// Background service worker: message router. Owns Supabase auth and all API
// calls; the side panel drives it over chrome.runtime messaging. Only senders
// running on our own chrome-extension:// origin are served — content scripts
// send with the web page's URL, so page-adjacent code can never trigger auth
// or API traffic, and tokens never appear in responses.
import type { BgRequest, BgResponse, ProviderFacilitiesInfo } from "../shared/messages";
import type { FillReportRecord } from "../shared/fill";
import { AuthRequiredError, currentUserId, getAuthState, signIn, signOut } from "./auth";
import {
  ApiError,
  getProviderProfile,
  listCases,
  listMyOrgs,
  listProviders,
  postSubmissionTouch,
} from "./api";
import { readActiveOrgId, writeActiveOrgId } from "./orgState";
import { fillPortal } from "./fill";

// Clicking the toolbar icon toggles the workbench side panel (the action has
// no popup). Top-level so every worker start re-asserts the behavior. The
// optional chain keeps the router alive in builds without the sidePanel API
// (headless test Chromium) — a throw here would kill the whole worker.
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) => console.error("sidePanel.setPanelBehavior failed", error));

const SELECTED_PROVIDER_KEY = "minted.selectedProviderId";
const SELECTED_CASE_PREFIX = "minted.selectedCaseId.";
const SELECTED_FACILITY_PREFIX = "minted.selectedFacilityId.";
const SUBMIT_TOUCH_ID_PREFIX = "minted.submitTouchId.";
// Persisted fill reports, keyed `<prefix><providerId>.<portalKey>` (both ids
// are dot-free). Labels, counts, and reasons only — never field values.
const FILL_REPORT_PREFIX = "minted.fillReport.";
// The user id the persisted workbench state belongs to. The org is resolved
// server-side from this identity (single-org v0), so an identity change is
// also the org change; a future org picker's selection joins this check.
const WORKBENCH_OWNER_KEY = "minted.workbenchOwner";

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

// Wipe the ORG-scoped workbench state: selections, facility picks, fill
// reports, submit idempotency ids. Runs when the active org changes — the new
// org must never see the old org's ids — and as part of the full clear below.
async function clearOrgScopedState(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter(
    (key) =>
      key === SELECTED_PROVIDER_KEY ||
      key.startsWith(SELECTED_CASE_PREFIX) ||
      key.startsWith(SELECTED_FACILITY_PREFIX) ||
      key.startsWith(SUBMIT_TOUCH_ID_PREFIX) ||
      key.startsWith(FILL_REPORT_PREFIX),
  );
  if (keys.length) await chrome.storage.session.remove(keys);
}

// The full wipe: org-scoped state PLUS the active org and the owner marker.
// Runs on sign-out and when a different identity signs in. Deliberately not
// the GoTrue session key — auth storage is owned by auth.ts.
async function clearWorkbenchState(): Promise<void> {
  await clearOrgScopedState();
  await writeActiveOrgId(null);
  await chrome.storage.session.remove(WORKBENCH_OWNER_KEY);
}

function fillReportKey(providerId: string, portalKey: string): string {
  return `${FILL_REPORT_PREFIX}${providerId}.${portalKey}`;
}

function isFillReportRecord(value: unknown): value is FillReportRecord {
  const record = value as FillReportRecord | null;
  return (
    record != null &&
    typeof record === "object" &&
    typeof record.providerId === "string" &&
    typeof record.portalKey === "string" &&
    typeof record.caseId === "string" &&
    typeof record.completedAt === "string" &&
    typeof record.submitted === "boolean" &&
    record.summary != null &&
    typeof record.summary === "object"
  );
}

// The provider's most recent stored report across portals (v0 has one
// portal, so "most recent" is exact). Best-effort by design.
async function readFillReport(providerId: string): Promise<FillReportRecord | null> {
  const all = await chrome.storage.session.get(null);
  const records = Object.entries(all)
    .filter(([key]) => key.startsWith(`${FILL_REPORT_PREFIX}${providerId}.`))
    .map(([, value]) => value)
    .filter(isFillReportRecord)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  return records[0] ?? null;
}

