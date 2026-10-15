// The DOM fill engine. Runs inside the portal page, receives fully resolved
// instructions (selector + final value), and applies them defensively: every
// field is wrapped so one bad selector or odd widget skips-and-reports
// instead of aborting the run. Nothing here reads storage, fetches, or sees
// anything beyond the values it is handed.
import type {
  FillInstruction,
  FillPageResult,
  FillProbeInstruction,
  FillProbeResult,
  ReportedField,
  ReportedFieldKind,
} from "../shared/fill";
import type { FillEventV2FieldOutcome, FillEventV2Outcome, FillEventV2ReasonCode } from "../shared/fillEventV2";
import {
  applySequencePageEvidence,
  isOtherPageInstruction,
  isSequencePageStep,
  otherPageReport,
  pageUnknownReport,
  resolveFillPage,
} from "../shared/fillPage";
import { FIELD_NOT_FOUND_REASON } from "../shared/fixit";
import { pageScopeMatches } from "../shared/pageScope";
import { HIDDEN_KIND, HIDDEN_REASON } from "../shared/hiddenField";
// DYN-PAGE-02 — the SAME "positively hidden" rule the scanner uses, shared
// rather than copied so the two surfaces can never disagree about what an
// inactive wizard panel looks like. The scanner's extra zero-box filter is
// deliberately NOT applied here; see isHiddenControl's own comment.
import { BOOLEAN_SENTINELS, canonicalControl, hostLabel, isHiddenControl } from "./captureScan";
import { FILLABLE, querySelectorAllDeep, querySelectorDeep } from "./deepDom";
import {
  isListItemChosen,
  listClickClearsOthers,
  primeFacesListItems,
  primeFacesSelectManyMenu,
  primeFacesSelectMenu,
  primeFacesWidget,
  toggleListItem,
  type PrimeFacesSelectManyMenu,
} from "./primeFaces";

// Label text comparison: case- and whitespace-insensitive, trailing
// colons/required-markers stripped ("First Name *" matches "First Name").
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s:*]+$/, "");
}

function safeNativeDate(value: string): string | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= (daysInMonth[month - 1] ?? 0)
    ? value
    : null;
}

export type Fillable = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLElement;

export function isCustomCheckboxElement(el: Element): boolean {
  if (el instanceof HTMLInputElement) {
    return el.type === "checkbox";
  }
  const role = el.getAttribute("role");
  if (role === "checkbox") return true;
  const tag = el.tagName.toLowerCase();
  if (tag.endsWith("-checkbox") || tag.includes("checkbox")) return true;
  if (el.shadowRoot?.querySelector('[role="checkbox"], input[type="checkbox"]')) return true;
  return false;
}

interface ProbedTarget {
  mapId: string;
  pageStep: string | null;
  pageUrl: string | null;
  target: Fillable;
  radioNodes: HTMLInputElement[] | null;
  mutationVersion: number;
  expiresAt: number;
  resolvedPage?: string | null;
  probedLabel?: string;
  probedOptionsSignature?: string | null;
}

// DOM references stay only in this content-script frame's short-lived memory.
// The opaque probe key binds APPLY_FILL to the exact node observed by probe.
const probedTargets = new Map<string, ProbedTarget>();
let probeMutationObserver: MutationObserver | null = null;
let probeMutationVersion = 0;
let activePrimeFacesMenu: NonNullable<ReturnType<typeof primeFacesSelectMenu>> | null = null;
let activePrimeFacesList: PrimeFacesSelectManyMenu | null = null;

function isDecorationMutation(record: MutationRecord, decorated: Fillable, title: string | undefined): boolean {
  if (record.type === "childList") {
    const isStyle = (n: Node) => {
      const el = n as unknown as { id?: string; tagName?: string };
      return (
        typeof el.tagName === "string" && el.tagName.toLowerCase() === "style" && el.id === "__minted-panel-fill-style"
      );
    };
    const addedOnlyStyle = Array.from(record.addedNodes).every(isStyle);
    const removedOnlyStyle = Array.from(record.removedNodes).every(isStyle);
    if ((record.addedNodes.length > 0 || record.removedNodes.length > 0) && addedOnlyStyle && removedOnlyStyle) {
      return true;
    }
  }
  if (record.type === "attributes" && record.target === decorated) {
    if (record.attributeName === "class") {
      const portalClasses = (value: string) => value.split(/\s+/)
        .filter((name) => name && name !== "mp-fill-static" && name !== "mp-fill-ai").sort().join(" ");
      return portalClasses(record.oldValue ?? "") === portalClasses(decorated.className);
    }
    return record.attributeName === "title" && title !== undefined && decorated.getAttribute("title") === title;
  }
  return false;
}

function isPrimeFacesInteractionMutation(record: MutationRecord): boolean {
  const list = activePrimeFacesList;
  if (list) {
    // A SelectManyMenu click only restyles its own items (highlight, hover,
    // the optional checkbox) and focuses the widget; option.selected is a
    // property, not an attribute. The change event's AJAX update is NOT
    // exempt: it lands after this window closes.
    const target = record.target as Element;
    return record.type === "attributes" &&
      ["class", "style", "aria-selected"].includes(record.attributeName ?? "") &&
      (target === list.wrapper ||
        (list.wrapper.contains(target) && target.matches(".ui-selectlistbox-item, .ui-chkbox-box, .ui-chkbox-icon")));
  }
  const menu = activePrimeFacesMenu;
  if (!menu) return false;
  const panel = primeFacesPanel(menu);
  if (panel?.contains(record.target)) return true;
  if (panel && record.type === "childList") {
    const changed = [...record.addedNodes, ...record.removedNodes];
    if (changed.length > 0 && changed.every((node) => node === panel)) return true;
  }
  const label = menu.wrapper.querySelector(".ui-selectonemenu-label");
  if (label?.contains(record.target) && (record.type === "childList" || record.type === "characterData")) return true;
  // Only presentation changes on this menu are expected during a selection.
  // Labels/options and all mutations elsewhere must invalidate pending probes.
  return record.type === "attributes" &&
    [menu.wrapper, menu.focusInput, label, menu.wrapper.querySelector(".ui-selectonemenu-trigger")].includes(record.target as Element) &&
    ["class", "style", "aria-expanded", "aria-activedescendant", "tabindex"].includes(record.attributeName ?? "");
}

function hasMeaningfulMutations(records: MutationRecord[]): boolean {
  return records.some((r) => !isPrimeFacesInteractionMutation(r));
}

