# Launch AI-slop register (extension)

Current-state checklist for `sonny303/minted-extension` before coordinators
use the Workbench. Voice bar is the design system: calm, sentence-case,
action-first, no emoji, no lorem, no marketing filler.

**This file is the tracking list. Do not treat a prior 3M slice as “already
clean.”** Parallel agents are sanitizing fixture names/NPIs — do not rewrite
`scripts/mock-panel-api.mjs` or design-kit sample people in the same PR as
copy.

---

## Do now (user-visible)

Ship these before anyone who is not an engineer opens the panel.

| ID | Surface | Finding | Change |
| --- | --- | --- | --- |
| SLOP-01 | Search / sandbox | Emoji `🧪` on the sandbox row and bar | Drop the emoji. Keep “Sandbox test profile” / “Sandbox — no case…” |
| SLOP-02 | Quick cards | `⚠ Not on file` | “Not on file” (design kit already uses this, no glyph) |
| SLOP-03 | Offer / train | `PROVEN` all-caps chip | “Proven” |
| SLOP-04 | Cases / SOP | `THIS PAGE` all-caps chip | “This page” |
| SLOP-05 | Coverage | “I fixed a mapping — refresh and re-check” | “Refresh mappings” |
| SLOP-06 | Queue / NBA | “Queue clear — nothing needs action right now.” | “Nothing needs action.” |
| SLOP-07 | Queue heading | “Pick up where you left off” | “Open cases” (or drop the heading if the list already says that) |
| SLOP-08 | NBA card | “Next best action” | “Up next” |
| SLOP-09 | Fill CTA | “Fill this page” | “Fill form” (design kit) |
| SLOP-10 | Fill report | “Needs manual entry or review:” | “Needs a human” (design kit) |
| SLOP-11 | Coverage count | “Can fill 7 of 19 mapped fields.” | “7 of 19 fields” |
| SLOP-12 | Train dry run | “synthetic Sample values” / “Mock dry run passed…” | “sample data” / “Dry run filled N fields. Review the form, then mark it proven.” |
| SLOP-13 | Capture restore | “…Field names only — no values are ever stored.” | Counts only. PHI rule stays in code comments, not the panel |
| SLOP-14 | Portal access | “Give Minted access to this organization's portal sites so it can capture and fill their forms.” | “Allow access to this org’s portal sites so capture and fill can run.” |
| SLOP-15 | Handoff | “Working from a Minted Panel handoff.” / “A case was handed off…” | “Opened from Minted Panel.” / “A case is waiting from Minted Panel.” |
| SLOP-16 | Duplicate guard | “Someone may already have done this work.” | “Already marked submitted {when}.” |
| SLOP-17 | Manifest | `0.1.0` + “One-click payer portal form fill…” | Ship version + “Fills payer enrollment forms from Minted Panel.” |

**Hot files:** `sidepanel.html`, `src/sidepanel/main.ts`, `src/shared/trainForms.ts`,
`src/shared/sandbox.ts`, `src/shared/caqh.ts`, `src/shared/capture.ts`,
`public/manifest.json`. Tests that pin the old strings go with the copy.

---

## Copy pass (string-by-string)

Replace, then grep the old string so it cannot hide in a test.

| Now | Proposed |
| --- | --- |
| `🧪 Sandbox test profile` | `Sandbox test profile` |
| `🧪 Sandbox — no case, nothing logged to a case` | `Sandbox. No case. Nothing is logged.` |
| `The mock dry run fills this live tab with synthetic Sample values — no provider PHI.` | `Fills this tab with sample data. No provider record is used.` |
| `Review the filled form after a successful dry run before marking it proven.` | `Review the filled form before you mark it proven.` |
| `This form hasn't been proven by a dry run — check the result before you submit.` | `This form is not proven. Check the fill before you submit.` |
| `New form — nothing matches this page yet. It will be registered as “{name}”.` | `New form. Nothing matches this page yet. It will be registered as “{name}”.` |
| `{n} sent to the shared form library. Nothing fills until they are mapped in the web app's Submit-form task editor.` | `{n} sent to the shared library. Nothing fills until they are mapped in the web app.` |
| `Will close task: {title}` | `Closes task: {title}` |
| `On a payer portal? Give Minted access…` | `On a payer portal? Allow access to this org’s portal sites.` |
| `Keep this tab open while filling.` | keep (short, useful) |
| `Submit the form on the portal yourself, then log it to the case:` | `Submit on the portal, then log it here.` |
| `Hi, {first}` | keep (design-system greeting) |
| `Open in Minted Panel ↗` | keep the link; drop `↗` if it reads as decoration |
| `Fix mapping ↗` / `Add the data ↗` / `See the touchlog ↗` | `Fix mapping` / `Add the data` / `See the touchlog` |

