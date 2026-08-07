import { describe, expect, it } from "vitest";
import type { PortalFieldMap, PortalRegistryRow } from "./apiTypes";
import {
  assignSortOrder,
  candidatePortalKey,
  candidatePortalName,
  captureStateSummary,
  derivePageStep,
  formCaptureState,
  recognizeForm,
  sequencePageName,
} from "./trainForms";

function portal(over: Partial<PortalRegistryRow> = {}): PortalRegistryRow {
  return {
    id: "p1",
    orgId: null,
    portalKey: "aetna_join",
    name: "Aetna join",
    payerId: "payer-1",
    payerName: "Aetna",
    formUrl: "https://payer.example/enroll/start",
    isVerified: false,
    lastVerifiedAt: null,
    provenAt: null,
    urlChangedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

function map(over: Partial<PortalFieldMap> = {}): PortalFieldMap {
  return {
    id: "m1",
    orgId: null,
    portalKey: "aetna_join",
    urlPattern: null,
    pageStep: "Practice details",
    mapType: "web",
    selector: "#npi",
    selectorFallbacks: null,
    source: "token",
    token: "provider.npi",
    hardcodedValue: null,
    transform: null,
    fieldType: "text",
    notes: null,
    status: "approved",
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

describe("derivePageStep", () => {
  it("prefers the heading — it is what the trainer will recognise later", () => {
    expect(
      derivePageStep({
        url: "https://payer.example/enroll/step2",
        heading: "  Practice   details ",
        sequence: 2,
        used: [],
      }),
    ).toBe("Practice details");
  });

  it("falls back to the URL tail when there is no heading", () => {
    expect(
      derivePageStep({
        url: "https://payer.example/enroll/credentials?session=abc#top",
        heading: null,
        sequence: 3,
        used: [],
      }),
    ).toBe("credentials");
  });

  it("falls back to the capture sequence when neither signal distinguishes", () => {
    // A single-URL wizard with no heading: the trainer walked to page 4, and
    // capture must name it rather than block or prompt.
    expect(derivePageStep({ url: "https://payer.example/enroll", heading: null, sequence: 4, used: ["enroll"] })).toBe(
      "Page 4",
    );
  });

  it("does not reuse a name already taken in this run", () => {
    // Two pages that look identical must not merge into one bucket — that
    // would silently pool their fields under one page in the editor.
    expect(
      derivePageStep({
        url: "https://payer.example/enroll/step",
        heading: "Practice details",
        sequence: 2,
        used: ["Practice details"],
      }),
    ).toBe("step");
    expect(
      derivePageStep({
        url: "https://payer.example/enroll/step",
        heading: "Practice details",
        sequence: 2,
        used: ["Practice details", "step"],
      }),
    ).toBe("Page 2");
  });

  it("skips past a taken sequence name rather than colliding", () => {
    expect(
      derivePageStep({ url: null, heading: null, sequence: 2, used: ["Page 2", "Page 3"] }),
    ).toBe("Page 4");
  });

  it("tolerates a malformed URL", () => {
    expect(derivePageStep({ url: "not a url", heading: null, sequence: 1, used: [] })).toBe(
      sequencePageName(1),
    );
  });
});

describe("assignSortOrder", () => {
  it("numbers rows 1..n in the order the scan produced them", () => {
    // The scan yields document order, so position IS the form's reading order.
    expect(assignSortOrder([{ selector: "#a" }, { selector: "#b" }])).toEqual([
      { selector: "#a", sortOrder: 1 },
      { selector: "#b", sortOrder: 2 },
    ]);
  });

  it("is empty-safe", () => {
    expect(assignSortOrder([])).toEqual([]);
  });
});

describe("recognizeForm", () => {
  const rows = [portal()];

  it("recognizes a page under a registered form's URL", () => {
    const result = recognizeForm("https://payer.example/enroll/start?x=1", rows, "Aetna");
    expect(result.kind).toBe("existing");
    if (result.kind === "existing") expect(result.portal.key).toBe("aetna_join");
  });

  it("greets an unmatched page as new, with a candidate name", () => {
    const result = recognizeForm("https://other.example/apply", rows, "Cigna");
    expect(result).toEqual({ kind: "new", candidateName: "Cigna form" });
  });

  it("numbers the candidate when the payer already has a form", () => {
    // A payer legitimately has several forms (D15) and URL/heading often
    // cannot tell a new one from an existing row — so number it and let the
    // admin rename, never block and never overwrite.
    expect(candidatePortalName("Aetna", rows)).toBe("Aetna form 2");
    expect(candidatePortalName("Aetna", [portal(), portal({ id: "p2", portalKey: "aetna_2" })])).toBe(
      "Aetna form 3",
    );
  });

  it("still names a candidate when the payer is unknown", () => {
    expect(candidatePortalName(null, [])).toBe("Payer form");
    expect(candidatePortalName("   ", [])).toBe("Payer form");
  });

  it("derives a key in the shape the server folds to", () => {
    expect(candidatePortalKey("Aetna form 2")).toBe("aetna_form_2");
    expect(candidatePortalKey("BCBS (KS) — Enrollment")).toBe("bcbs_ks_enrollment");
  });

  it("treats a missing URL as unrecognized rather than guessing", () => {
    expect(recognizeForm(null, rows, "Aetna").kind).toBe("new");
  });
});

describe("formCaptureState", () => {
  it("counts pages, captured fields and genuinely mapped ones", () => {
    const state = formCaptureState([
      map(),
      map({ id: "m2", selector: "#tin", pageStep: "Tax ID", source: "hardcoded", token: null, hardcodedValue: "Group" }),
      map({ id: "m3", selector: "#sig", pageStep: "Tax ID", status: "proposed", source: "manual", token: null }),
    ]);
    expect(state).toEqual({ pagesSeen: 2, fieldsCaptured: 3, mapped: 2, undecided: 1 });
  });

  it("does not count an approved row that would fill nothing", () => {
    // An approved token row with no token, or a fixed row with no value,
    // reports a form as trained while filling nothing — the exact failure the
    // epic exists to remove.
    const state = formCaptureState([
      map({ id: "a", token: null }),
      map({ id: "b", selector: "#x", source: "hardcoded", token: null, hardcodedValue: "  " }),
    ]);
    expect(state.mapped).toBe(0);
    expect(state.fieldsCaptured).toBe(2);
  });

  it("counts a human-fill decision as decided but not mapped", () => {
    const state = formCaptureState([map({ source: "manual", token: null })]);
    expect(state).toMatchObject({ mapped: 0, undecided: 0, fieldsCaptured: 1 });
  });

  it("ignores retired rows entirely", () => {
    expect(formCaptureState([map({ status: "retired" })])).toEqual({
      pagesSeen: 0,
      fieldsCaptured: 0,
      mapped: 0,
      undecided: 0,
    });
  });

  it("summarizes honestly when no page was ever recorded", () => {
    const state = formCaptureState([map({ pageStep: null })]);
    expect(captureStateSummary(state)).toBe("no pages recorded · 1 captured · 1 mapped");
  });

  it("summarizes a multi-page form", () => {
    expect(captureStateSummary({ pagesSeen: 5, fieldsCaptured: 23, mapped: 4, undecided: 19 })).toBe(
      "5 pages seen · 23 captured · 4 mapped",
    );
  });
});
