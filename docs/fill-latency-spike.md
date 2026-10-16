# Fill latency spike — where do 95 s go on a 70-field fill?

**Date:** 2026-10-15 · **Branch:** `claude/spike-fill-latency-0fb0df` · **Status:** measurement only, nothing optimised.

A real fill of the BCBS Kansas Network Enrollment Form on 2026-10-15 took
95 s for 70 attempted fields (about 1.3 s per field), with fields appearing one
at a time. This spike instruments the static fill path and measures it against
a synthetic page of the same shape. **No real portal was filled** — the
session that ran this had no unpacked install or test case to hand, so the
numbers below are from the vitest harness, and the "real page" column is an
extrapolation, labelled as such.

## Answer

**The per-field fresh `PROBE_FILL` is the top contributor, and it is the
structural one.** After the first write, `applyFillAcrossFrames`
(`src/background/frameMessaging.ts`) sets `priorApplyMayHaveChangedPage` and
then, before *every* remaining field, sends a single-instruction `PROBE_FILL`.
Each one runs `waitForPageSettled()` in the content script: a 120 ms
mutation-quiet window with a 700 ms cap. On a quiet page that is ≥140 ms per
field; on a page that never goes quiet for 120 ms (a session timer, a
`p:poll`, a jQuery fade that mutates `style` every frame) it is the full
700 ms per field. For 69 fields that is **10 s to 50 s before a single value
is written**, independent of control type.

The PrimeFaces select waits the spike was asked to look at are **not** the
cost: across 30 successful selects the menu wait summed to 125 ms and the
value wait to 72 ms. Those budgets (700 ms / 500 ms) only bite when a select
*fails*, so lowering them saves nothing on a working fill.

## Per-field message sequence today

For each instruction after the first, the worker does, in order:

1. `chrome.webNavigation.getAllFrames` (`listTabFrames`) — ~1 ms
2. `validate()` — the active-work guard, a `chrome.storage.session` read — ~1 ms
3. **`PROBE_FILL` for this one instruction** → `probeFillOnPage` → `waitForPageSettled()` — **120–700 ms**
4. `APPLY_FILL` for this one instruction → `applyFillSettled` — 20 ms text, 50–60 ms PrimeFaces select (jsdom numbers; faster in Chrome)

Steps 1, 2 and 4 are real per-field round trips but cheap. Step 3 is a
deliberate wait, and it is the only phase measured in hundreds of
milliseconds.

## Measured (synthetic page, vitest + jsdom, real timers)

Synthetic BCBS KS-shaped page: 40 text inputs + 30 PrimeFaces 10
SelectOneMenus (5 long vocabularies, 25 AM/PM pickers), driven through the
real `applyFillAcrossFrames` → real `probeFillOnPage` / `applyFillSettled`,
with `chrome.tabs.sendMessage` stubbed at 1.5 ms per hop and browser API calls
at 1 ms. Harness: `src/harness/fillLatencySpike.test.ts`
(`FILL_LATENCY_SPIKE=1 npx vitest run src/harness/fillLatencySpike.test.ts`).

| Phase | A: quiet page | B: page mutates every 50 ms | C: ajax render 250 ms after each select |
|---|---:|---:|---:|
| (a) batch `PROBE_FILL` (once, all 70) | 1.1 s (7%) | 1.4 s (3%) | 0.9 s (6%) |
| **per-field fresh `PROBE_FILL` (×69)** | **11.4 s (76%)** | **50.9 s (93%)** | **11.5 s (77%)** |
| per-field `getAllFrames` (×70) | 0.08 s | 0.08 s | 0.08 s |
| per-field `validate` (×70) | 0.08 s | 0.08 s | 0.08 s |
| (b) `APPLY_FILL`, regular (×40) | 0.8 s (6%) | 0.9 s | 0.8 s (5%) |
| (b) `APPLY_FILL`, PrimeFaces select (×30) | 1.5 s (10%) | 1.1 s | 1.5 s (10%) |
| (c) of which menu-items wait | 0.13 s | 0 (never reached) | 0.12 s |
| (c) of which value wait | 0.07 s | 0 (never reached) | 0.08 s |
| **Total** | **14.9 s · 213 ms/field** | **54.5 s · 779 ms/field** | **14.9 s · 213 ms/field** |
| Outcome | 70 filled | **15 filled, 55 skipped** | 70 filled |

