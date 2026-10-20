// Leave blank — the fourth field-map decision (PM, Oct 2026).
//
// An approved map with source "leave_blank" has been REVIEWED and must stay
// empty on purpose. The fill plans nothing for it (the control is never
// touched), lists it under no "needs you" / gap bucket, and never sends it
// in fill-event telemetry (the panel knows the map's own source; a skip row
// would read as drift or a manual item). It is still shown, as a separate
// muted count, so the coordinator knows the empty field is intentional.
//
// Wire contract: `source: "leave_blank"` on `portal_field_maps` (panel-side
// PR; no new column). Mirrored in `PortalFieldMapSource`, apiTypes.ts.
import type { ReportedField } from "./fill";

export const LEAVE_BLANK_KIND = "leave_blank" as const;
export const LEAVE_BLANK_REASON = "intentionally left blank";

/** A run where the form's only approved maps were leave-blank decisions:
 * nothing was attempted, nothing went missing, and at least one field was
 * left blank on purpose. That is the RIGHT answer, not a failed fill, so the
 * result reads neutral ("nothing to fill") rather than "the portal may have
 * changed" with a support button. A skipped (not found) row means something
 * WAS planned and missed, which is the drift case and stays red. */
export function isNothingToFillRun(summary: {
  filled: number;
  fieldsAttempted?: number;
  attemptedLabels?: readonly string[];
  skipped: readonly ReportedField[];
  leftBlank?: readonly ReportedField[];
}): boolean {
  const attempted = summary.fieldsAttempted ?? summary.attemptedLabels?.length ?? 0;
  return (summary.leftBlank?.length ?? 0) > 0 && summary.filled === 0 && attempted === 0 &&
    summary.skipped.length === 0;
}

export const NOTHING_TO_FILL_HEADLINE = "Nothing to fill on this page.";

/** The muted summary line: "3 left blank on purpose". Null when none. */
export function leftBlankLine(fields: readonly ReportedField[] | number | undefined): string | null {
  const count = typeof fields === "number" ? fields : fields?.length ?? 0;
  if (count <= 0) return null;
  return `${count} left blank on purpose`;
}
