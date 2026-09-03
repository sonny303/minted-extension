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
import { HIDDEN_KIND, HIDDEN_REASON } from "../shared/hiddenField";
// DYN-PAGE-02 — the SAME "positively hidden" rule the scanner uses, shared
// rather than copied so the two surfaces can never disagree about what an
// inactive wizard panel looks like. The scanner's extra zero-box filter is
// deliberately NOT applied here; see isHiddenControl's own comment.
import { isHiddenControl } from "./captureScan";

// Label text comparison: case- and whitespace-insensitive, trailing
// colons/required-markers stripped ("First Name *" matches "First Name").
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s:*]+$/, "");
}

type Fillable = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function controlForLabel(label: HTMLLabelElement): Fillable | null {
  const control =
    label.control ??
    (label.htmlFor ? document.getElementById(label.htmlFor) : null) ??
    label.querySelector("input, select, textarea");
  return control instanceof HTMLInputElement ||
    control instanceof HTMLSelectElement ||
    control instanceof HTMLTextAreaElement
    ? control
    : null;
}

/** The `label:` prefix the shared library uses for label-addressed maps. */
export const LABEL_SELECTOR_PREFIX = "label:";

// "label:First Name" → the form control belonging to the label whose full
// text matches exactly (after normalization). Exact match is deliberate: the
// portal has both "First Name" and "Provider's First Name".
//
// EXPORTED so the Selector Workshop resolves a label-addressed selector the
// same way the fill does. It used to run raw querySelectorAll, which cannot
// parse `label:…` at all — so every library field stored that way tested as
// "matches nothing" and read as drift on a page where it fills perfectly.
export function byLabel(text: string): Fillable | null {
  const want = normalize(text);
  for (const label of Array.from(document.querySelectorAll("label"))) {
    if (normalize(label.textContent ?? "") !== want) continue;
    const control = controlForLabel(label);
    if (control) return control;
  }
  return null;
}

function bySelector(selector: string): Fillable | null {
  try {
    const el = document.querySelector(selector);
    return el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
      ? el
      : null;
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
// inputs (React et al.) see the change, then fire the events the page's own
// validation listens for.
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
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
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
  const controls = document.querySelectorAll<Fillable>(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea',
  );
  for (const el of controls) {
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
  | { ok: true }
  | { ok: false; reason: string; kind?: ReportedFieldKind };

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
  const scope = el.form ?? document;
  const group = el.name
    ? Array.from(
        scope.querySelectorAll<HTMLInputElement>(
          `input[type="radio"][name="${CSS.escape(el.name)}"]`,
        ),
      )
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
  // The visibility guard belongs HERE, not on the resolved element: a radio
  // group is one field made of N controls, and `match` — the one that gets
  // clicked — need not be the one the selector resolved to.
  if (isHiddenControl(match)) return HIDDEN_OUTCOME;
  if (!match.checked) match.click();
  return { ok: true };
}

function applyCheckbox(el: HTMLInputElement, value: string): ApplyOutcome {
  const wantChecked = TRUTHY.has(normalize(value));
  if (el.checked !== wantChecked) el.click();
  return { ok: true };
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
  if (el.value !== match.value) {
    el.value = match.value;
    fireChanged(el);
  }
  return { ok: true };
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
  setNativeValue(el, instruction.value);
  return { ok: true };
}

// The page's fillable controls — the denominator for honest coverage
// reporting ("filled 3 of 24 mapped · ~117 fields on this page").
function countPageFields(): number {
  return document.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea',
  ).length;
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
  return { filled, skipped, pageFields: countPageFields() };
}
