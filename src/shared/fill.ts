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
}

export interface ReportedField {
  label: string;
  reason: string;
}

// What the content script did with the instructions it was handed.
export interface FillPageResult {
  filled: string[]; // labels
  skipped: ReportedField[]; // matched-but-unappliable or selector not found
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
  eventError: string | null;
  // The fill attempt's idempotency id (= the fill_sessions row PK) when the
  // event was recorded; null when logging failed — "Mark submitted" must not
  // reference a fill session the server never stored (it 404s unknown ids).
  fillSessionId: string | null;
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

export type ContentRequest = { type: "PING" } | { type: "APPLY_FILL"; instructions: FillInstruction[] };
