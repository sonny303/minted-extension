// The DOM fill engine. Runs inside the portal page, receives fully resolved
// instructions (selector + final value), and applies them defensively: every
// field is wrapped so one bad selector or odd widget skips-and-reports
// instead of aborting the run. Nothing here reads storage, fetches, or sees
// anything beyond the values it is handed.
import type {
  FillInstruction,
  FillPageResult,
  ReportedField,
  ReportedFieldKind,
} from "../shared/fill";
import {
  isOtherPageInstruction,
  otherPageReport,
  resolveFillPage,
} from "../shared/fillPage";
import { FIELD_NOT_FOUND_REASON } from "../shared/fixit";
import { pageScopeMatches } from "../shared/pageScope";
import { HIDDEN_KIND, HIDDEN_REASON } from "../shared/hiddenField";
// DYN-PAGE-02 — the SAME "positively hidden" rule the scanner uses, shared
// rather than copied so the two surfaces can never disagree about what an
// inactive wizard panel looks like. The scanner's extra zero-box filter is
// deliberately NOT applied here; see isHiddenControl's own comment.
import { isHiddenControl } from "./captureScan";
import { FILLABLE, querySelectorAllDeep, querySelectorDeep } from "./deepDom";

// Label text comparison: case- and whitespace-insensitive, trailing
// colons/required-markers stripped ("First Name *" matches "First Name").
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s:*]+$/, "");
}

export type Fillable = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function asFillable(el: Element | null): Fillable | null {
  return el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
    ? el
    : null;
}

function controlForLabel(label: HTMLLabelElement): Fillable | null {
  const control =
    asFillable(label.control) ??
    (label.htmlFor
      ? asFillable(querySelectorDeep(`#${CSS.escape(label.htmlFor)}`))
      : null) ??
    asFillable(querySelectorDeep(FILLABLE, label));
  return control;
}

/** The `label:` prefix the shared library uses for label-addressed maps. */
export const LABEL_SELECTOR_PREFIX = "label:";

// "label:First Name" → the form control belonging to the label whose full
// text matches exactly (after normalization). Exact match is deliberate: the
// portal has both "First Name" and "Provider's First Name".
//
// Also matches custom hosts that expose the caption via `label` / `aria-label`
// (Litehouse `<lh-input label="…">`) and resolve a fillable in their shadow.
//
// EXPORTED so the Selector Workshop resolves a label-addressed selector the
// same way the fill does. It used to run raw querySelectorAll, which cannot
// parse `label:…` at all — so every library field stored that way tested as
// "matches nothing" and read as drift on a page where it fills perfectly.
export function byLabel(text: string): Fillable | null {
  const want = normalize(text);
  for (const label of querySelectorAllDeep("label")) {
    if (!(label instanceof HTMLLabelElement)) continue;
    if (normalize(label.textContent ?? "") !== want) continue;
    const control = controlForLabel(label);
    if (control) return control;
  }
  // Host-attribute labels (no <label> element in the light DOM).
  for (const host of querySelectorAllDeep("[label], [aria-label]")) {
    const hostText =
      host.getAttribute("label")?.trim() ||
      host.getAttribute("aria-label")?.trim() ||
      "";
    if (normalize(hostText) !== want) continue;
    const root: ParentNode = host.shadowRoot ?? host;
    const control = asFillable(querySelectorDeep(FILLABLE, root));
    if (control) return control;
  }
  return null;
}

function bySelector(selector: string): Fillable | null {
  try {
    return asFillable(querySelectorDeep(selector));
  } catch {
    return null; // invalid CSS selector — treated as not found
  }
}

function resolveTarget(instruction: FillInstruction): Fillable | null {
  for (const selector of [
    instruction.selector,
    ...instruction.selectorFallbacks,
  ]) {
    const target = selector.startsWith("label:")
      ? byLabel(selector.slice("label:".length))
      : bySelector(selector);
    if (target) return target;
  }
  return null;
}

// Set an input's value through the prototype setter so framework-controlled
// inputs (React / Lit et al.) see the change, then fire the events the page's
// own validation listens for — including composed so listeners outside a
// shadow root still hear the change.
function setNativeValue(el: Fillable, value: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor?.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }
  fireChanged(el);
}

function fireChanged(el: HTMLElement): void {
  const init: EventInit = { bubbles: true, composed: true, cancelable: true };
  el.dispatchEvent(new Event("input", init));
  el.dispatchEvent(new Event("change", init));
}

