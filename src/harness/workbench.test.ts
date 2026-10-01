// The TE-10 mock-harness scenarios (TS-80–TS-83, TS-100–TS-103) plus the TE-3
// latency budgets, driven through the REAL background modules (api / fill /
// activeCase) against the in-repo mock of the panel contract
// (scripts/mock-panel-api.mjs). No real payer portal and no real panel is
// ever contacted; auth is mocked to a fixture JWT the mock server accepts.
import { stub } from "./chromeStub";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
// @ts-expect-error — the mock server is an untyped .mjs harness module,
// deliberately outside the typechecked tree (it mirrors the panel repo's own
// scripts/mock-api-server.mjs pattern).
import { createMockPanelApi, FIXTURES } from "../../scripts/mock-panel-api.mjs";
import { buildSubmissionTouchBody } from "../shared/submission";
import {
  ApiError,
  apiFetch,
  getCaseContext,
  getNextBestAction,
  getPortalFieldMaps,
  getProviderProfile,
  getViewPrefs,
  postSubmissionTouch,
  putViewPrefs,
  searchCases,
  listProviders,
  searchProviders,
  completeTaskStep,
  proposeFieldMap,
  listSharedPortals,
  listSharedFieldMaps,
  proposeSharedFieldMap,
} from "../background/api";
import { writeActiveOrgId } from "../background/orgState";
import { readPanelMode, writePanelMode } from "../background/mode";
import {
  assignSortOrder,
  candidatePortalName,
  CAPTURE_TAB_MISMATCH_ERROR,
  decideCaptureStart,
  formCaptureState,
  recognizeForm,
  resolveTrainRecognition,
} from "../shared/trainForms";
import { coveragePortal, planFill } from "../background/fill";
import {
  bindFillTab,
  enterActiveCase,
  getActiveCaseState,
  handleExternalMessage,
  maybeBindPortalTab,
  onTabRemoved,
  readActiveCaseRecord,
  touchActiveCaseActivity,
  ACTIVE_CASE_KEY,
} from "../background/activeCase";
import { buildStructuredTouchBody } from "../shared/structuredTouch";
import { projectQuickCards, resolveLayout } from "../shared/quickCards";
import { providerGroupsLabel } from "../shared/browseProviders";
import { ACTIVE_CASE_IDLE_MS, type ActiveCaseRecord } from "../shared/handoff";
import type { PortalFieldMap, PortalRegistryRow } from "../shared/apiTypes";

const holder = vi.hoisted(() => ({ baseUrl: "" }));

vi.mock("../shared/config", () => ({
  SUPABASE_URL: "https://stub.supabase.invalid",
  SUPABASE_ANON_KEY: "stub-anon-key",
  get API_BASE_URL() {
    return holder.baseUrl;
  },
}));

vi.mock("../background/auth", () => {
  class AuthRequiredError extends Error {
    constructor() {
      super("Not signed in");
      this.name = "AuthRequiredError";
    }
  }
  return {
    AuthRequiredError,
    getAccessToken: async () => "tok-primary",
    forceRefresh: async () => {
      throw new AuthRequiredError();
    },
    getAuthState: async () => ({
      signedIn: true,
      email: "test.coordinator@example.com",
      name: "Test Coordinator",
    }),
    currentUserId: async () => "user-primary",
    signIn: async () => ({
      signedIn: true,
      email: "test.coordinator@example.com",
      name: "Test Coordinator",
    }),
    signOut: async () => {},
  };
});

interface MockApi {
  baseUrl: string;
  state: {
    fieldMaps: Array<{
      id: string;
      token: string | null;
      [key: string]: unknown;
    }>;
    touches: Map<string, unknown>;
    fillSessions: Map<string, Record<string, unknown>>;
    learnedMaps: Map<string, Record<string, unknown>>;
    learningRequests: Array<{ body: Record<string, unknown>; orgId: string | null }>;
    viewPrefs: Map<string, string[]>;
    failTouches: number;
    failLearnings: number;
    // S4.3: `${taskId}:${stepId}` for every step the mock accepted.
    completedSteps: Set<string>;
    // S5.1/S5.4: `${portalKey}:${selector}` -> the proposed row.
    proposedMaps: Map<string, { status: string; token: string | null }>;
    // E6.9: the shared (org-free) training tier — the global registry, its
    // field maps, the proposals written to it, and every x-org-id header
    // those routes were sent (null = none, which is the contract).
    sharedPortals: PortalRegistryRow[];
    sharedMaps: Array<Partial<PortalFieldMap> & { id: string }>;
    sharedProposed: Map<
      string,
      {
        id: string;
        orgId: string | null;
        selector: string;
        pageStep: string | null;
        sortOrder: number | null;
        status: string;
        token: string | null;
      }
    >;
    sharedOrgHeaders: Array<string | null>;
    // B1.1/B1.4: every request the mock handled, in order — so a test can
    // assert exactly one /profile request went out, and what its query
    // string carried.
    requests: Array<{ method: string; path: string }>;
  };
  close(): Promise<void>;
}

let mock: MockApi;

beforeAll(async () => {
  mock = (await createMockPanelApi()) as MockApi;
  holder.baseUrl = mock.baseUrl;
});

afterAll(async () => {
  await mock.close();
});

beforeEach(() => {
  stub.reset();
});

afterEach(() => {
  mock.state.touches.clear();
  mock.state.fillSessions.clear();
  mock.state.learningRequests.length = 0;
  mock.state.failTouches = 0;
  mock.state.failLearnings = 0;
});

const HANDOFF = {
  type: "SET_ACTIVE_CASE",
  caseId: FIXTURES.CASE_ID as string,
  providerId: FIXTURES.PROVIDER_ID as string,
  orgId: FIXTURES.PRIMARY_ORG as string,
  portalUrl: "https://portal.example.com/enroll/form",
};
const APP_ORIGIN = "https://mintedpanel.vercel.app";

const AI_FILL_SESSION = "11111111-2222-4333-8444-555555555566";
const AI_SELECTOR = "#ai-npi";
const AI_PAGE_URL = "https://portal.example.com/enroll/form";
const AI_MAPPING = {
  selector: AI_SELECTOR,
  token: "provider.npi",
  confidence: 0.93,
  fieldType: "text" as const,
  pageUrl: AI_PAGE_URL,
};

async function seedAcceptedAiLearningReceipt(options: {
  mappings?: typeof AI_MAPPING[];
  facilityId?: string | null;
  selectionRevision?: number;
  eventRecorded?: boolean;
} = {}) {
  const { AI_ACCEPTED_RECEIPT_KEY, AI_SELECTION_REVISION_KEY } = await import("../background/index");
  const mappings = options.mappings ?? [AI_MAPPING];
  const facilityId = options.facilityId === undefined ? FIXTURES.FACILITY_ID : options.facilityId;
  const selectionRevision = options.selectionRevision ?? 4;
  const reportKey = `minted.fillReport.${FIXTURES.PROVIDER_ID}.${FIXTURES.PORTAL_KEY}`;
  const learning = { state: "accepted" as const, confirmedSavedCount: 0, insertedCount: 0, preservedCount: 0 };
  await enterActiveCase({ caseId: FIXTURES.CASE_ID, providerId: FIXTURES.PROVIDER_ID, orgId: FIXTURES.PRIMARY_ORG });
  await writeActiveOrgId(FIXTURES.PRIMARY_ORG);
  await writePanelMode("case");
  stub.sessionStore.set("minted.workbenchOwner", FIXTURES.USER_ID);
  stub.sessionStore.set("minted.selectedProviderId", FIXTURES.PROVIDER_ID);
  stub.sessionStore.set(`minted.selectedCaseId.${FIXTURES.PROVIDER_ID}`, FIXTURES.CASE_ID);
  stub.sessionStore.set(`minted.selectedFacilityId.${FIXTURES.PROVIDER_ID}`, facilityId);
  stub.sessionStore.set(AI_SELECTION_REVISION_KEY, selectionRevision);
  stub.sessionStore.set(AI_ACCEPTED_RECEIPT_KEY, {
    tabId: 21,
    fillSessionId: AI_FILL_SESSION,
    providerId: FIXTURES.PROVIDER_ID,
    caseId: FIXTURES.CASE_ID,
    portalKey: FIXTURES.PORTAL_KEY,
    state: "KS",
    facilityId,
    orgId: FIXTURES.PRIMARY_ORG,
    actorId: FIXTURES.USER_ID,
    selectionRevision,
    touchRecorded: false,
    learning,
    mappings,
  });
  stub.sessionStore.set(reportKey, {
    tabId: 21,
    providerId: FIXTURES.PROVIDER_ID,
    portalKey: FIXTURES.PORTAL_KEY,
    caseId: FIXTURES.CASE_ID,
    completedAt: "2026-09-26T12:00:00.000Z",
    submitted: false,
    summary: {
      filled: mappings.length,
      filledLabels: mappings.map((mapping) => mapping.selector),
      skipped: [],
      manual: [],
      eventRecorded: options.eventRecorded ?? true,
      eventError: null,
      fillSessionId: AI_FILL_SESSION,
      pageFields: mappings.length,
      staticFilled: 0,
      aiFilled: mappings.length,
      writtenSelectors: mappings.map((mapping) => mapping.selector),
      orgId: FIXTURES.PRIMARY_ORG,
      facilityId,
      state: "KS",
      aiReview: {
        scanId: "scan-ai-session",
        fillSessionId: AI_FILL_SESSION,
        status: "ready",
        writes: mappings,
        unprocessedControls: 0,
        accepted: true,
        learning,
      },
    },
  });
  mock.state.fillSessions.set(AI_FILL_SESSION, {
    id: AI_FILL_SESSION,
    caseId: FIXTURES.CASE_ID,
    providerId: FIXTURES.PROVIDER_ID,
    portalKey: FIXTURES.PORTAL_KEY,
    fieldsFilled: mappings.length,
  });
  mock.state.learningRequests.length = 0;
  return { reportKey, mappings, learning };
}

async function forceIdle(minutes: number): Promise<void> {
  const record = (await readActiveCaseRecord()) as ActiveCaseRecord;
  stub.sessionStore.set(ACTIVE_CASE_KEY, {
    ...record,
    lastActivityAt: new Date(Date.now() - minutes * 60_000).toISOString(),
  });
}

describe("TS-80 — handoff receipt, tab isolation, expiry", () => {
  it("accepts SET_ACTIVE_CASE from the approved app origin and stores the context", async () => {
    const result = await handleExternalMessage(HANDOFF, APP_ORIGIN);
    expect(result).toEqual({ ok: true });
    const state = await getActiveCaseState();
    expect(state.status).toBe("active");
    if (state.status !== "active") return;
    expect(state.record.caseId).toBe(FIXTURES.CASE_ID);
    expect(state.record.providerId).toBe(FIXTURES.PROVIDER_ID);
    expect(state.record.orgId).toBe(FIXTURES.PRIMARY_ORG);
    expect(state.record.source).toBe("handoff");
    // An open panel is told the context changed.
    expect(stub.broadcasts).toContainEqual({ type: "ACTIVE_CASE_UPDATED" });
  });

  it("rejects a disallowed origin and malformed shapes — nothing stored", async () => {
    expect(
      await handleExternalMessage(HANDOFF, "https://evil.example.com"),
    ).toEqual({ ok: false });
    expect(
      await handleExternalMessage({ ...HANDOFF, caseId: "nope" }, APP_ORIGIN),
    ).toEqual({
      ok: false,
    });
    expect((await getActiveCaseState()).status).toBe("none");
  });

  it("last launch wins — a second handoff replaces the pending context", async () => {
    await handleExternalMessage(HANDOFF, APP_ORIGIN);
    await handleExternalMessage(
      { ...HANDOFF, caseId: FIXTURES.CASE2_ID },
      APP_ORIGIN,
    );
    const state = await getActiveCaseState();
    expect(state.status).toBe("active");
    if (state.status === "active")
      expect(state.record.caseId).toBe(FIXTURES.CASE2_ID);
  });

  it("binds the next tab on the portal origin — and only that origin", async () => {
    await handleExternalMessage(HANDOFF, APP_ORIGIN);
    await maybeBindPortalTab(7, "https://unrelated.example.com/page");
    expect((await readActiveCaseRecord())?.boundTabId).toBeNull();
    await maybeBindPortalTab(7, "https://portal.example.com/login");
    expect((await readActiveCaseRecord())?.boundTabId).toBe(7);
    // Already bound: a later tab never steals the binding.
    await maybeBindPortalTab(9, "https://portal.example.com/other");
    expect((await readActiveCaseRecord())?.boundTabId).toBe(7);
  });

  it("expires the context when the bound tab closes", async () => {
    await handleExternalMessage(HANDOFF, APP_ORIGIN);
    await maybeBindPortalTab(7, "https://portal.example.com/login");
    await onTabRemoved(3); // not the bound tab — no effect
    expect((await getActiveCaseState()).status).toBe("active");
    await onTabRemoved(7);
    expect((await getActiveCaseState()).status).toBe("expired");
  });

  it("expires after 60 idle minutes; activity resets the clock", async () => {
    await handleExternalMessage(HANDOFF, APP_ORIGIN);
    await forceIdle(59);
    expect((await getActiveCaseState()).status).toBe("active");
    await touchActiveCaseActivity();
    await forceIdle(61);
    expect((await getActiveCaseState()).status).toBe("expired");
    // An expired record is never resurrected by activity.
    await touchActiveCaseActivity();
    expect((await getActiveCaseState()).status).toBe("expired");
    expect(ACTIVE_CASE_IDLE_MS).toBe(60 * 60 * 1000);
  });

  it("TE-17: an in-panel selection enters the same state; a fill binds its tab", async () => {
    await enterActiveCase({
      caseId: FIXTURES.CASE_ID,
      providerId: FIXTURES.PROVIDER_ID,
      orgId: null,
    });
    const state = await getActiveCaseState();
    expect(state.status).toBe("active");
    if (state.status === "active") expect(state.record.source).toBe("panel");
    await bindFillTab(FIXTURES.CASE_ID, 11);
    expect((await readActiveCaseRecord())?.boundTabId).toBe(11);
    await onTabRemoved(11);
    expect((await getActiveCaseState()).status).toBe("expired");
  });

  it("serves the full case-context projection for the handed-off case", async () => {
    const context = await getCaseContext(FIXTURES.CASE_ID);
    expect(context.provider?.name).toBe("Alex Sample");
    expect(context.payer?.name).toBe("Regional Health Plan");
    expect(context.state).toBe("KS");
    expect(context.payerPipelineState).toBe("submitted");
    expect(context.referenceNumbers).toEqual(["REF-1001"]);
    expect(context.selectedFacility?.id).toBe(FIXTURES.FACILITY_ID);
    expect(context.openTasks?.map((t) => t.executionType)).toEqual([
      "extension_fill",
      "manual",
    ]);
  });
});

