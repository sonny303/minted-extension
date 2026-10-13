# Form-filling architecture review: conditional fields and framework listeners

**Date:** 2026-10-13 · **Scope:** `minted-extension` content/background fill path, with the
panel's field-map service where it decides fill order · **Status:** assessment only, no code
change in this PR.

**Read with:** `src/content/fillEngine.ts`, `src/background/frameMessaging.ts`
(`applyFillAcrossFrames`), `src/content/captureScan.ts` (`selectorFor`), and the panel's
`docs/ops/dynamic-values-autofill-spike.md` (Gaps 2b, 3, 4). This review confirms that spike's
DYN-ASYNC and DYN-CONDITIONAL findings and adds what has changed since.

---

## Verdict in one screen

| Review area | Asked for | What ships today | Gap |
| --- | --- | --- | --- |
| 1. Event dispatch | `value=` then `input`/`change`; `click` for choice controls | Prototype setter, then `input` + `change` + `blur` + `focusout`, all `composed`. Radios and checkboxes use real `click()`. PrimeFaces menus are driven through their visible widget. | **Small.** No `focus()` before the write. No keyboard events except one PrimeFaces case. Validity is read synchronously, before frameworks have validated. |
| 2. Execution queue | Fill, yield, re-scan, resume | One probe snapshot per frame, then one worker→content round trip **per field**. After the first write, each later field gets one fresh probe. A field that is missing is reported once and never retried. | **This is the real gap.** No retry after a reveal, fill order is not reading order, and the settle window (700 ms cap) is shorter than most AJAX cascades. |
| 3. Mapping resiliency | Label / aria / accessibility anchors over positional paths | Capture emits `#id`, else `name[type]`, else an `nth-child` path. `label:` addressing exists in the engine but capture never emits it. `selector_fallbacks` is stored, read, and iterated by the engine, and **nothing writes it**. | **Medium.** One selector per row. Framework-generated ids (`mat-input-3`, `j_idt12:…`) win over stable names and labels. |

**Determination.** A step-and-wait queue will fix the cascade case (parent select reveals or
reloads a child in the same run). It will not, by itself, fix conditional fields, because a
conditional field hidden at capture time is usually never trained, and because a child on a
branch the provider does not take must read as "not applicable", not drift. No new abstraction
layer is needed. The existing `FillInstruction` → probe → apply → `kind`/`reasonCode` model
already is the abstraction. What it needs is: dependency-respecting order, a content-local
executor with a bounded reveal wait and one deferred retry, fallback selectors at capture, and a
guided capture path for conditional branches.

---

## 1. Event dispatching and framework integration

### What the code does (`fillEngine.ts`)

- **Text / textarea / date:** `setNativeValue` finds the `value` setter on the element's
  prototype and calls it, then `fireChanged` dispatches `input`, `change` (both `bubbles`,
  `composed`, `cancelable`), `blur`, and `focusout`. This is the correct React fix: setting
  through the prototype setter bypasses React's value tracker, so the `input` event is seen as a
  real change. It is already ahead of the reference pattern in the request.
- **Native `<select>`:** `el.value = match.value` then `fireChanged`. Options are matched value →
  normalized label → normalized value, with disabled options excluded. Correct for React, Vue
  (`v-model` listens on `change` for selects) and Angular forms.
- **Radio:** finds the group member by value or label and calls `click()`. A real click fires
  `click`, `input`, and `change` natively. Correct.
- **Checkbox:** `click()` on native inputs. Custom hosts (`cf-checkbox`, `role=checkbox`) click
  the inner control and then verify `aria-checked`/`checked`.
- **PrimeFaces SelectOneMenu:** opens the widget, clicks the visible item, waits for the label to
  match. Writing the hidden backing select alone was found to leave the widget stale.
- **Shadow DOM:** events are `composed`, so listeners outside an open shadow root hear them.

### Shortcomings that can block framework validation

1. **No focus before the write.** Angular Material, several mask libraries, and any component
   that arms its listeners on `focus`/`focusin` never see the value. Testofill's changelog cites
   exactly this fix ("focus before changing, works better with some components"). Bitwarden's
   autofill does focus → click → set → events → blur. Cost: one line per write path.
