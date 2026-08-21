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
   the panel API at `https://mintedpanel.com` (`src/shared/config.ts`).
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

## Shipping to the Chrome Web Store

`docs/CHROME-WEB-STORE.md` is the submission runbook: permission
justifications written against the code, the data-use disclosure answers, the
listing copy, packaging, and the ordered list of steps only the account owner
can do. Two things in it are worth knowing before touching the manifest:

- **Publish UNLISTED.** This is business software that does nothing without a
  Minted Panel account; public visibility buys nothing and invites review
  questions.
- **`optional_host_permissions: ["https://*/*"]` is the review risk**, and the
  defense is that the literal wildcard is NEVER passed to
  `chrome.permissions.request` — `portalOriginPatterns` turns registry rows
  into specific `https://host/*` patterns and only those are requested, inside
  a user gesture. Keep it that way; the justification text depends on it.
- **Bump `version` in BOTH `public/manifest.json` and `package.json`** for
  every upload. The store rejects a duplicate version, and drift between the
  two makes a published package untraceable to its source.
- **After the first approval, the extension ID changes.** `API_CORS_ORIGINS` on
  the panel's Vercel project must gain `chrome-extension://<published-id>` or
  every data call fails post-install — the likeliest launch-day failure.

## Commands (all verified passing 2026-08-20, clean clone + `npm ci`)

- `npm run build` — panel/background then content builds; `dist/` = loadable
  unpacked extension
