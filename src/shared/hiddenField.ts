// DYN-PAGE-02 — the pins for a target that resolved into an inactive panel.
//
// PAGE-01 stopped the fill attempting maps that belong to a different exact
// URL-page. This is the other half of the same problem, one page down: a
// multi-panel wizard keeps every step in the DOM and hides the inactive ones,
// so a selector can match perfectly and still point at a control the
// coordinator cannot see. Writing it is silent, invisible, and survives into a
// submission nobody reviewed.
//
// Reporting it as "field not found on this page" would be worse than useless —
// the selector was found. That is why this needs its own reason: the panel
// counts the not-found wording as drift, and a trainer sent to re-map a
// working selector will replace it with a worse one.
//
// Kind/reason strings are pinned to match panel `src/lib/formDrift.ts`
// (DYN-PAGE-02a). The extension Fix-it strip keys on reason alone, so this
// reason MUST differ from both FIELD_NOT_FOUND_REASON and OTHER_PAGE_REASON.

import type { FillInstruction, ReportedField } from "./fill";

/** Producer kind for a control that resolved but sits in an inactive panel. */
export const HIDDEN_KIND = "hidden";

/** Distinct from FIELD_NOT_FOUND_REASON and OTHER_PAGE_REASON — Fix-it keys
 * on reason alone, and only the not-found wording may read as drift. */
export const HIDDEN_REASON = "field is hidden on this page";

export function hiddenFieldReport(
  instruction: Pick<FillInstruction, "label" | "mapId">,
): ReportedField {
  return {
    label: instruction.label,
    reason: HIDDEN_REASON,
    mapId: instruction.mapId,
    kind: HIDDEN_KIND,
  };
}
