# CLAUDE.md — Minted Panel Workbench (Chrome extension)

Current-state orientation for AI coding sessions. The README carries the full
architecture spec (locked, v1.2) and the fill-flow narrative — read it next.

The panel repo (`sonny303/mintedpanel`) is the **server side of every contract
here**; its `CLAUDE.md` ("Server API layer" + locked decisions) is the source
of truth for the wire shapes. Cross-repo work happens with **both repos
attached in one session**.

## What this is

MV3 Chrome extension that fills payer-portal enrollment forms with Minted Panel
provider data in one click, then logs the fill and the human's submission back
to the case. Credentialing coordinators otherwise retype the same provider
details into dozens of portals per provider; this removes that.

**Current release: v0.1.8** (October 14, 2026), built from `74b4d29` and uploaded to the Chrome Web Store as an unlisted extension (Extension ID `dppfnbikpojpgdiobckgcknmkjlfoinh`; the panel's `vercel.json` pins `VITE_MINTED_EXTENSION_ID` to it, so Work in portal launches only reach the Store install). The previous Store version was v0.1.3. Capture and fill reach **any DB-registered portal** — the panel
requests the registry's origins on demand and the worker injects `content.js`
where there's no static match.

## Architecture — three locked rules

1. **Never queries Supabase tables; never holds the service key.** Supabase
   auth only mints a JWT (anon key + email/password). ALL data flows through
   the panel API at `https://mintedpanel.vercel.app` (`src/shared/config.ts`).
2. **The background service worker owns every API call.** The side panel
   (`src/sidepanel/main.ts`, vanilla TS, no framework) is UI-only and talks to
   the worker over `chrome.runtime` messaging (`src/shared/messages.ts` — typed
   `BgRequest`/response union). It never holds tokens. The content script
   (`src/content/`, IIFE build) receives resolved values, applies them
   (`fillEngine.ts`, native setters + `input`/`change` events), and reports
   results; **the worker refuses messages from tabs.**
3. **Session lives in `chrome.storage.session`** (dies with the browser). MV3
   workers restart constantly: `getSession()` refreshes on demand and the API
   layer retries a 401 once after a forced refresh.

An eslint rule enforces the boundary: **only `src/background/` may import
`@supabase/supabase-js`.** Keep that and the no-tokens-in-messages rule intact.

Layout: `src/background/` (`api.ts` fetch layer, `auth.ts`, `fill.ts`,
`mockFill.ts`, `orgState.ts`, `mode.ts`, `activeCase.ts`, `inject.ts`,
`index.ts` message router) · `src/sidepanel/` · `src/content/` ·
`src/shared/` (types + pure logic) · `src/harness/`.

Builds: `vite.config.ts` (panel + background) and `vite.content.config.ts`
(content script — content scripts can't be ESM). `npm run watch` rebuilds all
three into one `dist/`; the main config's `emptyOutDir` means every main
rebuild must re-emit `content.js`.

## Commands

`npm run build` (panel+background, then content — `dist/` is the loadable
unpacked extension) · `typecheck` · `lint` · `test` (vitest) · `watch`.

Guarded releases use `build:staging` or `build:production` with an explicit
three-value public configuration file. Both run the complete two-pass build into
separate `release-artifacts/<target>/extension` directories and verify target
origins and package integrity. Staging is loaded locally and tested manually;
production uses a separate restricted Store process. `check:store` validates
local release prerequisites and does not submit or publish a package. Follow
[`docs/release/README.md`](docs/release/README.md); the legacy `dist/` build is
not the staging installation target.

Chrome Web Store packaging runs via `./scripts/package-extension.sh` (or `npm test && ./scripts/package-extension.sh`), which builds the extension and bundles a clean root-level zip archive (`minted-panel-workbench-v<version>.zip`) stripped of macOS metadata (`__MACOSX`, `.DS_Store`). Automated contract validation runs via `scripts/release/contract.test.mjs`.

`npm run build:probe` builds `dist-probe/capture-probe.js` — `scanCapturableFields`
wrapped as a standalone IIFE (`src/probe/captureProbe.ts`) that Claude injects into
a payer form from a browser tool. Never part of the extension package.

`src/harness/workbench.test.ts` drives the **real background modules** against
`scripts/mock-panel-api.mjs`, an in-repo mirror of the panel /api contract — so
CI never touches a real portal or the real panel. Add harness coverage for any
new worker behavior that has a wire side.

## Locked wire contracts

Local mirror of all response/body types: `src/shared/apiTypes.ts`.
**Never change one unilaterally** — a one-sided edit breaks the fill or the
close-out loop silently.

- **Envelope:** `{ data, error, meta }`; list meta `{ total, page, pageSize }`;
  `meta.notes` advisory. Rows come back camelCased.
- **Auth/org headers:** `Authorization: Bearer <jwt>` on every call. A
  single-org user sends **no** `x-org-id`; a multi-org user **must** send it on
  every org-scoped call — the server 400s a multi-org caller without it, never
  guesses. The org header is keyed **by MODE, not by path**
  (`shouldSendOrgHeader`, `src/shared/panelMode.ts`): training sends none even
  for a multi-org user, because the org-resolving guard would 400 it and an org
  header would scope a shared-tier capture to one tenant.
- **Bare token keys:** the canonical form is `family.field` in camelCase
  (`provider.firstName`). The **server** normalizes braced `{{token}}` forms at
  its read boundary, so the field-map → profile-token join here is a literal
  string match. **The extension never strips braces.**
- **Profile:** `GET /api/providers/:id/profile?state=&facilityId=` →
  `provider` + `tokens[{token,value}]` + `unresolved[{token,reason}]` +
  `facilities` + `selected_facility_id`; ambiguous facility sets flag
  `meta.needs_facility`. Those two snake_case keys are the locked contract,
  unlike the camelCased rows.
- **Touches body is snake_case** (locked) — `POST /api/cases/:id/touches` takes
  `{ kind: "portal_submission", portal_key, idempotency_id, fill_session_id?,
note?, payer_reference_id?, wip_note?, task_id?, pdf_filename?,
bump_status? }`. Server sets org + user from the JWT.
- **`bump_status: true`** asks the panel to REPORT the status move; it does
  not cause it. The panel's DB trigger moves a Not Started or In Progress case
  to Submitted on every extension submission touch, whether or not the flag
  is sent. The extension sends it on every submission log (legacy and typed
  Work paths) and says so before the click: the log form shows "Logging moves
  this case to Submitted." when the case is Not Started or In Progress
  (`logMovesToSubmitted`, `src/shared/closeOut.ts`), so the change is never
  implicit. The outcome rides `meta.status_bump` (`applied`|`skipped` +
  reason), **never the touch** — a rejected transition is not a failed touch.
- **Structured touch:** same route, `kind: "structured_touch"` — `touch_type`
  required (one of seven canonical types); the portal_submission-only fields
  are a loud 422 on this kind. Sets mirrored in `src/shared/structuredTouch.ts`.
- **Fill-events body is camelCase** — `{ id, caseId, providerId, portalKey,
fillMode, startedAt, completedAt, fieldsFilled, fieldsSkipped }`.
- **Idempotency:** fill-events — the client-generated `id` is both idempotency
  key and row PK. Touches — `idempotency_id` becomes the anchor touch's PK; the
  worker reuses it on retries, and a replay short-circuits at the anchor
  re-running **no** side effects (no second note/task/system_event).
- **Field maps:** shared catalog; `orgId: null` = global portal truths, org rows
  = overrides. **ONLY `approved` maps fill** — a proposed row is an unreviewed
  observation awaiting the panel trainer; it counts as a coverage gap, never a
  fill. `POST /api/portal-field-maps` is **propose-only** (server forces
  `proposed`/`manual`/`token null` under the caller's org, whatever the body
  says); idempotent on `(portal_key, selector)`.
- **Shared (org-free) training tier:** `GET /api/shared-portals`,
  `GET/POST /api/shared-field-maps?portal_key=`, `POST /api/shared-portals/prove`,
  `POST /api/shared-test-fills` — all on the panel's **user-scoped** guard.
  Propose is idempotent on `(portal_key, selector)`: a re-capture returns the
  existing row **with its decision untouched**, which is what makes re-capture
  drift repair rather than a reset.
- **`SET_ACTIVE_CASE` handoff:** the webapp sends
  `{ type, caseId, providerId, orgId, portalUrl, portalKey?, facilityId? }`
  through `externally_connectable` — **identifiers + URL only, never a profile
  or token value.** `parseSetActiveCase` (`src/shared/handoff.ts`) strict-parses
  and drops unknown fields; the two optional extras are dropped rather than
  failing the handoff (losing a location costs a picker prompt; rejecting the
  message costs the launch).
- **Case context:** `GET /api/cases/:id/context` → `referenceNumbers`,
  `payerPipelineState`, `provider`/`payer`, `state`, `selectedFacility`,
  `facilities` (E1.4 — the case's FULL location set, primary row first then
  alphabetical, `isPrimary` badged per row), `openTasks` (with
  `executionType` — `extension_fill` tasks are the fillable ones),
  `latestNote`, `latestTouch`. Typed **optional** here so a panel that
  predates a key degrades to hidden rows; `facilities` degrading to
  `undefined` falls back to `selectedFacility`-only behavior exactly like an
  older panel. `selectedFacility` is UNCHANGED and still means "the primary"
  — `facilities` is additive.
- **Case/provider search:** `GET /api/cases?q=` → `CaseSearchRow`s (ids +
  display fields only); `GET /api/providers?search=` is the provider half.
- **`portalTasks`** on `GET /api/cases?providerId=` — the case's open,
  portal-linked SOP tasks; `portalKey` arrives normalized. Match the page's
  portal_key against these and pass the matched `task_id` on the submission
  touch. **Never invent a task.**
- **Provider groups on the list row:** `/api/providers` rows carry
  `groups: [{id,name,isPrimary}]` (current memberships, primary first). The
  grain is M:N, so `groupId` — the frozen primary mirror — could never answer
  "which Taylor Example is this?". **Optional both ways:** an older panel sends no
  key and `providerGroupsLabel` renders nothing rather than claiming the
  provider has no group.
- **View prefs:** `GET /api/me/view-prefs` (user-scoped) → `{ fields, catalog }`
  — the saved layout plus the **schema-derived** selectable-field catalog. The
  picker renders from the served catalog; there is **no local mirror**
  (`src/shared/quickCards.ts` holds only the default layout and projection
  helpers). PUT validates against the same derived set; no length cap.
  `resolveLayout` degrades an invalid stored layout to the default — but
  validates keys against the served set **only when the catalog read
  succeeded**, so a failed read never wipes a saved layout.

## Locked product rules

- **The extension never submits portal forms. Unchanged, forever.** The human
  submits; the extension logs.
- **Write boundary** — the only sanctioned writes: the manual touch POST (both
  kinds, incl. `bump_status`), the user-scoped layout PUT, the
  propose-only field-map POST (**never an approval**), the CAQH attestation
  POST, and the sandbox's `is_test` shared-test-fill log. The panel ticks no
  SOP steps (step ticking was removed in 0.1.8; `COMPLETE_TASK_STEP` and
  `PATCH /api/tasks/:id/steps` remain, uncalled). No mapping approvals, no
  auto-submit, no auto-touch, no implicit status change.
- **Case selection is required before a fill, with two exceptions that attach
  to no case by construction: the sandbox test profile, and an ad hoc fill
  ("No case · Ad hoc fill") on a regular form.** (PM, Oct 14.) Cases arrive via
  the handoff, unified search, active-cases list, NBA handback, or manual
  picker; all funnel into one active-case state. Neither exception writes a
  touch or moves a status. A sandbox fill logs through a route carrying
  neither case nor provider; an ad hoc fill saves its fill record under the
  provider (it needs a group and a location, and the worker refuses it while
  a launched or picked case is active). Case-only (Work-only) forms are never
  filled ad hoc: the panel's registry hides them from manual mode, and
  coordinators launch them from the case (a workflow rule, not a 0.1.8
  feature).
- **A case can have several locations; a fill still targets exactly ONE.**
  (E1.5) When `context.facilities` (the case's full location set) has more
  than one entry, the Workbench lists every location beside the picker —
  name + address, primary badged — but `#facility-select` stays the single
  fill-target control, now scoped to the CASE's own locations
  (`facilityPickerScope`, `src/shared/caseContext.ts`) rather than the
  provider's entire assigned set, falling back to that full set when the
  case carries no locations (most cases today — `case_facilities` is
  additive, so a case nobody has added a second location to has zero rows
  despite a perfectly good primary). Exactly one `facilityId` still rides
  the FILL request, and the extension still never submits a form.
- **Never fill from expired context.** The active-case record expires on
  bound-tab close or 60 min idle; the panel closes the gate **and** the worker
  refuses the FILL. Expiry/absence/mismatch are explicit UX states, never silent.
- **A Work launch stays linked through a tab switch and through pages on the
  payer's own site in the launched tab** (PM, Q3 answer B). Fill runs only on
  the form's own pages in the launched tab (`requireActiveWorkForTab` refuses
  elsewhere without ending the link); closing the tab, leaving the payer's
  origin, or 60 minutes idle end it (`onActiveWorkTabUpdated`,
  `reconcileActiveWorkTab`). This is what lets the payer's confirmation page
  log the submission. Reads that write nothing to a page (the profile behind
  the picker and Provider details, `GET_PROVIDER_FACILITIES`) follow the live
  record from any tab (`revalidateActiveWork(..., { requireBoundFormPage:
  false })`).
- **A launch follows its own auto-start bump, by inference from two panel
  facts.** The panel's first recorded typed fill on a Not Started case moves
  it to In Progress, which bumps `context_version` N to N+1, and the panel
  refuses a later fill or no-fill log still stamped N. The worker records
  `{ launchReceiptId, contextVersion, caseStatus }` from a case-context read of
  the launched case at the tuple's own version
  (`minted.activeWork.v2.caseObservation`; ids and the status word only).
  Before a Work fill it reads the case once itself if nothing was observed at
  that version (`ensureLaunchedCaseObserved`), since the panel caches context
  per case and may never re-read it under a new launch. When a fill is
  recorded at N and the observation says `not_started` at N, the tuple moves
  to N+1 by compare-and-set (`advanceActiveWorkContextVersion`); launch
  identity (receipt, bound tab) is unchanged, so the panel doesn't reload.
  `CaseContext.caseStatus` / `contextVersion` are optional in `apiTypes.ts`.
- **Tokens never touch page context.** Field values never persist in
  `chrome.storage` (fill reports store labels/counts/reasons only; the
  active-case record stores identifiers + URL only). Quick-card values (incl.
  DOB) are in-memory only — cleared on org/case change, sign-out, tab close,
  expiry.
- **Portal access is dynamic.** `optional_host_permissions:
["https://*/*"]` lets the panel _request_ origins, but it only ever requests
  the specific origins the registry names (`portalOriginPatterns`) — never
  `https://*/*` itself. `ensureContentScript` (`src/background/inject.ts`)
  injects **per frame** (falling back to `allFrames`) when there's no static
  match, so Availity-style shells whose form lives in a child iframe still get
  a content script. Capture/fill/match fan out across frames via
  `webNavigation.getAllFrames` (`src/background/frameMessaging.ts`); frame IDs
  are never persisted on field maps. Permission/manifest changes require
  reloading the unpacked extension.
- **Open shadow DOM is pierced.** Capture, fill, clear, picker, and the
  Selector Workshop walk open `#shadow-root` trees (`src/content/deepDom.ts`)
  and climb hosts for labels/hidden checks — required for LitElement /
  Litehouse portals (e.g. BCBSNC). Closed shadow roots remain unreachable.
  Fill events use `{ bubbles: true, composed: true }` so listeners outside the
  shadow hear the change.
- **The `portals` registry is a DEPLOY PREREQUISITE.** Recognition is
  `matchPortalByUrl(url, rowsFromGetApiPortals)`; over an empty table that
  returns null for every page, which is indistinguishable from "not a portal" —
  Fill disabled, capture hidden, and the panel telling you to open the form you
  are already looking at.
- **`API_CORS_ORIGINS`** on the panel's Vercel project must include
  `chrome-extension://<id>` (owner-managed; the id changes when the unpacked
  path changes or on packing). The handoff needs no CORS — it rides
  `externally_connectable`, allowlisted in the manifest **and** re-checked in
  the worker.
- The service-role key must never appear here. The committed
  `SUPABASE_ANON_KEY` / `API_BASE_URL` in `src/shared/config.ts` are public by
  design; optional `VITE_*` overrides retarget a build without editing source.

## Work cases layout (0.1.8)

Three collapsible sections, open state remembered per viewer in localStorage
(booleans only): the **task card**, **Provider details** (layout gear, served
picker and saved per-user layout unchanged), and **Log a call, email, or
note**. `renderTaskCard()` is the one renderer for the task card and runs
after every state change (`updateFillReady` calls it); it opens the card on
its own when the coordinator needs to act or read a result
(`taskCardNeedsAttention`).

- **Current task only.** No other open tasks and no step checkboxes. The
  card names the launched task (or the one task on the case that uses this
  form), shows one state pill (`taskCardPill`), the site access ask in Fill's
  spot, the fill result, Log it, the log form, the after-log card with Up
  next, and case details (status, payer reference, last touch, last note).
- **Log it works with or without a fill** (B2). Typed Work takes its exact
  case, task and step from the saved fill report, or from the live launch
  record when there was no fill; the worker names a fill only when Minted
  Panel holds its record (`summary.eventRecorded`), because the panel 404s an
  unknown fill id. When the panel sends no fill id (it lets go of its fill
  result on a page change), the worker recovers this launch's recorded,
  unlogged fill from its own report (`recoverLaunchFillSessionId`) before
  falling back to the launch record. Idempotency ids are keyed by fill, or by
  launch (`launch.<receipt>`) for a Work log with no fill, so a relaunch is a
  fresh attempt. A no-fill log releases its id after success, and any log
  releases it on a definite 4xx refusal (not 408/429); network errors and 5xx
  keep it so a retry replays the same id.
- **The log belongs to the case plus its launch** (`logScopeKey`,
  `${caseId}|${launchReceiptId ?? "manual"}`). A page change or tab switch
  inside that scope keeps the open form, its entries, a failed log and the
  done card; a different case or a new launch starts fresh. On another tab
  the whole form is held and the notice says to switch tabs to log it.
- **No Checklist task picker.** The plan line above Log submission states
  what logging will do (`submissionPlanLine`); a manual log closes a task
  only when it is the one task on this form and nothing else on it is open
  (`manualTaskToClose`).
- **Errors** carry Copy support code (`supportCode`: version, short case and
  fill ids, time, code; no names, no values). A failed log offers Try again
  only when the request never landed: a 5xx, or no code with an empty or
  network-looking message (`logFailureView`). The worker's own 409s ("may
  already be recorded", "launch ended") show their own text. After any other
  refusal, Work offers no re-log (the same launch repeats the same answer,
  PM E10); manual mode offers "Log it again" after the result, with the
  entries kept, because a manual log picks its task again.
- **Admin Details** (fields written, fill record, form key and mapping, work
  context, every skip, Fix mapping) shows for admins of the CURRENT org only
  (`isCurrentOrgAdmin`), not `canTrainForms` (admin in any org). The
  Needs-you list (missing data, uploads, by-hand fields) stays for everyone.
- **AI is off** (`AI_FILL_ENABLED = false`, `src/shared/config.ts`): no model
  check, no page scan, no review card. The code is kept for a designed return.
- The A6 org-switch prompt renders into `#org-switch` above the org picker,
  never inside `#case-work`; so does a launch notice (A7) while no org has
  resolved.
- **Why a link ended (D5).** The worker's block record carries a value-free
  `reason` (`tab_closed` | `left_site` | `expired` | `ended`) plus the ended
  launch's `ownerKind`/`ownerId`, surfaced on the `blocked` variant of
  `ActiveWorkState` (worker↔panel only, not an /api contract). Copy and the
  "Back to case" rule live in `src/shared/workLinkNotice.ts`. A new launch
  replacing the one on screen shows a one-time notice (D6,
  `isLaunchReplacement`). Known blip: the 30 s poll can land inside a new
  launch's validation and show the generic "link ended" line for a moment.
- **A dead session drops to sign-in (A4).** Every panel request goes through
  a local `sendToBackground` wrapper; a 401 resets the panel session (worker
  state is kept) and shows sign-in with "Your sign-in expired. Sign in again.
  The case stays linked." when a case or launch is linked.

## Panel modes — three jobs, one panel

After sign-in the panel asks which job is being done: **Search**, **Work
cases**, or **Train forms**.

- The mode lives in the **worker** (`src/background/mode.ts`,
  `chrome.storage.session`) because it decides whether a call carries
  `x-org-id`; the panel mirrors it.
- **Training shows a payer select → form find/select → capture and nothing
  else** — no org, provider, or case picker, no quick cards, no touch logging.
  A trained form has no org and exists before any case for that payer does.
- **Train forms is ADMIN-only** — `canTrainForms(memberships)` = admin in any
  org. It's an **affordance, not the wall**: the shared-tier routes accept any
  authenticated caller today (panel-side TD-42). `fallbackModeFor` moves a user
  whose role changed off a job they may no longer do (worker-side too). Roles
  are only known once `/api/me/orgs` lands, so the button **holds its state**
  until then rather than flashing away and back; TRAIN mode boots that read on
  its own.
- A `SET_ACTIVE_CASE` handoff **forces** the mode to `case` on receipt — the
  chooser never stands between the webapp's launch and the case it launched.
  A `SET_ACTIVE_WORK` launch does the same once it parses, BEFORE it
  validates: `validateWorkContext` only sends in case mode, so a launch from
  Search or Train would otherwise fail in the worker as `CONTEXT_STALE`.
- **Search replaced the browse-providers dropdown** (a dropdown couldn't show
  which group a provider belongs to, so same-named providers were
  indistinguishable). Rows name the group via `providerGroupsLabel`;
  `providerMatchesQuery` folds in roster rows the server's search can't reach.

### `renderModeSurfaces` is the ONE place that decides what's on screen

From `(mode, orgReady)` it toggles four top-level containers — `#train-section`,
`#org-field`, `#search-section`, `#case-work` — and **never the individual
cards inside `#case-work`**: those manage their own `hidden` as data arrives, so
reaching in would either reveal an empty card or clobber state it didn't set.
`src/sidepanel/panelMarkup.test.ts` pins the markup contract (every `el()` id
resolves, no duplicate ids, every case-work surface really is inside
`#case-work`) — `main.ts` throws at import on a missing id, which means a blank
panel, and nothing else would catch it.

## Capture and the field trainer

- **Capture is per PAGE.** The panel sends a collision-free `pageStep`
  candidate; the background names the page **after** the scan via
  `identifyCapturePage` (explicit next-page → URL/heading match → selector
  overlap ≥ 0.5 of the smaller set → else new page). `mergePageCapture` folds a
  scan in **per page** — a plain diff would drop every other page's rows, so a
  trainer walking five pages would keep only the fifth.
- **Fill matches exact URL-pages (DYN-PAGE-01).** Every instruction carries
  `pageStep`. When the open URL's last path segment equals a trained
  non-`Page N` page, maps for other exact pages skip with
  `kind: "other_page"` / reason `"field belongs to another page"` (panel
  DYN-PAGE-00 pin) and are not written. Ambiguous identity (`Page N`, null,
  unknown URL) keeps ordinary `"field not found on this page"`. Logging
  preserves producer kinds — it no longer overwrites every content skip to
  `"skipped"`.
- **The fill never writes a hidden control (DYN-PAGE-02).** A wizard keeps its
  inactive steps in the DOM, so a selector can resolve perfectly and still
  point somewhere the coordinator cannot see. `applyValue` guards on
  `isHiddenControl` (`src/content/captureScan.ts`) and reports
  `kind: "hidden"` / reason `"field is hidden on this page"` (panel
  DYN-PAGE-02a pin). **A radio group guards the option about to be CLICKED,
  not the one the selector resolved to** — they are often different elements,
  and guarding the resolved one would skip a visible answer.
  `isHiddenControl` is the shared **positive-hiding** half of the capture rule
  (`hidden` / `aria-hidden` / `display:none` / `visibility:hidden` on self or
  an ancestor). The scanner's extra zero-box check is deliberately NOT applied
  to the fill: a zero-size control is list noise for a trainer but a real field
  a coordinator is waiting on. **Exception in the scanner:** a zero-size
  radio/checkbox with a visible `<label>` is a page-drawn control (Qualtrics,
  custom-control CSS) and IS captured, ordered by its label's box. Labels are
  read from every `label[for]` (first with text) and skip embedded widgets
  (Qualtrics puts its date picker's calendar table inside the label).
  Clipped/off-screen panels are out of scope.
- **The three fill-skip reasons are disjoint, and the panel owns the wording.**
  `field not found on this page` (drift), `field belongs to another page`, and
  `field is hidden on this page`. **Only the first is drift** — the other two
  resolved a selector. Add a fourth panel-first, in `src/lib/formDrift.ts`, and
  join it to `isNoEvidenceSkip` there or it silently dates a mapping's last
  success to a fill that never touched the field.
- **Capture is shape-only, never values** — labels, selectors, control types,
  and option vocabularies. Option lists are capped at 50 by default
  (`CONTROL_OPTIONS_CAP`, `captureScan.ts`) because the panel's write boundary
  rejects longer lists; that truncates real dropdowns (US states, BlueKC's 146
  specialties). Only the capture probe, which never proposes, scans uncapped
  (`scanCapturableFields({ optionsCap: Infinity })`). Structured controls record `{value,label}[]` for
  `<select>`, radio groups, and valued checkboxes; `selected`/`checked`/typed
  values are never read. Empty option lists are ignored on re-capture.
- **Manual field mapping exists because a scan only sees what is rendered AND
  wired at that moment.** A field a portal reveals after an earlier answer is
  legitimately missed. `+ Add field` enters pick mode
  (`src/content/elementPicker.ts`): every listener is **capture-phase and
  swallows its event**, so picking a radio doesn't also select it and picking
  near a submit can't navigate the form away mid-training. The pick runs
  through the **same `describeControl` the scanner uses**, so hand-picked and
  auto-detected rows can never drift apart.
- **`displayLabel` (the trainer's name) is kept separate from `label` (the
  payer's captured text)** — exactly as the panel splits `display_label` from
  `field_label`. A re-scan refreshes what the portal says without discarding
  what the human called it. `SEND_CAPTURE` proposes the payer's text, falling
  back to the trainer's name only when the portal never labelled the field.
- **`mergePageCapture` rescues `user_mapped` and `selectorOverridden` rows a
  fresh scan can't see** — those are precisely the conditionally-rendered
  fields and hand-fixed selectors the picker exists for, and dropping them on
  the next re-capture would silently delete the manual work. An
  `auto_detected` row the scan no longer sees is still dropped, so drift repair
  is unchanged.
- **The selector IS the row's key.** `applyRowEdit` (`shared/capture.ts`)
  refuses a rewrite that collides with another row, and lives beside
  `mergePageCapture` because they guard the same invariant.

### Selector Workshop

**"Test selector" tests what is TYPED, not what is stored** — otherwise it
could only ever confirm the selector you're trying to replace.

The verdict reads the match **shape**, not a count
(`describeSelectorMatches` → `{valid, matches, fillable, radioGroup}` → the
pure `selectorVerdict`). A bare `querySelectorAll().length` got three common
cases backwards, each measured against the real engine:

- a **wrapper** (`#npi-field` on the div around the input) matched exactly one
  element and showed green, while the fill skipped it as "field not found";
- a **radio group** is one field made of N controls, so a correct selector read
  as "ambiguous, may fill the wrong one" — a false alarm on the exact defect
  class the trainer exists for, whose advice breaks a working selector;
- **invalid CSS** was reported as 0 matches, i.e. as a valid selector finding
  nothing, sending the trainer to re-capture over a typo.

`fillable` is a **copy** of the engine's rule, so `fillEngine.test.ts` pins the
two together over six element shapes rather than trusting a comment.

`highlightSelector` flashes every match in green via a **class**, never inline
styles (inline would overwrite the portal's own and couldn't be cleanly
undone). XPath is deliberately not offered yet.

`label:` selectors resolve the way the fill does — `byLabel` is exported from
`fillEngine.ts` and used by the workshop, because the shared library really
stores maps as `label:First Name`, which is not parseable CSS.

### Drifted library rows are actionable

"In the library but not on this page" IS the _needs updating_ half of the job.
**"Check page"** re-tests the library's own selector live, because "not found"
is a fact about the _scan_, not the page. **"Re-point"** proposes at the new
selector carrying the library's own name — the old map stays until someone
retires it in the web app, and the status line says exactly that instead of
implying the library was edited.

A sent capture links to where mapping actually happens:
`/admin/payer-admin/setup/{payerId}?tab=templates` (`MatchedPortal.payerId`).
Null payer ⇒ text only, never a dead link.

## Sandbox test profile

A normal fill needs a case, and the panel's 4-part case key means one case per
provider × group × payer × state — so testing a 100-field form meant
manufacturing cases and leaving junk behind. The sandbox fills from the org's
**designated test provider** (`providers.is_test_provider`, which the panel
already excludes from queue/generation/scorecard) with **no case in play**.

Not a synthetic identity — filling as a real provider is what exercises the
true profile pipeline. State comes from the provider's home state; null is a
legitimate answer.

**Test mode copy (G1 to G5)** lives in `src/shared/sandbox.ts`: the Search
row reads "Test profile: {name}", results use the real fill's notice look
(`sandboxFillView`, `sandboxClearView`), and the count is `fieldsAttempted -
fieldsRejected` (a test fill's `filled` counts read-back values, which v2 runs
never report). A result is cleared when the page changes.

**Guarded at BOTH layers, deliberately — neither alone is enough:**

1. The panel clears `sandboxActive` in `clearSandboxOnRealSelection`, called
   unconditionally from every funnel a real selection goes through, plus
   org-switch and sign-out. (`enterSandbox` sets the flag only _after_ its own
   `selectProviderInPanel` resolves, so entering doesn't clobber itself.)
2. The worker's `SANDBOX_FILL` and `CLEAR_PORTAL_FORM` handlers re-check the
   roster's own `is_test_provider` flag (`assertSandboxProvider`) — a stale
   panel is not the only caller that could send a real id.

**"Clear portal form" is sandbox-only** — it resets every control on the page,
which on a live case would wipe a coordinator's real typing — and reports what
it actually changed, so an already-empty form reads "nothing to clear" rather
than a fake success.

## Gotchas

- **A list read that renders must never trust an `ok` envelope's `data`.** A
  null `data` is a shape the wire permits; `for (… of null)` during render
  takes the **whole panel** down, not just one control. Coerce with
  `Array.isArray(…) ? … : []`. Only caught by driving the built panel in a
  browser — no unit test sees it.
- **Scanner selector fallbacks:** the no-id/no-name path anchors a real
  `:nth-child()` chain at the nearest id-bearing ancestor. (Mixing a
  document-wide query index with a sibling-scoped pseudo-class resolved to zero
  elements.) Name-based selectors carry the input **type** too.
- **Radio group labels** prefer the group's _question_ (fieldset legend /
  `[role=radiogroup]` aria); options keep their own text.
- **`nearbyLabel`** adopts a short preceding caption for a control the form
  wires no label for — never crossing into a sibling that owns its own control,
  and never past 120 chars (prose is not a label).
- **CAQH attestation date comes from the ROSTER ROW**
  (`caqhLastAttestedDate`), never a panel-local variable — a local one read
  "Never attested" for everyone and outlived a provider switch.
- **The CAQH exception strip is UNFINISHED** — `findCaqhGaps`,
  `PULL_CAQH_FIELD` and the rendering exist, but nothing populates
  `caqhGapRows`, because doing so means reading **values** off the CAQH page and
  capture is deliberately shape-only. Documented in-code as a known gap.
- **`PICK_ELEMENT` is the one async `ContentRequest`** (its listener returns
  true). `MATCH_SELECTOR` backs "Re-test on page".

## Skills reference

Recipes live in `.claude/skills/` rather than here — this file stays facts,
they carry procedure:

- **`publish-update-to-chrome-store`** — repeatable packaging, verification, and Chrome Web Store upload procedure for the published extension ID `dppfnbikpojpgdiobckgcknmkjlfoinh`.
- **`chrome-extension-minted`** — MV3 architecture, worker/side-panel/content
  messaging, the write boundary, and the common MV3 bugs.
- **`chrome-devtools-minted`** — DevTools debugging: form state, `/api`
  requests, both extension consoles, slow renders.
- **`adhd`** — output shaping for the human reading the session.
- **`payer-form-capture`** (+ agent `form-scraper`) — Claude walks a payer form
  in the user's own signed-in browser, scans it shape-only with the probe, and
  writes `form-captures/<portalKey>.capture.json`: a valid `CaptureSession`
  carrying token *suggestions* only (`chosenToken` null, nothing sent), plus
  per-page fingerprint, labeled navigation, gates and branch — the data a
  future automated walk needs, with readiness the test recomputes. Nothing
  automates Next today. `src/probe/formCaptures.test.ts` holds every capture
  file to that contract.

The panel repo (`sonny303/mintedpanel`) carries the same three plus
`supabase-migrations`, `api-isolation-gate`, `e2e-harness`, and
`minted-m3-audit`; attach both repos for cross-repo work.

## Scheduled backups (GCS)

Nightly scheduled backup workflow (`.github/workflows/scheduled-backup.yml`) runs daily at 04:15 UTC (staggered after `mintedpanel`). Creates full git bundles (`git bundle create --all`) and SHA-256 manifests, uploaded to Google Cloud Storage via Workload Identity Federation (`GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`) with 7-day fallback GitHub artifact retention.

## Keep this file honest

At the end of a session that changes this repo: update what went stale (new
messages, new contract fields, new modes, retired paths), mirror any panel-side
contract change in `src/shared/apiTypes.ts`, and **write current state, not
history** — if a section reads like a changelog entry, rewrite it as a fact.
If nothing changed structurally, leave it alone.
