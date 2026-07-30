// E4.3 F4.3.1 / TE-1 — the platform → extension case handoff, extension side.
// The webapp's "Work in portal" sends the locked SET_ACTIVE_CASE message
// through Chrome external messaging; this module owns the PURE half of the
// receipt: message validation, the active-case record shape, expiry math, and
// portal-origin matching. Everything Chrome-flavored (listeners, storage)
// lives in src/background/activeCase.ts so this file is unit-testable.
//
// The locked TE-1 shape (panel `src/lib/extensionHandoff.ts` — panel-first,
// mirrored here; never change unilaterally):
//   { type: "SET_ACTIVE_CASE", caseId, providerId, orgId, portalUrl,
//     portalKey?, facilityId? }
// IDENTIFIERS + URL ONLY — the message never carries profile or token values,
// and parseSetActiveCase deliberately drops every unknown field so nothing
// beyond the contract can ride along into storage. The last two are the S3.5
// (doc 06 C1) additions and are OPTIONAL in both directions: an older webapp
// omits them, and a malformed one is dropped rather than rejecting the whole
// handoff — losing the location is a picker prompt, losing the case is a
// broken launch.

/** The locked SET_ACTIVE_CASE message (TE-1). Identifiers + portal URL only. */
export interface SetActiveCaseMessage {
  type: "SET_ACTIVE_CASE";
  caseId: string;
  providerId: string;
  orgId: string;
  portalUrl: string;
  // S3.5: the launched portal's registry key, and the case's location.
  portalKey?: string;
  facilityId?: string;
}

/** The SETUP handoff: "open this portal, I'm configuring it" — no case.
 *
 * Why a second message instead of loosening SET_ACTIVE_CASE: the two journeys
 * genuinely carry different things. Casework has a case, a provider and an org
 * and its whole point is to FILL. Portal setup — registering a payer portal and
 * capturing its form in the SOP editor — has none of those; it only needs the
 * form's SHAPE, which is why the panel's capture UI already gates on a
 * recognized portal alone and never on a case.
 *
 * Making caseId optional on SET_ACTIVE_CASE would have been the smaller diff and
 * the wrong one: it would let a caseless context reach the fill path, quietly
 * dissolving the locked R2 rule "case selection is REQUIRED — no case, no fill".
 * A separate message that writes NO active-case record keeps that rule true by
 * construction rather than by a check someone can forget. A setup handoff can
 * capture and cannot fill, because there is nothing for fill to read.
 *
 * Same transport and the same origin allow-list as SET_ACTIVE_CASE — one door,
 * two intents. */
export interface OpenPortalMessage {
  type: "OPEN_PORTAL";
  portalUrl: string;
  /** Registry key of the portal being set up, when the caller knows it. */
  portalKey?: string;
  /** The org whose setup this is. Advisory only — nothing is scoped by it
   * today; it exists so a future multi-org panel can pre-select. */
  orgId?: string;
}

// Web origins allowed to hand off a case. Defense in depth: the manifest's
// externally_connectable.matches already restricts who can message us, but the
// handler re-checks the sender origin against this list so a manifest edit
// can't silently widen the surface.
export const HANDOFF_ALLOWED_ORIGINS: readonly string[] = ["https://mintedpanel.vercel.app"];

