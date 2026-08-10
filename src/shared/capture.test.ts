// S5.2/S5.4 — capture session rules.
import { describe, expect, it } from "vitest";
import {
  canSendCapture,
  captureCounts,
  diffCapture,
  mergePageCapture,
  orderCaptureRows,
  capturePageOrder,
  nextPageSequence,
  parseCaptureSession,
  resolvePageStepForCapture,
  usedPageNames,
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

  it("refreshes label and sortOrder from the new scan for unchanged selectors", () => {
    const prev = [
      row({ selector: "#npi", label: "Old label", sortOrder: 1, pageStep: "Page 1" }),
    ];
    const fresh = [
      row({
        selector: "#npi",
        label: "New label",
        sortOrder: 3,
        pageStep: "Page 1",
        formSection: "Identity",
      }),
    ];
    const diff = diffCapture(prev, fresh);
    const kept = diff.unchanged[0];
    if (!kept) throw new Error("expected an unchanged row");
    expect(kept.label).toBe("New label");
    expect(kept.sortOrder).toBe(3);
    expect(kept.formSection).toBe("Identity");
  });
});

describe("orderCaptureRows (BITE-CAP-02)", () => {
  const row = (selector: string, pageStep: string | null, sortOrder: number | null) => ({
    label: selector,
    selector,
    fieldType: "text" as const,
    formSection: null,
    suggestedToken: null,
    evidence: null,
    chosenToken: null,
    sent: false,
    pageStep,
    sortOrder,
  });

  it("orders by first-seen pageStep then sortOrder with nulls last", () => {
    const rows = [
      row("#b2", "Page 2", 2),
      row("#a2", "Page 1", 2),
      row("#b1", "Page 2", 1),
      row("#a1", "Page 1", 1),
      row("#orphan", null, 1),
    ];
    expect(orderCaptureRows(rows).map((r) => r.selector)).toEqual([
      "#b1",
      "#b2",
      "#a1",
      "#a2",
      "#orphan",
    ]);
  });

  it("uses capture walk order when pages are interleaved in storage", () => {
    const rows = [
      row("#p2a", "Page 2", 1),
      row("#p1a", "Page 1", 1),
      row("#p2b", "Page 2", 2),
      row("#p1b", "Page 1", 2),
    ];
    expect(capturePageOrder(rows)).toEqual(["Page 2", "Page 1"]);
    expect(orderCaptureRows(rows).map((r) => r.selector)).toEqual([
      "#p2a",
      "#p2b",
      "#p1a",
      "#p1b",
    ]);
  });
});

describe("mergePageCapture (E6.9 multi-page)", () => {
  const row = (selector: string, pageStep: string | null, over: Partial<CaptureRow> = {}) => ({
    label: selector,
    selector,
    fieldType: "text" as const,
    formSection: null,
    suggestedToken: null,
    evidence: null,
    chosenToken: null,
    sent: false,
    pageStep,
    sortOrder: null,
    ...over,
  });

  it("keeps other pages' rows when a new page is scanned", () => {
    // THE multi-page bug a plain diff would cause: scanning page 2 sees none of
    // page 1's selectors, so every page-1 row reads as "removed" and is
    // dropped — the trainer walks five pages and keeps only the fifth.
    const previous = [row("#a", "Page 1"), row("#b", "Page 1")];
    const merged = mergePageCapture(previous, [row("#c", "Page 2")], "Page 2");
    expect(merged.map((r) => r.selector)).toEqual(["#a", "#b", "#c"]);
  });

  it("re-scanning the SAME page carries its decisions and drops vanished fields", () => {
    const previous = [
      row("#a", "Page 1", { chosenToken: "provider.npi", sent: true }),
      row("#gone", "Page 1"),
    ];
    const merged = mergePageCapture(previous, [row("#a", "Page 1"), row("#new", "Page 1")], "Page 1");
    expect(merged.map((r) => r.selector)).toEqual(["#a", "#new"]);
    expect(merged[0]?.chosenToken).toBe("provider.npi");
    expect(merged[0]?.sent).toBe(true);
  });

  it("returns rows in page-walk order then sortOrder", () => {
    const previous = [
      row("#b", "Tax ID", { sortOrder: 2 }),
      row("#a", "Page 1", { sortOrder: 1 }),
    ];
    const merged = mergePageCapture(
      previous,
      [
        row("#c", "Page 1", { sortOrder: 2 }),
        row("#d", "Page 1", { sortOrder: 1 }),
      ],
      "Page 1",
    );
    expect(merged.map((r) => r.selector)).toEqual(["#b", "#d", "#c"]);
  });

  it("re-scanning one page of a multi-page run leaves the other pages alone", () => {
    const previous = [
      row("#a", "Page 1", { chosenToken: "provider.npi" }),
      row("#b", "Page 2", { chosenToken: "group.tin" }),
    ];
    const merged = mergePageCapture(previous, [row("#b2", "Page 2")], "Page 2");
    expect(merged.map((r) => r.selector)).toEqual(["#a", "#b2"]);
    expect(merged[0]?.chosenToken).toBe("provider.npi");
  });

  it("behaves like the old single-page diff for rows with no page", () => {
    const previous = [row("#a", null, { chosenToken: "provider.npi" })];
    const merged = mergePageCapture(previous, [row("#a", null)], null);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.chosenToken).toBe("provider.npi");
  });
});

