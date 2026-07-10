# Staging build — pinned plan (extension side)

**Status: APPROVED WITH REVISIONS — pinned 2026-07-10.** The full staging
architecture and rollout order live in the panel repo:
`mintedpanel/docs/staging-environment-plan.md`. This file pins the
extension-specific requirements. None of this is built yet — it is the
agreed spec for the staging build work.

## Context

Today the extension is production-only by construction:

- `src/shared/config.ts` hardcodes the prod Supabase URL, anon key, and
  `API_BASE_URL` (verified 2026-07-10).
- `public/manifest.json` host_permissions allow only the prod hosts.
- `npm run build` runs two Vite invocations (main + content script) into one
  `dist/`, and installs are unpacked from that single directory.

The staging spine adds a staging Supabase project and a staging Vercel
deployment (production alias of the `redesign` branch). The extension needs a
staging build that can be loaded **side by side** with the prod build and can
only ever talk to staging hosts.

## Requirements (must-fix finding 4 of the staging review)

1. **Build modes on BOTH invocations.** `--mode staging` must be passed to the
   main build AND the `vite.content.config.ts` build:

   ```
   vite build --mode staging
   vite build --config vite.content.config.ts --mode staging
   ```

2. **Separate output directories** — `dist/` (prod) and `dist-staging/`.
   Loading two builds from the same directory updates one unpacked install
   instead of creating a durable second installation.
3. **Generated per-target manifests** — distinct `name` (staging build
   suffixed "(Staging)" so the two side panels are distinguishable), and each
   manifest carries ONLY its own API/Supabase host permissions (a prod build
   must not be permitted to reach staging hosts, and vice versa).
4. **Config from build-time env, validated.** Replace the hardcoded constants
   with per-mode values (`import.meta.env` / define), and fail the build
   loudly when a required URL or key is missing — never fall back silently to
   prod values.
5. **Stable, distinct extension IDs.** Different unpacked paths produce
   different IDs, but for a predictable CORS allowlist assign stable distinct
   `key` values in each generated manifest (or explicitly register each
   tester's two IDs). The `API_CORS_ORIGINS=chrome-extension://<id>` install
   contract (INSTALL.md / README.md) stays: the staging extension origin goes
   into the STAGING Vercel project's `API_CORS_ORIGINS`. Do not rely on
   host_permissions alone without an end-to-end test.

## Acceptance checks

- Prod and staging builds installed side by side, visually distinguishable.
- Staging build authenticates only against staging GoTrue and calls only the
  staging API/Supabase hosts (verify in the service-worker network panel).
- A fill against the staging seed data works end to end (profile → fill →
  fill-event → submission touch).
- Prod build behavior is byte-for-byte unaffected (`dist/` output unchanged
  for the default mode).
