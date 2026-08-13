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
