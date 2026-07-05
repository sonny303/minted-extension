// Mirrors the Minted Panel /api contract (src/server/envelope.ts and the
// provider list projection in src/services/providers.ts over there). Every
// response is `{ data, error, meta }`; rows come back camelCased.

export interface ApiMeta {
  total?: number;
  page?: number;
  pageSize?: number;
}

export interface ApiEnvelope<T> {
  data: T | null;
  error: string | null;
  meta: ApiMeta | null;
}

export type ProviderStatus = "onboarding" | "active" | "terminated";

export type PortalFieldMapSource = "token" | "manual" | "manual_partial" | "hardcoded";
export type PortalFieldMapStatus = "proposed" | "approved" | "retired";
export type FillMode = "web" | "pdf";
export type PortalFieldType = "text" | "select" | "radio" | "checkbox" | "date" | "file";

// GET /api/portal-field-maps — shared catalog: orgId null rows are global
// portal truths, orgId rows are the caller's org overrides.
export interface PortalFieldMap {
  id: string;
  orgId: string | null;
  portalKey: string;
  urlPattern: string | null;
  pageStep: string | null;
  mapType: FillMode;
  selector: string;
  selectorFallbacks: string[] | null;
  source: PortalFieldMapSource;
  token: string | null;
  hardcodedValue: string | null;
  transform: string | null;
  fieldType: PortalFieldType;
  notes: string | null;
  status: PortalFieldMapStatus;
  createdAt: string;
  updatedAt: string;
}

// GET /api/providers/:id/profile?state=XX — every catalog token resolved to a
// value server-side; unresolved tokens come back null with a reason. The
// provider row itself is PHI-dense and unused by the fill engine, so it stays
// untyped here.
export interface ProfileToken {
  token: string;
  value: unknown;
}

export interface UnresolvedToken {
  token: string;
  reason: string;
}

export interface ProviderProfileResponse {
  provider: { id: string } & Record<string, unknown>;
  tokens: ProfileToken[];
  unresolved: UnresolvedToken[];
}

// GET /api/cases?providerId=... — the case picker feed (minimal route the
// extension pulls; see the README's backend-dependency note).
export interface CaseListItem {
  id: string;
  payerId: string | null;
  payerName: string | null;
  state: string | null;
  statusLabel: string | null;
  submittedDate: string | null;
}

// GET /api/providers returns the PHI-safe list projection — no SSN, DOB, or
// home address columns exist in this shape by construction.
export interface ProviderListItem {
  id: string;
  firstName: string;
  lastName: string;
  credentials: string | null;
  npi: string | null;
  homeState: string | null;
  caqhId: string | null;
  caqhLastAttestedDate: string | null;
  taxonomyCode: string | null;
  status: ProviderStatus;
  groupId: string | null;
  specialty: string | null;
  email: string | null;
  updatedAt: string;
}
