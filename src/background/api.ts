// The one place extension code talks to the Minted Panel API. Every request
// carries the caller's Supabase JWT; the server's guard resolves org + role
// from it. Single-org users send no x-org-id header (the server resolves
// their sole membership); once a multi-org user has picked an org, EVERY
// call carries x-org-id — the guard 400s a multi-org caller without one.
import { API_BASE_URL } from "../shared/config";
import type {
  ApiEnvelope,
  ApiMeta,
  AuthorizedContractProfileSelectors,
  BatchLearnPortalFieldMapsRequest,
  BatchLearnPortalFieldMapsResponse,
  CaseContext,
  CaseListItem,
  CaseSearchRow,
  CaseTouchBody,
  NextBestActionResult,
  PortalFieldMap,
  ProviderListItem,
  ProviderProfileResponse,
  SubmissionTouch,
  UserOrgMembership,
  PortalRegistryRow,
  QuickCardCatalogField,
  ViewPrefsResponse,
  StatusBumpMeta,
} from "../shared/apiTypes";
import { AuthRequiredError, forceRefresh, getAccessToken } from "./auth";
import { readActiveOrgId } from "./orgState";
import { readPanelMode } from "./mode";
import { shouldSendOrgHeader } from "../shared/panelMode";
import type { ReportedField } from "../shared/fill";
import { isFillEventV2Advertised, type FillEventV2Metadata } from "../shared/fillEventV2";
import {
  parseWorkContextValidationResponse,
  workTuplesEqual,
  type WorkContextTuple,
  type CanonicalWorkContextTuple,
  type WorkContextValidationResponse,
} from "../shared/workContext";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function requestOnce(
  path: string,
  token: string,
  init?: RequestInit,
  expectedContext?: { orgId: string | null; mode: "case"; useRequestedOrg?: boolean },
): Promise<Response> {
  // Stored only when a multi-org user has picked; absent = no header sent.
  const storedOrgId = await readActiveOrgId();
  // E6.9 F6.9.8: the org header is decided by MODE, not by a path literal.
  // Training a payer form has no org at all — it writes the shared library —
  // and the user-scoped routes (org discovery, view prefs, shared propose)
  // are named as a contract set in panelMode.ts rather than compared inline.
  // Match the pathname precisely (ignore any query string).
  const pathname = path.split("?")[0] ?? path;
  const mode = await readPanelMode();
  if (
    expectedContext &&
    (mode !== expectedContext.mode || (!expectedContext.useRequestedOrg && storedOrgId !== expectedContext.orgId))
  ) {
    throw new ApiError(409, "The active work context changed before learning could be saved.");
  }
  const orgId = expectedContext?.useRequestedOrg ? expectedContext.orgId : storedOrgId;
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(shouldSendOrgHeader(mode, pathname, orgId) ? { "x-org-id": orgId as string } : {}),
    },
  });
}

