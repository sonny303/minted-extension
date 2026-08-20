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
  /** E6.10 — the control's own choices. Never the selected/checked/typed
   * value. Empty array = structured control with no options loaded; omitted
   * on text/date/file. */
  options?: { value: string; label: string }[];
}

const FILLABLE =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';

/** Max options stored per field — matches the panel write-boundary cap. */
const CONTROL_OPTIONS_CAP = 50;

/** True when the control has a non-zero layout box (trainer can see it).
 * JSF multi-panel forms leave inactive panels in the DOM with no rects. */
function hasLayoutBox(el: Element): boolean {
  if (el.getClientRects().length === 0) return false;
  const { width, height } = el.getBoundingClientRect();
  return width > 0 && height > 0;
}

/** Same-row tolerance (px): tops within this band count as one reading row
 * and sort left→right. CSS grids often place siblings a few px apart. */
const SAME_ROW_TOLERANCE_PX = 8;

/** Reading order: top→bottom, then left→right within a row. DOM tree order is
 * NOT reading order on CSS grid/flex forms (Aetna RFP put submitter/phone
 * ahead of last/first name in the tree while painting last/first first). */
export function compareVisualPosition(a: Element, b: Element): number {
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  const topDelta = ra.top - rb.top;
  if (Math.abs(topDelta) > SAME_ROW_TOLERANCE_PX) return topDelta < 0 ? -1 : 1;
  const leftDelta = ra.left - rb.left;
  if (leftDelta !== 0) return leftDelta < 0 ? -1 : 1;
  const pos = a.compareDocumentPosition(b);
  if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
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

/** A structural path to `el`, as `:nth-child()` steps from the nearest
 * id-bearing ancestor (else `body`). This is the LAST-resort selector — it is
 * exactly the kind that drifts when the form changes — but it has to actually
 * resolve, which the old `tag:nth-of-type(queryIndex)` did not: that index came
 * from the document-wide control query while `:nth-of-type` counts among a
 * parent's children, so on the Humana status form it produced
 * `input:nth-of-type(4)`, which matches ZERO elements. A selector that finds
 * nothing can never be filled and can never be re-found on re-capture. */
function structuralPath(el: Element): string {
  const steps: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body && node.parentElement) {
    const parent: HTMLElement = node.parentElement;
    const tag = node.tagName.toLowerCase();
    const position = Array.prototype.indexOf.call(parent.children, node) + 1;
    steps.unshift(`${tag}:nth-child(${position})`);
    if (parent.id) {
      steps.unshift(`#${CSS.escape(parent.id)}`);
      return steps.join(" > ");
    }
    node = parent;
  }
  return ["body", ...steps].join(" > ");
}

/** The most stable selector we can offer for this control, in descending
 * order of durability: a real id, then name (scoped by tag AND type so a
 * radio group's members don't all collapse onto the first match), then the
 * structural path above. */
