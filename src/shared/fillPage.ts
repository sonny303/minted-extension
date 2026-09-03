// DYN-PAGE-01 — exact URL-page identity for fill apply.
//
// Capture already stores pageStep; fill historically ignored it and tried
// every approved map on every wizard page. Off-page misses then used the
// same reason the panel calls drift. This module is the fill-side matcher:
// exact URL-tail ↔ an existing exact page bucket. No selector-overlap scoring
// and no "Page N" guessing — when identity is ambiguous, callers keep today's
// not-found behavior.
//
// Kind/reason strings are pinned to match panel `src/lib/formDrift.ts`
// (DYN-PAGE-00). The extension Fix-it strip keys on reason alone, so the
// off-page reason MUST differ from FIELD_NOT_FOUND_REASON.

import { pageUrlTail } from "./trainForms";
import type { FillInstruction, ReportedField } from "./fill";

/** Producer kind for a map that belongs to a different exact URL-page. */
export const OTHER_PAGE_KIND = "other_page";

/** Distinct from "field not found on this page" — Fix-it keys on reason alone. */
export const OTHER_PAGE_REASON = "field belongs to another page";

/** Capture's sequence fallback (`Page 1`, `Page 2`, …) — never a fill identity. */
const SEQUENCE_PAGE_RE = /^Page \d+$/i;

function tidyPageName(value: string | null | undefined): string | null {
  const text = (value ?? "").trim().replace(/\s+/g, " ");
  return text.length > 0 ? text : null;
}

/** True when pageStep is a stable named bucket (URL-tail or heading), not the
 * sequence fallback and not an empty/legacy null. */
export function isExactFillPageIdentity(pageStep: string | null | undefined): boolean {
  const name = tidyPageName(pageStep);
  if (name == null) return false;
  return !SEQUENCE_PAGE_RE.test(name);
}

/** Match the open URL to an existing exact page bucket. Returns null when the
 * URL has no tail, the tail is not among trained exact pages, or every trained
 * page is ambiguous — callers must then preserve ordinary not-found. */
export function resolveFillPage(
  pageUrl: string | null | undefined,
  pageSteps: readonly (string | null | undefined)[],
): string | null {
  const tail = tidyPageName(pageUrlTail(pageUrl));
  if (tail == null) return null;

  const exact = new Set<string>();
  for (const step of pageSteps) {
    if (!isExactFillPageIdentity(step)) continue;
    const name = tidyPageName(step);
    if (name != null) exact.add(name);
  }
  return exact.has(tail) ? tail : null;
}

/** An instruction belongs on another exact page when we know the current page
 * AND the instruction names a different exact page. Null / Page N / matching
 * current page → attempt as today. */
export function isOtherPageInstruction(
  instruction: Pick<FillInstruction, "pageStep">,
  currentPage: string | null,
): boolean {
  if (currentPage == null) return false;
  if (!isExactFillPageIdentity(instruction.pageStep)) return false;
  return tidyPageName(instruction.pageStep) !== currentPage;
}

export function otherPageReport(
  instruction: Pick<FillInstruction, "label" | "mapId">,
): ReportedField {
  return {
    label: instruction.label,
    reason: OTHER_PAGE_REASON,
    mapId: instruction.mapId,
    kind: OTHER_PAGE_KIND,
  };
}
