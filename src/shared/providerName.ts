// The provider card's display name: "<name>, <credentials>, <specialty>".
//
// `credentials` and `specialty` are independent provider columns that often
// carry the same value (a PT whose credential and specialty both read "PT"),
// and `credentials` itself is a comma-separated list. Joining them naively
// renders "Jim Apple, PT, PT", so the parts are flattened and de-duplicated
// case-insensitively, first occurrence winning.
export function providerDisplayName(
  name: string,
  ...qualifiers: (string | null | undefined)[]
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of [name, ...qualifiers]) {
    for (const part of (raw ?? "").split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(trimmed);
    }
  }
  return parts.join(", ");
}
