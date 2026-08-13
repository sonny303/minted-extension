// Browse-list hygiene for the Workbench provider picker: match the webapp
// roster (providers.index filters terminated) and never render the same id
// twice if an API page or merge path double-emits a row.

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
