// TS-83 (pure half): the structured-touch draft validation and the locked
// snake_case body shape (kind 'structured_touch', E4.1 contract).
import { describe, expect, it } from "vitest";
import {
  STRUCTURED_TOUCH_TYPES,
  TOUCH_DISPOSITIONS,
  buildStructuredTouchBody,
  validateStructuredTouch,
  type StructuredTouchDraft,
} from "./structuredTouch";

const ID = "0f0e73c2-51f1-4be9-9f2e-0a4c7f2fbb02";

function draft(overrides: Partial<StructuredTouchDraft> = {}): StructuredTouchDraft {
  return {
    touchType: "portal",
    note: "Checked status on the portal",
    outcome: "",
    recipientName: "",
    recipientContact: "",
    followUpDate: "",
    trackingId: "",
    ...overrides,
  };
}

describe("mirrors of the panel's code-owned sets", () => {
  it("offers exactly the seven canonical E4.1 types (mail is legacy-only)", () => {
    expect(STRUCTURED_TOUCH_TYPES.map((t) => t.value)).toEqual([
      "call",
      "portal",
      "email",
      "fax",
      "caqh_update",
      "provider_outreach",
      "internal_sync",
    ]);
  });

  it("offers exactly the five dispositions", () => {
    expect(TOUCH_DISPOSITIONS.map((d) => d.value)).toEqual([
      "successful",
      "attempted",
      "no_response",
      "error",
      "other",
    ]);
  });
});

describe("validateStructuredTouch (mirrors the server's 422 rules)", () => {
  it("requires a type", () => {
    expect(validateStructuredTouch(draft({ touchType: "" })).ok).toBe(false);
    expect(validateStructuredTouch(draft({ touchType: "mail" })).ok).toBe(false);
    expect(validateStructuredTouch(draft()).ok).toBe(true);
  });

  it("requires context for outcome 'other'", () => {
    expect(validateStructuredTouch(draft({ outcome: "other", note: "  " })).ok).toBe(false);
    expect(validateStructuredTouch(draft({ outcome: "other", note: "why" })).ok).toBe(true);
    expect(validateStructuredTouch(draft({ outcome: "successful", note: "" })).ok).toBe(true);
  });

  it("rejects an invalid disposition and a malformed follow-up date", () => {
    expect(validateStructuredTouch(draft({ outcome: "great" })).ok).toBe(false);
    expect(validateStructuredTouch(draft({ followUpDate: "July 4" })).ok).toBe(false);
    expect(validateStructuredTouch(draft({ followUpDate: "2026-08-01" })).ok).toBe(true);
  });
});

describe("buildStructuredTouchBody (locked snake_case wire shape)", () => {
  it("builds the minimal body and OMITS blank optionals", () => {
    const body = buildStructuredTouchBody(draft({ note: "", outcome: "" }), ID);
    expect(body).toEqual({
      kind: "structured_touch",
      idempotency_id: ID,
      touch_type: "portal",
    });
  });

  it("carries every provided field under its snake_case key", () => {
    const body = buildStructuredTouchBody(
      draft({
        note: "Spoke with rep",
        outcome: "successful",
        recipientName: "Dana Rep",
        recipientContact: "800-555-0100",
        followUpDate: "2026-07-31",
        trackingId: "REF-2002",
      }),
      ID,
    );
    expect(body).toEqual({
      kind: "structured_touch",
      idempotency_id: ID,
      touch_type: "portal",
      note: "Spoke with rep",
      outcome: "successful",
      recipient_name: "Dana Rep",
      recipient_contact: "800-555-0100",
      next_follow_up_date: "2026-07-31",
      payer_reference_id: "REF-2002",
    });
  });

  it("never carries a portal_submission-only field", () => {
    const body = buildStructuredTouchBody(draft(), ID) as unknown as Record<string, unknown>;
    for (const key of ["portal_key", "fill_session_id", "task_id", "wip_note", "pdf_filename"]) {
      expect(body).not.toHaveProperty(key);
    }
  });
});
