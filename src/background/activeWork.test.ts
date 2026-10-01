import { beforeEach, describe, expect, it, vi } from "vitest";
import { stub } from "../harness/chromeStub";
import { ACTIVE_WORK_BLOCK_KEY, ACTIVE_WORK_KEY, clearActiveWork, getActiveWorkState, handleExternalSetActiveWork, onActiveWorkTabActivated, onActiveWorkTabUpdated, reconcileActiveWorkTab, registerValidatedWorkSelectionCommitter, requireActiveWorkForTab } from "./activeWork";
import { validateWorkContext } from "./api";
import { canonicalizeWorkContextTuple, tupleFromSetActiveWorkMessage, type CanonicalWorkContextTuple, type SetActiveWorkMessage } from "../shared/workContext";

vi.mock("./api", () => ({
  validateWorkContext: vi.fn(),
}));

const APP_ORIGIN = "https://mintedpanel.vercel.app";
const message: SetActiveWorkMessage = {
  type: "SET_ACTIVE_WORK",
  protocolVersion: 2,
  launchReceiptId: "11111111-1111-4111-8111-111111111111",
  ownerKind: "case",
  ownerId: "22222222-2222-4222-8222-222222222222",
  contextVersion: 4,
  sopTemplateId: "33333333-3333-4333-8333-333333333333",
  sopVersion: 3,
  portalId: "44444444-4444-4444-8444-444444444444",
  portalKey: "regional_enrollment",
  mappingGeneration: 2,
  effectiveMappingFingerprint: `sha256:${"a".repeat(64)}`,
  providerId: "55555555-5555-4555-8555-555555555555",
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  facilityId: null,
  taskId: "66666666-6666-4666-8666-666666666666",
  stepId: "77777777-7777-4777-8777-777777777777",
  stepIdentity: "case:task-1:step-2",
  portalUrl: "https://portal.example.com/enroll",
};

function validationResult(input: SetActiveWorkMessage = message) {
  const tuple = tupleFromSetActiveWorkMessage(input);
  return {
    tuple: tuple as CanonicalWorkContextTuple,
    caseType: "enrollment" as const,
    formUrl: "https://portal.example.com/enroll",
    requiresExplicitSelection: true,
    mappingGeneration: input.mappingGeneration,
    effectiveMappingFingerprint: input.effectiveMappingFingerprint,
    effectiveWebMaps: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  stub.reset();
  vi.resetAllMocks();
  registerValidatedWorkSelectionCommitter(async () => {});
  vi.mocked(validateWorkContext).mockImplementation(async (tuple) => validationResult({
    ...message,
    ...tuple,
  }));
});