// Envelope-aware fetch with the refresh-and-retry contract: if the server
// rejects the token (401), refresh once and retry once. A second 401 means
// the refresh token itself is dead — surface as a sign-in-required error.
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  expectedContext?: { orgId: string | null; mode: "case"; useRequestedOrg?: boolean },
): Promise<{ data: T; meta: ApiMeta | null }> {
  let token = await getAccessToken();
  let response = await requestOnce(path, token, init, expectedContext);
  if (response.status === 401) {
    // forceRefresh() throws AuthRequiredError when the refresh token itself is
    // dead. If the refresh SUCCEEDS but the server still 401s the retry, the
    // identity no longer authorizes this call — surface the SAME
    // sign-in-required path (AuthRequiredError), not a generic ApiError, per
    // the contract in this function's header comment.
    token = await forceRefresh();
    response = await requestOnce(path, token, init, expectedContext);
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

// GET /api/portals — the DB-driven portal registry (own-org + global rows).
// Org-scoped; the panel refetches per org and keeps rows in memory only.
export async function listPortals(): Promise<PortalRegistryRow[]> {
  const { data } = await apiFetch<PortalRegistryRow[]>("/api/portals");
  return data;
}

// GET /api/me/view-prefs — the user's saved detail-card field list PLUS the
// server-derived catalog of selectable fields (one round trip; the offered set
// is guaranteed to match what a PUT validates against). fields null = nothing
// saved (caller falls back to the default set). User-scoped like org
// discovery, but harmless with an x-org-id attached. A server that predates
// the catalog (no `catalog` key) degrades to an empty catalog — callers fall
// back to shape-only layout validation, never a broken card.
export async function getViewPrefs(): Promise<ViewPrefsResponse> {
  const { data } = await apiFetch<{
    fields: string[] | null;
    catalog?: QuickCardCatalogField[];
  }>("/api/me/view-prefs");
  return { fields: data.fields, catalog: Array.isArray(data.catalog) ? data.catalog : [] };
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

// GET /api/cases?q= — the case half of the unified standalone search (E4.3
// TE-11): org-scoped, matching payer name / provider name / tracking id, ids +
// display fields only. A blank query returns [] server-side.
export async function searchCases(query: string): Promise<CaseSearchRow[]> {
  const { data } = await apiFetch<CaseSearchRow[]>(`/api/cases?q=${encodeURIComponent(query)}`);
  return data;
}

// GET /api/providers?search= — the provider half of the search, reusing the
// existing guarded list route verbatim (TE-11): ilike over first/last name,
// NPI, and email over the PHI-minimized list projection.
export async function searchProviders(query: string): Promise<ProviderListItem[]> {
  const { data } = await apiFetch<ProviderListItem[]>(
    `/api/providers?search=${encodeURIComponent(query)}&page=1&pageSize=25&sort=last_name&order=asc`,
  );
  return data;
}

// GET /api/next-best-action — the org's RANKED queue (S3.3) plus its top
// item, or { item: null } for an honest queue-clear. Read-only; ordering and
// the per-case reason line come from the SERVER — the extension never ranks
// anything itself (the cross-cutting "no invented priority" gate).
export async function getNextBestAction(limit?: number): Promise<NextBestActionResult> {
  const qs = limit != null ? `?limit=${encodeURIComponent(String(limit))}` : "";
  const { data } = await apiFetch<NextBestActionResult>(`/api/next-best-action${qs}`);
  return data;
}

// PATCH /api/tasks/:id/steps — tick one SOP step complete (S4.3). The ONE
// task-state write the extension makes; the server owns the ordering rule and
// returns a 409 naming the blocker when a step isn't next.
export async function completeTaskStep(
  taskId: string,
  stepId: string,
): Promise<{ task: unknown; allDone: boolean }> {
  const { data } = await apiFetch<{ task: unknown; allDone: boolean }>(
    `/api/tasks/${encodeURIComponent(taskId)}/steps`,
    { method: "PATCH", body: JSON.stringify({ stepId }) },
  );
  return data;
}

// POST /api/portal-field-maps — PROPOSE a field the fill engine met that
// nothing maps (S5.1). The server forces status 'proposed' / source 'manual' /
// token null regardless of what we send: approving is a human act in the
// webapp trainer. The response carries the org's learned suggestion for the
// label (S5.3) with the evidence behind it.
export interface ProposeFieldResponse {
  map: PortalFieldMap;
  suggestion: { token: string; portalCount: number; fromDictionary: boolean } | null;
}

export async function proposeFieldMap(input: {
  portal_key: string;
  selector: string;
  field_label?: string | null;
  form_section?: string | null;
  field_type?: string | null;
}): Promise<ProposeFieldResponse> {
  const { data } = await apiFetch<ProposeFieldResponse>("/api/portal-field-maps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return data;
}

// POST /api/shared-field-maps — the E6.9 SHARED propose path (F6.9.2/F6.9.8).
//
// Distinct from proposeFieldMap above in exactly one way that matters: the row
// lands with `org_id IS NULL`, in the trained-form library every org inherits.
// It runs on the panel's user-scoped guard, so it carries no org header even
// for a multi-org user (shouldSendOrgHeader), and it is idempotent on
// (portal_key, selector) — re-capturing a page returns each existing row with
// its decision untouched, which is what makes re-capture drift repair rather
// than a reset.
//
// Shape-only, like every capture payload: label, selector, control type,
// section, page, position. There is no value key in this contract.
// GET /api/shared-portals — the GLOBAL registry only (E6.9 F6.9.9). Training
// has no org, so the org-scoped /api/portals cannot serve it; this runs on the
// panel's user-scoped guard and returns the shared library the trainer adds to.
export async function listSharedPortals(portalKey?: string): Promise<PortalRegistryRow[]> {
  const params = new URLSearchParams({ selection: "explicit" });
  if (portalKey != null) params.set("portal_key", portalKey);
  const { data } = await apiFetch<PortalRegistryRow[]>(`/api/shared-portals?${params.toString()}`);
  return data;
}

export async function proposeSharedFieldMap(input: {
  portal_key: string;
  /** The Train target's pinned generation. Omitted only for legacy generation-1 callers. */
  expected_mapping_generation?: number;
  selector: string;
  field_label?: string | null;
  form_section?: string | null;
  page_step?: string | null;
  field_type?: string | null;
  sort_order?: number | null;
  control_options?: { value: string; label: string }[] | null;
}): Promise<PortalFieldMap> {
  const { data } = await apiFetch<{ map: PortalFieldMap }>("/api/shared-field-maps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return data.map;
}

// GET /api/shared-field-maps?portal_key= — what a RECOGNIZED form already has
// (F6.9.9: pages seen, fields captured, mapped count). The shared tier only,
// on the same user-scoped guard as the propose above, because training names
// no org.
export async function listSharedFieldMapsWithMeta(portalKey: string): Promise<{ maps: PortalFieldMap[]; fillEventV2: boolean }> {
  const { data, meta } = await apiFetch<PortalFieldMap[]>(
    `/api/shared-field-maps?selection=explicit&portal_key=${encodeURIComponent(portalKey)}`,
  );
  return { maps: data, fillEventV2: isFillEventV2Advertised(meta) };
}

export async function listSharedFieldMaps(portalKey: string): Promise<PortalFieldMap[]> {
  return (await listSharedFieldMapsWithMeta(portalKey)).maps;
}

// POST /api/shared-test-fills — record a Train-forms synthetic fill as an
// is_test session. The route is user-scoped; orgId is body telemetry context
// for multi-org callers and is omitted from the request header in train mode.
export async function postSharedTestFill(body: {
  id: string;
  portalKey: string;
  fieldsFilled: number;
  fieldsSkipped: ReportedField[];
  startedAt?: string;
  completedAt?: string;
  orgId?: string | null;
  mockProfileVersion?: number;
  v2?: FillEventV2Metadata;
}): Promise<string> {
  const { v2, ...base } = body;
  const { data } = await apiFetch<{ session: { id: string } }>("/api/shared-test-fills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...base, ...(v2 ?? {}) }),
  });
  return data.session.id;
}

// POST /api/shared-portals/prove — the manual proven_at action. A dry-run
// result never calls this endpoint.
export async function proveSharedPortal(input: {
  portalKey: string;
  expectedMappingGeneration: number;
}): Promise<void> {
  await apiFetch("/api/shared-portals/prove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      portalKey: input.portalKey,
      expected_mapping_generation: input.expectedMappingGeneration,
    }),
  });
}

// PATCH /api/providers/:id — write ONE field (S6.3 gap pull). Deliberately
// narrow: the token key maps to the provider column the profile resolved it
// from, and only the gap fields the exception strip can offer are accepted, so
// this can never become a general provider-editing surface in the panel.
const PULLABLE_FIELDS: Readonly<Record<string, string>> = {
  "provider.deaNumber": "deaNumber",
  "provider.caqhId": "caqhId",
  "provider.taxonomyCode": "taxonomyCode",
  "provider.suffix": "suffix",
  "provider.middleInitial": "middleInitial",
  "provider.specialty": "specialty",
  "provider.subSpecialty": "subSpecialty",
};

export function isPullableField(token: string): boolean {
  return Object.hasOwn(PULLABLE_FIELDS, token);
}

export async function patchProviderField(
  providerId: string,
  token: string,
  value: string,
): Promise<void> {
  const column = PULLABLE_FIELDS[token];
  if (!column) throw new Error("That field can't be pulled from CAQH.");
  await apiFetch(`/api/providers/${encodeURIComponent(providerId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [column]: value }),
  });
}

// POST /api/providers/:id/caqh-attestation — record a CAQH re-attestation
// (S6.2/C6). `verifiedFields` are the token keys the fill carried; the server
// stamps each so the Details card can show per-field freshness (S6.1).
// PUSH ONLY: this never reads anything back into Minted Panel.
export async function recordCaqhAttestation(
  providerId: string,
  input: { attestedOn?: string | null; verifiedFields?: string[] } = {},
): Promise<{ caqhLastAttestedDate: string | null; currentThroughDays: number; verifiedFields: number }> {
  const { data } = await apiFetch<{
    caqhLastAttestedDate: string | null;
    currentThroughDays: number;
    verifiedFields: number;
  }>(`/api/providers/${encodeURIComponent(providerId)}/caqh-attestation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(input.attestedOn ? { attested_on: input.attestedOn } : {}),
      ...(input.verifiedFields?.length ? { verified_fields: input.verifiedFields } : {}),
    }),
  });
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

