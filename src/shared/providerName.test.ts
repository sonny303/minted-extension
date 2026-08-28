import { describe, expect, it } from "vitest";
import { providerDisplayName } from "./providerName";

describe("providerDisplayName", () => {
  it("joins name, credentials, and specialty", () => {
    expect(providerDisplayName("Jim Apple", "PT", "Physical Therapy")).toBe(
      "Jim Apple, PT, Physical Therapy",
    );
  });

  it("does not repeat a credential that is also the specialty", () => {
    expect(providerDisplayName("Jim Apple", "PT", "PT")).toBe("Jim Apple, PT");
  });

  it("de-duplicates case-insensitively and flattens credential lists", () => {
    expect(providerDisplayName("Alex Sample", "PT, DPT", "dpt")).toBe("Alex Sample, PT, DPT");
  });

  it("drops empty and missing parts", () => {
    expect(providerDisplayName("Alex Sample", null, "  ")).toBe("Alex Sample");
  });
});
