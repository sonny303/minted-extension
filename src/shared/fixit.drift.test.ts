// S4.1 — the drift signal on the offer card, and the report-snapshot rule.
import { describe, expect, it } from "vitest";
import {
  FIELD_NOT_FOUND_REASON,
  OTHER_PAGE_REASON,
  countBrokenSelectors,
} from "./fixit";
import type { ReportedField } from "./fill";

describe("countBrokenSelectors (S4.1 drift strip)", () => {
  const broken: ReportedField = {
    label: "NPI",
    reason: FIELD_NOT_FOUND_REASON,
    mapId: "m1",
  };
  const dataGap: ReportedField = {
    label: "CAQH ID",
    reason: "no value in Minted Panel",
    mapId: "m2",
    kind: "no_value",
  };
  const otherPage: ReportedField = {
    label: "TIN",
    reason: OTHER_PAGE_REASON,
    mapId: "m3",
    kind: "other_page",
  };

  it("counts only dead selectors, not data gaps", () => {
    expect(countBrokenSelectors([broken, dataGap, broken])).toBe(2);
    expect(countBrokenSelectors([dataGap])).toBe(0);
    expect(countBrokenSelectors([])).toBe(0);
  });

  it("does not count exact other-page skips as drift (DYN-PAGE-01)", () => {
    expect(countBrokenSelectors([broken, otherPage])).toBe(1);
    expect(countBrokenSelectors([otherPage])).toBe(0);
  });

  it("classifies from the REASON, so reports predating `kind` still count", () => {
    // The content script's wording is the wire signal; a persisted report from
    // before ReportedField.kind existed must still raise the strip.
    const legacy = { label: "NPI", reason: FIELD_NOT_FOUND_REASON } as ReportedField;
    expect(countBrokenSelectors([legacy])).toBe(1);
  });

  it("matches the content script's exact wording", () => {
    // If fillEngine.ts ever rewords this, the strip silently stops firing —
    // so the literal is pinned on both sides.
    expect(FIELD_NOT_FOUND_REASON).toBe("field not found on this page");
  });
});
