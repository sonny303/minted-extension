// The one place extension code talks to the Minted Panel API. Every request
// carries the caller's Supabase JWT; the server's guard resolves org + role
// from it. Single-org users send no x-org-id header (the server resolves
// their sole membership); once a multi-org user has picked an org, EVERY
// call carries x-org-id — the guard 400s a multi-org caller without one.
import { API_BASE_URL } from "../shared/config";
import type {
  ApiEnvelope,
  ApiMeta,
  CaseListItem,
  PortalFieldMap,
  ProviderListItem,
  ProviderProfileResponse,
  SubmissionTouch,
  SubmissionTouchBody,
  UserOrgMembership,
} from "../shared/apiTypes";
import { forceRefresh, getAccessToken } from "./auth";
import { readActiveOrgId } from "./orgState";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function requestOnce(path: string, token: string, init?: RequestInit): Promise<Response> {
  // Stored only when a multi-org user has picked; absent = no header sent.
  const orgId = await readActiveOrgId();
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(orgId != null ? { "x-org-id": orgId } : {}),
    },
  });
}

// Envelope-aware fetch with the refresh-and-retry contract: if the server
// rejects the token (401), refresh once and retry once. A second 401 means
// the refresh token itself is dead — surface as a sign-in-required error.
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T; meta: ApiMeta | null }> {
  let token = await getAccessToken();
  let response = await requestOnce(path, token, init);
  if (response.status === 401) {
    token = await forceRefresh();
    response = await requestOnce(path, token, init);
  }

  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiError(response.status, `Unexpected non-JSON response (HTTP ${response.status})`);
  }
  if (!response.ok || envelope.error != null || envelope.data == null) {
    throw new ApiError(response.status, envelope.error ?? `HTTP ${response.status}`);
  }
  return { data: envelope.data, meta: envelope.meta };
}

// User-scoped org discovery — the one route that needs no org context (it is
// how a multi-org caller learns what to send as x-org-id in the first place).
export async function listMyOrgs(): Promise<UserOrgMembership[]> {
  const { data } = await apiFetch<UserOrgMembership[]>("/api/me/orgs");
  return data;
}

export async function listProviders(): Promise<ProviderListItem[]> {
  const { data } = await apiFetch<ProviderListItem[]>(
    "/api/providers?page=1&pageSize=100&sort=last_name&order=asc",
  );
  return data;
}

export async function listCases(providerId: string): Promise<CaseListItem[]> {
  const { data } = await apiFetch<CaseListItem[]>(
    `/api/cases?providerId=${encodeURIComponent(providerId)}`,
  );
  return data;
}

export async function getPortalFieldMaps(portalKey: string): Promise<PortalFieldMap[]> {
  const { data } = await apiFetch<PortalFieldMap[]>(
    `/api/portal-field-maps?portal_key=${encodeURIComponent(portalKey)}`,
  );
  return data;
}

// PHI-dense payload (unmasked by design for form fill). Never log it.
// `facilityId` pins the facility.*/assignment.* token source; without it the
// server auto-resolves a sole facility or flags meta.needs_facility when the
// provider has several. Meta is returned so callers can read that flag.
export async function getProviderProfile(
  providerId: string,
  options: { state?: string; facilityId?: string | null } = {},
): Promise<{ profile: ProviderProfileResponse; meta: ApiMeta | null }> {
  const params = new URLSearchParams();
  if (options.state) params.set("state", options.state);
  if (options.facilityId) params.set("facilityId", options.facilityId);
  const qs = params.toString();
  const query = qs ? `?${qs}` : "";
  const { data, meta } = await apiFetch<ProviderProfileResponse>(
    `/api/providers/${encodeURIComponent(providerId)}/profile${query}`,
  );
  return { profile: data, meta };
}

export interface FillEventBody {
  id: string;
  caseId: string;
  providerId: string;
  portalKey: string;
  fillMode: "web";
  startedAt: string;
  completedAt: string;
  fieldsFilled: number;
  fieldsSkipped: unknown;
}

export async function postFillEvent(body: FillEventBody): Promise<void> {
  await apiFetch("/api/fill-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// POST /api/cases/:id/touches — the "Mark submitted" business log: one
// append-only touch on the case (never a status change). Idempotent on
// idempotency_id — a replay returns the stored touch (200) instead of
// appending (201).
export async function postSubmissionTouch(
  caseId: string,
  body: SubmissionTouchBody,
): Promise<SubmissionTouch> {
  const { data } = await apiFetch<SubmissionTouch>(
    `/api/cases/${encodeURIComponent(caseId)}/touches`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return data;
}
