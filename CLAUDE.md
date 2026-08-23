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

v0 is unlisted (loaded unpacked). The manifest ships static access to BCBS
Kansas, but capture and fill reach **any DB-registered portal** — the panel
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
- **`bump_status: true`** additionally moves In Progress → Submitted, evidenced
  by that touch. Off by default and omitted unless asked, so "never an
  *implicit* status change" still holds. The outcome rides `meta.status_bump`
  (`applied`|`skipped` + reason), **never the touch** — a rejected transition
  is not a failed touch.
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
  `openTasks` (with `executionType` — `extension_fill` tasks are the fillable
  ones), `latestNote`, `latestTouch`. Typed **optional** here so a panel that
  predates a key degrades to hidden rows.
- **Case/provider search:** `GET /api/cases?q=` → `CaseSearchRow`s (ids +
  display fields only); `GET /api/providers?search=` is the provider half.
- **`portalTasks`** on `GET /api/cases?providerId=` — the case's open,
  portal-linked SOP tasks; `portalKey` arrives normalized. Match the page's
  portal_key against these and pass the matched `task_id` on the submission
  touch. **Never invent a task.**
- **Provider groups on the list row:** `/api/providers` rows carry
  `groups: [{id,name,isPrimary}]` (current memberships, primary first). The
  grain is M:N, so `groupId` — the frozen primary mirror — could never answer
  "which Addie Jones is this?". **Optional both ways:** an older panel sends no
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
  kinds, incl. the opt-in `bump_status`), the user-scoped layout PUT, the
  propose-only field-map POST (**never an approval**), the CAQH attestation
  POST, and the sandbox's `is_test` shared-test-fill log. Still **no**
  task-state writes beyond `PATCH /api/tasks/:id/steps`, no mapping approvals,
  no auto-submit, no auto-touch, no implicit status change.
- **Case selection is required before fill** — via the handoff, unified search,
  active-cases list, NBA handback, or manual picker; all funnel into one
  active-case state. **The sandbox is the one exception** and does not weaken
  the rule: a sandbox fill is attributable to no case *by construction* — it
  writes no touch, moves no status, and logs through a route carrying neither
  case nor provider.
- **Never fill from expired context.** The active-case record expires on
  bound-tab close or 60 min idle; the panel closes the gate **and** the worker
  refuses the FILL. Expiry/absence/mismatch are explicit UX states, never silent.
- **Tokens never touch page context.** Field values never persist in
  `chrome.storage` (fill reports store labels/counts/reasons only; the
  active-case record stores identifiers + URL only). Quick-card values (incl.
  DOB) are in-memory only — cleared on org/case change, sign-out, tab close,
  expiry.
- **Portal access is dynamic, not BCBS-only.** `optional_host_permissions:
  ["https://*/*"]` lets the panel *request* origins, but it only ever requests
  the specific origins the registry names (`portalOriginPatterns`) — never
  `https://*/*` itself. `ensureContentScript` (`src/background/inject.ts`)
  injects on demand when there's no static match. Permission/manifest changes
  require reloading the unpacked extension.
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
- **Capture is shape-only, never values** — labels, selectors, control types,
  and option vocabularies. Structured controls record `{value,label}[]` for
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

"In the library but not on this page" IS the *needs updating* half of the job.
**"Check page"** re-tests the library's own selector live, because "not found"
is a fact about the *scan*, not the page. **"Re-point"** proposes at the new
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

**Guarded at BOTH layers, deliberately — neither alone is enough:**

1. The panel clears `sandboxActive` in `clearSandboxOnRealSelection`, called
   unconditionally from every funnel a real selection goes through, plus
   org-switch and sign-out. (`enterSandbox` sets the flag only *after* its own
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
- **Radio group labels** prefer the group's *question* (fieldset legend /
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

## Keep this file honest

At the end of a session that changes this repo: update what went stale (new
messages, new contract fields, new modes, retired paths), mirror any panel-side
contract change in `src/shared/apiTypes.ts`, and **write current state, not
history** — if a section reads like a changelog entry, rewrite it as a fact.
If nothing changed structurally, leave it alone.