describe("TS-81 — read-only fill: every field accounted for, reasons surfaced", () => {
  it("coverage lists filled/unresolved per field — never silent-partial", async () => {
    const coverage = await coveragePortal({
      providerId: FIXTURES.PROVIDER_ID,
      portalKey: FIXTURES.PORTAL_KEY,
      state: "KS",
      facilityId: FIXTURES.FACILITY_ID,
    });
    // 5 mapped web fields: 3 fillable + 2 gaps — the counts always add up.
    expect(coverage.total).toBe(5);
    expect(coverage.available).toBe(3);
    expect(coverage.gaps).toHaveLength(2);
    for (const gap of coverage.gaps) {
      expect(gap.label).toBeTruthy();
      expect(gap.reason).toBeTruthy();
    }
    // The two gap KINDS route differently (F4.3.3): data gap vs mapping gap.
    const caqh = coverage.gaps.find(
      (g) => g.label.includes("caqh") || g.label.includes("#caqh"),
    );
    expect(caqh?.kind).toBe("no_value");
    // Fill summaries use fixed safe reason text instead of echoing arbitrary
    // unresolved text from the profile service.
    expect(caqh?.reason).toBe("no value in Minted Panel");
    const ptan = coverage.gaps.find((g) => g.label === "Group Medicare PTAN");
    expect(ptan?.kind).toBe("no_mapping");
  });
});

describe("TS-82 — fix-it improves the live session after a refetch", () => {
  it("a trained mapping moves the field from the gap list to fillable", async () => {
    const before = await coveragePortal({
      providerId: FIXTURES.PROVIDER_ID,
      portalKey: FIXTURES.PORTAL_KEY,
      state: "KS",
      facilityId: FIXTURES.FACILITY_ID,
    });
    expect(before.gaps.some((g) => g.label === "Group Medicare PTAN")).toBe(
      true,
    );

    // The platform's train flow (TE-4) approves the mapping — simulated as
    // the server-side change it is; the extension itself writes nothing.
    const row = mock.state.fieldMaps.find(
      (m) => m.id === FIXTURES.UNTRAINED_MAP_ID,
    );
    if (row) row.token = "provider.email";

    const after = await coveragePortal({
      providerId: FIXTURES.PROVIDER_ID,
      portalKey: FIXTURES.PORTAL_KEY,
      state: "KS",
      facilityId: FIXTURES.FACILITY_ID,
    });
    expect(after.available).toBe(before.available + 1);
    expect(after.gaps.some((g) => g.label === "Group Medicare PTAN")).toBe(
      false,
    );
  });
});

describe("TS-83 — typed touch with retry preservation + next-best-action handback", () => {
  const draft = {
    touchType: "portal",
    note: "Checked enrollment status",
    outcome: "successful",
    recipientName: "",
    recipientContact: "",
    followUpDate: "2026-07-31",
    trackingId: "REF-3003",
  };

  it("logs one structured touch; a same-id retry replays instead of double-logging", async () => {
    const id = crypto.randomUUID();
    const body = buildStructuredTouchBody(draft, id);
    const { touch: created } = await postSubmissionTouch(
      FIXTURES.CASE_ID,
      body,
    );
    expect(created.touchType).toBe("portal");
    expect(created.outcome).toBe("successful");
    const { touch: replayed } = await postSubmissionTouch(
      FIXTURES.CASE_ID,
      body,
    );
    expect(replayed.id).toBe(created.id);
    expect(mock.state.touches.size).toBe(1);
    mock.state.touches.clear();
  });

  it("a failed write retried with the SAME draft id converges on one touch", async () => {
    const id = crypto.randomUUID();
    const body = buildStructuredTouchBody(draft, id);
    mock.state.failTouches = 1;
    await expect(postSubmissionTouch(FIXTURES.CASE_ID, body)).rejects.toThrow(
      ApiError,
    );
    expect(mock.state.touches.size).toBe(0);
    // The retry reuses the same idempotency id (the panel preserves the draft).
    const { touch: retried } = await postSubmissionTouch(
      FIXTURES.CASE_ID,
      body,
    );
    expect(retried.id).toBe(id);
    expect(mock.state.touches.size).toBe(1);
    mock.state.touches.clear();
  });

  it("the server rejects a portal_submission-only field on a structured touch", async () => {
    const id = crypto.randomUUID();
    const body = {
      ...buildStructuredTouchBody(draft, id),
      task_id: FIXTURES.TASK_ID,
    };
    await expect(
      postSubmissionTouch(FIXTURES.CASE_ID, body as never),
    ).rejects.toThrow(/portal_submission/);
  });

  it("after logging, the queue top comes back server-ranked with a deep link", async () => {
    const result = await getNextBestAction();
    expect(result.item).not.toBeNull();
    expect(result.item?.caseId).toBe(FIXTURES.CASE2_ID);
    expect(result.item?.action).toBe("Follow up with National Health Plan");
    expect(result.item?.deadline?.overdue).toBe(true);
    expect(result.item?.deepLink).toBe(`/cases/${FIXTURES.CASE2_ID}`);
    // The handback enters the same active-case state as a handoff (TE-17).
    await enterActiveCase({
      caseId: result.item?.caseId as string,
      providerId: result.item?.providerId as string,
      orgId: null,
    });
    const state = await getActiveCaseState();
    expect(state.status).toBe("active");
    if (state.status === "active")
      expect(state.record.caseId).toBe(FIXTURES.CASE2_ID);
  });
});

describe("Step6 — accepted AI learning follows the logged human touch", () => {
  async function markSubmitted(fillSessionId = AI_FILL_SESSION) {
    const { handleRequest } = await import("../background/index");
    return handleRequest({
      type: "MARK_SUBMITTED",
      providerId: FIXTURES.PROVIDER_ID,
      caseId: FIXTURES.CASE_ID,
      portalKey: FIXTURES.PORTAL_KEY,
      fillSessionId,
    });
  }

  it("learns an accepted receipt only after the touch and keeps original iframe URLs value-free", async () => {
    const secondFrameUrl = "https://portal.example.com/embedded/step-2";
    const mappings = [
      AI_MAPPING,
      { ...AI_MAPPING, selector: "#ai-license", pageUrl: secondFrameUrl },
    ];
    const { reportKey } = await seedAcceptedAiLearningReceipt({ mappings });

    const result = await markSubmitted() as {
      learning: { state: string; confirmedSavedCount: number; insertedCount: number };
    };

    expect(result.learning).toMatchObject({ state: "learned", confirmedSavedCount: 2, insertedCount: 2 });
    expect(mock.state.touches.size).toBe(1);
    expect(mock.state.learningRequests).toHaveLength(2);
    expect(mock.state.learningRequests.map((entry) => entry.body.page_url).sort()).toEqual([
      AI_PAGE_URL,
      secondFrameUrl,
    ].sort());
    for (const { body } of mock.state.learningRequests) {
      expect(body).not.toHaveProperty("org_id");
      expect(body).not.toHaveProperty("actor_id");
      expect(JSON.stringify(body)).not.toContain("1234567890");
      expect(JSON.stringify(body)).not.toContain("Alex");
    }

    const storedReceipt = stub.sessionStore.get("minted.aiAcceptedReceipt") as Record<string, unknown>;
    expect(storedReceipt).toMatchObject({ touchRecorded: true, learning: { state: "learned" } });
    expect(JSON.stringify(stub.sessionStore.get(reportKey))).not.toContain("1234567890");
    expect(JSON.stringify(storedReceipt)).not.toContain("1234567890");

    // A subsequent fill's normal map fetch exposes the learned mapping as a
    // green static map; no special cache or client-side fallback is needed.
    const maps = await getPortalFieldMaps(FIXTURES.PORTAL_KEY);
    const { profile } = await getProviderProfile(FIXTURES.PROVIDER_ID, {
      facilityId: FIXTURES.FACILITY_ID,
      state: "KS",
    });
    expect(planFill(maps, profile).staticFills.map((fill) => fill.selector)).toContain(AI_SELECTOR);
  });

  it("does not learn when the AI suggestions were cleared before submission", async () => {
    await seedAcceptedAiLearningReceipt();
    const { handleRequest } = await import("../background/index");
    await handleRequest({ type: "CLEAR_AI_FILL", tabId: 21, fillSessionId: AI_FILL_SESSION });
    await markSubmitted();

    expect(mock.state.touches.size).toBe(1);
    expect(mock.state.learningRequests).toHaveLength(0);
  });

  it("does not learn when the AI review was never accepted", async () => {
    const { reportKey } = await seedAcceptedAiLearningReceipt();
    const report = stub.sessionStore.get(reportKey) as Record<string, unknown>;
    const summary = report.summary as Record<string, unknown>;
    const review = summary.aiReview as Record<string, unknown>;
    stub.sessionStore.set(reportKey, {
      ...report,
      summary: { ...summary, aiReview: { ...review, accepted: false } },
    });
    stub.sessionStore.set("minted.aiAcceptedReceipt", null);
    await markSubmitted();

    expect(mock.state.touches.size).toBe(1);
    expect(mock.state.learningRequests).toHaveLength(0);
  });

  it("keeps a failed touch separate from learning", async () => {
    await seedAcceptedAiLearningReceipt();
    mock.state.failTouches = 1;

    await expect(markSubmitted()).rejects.toThrow(ApiError);
    expect(mock.state.touches.size).toBe(0);
    expect(mock.state.learningRequests).toHaveLength(0);
    expect(stub.sessionStore.get("minted.aiAcceptedReceipt")).toMatchObject({
      touchRecorded: false,
      learning: { state: "accepted" },
    });
  });

  it("preserves a successful touch after learning fails and retry performs learning only", async () => {
    await seedAcceptedAiLearningReceipt();
    mock.state.failLearnings = 1;
    const first = await markSubmitted() as { learning: { state: string } };
    expect(first.learning.state).toBe("failed");
    expect(mock.state.touches.size).toBe(1);
    expect(mock.state.learningRequests).toHaveLength(1);
    const touchRequestsBeforeRetry = mock.state.requests.filter((entry) => entry.path.includes("/touches")).length;

    const { handleRequest } = await import("../background/index");
    const retried = await handleRequest({ type: "RETRY_AI_LEARNING", fillSessionId: AI_FILL_SESSION }) as {
      state: string;
      confirmedSavedCount: number;
    };
    expect(retried).toMatchObject({ state: "learned", confirmedSavedCount: 1 });
    expect(mock.state.touches.size).toBe(1);
    expect(mock.state.requests.filter((entry) => entry.path.includes("/touches"))).toHaveLength(touchRequestsBeforeRetry);
    expect(mock.state.learningRequests).toHaveLength(2);
  });

  it("returns honest idempotent replay counts and rejects learning after a facility switch", async () => {
    const { handleRequest, AI_ACCEPTED_RECEIPT_KEY } = await import("../background/index");
    await seedAcceptedAiLearningReceipt();
    // An approved matching map already exists. Retry confirms it, with no
    // inserted count, instead of inventing a newly saved Good Catch.
    mock.state.fieldMaps.push({
      ...(mock.state.fieldMaps.find((map) => map.selector === "#npi") ?? {}),
      id: "fm-ai-replay",
      selector: AI_SELECTOR,
      token: AI_MAPPING.token,
      status: "approved",
    });
    const receipt = stub.sessionStore.get(AI_ACCEPTED_RECEIPT_KEY) as Record<string, unknown>;
    stub.sessionStore.set(AI_ACCEPTED_RECEIPT_KEY, {
      ...receipt,
      touchRecorded: true,
      learning: { state: "failed", confirmedSavedCount: 0, insertedCount: 0, preservedCount: 0, reason: "request_failed" },
    });
    mock.state.touches.set("existing-touch", {
      id: "existing-touch", caseId: FIXTURES.CASE_ID,
      portalKey: FIXTURES.PORTAL_KEY, fillSessionId: AI_FILL_SESSION,
    });
    const replay = await handleRequest({ type: "RETRY_AI_LEARNING", fillSessionId: AI_FILL_SESSION }) as {
      state: string; confirmedSavedCount: number; insertedCount: number;
    };
    expect(replay).toMatchObject({ state: "learned", confirmedSavedCount: 1, insertedCount: 0 });

    // A different selected secondary facility revokes the persisted receipt;
    // the retry route makes no network write.
    await seedAcceptedAiLearningReceipt({ facilityId: FIXTURES.FACILITY_ID });
    const fresh = stub.sessionStore.get(AI_ACCEPTED_RECEIPT_KEY) as Record<string, unknown>;
    stub.sessionStore.set(AI_ACCEPTED_RECEIPT_KEY, {
      ...fresh,
      touchRecorded: true,
      learning: { state: "failed", confirmedSavedCount: 0, insertedCount: 0, preservedCount: 0, reason: "request_failed" },
    });
    stub.sessionStore.set(`minted.selectedFacilityId.${FIXTURES.PROVIDER_ID}`, FIXTURES.FACILITY2_ID);
    mock.state.touches.set("existing-touch-2", {
      id: "existing-touch-2", caseId: FIXTURES.CASE_ID,
      portalKey: FIXTURES.PORTAL_KEY, fillSessionId: AI_FILL_SESSION,
    });
    const requestsBefore = mock.state.learningRequests.length;
    const changed = await handleRequest({ type: "RETRY_AI_LEARNING", fillSessionId: AI_FILL_SESSION }) as { state: string };
    expect(changed.state).toBe("revoked");
    expect(mock.state.learningRequests).toHaveLength(requestsBefore);
  });

  it("rejects an A-to-B-to-A facility switch using the persisted selection revision", async () => {
    const { handleRequest } = await import("../background/index");
    await seedAcceptedAiLearningReceipt();
    await handleRequest({
      type: "SET_SELECTED_FACILITY",
      providerId: FIXTURES.PROVIDER_ID,
      facilityId: FIXTURES.FACILITY2_ID,
    });
    await handleRequest({
      type: "SET_SELECTED_FACILITY",
      providerId: FIXTURES.PROVIDER_ID,
      facilityId: FIXTURES.FACILITY_ID,
    });

    await expect(handleRequest({ type: "RETRY_AI_LEARNING", fillSessionId: AI_FILL_SESSION })).rejects.toThrow(/receipt/);
    expect(mock.state.learningRequests).toHaveLength(0);
  });

  it("survives worker restart from session receipt and refuses an unlogged fill report", async () => {
    const seeded = await seedAcceptedAiLearningReceipt();
    const { AI_ACCEPTED_RECEIPT_KEY } = await import("../background/index");
    const receipt = stub.sessionStore.get(AI_ACCEPTED_RECEIPT_KEY) as Record<string, unknown>;
    stub.sessionStore.set(AI_ACCEPTED_RECEIPT_KEY, {
      ...receipt,
      touchRecorded: true,
      learning: { state: "pending", confirmedSavedCount: 0, insertedCount: 0, preservedCount: 0 },
    });
    mock.state.touches.set("restart-touch", {
      id: "restart-touch", caseId: FIXTURES.CASE_ID,
      portalKey: FIXTURES.PORTAL_KEY, fillSessionId: AI_FILL_SESSION,
    });
    vi.resetModules();
    const workerAfterRestart = await import("../background/index");
    const restoredReport = await workerAfterRestart.handleRequest({
      type: "GET_FILL_REPORT", providerId: FIXTURES.PROVIDER_ID,
    }) as { submitted: boolean; summary: { aiReview?: { learning?: { state?: string } } } };
    expect(restoredReport).toMatchObject({
      submitted: true,
      summary: { aiReview: { learning: { state: "failed" } } },
    });
    const restored = await workerAfterRestart.handleRequest({ type: "RETRY_AI_LEARNING", fillSessionId: AI_FILL_SESSION }) as { state: string };
    expect(restored.state).toBe("learned");

    // A forged/stale accepted receipt without a successful fill-event report
    // is revoked and cannot become a learned portal map.
    await seedAcceptedAiLearningReceipt({ eventRecorded: false });
    const current = stub.sessionStore.get(workerAfterRestart.AI_ACCEPTED_RECEIPT_KEY) as Record<string, unknown>;
    stub.sessionStore.set(workerAfterRestart.AI_ACCEPTED_RECEIPT_KEY, {
      ...current,
      touchRecorded: true,
      learning: { state: "failed", confirmedSavedCount: 0, insertedCount: 0, preservedCount: 0, reason: "request_failed" },
    });
    mock.state.touches.set("unlogged-touch", {
      id: "unlogged-touch", caseId: FIXTURES.CASE_ID,
      portalKey: FIXTURES.PORTAL_KEY, fillSessionId: AI_FILL_SESSION,
    });
    const before = mock.state.learningRequests.length;
    const refused = await workerAfterRestart.handleRequest({ type: "RETRY_AI_LEARNING", fillSessionId: AI_FILL_SESSION }) as { state: string };
    expect(refused.state).toBe("revoked");
    expect(mock.state.learningRequests).toHaveLength(before);
    expect(seeded.mappings).toHaveLength(1);
  });
});