function ensureProbeMutationObserver(): boolean {
  if (probeMutationObserver) return true;
  if (typeof MutationObserver === "undefined" || !document.documentElement) return false;
  probeMutationObserver = new MutationObserver((records) => {
    if (hasMeaningfulMutations(records)) probeMutationVersion += 1;
  });
  probeMutationObserver.observe(document.documentElement, {
    attributes: true,
    attributeOldValue: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  return true;
}

function currentProbeMutationVersion(): number {
  const records = probeMutationObserver?.takeRecords() ?? [];
  if (hasMeaningfulMutations(records)) probeMutationVersion += 1;
  return probeMutationVersion;
}

function stopProbeMutationObserverIfUnused(): void {
  if (probedTargets.size > 0) return;
  probeMutationObserver?.disconnect();
  probeMutationObserver = null;
  probeMutationVersion = 0;
}

function pruneProbedTargets(): void {
  const now = Date.now();
  for (const [key, value] of probedTargets) {
    if (value.expiresAt <= now) probedTargets.delete(key);
  }
  stopProbeMutationObserverIfUnused();
}

function asFillable(el: Element | null): Fillable | null {
  if (!el) return null;
  const canonical = canonicalControl(el);
  if (
    canonical instanceof HTMLInputElement ||
    canonical instanceof HTMLSelectElement ||
    canonical instanceof HTMLTextAreaElement
  ) {
    return primeFacesSelectMenu(canonical)?.select ?? canonical;
  }
  if (isCustomCheckboxElement(canonical) && canonical instanceof HTMLElement) {
    return canonical;
  }
  return null;
}

function isHiddenTarget(el: Fillable): boolean {
  const widget = primeFacesWidget(el);
  return widget ? isHiddenControl(widget) : isHiddenControl(el);
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
  return byLabelAll(text)[0] ?? null;
}

function byLabelAll(text: string): Fillable[] {
  const want = normalize(text);
  const controls = new Set<Fillable>();
  for (const label of querySelectorAllDeep("label")) {
    if (!(label instanceof HTMLLabelElement)) continue;
    if (normalize(label.textContent ?? "") !== want) continue;
    const control = controlForLabel(label);
    if (control) controls.add(control);
  }
  // Host-attribute labels (no <label> element in the light DOM).
  for (const host of querySelectorAllDeep("[label], [aria-label]")) {
    const hostText =
      host.getAttribute("label")?.trim() ||
      host.getAttribute("aria-label")?.trim() ||
      "";
    if (normalize(hostText) !== want) continue;
    const root: ParentNode = host.shadowRoot ?? host;
    for (const node of querySelectorAllDeep(FILLABLE, root)) {
      const control = asFillable(node);
      if (control) controls.add(control);
    }
  }
  // Slotted / text-content custom hosts (e.g. <cf-checkbox>).
  for (const el of querySelectorAllDeep(FILLABLE)) {
    const canonical = asFillable(el);
    if (canonical && canonical.tagName.includes("-")) {
      const hl = hostLabel(canonical);
      if (normalize(hl) === want) {
        controls.add(canonical);
      }
    }
  }
  return [...controls];
}

type TargetResolution =
  | { status: "unique"; target: Fillable }
  | { status: "missing" }
  | { status: "hidden" }
  | { status: "ambiguous" }
  | { status: "unsupported" };

function resolveTarget(instruction: FillInstruction): TargetResolution {
  let sawHidden = false;
  let sawUnsupported = false;
  for (const selector of [
    instruction.selector,
    ...instruction.selectorFallbacks,
  ]) {
    let matches: Element[];
    if (selector.startsWith(LABEL_SELECTOR_PREFIX)) {
      matches = byLabelAll(selector.slice(LABEL_SELECTOR_PREFIX.length));
    } else {
      try {
        matches = querySelectorAllDeep(selector);
      } catch {
        continue;
      }
    }
    const fillable = matches.map(asFillable).filter((item): item is Fillable => item !== null);
    if (fillable.length === 0) {
      if (matches.length > 0) sawUnsupported = true;
      continue;
    }
    let visible = [...new Set(fillable)].filter((control) => !isHiddenTarget(control));
    if (visible.length === 0 && instruction.fieldType === "radio" && fillable.every((item) => item instanceof HTMLInputElement && item.type === "radio")) {
      const firstRadio = fillable[0] as HTMLInputElement | undefined;
      if (firstRadio) {
        const group = firstRadio.name
          ? querySelectorAllDeep(`input[type="radio"][name="${CSS.escape(firstRadio.name)}"]`, firstRadio.form ?? document)
              .filter((node): node is HTMLInputElement => node instanceof HTMLInputElement)
          : [firstRadio];
        const groupVisible = group.filter((radio) => !isHiddenTarget(radio));
        if (groupVisible.length > 0 && sameRadioGroup(groupVisible)) visible = [firstRadio];
      }
    }
    if (visible.length === 0) {
      sawHidden = true;
      continue;
    }
    if (visible.length === 1) return { status: "unique", target: visible[0] as Fillable };
    if (instruction.fieldType === "radio" && sameRadioGroup(visible)) return { status: "unique", target: visible[0] as Fillable };
    // Multiple visible targets are ambiguous. Never let query order choose.
    return { status: "ambiguous" };
  }
  if (sawHidden) return { status: "hidden" };
  if (sawUnsupported) return { status: "unsupported" };
  return { status: "missing" };
}

// Set an input's value through the prototype setter so framework-controlled
// inputs (React / Lit et al.) see the change, then fire the events the page's
// own validation listens for — including composed so listeners outside a
// shadow root still hear the change.
function setNativeValue(el: Fillable, value: string): void {
  if (el instanceof HTMLInputElement && el.closest(".p-datepicker.ui-calendar")) {
    // PrimeFaces 10's calendar input consumes the next input event only after
    // keydown marks its internal model ready. This key is deliberately not a
    // navigation or submission key; dispatch it immediately before the write.
    el.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Unidentified",
      bubbles: true,
      composed: true,
      cancelable: true,
    }));
  }
  const proto = Object.getPrototypeOf(el) as object;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor?.set) {
    descriptor.set.call(el, value);
  } else if ("value" in el) {
    (el as HTMLElement & { value: string }).value = value;
  }
  fireChanged(el);
}

function fireChanged(el: HTMLElement): void {
  const init: EventInit = { bubbles: true, composed: true, cancelable: true };
  el.dispatchEvent(new Event("input", init));
  el.dispatchEvent(new Event("change", init));
  el.dispatchEvent(new Event("blur", { composed: true, cancelable: false }));
  el.dispatchEvent(new Event("focusout", { bubbles: true, composed: true, cancelable: false }));
}

export function isCheckboxChecked(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement && el.type === "checkbox") {
    return el.checked;
  }
  if ("checked" in el && typeof (el as HTMLElement & { checked?: unknown }).checked === "boolean") {
    return (el as HTMLElement & { checked: boolean }).checked;
  }
  const ariaChecked = el.getAttribute("aria-checked");
  if (ariaChecked != null) return ariaChecked === "true";
  if (el.shadowRoot) {
    const shadowBox = el.shadowRoot.querySelector<HTMLElement>('[role="checkbox"], input[type="checkbox"]');
    if (shadowBox instanceof HTMLInputElement) return shadowBox.checked;
    if (shadowBox?.getAttribute("aria-checked") != null) {
      return shadowBox.getAttribute("aria-checked") === "true";
    }
  }
  return false;
}

