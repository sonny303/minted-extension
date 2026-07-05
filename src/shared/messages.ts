// The chrome.runtime messaging protocol between the popup and the background
// service worker. The background owns Supabase auth and every API call; the
// popup is UI only. Access tokens never appear in any message payload.
import type { ProviderListItem } from "./apiTypes";

export type BgRequest =
  | { type: "GET_AUTH_STATE" }
  | { type: "SIGN_IN"; email: string; password: string }
  | { type: "SIGN_OUT" }
  | { type: "LIST_PROVIDERS" }
  | { type: "GET_SELECTED_PROVIDER" }
  | { type: "SET_SELECTED_PROVIDER"; providerId: string | null };

export interface AuthState {
  signedIn: boolean;
  email: string | null;
}

export type BgResponse<T> = { ok: true; data: T } | { ok: false; error: string };

export interface BgResponseMap {
  GET_AUTH_STATE: AuthState;
  SIGN_IN: AuthState;
  SIGN_OUT: null;
  LIST_PROVIDERS: ProviderListItem[];
  GET_SELECTED_PROVIDER: string | null;
  SET_SELECTED_PROVIDER: null;
}

// Typed wrapper so popup call sites get the right response type per request.
export async function sendToBackground<T extends BgRequest["type"]>(
  request: Extract<BgRequest, { type: T }>,
): Promise<BgResponse<BgResponseMap[T]>> {
  return chrome.runtime.sendMessage(request);
}
