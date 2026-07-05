# Minted Panel Fill — Chrome extension

Fills payer portal enrollment forms with Minted Panel provider data in one
click. v0 is unlisted (loaded unpacked); the first target portal is the BCBS
Kansas network enrollment form.

## Architecture (locked, spec v1.2)

Three rules everything else follows from:

1. **The extension never queries Supabase tables and never holds the service
   key.** Supabase auth is used only to mint a JWT (anon key + email/password
   sign-in). All data flows through the Minted Panel server API at
   `https://mintedpanel.vercel.app` with `Authorization: Bearer <jwt>`.
2. **The background service worker owns every API call.** The popup is UI
   only and talks to the worker over `chrome.runtime` messaging. The content
   script receives resolved fill values via messaging, applies them to the
   page, and reports results — tokens never touch page context, and the
   worker refuses messages that originate from a tab.
3. **Session lives in `chrome.storage.session`** (in-memory, gone when the
   browser exits) with supabase-js handling refresh. MV3 workers restart
   constantly, so refresh is on-demand: `getSession()` refreshes expired
   sessions, and the API layer retries a 401 once after a forced refresh — an
   API call made after token expiry succeeds without re-login.

API surface consumed (all responses use the `{ data, error, meta }` envelope):

| Route | Use |
| --- | --- |
| `GET /api/providers` | provider picker (PHI-safe list projection) |
| `GET /api/providers/:id/profile?state=XX` | resolved field-token values for fill |
| `GET /api/portal-field-maps?portal_key=…` | selector catalog for the portal |
| `GET /api/cases?providerId=…` | case picker (see note below) |
| `POST /api/fill-events` | fill log, idempotent on a client-generated UUID |

Single-org users send no `x-org-id` header.

**Backend dependency:** `POST /api/fill-events` requires a `caseId` owned by
the caller's org, so the popup has a case picker fed by
`GET /api/cases?providerId=…` — a minimal route the extension pulls from the
backend (consumer-pulled surface). Until that route is deployed, the popup
detects the 404 and falls back to pasting a case id from Minted Panel.

## Fill flow (M1)

One click on **Fill this page** while the BCBS KS enrollment form
(`provider.bcbsks.com/...NetworkEnrollmentForm*`) is the active tab:

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
4. The popup shows filled count, skipped fields with reasons, and the
   needs-manual list.

## Repo layout

```
public/manifest.json        Manifest V3 (copied verbatim into dist/)
popup.html                  popup entry (Vite html input)
src/popup/                  popup UI (vanilla TS, no framework)
src/background/             service worker: auth.ts, api.ts, index.ts (router)
src/content/                content script (IIFE build, messaging only)
src/shared/                 message protocol, API types, deploy constants
vite.config.ts              popup + background build
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
npm run watch        # rebuild popup/background on change
```

Load it: `chrome://extensions` → Developer mode → **Load unpacked** → pick
`dist/`. After code changes, rebuild and hit the extension's reload button.

## One-time backend config (owner does this manually)

`API_CORS_ORIGINS` on the Vercel project must include the extension origin
`chrome-extension://<id>` once the unpacked extension has its id (shown on
`chrome://extensions`). Until then, API calls from extension pages rely on the
host permission for `mintedpanel.vercel.app`; setting the env var is required
config for the API to serve extension origins. The id changes if the unpacked
directory path changes, and again when the extension is packed — re-check the
env var at both points.

## Verifying token refresh (M0 exit criterion)

1. Sign in from the popup and confirm the provider list loads.
2. Leave the browser alone past the access token's expiry (1 hour), or kill
   the worker early via `chrome://serviceworker-internals` → Stop.
3. Reopen the popup and hit **Refresh**. The list must load without a sign-in
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