describe("SET_ACTIVE_WORK exact tab binding", () => {
  it("validates a Panel-shaped SHA-256 launch and returns the exact capability ACK", async () => {
    const expectedTuple = tupleFromSetActiveWorkMessage(message);
    const ack = await handleExternalSetActiveWork(message, APP_ORIGIN, 1);

    expect(validateWorkContext).toHaveBeenCalledWith(expectedTuple, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(ack).toEqual({
      ok: true,
      protocolVersion: 2,
      capability: "exact-work-tab-v2",
      launchReceiptId: message.launchReceiptId,
      tuple: canonicalizeWorkContextTuple(expectedTuple),
      tabId: 700,
      portalUrl: "https://portal.example.com/enroll",
    });
  });

  it("creates and binds a new exact tab even when older tabs have the same URL", async () => {
    stub.setQueryTabs([
      { id: 10, windowId: 1, url: message.portalUrl, active: true } as chrome.tabs.Tab,
      { id: 11, windowId: 1, url: message.portalUrl, active: false } as chrome.tabs.Tab,
    ]);

    const ack = await handleExternalSetActiveWork(message, APP_ORIGIN, 1);
    expect(ack).toMatchObject({
      ok: true,
      protocolVersion: 2,
      capability: "exact-work-tab-v2",
      launchReceiptId: message.launchReceiptId,
      portalUrl: message.portalUrl,
    });
    if (ack.ok) expect(ack.portalUrl).toBe(validationResult().formUrl);
    if (!ack.ok) throw new Error("launch should succeed");
    expect(ack.tabId).toBe(700);
    expect(ack.tuple).toMatchObject({ ownerId: message.ownerId, portalId: message.portalId });
    expect(ack.tuple).not.toHaveProperty("protocolVersion");
    expect(stub.sessionStore.get(ACTIVE_WORK_KEY)).toMatchObject({
      boundTabId: 700,
      formOrigin: "https://portal.example.com",
      tuple: { launchReceiptId: message.launchReceiptId, orgId: message.orgId },
    });
    expect(stub.createdTabs).toHaveLength(1);
    expect(stub.createdTabs[0]?.id).toBe(700);
  });

  it("rejects update-required clients and URL hints that differ from the server", async () => {
    await expect(handleExternalSetActiveWork({ ...message, protocolVersion: 1 }, APP_ORIGIN))
      .resolves.toEqual({ ok: false, code: "UPDATE_REQUIRED" });
    vi.mocked(validateWorkContext).mockResolvedValueOnce({
      ...validationResult(),
      formUrl: "https://other.example.com/form",
    });
    await expect(handleExternalSetActiveWork(message, APP_ORIGIN))
      .resolves.toEqual({ ok: false, code: "CONTEXT_STALE" });
    expect(stub.createdTabs).toHaveLength(0);
    expect(stub.sessionStore.has(ACTIVE_WORK_KEY)).toBe(false);
  });

  it("rejects a late canonical response from another org before creating a tab", async () => {
    const mismatched = validationResult();
    vi.mocked(validateWorkContext).mockResolvedValueOnce({
      ...mismatched,
      tuple: { ...mismatched.tuple, orgId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    });

    await expect(handleExternalSetActiveWork(message, APP_ORIGIN))
      .resolves.toEqual({ ok: false, code: "CONTEXT_STALE" });
    expect(stub.createdTabs).toHaveLength(0);
    expect(stub.sessionStore.has(ACTIVE_WORK_KEY)).toBe(false);
    expect((await getActiveWorkState()).status).toBe("blocked");
  });

  it("does not let a late validation create or replace the newer launch", async () => {
    const first = deferred<ReturnType<typeof validationResult>>();
    vi.mocked(validateWorkContext)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(validationResult({
        ...message,
        launchReceiptId: "99999999-9999-4999-8999-999999999999",
        ownerId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        portalUrl: "https://portal.example.com/enroll",
      }));
    const staleLaunch = handleExternalSetActiveWork(message, APP_ORIGIN, 1);
    await vi.waitFor(() => expect(validateWorkContext).toHaveBeenCalledTimes(1));
    const newerMessage = {
      ...message,
      launchReceiptId: "99999999-9999-4999-8999-999999999999",
      ownerId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    };
    const currentLaunch = handleExternalSetActiveWork(newerMessage, APP_ORIGIN, 1);
    const currentAck = await currentLaunch;
    expect(currentAck.ok).toBe(true);
    first.resolve(validationResult());
    await expect(staleLaunch).resolves.toMatchObject({ ok: false, code: "SUPERSEDED" });
    expect(stub.sessionStore.get(ACTIVE_WORK_KEY)).toMatchObject({
      tuple: { launchReceiptId: newerMessage.launchReceiptId, ownerId: newerMessage.ownerId },
    });
    expect(stub.createdTabs).toHaveLength(1);
  });

  it("does not create a tab after a Work switch during selection commit", async () => {
    const commit = deferred<void>();
    const commitStarted = deferred<void>();
    registerValidatedWorkSelectionCommitter(async () => {
      commitStarted.resolve(undefined);
      return commit.promise;
    });
    const launch = handleExternalSetActiveWork(message, APP_ORIGIN, 1);
    await commitStarted.promise;
    const clearing = clearActiveWork({ allowLegacyFallback: true });
    commit.resolve(undefined);

    await expect(launch).resolves.toMatchObject({ ok: false, code: "SUPERSEDED" });
    await clearing;
    expect(stub.createdTabs).toHaveLength(0);
    expect((await getActiveWorkState()).status).toBe("none");
  });
});

describe("exact tab lifecycle", () => {
  it("worker restart reconciliation checks the persisted tab id instead of URL matching", async () => {
    stub.setQueryTabs([
      { id: 31, windowId: 1, url: message.portalUrl, active: true } as chrome.tabs.Tab,
      { id: 32, windowId: 1, url: message.portalUrl, active: false } as chrome.tabs.Tab,
    ]);
    stub.sessionStore.set(ACTIVE_WORK_KEY, {
      tuple: tupleFromSetActiveWorkMessage(message),
      boundTabId: 32,
      formOrigin: "https://portal.example.com",
      formPath: "/enroll",
      caseType: "enrollment",
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
    await reconcileActiveWorkTab();
    expect(stub.sessionStore.get(ACTIVE_WORK_KEY)).toMatchObject({ boundTabId: 32 });
    expect(stub.tabQueries).toHaveLength(0);
  });

  it("switching away from the bound tab revokes the context", async () => {
    stub.setQueryTabs([
      { id: 53, windowId: 1, url: message.portalUrl, active: true } as chrome.tabs.Tab,
      { id: 54, windowId: 1, url: "https://other.example.com", active: false } as chrome.tabs.Tab,
    ]);
    stub.sessionStore.set(ACTIVE_WORK_KEY, {
      tuple: tupleFromSetActiveWorkMessage(message),
      boundTabId: 53,
      formOrigin: "https://portal.example.com",
      formPath: "/enroll",
      caseType: "enrollment",
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
    await onActiveWorkTabActivated(54);
    expect(stub.sessionStore.has(ACTIVE_WORK_KEY)).toBe(false);
    expect(stub.sessionStore.get(ACTIVE_WORK_BLOCK_KEY)).toEqual({ orgId: message.orgId });
    expect((await getActiveWorkState()).status).toBe("blocked");
    await expect(requireActiveWorkForTab(54)).rejects.toThrow(/exact Work context ended/);
    await clearActiveWork({ allowLegacyFallback: true });
    expect((await getActiveWorkState()).status).toBe("none");
    await expect(requireActiveWorkForTab(54)).resolves.toBeNull();
  });

  it("revokes same-origin navigation outside the selected form path", async () => {
    stub.setQueryTabs([
      { id: 53, windowId: 1, url: message.portalUrl, active: true } as chrome.tabs.Tab,
    ]);
    stub.sessionStore.set(ACTIVE_WORK_KEY, {
      tuple: tupleFromSetActiveWorkMessage(message),
      boundTabId: 53,
      formOrigin: "https://portal.example.com",
      formPath: "/enroll",
      caseType: "enrollment",
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
    await onActiveWorkTabUpdated(53, "https://portal.example.com/admin");
    expect(stub.sessionStore.has(ACTIVE_WORK_KEY)).toBe(false);
    expect((await getActiveWorkState()).status).toBe("blocked");
  });
});
