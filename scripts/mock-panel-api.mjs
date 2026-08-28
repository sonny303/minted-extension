#!/usr/bin/env node
// In-repo mock of the Minted Panel /api surface the extension consumes — the
// TE-10 mock harness. This mirrors the CONTRACT of the merged panel server
// (sonny303/mintedpanel origin/redesign: src/server/api.ts,
// src/server/extensionRoutes.ts and the services they inject — envelope
// shape, camelCased rows, org scoping, status codes, idempotency), not its
// implementation. It follows the panel repo's own scripts/mock-api-server.mjs
// pattern; keep it in sync when the panel contract changes.
//
// CI never hits a real payer portal or the real panel — every harness test
// runs against this server. `delayMs` injects per-request latency so the
// TE-3 budget tests can PROVE the extension fetches concurrently instead of
// merely passing on a fast localhost.
//
// Usage (in-process, from vitest):
//   const mock = await createMockPanelApi({ delayMs: 0 });
//   ...fetch(`${mock.baseUrl}/api/...`)...
//   mock.state.fieldMaps.push(...)   // simulate a fix-it approval (TS-82)
//   await mock.close();
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { URL } from "node:url";

export const FIXTURES = {
  KANSAS_ORG: "20563fd6-8e95-46a0-8e1c-cb3b968b3c3d",
  PROVIDER_ID: "49ad83a8-d8b6-419d-8dcc-88c04a54c4da",
  PROVIDER2_ID: "6f0e73c2-51f1-4be9-9f2e-0a4c7f2fbb02",
  CASE_ID: "b7a90000-0000-4000-a000-0000000000c1",
  CASE2_ID: "b7a90000-0000-4000-a000-0000000000c2",
  // B1.4: a second case on PROVIDER2, pointing at PROVIDER2's NON-primary
  // facility (FACILITY2_ID below is the primary one) — the "case picks the
  // second location" fixture. Distinct from CASE2 so CASE2's existing
  // facilityId:null assertion (TS-100) stays untouched.
  CASE3_ID: "b7a90000-0000-4000-a000-0000000000c3",
  FACILITY_ID: "5f190f0d-2c5c-49f7-8953-aa05cd0a9d64",
  // B1.4: PROVIDER2's primary facility — multi-location shape (several
  // assigned locations, one primary) for the facility-picker tests.
  FACILITY2_ID: "5f190f0d-2c5c-49f7-8953-aa05cd0a9d65",
  TASK_ID: "b7a90000-0000-4000-a000-0000000000d1",
  TOKEN: "tok-kansas",
  USER_ID: "user-kansas",
  PORTAL_KEY: "bcbs_ks_enrollment",
  // The deliberately-untrained map row (token null) — the TS-82 fix-it target.
  UNTRAINED_MAP_ID: "fm-untrained-1",
  // The org's designated sandbox test provider (US-5) — distinct from the two
  // real roster providers above, so a SANDBOX_FILL test can assert real
  // providers are refused without disturbing any existing fixture assertion.
  SANDBOX_PROVIDER_ID: "8a1e6b4c-0000-4000-a000-00000000005a",
};

// A representative slice of the served quick-card catalog (the real one is
// derived from get_sop_field_tokens() panel-side; 117 fields). Enough here to
// exercise grouping, labels, and the ssnLast4-is-offered contract.
const QUICK_CARD_CATALOG = [
  { key: "provider.npi", label: "NPI (Type 1)", group: "provider", groupLabel: "Provider" },
  { key: "provider.caqhId", label: "CAQH ID", group: "provider", groupLabel: "Provider" },
  { key: "provider.ssnLast4", label: "SSN (last 4)", group: "provider", groupLabel: "Provider" },
  { key: "provider.firstName", label: "First name", group: "provider", groupLabel: "Provider" },
  { key: "group.tin", label: "Tax ID (TIN)", group: "group", groupLabel: "Provider group" },
  { key: "group.npiType2", label: "Group NPI (Type 2)", group: "group", groupLabel: "Provider group" },
  {
    key: "license.licenseNumber",
    label: "License number",
    group: "license",
    groupLabel: "State license",
  },
  { key: "user.name", label: "Name", group: "user", groupLabel: "You" },
];

const PROVIDERS = [
  {
    id: FIXTURES.PROVIDER_ID,
    firstName: "Alex",
    lastName: "Sample",
    credentials: "PT, DPT",
    npi: "1234567890",
    homeState: "KS",
    caqhId: null,
    caqhLastAttestedDate: null,
    taxonomyCode: "225100000X",
    status: "active",
    groupId: "g-1",
    // 2026-08-19: /api/providers rows carry the provider's groups so a search
    // can tell two same-named people apart. Two here, deliberately — the
    // truncation and the "+N" both have something to act on.
    groups: [
      { id: "g-1", name: "Lakeside PT Group", isPrimary: true },
      { id: "g-2", name: "Summit Health Group", isPrimary: false },
    ],
    specialty: "Physical Therapy",
    email: "alex.sample@example.com",
    updatedAt: "2026-07-01T00:00:00Z",
  },
  {
    id: FIXTURES.PROVIDER2_ID,
    firstName: "Jordan",
    lastName: "Example",
    credentials: "PT",
    npi: "1987654321",
    homeState: "KS",
    caqhId: "88881111",
    caqhLastAttestedDate: "2026-06-01",
    taxonomyCode: "225100000X",
    status: "active",
    groupId: "g-1",
    groups: [{ id: "g-1", name: "Lakeside PT Group", isPrimary: true }],
    specialty: "Physical Therapy",
    email: "jordan.example@example.com",
    updatedAt: "2026-07-01T00:00:00Z",
  },
  {
    id: FIXTURES.SANDBOX_PROVIDER_ID,
    firstName: "Sandy",
    lastName: "Testworthy",
    credentials: "PT",
    npi: "1000000099",
    homeState: "KS",
    caqhId: null,
    caqhLastAttestedDate: null,
    taxonomyCode: "225100000X",
    status: "active",
    groupId: "g-1",
    groups: [{ id: "g-1", name: "Lakeside PT Group", isPrimary: true }],
    specialty: "Physical Therapy",
    email: "sandy.testworthy@example.com",
    updatedAt: "2026-07-01T00:00:00Z",
    // US-5: the org's ONE designated sandbox profile — findSandboxProvider
    // picks the row carrying this flag.
    isTestProvider: true,
  },
];

