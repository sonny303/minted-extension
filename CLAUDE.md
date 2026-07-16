# CLAUDE.md — Minted Panel Workbench (Chrome extension)

Orientation for AI coding sessions. This is a map with pointers — the README
carries the full architecture spec (locked, v1.2) and the fill-flow narrative;
read it next. The panel repo (`sonny303/mintedpanel`) is the **server side of
every contract here** and its `CLAUDE.md` ("Server API layer" + locked
decisions) is the source of truth for the wire shapes below.

## What this is

MV3 Chrome extension ("Minted Panel Workbench") that fills payer-portal
enrollment forms with Minted Panel provider data in one click, then logs the
fill and the human's submission back to the case. v0 is unlisted (loaded
unpacked); first target portal is BCBS Kansas network enrollment.

## Architecture (three locked rules — README has the detail)

1. **Never queries Supabase tables; never holds the service key.** Supabase
   auth only mints a JWT (anon key + email/password). ALL data flows through
   the panel API at `https://mintedpanel.vercel.app` (`src/shared/config.ts`).
2. **The background service worker owns every API call** (`src/background/`:
   `api.ts` fetch layer, `auth.ts` session, `fill.ts` fill orchestration,
   `orgState.ts`, `index.ts` message router). The side panel
   (`src/sidepanel/main.ts`, vanilla TS, no framework) is UI-only and talks to
   the worker over `chrome.runtime` messaging (`src/shared/messages.ts` —
   typed `BgRequest`/response union). It never holds tokens. The content
   script (`src/content/`, IIFE build) receives resolved fill values via
   messaging, applies them (`fillEngine.ts`, native setters + `input`/`change`
   events), and reports results; the worker refuses messages from tabs.
3. **Session lives in `chrome.storage.session`** (dies with the browser).
   MV3 workers restart constantly: `getSession()` refreshes on demand and the
   API layer retries a 401 once after a forced refresh.