/**
 * US-5.3 — reset the form so the next sandbox fill starts clean.
 *
 * Values go back through the SAME native setter the fill uses, so a
 * framework-controlled input (React et al.) actually sees the clear and the
 * page's own validation re-runs; a plain `el.value = ""` would leave the
 * framework's state untouched and the field would snap back.
 *
 * Only the panel's sandbox surface can reach this — the button does not exist
 * outside sandbox mode — because on a live portal it would wipe a
 * coordinator's real typing. Returns how many controls it reset so the panel
 * can report rather than claim.
 */
export function clearPortalForm(): number {
  let cleared = 0;
  const controls = querySelectorAllDeep(FILLABLE);
  for (const node of controls) {
    const el = asFillable(node);
    if (!el) continue;
    try {
      if (
        el instanceof HTMLInputElement &&
        (el.type === "checkbox" || el.type === "radio")
      ) {
        if (!el.checked) continue;
        el.checked = false;
        fireChanged(el);
      } else if (el instanceof HTMLSelectElement) {
        if (el.selectedIndex <= 0 && el.value === "") continue;
        // Index 0 is the placeholder on a portal select; -1 (nothing chosen)
        // is the honest reset when there is no placeholder to fall back to.
        el.selectedIndex = el.options.length > 0 ? 0 : -1;
        fireChanged(el);
      } else {
        if (el.value === "") continue;
        setNativeValue(el, "");
      }
      cleared += 1;
    } catch {
      // One stubborn widget must not abort the reset of the rest.
    }
  }
  return cleared;
}

function labelTextOf(input: HTMLInputElement): string {
  const label = input.labels?.[0] ?? input.closest("label");
  return label?.textContent ?? "";
}

type ApplyOutcome =
  | { ok: true; changed: boolean; target: Fillable; expectedValue: string | boolean }
  | { ok: false; reason: string; kind?: ReportedFieldKind; target?: Fillable };

/** DYN-PAGE-02 — the control resolved but sits in an inactive panel, so the
 * fill declines to write it. Never drift: the selector was found. */
const HIDDEN_OUTCOME: ApplyOutcome = {
  ok: false,
  reason: HIDDEN_REASON,
  kind: HIDDEN_KIND,
};

const TRUTHY = new Set(["true", "yes", "y", "1", "x", "on", "checked"]);

/** Sample size for skip-reason lines (E6.10 F6.10.6 / OQ-3). */
const OPTION_SAMPLE_SIZE = 3;

function optionValuesSample(values: readonly string[]): string {
  const nonempty = values.filter((v) => v !== "");
  if (nonempty.length === 0) return "";
  const shown = nonempty.slice(0, OPTION_SAMPLE_SIZE);
  const extra = nonempty.length - shown.length;
  const body = shown.join(", ");
  return extra > 0 ? `${body}; ${extra} more` : body;
}

function vocabularyMismatchReason(
  kind: "dropdown" | "radio",
  attempted: string,
  optionValues: readonly string[],
): string {
  const sample = optionValuesSample(optionValues);
  const base = `${kind}: no option matches "${attempted}"`;
  return sample ? `${base} (${sample})` : base;
}

function applyRadio(el: HTMLInputElement, value: string): ApplyOutcome {
  const want = normalize(value);
  const group = el.name
    ? querySelectorAllDeep(
        `input[type="radio"][name="${CSS.escape(el.name)}"]`,
        el.form ?? document,
      ).filter((node): node is HTMLInputElement => node instanceof HTMLInputElement)
    : [el];
  const match = group.find(
    (radio) =>
      normalize(radio.value) === want || normalize(labelTextOf(radio)) === want,
  );
  if (!match) {
    return {
      ok: false,
      reason: vocabularyMismatchReason(
        "radio",
        value,
        group.map((radio) => radio.value),
      ),
    };
  }
  if (match.matches(":disabled")) {
    return { ok: false, reason: "field is disabled or read-only" };
  }
  // The visibility guard belongs HERE, not on the resolved element: a radio
  // group is one field made of N controls, and `match` — the one that gets
  // clicked — need not be the one the selector resolved to.
  if (isHiddenControl(match)) return HIDDEN_OUTCOME;
  const changed = !match.checked;
  if (changed) match.click();
  if (!match.checked) return { ok: false, reason: "field did not retain the requested value", target: match };
  return { ok: true, changed, target: match, expectedValue: true };
}

function applyCheckbox(el: HTMLInputElement, value: string): ApplyOutcome {
  const wantChecked = TRUTHY.has(normalize(value));
  const changed = el.checked !== wantChecked;
  if (changed) el.click();
  if (el.checked !== wantChecked) {
    return { ok: false, reason: "field did not retain the requested value", target: el };
  }
  return { ok: true, changed, target: el, expectedValue: wantChecked };
}