describe("resolvePageStepForCapture (BITE-CAP-01 — re-capture reuses pageStep)", () => {
  const portalKey = "aetna_join";

  it("derives a fresh name on first capture", () => {
    expect(
      resolvePageStepForCapture({
        url: "https://payer.example/enroll/credentials",
        heading: null,
        session: null,
        portalKey,
      }),
    ).toBe("credentials");
  });

  it("reuses the URL-tail pageStep when re-capturing the same URL", () => {
    const existing: CaptureSession = {
      portalKey,
      templateStepId: null,
      startedAt: "2026-07-28",
      rows: [row({ selector: "#npi", pageStep: "credentials", chosenToken: "provider.npi", sent: true })],
    };
    expect(
      resolvePageStepForCapture({
        url: "https://payer.example/enroll/credentials?session=volatile",
        heading: null,
        session: existing,
        portalKey,
      }),
    ).toBe("credentials");
  });

  it("reuses the only pageStep when the URL gives no match", () => {
    const existing: CaptureSession = {
      portalKey,
      templateStepId: null,
      startedAt: "2026-07-28",
      rows: [
        row({ selector: "#npi", pageStep: "Practice details" }),
        row({ selector: "#tin", pageStep: "Practice details" }),
      ],
    };
    expect(
      resolvePageStepForCapture({
        url: "https://payer.example/enroll/step2",
        heading: null,
        session: existing,
        portalKey,
      }),
    ).toBe("Practice details");
  });

  it("reuses the most recently captured page when several exist", () => {
    const existing: CaptureSession = {
      portalKey,
      templateStepId: null,
      startedAt: "2026-07-28",
      rows: [
        row({ selector: "#a", pageStep: "Page 1" }),
        row({ selector: "#b", pageStep: "Tax ID" }),
      ],
    };
    expect(
      resolvePageStepForCapture({
        url: "https://payer.example/enroll/ambiguous",
        heading: null,
        session: existing,
        portalKey,
      }),
    ).toBe("Tax ID");
  });

  it("does not invent Page 3 on re-capture when heading and URL tail are used", () => {
    const existing: CaptureSession = {
      portalKey,
      templateStepId: null,
      startedAt: "2026-07-28",
      rows: [
        row({ selector: "#a", pageStep: "Practice details" }),
        row({ selector: "#b", pageStep: "credentials" }),
      ],
    };
    const pageStep = resolvePageStepForCapture({
      url: "https://payer.example/enroll/credentials",
      heading: "Practice details",
      session: existing,
      portalKey,
    });
    expect(pageStep).toBe("credentials");
    expect(pageStep).not.toBe("Page 3");
  });
});

describe("re-capture same URL merges by selector (BITE-CAP-01)", () => {
  it("carries decisions and sent state when pageStep is reused", () => {
    const previous = [
      row({
        selector: "#npi",
        pageStep: "credentials",
        chosenToken: "provider.npi",
        sent: true,
      }),
      row({ selector: "#gone", pageStep: "credentials" }),
    ];
    const existing: CaptureSession = {
      portalKey: "aetna_join",
      templateStepId: null,
      startedAt: "2026-07-28",
      rows: previous,
    };
    const pageStep = resolvePageStepForCapture({
      url: "https://payer.example/enroll/credentials",
      heading: null,
      session: existing,
      portalKey: "aetna_join",
    });
    expect(pageStep).toBe("credentials");
    const merged = mergePageCapture(
      previous,
      [
        row({ selector: "#npi", pageStep: "credentials", sortOrder: 1 }),
        row({ selector: "#new", pageStep: "credentials", sortOrder: 2 }),
      ],
      pageStep,
    );
    expect(merged.map((r) => r.selector)).toEqual(["#npi", "#new"]);
    expect(merged[0]?.chosenToken).toBe("provider.npi");
    expect(merged[0]?.sent).toBe(true);
  });
});

describe("usedPageNames / nextPageSequence", () => {
  it("reports the distinct pages captured so far", () => {
    const session = {
      portalKey: "p",
      templateStepId: null,
      startedAt: "2026-08-07T00:00:00Z",
      rows: [
        { ...blankRow("#a"), pageStep: "Page 1" },
        { ...blankRow("#b"), pageStep: "Page 1" },
        { ...blankRow("#c"), pageStep: "Tax ID" },
        { ...blankRow("#d"), pageStep: null },
      ],
    };
    expect(usedPageNames(session)).toEqual(["Page 1", "Tax ID"]);
    expect(nextPageSequence(session)).toBe(3);
  });

  it("starts at page 1 with no session", () => {
    expect(usedPageNames(null)).toEqual([]);
    expect(nextPageSequence(null)).toBe(1);
  });
});

function blankRow(selector: string): CaptureRow {
  return {
    label: selector,
    selector,
    fieldType: "text",
    formSection: null,
    suggestedToken: null,
    evidence: null,
    chosenToken: null,
    sent: false,
  };
}
