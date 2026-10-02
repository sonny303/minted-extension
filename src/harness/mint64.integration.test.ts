// MINT-64 Extension integration evidence, pinned to the merged baselines under
// review: Panel M60 78204da977249ca784d44d4f7901290edd2f17cb and Extension
// a74231e3de3dfbc1893933b21d672bc7ef92cbd3. These tests use only synthetic
// identities, maps, and form URLs; they never contact a payer portal.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stub } from "./chromeStub";
// @ts-expect-error — the in-repo mock API is a harness-only .mjs server.
import { createMockPanelApi, FIXTURES } from "../../scripts/mock-panel-api.mjs";
import { ACTIVE_WORK_KEY } from "../background/activeWork";
import type { SetActiveWorkMessage, WorkContextTuple } from "../shared/workContext";

const holder = vi.hoisted(() => ({ baseUrl: "" }));

vi.mock("../shared/config", () => ({
  SUPABASE_URL: "https://stub.supabase.invalid",
  SUPABASE_ANON_KEY: "stub-anon-key",
  get API_BASE_URL() {
    return holder.baseUrl;
  },
}));

vi.mock("../background/auth", () => ({
  AuthRequiredError: class AuthRequiredError extends Error {},
  getAccessToken: async () => "tok-primary",
  forceRefresh: async () => { throw new Error("unexpected auth refresh"); },
  getAuthState: async () => ({ signedIn: true, email: "fixture@example.test", name: "Fixture" }),
  currentUserId: async () => "user-primary",
  signIn: async () => ({ signedIn: true, email: "fixture@example.test", name: "Fixture" }),
  signOut: async () => {},
}));