/** Revalidate one immutable M56 owner/step/config tuple in the active org.
 * The server returns canonical effective web maps in the same guarded read;
 * legacy org map/registry routes intentionally remain unchanged. */
export async function validateWorkContext(
  tuple: WorkContextTuple,
  options: { signal?: AbortSignal } = {},
): Promise<WorkContextValidationResponse> {
  let data: unknown;
  try {
    const response = await apiFetch<unknown>(
      "/api/work-context/validate",
      {
        method: "POST",
        cache: "no-store",
        signal: options.signal,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
        body: JSON.stringify(tuple),
      },
      { orgId: tuple.orgId, mode: "case", useRequestedOrg: true },
    );
    data = response.data;
  } catch (error) {
    if (error instanceof ApiError) {
      const message = error.status === 404
        ? "The authorized Work context could not be found in this organization."
        : error.status === 409
          ? "The Work context or portal mapping changed. Reopen this task from Minted Panel."
          : error.status === 422
            ? "Minted Panel rejected the Work context. Reopen this task from Minted Panel."
            : "Minted Panel could not validate this Work context.";
      throw new ApiError(error.status, message);
    }
    throw error;
  }
  const parsed = parseWorkContextValidationResponse(data);
  if (!parsed) throw new ApiError(502, "Minted Panel returned an invalid Work validation response.");
  const echoedTuple = {
    ...parsed.tuple,
    protocolVersion: tuple.protocolVersion,
  } as WorkContextTuple;
  if (
    !workTuplesEqual(echoedTuple, tuple) ||
    parsed.mappingGeneration !== tuple.mappingGeneration ||
    parsed.effectiveMappingFingerprint !== tuple.effectiveMappingFingerprint
  ) {
    throw new ApiError(409, "The Work context or portal mapping changed. Reopen this task from Minted Panel.");
  }
  return parsed;
}

