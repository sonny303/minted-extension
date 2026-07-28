// E4.3 F4.3.5 — Provider (Type 1) and Group (Type 2) Quick Cards: the pure
// projection from the profile endpoint's resolved tokens into the read-only
// card model, the saved-layout validation, and the <30-day expiry-badge math.
// No fetches, no Chrome, no clocks — the worker passes `today` in, so every
// rule here is unit-testable.
//
// THE CATALOG IS SERVED, NOT MIRRORED (2026-07-28, supersedes the verbatim
// allowlist this file used to carry). GET /api/me/view-prefs now returns
// `{ fields, catalog }` — the catalog is derived server-side from the SAME
// get_sop_field_tokens() the profile endpoint resolves values from, so the
// picker can never offer a field the fill wouldn't resolve, and a new panel
// field reaches the picker with no extension release. The server enforces
// membership at PUT (422 on any non-catalog key); `resolveLayout` here only
// keeps the panel honest between fetches. provider.ssnLast4 is a legitimate
// catalog field as of 2026-07-28 (product decision); the FULL SSN remains
// structurally unreachable — it lives in the panel's vault, which the token
// catalog does not sweep, so no key can name it.
import { labelForToken, tokenPrefix } from "./detailFields";
import type { ProfileToken, UnresolvedToken } from "./apiTypes";

// The default ID-grid layout (PM decision 2026-07-17, §5 Q1: the Type 1 slot
// the spec called "Medicare ID" ships as the primary License # now — no
// medicare_id schema exists until R10's enrollment-identifier model; Medicaid
// PTAN joins the catalog then too). Type 2 defaults: group NPI + TIN.
export const DEFAULT_QUICK_CARD_LAYOUT: readonly string[] = [
  "provider.npi",
  "provider.caqhId",
  "license.licenseNumber",
  "group.npiType2",
  "group.tin",
];

// The old "defaults + up to 3 custom" cap is GONE (S2.1): the picker groups
// by section, so layout length stopped being a usability problem, and the
// served catalog's closed key set already bounds what a layout can contain.

/** TE-15's degrade rule: a missing or invalid stored layout falls back to the
 * default — never a broken card. Valid = non-empty array of unique string
 * keys, each in the SERVED catalog when one is available. `allowedKeys` null/
 * empty means the catalog fetch failed or the server predates it — then only
 * the shape is validated: the stored keys were server-validated at PUT time,
 * and nuking a saved layout because one read failed would be the worse bug.
 * Order is preserved (it IS the user's layout order). */
export function resolveLayout(
  stored: unknown,
  allowedKeys?: ReadonlySet<string> | null,
): { fields: string[]; source: "saved" | "default" } {
  const checkMembership = allowedKeys != null && allowedKeys.size > 0;
  if (Array.isArray(stored) && stored.length > 0) {
    const seen = new Set<string>();
    const fields: string[] = [];
    let valid = true;
    for (const item of stored) {
      if (
        typeof item !== "string" ||
        item === "" ||
        seen.has(item) ||
        (checkMembership && !allowedKeys.has(item))
      ) {
        valid = false;
        break;
      }
      seen.add(item);
      fields.push(item);
    }
    if (valid) return { fields, source: "saved" };
  }
  return { fields: [...DEFAULT_QUICK_CARD_LAYOUT], source: "default" };
}

// ---------- expiry badges ----------

export const EXPIRY_WARNING_DAYS = 30;

/** "ok" | "expiring" (< 30 days out) | "expired" (before today) | null when
 * there is no parseable date to judge. Date-only comparison via UTC midnights
 * — no TZ drift. `today` is an ISO date string passed in by the caller. */
export type ExpiryStatus = "ok" | "expiring" | "expired";

export function expiryStatus(dateIso: string | null, today: string): ExpiryStatus | null {
  if (!dateIso) return null;
  const m = dateIso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const t = today.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m || !t) return null;
  const date = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]));
  const days = (date - now) / 86_400_000;
  if (days < 0) return "expired";
  if (days < EXPIRY_WARNING_DAYS) return "expiring";
  return "ok";
}

// ---------- card projection ----------

// One rendered card field: resolved value, or an honest empty — `reason` is
// the profile's unresolved reason when the server gave one, else null (the
// panel renders a muted em-dash). Values are display strings; the panel holds
// them in memory only (TE-14 — never chrome.storage/IndexedDB/logs).
export interface QuickCardField {
  key: string;
  label: string;
  value: string | null;
  reason: string | null;
}

