# Minted Panel Workbench — Chrome extension

Fills payer portal enrollment forms with Minted Panel provider data in one
click. v0 is unlisted (loaded unpacked); the first target portal is the BCBS
Kansas network enrollment form.

## Architecture (locked, spec v1.2)

Three rules everything else follows from:

1. **The extension never queries Supabase tables and never holds the service
   key.** Supabase auth is used only to mint a JWT (anon key + email/password
   sign-in). All data flows through the Minted Panel server API at
   `https://mintedpanel.vercel.app` with `Authorization: Bearer <jwt>`.
2. **The background service worker owns every API call.** The workbench UI —
   a Chrome side panel, opened by clicking the toolbar icon — is UI only and
   talks to the worker over `chrome.runtime` messaging; it never holds
   tokens. The content script receives resolved fill values via messaging,
   applies them to the page, and reports results — tokens never touch page
   context, and the worker refuses messages that originate from a tab.
3. **Session lives in `chrome.storage.session`** (in-memory, gone when the
   browser exits) with supabase-js handling refresh. MV3 workers restart
   constantly, so refresh is on-demand: `getSession()` refreshes expired
   sessions, and the API layer retries a 401 once after a forced refresh — an
   API call made after token expiry succeeds without re-login.

API surface consumed (all responses use the `{ data, error, meta }` envelope):