export function toggleCheckbox(el: HTMLElement, wantChecked?: boolean): void {
  if (el instanceof HTMLInputElement && el.type === "checkbox") {
    el.click();
    return;
  }
  const clickable = el.shadowRoot?.querySelector<HTMLElement>(
    '[role="checkbox"], input[type="checkbox"], .wrapper, .icon, label',
  ) ?? el;
  clickable.click();

  if (wantChecked !== undefined && isCheckboxChecked(el) !== wantChecked) {
    if (clickable !== el) {
      el.click();
    }
  }
  fireChanged(el);
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
  const controls = [...new Set(querySelectorAllDeep(FILLABLE)
    .map(asFillable)
    .filter((el): el is Fillable => el !== null))];
  for (const node of controls) {
    const el = node;
    try {
      if (
        el instanceof HTMLInputElement &&
        (el.type === "checkbox" || el.type === "radio")
      ) {
        if (!el.checked) continue;
        el.checked = false;
        fireChanged(el);
      } else if (isCustomCheckboxElement(el)) {
        if (!isCheckboxChecked(el)) continue;
        toggleCheckbox(el, false);
      } else if (el instanceof HTMLSelectElement && el.multiple) {
        // `selectedIndex = 0` on a multi-select would CHOOSE option 1.
        const list = primeFacesSelectManyMenu(el);
        if (list) {
          if (!clearPrimeFacesList(list)) continue;
        } else {
          const chosen = Array.from(el.selectedOptions);
          if (chosen.length === 0) continue;
          for (const option of chosen) option.selected = false;
          fireChanged(el);
        }
      } else if (el instanceof HTMLSelectElement) {
        if (el.selectedIndex <= 0 && el.value === "") continue;
        // Index 0 is the placeholder on a portal select; -1 (nothing chosen)
        // is the honest reset when there is no placeholder to fall back to.
        el.selectedIndex = el.options.length > 0 ? 0 : -1;
        fireChanged(el);
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
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

/** Clear a SelectManyMenu through its own list — ctrl-click each chosen item
 * off — so the widget and the posted select agree. A list whose clicks clear
 * the others (`metaKeySelection` off) can't be emptied that way; it is left
 * alone and not counted. */
function clearPrimeFacesList(list: PrimeFacesSelectManyMenu): boolean {
  const pairs = primeFacesListItems(list);
  if (!pairs || list.select.disabled || listClickClearsOthers(list)) return false;
  let cleared = false;
  for (const pair of pairs) {
    if (!isListItemChosen(pair) || pair.item.classList.contains("ui-state-disabled")) continue;
    toggleListItem(pair.item);
    cleared ||= !pair.option.selected;
  }
  return cleared;
}

function labelTextOf(input: HTMLInputElement): string {
  const label = input.labels?.[0] ?? input.closest("label");
  return label?.textContent ?? "";
}

function associatedLabelText(target: Fillable): string {
  if (target instanceof HTMLInputElement) {
    const text = labelTextOf(target);
    if (text) return normalize(text);
  }
  const labels = "labels" in target ? (target as HTMLInputElement).labels : undefined;
  const label = labels?.[0] ?? target.closest("label") ??
    (target.id ? document.querySelector(`label[for="${CSS.escape(target.id)}"]`) : null);
  if (label?.textContent) return normalize(label.textContent);
  if (target.tagName.includes("-")) {
    const hostText = hostLabel(target);
    if (hostText) return normalize(hostText);
  }
  const menu = target instanceof HTMLSelectElement ? primeFacesSelectMenu(target) : null;
  if (menu) {
    const menuLabel = menu.wrapper.closest("label") ??
      (menu.wrapper.id ? document.querySelector(`label[for="${CSS.escape(menu.wrapper.id)}"]`) : null) ??
      (target.id ? document.querySelector(`label[for="${CSS.escape(target.id)}"]`) : null);
    if (menuLabel?.textContent) return normalize(menuLabel.textContent);
  }
  const ariaLabel = target.getAttribute("aria-label");
  if (ariaLabel) return normalize(ariaLabel);
  const ariaLabelledBy = target.getAttribute("aria-labelledby");
  if (ariaLabelledBy) {
    const el = document.getElementById(ariaLabelledBy);
    if (el?.textContent) return normalize(el.textContent);
  }
  return "";
}

function getOptionsSignature(select: HTMLSelectElement): string {
  return Array.from(select.options)
    .map((o) => `${o.value}:${normalize(o.text)}`)
    .join("|");
}

type ApplyOutcome =
  | {
      ok: true;
      attempted: boolean;
      changed: boolean;
      target: Fillable;
      expectedValue: string | boolean;
    }
  | {
      ok: false;
      reason: string;
      kind?: ReportedFieldKind;
      outcome?: FillEventV2Outcome;
      reasonCode?: FillEventV2ReasonCode;
      target?: Fillable;
    };

/** DYN-PAGE-02 — the control resolved but sits in an inactive panel, so the
 * fill declines to write it. Never drift: the selector was found. */
const HIDDEN_OUTCOME: ApplyOutcome = {
  ok: false,
  reason: HIDDEN_REASON,
  kind: HIDDEN_KIND,
  outcome: "hidden",
  reasonCode: "field_hidden",
};

const TRUTHY = new Set(["true", "yes", "y", "1", "x", "on", "checked"]);

function vocabularyMismatchReason(kind: "dropdown" | "radio"): string {
  // A report may be persisted in the side-panel session and sent to legacy
  // telemetry. Never include the attempted value or a sample of live options.
  return `${kind}: no option matches the mapped value`;
}

function applyRadio(el: HTMLInputElement, value: string, markAttempted: () => void): ApplyOutcome {
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
      reason: vocabularyMismatchReason("radio"),
      outcome: "option_mismatch",
      reasonCode: "option_missing",
    };
  }
  if (match.matches(":disabled")) {
    return { ok: false, reason: "field is disabled or read-only" };
  }
  // The visibility guard belongs HERE, not on the resolved element: a radio
  // group is one field made of N controls, and `match` — the one that gets
  // clicked — need not be the one the selector resolved to.
  if (isHiddenTarget(match)) return HIDDEN_OUTCOME;
  const changed = !match.checked;
  if (changed) {
    markAttempted();
    match.click();
  }
  if (!match.checked) return { ok: false, reason: "field did not retain the requested value", target: match };
  return { ok: true, attempted: changed, changed, target: match, expectedValue: true };
}

function applyCheckbox(el: Fillable, value: string, markAttempted: () => void): ApplyOutcome {
  const norm = normalize(value);
  const optionValue = el.getAttribute("value");
  const optionLabel = associatedLabelText(el);
  const isOptionMatch =
    !BOOLEAN_SENTINELS.has(norm) &&
    ((optionValue != null &&
      !BOOLEAN_SENTINELS.has(normalize(optionValue)) &&
      normalize(optionValue) === norm) ||
      (optionLabel !== "" && normalize(optionLabel) === norm));

  const wantChecked = TRUTHY.has(norm) || isOptionMatch;
  const currentChecked = isCheckboxChecked(el);
  const changed = currentChecked !== wantChecked;
  if (changed) {
    markAttempted();
    toggleCheckbox(el, wantChecked);
  }
  const finalChecked = isCheckboxChecked(el);
  if (finalChecked !== wantChecked) {
    return { ok: false, reason: "field did not retain the requested value", target: el };
  }
  return { ok: true, attempted: changed, changed, target: el, expectedValue: wantChecked };
}

function applySelect(el: HTMLSelectElement, instruction: FillInstruction, markAttempted: () => void): ApplyOutcome {
  // Writing a SelectManyMenu's backing select would post an answer its list
  // never shows; only `applyPrimeFacesList` (the async path) clicks the list.
  if (primeFacesSelectManyMenu(el)) {
    return {
      ok: false,
      reason: "multi-select list can only be filled through its visible items",
      outcome: "unsupported",
      reasonCode: "unsupported_control",
    };
  }
  const value = instruction.value;
  const menu = primeFacesSelectMenu(el);
  if (menu && (menu.wrapper.matches(":disabled, .ui-state-disabled") || menu.wrapper.getAttribute("aria-disabled") === "true")) {
    return { ok: false, reason: "field is disabled or read-only", outcome: "unsupported", reasonCode: "unsupported_control" };
  }
  const options = Array.from(el.options);
  const enabled = (option: HTMLOptionElement): boolean =>
    !option.disabled && option.closest("optgroup")?.disabled !== true;
  const exactValue = options.filter((option) => option.value === value && enabled(option));
  const exactLabel = options.filter((option) => normalize(option.text) === normalize(value) && enabled(option));
  const normalizedValue = options.filter((option) => normalize(option.value) === normalize(value) && enabled(option));
  const candidates = instruction.exactSelectValue
    ? exactValue
    : exactValue.length > 0 ? exactValue : exactLabel.length > 0 ? exactLabel : normalizedValue;
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: "dropdown: multiple options match the mapped value",
      outcome: "needs_mapping",
      reasonCode: "ambiguous_target",
    };
  }
  const match = candidates[0];
  if (!match) {
    return {
      ok: false,
      reason: vocabularyMismatchReason("dropdown"),
      outcome: "option_mismatch",
      reasonCode: "option_missing",
    };
  }
  if (el.multiple) {
    // A value names ONE option; a multi-select fill adds it and never clears
    // the others (`select.value = …` would deselect every other choice).
    const added = !match.selected;
    if (added) {
      markAttempted();
      match.selected = true;
      fireChanged(el);
    }
    if (!match.selected) {
      return { ok: false, reason: "field did not retain the requested value", target: el };
    }
    return { ok: true, attempted: added, changed: added, target: el, expectedValue: match.value };
  }
  const changed = el.value !== match.value;
  if (changed) {
    markAttempted();
    el.value = match.value;
    fireChanged(el);
  }
  if (el.value !== match.value) {
    return { ok: false, reason: "field did not retain the requested value", target: el };
  }
  return { ok: true, attempted: changed, changed, target: el, expectedValue: match.value };
}

