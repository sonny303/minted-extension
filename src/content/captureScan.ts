// S5.2/S5.4 — capture: read the form's SHAPE off the page so an unknown
// portal can become a known one.
//
// Boundary (the PHI gate, and the reason this file is short): it collects
// LABELS, SELECTORS and CONTROL TYPES only. It never reads a control's VALUE,
// never touches the page's data, and returns nothing that could carry a
// provider's information. A captured field is "there is a box called NPI at
// this selector", never "the box says 1234567890".
import type { PortalFieldType } from "../shared/apiTypes";

export interface CapturedField {
  /** The payer's own label text, verbatim (trimmed). The server normalizes it
   * for dictionary matching; the raw text is what the human recognizes. */
  label: string;
  /** A selector that resolves this control, preferring stable identity. */
  selector: string;
  fieldType: PortalFieldType;
  /** Nearest fieldset/section heading, when the form has one. */
  formSection: string | null;
}

const FILLABLE =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';

/** True when the control has a non-zero layout box (trainer can see it).
 * JSF multi-panel forms leave inactive panels in the DOM with no rects. */
function hasLayoutBox(el: Element): boolean {
  if (el.getClientRects().length === 0) return false;
  const { width, height } = el.getBoundingClientRect();
  return width > 0 && height > 0;
}

/** Skip controls the trainer cannot meaningfully see: zero-size / no rects,
 * or an ancestor (or self) marked hidden / aria-hidden / display:none /
 * visibility:hidden. Never reads a control's value. */
export function isCapturableControl(el: Element): boolean {
  if (!hasLayoutBox(el)) return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute("hidden")) return false;
    if (node.getAttribute("aria-hidden") === "true") return false;
    const { display, visibility } = getComputedStyle(node);
    if (display === "none" || visibility === "hidden") return false;
  }
  return true;
}

function controlType(el: Element): PortalFieldType {
  if (el instanceof HTMLSelectElement) return "select";
  if (el instanceof HTMLTextAreaElement) return "text";
  if (el instanceof HTMLInputElement) {
    if (el.type === "radio") return "radio";
    if (el.type === "checkbox") return "checkbox";
    if (el.type === "date") return "date";
    if (el.type === "file") return "file";
  }
  return "text";
}

/** The most stable selector we can offer for this control, in descending
 * order of durability: a real id, then name, then a positional fallback.
 * A positional selector is the LAST resort — it is exactly the kind that
 * drifts when the form changes. */
function selectorFor(el: Element, index: number): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const name = (el as HTMLInputElement).name;
  if (name) {
    const tag = el.tagName.toLowerCase();
    return `${tag}[name="${CSS.escape(name)}"]`;
  }
  return `${el.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
}

/** The label a human would read for this control: its <label>, then aria
 * text, then placeholder. Empty when the form gives us nothing — such a field
 * is still captured (with its selector) rather than silently dropped, because
 * a human can name it in the review UI. */
function labelFor(el: Element): string {
  if (el.id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const text = explicit?.textContent?.trim();
    if (text) return text;
  }
  const wrapping = el.closest("label")?.textContent?.trim();
  if (wrapping) return wrapping;
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const target = document.getElementById(labelledBy);
    const text = target?.textContent?.trim();
    if (text) return text;
  }
  const placeholder = (el as HTMLInputElement).placeholder?.trim();
  return placeholder ?? "";
}

function sectionFor(el: Element): string | null {
  const legend = el.closest("fieldset")?.querySelector("legend")?.textContent?.trim();
  if (legend) return legend;
  const section = el.closest("section, [role='group']");
  const heading = section?.querySelector("h1, h2, h3, h4")?.textContent?.trim();
  return heading || null;
}

/** Scan the page's fillable controls into capture rows.
 *
 * Only VISIBLE controls are captured (no layout box, or hidden via attribute /
 * display / visibility ancestors, are skipped) so JSF multi-panel forms do not
 * flood the trainer with inactive-panel inputs. Radio groups collapse to ONE
 * row per name among the visible set: a payer's "Accepting new patients:
 * Yes/No" is one field to map, not two. Order is DOM order, which is the order
 * the human reads the form in. */
export function scanCapturableFields(): CapturedField[] {
  const seenRadioNames = new Set<string>();
  const fields: CapturedField[] = [];
  const controls = Array.from(document.querySelectorAll(FILLABLE));

  controls.forEach((el, index) => {
    if (!isCapturableControl(el)) return;
    const type = controlType(el);
    if (type === "radio") {
      const name = (el as HTMLInputElement).name;
      if (name) {
        if (seenRadioNames.has(name)) return;
        seenRadioNames.add(name);
      }
    }
    fields.push({
      label: labelFor(el),
      selector: selectorFor(el, index),
      fieldType: type,
      formSection: sectionFor(el),
    });
  });

  return fields;
}