2. **No keyboard events.** Masks that listen on `keydown`/`beforeinput` (Cleave, IMask, jQuery
   Mask) do not reformat a value that arrives by setter. The engine already does this for one
   case (PrimeFaces datepicker keydown gate). The panel spike's Gap 4 asks for a named fixture
   before building a general mask path. That gate still stands. Do not add a blanket keyboard
   storm; it also trips "typed too fast" bot heuristics on some portals.
3. **Validity is read on the same tick.** `applyValue` checks `el.validity.valid` immediately.
   React state updates, Angular async validators, and Formik's debounced validation run on a
   later tick, so a field can read "valid" now and show an error 50 ms later, or the reverse. The
   125 ms post-write readback exists for dates only. Extend it to every written field (one bounded
   pass, not per field).
4. **Native `<select>` is set by assignment, not by option click.** Fine for native selects. For
   framework comboboxes rendered as `div[role=combobox]` + listbox, there is no path at all;
   they classify as `unsupported`. The spike's Gap 2c already defers that behind a named payer
   and widget library. Agree.

**Conclusion for area 1:** event dispatch is not the primary reason conditional fields stay
hidden. Items 1 and 3 are cheap and worth doing. Item 2 waits on a fixture.

---

## 2. DOM mutation lifecycle and the execution queue

### What the code does today

1. **Probe phase.** The worker sends `PROBE_FILL` with every instruction to every frame.
   `probeFillOnPage` waits for the page to settle (120 ms quiet, 700 ms cap, `aria-busy` check),
   resolves each selector, records visible/hidden/missing/ambiguous, and binds a `probeKey` to
   the exact DOM node plus a mutation version.
2. **Routing.** The worker picks the one frame where the target is unique and visible.
3. **Apply phase.** For each instruction in array order, the worker sends `APPLY_FILL` with a
   single instruction to that frame, with `requireUniqueTarget: true`. The content script
   re-resolves and refuses the write if the node, label, option set, or mutation version changed
   since the probe (`strictRevalidation`).
4. **Partial step-and-wait already exists.** After the first write,
   `priorApplyMayHaveChangedPage` turns on. Each later instruction gets one fresh single-field
   `PROBE_FILL` (which itself waits for settle) before apply, and a field that was missing in the
   original snapshot gets one fresh look. A miss after a write is reported as
   `unverified / context_changed`, not drift. That is the correct telemetry posture.

So the skeleton the request asks for is present. Four things keep it from working on conditional
forms.

### Gap 2.1: fill order is not dependency order

The extension-facing route (`handleListPortalFieldMaps` → `listLegacyClientPortalMapResolutions`)
flattens maps with **no sort**, and `PORTAL_FIELD_MAP_FILL_COLUMNS` does not select `sort_order`.
`planFill` preserves array order. So the child field is attempted before its parent whenever the
database happens to return it first. Every downstream wait is wasted when the parent has not been
answered yet.

`sort_order` is capture-time visual reading order (top→bottom, left→right), which is a good proxy
for dependency order on real forms: the question comes before the fields it reveals. The fix is
panel-side and additive: order by `page_step`, then `sort_order`, then `created_at`, and add
`sort_order` to the fill column list so the extension can apply the same stable sort locally. The
wire shape does not change; `sortOrder` is already optional on `PortalFieldMap` in
`src/shared/apiTypes.ts`.

### Gap 2.2: no retry after a reveal

A field that is `missing` or `hidden` at its turn is reported and dropped. If the parent is filled
two instructions later and reveals it, nothing comes back for it. One pass.

### Gap 2.3: the settle window is tuned for render, not for AJAX

700 ms cap. State → county, payer → plan, specialty → taxonomy cascades commonly take 1 to 3 s on
payer portals. The "quiet for 120 ms" rule also returns early during a spinner that happens to be
a CSS animation with no DOM mutation.

### Gap 2.4: one round trip per field