function applyValue(el: Fillable, instruction: FillInstruction, markAttempted: () => void): ApplyOutcome {
  const isRadio = el instanceof HTMLInputElement && el.type === "radio";
  const isCheckboxControl =
    !(el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) &&
    isCustomCheckboxElement(el);
  // DYN-PAGE-02 — never mutate a control the coordinator cannot see. A wizard
  // that keeps every step in the DOM and hides the inactive ones would
  // otherwise take a silent write into a panel nobody reviews before
  // submitting. Radio defers its own check to applyRadio, which knows which
  // group member is actually about to be clicked.
  if (!isRadio && isHiddenTarget(el)) return HIDDEN_OUTCOME;
  if (instruction.fieldType === "checkbox" && !isCheckboxControl) {
    return {
      ok: false,
      reason: "mapping does not resolve to a checkbox control",
      outcome: "unsupported",
      reasonCode: "unsupported_control",
    };
  }
  if (isCheckboxControl) {
    return applyCheckbox(el, instruction.value, markAttempted);
  }
  if (el instanceof HTMLSelectElement)
    return applySelect(el, instruction, markAttempted);
  if (isRadio) {
    return applyRadio(el as HTMLInputElement, instruction.value, markAttempted);
  }
  if (el instanceof HTMLInputElement && el.type === "file") {
    // Belt and braces: the background never plans file fields.
    return { ok: false, reason: "file inputs cannot be filled" };
  }
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    return { ok: false, reason: "unsupported control type", outcome: "unsupported", reasonCode: "unsupported_control" };
  }
  if (el instanceof HTMLInputElement && (el.disabled || el.readOnly)) {
    return { ok: false, reason: "field is disabled or read-only", outcome: "unsupported", reasonCode: "unsupported_control" };
  }
  const nativeDate = instruction.nativeDateValue ?? safeNativeDate(instruction.value);
  if (el instanceof HTMLInputElement && el.type === "date" && !nativeDate) {
    return {
      ok: false,
      reason: "native date value is unavailable in a safe format; review this field on the portal",
      outcome: "write_rejected",
      reasonCode: "invalid_format",
    };
  }
  const nextValue = el instanceof HTMLInputElement && el.type === "date"
    ? nativeDate as string
    : instruction.value;
  const changed = el.value !== nextValue;
  markAttempted();
  setNativeValue(el, nextValue);
  if (el.value !== nextValue) {
    return { ok: false, reason: "field did not retain the requested value", target: el };
  }
  if (el.willValidate && !el.validity.valid) {
    return {
      ok: false,
      reason: "form rejected the field format; review it on the portal",
      outcome: "write_rejected",
      reasonCode: "invalid_format",
      target: el,
    };
  }
  return { ok: true, attempted: true, changed, target: el, expectedValue: nextValue };
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
  // Account for portal event-handler changes before exempting our own writes.
  currentProbeMutationVersion();
  const title = kind === "ai" && token ? `AI Suggested: ${token}` : undefined;
  installFillStyle(el);
  el.classList.add(kind === "ai" ? "mp-fill-ai" : "mp-fill-static");
  if (title !== undefined) el.setAttribute("title", title);
  const records = probeMutationObserver?.takeRecords() ?? [];
  if (hasMeaningfulMutations(records.filter((record) => !isDecorationMutation(record, el, title)))) {
    probeMutationVersion += 1;
  }
}

