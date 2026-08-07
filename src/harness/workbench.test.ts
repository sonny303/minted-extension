// The TE-10 mock-harness scenarios (TS-80–TS-83, TS-100–TS-103) plus the TE-3
// latency budgets, driven through the REAL background modules (api / fill /
// activeCase) against the in-repo mock of the panel contract
// (scripts/mock-panel-api.mjs). No real payer portal and no real panel is
// ever contacted; auth is mocked to a fixture JWT the mock server accepts.
import { stub } from "./chromeStub";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — the mock server is an untyped .mjs harness module,
// deliberately outside the typechecked tree (it mirrors the panel repo's own
// scripts/mock-api-server.mjs pattern).
import { createMockPanelApi, FIXTURES } from "../../scripts/mock-panel-api.mjs";
import { buildSubmissionTouchBody } from "../shared/submission";
import {
  ApiError,
  getCaseContext,
  getNextBestAction,
  getPortalFieldMaps,
  getProviderProfile,
  getViewPrefs,
  postSubmissionTouch,
  putViewPrefs,
  searchCases,
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
  formCaptureState,
  recognizeForm,
} from "../shared/trainForms";
import { coveragePortal } from "../background/fill";
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
    getAccessToken: async () => "tok-kansas",
    forceRefresh: async () => {
      throw new AuthRequiredError();
    },
    getAuthState: async () => ({ signedIn: true, email: "testkansas@minted.com", name: "Test Kansas" }),
    currentUserId: async () => "user-kansas",
    signIn: async () => ({ signedIn: true, email: "testkansas@minted.com", name: "Test Kansas" }),
    signOut: async () => {},
  };
});

interface MockApi {
  baseUrl: string;
  state: {
    fieldMaps: Array<{ id: string; token: string | null; [key: string]: unknown }>;
    touches: Map<string, unknown>;
    viewPrefs: Map<string, string[]>;
    failTouches: number;
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

const HANDOFF = {
  type: "SET_ACTIVE_CASE",
  caseId: FIXTURES.CASE_ID as string,
  providerId: FIXTURES.PROVIDER_ID as string,
  orgId: FIXTURES.KANSAS_ORG as string,
  portalUrl: "https://provider.bcbsks.com/enroll/form",
};
const APP_ORIGIN = "https://mintedpanel.vercel.app";

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
    expect(state.record.orgId).toBe(FIXTURES.KANSAS_ORG);
    expect(state.record.source).toBe("handoff");
    // An open panel is told the context changed.
    expect(stub.broadcasts).toContainEqual({ type: "ACTIVE_CASE_UPDATED" });
  });

  it("rejects a disallowed origin and malformed shapes — nothing stored", async () => {
    expect(await handleExternalMessage(HANDOFF, "https://evil.example.com")).toEqual({ ok: false });
    expect(await handleExternalMessage({ ...HANDOFF, caseId: "nope" }, APP_ORIGIN)).toEqual({
      ok: false,
    });
    expect((await getActiveCaseState()).status).toBe("none");
  });

  it("last launch wins — a second handoff replaces the pending context", async () => {
    await handleExternalMessage(HANDOFF, APP_ORIGIN);
    await handleExternalMessage({ ...HANDOFF, caseId: FIXTURES.CASE2_ID }, APP_ORIGIN);
    const state = await getActiveCaseState();
    expect(state.status).toBe("active");
    if (state.status === "active") expect(state.record.caseId).toBe(FIXTURES.CASE2_ID);
  });

  it("binds the next tab on the portal origin — and only that origin", async () => {
    await handleExternalMessage(HANDOFF, APP_ORIGIN);
    await maybeBindPortalTab(7, "https://unrelated.example.com/page");
    expect((await readActiveCaseRecord())?.boundTabId).toBeNull();
    await maybeBindPortalTab(7, "https://provider.bcbsks.com/login");
    expect((await readActiveCaseRecord())?.boundTabId).toBe(7);
    // Already bound: a later tab never steals the binding.
    await maybeBindPortalTab(9, "https://provider.bcbsks.com/other");
    expect((await readActiveCaseRecord())?.boundTabId).toBe(7);
  });

  it("expires the context when the bound tab closes", async () => {
    await handleExternalMessage(HANDOFF, APP_ORIGIN);
    await maybeBindPortalTab(7, "https://provider.bcbsks.com/login");
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
    expect(context.provider?.name).toBe("Kay One");
    expect(context.payer?.name).toBe("BCBS of Kansas");
    expect(context.state).toBe("KS");
    expect(context.payerPipelineState).toBe("submitted");
    expect(context.referenceNumbers).toEqual(["REF-1001"]);
    expect(context.selectedFacility?.id).toBe(FIXTURES.FACILITY_ID);
    expect(context.openTasks?.map((t) => t.executionType)).toEqual(["extension_fill", "manual"]);
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
    const caqh = coverage.gaps.find((g) => g.label.includes("caqh") || g.label.includes("#caqh"));
    expect(caqh?.kind).toBe("no_value");
    expect(caqh?.reason).toBe("empty on provider");
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
    expect(before.gaps.some((g) => g.label === "Group Medicare PTAN")).toBe(true);

    // The platform's train flow (TE-4) approves the mapping — simulated as
    // the server-side change it is; the extension itself writes nothing.
    const row = mock.state.fieldMaps.find((m) => m.id === FIXTURES.UNTRAINED_MAP_ID);
    if (row) row.token = "provider.email";

    const after = await coveragePortal({
      providerId: FIXTURES.PROVIDER_ID,
      portalKey: FIXTURES.PORTAL_KEY,
      state: "KS",
      facilityId: FIXTURES.FACILITY_ID,
    });
    expect(after.available).toBe(before.available + 1);
    expect(after.gaps.some((g) => g.label === "Group Medicare PTAN")).toBe(false);
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
    const { touch: created } = await postSubmissionTouch(FIXTURES.CASE_ID, body);
    expect(created.touchType).toBe("portal");
    expect(created.outcome).toBe("successful");
    const { touch: replayed } = await postSubmissionTouch(FIXTURES.CASE_ID, body);
    expect(replayed.id).toBe(created.id);
    expect(mock.state.touches.size).toBe(1);
    mock.state.touches.clear();
  });

  it("a failed write retried with the SAME draft id converges on one touch", async () => {
    const id = crypto.randomUUID();
    const body = buildStructuredTouchBody(draft, id);
    mock.state.failTouches = 1;
    await expect(postSubmissionTouch(FIXTURES.CASE_ID, body)).rejects.toThrow(ApiError);
    expect(mock.state.touches.size).toBe(0);
    // The retry reuses the same idempotency id (the panel preserves the draft).
    const { touch: retried } = await postSubmissionTouch(FIXTURES.CASE_ID, body);
    expect(retried.id).toBe(id);
    expect(mock.state.touches.size).toBe(1);
    mock.state.touches.clear();
  });

  it("the server rejects a portal_submission-only field on a structured touch", async () => {
    const id = crypto.randomUUID();
    const body = { ...buildStructuredTouchBody(draft, id), task_id: FIXTURES.TASK_ID };
    await expect(
      postSubmissionTouch(FIXTURES.CASE_ID, body as never),
    ).rejects.toThrow(/portal_submission/);
  });

  it("after logging, the queue top comes back server-ranked with a deep link", async () => {
    const result = await getNextBestAction();
    expect(result.item).not.toBeNull();
    expect(result.item?.caseId).toBe(FIXTURES.CASE2_ID);
    expect(result.item?.action).toBe("Follow up with Humana");
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
    if (state.status === "active") expect(state.record.caseId).toBe(FIXTURES.CASE2_ID);
  });
});

