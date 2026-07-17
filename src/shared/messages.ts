// The chrome.runtime messaging protocol between the side panel and the
// background service worker. The background owns Supabase auth and every API
// call; the panel is UI only. Access tokens never appear in any message
// payload.
import type {
  CaseContext,
  CaseListItem,
  CaseSearchRow,
  NextBestActionResult,
  ProviderListItem,
  ProviderProfileFacility,
  SubmissionTouch,
  UserOrgMembership,
} from "./apiTypes";
import type { FillCoverage, FillReportRecord, FillSummary } from "./fill";
import type { ActiveCaseState } from "./handoff";
import type { QuickCards } from "./quickCards";
import type { StructuredTouchDraft } from "./structuredTouch";

export type BgRequest =
  | { type: "GET_AUTH_STATE" }
  | { type: "SIGN_IN"; email: string; password: string }
  | { type: "SIGN_OUT" }
  | { type: "LIST_MY_ORGS" }
  | { type: "GET_ACTIVE_ORG" }
  // Selecting a DIFFERENT org clears all org-scoped workbench state
  // (provider, case, facility, reports, active-case context) in the worker
  // before the new id is stored. null = single-org mode, no x-org-id header.
  | { type: "SET_ACTIVE_ORG"; orgId: string | null }
  | { type: "LIST_PROVIDERS" }
  | { type: "LIST_CASES"; providerId: string }
  // E4.3 F4.3.5: the unified standalone search — the worker queries
  // GET /api/cases?q= and GET /api/providers?search= CONCURRENTLY and returns
  // both halves, each with its own error slot so one half failing (e.g. a
  // server that predates ?q=) degrades that half, never the whole search.
  | { type: "SEARCH"; query: string }
  // The selected case's context (identity header, open tasks, pipeline state,
  // tracking ID, latest note/touch) — a read-only, org-scoped fetch.
  | { type: "GET_CASE_CONTEXT"; caseId: string }
  // The provider's facility set + the Quick Cards projection, from ONE
  // audited profile read — the panel never receives the raw token payload.
  | { type: "GET_PROVIDER_FACILITIES"; providerId: string }
  | { type: "GET_SELECTED_PROVIDER" }
  | { type: "SET_SELECTED_PROVIDER"; providerId: string | null }
  | { type: "GET_SELECTED_CASE"; providerId: string }
  | { type: "SET_SELECTED_CASE"; providerId: string; caseId: string | null }
  | { type: "GET_SELECTED_FACILITY"; providerId: string }
  | { type: "SET_SELECTED_FACILITY"; providerId: string; facilityId: string | null }
  // Save the signed-in user's quick-card layout (bare closed-catalog keys, in
  // display order) via PUT /api/me/view-prefs. The panel refetches the
  // provider profile afterwards so the cards re-project under the new layout.
  | { type: "SET_VIEW_PREFS"; fields: string[] }
  // E4.3 F4.3.1/TE-1: the worker-owned active-case context. GET returns the
  // record + its expiry status; ENTER records an in-panel selection (search
  // result, active-cases click, NBA handback, or the manual picker — TE-17
  // parity: same record, same 60-min/tab-close expiry); CLEAR dismisses an
  // expired/mismatched context.
  | { type: "GET_ACTIVE_CASE" }
  | { type: "ENTER_ACTIVE_CASE"; caseId: string; providerId: string; orgId: string | null }
  | { type: "CLEAR_ACTIVE_CASE" }
  // E4.3 F4.3.4/TE-6: the server-derived queue top (or null = queue clear).
  | { type: "GET_NEXT_BEST_ACTION" }
  // E4.3 F4.3.4/TE-5: log ONE structured touch. The panel generates the
  // idempotency id once per draft and REUSES it on retries, so a failed write
  // retried can never double-log; a fresh draft gets a fresh id.
  | { type: "LOG_STRUCTURED_TOUCH"; caseId: string; idempotencyId: string; draft: StructuredTouchDraft }
  | {
      type: "FILL";
      tabId: number;
      providerId: string;
      caseId: string;
      portalKey: string;
      state: string;
      // The resolved location (user pick or sole facility); null only when
      // the provider has no facilities.
      facilityId: string | null;
    }
  // Read-only coverage sensor (Epic 3a): resolve the same profile + field maps
  // a fill would fetch for this selection and return "M of N + gaps" WITHOUT
  // touching the page or logging anything. Carries the fill selection's data
  // inputs (no tabId — no page is filled).
  | {
      type: "GET_FILL_COVERAGE";
      providerId: string;
      caseId: string;
      portalKey: string;
      state: string;
      facilityId: string | null;
    }
  // The provider's most recent persisted fill report, or null. The panel
  // uses it to restore the review state when it reopens.
  | { type: "GET_FILL_REPORT"; providerId: string }
  // Pressed by the human AFTER they submit the portal form themselves — the
  // extension never touches the portal's submit button. fillSessionId is the
  // fill attempt's idempotency id when the fill event was recorded, else null.
  // PR C write-back (Stories 5-7): the payer reference the human entered and an
  // optional WIP note. Phase 4: taskId is the portal-matched SOP task the human
  // chose to close (null/omitted when none matched or the human opted out).
  | {
      type: "MARK_SUBMITTED";
      providerId: string;
      caseId: string;
      portalKey: string;
      fillSessionId: string | null;
      payerReferenceId?: string | null;
      wipNote?: string | null;
      taskId?: string | null;
    };

