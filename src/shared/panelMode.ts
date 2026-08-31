// Panel mode decides which job the user is doing and whether requests carry x-org-id.
//
// - Work cases / Search: org-scoped (multi-org users must pick an org first).
// - Train forms: org-free — trained forms go into the shared library (org_id null).
//
// Mode lives in the worker; the panel mirrors it for UI.
export type PanelMode = "search" | "train" | "case";

// Render order in the mode chooser.
export const PANEL_MODES: readonly PanelMode[] = ["search", "case", "train"];

export const PANEL_MODE_LABELS: Readonly<Record<PanelMode, string>> = {
  search: "Search",
  train: "Train forms",
  case: "Work cases",
};

/** Default mode. Case work is most common; SET_ACTIVE_CASE handoffs expect it. */
export const DEFAULT_PANEL_MODE: PanelMode = "case";

export function parsePanelMode(raw: unknown): PanelMode | null {
  return raw === "search" || raw === "train" || raw === "case" ? raw : null;
}

/** Train forms is admin-only in the UI. Shared-tier routes are user-scoped
 * on the panel today — real enforcement belongs server-side if required. */
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