function applySelect(el: HTMLSelectElement, value: string): ApplyOutcome {
  const options = Array.from(el.options);
  const match =
    options.find((option) => option.value === value) ??
    options.find((option) => normalize(option.text) === normalize(value)) ??
    options.find((option) => normalize(option.value) === normalize(value));
  if (!match) {
    return {
      ok: false,
      reason: vocabularyMismatchReason(
        "dropdown",
        value,
        options.map((option) => option.value),
      ),
    };
  }
  const changed = el.value !== match.value;
  if (changed) {
    el.value = match.value;
    fireChanged(el);
  }
  if (el.value !== match.value) {
    return { ok: false, reason: "field did not retain the requested value", target: el };
  }
  return { ok: true, changed, target: el, expectedValue: match.value };
}

function applyValue(el: Fillable, instruction: FillInstruction): ApplyOutcome {
  const isRadio = el instanceof HTMLInputElement && el.type === "radio";
  // DYN-PAGE-02 — never mutate a control the coordinator cannot see. A wizard
  // that keeps every step in the DOM and hides the inactive ones would
  // otherwise take a silent write into a panel nobody reviews before
  // submitting. Radio defers its own check to applyRadio, which knows which
  // group member is actually about to be clicked.
  if (!isRadio && isHiddenControl(el)) return HIDDEN_OUTCOME;
  if (el instanceof HTMLSelectElement)
    return applySelect(el, instruction.value);
  if (isRadio) {
    return applyRadio(el as HTMLInputElement, instruction.value);
  }
  if (el instanceof HTMLInputElement && el.type === "checkbox") {
    return applyCheckbox(el, instruction.value);
  }
  if (el instanceof HTMLInputElement && el.type === "file") {
    // Belt and braces: the background never plans file fields.
    return { ok: false, reason: "file inputs cannot be filled" };
  }
  if (el instanceof HTMLInputElement && (el.disabled || el.readOnly)) {
    return { ok: false, reason: "field is disabled or read-only" };
  }
  const changed = el.value !== instruction.value;
  setNativeValue(el, instruction.value);
  if (el.value !== instruction.value) {
    return { ok: false, reason: "field did not retain the requested value", target: el };
  }
  return { ok: true, changed, target: el, expectedValue: instruction.value };
}

function installFillStyle(el: Element): void {
  const root = el.getRootNode();
  const styleId = "__minted-panel-fill-style";
  const existing = root instanceof ShadowRoot
    ? root.getElementById(styleId)
    : document.getElementById(styleId);
  if (existing) return;
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = [
    ".mp-fill-static{outline:2px solid #15803d!important;outline-offset:2px}",
    ".mp-fill-ai{outline:2px solid #d97706!important;outline-offset:2px}",
  ].join("\n");
  if (root instanceof ShadowRoot) root.append(style);
  else (document.head ?? document.documentElement).append(style);
}

export function decorateFill(el: Fillable, kind: "static" | "ai", token?: string): void {
  installFillStyle(el);
  el.classList.add(kind === "ai" ? "mp-fill-ai" : "mp-fill-static");
  if (kind === "ai" && token) el.setAttribute("title", `AI Suggested: ${token}`);
}

/** Write once a content-local scan has verified the exact empty target. */
export function applyAiValue(
  el: Fillable,
  value: string,
): { ok: true; changed: boolean; target: Fillable; writtenValue: string } | { ok: false; reason: string } {
  if (isHiddenControl(el) || el.matches(":disabled")) {
    return { ok: false, reason: "field is hidden or disabled" };
  }
  if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly) {
    return { ok: false, reason: "field is read-only" };
  }
  if (el instanceof HTMLInputElement && ["button", "file", "hidden", "image", "password", "reset", "submit"].includes(el.type)) {
    return { ok: false, reason: "field type is not supported" };
  }
  const isRadio = el instanceof HTMLInputElement && el.type === "radio";
  if (isRadio) {
    const group = el.name
      ? querySelectorAllDeep(`input[type="radio"][name="${CSS.escape(el.name)}"]`, el.form ?? document)
          .filter((node): node is HTMLInputElement => node instanceof HTMLInputElement)
      : [el];
    if (group.some((radio) => radio.checked)) return { ok: false, reason: "field already has a value" };
  } else if (el instanceof HTMLInputElement && el.type === "checkbox") {
    if (el.checked) return { ok: false, reason: "field already has a value" };
    if (!TRUTHY.has(normalize(value))) return { ok: false, reason: "suggestion does not require a write" };
  } else if (el.value !== "") {
    return { ok: false, reason: "field already has a value" };
  }
  const previousValue: string | boolean =
    el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")
      ? el.checked
      : el.value;

  const fieldType = el instanceof HTMLSelectElement
    ? "select"
    : el instanceof HTMLInputElement && el.type === "radio"
      ? "radio"
      : el instanceof HTMLInputElement && el.type === "checkbox"
        ? "checkbox"
        : "text";
  const outcome = applyValue(el, {
    mapId: "ai-suggestion",
    label: "AI suggestion",
    selector: "",
    selectorFallbacks: [],
    fieldType,
    value,
    pageStep: null,
    kind: "ai",
  });
  if (!outcome.ok) {
    if (outcome.target) {
      const currentValue: string | boolean =
        outcome.target instanceof HTMLInputElement &&
        (outcome.target.type === "radio" || outcome.target.type === "checkbox")
          ? outcome.target.checked
          : outcome.target.value;
      // Restore only while the rejected value remains the immediate result of
      // this write; later user edits are never overwritten by the caller.
      if (currentValue !== previousValue) restoreAiValueWithoutEvents(outcome.target, previousValue);
      return { ok: false, reason: "AI write did not read back" };
    }
    return { ok: false, reason: outcome.reason };
  }
  const writtenValue = String(outcome.expectedValue);
  return { ...outcome, writtenValue };
}

