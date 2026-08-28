# Pre-launch AI-slop cleanup — master list

**Scope:** `minted-extension` (this repo). Panel-side residual lives in the
panel's 3M register — do not conflate.

**Goal:** ship a panel that reads like a product built by humans who know
credentialing — calm copy, current-state docs, no half-wired surfaces, no
ticket archaeology in the shell.

**Already clean (do not re-open):** Geist self-hosted; primary `#1B4D3E`; no
card shadows / no purple-gradient look; status pills at 4px; no `console.log`
spam in `src/`; harness/mock API correctly isolated; most error strings are
already concrete.

**How to use:** check a box when the change lands on `main`. One PR per bite
when possible; never mix a delete of live write machinery with a comment-only
scrub.

---

## Do now — MUST before launch

| # | Item | Why it reads as slop / risk | Evidence | Bite |
| --- | --- | --- | --- | --- |
| 1 | **Delete or hard-quarantine CAQH pull machinery** | Half-wired write path still callable; UI gone, handler live | `PULL_CAQH_FIELD` in `src/shared/messages.ts`, handler in `src/background/index.ts` (~718), `findCaqhGaps` in `src/shared/caqh.ts`; quarantine essay in `main.ts` ~3914 | Remove message + handler + producer stubs **or** assert `never` / throw "not shipping". Keep CAQH **attestation push** (live). Update `CLAUDE.md` gotcha to match. |
| 2 | **Strip user-facing emoji** | Marketing/AI tell; DS says no emoji | `sidepanel.html` sandbox rows (`🧪`); `main.ts` `"⚠ Not on file"` | Plain text: `Sandbox test profile`, `Not on file`. |
| 3 | **Replace generic catch-all errors** | Soft AI default copy | `src/background/index.ts` ~938 / ~945 `"Something went wrong."` | Name the failure class (auth / network / unexpected) the way the rest of the panel already does. |
| 4 | **Rewrite README story sections as current behavior** | Changelog voice, not product truth | `README.md` §§ "E4.3 Workbench…" (ticket keys F4.3.x) and "Touchlog write-back (Stories 4–11)" | Drop Story/F/TE numbers; state what the panel does today. |
| 5 | **Archive or delete unfinished spike doc** | Empty verification table shipping as docs | `docs/S3.1-sidepanel-open-spike.md` | Move to `docs/archive/` with a one-line pointer, or delete if behavior is already in CLAUDE/README. |
| 6 | **Scrub ticket archaeology from `sidepanel.html` comments** | PR history in the panel shell | HTML comments citing S1.4 / E6.9 / QUARANTINED (~8–10, ~67–71, ~413–414) | Keep only invariants the next human needs ("CAQH pull not shipping"). |
| 7 | **Reconcile `CLAUDE.md` CAQH gotcha** | Docs claim strip/rendering exist; code removed the UI | `CLAUDE.md` ~368–371 vs quarantine note in `main.ts` | Current-state fact only: pull not shipping; attestation is. |

---

## Should clean — same week as launch if capacity

| # | Item | Evidence | Bite |
| --- | --- | --- | --- |
| 8 | **Comment pass: `main.ts` + CSS section headers** | ~100+ Story/Phase/E/F refs; CSS headers like `Stories 5/6`, `F4.3.x` in `sidepanel.css` | Rewrite to invariants. Drop "B1.2 bug", "Stories 5/6", "Phase 4". Keep non-obvious *why*. |
| 9 | **Shared module file tops** | `caseContext.ts`, `panelMode.ts`, `submission.ts`, `apiTypes.ts`, `messages.ts`, `activeCase.ts`, `mode.ts` open with epic archaeology | One-line purpose + locked rule; no PR numbers. |
| 10 | **Single `FillEventBody` home** | Local mirror in `src/background/api.ts` ~388–398 vs locked `apiTypes.ts` | Import from `apiTypes` (or delete local if identical). |
| 11 | **Drop `Inter` from `--mp-font` stack** | `sidepanel.css` / targets still list Inter after Geist | `"Geist", -apple-system, …` — Geist is shipped. |
| 12 | **Greeting tone** | `src/shared/greeting.ts` → `Hi, {first}` | Prefer matter-of-fact (`{first}` / email local-part) if the rest of the chrome stays dry. Update `greeting.test.ts`. |
| 13 | **Harness TD comment → real pointer** | `workbench.test.ts` cites missing `TECH-DEBT` | Point at this file or panel `TECH-DEBT.md`, or delete the dangling ref. |

---

## Later — not launch blockers

| # | Item | Note |
| --- | --- | --- |
| 14 | Split `main.ts` godfile (~5.2k) | TD-50 / SIDEPANEL-GOD — maintainability, not slop. |
| 15 | Tiny pure helpers (`greeting.ts`, `providerName.ts`) | Fine if tested; don't merge for aesthetics. |
| 16 | Count chips `border-radius: 999px` | Intentional DS exception for counts — leave. |
| 17 | Overlay soft shadow on avatar menu | Allowed per design-system `changes.md`. |
| 18 | Design-system kit under `docs/design-system/` | Reference, not product UI. |
| 19 | Panel-repo 3M residual (GEN-SILENT ops, OPA-RETIRE hosted, OPS-PURGE) | Different repo / human ops — see `.cursor/skills/minted-3m-audit/references/`. |

---

## Suggested PR sequence

1. **PR A — surface honesty:** items 1, 2, 3, 7 (CAQH pull + emoji + errors + CLAUDE).
2. **PR B — docs:** items 4, 5, 6 (README + spike + HTML comments).
3. **PR C — archaeology scrub:** items 8–13 (comments, apiTypes, Inter, greeting).

Stop rule: do not start new Train/feature work while PR A is open unless PM reorders.

---

## Acceptance (launch-ready for *this* lane)

- [ ] No emoji in user-visible strings
- [ ] No callable unfinished write path (`PULL_CAQH_FIELD` gone or hard-fails)
- [ ] README/CLAUDE describe **current** behavior only (no Stories N / empty spikes)
- [ ] Catch-all errors are specific
- [ ] Design tokens still match DS (Geist, forest primary, no card shadow) — already true; don't regress

---

*Inventoried against `main` @ `1a2ae45` (2026-08-28). Re-verify paths before coding — line numbers drift.*
