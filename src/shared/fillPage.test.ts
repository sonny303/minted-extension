import { describe, expect, it } from "vitest";
import type { FillInstruction } from "./fill";
import {
  OTHER_PAGE_KIND,
  OTHER_PAGE_REASON,
  isExactFillPageIdentity,
  isOtherPageInstruction,
  otherPageReport,
  resolveFillPage,
} from "./fillPage";

function instr(pageStep: string | null, over: Partial<FillInstruction> = {}): FillInstruction {
  return {
    mapId: over.mapId ?? "m1",
    label: over.label ?? "Field",
    selector: over.selector ?? "#f",
    selectorFallbacks: [],
    fieldType: "text",
    value: "x",
    pageStep,
  };
}

describe("isExactFillPageIdentity", () => {
  it("rejects null, blank, and Page N sequence fallbacks", () => {
    expect(isExactFillPageIdentity(null)).toBe(false);
    expect(isExactFillPageIdentity("")).toBe(false);
    expect(isExactFillPageIdentity("Page 1")).toBe(false);
    expect(isExactFillPageIdentity("Page 12")).toBe(false);
  });

  it("accepts URL-tail and heading page names", () => {
    expect(isExactFillPageIdentity("credentials")).toBe(true);
    expect(isExactFillPageIdentity("Practice details")).toBe(true);
  });
});

describe("resolveFillPage", () => {
  it("returns null for single-page / null pageStep portals", () => {
    expect(resolveFillPage("https://payer.example/enroll/credentials", [null])).toBeNull();
    expect(resolveFillPage("https://payer.example/enroll", ["credentials"])).toBeNull();
  });

  it("matches exact URL-tail to a trained exact page", () => {
    expect(
      resolveFillPage("https://payer.example/enroll/credentials?sid=1", [
        "credentials",
        "tax-id",
      ]),
    ).toBe("credentials");
  });

  it("returns null when the URL does not match any exact page", () => {
    expect(
      resolveFillPage("https://payer.example/enroll/other", ["credentials", "tax-id"]),
    ).toBeNull();
  });

  it("ignores Page N buckets when matching — never treats them as identity", () => {
    expect(
      resolveFillPage("https://payer.example/enroll/Page%201", ["Page 1", "credentials"]),
    ).toBeNull();
  });
});

describe("isOtherPageInstruction / otherPageReport", () => {
  it("classifies only exact different pages when current identity is known", () => {
    expect(isOtherPageInstruction(instr("tax-id"), "credentials")).toBe(true);
    expect(isOtherPageInstruction(instr("credentials"), "credentials")).toBe(false);
    expect(isOtherPageInstruction(instr(null), "credentials")).toBe(false);
    expect(isOtherPageInstruction(instr("Page 2"), "credentials")).toBe(false);
    expect(isOtherPageInstruction(instr("tax-id"), null)).toBe(false);
  });

  it("emits the panel-pinned kind and reason", () => {
    expect(otherPageReport(instr("tax-id", { label: "TIN", mapId: "m-tin" }))).toEqual({
      label: "TIN",
      reason: OTHER_PAGE_REASON,
      mapId: "m-tin",
      kind: OTHER_PAGE_KIND,
    });
    expect(OTHER_PAGE_KIND).toBe("other_page");
    expect(OTHER_PAGE_REASON).toBe("field belongs to another page");
  });
});
