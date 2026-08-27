// Pure logic for the case-context card (E4.3 TE-2). No fetches, no DOM — the
// side panel (src/sidepanel/main.ts) owns the render and the network call;
// this file owns the two decisions that were bug-prone when they lived inline
// in renderCaseContext/maybeApplyCaseFacility (B1.2):
//
//   1. Whether the context card has anything worth SHOWING.
//   2. Whether the case's own location should be ADOPTED as the facility pick.
//
// These are deliberately two separate questions. A case with only a
// selectedFacility and nothing else (no note/touch/tasks/pipeline/refs) has
// NOTHING to show — the card should stay hidden — but its location should
// still be adopted; adoption must never be gated on visibility. Coupling the
// two (checking "hasContent" before applying the facility) was exactly the
// B1.2 bug: a freshly generated case with no activity yet never adopted its
// own selectedFacility, and PRACTICE LOCATION / FACILITY ASSIGNMENT / STATE
// LICENSE stayed "Not on file" even though the case named a location.
import type { CaseContext } from "./apiTypes";

/** Does this context carry anything the read-only card would actually render?
 * Mirrors the fields renderCaseContext lays out below the identity guard —
 * deliberately EXCLUDES selectedFacility, which drives location adoption
 * (see resolveCaseFacilitySelection below) but is not itself a rendered row.
 * `caseContextBox.hidden` must track this exactly: only whether the box has
 * anything to show, never whether a location got applied. */
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
