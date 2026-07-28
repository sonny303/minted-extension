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
    rows.push({
      label: r.label,
      selector: r.selector,
      fieldType: (typeof r.fieldType === "string" ? r.fieldType : "text") as PortalFieldType,
      formSection: typeof r.formSection === "string" ? r.formSection : null,
      suggestedToken: typeof r.suggestedToken === "string" ? r.suggestedToken : null,
      evidence: typeof r.evidence === "string" ? r.evidence : null,
      chosenToken: typeof r.chosenToken === "string" ? r.chosenToken : null,
      sent: r.sent === true,
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