- `npm run typecheck` — `tsc --noEmit`, clean
- `npm run lint` — `eslint .`, clean
- `npm run test` — vitest; 26 files, 336 tests, all pass (includes the TE-10
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
  - `facilities` + `selected_facility_id`; ambiguous facility sets flag
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
- **Provider groups on the list row (2026-08-19):** `/api/providers` rows carry
  `groups: [{id, name, isPrimary}]` — every CURRENT group membership, primary
  first then A→Z. The grain is M:N, so `groupId` (the frozen primary mirror)
  could never answer "which Addie Jones is this?". OPTIONAL both ways: a panel
  deployed before this sends no key and `providerGroupsLabel` renders nothing
  rather than claiming the provider has no group. Group names are not PHI.
  Panel side: `listProviders(ctx, filters, { withGroups: true })` (opt-in — a
  second org-scoped read, so browser callers still issue exactly one query),
  pure `indexProviderGroups`/`attachProviderGroups` in `src/lib/groupAssignments.ts`,
  and gate assertions **27 / 27a** + the `providergroups` leak mode.
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
  `sort_order` to the org route's shape and is still values-free; E6.10 adds
  optional `control_options: {value,label}[]` (empty lists are ignored on
  re-capture). `PortalFieldMap` gained optional `displayLabel`/`section`/
  `sortOrder`/`controlOptions`; `PortalRegistryRow` gained optional `payerName`. Panel-side: `src/services/portals.ts`
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
- **THREE jobs, one panel (E6.9 F6.9.7; widened 2026-08-19).** After sign-in
  the panel asks which job is being done: **Search**, **Work cases**, or
  **Train forms**. Training shows a payer select → form find/select → capture
  and NOTHING else — no org, provider or case picker, no quick cards, no touch
  logging — because a trained form has no org and exists before any case for
  that payer does. Search is org-scoped (its routes are), and picking a result
  lands in Work cases. The mode lives in the WORKER
  (`src/background/mode.ts`, `chrome.storage.session`) because it decides
  whether a call carries `x-org-id`; the panel mirrors it. `shouldSendOrgHeader`
  keys off the mode: only `train` suppresses the header. A `SET_ACTIVE_CASE`
  hand-off FORCES the mode to `case` on receipt — the chooser never stands
  between the webapp's launch and the case it launched.
- **Train forms is ADMIN-only (2026-08-19).** `canTrainForms(memberships)` =
  admin in ANY org, since the shared library belongs to no org and the mode
  carries none; non-admins never see the button. It is an AFFORDANCE, not the
  wall — the shared-tier routes run on the panel's user-scoped guard and accept
  any authenticated caller today (panel TD-42). `fallbackModeFor` moves a user
  whose role changed off a job they may no longer do (worker-side too), so a
  stored session mode can never strand someone on hidden UI. Roles are only
  known once `/api/me/orgs` lands, so the button holds its state until then
  rather than flashing away and back — and TRAIN mode boots that read on its
  own (`refreshTrainEligibility`), since it otherwise loads no memberships.
- **Search replaced the Browse-providers dropdown (2026-08-19).** The dropdown
  could not show which group a provider belongs to, so two same-named
  providers were indistinguishable in it. Search rows name the group
  (`providerGroupsLabel`, primary first, "+N" past two) from the new
  `groups` field on `/api/providers`, and `providerMatchesQuery` folds in
  roster rows the SERVER's search cannot reach — it matches name/NPI/email,
  never group names. The selected provider is now plain panel state
  (`selectedProviderId`), not a `<select>` value; `#provider-bar` states who is
  loaded and its one button returns to Search, which IS the switcher.
- **`renderModeSurfaces` is the ONE place that decides what is on screen**,
  from (mode, orgReady). It toggles four top-level containers —
  `#train-section`, `#org-field`, `#search-section`, `#case-work` — and never
  the individual cards inside `#case-work`: those manage their own `hidden` as
  data arrives, so reaching in would either reveal an empty card or clobber
  state it did not set. `src/sidepanel/panelMarkup.test.ts` pins the markup
  contract (every `el()` id resolves, no duplicate ids, every case-work
  surface really is inside `#case-work`) — main.ts throws at import on a
  missing id, which means a blank panel, and nothing else would catch it.
- **Manual field mapping (2026-08-19).** A scan only sees what is rendered AND
  wired at the moment it runs, so a field a portal reveals after an earlier
  answer is legitimately missed — that is what "only 1 of 2 fields" on the
  Humana status form was (the NPI box is `display:none` until a certification
  type is chosen; the radio WAS found, which also rules out an iframe).
  **`+ Add field`** puts the page in pick mode (`src/content/elementPicker.ts`):
  crosshair, hover highlight, click to add, Esc/right-click/blur to cancel.
  Every listener is CAPTURE-phase and swallows its event, so picking a radio
  does not also select it and picking near a submit cannot navigate the form
  away mid-training — verified in a real browser, not just jsdom. The pick
  describes the element through the SAME `describeControl` the scanner uses, so
  a hand-picked and an auto-detected field can never drift apart.
  `PICK_ELEMENT` is the ONE async `ContentRequest` (its listener returns true);
  `MATCH_SELECTOR` backs "Re-test on page" (1 healthy / 0 will never fill / >1
  ambiguous). Per-row inline editing renames, re-types, re-tests and removes.
  **`CaptureRow` gained `origin`, `displayLabel` and `typeOverridden`:**
  `displayLabel` is the trainer's name and is kept SEPARATE from `label` (the
  payer's captured text) exactly as the panel splits display_label from
  field_label — so a re-scan refreshes what the portal says without discarding
  what the human called it. `SEND_CAPTURE` still proposes `field_label` as the
  payer's text, falling back to the trainer's name ONLY when the portal never
  labelled the field at all (otherwise there is nothing to preserve).
  **`mergePageCapture` rescues `user_mapped` rows a fresh scan cannot see** —
  those are precisely the conditionally-rendered fields the picker exists for,
  and dropping them on the next re-capture would silently delete the manual
  work. An `auto_detected` row the scan no longer sees is still dropped, so
  drift repair is unchanged. Legacy rows parse as `auto_detected`.
- **Selector Workshop + bulk delete (US-3.2/US-3.3, 2026-08-20).** The row
  editor's selector is an EDITABLE CSS box, and **"Test selector" tests what is
  TYPED, not what is stored** — otherwise it could only ever confirm the
  selector you are trying to replace. `MATCH_SELECTOR` gained `highlight`, and
  `highlightSelector` (`elementPicker.ts`) flashes every match in bright green
  (`#16a34a`, class `__mp-selector-hit`, auto-clearing after 2.5s) so "3
  matches" says WHICH three. It decorates with a CLASS, never inline styles:
  inline styles would overwrite the portal's own and could not be undone
  cleanly. Verified in a real browser (computed `outline-color` really is
  `rgb(22,163,74)`), because a class name in jsdom proves nothing about paint.
  XPath is deliberately NOT offered yet. A hand-written selector sets
  `selectorOverridden`, which `mergePageCapture` rescues exactly like a
  `user_mapped` row — the scan would re-produce the ORIGINAL fragile selector,
  so without it the fix dies at the very next re-capture. The edit itself is
  the pure `applyRowEdit` (`shared/capture.ts`), which lives beside
  `mergePageCapture` because it guards the same invariant — **the selector IS
  the row's key** — and REFUSES a rewrite colliding with another row.
  Multi-select is panel state keyed by selector (outside the DOM, so a
  re-render never drops a selection); the batch bar appears on the first tick
  and offers **Delete selected only** — assign-to-section and mark-as-human are
  deferred until sections exist.
- **The Selector Workshop's verdict reads the match SHAPE, not a count
  (2026-08-20).** `MATCH_SELECTOR` returns `{valid, matches, fillable,
radioGroup}` (`describeSelectorMatches`, `content/elementPicker.ts`) and the
  pure `selectorVerdict` (`shared/selectorMatch.ts`) turns it into the sentence
  the trainer reads. A bare `querySelectorAll().length` got three common cases
  wrong, each measured against the real engine before the fix: a **wrapper**
  (`#npi-field` on the div around the input) matched exactly one element and so
  showed the green "matches exactly one field", while `bySelector` accepts only
  input/select/textarea and the fill skipped it as `field not found on this
page` — the verdict said the opposite of the truth in the one place a trainer
  goes to be sure; a **radio group** is one field made of N controls, and the
  scanner's own `input[type="radio"][name="…"]` therefore matched N, so a
  correct selector was called "ambiguous, and may fill the wrong one" — a false
  alarm on the exact defect class this trainer was built for (the Humana status
  form), whose advice, followed, breaks a working selector; and **invalid CSS**
  was caught and reported as 0, i.e. as a valid selector finding nothing,
  sending the trainer to re-capture over a typo. `fillable` is a COPY of the
  engine's rule, so `fillEngine.test.ts` pins the two together over six element
  shapes rather than trusting the comment. An N-way radio match under a
  non-radio row now names the control type to change.
- **A drifted library row is actionable (2026-08-21).** "In the library but not
  on this page" IS the _needs updating_ half of the job, and those rows had no
  tick, no Edit and no action at all — the list named the problem and offered
  nothing to do about it. Two things are honest without deciding anything the
  web app owns. **"Check page"** re-tests the LIBRARY's own selector live,
  because "not found on this page" is a fact about the SCAN, not the page: a
  field revealed only after an earlier answer is genuinely present and simply
  was not rendered when the scan ran — the exact situation the picker exists
  for. **"Re-point"** is the repair: click where the field moved to, and the
  proposal carries the library's own name (`PICK_CAPTURE_FIELD` gained an
  optional `displayLabel`), so a reviewer sees the same field rather than a
  stranger. It PROPOSES at the new selector; the old map stays until someone
  retires it in the web app, and the status line says exactly that instead of
  implying the library was edited. `CaptureListRow` carries `fieldType` so a
  library-only row's re-test can read an N-way radio match as one field.
