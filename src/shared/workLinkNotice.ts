// What the panel says when a Work link ends (D5) or a new launch replaces
// the one on screen (D6). Pure, so the copy and the "is this a replacement"
// rule are tested without a DOM. Inputs are identifiers and display names
// the panel already holds; nothing here is stored.
import type { ActiveWorkEndReason, ActiveWorkState } from "./workContext";

type BlockedWork = Extract<ActiveWorkState, { status: "blocked" }>;

/** The pre-0.1.8 line, kept for "ended" and for a block with no reason. */
export const WORK_LINK_ENDED_LINE =
  "The link to the case ended (the payer tab closed or left the payer's site). Open the case in Minted Panel and click Work in portal again, or pick a case here.";

const LAUNCH_SWAP_PREFIX = "You opened another case from Minted Panel.";

// "The {payer} tab". payerLabel() falls back to "the payer", and a real name
// can start with "The", so a leading "the" is dropped rather than doubled.
function payerTabName(payer: string | null): string {
  const name = (payer ?? "").trim().replace(/^the\s+/i, "").trim();
  return name === "" ? "payer" : name;
}

/** Why the link ended, in the coordinator's words. `payer` is the selected
 * case's payer name, or null when it is unknown or not that case. */
export function workEndedLine(reason: ActiveWorkEndReason | undefined, payer: string | null): string {
  switch (reason) {
    case "tab_closed":
      return `The ${payerTabName(payer)} tab was closed. Click Work in portal again.`;
    case "left_site":
      return `The ${payerTabName(payer)} tab left the payer's site. Open the case and click Work in portal again.`;
    case "expired":
      return "This link timed out after 60 minutes. Open the case and click Work in portal again.";
    default:
      return WORK_LINK_ENDED_LINE;
  }
}

/** The case "Back to case" opens: only for a reason the panel explains, and
 * only when the ended launch was a case (a contract has no case page). */
export function workEndedCaseId(state: BlockedWork): string | null {
  if (state.reason !== "tab_closed" && state.reason !== "left_site" && state.reason !== "expired") return null;
  return state.ownerKind === "case" && state.ownerId != null ? state.ownerId : null;
}

/** The launch the panel last showed live, after reading `next`. It carries
 * through an "ended" block, which is also what a new launch writes while the
 * worker validates it, so a poll that lands mid-launch cannot hide a
 * replacement. A link that ended for a reason the panel explained carries
 * nothing: relaunching after that is not a surprise. */
export function carriedLaunchId(previous: string | null, next: ActiveWorkState): string | null {
  if (next.status === "active") return next.record.tuple.launchReceiptId;
  if (next.status === "blocked" && (next.reason == null || next.reason === "ended")) return previous;
  return null;
}

/** True when a different launch took over from the one the panel showed.
 * Never on the first launch (nothing shown before) or the same launch. */
export function isLaunchReplacement(previous: string | null, next: ActiveWorkState): boolean {
  return previous != null && next.status === "active" && next.record.tuple.launchReceiptId !== previous;
}

/** D6 copy. Falls back to "the new case" until the provider and payer names
 * are known; the state is added when known. */
export function launchSwapLine(names: { provider: string | null; payer: string | null; state: string | null }): string {
  const provider = names.provider?.trim() ?? "";
  const payer = names.payer?.trim() ?? "";
  const state = names.state?.trim() ?? "";
  if (provider === "" || payer === "") return `${LAUNCH_SWAP_PREFIX} This panel now shows the new case.`;
  return `${LAUNCH_SWAP_PREFIX} This panel now shows ${provider}, ${state === "" ? payer : `${payer} ${state}`}.`;
}
