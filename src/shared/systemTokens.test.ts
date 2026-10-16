import { describe, expect, it } from "vitest";
import { localIsoToday } from "./systemTokens";

describe("localIsoToday", () => {
  it("formats the local calendar date as yyyy-mm-dd with zero padding", () => {
    expect(localIsoToday(new Date(2026, 0, 5, 9, 30))).toBe("2026-01-05");
    expect(localIsoToday(new Date(2026, 9, 15, 23, 59, 59))).toBe("2026-10-15");
  });

  it("uses the local day even when UTC has already rolled over", () => {
    // 11:30 pm local on the 15th. Anywhere west of UTC the ISO instant is the
    // 16th; the signature date must still read the 15th.
    const lateLocal = new Date(2026, 9, 15, 23, 30);
    expect(localIsoToday(lateLocal)).toBe("2026-10-15");
    if (lateLocal.getTimezoneOffset() > 0) {
      expect(lateLocal.toISOString().slice(0, 10)).toBe("2026-10-16");
    }
  });
});