- **`label:` selectors resolve the way the fill does.** The shared library
  really stores maps as `label:First Name`, which is not parseable CSS — so
  `describeSelectorMatches` running raw `querySelectorAll` reported "matches
  nothing" for a field that fills perfectly, and in the capture list every
  label-addressed library field read as drift. `byLabel` is now exported from
  `fillEngine.ts` and used by the workshop, and the parity test covers both a
  present and an absent label.
- **A sent capture links to where mapping happens.** Training proposes; the
  decision is the web app's Submit-form task editor (D18). The note said so and
  stopped there, so the loop ended on an instruction in a different product with
  no way to follow it. `MatchedPortal` now carries `payerId` from the registry
  row it is already built from, and the note links
  `/admin/payer-admin/setup/{payerId}?tab=templates`. Null payer ⇒ text only,
  never a dead link.
- **Sandbox test profile (US-5, 2026-08-20).** A normal fill needs a case, and
  the panel's 4-part case key means one case per provider × group × payer ×
  state — so testing a 100+ field form meant manufacturing cases and leaving
  junk behind. The sandbox fills from the org's DESIGNATED test provider
  (`providers.is_test_provider`, which the panel already excludes from the
  queue, generation and the scorecard) with NO case in play: no touch, no
  status change, no case lifecycle. Not a synthetic identity — filling as a
  real provider is what exercises the true profile pipeline. Pinned above
  search results (it never depends on a query); entering reuses the ordinary
  provider-selection path so quick cards, facilities and the portal gate behave
  exactly as they do for real work. State comes from the provider's home state
  since there is no case to take it from; null is a legitimate answer.
  `sandboxFillPortal` logs through `postSharedTestFill` (`is_test`, no
  case/provider), so a sandbox run can never pollute form-drift. **"Clear
  portal form" is sandbox-only** — it resets every control on the page, which
  on a live case would wipe a coordinator's real typing — and reports what it
  actually changed, so an already-empty form reads "nothing to clear" rather
  than a fake success. `renderSandboxBar` hides `#case-fill` wholesale (the
  same one-container rule as `renderModeSurfaces`); `#portal-status` sits
  OUTSIDE it, because a sandbox fill needs to know whether this page is a
  portal every bit as much as a real one does.
