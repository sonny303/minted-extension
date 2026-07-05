// The chrome.runtime messaging protocol between the popup and the background
// service worker. The background owns Supabase auth and every API call; the
// popup is UI only. Access tokens never appear in any message payload.
import type { CaseListItem, ProviderListItem } from "./apiTypes";
import type { FillSummary } from "./fill";

export type BgRequest =
  | { type: "GET_AUTH_STATE" }
  | { type: "SIGN_IN"; email: string; password: string }
  | { type: "SIGN_OUT" }
  | { type: "LIST_PROVIDERS" }
  | { type: "LIST_CASES"; providerId: string }
  | { type: "GET_SELECTED_PROVIDER" }
  | { type: "SET_SELECTED_PROVIDER"; providerId: string | null }
  | { type: "GET_SELECTED_CASE"; providerId: string }
  | { type: "SET_SELECTED_CASE"; providerId: string; caseId: string | null }
  | {
      type: "FILL";
      tabId: number;
      providerId: string;
      caseId: string;
      portalKey: string;
      state: string;
    };

export interface AuthState {
  signedIn: boolean;
  email: string | null;
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
  LIST_PROVIDERS: ProviderListItem[];
  LIST_CASES: CaseListItem[];
  GET_SELECTED_PROVIDER: string | null;
  SET_SELECTED_PROVIDER: null;
  GET_SELECTED_CASE: string | null;
  SET_SELECTED_CASE: null;
  FILL: FillSummary;
}

// Typed wrapper so popup call sites get the right response type per request.
export async function sendToBackground<T extends BgRequest["type"]>(
  request: Extract<BgRequest, { type: T }>,
): Promise<BgResponse<BgResponseMap[T]>> {
  return chrome.runtime.sendMessage(request);
}
