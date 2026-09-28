# AGENTS.md — Minted Panel Workbench (Chrome Extension)

Binding rules and architectural orientation for AI coding agents working on the Minted Panel Workbench MV3 extension.

---

## 1. Project Overview

Minted Panel Workbench (`sonny303/minted-extension`) is a Manifest V3 Chrome extension that autofills payer-portal enrollment forms with Minted Panel provider data, and logs fills and submissions back to the case activity ledger.

- **Current Version**: `v0.1.2` (Chrome Web Store unlisted release, Extension ID `dppfnbikpojpgdiobckgcknmkjlfoinh`).
- **Server Counterpart**: `sonny303/mintedpanel` (`scratch/mintedpanel`). Contract shapes in `src/shared/apiTypes.ts` must stay in lockstep with the panel's `/api` routes.

---

## 2. Locked Architectural Rules

1. **Service Role Key Prohibited**:
   - The extension **never queries Supabase tables directly** and **never holds the service-role key**.
   - Supabase auth is used solely to obtain a user JWT (anon key + email/password).
   - ALL business data flows through the panel API (`https://mintedpanel.com` or `https://mintedpanel.vercel.app`).
2. **Background Worker Isolation**:
   - The background service worker (`src/background/`) owns **all network API calls**.
   - Side panel (`src/sidepanel/`) is UI-only and communicates with the worker via typed `chrome.runtime` messages (`src/shared/messages.ts`). The side panel never holds tokens.
   - Content scripts (`src/content/`) receive resolved values, inject them using native prototype setters (`Object.getOwnPropertyDescriptor(proto, 'value').set`), dispatch event cascades (`input`, `change`, `blur`), and report telemetry.
   - **The worker refuses messages from tabs**.
   - An ESLint rule strictly enforces: **only `src/background/` may import `@supabase/supabase-js`**.
3. **Session Lifecycle**:
   - Auth session is stored in `chrome.storage.session` (ephemeral; cleared on browser close).
   - The background worker auto-refreshes expired tokens and retries 401s once after forced token refresh.
4. **Strict Non-Submission Rule**:
   - **The extension NEVER submits portal forms.** It applies field values and logs the fill; the human coordinator must review and submit the form.
5. **Case Selection Invariant & Ad Hoc Fills**:
   - Case selection is required before a fill, except for:
     (a) the isolated sandbox test provider mode (exercises the profile pipeline without attaching to a real case), or
     (b) authorized ad hoc form fills where the operator explicitly selects a Provider + Location + Group with `(No case · Ad hoc fill)`.
   - For ad hoc fills, `assertFillMatchesActiveCase` enforces that no conflicting unexpired handoff or active in-panel case is bound. The fill session logs against the provider without mutating case state or allowing form submission.
   - Ad hoc choice is distinct from the empty case placeholder. Group joins provider/case/location in worker session selection; changes invalidate pending static and AI fills. Location state comes from the profile facility projection, never the provider's home state.
6. **Wire Contract Cohesion**:
   - `src/shared/apiTypes.ts` mirrors the server `/api` response shapes. Never alter a contract unilaterally.

---

## 3. Commands & Verification

```bash
# Typecheck TypeScript
npm run typecheck

# Run Vitest test suite
npm test

# Verify release contract (version bumps, manifest permissions, domain targets)
npx vitest run scripts/release/contract.test.mjs

# Package clean zip for Chrome Web Store upload
./scripts/package-extension.sh

# Build unpacked extension to dist/
npm run build
```

---

## 4. Manifest & Domain Boundaries

- `manifest_version`: 3
- `externally_connectable`: allowlists `https://mintedpanel.com/*` and `https://mintedpanel.vercel.app/*` for webapp handoffs (`SET_ACTIVE_CASE`).
- `host_permissions`: allowlists canonical web hosts and Supabase endpoints.
- Dynamic portal origins are requested on demand via `optional_host_permissions` using patterns from the database portal registry (`GET /api/portals`).
