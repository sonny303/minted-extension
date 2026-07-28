// S5.2/S5.4 — capture session rules.
import { describe, expect, it } from "vitest";
import {
  canSendCapture,
  captureCounts,
  diffCapture,
  parseCaptureSession,
  recognitionSummary,
  restoredSummary,
  type CaptureRow,
  type CaptureSession,
} from "./capture";

function row(over: Partial<CaptureRow> = {}): CaptureRow {
  return {
    label: "NPI",
    selector: "#npi",
    fieldType: "text",
    formSection: null,
    suggestedToken: null,
    evidence: null,
    chosenToken: null,
    sent: false,
    ...over,
  };
}

function session(rows: CaptureRow[]): CaptureSession {
  return { portalKey: "availity", templateStepId: null, startedAt: "2026-07-28", rows };
}

describe("captureCounts / recognitionSummary (S5.4)", () => {
  it("counts a row as recognized when it has a suggestion OR a choice", () => {
    const counts = captureCounts(
      session([
        row({ suggestedToken: "provider.npi" }),
        row({ selector: "#tin", chosenToken: "group.tin" }),
        row({ selector: "#mystery" }),
      ]),
    );
    expect(counts).toEqual({ total: 3, recognized: 2, gaps: 1, sent: 0 });
    expect(recognitionSummary(counts)).toBe("We recognise 2 of 3.");
  });

  it("handles an empty/absent session without dividing by zero", () => {
    expect(captureCounts(null)).toEqual({ total: 0, recognized: 0, gaps: 0, sent: 0 });
  });
});

describe("canSendCapture (S5.4 — zero-recognized still sends)", () => {
  it("allows sending when NOTHING was recognized", () => {
    // A form we understand none of is exactly the one worth capturing.
    expect(canSendCapture(session([row(), row({ selector: "#b" })]))).toBe(true);
  });

  it("blocks only an empty capture", () => {
    expect(canSendCapture(session([]))).toBe(false);
    expect(canSendCapture(null)).toBe(false);
  });
});

describe("parseCaptureSession (S5.2 — survives a worker restart)", () => {
  it("restores labels, selectors, decisions and sent state", () => {
    const stored = session([row({ chosenToken: "provider.npi", sent: true })]);
    const restored = parseCaptureSession(JSON.parse(JSON.stringify(stored)));
    const first = restored?.rows[0];
    if (!first) throw new Error("expected a restored row");
    expect(first.chosenToken).toBe("provider.npi");
    expect(first.sent).toBe(true);
  });

  it("returns null rather than a half-session when a row is malformed", () => {
    // Silently dropping rows would understate the form; starting over is honest.
    expect(parseCaptureSession({ portalKey: "a", rows: [{ label: 5 }] })).toBeNull();
    expect(parseCaptureSession({ rows: [] })).toBeNull();
    expect(parseCaptureSession(null)).toBeNull();
  });

  it("carries NO value field — there is nothing PHI-bearing to restore", () => {
    const restored = parseCaptureSession({
      portalKey: "availity",
      rows: [{ label: "SSN", selector: "#ssn", value: "123-45-6789" }],
    });
    expect(restored?.rows[0] ?? {}).not.toHaveProperty("value");
    expect(JSON.stringify(restored)).not.toContain("123-45-6789");
  });
});

describe("restoredSummary (S5.2 — says what came back)", () => {
  it("names the counts and states that values are never stored", () => {
    const text = restoredSummary(
      session([row({ chosenToken: "provider.npi", sent: true }), row({ selector: "#b" })]),
    );
    expect(text).toContain("2 fields restored");
    expect(text).toContain("1 already mapped");
    expect(text).toContain("1 already sent");
    expect(text).toContain("no values are ever stored");
  });
});

describe("diffCapture (S5.4 — re-capture as drift repair)", () => {
  const previous = [
    row({ selector: "#npi", chosenToken: "provider.npi", sent: true }),
    row({ selector: "#gone", label: "Old field" }),
  ];
  const next = [row({ selector: "#npi" }), row({ selector: "#new", label: "New field" })];

  it("names what appeared and what disappeared", () => {
    const diff = diffCapture(previous, next);
    expect(diff.added.map((r) => r.selector)).toEqual(["#new"]);
    expect(diff.removed.map((r) => r.selector)).toEqual(["#gone"]);
    expect(diff.unchanged.map((r) => r.selector)).toEqual(["#npi"]);
  });

  it("CARRIES an earlier decision through a re-capture", () => {
    // Re-deciding a field the human already mapped is exactly the busywork
    // this flow exists to remove.
    const diff = diffCapture(previous, next);
    const kept = diff.unchanged[0];
    if (!kept) throw new Error("expected an unchanged row");
    expect(kept.chosenToken).toBe("provider.npi");
    expect(kept.sent).toBe(true);
  });
});
