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
unpacked); the manifest ships static access to BCBS Kansas network enrollment,
but capture and fill reach ANY DB-registered portal — the panel grants the
registry's origins on demand and the worker injects `content.js` where there's
no static match (see "Portal access" below and the README).

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
- `npm run test` — vitest; 12 files, 133 tests, all pass (includes the TE-10
  mock harness: `src/harness/workbench.test.ts` drives the real background
  modules against `scripts/mock-panel-api.mjs`, an in-repo mirror of the
  panel /api contract — CI never touches a real portal or the real panel)
- `npm run watch` — rebuild panel, background AND content script on change
  (`scripts/watch.mjs`: two Vite configs write into one `dist/`, and the main
  config's `emptyOutDir` means every main rebuild has to re-emit `content.js`)

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
  pdf_filename?, bump_status? }`. Server sets org + user from the JWT.
  **S4.4 (2026-07-28): `bump_status: true` also moves the case In Progress ->
  Submitted** through the panel's `set_case_status`, evidenced by that touch.
  Off by default and omitted from the body unless asked, so the R2 "never an
  IMPLICIT status change" rule still holds. The outcome rides
  `meta.status_bump` (`applied` | `skipped` + `status_bump_reason`), never the
  touch — a rejected transition is NOT a failed touch, and the panel reports
  both separately. (Panel `src/services/submissionTouches.ts`; mirror
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
  overrides. **ONLY `approved` maps fill** (S5.1, 2026-07-28 — supersedes the
  v0 proposed-fills-too posture): a proposed row is an unreviewed observation
  awaiting the panel trainer; it counts as a gap in coverage, never a fill.
  `POST /api/portal-field-maps` is the PROPOSE-ONLY write — the server forces
  `status 'proposed'`, `source 'manual'`, `token null` under the caller's org
  whatever the body says; idempotent on `(portal_key, selector)` across
  global + own-org rows (200 on a repeat, 201 first sighting).
  (Panel `src/services/portalFieldMaps.ts`.)
- **SET_ACTIVE_CASE handoff (E4.3 TE-1; widened by S3.5 2026-07-28):** the
  webapp sends `{ type: "SET_ACTIVE_CASE", caseId, providerId, orgId,
portalUrl, portalKey?, facilityId? }` through
  `externally_connectable` — IDENTIFIERS + URL ONLY, never a profile/token
  value. `parseSetActiveCase` (`src/shared/handoff.ts`) strict-parses and
  drops unknown fields; the two S3.5 extras are OPTIONAL both ways — the
  webapp omits them when a case has none, and a malformed value is DROPPED
  rather than failing the handoff (losing the location costs a picker prompt,
  rejecting the message costs the launch). A carried `facilityId` pre-selects
  the location so the panel lands with zero dropdowns; the worker (`src/background/activeCase.ts`) stores
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
- **View prefs = quick-card layout + SERVED catalog (2026-07-28, supersedes
  the TE-16 mirror):** `GET /api/me/view-prefs` (user-scoped) returns
  `{ fields: string[] | null, catalog: QuickCardCatalogField[] }` — the saved
  layout plus the schema-derived selectable-field catalog
  (`{key,label,group,groupLabel}`, 117 fields, derived panel-side from the
  SAME `get_sop_field_tokens()` the profile resolves values from). The picker
  renders from the served catalog; `src/shared/quickCards.ts` carries NO
  mirror anymore. PUT validates against the same derived set (a non-catalog
  key 422s; there is NO length cap). `provider.ssnLast4` is a legitimate
  catalog field (product decision 2026-07-28); the FULL SSN remains
  structurally unreachable (the vault is outside the token catalog's sweep).
  `resolveLayout` degrades any invalid stored layout to the default — never a
  broken card — and validates keys against the served set only when the
  catalog read succeeded (a failed read must not wipe a saved layout).

- **Shared (org-free) training tier — E6.9, 2026-08-07:** three routes run on
  the panel's USER-scoped guard and touch the shared library every org
  inherits: `GET /api/shared-portals` (global registry rows only),
  `GET /api/shared-field-maps?portal_key=` (that form's shared rows, ordered by
  `sort_order`), and `POST /api/shared-field-maps` (propose; `org_id` is always
  null, idempotent on `(portal_key, selector)` — a re-capture returns the
  existing row with its decision untouched, which is what makes re-capture
  drift repair rather than a reset). The propose body adds `page_step` and
  `sort_order` to the org route's shape and is still values-free. `PortalFieldMap`
  gained optional `displayLabel`/`section`/`sortOrder`; `PortalRegistryRow`
  gained optional `payerName`. Panel-side: `src/services/portals.ts`
  `listSharedPortals`, `src/services/portalFieldMaps.ts` `listSharedFieldMaps` /
  `proposeSharedFieldMap`; gate assertions 22/22b/23 + the `sharedtier` leak
  mode. **The org header is keyed by MODE, not by path** (`shouldSendOrgHeader`
  in `src/shared/panelMode.ts`): training sends none even for a multi-org user,
  because the org-resolving guard would 400 it and an org header would scope
  the capture to a tenant.

## Locked product rules

- **Portal access is dynamic, not BCBS-only.** Recognition and content-script
  injection both need host permission for the tab's origin; the manifest ships
  static access to BCBS KS only. `optional_host_permissions: ["https://*/*"]`
  lets the panel REQUEST origins, but it only ever requests the specific origins
  the registry names (`portalOriginPatterns`, `src/shared/portals.ts`) — never
  `https://*/*` itself. The `#portal-access` panel prompt grants them in one
  click; `ensureContentScript` (`src/background/inject.ts`) then injects the
  SAME `content.js` on demand before `START_CAPTURE`/`FILL` when no static
  content-script match exists. Shape-only capture + resolved-value fill are
  unchanged — the injection moves no data boundary. Permission/manifest changes
  mean reloading the unpacked extension.
