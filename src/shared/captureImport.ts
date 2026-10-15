// Loading a Claude-written capture file (form-captures/*.capture.json, from the
// payer-form-capture skill) into Train forms, so its rows reach the panel
// through the SAME propose-only path a live scan uses: SEND_CAPTURE →
// POST /api/shared-field-maps. Pure; the worker re-runs all of it on the
// file text it is handed and never trusts the side panel's own check.
//
// THE PAGE MODEL. A capture file names its pages the way the trainer does
// (the page heading, else "Page 1", "Page 2", … in walk order: BlueKC's
// Qualtrics pages have no heading, BCBSKS's form does) and stamps each row's
// DOM position within its page, so a file row maps one-to-one: `pageStep`
// stays the page name, `sortOrder` stays the position inside that page. Rows
// are regrouped by page in first-appearance order and sorted by `sortOrder`
// inside a page, which is the order `groupCaptureRowsByPage` and the panel's
// template editor read.
// A page with no capturable row (an intro, a signature-only page) has nothing
// to propose and does not appear: the trainer's page model is row-derived.
//
// WHAT NEVER COMES ACROSS. Decisions: `chosenToken` is forced null and `sent`
// false whatever the file says, because a file is Claude's suggestion and the
// approval belongs to a person in the panel's editor. Values: none exist —
// `parseCaptureSession` keeps the row contract and drops every other key
// (`suggestedValue`, `decision`, `confidence`, the walk's pages/routes/notes).
// Claude's `suggestedToken` and `evidence` are kept for the trainer to read;
// neither is ever sent.
import type { PortalFieldType } from "./apiTypes";
import {
  CAPTURE_FIELD_TYPES,
  parseCaptureSession,
  type CaptureRow,
  type CaptureSession,
} from "./capture";

/** The `format` every capture file declares (payer-form-capture skill). */
export const CAPTURE_FILE_FORMAT = "minted.form-capture/v1";

/** Far above any real form (BlueKC: 89 rows, ~150 KB). A bigger file is not a
 * capture, and reading it would only stall the panel. */
export const CAPTURE_FILE_MAX_BYTES = 2_000_000;

export interface CaptureFile {
  /** The key the file was captured under, as written. */
  portalKey: string;
  templateStepId: string | null;
  startedAt: string;
  rows: CaptureRow[];
  /** Rows dropped because an earlier row already used the selector. */
  duplicates: number;
}

export type CaptureFileParse =
  | { ok: true; file: CaptureFile }
  | { ok: false; reason: string };

const FIELD_TYPES = new Set<string>(CAPTURE_FIELD_TYPES.map((t) => t.value));

/** Read a capture file's text into rows the trainer can review, or say why it
 * cannot be read. */
export function parseCaptureFile(text: string): CaptureFileParse {
  if (text.length > CAPTURE_FILE_MAX_BYTES) {
    return { ok: false, reason: "That file is too large to be a form capture." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That file isn't valid JSON. Choose a .capture.json file from form-captures." };
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "That file isn't a form capture. Choose a .capture.json file from form-captures." };
  }
  const format = (raw as Record<string, unknown>).format;
  if (format !== CAPTURE_FILE_FORMAT) {
    return {
      ok: false,
      reason: `That file isn't a form capture this version reads (expected format ${CAPTURE_FILE_FORMAT}).`,
    };
  }
  const session = parseCaptureSession(raw);
  if (session == null) {
    return {
      ok: false,
      reason: "The capture file is damaged: it needs a portal key, and every field needs a label and a selector.",
    };
  }

  const seen = new Set<string>();
  const kept: CaptureRow[] = [];
  let duplicates = 0;
  for (const row of session.rows) {
    const selector = row.selector.trim();
    if (selector === "") {
      return { ok: false, reason: `"${fieldName(row)}" has no selector, so it can't be proposed.` };
    }
    if (!FIELD_TYPES.has(row.fieldType)) {
      return {
        ok: false,
        reason: `"${fieldName(row)}" has a control type Minted can't fill (${String(row.fieldType)}).`,
      };
    }
    // The selector is the row's key here and in the shared library
    // (idempotent on portal_key + selector), so a second row on it could only
    // ever be the same proposal.
    if (seen.has(selector)) {
      duplicates += 1;
      continue;
    }
    seen.add(selector);
    kept.push({
      ...row,
      selector,
      fieldType: row.fieldType as PortalFieldType,
      chosenToken: null,
      sent: false,
      heldReason: null,
    });
  }
  if (kept.length === 0) {
    return { ok: false, reason: "The capture file has no fields to import." };
  }
  return {
    ok: true,
    file: {
      portalKey: session.portalKey.trim(),
      templateStepId: session.templateStepId,
      startedAt: session.startedAt,
      rows: orderByPage(kept),
      duplicates,
    },
  };
}

function fieldName(row: CaptureRow): string {
  const name = (row.displayLabel ?? "").trim() || row.label.trim() || row.selector.trim();
  return name.length > 60 ? `${name.slice(0, 57)}…` : name || "A field";
}

/** Pages in first-appearance order; `sortOrder` within a page, a missing one
 * last; ties keep file order. */
