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

/** The muted summary line: "3 left blank on purpose". Null when none. */
export function leftBlankLine(fields: readonly ReportedField[] | number | undefined): string | null {
  const count = typeof fields === "number" ? fields : fields?.length ?? 0;
  if (count <= 0) return null;
  return `${count} left blank on purpose`;
}
