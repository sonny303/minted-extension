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
  caseType: PortalRegistryRow["caseType"];
  /** Normalized current generation; old rows with NULL metadata are gen 1. */
  mappingGeneration: number;
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

export function toMatchedPortal(row: PortalRegistryRow): MatchedPortal {
  const generation = row.mappingGeneration;
  return {
    key: row.portalKey,
    label: row.name,
    formUrl: row.formUrl,
    caseType: row.caseType ?? null,
    mappingGeneration:
      Number.isSafeInteger(generation) && typeof generation === "number" && generation > 0
        ? generation
        : 1,
    payerId: row.payerId,
    proven: row.provenAt != null,
    verified: row.isVerified,
  };
}

function matchesFormUrl(url: URL, formUrl: string): boolean {
  try {
    const registered = new URL(formUrl);
    if (url.origin !== registered.origin) return false;
    const prefix = registered.pathname;
    if (prefix.endsWith("/")) return url.pathname.startsWith(prefix);
    return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
  } catch {
    return false;
  }
}

/** Every registered configuration whose own origin/path rules permit this
 * page. Results are specificity ordered for display only; identity must come
 * from an exact selected key when more than one candidate remains. */
export function portalCandidatesByUrl(
  url: string | undefined | null,
  rows: readonly PortalRegistryRow[],
): MatchedPortal[] {
  if (!url) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  return rows
    .filter((row) => row.formUrl != null && matchesFormUrl(parsed, row.formUrl))
    .map(toMatchedPortal)
    .sort((a, b) => {
      const aPath = (() => { try { return new URL(a.formUrl ?? "").pathname.length; } catch { return -1; } })();
      const bPath = (() => { try { return new URL(b.formUrl ?? "").pathname.length; } catch { return -1; } })();
      return bPath - aPath || a.key.localeCompare(b.key);
    });
}

/** The most-specific candidates. Equal-specificity rows are intentionally
 * preserved so Train/Test can ask the operator instead of choosing by order. */
export function bestPortalCandidatesByUrl(
  url: string | undefined | null,
  rows: readonly PortalRegistryRow[],
): MatchedPortal[] {
  const candidates = portalCandidatesByUrl(url, rows);
  if (candidates.length < 2) return candidates;
  const bestPathLength = candidates[0]?.formUrl
    ? new URL(candidates[0].formUrl).pathname.length
    : -1;
  return candidates.filter((candidate) => {
    try {
      return new URL(candidate.formUrl ?? "").pathname.length === bestPathLength;
    } catch {
      return false;
    }
  });
}

/** Whether this exact configuration's origin/path rules permit the page,
 * independent of any sibling's URL specificity or registry ordering. */
export function portalKeyEligibleForUrl(
  portalKey: string,
  url: string | undefined | null,
  rows: readonly PortalRegistryRow[],
): boolean {
  return portalCandidatesByUrl(url, rows).some((candidate) => candidate.key === portalKey);
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
    const parsed = new URL(url);
    target = `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
  let best: PortalRegistryRow | null = null;
  let bestLength = -1;
  for (const row of rows) {
    if (!row.formUrl) continue;
    try {
      const parsed = new URL(row.formUrl);
      const prefix = `${parsed.origin}${parsed.pathname}`;
      if (target.startsWith(prefix) && prefix.length > bestLength) {
        best = row;
        bestLength = prefix.length;
      }
    } catch {
      // A malformed registry URL does not match this page.
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