export async function getPortalFieldMapsWithMeta(portalKey: string): Promise<{ maps: PortalFieldMap[]; fillEventV2: boolean }> {
  const { data, meta } = await apiFetch<PortalFieldMap[]>(
    `/api/portal-field-maps?portal_key=${encodeURIComponent(portalKey)}`,
  );
  return { maps: data, fillEventV2: isFillEventV2Advertised(meta) };
}

export async function getPortalFieldMaps(portalKey: string): Promise<PortalFieldMap[]> {
  return (await getPortalFieldMapsWithMeta(portalKey)).maps;
}

export type ProviderProfileRequestOptions =
  | {
      state?: string;
      facilityId?: string | null;
      groupId?: string | null;
      caseId?: string | null;
      contractContext?: undefined;
    }
  | {
      /** Contract profile group/state derive from owner validation; these
       * selectors cannot be supplied independently of the full tuple. A
       * selected facility may accompany that tuple and is membership-checked
       * by the Panel. */
      state?: never;
      facilityId?: string;
      groupId?: never;
      caseId?: undefined;
      contractContext: AuthorizedContractProfileSelectors;
    };

/** Build only the selectors supported by the Panel route. The Contract arm
 * accepts a complete authorized tuple; partial identifiers cannot be sent. */
export function providerProfileSearchParams(options: ProviderProfileRequestOptions = {}): URLSearchParams {
  const params = new URLSearchParams();
  if (options.state) params.set("state", options.state);
  if (options.facilityId) params.set("facilityId", options.facilityId);
  if (options.groupId) params.set("groupId", options.groupId);
  if (options.contractContext) {
    // The typed tuple is supplied only after authorized form-context
    // selection. M56 still owns tab binding; this query seam alone does not
    // authorize a live Contract fill or handoff.
    params.set("contractId", options.contractContext.contractId);
    params.set("assignmentId", options.contractContext.assignmentId);
    params.set("contextVersion", String(options.contractContext.contextVersion));
    params.set("sopTemplateId", options.contractContext.sopTemplateId);
    params.set("sopVersion", String(options.contractContext.sopVersion));
    params.set("stepIdentity", options.contractContext.stepIdentity);
  } else if (options.caseId) {
    params.set("caseId", options.caseId);
  }
  return params;
}