describe("TS-100 — unified standalone search", () => {
  it("finds cases by provider name, payer name, tracking ID, and case number", async () => {
    const byProvider = await searchCases("alex");
    expect(byProvider.map((r) => r.id)).toEqual([FIXTURES.CASE_ID]);
    expect(byProvider[0]?.providerName).toBe("Alex Sample");
    // Case search carries the case's facility so the panel can pre-select it.
    expect(byProvider[0]?.facilityId).toBe(FIXTURES.FACILITY_ID);
    const byPayer = await searchCases("national");
    expect(byPayer.map((r) => r.id)).toEqual([FIXTURES.CASE2_ID]);
    expect(byPayer[0]?.facilityId).toBeNull();
    const byRef = await searchCases("REF-1001");
    expect(byRef.map((r) => r.id)).toEqual([FIXTURES.CASE_ID]);
    expect((await searchCases("C-1001")).map((r) => r.id)).toEqual([
      FIXTURES.CASE_ID,
    ]);
    expect((await searchCases("1002")).map((r) => r.id)).toEqual([
      FIXTURES.CASE2_ID,
    ]);
    expect(await searchCases("   ")).toEqual([]);
  });

  it("finds providers over the PHI-minimized list projection", async () => {
    const rows = await searchProviders("jord");
    expect(rows.map((r) => r.id)).toEqual([FIXTURES.PROVIDER2_ID]);
    expect(rows[0]).not.toHaveProperty("ssnLast4");
    expect(rows[0]).not.toHaveProperty("dateOfBirth");
  });

  // 2026-08-19 — the row carries the provider's groups, so a search result can
  // name the group beside the person. Group names are not PHI; this asserts
  // the field survives the real fetch layer, not just the pure formatter.
  it("carries every group a provider works under, primary first", async () => {
    const rows = await listProviders();
    const alex = rows.find((r) => r.id === FIXTURES.PROVIDER_ID);
    expect(alex?.groups?.map((g) => g.name)).toEqual([
      "Lakeside PT Group",
      "Summit Health Group",
    ]);
    expect(alex?.groups?.[0]?.isPrimary).toBe(true);
    // The formatter the panel actually renders, over that same wire shape.
    expect(providerGroupsLabel(alex!)).toBe(
      "Lakeside PT Group · Summit Health Group",
    );
  });
});

describe("TS-101 — quick cards from the live profile endpoint", () => {
  it("projects honest empties (with reasons) and the <30-day expiry badge", async () => {
    const { profile } = await getProviderProfile(FIXTURES.PROVIDER_ID);
    const today = new Date().toISOString().slice(0, 10);
    const cards = projectQuickCards(
      profile.tokens,
      profile.unresolved,
      resolveLayout(null),
      today,
    );
    expect(cards.name).toBe("Alex Sample");
    expect(cards.dateOfBirth).toBe("1980-01-15");
    // CAQH is empty on the fixture — rendered honestly with the reason.
    const caqh = cards.type1Fields.find((f) => f.key === "provider.caqhId");
    expect(caqh?.value).toBeNull();
    expect(caqh?.reason).toBe("empty on provider");
    // The fixture license expires 20 days out — inside the amber window.
    expect(cards.license.expiry).toBe("expiring");
    expect(cards.groupName).toBe("Lakeside PT Group");
  });
});