| Route | Use |
| --- | --- |
| `GET /api/me/orgs` | org picker (the caller's own memberships; user-scoped, needs no org context) |
| `GET /api/providers` | provider picker (PHI-safe list projection) |
| `GET /api/providers/:id/profile?state=XX&facilityId=…` | resolved field-token values for fill; the worker also projects the five card identifiers (NPI, license, CAQH, TIN/EIN, DEA) from its tokens; carries the provider's `facilities` list + `selected_facility_id`, and flags `meta.needs_facility` when several locations need a user pick |
| `GET /api/portal-field-maps?portal_key=…` | selector catalog for the portal |
| `GET /api/cases?providerId=…` | case picker (the provider's OPEN cases); each row also carries `payerReferenceId` (prefill), `latestNote` (card), and `lastSubmittedAt` (duplicate-submission guard) |
| `POST /api/fill-events` | fill log, idempotent on a client-generated UUID |
| `POST /api/cases/:id/touches` | "Mark submitted" business log (snake_case body per the locked R2 contract); optional write-back on the same POST — `payer_reference_id`, `wip_note`, `task_id`, `pdf_filename` |

Org context: a single-org user sends no `x-org-id` header — the server
resolves their sole membership (unchanged v0 behavior) and the panel shows
the org read-only. A multi-org user must pick from the org dropdown (fed by
`GET /api/me/orgs`) before anything org-scoped loads; the background worker
then sends `x-org-id` on EVERY subsequent API call (the server 400s a
multi-org caller without it — never guesses). Switching orgs clears all
org-scoped workbench state: provider, case, location, and fill reports.

Location context: the facility dropdown between provider and case is fed by
the profile response's `facilities` list. Exactly one location auto-selects
and shows read-only (the server resolves it the same way); several require a
pick — while `meta.needs_facility` is unanswered the fill button stays
disabled with "Pick a location first." The fill's profile fetch carries
`facilityId` so `facility.*`/`assignment.*` tokens resolve from the chosen
location. The fill gate overall: org resolved, provider selected, facility
resolved, case selected — same hard-gate pattern as the locked case rule.

**Case selection is REQUIRED** (locked decision): the panel's case dropdown is
fed by `GET /api/cases?providerId=…` (a consumer-pulled route, merged in
mintedpanel R2), rendered as `<payer> - <state> - <status>`. No case selected,
no fill. The old paste-a-case-id fallback (for before the route existed) is
gone.

The panel stays open across tab switches and always reflects the ACTIVE tab:
portal detection re-runs on `tabs.onActivated`/`onUpdated`, and the fill
re-checks the active tab's URL at click time. Tab URLs are only readable for
origins in `host_permissions` (the portals) — every other page reads as "no
portal detected", which is the correct state.

The workbench remembers where you were: the active org (multi-org users),
the selected provider, location, and case, and the last fill report (per
provider + portal) persist in `chrome.storage.session` — field labels,
counts, and skip reasons only, never field values, resolved tokens, or auth
material beyond what session auth already stores. Reopening the panel
restores that state and re-validates it silently against the caller's
current memberships and the org's provider/facility/open-case lists; stale
entries are dropped, not errored. A restored report is labeled with when it
ran ("Fill report from 9:42 PM.") so it can't pass for a fresh one, and one
already marked submitted shows "Logged to the case." instead of the button.
Org-scoped state clears on org switch; everything clears on sign-out and
whenever a different identity signs in, and dies with the browser session
either way.

## Touchlog write-back (workbench Stories 4–11)

The workbench surfaces case context and writes structured activity back to the
case touchlog. All of it rides existing routes; the server bridge is in
mintedpanel `submissionTouches.ts` / `providerCases.ts`.

- **Key identifiers (4):** the provider card shows NPI, license #, CAQH ID,
  TIN/EIN, and DEA, each with a copy button; a missing value renders greyed.
  Values come from the profile the worker already fetches — only these five
  non-PHI identifiers cross into the panel.
- **Payer reference / submission ID (5):** a box at the bottom of the fill,
  prefilled from the case's `payerReferenceId`; on submit it overwrites the
  case's latest-wins reference.
- **WIP note (6):** an optional note box → a touchlog `note` entry on submit.
- **Submit → task + logs (7):** every submit writes a `system_event` "Form
  submitted to {payer}"; the server closes a linked SOP task and records a
  `task_update` when `task_id` is supplied. The v1 panel has no task source, so
  it sends none — the plumbing is ready (locked decision (c)).
- **Field-gap flag (9):** before submit, the count of mapped fields with no
  value (skipped + needs-manual) is flagged; submitting is never blocked.
- **Duplicate-submission guard (10):** if the case was marked submitted within
  14 days (`lastSubmittedAt`), the first "Mark submitted" click warns and
  re-labels to "Log anyway"; the next click logs it.
- **Latest note (11):** the selected case's most recent touchlog note shows
  under the case picker.

## Fill flow (M1)

One click on **Fill this page** while the BCBS KS enrollment form
(`provider.bcbsks.com/bcbsks-provider/facelets/allUsers/form/NetworkEnrollmentForm.faces*`)
is the active tab:

1. Background fetches the portal's field maps and the provider's `/profile`
   values (`?state=KS` selects the KS license) in parallel, then plans
   instructions: `hardcoded` → the fixed value; `token` → the resolved
   profile value; `manual` and `file` fields are never attempted and are
   listed for the user; `manual_partial` fills the known part and flags the
   field for review; empty/unresolved tokens are listed with the server's
   reason.
2. The content script resolves each selector (`label:<text>` = exact
   normalized label-text match — deliberate, the form has both "First Name"
   and "Provider's First Name" — else CSS, then fallbacks), sets values
   through native setters, and fires `input`/`change` so the page's own
   validation runs. Selects match by option value then text; radios by value
   or label text. Anything unmatched or unappliable is skipped and reported —
   the engine never throws.
3. Background POSTs `/api/fill-events` with `id: crypto.randomUUID()` (new
   per attempt), the case + provider ids, portal key, timestamps, and
   filled/skipped counts. A logging failure downgrades to a warning — it
   never un-reports a successful fill.
4. The panel shows a review state: filled count, skipped fields with reasons,
   the needs-manual list, and a **Mark submitted** button. The human submits
   the portal form themselves — the extension never clicks or automates the
   portal's submit — then presses Mark submitted, which POSTs
   `/api/cases/:id/touches` (`kind: portal_submission`, the portal key, the
   fill session's id as `fill_session_id`, and a fresh `idempotency_id` the
   worker reuses on retries so the touch can never double-log). On success the
   panel shows "Logged to the case."

## Repo layout

```
public/manifest.json        Manifest V3 (copied verbatim into dist/)
sidepanel.html              side panel entry (Vite html input)
src/sidepanel/              workbench side panel UI (vanilla TS, no framework)
src/background/             service worker: auth.ts, api.ts, index.ts (router)
src/content/                content script (IIFE build, messaging only)
src/shared/                 message protocol, API types, deploy constants
vite.config.ts              side panel + background build
vite.content.config.ts      content script build (content scripts can't be ESM)
```

An eslint rule enforces the boundary: only `src/background/` may import
`@supabase/supabase-js`.

## Develop

```sh
npm install
npm run build        # dist/ = loadable extension
npm run typecheck
npm run lint
npm run watch        # rebuild panel/background on change
```

Load it: `chrome://extensions` → Developer mode → **Load unpacked** → pick
`dist/`. Click the toolbar icon to open the workbench side panel (the worker
sets `openPanelOnActionClick`; there is no action popup). After code changes,
rebuild and hit the extension's reload button.

## One-time backend config (owner does this manually)

`API_CORS_ORIGINS` on the Vercel project must include the extension origin
`chrome-extension://<id>` once the unpacked extension has its id (shown on
`chrome://extensions`). Until then, API calls from extension pages rely on the
host permission for `mintedpanel.vercel.app`; setting the env var is required
config for the API to serve extension origins. The id changes if the unpacked
directory path changes, and again when the extension is packed — re-check the
env var at both points.

## Verifying token refresh (M0 exit criterion)

1. Sign in from the side panel and confirm the provider list loads.
2. Leave the browser alone past the access token's expiry (1 hour), or kill
   the worker early via `chrome://serviceworker-internals` → Stop.
3. Reopen the panel and hit **Refresh**. The list must load without a sign-in
   prompt: `getSession()` re-reads storage and exchanges the refresh token,
   and any straggling 401 is retried once after a forced refresh.

## Milestones

- **M0**: scaffold, sign-in, provider picker showing name + NPI, proven token
  refresh, CI (tsc + lint + build).
- **M1 (this)**: fetch field maps (`bcbs_ks_enrollment`) + profile values,
  one-click fill on the BCBS KS enrollment page with `input`/`change` events
  fired, skipped/unfillable fields reported not attempted, fill event POSTed
  with an idempotency id.
- **Parked until M1 is verified on the live portal**: attachments, PDF fill,
  CAQH, second-portal generalization.
