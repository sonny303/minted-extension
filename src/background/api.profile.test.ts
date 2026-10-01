import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("chrome", {
  storage: {
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
});

const { providerProfileSearchParams } = await import("./api");

describe("provider profile selectors", () => {
  it("serializes only a complete authorized Contract tuple", () => {
    const params = providerProfileSearchParams({
      contractContext: {
        contractId: "123e4567-e89b-12d3-a456-426614174000",
        assignmentId: "123e4567-e89b-12d3-a456-426614174001",
        contextVersion: 4,
        sopTemplateId: "123e4567-e89b-12d3-a456-426614174002",
        sopVersion: 2,
        stepIdentity: "contract:task:step",
      },
      facilityId: "123e4567-e89b-12d3-a456-426614174003",
    });

    expect(params.toString()).toBe(
      "facilityId=123e4567-e89b-12d3-a456-426614174003&contractId=123e4567-e89b-12d3-a456-426614174000&assignmentId=123e4567-e89b-12d3-a456-426614174001&contextVersion=4&sopTemplateId=123e4567-e89b-12d3-a456-426614174002&sopVersion=2&stepIdentity=contract%3Atask%3Astep",
    );
    expect(params.has("caseId")).toBe(false);
  });

  it("keeps legacy case profile selectors unchanged", () => {
    const params = providerProfileSearchParams({ caseId: "case-1", state: "CO" });
    expect(params.toString()).toBe("state=CO&caseId=case-1");
    expect(params.has("contractId")).toBe(false);
  });
});