Per-field rows (quiet page): a text field is `frames 1.2 · validate 1.2 ·
freshProbe ~165 · apply ~21 ms`; a PrimeFaces select is `freshProbe ~166 ·
apply ~56 (menuWait ~5, valueWait ~3) ms`. On the busy page every
`freshProbe` reads 731–744 ms — the cap plus one poll tick.

Notes on reading the table:

- jsdom is slower than Chrome at DOM queries, so the batch probe and the apply
  figures are inflated; the probe-settle waits are timer-bound and transfer
  as-is. The 120 ms floor per field is the number to trust.
- Scenario C costs the same as A because the ajax render lands *after* the
  next probe has already satisfied its 120 ms window. It would cost the full
  cap if the render took longer than the probe or arrived in pieces.
- Scenario B's 55 refusals are a second effect of a never-quiet page: the
  apply path's own revalidation reads the mutations as "form changed" (see the
  skip reasons printed by the harness). That overlaps the sibling
  context_changed spike and is recorded here, not investigated.

## Extrapolation to the real 95 s

The model gives a floor of ~150 ms/field (quiet page, Chrome IPC) and a probe
ceiling of ~720 ms/field. The observed 1,360 ms/field says the real page sat
at the probe cap for most fields (≈48 s for 69 probes) with ~600 ms per field
unaccounted for by this model — plausible candidates are PrimeFaces' default
400 ms `fade` on panel show/hide keeping the DOM "unquiet", `p:ajax` partial
renders slower than 120 ms, and PrimeFaces selects that failed readback and
ate their full 500 ms value wait. The gate makes that a one-fill question:
flip `enabled` to `true` in `src/shared/fillTiming.ts`, `npm run build`, load
`dist/` unpacked, run the fill, and read the `[fill-timing]` table in the
worker console (ids and milliseconds only, no values).

## Proposal — the smallest change

**Drop the settle wait from the per-field re-probe; keep the settled probe as
the fallback.** Give `PROBE_FILL` a `settle: false` option that the
singleton re-probes in `applyFillAcrossFrames` send; `probeFillOnPage` then
skips `waitForPageSettled()` and resolves the selector immediately (~1 ms in
Chrome). Only when that unsettled probe does **not** return a unique eligible
target does the worker re-send the probe settled, exactly as today. The batch
probe at the start keeps its settle. Expected effect on the model: the
quiet-page run drops from 14.9 s to about 3.5 s, and the busy-page run from
54.5 s to about 4 s; on the real form it removes the ≈48 s probe-cap term, so
a 95 s fill lands somewhere around 40 s before anything else changes.

Risk: a probe taken mid-mutation can report "unique" for a control a wizard
is about to replace. That window already exists (the settled probe is a
snapshot too), and the write is still guarded by `APPLY_FILL`'s
`requireUniqueTarget` revalidation and the probe mutation-version check in
the content script, so the failure mode is an extra `context_changed` skip,
not a wrong write. The miss case (a field an earlier write revealed) keeps the
settled search via the fallback. Change surface: one optional field on the
worker↔content `PROBE_FILL` message (not an `/api` contract), one branch in
`probeFillOnPage`, one retry in the worker loop, plus a harness case for
"unsettled probe misses, settled fallback finds". Not shipped in this spike.

Alternatives weighed and set aside: batching the regular inputs into one
`APPLY_FILL` removes the re-probe for 39 of 69 fields (~45% of the probe cost)
but leaves every select at full price and breaks the one-outcome-per-apply
binding that V2 telemetry relies on; lowering the select wait budgets saves
only failed selects.

## Instrumentation left in place (gated)

`src/shared/fillTiming.ts` — off by default. When on, `applyFillSettled`
attaches `timing` (numbers + map ids) to the page result and
`applyFillAcrossFrames` logs the per-field table. Every touch point is marked
`SPIKE(fill-latency)` so it can be deleted in one grep once the proposal
lands and the real-page numbers have been read.
