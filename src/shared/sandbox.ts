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

/** How the sandbox names itself wherever it is offered. */
export const SANDBOX_LABEL = "Sandbox test profile";

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