// Date helpers for expiry fixtures relative to "today" (the mock computes at
// request time; the pure expiry math is separately unit-tested with fixed
// dates).
function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const FACILITIES = [
  {
    id: FIXTURES.FACILITY_ID,
    name: "Riverside Clinic",
    street: "100 Main St",
    suite: null,
    city: "Leavenworth",
    state: "KS",
    zip: "66048",
  },
  // B1.4
  {
    id: FIXTURES.FACILITY2_ID,
    name: "Midtown Clinic",
    street: "220 Commerce Dr",
    suite: "Suite 200",
    city: "Lee's Summit",
    state: "MO",
    zip: "64063",
  },
];

// Per-provider facility ASSIGNMENTS — distinct from the FACILITIES catalog
// above (a facility can be shared context; the assignment is the provider's
// own relationship to it, carrying isPrimary + the assignment's own start
// date). Alex Sample keeps the single-facility shape every existing test
// assumes. Jordan Example (B1.4) carries the multi-location shape: several
// assigned locations, one primary, one not.
const PROVIDER_FACILITIES = {
  [FIXTURES.PROVIDER_ID]: [
    { facilityId: FIXTURES.FACILITY_ID, isPrimary: true, assignmentStartDate: "2024-01-01" },
  ],
  [FIXTURES.PROVIDER2_ID]: [
    // Non-primary — CASE3 points here.
    { facilityId: FIXTURES.FACILITY_ID, isPrimary: false, assignmentStartDate: "2023-05-01" },
    { facilityId: FIXTURES.FACILITY2_ID, isPrimary: true, assignmentStartDate: "2022-03-15" },
  ],
  [FIXTURES.SANDBOX_PROVIDER_ID]: [
    { facilityId: FIXTURES.FACILITY_ID, isPrimary: true, assignmentStartDate: "2024-01-01" },
  ],
};

// Per-provider state licenses. Alex Sample keeps the existing single-license
// "rich" shape (used by the <30-day expiry badge test). Jordan Example (B1.4)
// carries TWO — the exact shape that left STATE LICENSE ambiguous without a
// state param.
const PROVIDER_LICENSES = {
  [FIXTURES.PROVIDER_ID]: [
    {
      state: "KS",
      licenseNumber: "KS-12345",
      expirationDate: isoDaysFromNow(20),
      issueDate: "2020-01-01",
    },
  ],
  [FIXTURES.PROVIDER2_ID]: [
    {
      state: "KS",
      licenseNumber: "KS-77777",
      expirationDate: isoDaysFromNow(200),
      issueDate: "2019-01-01",
    },
    {
      state: "MO",
      licenseNumber: "MO-88888",
      expirationDate: isoDaysFromNow(220),
      issueDate: "2019-06-01",
    },
  ],
};

// Resolve a provider's facility SELECTION the way the real server does
// (mintedpanel CLAUDE.md: "?facilityId must be in the provider's set (else
// 404); sole facility auto-selects; several with no param → facility/
// assignment tokens come back null with meta.needs_facility"). Returns
// { facilities, assignments, selected, needsFacility, notFound }.
function resolveFacilitySelection(providerId, facilityId) {
  const assignments = PROVIDER_FACILITIES[providerId] ?? [];
  const facilities = assignments
    .map((a) => FACILITIES.find((f) => f.id === a.facilityId))
    .filter(Boolean);
  if (facilityId) {
    const assignment = assignments.find((a) => a.facilityId === facilityId);
    if (!assignment) return { facilities, assignments, selected: null, needsFacility: false, notFound: true };
    return {
      facilities,
      assignments,
      selected: { facility: FACILITIES.find((f) => f.id === facilityId), assignment },
      needsFacility: false,
      notFound: false,
    };
  }
  if (assignments.length === 1) {
    const assignment = assignments[0];
    return {
      facilities,
      assignments,
      selected: { facility: FACILITIES.find((f) => f.id === assignment.facilityId), assignment },
      needsFacility: false,
      notFound: false,
    };
  }
  return {
    facilities,
    assignments,
    selected: null,
    needsFacility: assignments.length > 1,
    notFound: false,
  };
}

