import { describe, expect, it } from "vitest";
import {
  aggregateScannedFields,
  filterShellNoise,
  mergeFillPageResults,
  mergeSelectorReports,
} from "./frameMessaging";
import { FIELD_NOT_FOUND_REASON } from "../shared/fixit";
import type { CapturedField } from "../content/captureScan";

const field = (over: Partial<CapturedField> & { label: string }): CapturedField => ({
  label: over.label,
  selector: over.selector ?? `#${over.label}`,
  fieldType: over.fieldType ?? "text",
  formSection: over.formSection ?? null,
});

describe("filterShellNoise", () => {
  it("keeps top-frame fields when no subframe has any", () => {
    const rows = filterShellNoise([
      { ...field({ label: "Search by keyword" }), frameId: 0 },
      { ...field({ label: "NPI" }), frameId: 0 },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Search by keyword", "NPI"]);
  });

  it("drops shell search fields when a subframe has form fields", () => {
    const rows = filterShellNoise([
      { ...field({ label: "Search by keyword" }), frameId: 0 },
      { ...field({ label: "Service Location Name" }), frameId: 3 },
      { ...field({ label: "City" }), frameId: 3 },
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      "Service Location Name",
      "City",
    ]);
  });
});

describe("aggregateScannedFields", () => {
  it("merges frame replies and strips frameId", () => {
    const fields = aggregateScannedFields([
      {
        frameId: 0,
        ok: true,
        data: [field({ label: "Search by keyword", selector: "#keyword" })],
      },
      {
        frameId: 2,
        ok: true,
        data: [field({ label: "Street Address 1", selector: "#addr1" })],
      },
      { frameId: 9, ok: false },
    ]);
    expect(fields).toEqual([
      field({ label: "Street Address 1", selector: "#addr1" }),
    ]);
    expect(fields[0]).not.toHaveProperty("frameId");
  });
});

describe("mergeFillPageResults", () => {
  it("lets a fill in one frame win over not-found in another", () => {
    const merged = mergeFillPageResults([
      {
        filled: [],
        skipped: [{ label: "NPI", reason: FIELD_NOT_FOUND_REASON, mapId: "m1" }],
        pageFields: 1,
      },
      {
        filled: ["NPI"],
        skipped: [],
        pageFields: 8,
      },
    ]);
    expect(merged.filled).toEqual(["NPI"]);
    expect(merged.skipped).toEqual([]);
    expect(merged.pageFields).toBe(9);
  });

  it("keeps concrete apply failures over not-found", () => {
    const merged = mergeFillPageResults([
      {
        filled: [],
        skipped: [{ label: "State", reason: FIELD_NOT_FOUND_REASON }],
        pageFields: 0,
      },
      {
        filled: [],
        skipped: [{ label: "State", reason: 'dropdown: no option matches "ZZ"' }],
        pageFields: 5,
      },
    ]);
    expect(merged.skipped).toEqual([
      { label: "State", reason: 'dropdown: no option matches "ZZ"' },
    ]);
  });
});

describe("mergeSelectorReports", () => {
  it("sums matches across frames", () => {
    expect(
      mergeSelectorReports([
        { valid: true, matches: 0, fillable: 0, radioGroup: false },
        { valid: true, matches: 1, fillable: 1, radioGroup: false },
      ]),
    ).toEqual({ valid: true, matches: 1, fillable: 1, radioGroup: false });
  });
});
