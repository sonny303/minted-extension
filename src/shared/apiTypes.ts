// Mirrors the Minted Panel /api contract (src/server/envelope.ts and the
// provider list projection in src/services/providers.ts over there). Every
// response is `{ data, error, meta }`; rows come back camelCased.

export interface ApiMeta {
  total?: number;
  page?: number;
  pageSize?: number;
  // Non-fatal resolution notes (e.g. an empty {{user.*}} token). Advisory.
  notes?: string[];
  // GET /api/providers/:id/profile only: the provider has several facilities
  // and no ?facilityId was sent, so facility.*/assignment.* tokens are empty —
  // the client must ask the user to pick; the server never guesses.
  // snake_case is the wire contract (mintedpanel src/server/envelope.ts).
  needs_facility?: boolean;
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

// The provider's resolvable facility set, carried on the profile response so
// the workbench can render a location picker (mintedpanel
// src/services/providerProfile.ts).
export interface ProviderProfileFacility {
  id: string;
  name: string;
}

export interface ProviderProfileResponse {
  provider: { id: string } & Record<string, unknown>;
  tokens: ProfileToken[];
  unresolved: UnresolvedToken[];
  // snake_case keys are the wire contract for these two, pinned by the
  // mintedpanel route tests — unlike the camelCased row payloads.
  facilities: ProviderProfileFacility[];
  // The facility the facility.*/assignment.* tokens were resolved from:
  // the ?facilityId when sent, else the provider's sole facility, else null.
  selected_facility_id: string | null;
}

// GET /api/me/orgs — the caller's own memberships (user-scoped; works BEFORE
// an x-org-id can be sent, which is the point). Mirrors mintedpanel
// src/services/orgMemberships.ts.
export interface UserOrgMembership {
  orgId: string;
  orgName: string;
  role: string;
}

// The case's most recent touchlog note, author-resolved (Story 11).
export interface CaseLatestNote {
  text: string;
  author: string | null;
  at: string;
}

// GET /api/cases?providerId=... — the case picker feed. Mirrors the merged
// route (mintedpanel src/services/providerCases.ts): the provider's OPEN
// cases only (open = credentialing status not in the config's 'complete'
// action bucket), sorted payer then state. PR C added three touchlog-derived
// fields the panel prefills/guards off.
export interface CaseListItem {
  id: string;
  payerName: string | null;
  state: string;
  status: string | null;
  submittedDate: string | null;
  // Story 5: the case's latest-wins payer reference — prefills the ref box.
  payerReferenceId: string | null;
  // Story 11: the most recent note on the case, shown on the card.
  latestNote: CaseLatestNote | null;
  // Story 10: the most recent submission (a touchpoint with outcome
  // 'submitted') as an ISO timestamp — drives the duplicate-submission guard.
  lastSubmittedAt: string | null;
}

// GET /api/cases/:id/context — the selected case's reference number(s) and most
// recent activity, fetched per-case after selection (Epic 3d). Distinct from
// CaseListItem.latestNote (which rides the case-picker list): this is a
// dedicated, org-scoped read that also surfaces the payer reference id(s) and
// the latest touch. Mirrors the merged mintedpanel route's `data` shape exactly.
export interface CaseContextNote {
  content: string;
  createdAt: string;
  authorName: string | null;
}

export interface CaseContextTouch {
  touchDate: string;
  touchType: string;
  outcome: string;
  note: string | null;
}

export interface CaseContext {
  // [] or one payer reference id — rendered as "Reference: <n>", row hidden
  // when empty.
  referenceNumbers: string[];
  latestNote: CaseContextNote | null;
  latestTouch: CaseContextTouch | null;
}

// POST /api/cases/:id/touches — the "Mark submitted" business log. Body keys
// are snake_case per the locked R2 contract (2026-07-05), unlike fill-events'
// camelCase. The server sets org and the performing user from the JWT;
// idempotency_id becomes the anchor touch row's id (a replay returns the
// stored row). PR C (Stories 5-7) adds optional write-back fields on the same
// POST, all snake_case.
export interface SubmissionTouchBody {
  kind: "portal_submission";
  portal_key: string;
  fill_session_id?: string | null;
  note?: string | null;
  idempotency_id: string;
  // Story 5: overwrite the case's latest-wins payer reference / submission id.
  payer_reference_id?: string | null;
  // Story 6: a work-in-progress note → a touchlog note entry (task-linked when
  // task_id is known).
  wip_note?: string | null;
  // Story 7: the SOP task the human just submitted — org-validated + marked
  // done server-side (locked decision (c)). The v1 panel has no task source,
  // so this stays undefined and no task is closed; the plumbing is ready.
  task_id?: string | null;
  // Story 7: the attached PDF's filename → a second system_event.
  pdf_filename?: string | null;
}

// The created touch, camelCased like every row in the envelope contract
// (mintedpanel src/services/submissionTouches.ts).
export interface SubmissionTouch {
  id: string;
  caseId: string;
  touchDate: string;
  touchType: string;
  outcome: string;
  notes: string | null;
  source: string;
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
