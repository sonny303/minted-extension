---
name: payer-form-capture
description: Capture a payer enrollment/credentialing web form with Claude — walk it in a browser (the user's own logins), scan its fields with the extension's own scanner (shape only, never values), suggest Minted Panel token mappings, and write a reviewable capture file under form-captures/. Use when the user gives a payer form/portal URL and asks to capture, scrape, compile, inventory, or map its fields, or to "train" a form with Claude instead of the extension.
---

# Payer form capture (Claude-driven)

Produces `form-captures/<portalKey>.capture.json` — a **valid extension
`CaptureSession`** (it round-trips through `parseCaptureSession`,
`src/shared/capture.ts`) with Claude's token *suggestions* filled in and every
decision left to a human. Same rules as the extension's Train-forms capture:

- **Shape only, never values.** Labels, selectors, control types, option
  vocabularies. Never type, select, or read a value. The probe enforces this;
  don't add a second scanner of your own.
- **Never submit a form.** Not the final Submit, not "Save", not "Finish".
- **Suggest, never decide.** `suggestedToken` + `evidence` only. `chosenToken`
  stays `null`, `sent` stays `false`. Approval happens in the panel trainer.
- **Never write to the panel.** No API calls, no Supabase. The capture file is
  the whole output.

## 0. Before starting

1. `npm run build:probe` → `dist-probe/capture-probe.js` (~11 KB IIFE built from
   `src/probe/captureProbe.ts`, which wraps `scanCapturableFields`). Rebuild
   whenever `src/content/captureScan.ts` changes.
2. Get from the user (ask once, together): the form URL, the payer, and the
   panel `portal_key` if the form is already registered. Unregistered → use a
   provisional key `<payer-slug>-<form-slug>` and set
   `"portalKeyStatus": "provisional"` (registering it in the `portals` table is
   a deploy prerequisite before the extension can fill it).

## 1. Pick the browser

| Situation | Browser |
|---|---|
| Public form (Qualtrics, Jotform, Smartsheet, Google Forms, public PDF intake) | Built-in browser (`mcp__Claude_Browser__*`) — default |
| Login-gated portal the user is already signed into in Chrome (Availity, CAQH, payer provider portals) | Claude in Chrome (`mcp__claude-in-chrome__*`) — "using my logins" |
| Login-gated, user prefers the in-app pane | Built-in browser; the user signs in once there, the session persists |

**Credentials are the user's to enter.** Never type a password, MFA code, or
security answer, and never solve a CAPTCHA or click past a bot gate (Qualtrics
"Click the button to continue" carries a reCAPTCHA frame). Stop, say exactly
what to click/sign in to, and for the built-in browser call `tabs_context`
first — if the pane is hidden, ask the user to press Cmd+Shift+B.

**Scored bot gates refuse the built-in pane outright.** The pane is an
automation-controlled browser, and reCAPTCHA v3/Enterprise scores it as a bot
even when the human clicks. Recognise it: the probe's `frames` include
`google.com/recaptcha/…`, the page asks to "click the button to continue", and
the console shows `shouldAutoStart {passed: false}` after a
`getRecaptchaAssessment` POST (Qualtrics; seen on BlueKC 2026-10-14). Don't
retry or reload in a loop. Switch to Claude in Chrome on the user's real
profile, or have the trainer use the extension's own Train-forms capture on
that page, which no bot check sees.

## 2. Probe each page

Read `dist-probe/capture-probe.js` and run it with `javascript_tool`, appending
one expression:

```
<contents of dist-probe/capture-probe.js>
window.__mintedCaptureProbe.scan()
```

On an SPA (Qualtrics, React portals) the probe survives page changes: after the
first injection run only `window.__mintedCaptureProbe.scan()`; re-inject if
that throws. The result:

```
{ probeVersion: 2, url (no query), title, heading, platform ("qualtrics"|null),
  fingerprint: { keys[], hash },          // page identity — QIDs on Qualtrics
  navigation: [{ kind, caption, selector, disabled }],   // page buttons
  submitWarning,                          // page copy says its Next SUBMITS
  dialogs:    [{ text, actions: [{ kind: "dismiss", … }] }],
  errors:     [{ message, selector|null, question|null }], // validation = gate
  frames[], fields[] }
fields[i] = { label, selector, fieldType, formSection, options?, sortOrder, required }
kind ∈ advance | back | submit | save | dismiss | other
```

`kind: "submit"` is classified by **caption first** (a Qualtrics last page keeps
`#NextButton` but says "Submit"), and then by **page copy**: a page that says
'Click "Next" … to submit' (BlueKC's last page — the button still reads
"Next") reports its advance as `submit` with `submitWarning: true`. An
uncaptioned button whose id/class says submit/finish is `submit` too, and an
empty `aria-label` falls through to the text (PrimeFaces CommandButtons render
`aria-label=""` — BCBSKS's Submit read as `other` before that fix). Never click
a `submit`, whatever its id or caption.

**Getting a big result out of Claude in Chrome.** Its `javascript_tool` result
is cut at about 1 KB, so a long form (BCBSKS: 108 fields, two 855-option
taxonomy lists) can't be read back in one call. Write a compact listing into a
temporary `<article>` and read it with `get_page_text` (no cut), then remove
it. For the full rows, when the form is server-rendered, save its static HTML
and replay the same `dist-probe/capture-probe.js` in jsdom. Use the replay's
fields only if they hash byte-identical to the live scan (FNV over
`JSON.stringify(fields)`, computed in the page). Take `navigation` from the
live page, because script-added buttons aren't in the static HTML.

**PrimeFaces / JSF (`.faces`).** Answers redraw panels through AJAX
(`PrimeFaces.ab(… u: "…Panel")` in an `onchange`). Grep the page for those
calls to find every answer that reveals, hides, disables, or flips `required`
on other fields. A disabled field isn't a removed one, so the fingerprint
doesn't change. After each change, wait for `pfAjaxComplete` instead of
sleeping. A `SelectManyMenu` (`<select multiple>` that PrimeFaces renders as
0×0 beside a clickable list) is captured as one `select` row: the backing
select's selector, judged visible by its list, with every option. A token value
names ONE option, and the fill adds it without clearing others. So a
pick-several list is usually `human`.

- `fields: []` with a non-empty `frames` → the form lives in an iframe. A
  same-origin frame: navigate the tab to the frame URL and re-probe. A
  cross-origin one you can't open directly: record it in `notes` and fall back
  to the extension capture, which injects per frame.
- Closed shadow roots are unreachable (same as the extension). Note it.
- A label that's empty or generic ("Other", "Please specify") — look at the
  page text around the selector (`find`/`read_page`) and put a readable name in
  `displayLabel`; keep the probe's `label` untouched (it's the payer's text).

## 3. Walk the pages — ask before advancing

Advancing is not neutral: Qualtrics/Jotform "Next" posts the page to the
payer's server (a partial response) and forced-response questions block it
when empty. So:

1. Probe the first page, show the user the field count + page actions.
2. **Ask once per form** whether to click Next/Continue to walk the remaining
   pages (never the final Submit). If the walk needs answers to get past
   forced-response or to reveal branches, list the choice questions you'd
   answer and the neutral option you'd pick, and ask. Never type into text
   fields to get past validation; never pick an answer that attests to
   something.
3. For each page: probe, record `pageStep` (the page heading, or `Page N` when
   it has none — matches the extension's naming), and note which earlier answer
   revealed it in `pages[].reachedBy`.
4. Fields that only appear after an answer on the same page: probe again after
   the user (or you, with their OK) picks it; tag the new rows with
   `"revealedBy": "<question> = <option>"`.
5. **Re-probe before every click** and click only a control whose `kind` is
   `advance` (or `dismiss` for an informational popup). A page with
   `submitWarning: true` ENDS the walk: record it with `advance: null`, read
   its copy to the user, and leave the submit to them.
6. **Record the walk as data**, so a future runner can replay it — every click
   you make is recorded, never left in the conversation:
   - Click the `advance` action from `navigation`, then probe until the
     fingerprint changes or `errors`/`dialogs` appear — poll (a few seconds
     apart, ~15 s total), never one fixed sleep: an unchanged fingerprint with
     no errors means still loading, not refused. If the fingerprint didn't
     change and `errors` is non-empty, the page refused:
     each error becomes a gate in `advance.requires` (`kind: "answer"` for
     radio/select/checkbox, `"nonEmpty"` for text, `"uncapturable"` with
     `selector: null` + the error's `question` when the required answer has no
     input — a canvas signature pad). Ask the user before answering anything
     to get past it.
   - Where Next goes is a list, `advance.routes: [{ branch, leadsTo,
     condition? }]`. `branch` holds the choices that decide the path, as
     `{ selector, option }` (the option's `value`, never typed text) or
     `{ selector, notOption }` when the walk only knows "anything but X".
     When the next page's probe shows a new fingerprint, set that route's
     `leadsTo` to the hash.
   - **Branch points.** When the user goes Back and changes an answer and a
     different page follows, ADD a route — never overwrite the first — and
     name the new page with a suffix (`Page 17a` / `Page 17b`). Two routes to
     different pages must each carry a `branch`. If you only infer which
     option the user picked (you never read selections), say so in
     `condition` and confirm with the user.
   - A question with no capturable control — a canvas signature pad, a file
     upload whose `<input type=file>` only exists after a click (Qualtrics) —
     goes in `uncapturedQuestions` (`kind`: signature | file | widget, with
     `required` from the refused-Next errors). Never click an upload button.
   - A **soft-required** question (Qualtrics "Response Requested … Continue
     Without Answering / Answer the Question") is not a gate: leave it out of
     `requires`, and record the popup in `interstitials` with
     `dismissSelector` (answer) and `proceedSelector` (skip). Skipping a
     requested answer is the user's call — ask.
   - A dialog that interrupts (e.g. Qualtrics "Your session was outdated…"
     when the user has the same survey open in another tab) goes in
     `interstitials` with its dismiss action's selector. Dismiss it only if
     it's informational.

## 4. Suggest mappings

Use `token-catalog.md` (this folder) — the web-fillable families only. For each
row set:

- `suggestedToken` — a bare `family.field` key, or `null`.
- `evidence` — one line, prefixed `Claude:`, naming the label/option cue
  (`"Claude: label 'Individual NPI' → provider.npi"`).
- `decision` — `token` | `fixed` (same answer every time for this org, e.g.
  "Are you contracting as a group?" → put the answer in `suggestedValue`) |
  `human` (attestations, signatures, uploads, free-text explanations,
  case-specific questions) | `undecided`.
- `confidence` — `high` (unambiguous label), `medium` (needs a glance:
  group vs individual NPI, home vs practice address), `low` (guess).

Rules that bite:
- A **repeated label** ("Address", "Phone") is mapped by `formSection`/heading,
  never by label alone — the panel refuses to learn from non-unique labels too.
- **Group vs individual**: "Group/Billing/Type 2 NPI" → `group.npiType2`;
  "Individual/Rendering/Type 1 NPI" → `provider.npi`. TIN/EIN → `group.tin`.
- **Practice/service location** → `facility.*`; **mailing/correspondence** →
  `group.correspondence*`; **billing/pay-to** → `group.billing*`;
  **credentialing contact** → `credentialingContact.*`; the person filling the
  form → `user.*`.
- Selects/radios: map only if the token's values plausibly match the option
  vocabulary (state selects → `*.state` ok; a "Specialty" select of 200 payer
  codes → `human` unless the options match `provider.specialty`). Say so in
  `evidence`.
- File uploads, signatures, e-sign checkboxes, "I attest…" → `human`, always.
- Never suggest `payer.*`, `contract.*`, `mso.*` (no fill resolves them).

## 5. Write the capture file

`form-captures/<portalKey>.capture.json`:

```json
{
  "format": "minted.form-capture/v1",
  "portalKey": "bluekc-qualtrics-enrollment",
  "portalKeyStatus": "provisional",
  "templateStepId": null,
  "startedAt": "<ISO now>",
  "payer": "Blue KC",
  "formUrl": "<origin + path, no query>",
  "platform": "qualtrics",
  "capturedWith": { "probeVersion": 2, "browser": "chrome" },
  "pages": [{
    "pageStep": "Page 2", "heading": null, "reachedBy": "…",
    "fingerprint": { "keys": ["QID180", "QID185"], "hash": "1a2b3c4d" },
    "navigation": [{ "kind": "advance", "caption": "Next", "selector": "#NextButton", "disabled": false }],
    "advance": {
      "selector": "#NextButton",
      "requires": [
        { "selector": "#QR\\~QID185", "question": "QID185", "kind": "nonEmpty", "message": "Please answer this question." },
        { "selector": null, "question": "QID92", "kind": "uncapturable", "message": "Please answer this question." }
      ],
      "routes": [
        { "branch": [], "leadsTo": "<next page fingerprint hash, or null if not walked>" }
      ]
    },
    "interstitials": [{ "text": "Your session was outdated…", "dismissSelector": "…" }],
    "uncapturedQuestions": [{ "question": "QID92", "kind": "signature", "required": true, "text": "…" }],
    "readyOnceApproved": false,
    "automationBlockers": ["Provider/Submitter Name: human"]
  }],
  "notes": ["…"],
  "rows": [{
    "label": "…", "selector": "…", "fieldType": "text", "formSection": null,
    "options": [], "pageStep": "Page 1", "sortOrder": 0, "required": true,
    "origin": "auto_detected", "displayLabel": null,
    "suggestedToken": "provider.npi", "evidence": "Claude: …",
    "decision": "token", "confidence": "high",
    "chosenToken": null, "sent": false
  }]
}
```

`sortOrder` restarts at 0 on each page (it's the position within the page).
`options` hold the **full** vocabulary — the probe is uncapped. The extension's
own capture and the panel's write boundary still cap lists at 1000
(`CONTROL_OPTIONS_CAP`, a longer list is rejected), so note any row over 1000
when handing a capture to the trainer.
Selectors are the probe's, verbatim — the scanner's selector IS the row's key.
`advance` is `null` only on the final (submit) page. On a page you couldn't get
past, keep `advance` with its `requires` and a route with `leadsTo: null` — the
gates are the most useful thing the walk learned there.

**Readiness is computed, never declared.** `readyOnceApproved` is true only
when the page has an `advance`, every row on it is `token`/`fixed` at `high`
confidence, every gate is on a captured row, and no soft-required popup asks
for an answer the runner would have to skip; otherwise list why in
`automationBlockers`. It means "a runner could take this page once these
suggestions are approved as-is" — nothing runs today, and the test recomputes
the flag and fails if it disagrees. Automating Next is a future product
decision: on Qualtrics every Next posts the page to the payer.

Then run `npx vitest run src/probe` — `formCaptures.test.ts` checks every
capture file round-trips through `parseCaptureSession`, uses only catalog
families, leaves decisions to humans, carries no values, advances only through
`advance` controls, ties gates/branches to captured fields, and states
readiness exactly as computed.

## 6. Report

Tell the user: pages walked, fields found, how many have a high-confidence
suggestion, the `human`/`undecided` rows they need to look at, and anything you
couldn't reach (cross-origin frames, unanswered branches, closed shadow DOM).
Point them at the panel trainer
(`/admin/payer-admin/setup/{payerId}?tab=templates`) for approval — that is
where a suggestion becomes a fill.
