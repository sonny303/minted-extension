import { describe, expect, it } from "vitest";
import { formatDisplayDate, looksLikeIsoDate } from "./detailFields";

describe("formatDisplayDate", () => {
  it("formats date-only ISO as MM/DD/YYYY without a timezone shift", () => {
    expect(formatDisplayDate("2026-07-31")).toBe("07/31/2026");
    expect(formatDisplayDate("2026-12-31")).toBe("12/31/2026");
    expect(formatDisplayDate("2026-01-05")).toBe("01/05/2026");
  });

  it("returns empty for missing or unparseable values", () => {
    expect(formatDisplayDate("")).toBe("");
    expect(formatDisplayDate("not-a-date")).toBe("");
  });

  it("formats full timestamps as local MM/DD/YYYY", () => {
    // Fixed instant — assert pad + slash shape rather than a TZ-dependent day.
    const formatted = formatDisplayDate("2026-07-05T15:42:00.000Z");
    expect(formatted).toMatch(/^\d{2}\/\d{2}\/2026$/);
  });
});

describe("looksLikeIsoDate", () => {
  it("recognizes date and datetime ISO prefixes", () => {
    expect(looksLikeIsoDate("2026-07-31")).toBe(true);
    expect(looksLikeIsoDate("2026-07-31T12:00:00Z")).toBe(true);
    expect(looksLikeIsoDate("Jul 31, 2026")).toBe(false);
  });
});
