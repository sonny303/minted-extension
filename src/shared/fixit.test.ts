// TS-82 (pure half): gap routing — the panel distinguishes "no mapping" from
// "no value" so the fix-it action is always the right fix (F4.3.3).
import { describe, expect, it } from "vitest";
import type { ReportedField } from "./fill";
import {
  dataFixAction,
  groupRecordFixUrl,
  partialFillWarning,
  partitionGaps,
  providerFixPath,
  trainFlowPath,
} from "./fixit";

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
    expect(trainFlowPath("regional_enrollment", "Group Medicare PTAN")).toBe(
      "/portals/regional_enrollment/train?field=Group%20Medicare%20PTAN",
    );
    expect(trainFlowPath("regional_enrollment")).toBe("/portals/regional_enrollment/train");
  });

  it("routes a data gap to the provider record", () => {
    expect(providerFixPath("p-1")).toBe("/providers/p-1");
    expect(dataFixAction(undefined, "p-1", "https://mintedpanel.vercel.app")).toEqual({
      href: "https://mintedpanel.vercel.app/providers/p-1",
      label: "Add the data ↗",
    });
    expect(dataFixAction("/groups/not-a-uuid", null, "https://mintedpanel.vercel.app")).toBeNull();
  });

  it("links a missing group value to its exact same-origin group record", () => {
    expect(groupRecordFixUrl(
      "/groups/123e4567-e89b-12d3-a456-426614174000",
      "https://mintedpanel.vercel.app",
    )).toBe("https://mintedpanel.vercel.app/groups/123e4567-e89b-12d3-a456-426614174000");
    expect(dataFixAction(
      "/groups/123e4567-e89b-12d3-a456-426614174000",
      "p-1",
      "https://mintedpanel.vercel.app",
    )).toEqual({
      href: "https://mintedpanel.vercel.app/groups/123e4567-e89b-12d3-a456-426614174000",
      label: "Open group record ↗",
    });
  });

  it("rejects non-group, cross-origin, and normalized record paths", () => {
    for (const path of [
      "//evil.example/groups/123e4567-e89b-12d3-a456-426614174000",
      "https://evil.example/groups/123e4567-e89b-12d3-a456-426614174000",
      "/groups/../providers/p1",
      "/groups/123e4567-e89b-12d3-a456-426614174000?tab=edit",
      "/groups/123e4567-e89b-12d3-a456-426614174000#contact",
      "/providers/123e4567-e89b-12d3-a456-426614174000",
    ]) {
      expect(groupRecordFixUrl(path, "https://mintedpanel.vercel.app")).toBeNull();
    }
    expect(groupRecordFixUrl(
      "/groups/123e4567-e89b-12d3-a456-426614174000",
      "javascript:alert(1)",
    )).toBeNull();
  });

  it("warns clearly for a partial fill while preserving legacy fills without gaps", () => {
    expect(partialFillWarning([
      {
        label: "Contracting contact",
        reason: "This Contract group's contracting contact value is missing.",
        kind: "no_value",
        recordPath: "/groups/123e4567-e89b-12d3-a456-426614174000",
      },
    ], 0)).toBe(
      "Partial fill: 1 mapped field has no Minted Panel value. Review the lists above and complete them on the portal before you submit.",
    );
    expect(partialFillWarning([{ label: "Review", reason: "prefilled", kind: "review" }], 0)).toBeNull();
    expect(partialFillWarning([], 1)).toContain("1 mapped field needs review from this fill");
  });
});