describe("TS-100 — unified standalone search", () => {
  it("finds cases by provider name, payer name, and tracking ID", async () => {
    const byProvider = await searchCases("kay");
    expect(byProvider.map((r) => r.id)).toEqual([FIXTURES.CASE_ID]);
    expect(byProvider[0]?.providerName).toBe("Kay One");
    const byPayer = await searchCases("humana");
    expect(byPayer.map((r) => r.id)).toEqual([FIXTURES.CASE2_ID]);
    const byRef = await searchCases("REF-1001");
    expect(byRef.map((r) => r.id)).toEqual([FIXTURES.CASE_ID]);
    expect(await searchCases("   ")).toEqual([]);
  });

  it("finds providers over the PHI-minimized list projection", async () => {
    const rows = await searchProviders("ostr");
    expect(rows.map((r) => r.id)).toEqual([FIXTURES.PROVIDER2_ID]);
    expect(rows[0]).not.toHaveProperty("ssnLast4");
    expect(rows[0]).not.toHaveProperty("dateOfBirth");
  });
});

describe("TS-101 — quick cards from the live profile endpoint", () => {
  it("projects honest empties (with reasons) and the <30-day expiry badge", async () => {
    const { profile } = await getProviderProfile(FIXTURES.PROVIDER_ID);
    const today = new Date().toISOString().slice(0, 10);
    const cards = projectQuickCards(profile.tokens, profile.unresolved, resolveLayout(null), today);
    expect(cards.name).toBe("Kay One");
    expect(cards.dateOfBirth).toBe("1980-01-15");
    // CAQH is empty on the fixture — rendered honestly with the reason.
    const caqh = cards.type1Fields.find((f) => f.key === "provider.caqhId");
    expect(caqh?.value).toBeNull();
    expect(caqh?.reason).toBe("empty on provider");
    // The fixture license expires 20 days out — inside the amber window.
    expect(cards.license.expiry).toBe("expiring");
    // Malpractice is 200 days out — no badge.
    expect(cards.malpractice.expiry).toBe("ok");
    expect(cards.groupName).toBe("Kansas Fitness Physio Group");
  });
});

