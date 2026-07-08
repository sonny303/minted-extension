// The one place extension code talks to the Minted Panel API. Every request
// carries the caller's Supabase JWT; the server's guard resolves org + role
// from it. Single-org users send no x-org-id header (the server resolves
// their sole membership); once a multi-org user has picked an org, EVERY
// call carries x-org-id — the guard 400s a multi-org caller without one.
import { API_BASE_URL } from "../shared/config";
import type {
  ApiEnvelope,
  ApiMeta,
  CaseContext,
  CaseListItem,
  PortalFieldMap,
  ProviderListItem,
  ProviderProfileResponse,
  SubmissionTouch,
  SubmissionTouchBody,
  UserOrgMembership,
} from "../shared/apiTypes";
import { AuthRequiredError, forceRefresh, getAccessToken } from "./auth";
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
  // Org discovery must work BEFORE/WITHOUT org context — it is how a multi-org
  // caller learns what to send as x-org-id — so /api/me/orgs never carries the
  // header. A stale/revoked stored org id must not brick that recovery path.
  // Match the pathname precisely (ignore any query string).
  const pathname = path.split("?")[0];
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(orgId != null && pathname !== "/api/me/orgs" ? { "x-org-id": orgId } : {}),
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
    // forceRefresh() throws AuthRequiredError when the refresh token itself is
    // dead. If the refresh SUCCEEDS but the server still 401s the retry, the
    // identity no longer authorizes this call — surface the SAME
    // sign-in-required path (AuthRequiredError), not a generic ApiError, per
    // the contract in this function's header comment.
    token = await forceRefresh();
    response = await requestOnce(path, token, init);
    if (response.status === 401) throw new AuthRequiredError();
  }

  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiError(
      response.status,
      `Minted Panel sent back something unexpected (HTTP ${response.status}). Try again in a moment.`,
    );
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

// GET /api/me/view-prefs — the user's saved detail-card field list; fields
// null = nothing saved (caller falls back to the default set). User-scoped
// like org discovery, but harmless with an x-org-id attached.
export async function getViewPrefs(): Promise<string[] | null> {
  const { data } = await apiFetch<{ fields: string[] | null }>("/api/me/view-prefs");
  return data.fields;
}

// PUT /api/me/view-prefs — save the field list (bare token keys, in order).
export async function putViewPrefs(fields: string[]): Promise<void> {
  await apiFetch("/api/me/view-prefs", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields }),
  });
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

// GET /api/cases/:id/context — the selected case's reference number(s), latest
// note, and latest touch (Epic 3d). Org-scoped like the other case routes, so
// requestOnce attaches x-org-id in multi-org mode (this pathname is NOT the
// /api/me/orgs exception). Read-only and purely informational for the panel.
export async function getCaseContext(caseId: string): Promise<CaseContext> {
  const { data } = await apiFetch<CaseContext>(
    `/api/cases/${encodeURIComponent(caseId)}/context`,
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
