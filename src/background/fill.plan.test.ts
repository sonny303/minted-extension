import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PortalFieldMap, ProviderProfileResponse } from "../shared/apiTypes";
import { FIELD_NOT_FOUND_REASON } from "../shared/fixit";

vi.stubGlobal("chrome", {
  storage: {
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
});

const { applyTransform, computeCoverage, planFill, sanitizeLegacyFields } = await import("./fill");

function map(over: Partial<PortalFieldMap> & Pick<PortalFieldMap, "id" | "selector">): PortalFieldMap {
  return {
    id: over.id,
    orgId: over.orgId ?? null,
    portalKey: over.portalKey ?? "demo",
    urlPattern: over.urlPattern ?? null,
    pageStep: over.pageStep ?? null,
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
    ...(over.learnedVia !== undefined ? { learnedVia: over.learnedVia } : {}),
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
  it("formats canonical dates in each supported payer shape", () => {
    expect(applyTransform("1980-05-04", "date_mmddyyyy")).toBe("05/04/1980");
    expect(applyTransform("1980-05-04", "date_mmddyyyy_dash")).toBe("05-04-1980");
    expect(applyTransform("1980-05-04", "date_ddmmyyyy")).toBe("04/05/1980");
    expect(applyTransform("1980-05-04", "date_ddmmyyyy_dash")).toBe("04-05-1980");
    expect(applyTransform("1980-05-04", "date_yyyymmdd_slash")).toBe("1980/05/04");
    expect(applyTransform("1980-05-04", "date_yyyymmdd")).toBe("1980-05-04");
    expect(applyTransform("2000-02-29T23:59:59.000Z", "date_mmddyyyy")).toBe("02/29/2000");
  });

  it("trims valid ZIP+4 and reshapes only valid US phone numbers", () => {
    expect(applyTransform("27608-1110", "zip5")).toBe("27608");
    expect(applyTransform("02708-1110", "zip5")).toBe("02708");
    expect(applyTransform("276081110", "zip5")).toBe("27608");
    expect(applyTransform("2760-81110", "zip5")).toBe("2760-81110");
    expect(applyTransform("(855) 749-7461", "phone_digits")).toBe("8557497461");
    expect(applyTransform("1-855-749-7461", "phone_dashed")).toBe("855-749-7461");
    expect(applyTransform("8557497461", "phone_country_dashed")).toBe("(1) 855-749-7461");
    expect(applyTransform("855-749-7461", "phone_e164")).toBe("+18557497461");
  });

  it("preserves impossible, foreign, and extension-bearing values for review", () => {
    expect(applyTransform("2025-02-29", "date_mmddyyyy")).toBe("2025-02-29");
    expect(applyTransform("31/12/2025", "date_mmddyyyy")).toBe("31/12/2025");
    expect(applyTransform("+44 20 7946 0958", "phone_digits")).toBe("+44 20 7946 0958");
    expect(applyTransform("+4930123456", "phone_e164")).toBe("+4930123456");
    expect(applyTransform("855-749-7461 ext 20", "phone_digits")).toBe("855-749-7461 ext 20");
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
    expect(plan.staticFills).toHaveLength(1);
    expect(plan.staticFills[0]?.label).toBe("First Name");
    expect(plan.staticFills[0]?.value).toBe("Ada");
    expect(plan.staticFills[0]?.pageStep).toBeNull();
  });

  it("carries trained pageStep onto each instruction (DYN-PAGE-01)", () => {
    const plan = planFill(
      [map({ id: "a", selector: "label:First Name", pageStep: "credentials" })],
      profile,
    );
    expect(plan.staticFills[0]?.pageStep).toBe("credentials");
  });

  it("carries exact URL scope only for Nano-learned maps", () => {
    const plan = planFill(
      [
        map({
          id: "learned",
          selector: "#field",
          learnedVia: "nano",
          urlPattern: "https://portal.example/provider",
        }),
        map({
          id: "legacy",
          selector: "#legacy",
          urlPattern: "https://portal.example/provider",
        }),
      ],
      profile,
    );
    expect(plan.staticFills[0]?.pageUrlScope).toBe("https://portal.example/provider");
    expect(plan.staticFills[1]).not.toHaveProperty("pageUrlScope");
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
    expect(plan.staticFills.map((i) => i.label)).toEqual(["Const"]);
    expect(plan.staticFills[0]?.value).toBe("FIXED");
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
    expect(plan.staticFills[0]?.value).toBe("05/04/1980");
    expect(plan.staticFills[0]?.nativeDateValue).toBe("1980-05-04");
    expect(plan.manual).toEqual([
      {
        label: "DOB",
        reason: "prefilled - review and complete manually",
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

describe("legacy fill-event projection", () => {
  it("preserves qualified drift and keeps unknown context in the old no-evidence bucket", () => {
    const projected = sanitizeLegacyFields([
      { label: "NPI", reason: FIELD_NOT_FOUND_REASON, mapId: "map-id", kind: "skipped" },
      { label: "Tax ID", reason: "typed value was XYZ", mapId: "map-id-2", kind: "page_unknown" },
      { label: "State", reason: 'dropdown has no option for "CO"', mapId: "map-id-3", kind: "skipped" },
    ]);
    expect(projected[0]).toEqual({ label: "NPI", reason: FIELD_NOT_FOUND_REASON, mapId: "map-id", kind: "skipped" });
    expect(projected[1]).toEqual({ label: "Tax ID", reason: "current wizard page could not be confirmed", mapId: "map-id-2", kind: "hidden" });
    expect(projected[2]?.reason).toBe("field option mismatch; review options on the portal");
    expect(JSON.stringify(projected)).not.toContain("XYZ");
    expect(JSON.stringify(projected)).not.toContain("CO");
  });
});
