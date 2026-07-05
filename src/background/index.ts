// Background service worker: message router. Owns Supabase auth and all API
// calls; the popup drives it over chrome.runtime messaging. Only senders
// running on our own chrome-extension:// origin are served — content scripts
// send with the web page's URL, so page-adjacent code can never trigger auth
// or API traffic, and tokens never appear in responses.
import type { BgRequest, BgResponse } from "../shared/messages";
import { AuthRequiredError, getAuthState, signIn, signOut } from "./auth";
import { ApiError, listProviders } from "./api";

const SELECTED_PROVIDER_KEY = "minted.selectedProviderId";

async function getSelectedProviderId(): Promise<string | null> {
  const entry = await chrome.storage.session.get(SELECTED_PROVIDER_KEY);
  const value = entry[SELECTED_PROVIDER_KEY];
  return typeof value === "string" ? value : null;
}

async function setSelectedProviderId(providerId: string | null): Promise<void> {
  if (providerId == null) {
    await chrome.storage.session.remove(SELECTED_PROVIDER_KEY);
  } else {
    await chrome.storage.session.set({ [SELECTED_PROVIDER_KEY]: providerId });
  }
}

async function handleRequest(request: BgRequest): Promise<unknown> {
  switch (request.type) {
    case "GET_AUTH_STATE":
      return getAuthState();
    case "SIGN_IN":
      return signIn(request.email, request.password);
    case "SIGN_OUT":
      await setSelectedProviderId(null);
      await signOut();
      return null;
    case "LIST_PROVIDERS":
      return listProviders();
    case "GET_SELECTED_PROVIDER":
      return getSelectedProviderId();
    case "SET_SELECTED_PROVIDER":
      await setSelectedProviderId(request.providerId);
      return null;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof AuthRequiredError) return "Session expired — please sign in again.";
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return "Could not reach Minted Panel — check your connection.";
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
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
      .catch((error: unknown) => sendResponse({ ok: false, error: toErrorMessage(error) }));
    return true; // keep the channel open for the async response
  },
);
