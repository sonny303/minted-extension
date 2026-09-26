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
  isOtherPageInstruction,
  otherPageReport,
  pageUnknownReport,
  resolveFillPage,
} from "../shared/fillPage";
import { FIELD_NOT_FOUND_REASON } from "../shared/fixit";
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

type Fillable = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface ProbedTarget {
  mapId: string;
  pageStep: string | null;
  pageUrl: string | null;
  target: Fillable;
  radioNodes: HTMLInputElement[] | null;
  mutationVersion: number;
  expiresAt: number;
}

// DOM references stay only in this content-script frame's short-lived memory.
// The opaque probe key binds APPLY_FILL to the exact node observed by probe.
const probedTargets = new Map<string, ProbedTarget>();
let probeMutationObserver: MutationObserver | null = null;
let probeMutationVersion = 0;

function ensureProbeMutationObserver(): boolean {
  if (probeMutationObserver) return true;
  if (typeof MutationObserver === "undefined" || !document.documentElement) return false;
  probeMutationObserver = new MutationObserver((records) => {
    if (records.length > 0) probeMutationVersion += 1;
  });
  probeMutationObserver.observe(document.documentElement, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  return true;
}

function currentProbeMutationVersion(): number {
  const records = probeMutationObserver?.takeRecords() ?? [];
  if (records.length > 0) probeMutationVersion += 1;
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
    let visible = fillable.filter((control) => !isHiddenControl(control));
    if (visible.length === 0 && instruction.fieldType === "radio" && fillable.every((item) => item instanceof HTMLInputElement && item.type === "radio")) {
      const firstRadio = fillable[0] as HTMLInputElement | undefined;
      if (firstRadio) {
        const group = firstRadio.name
          ? querySelectorAllDeep(`input[type="radio"][name="${CSS.escape(firstRadio.name)}"]`, firstRadio.form ?? document)
              .filter((node): node is HTMLInputElement => node instanceof HTMLInputElement)
          : [firstRadio];
        const groupVisible = group.filter((radio) => !isHiddenControl(radio));
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
  | { ok: true; attempted: boolean }
  | { ok: false; reason: string; kind?: ReportedFieldKind; outcome?: FillEventV2Outcome; reasonCode?: FillEventV2ReasonCode };

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
  // The visibility guard belongs HERE, not on the resolved element: a radio
  // group is one field made of N controls, and `match` — the one that gets
  // clicked — need not be the one the selector resolved to.
  if (isHiddenControl(match)) return HIDDEN_OUTCOME;
  if (!match.checked) {
    markAttempted();
    match.click();
    return { ok: true, attempted: true };
  }
  return { ok: true, attempted: false };
}

function applyCheckbox(el: HTMLInputElement, value: string, markAttempted: () => void): ApplyOutcome {
  const wantChecked = TRUTHY.has(normalize(value));
  if (el.checked !== wantChecked) {
    markAttempted();
    el.click();
    return { ok: true, attempted: true };
  }
  return { ok: true, attempted: false };
}

function applySelect(el: HTMLSelectElement, value: string, markAttempted: () => void): ApplyOutcome {
  const options = Array.from(el.options);
  const match =
    options.find((option) => option.value === value) ??
    options.find((option) => normalize(option.text) === normalize(value)) ??
    options.find((option) => normalize(option.value) === normalize(value));
  if (!match) {
    return {
      ok: false,
      reason: vocabularyMismatchReason("dropdown"),
      outcome: "option_mismatch",
      reasonCode: "option_missing",
    };
  }
  if (el.value !== match.value) {
    markAttempted();
    el.value = match.value;
    fireChanged(el);
    return { ok: true, attempted: true };
  }
  return { ok: true, attempted: false };
}

function applyValue(el: Fillable, instruction: FillInstruction, markAttempted: () => void): ApplyOutcome {
  const isRadio = el instanceof HTMLInputElement && el.type === "radio";
  // DYN-PAGE-02 — never mutate a control the coordinator cannot see. A wizard
  // that keeps every step in the DOM and hides the inactive ones would
  // otherwise take a silent write into a panel nobody reviews before
  // submitting. Radio defers its own check to applyRadio, which knows which
  // group member is actually about to be clicked.
  if (!isRadio && isHiddenControl(el)) return HIDDEN_OUTCOME;
  if (el instanceof HTMLSelectElement)
    return applySelect(el, instruction.value, markAttempted);
  if (isRadio) {
    return applyRadio(el as HTMLInputElement, instruction.value, markAttempted);
  }
  if (el instanceof HTMLInputElement && el.type === "checkbox") {
    return applyCheckbox(el, instruction.value, markAttempted);
  }
  if (el instanceof HTMLInputElement && el.type === "file") {
    // Belt and braces: the background never plans file fields.
    return { ok: false, reason: "file inputs cannot be filled" };
  }
  if (el instanceof HTMLInputElement && (el.disabled || el.readOnly)) {
    return { ok: false, reason: "field is disabled or read-only", outcome: "unsupported", reasonCode: "unsupported_control" };
  }
  markAttempted();
  setNativeValue(el, instruction.value);
  return { ok: true, attempted: true };
}

// The page's fillable controls — the denominator for honest coverage
// reporting ("filled 3 of 24 mapped · ~117 fields on this page").
function countPageFields(): number {
  return querySelectorAllDeep(FILLABLE).length;
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
export async function probeFillOnPage(instructions: FillProbeInstruction[]): Promise<FillProbeResult[]> {
  const pageSettled = await waitForPageSettled();
  pruneProbedTargets();
  const mutationWatchAvailable = ensureProbeMutationObserver();
  const pageUrl = typeof location !== "undefined" ? location.href : null;
  const currentPage = resolveFillPage(
    pageUrl,
    instructions.map((instruction) => instruction.pageStep),
  );
  const pageFields = countPageFields();
  const results: FillProbeResult[] = instructions.map((instruction) => {
    probedTargets.delete(instruction.probeKey);
    if (isOtherPageInstruction(instruction, currentPage)) {
      return { mapId: instruction.mapId, pageStatus: "other_page", targetStatus: "missing", pageSettled, radioGroup: false, pageFields };
    }
    if (currentPage == null && Boolean(instruction.pageStep?.trim())) {
      return { mapId: instruction.mapId, pageStatus: "page_unknown", targetStatus: "missing", pageSettled, radioGroup: false, pageFields };
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
        if (matches.length > 0) return { mapId: instruction.mapId, pageStatus: "eligible", targetStatus: "unsupported", pageSettled, radioGroup: false, pageFields };
        continue;
      }
      let visible = fillable.filter((control) => !isHiddenControl(control));
      let radioGroup = instruction.fieldType === "radio" && sameRadioGroup(visible);
      if (visible.length === 0 && instruction.fieldType === "radio" && fillable.every((item) => item instanceof HTMLInputElement && item.type === "radio")) {
        const firstRadio = fillable[0] as HTMLInputElement | undefined;
        if (firstRadio) {
          const group = firstRadio.name
            ? querySelectorAllDeep(`input[type="radio"][name="${CSS.escape(firstRadio.name)}"]`, firstRadio.form ?? document)
                .filter((node): node is HTMLInputElement => node instanceof HTMLInputElement)
            : [firstRadio];
          const groupVisible = group.filter((radio) => !isHiddenControl(radio));
          if (groupVisible.length > 0 && sameRadioGroup(groupVisible)) {
            visible = [firstRadio];
            radioGroup = true;
          }
        }
      }
      if (visible.length === 0) return { mapId: instruction.mapId, pageStatus: "eligible", targetStatus: "hidden", pageSettled, radioGroup: false, pageFields };
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
        });
      }
      return { mapId: instruction.mapId, pageStatus: "eligible", targetStatus, pageSettled, radioGroup, pageFields };
    }
    return { mapId: instruction.mapId, pageStatus: "eligible", targetStatus: invalid ? "unsupported" : "missing", pageSettled, radioGroup: false, pageFields };
  });
  stopProbeMutationObserverIfUnused();
  return results;
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
  const currentPage = resolveFillPage(
    pageUrl,
    instructions.map((i) => i.pageStep),
  );
  for (const instruction of instructions) {
    let writeAttempted = false;
    const mutationVersion = currentProbeMutationVersion();
    const probedTarget = instruction.probeKey ? probedTargets.get(instruction.probeKey) : undefined;
    if (instruction.probeKey) probedTargets.delete(instruction.probeKey);
    stopProbeMutationObserverIfUnused();
    try {
      if (isOtherPageInstruction(instruction, currentPage)) {
        skipped.push(otherPageReport(instruction));
        recordOutcome(instruction, false, "other_page", "other_page");
        continue;
      }
      if (currentPage == null && Boolean(instruction.pageStep?.trim())) {
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
      if (strictRevalidation && (
        !probedTarget ||
        probedTarget.mapId !== instruction.mapId ||
        probedTarget.pageStep !== instruction.pageStep ||
        probedTarget.pageUrl !== pageUrl ||
        probedTarget.target !== resolution.target ||
        probedTarget.mutationVersion !== mutationVersion ||
        !sameNodeList(probedTarget.radioNodes, radioGroupNodes(resolution.target))
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
        // R1 knows the setter accepted the write, not that the portal retained
        // it. Semantic readback arrives in R3.
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
          recordOutcome(instruction, false, outcome.outcome, outcome.reasonCode);
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
  return { filled, attemptedLabels, skipped, pageFields: countPageFields(), fieldOutcomes };
}