function orderByPage(rows: readonly CaptureRow[]): CaptureRow[] {
  const pageIndex = new Map<string | null, number>();
  for (const row of rows) {
    const page = row.pageStep ?? null;
    if (!pageIndex.has(page)) pageIndex.set(page, pageIndex.size);
  }
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const page = pageIndex.get(a.row.pageStep ?? null)! - pageIndex.get(b.row.pageStep ?? null)!;
      if (page !== 0) return page;
      const sa = a.row.sortOrder ?? Number.POSITIVE_INFINITY;
      const sb = b.row.sortOrder ?? Number.POSITIVE_INFINITY;
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

/** The panel's own key rule (`normalizePortalKey`: trim + lowercase). */
function sameKey(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface CaptureImportTarget {
  portalKey: string;
  mappingGeneration: number;
}

export interface CaptureImportSummary {
  fields: number;
  pages: number;
  /** Rows carrying Claude's token suggestion. */
  suggested: number;
  duplicates: number;
  /** Rows of the capture this import replaced (0 when there was none). */
  replaced: number;
  /** The file's own key when it differs from the selected form's. */
  importedFrom: string | null;
}

export interface CaptureImportInput {
  file: CaptureFile;
  target: CaptureImportTarget;
  /** The capture already held for this target, if any. */
  existing: CaptureSession | null;
  /** The trainer confirmed replacing `existing`. */
  replaceExisting: boolean;
  /** The file key the trainer confirmed importing under the selected form's
   * key, when the two differ. */
  acceptPortalKey: string | null;
}

export type CaptureImportPlan =
  | { ok: true; session: CaptureSession; summary: CaptureImportSummary }
  | { ok: false; reason: string };

/**
 * Turn a parsed file into the capture session for the selected form.
 *
 * The SELECTED form wins: the session takes the Train target's key and its
 * CURRENT mapping generation (a file carries neither reliably — a provisional
 * key, no generation), because that is what every later propose is checked
 * against. Two things need the trainer's say-so first, and are refused
 * without it: a file captured under a different key (it may be the right form
 * under a provisional name, or the wrong form), and an existing capture that
 * the import would replace.
 */
export function planCaptureImport(input: CaptureImportInput): CaptureImportPlan {
  const { file, target, existing } = input;
  const keyDiffers = !sameKey(file.portalKey, target.portalKey);
  if (keyDiffers && !(input.acceptPortalKey != null && sameKey(input.acceptPortalKey, file.portalKey))) {
    return {
      ok: false,
      reason: `This file was captured for "${file.portalKey}", not the selected form "${target.portalKey}". Select that form, or confirm importing the file into this one.`,
    };
  }
  const replaced = existing?.rows.length ?? 0;
  if (replaced > 0 && !input.replaceExisting) {
    return {
      ok: false,
      reason: "This form already has a capture in this browser. Confirm replacing it to import the file.",
    };
  }
  const session: CaptureSession = {
    portalKey: target.portalKey,
    mappingGeneration: target.mappingGeneration,
    templateStepId: file.templateStepId,
    startedAt: file.startedAt,
    rows: file.rows,
  };
  return {
    ok: true,
    session,
    summary: {
      fields: file.rows.length,
      pages: new Set(file.rows.map((r) => r.pageStep ?? null)).size,
      suggested: file.rows.filter((r) => r.suggestedToken != null).length,
      duplicates: file.duplicates,
      replaced,
      importedFrom: keyDiffers ? file.portalKey : null,
    },
  };
}

/** What the trainer must agree to before the import runs, or null when
 * nothing needs asking. Same two conditions `planCaptureImport` refuses on. */
export function captureImportConfirmation(
  file: CaptureFile,
  target: CaptureImportTarget,
  existing: CaptureSession | null,
): string | null {
  const asks: string[] = [];
  if (!sameKey(file.portalKey, target.portalKey)) {
    asks.push(
      `This file was captured as "${file.portalKey}", but the selected form is "${target.portalKey}". Import it into the selected form?`,
    );
  }
  const replaced = existing?.rows.length ?? 0;
  if (replaced > 0) {
    const sent = existing!.rows.filter((r) => r.sent).length;
    asks.push(
      `It replaces the ${replaced} ${replaced === 1 ? "field" : "fields"} captured here.${
        sent > 0 ? " Fields already sent stay in the shared library." : ""
      }`,
    );
  }
  return asks.length > 0 ? asks.join("\n\n") : null;
}

/** "Imported 89 fields on 22 pages…" — said once, right after the import. */
export function captureImportSummaryText(summary: CaptureImportSummary): string {
  const parts = [
    `Imported ${summary.fields} ${summary.fields === 1 ? "field" : "fields"} on ${summary.pages} ${
      summary.pages === 1 ? "page" : "pages"
    } from the capture file.`,
  ];
  if (summary.suggested > 0) {
    parts.push(`Claude suggested a token for ${summary.suggested}; you decide each one in the web app.`);
  }
  if (summary.duplicates > 0) {
    parts.push(
      `${summary.duplicates} repeated ${summary.duplicates === 1 ? "selector was" : "selectors were"} skipped.`,
    );
  }
  parts.push("Nothing is sent until you choose Send for approval.");
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Option lists over the panel's cap
// ---------------------------------------------------------------------------

/** The panel's write boundary refuses a long option list outright
 * (`control_options cannot exceed N entries`, 422) rather than truncating it.
 * Matched on the message so any other 422 still fails the send loudly. */
const OPTION_CAP_REFUSAL = /control_options cannot exceed (\d+) entries/i;

export function isOptionListCapRefusal(status: number, message: string): boolean {
  return status === 422 && OPTION_CAP_REFUSAL.test(message);
}

/** Why a row stayed unsent. Truncating the list is never offered: the choice a
 * fill needs can sit past any cut (BlueKC's Physical Therapist is #121 of 146). */
export function optionListHeldReason(optionCount: number, message: string): string {
  const cap = OPTION_CAP_REFUSAL.exec(message)?.[1];
  const limit = cap ? `up to ${cap} options` : "fewer options";
  return `Not sent: Minted Panel accepts ${limit} per field and this one has ${optionCount}. Send again once the panel takes longer lists.`;
}
