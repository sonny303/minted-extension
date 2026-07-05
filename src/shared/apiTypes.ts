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