// B1.1/B1.4 — a case whose location + state are known before the first read
// resolves PRACTICE LOCATION / FACILITY ASSIGNMENT / STATE LICENSE in ONE
// profile request, never a guessed facilityId, and never a second request
// when nothing needed correcting.
describe("B1.1/B1.4 — location + state resolve on the first profile read", () => {
  it("GET_PROVIDER_FACILITIES forwards a known facilityId+state to exactly ONE profile request, and it resolves (no needs_facility)", async () => {
    const { handleRequest } = await import("../background/index");
    mock.state.requests.length = 0;
    const info = (await handleRequest({
      type: "GET_PROVIDER_FACILITIES",
      providerId: FIXTURES.PROVIDER2_ID,
      // Jordan's NON-primary location — the one CASE3 points at.
      facilityId: FIXTURES.FACILITY_ID,
      state: "MO",
    })) as import("../shared/messages").ProviderFacilitiesInfo;

    const profileRequests = mock.state.requests.filter((r) =>
      r.path.startsWith(`/api/providers/${FIXTURES.PROVIDER2_ID}/profile`),
    );
    expect(profileRequests).toHaveLength(1);
    expect(profileRequests[0]!.path).toContain(`facilityId=${FIXTURES.FACILITY_ID}`);
    expect(profileRequests[0]!.path).toContain("state=MO");
    expect(info.needsFacility).toBe(false);
    expect(info.facilities.map((f) => f.id)).toContain(FIXTURES.FACILITY_ID);
  });

  it("the location, its assignment, and the matching state license all resolve — not nulls", async () => {
    const { profile } = await getProviderProfile(FIXTURES.PROVIDER2_ID, {
      facilityId: FIXTURES.FACILITY_ID,
      state: "MO",
    });
    const cards = projectQuickCards(
      profile.tokens,
      profile.unresolved,
      {
        fields: [
          "facility.name",
          "facility.street",
          "facility.city",
          "assignment.startDate",
          "license.licenseNumber",
          "license.state",
        ],
        source: "saved",
      },
      new Date().toISOString().slice(0, 10),
    );
    const value = (key: string) =>
      cards.type1Fields.find((f) => f.key === key)?.value;
    expect(value("facility.name")).toBe("Riverside Clinic");
    expect(value("facility.street")).toBe("1 Example St");
    expect(value("facility.city")).toBe("Riverside");
    expect(value("assignment.startDate")).toBe("2023-05-01");
    expect(value("license.licenseNumber")).toBe("MO-88888");
    expect(value("license.state")).toBe("MO");
  });

  it("never guesses a facility for a provider with several locations and no known pick — needs_facility stays up, nothing resolves", async () => {
    const { profile, meta } = await getProviderProfile(FIXTURES.PROVIDER2_ID);
    expect(meta?.needs_facility).toBe(true);
    const facilityName = profile.tokens.find((t) => t.token === "facility.name");
    expect(facilityName?.value).toBeNull();
    expect(profile.unresolved.some((u) => u.token === "facility.name")).toBe(true);
  });

  it("an unrecognized facilityId 404s rather than being guessed past", async () => {
    await expect(
      getProviderProfile(FIXTURES.PROVIDER2_ID, { facilityId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("several state licenses with no matching state param stay unresolved, not guessed", async () => {
    const { profile } = await getProviderProfile(FIXTURES.PROVIDER2_ID, {
      facilityId: FIXTURES.FACILITY2_ID,
    });
    const licenseNumber = profile.tokens.find((t) => t.token === "license.licenseNumber");
    expect(licenseNumber?.value).toBeNull();
  });
});

// B1.2 — a "quiet" case context (no note/touch/tasks/pipeline/refs) carries
// ONLY selectedFacility. This is the exact shape renderCaseContext's early
// return used to skip past before applying the facility (main.ts has no unit
// surface of its own — see panelMarkup.test.ts — so this pins the CONTRACT
// the fix depends on: the shape is real, and resolving that facility's own
// profile does populate the cards).
describe("B1.2 — a quiet case still carries (and resolves) its own location", () => {
  it("CASE3's context carries ONLY selectedFacility — no note/touch/tasks/pipeline/refs", async () => {
    const context = await getCaseContext(FIXTURES.CASE3_ID);
    expect(context.selectedFacility?.id).toBe(FIXTURES.FACILITY_ID);
    expect(context.referenceNumbers).toEqual([]);
    expect(context.latestNote).toBeNull();
    expect(context.latestTouch).toBeNull();
    expect(context.openTasks).toEqual([]);
    expect(context.payerPipelineState).toBe("not_started");
  });

  it("adopting that quiet case's own facility resolves its cards", async () => {
    const context = await getCaseContext(FIXTURES.CASE3_ID);
    const facilityId = context.selectedFacility?.id as string;
    const { profile } = await getProviderProfile(FIXTURES.PROVIDER2_ID, {
      facilityId,
      state: context.state,
    });
    const facilityName = profile.tokens.find((t) => t.token === "facility.name");
    expect(facilityName?.value).toBe("Riverside Clinic");
  });
});

// E1.5 — CASE3 (PROVIDER2, the two-facility provider from B1.4) doubles as
// the E1.4 multi-location fixture: its context.facilities carries BOTH of
// PROVIDER2's assigned locations, primary marked, so the Workbench can list
// every location while still filling exactly one at a time. The DOM list and
// the #facility-select rescope have no unit surface here (main.ts — see
// panelMarkup.test.ts, plus facilityPickerScope/facilityAddressLines's own
// pure-logic coverage in src/shared/caseContext.test.ts); this pins the
// WIRE-level guarantee those functions consume: the served shape, and that
// picking either of a case's two locations really does resolve DIFFERENT
// facility tokens (not the same one twice).
describe("E1.5 — a multi-location case's context carries every location, primary marked", () => {
  it("CASE3's context.facilities holds BOTH of PROVIDER2's locations, primary first", async () => {
    const context = await getCaseContext(FIXTURES.CASE3_ID);
    expect(context.facilities?.map((f) => ({ id: f.id, isPrimary: f.isPrimary }))).toEqual([
      { id: FIXTURES.FACILITY_ID, isPrimary: true },
      { id: FIXTURES.FACILITY2_ID, isPrimary: false },
    ]);
    // selectedFacility is the UNCHANGED primary mirror — still the same id.
    expect(context.selectedFacility?.id).toBe(FIXTURES.FACILITY_ID);
  });

  it("switching the fill target between the case's two locations re-resolves DIFFERENT facility.* tokens", async () => {
    const context = await getCaseContext(FIXTURES.CASE3_ID);
    const [primary, secondary] = context.facilities ?? [];
    expect(primary).toBeDefined();
    expect(secondary).toBeDefined();

    const { profile: primaryProfile } = await getProviderProfile(FIXTURES.PROVIDER2_ID, {
      facilityId: primary!.id,
      state: context.state,
    });
    const { profile: secondaryProfile } = await getProviderProfile(FIXTURES.PROVIDER2_ID, {
      facilityId: secondary!.id,
      state: context.state,
    });
    const nameOf = (p: typeof primaryProfile) =>
      p.tokens.find((t) => t.token === "facility.name")?.value;
    expect(nameOf(primaryProfile)).toBe("Riverside Clinic");
    expect(nameOf(secondaryProfile)).toBe("Midtown Clinic");
    expect(nameOf(primaryProfile)).not.toBe(nameOf(secondaryProfile));
  });

  it("a single-location case's facilities holds exactly its one primary location — every existing single-location shape is untouched", async () => {
    const context = await getCaseContext(FIXTURES.CASE_ID);
    expect(context.facilities).toEqual([
      expect.objectContaining({ id: FIXTURES.FACILITY_ID, isPrimary: true }),
    ]);
  });

  it("a case with no case_facilities rows carries an empty array (the common case — falls back to the provider's full set client-side, facilityPickerScope)", async () => {
    const context = await getCaseContext(FIXTURES.CASE2_ID);
    expect(context.facilities).toEqual([]);
    expect(context.selectedFacility).toBeNull();
  });
});

// B1.3 — the race the retry path guards against: concurrent requests for two
// different providers must never cross-contaminate a response. This is the
// wire-level guarantee main.ts's generation/provider/facility guards rely on;
// the DOM-side retry orchestration itself has no unit surface (main.ts —
// see panelMarkup.test.ts), so shouldRetryFacilityCards (src/shared/
// quickCards.ts) carries the retry DECISION's own unit coverage instead.
describe("B1.3 — concurrent facility reads never cross-contaminate", () => {
  it("two GET_PROVIDER_FACILITIES calls in flight together each resolve their OWN provider+facility", async () => {
    const { handleRequest } = await import("../background/index");
    const [a, b] = await Promise.all([
      handleRequest({
        type: "GET_PROVIDER_FACILITIES",
        providerId: FIXTURES.PROVIDER_ID,
        facilityId: FIXTURES.FACILITY_ID,
      }) as Promise<import("../shared/messages").ProviderFacilitiesInfo>,
      handleRequest({
        type: "GET_PROVIDER_FACILITIES",
        providerId: FIXTURES.PROVIDER2_ID,
        facilityId: FIXTURES.FACILITY2_ID,
        state: "KS",
      }) as Promise<import("../shared/messages").ProviderFacilitiesInfo>,
    ]);
    expect(a.facilities.map((f) => f.id)).toEqual([FIXTURES.FACILITY_ID]);
    expect(b.facilities.map((f) => f.id).sort()).toEqual(
      [FIXTURES.FACILITY_ID, FIXTURES.FACILITY2_ID].sort(),
    );
    expect(b.needsFacility).toBe(false);
  });
});

describe("S5.1/S5.3 — capture proposes, and learns", () => {
  it("writes a PROPOSED row with no token, whatever we ask for", async () => {
    const result = await proposeFieldMap({
      portal_key: "national_enroll",
      selector: "#npi",
      field_label: "NPI",
    });
    // Approving is a human act in the webapp; the panel can only propose.
    expect(result.map.status).toBe("proposed");
    expect(result.map.token).toBeNull();
    expect(mock.state.proposedMaps.get("national_enroll:#npi")?.status).toBe(
      "proposed",
    );
  });

  it("returns the learned suggestion with its payer-count evidence", async () => {
    const result = await proposeFieldMap({
      portal_key: "national_enroll",
      selector: "#npi2",
      field_label: "NPI",
    });
    expect(result.suggestion?.token).toBe("provider.npi");
    expect(result.suggestion?.portalCount).toBe(3);
  });

  it("returns no suggestion for a label nothing backs — an honest blank", async () => {
    const result = await proposeFieldMap({
      portal_key: "national_enroll",
      selector: "#mystery",
      field_label: "Mystery box",
    });
    expect(result.suggestion).toBeNull();
  });

  it("is idempotent on (portal_key, selector)", async () => {
    const a = await proposeFieldMap({
      portal_key: "p",
      selector: "#dup",
      field_label: "X",
    });
    const b = await proposeFieldMap({
      portal_key: "p",
      selector: "#dup",
      field_label: "X",
    });
    expect(a.map.id).toBe(b.map.id);
  });
});

describe("S4.4 — the opt-in status bump", () => {
  const submissionBody = (idempotencyId: string, bump: boolean) =>
    buildSubmissionTouchBody({
      portalKey: "regional_enrollment",
      fillSessionId: null,
      idempotencyId,
      bumpStatus: bump,
    });

  it("OMITS bump_status unless asked — a server predating S4.4 sees the old body", () => {
    const body = submissionBody(crypto.randomUUID(), false);
    expect("bump_status" in body).toBe(false);
  });

  it("reports an applied bump beside the touch", async () => {
    // CASE2 is In Progress — the legal source for the bump.
    const result = await postSubmissionTouch(
      FIXTURES.CASE2_ID,
      submissionBody(crypto.randomUUID(), true),
    );
    expect(result.touch.outcome).toBe("submitted");
    expect(result.statusBump).toEqual({ applied: true, reason: null });
  });

  it("reports a SKIPPED bump without failing the touch", async () => {
    // CASE_ID is already Submitted, so the transition is illegal — but the
    // touch itself must still land. A rejected bump is never a failed touch.
    const result = await postSubmissionTouch(
      FIXTURES.CASE_ID,
      submissionBody(crypto.randomUUID(), true),
    );
    expect(result.touch.id).toBeTruthy();
    expect(result.statusBump?.applied).toBe(false);
    expect(result.statusBump?.reason).toMatch(
      /status that can move to Submitted/,
    );
  });

  it("carries no bump meta when none was requested", async () => {
    const result = await postSubmissionTouch(
      FIXTURES.CASE2_ID,
      submissionBody(crypto.randomUUID(), false),
    );
    expect(result.statusBump).toBeNull();
  });
});

describe("S4.3 — the step tick writes, and never falsely succeeds", () => {
  it("ticks a step through the server", async () => {
    const result = await completeTaskStep("task-1", "step-1");
    expect(result.allDone).toBe(false);
    expect(mock.state.completedSteps.has("task-1:step-1")).toBe(true);
  });

  it("surfaces the server's ordering rejection instead of inventing one", async () => {
    // The ordering rule lives server-side (shared pure module with the
    // webapp). The panel must render the 409's message, not re-derive it.
    await expect(completeTaskStep("task-1", "blocked-step")).rejects.toThrow(
      /Complete "Upload W-9" first/,
    );
    // Nothing was recorded — a rejected tick must not look done.
    expect(mock.state.completedSteps.has("task-1:blocked-step")).toBe(false);
  });
});

describe("S4.1 — the fill report is a snapshot", () => {
  it("persists the run's own counts, so a later data change can't rewrite history", async () => {
    // The record carries the fill's OWN summary + completedAt. Nothing in the
    // restore path recomputes coverage — a field fixed after the run must not
    // retroactively change what the run reported.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/sidepanel/main.ts", "utf8") as string;
    const restore = source.slice(
      source.indexOf("async function restoreFillReport"),
      source.indexOf("function renderFacilityAddress"),
    );
    // It renders record.summary verbatim and never asks for fresh coverage.
    expect(restore).toContain("renderFillSummary(record.summary");
    expect(restore).not.toContain("GET_FILL_COVERAGE");
    expect(restore).not.toContain("refreshCoverage(");
  });

  it("restores ad hoc (case-free) fill report when no case is selected", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/sidepanel/main.ts", "utf8") as string;
    const restore = source.slice(
      source.indexOf("async function restoreFillReport"),
      source.indexOf("function renderFacilityAddress"),
    );
    // Does not exit immediately on null selectedCase, checks ad hoc matching
    expect(restore).not.toMatch(/if\s*\(\s*selectedCase\s*==\s*null\s*\)\s*return;/);
    expect(restore).toContain("isAdHoc");
    expect(restore).toContain("record.caseId != null");
  });
});

describe("S3.3 — the pickup queue is server-ranked", () => {
  it("returns a ranked list whose first entry IS the single-item top", async () => {
    const result = await getNextBestAction();
    const items = result.items ?? [];
    expect(items.length).toBeGreaterThan(1);
    const first = items[0];
    if (!first) throw new Error("expected a ranked first entry");
    // The extension must never re-rank: items[0] and item are the same case,
    // and the reason line is the server's text rendered verbatim.
    expect(result.item?.caseId).toBe(first.caseId);
    expect(first.reason).toBeTruthy();
  });

  it("honors ?limit= so a large org's queue is bounded", async () => {
    const one = await getNextBestAction(1);
    const items = one.items ?? [];
    expect(items).toHaveLength(1);
    const first = items[0];
    if (!first) throw new Error("expected a ranked first entry");
    expect(one.item?.caseId).toBe(first.caseId);
  });
});

describe("TS-102 — layout persists server-side across a worker restart", () => {
  it("saves, then reads the same layout back with no client-side cache", async () => {
    // Keys must be in the SERVED catalog now (schema-derived, 2026-07-28).
    const layout = ["provider.npi", "group.tin", "provider.caqhId"];
    await putViewPrefs(layout);
    // A worker restart holds NO state — the next read IS the restart path.
    const prefs = await getViewPrefs();
    expect(prefs.fields).toEqual(layout);
    expect(mock.state.viewPrefs.get("user-primary")).toEqual(layout);
  });

  it("GET serves the schema-derived catalog beside the layout (one round trip)", async () => {
    const prefs = await getViewPrefs();
    expect(prefs.catalog.length).toBeGreaterThan(0);
    const keys = prefs.catalog.map((f) => f.key);
    // ssnLast4 is OFFERED as of 2026-07-28 (product decision) — the profile
    // already returns it and payer forms ask for it. The FULL SSN has no
    // token to name (the vault is outside get_sop_field_tokens' sweep).
    expect(keys).toContain("provider.ssnLast4");
    expect(prefs.catalog.every((f) => f.label && f.groupLabel)).toBe(true);
  });

  it("a PUT naming ssnLast4 now validates; a non-catalog key still 422s", async () => {
    await putViewPrefs(["provider.ssnLast4", "provider.npi"]);
    expect(mock.state.viewPrefs.get("user-primary")).toEqual([
      "provider.ssnLast4",
      "provider.npi",
    ]);
    await expect(putViewPrefs(["provider.notARealColumn"])).rejects.toThrow(
      ApiError,
    );
  });

  it("an invalid stored layout degrades to the default, never a broken card", () => {
    const served = new Set(["provider.npi"]);
    expect(resolveLayout(["provider.npi", "bogus.key"], served).source).toBe(
      "default",
    );
    expect(resolveLayout(null, served).source).toBe("default");
  });
});

describe("TS-103 — escape hatch preserves the portal tab", () => {
  it("the card's webapp link opens in a NEW tab (target=_blank in the panel markup)", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync("sidepanel.html", "utf8") as string;
    const anchor = html.match(/<a[^>]*id="open-in-panel"[^>]*>/)?.[0] ?? "";
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noreferrer"');
  });
});

// ---------------------------------------------------------------------------
// E6.9 — Train forms: the org-free tier, page stamping, and recognition
// (TS-151, TS-152, TS-153) driven through the real background modules.
// ---------------------------------------------------------------------------
describe("E6.9 Train forms — the org-free shared tier", () => {
  beforeEach(async () => {
    stub.reset();
    mock.state.sharedOrgHeaders.length = 0;
    mock.state.sharedProposed.clear();
  });

  it("TS-151 — training carries NO x-org-id, even for a multi-org caller", async () => {
    // The mode is what decides this, not the path: an org is stored (the
    // multi-org case) and case-mode calls still carry it, but every training
    // call goes out without one. Sending it would land the capture in that
    // org's private overrides instead of the shared library.
    await writeActiveOrgId(FIXTURES.PRIMARY_ORG);
    await writePanelMode("train");

    await listSharedPortals();
    await proposeSharedFieldMap({
      portal_key: "national_join",
      selector: "#npi",
      field_label: "NPI",
      page_step: "Provider identity",
      field_type: "text",
      sort_order: 1,
    });

    expect(mock.state.sharedOrgHeaders).toEqual([null, null]);

    // And the row itself is shared, never the caller's org.
    const written = [...mock.state.sharedProposed.values()];
    expect(written).toHaveLength(1);
    expect(written[0]?.orgId).toBeNull();
    expect(written[0]?.status).toBe("proposed");
    expect(written[0]?.token).toBeNull();
  });

  it("M53 — uses explicit configuration routes while legacy no-query reads stay filtered", async () => {
    await writePanelMode("train");
    mock.state.requests.length = 0;
    mock.state.sharedOrgHeaders.length = 0;
    const legacy = mock.state.sharedPortals[0]!;
    legacy.mappingGeneration = null;
    legacy.caseType = null;
    legacy.requiresExplicitSelection = false;
    const explicit = {
      ...legacy,
      id: "shared-contract-1",
      portalKey: "aetna_contract",
      name: "Aetna Contract",
      caseType: "contract" as const,
      mappingGeneration: 7,
      requiresExplicitSelection: true,
    };
    mock.state.sharedPortals.push(explicit);
    try {
      const registry = await listSharedPortals();
      expect(registry.map((row) => row.portalKey)).toEqual(["national_join", "aetna_contract"]);
      expect(registry.find((row) => row.portalKey === "aetna_contract")).toMatchObject({
        caseType: "contract",
        mappingGeneration: 7,
      });
      expect(mock.state.requests.at(-1)?.path).toBe("/api/shared-portals?selection=explicit");

      const exact = await listSharedPortals("aetna_contract");
      expect(exact.map((row) => row.portalKey)).toEqual(["aetna_contract"]);
      expect(mock.state.requests.at(-1)?.path).toBe(
        "/api/shared-portals?selection=explicit&portal_key=aetna_contract",
      );
      await expect(listSharedPortals("missing_configuration")).rejects.toMatchObject({ status: 404 });

      await listSharedFieldMaps("aetna_contract");
      expect(mock.state.requests.at(-1)?.path).toBe(
        "/api/shared-field-maps?selection=explicit&portal_key=aetna_contract",
      );

      const legacyRead = await apiFetch<PortalRegistryRow[]>("/api/shared-portals");
      expect(legacyRead.data.map((row) => row.portalKey)).toEqual(["national_join"]);
      expect(mock.state.requests.at(-1)?.path).toBe("/api/shared-portals");
      expect(mock.state.sharedOrgHeaders).toEqual([null, null, null, null, null]);
    } finally {
      mock.state.sharedPortals.splice(mock.state.sharedPortals.indexOf(explicit), 1);
    }
  });

  it("TS-151b — a hand-off lands in Work cases whatever job was selected", async () => {
    // The chooser must never stand between the webapp's launch and the case
    // it launched — and leaving the panel in training mode would also strip
    // the org header off the calls that case needs.
    await writePanelMode("train");
    const accepted = await handleExternalMessage(
      {
        type: "SET_ACTIVE_CASE",
        caseId: FIXTURES.CASE_ID,
        providerId: FIXTURES.PROVIDER_ID,
        orgId: FIXTURES.PRIMARY_ORG,
        portalUrl: "https://portal.example.com/x",
      },
      "https://mintedpanel.vercel.app",
    );
    expect(accepted).toEqual({ ok: true });
    expect(await readPanelMode()).toBe("case");
  });

  it("TS-152 — a page's fields propose with their page and DOM order", async () => {
    await writePanelMode("train");
    const rows = assignSortOrder([
      { label: "First name", selector: "#first" },
      { label: "Last name", selector: "#last" },
    ]);
    for (const row of rows) {
      await proposeSharedFieldMap({
        portal_key: "national_join",
        selector: row.selector,
        field_label: row.label,
        page_step: "Provider identity",
        field_type: "text",
        sort_order: row.sortOrder,
      });
    }
    const written = [...mock.state.sharedProposed.values()];
    expect(written.map((r) => [r.selector, r.pageStep, r.sortOrder])).toEqual([
      ["#first", "Provider identity", 1],
      ["#last", "Provider identity", 2],
    ]);
    // Shape only: no value key exists in this contract, so none can ride in.
    for (const row of written) {
      expect(Object.keys(row)).not.toContain("value");
    }
  });

  it("TS-152b — re-capturing a page returns the SAME row, decision intact", async () => {
    await writePanelMode("train");
    const first = await proposeSharedFieldMap({
      portal_key: "national_join",
      selector: "#npi",
      field_label: "NPI",
      page_step: "Page 1",
      field_type: "text",
      sort_order: 1,
    });
    const again = await proposeSharedFieldMap({
      portal_key: "national_join",
      selector: "#npi",
      field_label: "NPI number",
      page_step: "Page 1",
      field_type: "text",
      sort_order: 1,
    });
    // Idempotent on (portal_key, selector) — this is what makes re-capture
    // drift repair rather than a reset.
    expect(again.id).toBe(first.id);
    expect(mock.state.sharedProposed.size).toBe(1);
  });

  it("TS-158 — captured option vocabulary rides the shared propose, shape-only", async () => {
    await writePanelMode("train");
    const map = await proposeSharedFieldMap({
      portal_key: "national_join",
      selector: "#practice-state",
      field_label: "Practice State",
      field_type: "select",
      sort_order: 1,
      control_options: [
        { value: "KS", label: "Kansas" },
        { value: "MO", label: "Missouri" },
        { value: "NE", label: "Nebraska" },
      ],
    });
    expect(map.orgId).toBeNull();
    expect(map.status).toBe("proposed");
    expect(map.token).toBeNull();
    expect(map.controlOptions).toEqual([
      { value: "KS", label: "Kansas" },
      { value: "MO", label: "Missouri" },
      { value: "NE", label: "Nebraska" },
    ]);
    expect(JSON.stringify(map)).not.toMatch(/selected|checked/i);
  });

  it("TS-159 — re-capture refreshes a non-empty list and ignores an empty one", async () => {
    await writePanelMode("train");
    const first = await proposeSharedFieldMap({
      portal_key: "national_join",
      selector: "#practice-state",
      field_label: "Practice State",
      field_type: "select",
      control_options: [
        { value: "KS", label: "Kansas" },
        { value: "MO", label: "Missouri" },
      ],
    });
    const withNew = await proposeSharedFieldMap({
      portal_key: "national_join",
      selector: "#practice-state",
      field_label: "Practice State",
      field_type: "select",
      control_options: [
        { value: "KS", label: "Kansas" },
        { value: "MO", label: "Missouri" },
        { value: "NE", label: "Nebraska" },
      ],
    });
    expect(withNew.id).toBe(first.id);
    expect(withNew.status).toBe("proposed");
    expect(withNew.token).toBeNull();
    expect(withNew.controlOptions).toEqual([
      { value: "KS", label: "Kansas" },
      { value: "MO", label: "Missouri" },
      { value: "NE", label: "Nebraska" },
    ]);
    const empty = await proposeSharedFieldMap({
      portal_key: "national_join",
      selector: "#practice-state",
      field_label: "Practice State",
      field_type: "select",
      control_options: [],
    });
    expect(empty.id).toBe(first.id);
    expect(empty.controlOptions).toEqual(withNew.controlOptions);
    expect(mock.state.sharedProposed.size).toBe(1);
  });

  it("TS-153 — a known form is recognized with what it already has; a new one is greeted", async () => {
    await writePanelMode("train");
    const registry = await listSharedPortals();

    const known = recognizeForm(
      "https://portal.example.com/national/join/start?session=abc",
      registry,
      "National Health Plan",
    );
    expect(known.kind).toBe("existing");
    if (known.kind === "existing") expect(known.portal.key).toBe("national_join");

    const unknown = recognizeForm(
      "https://other.example/apply",
      registry,
      "Example Insurance Co.",
    );
    expect(unknown).toEqual({ kind: "new", candidateName: "Example Insurance Co. form" });

    // A second form for a payer that already has one is numbered, never a
    // block and never an overwrite.
    expect(candidatePortalName("National Health Plan", registry)).toBe("National Health Plan form 2");

    // Nothing was written by recognizing anything.
    expect(mock.state.sharedProposed.size).toBe(0);
  });

  it("TS-153b — the recognized form reports its capture state honestly", async () => {
    await writePanelMode("train");
    mock.state.sharedMaps = [
      {
        id: "s1",
        orgId: null,
        portalKey: "national_join",
        selector: "#npi",
        pageStep: "Page 1",
        source: "token",
        token: "provider.npi",
        hardcodedValue: null,
        status: "approved",
      },
      {
        id: "s2",
        orgId: null,
        portalKey: "national_join",
        selector: "#tin",
        pageStep: "Page 2",
        source: "manual",
        token: null,
        hardcodedValue: null,
        status: "proposed",
      },
    ];
    const maps = await listSharedFieldMaps("national_join");
    expect(formCaptureState(maps)).toEqual({
      pagesSeen: 2,
      fieldsCaptured: 2,
      mapped: 1,
      undecided: 1,
    });
    mock.state.sharedMaps = [];
  });

  it("TRAIN-DUAL — mismatched capture rejects START_CAPTURE (helper + source tripwire)", async () => {
    await writePanelMode("train");
    const registry = await listSharedPortals();
    // Behavioral half (real): decideCaptureStart must refuse a login wall /
    // stale key so START_CAPTURE is not authorized.
    const rejected = decideCaptureStart({
      portalKey: "national_join",
      tabId: 7,
      tabUrl: "https://login.example/sso",
      rows: registry,
    });
    expect(rejected).toEqual({ ok: false, reason: "key-mismatch" });
    expect(mock.state.sharedProposed.size).toBe(0);

    // Wiring half is ONLY a source tripwire against retyping the stale
    // portalTabId hand-patch — it does NOT click the button, mock
    // chrome.tabs / sendToBackground, or prove the handler uses the decision.
    // Full click-path coverage waits on TD-51 / TD-50 extract (see TECH-DEBT).
    // CAP-05 moved the gate into async startCapture(); listeners only dispatch
    // mode. Slice that function — not the thin click wrappers — for the tripwire.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/sidepanel/main.ts", "utf8") as string;
    const captureFn = source.slice(
      source.indexOf("async function startCapture("),
      source.indexOf("captureSend.addEventListener"),
    );
    expect(captureFn).toContain("decideCaptureStart(");
    expect(captureFn).toContain("decision.tabId");
    expect(captureFn).toContain("await detectPortal()");
    expect(captureFn).toContain("CAPTURE_TAB_MISMATCH_ERROR");
    expect(captureFn).not.toMatch(/portalTabId = portal \? tabId/);
    expect(CAPTURE_TAB_MISMATCH_ERROR).toMatch(/no longer matches/);

    // Selection sticky + mismatch copy still routes through resolveTrainRecognition.
    const view = resolveTrainRecognition({
      url: "https://login.example/sso",
      rows: registry,
      payerName: "National Health Plan",
      selectedPortalKey: "national_join",
    });
    expect(view.status).toBe("mismatch");
    expect(view.portal).toBeNull();
  });
});

describe("BITE-CAP-05 — identify page after scan (multi-page session)", () => {
  // Drives the real background START_CAPTURE handler against a stubbed
  // SCAN_FIELDS reply — no real portal, no panel API needed beyond the
  // existing mock server.
  let scanPayload: Array<{
    label: string;
    selector: string;
    fieldType: string;
    formSection: string | null;
  }>;
  let previousSendMessage: typeof chrome.tabs.sendMessage;
  let previousTabGet: typeof chrome.tabs.get;
  let previousFetch: typeof fetch;
  let pickPayload: unknown;
  let captureTarget: {
    portalKey: string;
    mappingGeneration: number;
    targetRevision: number;
  };
  const capturePortalRow = {
    id: "shared-regional-enrollment",
    orgId: null,
    portalKey: "regional_enrollment",
    name: "Regional Health Plan network enrollment",
    payerId: null,
    payerName: "Regional Health Plan",
    caseType: "enrollment",
    mappingGeneration: 1,
    requiresExplicitSelection: true,
    formUrl: "https://portal.example.com/regional/enroll/form",
    isVerified: true,
    lastVerifiedAt: null,
    provenAt: null,
    urlChangedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
  } satisfies PortalRegistryRow;

  beforeAll(async () => {
    // Importing the worker registers messaging; handleRequest is the same
    // path the onMessage listener uses.
    await import("../background/index");
  });

  beforeEach(async () => {
    stub.reset();
    mock.state.sharedPortals.push(capturePortalRow);
    scanPayload = [];
    pickPayload = { status: "cancelled" };
    previousSendMessage = chrome.tabs.sendMessage;
    previousTabGet = chrome.tabs.get;
    previousFetch = globalThis.fetch;
    chrome.tabs.get = (async (tabId: number) => ({
      id: tabId,
      url: "https://portal.example.com/regional/enroll/form/step1",
      active: true,
      windowId: 1,
    })) as typeof chrome.tabs.get;
    chrome.tabs.sendMessage = (async (
      _tabId: number,
      message: { type?: string },
    ) => {
      if (message?.type === "PING") return { ok: true };
      if (message?.type === "SCAN_FIELDS")
        return { ok: true, data: scanPayload };
      if (message?.type === "PICK_ELEMENT")
        return { ok: true, data: pickPayload };
      throw new Error(`unexpected tab message: ${message?.type ?? "?"}`);
    }) as typeof chrome.tabs.sendMessage;
    await writePanelMode("train");
    const { handleRequest } = await import("../background/index");
    const state = await handleRequest({
      type: "SET_TRAIN_TARGET",
      portalKey: capturePortalRow.portalKey,
      mappingGeneration: capturePortalRow.mappingGeneration,
    }) as import("../shared/trainTarget").TrainTargetState;
    captureTarget = {
      portalKey: capturePortalRow.portalKey,
      mappingGeneration: capturePortalRow.mappingGeneration,
      targetRevision: state.revision,
    };
  });

  afterEach(() => {
    chrome.tabs.sendMessage = previousSendMessage;
    chrome.tabs.get = previousTabGet;
    globalThis.fetch = previousFetch;
    const index = mock.state.sharedPortals.indexOf(capturePortalRow);
    if (index >= 0) mock.state.sharedPortals.splice(index, 1);
  });

  it("keeps page 1 rows and decisions when a disjoint page 2 is scanned", async () => {
    const { handleRequest } = await import("../background/index");
    const { usedPageNames, captureCounts } = await import("../shared/capture");
    // Capture is Train-only; Work cases refuses START_CAPTURE.
    await writePanelMode("train");

    scanPayload = [
      {
        label: "First",
        selector: "#p1a",
        fieldType: "text",
        formSection: null,
      },
      {
        label: "Second",
        selector: "#p1b",
        fieldType: "text",
        formSection: null,
      },
    ];
    const page1 = (await handleRequest({
      type: "START_CAPTURE",
      tabId: 1,
      ...captureTarget,
      pageStep: "step1",
      pageUrlTail: "step1",
      captureMode: "auto",
    })) as import("../shared/capture").CaptureSession;
    expect(usedPageNames(page1)).toEqual(["step1"]);

    await handleRequest({
      type: "SET_CAPTURE_CHOICE",
      selector: "#p1a",
      token: "provider.firstName",
      ...captureTarget,
    });

    // Disjoint selectors + a different URL tail candidate — must become a
    // second page, not collapse onto step1 (the CAP-01 unconditional-reuse
    // regression that wiped page 1 via mergePageCapture).
    scanPayload = [
      { label: "TIN", selector: "#p2a", fieldType: "text", formSection: null },
      { label: "NPI", selector: "#p2b", fieldType: "text", formSection: null },
    ];
    const page2 = (await handleRequest({
      type: "START_CAPTURE",
      tabId: 1,
      ...captureTarget,
      pageStep: "step2",
      pageUrlTail: "step2",
      captureMode: "auto",
    })) as import("../shared/capture").CaptureSession;

    expect(usedPageNames(page2)).toEqual(["step1", "step2"]);
    expect(captureCounts(page2).total).toBe(4);
    const kept = page2.rows.find((r) => r.selector === "#p1a");
    expect(kept?.pageStep).toBe("step1");
    expect(kept?.chosenToken).toBe("provider.firstName");
    expect(
      page2.rows.filter((r) => r.pageStep === "step2").map((r) => r.selector),
    ).toEqual(["#p2a", "#p2b"]);

    const switched = await handleRequest({
      type: "SET_TRAIN_TARGET",
      portalKey: "national_join",
      mappingGeneration: 1,
    }) as import("../shared/trainTarget").TrainTargetState;
    expect(await handleRequest({
      type: "GET_CAPTURE",
      portalKey: "national_join",
      mappingGeneration: 1,
      targetRevision: switched.revision,
    })).toBeNull();
  });

  it("keeps approved local decisions on a same-generation page recapture", async () => {
    const { handleRequest } = await import("../background/index");
    scanPayload = [{ label: "Member ID", selector: "#member-id", fieldType: "text", formSection: null }];
    await handleRequest({
      type: "START_CAPTURE",
      tabId: 1,
      ...captureTarget,
      pageStep: "member-details",
      pageUrlTail: "step1",
      captureMode: "auto",
    });
    await handleRequest({
      type: "SET_CAPTURE_CHOICE",
      selector: "#member-id",
      token: "provider.npi",
      ...captureTarget,
    });

    scanPayload = [{ label: "Member identification number", selector: "#member-id", fieldType: "text", formSection: null }];
    const recaptured = await handleRequest({
      type: "START_CAPTURE",
      tabId: 1,
      ...captureTarget,
      pageStep: "member-details",
      pageUrlTail: "step1",
      captureMode: "auto",
    }) as import("../shared/capture").CaptureSession;

    expect(recaptured.mappingGeneration).toBe(captureTarget.mappingGeneration);
    expect(recaptured.rows).toMatchObject([{
      selector: "#member-id",
      label: "Member identification number",
      chosenToken: "provider.npi",
    }]);
  });

  it("sends the exact pinned key and generation with shared-map and proof writes", async () => {
    const { handleRequest } = await import("../background/index");
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (init?.method === "POST" &&
          ["/api/shared-field-maps", "/api/shared-portals/prove"].includes(url.pathname)) {
        writes.push({ path: url.pathname, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      }
      return fetchBefore(input, init);
    }) as typeof fetch;

    try {
      scanPayload = [{ label: "Provider number", selector: "#provider-number", fieldType: "text", formSection: null }];
      await handleRequest({
        type: "START_CAPTURE",
        tabId: 1,
        ...captureTarget,
        pageStep: "provider-details",
        pageUrlTail: "step1",
        captureMode: "auto",
      });
      await handleRequest({ type: "SEND_CAPTURE", ...captureTarget });
      await handleRequest({ type: "MARK_PORTAL_PROVEN", ...captureTarget });

      expect(writes.find((write) => write.path === "/api/shared-field-maps")?.body).toMatchObject({
        portal_key: captureTarget.portalKey,
        expected_mapping_generation: captureTarget.mappingGeneration,
        selector: "#provider-number",
      });
      expect(writes.find((write) => write.path === "/api/shared-portals/prove")?.body).toEqual({
        portalKey: captureTarget.portalKey,
        expected_mapping_generation: captureTarget.mappingGeneration,
      });
      expect(JSON.stringify(writes)).not.toMatch(/provider value|123-45-6789/i);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });

  it("clears the matching draft and returns refresh guidance on a stale generation 409", async () => {
    const { handleRequest } = await import("../background/index");
    const fetchBefore = globalThis.fetch;
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/api/shared-field-maps" && init?.method === "POST") {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          data: null,
          error: "The form mapping changed. Reload the configuration before capturing fields again.",
          meta: null,
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return fetchBefore(input, init);
    }) as typeof fetch;

    try {
      scanPayload = [{ label: "Plan ID", selector: "#plan-id", fieldType: "text", formSection: null }];
      await handleRequest({
        type: "START_CAPTURE",
        tabId: 1,
        ...captureTarget,
        pageStep: "provider-details",
        pageUrlTail: "step1",
        captureMode: "auto",
      });
      expect(stub.sessionStore.has("capture.session")).toBe(true);

      await expect(handleRequest({ type: "SEND_CAPTURE", ...captureTarget })).rejects.toMatchObject({
        status: 409,
        message: "This form configuration's mapping generation changed. Refresh Train forms, select its current generation, and recapture before continuing.",
      });
      expect(body).toMatchObject({
        portal_key: captureTarget.portalKey,
        expected_mapping_generation: captureTarget.mappingGeneration,
      });
      expect(stub.sessionStore.has("capture.session")).toBe(false);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });

  it("clears the matching draft when the proof write is rejected as stale", async () => {
    const { handleRequest } = await import("../background/index");
    const fetchBefore = globalThis.fetch;
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/api/shared-portals/prove" && init?.method === "POST") {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          data: null,
          error: "The form mapping changed. Reload the configuration before marking it proven.",
          meta: null,
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return fetchBefore(input, init);
    }) as typeof fetch;

    try {
      scanPayload = [{ label: "Provider number", selector: "#provider-number", fieldType: "text", formSection: null }];
      await handleRequest({
        type: "START_CAPTURE",
        tabId: 1,
        ...captureTarget,
        pageStep: "provider-details",
        pageUrlTail: "step1",
        captureMode: "auto",
      });
      expect(stub.sessionStore.has("capture.session")).toBe(true);

      await expect(handleRequest({ type: "MARK_PORTAL_PROVEN", ...captureTarget })).rejects.toMatchObject({
        status: 409,
        message: "This form configuration's mapping generation changed. Refresh Train forms, select its current generation, and recapture before continuing.",
      });
      expect(body).toEqual({
        portalKey: captureTarget.portalKey,
        expected_mapping_generation: captureTarget.mappingGeneration,
      });
      expect(stub.sessionStore.has("capture.session")).toBe(false);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });

  it("does not clear the new A draft when a stale A write returns after A→B→A", async () => {
    const { handleRequest } = await import("../background/index");
    let announceWrite!: () => void;
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => { announceWrite = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/api/shared-field-maps" && init?.method === "POST") {
        announceWrite();
        await writeGate;
        return new Response(JSON.stringify({
          data: null,
          error: "The form mapping changed. Reload the configuration before capturing fields again.",
          meta: null,
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return fetchBefore(input, init);
    }) as typeof fetch;

    try {
      scanPayload = [{ label: "Old A field", selector: "#old-a", fieldType: "text", formSection: null }];
      await handleRequest({
        type: "START_CAPTURE",
        tabId: 1,
        ...captureTarget,
        pageStep: "provider-details",
        pageUrlTail: "step1",
        captureMode: "auto",
      });
      const staleSend = handleRequest({ type: "SEND_CAPTURE", ...captureTarget });
      await writeStarted;

      await handleRequest({ type: "SET_TRAIN_TARGET", portalKey: "same-url-sibling", mappingGeneration: 1 });
      const nextA = await handleRequest({
        type: "SET_TRAIN_TARGET",
        portalKey: captureTarget.portalKey,
        mappingGeneration: captureTarget.mappingGeneration,
      }) as import("../shared/trainTarget").TrainTargetState;
      const nextATarget = { ...captureTarget, targetRevision: nextA.revision };
      scanPayload = [{ label: "New A field", selector: "#new-a", fieldType: "text", formSection: null }];
      await handleRequest({
        type: "START_CAPTURE",
        tabId: 1,
        ...nextATarget,
        pageStep: "provider-details",
        pageUrlTail: "step1",
        captureMode: "auto",
      });

      releaseWrite();
      await expect(staleSend).rejects.toMatchObject({ status: 409 });
      expect(stub.sessionStore.get("capture.session")).toMatchObject({
        portalKey: captureTarget.portalKey,
        mappingGeneration: captureTarget.mappingGeneration,
        rows: [{ selector: "#new-a", label: "New A field" }],
      });
      expect(stub.sessionStore.get("capture.trainTarget")).toMatchObject({ revision: nextA.revision });
    } finally {
      releaseWrite();
      globalThis.fetch = fetchBefore;
    }
  });

  it("rejects a scan result that arrives after the exact target changes", async () => {
    const { handleRequest } = await import("../background/index");
    let announceScan!: () => void;
    let releaseScan!: (value: unknown) => void;
    const scanStarted = new Promise<void>((resolve) => { announceScan = resolve; });
    const delayedScan = new Promise<unknown>((resolve) => { releaseScan = resolve; });
    chrome.tabs.sendMessage = (async (
      _tabId: number,
      message: { type?: string },
    ) => {
      if (message?.type === "PING") return { ok: true };
      if (message?.type === "SCAN_FIELDS") {
        announceScan();
        return delayedScan;
      }
      throw new Error(`unexpected tab message: ${message?.type ?? "?"}`);
    }) as typeof chrome.tabs.sendMessage;

    const pendingCapture = handleRequest({
      type: "START_CAPTURE",
      tabId: 1,
      ...captureTarget,
      pageStep: "step1",
      pageUrlTail: "step1",
      captureMode: "auto",
    });
    await scanStarted;
    const switched = await handleRequest({
      type: "SET_TRAIN_TARGET",
      portalKey: "national_join",
      mappingGeneration: 1,
    }) as import("../shared/trainTarget").TrainTargetState;
    releaseScan({ ok: true, data: scanPayload });

    await expect(pendingCapture).rejects.toThrow(/configuration changed/);
    expect(switched.portalKey).toBe("national_join");
    expect(await handleRequest({
      type: "GET_CAPTURE",
      portalKey: "national_join",
      mappingGeneration: 1,
      targetRevision: switched.revision,
    })).toBeNull();
  });

  it("rejects an exact map-list result that arrives after a target switch", async () => {
    const { handleRequest } = await import("../background/index");
    let announceRequest!: () => void;
    let releaseRequest!: () => void;
    const requestStarted = new Promise<void>((resolve) => { announceRequest = resolve; });
    const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/shared-field-maps?") && url.includes("portal_key=regional_enrollment")) {
        announceRequest();
        await requestGate;
      }
      return fetchBefore(input, init);
    }) as typeof fetch;

    try {
      const pendingMaps = handleRequest({ type: "LIST_SHARED_FIELD_MAPS", ...captureTarget });
      await requestStarted;
      await handleRequest({
        type: "SET_TRAIN_TARGET",
        portalKey: "national_join",
        mappingGeneration: 1,
      });
      releaseRequest();
      await expect(pendingMaps).rejects.toThrow(/configuration changed/);
    } finally {
      releaseRequest();
      globalThis.fetch = fetchBefore;
    }
  });

  it("rejects a proof acknowledgement that arrives after a target switch", async () => {
    const { handleRequest } = await import("../background/index");
    let announceRequest!: () => void;
    let releaseRequest!: () => void;
    const requestStarted = new Promise<void>((resolve) => { announceRequest = resolve; });
    const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/shared-portals/prove")) {
        announceRequest();
        await requestGate;
      }
      return fetchBefore(input, init);
    }) as typeof fetch;

    try {
      const pendingProof = handleRequest({ type: "MARK_PORTAL_PROVEN", ...captureTarget });
      await requestStarted;
      await handleRequest({
        type: "SET_TRAIN_TARGET",
        portalKey: "national_join",
        mappingGeneration: 1,
      });
      releaseRequest();
      await expect(pendingProof).rejects.toThrow(/configuration changed/);
    } finally {
      releaseRequest();
      globalThis.fetch = fetchBefore;
    }
  });

  it("does not apply a late mock-map result to a different target", async () => {
    const { handleRequest } = await import("../background/index");
    let announceRequest!: () => void;
    let releaseRequest!: () => void;
    let fillMessages = 0;
    const requestStarted = new Promise<void>((resolve) => { announceRequest = resolve; });
    const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const fetchBefore = globalThis.fetch;
    const sendBefore = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = (async (_tabId: number, message: { type?: string }) => {
      if (message?.type === "FILL_FIELDS") fillMessages += 1;
      if (message?.type === "PING") return { ok: true };
      throw new Error(`unexpected tab message: ${message?.type ?? "?"}`);
    }) as typeof chrome.tabs.sendMessage;
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/shared-field-maps?")) {
        announceRequest();
        await requestGate;
      }
      return fetchBefore(input, init);
    }) as typeof fetch;

    try {
      const pendingMock = handleRequest({
        type: "RUN_MOCK_DRY_RUN",
        tabId: 1,
        ...captureTarget,
      });
      await requestStarted;
      await handleRequest({
        type: "SET_TRAIN_TARGET",
        portalKey: "national_join",
        mappingGeneration: 1,
      });
      releaseRequest();
      await expect(pendingMock).rejects.toThrow(/configuration changed/);
      expect(fillMessages).toBe(0);
    } finally {
      releaseRequest();
      globalThis.fetch = fetchBefore;
      chrome.tabs.sendMessage = sendBefore;
    }
  });

  it("re-points a drifted library field under the library's own name", async () => {
    // The drift repair: the trainer clicks where the field moved to, and the
    // proposal has to be recognisable in the web app as the SAME field rather
    // than an anonymous new one — otherwise a reviewer sees a stranger and the
    // old map with no way to connect them.
    const { handleRequest } = await import("../background/index");
    await writePanelMode("train");
    scanPayload = [
      { label: "First", selector: "#a", fieldType: "text", formSection: null },
    ];
    await handleRequest({
      type: "START_CAPTURE",
      tabId: 1,
      ...captureTarget,
      pageStep: "step1",
      pageUrlTail: "step1",
      captureMode: "auto",
    });

    pickPayload = {
      status: "picked",
      field: {
        // The portal calls the new control something else entirely.
        label: "txtNPI2",
        selector: "#npi-moved",
        fieldType: "text",
        formSection: null,
      },
    };
    const session = (await handleRequest({
      type: "PICK_CAPTURE_FIELD",
      tabId: 1,
      ...captureTarget,
      pageStep: "step1",
      displayLabel: "Provider NPI",
    })) as {
      rows: Array<{
        selector: string;
        displayLabel?: string | null;
        label: string;
      }>;
    };

    const added = session.rows.find((r) => r.selector === "#npi-moved");
    expect(added?.displayLabel).toBe("Provider NPI");
    // The portal's own text is preserved beside it, never overwritten.
    expect(added?.label).toBe("txtNPI2");
  });

  it("leaves an ordinary hand-added field unnamed for the portal's text", async () => {
    const { handleRequest } = await import("../background/index");
    await writePanelMode("train");
    scanPayload = [
      { label: "First", selector: "#a", fieldType: "text", formSection: null },
    ];
    await handleRequest({
      type: "START_CAPTURE",
      tabId: 1,
      ...captureTarget,
      pageStep: "step1",
      pageUrlTail: "step1",
      captureMode: "auto",
    });
    pickPayload = {
      status: "picked",
      field: {
        label: "NPI",
        selector: "#npi",
        fieldType: "text",
        formSection: null,
      },
    };
    const session = (await handleRequest({
      type: "PICK_CAPTURE_FIELD",
      tabId: 1,
      ...captureTarget,
      pageStep: "step1",
    })) as { rows: Array<{ selector: string; displayLabel?: string | null }> };
    expect(
      session.rows.find((r) => r.selector === "#npi")?.displayLabel,
    ).toBeNull();
  });

  it("refuses START_CAPTURE in Work cases mode", async () => {
    const { handleRequest } = await import("../background/index");
    await writePanelMode("case");
    scanPayload = [
      { label: "First", selector: "#a", fieldType: "text", formSection: null },
    ];
    await expect(
      handleRequest({
        type: "START_CAPTURE",
        tabId: 1,
        ...captureTarget,
        pageStep: "step1",
        pageUrlTail: "step1",
        captureMode: "auto",
      }),
    ).rejects.toThrow(/Train forms/);
  });
});

