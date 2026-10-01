import { beforeEach, describe, expect, it, vi } from "vitest";
import { stub } from "../harness/chromeStub";
import { readPanelMode, writePanelMode } from "./mode";
import { activeCaseReceiptKey } from "../shared/handoff";
import {
  HANDOFF_CASE_ID_FIXTURE,
  HANDOFF_FACILITY_ID_FIXTURE,
  HANDOFF_ORG_ID_FIXTURE,
  SET_ACTIVE_CASE_MESSAGE_FIXTURE,
} from "../testFixtures/extensionHandoff";
import {
  ACTIVE_CASE_KEY,
  assertCaseWriteMatchesActiveCase,
  assertFillMatchesActiveCase,
  clearActiveCase,
  clearActiveCaseIfCurrent,
  commitForCurrentHandoff,
  enterActiveCase,
  getActiveCaseState,
  handleExternalMessage,
  maybeBindPortalTab,
  onTabRemoved,
  readActiveCaseRecord,
  reconcilePersistedPortalTab,
  registerActiveCaseListeners,
} from "./activeCase";

const APP_ORIGIN = "https://mintedpanel.vercel.app";
const CASE_A = HANDOFF_CASE_ID_FIXTURE;
const CASE_B = "b7a90000-0000-4000-a000-0000000000c2";
const ORG_ID = HANDOFF_ORG_ID_FIXTURE;
const OTHER_ORG_ID = "30563fd6-8e95-46a0-8e1c-cb3b968b3c3d";
const FACILITY_ID = HANDOFF_FACILITY_ID_FIXTURE;

function message(caseId: string) {
  return {
    ...SET_ACTIVE_CASE_MESSAGE_FIXTURE,
    caseId,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  stub.reset();
});

