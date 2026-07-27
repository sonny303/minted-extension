// The header account line. The design system pairs the forest header with a
// greeting rather than a raw email address; the name comes from the auth
// user's metadata (the same source as the panel's {{user.name}} token —
// `mintedpanel/src/server/userTokens.ts`), so a user without one degrades to
// their email instead of an empty header.
export function accountGreeting(name: string | null, email: string | null): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  if (first) return `Hi, ${first}`;
  if (email) return email;
  return "Signed in";
}
