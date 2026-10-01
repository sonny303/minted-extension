import { describe, expect, it } from "vitest";
import {
  EMPTY_TRAIN_TARGET,
  parseTrainTargetState,
  trainTargetRequestMatches,
  transitionTrainTarget,
} from "./trainTarget";

describe("Train/Test target identity", () => {
  it("invalidates requests when either exact key or current generation changes", () => {
    const first = transitionTrainTarget(EMPTY_TRAIN_TARGET, {
      portalKey: "aetna_contract",
      mappingGeneration: 3,
    }).state;
    const request = {
      portalKey: "aetna_contract",
      mappingGeneration: 3,
      targetRevision: first.revision,
    };
    expect(trainTargetRequestMatches(first, request)).toBe(true);

    const switchedKey = transitionTrainTarget(first, {
      portalKey: "aetna_enrollment",
      mappingGeneration: 3,
    }).state;
    const resetGeneration = transitionTrainTarget(first, {
      portalKey: "aetna_contract",
      mappingGeneration: 4,
    }).state;
    expect(trainTargetRequestMatches(switchedKey, request)).toBe(false);
    expect(trainTargetRequestMatches(resetGeneration, request)).toBe(false);
  });

  it("does not bump the revision when the exact target is unchanged", () => {
    const target = transitionTrainTarget(EMPTY_TRAIN_TARGET, {
      portalKey: "legacy_form",
      mappingGeneration: 1,
    }).state;
    expect(transitionTrainTarget(target, target)).toEqual({ state: target, changed: false });
  });

  it("rejects an earlier request after an A-to-B-to-A selection cycle", () => {
    const first = transitionTrainTarget(EMPTY_TRAIN_TARGET, {
      portalKey: "aetna_contract",
      mappingGeneration: 3,
    }).state;
    const originalRequest = {
      portalKey: "aetna_contract",
      mappingGeneration: 3,
      targetRevision: first.revision,
    };
    const second = transitionTrainTarget(first, {
      portalKey: "aetna_enrollment",
      mappingGeneration: 3,
    }).state;
    const third = transitionTrainTarget(second, {
      portalKey: "aetna_contract",
      mappingGeneration: 3,
    }).state;

    expect(third.portalKey).toBe(first.portalKey);
    expect(third.revision).toBeGreaterThan(first.revision);
    expect(trainTargetRequestMatches(third, originalRequest)).toBe(false);
  });

  it("restores only valid session metadata", () => {
    expect(parseTrainTargetState({ portalKey: "x", mappingGeneration: 2, revision: 8 })).toEqual({
      portalKey: "x",
      mappingGeneration: 2,
      revision: 8,
    });
    expect(parseTrainTargetState({ portalKey: "x", mappingGeneration: 0, revision: 8 })).toEqual(
      EMPTY_TRAIN_TARGET,
    );
  });
});
