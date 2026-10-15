# form-captures

Payer forms captured by Claude with the `payer-form-capture` skill
(`.claude/skills/payer-form-capture/`), or by the `form-scraper` agent.

One file per form: `<portalKey>.capture.json`. Each file is a valid extension
`CaptureSession` (labels, selectors, control types, option vocabularies, never
values) with Claude's token **suggestions** filled in. Every decision is still
open. `chosenToken` is always `null` until a person approves a mapping in the
panel trainer.

`src/probe/formCaptures.test.ts` holds every file here to that contract.