/** Write once a content-local scan has verified the exact empty target. */
export function applyAiValue(
  el: Fillable,
  value: string,
): { ok: true; changed: boolean; target: Fillable; writtenValue: string } | { ok: false; reason: string } {
  if (isHiddenTarget(el) || el.matches(":disabled")) {
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
  } else if (
    (el instanceof HTMLInputElement && el.type === "checkbox") ||
    isCustomCheckboxElement(el)
  ) {
    if (isCheckboxChecked(el)) return { ok: false, reason: "field already has a value" };
    if (!TRUTHY.has(normalize(value))) return { ok: false, reason: "suggestion does not require a write" };
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.value !== "") return { ok: false, reason: "field already has a value" };
  }
  const previousValue: string | boolean =
    el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")
      ? el.checked
      : isCustomCheckboxElement(el)
        ? isCheckboxChecked(el)
        : (el as HTMLElement & { value?: string }).value ?? "";

  const fieldType = el instanceof HTMLSelectElement
    ? "select"
    : el instanceof HTMLInputElement && el.type === "radio"
      ? "radio"
      : (el instanceof HTMLInputElement && el.type === "checkbox") || isCustomCheckboxElement(el)
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
  }, () => void 0);
  if (!outcome.ok) {
    if (outcome.target) {
      const currentValue: string | boolean =
        outcome.target instanceof HTMLInputElement &&
        (outcome.target.type === "radio" || outcome.target.type === "checkbox")
          ? outcome.target.checked
          : isCustomCheckboxElement(outcome.target)
            ? isCheckboxChecked(outcome.target)
            : (outcome.target as HTMLElement & { value?: string }).value ?? "";
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
  if (el instanceof HTMLInputElement && el.type === "radio") {
    el.checked = value === true;
    return;
  }
  if (
    (el instanceof HTMLInputElement && el.type === "checkbox") ||
    isCustomCheckboxElement(el)
  ) {
    toggleCheckbox(el, value === true);
    return;
  }
  const next = typeof value === "string" ? value : "";
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
  if (descriptor?.set) descriptor.set.call(el, next);
  else (el as HTMLElement & { value?: string }).value = next;
}

export function restoreAiValue(el: Fillable, previous: string | boolean): void {
  if (el instanceof HTMLInputElement && el.type === "radio") {
    el.checked = previous === true;
    fireChanged(el);
    return;
  }
  if (
    (el instanceof HTMLInputElement && el.type === "checkbox") ||
    isCustomCheckboxElement(el)
  ) {
    toggleCheckbox(el, previous === true);
    return;
  }
  setNativeValue(el, typeof previous === "string" ? previous : "");
}

// The page's fillable controls — the denominator for honest coverage
// reporting ("filled 3 of 24 mapped · ~117 fields on this page").
function countPageFields(): number {
  return new Set(querySelectorAllDeep(FILLABLE)
    .map(asFillable)
    .filter((el): el is Fillable => el !== null)).size;
}

function sameRadioGroup(elements: Fillable[]): boolean {
  if (elements.length === 0) return false;
  if (!elements.every((element) => element instanceof HTMLInputElement && element.type === "radio")) return false;
  if (elements.length === 1) return true;
  const first = elements[0] as HTMLInputElement;
  return first.name.length > 0 && elements.every((element) =>
    element instanceof HTMLInputElement && element.form === first.form && element.name === first.name,
  );
}

function radioGroupNodes(element: Fillable): HTMLInputElement[] | null {
  if (!(element instanceof HTMLInputElement) || element.type !== "radio") return null;
  const group = element.name
    ? querySelectorAllDeep(`input[type="radio"][name="${CSS.escape(element.name)}"]`, element.form ?? document)
        .filter((node): node is HTMLInputElement => node instanceof HTMLInputElement)
    : [element];
  return sameRadioGroup(group) ? group : null;
}

function sameNodeList(left: HTMLInputElement[] | null, right: HTMLInputElement[] | null): boolean {
  return left === null || right === null
    ? left === right
    : left.length === right.length && left.every((node, index) => node === right[index]);
}

/**
 * A bounded DOM-stability check used only before classifying a selector miss.
 * It waits for the page to finish loading and for a short mutation-quiet
 * window, so delayed wizard panels are searched before a miss is recorded.
 */
async function waitForPageSettled(quietMs = 120, maxWaitMs = 700): Promise<boolean> {
  if (document.readyState !== "complete" || typeof MutationObserver === "undefined" || !document.documentElement) {
    return false;
  }
  let lastMutation = Date.now();
  const observer = new MutationObserver(() => { lastMutation = Date.now(); });
  observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  const startedAt = Date.now();
  const hasVisibleBusyState = (): boolean => {
    for (const element of querySelectorAllDeep('[aria-busy="true"], [data-loading="true"], [role="progressbar"]')) {
      if (!isHiddenControl(element)) return true;
    }
    return false;
  };
  try {
    while (Date.now() - startedAt < maxWaitMs) {
      if (Date.now() - lastMutation >= quietMs && !hasVisibleBusyState()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return Date.now() - lastMutation >= quietMs && !hasVisibleBusyState();
  } finally {
    observer.disconnect();
  }
}

/** Shape-only probe used to route each map to at most one accessible frame. */
export async function probeFillOnPage(
  instructions: FillProbeInstruction[],
  explicitPageUrl: string | null = null,
): Promise<FillProbeResult[]> {
  const pageSettled = await waitForPageSettled();
  pruneProbedTargets();
  const mutationWatchAvailable = ensureProbeMutationObserver();
  const pageUrl = explicitPageUrl ?? (typeof location !== "undefined" ? location.href : null);
  const currentPage = resolveFillPage(
    pageUrl,
    instructions.map((instruction) => instruction.pageStep),
  );
  const pageFields = countPageFields();
  const results: FillProbeResult[] = instructions.map((instruction) => {
    probedTargets.delete(instruction.probeKey);
    if (isOtherPageInstruction(instruction, currentPage)) {
      return { mapId: instruction.mapId, pageStatus: "other_page", targetStatus: "missing", pageSettled, radioGroup: false, pageFields, resolvedPage: currentPage };
    }
    // A "Page N" map is searched anyway: its bucket may prove the page by its
    // own trained selectors (DYN-PAGE-03), decided over the whole batch below.
    if (currentPage == null && Boolean(instruction.pageStep?.trim()) && !isSequencePageStep(instruction.pageStep)) {
      return { mapId: instruction.mapId, pageStatus: "page_unknown", targetStatus: "missing", pageSettled, radioGroup: false, pageFields, resolvedPage: currentPage };
    }

    let invalid = false;
    for (const selector of [instruction.selector, ...instruction.selectorFallbacks]) {
      let matches: Element[];
      if (selector.startsWith(LABEL_SELECTOR_PREFIX)) {
        matches = byLabelAll(selector.slice(LABEL_SELECTOR_PREFIX.length));
      } else {
        try {
          matches = querySelectorAllDeep(selector);
        } catch {
          invalid = true;
          continue;
        }
      }
      const fillable = matches.map(asFillable).filter((item): item is Fillable => item !== null);
      if (fillable.length === 0) {
        if (matches.length > 0) return { mapId: instruction.mapId, pageStatus: "eligible", targetStatus: "unsupported", pageSettled, radioGroup: false, pageFields, resolvedPage: currentPage };
        continue;
      }
      let visible = [...new Set(fillable)].filter((control) => !isHiddenTarget(control));
      let radioGroup = instruction.fieldType === "radio" && sameRadioGroup(visible);
      if (visible.length === 0 && instruction.fieldType === "radio" && fillable.every((item) => item instanceof HTMLInputElement && item.type === "radio")) {
        const firstRadio = fillable[0] as HTMLInputElement | undefined;
        if (firstRadio) {
          const group = firstRadio.name
            ? querySelectorAllDeep(`input[type="radio"][name="${CSS.escape(firstRadio.name)}"]`, firstRadio.form ?? document)
                .filter((node): node is HTMLInputElement => node instanceof HTMLInputElement)
            : [firstRadio];
          const groupVisible = group.filter((radio) => !isHiddenTarget(radio));
          if (groupVisible.length > 0 && sameRadioGroup(groupVisible)) {
            visible = [firstRadio];
            radioGroup = true;
          }
        }
      }
      if (visible.length === 0) return { mapId: instruction.mapId, pageStatus: "eligible", targetStatus: "hidden", pageSettled, radioGroup: false, pageFields, resolvedPage: currentPage };
      const targetStatus = visible.length === 1 || radioGroup ? "unique" : "ambiguous";
      if (targetStatus === "unique" && visible[0] && mutationWatchAvailable) {
        probedTargets.set(instruction.probeKey, {
          mapId: instruction.mapId,
          pageStep: instruction.pageStep,
          pageUrl,
          target: visible[0],
          radioNodes: radioGroup ? radioGroupNodes(visible[0]) : null,
          mutationVersion: currentProbeMutationVersion(),
          expiresAt: Date.now() + 30_000,
          resolvedPage: currentPage,
          probedLabel: associatedLabelText(visible[0]),
          probedOptionsSignature: visible[0] instanceof HTMLSelectElement ? getOptionsSignature(visible[0]) : null,
        });
      }
      return { mapId: instruction.mapId, pageStatus: "eligible", targetStatus, pageSettled, radioGroup, pageFields, resolvedPage: currentPage };
    }
    return { mapId: instruction.mapId, pageStatus: "eligible", targetStatus: invalid ? "unsupported" : "missing", pageSettled, radioGroup: false, pageFields, resolvedPage: currentPage };
  });
  const proven = applySequencePageEvidence(instructions, results, currentPage);
  // A withheld map must not leave a probe binding behind: apply reads one as
  // "the probe routed this target here".
  proven.forEach((row, index) => {
    if (row.pageStatus === "page_unknown") probedTargets.delete(instructions[index]!.probeKey);
  });
  stopProbeMutationObserverIfUnused();
  return proven;
}

export function applyFill(instructions: FillInstruction[], strictRevalidation = false): FillPageResult {
  return applyFillOnPage(
    instructions,
    typeof location !== "undefined" ? location.href : null,
    strictRevalidation,
  );
}

/** Apply instructions against an explicit page URL. Exported for unit tests;
 * production always goes through `applyFill` → `location.href`. */
export function applyFillOnPage(
  instructions: FillInstruction[],
  pageUrl: string | null,
  strictRevalidation = false,
): FillPageResult {
  const filled: string[] = [];
  const attemptedLabels: string[] = [];
  const writes: NonNullable<FillPageResult["writes"]> = [];
  const skipped: ReportedField[] = [];
  const fieldOutcomes: FillEventV2FieldOutcome[] = [];
  const recordOutcome = (
    instruction: FillInstruction,
    attempted: boolean,
    outcome: FillEventV2Outcome,
    reasonCode: FillEventV2ReasonCode | null,
  ): void => {
    const identity = instruction.telemetry;
    if (!identity) return;
    fieldOutcomes.push({
      mapId: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instruction.mapId)
        ? instruction.mapId
        : null,
      targetKey: identity.targetKey,
      frameKey: identity.frameKey,
      stepKey: identity.stepKey,
      attempted,
      outcome,
      reasonCode,
    });
  };
  // Exact URL-tail identity only. Ambiguous / missing → null; all nonempty
  // step-bound instructions are withheld as page_unknown below.
  const resolvedInstructionPage = instructions.find((i) => i.resolvedPage)?.resolvedPage ?? null;
  const currentPage = resolvedInstructionPage ?? resolveFillPage(
    pageUrl,
    instructions.map((i) => i.pageStep),
  );
  for (const instruction of instructions) {
    let writeAttempted = false;
    const mutationVersion = currentProbeMutationVersion();
    const probedTarget = instruction.probeKey ? probedTargets.get(instruction.probeKey) : undefined;
    if (instruction.probeKey) probedTargets.delete(instruction.probeKey);
    stopProbeMutationObserverIfUnused();
    const effectivePage = instruction.resolvedPage ?? probedTarget?.resolvedPage ?? currentPage;
    try {
      if (isOtherPageInstruction(instruction, effectivePage)) {
        skipped.push(otherPageReport(instruction));
        recordOutcome(instruction, false, "other_page", "other_page");
        continue;
      }
      if (!pageScopeMatches(instruction.pageUrlScope, pageUrl)) {
        skipped.push({
          label: instruction.label,
          reason: "mapping is scoped to a different page",
          mapId: instruction.mapId,
          kind: "other_page",
        });
        recordOutcome(instruction, false, "other_page", "other_page");
        continue;
      }
      if (effectivePage == null && Boolean(instruction.pageStep?.trim()) && !probedTarget) {
        skipped.push(pageUnknownReport(instruction));
        recordOutcome(instruction, false, "page_unknown", "page_unknown");
        continue;
      }
      const resolution = resolveTarget(instruction);
      if (resolution.status === "missing") {
        if (!strictRevalidation) {
          skipped.push({ label: instruction.label, reason: FIELD_NOT_FOUND_REASON, mapId: instruction.mapId, kind: "skipped" });
          continue;
        }
        // A target disappearing between the shape probe and this immediate
        // write-time check is a context change, never a qualified drift miss.
        skipped.push({
          label: instruction.label,
          reason: "form changed during fill; review this field on the portal",
          mapId: instruction.mapId,
          kind: "unverified",
        });
        recordOutcome(instruction, false, "unverified", "context_changed");
        continue;
      }
      if (resolution.status === "hidden") {
        skipped.push({ label: instruction.label, reason: HIDDEN_REASON, mapId: instruction.mapId, kind: HIDDEN_KIND });
        recordOutcome(instruction, false, "hidden", "field_hidden");
        continue;
      }
      if (resolution.status === "ambiguous") {
        skipped.push({ label: instruction.label, reason: "multiple visible controls match this mapping", mapId: instruction.mapId, kind: "no_mapping" });
        recordOutcome(instruction, false, "needs_mapping", "ambiguous_target");
        continue;
      }
      if (resolution.status === "unsupported") {
        skipped.push({ label: instruction.label, reason: "mapping does not resolve to a fillable control", mapId: instruction.mapId, kind: "unverified" });
        recordOutcome(instruction, false, "unsupported", "unsupported_control");
        continue;
      }
      const labelMatches = !probedTarget?.probedLabel ||
        associatedLabelText(resolution.target) === probedTarget.probedLabel;
      const optionsMatch = !probedTarget?.probedOptionsSignature ||
        !(resolution.target instanceof HTMLSelectElement) ||
        getOptionsSignature(resolution.target) === probedTarget.probedOptionsSignature;

      if (strictRevalidation && (
        !probedTarget ||
        probedTarget.mapId !== instruction.mapId ||
        probedTarget.pageStep !== instruction.pageStep ||
        probedTarget.pageUrl !== pageUrl ||
        probedTarget.target !== resolution.target ||
        !resolution.target.isConnected ||
        !sameNodeList(probedTarget.radioNodes, radioGroupNodes(resolution.target)) ||
        probedTarget.mutationVersion !== mutationVersion ||
        !labelMatches ||
        !optionsMatch
      )) {
        skipped.push({
          label: instruction.label,
          reason: "form changed during fill; review this field on the portal",
          mapId: instruction.mapId,
          kind: "unverified",
        });
        recordOutcome(instruction, false, "unverified", "context_changed");
        continue;
      }
      const outcome = applyValue(resolution.target, instruction, () => { writeAttempted = true; });
      if (outcome.ok) {
        filled.push(instruction.label);
        if (outcome.attempted) attemptedLabels.push(instruction.label);
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
        // The production async wrapper settles known masks/date widgets after
        // this immediate setter check; other controls remain readback-unavailable.
        if (!outcome.attempted) {
          skipped.push({
            label: instruction.label,
            reason: "field could not be verified; review it on the portal",
            mapId: instruction.mapId,
            kind: "unverified",
          });
        }
        recordOutcome(
          instruction,
          outcome.attempted,
          "unverified",
          "readback_unavailable",
        );
      } else {
        skipped.push({
          label: instruction.label,
          reason: outcome.reason,
          mapId: instruction.mapId,
          // Explicit, so a producer kind (hidden) survives; the rest state the
          // "skipped" the panel would have defaulted them to anyway.
          kind: outcome.kind ?? "skipped",
        });
        if (outcome.outcome && outcome.reasonCode) {
          recordOutcome(instruction, writeAttempted, outcome.outcome, outcome.reasonCode);
        }
      }
    } catch {
      skipped.push({
        label: instruction.label,
        // Exception text can contain provider data or a form value; keep only
        // a fixed safe reason in both session storage and legacy telemetry.
        reason: "field could not be applied; review it on the portal",
        mapId: instruction.mapId,
        kind: "unverified",
      });
      if (writeAttempted) {
        filled.push(instruction.label);
        attemptedLabels.push(instruction.label);
      }
      recordOutcome(instruction, writeAttempted, "unverified", "context_changed");
    }
  }
  return { filled, attemptedLabels, writes, skipped, pageFields: countPageFields(), fieldOutcomes };
}

function waitForValue<T>(read: () => T | null, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = (): void => {
      let value: T | null;
      try {
        value = read();
      } catch {
        resolve(null);
        return;
      }
      if (value !== null) {
        resolve(value);
      } else if (Date.now() - startedAt >= timeoutMs) {
        resolve(null);
      } else {
        setTimeout(poll, 20);
      }
    };
    poll();
  });
}

