// Case-context card helpers (pure logic — no fetches, no DOM).
//
// Two separate decisions:
// 1. Does the context card have anything to show? (notes, tasks, pipeline, etc.)
// 2. Should the case's own facility be adopted into the location picker?
//
// A case can have a facility worth adopting even when the card stays hidden
// (e.g. a new case with no notes yet). Never gate adoption on card visibility.
import type { CaseContext } from "./apiTypes";

/** True when the read-only context card has rows to render.
 * Excludes selectedFacility — that drives location adoption, not card content. */
export function caseContextHasContent(context: CaseContext | null): boolean {
  if (context == null) return false;
  const refs = context.referenceNumbers ?? [];
  const tasks = context.openTasks ?? [];
  return (
    refs.length > 0 ||
    context.latestNote != null ||
    context.latestTouch != null ||
    tasks.length > 0 ||
    context.payerPipelineState != null
  );
}

export interface CaseFacilitySelectionInput {
  /** The case's own explicit facility relationship (context.selectedFacility),
   * server-resolved — never a guess. Absent/null both mean "no case-selected
   * facility." */
  selectedFacility: { id: string } | null | undefined;
  /** The provider's currently-loaded facility set — the case's pick only
   * applies when it's actually a member (a case reassigned since the
   * provider's facility set was last fetched should not force a phantom
   * selection). */
  facilityIds: readonly string[];
  /** True for a FRESH case selection (search/NBA/handoff/dropdown pick) —
   * a fresh pick should land on that case's own site even over a remembered
   * location from a different case on the same provider. False once that
   * one-time preference has already been consumed. */
  preferCaseFacility: boolean;
  /** The facility currently selected in the picker, if any. */
  currentFacilityId: string | null;
}

export type CaseFacilitySelectionResult =
  // Nothing to apply — the case carries no facility, or it isn't (yet) a
  // member of the provider's loaded set. The caller still clears its one-time
  // preferCaseFacility flag on EVERY result (apply or not) — a stale
  // preference must never linger to fire later against an unrelated
  // facilities load.
  | { apply: false }
  // Apply this facility id. `alreadyCurrent` distinguishes "already selected,
  // but re-resolve its cards anyway" (the profile read that first surfaced
  // needs_facility never resolved facility.*/assignment.* for it) from a real
  // change (which also needs the worker's remembered-pick write + full
  // re-render, not just a card refresh).
  | { apply: true; facilityId: string; alreadyCurrent: boolean };

/** The pure decision behind maybeApplyCaseFacility: given the case's own
 * facility, the provider's known facility set, and the current pick, should
 * the case's location become (or stay, but get its cards re-resolved as) the
 * selection? Never invoked before the caller confirms the context AND the
 * facility list are both loaded — that ordering guard stays with the caller,
 * since it depends on two independent async loads, not on this pure shape. */
export function resolveCaseFacilitySelection(
  input: CaseFacilitySelectionInput,
): CaseFacilitySelectionResult {
  const facility = input.selectedFacility ?? null;
  if (facility == null || !input.facilityIds.includes(facility.id)) {
    return { apply: false };
  }
  const shouldApply =
    input.preferCaseFacility || input.currentFacilityId == null;
  if (!shouldApply) return { apply: false };
  return {
    apply: true,
    facilityId: facility.id,
    alreadyCurrent: input.currentFacilityId === facility.id,
  };
}

// Which facilities populate #facility-select.
export interface FacilityPickerOption {
  id: string;
  name: string;
}

/** Scope the location picker to the case's facilities when the case has any.
 * Falls back to the provider's full facility list when the case has none,
 * or when none of the case's facilities are still on the provider's roster. */
export function facilityPickerScope<
  T extends FacilityPickerOption,
  P extends FacilityPickerOption,
>(caseFacilities: readonly T[] | undefined, providerFacilities: readonly P[]): readonly (T | P)[] {
  if (caseFacilities != null && caseFacilities.length > 0) {
    const providerIds = new Set(providerFacilities.map((f) => f.id));
    const scoped = caseFacilities.filter((f) => providerIds.has(f.id));
    if (scoped.length > 0) return scoped;
  }
  return providerFacilities;
}

// Two-line address format for the location picker and case-location list.
export interface FacilityAddressLike {
  street?: string | null;
  suite?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export function facilityAddressLines(
  f: FacilityAddressLike | null | undefined,
): string[] {
  const street = [f?.street, f?.suite].filter(Boolean).join(", ");
  const locality = [f?.city, [f?.state, f?.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return [street, locality].filter(Boolean);
}
