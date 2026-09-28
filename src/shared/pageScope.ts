/** Canonical page identity used by Nano-learned mappings. Query and fragment
 * data never participate in matching or persistence. */
export function canonicalPageIdentity(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return null;
    }
    return `${url.origin}${url.pathname || "/"}`;
  } catch {
    return null;
  }
}

/** A null scope means a historical/unscoped map and intentionally keeps its
 * pre-flywheel behavior. A present malformed scope fails closed. */
export function pageScopeMatches(
  scope: string | null | undefined,
  pageUrl: string | null | undefined,
): boolean {
  if (scope == null) return true;
  const canonicalScope = canonicalPageIdentity(scope);
  return canonicalScope != null && canonicalScope === canonicalPageIdentity(pageUrl);
}
