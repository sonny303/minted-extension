# form-captures

Payer forms captured by Claude with the `payer-form-capture` skill
(`.claude/skills/payer-form-capture/`), or by the `form-scraper` agent.

One file per form: `<portalKey>.capture.json`. Each file is a valid extension
`CaptureSession` (labels, selectors, control types, option vocabularies, never
values) with Claude's token **suggestions** filled in. Every decision is still
open. `chosenToken` is always `null` until a person approves a mapping in the
panel trainer.

`src/probe/formCaptures.test.ts` holds every file here to that contract.

## Loading a capture into Minted Panel

In the extension: **Train forms** → pick the payer and the form (registered in
the panel's `portals` table) → open the form → **Import file** → choose the
`.capture.json` → review → **Send for approval**. That proposes every row to
the shared library through the usual propose-only route; nothing is approved
and no suggested token is sent. Approve mappings in the panel's template
editor. A row whose option list is over the panel's cap is held, with the
reason, and sent on a later Send once the cap allows it.
