// E4.3 F4.3.5 — Provider (Type 1) and Group (Type 2) Quick Cards: the pure
// projection from the profile endpoint's resolved tokens into the read-only
// card model, the CLOSED field catalog mirror, the saved-layout validation,
// and the <30-day expiry-badge math. No fetches, no Chrome, no clocks — the
// worker passes `today` in, so every rule here is unit-testable.
//
// The catalog is a VERBATIM mirror of the panel's server-owned allowlist
// (mintedpanel `src/lib/quickCardCatalog.ts`, TE-16) — the server enforces it
// at PUT /api/me/view-prefs (422 on any excluded key, e.g. provider.ssnLast4
// or any vault field, which are structurally ABSENT from the list); this
// mirror only keeps the picker honest so a save can't 422 on a key the server
// never allowed. Never add a key here that the panel catalog lacks.
import { labelForToken, tokenPrefix } from "./detailFields";
import type { ProfileToken, UnresolvedToken } from "./apiTypes";

/** Mirror of the panel's QUICK_CARD_FIELD_CATALOG (TE-16). Keys are bare
 * catalog token keys, camelCase `family.field` — the profile-token join is a
 * literal string match. */
export const QUICK_CARD_FIELD_CATALOG: readonly string[] = [
  // provider (Type 1 identity, credentials, demographics) — ssnLast4 excluded
  "provider.firstName",
  "provider.lastName",
  "provider.middleInitial",
  "provider.suffix",
  "provider.credentials",
  "provider.npi",
  "provider.caqhId",
  "provider.caqhLastAttestedDate",
  "provider.taxonomyCode",
  "provider.specialty",
  "provider.subSpecialty",
  "provider.deaNumber",
  "provider.deaExpirationDate",
  "provider.dateOfBirth",
  "provider.email",
  "provider.phone",
  "provider.gender",
  "provider.ethnicity",
  "provider.startDate",
  "provider.homeState",
  "provider.boardCertified",
  "provider.medicaidAttested",
  "provider.languages",
  "provider.degree",
  "provider.schoolName",
  "provider.graduationDate",
  "provider.malpracticeCarrier",
  "provider.malpracticePolicyNumber",
  "provider.malpracticeCoverageStart",
  "provider.malpracticeCoverageEnd",
  "provider.licenseNumber",
  "provider.licenseState",
  "provider.licenseIssueDate",
  "provider.licenseExpirationDate",
  // state_licenses (the ?state-selected primary license)
  "license.licenseNumber",
  "license.state",
  "license.licenseType",
  "license.issueDate",
  "license.expirationDate",
  "license.verifiedStatus",
  // provider_groups (Type 2)
  "group.name",
  "group.tin",
  "group.npiType2",
  "group.taxIdType",
  "group.websiteUrl",
  "group.billingContactName",
  "group.billingPhone",
  "group.billingEmail",
  "group.billingState",
  "group.contractingContactName",
  "group.contractingContactEmail",
  "group.credentialingContactName",
  "group.credentialingPhone",
  "group.credentialingEmail",
  "group.contractSignerName",
  "group.contractSignerEmail",
  // group_insurance_policies (malpractice)
  "groupInsurance.insurerName",
  "groupInsurance.policyNumber",
  "groupInsurance.policyStartDate",
  "groupInsurance.policyEndDate",
  "groupInsurance.insuranceType",
  // facilities (the selected practice location)
  "facility.name",
  "facility.street",
  "facility.suite",
  "facility.city",
  "facility.state",
  "facility.zip",
  "facility.phone",
  "facility.fax",
  "facility.county",
  "facility.contactName",
  "facility.appointmentPhone",
  // provider_facility_assignments (the link row of the selected facility)
  "assignment.startDate",
  "assignment.isPrimary",
  "assignment.practiceFrequency",
];

const CATALOG_SET: ReadonlySet<string> = new Set(QUICK_CARD_FIELD_CATALOG);

export function isQuickCardField(key: string): boolean {
  return CATALOG_SET.has(key);
}

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

/** F4.3.5 3.3 — the user may swap defaults and ADD UP TO 3 custom fields, so
 * a layout never exceeds default count + 3. (The server's own ceiling is 32;
 * this is the tighter product rule, enforced in the editor.) */
export const MAX_CUSTOM_FIELDS = 3;
export const MAX_LAYOUT_FIELDS = DEFAULT_QUICK_CARD_LAYOUT.length + MAX_CUSTOM_FIELDS;

/** TE-15's degrade rule: a missing or invalid stored layout falls back to the
 * default — never a broken card. Valid = non-empty array of unique
 * closed-catalog keys. Order is preserved (it IS the user's layout order). */
export function resolveLayout(stored: unknown): { fields: string[]; source: "saved" | "default" } {
  if (Array.isArray(stored) && stored.length > 0) {
    const seen = new Set<string>();
    const fields: string[] = [];
    let valid = true;
    for (const item of stored) {
      if (typeof item !== "string" || !CATALOG_SET.has(item) || seen.has(item)) {
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
      label: labelForToken(key),
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