function primeFacesPanel(menu: NonNullable<ReturnType<typeof primeFacesSelectMenu>>): Element | null {
  const panelId = menu.select.id.endsWith("_input")
    ? `${menu.select.id.slice(0, -"_input".length)}_panel`
    : `${menu.wrapper.id}_panel`;
  return document.getElementById(panelId) ?? querySelectorDeep(`#${CSS.escape(panelId)}`);
}

function primeFacesItems(menu: NonNullable<ReturnType<typeof primeFacesSelectMenu>>, option: HTMLOptionElement): HTMLElement[] {
  const panel = primeFacesPanel(menu);
  if (!panel) return [];
  return querySelectorAllDeep(".ui-selectonemenu-item", panel)
    .filter((item): item is HTMLElement => item instanceof HTMLElement)
    .filter((item) => {
      const dataValue = item.getAttribute("data-value");
      if (dataValue !== null) return dataValue === option.value;
      const label = item.getAttribute("data-label") ?? item.textContent ?? "";
      return normalize(label) === normalize(option.text);
    });
}

function primeFacesLabel(menu: NonNullable<ReturnType<typeof primeFacesSelectMenu>>): string {
  return menu.wrapper.querySelector<HTMLElement>(".ui-selectonemenu-label")?.textContent ?? "";
}

async function selectPrimeFacesItem(
  menu: NonNullable<ReturnType<typeof primeFacesSelectMenu>>,
  option: HTMLOptionElement,
  isCurrent: () => boolean,
): Promise<boolean> {
  if (!isCurrent()) return false;
  if (menu.select.value === option.value && normalize(primeFacesLabel(menu)) === normalize(option.text)) return true;
  const trigger = menu.wrapper.querySelector<HTMLElement>(".ui-selectonemenu-trigger") ??
    menu.wrapper.querySelector<HTMLElement>(".ui-selectonemenu-label") ?? menu.wrapper;
  trigger.click();
  const items = await waitForValue(() => {
    if (!isCurrent()) return null;
    const matches = primeFacesItems(menu, option);
    return matches.length > 0 ? matches : null;
  }, 700);
  if (!items || items.length !== 1 || !isCurrent()) return false;
  const item = items[0];
  if (!item || item.matches(":disabled, .ui-state-disabled, [aria-disabled='true']")) return false;
  item.click();
  if (!isCurrent()) return false;
  return (await waitForValue(() =>
    isCurrent() && menu.select.value === option.value && normalize(primeFacesLabel(menu)) === normalize(option.text)
      ? true
      : null,
  500)) === true;
}

function selectOptionForInstruction(
  select: HTMLSelectElement,
  instruction: FillInstruction,
): { option: HTMLOptionElement | null; ambiguous: boolean } {
  const enabled = (option: HTMLOptionElement): boolean =>
    !option.disabled && option.closest("optgroup")?.disabled !== true;
  const options = Array.from(select.options).filter(enabled);
  const tiers = instruction.exactSelectValue
    ? [options.filter((option) => option.value === instruction.value)]
    : [
        options.filter((option) => option.value === instruction.value),
        options.filter((option) => normalize(option.text) === normalize(instruction.value)),
        options.filter((option) => normalize(option.value) === normalize(instruction.value)),
      ];
  const matches = tiers.find((tier) => tier.length > 0) ?? [];
  return matches.length === 1
    ? { option: matches[0] ?? null, ambiguous: false }
    : { option: null, ambiguous: matches.length > 1 };
}

function outcomeFor(
  instruction: FillInstruction,
  attempted: boolean,
  outcome: FillEventV2Outcome,
  reasonCode: FillEventV2ReasonCode | null,
): FillEventV2FieldOutcome[] {
  if (!instruction.telemetry) return [];
  return [{
    mapId: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instruction.mapId)
      ? instruction.mapId
      : null,
    targetKey: instruction.telemetry.targetKey,
    frameKey: instruction.telemetry.frameKey,
    stepKey: instruction.telemetry.stepKey,
    attempted,
    outcome,
    reasonCode,
  }];
}

function skippedResult(
  instruction: FillInstruction,
  reason: string,
  kind: ReportedFieldKind,
  outcome: FillEventV2Outcome,
  reasonCode: FillEventV2ReasonCode,
  attempted = false,
): FillPageResult {
  return {
    filled: [],
    attemptedLabels: [],
    writes: [],
    skipped: [{ label: instruction.label, reason, mapId: instruction.mapId, kind }],
    pageFields: countPageFields(),
    fieldOutcomes: outcomeFor(instruction, attempted, outcome, reasonCode),
  };
}

