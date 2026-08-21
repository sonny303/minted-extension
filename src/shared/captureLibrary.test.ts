// BITE-TRAIN-03 — the capture list joined to the shared field library.
import { describe, expect, it } from "vitest";
import {
  captureLibraryCounts,
  captureLibrarySummary,
  joinCaptureLibrary,
  libraryRowName,
} from "./captureLibrary";
import type { CaptureRow } from "./capture";
import type { PortalFieldMap } from "./apiTypes";

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

function map(over: Partial<PortalFieldMap> = {}): PortalFieldMap {
  return {
    id: over.id ?? "map-1",
    orgId: null,
    portalKey: "availity",
    urlPattern: null,
    pageStep: null,
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
    createdAt: "2026-08-01",
    updatedAt: "2026-08-01",
    ...over,
  };
}

describe("joinCaptureLibrary", () => {
  it("marks a scanned field the library already holds, with its decision", () => {
    const list = joinCaptureLibrary([row()], [map()]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      selector: "#npi",
      state: "in-library",
      library: { decision: "token", note: "Fills from provider.npi" },
    });
  });

  it("marks a field the library has never seen as new", () => {
    const list = joinCaptureLibrary(
      [row({ selector: "#tin", label: "TIN" })],
      [map()],
    );
    expect(list[0]).toMatchObject({ state: "new", library: null });
  });

  it("flags a library field the scan missed on a page it walked as drift", () => {
    const list = joinCaptureLibrary(
      [row({ selector: "#tin", label: "TIN", pageStep: "Practice" })],
      [map({ pageStep: "Practice", displayLabel: "Individual NPI" })],
    );
    expect(list.map((r) => [r.name, r.state])).toEqual([
      ["TIN", "new"],
      ["Individual NPI", "drifted"],
    ]);
    expect(list[1]?.row).toBeNull();
  });

  it("does not call a page the trainer never opened drift", () => {
    const list = joinCaptureLibrary(
      [row({ selector: "#tin", pageStep: "Practice" })],
      [map({ pageStep: "Credentials" })],
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.state).toBe("new");
  });

  it("lists the library alone when the browser lost the capture session", () => {
    const list = joinCaptureLibrary(
      [],
      [
        map({ pageStep: "Credentials" }),
        map({ id: "map-2", selector: "#tin" }),
      ],
    );
    expect(list.map((r) => r.state)).toEqual(["library-only", "library-only"]);
    expect(list.every((r) => r.row === null)).toBe(true);
  });

  it("ignores retired maps — a tombstone is not drift", () => {
    expect(joinCaptureLibrary([], [map({ status: "retired" })])).toEqual([]);
  });

  it("matches a scanned row through a map's fallback selector", () => {
    const list = joinCaptureLibrary(
      [row({ selector: "input[name='npi']" })],
      [map({ selectorFallbacks: ["input[name='npi']"] })],
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.state).toBe("in-library");
  });

  it("names a library row by the selector when nobody renamed it", () => {
    expect(libraryRowName(map({ selector: "label:Provider NPI" }))).toBe(
      "Provider NPI",
    );
    expect(libraryRowName(map({ displayLabel: "  Individual NPI " }))).toBe(
      "Individual NPI",
    );
  });
});

describe("captureLibraryCounts / captureLibrarySummary", () => {
  it("counts against the library, not the dead per-row token", () => {
    const list = joinCaptureLibrary(
      [
        row({ selector: "#npi" }),
        row({ selector: "#tin", label: "TIN" }),
        row({ selector: "#dea", label: "DEA" }),
      ],
      [
        map(),
        map({
          id: "map-2",
          selector: "#tin",
          status: "proposed",
          source: "manual",
          token: null,
        }),
        map({ id: "map-3", selector: "#lic", displayLabel: "License" }),
      ],
    );
    const counts = captureLibraryCounts(list);
    expect(counts).toEqual({
      total: 4,
      mapped: 2,
      undecided: 1,
      human: 0,
      fresh: 1,
      drifted: 1,
    });
    expect(captureLibrarySummary(counts)).toBe(
      "2 of 4 fill from the shared library · 1 awaiting a decision · 1 new in this scan · 1 in the library but not on this page.",
    );
  });

  it("says so plainly when neither the page nor the library has anything", () => {
    expect(captureLibrarySummary(captureLibraryCounts([]))).toBe(
      "Nothing in the shared library for this form yet — capture it to propose its fields.",
    );
  });
});

describe("library rows carry a control type", () => {
  it("takes it from the map for a row the scan did not find", () => {
    // The drift row's live re-check needs it: an N-way radio match is one
    // field, and without the type it would read as ambiguity.
    const list = joinCaptureLibrary(
      [row({ selector: "#a" })],
      [map({ selector: "#gone", fieldType: "radio" })],
    );
    const drifted = list.find((r) => r.state === "drifted");
    expect(drifted?.fieldType).toBe("radio");
  });

  it("takes it from the captured row when the scan found it", () => {
    const list = joinCaptureLibrary(
      [row({ selector: "#a", fieldType: "select" })],
      [map({ selector: "#a" })],
    );
    expect(list[0]?.fieldType).toBe("select");
  });
});