// Worker → panel broadcast when the active-case context changes out from
// under the panel (a handoff arrived, the bound tab closed, a second launch
// replaced the context). The panel re-reads GET_ACTIVE_CASE on receipt.
export interface ActiveCaseUpdatedEvent {
  type: "ACTIVE_CASE_UPDATED";
}

export interface AuthState {
  signedIn: boolean;
  email: string | null;
}

// The location-picker feed + the Quick Cards projection, both derived from
// the SAME single audited profile read. The panel owns facility selection —
// the case context's explicit facility, a sole facility, or the user's
// remembered pick — so the server's resolved selected_facility_id is
// deliberately not carried here.
export interface ProviderFacilitiesInfo {
  facilities: ProviderProfileFacility[];
  // meta.needs_facility: several facilities, none picked — the fill gate
  // stays closed until the user picks ("Pick a location first.").
  needsFacility: boolean;
  // E4.3 F4.3.5: the read-only Type 1 / Type 2 quick cards. Display values
  // only, held in panel memory — never persisted anywhere (TE-14).
  cards: QuickCards;
}

// The unified search's two halves. Each half degrades independently: a null
// error with rows is success; a non-null error renders that half's honest
// failure line while the other half still works.
export interface SearchResults {
  cases: CaseSearchRow[];
  providers: ProviderListItem[];
  casesError: string | null;
  providersError: string | null;
}

export type BgResponse<T> =
  | { ok: true; data: T }
  // `code` is the HTTP status when the failure came from the API (e.g. 404 =
  // route not deployed, 403 = role can't write).
  | { ok: false; error: string; code?: number };

export interface BgResponseMap {
  GET_AUTH_STATE: AuthState;
  SIGN_IN: AuthState;
  SIGN_OUT: null;
  LIST_MY_ORGS: UserOrgMembership[];
  GET_ACTIVE_ORG: string | null;
  SET_ACTIVE_ORG: null;
  LIST_PROVIDERS: ProviderListItem[];
  LIST_CASES: CaseListItem[];
  SEARCH: SearchResults;
  GET_CASE_CONTEXT: CaseContext;
  GET_PROVIDER_FACILITIES: ProviderFacilitiesInfo;
  GET_SELECTED_PROVIDER: string | null;
  SET_SELECTED_PROVIDER: null;
  GET_SELECTED_CASE: string | null;
  SET_SELECTED_CASE: null;
  GET_SELECTED_FACILITY: string | null;
  SET_SELECTED_FACILITY: null;
  SET_VIEW_PREFS: null;
  GET_ACTIVE_CASE: ActiveCaseState;
  ENTER_ACTIVE_CASE: null;
  CLEAR_ACTIVE_CASE: null;
  GET_NEXT_BEST_ACTION: NextBestActionResult;
  LOG_STRUCTURED_TOUCH: SubmissionTouch;
  GET_FILL_COVERAGE: FillCoverage;
  GET_FILL_REPORT: FillReportRecord | null;
  FILL: FillSummary;
  MARK_SUBMITTED: SubmissionTouch;
}

// Typed wrapper so panel call sites get the right response type per request.
export async function sendToBackground<T extends BgRequest["type"]>(
  request: Extract<BgRequest, { type: T }>,
): Promise<BgResponse<BgResponseMap[T]>> {
  return chrome.runtime.sendMessage(request);
}
