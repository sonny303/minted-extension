// Portal identity — DB-DRIVEN since 2026-07-28 (S3.2, supersedes the v0
// hardcoded single-portal list). Rows come from GET /api/portals (own-org +
// global registry rows); adding a portal is a panel-side registry row, never
// an extension release.
//
// Page recognition matches the tab URL against each row's formUrl by
// origin + path prefix (query/hash ignored — enrollment forms carry volatile
// state there). Rows with no formUrl never match: a portal that hasn't named
// its form page can't be recognized, only launched into via the handoff.
import type { PortalRegistryRow } from "./apiTypes";

export interface MatchedPortal {
  key: string;
  label: string;
  formUrl: string | null;
  /** The payer this form belongs to, when the registry names one. Carried so
   * the panel can hand a finished capture straight to that payer's template
   * editor in the web app, which is where mapping actually happens (D18) —
   * naming the destination without a way to reach it is where the trainer's
   * loop was ending. Null for a registry row with no payer. */
  payerId: string | null;
  // A dry-run proved this form (S4.1 PROVEN chip).
  proven: boolean;
  verified: boolean;
}

function prefixOf(formUrl: string): string | null {
  try {
    const u = new URL(formUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

export function toMatchedPortal(row: PortalRegistryRow): MatchedPortal {
  return {
    key: row.portalKey,
    label: row.name,
    formUrl: row.formUrl,
    payerId: row.payerId,
    proven: row.provenAt != null,
    verified: row.isVerified,
  };
}

/** The registry row whose formUrl prefixes `url`, longest prefix wins (two
 * portals on one host resolve to the more specific form). null = not a
 * recognized portal page. */
export function matchPortalByUrl(
  url: string | undefined | null,
  rows: PortalRegistryRow[],
): MatchedPortal | null {
  if (!url) return null;
  let target: string;
  try {
    const u = new URL(url);
    target = `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
  let best: PortalRegistryRow | null = null;
  let bestLen = -1;
  for (const row of rows) {
    if (!row.formUrl) continue;
    const prefix = prefixOf(row.formUrl);
    if (prefix == null) continue;
    if (target.startsWith(prefix) && prefix.length > bestLen) {
      best = row;
      bestLen = prefix.length;
    }
  }
  return best ? toMatchedPortal(best) : null;
}

/** A registry row by key (the handoff names a portal_key, not a URL). */
export function portalByKey(key: string, rows: PortalRegistryRow[]): MatchedPortal | null {
  const row = rows.find((r) => r.portalKey === key);
  return row ? toMatchedPortal(row) : null;
}

/** Distinct host match patterns (`https://host/*`) for every registry row that
 * names an https form page — the origins the panel asks the user to grant so
 * capture and fill can reach ANY DB-registered portal, not just the one baked
 * into the manifest. Derived from the registry (S3.2), never hardcoded per
 * payer, so a new portal is still "a registry row, not an extension release":
 * once its origin is granted the extension can read the tab URL (recognition)
 * and inject content.js there. Non-https rows are skipped — payer portals are
 * https, and the manifest only lets us request https origins. */
export function portalOriginPatterns(rows: PortalRegistryRow[]): string[] {
  const patterns = new Set<string>();
  for (const row of rows) {
    if (!row.formUrl) continue;
    try {
      const u = new URL(row.formUrl);
      if (u.protocol === "https:") patterns.add(`https://${u.host}/*`);
    } catch {
      // A malformed formUrl names no origin to grant — skip it.
    }
  }
  return [...patterns];
}