Do **not** rewrite locked mismatch copy in `trainForms.ts`
(`This page doesn’t match {name} — finish login or open the registered form URL`)
beyond trimming the em dash. TRAIN-DUAL C1 is product, not filler.

---

## Hide or finish (unfinished chrome)

| ID | Finding | Evidence | Rec |
| --- | --- | --- | --- |
| SLOP-18 | CAQH exception strip is wired in comments and worker (`PULL_CAQH_FIELD`, `findCaqhGaps`) but never populated — capture is shape-only | `src/sidepanel/main.ts` ~3914, `CLAUDE.md` CAQH gap, `src/shared/caqh.ts` | Hide the pull path from launch. Keep push (offer + Record attestation). Do not ship a blank “exceptions” strip |
| SLOP-19 | `docs/S3.1-sidepanel-open-spike.md` still asks for a human Chrome verification table (empty) | that file | Verify once, or stop promising auto-open. Not panel copy |

---

## After launch-visible copy (engineer-only slop)

These never reach a coordinator. Strip in a **separate** PR so copy review stays small.

| ID | Finding | Rec |
| --- | --- | --- |
| SLOP-20 | `src/sidepanel/main.ts` is 5193 lines with ~855 `//` comments. Many are changelog: Story 4–11, S1–S6, E4.3/E6.9, F4.3.*, US-3, BITE-*, “removed 2026-08-19” | Keep comments that encode a **locked invariant** (why). Delete comments that restate the next three lines or cite a shipped ticket |
| SLOP-21 | Same ticket IDs in `sidepanel.html` (23 HTML comments) and `sidepanel.css` (“Stories 5/6”, “E1.5”, “US-5”) | Same rule |
| SLOP-22 | File-header essays in `src/shared/*.ts` (`trainForms.ts`, `sandbox.ts`, `caqh.ts`, `panelMode.ts`, `quickCards.ts`, `messages.ts`) that retell the epic | One-line module purpose. Move facts that must stay into `CLAUDE.md` |
| SLOP-23 | Verbal tic “honest” / “deliberately” / “the ONE” across comments and test names | Fine in tests that pin a contract. Drop from UI-adjacent comments |
| SLOP-24 | `docs/design-system/` (~103 files): agent handoff, `.prompt.md`, `support.js`, emoji legend in `changes.md`. Not loaded by the extension, but it is in the repo | Do not pack it. Sanitization lane owns sample names inside it. After tokens are applied, keep `targets/` + the written voice rules; drop `.prompt.md` / runtime kit if they are not used |

`SIDEPANEL-GOD` (extract `main.ts`) is TD-50, not slop. Do not fold a rewrite into this list.

---

## Sanitization (separate lane — do not duplicate here)

Sibling “Launch data sanitization” agents are rewriting fixtures. Names/NPIs
currently in tree (verify before claiming clean):

- `scripts/mock-panel-api.mjs` — Pat Ostrander, Kansas Fitness Physio, Wellspring PT, Leavenworth, Brian Hershberger (comment)
- Tests — Addie Jones / NPI `1891243838`; `greeting.test.ts` Sowmya Surapureddy
- `docs/design-system/**` — Brian Hershberger, Sarah Nguyen, Marcus Bell, NPIs `1841293756` / `1730495821` / `1902847563`, CAQH `14237788`, Kansas Fitness Physio

Keep `Sample Provider` / `sample.provider@example.com` in `src/shared/mockFillProfile.ts` — that is the Train dry-run identity, not a client.

---

## Keep (looks like AI, is product)

- Extension never submits the portal form; “Mark submitted” stays
- URL-only Train capture bind and mismatch copy (TRAIN-DUAL)
- Case required before fill; sandbox is the one exception
- Tokens never in `chrome.storage` or page context
- `renderModeSurfaces` as the only mode chrome switch
- Anon key + `API_BASE_URL` in `src/shared/config.ts` (public by design)
- `Unnamed field` capture fallback

---

## Recommended first PR (copy only)

1. SLOP-01…04 (emoji + shouty chips)
2. SLOP-05…11 (queue / coverage / fill labels vs design kit)
3. SLOP-12…17 (train, capture, handoff, manifest)
4. Tests that pin those strings
5. Stop. Comment stripping and fixture names are later PRs

**Verify:** `npm run test` · `npm run typecheck` · grep the old strings ·
side panel still has no submit button and Train still URL-binds.

**Stop:** do not approve mappings, do not DROP comments that encode PHI/org-header
rules, do not rewrite `mock-panel-api.mjs` in the copy PR.