Each field costs `listTabFrames`, a possible `isHiddenLeafFrame` script execution, a `PROBE_FILL`
(with its own settle wait), and an `APPLY_FILL`. On a 100-field page with one revealing write
early, the worst case is 100 × 700 ms of settle waits, serialized through the worker. This is the
cost that makes a longer settle window unaffordable in the current shape.

### Recommended refactor: a content-local ordered executor

Move the per-field loop from the worker into the content script, one message per frame.

```
worker                                  content script (one frame)
──────                                  ──────────────────────────
PROBE_FILL (all, once per frame)  ───►  resolve all, bind probeKeys, report
route each map to ONE frame
APPLY_FILL_BATCH (ordered list)   ───►  pass 1: for each instruction in order
                                          resolve → unique+visible? apply
                                          structured control changed?
                                            await settle(form subtree,
                                              quiet 150 ms, cap 1.5 s)
                                          missing/hidden? → deferred[]
                                        pass 2: for each deferred
                                          await targetAppears(cap 2 s)
                                          resolve → apply, else report
                               ◄───     one FillPageResult
```

Design rules, so the move does not weaken anything that is locked:

- **Strict revalidation gets stronger, not weaker.** Today the mutation-version check guards the
  message hop between probe and apply. In a content-local loop, re-resolve and apply happen in the
  same task with no yield, so the check is trivially satisfied for pass-1 writes. For deferred
  retries, re-resolve immediately before the write and apply the same uniqueness, label, and
  option-set checks. A reveal is a mutation by definition, so the version check must be scoped to
  "between my re-resolve and my write", not "since the original probe".
- **Settle waits are scoped and bounded.** Observe the control's `form` (or nearest fieldset, or
  frame document as last resort), not `documentElement`. Only wait after a write to a select,
  radio, or checkbox, or when the written input had `aria-controls` / `aria-expanded` /
  `aria-haspopup`. Text writes do not pause. Total per-run cap (e.g. 8 s) so a pathological page
  cannot hang the panel.
- **Wait for the target, not for silence.** Pass 2 uses a MutationObserver that resolves as soon
  as the deferred selector matches a visible control, with a cap. That is both faster and more
  reliable than "quiet for N ms".
- **Telemetry stays honest.** A deferred field that fills reports `verified`/`unverified` as
  normal. A deferred field still absent after the cap reports `unverified / context_changed`
  when any reveal happened in the run, and `not_found` only when the page settled and nothing
  changed. That preserves the panel's drift predicate (`isOnPageNotFound`) exactly. If the PM
  wants to see "filled after reveal" as its own signal, add a `reasonCode` panel-first in
  `src/lib/formDrift.ts` / `fillEventV2`, then mirror it. Not required for the fix.
- **Hidden guard interaction.** DYN-PAGE-02 skips a `display:none` child before its parent is
  answered. With ordering (2.1) and deferral (2.2), the child is retried after the reveal and the
  guard still refuses a write into a panel the coordinator cannot see. No change to the guard.
- **Per-frame routing is unchanged.** The worker still probes every frame once and routes each
  map to exactly one frame. It just sends the frame its whole ordered list instead of one field at
  a time.
- **No fixed sleeps.** The spike's rule. Settle and appear waits are observer-driven with caps.

### Gap 2.5: the worker loop also re-lists frames per field

`listTabFrames` + `sameFrameInventory` + `isHiddenLeafFrame` run before every dispatch. With a
batch per frame this collapses to once per frame, which also removes most of the
"a form frame could not be checked" noise on pages that add and remove helper iframes while the
user is filling.

---

## 3. Resiliency of the mapping engine

### What the code does today

- **Capture** (`selectorFor`): `#id` if any id, else `tag[type][name]` (plus `[value]` for fixed
  checkboxes), else an `nth-child` chain anchored at the nearest id-bearing ancestor.
- **Fill** (`resolveTarget`): tries `selector`, then each `selectorFallbacks` entry; supports the
  `label:<text>` prefix (exact normalized label text, host `label`/`aria-label` attributes, and
  slotted custom-host text); pierces open shadow DOM; rejects ambiguous matches instead of taking
  the first.