- **The extension never submits portal forms. Unchanged, forever.** The human
  submits; the extension logs. Never a case status change from here (v1).
- **Two jobs, one panel (E6.9 F6.9.7).** After sign-in the panel asks which
  job is being done: **Train forms** or **Work cases**. Training shows a payer
  select → form find/select → capture and NOTHING else — no org, provider or
  case picker, no quick cards, no touch logging — because a trained form has no
  org and exists before any case for that payer does. Work cases is the
  unchanged screen. The mode lives in the WORKER
  (`src/background/mode.ts`, `chrome.storage.session`) because it decides
  whether a call carries `x-org-id`; the panel mirrors it. A `SET_ACTIVE_CASE`
  hand-off FORCES the mode to `case` on receipt — the chooser never stands
  between the webapp's launch and the case it launched.
- **Capture is per PAGE (E6.9 F6.9.8; page naming amended by BITE-CAP-01).**
  `START_CAPTURE` carries a `pageStep` and rows carry DOM-order `sortOrder`.
  `mergePageCapture` folds a scan into the session PER PAGE — a plain
  `diffCapture` would read every other page's rows as removed and drop them,
  so a trainer walking five pages would keep only the fifth. The name comes
  from `resolvePageStepForCapture` (`src/shared/capture.ts`): a FIRST capture
  (no session, or a different portal) derives it with `derivePageStep`
  (heading → URL tail → capture sequence), and every later capture on the same
  portal REUSES an existing page name so re-capture is drift repair rather than
  an appended clone. The panel passes `heading: null` — `tab.title` is not a
  wizard heading, so the heading rung is dormant until the content script
  reports one. **Known limitation:** because reuse is unconditional, a trainer
  who navigates to page 2 and captures again lands in page 1's bucket and
  page 1's rows are diffed away; multi-page walks need a "capture next page"
  affordance (or selector-overlap detection) before they work again.
- **Recognition never blocks or guesses (E6.9 F6.9.9).** `recognizeForm` reuses
  the SAME `matchPortalByUrl` the fill engine uses, so trainer and filler can
  never disagree about which portal a page is. A recognized form reports what
  it already has (`formCaptureState`: pages seen, fields captured, mapped —
  where "mapped" excludes an approved row that would fill nothing) and is never
  silently changed; an unrecognized page is greeted as new with a NUMBERED
  candidate name (`<Payer> form 2`) the admin renames. Nothing is auto-attached
  to a template or task.
- **Case selection is REQUIRED before fill** (locked decision) — via the
  E4.3 handoff, the unified search, the active-cases list, the NBA handback,
  or the manual picker; all funnel into the same active-case state.
- **Write boundary (widened 2026-07-28, supersedes the E4.3 R6 read-only
  posture — panel-first coordinated change, both repos in one session):** the
  sanctioned writes are the manual touch POST (both kinds; a
  `portal_submission` may carry the opt-in `bump_status: true`, the ONE
  explicit status transition — In Progress → Submitted via the panel's
  `set_case_status`, evidenced by the touch; the outcome rides
  `meta.status_bump`, a skipped bump is reported, never silent), the
  user-scoped layout PUT, the PROPOSE-ONLY field-map POST (never an
  approval), and the CAQH attestation POST
  (`/api/providers/:id/caqh-attestation`). Still NO task-state writes, no
  mapping approvals, no auto-submit, no auto-touch, no IMPLICIT status
  change.
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
  public by design. Optional `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` /
  `VITE_API_BASE_URL` overrides retarget a build without editing source
  (3M Slice 5 / F13); unset keeps production defaults.
