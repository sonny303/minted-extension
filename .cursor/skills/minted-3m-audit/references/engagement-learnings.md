# Engagement learnings (capture from 3M thread)

Lessons that repeatedly bit us. Encode into recommendations and PR review.

## Process

1. **Execute, don’t chore-list.** PM asked agents to do the work; chat dumps of “please tick boxes” were rejected.
2. **One decision surface.** Bundle related product forks into one PM reply block (A/B/C), then implement. Don’t reopen after sign-off without new evidence.
3. **Draft PRs early; merge is human (default).** Self-merge only when PM explicitly requests.
4. **Slice close ≠ system optimized.** After Slice 6 merge, rescore the whole system; don’t treat engagement closure as architecture health.
5. **UAT is hosted.** Local green does not clear ops: migrations applied, vault, seeded payers, extension against prod API.
6. **Cross-repo sync.** Panel docs/workflow changes that affect extension contributors need a sync PR on `minted-extension` (even if code-noop).

## Product / architecture decisions that stuck

| ID | Decision | Implication |
|---|---|---|
| D1=B | Slice 0–1 first | Sequencing: truth → UX empty states → orphans → watch → env → platform |
| D2 | Slice 6 = platform/org overhaul | Not audit-docs-only |
| D3 | F24 portal filter into Slice 6 | Shipped as `portalVisibility` + list filters |
| D4 | Skip Postman (#265) | Extension door stays extension-only |
| D6.1–D6.7 | Spike then build | Assignment RPC, SOP RLS, archive filter, authoring payers |
| Sign-offs | Keep `archived_at`; D6.5 = all global SOPs; keep `useAuthoringPayers` | Do not “fix” these without PM |

## Findings that looked fixed but weren’t (mura traps)

- **Open Cases = `case_status`:** fixed in panel + extension; do not regress to stage-based open filters.
- **Portals empty registry:** API `registry_empty` + extension empty UX; browser storage list still diverges.
- **Reporting route:** `/reports` → `/reporting`; **orphan components** under `components/reports/` may still exist — delete is separate bite.
- **CAQH strip:** quarantined in sidepanel; not a substitute for product CAQH work.
- **`npm run watch`:** must rebuild content.js; verify after vite config edits.
- **F13 env:** Vite overrides shipped; manifest / handoff / CORS may still be incomplete — split bites.
- **F23/F24 code:** closed in Slice 6; Slice 4 audit markdown is **historical**, not a second source of truth.
- **Train tab:** can wipe recognition when URL match ≠ selected portal — **dual registry**; highest-value post-3M mura.
- **Global payer pile (~270):** assignment model made globals muda for ops; DELETE needs inventory + PM-signed candidates (separate epic/spike).

## Failure modes to anticipate

- Regenerating `types.ts` **before** applying migrations drops new RPC args.
- RLS INSERT on assignments fails without DEFINER RPC (cross-org portal invisible).
- Authoring dropdown empty if UI uses ops `listPayers` instead of authoring list.
- Extension fill against unfiltered `listPortals` undoes D6.4 intent.
- Agents editing old migration files or proposing destructive DDL — reject.

## Communication preferences (PM)

- Bite-sized recommendations; large features → numbered sub-slices with explicit sequencing.
- Prefer merged outcome + next decision over long status essays.
- Claude/Cursor handoffs: paste-ready prompt with D-decisions locked, files, AC, out of scope.
- Review/merge for PM — do not dump hosted box-ticking chores into chat; label **ops residual**.

## Skill maintenance

- Canonical pack: `.cursor/skills/minted-3m-audit/` in **both** repos (keep references identical).
- After a material 3M decision or merge, update `engagement-learnings.md` + `known-debt-map.md` in the same PR when practical.
- Re-run audits from code; do not treat this file as a live AC list.