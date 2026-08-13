// E6.9 F6.9.7/F6.9.8 — the panel does TWO jobs, and they have different
// tenancy.
//
// Working a case is org-scoped: a provider, a case and a fill all belong to one
// organization, so every call carries `x-org-id` once a multi-org user has
// picked. Training a payer form is not: the trained form lands in the SHARED
// (`org_id IS NULL`) library that every org inherits, and it happens BEFORE any
// case for that payer exists. Making a trainer pick an org first is not just
// friction — under the org-resolving `authenticate()` guard it would scope the
// capture to that org, which is precisely the row we do not want written.
//
// So the mode is not cosmetic: it decides which guard the request lands on. The
// org header is therefore keyed by MODE, not by a list of path literals (that
// was the F6.9.8 criterion), with the pre-existing user-scoped routes named as
// a contract set rather than an inline string compare.

export type PanelMode = "train" | "case";

export const PANEL_MODES: readonly PanelMode[] = ["train", "case"];

export const PANEL_MODE_LABELS: Readonly<Record<PanelMode, string>> = {
  train: "Train forms",
  case: "Work cases",
};

/** The default job. Case work is the overwhelmingly more common one and is
 * what a `SET_ACTIVE_CASE` hand-off needs, so an unset mode must never strand
 * a hand-off in the trainer. */
export const DEFAULT_PANEL_MODE: PanelMode = "case";

export function parsePanelMode(raw: unknown): PanelMode | null {
  return raw === "train" || raw === "case" ? raw : null;
}

/**
 * Routes that are USER-scoped by contract and never carry an org header, in
 * either mode.
 *
 * `/api/me/orgs` is how a multi-org caller learns what to send as `x-org-id`
 * in the first place, so a stale or revoked stored org id must not be able to
 * brick that recovery path. `/api/me/view-prefs` follows the user across orgs.
 * `/api/shared-field-maps` is the E6.9 shared propose path — it runs on
 * `authenticateUser()` and writes `org_id IS NULL`, so an org header would be
 * meaningless there even in case mode.
 */
export const USER_SCOPED_PATHS: readonly string[] = [
  "/api/me/orgs",
  "/api/me/view-prefs",
  "/api/shared-field-maps",
];

/**
 * Should this request carry `x-org-id`?
 *
 * Training mode sends NO org header at all — including for multi-org users —
 * because nothing it touches is org-scoped. Case mode sends one whenever an org
 * has been resolved, except on the user-scoped routes above.
 *
 * `orgId == null` is the single-org case: the server resolves the sole
 * membership and no header is needed.
 */
export function shouldSendOrgHeader(
  mode: PanelMode,
  pathname: string,
  orgId: string | null,
): boolean {
  if (orgId == null) return false;
  if (mode === "train") return false;
  return !USER_SCOPED_PATHS.includes(pathname);
}

/** Capture / Send for approval is a Train-forms job only. Work cases is the
 * fill + touch workflow — showing the trainer there re-opens the dual-door
 * confusion E6.9 closed. */
export function isCaptureMode(mode: PanelMode): boolean {
  return mode === "train";
}