function selectorFor(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const name = (el as HTMLInputElement).name;
  if (name) {
    const tag = el.tagName.toLowerCase();
    const type = el instanceof HTMLInputElement ? el.type : "";
    const typePart = type ? `[type="${CSS.escape(type)}"]` : "";
    return `${tag}${typePart}[name="${CSS.escape(name)}"]`;
  }
  return structuralPath(el);
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

/** The name to CAPTURE this control under. A radio prefers its group's
 * question over its own option text; anything the form left unlabelled falls
 * back to nearby visible text. Still possibly empty — a nameless row is
 * captured with its selector rather than dropped, and the trainer names it. */
function captureLabel(el: Element, type: PortalFieldType): string {
  if (type === "radio" && el instanceof HTMLInputElement) {
    const question = radioGroupLabel(el);
    if (question) return question;
  }
  const wired = labelFor(el);
  if (wired) return wired;
  return nearbyLabel(el);
}

/** Longest text we will adopt as a label guess. A portal's paragraph of
 * instructions is not a field name; past this it is prose, not a label. */
const NEARBY_LABEL_MAX_CHARS = 120;

function cleanLabelText(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

/** The question a RADIO GROUP is asking, which is not the same as any one
 * option's text. `labelFor` on a radio returns its own option ("Practitioner
 * certification application"), so a group captured that way is named after
 * whichever option happened to come first — the exact mis-naming seen on the
 * Humana status form, where the real question is "Please select which type of
 * certification application you would like a status on:".
 *
 * Looks only at grouping containers and their accessible names; the options
 * themselves are already preserved in `options`. */
function radioGroupLabel(el: HTMLInputElement): string {
  const group = el.closest("fieldset, [role='radiogroup']");
  if (group) {
    const legend = cleanLabelText(group.querySelector("legend")?.textContent);
    if (legend) return legend;
    const aria = cleanLabelText(group.getAttribute("aria-label"));
    if (aria) return aria;
    const labelledBy = group.getAttribute("aria-labelledby");
    if (labelledBy) {
      // aria-labelledby is a token LIST; join what resolves, in order.
      const text = labelledBy
        .split(/\s+/)
        .map((id) => cleanLabelText(document.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }
    const heading = cleanLabelText(group.querySelector("h1, h2, h3, h4, h5, h6")?.textContent);
    if (heading && heading.length <= NEARBY_LABEL_MAX_CHARS) return heading;
  }
  return "";
}

/** The visible text a human would read AS this control's name when the form
 * wires no label at all — the case that makes a captured row nameless and
 * unmappable (the Humana NPI box: its caption is a plain sibling, with no
 * `for`, no aria, no placeholder).
 *
 * Deliberately narrow. It walks previous siblings of the control and of its
 * wrapper, taking the first short run of text, and never descends into other
 * controls. It reads element TEXT only — never a control's value — so the PHI
 * boundary is unmoved. A guess is still only a guess: it is a starting point
 * the trainer can rename, which is why the edit UI exists. */
function nearbyLabel(el: Element): string {
  const ownsAControl = (node: Element): boolean => node.querySelector(FILLABLE) != null;
  // Two levels: the control's own siblings, then its wrapper's. Portals
  // usually put the caption in one of those two places.
  let node: Element | null = el;
  for (let depth = 0; node && node !== document.body && depth < 2; depth += 1) {
    for (
      let previous = node.previousElementSibling;
      previous;
      previous = previous.previousElementSibling
    ) {
      // A sibling that owns its own control is that field's caption, not ours.
      if (ownsAControl(previous)) break;
      const text = cleanLabelText(previous.textContent);
      if (text && text.length <= NEARBY_LABEL_MAX_CHARS) return text;
    }
    node = node.parentElement;
  }
  return "";
}

function sectionFor(el: Element): string | null {
  const legend = el.closest("fieldset")?.querySelector("legend")?.textContent?.trim();
  if (legend) return legend;
  const section = el.closest("section, [role='group']");
  const heading = section?.querySelector("h1, h2, h3, h4")?.textContent?.trim();
  return heading || null;
}

function capOptions(options: { value: string; label: string }[]): { value: string; label: string }[] {
  return options.slice(0, CONTROL_OPTIONS_CAP);
}

/** Option vocabulary for a structured control. Reads each choice's declared
 * `value` attribute and its visible label — never `selected`, `checked`, or a
 * typed value. */
function optionsFor(el: Element, type: PortalFieldType): { value: string; label: string }[] | undefined {
  if (type === "select" && el instanceof HTMLSelectElement) {
    const options: { value: string; label: string }[] = [];
    for (const option of Array.from(el.options)) {
      // `option.value` is the declared choice (value attr, else the text).
      // That is not the select's selected state (`select.value` / `option.selected`).
      const value = option.value;
      if (value === "") continue;
      options.push({ value, label: (option.textContent ?? "").trim() });
    }
    return capOptions(options);
  }
  if (type === "radio" && el instanceof HTMLInputElement) {
    const scope = el.form ?? document;
    const group = el.name
      ? Array.from(
          scope.querySelectorAll<HTMLInputElement>(
            `input[type="radio"][name="${CSS.escape(el.name)}"]`,
          ),
        )
      : [el];
    const options: { value: string; label: string }[] = [];
    for (const radio of group) {
      if (!isCapturableControl(radio)) continue;
      const value = radio.getAttribute("value") ?? "";
      if (value === "") continue;
      options.push({ value, label: labelFor(radio) || value });
    }
    return capOptions(options);
  }
  if (type === "checkbox" && el instanceof HTMLInputElement) {
    const value = el.getAttribute("value");
    if (value == null || value === "" || value === "on") return [];
    return [{ value, label: labelFor(el) || value }];
  }
  return undefined;
}

/** Scan the page's fillable controls into capture rows.
 *
 * Only VISIBLE controls are captured (no layout box, or hidden via attribute /
 * display / visibility ancestors, are skipped) so JSF multi-panel forms do not
 * flood the trainer with inactive-panel inputs. Radio groups collapse to ONE
 * row per name among the visible set: a payer's "Accepting new patients:
 * Yes/No" is one field to map, not two. Rows are ordered by VISUAL reading
 * position (top→bottom, left→right), not DOM tree order — grid/flex forms
 * often paint fields in a different sequence than `querySelectorAll`. The
 * background stamps that sequence as `sort_order` for Form setup. */
/** Describe ONE control exactly as a scan would. The manual element picker
 * calls this too, so a hand-picked field and an auto-detected one carry
 * identical metadata — there is no second, drifting copy of "what a captured
 * field looks like". Shape only: never a value. */
export function describeControl(el: Element): CapturedField {
  const type = controlType(el);
  const options = optionsFor(el, type);
  return {
    label: captureLabel(el, type),
    selector: selectorFor(el),
    fieldType: type,
    formSection: sectionFor(el),
    ...(options !== undefined ? { options } : {}),
  };
}

/** The nearest thing to `node` that capture can actually map: the control
 * itself, the control a clicked <label> points at, or a control inside a
 * clicked wrapper. Null when the click landed on nothing mappable. */
export function nearestCapturableControl(node: Element | null): Element | null {
  if (node == null) return null;
  const self = node.closest(FILLABLE);
  if (self) return self;
  const label = node.closest("label");
  if (label) {
    const forId = label.getAttribute("for");
    if (forId) {
      const target = document.getElementById(forId);
      if (target?.matches(FILLABLE)) return target;
    }
    const inner = label.querySelector(FILLABLE);
    if (inner) return inner;
  }
  return node.querySelector(FILLABLE);
}

export function scanCapturableFields(): CapturedField[] {
  const seenRadioNames = new Set<string>();
  const fields: CapturedField[] = [];
  const controls = Array.from(document.querySelectorAll(FILLABLE)).map((el, index) => ({
    el,
    index,
  }));

  const visible = controls
    .filter(({ el }) => isCapturableControl(el))
    .sort(
      (a, b) => compareVisualPosition(a.el, b.el) || a.index - b.index,
    );

  for (const { el } of visible) {
    const type = controlType(el);
    if (type === "radio") {
      const name = (el as HTMLInputElement).name;
      if (name) {
        if (seenRadioNames.has(name)) continue;
        seenRadioNames.add(name);
      }
    }
    fields.push(describeControl(el));
  }

  return fields;
}