// PHI-dense payload (unmasked by design for form fill). Never log it.
// `facilityId` pins the facility.*/assignment.* token source; without it the
// server auto-resolves a sole facility or flags meta.needs_facility when the
// provider has several. Meta is returned so callers can read that flag.
export async function getProviderProfile(
  providerId: string,
  options: ProviderProfileRequestOptions = {},
): Promise<{ profile: ProviderProfileResponse; meta: ApiMeta | null }> {
  const params = providerProfileSearchParams(options);
  const qs = params.toString();
  const query = qs ? `?${qs}` : "";
  const { data, meta } = await apiFetch<ProviderProfileResponse>(
    `/api/providers/${encodeURIComponent(providerId)}/profile${query}`,
  );
  return { profile: data, meta };
}

export interface FillEventBody {
  id: string;
  caseId?: string | null;
  providerId: string;
  portalKey: string;
  fillMode: "web";
  startedAt: string;
  completedAt: string;
  fieldsFilled: number;
  fieldsSkipped: unknown;
  v2?: FillEventV2Metadata;
  /** Canonical tuple copied from the validated worker Work guard. */
  workContext?: CanonicalWorkContextTuple;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function persistedFillMatchesWorkContext(
  row: Record<string, unknown>,
  tuple: CanonicalWorkContextTuple,
): boolean {
  const common: Array<[string, unknown]> = [
    ["contextVersion", tuple.contextVersion],
    ["sopTemplateId", tuple.sopTemplateId],
    ["sopVersion", tuple.sopVersion],
    ["portalId", tuple.portalId],
    ["portalKey", tuple.portalKey],
    ["mappingGeneration", tuple.mappingGeneration],
    ["effectiveMappingFingerprint", tuple.effectiveMappingFingerprint],
    ["providerId", tuple.providerId],
    ["facilityId", tuple.facilityId],
    ["launchReceiptId", tuple.launchReceiptId],
    ["stepIdentity", tuple.stepIdentity],
  ];
  if (common.some(([key, expected]) => row[key] !== expected)) return false;
  if (tuple.ownerKind === "case") {
    return row.caseId === tuple.ownerId && row.caseTaskId === tuple.taskId && row.caseStepId === tuple.stepId &&
      row.contractId == null && row.contractSopAssignmentId == null && row.taskIndex == null && row.stepIndex == null;
  }
  return row.caseId == null && row.contractId === tuple.ownerId &&
    row.contractSopAssignmentId === tuple.assignmentId && row.taskIndex === tuple.taskIndex &&
    row.stepIndex === tuple.stepIndex && row.caseTaskId == null && row.caseStepId == null;
}

export async function postFillEvent(
  body: FillEventBody,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const { v2, ...base } = body;
  const { data } = await apiFetch<unknown>("/api/fill-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...base, ...(v2 ?? {}) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!isRecord(data) || data.id !== body.id || data.providerId !== body.providerId ||
    data.portalKey !== body.portalKey || (data.caseId ?? null) !== (body.caseId ?? null) ||
    data.fillMode !== "web" || data.isTest === true ||
    (v2 != null && data.eventSchemaVersion !== 2) ||
    (body.workContext != null && (data.isTest !== false || data.eventSchemaVersion !== 2 ||
      !persistedFillMatchesWorkContext(data, body.workContext)))) {
    throw new ApiError(502, "Minted Panel returned a fill receipt that does not match this fill.");
  }
}

/** Persist only a value-free receipt after the successful portal touch. The
 * worker owns auth and derives org/actor from its session; the request itself
 * carries no profile values, frame IDs, or identity fields. */
export async function postBatchLearnPortalFieldMaps(
  body: BatchLearnPortalFieldMapsRequest,
  options: { signal?: AbortSignal; expectedOrgId: string | null },
): Promise<BatchLearnPortalFieldMapsResponse> {
  const { data } = await apiFetch<BatchLearnPortalFieldMapsResponse>(
    "/api/portal-field-maps/batch-learn",
    {
      method: "POST",
      signal: options.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    { orgId: options.expectedOrgId, mode: "case" },
  );
  const validCount = (value: unknown): value is number =>
    Number.isInteger(value) && typeof value === "number" && value >= 0;
  if (
    data == null ||
    !validCount(data.inserted_count) ||
    !validCount(data.confirmed_saved_count) ||
    !validCount(data.preserved_count) ||
    !Array.isArray(data.results) ||
    data.results.length > body.mappings.length ||
    data.confirmed_saved_count > body.mappings.length ||
    data.inserted_count > data.confirmed_saved_count ||
    data.preserved_count > body.mappings.length
  ) {
    throw new ApiError(502, "Minted Panel returned an invalid learning receipt.");
  }
  const outcomeCounts = { inserted: 0, already_present: 0, preserved: 0 };
  const expected = new Map(body.mappings.map((mapping) => [mapping.selector, mapping.token]));
  const received = new Set<string>();
  for (const result of data.results) {
    if (!result || typeof result !== "object" ||
      !["inserted", "already_present", "preserved"].includes(result.outcome) ||
      typeof result.selector !== "string" || expected.get(result.selector) !== result.token ||
      received.has(result.selector)) {
      throw new ApiError(502, "Minted Panel returned an invalid learning receipt.");
    }
    received.add(result.selector);
    outcomeCounts[result.outcome] += 1;
  }
  if (data.results.length !== body.mappings.length ||
    outcomeCounts.inserted !== data.inserted_count ||
    outcomeCounts.inserted + outcomeCounts.already_present !== data.confirmed_saved_count ||
    outcomeCounts.preserved !== data.preserved_count) {
    throw new ApiError(502, "Minted Panel returned an invalid learning receipt.");
  }
  return data;
}

// POST /api/cases/:id/touches — both touch kinds ride the same append-only
// route: kind 'portal_submission' (the "Mark submitted" business log) and
// kind 'structured_touch' (the E4.3 log-and-advance typed touch). Never a
// status change. Idempotent on idempotency_id — a replay returns the stored
// touch (200) instead of appending (201).
export async function postSubmissionTouch(
  caseId: string,
  body: CaseTouchBody,
): Promise<{ touch: SubmissionTouch; statusBump: StatusBumpMeta | null }> {
  const { data, meta } = await apiFetch<SubmissionTouch>(
    `/api/cases/${encodeURIComponent(caseId)}/touches`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  // S4.4: the bump outcome rides meta, never the touch. A skipped bump is not
  // a failed touch — the panel reports both honestly.
  const bump = (meta as { status_bump?: string; status_bump_reason?: string } | null) ?? null;
  const statusBump =
    bump?.status_bump === "applied" || bump?.status_bump === "skipped"
      ? { applied: bump.status_bump === "applied", reason: bump.status_bump_reason ?? null }
      : null;
  return { touch: data, statusBump };
}
