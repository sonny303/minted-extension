// E4.3 F4.3.3 / TE-4 — the missing-mapping fix-it tie-in. The extension NEVER
// writes mappings (R6 read-only boundary): a gap routes the specialist into
// the EXISTING platform flow with the portal/field context carried in the
// URL, and the panel refetches maps + retries after they return. This module
// is the pure half: gap partitioning and the platform deep links.
//
// The panel distinguishes "no mapping" from "no value" (F4.3.3 AC): a field
// whose map row isn't linked to a Minted Panel token is a MAPPING gap and
// routes to the train flow; a mapped token with no value on the provider/case
// is a DATA gap and routes to the provider record — the fix-it action is
// always the right fix.
import type { ReportedField } from "./fill";

export interface GapPartition {
  // Mapping gaps → the train flow (fix-it proper).
  mappingGaps: ReportedField[];
  // Data gaps → the provider record / outreach.
  dataGaps: ReportedField[];
  // Everything else (file uploads, deliberate manual fields, review flags) —
  // informational, no fix route offered.
  other: ReportedField[];
}

export function partitionGaps(gaps: ReportedField[]): GapPartition {
  const mappingGaps: ReportedField[] = [];
  const dataGaps: ReportedField[] = [];
  const other: ReportedField[] = [];
  for (const gap of gaps) {
    if (gap.kind === "no_mapping") mappingGaps.push(gap);
    else if (gap.kind === "no_value") dataGaps.push(gap);
    else other.push(gap);
  }
  return { mappingGaps, dataGaps, other };
}

/** The existing platform mapping-review flow for this portal (TE-4:
 * `/portals/$portalKey/train`), with the field the specialist just hit
 * carried as context so she never has to re-find it. */
export function trainFlowPath(portalKey: string, fieldLabel?: string): string {
  const base = `/portals/${encodeURIComponent(portalKey)}/train`;
  return fieldLabel ? `${base}?field=${encodeURIComponent(fieldLabel)}` : base;
}

/** The data fix for an empty-but-mapped token: the provider record in the
 * webapp. Provider id only — never PHI in a URL. */
export function providerFixPath(providerId: string): string {
  return `/providers/${encodeURIComponent(providerId)}`;
}

// S4.1 — the drift signal shown on the offer card. The content script reports
// a dead selector with this exact reason (src/content/fillEngine.ts); a
// mapped field that "wasn't found on this page" means the FORM changed, not
// that our data is missing. Kept here beside the other gap classifiers so the
// literal lives in one place on this side of the wire.
export const FIELD_NOT_FOUND_REASON = "field not found on this page";

// Re-export the off-page pin so the Fix-it strip and fill engine share one
// import surface. Definitions live in fillPage.ts beside the matcher.
export { OTHER_PAGE_KIND, OTHER_PAGE_REASON } from "./fillPage";

/** How many of a fill's skipped fields are dead selectors (drift), not data
 * gaps or exact off-page misses. Defensive: a report persisted before `kind`
 * existed still classifies, because the reason string is the signal. Off-page
 * uses a distinct reason so this count cannot inflate from multi-page fills. */
export function countBrokenSelectors(skipped: readonly ReportedField[]): number {
  return skipped.filter((f) => f.reason === FIELD_NOT_FOUND_REASON).length;
}
