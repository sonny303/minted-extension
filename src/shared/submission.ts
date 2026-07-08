// Pure, unit-tested helpers for the SOP↔portal close-out loop (Phase 4).
// Kept out of the side panel (state-reading) and the background worker (auth +
// fetch) so the two behaviors the spec pins — the portal-key task match and the
// touch-body shape — can be exercised in isolation.
import type { CasePortalTask, SubmissionTouchBody } from "./apiTypes";

// Match the current page's portal_key against a selected case's portal-linked
// open SOP tasks. LITERAL string compare on already-normalized keys: the server
// emits bare/lowercase portal keys and the extension uses the same bare key for
// GET /api/portal-field-maps, so the join is a plain `===` — never re-normalize,
// slugify, or strip braces here (same discipline as the field-map → profile-token
// join). Older server responses without portalTasks arrive undefined and are
// treated as an empty array (never crash). Entries missing a taskId or portalKey
// are dropped defensively; status is NOT re-filtered (the server already returns
// only non-completed tasks).
export function matchPortalTasks(
  portalTasks: CasePortalTask[] | undefined | null,
  portalKey: string,
): CasePortalTask[] {
  return (portalTasks ?? []).filter(
    (task) => task != null && Boolean(task.taskId) && Boolean(task.portalKey) && task.portalKey === portalKey,
  );
}

export interface SubmissionTouchInput {
  portalKey: string;
  fillSessionId: string | null;
  idempotencyId: string;
  payerReferenceId?: string | null;
  wipNote?: string | null;
  // The SOP task the human just closed. Included as task_id ONLY when set —
  // never sent as null/empty (an absent key is how "no task to close" is wired).
  taskId?: string | null;
}

// Blank/whitespace → null so an empty field is a no-op server-side (the server
// treats a null payer reference / wip note as "don't overwrite").
function cleanText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

// Build the POST /api/cases/:id/touches body (snake_case per the locked R2
// contract). payer_reference_id and wip_note are always present (possibly null —
// the server reads null as "leave as-is"); task_id is OMITTED entirely unless a
// task was selected.
export function buildSubmissionTouchBody(input: SubmissionTouchInput): SubmissionTouchBody {
  const taskId = cleanText(input.taskId);
  return {
    kind: "portal_submission",
    portal_key: input.portalKey,
    fill_session_id: input.fillSessionId,
    idempotency_id: input.idempotencyId,
    payer_reference_id: cleanText(input.payerReferenceId),
    wip_note: cleanText(input.wipNote),
    ...(taskId ? { task_id: taskId } : {}),
  };
}