function rejectPostFill(
  result: FillPageResult,
  instruction: FillInstruction,
  target: Fillable,
  reason: string,
  outcome: FillEventV2Outcome,
  reasonCode: FillEventV2ReasonCode,
): void {
  const removeOne = <T>(items: T[] | undefined, matches: (item: T) => boolean): void => {
    if (!items) return;
    let index = -1;
    for (let candidate = items.length - 1; candidate >= 0; candidate -= 1) {
      if (matches(items[candidate] as T)) {
        index = candidate;
        break;
      }
    }
    if (index >= 0) items.splice(index, 1);
  };
  removeOne(result.filled, (label) => label === instruction.label);
  removeOne(result.attemptedLabels, (label) => label === instruction.label);
  removeOne(result.writes, (write) => write.selector === instruction.selector);
  target.classList.remove("mp-fill-static", "mp-fill-ai");
  result.skipped.push({ label: instruction.label, reason, mapId: instruction.mapId, kind: "unverified" });
  const identity = instruction.telemetry;
  const field = identity && result.fieldOutcomes?.find((item) =>
    item.targetKey === identity.targetKey && item.frameKey === identity.frameKey && item.stepKey === identity.stepKey,
  );
  if (field) {
    field.attempted = true;
    field.outcome = outcome;
    field.reasonCode = reasonCode;
  }
}

type PrimeFacesTarget =
  | { ok: true; select: HTMLSelectElement; pageUrl: string | null; probe: ProbedTarget | undefined }
  | { ok: false; result: FillPageResult };

/** What every PrimeFaces widget fill checks before it touches the widget:
 * the page is this mapping's, the selector resolves to ONE visible, enabled
 * backing select of the expected widget kind, and — under strict
 * revalidation — it is exactly the control the shape probe saw. */
function preparePrimeFacesTarget(
  instruction: FillInstruction,
  strictRevalidation: boolean,
  widgetOf: (select: HTMLSelectElement) => HTMLElement | null,
): PrimeFacesTarget {
  const skip = (result: FillPageResult): PrimeFacesTarget => ({ ok: false, result });
  const pageUrl = typeof location !== "undefined" ? location.href : null;
  const probedTarget = instruction.probeKey ? probedTargets.get(instruction.probeKey) : undefined;
  const currentPage = instruction.resolvedPage ?? probedTarget?.resolvedPage ?? resolveFillPage(pageUrl, [instruction.pageStep]);
  if (isOtherPageInstruction(instruction, currentPage)) {
    return skip(skippedResult(instruction, "field belongs to another page", "other_page", "other_page", "other_page"));
  }
  if (!pageScopeMatches(instruction.pageUrlScope, pageUrl)) {
    return skip(skippedResult(instruction, "mapping is scoped to a different page", "other_page", "other_page", "other_page"));
  }
  if (currentPage == null && Boolean(instruction.pageStep?.trim()) && !probedTarget) {
    return skip(skippedResult(instruction, "current wizard page could not be confirmed", "page_unknown", "page_unknown", "page_unknown"));
  }
  const resolution = resolveTarget(instruction);
  if (resolution.status !== "unique" || !(resolution.target instanceof HTMLSelectElement)) {
    const hidden = resolution.status === "hidden";
    const ambiguous = resolution.status === "ambiguous";
    return skip(skippedResult(
      instruction,
      hidden ? HIDDEN_REASON : ambiguous ? "multiple visible controls match this mapping" : "mapping does not resolve to one visible dropdown",
      hidden ? HIDDEN_KIND : ambiguous ? "no_mapping" : "unverified",
      hidden ? "hidden" : ambiguous ? "needs_mapping" : "unverified",
      hidden ? "field_hidden" : ambiguous ? "ambiguous_target" : "context_changed",
    ));
  }
  const select = resolution.target;
  const wrapper = widgetOf(select);
  if (!wrapper) return skip(skippedResult(instruction, "mapping does not resolve to one visible dropdown", "unverified", "unsupported", "unsupported_control"));
  if (isHiddenTarget(select)) return skip(skippedResult(instruction, HIDDEN_REASON, HIDDEN_KIND, "hidden", "field_hidden"));
  if (select.disabled || wrapper.matches(":disabled, .ui-state-disabled") || wrapper.getAttribute("aria-disabled") === "true") {
    return skip(skippedResult(instruction, "field is disabled or read-only", "unverified", "unsupported", "unsupported_control"));
  }

  const probe = instruction.probeKey ? probedTargets.get(instruction.probeKey) : undefined;
  const mutationVersion = currentProbeMutationVersion();
  if (instruction.probeKey) probedTargets.delete(instruction.probeKey);
  stopProbeMutationObserverIfUnused();
  const labelMatches = !probe?.probedLabel ||
    associatedLabelText(select) === probe.probedLabel;
  const optionsMatch = !probe?.probedOptionsSignature ||
    getOptionsSignature(select) === probe.probedOptionsSignature;

  if (strictRevalidation && (
    !probe || probe.mapId !== instruction.mapId || probe.pageStep !== instruction.pageStep ||
    probe.pageUrl !== pageUrl || probe.target !== select || probe.mutationVersion !== mutationVersion ||
    !labelMatches || !optionsMatch
  )) {
    return skip(skippedResult(instruction, "form changed during fill; review this field on the portal", "unverified", "unverified", "context_changed"));
  }
  return { ok: true, select, pageUrl, probe };
}

/** A widget fill that landed: `decorated` is what was changed (null when the
 * field already held the value, so nothing was written). */
function widgetFilledResult(instruction: FillInstruction, decorated: Fillable | null): FillPageResult {
  const unchanged = decorated === null;
  if (decorated) decorateFill(decorated, instruction.kind ?? "static", instruction.token);
  return {
    filled: [instruction.label],
    attemptedLabels: unchanged ? [] : [instruction.label],
    writes: unchanged ? [] : [{
      selector: instruction.selector,
      kind: instruction.kind ?? "static" as const,
      ...(instruction.token ? { token: instruction.token } : {}),
      ...(instruction.confidence != null ? { confidence: instruction.confidence } : {}),
    }],
    skipped: [],
    pageFields: countPageFields(),
    fieldOutcomes: outcomeFor(instruction, !unchanged, unchanged ? "unchanged" : "unverified", unchanged ? "unchanged_value" : "readback_unavailable"),
  };
}

/** Apply PrimeFaces menus through their actual visible options. Writing the
 * aria-hidden backing select first leaves PrimeFaces' internal value stale. */
async function applyPrimeFacesSelect(
  instruction: FillInstruction,
  strictRevalidation: boolean,
): Promise<FillPageResult> {
  const prepared = preparePrimeFacesTarget(
    instruction,
    strictRevalidation,
    (candidate) => primeFacesSelectMenu(candidate)?.wrapper ?? null,
  );
  if (!prepared.ok) return prepared.result;
  const { select, pageUrl, probe } = prepared;
  const menu = primeFacesSelectMenu(select);
  if (!menu) return skippedResult(instruction, "mapping does not resolve to one visible dropdown", "unverified", "unsupported", "unsupported_control");

  const selection = selectOptionForInstruction(select, instruction);
  if (!selection.option) {
    return selection.ambiguous
      ? skippedResult(instruction, "dropdown: multiple options match the mapped value", "no_mapping", "needs_mapping", "ambiguous_target")
      : skippedResult(instruction, vocabularyMismatchReason("dropdown"), "skipped", "option_mismatch", "option_missing");
  }
  const option = selection.option;
  const optionValue = option.value;
  const optionText = option.text;
  const optionSetSignature = probe?.probedOptionsSignature ?? getOptionsSignature(select);
  const isCurrent = (): boolean => {
    if (typeof location !== "undefined" && location.href !== pageUrl) return false;
    const current = resolveTarget(instruction);
    return current.status === "unique" && current.target === select && select.isConnected &&
      Array.from(select.options).includes(option) && option.value === optionValue && option.text === optionText &&
      getOptionsSignature(select) === optionSetSignature &&
      menu.wrapper.isConnected && !isHiddenTarget(select) && !select.disabled &&
      !menu.wrapper.matches(":disabled, .ui-state-disabled") &&
      menu.wrapper.getAttribute("aria-disabled") !== "true";
  };
  const unchanged = select.value === option.value && normalize(primeFacesLabel(menu)) === normalize(option.text);
  if (!unchanged) {
    let selected: boolean;
    activePrimeFacesMenu = menu;
    try {
      selected = await selectPrimeFacesItem(menu, option, isCurrent);
    } catch {
      return skippedResult(instruction, "field could not be applied; review it on the portal", "unverified", "unverified", "context_changed", true);
    } finally {
      // Drain this interaction's records while its narrow widget scope is active.
      currentProbeMutationVersion();
      activePrimeFacesMenu = null;
    }
    if (!isCurrent()) {
      return skippedResult(instruction, "form changed during fill; review this field on the portal", "unverified", "unverified", "context_changed", true);
    }
    if (!selected) {
      return skippedResult(
        instruction,
        "dropdown selection did not remain visible; review this field on the portal",
        "unverified",
        "write_rejected",
        "readback_mismatch",
        true,
      );
    }
  }
  return widgetFilledResult(instruction, unchanged ? null : select);
}

