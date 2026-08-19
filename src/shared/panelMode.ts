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

export type PanelMode = "search" | "train" | "case";

// Listed in the order the panel renders them (2026-08-19): find the work,
// then do it; training is the separate, admin-only job.
export const PANEL_MODES: readonly PanelMode[] = ["search", "case", "train"];

export const PANEL_MODE_LABELS: Readonly<Record<PanelMode, string>> = {
  search: "Search",
  train: "Train forms",
  case: "Work cases",
};

/** The default job. Case work is the overwhelmingly more common one and is
 * what a `SET_ACTIVE_CASE` hand-off needs, so an unset mode must never strand
 * a hand-off in the trainer. */
export const DEFAULT_PANEL_MODE: PanelMode = "case";

export function parsePanelMode(raw: unknown): PanelMode | null {
  return raw === "search" || raw === "train" || raw === "case" ? raw : null;
}

/**
 * Train forms is ADMIN-only (2026-08-19).
 *
 * Training writes the GLOBAL shared library every organization inherits, so
 * the question "may this person train?" is not answerable per-org — and the
 * mode itself carries no org at all. The honest signal available to the panel
 * is the caller's memberships: admin anywhere ⇒ the trainer is offered.
 *
 * This is an AFFORDANCE, not the security boundary. The shared-tier routes run
 * on the panel's user-scoped guard and accept any authenticated caller today
 * (panel TD-42); if that must become a real restriction, it belongs in the
 * panel's guard, not here.
 */
export const ADMIN_ROLE = "admin";

export function canTrainForms(memberships: readonly { role: string }[]): boolean {
  return memberships.some((m) => m.role?.trim().toLowerCase() === ADMIN_ROLE);
}

/** The modes to render for this user, in PANEL_MODES order. */
export function visiblePanelModes(memberships: readonly { role: string }[]): PanelMode[] {
  const canTrain = canTrainForms(memberships);
  return PANEL_MODES.filter((mode) => mode !== "train" || canTrain);
}

/** Where a user who may not train (or whose admin role was revoked mid-session)
 * lands instead. Never leave them on a mode whose UI is hidden. */
export function fallbackModeFor(
  mode: PanelMode,
  memberships: readonly { role: string }[],
): PanelMode {
  return mode === "train" && !canTrainForms(memberships) ? DEFAULT_PANEL_MODE : mode;
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
 * because nothing it touches is org-scoped. Case AND search modes send one
 * whenever an org has been resolved, except on the user-scoped routes above:
 * search reads `/api/cases?q=` and `/api/providers?search=`, which are
 * org-scoped exactly like the case work they feed.
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

/** Search and Work cases both operate inside one organization; Train forms
 * does not. This is the ONE predicate that decides whether the org picker and
 * everything hanging off it applies. */
export function isOrgScopedMode(mode: PanelMode): boolean {
  return mode !== "train";
}