export interface QuickCardLicense {
  state: QuickCardField;
  number: QuickCardField;
  expiration: QuickCardField;
  expiry: ExpiryStatus | null;
}

export interface QuickCardMalpractice {
  insurer: QuickCardField;
  policyNumber: QuickCardField;
  expiration: QuickCardField;
  expiry: ExpiryStatus | null;
}

export interface QuickCards {
  // Type 1 header: full name + DOB (bold, compact).
  name: string;
  credentials: string | null;
  dateOfBirth: string | null;
  // The layout-driven ID grid, split per card by token family.
  type1Fields: QuickCardField[];
  type2Fields: QuickCardField[];
  // Fixed structural rows (always rendered, honest when empty).
  license: QuickCardLicense;
  groupName: string | null;
  malpractice: QuickCardMalpractice;
  // The layout the grid reflects, and where it came from (TS-102).
  layout: string[];
  layoutSource: "saved" | "default";
}

// Type 2 = group-family tokens; everything else renders on the Type 1 card.
const TYPE2_PREFIXES = new Set(["group", "groupInsurance"]);

export function isType2Field(key: string): boolean {
  return TYPE2_PREFIXES.has(tokenPrefix(key));
}

// License fields fall back to the legacy provider.* license columns when the
// state_licenses-backed license.* token is empty (the existing card rule).
const LEGACY_FALLBACKS: Record<string, string> = {
  "license.licenseNumber": "provider.licenseNumber",
  "license.state": "provider.licenseState",
  "license.issueDate": "provider.licenseIssueDate",
  "license.expirationDate": "provider.licenseExpirationDate",
};

function asDisplay(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** Project the profile's tokens into the full quick-card model. Every field is
 * accounted for: value, or unresolved reason, or a plain empty — the F4.3.2
 * per-field discipline applied to cards (nothing silently dropped). */
export function projectQuickCards(
  tokens: ProfileToken[],
  unresolved: UnresolvedToken[],
  layout: { fields: string[]; source: "saved" | "default" },
  today: string,
  // Served catalog labels (key -> label). Preferred over the local
  // labelForToken derivation so the panel and the webapp agree on wording;
  // absent/missing keys fall back to the local rule.
  labels?: ReadonlyMap<string, string>,
): QuickCards {
  const values = new Map<string, unknown>(tokens.map((t) => [t.token, t.value]));
  const reasons = new Map<string, string>(unresolved.map((u) => [u.token, u.reason]));

  const field = (key: string): QuickCardField => {
    let value = asDisplay(values.get(key));
    if (value == null) {
      const fallback = LEGACY_FALLBACKS[key];
      if (fallback != null) value = asDisplay(values.get(fallback));
    }
    return {
      key,
      label: labels?.get(key) ?? labelForToken(key),
      value,
      reason: value == null ? (reasons.get(key) ?? null) : null,
    };
  };

  const type1Fields: QuickCardField[] = [];
  const type2Fields: QuickCardField[] = [];
  for (const key of layout.fields) {
    (isType2Field(key) ? type2Fields : type1Fields).push(field(key));
  }

  const licenseExpiration = field("license.expirationDate");
  const malpracticeExpiration = field("groupInsurance.policyEndDate");
  const name = [asDisplay(values.get("provider.firstName")), asDisplay(values.get("provider.lastName"))]
    .filter(Boolean)
    .join(" ");

  return {
    name,
    credentials: asDisplay(values.get("provider.credentials")),
    dateOfBirth: asDisplay(values.get("provider.dateOfBirth")),
    type1Fields,
    type2Fields,
    license: {
      state: field("license.state"),
      number: field("license.licenseNumber"),
      expiration: licenseExpiration,
      expiry: expiryStatus(licenseExpiration.value, today),
    },
    groupName: asDisplay(values.get("group.name")),
    malpractice: {
      insurer: field("groupInsurance.insurerName"),
      policyNumber: field("groupInsurance.policyNumber"),
      expiration: malpracticeExpiration,
      expiry: expiryStatus(malpracticeExpiration.value, today),
    },
    layout: layout.fields,
    layoutSource: layout.source,
  };
}

/** The 1-to-many escape hatch (F4.3.5 3.4, PM Q3): "Open in Minted Panel ↗" →
 * the provider's webapp page, ALWAYS a new tab so the portal session is
 * preserved. Provider id only — never PHI in the URL (TE-13). */
export function providerWebappPath(providerId: string): string {
  return `/providers/${encodeURIComponent(providerId)}`;
}
