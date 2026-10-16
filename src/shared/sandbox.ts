// US-5 — the sandbox test profile.
//
// The bottleneck this removes: a normal fill needs a case, and the panel's
// 4-part case key means one case per provider x group x payer x state. Testing
// a 100+ field form therefore meant manufacturing cases, which is slow and
// leaves junk behind. The sandbox fills from a REAL provider the org has
// designated for exactly this — so the values exercise the true profile
// pipeline — while writing nothing that belongs to a case.
//
// Why a designated provider rather than a name hardcoded in the bundle: the
// panel already models this as `providers.is_test_provider`, and already
// excludes such a provider from the queue, generation and the scorecard. That
// makes it safe to fill with repeatedly, works per-org, and needs no release
// to point somewhere else.

import type { ProviderListItem } from "./apiTypes";
import type { ReportedField, ReportedFieldKind, SandboxFillSummary } from "./fill";
import { isNothingToFillRun, leftBlankLine, NOTHING_TO_FILL_HEADLINE } from "./leaveBlank";

export type { SandboxFillSummary };

/** How the sandbox names itself wherever it is offered. Coordinators call it
 * test mode; "sandbox" stays an engineering word and never shows. */
export const SANDBOX_LABEL = "Test profile";

/** G1: the meta line on the Search row. */
export const SANDBOX_ENTRY_META = "No case needed.";

/** Run test fill or Clear form was clicked with no payer form on the tab. */
export const SANDBOX_NO_FORM_NOTE = "Open the payer's form in this tab, then try again.";

/** Said when the org has designated nobody — actionable, not a dead end. */
export const SANDBOX_UNAVAILABLE_NOTE =
  "No sandbox provider yet. In Minted Panel, mark one provider as the organization's test provider to fill forms without creating a case.";

/**
 * The org's sandbox provider, or null.
 *
 * Ties are resolved by roster order rather than arbitrarily so the sandbox
 * identity is stable between panel opens — a sandbox that silently changed
 * who it fills as would make a failed test impossible to interpret.
 */
export function findSandboxProvider(
  providers: readonly ProviderListItem[],
): ProviderListItem | null {
  return providers.find((p) => p.isTestProvider === true) ?? null;
}

/** Is this the sandbox provider? Used to keep the panel's sandbox chrome and
 * the fill path in agreement about which state they are in. */
export function isSandboxProvider(
  provider: ProviderListItem | null | undefined,
): boolean {
  return provider?.isTestProvider === true;
}

/**
 * The state a sandbox fill resolves state-scoped tokens against.
 *
 * There is no case to take it from, so the provider's home state stands in.
 * Null is a legitimate answer — the profile endpoint then returns licence and
 * state tokens unresolved WITH reasons, which is the honest outcome and still
 * exercises everything else on the form.
 */
export function sandboxFillState(provider: ProviderListItem | null): string | null {
  const state = (provider?.homeState ?? "").trim();
  return state === "" ? null : state;
}

/** The test profile's name as people say it: "First Last". */
export function sandboxProfileName(provider: Pick<ProviderListItem, "firstName" | "lastName">): string {
  return [provider.firstName, provider.lastName]
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "")
    .join(" ");
}

/** G1: the Search row's title, "Test profile: First Last". */
export function sandboxEntryTitle(provider: Pick<ProviderListItem, "firstName" | "lastName">): string {
  const name = sandboxProfileName(provider);
  return name === "" ? SANDBOX_LABEL : `${SANDBOX_LABEL}: ${name}`;
}

/**
 * Fields a test fill wrote on this page.
 *
 * Not `summary.filled`: on a v2 run that counts values read back and checked,
 * and the engine never reads values back, so it is 0 on every run. The write
 * count is the setter attempts minus the writes the portal rejected (those
 * lose their green outline and land in the not-checked list). An older
 * worker that sends no attempt count falls back to `filled`.
 */
export function sandboxFilledCount(
  summary: Pick<SandboxFillSummary, "filled" | "fieldsAttempted" | "fieldsRejected">,
): number {
  if (typeof summary.fieldsAttempted !== "number") return summary.filled;
  return Math.max(0, summary.fieldsAttempted - (summary.fieldsRejected ?? 0));
}

// The same "needs a person" set a real fill lists (missing data, uploads,
// fields marked for a human). Drift, other pages and hidden controls are
// engineering detail and stay out of the result.
const NEEDS_YOU_KINDS: ReadonlySet<ReportedFieldKind> = new Set<ReportedFieldKind>([
  "no_value",
  "file",
  "manual",
  "review",
]);

function needsYouCount(manual: readonly ReportedField[]): number {
  return manual.filter((field) => field.kind != null && NEEDS_YOU_KINDS.has(field.kind)).length;
}

/** G4: what a finished test fill says. Counts only: no labels, no
 * selectors, no values. */
export interface SandboxFillView {
  filled: number;
  /** Green when Minted wrote a field, red when it wrote none, neutral when
   * there was nothing to write because every map was left blank on purpose. */
  tone: "ok" | "danger" | "neutral";
  /** Headline first, then one plain line. */
  lines: [string, string];
  /** Neutral lines about fields Minted did not fill. Empty when none. */
  skipLines: string[];
  /** Set when Minted Panel did not save a record of the test fill. */
  recordLine: string | null;
}

export function sandboxFillView(
  summary: Pick<
    SandboxFillSummary,
    "filled" | "fieldsAttempted" | "fieldsRejected" | "skipped" | "manual" | "leftBlank" | "logError"
  >,
): SandboxFillView {
  const filled = sandboxFilledCount(summary);
  const leftBlank = leftBlankLine(summary.leftBlank);
  // Every map left blank on purpose: the right answer, not a failure.
  const nothingToFill = isNothingToFillRun({ ...summary, filled });
  const lines: [string, string] = filled > 0
    ? [
        `Filled ${filled} ${filled === 1 ? "field" : "fields"} on this page.`,
        "Green outline on the page = filled by Minted.",
      ]
    : nothingToFill
      ? [NOTHING_TO_FILL_HEADLINE, `${leftBlank}.`]
      : [
          "Nothing was filled on this page.",
          "Minted couldn't find this page's trained fields. The portal may have changed.",
        ];
  const skipLines: string[] = [];
  const skipped = summary.skipped.length;
  if (skipped > 0) {
    skipLines.push(
      skipped === 1
        ? "1 field on this page was skipped."
        : `${skipped} fields on this page were skipped.`,
    );
  }
  const needs = needsYouCount(summary.manual);
  if (needs > 0) {
    skipLines.push(
      needs === 1
        ? "1 field on this form needs you: not on file, or filled by hand."
        : `${needs} fields on this form need you: not on file, or filled by hand.`,
    );
  }
  // Reviewed "leave blank" maps: a muted count, never a needs-you line
  // (already the headline's second line when nothing was there to fill).
  if (leftBlank && !nothingToFill) skipLines.push(`${leftBlank}.`);
  return {
    filled,
    tone: filled > 0 ? "ok" : nothingToFill ? "neutral" : "danger",
    lines,
    skipLines,
    recordLine: summary.logError != null
      ? "Minted Panel didn't save a record of this test fill. You can keep testing."
      : null,
  };
}

/** G5: what Clear form says. It reports what it actually changed, so an
 * already-empty form never reads as a fake success. */
export function sandboxClearView(cleared: number): { tone: "ok" | "neutral"; text: string } {
  if (cleared <= 0) return { tone: "neutral", text: "Nothing to clear." };
  return {
    tone: "ok",
    text: `Cleared ${cleared} ${cleared === 1 ? "field" : "fields"}. Ready to test again.`,
  };
}