// ---------------------------------------------------------------------------
// US-5 sandbox actions — the worker's own is_test_provider re-check.
//
// The panel is expected to keep sandboxActive in sync with the real
// selection, but the worker must not TRUST that: a stale panel state (or any
// other caller) sending a real provider id must never reach a live portal
// through the no-attribution, no-touch sandbox path — nor clear a real,
// in-progress form. Proven at the handleRequest boundary — the same path
// chrome.runtime.onMessage uses — against the mock server's own roster, not
// a stub. Both SANDBOX_FILL and CLEAR_PORTAL_FORM share the guard
// (assertSandboxProvider in background/index.ts).
// ---------------------------------------------------------------------------
describe("SANDBOX_FILL / CLEAR_PORTAL_FORM — refuse any provider that isn't the designated sandbox profile", () => {
  let previousSendMessage: typeof chrome.tabs.sendMessage;

  beforeEach(async () => {
    stub.reset();
    await writeActiveOrgId(FIXTURES.PRIMARY_ORG);
    await writePanelMode("case");
    previousSendMessage = chrome.tabs.sendMessage;
  });

  afterEach(() => {
    chrome.tabs.sendMessage = previousSendMessage;
  });

  it("rejects a real, non-designated provider before ever touching the tab", async () => {
    const { handleRequest } = await import("../background/index");
    // No PING/APPLY_FILL stub installed on purpose: a passing test here must
    // mean the guard fired before any tab message was sent, not that a
    // lenient stub happened to answer one.
    chrome.tabs.sendMessage = (async () => {
      throw new Error(
        "SANDBOX_FILL must not message the tab for a refused provider",
      );
    }) as typeof chrome.tabs.sendMessage;

    await expect(
      handleRequest({
        type: "SANDBOX_FILL",
        tabId: 1,
        providerId: FIXTURES.PROVIDER_ID, // a real roster provider, not the sandbox one
        portalKey: FIXTURES.PORTAL_KEY,
        state: null,
        facilityId: null,
      }),
    ).rejects.toThrow(/designated sandbox test profile/);
  });

  it("allows the fill once the request really names the designated sandbox provider", async () => {
    const { handleRequest } = await import("../background/index");
    const originalMaps = [...mock.state.fieldMaps];
    const controlledMapId = "4d0d6e10-4f6f-4a7d-8d80-5a3a16ea4e73";
    const firstMap = originalMaps[0];
    if (!firstMap) throw new Error("mock panel needs its base approved field map");
    mock.state.fieldMaps.splice(0, mock.state.fieldMaps.length, {
      ...firstMap,
      id: controlledMapId,
      selector: "label:First name",
      pageStep: null,
      mapType: "web",
      source: "token",
      token: "provider.firstName",
      status: "approved",
    });

    try {
      chrome.tabs.sendMessage = (async (
        _tabId: number,
        rawMessage: unknown,
      ) => {
        const message = rawMessage as {
          type?: string;
          instructions?: Array<{
            mapId: string;
            label: string;
            telemetry?: { targetKey: string; frameKey: string; stepKey: string | null };
          }>;
        };
        if (message?.type === "PING") return { ok: true };
        if (message?.type === "PROBE_FILL") {
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
        if (message?.type === "APPLY_FILL") {
          const instruction = message.instructions?.[0];
          const telemetry = instruction?.telemetry;
          const outcomeMapId = instruction?.mapId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instruction.mapId)
            ? instruction.mapId
            : null;
          return {
            ok: true,
            data: {
              filled: instruction ? [instruction.label] : [],
              attemptedLabels: instruction ? [instruction.label] : [],
              skipped: [],
              pageFields: 1,
              fieldOutcomes: instruction && telemetry ? [{
                // The content producer normalizes non-UUID mock map IDs to null
                // before returning its value-free V2 outcome.
                mapId: outcomeMapId,
                targetKey: telemetry.targetKey,
                frameKey: telemetry.frameKey,
                stepKey: telemetry.stepKey,
                attempted: true,
                outcome: "unverified",
                reasonCode: "readback_unavailable",
              }] : [],
            },
          };
        }
        throw new Error(`unexpected tab message: ${message?.type ?? "?"}`);
      }) as typeof chrome.tabs.sendMessage;

      const summary = (await handleRequest({
        type: "SANDBOX_FILL",
        tabId: 1,
        providerId: FIXTURES.SANDBOX_PROVIDER_ID,
        portalKey: FIXTURES.PORTAL_KEY,
        state: null,
        facilityId: null,
      })) as import("../shared/fill").SandboxFillSummary;

      expect(summary).toMatchObject({
        fieldsAttempted: 1,
        fieldsVerified: 0,
        fieldsRejected: 0,
        filled: 0,
        attemptedLabels: ["First name"],
        notChecked: [],
        skipped: [],
        manual: [],
        logError: null,
      });
      expect(summary.fieldOutcomes).toHaveLength(1);
      expect(summary.fieldOutcomes?.[0]).toMatchObject({
        mapId: controlledMapId,
        attempted: true,
        outcome: "unverified",
        reasonCode: "readback_unavailable",
      });
    } finally {
      mock.state.fieldMaps.splice(0, mock.state.fieldMaps.length, ...originalMaps);
    }
  });

  it("refuses CLEAR_PORTAL_FORM for a real, non-designated provider before touching the tab", async () => {
    const { handleRequest } = await import("../background/index");
    chrome.tabs.sendMessage = (async () => {
      throw new Error(
        "CLEAR_PORTAL_FORM must not message the tab for a refused provider",
      );
    }) as typeof chrome.tabs.sendMessage;

    await expect(
      handleRequest({
        type: "CLEAR_PORTAL_FORM",
        tabId: 1,
        providerId: FIXTURES.PROVIDER_ID, // a real roster provider, not the sandbox one
      }),
    ).rejects.toThrow(/designated sandbox test profile/);
  });

  it("clears the form once the request really names the designated sandbox provider", async () => {
    const { handleRequest } = await import("../background/index");
    chrome.tabs.sendMessage = (async (
      _tabId: number,
      message: { type?: string },
    ) => {
      if (message?.type === "PING") return { ok: true };
      if (message?.type === "CLEAR_FORM") return { ok: true, data: 2 };
      throw new Error(`unexpected tab message: ${message?.type ?? "?"}`);
    }) as typeof chrome.tabs.sendMessage;

    const result = (await handleRequest({
      type: "CLEAR_PORTAL_FORM",
      tabId: 1,
      providerId: FIXTURES.SANDBOX_PROVIDER_ID,
    })) as { cleared: number };

    expect(result.cleared).toBe(2);
  });
});