// Resolve a provider's license the way STATE LICENSE needs it: one license,
// no ambiguity regardless of a state param; several, only a matching state
// param resolves one (no param or no match ⇒ unresolved — never a guess).
function resolveLicense(providerId, state) {
  const licenses = PROVIDER_LICENSES[providerId] ?? [];
  if (licenses.length === 1) return licenses[0];
  if (licenses.length > 1 && state) {
    return licenses.find((l) => l.state === state) ?? null;
  }
  return null;
}

// The provider profile's resolved tokens (TE-12: quick cards are a rendering
// of this endpoint). Alex Sample carries honest gaps: caqhId empty (data gap) and
// a license expiring inside the 30-day badge window. facility.*/assignment.*
// resolve only for a selected facility (B1.4); license.* only for a resolved
// license (B1.1) — both come back null, with an unresolved reason, otherwise.
function profileTokens(providerId, selectedFacility, license) {
  const p = PROVIDERS.find((row) => row.id === providerId);
  const facility = selectedFacility?.facility ?? null;
  const assignment = selectedFacility?.assignment ?? null;
  return [
    { token: "provider.firstName", value: p.firstName },
    { token: "provider.lastName", value: p.lastName },
    { token: "provider.credentials", value: p.credentials },
    { token: "provider.dateOfBirth", value: "1980-01-15" },
    { token: "provider.npi", value: p.npi },
    { token: "provider.caqhId", value: p.caqhId },
    { token: "provider.specialty", value: p.specialty },
    { token: "provider.email", value: p.email },
    { token: "license.licenseNumber", value: license?.licenseNumber ?? null },
    { token: "license.state", value: license?.state ?? null },
    { token: "license.expirationDate", value: license?.expirationDate ?? null },
    { token: "license.issueDate", value: license?.issueDate ?? null },
    { token: "group.name", value: "Lakeside PT Group" },
    { token: "group.tin", value: "48-1234567" },
    { token: "group.npiType2", value: "1098765432" },
    { token: "groupInsurance.insurerName", value: "Example Mutual Insurance" },
    { token: "groupInsurance.policyNumber", value: "MP-889900" },
    { token: "groupInsurance.policyEndDate", value: isoDaysFromNow(200) },
    { token: "facility.name", value: facility?.name ?? null },
    { token: "facility.street", value: facility?.street ?? null },
    { token: "facility.city", value: facility?.city ?? null },
    { token: "assignment.startDate", value: assignment?.assignmentStartDate ?? null },
    { token: "payer.name", value: null },
    { token: "user.name", value: "Test Kansas" },
    { token: "user.email", value: "test.coordinator@example.com" },
  ];
}

// Unresolved reasons for the fields above that came back null — dynamic,
// unlike the static provider.caqhId/payer.name gaps, because whether
// facility.*/license.* resolve depends on the request's facilityId/state.
function profileUnresolved(providerId, selection, license) {
  const reasons = [
    { token: "provider.caqhId", reason: "empty on provider" },
    { token: "payer.name", reason: "case-scoped source (payers); resolve at fill time" },
  ];
  if (selection.notFound) {
    // handled as a 404 by the caller — this branch is unreachable in
    // practice, kept only so a future refactor can't silently swallow it.
    return reasons;
  }
  if (selection.selected == null) {
    const facilityReason = selection.needsFacility
      ? "several locations on file; pick one to resolve"
      : "no location on file";
    reasons.push(
      { token: "facility.name", reason: facilityReason },
      { token: "facility.street", reason: facilityReason },
      { token: "facility.city", reason: facilityReason },
      { token: "assignment.startDate", reason: facilityReason },
    );
  }
  if (license == null) {
    const licenses = PROVIDER_LICENSES[providerId] ?? [];
    const licenseReason =
      licenses.length > 1
        ? "several state licenses on file; pass state to resolve"
        : "no license on file";
    reasons.push(
      { token: "license.licenseNumber", reason: licenseReason },
      { token: "license.state", reason: licenseReason },
      { token: "license.expirationDate", reason: licenseReason },
      { token: "license.issueDate", reason: licenseReason },
    );
  }
  return reasons;
}

const CASES = [
  {
    id: FIXTURES.CASE_ID,
    providerId: FIXTURES.PROVIDER_ID,
    facilityId: FIXTURES.FACILITY_ID,
    payerName: "BCBS of Kansas",
    state: "KS",
    status: "Submitted",
    submittedDate: "2026-06-01",
    payerReferenceId: "REF-1001",
    caseNumber: 1001,
    latestNote: { text: "Called payer, pending review", author: "Test Kansas", at: "2026-07-10T00:00:00Z" },
    lastSubmittedAt: null,
    payerPipelineState: "submitted",
    portalTasks: [
      {
        taskId: FIXTURES.TASK_ID,
        title: "Enroll on BCBS portal",
        portalKey: FIXTURES.PORTAL_KEY,
        status: "in_progress",
      },
    ],
    openTasks: [
      {
        id: FIXTURES.TASK_ID,
        title: "Enroll on BCBS portal",
        status: "in_progress",
        executionType: "extension_fill",
        sortOrder: 1,
        dueDate: "2026-07-20",
      },
      {
        id: "b7a90000-0000-4000-a000-0000000000d2",
        title: "Verify roster entry",
        status: "open",
        executionType: "manual",
        sortOrder: 2,
        dueDate: null,
      },
    ],
  },
  {
    id: FIXTURES.CASE2_ID,
    providerId: FIXTURES.PROVIDER2_ID,
    facilityId: null,
    payerName: "Humana",
    state: "KS",
    status: "In Progress",
    submittedDate: null,
    payerReferenceId: null,
    caseNumber: 1002,
    latestNote: null,
    lastSubmittedAt: null,
    payerPipelineState: "not_started",
    portalTasks: [],
    openTasks: [],
  },
  // B1.4: PROVIDER2's NON-primary facility (FACILITY_ID — FACILITY2_ID is
  // PROVIDER2's primary, per PROVIDER_FACILITIES above) and a state (MO)
  // matching one of PROVIDER2's two licenses.
  {
    id: FIXTURES.CASE3_ID,
    providerId: FIXTURES.PROVIDER2_ID,
    facilityId: FIXTURES.FACILITY_ID,
    payerName: "Cigna",
    state: "MO",
    status: "In Progress",
    submittedDate: null,
    payerReferenceId: null,
    caseNumber: 1003,
    latestNote: null,
    lastSubmittedAt: null,
    payerPipelineState: "not_started",
    portalTasks: [],
    openTasks: [],
  },
];

