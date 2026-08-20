// BITE-TRAIN-03 — join the shared field library into the capture list.
//
// The capture list used to show one thing: what THIS scan found, merged
// against a session that lives in `chrome.storage.session` and dies with the
// browser. So the second half of the trainer's job — "the form needs updating"
// — had no working loop the next day: nothing said which fields the library
// already holds, which are new, and which the library expects but this page no
// longer has (the drift).
//
// The maps are already in panel state (`LIST_SHARED_FIELD_MAPS` runs on
// recognition), so this is a join, not a fetch. It reads only: nothing here
// proposes, approves or writes — mapping decisions stay in the web app.

import type { PortalFieldMap } from "./apiTypes";
import type { CaptureRow } from "./capture";
import { rowDisplayName } from "./capture";
import { classifyFieldMap, type FieldDecision } from "./fieldClassify";

/** Where a listed field stands between the page and the library. */
export type CaptureRowState =
  /** The library holds it and this scan found it. */
  | "in-library"
  /** This scan found it and the library has never seen it. */
  | "new"
  /** The library holds it and this scan did NOT find it — the drift. */
  | "drifted"
  /** The library holds it and nothing has been captured to compare against —
   * what the form already has, before the trainer decides to re-capture. */
  | "library-only";

export interface CaptureListRow {
  /** The library's selector when the page no longer has the field, else the
   * captured row's. Unique within a list. */
  selector: string;
  page: string | null;
  name: string;
  state: CaptureRowState;
  /** The captured row, or null for a library field this scan did not find
   * (or did not look for). */
  row: CaptureRow | null;
  /** What the library says about it, or null when the library has never seen
   * it. `decision` mirrors the web app's own registry classifier. */
  library: { decision: FieldDecision; note: string } | null;
}

/** A library row's human name: the admin's rename, else the selector with the
 * engine's `label:` prefix stripped — never a blank cell. */
export function libraryRowName(map: PortalFieldMap): string {
  const own = (map.displayLabel ?? "").trim();
  if (own) return own;
  return map.selector.startsWith("label:") ? map.selector.slice("label:".length) : map.selector;
}

/** Every selector a map answers to — the stored one plus its fallbacks, so a
 * field the scan found by a fallback is not reported as new. */
function selectorsOf(map: PortalFieldMap): string[] {
  return [map.selector, ...(map.selectorFallbacks ?? [])].map((s) => s.trim()).filter(Boolean);
}

/**
 * Join a capture's rows to the shared library for this form.
 *
 * Scanned rows keep their order (the list reads down the form); library fields
 * the scan did not find are appended, because they are a diagnosis about the
 * page rather than a position on it. Retired maps are ignored entirely — they
 * are the library's own tombstones, not drift.
 *
 * With NO capture in hand the library still lists, as `library-only`: that is
 * the answer to "what does this form already have", and it is the only answer
 * available once the session storage has died with the browser.
 */
export function joinCaptureLibrary(
  rows: readonly CaptureRow[],
  maps: readonly PortalFieldMap[],
): CaptureListRow[] {
  const live = maps.filter((m) => m.status !== "retired");
  const bySelector = new Map<string, PortalFieldMap>();
  for (const map of live) {
    for (const selector of selectorsOf(map)) {
      if (!bySelector.has(selector)) bySelector.set(selector, map);
    }
  }

  const matched = new Set<string>();
  const out: CaptureListRow[] = rows.map((row) => {
    const map = bySelector.get(row.selector) ?? null;
    if (map) matched.add(map.id);
    return {
      selector: row.selector,
      page: row.pageStep?.trim() ? row.pageStep.trim() : null,
      name: rowDisplayName(row),
      state: map ? "in-library" : "new",
      row,
      library: map ? describe(map) : null,
    };
  });

  // The scan is per PAGE, so only fields the library files under a page this
  // capture actually walked can be called missing. Anything else is simply a
  // page the trainer has not opened, and flagging it as drift would cry wolf
  // on every multi-page form.
  const scanned = out.length > 0;
  const walked = new Set(out.map((r) => r.page));
  for (const map of live) {
    if (matched.has(map.id)) continue;
    const page = (map.pageStep ?? "").trim() || null;
    if (scanned && !walked.has(page)) continue;
    out.push({
      selector: map.selector,
      page,
      name: libraryRowName(map),
      state: scanned ? "drifted" : "library-only",
      row: null,
      library: describe(map),
    });
  }
  return out;
}

function describe(map: PortalFieldMap): { decision: FieldDecision; note: string } {
  const classification = classifyFieldMap(map);
  return { decision: classification.decision, note: classification.reason };
}

export interface CaptureLibraryCounts {
  total: number;
  mapped: number;
  undecided: number;
  human: number;
  fresh: number;
  drifted: number;
}

export function captureLibraryCounts(list: readonly CaptureListRow[]): CaptureLibraryCounts {
  const counts: CaptureLibraryCounts = {
    total: list.length,
    mapped: 0,
    undecided: 0,
    human: 0,
    fresh: 0,
    drifted: 0,
  };
  for (const item of list) {
    if (item.state === "new") counts.fresh += 1;
    if (item.state === "drifted") counts.drifted += 1;
    switch (item.library?.decision) {
      case "token":
      case "fixed":
        counts.mapped += 1;
        break;
      case "undecided":
      case "invalid":
        counts.undecided += 1;
        break;
      case "human":
        counts.human += 1;
        break;
      default:
        break;
    }
  }
  return counts;
}

/**
 * The capture headline, counted against the LIBRARY.
 *
 * It used to read "We recognise 0 of N" on every train capture without
 * exception: the only writer of the per-row token it counted has no call site,
 * so the number could not be anything but zero. What a trainer needs to know
 * before deciding whether to re-capture is what the library already holds, so
 * that is what this says.
 */
export function captureLibrarySummary(counts: CaptureLibraryCounts): string {
  if (counts.total === 0) {
    return "Nothing in the shared library for this form yet — capture it to propose its fields.";
  }
  const parts: string[] = [`${counts.mapped} of ${counts.total} fill from the shared library`];
  if (counts.undecided > 0) parts.push(`${counts.undecided} awaiting a decision`);
  if (counts.human > 0) parts.push(`${counts.human} filled by a person`);
  if (counts.fresh > 0) parts.push(`${counts.fresh} new in this scan`);
  if (counts.drifted > 0) {
    parts.push(`${counts.drifted} in the library but not on this page`);
  }
  return `${parts.join(" · ")}.`;
}
