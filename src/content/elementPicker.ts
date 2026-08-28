// 2026-08-19 — the manual element picker: let a trainer point at a control the
// automatic scan did not capture, and add it by hand.
//
// Why it exists: a scan can only see what is on the page AT THAT MOMENT and
// wired well enough to recognise. On one example enrollment status form the NPI box is
// revealed only after a radio choice, so a capture taken first correctly skips
// it — and there was no way to add it afterwards short of re-capturing at
// exactly the right instant. The picker removes that timing dependency.
//
// Boundary, unchanged and load-bearing: this reads the SHAPE of the element
// the user clicks — its label text, selector and control type, via the SAME
// `describeControl` the scanner uses — and never its value. Pointing at a box
// that already contains an NPI captures "there is a text box here called NPI",
// never the digits.
import type { SelectorMatchReport } from "../shared/selectorMatch";
import { byLabel, LABEL_SELECTOR_PREFIX } from "./fillEngine";
import {
  describeControl,
  nearestCapturableControl,
  type CapturedField,
} from "./captureScan";

/** What the pick produced. `cancelled` is a first-class outcome, not an error:
 * pressing Escape is a normal thing to do and must not surface as a failure. */
export type PickOutcome =
  | { status: "picked"; field: CapturedField }
  | { status: "cancelled" };

const OVERLAY_ID = "__minted-panel-pick-overlay";
const HINT_ID = "__minted-panel-pick-hint";
const STYLE_ID = "__minted-panel-pick-style";

// Above anything a portal is plausibly using, but still a real number rather
// than the max — a page that wants to sit on top of us can, and that is
// better than fighting an unwinnable z-index war.
const OVERLAY_Z = 2147483000;

const STYLE = `
  .__mp-pick-active, .__mp-pick-active * { cursor: crosshair !important; }
  #${OVERLAY_ID} {
    position: fixed; pointer-events: none; z-index: ${OVERLAY_Z};
    border: 2px solid #1B4D3E; background: rgba(27,77,62,.12);
    border-radius: 3px; transition: all 60ms linear;
  }
  #${HINT_ID} {
    position: fixed; z-index: ${OVERLAY_Z + 1}; left: 50%; top: 16px;
    transform: translateX(-50%); pointer-events: none;
    background: #1B4D3E; color: #fff; font: 500 13px/1.4 system-ui, sans-serif;
    padding: 8px 14px; border-radius: 6px; max-width: 90vw; text-align: center;
    box-shadow: 0 2px 12px rgba(0,0,0,.25);
  }
`;

let activePick: (() => void) | null = null;

/** True while a pick is in progress. `startElementPick` self-cancels any
 * prior pick rather than being refused — the worker never calls this; it
 * exists for tests and callers that want to check without starting one. */
export function isPicking(): boolean {
  return activePick != null;
}

/** Cancel an in-flight pick from outside (panel closed, tab switched). */
export function cancelElementPick(): void {
  activePick?.();
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.append(style);
}

function makeOverlay(): { box: HTMLElement; hint: HTMLElement } {
  const box = document.createElement("div");
  box.id = OVERLAY_ID;
  const hint = document.createElement("div");
  hint.id = HINT_ID;
  hint.textContent = "Click the field to add it · Esc to cancel";
  document.body.append(box, hint);
  return { box, hint };
}

