# Minted Panel Workbench

Chrome MV3 extension. Fills payer-portal enrollment forms with Minted Panel
provider data, then logs the fill and the human's submission back to the case.
v0 is unlisted, loaded unpacked.

## Architecture (locked)

1. **Never queries Supabase tables; never holds the service key.** Supabase auth
   only mints a JWT — all data flows through the panel API at
   `https://mintedpanel.vercel.app`.
2. **The background service worker owns every API call.** The side panel is
   UI-only over `chrome.runtime` messaging; the content script applies resolved
   values and reports results.
3. **Session lives in `chrome.storage.session`** (dies with the browser).

## Panel modes

Search · Work cases · Train forms (admin-only). The mode decides whether a call
carries `x-org-id` — training sends none.

## Portals

The manifest ships static access to BCBS Kansas only. Every other portal comes
from the DB registry (`/api/portals`, `/api/shared-portals`); origins are granted
on demand and `content.js` is injected by the worker.

## Locked product rules

- **Never submits a portal form.** The human submits; the extension logs.
- Case selection is required before a fill (the `is_test_provider` sandbox is the
  one exception — no case, no touch, no status change).
- Sanctioned writes only: touches (both kinds), the user-scoped layout PUT,
  propose-only field maps, the CAQH attestation POST, the sandbox test-fill log.
- No tokens in messages; no field values in `chrome.storage`.

## Commands

`npm run build` · `typecheck` · `lint` · `test` · `watch`

## Read before working

- `docs/SYSTEM-MAP.md` — wire contracts, capture/fill rules, panel-mode rules, full locked-rule list
- `README.md` — architecture spec v1.2 and the fill-flow narrative
- `sonny303/mintedpanel` `docs/SYSTEM-MAP.md` — the server side of every contract here

## Skills

- `chrome-extension-minted` — MV3 architecture patterns
- `chrome-devtools-minted` — DevTools debugging
- `adhd` — output shaping

## Notes

- MV3 only. `chrome.storage.local`/`session`, never `localStorage`.
- Never change a locked wire contract unilaterally — panel-first, mirrored in
  `src/shared/apiTypes.ts` in the same coordinated change.
- `API_CORS_ORIGINS` on the panel's Vercel project must include
  `chrome-extension://<id>`.
