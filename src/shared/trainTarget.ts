/** Exact Train/Test configuration identity shared by the panel and worker. */
export interface TrainTargetIdentity {
  portalKey: string | null;
  mappingGeneration: number | null;
}

export interface TrainTargetState extends TrainTargetIdentity {
  /** Changes on every key or generation switch and invalidates older requests. */
  revision: number;
}

export interface VersionedTrainTarget extends TrainTargetIdentity {
  targetRevision: number;
}

export const EMPTY_TRAIN_TARGET: TrainTargetState = {
  portalKey: null,
  mappingGeneration: null,
  revision: 0,
};

export function sameTrainTarget(a: TrainTargetIdentity, b: TrainTargetIdentity): boolean {
  return a.portalKey === b.portalKey && a.mappingGeneration === b.mappingGeneration;
}

/**
 * A selection switch is one revision step, even when only the map generation
 * changed. Callers clear capture state in the same storage write as this state.
 */
export function transitionTrainTarget(
  current: TrainTargetState,
  requested: TrainTargetIdentity,
): { state: TrainTargetState; changed: boolean } {
  if (sameTrainTarget(current, requested)) return { state: current, changed: false };
  return {
    state: {
      portalKey: requested.portalKey,
      mappingGeneration: requested.mappingGeneration,
      revision: current.revision + 1,
    },
    changed: true,
  };
}

/** Stored data is untrusted across worker restarts and extension upgrades. */
export function parseTrainTargetState(raw: unknown): TrainTargetState {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_TRAIN_TARGET;
  const value = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(value.revision) || typeof value.revision !== "number" || value.revision < 0) {
    return EMPTY_TRAIN_TARGET;
  }
  if (value.portalKey === null && value.mappingGeneration === null) {
    return { portalKey: null, mappingGeneration: null, revision: value.revision };
  }
  if (
    typeof value.portalKey === "string" && value.portalKey.trim() !== "" &&
    Number.isSafeInteger(value.mappingGeneration) &&
    typeof value.mappingGeneration === "number" && value.mappingGeneration > 0
  ) {
    return {
      portalKey: value.portalKey,
      mappingGeneration: value.mappingGeneration,
      revision: value.revision,
    };
  }
  return EMPTY_TRAIN_TARGET;
}

export function trainTargetRequestMatches(
  state: TrainTargetState,
  request: VersionedTrainTarget,
): boolean {
  return state.revision === request.targetRevision &&
    sameTrainTarget(state, request) &&
    request.portalKey != null &&
    request.mappingGeneration != null;
}
