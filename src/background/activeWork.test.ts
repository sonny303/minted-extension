import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stub } from "../harness/chromeStub";
import { ACTIVE_WORK_BLOCK_KEY, ACTIVE_WORK_KEY, clearActiveWork, getActiveWorkState, getWorkPortalPermissionTarget, handleExternalSetActiveWork, onActiveWorkTabActivated, onActiveWorkTabUpdated, reconcileActiveWorkTab, registerValidatedWorkSelectionCommitter, requireActiveWorkForTab } from "./activeWork";
import { validateWorkContext } from "./api";
import { canonicalizeWorkContextTuple, tupleFromSetActiveWorkMessage, type CanonicalWorkContextTuple, type SetActiveWorkMessage } from "../shared/workContext";

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
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
    formUrl: input.portalUrl,
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

function setupWebNavigationHarness() {
  const frames = new Map<number, string | undefined>();
  const beforeListeners = new Set<(details: chrome.webNavigation.WebNavigationBaseCallbackDetails) => void>();
  const committedListeners = new Set<(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => void>();
  const historyListeners = new Set<(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => void>();
  const baseCreate = chrome.tabs.create.bind(chrome.tabs);
  const getFrame = vi.fn(async (details: chrome.webNavigation.GetFrameDetails) => {
    if (typeof details.tabId !== "number") return null;
    const url = frames.get(details.tabId);
    return url == null ? null : { url } as chrome.webNavigation.GetFrameResultDetails;
  });
  const makeEvent = <T>(listeners: Set<T>) => ({
    addListener: (listener: T) => listeners.add(listener),
    removeListener: (listener: T) => listeners.delete(listener),
  });
  Object.assign(chrome.webNavigation, {
    getFrame,
    onBeforeNavigate: makeEvent(beforeListeners),
    onCommitted: makeEvent(committedListeners),
    onHistoryStateUpdated: makeEvent(historyListeners),
  });
  const emitBefore = (tabId: number, url: string) => {
    const details = { tabId, frameId: 0, url } as chrome.webNavigation.WebNavigationBaseCallbackDetails;
    for (const listener of beforeListeners) listener(details);
  };
  const emitCommitted = (tabId: number, url: string) => {
    frames.set(tabId, url);
    const details = { tabId, frameId: 0, url } as chrome.webNavigation.WebNavigationTransitionCallbackDetails;
    for (const listener of committedListeners) listener(details);
  };
  vi.spyOn(chrome.tabs, "create").mockImplementation(async (properties) => {
    const tab = await baseCreate(properties);
    if (tab.id != null) {
      const url = properties.url ?? "about:blank";
      emitBefore(tab.id, url);
      emitCommitted(tab.id, url);
    }
    return tab;
  });
  return {
    frames,
    getFrame,
    emitBefore,
    emitCommitted,
    baseCreate,
  };
}

let navigationHarness: ReturnType<typeof setupWebNavigationHarness>;

beforeEach(async () => {
  stub.reset();
  vi.resetAllMocks();
  navigationHarness = setupWebNavigationHarness();
  registerValidatedWorkSelectionCommitter(async () => {});
  vi.mocked(validateWorkContext).mockImplementation(async (tuple) => validationResult({
    ...message,
    ...tuple,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it("waits for webNavigation main-frame commit evidence before ACK", async () => {
    // The tab starts at about:blank and commits only when the test explicitly
    // emits the browser navigation event.
    vi.mocked(chrome.tabs.create).mockImplementation(async (properties) => {
      const tab = await navigationHarness.baseCreate(properties);
      if (tab.id != null) {
        navigationHarness.frames.set(tab.id, "about:blank");
        navigationHarness.emitBefore(tab.id, message.portalUrl);
      }
      return tab;
    });

    const launch = handleExternalSetActiveWork(message, APP_ORIGIN, 1);
    await vi.waitFor(() => expect(navigationHarness.getFrame).toHaveBeenCalled());
    expect(stub.sessionStore.has(ACTIVE_WORK_KEY)).toBe(false);
    navigationHarness.frames.set(700, message.portalUrl);
    navigationHarness.emitCommitted(700, message.portalUrl);
    const ack = await launch;

    expect(ack.ok).toBe(true);
    expect(navigationHarness.getFrame).toHaveBeenCalledWith({ tabId: 700, frameId: 0 });
    expect(stub.sessionStore.get(ACTIVE_WORK_KEY)).toMatchObject({ boundTabId: 700 });
  });

  it("times out on blank tab and removes only the still-canonical pending tab", async () => {
    vi.useFakeTimers();
    vi.mocked(chrome.tabs.create).mockImplementation(async (properties) => {
      const tab = await navigationHarness.baseCreate(properties);
      if (tab.id != null) {
        navigationHarness.frames.set(tab.id, "about:blank");
        navigationHarness.emitBefore(tab.id, message.portalUrl);
      }
      return tab;
    });
    const launch = handleExternalSetActiveWork(message, APP_ORIGIN, 1);
    for (let i = 0; i < 40 && stub.tabQueries.length === 0; i += 1) await Promise.resolve();
    expect(stub.tabQueries.length).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(launch).resolves.toEqual({ ok: false, code: "TAB_BIND_FAILED" });
    await expect(chrome.tabs.get(700)).rejects.toThrow(/No tab/);
    expect(stub.sessionStore.has(ACTIVE_WORK_KEY)).toBe(false);
  });

  it("accepts the exact canonical query URL", async () => {
    const queryMessage = { ...message, portalUrl: "https://portal.example.com/enroll?payer=A" };
    vi.mocked(validateWorkContext).mockResolvedValueOnce(validationResult(queryMessage));
    const ack = await handleExternalSetActiveWork(queryMessage, APP_ORIGIN, 1);
    expect(ack).toMatchObject({ ok: true, portalUrl: queryMessage.portalUrl });
    expect(stub.sessionStore.get(ACTIVE_WORK_KEY)).toMatchObject({ boundTabId: 700 });
  });

  it("rejects a committed query mismatch and leaves the navigated tab alone", async () => {
    const queryMessage = { ...message, portalUrl: "https://portal.example.com/enroll?payer=A" };
    const wrongQuery = "https://portal.example.com/enroll?payer=B";
    vi.mocked(validateWorkContext).mockResolvedValueOnce(validationResult(queryMessage));
    vi.mocked(chrome.tabs.create).mockImplementation(async (properties) => {
      const tab = await navigationHarness.baseCreate(properties);
      if (tab.id != null) {
        navigationHarness.emitBefore(tab.id, wrongQuery);
        navigationHarness.emitCommitted(tab.id, wrongQuery);
      }
      return tab;
    });
    await expect(handleExternalSetActiveWork(queryMessage, APP_ORIGIN, 1))
      .resolves.toEqual({ ok: false, code: "TAB_BIND_FAILED" });
    await expect(chrome.tabs.get(700)).resolves.toBeDefined();
    expect(stub.sessionStore.has(ACTIVE_WORK_KEY)).toBe(false);
  });

  it("rejects a blank tab with a pending query mismatch and leaves it open", async () => {
    const queryMessage = { ...message, portalUrl: "https://portal.example.com/enroll?payer=A" };
    const wrongQuery = "https://portal.example.com/enroll?payer=B";
    vi.mocked(validateWorkContext).mockResolvedValueOnce(validationResult(queryMessage));
    vi.mocked(chrome.tabs.create).mockImplementation(async (properties) => {
      const tab = await navigationHarness.baseCreate(properties);
      if (tab.id != null) {
        navigationHarness.frames.set(tab.id, "about:blank");
        navigationHarness.emitBefore(tab.id, wrongQuery);
      }
      return tab;
    });
    await expect(handleExternalSetActiveWork(queryMessage, APP_ORIGIN, 1))
      .resolves.toEqual({ ok: false, code: "TAB_BIND_FAILED" });
    await expect(chrome.tabs.get(700)).resolves.toBeDefined();
    expect(stub.sessionStore.has(ACTIVE_WORK_KEY)).toBe(false);
  });

  it("fails closed if Chrome closes the created tab before commit", async () => {
    const getTab = chrome.tabs.get.bind(chrome.tabs);
    vi.spyOn(chrome.tabs, "get").mockImplementation(async (tabId) => {
      if (tabId === 700) {
        await chrome.tabs.remove(700);
        throw new Error("No tab with id");
      }
      return getTab(tabId);
    });

    await expect(handleExternalSetActiveWork(message, APP_ORIGIN, 1))
      .resolves.toEqual({ ok: false, code: "TAB_BIND_FAILED" });
    await expect(chrome.tabs.get(700)).rejects.toThrow(/No tab/);
    expect(stub.sessionStore.has(ACTIVE_WORK_KEY)).toBe(false);
  });

  it.each([1, 2] as const)("rejects when focus changes to window %s", async (activeWindowId) => {
    const queryTabs = chrome.tabs.query.bind(chrome.tabs);
    vi.spyOn(chrome.tabs, "query").mockImplementation(async (query) => {
      if (query?.active === true && query.lastFocusedWindow === true) {
        return [{ id: 701, windowId: activeWindowId, url: "https://other.example.com", active: true } as chrome.tabs.Tab];
      }
      return queryTabs(query);
    });

    await expect(handleExternalSetActiveWork(message, APP_ORIGIN, 1))
      .resolves.toEqual({ ok: false, code: "TAB_BIND_FAILED" });
    await expect(chrome.tabs.get(700)).rejects.toThrow(/No tab/);
    expect(stub.sessionStore.has(ACTIVE_WORK_KEY)).toBe(false);
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

  it("supersedes while waiting for commit and cleans up only the matching pending tab", async () => {
    vi.mocked(chrome.tabs.create).mockImplementation(async (properties) => {
      const tab = await navigationHarness.baseCreate(properties);
      if (tab.id != null) {
        navigationHarness.frames.set(tab.id, "about:blank");
        navigationHarness.emitBefore(tab.id, message.portalUrl);
      }
      return tab;
    });
    const launch = handleExternalSetActiveWork(message, APP_ORIGIN, 1);
    await vi.waitFor(() => expect(stub.tabQueries.length).toBeGreaterThan(0));
    await clearActiveWork({ allowLegacyFallback: true });

    await expect(launch).resolves.toEqual({ ok: false, code: "SUPERSEDED" });
    await expect(chrome.tabs.get(700)).rejects.toThrow(/No tab/);
    expect((await getActiveWorkState()).status).toBe("none");
  });
});

describe("MINT-64 Work host permission target", () => {
  it("returns only the freshly validated origin of the exact active Work tab", async () => {
    await handleExternalSetActiveWork(message, APP_ORIGIN, 1);

    await expect(getWorkPortalPermissionTarget()).resolves.toEqual({
      tabId: 700,
      launchReceiptId: message.launchReceiptId,
      origin: "https://portal.example.com",
    });
    expect(validateWorkContext).toHaveBeenCalledTimes(2);
    expect(stub.tabQueries).toContainEqual({ active: true, currentWindow: true });
  });

  it("does not return a target when fresh server validation no longer requires explicit selection", async () => {
    await handleExternalSetActiveWork(message, APP_ORIGIN, 1);
    vi.mocked(validateWorkContext).mockResolvedValueOnce({
      ...validationResult(),
      requiresExplicitSelection: false,
    });

    await expect(getWorkPortalPermissionTarget()).resolves.toBeNull();
  });

  it("returns no target for a different active tab without changing the bound Work", async () => {
    await handleExternalSetActiveWork(message, APP_ORIGIN, 1);
    stub.setQueryTabs([
      { id: 701, windowId: 1, url: "https://other.example/form", active: true } as chrome.tabs.Tab,
    ]);

    await expect(getWorkPortalPermissionTarget()).resolves.toBeNull();
    expect(stub.sessionStore.has(ACTIVE_WORK_KEY)).toBe(true);
    expect(validateWorkContext).toHaveBeenCalledTimes(1);
  });

  it("does not return a grant target for an expired Work record", async () => {
    await handleExternalSetActiveWork(message, APP_ORIGIN, 1);
    const record = stub.sessionStore.get(ACTIVE_WORK_KEY) as Record<string, unknown>;
    stub.sessionStore.set(ACTIVE_WORK_KEY, {
      ...record,
      lastActivityAt: new Date(Date.now() - 60 * 60 * 1000 - 1).toISOString(),
    });

    await expect(getWorkPortalPermissionTarget()).resolves.toBeNull();
    expect(stub.sessionStore.has(ACTIVE_WORK_KEY)).toBe(true);
    expect(validateWorkContext).toHaveBeenCalledTimes(1);
  });

  it("does not extend the Work idle timeout while preparing the permission prompt", async () => {
    await handleExternalSetActiveWork(message, APP_ORIGIN, 1);
    const record = stub.sessionStore.get(ACTIVE_WORK_KEY) as Record<string, unknown>;
    const lastActivityAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    stub.sessionStore.set(ACTIVE_WORK_KEY, { ...record, lastActivityAt });

    await expect(getWorkPortalPermissionTarget()).resolves.toMatchObject({ origin: "https://portal.example.com" });
    expect(stub.sessionStore.get(ACTIVE_WORK_KEY)).toMatchObject({ lastActivityAt });
  });

  it("drops the target if the active tab changes while Panel revalidation is pending", async () => {
    await handleExternalSetActiveWork(message, APP_ORIGIN, 1);
    const pending = deferred<ReturnType<typeof validationResult>>();
    vi.mocked(validateWorkContext).mockImplementationOnce(() => pending.promise);
    const target = getWorkPortalPermissionTarget();
    await vi.waitFor(() => expect(validateWorkContext).toHaveBeenCalledTimes(2));
    stub.setQueryTabs([
      { id: 700, windowId: 1, url: message.portalUrl, active: false } as chrome.tabs.Tab,
      { id: 701, windowId: 1, url: "https://other.example/form", active: true } as chrome.tabs.Tab,
    ]);
    pending.resolve(validationResult());

    await expect(target).resolves.toBeNull();
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
    navigationHarness.getFrame.mockImplementation(async (details: chrome.webNavigation.GetFrameDetails) => ({
      url: details.tabId === 32 ? message.portalUrl : "https://other.example.com",
    } as chrome.webNavigation.GetFrameResultDetails));
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

  it("uses webNavigation frame URL when Chrome hides tabs.Tab.url", async () => {
    await handleExternalSetActiveWork(message, APP_ORIGIN, 1);
    const originalGet = chrome.tabs.get.bind(chrome.tabs);
    vi.spyOn(chrome.tabs, "get").mockImplementation(async (tabId) => {
      const tab = await originalGet(tabId);
      return { id: tab.id, windowId: tab.windowId, active: tab.active } as chrome.tabs.Tab;
    });
    navigationHarness.frames.set(700, message.portalUrl);

    await expect(requireActiveWorkForTab(700)).resolves.toMatchObject({ boundTabId: 700 });
    expect(navigationHarness.getFrame).toHaveBeenCalledWith({ tabId: 700, frameId: 0 });
  });

  it("revalidates an exact Work fill through webNavigation when tabs.Tab.url is hidden", async () => {
    const tabId = 71;
    stub.setQueryTabs([{ id: tabId, windowId: 1, active: true } as chrome.tabs.Tab]);
    const tuple = tupleFromSetActiveWorkMessage(message);
    const now = new Date().toISOString();
    stub.sessionStore.set(ACTIVE_WORK_KEY, {
      tuple,
      boundTabId: tabId,
      formOrigin: "https://portal.example.com",
      formPath: "/enroll",
      caseType: "enrollment",
      createdAt: now,
      lastActivityAt: now,
    });
    stub.sessionStore.set("minted.activeOrgId", message.orgId);
    stub.sessionStore.set("minted.selectedProviderId", message.providerId);
    stub.sessionStore.set(`minted.selectedCaseId.${message.providerId}`, message.ownerId);
    navigationHarness.frames.set(tabId, message.portalUrl);

    const { handleRequest } = await import("./index");
    await expect(handleRequest({
      type: "PREPARE_AI_FILL",
      tabId,
      providerId: message.providerId,
      caseId: message.ownerId,
      portalKey: message.portalKey,
      portalId: message.portalId,
      mappingGeneration: message.mappingGeneration,
      state: "CO",
      facilityId: null,
    })).rejects.toThrow(/Could not reach the enrollment form/);
    expect(navigationHarness.getFrame).toHaveBeenCalledWith({ tabId, frameId: 0 });
    expect(navigationHarness.getFrame.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
