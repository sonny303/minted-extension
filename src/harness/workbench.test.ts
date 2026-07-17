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
} from "../background/api";
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
    getAuthState: async () => ({ signedIn: true, email: "testkansas@minted.com" }),
    currentUserId: async () => "user-kansas",
    signIn: async () => ({ signedIn: true, email: "testkansas@minted.com" }),
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
    const created = await postSubmissionTouch(FIXTURES.CASE_ID, body);
    expect(created.touchType).toBe("portal");
    expect(created.outcome).toBe("successful");
    const replayed = await postSubmissionTouch(FIXTURES.CASE_ID, body);
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
    const retried = await postSubmissionTouch(FIXTURES.CASE_ID, body);
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

describe("TS-102 — layout persists server-side across a worker restart", () => {
  it("saves, then reads the same layout back with no client-side cache", async () => {
    const layout = ["provider.npi", "group.tin", "provider.deaNumber"];
    await putViewPrefs(layout);
    // A worker restart holds NO state — the next read IS the restart path.
    expect(await getViewPrefs()).toEqual(layout);
    expect(mock.state.viewPrefs.get("user-kansas")).toEqual(layout);
  });

  it("the server 422s an excluded key (ssnLast4 is structurally absent)", async () => {
    await expect(putViewPrefs(["provider.ssnLast4"])).rejects.toThrow(ApiError);
  });

  it("an invalid stored layout degrades to the default, never a broken card", () => {
    expect(resolveLayout(["provider.npi", "bogus.key"]).source).toBe("default");
    expect(resolveLayout(null).source).toBe("default");
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
