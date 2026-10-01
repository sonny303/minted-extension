// E4.3 F4.3.3 / TE-4 — the missing-mapping fix-it tie-in. The extension NEVER
// writes mappings (R6 read-only boundary): a gap routes the specialist into
// the EXISTING platform flow with the portal/field context carried in the
// URL, and the panel refetches maps + retries after they return. This module
// is the pure half: gap partitioning and the platform deep links.
//
// The panel distinguishes "no mapping" from "no value" (F4.3.3 AC): a field
// whose map row isn't linked to a Minted Panel token is a MAPPING gap and
// routes to the train flow; a mapped token with no value on the provider/case
// is a DATA gap and routes to the token's exact owning record when supplied,
// otherwise to the provider record.
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

/** Legacy data fix for an empty-but-mapped token without a more specific
 * server-provided owner record. Provider id only — never PHI in a URL. */
export function providerFixPath(providerId: string): string {
  return `/providers/${encodeURIComponent(providerId)}`;
}

/** Check the exact group-record path shape before it enters a local fill
 * summary. It is not a general Panel URL sanitizer. */
export function isExactGroupRecordPath(recordPath: string | undefined): recordPath is string {
  return !!recordPath && /^\/groups\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(recordPath);
}

/** Return an absolute link only for the exact group-record route emitted by
 * the Panel. The record path is untrusted response data; reject other paths,
 * origins, query strings, fragments, and URL normalization before rendering. */
export function groupRecordFixUrl(recordPath: string | undefined, webBaseUrl: string): string | null {
  if (!isExactGroupRecordPath(recordPath)) return null;
  try {
    const base = new URL(webBaseUrl);
    if ((base.protocol !== "https:" && base.protocol !== "http:") || base.username || base.password) {
      return null;
    }
    const destination = new URL(recordPath, base);
    if (
      destination.origin !== base.origin ||
      destination.pathname !== recordPath ||
      destination.search !== "" ||
      destination.hash !== ""
    ) {
      return null;
    }
    return destination.toString();
  } catch {
    return null;
  }
}

/** Prefer the exact group record when Panel supplies one. Older Panel
 * responses keep the provider-record fallback. */
export function dataFixAction(
  recordPath: string | undefined,
  providerId: string | null,
  webBaseUrl: string,
): { href: string; label: string } | null {
  const groupRecordUrl = groupRecordFixUrl(recordPath, webBaseUrl);
  if (groupRecordUrl) return { href: groupRecordUrl, label: "Open group record ↗" };
  if (providerId == null) return null;
  try {
    return {
      href: new URL(providerFixPath(providerId), webBaseUrl).toString(),
      label: "Add the data ↗",
    };
  } catch {
    return null;
  }
}

/** Missing profile values are safe partial-fill gaps, but the operator must
 * see that the portal still needs manual completion before submit. */
export function partialFillWarning(manual: readonly ReportedField[], skippedCount: number): string | null {
  const missingValueCount = manual.filter((field) => field.kind === "no_value").length;
  if (missingValueCount === 0 && skippedCount === 0) return null;

  const items: string[] = [];
  if (missingValueCount > 0) {
    items.push(
      `${missingValueCount} mapped ${missingValueCount === 1 ? "field has" : "fields have"} no Minted Panel value`,
    );
  }
  if (skippedCount > 0) {
    items.push(`${skippedCount} mapped ${skippedCount === 1 ? "field needs" : "fields need"} review from this fill`);
  }
  return `Partial fill: ${items.join("; ")}. Review the lists above and complete them on the portal before you submit.`;
}

// S4.1 — the drift signal shown on the offer card. The content script reports
// a dead selector with this exact reason (src/content/fillEngine.ts); a
// mapped field that "wasn't found on this page" means the FORM changed, not
// that our data is missing. Kept here beside the other gap classifiers so the
// literal lives in one place on this side of the wire.
export const FIELD_NOT_FOUND_REASON = "field not found on this page";

// Re-export the two no-evidence pins so the Fix-it strip and fill engine share
// one import surface. Definitions live beside the code that produces them:
// fillPage.ts with the page matcher, hiddenField.ts with the visibility guard.
export { OTHER_PAGE_KIND, OTHER_PAGE_REASON } from "./fillPage";
export { HIDDEN_KIND, HIDDEN_REASON } from "./hiddenField";

/** How many of a fill's skipped fields are dead selectors (drift), not data
 * gaps, off-page misses, or hidden controls. Defensive: a report persisted
 * before `kind` existed still classifies, because the reason string is the
 * signal. Off-page and hidden each use a distinct reason, so neither can
 * inflate this count — in both, the selector resolved. */
export function countBrokenSelectors(skipped: readonly ReportedField[]): number {
  return skipped.filter((f) => f.reason === FIELD_NOT_FOUND_REASON).length;
}