describe("S5.1/S5.3 — capture proposes, and learns", () => {
  it("writes a PROPOSED row with no token, whatever we ask for", async () => {
    const result = await proposeFieldMap({
      portal_key: "humana_enroll",
      selector: "#npi",
      field_label: "NPI",
    });
    // Approving is a human act in the webapp; the panel can only propose.
    expect(result.map.status).toBe("proposed");
    expect(result.map.token).toBeNull();
    expect(mock.state.proposedMaps.get("humana_enroll:#npi")?.status).toBe("proposed");
  });

  it("returns the learned suggestion with its payer-count evidence", async () => {
    const result = await proposeFieldMap({
      portal_key: "humana_enroll",
      selector: "#npi2",
      field_label: "NPI",
    });
    expect(result.suggestion?.token).toBe("provider.npi");
    expect(result.suggestion?.portalCount).toBe(3);
  });

  it("returns no suggestion for a label nothing backs — an honest blank", async () => {
    const result = await proposeFieldMap({
      portal_key: "humana_enroll",
      selector: "#mystery",
      field_label: "Mystery box",
    });
    expect(result.suggestion).toBeNull();
  });

  it("is idempotent on (portal_key, selector)", async () => {
    const a = await proposeFieldMap({ portal_key: "p", selector: "#dup", field_label: "X" });
    const b = await proposeFieldMap({ portal_key: "p", selector: "#dup", field_label: "X" });
    expect(a.map.id).toBe(b.map.id);
  });
});

describe("S4.4 — the opt-in status bump", () => {
  const submissionBody = (idempotencyId: string, bump: boolean) =>
    buildSubmissionTouchBody({
      portalKey: "bcbs_ks_enrollment",
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
    expect(result.statusBump?.reason).toMatch(/status that can move to Submitted/);
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
    // @ts-expect-error — node builtin, untyped in this browser-typed project
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
    expect(mock.state.viewPrefs.get("user-kansas")).toEqual(layout);
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
    expect(mock.state.viewPrefs.get("user-kansas")).toEqual([
      "provider.ssnLast4",
      "provider.npi",
    ]);
    await expect(putViewPrefs(["provider.notARealColumn"])).rejects.toThrow(ApiError);
  });

  it("an invalid stored layout degrades to the default, never a broken card", () => {
    const served = new Set(["provider.npi"]);
    expect(resolveLayout(["provider.npi", "bogus.key"], served).source).toBe("default");
    expect(resolveLayout(null, served).source).toBe("default");
  });
});

describe("TS-103 — escape hatch preserves the portal tab", () => {
  it("the card's webapp link opens in a NEW tab (target=_blank in the panel markup)", async () => {
    // @ts-expect-error — node builtin, untyped in this browser-typed project
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
    await writeActiveOrgId(FIXTURES.KANSAS_ORG);
    await writePanelMode("train");

    await listSharedPortals();
    await proposeSharedFieldMap({
      portal_key: "aetna_join",
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
        orgId: FIXTURES.KANSAS_ORG,
        portalUrl: "https://provider.bcbsks.com/x",
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
        portal_key: "aetna_join",
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
      portal_key: "aetna_join",
      selector: "#npi",
      field_label: "NPI",
      page_step: "Page 1",
      field_type: "text",
      sort_order: 1,
    });
    const again = await proposeSharedFieldMap({
      portal_key: "aetna_join",
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

  it("TS-153 — a known form is recognized with what it already has; a new one is greeted", async () => {
    await writePanelMode("train");
    const registry = await listSharedPortals();

    const known = recognizeForm(
      "https://payer.example/aetna/join/start?session=abc",
      registry,
      "Aetna",
    );
    expect(known.kind).toBe("existing");
    if (known.kind === "existing") expect(known.portal.key).toBe("aetna_join");

    const unknown = recognizeForm("https://other.example/apply", registry, "Cigna");
    expect(unknown).toEqual({ kind: "new", candidateName: "Cigna form" });

    // A second form for a payer that already has one is numbered, never a
    // block and never an overwrite.
    expect(candidatePortalName("Aetna", registry)).toBe("Aetna form 2");

    // Nothing was written by recognizing anything.
    expect(mock.state.sharedProposed.size).toBe(0);
  });

  it("TS-153b — the recognized form reports its capture state honestly", async () => {
    await writePanelMode("train");
    mock.state.sharedMaps = [
      {
        id: "s1",
        orgId: null,
        portalKey: "aetna_join",
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
        portalKey: "aetna_join",
        selector: "#tin",
        pageStep: "Page 2",
        source: "manual",
        token: null,
        hardcodedValue: null,
        status: "proposed",
      },
    ];
    const maps = await listSharedFieldMaps("aetna_join");
    expect(formCaptureState(maps)).toEqual({
      pagesSeen: 2,
      fieldsCaptured: 2,
      mapped: 1,
      undecided: 1,
    });
    mock.state.sharedMaps = [];
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
      getProviderProfile(FIXTURES.PROVIDER_ID, { state: "KS", facilityId: FIXTURES.FACILITY_ID }),
      getPortalFieldMaps(FIXTURES.PORTAL_KEY),
    ]);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(2000); // the TE-3 budget
    expect(elapsed).toBeLessThan(1100); // < 3×400ms ⇒ genuinely concurrent
  });
});
