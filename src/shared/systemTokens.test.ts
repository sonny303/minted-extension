import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localIsoToday } from "./systemTokens";

describe("localIsoToday", () => {
  it("formats the local calendar date as yyyy-mm-dd with zero padding", () => {
    expect(localIsoToday(new Date(2026, 0, 5, 9, 30))).toBe("2026-01-05");
    expect(localIsoToday(new Date(2026, 9, 15, 23, 59, 59))).toBe("2026-10-15");
  });

  describe("west of UTC, late evening", () => {
    // Pinned, not inherited from the CI host: in UTC the local and ISO dates
    // agree and a regression to toISOString() would pass unnoticed.
    const originalTz = process.env.TZ;
    beforeEach(() => {
      process.env.TZ = "America/Los_Angeles";
      vi.useFakeTimers();
      // 06:30Z on the 16th is 23:30 PDT on the 15th.
      vi.setSystemTime(new Date("2026-10-16T06:30:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it("uses the local day even though UTC has already rolled over", () => {
      const now = new Date();
      expect(now.toISOString().slice(0, 10)).toBe("2026-10-16");
      expect(localIsoToday(now)).toBe("2026-10-15");
      expect(localIsoToday()).toBe("2026-10-15");
    });
  });
});
