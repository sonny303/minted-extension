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