- **Label discovery** (`labelFor`, `radioGroupLabel`, `nearbyLabel`): `label[for]`, wrapping
  label, `aria-label`, `aria-labelledby`, host attributes, fieldset legend, then a short preceding
  caption. Used to **name** the row, not to **address** it.
- **Row identity:** `(portal_key, selector)` is the uniqueness grain, and the Selector Workshop
  tests the typed selector against the live page with a shape verdict.

This is already an anchor-based design, and it is better than any of the three reference repos
(see benchmarks). The weaknesses are narrower than "transition away from XPath".

### Gaps

1. **Fallbacks are never generated.** `selector_fallbacks` has existed since the baseline schema,
   the propose routes accept it, `planFill` reads it, and `resolveTarget` iterates it. Capture
   writes one selector and leaves the array empty. Emit a ranked list at capture: stable id,
   `name`, `label:<text>`, `[aria-label=…]` / `aria-labelledby` text, `[placeholder=…]`,
   `[data-testid]` / `[data-test]` / `[formcontrolname]`, structural path last. No wire change;
   the row key stays the primary selector.
2. **Framework ids out-rank stable anchors.** `#mat-input-3`, `#react-select-2-input`,
   `#j_idt123:j_idt456`, `#ember12`, `:r1:` style ids change on every render or deploy. Today
   `#id` always wins. Add a volatility test (trailing digit run, known framework prefixes,
   JSF colon paths) and demote such ids to a fallback behind `name` and `label:`.
