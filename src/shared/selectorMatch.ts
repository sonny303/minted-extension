// The Selector Workshop's verdict: what a typed CSS selector would actually do
// on this page, said in the trainer's words.
//
// The first cut answered ONE question — `document.querySelectorAll(sel).length`
// — and read the answer as health: 1 good, 0 never fills, N ambiguous. Three
// common cases in the mapping loop get the wrong verdict that way, each
// reproduced against the real engine before this module existed:
//
//   * a WRAPPER (`#npi-field` on the div around the input) matches exactly one
//     element, so it showed the green "matches exactly one field" — while the
//     fill engine resolves through `bySelector`, which accepts only
//     input/select/textarea, and skips it as "field not found on this page".
//     The verdict said the opposite of the truth in the one place a trainer
//     goes to be sure;
//   * a RADIO GROUP is one field made of N controls, and the scanner's own
//     `input[type="radio"][name="…"]` selector therefore matches N. Calling
//     that "ambiguous, and may fill the wrong one" is a false alarm on the
//     exact defect class this trainer was built for (the Humana status form),
//     and following the advice — narrowing to one option — breaks a working
//     selector;
//   * INVALID CSS was caught and reported as 0, i.e. as a valid selector that
//     found nothing, sending the trainer to re-capture or hand-pick the field
//     when the actual fix is a typo in the box.
//
// So the page reports the SHAPE of the match and this decides what it means.
import type { PortalFieldType } from "./apiTypes";

export interface SelectorMatchReport {
  /** False when the string will not parse as CSS at all — a different problem
   * from a selector that parses and finds nothing, and a different fix. */
  valid: boolean;
  /** Every element hit, form control or not. */
  matches: number;
  /** How many of those the fill engine could actually write to. Mirrors
   * `bySelector` in `content/fillEngine.ts`: input, select, textarea. */
  fillable: number;
  /** Every match is a radio sharing one `name` — one field made of N controls,
   * which is health and not ambiguity. */
  radioGroup: boolean;
}

export interface SelectorVerdict {
  text: string;
  /** True when this selector would fill the field it is meant to fill. Drives
   * the note-vs-warning styling, so it must never be true for a selector the
   * engine would skip. */
  ok: boolean;
}

/** An empty report, for a page that could not be asked. */
export const NO_MATCHES: SelectorMatchReport = {
  valid: true,
  matches: 0,
  fillable: 0,
  radioGroup: false,
};

/**
 * What the trainer should be told about a tested selector.
 *
 * `fieldType` is the row's control type, which is what makes an N-way radio
 * match legible: N radios under one name is correct for a radio row and a
 * mis-typed row for any other, and both are more useful than "ambiguous".
 */
export function selectorVerdict(
  report: SelectorMatchReport,
  fieldType: PortalFieldType,
): SelectorVerdict {
  if (!report.valid) {
    return {
      ok: false,
      text: "That is not valid CSS, so it was never tried — check the syntax in the box.",
    };
  }
  if (report.matches === 0) {
    return {
      ok: false,
      text: "Matches nothing on this page — it will never fill. Re-capture, or add the field by hand while it is visible.",
    };
  }
  if (report.fillable === 0) {
    const what =
      report.matches === 1 ? "one element" : `${report.matches} elements`;
    return {
      ok: false,
      text: `Matches ${what}, but nothing that can be typed into — the fill engine writes to inputs, dropdowns and text areas only. Point at the field itself rather than the box around it.`,
    };
  }
  if (report.radioGroup) {
    return fieldType === "radio"
      ? {
          ok: true,
          text: `Matches the ${report.matches} options of one radio group — that is what a radio field looks like.`,
        }
      : {
          ok: false,
          text: `Matches ${report.matches} options of one radio group, but this row's control type is not Radio group. Change the type above and it will fill correctly.`,
        };
  }
  if (report.fillable === 1) {
    return { ok: true, text: "Matches exactly one field on this page." };
  }
  return {
    ok: false,
    text: `Matches ${report.fillable} fields — ambiguous, and may fill the wrong one.`,
  };
}
