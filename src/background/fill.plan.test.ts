import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PortalFieldMap, ProviderProfileResponse } from "../shared/apiTypes";

vi.stubGlobal("chrome", {
  storage: {
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
});

const { applyTransform, computeCoverage, planFill } = await import("./fill");

function map(over: Partial<PortalFieldMap> & Pick<PortalFieldMap, "id" | "selector">): PortalFieldMap {
  return {
    id: over.id,
    orgId: over.orgId ?? null,
    portalKey: over.portalKey ?? "demo",
    urlPattern: null,
    pageStep: null,
    mapType: over.mapType ?? "web",
    selector: over.selector,
    selectorFallbacks: over.selectorFallbacks ?? null,
    source: over.source ?? "token",
    token: Object.prototype.hasOwnProperty.call(over, "token")
      ? (over.token ?? null)
      : "provider.firstName",
    hardcodedValue: over.hardcodedValue ?? null,
    transform: over.transform ?? null,
    fieldType: over.fieldType ?? "text",
    notes: over.notes ?? null,
    status: over.status ?? "approved",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const profile: ProviderProfileResponse = {
  provider: { id: "p1" },
  tokens: [
    { token: "provider.firstName", value: "Ada" },
    { token: "provider.dob", value: "1980-05-04" },
    { token: "provider.state", value: "Kansas" },
  ],
  unresolved: [{ token: "provider.deaNumber", reason: "DEA not on file" }],
  facilities: [],
  selected_facility_id: null,
};

describe("applyTransform", () => {
  it("formats dates and state abbreviations; unknown transforms pass through", () => {
    expect(applyTransform("1980-05-04", "date_mmddyyyy")).toBe("05/04/1980");
    expect(applyTransform("Kansas", "state_abbrev")).toBe("KS");
    expect(applyTransform("ks", "state_abbrev")).toBe("KS");
    expect(applyTransform("Ada", "mystery")).toBe("Ada");
    expect(applyTransform("Ada", null)).toBe("Ada");
  });
});

describe("planFill", () => {
  beforeAll(() => {
    expect(planFill).toBeTypeOf("function");
  });

  it("only plans approved web maps", () => {
    const plan = planFill(
      [
        map({ id: "a", selector: "label:First Name", status: "approved" }),
        map({ id: "b", selector: "label:Skip", status: "proposed" }),
        map({ id: "c", selector: "label:Pdf", mapType: "pdf", status: "approved" }),
      ],
      profile,
    );
    expect(plan.instructions).toHaveLength(1);
    expect(plan.instructions[0]?.label).toBe("First Name");
    expect(plan.instructions[0]?.value).toBe("Ada");
  });

  it("routes file/manual/no_mapping/no_value into manual with kinds", () => {
    const plan = planFill(
      [
        map({ id: "f", selector: "label:W9", fieldType: "file", token: null }),
        map({ id: "m", selector: "label:Notes", source: "manual", token: null }),
        map({ id: "n", selector: "label:DEA", token: "provider.deaNumber" }),
        map({ id: "u", selector: "label:Orphan", token: null, source: "token" }),
        map({
          id: "h",
          selector: "label:Const",
          source: "hardcoded",
          token: null,
          hardcodedValue: "FIXED",
        }),
      ],
      profile,
    );
    expect(plan.instructions.map((i) => i.label)).toEqual(["Const"]);
    expect(plan.instructions[0]?.value).toBe("FIXED");
    expect(plan.manual.map((g) => g.kind)).toEqual(["file", "manual", "no_value", "no_mapping"]);
  });

  it("applies transforms and flags manual_partial for review", () => {
    const plan = planFill(
      [
        map({
          id: "d",
          selector: "label:DOB",
          token: "provider.dob",
          transform: "date_mmddyyyy",
          source: "manual_partial",
          notes: "confirm with license",
        }),
      ],
      profile,
    );
    expect(plan.instructions[0]?.value).toBe("05/04/1980");
    expect(plan.manual).toEqual([
      {
        label: "DOB",
        reason: "confirm with license",
        mapId: "d",
        kind: "review",
      },
    ]);
  });
});

describe("computeCoverage", () => {
  it("derives available/total from the same planFill rules", () => {
    const coverage = computeCoverage(
      [
        map({ id: "a", selector: "label:First Name" }),
        map({ id: "b", selector: "label:DEA", token: "provider.deaNumber" }),
      ],
      profile,
    );
    expect(coverage.available).toBe(1);
    expect(coverage.total).toBe(2);
    expect(coverage.gaps).toHaveLength(1);
  });
});
