// Types shared by the fill pipeline: background (plans instructions from
// field maps + profile values), content script (applies them to the page),
// popup (renders the outcome). Instructions carry only what the page needs —
// selectors and final values — never tokens or auth material.
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

// The popup-facing outcome of one fill attempt.
export interface FillSummary {
  filled: number;
  filledLabels: string[];
  skipped: ReportedField[];
  // Never attempted by design: manual-source fields, file uploads, tokens
  // with no value in Minted Panel, and manual_partial review flags.
  manual: ReportedField[];
  eventRecorded: boolean;
  eventError: string | null;
}

export type ContentRequest = { type: "PING" } | { type: "APPLY_FILL"; instructions: FillInstruction[] };
