import { describe, expect, it, vi } from "vitest";
import type { PortalFieldMap } from "../shared/apiTypes";

vi.stubGlobal("chrome", {
  storage: {
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
});

const { planMockFill } = await import("./mockFill");

function map(over: Partial<PortalFieldMap> & Pick<PortalFieldMap, "id" | "selector">): PortalFieldMap {
  return {
    id: over.id,
    orgId: null,
    portalKey: "demo",
    urlPattern: null,
    pageStep: null,
    mapType: "web",
    selector: over.selector,
    selectorFallbacks: null,
    source: over.source ?? "token",
    token: Object.prototype.hasOwnProperty.call(over, "token")
      ? (over.token ?? null)
      : "provider.firstName",
    hardcodedValue: over.hardcodedValue ?? null,
    transform: over.transform ?? null,
    fieldType: over.fieldType ?? "text",
    notes: null,
    status: over.status ?? "approved",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("planMockFill", () => {
  it("reports undecided rows while still producing synthetic token instructions", () => {
    const plan = planMockFill([
      map({ id: "token", selector: "label:First Name", token: "provider.firstName" }),
      map({ id: "undecided", selector: "label:Unmapped", status: "proposed", source: "manual", token: null }),
      map({ id: "human", selector: "label:Notes", source: "manual", token: null }),
      map({ id: "retired", selector: "label:Old", status: "retired" }),
    ]);

    expect(plan.instructions).toHaveLength(1);
    expect(plan.instructions[0]?.value).toBe("Sample");
    expect(plan.gaps).toEqual([
      expect.objectContaining({ mapId: "undecided", reason: "Needs a decision" }),
    ]);
  });

  it("fills fixed values with transforms and reports file fields", () => {
    const plan = planMockFill([
      map({
        id: "date",
        selector: "label:DOB",
        source: "token",
        token: "provider.dateOfBirth",
        transform: "date_mmddyyyy",
      }),
      map({
        id: "fixed",
        selector: "label:State",
        source: "hardcoded",
        token: null,
        hardcodedValue: "NC",
      }),
      map({ id: "file", selector: "label:W9", fieldType: "file", token: null }),
    ]);

    expect(plan.instructions.map((instruction) => instruction.value)).toEqual(["01/15/1980", "NC"]);
    expect(plan.gaps).toEqual([
      expect.objectContaining({ mapId: "file", kind: "file" }),
    ]);
  });
});
