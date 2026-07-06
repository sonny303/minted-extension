// The active org selection, owned by the background worker. Only MULTI-org
// users ever have one stored: a single-org user's requests carry no x-org-id
// (the server resolves their sole membership — unchanged v0 behavior), and a
// multi-org user's requests MUST carry it on every org-scoped call (omitting
// it is a loud 400 from the guard, never a guessed org).
const ACTIVE_ORG_KEY = "minted.activeOrgId";

export async function readActiveOrgId(): Promise<string | null> {
  const entry = await chrome.storage.session.get(ACTIVE_ORG_KEY);
  const value = entry[ACTIVE_ORG_KEY];
  return typeof value === "string" ? value : null;
}

export async function writeActiveOrgId(orgId: string | null): Promise<void> {
  if (orgId == null) {
    await chrome.storage.session.remove(ACTIVE_ORG_KEY);
  } else {
    await chrome.storage.session.set({ [ACTIVE_ORG_KEY]: orgId });
  }
}