function restoreAiValueWithoutEvents(el: Fillable, value: string | boolean): void {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    el.checked = value === true;
    return;
  }
  const next = typeof value === "string" ? value : "";
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
  if (descriptor?.set) descriptor.set.call(el, next);
  else el.value = next;
}

export function restoreAiValue(el: Fillable, previous: string | boolean): void {
  if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
    el.checked = previous === true;
    fireChanged(el);
    return;
  }
  setNativeValue(el, typeof previous === "string" ? previous : "");
}

// The page's fillable controls — the denominator for honest coverage
// reporting ("filled 3 of 24 mapped · ~117 fields on this page").
function countPageFields(): number {
  return querySelectorAllDeep(FILLABLE).length;
}

export function applyFill(instructions: FillInstruction[]): FillPageResult {
  return applyFillOnPage(
    instructions,
    typeof location !== "undefined" ? location.href : null,
  );
}

/** Apply instructions against an explicit page URL. Exported for unit tests;
 * production always goes through `applyFill` → `location.href`. */
export function applyFillOnPage(
  instructions: FillInstruction[],
  pageUrl: string | null,
): FillPageResult {
  const filled: string[] = [];
  const writes: NonNullable<FillPageResult["writes"]> = [];
  const skipped: ReportedField[] = [];
  // Exact URL-tail identity only. Ambiguous / missing → null → every
  // instruction is attempted and unresolved selectors stay ordinary drift.
  const currentPage = resolveFillPage(
    pageUrl,
    instructions.map((i) => i.pageStep),
  );
  for (const instruction of instructions) {
    try {
      if (isOtherPageInstruction(instruction, currentPage)) {
        skipped.push(otherPageReport(instruction));
        continue;
      }
      if (!pageScopeMatches(instruction.pageUrlScope, pageUrl)) {
        skipped.push({
          label: instruction.label,
          reason: "mapping is scoped to a different page",
          mapId: instruction.mapId,
          kind: "other_page",
        });
        continue;
      }
      const target = resolveTarget(instruction);
      if (!target) {
        skipped.push({
          label: instruction.label,
          reason: FIELD_NOT_FOUND_REASON,
          mapId: instruction.mapId,
          kind: "skipped",
        });
        continue;
      }
      const outcome = applyValue(target, instruction);
      if (outcome.ok) {
        filled.push(instruction.label);
        if (outcome.changed) {
          const kind = instruction.kind ?? "static";
          decorateFill(outcome.target, kind, instruction.token);
          writes.push({
            selector: instruction.selector,
            kind,
            ...(instruction.token ? { token: instruction.token } : {}),
            ...(instruction.confidence != null ? { confidence: instruction.confidence } : {}),
          });
        }
      } else {
        skipped.push({
          label: instruction.label,
          reason: outcome.reason,
          mapId: instruction.mapId,
          // Explicit, so a producer kind (hidden) survives; the rest state the
          // "skipped" the panel would have defaulted them to anyway.
          kind: outcome.kind ?? "skipped",
        });
      }
    } catch (error) {
      skipped.push({
        label: instruction.label,
        reason: `error applying value: ${error instanceof Error ? error.message : String(error)}`,
        mapId: instruction.mapId,
      });
    }
  }
  return { filled, writes, skipped, pageFields: countPageFields() };
}
