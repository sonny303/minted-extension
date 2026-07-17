// E4.3 F4.3.4 / TE-5 — the structured touch the specialist logs from the
// panel after portal work: the E4.1 type set, the optional disposition set,
// the draft validation the form enforces, and the snake_case body builder for
// POST /api/cases/:id/touches (kind 'structured_touch').
//
// The type and disposition sets are VERBATIM mirrors of the panel's
// code-owned lists (mintedpanel `src/lib/touchTypes.ts` CANONICAL_TOUCH_TYPES
// and `src/lib/touchDispositions.ts`) — the server validates against those,
// so this mirror only keeps the form honest. Never widen either list here.
import type { StructuredTouchBody } from "./apiTypes";

export interface TouchTypeOption {
  value: string;
  label: string;
}

/** The seven canonical E4.1 touch types, coordinator-facing order. (`mail` is
 * legacy-only on the panel and never offered as a new choice.) */
export const STRUCTURED_TOUCH_TYPES: readonly TouchTypeOption[] = [
  { value: "call", label: "Call" },
  { value: "portal", label: "Portal Check" },
  { value: "email", label: "Email" },
  { value: "fax", label: "Fax" },
  { value: "caqh_update", label: "CAQH Update" },
  { value: "provider_outreach", label: "Provider Outreach" },
  { value: "internal_sync", label: "Internal Sync" },
];

/** The optional E4.1 dispositions. "Other" requires the one-line context. */
export const TOUCH_DISPOSITIONS: readonly TouchTypeOption[] = [
  { value: "successful", label: "Successful" },
  { value: "attempted", label: "Attempted" },
  { value: "no_response", label: "No response" },
  { value: "error", label: "Error" },
  { value: "other", label: "Other" },
];

const TOUCH_TYPE_VALUES: ReadonlySet<string> = new Set(STRUCTURED_TOUCH_TYPES.map((t) => t.value));
const DISPOSITION_VALUES: ReadonlySet<string> = new Set(TOUCH_DISPOSITIONS.map((d) => d.value));

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// What the form collects. Field names are the panel-side wire names minus the
// snake casing; blank strings mean "not provided".
export interface StructuredTouchDraft {
  touchType: string;
  note: string;
  outcome: string;
  recipientName: string;
  recipientContact: string;
  followUpDate: string;
  trackingId: string;
}

// Blank/whitespace → null so an empty field is omitted, never a spurious
// write (the server treats a null tracking id as "leave as-is").
function cleanText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

export type StructuredTouchValidation =
  | { ok: true }
  | { ok: false; message: string };

/** The form's gate, mirroring the server's 422 rules so a rejected save is a
 * local message, not a round trip: type required; a valid disposition when
 * one is given; 'other' requires the context line; the follow-up date must be
 * YYYY-MM-DD. */
export function validateStructuredTouch(draft: StructuredTouchDraft): StructuredTouchValidation {
  if (!TOUCH_TYPE_VALUES.has(draft.touchType)) {
    return { ok: false, message: "Pick a touch type." };
  }
  const outcome = cleanText(draft.outcome);
  if (outcome != null && !DISPOSITION_VALUES.has(outcome)) {
    return { ok: false, message: "Pick a valid outcome." };
  }
  if (outcome === "other" && cleanText(draft.note) == null) {
    return { ok: false, message: 'Outcome "Other" needs a one-line context.' };
  }
  const followUp = cleanText(draft.followUpDate);
  if (followUp != null && !ISO_DATE_RE.test(followUp)) {
    return { ok: false, message: "Follow-up date must be a full date." };
  }
  return { ok: true };
}

/** Build the snake_case POST body. Optional fields are OMITTED when blank —
 * never sent as empty strings. The idempotency id is generated once per draft
 * by the caller and REUSED on every retry, so a failed write can never
 * double-log when retried (the server replays the stored row). */
export function buildStructuredTouchBody(
  draft: StructuredTouchDraft,
  idempotencyId: string,
): StructuredTouchBody {
  const note = cleanText(draft.note);
  const outcome = cleanText(draft.outcome);
  const recipientName = cleanText(draft.recipientName);
  const recipientContact = cleanText(draft.recipientContact);
  const followUpDate = cleanText(draft.followUpDate);
  const trackingId = cleanText(draft.trackingId);
  return {
    kind: "structured_touch",
    idempotency_id: idempotencyId,
    touch_type: draft.touchType,
    ...(note != null ? { note } : {}),
    ...(outcome != null ? { outcome } : {}),
    ...(recipientName != null ? { recipient_name: recipientName } : {}),
    ...(recipientContact != null ? { recipient_contact: recipientContact } : {}),
    ...(followUpDate != null ? { next_follow_up_date: followUpDate } : {}),
    ...(trackingId != null ? { payer_reference_id: trackingId } : {}),
  };
}
