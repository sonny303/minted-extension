// S5.2/S5.4 — the capture session: the pure half. A capture binds to a portal
// key (and optionally the template step that asked for it), holds the scanned
// fields with their suggestions, and survives an MV3 worker restart.
//
// WHAT SURVIVES A RESTART, AND WHAT MUST NOT (the S5.2 criterion): labels,
// selectors, counts and decisions restore; VALUES NEVER, because none are ever
// collected — captureScan reads the form's shape only. That makes the storage
// question trivial rather than delicate: there is nothing PHI-bearing in a
// capture session to leak.
import type { PortalFieldType } from "./apiTypes";

/** A scanned field plus whatever the server suggested for it. */
export interface CaptureRow {
  label: string;
  selector: string;
  fieldType: PortalFieldType;
  formSection: string | null;
  /** The server's learned suggestion (S5.3), or null when nothing backed one. */
  suggestedToken: string | null;
  /** Human-readable evidence for the suggestion ("Mapped this way on 3 other
   * payers"), or null. */
  evidence: string | null;
  /** The human's decision for this row: the suggestion accepted/overridden, or
   * null while it is still a gap. */
  chosenToken: string | null;
  /** Set once the row has been sent to the server as a proposal. */
  sent: boolean;
  /** E6.9 F6.9.8 — the wizard page this row was scanned from, and its DOM
   * position within that page. Both are shape facts, like the selector, and
   * both ride the proposal so the editor can group and order a multi-page
   * form the way it actually reads. Null on rows captured before E6.9. */
  pageStep?: string | null;
  sortOrder?: number | null;
  /** E6.10 — captured option vocabulary. Shape-only; never a selected value. */
  options?: { value: string; label: string }[];
}

export interface CaptureSession {
  portalKey: string;
  /** The SOP template step this capture was started from, when it was. */
  templateStepId: string | null;
  startedAt: string;
  rows: CaptureRow[];
}

export interface CaptureCounts {
  total: number;
  /** Rows carrying a suggestion or an explicit choice — "we recognise N of M". */
  recognized: number;
  /** Rows with neither: the gaps the human must resolve or skip. */
  gaps: number;
  sent: number;
}

export function captureCounts(session: CaptureSession | null): CaptureCounts {
  const rows = session?.rows ?? [];
  const recognized = rows.filter((r) => r.chosenToken != null || r.suggestedToken != null).length;
  return {
    total: rows.length,
    recognized,
    gaps: rows.length - recognized,
    sent: rows.filter((r) => r.sent).length,
  };
}

/** "We recognise 12 of 18." — the S5.4 headline. */
export function recognitionSummary(counts: CaptureCounts): string {
  return `We recognise ${counts.recognized} of ${counts.total}.`;
}

/** Is the capture ready to send? ALWAYS true when it has rows — the
 * zero-recognized case still sends (S5.4), because a form we understand none
 * of is exactly the one worth capturing. Gaps are surfaced, never blocking. */
export function canSendCapture(session: CaptureSession | null): boolean {
  return (session?.rows.length ?? 0) > 0;
}

function parseCapturedOptions(raw: unknown): { value: string; label: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: { value: string; label: string }[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") return undefined;
    const rec = item as Record<string, unknown>;
    if (typeof rec.value !== "string" || typeof rec.label !== "string") return undefined;
    out.push({ value: rec.value, label: rec.label });
  }
  return out;
}

/** Restore a session from storage, dropping anything malformed. Returns null
 * rather than a half-session — a partial restore that silently lost rows would
 * be worse than starting over. */
export function parseCaptureSession(raw: unknown): CaptureSession | null {
  if (raw == null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.portalKey !== "string" || !s.portalKey) return null;
  if (!Array.isArray(s.rows)) return null;
  const rows: CaptureRow[] = [];
  for (const item of s.rows) {
    if (item == null || typeof item !== "object") return null;
    const r = item as Record<string, unknown>;
    if (typeof r.label !== "string" || typeof r.selector !== "string") return null;
    const parsedOptions = parseCapturedOptions(r.options);
    rows.push({
      label: r.label,
      selector: r.selector,
      fieldType: (typeof r.fieldType === "string" ? r.fieldType : "text") as PortalFieldType,
      formSection: typeof r.formSection === "string" ? r.formSection : null,
      suggestedToken: typeof r.suggestedToken === "string" ? r.suggestedToken : null,
      evidence: typeof r.evidence === "string" ? r.evidence : null,
      chosenToken: typeof r.chosenToken === "string" ? r.chosenToken : null,
      sent: r.sent === true,
      pageStep: typeof r.pageStep === "string" ? r.pageStep : null,
      sortOrder: typeof r.sortOrder === "number" ? r.sortOrder : null,
      ...(parsedOptions !== undefined ? { options: parsedOptions } : {}),
    });
  }
  return {
    portalKey: s.portalKey,
    templateStepId: typeof s.templateStepId === "string" ? s.templateStepId : null,
    startedAt: typeof s.startedAt === "string" ? s.startedAt : new Date(0).toISOString(),
    rows,
  };
}

