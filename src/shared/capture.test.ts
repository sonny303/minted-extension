// S5.2/S5.4 — capture session rules.
import { describe, expect, it } from "vitest";
import {
  applyRowEdit,
  canSendCapture,
  captureCounts,
  diffCapture,
  identifyCapturePage,
  mergePageCapture,
  nextPageSequence,
  parseCaptureSession,
  usedPageNames,
  isNamedRow,
  recognitionSummary,
  restoredSummary,
  rowDisplayName,
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

  it("restores captured option vocabulary and still drops a typed value", () => {
    const restored = parseCaptureSession({
      portalKey: "availity",
      rows: [
        {
          label: "State",
          selector: "#st",
          fieldType: "select",
          options: [{ value: "KS", label: "Kansas" }],
          value: "Kansas",
        },
      ],
    });
    expect(restored?.rows[0]?.options).toEqual([{ value: "KS", label: "Kansas" }]);
    expect(restored?.rows[0] ?? {}).not.toHaveProperty("value");
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

describe("identifyCapturePage (BITE-CAP-05)", () => {
  const base = {
    candidate: "step2",
    urlTail: null as string | null,
    heading: null as string | null,
    mode: "auto" as const,
  };

  it("returns the candidate when there are no previous rows", () => {
    expect(
      identifyCapturePage({
        ...base,
        previous: [],
        scanned: ["#a", "#b"],
      }),
    ).toBe("step2");
  });

  it("mode next-page wins over an identical selector set", () => {
    const previous = [row({ selector: "#a", pageStep: "step1" }), row({ selector: "#b", pageStep: "step1" })];
    expect(
      identifyCapturePage({
        ...base,
        previous,
        scanned: ["#a", "#b"],
        candidate: "Page 2",
        mode: "next-page",
      }),
    ).toBe("Page 2");
  });

  it("URL tail matching reuses that page even at 0 overlap", () => {
    const previous = [
      row({ selector: "#old1", pageStep: "credentials" }),
      row({ selector: "#old2", pageStep: "credentials" }),
    ];
    expect(
      identifyCapturePage({
        ...base,
        previous,
        scanned: ["#brand-new"],
        candidate: "Page 2",
        urlTail: "credentials",
      }),
    ).toBe("credentials");
  });

  it("heading matching reuses that page", () => {
    const previous = [row({ selector: "#a", pageStep: "Practice details" })];
    expect(
      identifyCapturePage({
        ...base,
        previous,
        scanned: ["#x"],
        candidate: "Page 2",
        heading: "Practice details",
      }),
    ).toBe("Practice details");
  });

  it("identical selector set reuses the existing page (overlap = 1.0)", () => {
    const previous = [
      row({ selector: "#a", pageStep: "step1", chosenToken: "provider.npi", sent: true }),
      row({ selector: "#b", pageStep: "step1" }),
    ];
    expect(
      identifyCapturePage({
        ...base,
        previous,
        scanned: ["#a", "#b"],
        candidate: "Page 2",
      }),
    ).toBe("step1");
  });

  it("12-of-20 shared selectors reuses the existing page (drift, ≥ 0.5)", () => {
    const previous = Array.from({ length: 20 }, (_, i) =>
      row({ selector: `#p${i}`, pageStep: "step1" }),
    );
    const scanned = [
      ...Array.from({ length: 12 }, (_, i) => `#p${i}`),
      ...Array.from({ length: 8 }, (_, i) => `#new${i}`),
    ];
    expect(
      identifyCapturePage({
        ...base,
        previous,
        scanned,
        candidate: "Page 2",
      }),
    ).toBe("step1");
  });

  it("6 shared of a 20-row page vs a 6-control scan reuses (min-set normalisation)", () => {
    const previous = Array.from({ length: 20 }, (_, i) =>
      row({ selector: `#p${i}`, pageStep: "step1" }),
    );
    const scanned = Array.from({ length: 6 }, (_, i) => `#p${i}`);
    expect(
      identifyCapturePage({
        ...base,
        previous,
        scanned,
        candidate: "Page 2",
      }),
    ).toBe("step1");
  });

  it("fully disjoint selector set returns the candidate (the multi-page regression)", () => {
    // Reproduced against the CAP-01 unconditional reuse: a genuine second page
    // must NOT collapse onto step1 and wipe its rows via mergePageCapture.
    const previous = [
      row({ selector: "#p1a", pageStep: "step1", chosenToken: "provider.npi", sent: true }),
      row({ selector: "#p1b", pageStep: "step1" }),
    ];
    expect(
      identifyCapturePage({
        ...base,
        previous,
        scanned: ["#p2a", "#p2b"],
        candidate: "step2",
        urlTail: "step2",
      }),
    ).toBe("step2");
  });

  it("two existing pages: overlap only with the second → the second", () => {
    const previous = [
      row({ selector: "#a1", pageStep: "pageA" }),
      row({ selector: "#a2", pageStep: "pageA" }),
      row({ selector: "#b1", pageStep: "pageB" }),
      row({ selector: "#b2", pageStep: "pageB" }),
    ];
    expect(
      identifyCapturePage({
        ...base,
        previous,
        scanned: ["#b1", "#b2", "#b3"],
        candidate: "Page 3",
      }),
    ).toBe("pageB");
  });

  it("ties break toward the page whose rows appear last", () => {
    const previous = [
      row({ selector: "#shared", pageStep: "first" }),
      row({ selector: "#only-first", pageStep: "first" }),
      row({ selector: "#shared", pageStep: "second" }),
      row({ selector: "#only-second", pageStep: "second" }),
    ];
    // scanned overlaps each page by exactly 1 of 2 → ratio 0.5 for both;
    // tie on overlap count breaks toward "second" (rows appear last).
    expect(
      identifyCapturePage({
        ...base,
        previous,
        scanned: ["#shared", "#brand-new"],
        candidate: "Page 3",
      }),
    ).toBe("second");
  });

  it("legacy pageStep null with overlapping selectors returns null", () => {
    const previous = [
      row({ selector: "#a", pageStep: null, chosenToken: "provider.npi", sent: true }),
      row({ selector: "#b", pageStep: null }),
    ];
    expect(
      identifyCapturePage({
        ...base,
        previous,
        scanned: ["#a", "#b"],
        candidate: "Page 1",
      }),
    ).toBeNull();
  });
});

describe("re-capture same page merges by selector (BITE-CAP-05 preserves CAP-01)", () => {
  it("carries decisions and sent state when identifyCapturePage reuses the page", () => {
    const previous = [
      row({
        selector: "#npi",
        pageStep: "credentials",
        chosenToken: "provider.npi",
        sent: true,
      }),
      row({ selector: "#gone", pageStep: "credentials" }),
    ];
    const pageStep = identifyCapturePage({
      previous,
      scanned: ["#npi", "#new"],
      candidate: "Page 2",
      urlTail: "credentials",
      heading: null,
      mode: "auto",
    });
    expect(pageStep).toBe("credentials");
    const merged = mergePageCapture(
      previous,
      [row({ selector: "#npi", pageStep: "credentials" }), row({ selector: "#new", pageStep: "credentials" })],
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

// 2026-08-19 — manual mapping. The picker exists because an auto-scan can only
// see what is rendered AND wired at the moment it runs; these rules are what
// stop a later re-capture from throwing the trainer's work away.
describe("rowDisplayName / isNamedRow", () => {
  it("prefers the trainer's name over the payer's captured text", () => {
    expect(rowDisplayName(row({ label: "txtNPI_1", displayLabel: "NPI (Type 1)" }))).toBe(
      "NPI (Type 1)",
    );
  });

  it("falls back to the payer's text, then to an honest placeholder", () => {
    expect(rowDisplayName(row({ label: "Tax ID", displayLabel: null }))).toBe("Tax ID");
    // An empty cell reads as a rendering bug; this reads as "the form gave us
    // nothing", which is the truth and is actionable.
    expect(rowDisplayName(row({ label: "", displayLabel: null }))).toBe("Unnamed field");
    expect(rowDisplayName(row({ label: "   ", displayLabel: "  " }))).toBe("Unnamed field");
  });

  it("knows which rows still need a human name", () => {
    expect(isNamedRow(row({ label: "NPI" }))).toBe(true);
    expect(isNamedRow(row({ label: "", displayLabel: "NPI" }))).toBe(true);
    expect(isNamedRow(row({ label: "", displayLabel: null }))).toBe(false);
  });
});

describe("parseCaptureSession — manual-mapping fields", () => {
  it("restores origin, the trainer's name, and the type override", () => {
    const restored = parseCaptureSession(
      session([
        row({
          selector: "#npi",
          origin: "user_mapped",
          displayLabel: "NPI",
          typeOverridden: true,
        }),
      ]),
    );
    expect(restored?.rows[0]).toMatchObject({
      origin: "user_mapped",
      displayLabel: "NPI",
      typeOverridden: true,
    });
  });

  it("treats a row captured before the picker existed as auto-detected", () => {
    // Legacy sessions carry no `origin`; defaulting to user_mapped would make
    // mergePageCapture preserve rows the portal really did remove.
    const legacy = { label: "NPI", selector: "#npi", fieldType: "text" };
    const restored = parseCaptureSession({
      portalKey: "availity",
      templateStepId: null,
      startedAt: "2026-07-28",
      rows: [legacy],
    });
    expect(restored?.rows[0]?.origin).toBe("auto_detected");
    expect(restored?.rows[0]?.displayLabel).toBeNull();
    expect(restored?.rows[0]?.typeOverridden).toBe(false);
  });
});

describe("mergePageCapture — a re-capture must not delete manual work", () => {
  const page = "Page 1";

  it("KEEPS a user-mapped row the fresh scan cannot see", () => {
    // The whole point of the picker: the Humana NPI box only exists after a
    // radio choice, so the next scan legitimately misses it. Dropping it here
    // would silently undo the trainer's fix.
    const previous = [
      row({ selector: "#type", pageStep: page, origin: "auto_detected" }),
      row({
        selector: "#npi",
        pageStep: page,
        origin: "user_mapped",
        displayLabel: "NPI",
        chosenToken: "provider.npi",
      }),
    ];
    const scan = [row({ selector: "#type", pageStep: page })];

    const merged = mergePageCapture(previous, scan, page);
    const npi = merged.find((r) => r.selector === "#npi");
    expect(npi).toBeDefined();
    expect(npi).toMatchObject({ displayLabel: "NPI", chosenToken: "provider.npi" });
  });

  it("still DROPS an auto-detected row the scan no longer sees", () => {
    // Drift repair has to keep working: a field the portal really removed
    // should leave the capture.
    const previous = [row({ selector: "#gone", pageStep: page, origin: "auto_detected" })];
    const merged = mergePageCapture(previous, [row({ selector: "#kept", pageStep: page })], page);
    expect(merged.map((r) => r.selector)).toEqual(["#kept"]);
  });

  it("does not duplicate a user-mapped row the scan HAS caught up with", () => {
    // Once the field is visible at scan time the auto row covers it; keeping
    // the rescued copy too would propose the same selector twice.
    const previous = [
      row({ selector: "#npi", pageStep: page, origin: "user_mapped", displayLabel: "NPI" }),
    ];
    const merged = mergePageCapture(previous, [row({ selector: "#npi", pageStep: page })], page);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ selector: "#npi", displayLabel: "NPI" });
  });

  it("carries a rename and a type override across a re-scan", () => {
    const previous = [
      row({
        selector: "#npi",
        label: "txtNPI_1",
        pageStep: page,
        displayLabel: "NPI (Type 1)",
        fieldType: "text",
        typeOverridden: true,
      }),
    ];
    // The scan re-reads the portal and guesses a different type.
    const scan = [row({ selector: "#npi", label: "txtNPI_1", pageStep: page, fieldType: "select" })];

    const [merged] = mergePageCapture(previous, scan, page);
    expect(merged?.displayLabel).toBe("NPI (Type 1)");
    expect(merged?.fieldType).toBe("text");
  });

  it("lets a re-scan correct a type the trainer never overrode", () => {
    const previous = [row({ selector: "#state", pageStep: page, fieldType: "text" })];
    const scan = [row({ selector: "#state", pageStep: page, fieldType: "select" })];
    expect(mergePageCapture(previous, scan, page)[0]?.fieldType).toBe("select");
  });

  it("KEEPS an auto row whose selector the trainer rewrote by hand", () => {
    // US-3.2: fixing a bad selector is exactly as much manual work as adding
    // the field would have been, and the rewritten selector is by definition
    // one the scanner does not produce — so the next scan reports the row as
    // gone. Judging by origin alone would delete the fix on the very next
    // re-capture, which is when a trainer is most likely to re-capture.
    const previous = [
      row({
        selector: "#hand-written",
        pageStep: page,
        origin: "auto_detected",
        selectorOverridden: true,
        displayLabel: "NPI",
      }),
    ];
    const scan = [row({ selector: "input:nth-of-type(4)", pageStep: page })];

    const merged = mergePageCapture(previous, scan, page);
    expect(merged.map((r) => r.selector).sort()).toEqual([
      "#hand-written",
      "input:nth-of-type(4)",
    ]);
  });

  it("does not duplicate a rewritten selector the scan now produces itself", () => {
    const previous = [
      row({ selector: "#npi", pageStep: page, origin: "auto_detected", selectorOverridden: true }),
    ];
    expect(mergePageCapture(previous, [row({ selector: "#npi", pageStep: page })], page)).toHaveLength(
      1,
    );
  });

  it("keeps a user-mapped row belonging to ANOTHER page untouched", () => {
    const previous = [
      row({ selector: "#p1", pageStep: "Page 1", origin: "user_mapped" }),
      row({ selector: "#p2", pageStep: "Page 2" }),
    ];
    const merged = mergePageCapture(previous, [row({ selector: "#p2b", pageStep: "Page 2" })], "Page 2");
    expect(merged.map((r) => r.selector).sort()).toEqual(["#p1", "#p2b"]);
  });
});

// US-3.2 — the per-row editor. Its one hard rule is the invariant the whole
// capture session rests on: the SELECTOR IS THE KEY (diffCapture,
// mergePageCapture and SET_CAPTURE_CHOICE all match rows on it), and the one
// moment a duplicate can be introduced is a hand-written selector.
describe("applyRowEdit", () => {
  const rows = [
    row({ selector: "#a", label: "Portal's name for A", fieldType: "text" }),
    row({ selector: "#b", label: "B" }),
  ];

  it("renames without touching the payer's captured label", () => {
    // The split is the point: a re-scan must be able to refresh what the
    // portal says without discarding what the human called it.
    const out = applyRowEdit(rows, "#a", { displayLabel: " NPI (Type 1) " });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rows[0]).toMatchObject({
      displayLabel: "NPI (Type 1)",
      label: "Portal's name for A",
    });
  });

  it("clears the trainer's name when it is blanked, back to the portal's", () => {
    const named = [row({ selector: "#a", label: "Portal", displayLabel: "Mine" })];
    const out = applyRowEdit(named, "#a", { displayLabel: "   " });
    expect(out.ok && out.rows[0]?.displayLabel).toBeNull();
  });

  it("leaves a field alone when its key is ABSENT", () => {
    // Present-with-empty means "clear it"; absent means "I did not touch it".
    // Collapsing the two would wipe a name on any type-only edit.
    const named = [row({ selector: "#a", displayLabel: "Mine", fieldType: "text" })];
    const out = applyRowEdit(named, "#a", { fieldType: "select" });
    expect(out.ok && out.rows[0]).toMatchObject({ displayLabel: "Mine", fieldType: "select" });
  });

  it("marks a type change as human-chosen so a re-scan cannot undo it", () => {
    const out = applyRowEdit(rows, "#a", { fieldType: "date" });
    expect(out.ok && out.rows[0]).toMatchObject({ fieldType: "date", typeOverridden: true });
  });

  it("rewrites a selector, flags the override, and re-opens it for sending", () => {
    // sent:false is deliberate — the shared library still holds a row at the
    // OLD selector, so the fix is a NEW proposal, not a no-op.
    const sent = [row({ selector: "#old", sent: true })];
    const out = applyRowEdit(sent, "#old", { newSelector: "  #new  " });
    expect(out.ok && out.rows[0]).toMatchObject({
      selector: "#new",
      selectorOverridden: true,
      sent: false,
    });
  });

  it("REFUSES a rewrite that collides with another row", () => {
    // Two rows sharing a selector would corrupt every diff and propose the
    // same selector to the shared library twice.
    const out = applyRowEdit(rows, "#a", { newSelector: "#b" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/already uses that selector/i);
  });

  it("allows a no-op rewrite to a row's own selector", () => {
    // Pressing Save without touching the selector box must not read as a
    // collision with itself.
    const out = applyRowEdit(rows, "#a", { newSelector: "#a", displayLabel: "A" });
    expect(out.ok && out.rows[0]).toMatchObject({ selector: "#a", displayLabel: "A" });
    expect(out.ok && out.rows[0]?.selectorOverridden).toBeUndefined();
  });

  it("ignores a blank selector rather than erasing the row's key", () => {
    const out = applyRowEdit(rows, "#a", { newSelector: "   " });
    expect(out.ok && out.rows[0]?.selector).toBe("#a");
  });

  it("reports an unknown row instead of silently doing nothing", () => {
    const out = applyRowEdit(rows, "#gone", { displayLabel: "x" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toMatch(/no longer in this capture/i);
  });

  it("never mutates the input rows", () => {
    const before = JSON.stringify(rows);
    applyRowEdit(rows, "#a", { displayLabel: "X", fieldType: "select", newSelector: "#z" });
    expect(JSON.stringify(rows)).toBe(before);
  });
});
