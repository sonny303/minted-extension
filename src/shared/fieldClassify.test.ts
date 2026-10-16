import { describe, expect, it } from "vitest";
import { classifyFieldMap } from "./fieldClassify";

describe("classifyFieldMap", () => {
  it("treats a proposed manual row as undecided", () => {
    const classification = classifyFieldMap({
      status: "proposed",
      source: "manual",
      token: null,
    });

    expect(classification).toMatchObject({
      decision: "undecided",
      needsDecision: true,
      mapped: false,
    });
  });

  it("classifies an approved leave_blank row as decided, never autofillable, never a gap", () => {
    expect(
      classifyFieldMap({ status: "approved", source: "leave_blank", token: null }),
    ).toEqual({
      decision: "blank",
      mapped: true,
      autofillable: false,
      needsDecision: false,
      reason: "Left blank on purpose",
    });
    // Proposed is classified before source: an unreviewed leave_blank is still undecided.
    expect(
      classifyFieldMap({ status: "proposed", source: "leave_blank", token: null }),
    ).toMatchObject({ decision: "undecided", needsDecision: true });
  });

  it("classifies approved token and fixed-value rows as autofillable", () => {
    expect(
      classifyFieldMap({ status: "approved", source: "token", token: "provider.firstName" }),
    ).toMatchObject({ decision: "token", autofillable: true });
    expect(
      classifyFieldMap({
        status: "approved",
        source: "hardcoded",
        token: null,
        hardcodedValue: "NC",
      }),
    ).toMatchObject({ decision: "fixed", autofillable: true });
  });
});
