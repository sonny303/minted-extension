// The chrome.runtime messaging protocol between the side panel and the
// background service worker. The background owns Supabase auth and every API
// call; the panel is UI only. Access tokens never appear in any message
// payload.
import type {
  CaseListItem,
  ProviderListItem,
  ProviderProfileFacility,
  SubmissionTouch,
  UserOrgMembership,
} from "./apiTypes";
import type { FillCoverage, FillReportRecord, FillSummary } from "./fill";

export type BgRequest =
  | { type: "GET_AUTH_STATE" }
  | { type: "SIGN_IN"; email: string; password: string }
  | { type: "SIGN_OUT" }
  | { type: "LIST_MY_ORGS" }
  | { type: "GET_ACTIVE_ORG" }
  // Selecting a DIFFERENT org clears all org-scoped workbench state
  // (provider, case, facility, reports) in the worker before the new id is
  // stored. null = single-org mode, no x-org-id header.
  | { type: "SET_ACTIVE_ORG"; orgId: string | null }
  | { type: "LIST_PROVIDERS" }
  | { type: "LIST_CASES"; providerId: string }
  // The provider's facility set for the location picker, projected from the
  // profile response — the panel never receives the token payload itself.
  | { type: "GET_PROVIDER_FACILITIES"; providerId: string }
  | { type: "GET_SELECTED_PROVIDER" }
  | { type: "SET_SELECTED_PROVIDER"; providerId: string | null }
  | { type: "GET_SELECTED_CASE"; providerId: string }
  | { type: "SET_SELECTED_CASE"; providerId: string; caseId: string | null }
  | { type: "GET_SELECTED_FACILITY"; providerId: string }
  | { type: "SET_SELECTED_FACILITY"; providerId: string; facilityId: string | null }
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
  // PR C write-back (Stories 5-7): the payer reference the human entered, an
  // optional WIP note, and a task_id when one is known (v1 sends none).
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

export interface AuthState {
  signedIn: boolean;
  email: string | null;
}

// The location-picker feed: the provider's facility set from the profile
// response and nothing else (no tokens, no provider row). The panel owns
// facility selection — a sole facility auto-selects, several are picked and
// remembered per provider — so the server's resolved selected_facility_id is
// deliberately not carried here.
export interface ProviderFacilitiesInfo {
  facilities: ProviderProfileFacility[];
  // meta.needs_facility: several facilities, none picked — the fill gate
  // stays closed until the user picks ("Pick a location first.").
  needsFacility: boolean;
  // Story 4: the provider's key professional identifiers, projected from the
  // profile tokens (not PHI — NPI/license/CAQH/TIN/DEA are form-fill fields).
  // The PHI-dense token payload stays in the worker; only these five cross.
  identifiers: ProviderIdentifiers;
}

// Story 4: the identifiers shown on the provider card, each with a copy button.
// A null value renders greyed ("—"). Keys are camelCase panel fields, not
// tokens; the worker maps them from provider.*/group.* profile tokens.
export interface ProviderIdentifiers {
  npi: string | null;
  license: string | null;
  caqh: string | null;
  tin: string | null;
  dea: string | null;
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
  GET_PROVIDER_FACILITIES: ProviderFacilitiesInfo;
  GET_SELECTED_PROVIDER: string | null;
  SET_SELECTED_PROVIDER: null;
  GET_SELECTED_CASE: string | null;
  SET_SELECTED_CASE: null;
  GET_SELECTED_FACILITY: string | null;
  SET_SELECTED_FACILITY: null;
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
