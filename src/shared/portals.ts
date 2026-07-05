// Portal registry, v0: exactly one portal, hardcoded. Generalizing to
// DB-driven portal configs is parked until M1 is verified on the live portal
// (field maps already carry url_pattern for that future).
export interface PortalConfig {
  key: string;
  label: string;
  // Two-letter state passed to /profile?state= so the server picks the right
  // state license.
  state: string;
  // URL prefix of the enrollment form; matches the manifest content_scripts
  // pattern and the catalog rows' url_pattern.
  urlPrefix: string;
}

export const PORTALS: PortalConfig[] = [
  {
    key: "bcbs_ks_enrollment",
    label: "BCBS KS network enrollment",
    state: "KS",
    urlPrefix: "https://provider.bcbsks.com/bcbsks-provider/facelets/allUsers/form/NetworkEnrollmentForm",
  },
];

export function matchPortal(url: string | undefined | null): PortalConfig | null {
  if (!url) return null;
  return PORTALS.find((portal) => url.startsWith(portal.urlPrefix)) ?? null;
}