/** Add ONE option to a PrimeFaces SelectManyMenu by ctrl-clicking its visible
 * list item, the way a person adds to a multi-selection. A value names one
 * option — a profile token resolves to a single string, and the wire has no
 * list-valued token — so the fill adds that option and never removes another
 * choice: clearing what a coordinator picked is not a write it can justify. */
async function applyPrimeFacesList(
  instruction: FillInstruction,
  strictRevalidation: boolean,
): Promise<FillPageResult> {
  const prepared = preparePrimeFacesTarget(
    instruction,
    strictRevalidation,
    (candidate) => primeFacesSelectManyMenu(candidate)?.wrapper ?? null,
  );
  if (!prepared.ok) return prepared.result;
  const { select, pageUrl, probe } = prepared;
  const list = primeFacesSelectManyMenu(select);
  const pairs = list ? primeFacesListItems(list) : null;
  if (!list || !pairs) {
    return skippedResult(instruction, "list items do not line up with the field's options; review this field on the portal", "unverified", "unsupported", "unsupported_control");
  }

  const selection = selectOptionForInstruction(select, instruction);
  if (!selection.option) {
    return selection.ambiguous
      ? skippedResult(instruction, "dropdown: multiple options match the mapped value", "no_mapping", "needs_mapping", "ambiguous_target")
      : skippedResult(instruction, vocabularyMismatchReason("dropdown"), "skipped", "option_mismatch", "option_missing");
  }
  const pair = pairs.find((candidate) => candidate.option === selection.option);
  if (!pair) {
    return skippedResult(instruction, "list items do not line up with the field's options; review this field on the portal", "unverified", "unsupported", "unsupported_control");
  }
  // DYN-PAGE-02, guarded on the item about to be CLICKED (a list filter hides
  // items while the widget stays visible) — the same rule as a radio option.
  if (isHiddenControl(pair.item)) return skippedResult(instruction, HIDDEN_REASON, HIDDEN_KIND, "hidden", "field_hidden");
  if (pair.item.matches(".ui-state-disabled, [aria-disabled='true']")) {
    return skippedResult(instruction, "field is disabled or read-only", "unverified", "unsupported", "unsupported_control");
  }
  if (isListItemChosen(pair)) return widgetFilledResult(instruction, null);
  // Highlighted but not posted: a ctrl-click would toggle it OFF.
  if (pair.item.classList.contains("ui-state-highlight")) {
    return skippedResult(instruction, "list selection disagrees with the field; review this field on the portal", "unverified", "unverified", "readback_mismatch");
  }
  const others = pairs.filter((candidate) => candidate !== pair && candidate.option.selected).map(({ option }) => option);
  if (others.length > 0 && listClickClearsOthers(list)) {
    return skippedResult(instruction, "this list replaces its other choices on click; review this field on the portal", "unverified", "unsupported", "unsupported_control");
  }

  const optionSetSignature = probe?.probedOptionsSignature ?? getOptionsSignature(select);
  const isCurrent = (): boolean => {
    if (typeof location !== "undefined" && location.href !== pageUrl) return false;
    const current = resolveTarget(instruction);
    return current.status === "unique" && current.target === select && select.isConnected &&
      pair.item.isConnected && getOptionsSignature(select) === optionSetSignature &&
      !isHiddenTarget(select) && !isHiddenControl(pair.item) && !select.disabled;
  };
  let chosen: boolean;
  activePrimeFacesList = list;
  try {
    toggleListItem(pair.item);
    chosen = (await waitForValue(() => (isCurrent() && isListItemChosen(pair) ? true : null), 500)) === true;
  } catch {
    return skippedResult(instruction, "field could not be applied; review it on the portal", "unverified", "unverified", "context_changed", true);
  } finally {
    // Drain this interaction's records while its narrow widget scope is active.
    currentProbeMutationVersion();
    activePrimeFacesList = null;
  }
  if (!isCurrent()) {
    return skippedResult(instruction, "form changed during fill; review this field on the portal", "unverified", "unverified", "context_changed", true);
  }
  if (!chosen) {
    return skippedResult(instruction, "list selection did not remain visible; review this field on the portal", "unverified", "write_rejected", "readback_mismatch", true);
  }
  if (others.some((option) => !option.selected)) {
    return skippedResult(instruction, "selecting it cleared the list's other choices; review this field on the portal", "unverified", "write_rejected", "readback_mismatch", true);
  }
  // Outline the list the coordinator reviews, not its 0×0 backing select.
  return widgetFilledResult(instruction, list.wrapper);
}

/** Production fill path. Generic fields keep the synchronous engine; date
 * masks get one bounded post-write readback for the whole routed batch. */
export async function applyFillSettled(
  instructions: FillInstruction[],
  strictRevalidation = false,
): Promise<FillPageResult> {
  const regular: FillInstruction[] = [];
  const widgets: Array<{ instruction: FillInstruction; apply: typeof applyPrimeFacesSelect }> = [];
  const dateTargets: Array<{ instruction: FillInstruction; target: Fillable }> = [];
  for (const instruction of instructions) {
    const resolution = resolveTarget(instruction);
    const select = resolution.status === "unique" && resolution.target instanceof HTMLSelectElement
      ? resolution.target
      : null;
    if (select && primeFacesSelectManyMenu(select)) {
      widgets.push({ instruction, apply: applyPrimeFacesList });
    } else if (select && primeFacesSelectMenu(select)) {
      widgets.push({ instruction, apply: applyPrimeFacesSelect });
    } else {
      regular.push(instruction);
      if (resolution.status === "unique") {
        const target = resolution.target;
        const dateWidget = target instanceof HTMLInputElement && Boolean(target.closest(".p-datepicker.ui-calendar"));
        if (instruction.nativeDateValue || instruction.fieldType === "date" || dateWidget) {
          dateTargets.push({ instruction, target });
        }
      }
    }
  }
  const result = applyFill(regular, strictRevalidation);
  for (const { instruction, apply } of widgets) {
    let widgetResult: FillPageResult;
    try {
      widgetResult = await apply(instruction, strictRevalidation);
    } catch {
      // Keep one misbehaving widget from discarding successful writes to
      // unrelated fields. Exception text can contain provider data.
      widgetResult = skippedResult(instruction, "field could not be applied; review it on the portal", "unverified", "unverified", "context_changed", true);
    }
    result.filled.push(...widgetResult.filled);
    result.attemptedLabels?.push(...(widgetResult.attemptedLabels ?? []));
    result.writes?.push(...(widgetResult.writes ?? []));
    result.skipped.push(...widgetResult.skipped);
    result.fieldOutcomes?.push(...(widgetResult.fieldOutcomes ?? []));
  }

  const writtenDates = dateTargets.filter(({ instruction }) =>
    !result.skipped.some((field) => field.mapId === instruction.mapId) &&
    result.filled.includes(instruction.label),
  );
  if (writtenDates.length > 0) await new Promise((resolve) => setTimeout(resolve, 125));
  for (const { instruction, target } of writtenDates) {
    const currentResolution = resolveTarget(instruction);
    if (currentResolution.status !== "unique" || currentResolution.target !== target || !target.isConnected || isHiddenTarget(target)) {
      rejectPostFill(result, instruction, target, "form changed after fill; review this field before submitting", "unverified", "context_changed");
      continue;
    }
    const isInputOrTextarea = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    const expected = target instanceof HTMLInputElement && target.type === "date"
      ? instruction.nativeDateValue ?? safeNativeDate(instruction.value) ?? ""
      : instruction.value;
    if (isInputOrTextarea && target.value !== expected) {
      rejectPostFill(result, instruction, target, "portal changed the date after fill; review this field on the portal", "write_rejected", "mask_reverted");
      continue;
    }
    if (isInputOrTextarea && target.willValidate && !target.validity.valid) {
      rejectPostFill(result, instruction, target, "form rejected the field format; review this field on the portal", "write_rejected", "invalid_format");
    }
  }
  return result;
}
