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
  FACILITY_ID: "5f190f0d-2c5c-49f7-8953-aa05cd0a9d64",
  TASK_ID: "b7a90000-0000-4000-a000-0000000000d1",
  TOKEN: "tok-kansas",
  USER_ID: "user-kansas",
  PORTAL_KEY: "bcbs_ks_enrollment",
  // The deliberately-untrained map row (token null) — the TS-82 fix-it target.
  UNTRAINED_MAP_ID: "fm-untrained-1",
};

const PROVIDERS = [
  {
    id: FIXTURES.PROVIDER_ID,
    firstName: "Kay",
    lastName: "One",
    credentials: "PT, DPT",
    npi: "1234567890",
    homeState: "KS",
    caqhId: null,
    caqhLastAttestedDate: null,
    taxonomyCode: "225100000X",
    status: "active",
    groupId: "g-1",
    specialty: "Physical Therapy",
    email: "kay.one@example.com",
    updatedAt: "2026-07-01T00:00:00Z",
  },
  {
    id: FIXTURES.PROVIDER2_ID,
    firstName: "Pat",
    lastName: "Ostrander",
    credentials: "PT",
    npi: "1987654321",
    homeState: "KS",
    caqhId: "88881111",
    caqhLastAttestedDate: "2026-06-01",
    taxonomyCode: "225100000X",
    status: "active",
    groupId: "g-1",
    specialty: "Physical Therapy",
    email: "pat.o@example.com",
    updatedAt: "2026-07-01T00:00:00Z",
  },
];

// Date helpers for expiry fixtures relative to "today" (the mock computes at
// request time; the pure expiry math is separately unit-tested with fixed
// dates).
function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

// The provider profile's resolved tokens (TE-12: quick cards are a rendering
// of this endpoint). Kay One carries honest gaps: caqhId empty (data gap) and
// a license expiring inside the 30-day badge window.
function profileTokens(providerId) {
  const p = PROVIDERS.find((row) => row.id === providerId);
  const rich = providerId === FIXTURES.PROVIDER_ID;
  return [
    { token: "provider.firstName", value: p.firstName },
    { token: "provider.lastName", value: p.lastName },
    { token: "provider.credentials", value: p.credentials },
    { token: "provider.dateOfBirth", value: "1980-01-15" },
    { token: "provider.npi", value: p.npi },
    { token: "provider.caqhId", value: p.caqhId },
    { token: "provider.specialty", value: p.specialty },
    { token: "provider.email", value: p.email },
    { token: "license.licenseNumber", value: rich ? "KS-12345" : null },
    { token: "license.state", value: rich ? "KS" : null },
    { token: "license.expirationDate", value: rich ? isoDaysFromNow(20) : null },
    { token: "license.issueDate", value: rich ? "2020-01-01" : null },
    { token: "group.name", value: "Kansas Fitness Physio Group" },
    { token: "group.tin", value: "48-1234567" },
    { token: "group.npiType2", value: "1098765432" },
    { token: "groupInsurance.insurerName", value: "CoverWell Mutual" },
    { token: "groupInsurance.policyNumber", value: "MP-889900" },
    { token: "groupInsurance.policyEndDate", value: isoDaysFromNow(200) },
    { token: "facility.name", value: "Fitness Physio - Leavenworth" },
    { token: "payer.name", value: null },
    { token: "user.name", value: "Test Kansas" },
    { token: "user.email", value: "testkansas@minted.com" },
  ];
}

const PROFILE_UNRESOLVED = [
  { token: "provider.caqhId", reason: "empty on provider" },
  { token: "payer.name", reason: "case-scoped source (payers); resolve at fill time" },
];

const FACILITIES = [
  {
    id: FIXTURES.FACILITY_ID,
    name: "Fitness Physio - Leavenworth",
    street: "100 Main St",
    suite: null,
    city: "Leavenworth",
    state: "KS",
    zip: "66048",
  },
];

const CASES = [
  {
    id: FIXTURES.CASE_ID,
    providerId: FIXTURES.PROVIDER_ID,
    payerName: "BCBS of Kansas",
    state: "KS",
    status: "Submitted",
    submittedDate: "2026-06-01",
    payerReferenceId: "REF-1001",
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
    payerName: "Humana",
    state: "KS",
    status: "In Progress",
    submittedDate: null,
    payerReferenceId: null,
    latestNote: null,
    lastSubmittedAt: null,
    payerPipelineState: "not_started",
    portalTasks: [],
    openTasks: [],
  },
];

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
      const rows = [{ orgId: FIXTURES.KANSAS_ORG, orgName: "Kansas Fitness Physio", role: "admin" }];
      return envelope(res, 200, rows, null, { total: rows.length });
    }

    // --- /api/me/view-prefs (E4.3 TE-15: user-scoped, closed catalog) ---
    if (/^\/api\/me\/view-prefs\/?$/.test(url.pathname)) {
      if (method === "GET") {
        return envelope(res, 200, { fields: state.viewPrefs.get(FIXTURES.USER_ID) ?? null });
      }
      if (method === "PUT") {
        const body = await readBody(req);
        const fields = body?.fields;
        if (
          !Array.isArray(fields) ||
          fields.length > 32 ||
          new Set(fields).size !== fields.length ||
          fields.some(
            (f) => typeof f !== "string" || f === "provider.ssnLast4" || !f.includes("."),
          )
        ) {
          return envelope(res, 422, null, "unknown or excluded field key");
        }
        state.viewPrefs.set(FIXTURES.USER_ID, fields);
        return envelope(res, 200, { fields });
      }
      return envelope(res, 405, null, "Method not allowed");
    }

    // --- /api/providers/:id/profile ---
    const profileMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/profile\/?$/);
    if (profileMatch) {
      const p = PROVIDERS.find((row) => row.id === profileMatch[1]);
      if (!p) return envelope(res, 404, null, "Provider not found");
      res.setHeader("cache-control", "no-store");
      return envelope(res, 200, {
        provider: { id: p.id, ssnLast4: "0000", dateOfBirth: "1980-01-15" },
        tokens: profileTokens(p.id),
        unresolved: PROFILE_UNRESOLVED,
        facilities: FACILITIES,
        selected_facility_id: FIXTURES.FACILITY_ID,
      });
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

    // --- /api/next-best-action (E4.3 TE-6) ---
    if (/^\/api\/next-best-action\/?$/.test(url.pathname)) {
      if (method !== "GET") return envelope(res, 405, null, "Method not allowed");
      return envelope(res, 200, {
        item: {
          caseId: FIXTURES.CASE2_ID,
          providerId: FIXTURES.PROVIDER2_ID,
          providerName: "Pat Ostrander",
          payerName: "Humana",
          groupName: "Kansas Fitness Physio Group",
          state: "KS",
          actionKind: "follow_up",
          action: "Follow up with Humana",
          reason: "Follow-up overdue by 3 days.",
          deadline: { date: isoDaysFromNow(-3), source: "follow_up", overdue: true },
          payerPipelineState: "not_started",
          deepLink: `/cases/${FIXTURES.CASE2_ID}`,
        },
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
                };
              }).filter((r) => {
                const hay =
                  `${r.providerName} ${r.payerName ?? ""} ${r.payerReferenceId ?? ""}`.toLowerCase();
                return hay.includes(needle);
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
        selectedFacility: FACILITIES[0],
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
      return envelope(res, 201, touch);
    }

    // --- /api/portal-field-maps ---
    if (/^\/api\/portal-field-maps\/?$/.test(url.pathname)) {
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
