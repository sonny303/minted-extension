// BITE-TRAIN-01 — the in-progress row edit, held as state instead of in the DOM.
//
// The row editor is rebuilt from scratch on every `renderCapture()`, and
// renderCapture runs for reasons the trainer did not ask for: a selector test,
// a tab switch (`tabs.onActivated` → portal detection), a pick. Reading the
// inputs' current values back out of the DOM is therefore impossible — they
// have already been replaced. So the draft lives here, keyed by the row it
// belongs to, and the inputs are rendered FROM it.
//
// It also fixes the verdict: "Test selector" tests what is TYPED, so its answer
// has to be matched against the DRAFT selector, not the stored one. Keyed to
// the row it would only ever show for a selector the trainer had not edited —
// which is the one case the workshop does not exist for.

import type { PortalFieldType } from "./apiTypes";
import type { CaptureRow, CaptureRowEdit } from "./capture";
import type { SelectorTestResult } from "./messages";

export interface CaptureRowDraft {
  /** The row this draft belongs to — its CURRENT stored selector, which is
   * also the key `EDIT_CAPTURE_ROW` identifies the row by. */
  rowSelector: string;
  displayLabel: string;
  fieldType: PortalFieldType;
  /** What is typed in the CSS selector box, which may not be saved yet. */
  selectorText: string;
}

/** The draft to render the editor from: the one in hand when it belongs to this
 * row, else a fresh one seeded from the stored row. */
export function draftForRow(row: CaptureRow, held: CaptureRowDraft | null): CaptureRowDraft {
  if (held != null && held.rowSelector === row.selector) return held;
  return {
    rowSelector: row.selector,
    displayLabel: row.displayLabel ?? "",
    fieldType: row.fieldType,
    selectorText: row.selector,
  };
}

/**
 * The patch a Save should send — only the keys the trainer actually changed.
 *
 * `EDIT_CAPTURE_ROW` reads a present `fieldType` as a human override and a
 * present `newSelector` as a hand-written selector, both of which exempt the
 * row from future drift repair. Opening the editor and saving a rename must
 * not do either.
 */
export function draftEdit(row: CaptureRow, draft: CaptureRowDraft): CaptureRowEdit {
  const selector = draft.selectorText.trim();
  return {
    displayLabel: draft.displayLabel,
    ...(draft.fieldType !== row.fieldType ? { fieldType: draft.fieldType } : {}),
    ...(selector !== "" && selector !== row.selector ? { newSelector: selector } : {}),
  };
}

/** The match count to show, or null when the verdict in hand answers a
 * different selector than the one now in the box (the trainer kept typing). */
export function draftTestMatches(
  draft: CaptureRowDraft,
  result: SelectorTestResult | null,
): number | null {
  if (result == null) return null;
  return result.selector === draft.selectorText.trim() ? result.matches : null;
}
