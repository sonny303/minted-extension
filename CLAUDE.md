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
   `orgState.ts`, `activeCase.ts` E4.3 handoff receipt + active-case record,
   `index.ts` message router). The side panel
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

## Commands (all verified passing 2026-07-17, clean clone + `npm ci`)

- `npm run build` — panel/background then content builds; `dist/` = loadable
  unpacked extension
- `npm run typecheck` — `tsc --noEmit`, clean
- `npm run lint` — `eslint .`, clean
- `npm run test` — vitest; 6 files, 78 tests, all pass (includes the TE-10
  mock harness: `src/harness/workbench.test.ts` drives the real background
  modules against `scripts/mock-panel-api.mjs`, an in-repo mirror of the
  panel /api contract — CI never touches a real portal or the real panel)
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
- **SET_ACTIVE_CASE handoff (E4.3 TE-1):** the webapp sends
  `{ type: "SET_ACTIVE_CASE", caseId, providerId, orgId, portalUrl }` through
  `externally_connectable` — IDENTIFIERS + URL ONLY, never a profile/token
  value. `parseSetActiveCase` (`src/shared/handoff.ts`) strict-parses and
  drops unknown fields; the worker (`src/background/activeCase.ts`) stores
  ONE record (last launch wins), binds the next portal-origin tab, expires on
  tab close or 60 min idle. (Panel `src/lib/extensionHandoff.ts`.)
- **Case context (E4.3 TE-2):** `GET /api/cases/:id/context` returns
  `referenceNumbers`, `payerPipelineState`, `provider`/`payer` (`{id, name}`),
  `state`, `selectedFacility`, `openTasks` (with E4.2 `executionType` —
  `extension_fill` tasks are the fillable ones), `latestNote`, `latestTouch`.
  The new keys are camelCase per that contract; the extension types them
  OPTIONAL so a server that predates them degrades to hidden rows. (Panel
  `src/services/caseContext.ts`.)
- **Structured touch (E4.3 TE-5):** the same `POST /api/cases/:id/touches`
  takes `kind: "structured_touch"` — `touch_type` REQUIRED (one of the seven
  E4.1 canonical types), optional `note`/`outcome`/`recipient_name`/
  `recipient_contact`/`next_follow_up_date`/`clears_follow_up`/
  `payer_reference_id`; the portal_submission-only fields are a loud 422 on
  this kind. Type + disposition sets are mirrored in
  `src/shared/structuredTouch.ts`. (Panel `src/services/submissionTouches.ts`
  `recordStructuredTouch`.)
- **Next best action (E4.3 TE-6):** `GET /api/next-best-action` returns
  `{ item }` or `{ item: null }` (honest queue-clear); item carries case/
  provider pointers, display fields, `deadline {date, source, overdue}`, and
  a webapp `deepLink` path. No ranking logic in the extension, nothing
  persisted. (Panel `src/services/nextBestAction.ts`.)
- **Case search (E4.3 TE-11):** `GET /api/cases?q=` returns `CaseSearchRow`s
  (ids + display fields only); `GET /api/providers?search=` is the provider
  half, the PHI-minimized list projection. (Panel
  `src/services/providerCases.ts` `searchOrgCases`, `src/services/providers.ts`.)
- **View prefs = quick-card layout (E4.3 TE-15/TE-16):**
  `GET/PUT /api/me/view-prefs` (user-scoped) stores `{ fields: string[] }` of
  CLOSED-catalog keys (≤32, deduped, ordered; excluded keys like
  `provider.ssnLast4` are a 422 — they are structurally absent from the
  catalog). `src/shared/quickCards.ts` mirrors the catalog verbatim (panel
  `src/lib/quickCardCatalog.ts`) and degrades any invalid stored layout to
  the default — never a broken card.

## Locked product rules

- **The extension never submits portal forms. Unchanged, forever.** The human
  submits; the extension logs. Never a case status change from here (v1).
- **Case selection is REQUIRED before fill** (locked decision) — via the
  E4.3 handoff, the unified search, the active-cases list, the NBA handback,
  or the manual picker; all funnel into the same active-case state.
- **R6 read-only boundary (E4.3):** the ONLY writes are the manual touch POST
  (both kinds) and the user-scoped layout PUT. No task-state writes, no
  mapping writes (fix-it hands off to the platform flows), no auto-submit,
  no auto-touch.
- **Never fill from expired context:** the active-case record expires on
  bound-tab close or 60 minutes idle; the panel closes the gate AND the
  worker refuses the FILL. Expiry/absence/mismatch are explicit UX states,
  never silent.
- Tokens never touch page context; field values never persist in
  `chrome.storage` (fill reports store labels/counts/reasons only; the
  active-case record stores identifiers + URL only). Quick-card values (incl.
  DOB) are in-memory only — cleared on org/case change, sign-out, tab close,
  expiry (TE-14).
- `API_CORS_ORIGINS` on the panel's Vercel project must include
  `chrome-extension://<id>` (owner-managed; id changes when the unpacked path
  changes or on packing). The handoff needs no CORS — it rides
  `externally_connectable` (allowlisted to the app origin in the manifest AND
  re-checked in the worker).

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