export function isAllowedHandoffOrigin(origin: string | undefined | null): boolean {
  return origin != null && HANDOFF_ALLOWED_ORIGINS.includes(origin);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Strict-parse an external message into the locked shape, or null. Unknown
 * fields are DROPPED (never stored); ids must be UUIDs and portalUrl must be
 * an https URL — a malformed handoff is discarded, never "repaired". */
export function parseSetActiveCase(message: unknown): SetActiveCaseMessage | null {
  if (message == null || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.type !== "SET_ACTIVE_CASE") return null;
  if (!nonEmptyString(m.caseId) || !UUID_RE.test(m.caseId)) return null;
  if (!nonEmptyString(m.providerId) || !UUID_RE.test(m.providerId)) return null;
  if (!nonEmptyString(m.orgId) || !UUID_RE.test(m.orgId)) return null;
  if (!nonEmptyString(m.portalUrl)) return null;
  let portalUrl: URL;
  try {
    portalUrl = new URL(m.portalUrl);
  } catch {
    return null;
  }
  if (portalUrl.protocol !== "https:") return null;
  const parsed: SetActiveCaseMessage = {
    type: "SET_ACTIVE_CASE",
    caseId: m.caseId,
    providerId: m.providerId,
    orgId: m.orgId,
    portalUrl: m.portalUrl,
  };
  // S3.5 optional extras. A malformed value is DROPPED, not fatal: the launch
  // still lands on the right case and the panel falls back to asking.
  if (nonEmptyString(m.portalKey)) parsed.portalKey = m.portalKey.trim().toLowerCase();
  if (nonEmptyString(m.facilityId) && UUID_RE.test(m.facilityId)) {
    parsed.facilityId = m.facilityId;
  }
  return parsed;
}

/** Strict-parse the setup handoff, or null. Same discipline as
 * parseSetActiveCase: unknown fields are DROPPED, portalUrl must be https, and
 * a malformed optional value is dropped rather than failing the message.
 *
 * Deliberately rejects anything case-shaped: a caller that sends caseId or
 * providerId here has confused the two intents, and silently ignoring those
 * fields would produce a context that looks fillable and is not. */
export function parseOpenPortal(message: unknown): OpenPortalMessage | null {
  if (message == null || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.type !== "OPEN_PORTAL") return null;
  if (m.caseId != null || m.providerId != null) return null;
  if (!nonEmptyString(m.portalUrl)) return null;
  let portalUrl: URL;
  try {
    portalUrl = new URL(m.portalUrl);
  } catch {
    return null;
  }
  if (portalUrl.protocol !== "https:") return null;
  const parsed: OpenPortalMessage = { type: "OPEN_PORTAL", portalUrl: m.portalUrl };
  if (nonEmptyString(m.portalKey)) parsed.portalKey = m.portalKey.trim().toLowerCase();
  if (nonEmptyString(m.orgId) && UUID_RE.test(m.orgId)) parsed.orgId = m.orgId;
  return parsed;
}

/** Context expires after 60 minutes idle (TE-1) — or immediately when its
 * bound portal tab closes. */
export const ACTIVE_CASE_IDLE_MS = 60 * 60 * 1000;

// The one active-case record the worker holds (LAST LAUNCH WINS — a second
// handoff or in-panel selection replaces it, never stacks). Stored in
// chrome.storage.session: identifiers + URL only, never a profile/token value,
// so the PHI rules for session storage are untouched.
export interface ActiveCaseRecord {
  caseId: string;
  providerId: string;
  // The org the context belongs to. Handoffs always carry one; an in-panel
  // selection records the panel's resolved org id, or null in single-org mode
  // (the server resolves the sole membership — no id to record).
  orgId: string | null;
  // The portal tab the webapp is about to open (handoff only) — the worker
  // binds the next tab on this origin. null for in-panel selections until a
  // fill binds one.
  portalUrl: string | null;
  // S3.5: the launched portal's registry key and the case's location, when the
  // handoff carried them. Both nullable — an in-panel selection has neither,
  // and a case without a facility legitimately has no location.
  portalKey: string | null;
  facilityId: string | null;
  source: "handoff" | "panel";
  // The bound portal tab; closing it expires the context (TE-1).
  boundTabId: number | null;
  // Set when the bound tab closed — a HARD expiry regardless of idle time.
  tabClosedAt: string | null;
  createdAt: string;
  lastActivityAt: string;
}

export function isActiveCaseExpired(record: ActiveCaseRecord, nowMs: number): boolean {
  if (record.tabClosedAt != null) return true;
  const last = Date.parse(record.lastActivityAt);
  if (Number.isNaN(last)) return true;
  return nowMs - last > ACTIVE_CASE_IDLE_MS;
}

/** Does a tab URL live on the handed-off portal's origin? Used to bind "the
 * next tab opened to the portal origin" (TE-1). Origin match, not prefix —
 * portals redirect within their own origin during login. */
export function isPortalOriginUrl(portalUrl: string | null, tabUrl: string | undefined): boolean {
  if (!portalUrl || !tabUrl) return false;
  try {
    return new URL(tabUrl).origin === new URL(portalUrl).origin;
  } catch {
    return false;
  }
}

// What the panel needs to render the handoff state. "expired" keeps the record
// so the panel can say WHICH case expired and offer re-launch / the picker —
// it is cleared only by an explicit dismiss, a new selection, or a new launch.
export type ActiveCaseState =
  | { status: "none" }
  | { status: "active"; record: ActiveCaseRecord }
  | { status: "expired"; record: ActiveCaseRecord };

export function resolveActiveCaseState(
  record: ActiveCaseRecord | null,
  nowMs: number,
): ActiveCaseState {
  if (record == null) return { status: "none" };
  if (isActiveCaseExpired(record, nowMs)) return { status: "expired", record };
  return { status: "active", record };
}