function moveOverlay(box: HTMLElement, target: Element | null): void {
  if (target == null) {
    box.style.display = "none";
    return;
  }
  const rect = target.getBoundingClientRect();
  box.style.display = "block";
  box.style.top = `${rect.top - 2}px`;
  box.style.left = `${rect.left - 2}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}

/**
 * Enter pick mode and resolve with the control the user clicks.
 *
 * Every listener is CAPTURE-phase and swallows the event it acts on, so
 * clicking a radio during a pick does not also select it, and clicking a
 * submit-adjacent control cannot navigate the page out from under the
 * trainer. That matters more than usual here: the whole point is to point at
 * a live portal form mid-workflow without disturbing it.
 */
export function startElementPick(): Promise<PickOutcome> {
  // A second pick would leave two overlays and two listener sets fighting over
  // the same click; resolve the first as cancelled and start clean.
  cancelElementPick();

  return new Promise<PickOutcome>((resolve) => {
    ensureStyle();
    const { box, hint } = makeOverlay();
    document.documentElement.classList.add("__mp-pick-active");
    let hovered: Element | null = null;

    const teardown = (): void => {
      document.documentElement.classList.remove("__mp-pick-active");
      box.remove();
      hint.remove();
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("blur", onCancel);
      activePick = null;
    };

    const finish = (outcome: PickOutcome): void => {
      teardown();
      resolve(outcome);
    };

    const onCancel = (): void => finish({ status: "cancelled" });

    function onMove(event: MouseEvent): void {
      hovered = nearestCapturableControl(event.target as Element | null);
      moveOverlay(box, hovered);
      hint.textContent = hovered
        ? "Click the field to add it · Esc to cancel"
        : "Point at a form field · Esc to cancel";
    }

    function onClick(event: MouseEvent): void {
      // Swallow first, decide second: even a click on empty space must not
      // reach the page while the picker owns the cursor.
      event.preventDefault();
      event.stopPropagation();
      const target = nearestCapturableControl(event.target as Element | null);
      if (target == null) return; // nothing mappable — stay in pick mode
      finish({ status: "picked", field: describeControl(target) });
    }

    function onKey(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish({ status: "cancelled" });
    }

    function onContextMenu(event: MouseEvent): void {
      event.preventDefault();
      finish({ status: "cancelled" });
    }

    activePick = onCancel;
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    // Leaving the tab abandons the pick rather than leaving a live overlay
    // behind on a page the trainer has walked away from.
    window.addEventListener("blur", onCancel);
  });
}

/** Can the fill engine write to this element? Mirrors `bySelector` in
 * `fillEngine.ts` EXACTLY — a selector the workshop calls healthy and the
 * engine then skips is worse than no verdict at all, so the two definitions of
 * "a field" have to be the same one. Pinned by a parity test. */
function isFillable(el: Element): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  );
}

/** Are these matches the N controls of ONE radio group? That is a single field
 * rendered as N inputs — the shape the scanner's own name-based selector
 * produces — and calling it ambiguity would send a trainer to "fix" a correct
 * selector. */
function isOneRadioGroup(els: readonly Element[]): boolean {
  if (els.length < 2) return false;
  const names = new Set<string>();
  for (const el of els) {
    if (!(el instanceof HTMLInputElement) || el.type !== "radio" || !el.name)
      return false;
    names.add(el.name);
  }
  return names.size === 1;
}

/** What a selector would DO on this page: not just how many elements it hits,
 * but how many of those the engine could fill, and whether they are one radio
 * group. `selectorVerdict` (shared/selectorMatch.ts) turns this into words —
 * the page measures, the panel interprets.
 *
 * An invalid selector is reported as `valid: false` rather than thrown across
 * the messaging boundary, and is deliberately NOT collapsed into "matched
 * nothing": the fix for a typo is not the fix for a missing field. */
export function describeSelectorMatches(selector: string): SelectorMatchReport {
  // A `label:` selector is not CSS and querySelectorAll cannot parse it. The
  // shared library really stores maps that way, so testing one raw reported
  // "matches nothing" for a field that fills perfectly — and, in the capture
  // list, made every label-addressed library field read as drift.
  if (selector.startsWith(LABEL_SELECTOR_PREFIX)) {
    const hit = byLabel(selector.slice(LABEL_SELECTOR_PREFIX.length)) != null;
    return {
      valid: true,
      matches: hit ? 1 : 0,
      fillable: hit ? 1 : 0,
      radioGroup: false,
    };
  }
  let els: Element[];
  try {
    els = Array.from(document.querySelectorAll(selector));
  } catch {
    return { valid: false, matches: 0, fillable: 0, radioGroup: false };
  }
  return {
    valid: true,
    matches: els.length,
    fillable: els.filter(isFillable).length,
    radioGroup: isOneRadioGroup(els),
  };
}

/** How many elements a selector currently matches on this page. Kept as the
 * raw count for callers that only need a number; the trainer-facing answer is
 * `describeSelectorMatches`, because the count alone gets a wrapper, a radio
 * group and a typo all wrong. */
export function countSelectorMatches(selector: string): number {
  return describeSelectorMatches(selector).matches;
}

// ---------------------------------------------------------------------------
// US-3.2 — Selector Workshop: show the trainer WHICH element a selector hits.
// ---------------------------------------------------------------------------

const HIGHLIGHT_CLASS = "__mp-selector-hit";
const HIGHLIGHT_STYLE_ID = "__minted-panel-highlight-style";
/** Long enough to look at, short enough that a forgotten highlight never
 * becomes page furniture. */
const HIGHLIGHT_MS = 2500;

// Bright green, deliberately unlike the pick overlay's forest green: one says
// "this is what I would hover", the other "this is what your selector found".
const HIGHLIGHT_STYLE = `
  .${HIGHLIGHT_CLASS} {
    outline: 3px solid #16a34a !important;
    outline-offset: 1px !important;
    background-color: rgba(22,163,74,.18) !important;
    transition: none !important;
  }
`;

let highlightTimer: number | null = null;

function clearHighlight(): void {
  if (highlightTimer != null) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  for (const el of document.querySelectorAll(`.${HIGHLIGHT_CLASS}`)) {
    el.classList.remove(HIGHLIGHT_CLASS);
  }
}

/**
 * Flash every element the selector matches in bright green, and say how many
 * there were.
 *
 * Decorating with a CLASS rather than inline styles means the page's own
 * styles are never overwritten and the cleanup is a class removal that cannot
 * leave a control looking edited. The first match is scrolled into view —
 * a highlight below the fold answers nothing.
 */
export function highlightSelectorReport(selector: string): SelectorMatchReport {
  clearHighlight();
  if (!document.getElementById(HIGHLIGHT_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = HIGHLIGHT_STYLE;
    document.head.append(style);
  }
  let matches: Element[];
  try {
    matches = Array.from(document.querySelectorAll(selector));
  } catch {
    // Invalid CSS: nothing to paint, and the report says WHY so the panel can
    // tell a typo from a field that is genuinely gone.
    return { valid: false, matches: 0, fillable: 0, radioGroup: false };
  }
  for (const el of matches) el.classList.add(HIGHLIGHT_CLASS);
  // Optional-called: scrolling is a courtesy, and a context that does not
  // implement it must not turn a successful test into a thrown error.
  matches[0]?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  if (matches.length > 0) {
    highlightTimer = setTimeout(
      clearHighlight,
      HIGHLIGHT_MS,
    ) as unknown as number;
  }
  return describeSelectorMatches(selector);
}

/** The count-only form, for the tests and callers that want a number. */
export function highlightSelector(selector: string): number {
  return highlightSelectorReport(selector).matches;
}
