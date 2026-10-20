// DYN-PAGE-01 — exact URL-page identity for fill apply.
//
// Capture already stores pageStep; fill historically ignored it and tried
// every approved map on every wizard page. Off-page misses then used the
// same reason the panel calls drift. This module is the fill-side matcher:
// exact URL-tail ↔ an existing exact page bucket. A "Page N" name is a
// sequence label, never an identity, so when the URL names no trained page a
// "Page N" bucket fills only on its own trained evidence (DYN-PAGE-03,
// `applySequencePageEvidence` below). Every other unconfirmed step-bound map
// is withheld as page_unknown.
//
// Kind/reason strings are pinned to match panel `src/lib/formDrift.ts`
// (DYN-PAGE-00). The extension Fix-it strip keys on reason alone, so the
// off-page reason MUST differ from FIELD_NOT_FOUND_REASON.

import { pageUrlTail } from "./trainForms";
import type {
  FillInstruction,
  FillProbeInstruction,
  FillProbeResult,
  FillProbeTargetStatus,
  ReportedField,
} from "./fill";

/** Producer kind for a map that belongs to a different exact URL-page. */
export const OTHER_PAGE_KIND = "other_page";

/** Distinct from "field not found on this page" — Fix-it keys on reason alone. */
export const OTHER_PAGE_REASON = "field belongs to another page";
export const PAGE_UNKNOWN_KIND = "page_unknown";
export const PAGE_UNKNOWN_REASON = "current wizard page could not be confirmed";

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

/** True for capture's sequence fallback (`Page 2`). */
export function isSequencePageStep(pageStep: string | null | undefined): boolean {
  const name = tidyPageName(pageStep);
  return name != null && SEQUENCE_PAGE_RE.test(name);
}

/** Share of a "Page N" bucket's maps that must find their control in a frame
 * before any of them is written there. The same half that capture's
 * `identifyCapturePage` asks of selector overlap to call a scan the same page. */
export const SEQUENCE_PAGE_EVIDENCE_RATIO = 0.5;

/** Target statuses that mean the trained selector found its control. */
const PRESENT_TARGETS: ReadonlySet<FillProbeTargetStatus> = new Set(["unique", "ambiguous", "hidden"]);

/**
 * DYN-PAGE-03 — a "Page N" bucket proven by its own trained selectors.
 *
 * Applies only when the open URL resolved to no exact page (`currentPage`
 * null). Production `humana-tricare` is the case: one URL (`…/home/index`),
 * four accordion steps, 53 approved maps all named "Page 2". Without this,
 * every one of them reads page_unknown and the fill writes nothing.
 *
 * `rows` are one frame's probe results, index-aligned with `instructions`,
 * with each "Page N" target already searched. Per bucket: when at least
 * SEQUENCE_PAGE_EVIDENCE_RATIO of its maps found their control in this frame
 * (unique, ambiguous or hidden), every map whose selector matched something
 * keeps its result, marked `pageEvidence: "fingerprint"`, and the caller may
 * write a unique visible one. Everything else in the bucket — every map when
 * the share falls short, and a map whose control is missing even when it is
 * met — reads page_unknown.
 *
 * Absence never becomes drift here: the page is still a sequence label, so a
 * missing control is page_unknown, never not_found. Hidden stays hidden.
 */
export function applySequencePageEvidence(
  instructions: readonly Pick<FillProbeInstruction, "pageStep">[],
  rows: readonly FillProbeResult[],
  currentPage: string | null,
): FillProbeResult[] {
  const out = [...rows];
  if (currentPage != null) return out;
  const buckets = new Map<string, number[]>();
  instructions.forEach((instruction, index) => {
    if (!isSequencePageStep(instruction.pageStep)) return;
    const name = tidyPageName(instruction.pageStep) as string;
    buckets.set(name, [...(buckets.get(name) ?? []), index]);
  });
  for (const indices of buckets.values()) {
    const present = indices.filter((index) => {
      const row = rows[index];
      return row != null && row.pageStatus === "eligible" && PRESENT_TARGETS.has(row.targetStatus);
    }).length;
    const proven = present / indices.length >= SEQUENCE_PAGE_EVIDENCE_RATIO;
    for (const index of indices) {
      const row = rows[index];
      if (row == null) continue;
      out[index] = proven && row.pageStatus === "eligible" && row.targetStatus !== "missing"
        ? { ...row, pageEvidence: "fingerprint" }
        : { ...row, pageStatus: "page_unknown", targetStatus: "missing", radioGroup: false };
    }
  }
  return out;
}

/** Match the open URL to an existing exact page bucket. Returns null when the
 * URL has no tail, the tail is not among trained exact pages, or every trained
 * page is ambiguous — callers must withhold step-bound writes rather than
 * turn uncertainty into drift. */
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
 * current page are not classified as other_page; nonempty unknown identities
 * are separately withheld by the fill engine. */
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

export function pageUnknownReport(
  instruction: Pick<FillInstruction, "label" | "mapId">,
): ReportedField {
  return {
    label: instruction.label,
    reason: PAGE_UNKNOWN_REASON,
    mapId: instruction.mapId,
    kind: PAGE_UNKNOWN_KIND,
  };
}
