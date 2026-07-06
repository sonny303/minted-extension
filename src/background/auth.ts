// Supabase auth, owned exclusively by the background service worker.
//
// The client is auth-only: nothing in this extension ever calls .from() or
// .rpc() — all data flows through the Minted Panel /api routes with a bearer
// token. The session lives in chrome.storage.session (in-memory, cleared when
// the browser exits, shared across service-worker restarts).
//
// MV3 service workers are killed and restarted constantly, so the GoTrue
// background refresh timer is useless here (autoRefreshToken: false).
// Instead, refresh is on-demand: getSession() refreshes an expired session
// from storage when called, and the API layer retries a 401 once after
// forceRefresh() — so a call made after token expiry succeeds without
// re-login.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../shared/config";
import type { AuthState } from "../shared/messages";

// GoTrue expects a localStorage-shaped adapter; back it with
// chrome.storage.session so tokens never hit disk.
const chromeSessionStorage = {
  getItem: async (key: string): Promise<string | null> => {
    const entry = await chrome.storage.session.get(key);
    const value = entry[key];
    return typeof value === "string" ? value : null;
  },
  setItem: async (key: string, value: string): Promise<void> => {
    await chrome.storage.session.set({ [key]: value });
  },
  removeItem: async (key: string): Promise<void> => {
    await chrome.storage.session.remove(key);
  },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: chromeSessionStorage,
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

export class AuthRequiredError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "AuthRequiredError";
  }
}

export async function getAuthState(): Promise<AuthState> {
  const { data } = await supabase.auth.getSession();
  return {
    signedIn: data.session != null,
    email: data.session?.user.email ?? null,
  };
}

export async function signIn(email: string, password: string): Promise<AuthState> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return { signedIn: true, email: data.user?.email ?? email };
}

// The signed-in user's id — the router scopes persisted workbench state to
// it (a different identity signing in must not inherit the previous one's
// selections). Not a token; safe to compare and store.
export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

// scope: "local" clears only this extension's session. The default ("global")
// would revoke every refresh token the user holds — including their Minted
// Panel web app session.
export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) throw new Error(error.message);
}

// Current access token, refreshed transparently if expired.
export async function getAccessToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error(error.message);
  if (!data.session) throw new AuthRequiredError();
  return data.session.access_token;
}

// Force a refresh-token exchange. Used by the API layer when a request comes
// back 401 (token expired mid-flight or clock skew slipped past getSession).
export async function forceRefresh(): Promise<string> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session) throw new AuthRequiredError();
  return data.session.access_token;
}
