// 2026-08-19 — the manual element picker: let a trainer point at a control the
// automatic scan did not capture, and add it by hand.
//
// Why it exists: a scan can only see what is on the page AT THAT MOMENT and
// wired well enough to recognise. On the Humana status form the NPI box is
// revealed only after a radio choice, so a capture taken first correctly skips
// it — and there was no way to add it afterwards short of re-capturing at
// exactly the right instant. The picker removes that timing dependency.
//
// Boundary, unchanged and load-bearing: this reads the SHAPE of the element
// the user clicks — its label text, selector and control type, via the SAME
// `describeControl` the scanner uses — and never its value. Pointing at a box
// that already contains an NPI captures "there is a text box here called NPI",
// never the digits.
import { describeControl, nearestCapturableControl, type CapturedField } from "./captureScan";

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

/** True while a pick is in progress — the worker refuses to start a second. */
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

/** How many elements a selector currently matches on this page — the
 * "re-test selector" answer. 1 is healthy; 0 means it will never fill, and >1
 * means it is ambiguous and may fill the wrong box. An invalid selector counts
 * as 0 rather than throwing across the messaging boundary. */
export function countSelectorMatches(selector: string): number {
  try {
    return document.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}