// E1.4/E1.5 — case_facilities: a case's full location set, mirroring the
// panel's case_facilities table (context.facilities). CASE_ID keeps the
// single-location shape every existing test assumes (one row, primary,
// matching its facilityId above); CASE2_ID carries none — most cases today,
// since case_facilities is additive and a case predating it (or one nobody
// has added a second location to) has zero rows despite a perfectly good
// primary on the legacy facilityId. CASE3_ID (PROVIDER2, the two-facility
// provider from B1.4) is the E1.5 multi-location fixture: two rows, the SAME
// facility its own facilityId/selectedFacility already names as primary, plus
// its provider's OTHER assigned facility as a non-primary second location.
const CASE_FACILITIES = {
  [FIXTURES.CASE_ID]: [{ facilityId: FIXTURES.FACILITY_ID, isPrimary: true }],
  [FIXTURES.CASE2_ID]: [],
  [FIXTURES.CASE3_ID]: [
    { facilityId: FIXTURES.FACILITY_ID, isPrimary: true },
    { facilityId: FIXTURES.FACILITY2_ID, isPrimary: false },
  ],
};

// Project a case's case_facilities rows the way the real server does:
// primary first, then alphabetical by name, `isPrimary` riding each row.
function caseFacilitiesFor(caseId) {
  return (CASE_FACILITIES[caseId] ?? [])
    .map((row) => {
      const f = FACILITIES.find((x) => x.id === row.facilityId);
      return f ? { ...f, isPrimary: row.isPrimary } : null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function fieldMapRow(id, portalKey, selector, token, overrides = {}) {
  return {
    id,
    orgId: null,
    portalKey,
    urlPattern: null,
    pageStep: "1",
    mapType: "web",
    selector,
    selectorFallbacks: null,
    source: "token",
    token,
    hardcodedValue: null,
    transform: null,
    fieldType: "text",
    notes: null,
    status: "approved",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

const CANONICAL_TOUCH_TYPES = [
  "call",
  "portal",
  "email",
  "fax",
  "caqh_update",
  "provider_outreach",
  "internal_sync",
];
const DISPOSITIONS = ["successful", "attempted", "no_response", "error", "other"];
const PORTAL_SUBMISSION_ONLY = ["portal_key", "fill_session_id", "task_id", "wip_note", "pdf_filename"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createMockPanelApi(options = {}) {
  const delayMs = options.delayMs ?? 0;
  const state = {
    // Mutable so a test can "approve a fix-it" (add/complete a mapping) and
    // re-fetch — the TS-82 loop.
    fieldMaps: [
      fieldMapRow("fm-1", FIXTURES.PORTAL_KEY, "#firstName", "provider.firstName"),
      fieldMapRow("fm-2", FIXTURES.PORTAL_KEY, "#lastName", "provider.lastName"),
      fieldMapRow("fm-3", FIXTURES.PORTAL_KEY, "#npi", "provider.npi"),
      // A data gap: mapped token whose value is empty on the provider.
      fieldMapRow("fm-4", FIXTURES.PORTAL_KEY, "#caqh", "provider.caqhId"),
      // A mapping gap: the row exists but is linked to no token yet.
      fieldMapRow(FIXTURES.UNTRAINED_MAP_ID, FIXTURES.PORTAL_KEY, "label:Group Medicare PTAN", null),
    ],
    touches: new Map(), // idempotency_id -> stored touch row
    fillSessions: new Map(),
    viewPrefs: new Map(), // userId -> fields[]
    // Failure injection: >0 makes the next N touch POSTs fail 500 (the
    // preserved-values retry path, F4.3.4).
    failTouches: 0,
    // Request log so tests can assert what was sent.
    requests: [],
    completedSteps: new Set(),
    proposedMaps: new Map(),
    // E6.9 shared tier: the global registry a trainer works against, the
    // proposals it writes, and every x-org-id header those routes were sent
    // (so a test can pin that training carries none).
    sharedPortals: [
      {
        id: "shared-portal-1",
        orgId: null,
        portalKey: "aetna_join",
        name: "Aetna — Request to Join",
        payerId: "payer-aetna",
        payerName: "Aetna",
        formUrl: "https://payer.example/aetna/join/start",
        isVerified: false,
        lastVerifiedAt: null,
        provenAt: null,
        urlChangedAt: null,
        createdAt: "2026-08-01T00:00:00Z",
        updatedAt: "2026-08-01T00:00:00Z",
      },
    ],
    sharedMaps: [],
    sharedProposed: new Map(),
    sharedTestFills: new Map(),
    sharedOrgHeaders: [],
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  function envelope(res, status, data, error = null, meta = null) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ data, error, meta }));
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
    });
  }

  async function handle(req, res) {
    if (delayMs > 0) await sleep(delayMs);
    const url = new URL(req.url, "http://localhost");
    const method = req.method.toUpperCase();
    state.requests.push({ method, path: url.pathname + url.search });

    if (!url.pathname.startsWith("/api")) return envelope(res, 404, null, "Not found");
    if (url.pathname === "/api/health") return envelope(res, 200, "ok");

    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (token !== FIXTURES.TOKEN) {
      return envelope(res, 401, null, "Missing or malformed Authorization header");
    }

    // --- /api/me/orgs (user-scoped) ---
    if (/^\/api\/me\/orgs\/?$/.test(url.pathname)) {
      const rows = [{ orgId: FIXTURES.KANSAS_ORG, orgName: "Lakeside Physical Therapy", role: "admin" }];
      return envelope(res, 200, rows, null, { total: rows.length });
    }

    // --- /api/tasks/:id/steps (S4.3 step tick) ---
    const stepMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/steps\/?$/);
    if (stepMatch) {
      if (method !== "PATCH") return envelope(res, 405, null, "Method not allowed");
      const body = (await readBody(req)) ?? {};
      if (typeof body.stepId !== "string" || body.stepId.trim() === "") {
        return envelope(res, 422, null, "stepId is required");
      }
      // The ordering rule lives server-side; the mock mirrors the 409 shape so
      // the panel's "render the server's message verbatim" path is exercised.
      if (body.stepId === "blocked-step") {
        return envelope(res, 409, null, 'Complete "Upload W-9" first');
      }
      state.completedSteps.add(`${stepMatch[1]}:${body.stepId}`);
      return envelope(res, 200, {
        task: { id: stepMatch[1], status: "in_progress" },
        allDone: false,
      });
    }

    // --- /api/portals (S3.2: the DB-driven registry — own-org + global) ---
    if (/^\/api\/portals\/?$/.test(url.pathname)) {
      if (method !== "GET") return envelope(res, 405, null, "Method not allowed");
      const rows = [
        {
          id: "portal-1",
          orgId: null,
          portalKey: "bcbs_ks_enrollment",
          name: "BCBS KS network enrollment",
          payerId: null,
          formUrl:
            "https://provider.bcbsks.com/bcbsks-provider/facelets/allUsers/form/NetworkEnrollmentForm.faces",
          isVerified: true,
          lastVerifiedAt: "2026-07-01T00:00:00Z",
          provenAt: "2026-07-02T00:00:00Z",
          urlChangedAt: null,
          createdAt: "2026-06-01T00:00:00Z",
          updatedAt: "2026-07-02T00:00:00Z",
        },
      ];
      return envelope(res, 200, rows, null, { total: rows.length });
    }

    // --- /api/me/view-prefs (E4.3 TE-15: user-scoped, closed catalog) ---
    if (/^\/api\/me\/view-prefs\/?$/.test(url.pathname)) {
      if (method === "GET") {
        // The schema-derived catalog rides the GET (2026-07-28) — a slice of
        // it, enough to exercise the picker contract: grouped fields incl.
        // the now-offered ssnLast4.
        return envelope(res, 200, {
          fields: state.viewPrefs.get(FIXTURES.USER_ID) ?? null,
          catalog: QUICK_CARD_CATALOG,
        });
      }
      if (method === "PUT") {
        const body = await readBody(req);
        const fields = body?.fields;
        const allowed = new Set(QUICK_CARD_CATALOG.map((f) => f.key));
        // No length cap (S2.1); membership in the DERIVED catalog is the rule.
        if (
          !Array.isArray(fields) ||
          new Set(fields).size !== fields.length ||
          fields.some((f) => typeof f !== "string" || !allowed.has(f))
        ) {
          return envelope(res, 422, null, "unknown or excluded field key");
        }
        state.viewPrefs.set(FIXTURES.USER_ID, fields);
        return envelope(res, 200, { fields });
      }
      return envelope(res, 405, null, "Method not allowed");
    }

    // --- /api/providers/:id/profile?state=&facilityId= ---
    // B1.1/B1.4: facilityId/state are now REAL inputs, mirroring the panel
    // contract exactly (mintedpanel CLAUDE.md): an unrecognized facilityId
    // 404s the whole read (never guessed past); several locations and no
    // facilityId flags meta.needs_facility; several licenses and no matching
    // state leaves license.* unresolved rather than picking one.
    const profileMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/profile\/?$/);
    if (profileMatch) {
      const p = PROVIDERS.find((row) => row.id === profileMatch[1]);
      if (!p) return envelope(res, 404, null, "Provider not found");
      const facilityId = url.searchParams.get("facilityId");
      const state = url.searchParams.get("state");
      const selection = resolveFacilitySelection(p.id, facilityId);
      if (selection.notFound) {
        return envelope(res, 404, null, "Facility not found for this provider");
      }
      const license = resolveLicense(p.id, state);
      res.setHeader("cache-control", "no-store");
      return envelope(
        res,
        200,
        {
          provider: { id: p.id, ssnLast4: "0000", dateOfBirth: "1980-01-15" },
          tokens: profileTokens(p.id, selection.selected, license),
          unresolved: profileUnresolved(p.id, selection, license),
          facilities: selection.facilities,
          selected_facility_id: selection.selected?.facility.id ?? null,
        },
        null,
        selection.needsFacility ? { needs_facility: true } : null,
      );
    }

    // --- /api/providers (list + ?search=) ---
    if (/^\/api\/providers\/?$/.test(url.pathname)) {
      if (method !== "GET") return envelope(res, 405, null, "Method not allowed");
      const search = url.searchParams.get("search");
      let rows = PROVIDERS;
      if (search) {
        const q = search.toLowerCase();
        rows = rows.filter(
          (p) =>
            p.firstName.toLowerCase().includes(q) ||
            p.lastName.toLowerCase().includes(q) ||
            (p.npi ?? "").includes(q) ||
            (p.email ?? "").toLowerCase().includes(q),
        );
      }
      return envelope(res, 200, rows, null, { total: rows.length, page: 1, pageSize: 25 });
    }

    // --- /api/next-best-action (S3.3: ranked list + top) ---
    if (/^\/api\/next-best-action\/?$/.test(url.pathname)) {
      if (method !== "GET") return envelope(res, 405, null, "Method not allowed");
      const raw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(raw) && raw >= 1 && raw <= 100 ? raw : 20;
      const ranked = [
        {
          caseId: FIXTURES.CASE2_ID,
          providerId: FIXTURES.PROVIDER2_ID,
          providerName: "Jordan Example",
          payerName: "Humana",
          groupName: "Lakeside PT Group",
          state: "KS",
          actionKind: "follow_up",
          action: "Follow up with Humana",
          reason: "Follow-up overdue by 3 days.",
          deadline: { date: isoDaysFromNow(-3), source: "follow_up", overdue: true },
          payerPipelineState: "submitted",
          deepLink: `/cases/${FIXTURES.CASE2_ID}`,
        },
        {
          caseId: FIXTURES.CASE_ID,
          providerId: FIXTURES.PROVIDER_ID,
          providerName: "Alex Sample",
          payerName: "BCBS of Kansas",
          groupName: "Lakeside PT Group",
          state: "KS",
          actionKind: "task",
          action: "Enroll on BCBS portal",
          reason: "Task due in 5 days.",
          deadline: { date: isoDaysFromNow(5), source: "task_due", overdue: false },
          payerPipelineState: "in_review",
          deepLink: `/cases/${FIXTURES.CASE_ID}`,
        },
      ].slice(0, limit);
      return envelope(res, 200, { item: ranked[0] ?? null, items: ranked }, null, {
        total: ranked.length,
      });
    }

    // --- /api/cases?providerId= | ?q= ---
    if (/^\/api\/cases\/?$/.test(url.pathname)) {
      if (method !== "GET") return envelope(res, 405, null, "Method not allowed");
      const providerId = url.searchParams.get("providerId");
      const q = url.searchParams.get("q");
      if (providerId) {
        const p = PROVIDERS.find((row) => row.id === providerId);
        if (!p) return envelope(res, 404, null, "Provider not found");
        const rows = CASES.filter((c) => c.providerId === providerId).map((c) => ({
          id: c.id,
          payerName: c.payerName,
          state: c.state,
          status: c.status,
          submittedDate: c.submittedDate,
          payerReferenceId: c.payerReferenceId,
          latestNote: c.latestNote,
          lastSubmittedAt: c.lastSubmittedAt,
          portalTasks: c.portalTasks,
        }));
        return envelope(res, 200, rows, null, { total: rows.length });
      }
      if (q != null) {
        const needle = q.trim().toLowerCase();
        const caseDigits = /^(?:c-?)?(\d+)$/.exec(needle)?.[1] ?? null;
        const rows =
          needle === ""
            ? []
            : CASES.map((c) => {
                const p = PROVIDERS.find((row) => row.id === c.providerId);
                return {
                  id: c.id,
                  providerId: c.providerId,
                  providerName: p ? `${p.firstName} ${p.lastName}` : "",
                  payerName: c.payerName,
                  state: c.state,
                  status: c.status,
                  payerReferenceId: c.payerReferenceId,
                  payerPipelineState: c.payerPipelineState ?? "not_started",
                  facilityId: c.facilityId ?? null,
                  caseNumber: c.caseNumber ?? null,
                };
              }).filter((r) => {
                const hay =
                  `${r.providerName} ${r.payerName ?? ""} ${r.payerReferenceId ?? ""}`.toLowerCase();
                const digits = r.caseNumber != null ? String(r.caseNumber) : "";
                return (
                  hay.includes(needle) ||
                  (caseDigits != null && digits !== "" && digits.includes(caseDigits))
                );
              });
        return envelope(res, 200, rows, null, { total: rows.length });
      }
      return envelope(res, 422, null, "providerId or q query parameter is required");
    }

    // --- /api/cases/:id/context (full E4.3 TE-2 projection) ---
    const contextMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/context\/?$/);
    if (contextMatch) {
      if (method !== "GET") return envelope(res, 405, null, "Method not allowed");
      const c = CASES.find((row) => row.id === contextMatch[1]);
      if (!c) return envelope(res, 404, null, "Case not found");
      const p = PROVIDERS.find((row) => row.id === c.providerId);
      res.setHeader("cache-control", "no-store");
      return envelope(res, 200, {
        referenceNumbers: c.payerReferenceId ? [c.payerReferenceId] : [],
        payerPipelineState: c.payerPipelineState ?? "not_started",
        provider: p ? { id: p.id, name: `${p.firstName} ${p.lastName}` } : null,
        payer: { id: "payer-1", name: c.payerName },
        state: c.state,
        selectedFacility: (() => {
          const id = c.facilityId;
          if (!id) return null;
          const facility = FACILITIES.find((f) => f.id === id);
          return facility ?? null;
        })(),
        // E1.4 — the case's full location set; caseFacilitiesFor() above.
        facilities: caseFacilitiesFor(c.id),
        openTasks: c.openTasks,
        latestNote: c.latestNote
          ? { content: c.latestNote.text, createdAt: c.latestNote.at, authorName: c.latestNote.author }
          : null,
        latestTouch: null,
      });
    }

    // --- /api/cases/:id/touches (portal_submission + structured_touch) ---
    const touchesMatch = url.pathname.match(/^\/api\/cases\/([^/]+)\/touches\/?$/);
    if (touchesMatch) {
      if (method !== "POST") return envelope(res, 405, null, "Method not allowed");
      const body = await readBody(req);
      if (!body || typeof body !== "object") {
        return envelope(res, 422, null, "Request body must be a JSON object");
      }
      const caseRow = CASES.find((c) => c.id === touchesMatch[1]);
      if (!caseRow) return envelope(res, 404, null, "Case not found");
      if (body.kind !== "portal_submission" && body.kind !== "structured_touch") {
        return envelope(res, 422, null, "kind must be 'portal_submission' or 'structured_touch'");
      }
      if (!UUID_RE.test(body.idempotency_id ?? "")) {
        return envelope(res, 422, null, "idempotency_id must be a client-generated UUID");
      }
      if (body.kind === "structured_touch") {
        for (const field of PORTAL_SUBMISSION_ONLY) {
          if (body[field] != null) {
            return envelope(res, 422, null, `${field} is only valid for kind 'portal_submission'`);
          }
        }
        if (!CANONICAL_TOUCH_TYPES.includes(body.touch_type)) {
          return envelope(res, 422, null, "touch_type must be one of the canonical types");
        }
        if (body.outcome != null && !DISPOSITIONS.includes(body.outcome)) {
          return envelope(res, 422, null, "outcome must be a valid disposition");
        }
        if (body.outcome === "other" && !(typeof body.note === "string" && body.note.trim())) {
          return envelope(res, 422, null, "outcome 'other' requires a one-line context in note");
        }
      } else if (typeof body.portal_key !== "string" || body.portal_key.trim() === "") {
        return envelope(res, 422, null, "portal_key is required");
      }
      // Idempotent replay BEFORE failure injection: a stored touch replays
      // even when the "network" is flaky, mirroring the server-side anchor.
      if (state.touches.has(body.idempotency_id)) {
        return envelope(res, 200, state.touches.get(body.idempotency_id));
      }
      if (state.failTouches > 0) {
        state.failTouches -= 1;
        return envelope(res, 500, null, "Internal error");
      }
      const touch = {
        id: body.idempotency_id,
        caseId: touchesMatch[1],
        touchDate: new Date().toISOString().slice(0, 10),
        touchType: body.kind === "structured_touch" ? body.touch_type : "portal",
        outcome: body.kind === "structured_touch" ? (body.outcome ?? null) : "submitted",
        notes: body.note ?? null,
        source: "extension",
      };
      state.touches.set(body.idempotency_id, touch);
      // S4.4: the opt-in bump's outcome rides META, never the touch. The mock
      // mirrors both outcomes so the panel's honest-reporting path is
      // exercised: a case already past In Progress reports skipped.
      let meta = null;
      if (body.bump_status === true) {
        meta =
          caseRow.status === "Submitted"
            ? {
                status_bump: "skipped",
                status_bump_reason: "The case was not in a status that can move to Submitted.",
              }
            : { status_bump: "applied" };
      }
      return envelope(res, 201, touch, null, meta);
    }

    // --- E6.9 shared (org-free) training tier. Mirrors the panel: both routes
    // run on the user-scoped guard, and the mock RECORDS the x-org-id header it
    // was sent so a test can pin that training never carries one. ---
    if (/^\/api\/shared-portals\/?$/.test(url.pathname)) {
      if (method !== "GET") return envelope(res, 405, null, "Method not allowed");
      state.sharedOrgHeaders.push(req.headers["x-org-id"] ?? null);
      return envelope(res, 200, state.sharedPortals, null, {
        total: state.sharedPortals.length,
      });
    }
    if (/^\/api\/shared-portals\/prove\/?$/.test(url.pathname)) {
      state.sharedOrgHeaders.push(req.headers["x-org-id"] ?? null);
      if (method !== "POST") return envelope(res, 405, null, "Method not allowed");
      const body = (await readBody(req)) ?? {};
      const portal = state.sharedPortals.find(
        (row) => (typeof body.portalKey === "string" && row.portalKey === body.portalKey) ||
          (typeof body.id === "string" && row.id === body.id),
      );
      if (!portal) return envelope(res, 404, null, "Shared portal not found");
      portal.provenAt = new Date().toISOString();
      return envelope(res, 200, { portal });
    }
    if (/^\/api\/shared-test-fills\/?$/.test(url.pathname)) {
      state.sharedOrgHeaders.push(req.headers["x-org-id"] ?? null);
      if (method !== "POST") return envelope(res, 405, null, "Method not allowed");
      const body = (await readBody(req)) ?? {};
      if (state.sharedTestFills.has(body.id)) {
        return envelope(res, 200, { session: state.sharedTestFills.get(body.id) });
      }
      const session = { ...body, isTest: true, performedBy: FIXTURES.USER_ID };
      state.sharedTestFills.set(body.id, session);
      return envelope(res, 201, { session });
    }
    if (/^\/api\/shared-field-maps\/?$/.test(url.pathname)) {
      state.sharedOrgHeaders.push(req.headers["x-org-id"] ?? null);
      if (method === "GET") {
        const portalKey = url.searchParams.get("portal_key");
        let rows = state.sharedMaps;
        if (portalKey) rows = rows.filter((r) => r.portalKey === portalKey);
        return envelope(res, 200, rows, null, { total: rows.length });
      }
      if (method !== "POST") return envelope(res, 405, null, "Method not allowed");
      const body = (await readBody(req)) ?? {};
      if (typeof body.portal_key !== "string" || !body.portal_key.trim()) {
        return envelope(res, 422, null, "portal_key is required");
      }
      if (typeof body.selector !== "string" || !body.selector.trim()) {
        return envelope(res, 422, null, "selector is required");
      }
      const key = `${body.portal_key}:${body.selector}`;
      let map = state.sharedProposed.get(key);
      const created = map == null;
      const incomingOptions = Array.isArray(body.control_options) ? body.control_options : null;
      if (!map) {
        map = {
          id: `fm-shared-${state.sharedProposed.size + 1}`,
          // The tier's defining property: never the caller's org.
          orgId: null,
          portalKey: body.portal_key,
          selector: body.selector,
          fieldLabel: String(body.field_label ?? "").trim().toLowerCase() || null,
          formSection: body.form_section ?? null,
          pageStep: body.page_step ?? null,
          sortOrder: body.sort_order ?? null,
          fieldType: body.field_type ?? "text",
          controlOptions: incomingOptions && incomingOptions.length > 0 ? incomingOptions : null,
          source: "manual",
          token: null,
          status: "proposed",
        };
        state.sharedProposed.set(key, map);
      } else if (incomingOptions && incomingOptions.length > 0) {
        map.controlOptions = incomingOptions;
      }
      return envelope(res, created ? 201 : 200, { map });
    }

    // --- /api/portal-field-maps ---
    if (/^\/api\/portal-field-maps\/?$/.test(url.pathname)) {
      // S5.1/S5.3: propose-only. The row is always proposed/manual/token-null;
      // the response carries the org's learned suggestion for the label.
      if (method === "POST") {
        const body = (await readBody(req)) ?? {};
        if (typeof body.portal_key !== "string" || !body.portal_key.trim()) {
          return envelope(res, 422, null, "portal_key is required");
        }
        if (typeof body.selector !== "string" || !body.selector.trim()) {
          return envelope(res, 422, null, "selector is required");
        }
        const label = String(body.field_label ?? "").trim().toLowerCase();
        const key = `${body.portal_key}:${body.selector}`;
        let map = state.proposedMaps.get(key);
        if (!map) {
          map = {
            id: `fm-proposed-${state.proposedMaps.size + 1}`,
            orgId: FIXTURES.KANSAS_ORG,
            portalKey: body.portal_key,
            selector: body.selector,
            fieldLabel: label || null,
            source: "manual",
            token: null,
            status: "proposed",
          };
          state.proposedMaps.set(key, map);
        }
        // A tiny learned dictionary so the panel's evidence path is exercised.
        const learned = { npi: { token: "provider.npi", portalCount: 3 } }[label];
        return envelope(res, 201, {
          map,
          suggestion: learned
            ? { token: learned.token, portalCount: learned.portalCount, fromDictionary: false }
            : null,
        });
      }
      if (method !== "GET") return envelope(res, 405, null, "Method not allowed");
      const portalKey = url.searchParams.get("portal_key");
      let rows = state.fieldMaps;
      if (portalKey) rows = rows.filter((r) => r.portalKey === portalKey);
      return envelope(res, 200, rows, null, { total: rows.length });
    }

    // --- /api/fill-events ---
    if (/^\/api\/fill-events\/?$/.test(url.pathname)) {
      if (method !== "POST") return envelope(res, 405, null, "Method not allowed");
      const body = await readBody(req);
      if (!body || typeof body !== "object") {
        return envelope(res, 422, null, "Request body must be a JSON object");
      }
      if (state.fillSessions.has(body.id)) {
        return envelope(res, 200, state.fillSessions.get(body.id));
      }
      const session = { ...body, performedBy: FIXTURES.USER_ID };
      state.fillSessions.set(body.id, session);
      return envelope(res, 201, session);
    }

    return envelope(res, 404, null, "Not found");
  }

  const port = await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve(server.address().port));
  });
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
