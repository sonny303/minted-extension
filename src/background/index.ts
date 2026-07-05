// Background service worker: message router. Owns Supabase auth and all API
// calls; the popup drives it over chrome.runtime messaging. Only senders
// running on our own chrome-extension:// origin are served — content scripts
// send with the web page's URL, so page-adjacent code can never trigger auth
// or API traffic, and tokens never appear in responses.
import type { BgRequest, BgResponse } from "../shared/messages";
import { AuthRequiredError, getAuthState, signIn, signOut } from "./auth";
import { ApiError, listCases, listProviders } from "./api";
import { fillPortal } from "./fill";

const SELECTED_PROVIDER_KEY = "minted.selectedProviderId";
const SELECTED_CASE_PREFIX = "minted.selectedCaseId.";

async function readSessionString(key: string): Promise<string | null> {
  const entry = await chrome.storage.session.get(key);
  const value = entry[key];
  return typeof value === "string" ? value : null;
}

async function writeSessionString(key: string, value: string | null): Promise<void> {
  if (value == null) {
    await chrome.storage.session.remove(key);
  } else {
    await chrome.storage.session.set({ [key]: value });
  }
}

async function clearSelections(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter(
    (key) => key === SELECTED_PROVIDER_KEY || key.startsWith(SELECTED_CASE_PREFIX),
  );
  if (keys.length) await chrome.storage.session.remove(keys);
}

async function handleRequest(request: BgRequest): Promise<unknown> {
  switch (request.type) {
    case "GET_AUTH_STATE":
      return getAuthState();
    case "SIGN_IN":
      return signIn(request.email, request.password);
    case "SIGN_OUT":
      await clearSelections();
      await signOut();
      return null;
    case "LIST_PROVIDERS":
      return listProviders();
    case "LIST_CASES":
      return listCases(request.providerId);
    case "GET_SELECTED_PROVIDER":
      return readSessionString(SELECTED_PROVIDER_KEY);
    case "SET_SELECTED_PROVIDER":
      await writeSessionString(SELECTED_PROVIDER_KEY, request.providerId);
      return null;
    case "GET_SELECTED_CASE":
      return readSessionString(SELECTED_CASE_PREFIX + request.providerId);
    case "SET_SELECTED_CASE":
      await writeSessionString(SELECTED_CASE_PREFIX + request.providerId, request.caseId);
      return null;
    case "FILL":
      return fillPortal({
        tabId: request.tabId,
        providerId: request.providerId,
        caseId: request.caseId,
        portalKey: request.portalKey,
        state: request.state,
      });
  }
}

function toFailure(error: unknown): BgResponse<never> {
  if (error instanceof AuthRequiredError) {
    return { ok: false, error: "Session expired — please sign in again.", code: 401 };
  }
  if (error instanceof ApiError) return { ok: false, error: error.message, code: error.status };
  if (error instanceof TypeError) {
    return { ok: false, error: "Could not reach Minted Panel — check your connection." };
  }
  if (error instanceof Error) return { ok: false, error: error.message };
  return { ok: false, error: "Something went wrong." };
}

chrome.runtime.onMessage.addListener(
  (message: BgRequest, sender, sendResponse: (response: BgResponse<unknown>) => void) => {
    const ownOrigin = `chrome-extension://${chrome.runtime.id}/`;
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(ownOrigin)) {
      sendResponse({ ok: false, error: "Not allowed" });
      return false;
    }
    handleRequest(message)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error: unknown) => sendResponse(toFailure(error)));
    return true; // keep the channel open for the async response
  },
);
