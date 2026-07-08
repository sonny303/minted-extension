// The DOM fill engine. Runs inside the portal page, receives fully resolved
// instructions (selector + final value), and applies them defensively: every
// field is wrapped so one bad selector or odd widget skips-and-reports
// instead of aborting the run. Nothing here reads storage, fetches, or sees
// anything beyond the values it is handed.
import type { FillInstruction, FillPageResult, ReportedField } from "../shared/fill";

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

// "label:First Name" → the form control belonging to the label whose full
// text matches exactly (after normalization). Exact match is deliberate: the
// portal has both "First Name" and "Provider's First Name".
function byLabel(text: string): Fillable | null {
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
  for (const selector of [instruction.selector, ...instruction.selectorFallbacks]) {
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

function labelTextOf(input: HTMLInputElement): string {
  const label = input.labels?.[0] ?? input.closest("label");
  return label?.textContent ?? "";
}

type ApplyOutcome = { ok: true } | { ok: false; reason: string };

const TRUTHY = new Set(["true", "yes", "y", "1", "x", "on", "checked"]);

function applyRadio(el: HTMLInputElement, value: string): ApplyOutcome {
  const want = normalize(value);
  const scope = el.form ?? document;
  const group = el.name
    ? Array.from(
        scope.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(el.name)}"]`),
      )
    : [el];
  const match = group.find(
    (radio) => normalize(radio.value) === want || normalize(labelTextOf(radio)) === want,
  );
  if (!match) return { ok: false, reason: `no radio option matches "${value}"` };
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
  if (!match) return { ok: false, reason: `no option matches "${value}"` };
  if (el.value !== match.value) {
    el.value = match.value;
    fireChanged(el);
  }
  return { ok: true };
}

function applyValue(el: Fillable, instruction: FillInstruction): ApplyOutcome {
  if (el instanceof HTMLSelectElement) return applySelect(el, instruction.value);
  if (el instanceof HTMLInputElement && el.type === "radio") {
    return applyRadio(el, instruction.value);
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
  const filled: string[] = [];
  const skipped: ReportedField[] = [];
  for (const instruction of instructions) {
    try {
      const target = resolveTarget(instruction);
      if (!target) {
        skipped.push({
          label: instruction.label,
          reason: "field not found on this page",
          mapId: instruction.mapId,
        });
        continue;
      }
      const outcome = applyValue(target, instruction);
      if (outcome.ok) {
        filled.push(instruction.label);
      } else {
        skipped.push({ label: instruction.label, reason: outcome.reason, mapId: instruction.mapId });
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
