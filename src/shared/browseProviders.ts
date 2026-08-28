// Provider-list hygiene and display for the Workbench search: match the webapp
// roster (providers.index filters terminated), never render the same id twice
// if an API page or merge path double-emits a row, and name the groups a
// provider works under so two same-named people are distinguishable.

import type { ProviderListItem } from "./apiTypes";

/** Active (non-terminated) providers, unique by id, stable order preserved. */
export function browseableProviders(rows: readonly ProviderListItem[]): ProviderListItem[] {
  const seen = new Set<string>();
  const out: ProviderListItem[] = [];
  for (const p of rows) {
    if (p.status === "terminated") continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/** How many groups a search row names before collapsing the rest into "+N". */
export const MAX_SHOWN_GROUPS = 2;

/**
 * The group half of a search row's meta line (2026-08-19).
 *
 * Returns "" — not a placeholder — when the row carries no groups, because
 * that covers TWO different situations we must not pretend to tell apart: a
 * provider genuinely on no roster, and a panel deployed before `groups`
 * existed. Either way the honest render is to say nothing and fall back to
 * the NPI the row has always carried.
 *
 * Order comes from the server (primary first, then A→Z); this only truncates,
 * so the primary group is the one that always survives.
 */
export function providerGroupsLabel(
  provider: Pick<ProviderListItem, "groups">,
  max: number = MAX_SHOWN_GROUPS,
): string {
  const names = (provider.groups ?? []).map((g) => (g?.name ?? "").trim()).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length <= max) return names.join(" · ");
  return `${names.slice(0, max).join(" · ")} +${names.length - max}`;
}

/**
 * Does this provider match a free-text query, as a fallback filter?
 *
 * The server already filters `/api/providers?search=` over name/NPI/email, so
 * this exists only to narrow a list the panel already holds — notably the
 * group names, which the server's search does NOT cover. Matching is
 * substring, case-insensitive, and every term must hit somewhere, so
 * "ada riverbend" finds the Ada on Riverbend and not the other one.
 */
export function providerMatchesQuery(provider: ProviderListItem, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [
    provider.firstName,
    provider.lastName,
    provider.npi,
    provider.email,
    ...(provider.groups ?? []).map((g) => g?.name ?? ""),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
