import { describe, expect, it } from "vitest";
import {
  caseContextHasContent,
  resolveCaseFacilitySelection,
} from "./caseContext";
import type { CaseContext } from "./apiTypes";

const FACILITY = {
  id: "fac-1",
  name: "Fitness Physio - Lee's Summit",
  street: "1 Main St",
  suite: null,
  city: "Lee's Summit",
  state: "MO",
  zip: "64063",
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
