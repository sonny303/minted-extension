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

## Corrected payer-setup plan (2026-08-10 — locked)

Do **not** paste a full 3M audit into handoffs; bind this skill and cite paths.

| Lock | Status | Implication |
|---|---|---|
| **Ready = checklist SOP** | #277 merged | ≥1 active global SOP with ≥1 task. Portal train/prove/drift = soft CTAs / autofill **badges**, not the Ready gate. Form mapper stays. |
| **Attach: defaults only** | #277 merged | Keep E6.2 group-operating-state eligibility; zero-facility proposed states stay **visible** but **unchecked** by default. Do not reverse E6.2. |
| **Keep `org_payer_assignments`** | locked closed | #274 prose “Slice 3 = drop assignments” ≠ live plan. Do not remove or bypass unless PM reopens. |
| **Catalog DELETE** | #275 merged code | Hosted apply needs **second PM sign-off**. Never run purge SQL without it. |
| **`create_payer` live signature** | #274 merged | App sends the hosted **10-arg** RPC. `p_assign_to_org` migration is `.superseded` — do not resurrect. |
| **Slice 3 = SOP All-states** | spike #278 | Build **only after** PM acks D3.1–D3.7 in `docs/ops/slice-3-sop-all-states-spike.md`. Spike default D3.1 = Option A (`state='All'`). |
| **Slice 5** | out | Generation-reason / sidepanel godfile work stays out unless asked. |

## Findings that looked fixed but weren’t (mura traps)

- **Open Cases = `case_status`:** fixed in panel + extension; do not regress to stage-based open filters.
- **Portals empty registry:** API `registry_empty` + extension empty UX; browser storage list still diverges.
- **Reporting route:** `/reports` → `/reporting`; **orphan components** under `components/reports/` may still exist — delete is separate bite.
- **CAQH strip:** quarantined in sidepanel; not a substitute for product CAQH work.
- **`npm run watch`:** must rebuild content.js; verify after vite config edits.
- **F13 env:** Vite overrides shipped; manifest / handoff / CORS may still be incomplete — split bites.
- **F23/F24 code:** closed in Slice 6; Slice 4 audit markdown is **historical**, not a second source of truth.
- **Train tab:** can wipe recognition when URL match ≠ selected portal — **dual registry**; highest-value post-3M mura.
- **Global payer pile:** #275 ships guarded DELETE (ops-gated). Do not treat “still ~270 on hosted” as a code bug until the second PM sign-off + apply.
- **`create_payer` PGRST202:** was hosted/app signature drift (#274). Re-probe live RPC args before inventing a new flag.
- **Attach Save disabled:** zero-facility defaults (#277) — e2e must check the box or seed a facility; do not “fix” by auto-checking zero-facility again.

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