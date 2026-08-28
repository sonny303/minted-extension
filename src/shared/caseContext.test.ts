import { describe, expect, it } from "vitest";
import {
  caseContextHasContent,
  facilityAddressLines,
  facilityPickerScope,
  resolveCaseFacilitySelection,
} from "./caseContext";
import type { CaseContext } from "./apiTypes";

const FACILITY = {
  id: "fac-1",
  name: "Midtown Clinic",
  street: "1 Example St",
  suite: null,
  city: "Midtown",
  state: "MO",
  zip: "67890",
};

describe("caseContextHasContent", () => {
  it("is false for a quiet case — ONLY selectedFacility populated (B1.2)", () => {
    const context: CaseContext = {
      referenceNumbers: [],
      latestNote: null,
      latestTouch: null,
      selectedFacility: FACILITY,
      openTasks: [],
      payerPipelineState: undefined,
    };
    expect(caseContextHasContent(context)).toBe(false);
  });

  it("is false for null", () => {
    expect(caseContextHasContent(null)).toBe(false);
  });

  it("is true when any rendered field is populated", () => {
    const base: CaseContext = {
      referenceNumbers: [],
      latestNote: null,
      latestTouch: null,
      openTasks: [],
    };
    expect(caseContextHasContent({ ...base, referenceNumbers: ["REF-1"] })).toBe(true);
    expect(
      caseContextHasContent({
        ...base,
        latestNote: { content: "hi", createdAt: "2026-01-01", authorName: null },
      }),
    ).toBe(true);
    expect(
      caseContextHasContent({
        ...base,
        latestTouch: { touchDate: null, touchType: null, outcome: null, note: null },
      }),
    ).toBe(true);
    expect(
      caseContextHasContent({
        ...base,
        openTasks: [
          {
            id: "t1",
            title: "Task",
            status: "open",
            executionType: "manual",
            sortOrder: 1,
            dueDate: null,
          },
        ],
      }),
    ).toBe(true);
    expect(caseContextHasContent({ ...base, payerPipelineState: "not_started" })).toBe(true);
  });
});

describe("resolveCaseFacilitySelection", () => {
  it("applies the case's facility when preferCaseFacility is set", () => {
    const result = resolveCaseFacilitySelection({
      selectedFacility: { id: "fac-1" },
      facilityIds: ["fac-1", "fac-2"],
      preferCaseFacility: true,
      currentFacilityId: "fac-2",
    });
    expect(result).toEqual({ apply: true, facilityId: "fac-1", alreadyCurrent: false });
  });

  it("applies the case's facility when nothing is currently selected, even without the preference flag", () => {
    const result = resolveCaseFacilitySelection({
      selectedFacility: { id: "fac-1" },
      facilityIds: ["fac-1"],
      preferCaseFacility: false,
      currentFacilityId: null,
    });
    expect(result).toEqual({ apply: true, facilityId: "fac-1", alreadyCurrent: false });
  });

  it("flags alreadyCurrent when the case's facility is already the selection — cards still need resolving", () => {
    const result = resolveCaseFacilitySelection({
      selectedFacility: { id: "fac-1" },
      facilityIds: ["fac-1"],
      preferCaseFacility: true,
      currentFacilityId: "fac-1",
    });
    expect(result).toEqual({ apply: true, facilityId: "fac-1", alreadyCurrent: true });
  });

  it("never applies when the case has no facility", () => {
    const result = resolveCaseFacilitySelection({
      selectedFacility: null,
      facilityIds: ["fac-1"],
      preferCaseFacility: true,
      currentFacilityId: null,
    });
    expect(result).toEqual({ apply: false });
  });

  it("never applies a facility the provider's current set doesn't carry — no guessing", () => {
    const result = resolveCaseFacilitySelection({
      selectedFacility: { id: "stale-facility" },
      facilityIds: ["fac-1", "fac-2"],
      preferCaseFacility: true,
      currentFacilityId: null,
    });
    expect(result).toEqual({ apply: false });
  });

  it("leaves an existing pick alone when there's no fresh preference and something is already selected", () => {
    const result = resolveCaseFacilitySelection({
      selectedFacility: { id: "fac-1" },
      facilityIds: ["fac-1", "fac-2"],
      preferCaseFacility: false,
      currentFacilityId: "fac-2",
    });
    expect(result).toEqual({ apply: false });
  });
});

describe("facilityPickerScope (E1.5)", () => {
  const provider = [
    { id: "fac-1", name: "Main Clinic" },
    { id: "fac-2", name: "Satellite Office" },
    { id: "fac-3", name: "Third Site" },
  ];

  it("scopes to the case's own locations when it has any", () => {
    const caseFacilities = [
      { id: "fac-2", name: "Satellite Office" },
      { id: "fac-1", name: "Main Clinic" },
    ];
    expect(facilityPickerScope(caseFacilities, provider)).toEqual(caseFacilities);
  });

  it("falls back to the provider's full set when the case has none", () => {
    expect(facilityPickerScope([], provider)).toBe(provider);
    expect(facilityPickerScope(undefined, provider)).toBe(provider);
  });

  it("filters out a case location the provider's CURRENT set no longer carries", () => {
    const caseFacilities = [
      { id: "fac-1", name: "Main Clinic" },
      { id: "fac-stale", name: "Since Unassigned" },
    ];
    expect(facilityPickerScope(caseFacilities, provider)).toEqual([
      { id: "fac-1", name: "Main Clinic" },
    ]);
  });

  it("falls back to the provider's full set rather than showing zero locations when NONE of the case's intersect", () => {
    const caseFacilities = [{ id: "fac-stale", name: "Since Unassigned" }];
    expect(facilityPickerScope(caseFacilities, provider)).toBe(provider);
  });
});

describe("facilityAddressLines (E1.5)", () => {
  it("joins street+suite and city/state/zip into two lines", () => {
    expect(
      facilityAddressLines({
        street: "1 Example St",
        suite: "Ste 2",
        city: "Wichita",
        state: "KS",
        zip: "67202",
      }),
    ).toEqual(["1 Example St, Ste 2", "Wichita, KS 67202"]);
  });

  it("collapses a missing suite/state/zip without a stray comma", () => {
    expect(
      facilityAddressLines({
        street: "1 Example St",
        suite: null,
        city: "Wichita",
        state: null,
        zip: null,
      }),
    ).toEqual(["1 Example St", "Wichita"]);
  });

  it("returns [] for a facility with no address fields at all", () => {
    expect(facilityAddressLines({})).toEqual([]);
    expect(facilityAddressLines(null)).toEqual([]);
    expect(facilityAddressLines(undefined)).toEqual([]);
  });
});
