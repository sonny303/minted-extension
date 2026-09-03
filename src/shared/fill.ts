// Types shared by the fill pipeline: background (plans instructions from
// field maps + profile values), content script (applies them to the page),
// side panel (renders the outcome). Instructions carry only what the page
// needs — selectors and final values — never tokens or auth material.
import type { PortalFieldType } from "./apiTypes";

export interface FillInstruction {
  mapId: string;
  // Human-readable field name for reporting (the label text for label:
  // selectors, else the selector itself).
  label: string;
  selector: string;
  selectorFallbacks: string[];
  fieldType: PortalFieldType;
  value: string;
  /** Trained wizard page for this map (`portal_field_maps.page_step`). Null
   * means legacy / unnamed — fill still attempts it. Used at apply time to
   * classify exact off-page misses (DYN-PAGE-01). */
  pageStep: string | null;
}

// Why a mapped field wasn't (fully) filled — machine-readable so the fix-it
// tie-in (F4.3.3) can route each gap to the RIGHT fix without string-matching
// reasons: `no_mapping` → the mapping flow (train), `no_value` → the data fix
// (provider record); the rest are informational. Optional so records persisted
// before this field restore cleanly.
//
// Telemetry kinds on fill_sessions.fields_skipped also use `skipped` (on-page
// miss) and `other_page` (exact off-page — DYN-PAGE-01 / panel formDrift).
export type ReportedFieldKind =
  | "no_mapping"
  | "no_value"
  | "file"
  | "manual"
  | "review"
  | "skipped"
  | "other_page";

export interface ReportedField {
  label: string;
  reason: string;
  // The portal_field_maps row this report is about — rides into the fill
  // event's fields_skipped so the panel can flag the exact broken mapping.
  mapId?: string;
  kind?: ReportedFieldKind;
}

// What the content script did with the instructions it was handed.
export interface FillPageResult {
  filled: string[]; // labels
  skipped: ReportedField[]; // matched-but-unappliable or selector not found
  // Fillable controls counted on the page — the honest denominator for how
  // much of the form the mapped fields actually cover.
  pageFields: number;
}

export interface SandboxFillSummary {
  filled: number;
  filledLabels: string[];
  skipped: ReportedField[];
  manual: ReportedField[];
  pageFields: number;
  /** Selectors this run wrote, so "Clear portal form" can undo exactly them. */
  filledSelectors: string[];
  fillSessionId: string | null;
  /** Non-fatal: the fill happened even if the machine log did not. */
  logError: string | null;
}

export interface MockDryRunSummary {
  pass: boolean;
  filled: number;
  skipped: ReportedField[];
  gaps: ReportedField[];
  fillSessionId: string;
  mockProfileVersion: number;
}

// The read-only coverage sensor shown BEFORE a fill (Epic 3a): how many mapped
// fields Minted Panel can supply (`available`) out of the total fillable mapped
// fields (`total`, web + non-retired), plus the gap list — the same fields
// planFill flags for manual entry, each with its reason. Derived purely from
// planFill; computing it never executes a fill.
export interface FillCoverage {
  available: number;
  total: number;
  gaps: ReportedField[];
}

// The panel-facing outcome of one fill attempt.
export interface FillSummary {
  filled: number;
  filledLabels: string[];
  skipped: ReportedField[];
  // Never attempted by design: manual-source fields, file uploads, tokens
  // with no value in Minted Panel, and manual_partial review flags.
  manual: ReportedField[];
  eventRecorded: boolean;
  // The COMPLETE user-facing warning line for a failed fill-event log,
  // composed by the background (it knows the failure kind — e.g. a 403 role
  // error gets its own wording). The panel renders it verbatim.
  eventError: string | null;
  // The fill attempt's idempotency id (= the fill_sessions row PK) when the
  // event was recorded; null when logging failed — "Mark submitted" must not
  // reference a fill session the server never stored (it 404s unknown ids).
  fillSessionId: string | null;
  // Fillable controls on the page (from FillPageResult). Optional so reports
  // persisted before this field restore cleanly.
  pageFields?: number;
}

// One persisted fill outcome, keyed per (provider, portal) in
// chrome.storage.session so reopening the panel restores the review state.
// Carries only what FillSummary already carries — counts, field labels, skip
// reasons, the fill session id. Field VALUES (PHI) exist only in transient
// FillInstructions and are never stored.
export interface FillReportRecord {
  providerId: string;
  portalKey: string;
  caseId: string;
  summary: FillSummary;
  // When the fill ran (ISO). The panel labels a restored report with it so a
  // stale report is never mistaken for a fresh one.
  completedAt: string;
  // "Mark submitted" already logged this report's touch — a restored panel
  // shows "Logged to the case." instead of offering the button again.
  submitted: boolean;
}

export type ContentRequest =
  | { type: "PING" }
  | { type: "APPLY_FILL"; instructions: FillInstruction[] }
  // S5.2: read the form's SHAPE (labels/selectors/types only — never a value).
  | { type: "SCAN_FIELDS" }
  // 2026-08-19 manual mapping. PICK_ELEMENT is the ONE async content request:
  // it resolves when the human clicks a control or cancels. All three read
  // shape only, exactly like SCAN_FIELDS.
  | { type: "PICK_ELEMENT" }
  | { type: "CANCEL_PICK" }
  // `highlight` flashes the matches bright green on the page (US-3.2's
  // Test Selector); without it this is a silent count.
  | { type: "MATCH_SELECTOR"; selector: string; highlight?: boolean }
  // US-5.3 — reset the portal form so the next sandbox fill starts clean.
  // Reachable ONLY from the sandbox surface; on a live form it would wipe a
  // coordinator's real typing.
  | { type: "CLEAR_FORM" };
