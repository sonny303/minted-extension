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
  // GET /api/portals: true when the registry returned zero rows.
  registry_empty?: boolean;
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
  /** E6.9 registry presentation. Optional so an older server still parses:
   * `displayLabel` is the admin's rename (the payer's own `fieldLabel` is
   * never overwritten), `section` the admin's grouping, `sortOrder` the
   * capture-derived position within its page. */
  displayLabel?: string | null;
  section?: string | null;
  sortOrder?: number | null;
  /** E6.10 — captured option vocabulary. Null/absent = never captured. */
  controlOptions?: { value: string; label: string }[] | null;
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
  // Address fields for the selected location's practice-address display.
  // Optional so the panel degrades gracefully against a server that predates
  // them (treated as no address on file).
  street?: string | null;
  suite?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
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
// GET /api/me/view-prefs — the saved layout PLUS the server-derived catalog of
// selectable quick-card fields (schema-derived panel-side from
// get_sop_field_tokens(), 2026-07-28 — supersedes the closed-allowlist mirror
// this repo used to carry in quickCards.ts). The catalog is the SINGLE source
// for the picker AND the PUT validator, served together so they can never
// disagree. `group` is the token family (provider/group/facility/license/
// assignment/groupInsurance/user); `groupLabel` is its section heading.
// GET /api/portals — the DB-driven payer-portal registry (2026-07-28), so
// portal identity stops being a hardcoded list in this bundle. Own-org rows
// plus global (orgId null) registry rows, the shared-catalog pattern the
// field maps already follow. `provenAt` non-null = a dry-run proved the form
// (the S4.1 PROVEN chip); `formUrl` drives page recognition.
export interface PortalRegistryRow {
  id: string;
  orgId: string | null;
  portalKey: string;
  name: string;
  payerId: string | null;
  /** The payer's display name, embedded by the /api projection (E6.9) so the
   * Train-forms picker can group by payer without a payer endpoint of its own.
   * Optional: a server that predates it degrades to an ungrouped list. */
  payerName?: string | null;
  formUrl: string | null;
  isVerified: boolean;
  lastVerifiedAt: string | null;
  provenAt: string | null;
  urlChangedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuickCardCatalogField {
  key: string;
  label: string;
  group: string;
  groupLabel: string;
}

export interface ViewPrefsResponse {
  fields: string[] | null;
  catalog: QuickCardCatalogField[];
}

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

// A portal-linked open SOP task on the case (Phase 4, SOP↔portal link). The
// panel matches the current page's portal_key against these to close the right
// task on submit (passing task_id on the submission touch). The extension never
// invents a task — it only echoes one the server derived from the case's tasks.
// portalKey arrives normalized (bare/lowercase) from the server.
export interface CasePortalTask {
  taskId: string;
  title: string;
  portalKey: string;
  status: string;
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
  // Phase 4: the case's open, portal-linked SOP tasks. Optional so the panel
  // degrades gracefully against a server that predates this field (treated as
  // no tasks). The extension matches the page's portal_key against these.
  portalTasks?: CasePortalTask[];
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

// touch_type/outcome/touch_date are nullable on the merged panel service (only
// touchpoint rows carry them, and older rows may predate the columns).
export interface CaseContextTouch {
  touchDate: string | null;
  touchType: string | null;
  outcome: string | null;
  note: string | null;
}

// E4.3 selected-facility parity: the practice address of the facility the CASE
// selects, resolved server-side from the case's explicit facility relationship
// only — never from the provider's facility set and never a fallback-to-first
// guess. Address fields are nullable; `null` for the whole object means the
// case has no facility link (an explicit gap the panel must not fill by
// guessing). (Panel `src/services/caseContext.ts`.)
export interface CaseContextFacility {
  id: string;
  name: string;
  street: string | null;
  suite: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  // E1.4 — present on `facilities[]` entries only (true for the case's
  // primary row, so the Workbench can badge it without a second lookup).
  // Absent on `selectedFacility`, which is already known to be the primary.
  isPrimary?: boolean;
}

// E4.3 TE-2 — the case's provider/payer identity for the panel header
// (F4.3.1 identity guard). Display fields only (id + name), never a row
// payload. (Panel `src/services/caseContext.ts`.)
export interface CaseContextParty {
  id: string;
  name: string;
}

// E4.3 TE-2 — one open SOP task with its E4.2 execution type. `extension_fill`
// tasks are the ones the panel offers the fill action on; the rest render as
// read-only checklist context. Task-state writes stay in the webapp (R6).
// S4.3 — one SOP step on an open task. LABELS AND STATE ONLY; the fill
// payload stays the profile endpoint's job.
export interface CaseContextTaskStep {
  id: string;
  label: string;
  order: number;
  isCompleted: boolean;
  stepType: string | null;
  portalKey: string | null;
}

export interface CaseContextTask {
  id: string;
  title: string;
  status: string;
  executionType: string;
  sortOrder: number;
  dueDate: string | null;
  // OPTIONAL: a server predating S4.3 omits it — the Progress tab then falls
  // back to task-level rows rather than rendering an empty checklist.
  steps?: CaseContextTaskStep[];
}

export interface CaseContext {
  // [] or one payer reference id — rendered as "Reference: <n>", row hidden
  // when empty. This is the case's tracking ID (latest-wins column).
  referenceNumbers: string[];
  latestNote: CaseContextNote | null;
  latestTouch: CaseContextTouch | null;
  // Optional so the panel degrades gracefully against a server that predates
  // this field (the portalTasks precedent): absent and null both mean "no
  // case-selected facility to show".
  selectedFacility?: CaseContextFacility | null;
  // E1.4 — the case's FULL location set (case_facilities joined to
  // facilities), primary row first then alphabetical by name, `isPrimary`
  // badged per row. Optional: a panel that predates this key degrades to
  // hidden rows, falling back to selectedFacility-only behavior.
  // selectedFacility is UNCHANGED and still means "the primary" — this is
  // additive, for the Workbench to show every location while filling one.
  facilities?: CaseContextFacility[];
  // --- E4.3 TE-2 additions (all optional: the production server may predate
  // the redesign contract; absent fields degrade to hidden rows, never a
  // crash). camelCase keys per the panel's context contract (the
  // payerPipelineState precedent), unlike the profile's snake_case pair. ---
  // E4.0 TE-7 — the external payer-pipeline state, e.g. "not_started".
  payerPipelineState?: string;
  provider?: CaseContextParty | null;
  payer?: CaseContextParty | null;
  state?: string;
  openTasks?: CaseContextTask[];
}

// GET /api/cases?q= — one case-search result row (E4.3 TE-11, the case half of
// the unified standalone search). Ids + display fields only, org-scoped
// server-side. Mirrors panel `src/services/providerCases.ts` CaseSearchRow.
export interface CaseSearchRow {
  id: string;
  providerId: string;
  providerName: string;
  payerName: string | null;
  state: string;
  status: string | null;
  payerReferenceId: string | null;
  payerPipelineState: string;
  /** Case practice location — mirrors panel CaseSearchRow.facilityId. */
  facilityId?: string | null;
  /** Globally-sequential case # shown as C-<n> on /cases; searchable via ?q=. */
  caseNumber?: number | null;
}

// GET /api/next-best-action — the queue top under the org's ranking config
// (E4.3 TE-6), or { item: null } for an honest "queue clear". The extension
// renders exactly this — no ranking logic lives here. Mirrors panel
// `src/services/nextBestAction.ts`.
export interface NextBestActionDeadline {
  date: string;
  source: string;
  overdue: boolean;
}

export interface NextBestActionItem {
  caseId: string;
  providerId: string;
  providerName: string;
  payerName: string;
  groupName: string;
  state: string;
  actionKind: string;
  action: string;
  reason: string;
  deadline: NextBestActionDeadline | null;
  payerPipelineState?: string;
  // Webapp route path (e.g. "/cases/<id>"); the extension prepends the
  // configured webapp origin.
  deepLink: string;
}

export interface NextBestActionResult {
  item: NextBestActionItem | null;
  // S3.3 — the ranked queue (server-derived, bounded by ?limit=). `item` is
  // items[0]. OPTIONAL so a server predating S3.3 degrades to the single-item
  // handback rather than an empty queue.
  items?: NextBestActionItem[];
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
  // Story 7 / Phase 4: the SOP task the human just submitted — org-validated +
  // marked done server-side (locked decision (c)). Supplied by the panel when the
  // page's portal_key matched an open task on the case; omitted otherwise.
  task_id?: string | null;
  // Story 7: the attached PDF's filename → a second system_event.
  pdf_filename?: string | null;
  // S4.4 (2026-07-28): also move the case In Progress -> Submitted through
  // set_case_status, evidenced by this touch. OFF by default — the R2 rule
  // that the extension never changes status IMPLICITLY still holds; this is
  // explicit and per-request. The outcome rides meta.status_bump, never the
  // touch itself, so a rejected transition can't look like a failed touch.
  bump_status?: boolean;
}

// POST /api/cases/:id/touches with kind 'structured_touch' — E4.3 TE-5 /
// F4.3.4: ONE E4.1 structured touchpoint appended from the extension.
// snake_case per this endpoint's locked idiom. touch_type is REQUIRED (one of
// the seven canonical E4.1 types); outcome 'other' requires the one-line
// context in note; the optional payer_reference_id is the audited latest-wins
// tracking-ID write-back. portal_key / fill_session_id / task_id / wip_note /
// pdf_filename are portal_submission-only — the server 422s them loudly on
// this kind. (Panel `src/services/submissionTouches.ts` recordStructuredTouch.)
export interface StructuredTouchBody {
  kind: "structured_touch";
  idempotency_id: string;
  touch_type: string;
  note?: string | null;
  outcome?: string | null;
  recipient_name?: string | null;
  recipient_contact?: string | null;
  next_follow_up_date?: string | null;
  clears_follow_up?: boolean;
  payer_reference_id?: string | null;
}

// Either kind on the same POST — the two bodies never mix fields.
export type CaseTouchBody = SubmissionTouchBody | StructuredTouchBody;

// S4.4 — the opt-in status bump's outcome, from the touch response's meta.
// null = no bump was requested (or the server predates it).
export interface StatusBumpMeta {
  applied: boolean;
  // Populated when applied === false: the server's caller-facing reason.
  reason: string | null;
}

// The created touch, camelCased like every row in the envelope contract
// (mintedpanel src/services/submissionTouches.ts). touchType/outcome are
// nullable on the wire for non-touchpoint entries; the touches this extension
// creates always carry a touchType.
export interface SubmissionTouch {
  id: string;
  caseId: string;
  touchDate: string;
  touchType: string | null;
  outcome: string | null;
  notes: string | null;
  source: string;
}

// One group a provider works under, as carried on a list row. The grain is
// M:N — the same human can be on two groups' rosters — which is exactly why
// the search shows it: two rows reading "Jones, Addie" are otherwise
// indistinguishable. Group names are not PHI.
export interface ProviderGroupRef {
  id: string;
  name: string;
  isPrimary: boolean;
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
  // OPTIONAL on the wire: a panel deployed before 2026-08-19 sends no `groups`
  // key at all, and the row must still render — absent means "this server
  // doesn't say", never "no groups".
  groups?: ProviderGroupRef[];
  /** The org's designated dry-run test provider (panel E4.2 F4.2.7). Already
   * in the list projection; the extension reads it to offer the US-5 sandbox.
   * The panel excludes such a provider from queue/generation/scorecard, which
   * is exactly what makes it safe to fill with repeatedly. */
  isTestProvider?: boolean;
  updatedAt: string;
}