- **Sandbox state must be cleared on every REAL selection, not just Exit
  (review fix, 2026-08-20).** `sandboxActive` used to be flipped false ONLY by
  the Exit button, so picking a real case or provider while the sandbox was up
  left the sandbox bar showing (hiding the real Fill button) and let "Sandbox
  fill" run against whatever real, non-designated provider had since loaded —
  a fill with no case attribution and no `is_test_provider` check of its own.
  Fixed at BOTH layers, deliberately, since neither alone is enough: (1) the
  panel now clears `sandboxActive` inside `clearSandboxOnRealSelection`,
  called unconditionally from every funnel a real selection goes through
  (`applyCaseChoice`, `selectCaseInPanel`, `selectProviderInPanel`) plus
  org-switch and sign-out; `enterSandbox` sets `sandboxActive = true` only
  AFTER its own call into `selectProviderInPanel` resolves, so entering the
  sandbox doesn't immediately clobber itself. (2) the WORKER's `SANDBOX_FILL`
  handler (`src/background/index.ts`) re-checks the roster's own
  `is_test_provider` flag against the request's `providerId` before doing
  anything else — a stale panel is not the only caller that could send a real
  id, so the fill is refused server-of-truth-side regardless of what the panel
  believed. Pinned in `src/harness/workbench.test.ts` (a real, non-designated
  provider is refused before any tab message is sent; the designated sandbox
  provider still fills) against a new `FIXTURES.SANDBOX_PROVIDER_ID` roster row.
  **`CLEAR_PORTAL_FORM` carries the same guard** (`assertSandboxProvider`,
  shared with `SANDBOX_FILL`): its message widened to carry `providerId`, and
  the worker refuses to clear anything unless that id really is the
  designated sandbox provider — resetting every control on a REAL case's form
  would wipe a coordinator's live typing, the same blast radius as filling
  one with the wrong data. The message comment previously CLAIMED this guard
  existed when it did not (review nit); it now does.
- **A list read that renders must never trust an `ok` envelope's `data`.**
  `loadSharedRegistry` assigned `response.data` straight to the shared-portal
  rows, and `renderTrainPayers` iterates it DURING render — so a null `data`
  (a shape the wire permits) threw `for (… of null)` and took the WHOLE panel
  down, not just the payer select. Now coerced with `Array.isArray(…) ? … :
[]`, which degrades to an honest "no payers". Caught only by driving the
  built panel in a browser; no unit test would have seen it.