describe("P06 receiver persistence and reply truth", () => {
  it("does not replace a valid context for a rejected origin or malformed required field", async () => {
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    const prior = await readActiveCaseRecord();

    await expect(
      handleExternalMessage(message(CASE_B), "https://evil.example"),
    ).resolves.toEqual({ ok: false });
    await expect(
      handleExternalMessage({ ...message(CASE_B), providerId: "not-a-uuid" }, APP_ORIGIN),
    ).resolves.toEqual({ ok: false });
    expect(await readActiveCaseRecord()).toEqual(prior);
  });

  it("preserves the prior valid context and returns false when record storage fails", async () => {
    expect(await handleExternalMessage(message(CASE_A), APP_ORIGIN)).toEqual({ ok: true });
    const prior = await readActiveCaseRecord();
    stub.queueSessionSet(async () => {
      throw new Error("session storage unavailable");
    });

    await expect(handleExternalMessage(message(CASE_B), APP_ORIGIN)).resolves.toEqual({
      ok: false,
    });
    expect(await readActiveCaseRecord()).toEqual(prior);
  });

  it("persists record and case mode atomically, preserving both prior values on rejection", async () => {
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    await writePanelMode("train");
    const prior = await readActiveCaseRecord();
    let attempted: Record<string, unknown> | null = null;
    stub.queueSessionSet(async (items) => {
      attempted = items;
      throw new Error("atomic session storage unavailable");
    });

    await expect(handleExternalMessage(message(CASE_B), APP_ORIGIN)).resolves.toEqual({
      ok: false,
    });

    expect(Object.keys(attempted ?? {})).toEqual(
      expect.arrayContaining(["minted.activeCase", "minted.panelMode"]),
    );
    expect(await readActiveCaseRecord()).toEqual(prior);
    expect(await readPanelMode()).toBe("train");
  });

  it("replies exactly once with ok:false when async receipt persistence rejects", async () => {
    registerActiveCaseListeners();
    const listener = stub.events.messageExternal.listeners.at(-1);
    expect(listener).toBeTypeOf("function");
    stub.queueSessionSet(async () => {
      throw new Error("session storage unavailable");
    });
    const replies: unknown[] = [];

    expect(
      listener?.(
        message(CASE_A),
        { origin: APP_ORIGIN, tab: { windowId: 12 } },
        (reply: unknown) => replies.push(reply),
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(replies).toEqual([{ ok: false }]));
  });
});

describe("active-case Chrome tab listener failures", () => {
  it("contains rejected storage work from update, activation, and removal events", async () => {
    const timestamp = new Date().toISOString();
    stub.sessionStore.set(ACTIVE_CASE_KEY, {
      caseId: CASE_A,
      providerId: "cb9d11d7-8b1d-4db0-a83b-0b6db10a50b2",
      orgId: ORG_ID,
      portalUrl: "https://portal.example/login",
      portalKey: "regional_enrollment",
      facilityId: FACILITY_ID,
      source: "handoff",
      boundTabId: 41,
      tabClosedAt: null,
      createdAt: timestamp,
      lastActivityAt: timestamp,
    });
    registerActiveCaseListeners();

    const cases = [
      {
        getListener: () => stub.events.tabUpdated.listeners.at(-1),
        fire: (listener: ((...args: unknown[]) => unknown) | undefined) =>
          listener?.(41, { url: "https://portal.example/login" }, {}),
      },
      {
        getListener: () => stub.events.tabActivated.listeners.at(-1),
        fire: (listener: ((...args: unknown[]) => unknown) | undefined) =>
          listener?.({ tabId: 41, windowId: 7 }),
      },
      {
        getListener: () => stub.events.tabRemoved.listeners.at(-1),
        fire: (listener: ((...args: unknown[]) => unknown) | undefined) => listener?.(41),
      },
    ];

    for (const [index, listenerCase] of cases.entries()) {
      let storageAttempted!: () => void;
      const attempted = new Promise<void>((resolve) => {
        storageAttempted = resolve;
      });
      stub.queueSessionSet(async () => {
        storageAttempted();
        throw new Error(`synthetic session write failure ${index}`);
      });
      listenerCase.fire(listenerCase.getListener());
      await attempted;
      // Let Node/Vitest process the rejected listener promise. An unhandled
      // rejection fails the test; handled best-effort tab events stay quiet.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
});

describe("P06 receiver ordering", () => {
  it("keeps B when delayed receipt A finishes after newer receipt B", async () => {
    const gate = deferred();
    let aStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      aStarted = resolve;
    });
    stub.queueSessionSet(async () => {
      aStarted();
      await gate.promise;
    });

    const a = handleExternalMessage(message(CASE_A), APP_ORIGIN);
    await started;
    const b = handleExternalMessage(message(CASE_B), APP_ORIGIN);
    await Promise.resolve();
    await Promise.resolve();
    gate.resolve();
    await Promise.all([a, b]);

    expect((await readActiveCaseRecord())?.caseId).toBe(CASE_B);
  });

  it("does not let stale tab removal replace a newer handoff", async () => {
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    await maybeBindPortalTab(7, "https://portal.example/login");
    const gate = deferred();
    let removalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      removalStarted = resolve;
    });
    stub.queueSessionSet(async () => {
      removalStarted();
      await gate.promise;
    });

    const removal = onTabRemoved(7);
    await started;
    const newer = handleExternalMessage(message(CASE_B), APP_ORIGIN);
    await Promise.resolve();
    await Promise.resolve();
    gate.resolve();
    await Promise.all([removal, newer]);

    expect((await readActiveCaseRecord())?.caseId).toBe(CASE_B);
    expect((await getActiveCaseState()).status).toBe("active");
  });

  it("does not revive a receipt that logout/org/account clearing removed", async () => {
    const gate = deferred();
    let receiptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      receiptStarted = resolve;
    });
    stub.queueSessionSet(async () => {
      receiptStarted();
      await gate.promise;
    });

    const receipt = handleExternalMessage(message(CASE_A), APP_ORIGIN);
    await started;
    const clear = clearActiveCase();
    gate.resolve();
    await Promise.all([receipt, clear]);

    expect(await readActiveCaseRecord()).toBeNull();
  });

  it("prevents a stale application commit from writing after receipt B", async () => {
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    const receiptA = await readActiveCaseRecord();
    if (receiptA == null) throw new Error("expected receipt A");
    await handleExternalMessage(message(CASE_B), APP_ORIGIN);
    const commit = vi.fn(async () => {});

    await expect(
      commitForCurrentHandoff(
        activeCaseReceiptKey(receiptA),
        {
          providerId: receiptA.providerId,
          caseId: receiptA.caseId,
          facilityId: receiptA.facilityId,
        },
        commit,
      ),
    ).resolves.toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect((await readActiveCaseRecord())?.caseId).toBe(CASE_B);
  });

  it("rejects an applied A fill after receipt B becomes current", async () => {
    const { handleRequest } = await import("./index");
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    const receiptA = await readActiveCaseRecord();
    if (receiptA == null) throw new Error("expected receipt A");
    await handleRequest({
      type: "COMMIT_HANDOFF_SELECTION",
      receiptKey: activeCaseReceiptKey(receiptA),
      providerId: receiptA.providerId,
      caseId: receiptA.caseId,
      facilityId: receiptA.facilityId,
    });
    await handleExternalMessage(message(CASE_B), APP_ORIGIN);

    await expect(
      handleRequest({
        type: "FILL",
        tabId: 77,
        providerId: receiptA.providerId,
        caseId: receiptA.caseId,
        portalKey: receiptA.portalKey ?? "regional_enrollment",
        state: "CO",
        facilityId: receiptA.facilityId,
      }),
    ).rejects.toThrow(/active handoff changed/i);
  });

  it("blocks case writes until the current handoff selection is applied", async () => {
    const { handleRequest } = await import("./index");
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    const pending = await readActiveCaseRecord();
    if (pending == null) throw new Error("expected pending receipt");

    await expect(assertCaseWriteMatchesActiveCase(CASE_A)).rejects.toThrow(
      /active handoff is not applied/i,
    );
    await expect(
      handleRequest({
        type: "LOG_STRUCTURED_TOUCH",
        caseId: CASE_A,
        idempotencyId: "0f0e73c2-51f1-4be9-9f2e-0a4c7f2fbb02",
        draft: {
          touchType: "portal",
          note: "Checked status",
          outcome: "successful",
          recipientName: "",
          recipientContact: "",
          followUpDate: "",
          trackingId: "",
        },
      }),
    ).rejects.toThrow(/active handoff is not applied/i);
    await handleRequest({
      type: "COMMIT_HANDOFF_SELECTION",
      receiptKey: activeCaseReceiptKey(pending),
      providerId: pending.providerId,
      caseId: pending.caseId,
      facilityId: pending.facilityId,
    });
    await expect(assertCaseWriteMatchesActiveCase(CASE_A)).resolves.toBeUndefined();
    await expect(assertCaseWriteMatchesActiveCase(CASE_B)).rejects.toThrow(
      /active handoff is not applied/i,
    );

    await enterActiveCase({
      caseId: CASE_B,
      providerId: pending.providerId,
      orgId: ORG_ID,
    });
    await expect(assertCaseWriteMatchesActiveCase(CASE_B)).resolves.toBeUndefined();
  });

  it("blocks portal submission logging until the current handoff selection is applied", async () => {
    const { handleRequest } = await import("./index");
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    const pending = await readActiveCaseRecord();
    if (pending == null) throw new Error("expected pending receipt");

    await expect(
      handleRequest({
        type: "MARK_SUBMITTED",
        providerId: pending.providerId,
        caseId: CASE_A,
        portalKey: pending.portalKey ?? "regional_enrollment",
        fillSessionId: "0f0e73c2-51f1-4be9-9f2e-0a4c7f2fbb01",
        bumpStatus: false,
      }),
    ).rejects.toThrow(/active handoff is not applied/i);

    await handleRequest({
      type: "COMMIT_HANDOFF_SELECTION",
      receiptKey: activeCaseReceiptKey(pending),
      providerId: pending.providerId,
      caseId: pending.caseId,
      facilityId: pending.facilityId,
    });
    // After apply the write gate opens; the route may still fail later on the
    // network mock — the assertion under test is only the pre-write handoff check.
    await expect(assertCaseWriteMatchesActiveCase(CASE_A)).resolves.toBeUndefined();
  });

  it("commits all selection identities only for the current receipt", async () => {
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    const receiptA = await readActiveCaseRecord();
    if (receiptA == null) throw new Error("expected receipt A");
    const { handleRequest } = await import("./index");

    await expect(
      handleRequest({
        type: "COMMIT_HANDOFF_SELECTION",
        receiptKey: activeCaseReceiptKey(receiptA),
        providerId: receiptA.providerId,
        caseId: receiptA.caseId,
        facilityId: receiptA.facilityId,
      }),
    ).resolves.toBe(true);
    expect(stub.sessionStore.get("minted.selectedProviderId")).toBe(receiptA.providerId);
    expect(
      stub.sessionStore.get(`minted.selectedCaseId.${receiptA.providerId}`),
    ).toBe(receiptA.caseId);
    expect(
      stub.sessionStore.get(`minted.selectedFacilityId.${receiptA.providerId}`),
    ).toBe(receiptA.facilityId);
  });

  it("rejects provider, case, or facility drift from the applied handoff at Fill", async () => {
    const { handleRequest } = await import("./index");
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    const receipt = await readActiveCaseRecord();
    if (receipt == null) throw new Error("expected receipt");
    await handleRequest({
      type: "COMMIT_HANDOFF_SELECTION",
      receiptKey: activeCaseReceiptKey(receipt),
      providerId: receipt.providerId,
      caseId: receipt.caseId,
      facilityId: receipt.facilityId,
    });

    await expect(
      assertFillMatchesActiveCase({
        providerId: receipt.providerId,
        caseId: receipt.caseId,
        facilityId: receipt.facilityId,
      }),
    ).resolves.toBeUndefined();
    for (const attempt of [
      {
        providerId: "59ad83a8-d8b6-419d-8dcc-88c04a54c4da",
        caseId: receipt.caseId,
        facilityId: receipt.facilityId,
      },
      {
        providerId: receipt.providerId,
        caseId: CASE_B,
        facilityId: receipt.facilityId,
      },
      {
        providerId: receipt.providerId,
        caseId: receipt.caseId,
        facilityId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      },
    ]) {
      await expect(assertFillMatchesActiveCase(attempt)).rejects.toThrow(
        /active handoff changed/i,
      );
    }
  });

  it("rejects mismatched provider, case, and explicit facility commit values", async () => {
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    const receiptA = await readActiveCaseRecord();
    if (receiptA == null) throw new Error("expected receipt A");
    const { handleRequest } = await import("./index");
    const receiptKey = activeCaseReceiptKey(receiptA);
    const attempts = [
      {
        providerId: "59ad83a8-d8b6-419d-8dcc-88c04a54c4da",
        caseId: receiptA.caseId,
        facilityId: receiptA.facilityId,
      },
      {
        providerId: receiptA.providerId,
        caseId: CASE_B,
        facilityId: receiptA.facilityId,
      },
      {
        providerId: receiptA.providerId,
        caseId: receiptA.caseId,
        facilityId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      },
    ];

    for (const attempt of attempts) {
      await expect(
        handleRequest({
          type: "COMMIT_HANDOFF_SELECTION",
          receiptKey,
          ...attempt,
        }),
      ).resolves.toBe(false);
    }
    expect(stub.sessionStore.has("minted.selectedProviderId")).toBe(false);
    expect(
      [...stub.sessionStore.keys()].filter((key) => key.startsWith("minted.selectedCaseId.")),
    ).toEqual([]);
    expect(
      [...stub.sessionStore.keys()].filter((key) =>
        key.startsWith("minted.selectedFacilityId."),
      ),
    ).toEqual([]);
  });

  it("keeps base-receipt compatibility when no facility was supplied", async () => {
    const baseMessage = { ...message(CASE_A) };
    delete (baseMessage as { facilityId?: string }).facilityId;
    await handleExternalMessage(baseMessage, APP_ORIGIN);
    const receipt = await readActiveCaseRecord();
    if (receipt == null) throw new Error("expected base receipt");
    const { handleRequest } = await import("./index");

    await expect(
      handleRequest({
        type: "COMMIT_HANDOFF_SELECTION",
        receiptKey: activeCaseReceiptKey(receipt),
        providerId: receipt.providerId,
        caseId: receipt.caseId,
        facilityId: FACILITY_ID,
      }),
    ).resolves.toBe(true);
    expect(
      stub.sessionStore.get(`minted.selectedFacilityId.${receipt.providerId}`),
    ).toBe(FACILITY_ID);
    await expect(
      assertFillMatchesActiveCase({
        providerId: receipt.providerId,
        caseId: receipt.caseId,
        facilityId: FACILITY_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps ordinary in-panel selections outside the handoff receipt gate", async () => {
    await enterActiveCase({
      providerId: SET_ACTIVE_CASE_MESSAGE_FIXTURE.providerId,
      caseId: CASE_A,
      orgId: ORG_ID,
    });

    await expect(
      assertFillMatchesActiveCase({
        providerId: SET_ACTIVE_CASE_MESSAGE_FIXTURE.providerId,
        caseId: CASE_A,
        facilityId: FACILITY_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it("prevents a stale rejection from clearing receipt B", async () => {
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    const receiptA = await readActiveCaseRecord();
    if (receiptA == null) throw new Error("expected receipt A");
    await handleExternalMessage(message(CASE_B), APP_ORIGIN);

    await expect(
      clearActiveCaseIfCurrent(activeCaseReceiptKey(receiptA)),
    ).resolves.toBe(false);
    expect((await readActiveCaseRecord())?.caseId).toBe(CASE_B);
  });

  it("serializes the real onUpdated handler behind pending receipt persistence", async () => {
    const gate = deferred();
    let receiptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      receiptStarted = resolve;
    });
    stub.queueSessionSet(async () => {
      receiptStarted();
      await gate.promise;
    });

    const receipt = handleExternalMessage(message(CASE_A), APP_ORIGIN);
    await started;
    registerActiveCaseListeners();
    const listener = stub.events.tabUpdated.listeners.at(-1);
    expect(listener).toBeTypeOf("function");
    listener?.(23, { url: "https://portal.example/login" }, {});
    gate.resolve();
    await receipt;

    await vi.waitFor(async () => {
      expect((await readActiveCaseRecord())?.boundTabId).toBe(23);
    });
  });

  it("does not fresh-bind a same-origin tab that predated receipt dispatch", async () => {
    stub.setQueryTabs([
      { id: 29, url: "https://portal.example/login" } as chrome.tabs.Tab,
    ]);

    await handleExternalMessage(message(CASE_A), APP_ORIGIN);

    expect((await readActiveCaseRecord())?.boundTabId).toBeNull();
  });

  it("fresh-binds only the active target in the sender window when it opened before dispatch", async () => {
    stub.setQueryTabs([
      {
        id: 5,
        windowId: 12,
        active: false,
        url: `${APP_ORIGIN}/cases/${CASE_A}`,
      } as chrome.tabs.Tab,
      {
        id: 41,
        windowId: 12,
        active: false,
        url: "https://portal.example/old",
      } as chrome.tabs.Tab,
      {
        id: 42,
        windowId: 12,
        active: true,
        url: "https://portal.example/new",
      } as chrome.tabs.Tab,
    ]);
    await handleExternalMessage(message(CASE_A), APP_ORIGIN, 5, 12);

    await vi.waitFor(async () => {
      expect((await readActiveCaseRecord())?.boundTabId).toBe(42);
    });
    expect(stub.tabQueries).toEqual([{ windowId: 12, active: true }]);
  });

  it("does not delay receipt while sidePanel.open remains pending", async () => {
    const chromeWithSidePanel = chrome as unknown as {
      sidePanel: { open: () => Promise<void> } | undefined;
    };
    const previous = chromeWithSidePanel.sidePanel;
    chromeWithSidePanel.sidePanel = { open: () => new Promise<void>(() => {}) };
    try {
      const outcome = await Promise.race([
        handleExternalMessage(message(CASE_A), APP_ORIGIN, undefined, 12),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);
      expect(outcome).toEqual({ ok: true });
    } finally {
      chromeWithSidePanel.sidePanel = previous;
    }
  });

  it("reconciles one matching portal tab after a worker restart", async () => {
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    stub.setQueryTabs([
      { id: 41, url: "https://portal.example/login" } as chrome.tabs.Tab,
    ]);

    await reconcilePersistedPortalTab();

    expect((await readActiveCaseRecord())?.boundTabId).toBe(41);
    expect(stub.tabQueries.at(-1)).toEqual({});
  });

  it("leaves restart binding unresolved when several same-origin tabs are ambiguous", async () => {
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    stub.setQueryTabs([
      { id: 41, url: "https://portal.example/login" } as chrome.tabs.Tab,
      { id: 42, url: "https://portal.example/other" } as chrome.tabs.Tab,
    ]);

    await reconcilePersistedPortalTab();

    expect((await readActiveCaseRecord())?.boundTabId).toBeNull();
  });
});

describe("P06 explicit org recovery", () => {
  it("preserves the full handoff record when switching to its member org", async () => {
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    const prior = await readActiveCaseRecord();
    if (prior == null) throw new Error("expected handoff record");
    const { handleRequest } = await import("./index");

    await expect(
      handleRequest({
        type: "SET_ACTIVE_ORG_FOR_HANDOFF",
        orgId: ORG_ID,
        receiptKey: activeCaseReceiptKey(prior),
      }),
    ).resolves.toBe(true);

    expect(await readActiveCaseRecord()).toEqual(prior);
    expect((await readActiveCaseRecord())?.source).toBe("handoff");
    expect((await readActiveCaseRecord())?.portalUrl).toBe(message(CASE_A).portalUrl);
    expect((await readActiveCaseRecord())?.portalKey).toBe(message(CASE_A).portalKey);
    expect((await readActiveCaseRecord())?.facilityId).toBe(FACILITY_ID);
  });

  it("clears a handoff when switching to a different org", async () => {
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    const { handleRequest } = await import("./index");

    await handleRequest({ type: "SET_ACTIVE_ORG", orgId: OTHER_ORG_ID });

    expect(await readActiveCaseRecord()).toBeNull();
  });

  it("does not let a stale A org switch clear receipt B or change its org", async () => {
    const { handleRequest } = await import("./index");
    await handleRequest({ type: "SET_ACTIVE_ORG", orgId: OTHER_ORG_ID });
    await handleExternalMessage(message(CASE_A), APP_ORIGIN);
    const receiptA = await readActiveCaseRecord();
    if (receiptA == null) throw new Error("expected receipt A");
    await handleExternalMessage(message(CASE_B), APP_ORIGIN);

    await expect(
      handleRequest({
        type: "SET_ACTIVE_ORG_FOR_HANDOFF",
        orgId: ORG_ID,
        receiptKey: activeCaseReceiptKey(receiptA),
      }),
    ).resolves.toBe(false);

    expect((await readActiveCaseRecord())?.caseId).toBe(CASE_B);
    await expect(handleRequest({ type: "GET_ACTIVE_ORG" })).resolves.toBe(OTHER_ORG_ID);
  });

  describe("ad hoc (case-free) fill guarding", () => {
    it("allows case-free fill when no active case is bound", async () => {
      await expect(
        assertFillMatchesActiveCase({
          providerId: "59ad83a8-d8b6-419d-8dcc-88c04a54c4da",
          caseId: null,
          facilityId: null,
        }),
      ).resolves.toBeUndefined();
    });

    it("rejects case-free fill when an unexpired handoff is active", async () => {
      await handleExternalMessage(message(CASE_A), APP_ORIGIN);
      await expect(
        assertFillMatchesActiveCase({
          providerId: message(CASE_A).providerId,
          caseId: null,
          facilityId: FACILITY_ID,
        }),
      ).rejects.toThrow(/active handoff changed/i);
    });

    it("rejects case-free fill when an in-panel case is actively selected", async () => {
      await enterActiveCase({
        caseId: CASE_A,
        providerId: message(CASE_A).providerId,
        orgId: ORG_ID,
      });

      await expect(
        assertFillMatchesActiveCase({
          providerId: message(CASE_A).providerId,
          caseId: null,
          facilityId: null,
        }),
      ).rejects.toThrow(/active case is currently selected/i);
    });

    it("allows case-free fill after active case is cleared", async () => {
      await enterActiveCase({
        caseId: CASE_A,
        providerId: message(CASE_A).providerId,
        orgId: ORG_ID,
      });
      await clearActiveCase();

      await expect(
        assertFillMatchesActiveCase({
          providerId: message(CASE_A).providerId,
          caseId: null,
          facilityId: null,
        }),
      ).resolves.toBeUndefined();
    });
  });
});
