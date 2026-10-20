import { describe, expect, it } from "vitest";
import type { FillInstruction, FillProbeResult, FillProbeTargetStatus } from "./fill";
import {
  OTHER_PAGE_KIND,
  OTHER_PAGE_REASON,
  applySequencePageEvidence,
  isExactFillPageIdentity,
  isOtherPageInstruction,
  isSequencePageStep,
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

// DYN-PAGE-03 — a "Page N" bucket fills only on its own trained evidence.
describe("applySequencePageEvidence", () => {
  const row = (mapId: string, targetStatus: FillProbeTargetStatus): FillProbeResult => ({
    mapId,
    pageStatus: "eligible",
    targetStatus,
    pageSettled: true,
    radioGroup: targetStatus === "unique",
    pageFields: 4,
    resolvedPage: null,
  });
  const steps = (...pageSteps: (string | null)[]) => pageSteps.map((pageStep) => ({ pageStep }));
  const withheld = (mapId: string): FillProbeResult => ({
    ...row(mapId, "missing"),
    pageStatus: "page_unknown",
    radioGroup: false,
  });

  it("recognizes only the sequence fallback as a sequence page", () => {
    expect(isSequencePageStep("Page 2")).toBe(true);
    expect(isSequencePageStep(" page  12 ")).toBe(true);
    expect(isSequencePageStep("index")).toBe(false);
    expect(isSequencePageStep("Demographic information")).toBe(false);
    expect(isSequencePageStep(null)).toBe(false);
  });

  it("proves a bucket when at least half its maps find their control, and withholds the missing ones", () => {
    const out = applySequencePageEvidence(
      steps("Page 2", "Page 2", "Page 2", "Page 2"),
      [row("a", "unique"), row("b", "hidden"), row("c", "missing"), row("d", "missing")],
      null,
    );
    expect(out).toEqual([
      { ...row("a", "unique"), pageEvidence: "fingerprint" },
      { ...row("b", "hidden"), pageEvidence: "fingerprint" },
      withheld("c"),
      withheld("d"),
    ]);
  });

  it("withholds the whole bucket when fewer than half its maps find their control", () => {
    const out = applySequencePageEvidence(
      steps("Page 2", "Page 2", "Page 2"),
      [row("a", "unique"), row("b", "missing"), row("c", "unsupported")],
      null,
    );
    expect(out).toEqual([withheld("a"), withheld("b"), withheld("c")]);
  });

  it("judges each Page N bucket on its own and leaves other maps alone", () => {
    const heading = { ...row("h", "missing"), pageStatus: "page_unknown" as const };
    const out = applySequencePageEvidence(
      steps("Page 2", "Page 3", "Page 3", null, "Demographic information"),
      [row("p2", "unique"), row("p3a", "unique"), row("p3b", "missing"), row("legacy", "unique"), heading],
      null,
    );
    expect(out.map((r) => [r.mapId, r.pageStatus, r.pageEvidence ?? null])).toEqual([
      ["p2", "eligible", "fingerprint"],
      ["p3a", "eligible", "fingerprint"],
      ["p3b", "page_unknown", null],
      ["legacy", "eligible", null],
      ["h", "page_unknown", null],
    ]);
  });

  it("changes nothing once the URL resolved an exact page", () => {
    const rows = [row("a", "unique"), row("b", "missing")];
    expect(applySequencePageEvidence(steps("Page 2", "Page 2"), rows, "credentials")).toEqual(rows);
  });
});