describe("TE-3 — latency budgets on the seeded mock harness", () => {
  let slow: MockApi;

  beforeAll(async () => {
    // 400ms per request: serial context+profile+maps would take ≥1200ms, so
    // the budget assertions below PROVE the concurrent fetch, not just a fast
    // localhost.
    slow = (await createMockPanelApi({ delayMs: 400 })) as MockApi;
    holder.baseUrl = slow.baseUrl;
  });

  afterAll(async () => {
    holder.baseUrl = mock.baseUrl;
    await slow.close();
  });

  it("case context is visible within the 1s budget", async () => {
    const start = performance.now();
    await getCaseContext(FIXTURES.CASE_ID);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("fill-ready (context + profile + maps, fetched concurrently) beats the 2s budget", async () => {
    const start = performance.now();
    await Promise.all([
      getCaseContext(FIXTURES.CASE_ID),
      getProviderProfile(FIXTURES.PROVIDER_ID, {
        state: "KS",
        facilityId: FIXTURES.FACILITY_ID,
      }),
      getPortalFieldMaps(FIXTURES.PORTAL_KEY),
    ]);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000); // the TE-3 budget
    expect(elapsed).toBeLessThan(1100); // < 3×400ms ⇒ genuinely concurrent
  });
});

describe("Astra F2 — worker cancellation stays live through delayed frame apply", () => {
  const TAB_ID = 91;
  const TAB_URL = "https://portal.example.com/enroll/form";
  const FRAME_URL = "https://portal.example.com/enroll/embedded";
  const frames = [
    { frameId: 0, url: TAB_URL },
    { frameId: 3, url: FRAME_URL },
  ];
  let previousSendMessage: typeof chrome.tabs.sendMessage;
  let previousTabGet: typeof chrome.tabs.get;
  let previousGetAllFrames: typeof chrome.webNavigation.getAllFrames;

  beforeEach(async () => {
    stub.reset();
    const { handleRequest } = await import("../background/index");
    await handleRequest({ type: "SET_ACTIVE_ORG", orgId: FIXTURES.PRIMARY_ORG });
    await handleRequest({
      type: "ENTER_ACTIVE_CASE",
      caseId: FIXTURES.CASE_ID,
      providerId: FIXTURES.PROVIDER_ID,
      orgId: FIXTURES.PRIMARY_ORG,
    });
    await handleRequest({ type: "SET_SELECTED_PROVIDER", providerId: FIXTURES.PROVIDER_ID });
    await handleRequest({ type: "SET_SELECTED_CASE", providerId: FIXTURES.PROVIDER_ID, caseId: FIXTURES.CASE_ID });
    await handleRequest({ type: "SET_SELECTED_FACILITY", providerId: FIXTURES.PROVIDER_ID, facilityId: FIXTURES.FACILITY_ID });

    stub.setQueryTabs([{ id: TAB_ID, url: TAB_URL, active: true, windowId: 1 } as chrome.tabs.Tab]);
    previousSendMessage = chrome.tabs.sendMessage;
    previousTabGet = chrome.tabs.get;
    previousGetAllFrames = chrome.webNavigation.getAllFrames;
    chrome.tabs.get = (async (tabId: number) => ({
      id: tabId,
      url: TAB_URL,
      active: true,
      windowId: 1,
    })) as typeof chrome.tabs.get;
    chrome.webNavigation.getAllFrames = (async () => frames) as unknown as typeof chrome.webNavigation.getAllFrames;
  });

  afterEach(() => {
    chrome.tabs.sendMessage = previousSendMessage;
    chrome.tabs.get = previousTabGet;
    chrome.webNavigation.getAllFrames = previousGetAllFrames;
  });

  it("cancels a static ad hoc fill after a group A-B-A switch before any page write", async () => {
    const { handleRequest } = await import("../background/index");
    const { AD_HOC_CASE_SELECTION } = await import("../shared/messages");
    await handleRequest({ type: "CLEAR_ACTIVE_CASE" });
    await handleRequest({ type: "SET_SELECTED_CASE", providerId: FIXTURES.PROVIDER_ID, caseId: AD_HOC_CASE_SELECTION });
    await handleRequest({ type: "SET_SELECTED_GROUP", providerId: FIXTURES.PROVIDER_ID, groupId: "group-A" });

    let releaseFrames!: () => void;
    let announceFrames!: () => void;
    const frameLookupStarted = new Promise<void>((resolve) => { announceFrames = resolve; });
    const blockedFrames = new Promise<void>((resolve) => { releaseFrames = resolve; });
    chrome.webNavigation.getAllFrames = (async () => {
      announceFrames();
      await blockedFrames;
      return frames;
    }) as unknown as typeof chrome.webNavigation.getAllFrames;
    const applied: string[] = [];
    chrome.tabs.sendMessage = (async (_tabId: number, rawMessage: unknown, options?: chrome.tabs.MessageSendOptions) => {
      const message = rawMessage as { type: string; instructions?: Array<{ mapId: string }> };
      const frameId = options?.frameId ?? 0;
      if (message.type === "PROBE_FILL") {
        return {
          ok: true,
          data: (message.instructions ?? []).map(({ mapId }) => ({
            mapId,
            pageStatus: "eligible",
            targetStatus: frameId === 0 ? "unique" : "missing",
            pageSettled: true,
            radioGroup: false,
            pageFields: 1,
          })),
        };
      }
      if (message.type.startsWith("APPLY_")) applied.push(message.type);
      return { ok: true, data: { filled: [], writes: [], skipped: [], pageFields: 0 } };
    }) as typeof chrome.tabs.sendMessage;
    const request = {
      type: "FILL" as const, tabId: TAB_ID, providerId: FIXTURES.PROVIDER_ID,
      caseId: null, groupId: "group-A", facilityId: FIXTURES.FACILITY_ID,
      state: "CO", portalKey: FIXTURES.PORTAL_KEY,
    };
    const pending = handleRequest(request);
    const rejected = expect(pending).rejects.toThrow();
    await frameLookupStarted;
    await handleRequest({ type: "SET_SELECTED_GROUP", providerId: FIXTURES.PROVIDER_ID, groupId: "group-B" });
    await handleRequest({ type: "SET_SELECTED_GROUP", providerId: FIXTURES.PROVIDER_ID, groupId: "group-A" });
    releaseFrames();
    await rejected;
    expect(applied).toEqual([]);
    expect(mock.state.fillSessions.size).toBe(0);

    // The same choices remain usable immediately; cancellation adds no lock.
    await expect(handleRequest(request)).resolves.toMatchObject({ eventRecorded: true });
    expect(applied).toContain("APPLY_FILL");
    expect(await handleRequest({ type: "GET_FILL_REPORT", providerId: FIXTURES.PROVIDER_ID }))
      .toMatchObject({ caseId: null, groupId: "group-A" });
    expect(await handleRequest({ type: "GET_SELECTED_GROUP", providerId: FIXTURES.PROVIDER_ID })).toBe("group-A");
    await handleRequest({ type: "SET_ACTIVE_ORG", orgId: "another-org" });
    expect(await handleRequest({ type: "GET_SELECTED_GROUP", providerId: FIXTURES.PROVIDER_ID })).toBeNull();
  });

  it.each([
    [null, "group-A", FIXTURES.FACILITY_ID],
    ["__ad_hoc__", null, FIXTURES.FACILITY_ID],
    ["__ad_hoc__", "group-A", null],
  ])("rejects incomplete ad hoc choices in the worker (%s, %s, %s)", async (caseChoice, groupId, facilityId) => {
    const { handleRequest } = await import("../background/index");
    await handleRequest({ type: "CLEAR_ACTIVE_CASE" });
    await handleRequest({ type: "SET_SELECTED_CASE", providerId: FIXTURES.PROVIDER_ID, caseId: caseChoice });
    await handleRequest({ type: "SET_SELECTED_GROUP", providerId: FIXTURES.PROVIDER_ID, groupId });
    await expect(handleRequest({
      type: "FILL", tabId: TAB_ID, providerId: FIXTURES.PROVIDER_ID,
      caseId: null, groupId, facilityId, state: "CO", portalKey: FIXTURES.PORTAL_KEY,
    })).rejects.toThrow("Choose Ad hoc fill, a group, and a location");
    expect(mock.state.fillSessions.size).toBe(0);
  });

  it("cancels after A-B-A switches, clears the delayed frame, and lets a refill own the report", async () => {
    const { handleRequest, AI_ACCEPTED_RECEIPT_KEY } = await import("../background/index");
    let releaseFirstApply!: () => void;
    let announceFirstApply!: () => void;
    const firstApplyStarted = new Promise<void>((resolve) => { announceFirstApply = resolve; });
    const blockedFirstApply = new Promise<void>((resolve) => { releaseFirstApply = resolve; });
    const appliedFrames: number[] = [];
    const clearedFrames: number[] = [];
    const aiSessionIds: string[] = [];
    const controlsByFrame = new Map<number, Array<{ selector: string; label: string; controlType: "text" }>>([
      [0, [{ selector: "#ai-npi", label: "NPI", controlType: "text" }]],
      [3, [{ selector: "#ai-email", label: "Email", controlType: "text" }]],
    ]);
    chrome.tabs.sendMessage = (async (
      _tabId: number,
      rawMessage: unknown,
      options?: chrome.tabs.MessageSendOptions,
    ) => {
      const message = rawMessage as {
        type?: string;
        fillSessionId?: string;
        instructions?: Array<{ selector: string; token?: string; confidence?: number }>;
      };
      const frameId = options?.frameId ?? 0;
      if (message.type === "PING") return { ok: true };
      if (message.type === "SCAN_UNMAPPED_CONTROLS") {
        return { ok: true, data: controlsByFrame.get(frameId) ?? [] };
      }
      if (message.type === "CLEAR_AI_SCAN") return { ok: true, data: null };
      if (message.type === "PROBE_FILL") {
        return {
          ok: true,
          data: ((rawMessage as { instructions?: Array<{ mapId: string }> }).instructions ?? []).map(({ mapId }) => ({
            mapId,
            pageStatus: "eligible",
            targetStatus: "unique",
            pageSettled: true,
            radioGroup: false,
            pageFields: 1,
          })),
        };
      }
      if (message.type === "APPLY_FILL") {
        return { ok: true, data: { filled: [], writes: [], skipped: [], pageFields: 0 } };
      }
      if (message.type === "APPLY_AI_FILL") {
        appliedFrames.push(frameId);
        if (message.fillSessionId) aiSessionIds.push(message.fillSessionId);
        if (frameId === 0) {
          announceFirstApply();
          await blockedFirstApply;
        }
        const writes = (message.instructions ?? []).map((instruction) => ({
          selector: instruction.selector,
          kind: "ai" as const,
          token: instruction.token,
          confidence: instruction.confidence,
        }));
        return { ok: true, data: { filled: writes.map((write) => write.selector), writes, skipped: [], pageFields: 2 } };
      }
      if (message.type === "CLEAR_AI_FILL") {
        clearedFrames.push(frameId);
        return { ok: true, data: 1 };
      }
      throw new Error(`unexpected content message: ${message.type ?? "?"}`);
    }) as typeof chrome.tabs.sendMessage;

    const prepared = await handleRequest({
      type: "PREPARE_AI_FILL",
      tabId: TAB_ID,
      providerId: FIXTURES.PROVIDER_ID,
      caseId: FIXTURES.CASE_ID,
      portalKey: FIXTURES.PORTAL_KEY,
      state: "CO",
      facilityId: FIXTURES.FACILITY_ID,
    }) as import("../shared/fill").AiFillPreparation;
    expect(prepared.controls.map((control) => control.selector)).toEqual(["#ai-npi", "#ai-email"]);

    const originalFill = handleRequest({
      type: "FILL",
      tabId: TAB_ID,
      providerId: FIXTURES.PROVIDER_ID,
      caseId: FIXTURES.CASE_ID,
      portalKey: FIXTURES.PORTAL_KEY,
      state: "CO",
      facilityId: FIXTURES.FACILITY_ID,
      aiScanId: prepared.scanId,
      aiMatches: [
        { selector: "#ai-npi", token: "provider.npi", confidence: 0.95 },
        { selector: "#ai-email", token: "provider.email", confidence: 0.95 },
      ],
    });
    await firstApplyStarted;

    // Each public selection route advances the worker generation. Returning
    // to the original tuple cannot make the in-flight scan current again.
    await handleRequest({ type: "SET_SELECTED_PROVIDER", providerId: "secondary-provider" });
    await handleRequest({ type: "SET_SELECTED_PROVIDER", providerId: FIXTURES.PROVIDER_ID });
    await handleRequest({ type: "SET_SELECTED_CASE", providerId: FIXTURES.PROVIDER_ID, caseId: FIXTURES.CASE2_ID });
    await handleRequest({ type: "SET_SELECTED_CASE", providerId: FIXTURES.PROVIDER_ID, caseId: FIXTURES.CASE_ID });
    await handleRequest({ type: "SET_SELECTED_FACILITY", providerId: FIXTURES.PROVIDER_ID, facilityId: FIXTURES.FACILITY2_ID });
    await handleRequest({ type: "SET_SELECTED_FACILITY", providerId: FIXTURES.PROVIDER_ID, facilityId: FIXTURES.FACILITY_ID });
    await handleRequest({ type: "SET_ACTIVE_ORG", orgId: "30563fd6-8e95-46a0-8e1c-cb3b968b3c3d" });
    await handleRequest({ type: "SET_ACTIVE_ORG", orgId: FIXTURES.PRIMARY_ORG });
    await handleRequest({
      type: "ENTER_ACTIVE_CASE",
      caseId: FIXTURES.CASE_ID,
      providerId: FIXTURES.PROVIDER_ID,
      orgId: FIXTURES.PRIMARY_ORG,
    });
    await handleRequest({ type: "SET_SELECTED_PROVIDER", providerId: FIXTURES.PROVIDER_ID });
    await handleRequest({ type: "SET_SELECTED_CASE", providerId: FIXTURES.PROVIDER_ID, caseId: FIXTURES.CASE_ID });
    await handleRequest({ type: "SET_SELECTED_FACILITY", providerId: FIXTURES.PROVIDER_ID, facilityId: FIXTURES.FACILITY_ID });

    const refill = await handleRequest({
      type: "FILL",
      tabId: TAB_ID,
      providerId: FIXTURES.PROVIDER_ID,
      caseId: FIXTURES.CASE_ID,
      portalKey: FIXTURES.PORTAL_KEY,
      state: "CO",
      facilityId: FIXTURES.FACILITY_ID,
    }) as import("../shared/fill").FillSummary;
    const reportKey = `minted.fillReport.${FIXTURES.PROVIDER_ID}.${FIXTURES.PORTAL_KEY}`;
    const currentReport = stub.sessionStore.get(reportKey) as import("../shared/fill").FillReportRecord;
    expect(currentReport.summary.fillSessionId).toBe(refill.fillSessionId);
    expect(currentReport.summary.aiReview).toBeFalsy();

    releaseFirstApply();
    const stale = await originalFill as import("../shared/fill").FillSummary;
    expect(appliedFrames).toEqual([0]);
    expect(clearedFrames).toContain(0);
    expect(clearedFrames).not.toContain(3);
    expect(aiSessionIds).toHaveLength(1);
    expect(stale.aiReview).toBeNull();
    expect(stale.aiFilled).toBe(0);
    expect((await import("../background/fill")).readActiveAiReview(aiSessionIds[0]!)).toBeNull();
    expect(stub.sessionStore.get(AI_ACCEPTED_RECEIPT_KEY)).toBeNull();
    expect((stub.sessionStore.get(reportKey) as import("../shared/fill").FillReportRecord).summary.fillSessionId)
      .toBe(refill.fillSessionId);
  });
});