An eslint rule enforces the boundary: only `src/background/` may import
`@supabase/supabase-js`. Builds: `vite.config.ts` (panel + background) and
`vite.content.config.ts` (content script — content scripts can't be ESM).

## Commands (all verified passing 2026-07-16, clean clone + `npm ci`)

- `npm run build` — panel/background then content builds; `dist/` = loadable
  unpacked extension
- `npm run typecheck` — `tsc --noEmit`, clean
- `npm run lint` — `eslint .`, clean
- `npm run test` — vitest; 1 file, 15 tests, all pass
- `npm run watch` — rebuild panel/background on change

## Locked wire contracts with the panel (do not change unilaterally)

Local mirror of all response/body types: `src/shared/apiTypes.ts`. Panel-side
truth in `sonny303/mintedpanel` at the paths cited per item.

- **Envelope:** every response is `{ data, error, meta }`; list meta carries
  `{ total, page, pageSize }`; `meta.notes` is advisory. Rows come back
  camelCased. (Panel `src/server/envelope.ts`.)
- **Auth/org headers:** `Authorization: Bearer <jwt>` on every call. A
  single-org user sends NO `x-org-id` (server resolves the sole membership);
  a multi-org user must send `x-org-id` on every org-scoped call — the server
  400s a multi-org caller without it, never guesses. `GET /api/me/orgs` is the
  ONE route that never carries it (it's how the caller learns what to send).
  (Panel `src/server/guard.ts`; extension `src/background/api.ts`.)
- **Bare token keys:** the canonical token key is the bare catalog form
  `family.field` in camelCase — e.g. `provider.firstName` — exactly what the
  panel's `get_sop_field_tokens()` emits. The SERVER normalizes braced
  `{{token}}` forms at its read boundary, so the field-map → profile-token
  join here is a literal string match; **the extension never strips braces.**
  (Panel `src/lib/tokenFormat.ts` `normalizeTokenKey`, pinned by
  `src/server/profileFieldMapJoin.test.ts`.)
- **Profile response:** `GET /api/providers/:id/profile?state=XX&facilityId=…`
  returns `provider` + `tokens[{token, value}]` + `unresolved[{token, reason}]`
  + `facilities` + `selected_facility_id`; ambiguous facility sets flag
  `meta.needs_facility`. The snake_case keys `selected_facility_id` and
  `needs_facility` are the locked wire contract, unlike the camelCased rows.
  (Panel `src/services/providerProfile.ts`.)
- **portalTasks (portal-task close-out):** `GET /api/cases?providerId=…` rows
  optionally carry `portalTasks: [{ taskId, title, portalKey, status }]` — the
  case's open, portal-linked SOP tasks; `portalKey` arrives normalized
  (bare/lowercase) from the server. The extension matches the page's
  portal_key against these and passes the matched `task_id` on the submission
  touch; it never invents a task. Rows also carry `payerReferenceId` (prefill),
  `latestNote {text, author, at}`, and `lastSubmittedAt` (14-day duplicate
  guard). (Panel `src/services/providerCases.ts`.)
- **Touches body is snake_case** (locked R2 contract, 2026-07-05 — unlike
  fill-events' camelCase): `POST /api/cases/:id/touches` takes
  `{ kind: "portal_submission", portal_key, idempotency_id,
  fill_session_id?, note?, payer_reference_id?, wip_note?, task_id?,
  pdf_filename? }`. Server sets org + user from the JWT; never a status
  change. (Panel `src/services/submissionTouches.ts`; mirror
  `SubmissionTouchBody` in `src/shared/apiTypes.ts`.)
- **Fill-events body is camelCase:** `POST /api/fill-events` takes
  `{ id, caseId, providerId, portalKey, fillMode: "web", startedAt,
  completedAt, fieldsFilled, fieldsSkipped }`. (Panel
  `src/services/fillSessions.ts`; mirror `FillEventBody` in
  `src/background/api.ts`.)
- **Idempotency:** fill-events — the client-generated `id`
  (`crypto.randomUUID()`, new per attempt) is both idempotency key and row PK;
  a replay returns the stored row (200) instead of inserting (201). Touches —
  `idempotency_id` becomes the anchor touch row's PK; the worker reuses it on
  retries so a touch can never double-log, and a replay short-circuits at the
  anchor re-running NO side effects (no second note/task/system_event).
  (Panel `src/services/fillSessions.ts` / `src/services/submissionTouches.ts`.)
- **Field maps:** `GET /api/portal-field-maps?portal_key=…` is a shared
  catalog — `orgId: null` rows are global portal truths, org rows are
  overrides. The extension fills `proposed` AND `approved` maps (only
  `retired` is skipped). (Panel `src/services/portalFieldMaps.ts`.)

## Locked product rules

- **The extension never submits portal forms. Unchanged, forever.** The human
  submits; the extension logs. Never a case status change from here (v1).
- **Case selection is REQUIRED before fill** (locked decision) — the case
  dropdown is fed by `GET /api/cases?providerId=…`.
- Tokens never touch page context; field values never persist in
  `chrome.storage` (fill reports store labels/counts/reasons only).
- `API_CORS_ORIGINS` on the panel's Vercel project must include
  `chrome-extension://<id>` (owner-managed; id changes when the unpacked path
  changes or on packing).

## Before you change anything

- **Never change a locked wire contract unilaterally.** Every shape above has
  a server side in `sonny303/mintedpanel` (guard, envelope, route services,
  isolation-gate assertions) — a one-sided edit breaks the fill or the
  close-out loop silently. Contract changes are panel-first, mirrored here in
  `src/shared/apiTypes.ts` in the same coordinated change.
- **E4.3 (extension handoff parity) coordination happens with BOTH repos
  attached in one session** — the contract lives in one context, not in two
  sessions coordinating through PR descriptions.
- Keep the eslint import boundary (only `src/background/` touches
  supabase-js) and the no-tokens-in-messages rule intact.
- The service-role key must never appear anywhere in this codebase; the
  committed `SUPABASE_ANON_KEY`/`API_BASE_URL` in `src/shared/config.ts` are
  public by design.