- **Scanner fixes shipped with it (2026-08-19), all three reproduced first.**
  (1) The no-id/no-name fallback selector `tag:nth-of-type(queryIndex)` mixed
  a document-wide query index with a sibling-scoped pseudo-class and resolved
  to ZERO elements — replaced by a real `:nth-child()` path anchored at the
  nearest id-bearing ancestor. (2) A radio group was named after whichever
  option came first; `radioGroupLabel` now prefers the group's QUESTION
  (fieldset legend / `[role=radiogroup]` aria) and the options keep their own
  text. (3) A control the form wires no label for captured nameless;
  `nearbyLabel` adopts a short preceding caption, never crossing into a
  sibling that owns its own control, and never past 120 chars (prose is not a
  label). Name-based selectors now carry the input TYPE too.
- **Capture is per PAGE (E6.9 F6.9.8 / BITE-CAP-05).** The side panel sends a
  collision-free `pageStep` candidate from `derivePageStep` (heading → URL
  tail → capture sequence); the background names the page AFTER the scan via
  `identifyCapturePage` (explicit next-page → URL/heading match → selector
  overlap ≥ 0.5 of the smaller set → else new page). `mergePageCapture` folds
  a scan into the session PER PAGE — a plain `diffCapture` would drop every
  other page's rows, so a trainer walking five pages would keep only the fifth.
  Rows carry DOM-order `sortOrder`.
- **Structured controls capture their option vocabulary (E6.10 F6.10.1).**
  `scanCapturableFields` records `{value,label}[]` for `<select>`, radio groups,
  and checkboxes with a meaningful `value` attribute. Placeholder empty-value
  options are omitted; a plain checkbox records an empty list. Capture still
  never reads `selected`, `checked`, or a typed value. The list rides
  `control_options` on `POST /api/shared-field-maps`. A vocabulary miss at fill
  time names the control type and a bounded sample of live DOM options; the
  selector-not-found reason (`field not found on this page`) is unchanged.
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
  or the manual picker; all funnel into the same active-case state. **The
  sandbox is the one deliberate exception (US-5, 2026-08-20)** and it does not
  weaken the rule it excepts: the rule exists so a fill is always attributable
  to a case, and a sandbox fill is attributable to NO case by construction —
  it writes no touch, moves no status, and logs through the `is_test`
  shared-test-fill route that carries neither a case nor a provider.
- **Write boundary (widened 2026-07-28, supersedes the E4.3 R6 read-only
  posture — panel-first coordinated change, both repos in one session):** the
  sanctioned writes are the manual touch POST (both kinds; a
  `portal_submission` may carry the opt-in `bump_status: true`, the ONE
  explicit status transition — In Progress → Submitted via the panel's
  `set_case_status`, evidenced by the touch; the outcome rides
  `meta.status_bump`, a skipped bump is reported, never silent), the
  user-scoped layout PUT, the PROPOSE-ONLY field-map POST (never an
  approval), the CAQH attestation POST
  (`/api/providers/:id/caqh-attestation`), and the US-5 sandbox's `is_test`
  shared-test-fill log (no case, no provider, excluded from form-drift).
  Still NO task-state writes, no mapping approvals, no auto-submit, no
  auto-touch, no IMPLICIT status change.
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
- **The app host is `https://mintedpanel.com`** (canonical; `www` redirects to
  it and is therefore never a page origin, so it is allowlisted nowhere). The
  `.vercel.app` deployment URL stays allowlisted for handoff/host access
  because Vercel keeps serving it and an old bookmark would otherwise fail
  silently — but `API_BASE_URL` points at the apex ONLY, since a redirect on
  the API host breaks CORS preflight on writes. The host lives in four
  non-interchangeable places (`config.ts`, `handoff.ts`, and two manifest
  keys); `docs/CHROME-WEB-STORE.md` has the table. `VITE_API_BASE_URL`
  retargets a build, but the MANIFEST cannot read env vars.

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