// The webNavigation stub emits real before/commit events from tabs.create, so
// the launch is bound by the same exact-tab path as the MV3 worker.
const frames = new Map<number, string>();
const beforeListeners = new Set<(details: chrome.webNavigation.WebNavigationBaseCallbackDetails) => void>();
const committedListeners = new Set<(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => void>();
const historyListeners = new Set<(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => void>();
const navEvent = <T>(listeners: Set<T>) => ({
  addListener: (listener: T) => listeners.add(listener),
  removeListener: (listener: T) => listeners.delete(listener),
});
Object.assign(chrome.webNavigation, {
  getFrame: async ({ tabId }: chrome.webNavigation.GetFrameDetails) => {
    const url = typeof tabId === "number" ? frames.get(tabId) : undefined;
    return url ? { url } as chrome.webNavigation.GetFrameResultDetails : null;
  },
  onBeforeNavigate: navEvent(beforeListeners),
  onCommitted: navEvent(committedListeners),
  onHistoryStateUpdated: navEvent(historyListeners),
});
const createTab = chrome.tabs.create.bind(chrome.tabs);
vi.spyOn(chrome.tabs, "create").mockImplementation(async (properties) => {
  const tab = await createTab(properties);
  if (tab.id != null) {
    const url = properties.url ?? "about:blank";
    const details = { tabId: tab.id, frameId: 0, url } as chrome.webNavigation.WebNavigationBaseCallbackDetails;
    for (const listener of beforeListeners) listener(details);
    frames.set(tab.id, url);
    for (const listener of committedListeners) listener(details as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
  }
  return tab;
});

interface MockApi {
  baseUrl: string;
  state: {
    workContexts: Map<string, Record<string, unknown>>;
    workContextRequests: Array<Record<string, unknown>>;
    fillSessions: Map<string, Record<string, unknown>>;
    beforeWorkContextResponse?: ((request: Record<string, unknown>) => void | Promise<void>) | null;
  };
  close(): Promise<void>;
}

const FORM_URL = "https://portal.example.test/shared/enrollment";
const APP_ORIGIN = "https://mintedpanel.vercel.app";
const OWNER_A = "b7a90000-0000-4000-a000-0000000000c1";
const OWNER_B = "b7a90000-0000-4000-a000-0000000000c3";
const PORTAL_A = "44444444-4444-4444-8444-444444444441";
const PORTAL_B = "44444444-4444-4444-8444-444444444442";
const MAP_A = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAP_B = "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MAP_MANUAL = "bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeTuple(owner: "a" | "b"): WorkContextTuple {
  const isA = owner === "a";
  return {
    protocolVersion: 2,
    launchReceiptId: isA
      ? "11111111-1111-4111-8111-111111111111"
      : "22222222-2222-4222-8222-222222222222",
    ownerKind: "case",
    ownerId: isA ? OWNER_A : OWNER_B,
    contextVersion: isA ? 4 : 5,
    sopTemplateId: "33333333-3333-4333-8333-333333333333",
    sopVersion: isA ? 3 : 4,
    portalId: isA ? PORTAL_A : PORTAL_B,
    portalKey: isA ? "mint64_owner_a" : "mint64_owner_b",
    mappingGeneration: 1,
    effectiveMappingFingerprint: `sha256:${isA ? "a" : "b"}${"0".repeat(63)}`,
    providerId: isA ? FIXTURES.PROVIDER_ID : FIXTURES.PROVIDER2_ID,
    orgId: FIXTURES.PRIMARY_ORG,
    facilityId: isA ? null : FIXTURES.FACILITY2_ID,
    taskId: isA
      ? "66666666-6666-4666-8666-666666666666"
      : "66666666-6666-4666-8666-666666666667",
    stepId: isA
      ? "77777777-7777-4777-8777-777777777777"
      : "77777777-7777-4777-8777-777777777778",
    stepIdentity: isA ? "case:a:step:enrollment" : "case:b:step:enrollment",
  };
}

function mapRow(input: {
  id: string;
  portalKey: string;
  selector: string;
  source: "token" | "manual";
  token?: string | null;
  fieldType?: "text" | "file";
}) {
  return {
    id: input.id,
    orgId: null,
    portalKey: input.portalKey,
    urlPattern: null,
    pageStep: "1",
    mapType: "web",
    selector: input.selector,
    selectorFallbacks: null,
    source: input.source,
    token: input.token ?? null,
    hardcodedValue: null,
    transform: null,
    fieldType: input.fieldType ?? "text",
    notes: null,
    status: "approved",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  };
}

function launchMessage(tuple: WorkContextTuple): SetActiveWorkMessage {
  return { type: "SET_ACTIVE_WORK", ...tuple, portalUrl: FORM_URL };
}

function externalWorkLaunch(message: SetActiveWorkMessage): Promise<unknown> {
  const listener = stub.events.messageExternal.listeners.at(-1);
  if (!listener) throw new Error("The external Work listener was not registered.");
  return new Promise((resolve, reject) => {
    try {
      listener(message, { origin: APP_ORIGIN, tab: { windowId: 1 } }, resolve);
    } catch (error) {
      reject(error);
    }
  });
}

function configureWork(api: MockApi, tuple: WorkContextTuple, maps: Record<string, unknown>[]): void {
  const canonicalTuple = Object.fromEntries(
    Object.entries(tuple).filter(([key]) => key !== "protocolVersion"),
  );
  api.state.workContexts.set(tuple.portalKey, {
    tuple: canonicalTuple,
    caseType: "enrollment",
    formUrl: FORM_URL,
    requiresExplicitSelection: true,
    mappingGeneration: tuple.mappingGeneration,
    effectiveMappingFingerprint: tuple.effectiveMappingFingerprint,
    effectiveWebMaps: maps,
  });
}

let api: MockApi;
let handleRequest: typeof import("../background/index")["handleRequest"];

beforeAll(async () => {
  api = (await createMockPanelApi()) as MockApi;
  holder.baseUrl = api.baseUrl;
  ({ handleRequest } = await import("../background/index"));
});

afterAll(async () => {
  if (api) await api.close();
  vi.restoreAllMocks();
});

beforeEach(() => {
  stub.reset();
  frames.clear();
  api.state.workContexts.clear();
  api.state.workContextRequests.length = 0;
  api.state.fillSessions.clear();
  api.state.beforeWorkContextResponse = null;
});

describe("MINT-64 — integrated exact Work owner/config guard", () => {
  it("keeps same-origin same-URL owners on distinct keys and applies only the current owner's map", async () => {
    const tupleA = makeTuple("a");
    const tupleB = makeTuple("b");
    const mapA = mapRow({ id: MAP_A, portalKey: tupleA.portalKey, selector: "#owner-a", source: "token", token: "provider.firstName" });
    const mapB = mapRow({ id: MAP_B, portalKey: tupleB.portalKey, selector: "#owner-b", source: "token", token: "provider.npi" });
    const manualOnly = mapRow({ id: MAP_MANUAL, portalKey: tupleB.portalKey, selector: "label:Upload credential", source: "manual", fieldType: "file" });
    configureWork(api, tupleA, [mapA]);
    configureWork(api, tupleB, [mapB, manualOnly]);

    const launchA = await externalWorkLaunch(launchMessage(tupleA));
    const launchB = await externalWorkLaunch(launchMessage(tupleB));
    expect(launchA).toMatchObject({ ok: true, tabId: 700, portalUrl: FORM_URL });
    expect(launchB).toMatchObject({ ok: true, tabId: 701, portalUrl: FORM_URL });
    expect((launchA as { portalUrl: string }).portalUrl).toMatch(/^https:\/\/portal\.example\.test/);
    expect((launchB as { portalUrl: string }).portalUrl).toMatch(/^https:\/\/portal\.example\.test/);
    expect(api.state.workContextRequests.map((row) => row.portalKey)).toEqual([tupleA.portalKey, tupleB.portalKey]);
    expect(stub.sessionStore.get(ACTIVE_WORK_KEY)).toMatchObject({
      boundTabId: 701,
      formOrigin: "https://portal.example.test",
      tuple: { ownerId: OWNER_B, portalId: PORTAL_B, portalKey: tupleB.portalKey, providerId: FIXTURES.PROVIDER2_ID },
    });

    const applied: Array<{ tabId: number; mapIds: string[] }> = [];
    chrome.tabs.sendMessage = (async (tabId: number, rawMessage: unknown) => {
      const message = rawMessage as { type?: string; instructions?: Array<{ mapId: string; label: string; selector: string; token?: string }> };
      if (message.type === "PING") return { ok: true };
      if (message.type === "PROBE_FILL") {
        return {
          ok: true,
          data: (message.instructions ?? []).map(({ mapId }) => ({
            mapId,
            pageStatus: "eligible",
            targetStatus: "unique",
            pageSettled: true,
            radioGroup: false,
            pageFields: 2,
          })),
        };
      }
      if (message.type === "APPLY_FILL") {
        const instructions = message.instructions ?? [];
        applied.push({ tabId, mapIds: instructions.map((instruction) => instruction.mapId) });
        return {
          ok: true,
          data: {
            filled: instructions.map((instruction) => instruction.label),
            writes: instructions.map((instruction) => ({ selector: instruction.selector, kind: "static", token: instruction.token })),
            skipped: [],
            pageFields: 2,
          },
        };
      }
      throw new Error(`unexpected synthetic portal message ${message.type ?? "?"}`);
    }) as typeof chrome.tabs.sendMessage;

    // A second same-origin tab with the old owner's URL cannot borrow B's
    // receipt, even though both configurations point at the same URL.
    await expect(handleRequest({
      type: "FILL",
      tabId: 700,
      providerId: tupleA.providerId,
      caseId: tupleA.ownerId,
      portalKey: tupleA.portalKey,
      portalId: tupleA.portalId,
      mappingGeneration: tupleA.mappingGeneration,
      facilityId: tupleA.facilityId,
      state: "KS",
    })).rejects.toThrow(/different portal tab|exact Work context/i);
    expect(applied).toEqual([]);

    // Reopen B after the stale-tab attempt (which deliberately revokes the
    // singleton authorization), then execute B's own two-control config.
    const launchBRetry = await externalWorkLaunch(launchMessage(tupleB));
    expect(launchBRetry).toMatchObject({ ok: true, tabId: 702 });
    const result = await handleRequest({
      type: "FILL",
      tabId: 702,
      providerId: tupleB.providerId,
      caseId: tupleB.ownerId,
      portalKey: tupleB.portalKey,
      portalId: tupleB.portalId,
      mappingGeneration: tupleB.mappingGeneration,
      facilityId: tupleB.facilityId,
      state: "KS",
    }) as { filledLabels: string[]; manual: Array<{ label: string; kind: string }>; fillSessionId: string; eventRecorded: boolean };

    expect(applied).toEqual([{ tabId: 702, mapIds: [MAP_B] }]);
    expect(result.filledLabels).toEqual(["#owner-b"]);
    expect(result.manual).toContainEqual(expect.objectContaining({ label: "Upload credential", kind: "file" }));
    expect(result.eventRecorded).toBe(true);
    const receipt = api.state.fillSessions.get(result.fillSessionId);
    expect(receipt).toMatchObject({
      providerId: tupleB.providerId,
      caseId: tupleB.ownerId,
      portalKey: tupleB.portalKey,
      workContext: expect.objectContaining({ ownerId: tupleB.ownerId, portalId: tupleB.portalId, portalKey: tupleB.portalKey }),
    });
    expect(JSON.stringify(receipt)).not.toMatch(/Jordan|1987654321|Alex|1234567890/);
    expect(receipt).not.toHaveProperty("submit");
  });

  it("blocks a reset before prepare and rechecks it after a delayed page probe before apply", async () => {
    const tupleV1 = makeTuple("b");
    const maps = [mapRow({
      id: MAP_B,
      portalKey: tupleV1.portalKey,
      selector: "#owner-b",
      source: "token",
      token: "provider.npi",
    })];
    configureWork(api, tupleV1, maps);
    const launchV1 = await externalWorkLaunch(launchMessage(tupleV1));
    expect(launchV1).toMatchObject({ ok: true, tabId: 700 });

    const tabMessages: string[] = [];
    chrome.tabs.sendMessage = (async (_tabId: number, rawMessage: unknown) => {
      const message = rawMessage as { type?: string; instructions?: Array<{ mapId: string }> };
      tabMessages.push(message.type ?? "?");
      if (message.type === "PING") return { ok: true };
      if (message.type === "SCAN_UNMAPPED_CONTROLS") return { ok: true, data: [] };
      if (message.type === "PROBE_FILL") {
        return {
          ok: true,
          data: (message.instructions ?? []).map(({ mapId }) => ({
            mapId,
            pageStatus: "eligible",
            targetStatus: "unique",
            pageSettled: true,
            radioGroup: false,
            pageFields: 1,
          })),
        };
      }
      return { ok: true, data: { filled: [], writes: [], skipped: [], pageFields: 0 } };
    }) as typeof chrome.tabs.sendMessage;

    // A committed server-side reset invalidates the current worker tuple before
    // the panel can prepare any AI review or scan controls on the page.
    const tupleV2 = { ...tupleV1, mappingGeneration: 2, effectiveMappingFingerprint: `sha256:${"c".repeat(64)}` };
    configureWork(api, tupleV2, maps);
    await expect(handleRequest({
      type: "PREPARE_AI_FILL",
      tabId: 700,
      providerId: tupleV1.providerId,
      caseId: tupleV1.ownerId,
      portalKey: tupleV1.portalKey,
      portalId: tupleV1.portalId,
      mappingGeneration: tupleV1.mappingGeneration,
      state: "KS",
      facilityId: tupleV1.facilityId,
    })).rejects.toThrow(/mapping changed|reopen this task/i);
    expect(tabMessages).toEqual([]);

    // Relaunch the new generation, then hold the browser's synthetic probe
    // while the mock Panel commits another generation. The decisive MINT-64
    // check is that stale instructions never reach APPLY_FILL after that wait.
    const tupleV2Fresh = { ...tupleV2, launchReceiptId: "22222222-2222-4222-8222-222222222223" };
    configureWork(api, tupleV2Fresh, maps);
    const launchV2 = await externalWorkLaunch(launchMessage(tupleV2Fresh));
    expect(launchV2).toMatchObject({ ok: true, tabId: 701 });

    let releaseProbe!: () => void;
    let announceProbe!: () => void;
    const probeStarted = new Promise<void>((resolve) => { announceProbe = resolve; });
    const blockedProbe = new Promise<void>((resolve) => { releaseProbe = resolve; });
    let applies = 0;
    chrome.tabs.sendMessage = (async (_tabId: number, rawMessage: unknown) => {
      const message = rawMessage as { type?: string; instructions?: Array<{ mapId: string }> };
      if (message.type === "PING") return { ok: true };
      if (message.type === "PROBE_FILL") {
        announceProbe();
        await blockedProbe;
        return {
          ok: true,
          data: (message.instructions ?? []).map(({ mapId }) => ({
            mapId,
            pageStatus: "eligible",
            targetStatus: "unique",
            pageSettled: true,
            radioGroup: false,
            pageFields: 1,
          })),
        };
      }
      if (message.type === "APPLY_FILL") applies += 1;
      return { ok: true, data: { filled: [], writes: [], skipped: [], pageFields: 1 } };
    }) as typeof chrome.tabs.sendMessage;
    const pending = handleRequest({
      type: "FILL",
      tabId: 701,
      providerId: tupleV2Fresh.providerId,
      caseId: tupleV2Fresh.ownerId,
      portalKey: tupleV2Fresh.portalKey,
      portalId: tupleV2Fresh.portalId,
      mappingGeneration: tupleV2Fresh.mappingGeneration,
      state: "KS",
      facilityId: tupleV2Fresh.facilityId,
    });
    const rejectedFill = expect(pending).rejects.toThrow(/mapping changed|form or Work context changed|Fill failed/i);
    await probeStarted;
    const tupleV3 = { ...tupleV2Fresh, mappingGeneration: 3, effectiveMappingFingerprint: `sha256:${"d".repeat(64)}` };
    configureWork(api, tupleV3, maps);
    releaseProbe();
    await rejectedFill;
    expect(applies).toBe(0);
    expect(api.state.fillSessions.size).toBe(0);
  });

  it("cancels a fill when the selected location changes during owner validation", async () => {
    const tuple = makeTuple("b");
    configureWork(api, tuple, [mapRow({
      id: MAP_B,
      portalKey: tuple.portalKey,
      selector: "#owner-b",
      source: "token",
      token: "provider.npi",
    })]);
    const launch = await externalWorkLaunch(launchMessage(tuple));
    expect(launch).toMatchObject({ ok: true, tabId: 700 });

    let release!: () => void;
    let announce!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.state.beforeWorkContextResponse = async (request: Record<string, unknown>) => {
      if (request.launchReceiptId !== tuple.launchReceiptId || api.state.workContextRequests.length < 2) return;
      announce();
      await gate;
    };
    const messages: string[] = [];
    chrome.tabs.sendMessage = (async (_tabId: number, rawMessage: unknown) => {
      const message = rawMessage as { type?: string };
      messages.push(message.type ?? "?");
      if (message.type === "PING") return { ok: true };
      return { ok: true, data: [] };
    }) as typeof chrome.tabs.sendMessage;

    const pending = handleRequest({
      type: "FILL",
      tabId: 700,
      providerId: tuple.providerId,
      caseId: tuple.ownerId,
      portalKey: tuple.portalKey,
      portalId: tuple.portalId,
      mappingGeneration: tuple.mappingGeneration,
      facilityId: tuple.facilityId,
      state: "KS",
    });
    const rejected = expect(pending).rejects.toThrow(/Work context changed|location changed|Reopen the Work/i);
    await started;
    await handleRequest({
      type: "SET_SELECTED_FACILITY",
      providerId: tuple.providerId,
      facilityId: FIXTURES.FACILITY_ID,
    });
    release();
    await rejected;

    expect(messages).toEqual([]);
    expect(api.state.fillSessions.size).toBe(0);
  });
});