/** What a restored session tells the user it recovered (S5.2: "restored state
 * says what came back"). Deliberately names labels and counts — the only
 * things a capture ever held. */
export function restoredSummary(session: CaptureSession): string {
  const counts = captureCounts(session);
  const decided = session.rows.filter((r) => r.chosenToken != null).length;
  const parts = [`${counts.total} ${counts.total === 1 ? "field" : "fields"} restored`];
  if (decided > 0) parts.push(`${decided} already mapped`);
  if (counts.sent > 0) parts.push(`${counts.sent} already sent`);
  return `${parts.join(" · ")}. Field names only — no values are ever stored.`;
}

/** Diff a fresh scan against an existing capture on the same portal (S5.4
 * re-capture as drift repair): which selectors are new, which are gone, and
 * which are unchanged. */
export interface CaptureDiff {
  added: CaptureRow[];
  removed: CaptureRow[];
  unchanged: CaptureRow[];
}

export function diffCapture(
  previous: readonly CaptureRow[],
  next: readonly CaptureRow[],
): CaptureDiff {
  const prevBySelector = new Map(previous.map((r) => [r.selector, r]));
  const nextSelectors = new Set(next.map((r) => r.selector));
  return {
    added: next.filter((r) => !prevBySelector.has(r.selector)),
    removed: previous.filter((r) => !nextSelectors.has(r.selector)),
    // Carry the PREVIOUS row for unchanged selectors so an earlier decision
    // survives a re-capture — re-deciding a field the human already mapped is
    // exactly the busywork this flow exists to remove.
    unchanged: next
      .filter((r) => prevBySelector.has(r.selector))
      .map((r) => ({ ...r, ...pickDecision(prevBySelector.get(r.selector)) })),
  };
}

function pickDecision(prev: CaptureRow | undefined): Partial<CaptureRow> {
  if (!prev) return {};
  return { chosenToken: prev.chosenToken, sent: prev.sent };
}

/**
 * Fold a fresh scan of ONE page into an existing capture of the same portal
 * (E6.9 F6.9.8).
 *
 * Drift repair is per PAGE. `diffCapture` alone would be wrong for a multi-page
 * wizard: scanning page 2 sees none of page 1's selectors, so every page-1 row
 * would read as "removed" and be dropped — the trainer would walk five pages
 * and keep only the fifth. Rows belonging to OTHER pages are therefore carried
 * verbatim, and only the rows on the page being scanned are diffed, so a
 * re-scan of page 2 still preserves the decisions already made there.
 *
 * Rows captured before pages existed (`pageStep` null) diff against an unnamed
 * scan, which is exactly the old single-page behaviour.
 */
export function mergePageCapture(
  previous: readonly CaptureRow[],
  next: readonly CaptureRow[],
  pageStep: string | null,
): CaptureRow[] {
  const samePage = (row: CaptureRow) => (row.pageStep ?? null) === pageStep;
  const otherPages = previous.filter((row) => !samePage(row));
  const diff = diffCapture(previous.filter(samePage), next);
  return [...otherPages, ...diff.unchanged, ...diff.added];
}

/** The page names already used in this capture run — what `derivePageStep`
 * needs so a second scan of an indistinguishable page does not silently merge
 * into the first one's bucket. */
export function usedPageNames(session: CaptureSession | null): string[] {
  const names = new Set<string>();
  for (const row of session?.rows ?? []) {
    const page = row.pageStep?.trim();
    if (page) names.add(page);
  }
  return [...names];
}

/** How many distinct pages this run has captured — the 1-based sequence the
 * next page falls back to. */
export function nextPageSequence(session: CaptureSession | null): number {
  return usedPageNames(session).length + 1;
}

function tidyPageName(value: string | null | undefined): string | null {
  const text = (value ?? "").trim().replace(/\s+/g, " ");
  return text.length > 0 ? text : null;
}

