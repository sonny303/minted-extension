import { describe, expect, it } from "vitest";
import {
  buildFillEventV2Metadata,
  createFillEventV2OpaqueKey,
  FILL_EVENT_V2_LIMIT_ERROR,
  isFillEventV2Advertised,
  isFillEventV2FieldOutcome,
  type FillEventV2FieldOutcome,
} from "./fillEventV2";

const mapId = "4f0d6e10-4f6f-4a7d-8d80-5a3a16ea4e73";

function outcome(over: Partial<FillEventV2FieldOutcome> = {}): FillEventV2FieldOutcome {
  return {
    mapId,
    targetKey: createFillEventV2OpaqueKey("t"),
    frameKey: createFillEventV2OpaqueKey("f"),
    stepKey: createFillEventV2OpaqueKey("s"),
    attempted: true,
    outcome: "unverified",
    reasonCode: "readback_unavailable",
    ...over,
  };
}

describe("fill-event V2 contract", () => {
  it("requires explicit schema-v2 advertisement and otherwise keeps V1", () => {
    expect(isFillEventV2Advertised(null)).toBe(false);
    expect(isFillEventV2Advertised({})).toBe(false);
    expect(isFillEventV2Advertised({ fill_event_schema_version: 1 })).toBe(false);
    expect(isFillEventV2Advertised({ fill_event_schema_version: 2 })).toBe(true);
  });

  it("reconciles counters and emits only value-free opaque outcomes", () => {
    const attempted = outcome();
    const missing = outcome({
      targetKey: createFillEventV2OpaqueKey("t"),
      attempted: false,
      outcome: "not_found",
      reasonCode: "target_missing",
      notFoundEvidence: {
        stepKnown: true,
        frameAccessible: true,
        pageSettled: true,
        searchComplete: true,
        targetAbsent: true,
      },
    });
    const metadata = buildFillEventV2Metadata([attempted, missing]);
    expect(metadata).toMatchObject({
      schemaVersion: 2,
      fieldsAttempted: 1,
      fieldsVerified: 0,
      fieldsRejected: 0,
    });
    expect(isFillEventV2FieldOutcome(missing)).toBe(true);
    expect(JSON.stringify(metadata)).not.toMatch(/label|selector|value|url/i);
  });

  it("rejects unqualified not-found outcomes and duplicate identities", () => {
    const missing = outcome({
      attempted: false,
      outcome: "not_found",
      reasonCode: "target_missing",
    });
    expect(isFillEventV2FieldOutcome(missing)).toBe(false);
    const repeated = outcome({ targetKey: "t_4f0d6e10-4f6f-4a7d-8d80-5a3a16ea4e73" });
    expect(() => buildFillEventV2Metadata([repeated, repeated])).toThrow(/validation/i);
    const caseVariant = {
      ...repeated,
      mapId: repeated.mapId?.toUpperCase() ?? null,
      targetKey: repeated.targetKey.toUpperCase(),
      frameKey: repeated.frameKey?.toUpperCase() ?? null,
    };
    expect(isFillEventV2FieldOutcome(caseVariant)).toBe(true);
    expect(() => buildFillEventV2Metadata([repeated, caseVariant])).toThrow(/validation/i);
  });

  it("fails clearly instead of truncating above 250 outcomes", () => {
    const outcomes = Array.from({ length: 251 }, () => outcome({ targetKey: createFillEventV2OpaqueKey("t") }));
    expect(() => buildFillEventV2Metadata(outcomes)).toThrow(FILL_EVENT_V2_LIMIT_ERROR);
  });
});