3. **Re-pointing is manual.** "Check page" / "Re-point" exist and are good. With fallbacks in
   place, a primary miss that a fallback resolves should surface as a repair hint ("filled via
   fallback, primary selector stale") so the registry self-heals through the trainer instead of
   waiting for drift.
4. **Accessibility tree** is not reachable from a content script. `role`/`aria-*` attributes are
   the usable proxy and are already read for labels and hidden checks. Nothing to add here beyond
   item 1.

---

## 4. Benchmarks, honestly

| Repo | What it actually does | Relevance |
| --- | --- | --- |
| `holyjak/Testofill-chrome-extension` | Rules of CSS selector → value (Sizzle). No label lookup ("find by label?" is a TODO). React handled via `react-trigger-change`; focuses the element before changing it. No dynamic-field handling; README notes JS-activated forms need a manual re-run. | Confirms **focus-before-write**. Otherwise behind the current engine. |
| `hddevteam/smart-form-filler` | AI maps page fields to data; README describes an analysis API and that dropdown/radio/checkbox option lists are sent to the model. No published event or mutation strategy. | The option-vocabulary idea is already shipped here (E6.10). Nothing to borrow for the DOM loop. |
| `GeekyPS/Automata` | Puppeteer script for Google Forms. Short-answer fields and "click the first checkbox". No waits, no radio handling, no event story. | Not a comparable architecture. |

The more useful public references for the DOM loop are the password-manager autofill scripts
(Bitwarden, KeePassXC-browser): focus → click → synthetic key events → prototype setter →
`input`/`change` → blur, applied per field with a short per-field delay and a re-collect of the
page between passes. That is the pattern section 2 recommends, minus the key events until a
fixture proves a portal needs them.

---

## 5. Will these changes solve conditional logic natively?

| Scenario | Fixed by ordering + executor? | What else is needed |
| --- | --- | --- |
| Parent select reveals or reloads a child in the same run (cascade) | **Yes**, once the child is trained and ordered after the parent. | Nothing. |
| Child is hidden with `display:none` until the parent is answered | **Yes.** Deferred retry after the reveal; the hidden guard still protects inactive panels. | Nothing. |
| Child was never trained because capture only scans visible controls | **No.** Nothing to fill. | Guided capture: the trainer answers the question on the portal, then re-scans. `mergePageCapture` already preserves earlier rows, so this is a UX prompt plus a registry note ("revealed by …"), not an engine change. |
| Child exists only on a branch this provider does not take | **No**, and it should not. | The spike's DYN-CONDITIONAL presence policy, after the ordering and retry fixes clean the telemetry. Do not add a trainer-asserted Boolean first; the spike's objection stands. |
| Framework validation runs on a later tick and blocks submit | **Partly.** The post-pass readback catches it and reports it. | Focus-before-write fixes most; a named fixture decides whether key events are needed. |
| Custom combobox / masked input needs keyboard interaction | **No.** | Widget-specific adapter, as PrimeFaces is today. Gate on a named payer. |

**Is an alternative architecture needed?** No. The instruction model, the probe/apply split, the
page and hidden pins, and the reason-code telemetry are the right shape. A dependency-graph
schema (explicit "this field depends on that answer" rows) is not recommended: it is a trainer
assertion that goes stale, and ordering plus observer-driven retry is detection. Revisit only if
telemetry after these slices shows a class of forms where reading order is not dependency order.

---

## 6. Proposed slices

| # | Slice | Repo | Size | Wire change | Verification |
| --- | --- | --- | --- | --- | --- |
| S1 | Order extension-facing maps by `page_step`, `sort_order`, `created_at`; add `sort_order` to `PORTAL_FIELD_MAP_FILL_COLUMNS`. Extension applies the same stable sort locally when `sortOrder` is present. | panel, then extension | S | Additive (field already optional in `apiTypes.ts`) | `extensionRoutes.test.ts` order assertion; `fill.plan.test.ts` keeps order. |
| S2 | `focus()` before each write; one bounded post-pass validity and value readback for every written field (today dates only). | extension | S | None | `fillEngine.test.ts`: focus listener sees the write; a late-invalidating input reports `write_rejected`. |
| S3 | Content-local ordered executor: `APPLY_FILL_BATCH` per frame, scoped settle after structured writes, deferred retry with target-appears wait, per-run cap. Worker keeps per-frame routing and sends one batch. | extension | M | New content message only (worker ↔ content, not panel API). Telemetry codes unchanged. | jsdom fixtures: select state → async county; radio Yes → reveals text; `aria-busy` spinner. Harness test over the real background modules. |
| S4 | Capture emits ranked fallbacks; demote volatile framework ids. Surface "filled via fallback" as a repair hint. | extension (capture), panel (hint) | S/M | Additive (`selector_fallbacks` already exists) | `captureScan.test.ts` for each anchor type; re-capture ops to backfill old rows. |
| S5 | Guided conditional capture: prompt to answer and re-scan; registry note for revealed fields. | extension + panel UX | M | Additive | Manual on a named portal. |
| S6 | DYN-CONDITIONAL presence policy, from clean telemetry after S1–S3. | panel | spike first | TBD | Per the existing spike. |

S1 and S2 are safe to build now. S3 is the one that needs a named payer and a reproducible
fixture before tuning the caps; the spike's entry gate still applies. S4 can run in parallel with
S3. S5 and S6 wait for S3's telemetry.

---

## 7. Open questions for the PM (multiple choice)

1. **Which portal is the fixture for S3?**
   (a) the PrimeFaces state → county portal already in the test suite, (b) an Availity iframe
   shell with a reveal, (c) a Litehouse/BCBSNC shadow-DOM form, (d) all three, in that order.
2. **Settle and retry caps.** (a) 1.5 s per structured write, 2 s per deferred field, 8 s per run
   (recommended), (b) tighter: 1 s / 1 s / 5 s, (c) looser: 3 s / 3 s / 15 s.
3. **Telemetry for "filled after reveal".** (a) no new code; reuse existing outcomes
   (recommended for S3), (b) add a panel-first `reasonCode` so the registry can show it.
4. **Keyboard events for masks.** (a) wait for a named fixture (recommended, matches the spike),
   (b) add focus + `keydown`/`keyup` on text writes now behind a per-portal flag.
5. **S1 ordering.** (a) order by `page_step`, `sort_order`, `created_at` (recommended),
   (b) only `sort_order`, (c) also let the trainer drag-reorder in the registry.