/** Stable page key for a row: a trimmed name, or `null` for the pre-E6.9
 * unnamed bucket. */
function rowPageKey(row: CaptureRow): string | null {
  return tidyPageName(row.pageStep ?? null);
}

/**
 * Pages already present in the session, in first-seen order. Named pages
 * come first; the legacy unnamed bucket (`pageStep` null) is appended once
 * when any such row exists — it is not a name, but it IS an overlap target.
 */
function existingCapturePages(previous: readonly CaptureRow[]): Array<string | null> {
  const named: string[] = [];
  const seen = new Set<string>();
  let hasUnnamed = false;
  for (const row of previous) {
    const key = rowPageKey(row);
    if (key == null) {
      hasUnnamed = true;
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      named.push(key);
    }
  }
  return hasUnnamed ? [...named, null] : named;
}

function selectorsOfPage(previous: readonly CaptureRow[], page: string | null): Set<string> {
  const out = new Set<string>();
  for (const row of previous) {
    if (rowPageKey(row) === page) out.add(row.selector);
  }
  return out;
}

/** Index of the last row belonging to `page` in `previous` (-1 if none). */
function lastRowIndexOfPage(previous: readonly CaptureRow[], page: string | null): number {
  for (let i = previous.length - 1; i >= 0; i -= 1) {
    if (rowPageKey(previous[i]!) === page) return i;
  }
  return -1;
}

export interface IdentifyCapturePageInput {
  /** Rows already in the session for this portal (empty on a first capture). */
  previous: readonly CaptureRow[];
  /** Selectors from the fresh scan, in DOM order. */
  scanned: readonly string[];
  /** Candidate name for a NEW page, from the side panel's derivePageStep. */
  candidate: string;
  /** Last non-empty URL path segment of the scanned tab, or null. */
  urlTail: string | null;
  /** Form heading reported by the page, or null. Still null today (CAP-HEAD). */
  heading: string | null;
  /** "next-page" = the trainer explicitly asked for a new page: never reuse. */
  mode: "auto" | "next-page";
}

/**
 * Decide which wizard page a fresh scan belongs to (BITE-CAP-05).
 *
 * Runs in the background AFTER `SCAN_FIELDS`, so the selector set is available.
 * Returns an existing page name when there is evidence of a match, `null` when
 * the match is the pre-E6.9 unnamed bucket, or `candidate` for a new page.
 *
 * Decision order (stop at the first hit): empty session → explicit next-page →
 * URL-tail / heading name match → selector-overlap (≥ 0.5 of the smaller set)
 * → new page. Ties on overlap count break toward the page whose rows appear
 * last in `previous` (most recently worked).
 */
export function identifyCapturePage(input: IdentifyCapturePageInput): string | null {
  const { previous, scanned, candidate, urlTail, heading, mode } = input;
  const pages = existingCapturePages(previous);

  // 1. Nothing captured yet for this portal → the side panel's candidate.
  if (pages.length === 0) return candidate;

  // 2. Trainer said "this is a new page" — never reuse, even on identical DOM.
  if (mode === "next-page") return candidate;

  // 3. URL tail matches an existing named page (drift repair after redesign).
  const tail = tidyPageName(urlTail);
  if (tail != null && pages.includes(tail)) return tail;

  // 4. Heading matches an existing named page.
  const pageHeading = tidyPageName(heading);
  if (pageHeading != null && pages.includes(pageHeading)) return pageHeading;

  // 5. Selector overlap — majority of the smaller set ⇒ same page.
  const scannedSet = new Set(scanned);
  let bestPage: string | null | undefined;
  let bestOverlap = -1;
  let bestLastIndex = -1;

  for (const page of pages) {
    const pageSelectors = selectorsOfPage(previous, page);
    let overlap = 0;
    for (const selector of scannedSet) {
      if (pageSelectors.has(selector)) overlap += 1;
    }
    const denom = Math.min(scanned.length, pageSelectors.size);
    if (denom === 0) continue;
    if (overlap / denom < 0.5) continue;

    const lastIndex = lastRowIndexOfPage(previous, page);
    if (
      bestPage === undefined ||
      overlap > bestOverlap ||
      (overlap === bestOverlap && lastIndex > bestLastIndex)
    ) {
      bestPage = page;
      bestOverlap = overlap;
      bestLastIndex = lastIndex;
    }
  }

  if (bestPage !== undefined) return bestPage;

  // 6. Unrecognised scan → a new page (the CAP-01 unconditional-reuse fix).
  return candidate;
}