async function handleRequest(request: BgRequest): Promise<unknown> {
  switch (request.type) {
    case "GET_AUTH_STATE":
      return getAuthState();
    case "SIGN_IN": {
      const state = await signIn(request.email, request.password);
      // Workbench state belongs to one identity (and the org the server
      // resolves for it). Same user back after token expiry keeps their
      // place; anyone else starts clean.
      const userId = await currentUserId();
      const previousOwner = await readSessionString(WORKBENCH_OWNER_KEY);
      if (previousOwner != null && previousOwner !== userId) await clearWorkbenchState();
      await writeSessionString(WORKBENCH_OWNER_KEY, userId);
      return state;
    }
    case "SIGN_OUT":
      await clearWorkbenchState();
      await signOut();
      return null;
    case "LIST_MY_ORGS":
      return listMyOrgs();
    case "GET_ACTIVE_ORG":
      return readActiveOrgId();
    case "SET_ACTIVE_ORG": {
      // Switching to a DIFFERENT org wipes all org-scoped state first — the
      // new org must never restore the old org's provider/case/facility ids
      // or fill reports. Re-asserting the same org (or staying in single-org
      // mode, null -> null) clears nothing.
      const previous = await readActiveOrgId();
      if (previous !== request.orgId) await clearOrgScopedState();
      await writeActiveOrgId(request.orgId);
      return null;
    }
    case "LIST_PROVIDERS":
      return listProviders();
    case "LIST_CASES":
      return listCases(request.providerId);
    case "GET_PROVIDER_FACILITIES": {
      // Fetch the profile but hand the panel ONLY the facility fields — the
      // token payload (PHI) never crosses into UI state it doesn't need.
      const { profile, meta } = await getProviderProfile(request.providerId);
      const info: ProviderFacilitiesInfo = {
        facilities: profile.facilities,
        selectedFacilityId: profile.selected_facility_id,
        needsFacility: meta?.needs_facility === true,
      };
      return info;
    }
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
    case "GET_SELECTED_FACILITY":
      return readSessionString(SELECTED_FACILITY_PREFIX + request.providerId);
    case "SET_SELECTED_FACILITY":
      await writeSessionString(SELECTED_FACILITY_PREFIX + request.providerId, request.facilityId);
      return null;
    case "GET_FILL_REPORT":
      return readFillReport(request.providerId);
    case "FILL": {
      const summary = await fillPortal({
        tabId: request.tabId,
        providerId: request.providerId,
        caseId: request.caseId,
        portalKey: request.portalKey,
        state: request.state,
        facilityId: request.facilityId,
      });
      // Persist the review state so reopening the panel restores it. A
      // storage failure must not un-report a successful fill.
      try {
        const record: FillReportRecord = {
          providerId: request.providerId,
          portalKey: request.portalKey,
          caseId: request.caseId,
          summary,
          completedAt: new Date().toISOString(),
          submitted: false,
        };
        await chrome.storage.session.set({
          [fillReportKey(request.providerId, request.portalKey)]: record,
        });
      } catch {
        // best-effort — the fill itself succeeded
      }
      return summary;
    }
    case "MARK_SUBMITTED": {
      // One idempotency id per (case, fill session), remembered for the
      // browser session: a retry after a network failure replays the same id,
      // so the server returns the stored touch instead of appending a second
      // one. A new fill session gets a fresh id.
      const idKey = `${SUBMIT_TOUCH_ID_PREFIX}${request.caseId}.${request.fillSessionId ?? "none"}`;
      let idempotencyId = await readSessionString(idKey);
      if (!idempotencyId) {
        idempotencyId = crypto.randomUUID();
        await writeSessionString(idKey, idempotencyId);
      }
      const touch = await postSubmissionTouch(request.caseId, {
        kind: "portal_submission",
        portal_key: request.portalKey,
        fill_session_id: request.fillSessionId,
        idempotency_id: idempotencyId,
      });
      // Remember the submission on the stored report so a restored panel
      // shows "Logged to the case." instead of offering the button again.
      try {
        const key = fillReportKey(request.providerId, request.portalKey);
        const entry = await chrome.storage.session.get(key);
        const record = entry[key];
        if (isFillReportRecord(record) && record.caseId === request.caseId) {
          await chrome.storage.session.set({ [key]: { ...record, submitted: true } });
        }
      } catch {
        // best-effort — the touch itself was logged
      }
      return touch;
    }
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
