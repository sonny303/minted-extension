// TS-82 (pure half): gap routing — the panel distinguishes "no mapping" from
// "no value" so the fix-it action is always the right fix (F4.3.3).
import { describe, expect, it } from "vitest";
import type { ReportedField } from "./fill";
import { partitionGaps, providerFixPath, trainFlowPath } from "./fixit";

const gaps: ReportedField[] = [
  { label: "Group Medicare PTAN", reason: "not linked", kind: "no_mapping" },
  { label: "CAQH ID", reason: "empty on provider", kind: "no_value" },
  { label: "W-9 upload", reason: "file upload - attach manually", kind: "file" },
  { label: "Signature", reason: "not tracked", kind: "manual" },
  { label: "Old record", reason: "persisted before kinds existed" },
];

describe("partitionGaps", () => {
  it("routes mapping gaps, data gaps, and the rest separately", () => {
    const { mappingGaps, dataGaps, other } = partitionGaps(gaps);
    expect(mappingGaps.map((g) => g.label)).toEqual(["Group Medicare PTAN"]);
    expect(dataGaps.map((g) => g.label)).toEqual(["CAQH ID"]);
    expect(other.map((g) => g.label)).toEqual(["W-9 upload", "Signature", "Old record"]);
  });
});

describe("platform deep links (TE-4: the EXISTING flows, no extension writes)", () => {
  it("routes a mapping gap to the train flow with the field context carried", () => {
    expect(trainFlowPath("bcbs_ks_enrollment", "Group Medicare PTAN")).toBe(
      "/portals/bcbs_ks_enrollment/train?field=Group%20Medicare%20PTAN",
    );
    expect(trainFlowPath("bcbs_ks_enrollment")).toBe("/portals/bcbs_ks_enrollment/train");
  });

  it("routes a data gap to the provider record", () => {
    expect(providerFixPath("p-1")).toBe("/providers/p-1");
  });
});
