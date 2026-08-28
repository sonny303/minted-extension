// Background service worker: message router. Owns Supabase auth and all API
// calls; the side panel drives it over chrome.runtime messaging. Only senders
// running on our own chrome-extension:// origin are served — content scripts
// send with the web page's URL, so page-adjacent code can never trigger auth
// or API traffic, and tokens never appear in responses.
import type {
  BgRequest,
  BgResponse,
  ProviderFacilitiesInfo,
  SearchResults,
} from "../shared/messages";
import type { FillReportRecord } from "../shared/fill";
import type { QuickCardCatalogField } from "../shared/apiTypes";
import {
  AuthRequiredError,
  currentUserId,
  getAuthState,
  signIn,
  signOut,
} from "./auth";
import {
  ApiError,
  completeTaskStep,
  getCaseContext,
  patchProviderField,
  proposeSharedFieldMap,
  recordCaqhAttestation,
  getNextBestAction,
  getProviderProfile,
  getViewPrefs,
  listCases,
  listMyOrgs,
  listPortals,
  listProviders,
  listSharedFieldMaps,
  listSharedPortals,
  postSubmissionTouch,
  proveSharedPortal,
  putViewPrefs,
  searchCases,
  searchProviders,
} from "./api";
import { projectQuickCards, resolveLayout } from "../shared/quickCards";
import {
  buildStructuredTouchBody,
  validateStructuredTouch,
} from "../shared/structuredTouch";
import { readActiveOrgId, writeActiveOrgId } from "./orgState";
import { readPanelMode, writePanelMode } from "./mode";
import { coveragePortal, fillPortal, sandboxFillPortal } from "./fill";
import { fillMockPortal } from "./mockFill";
import { ensureContentScript } from "./inject";
import { buildSubmissionTouchBody } from "../shared/submission";
import {
  ACTIVE_CASE_KEY,
  bindFillTab,
  clearActiveCase,
  enterActiveCase,
  getActiveCaseState,
  readActiveCaseRecord,
  registerActiveCaseListeners,
  touchActiveCaseActivity,
} from "./activeCase";
import { resolveActiveCaseState } from "../shared/handoff";
import {
  applyRowEdit,
  identifyCapturePage,
  mergePageCapture,
  parseCaptureSession,
  rowDisplayName,
  type CaptureRow,
  type CaptureSession,
} from "../shared/capture";
import type { PickOutcome } from "../content/elementPicker";
import { assignSortOrder } from "../shared/trainForms";
import { browseableProviders } from "../shared/browseProviders";
import type { CapturedField } from "../content/captureScan";
import { isSandboxProvider } from "../shared/sandbox";
import type { SelectorMatchReport } from "../shared/selectorMatch";

// Clicking the toolbar icon toggles the workbench side panel (the action has
// no popup). Top-level so every worker start re-asserts the behavior. The
// optional chain keeps the router alive in builds without the sidePanel API
// (headless test Chromium) — a throw here would kill the whole worker.
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) =>
    console.error("sidePanel.setPanelBehavior failed", error),
  );

// E4.3 F4.3.1/TE-1: the SET_ACTIVE_CASE handoff receipt + portal-tab binding
// and expiry listeners. Top-level so every worker restart re-registers them.
registerActiveCaseListeners();

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

async function writeSessionString(
  key: string,
  value: string | null,
): Promise<void> {
  if (value == null) {
    await chrome.storage.session.remove(key);
  } else {
    await chrome.storage.session.set({ [key]: value });
  }
}

// Wipe the ORG-scoped workbench state: selections, facility picks, fill
// reports, submit idempotency ids, and the active-case context (a handoff for
// org A must never survive into org B — TE-3's cleared-on-org-change rule).
// Runs when the active org changes and as part of the full clear below.
async function clearOrgScopedState(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter(
    (key) =>
      key === SELECTED_PROVIDER_KEY ||
      key === ACTIVE_CASE_KEY ||
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

// S5.2 — the capture session lives in chrome.storage.session (dies with the
// browser) and holds labels/selectors/decisions only. There is no value in it
// to protect: captureScan never reads one.
const CAPTURE_KEY = "capture.session";

async function readCaptureSession(): Promise<CaptureSession | null> {
  try {
    const entry = await chrome.storage.session.get(CAPTURE_KEY);
    return parseCaptureSession(entry[CAPTURE_KEY]);
  } catch {
    return null;
  }
}

async function writeCaptureSession(session: CaptureSession): Promise<void> {
  await chrome.storage.session.set({ [CAPTURE_KEY]: session });
}

function fillReportKey(providerId: string, portalKey: string): string {
  return `${FILL_REPORT_PREFIX}${providerId}.${portalKey}`;
}

// Saved quick-card layout + catalog. Invalid layouts fall back to defaults.
// If the catalog read fails, validate shape only — don't wipe a saved layout.
async function readCardLayout(): Promise<{
  layout: { fields: string[]; source: "saved" | "default" };
  catalog: QuickCardCatalogField[];
}> {
  try {
    const prefs = await getViewPrefs();
    const allowed = new Set(prefs.catalog.map((f) => f.key));
    return {
      layout: resolveLayout(prefs.fields, allowed),
      catalog: prefs.catalog,
    };
  } catch {
    return { layout: resolveLayout(null), catalog: [] };
  }
}

// Date-only ISO for the quick-card expiry badges; the pure module never reads
// a clock.
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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
async function readFillReport(
  providerId: string,
): Promise<FillReportRecord | null> {
  const all = await chrome.storage.session.get(null);
  const records = Object.entries(all)
    .filter(([key]) => key.startsWith(`${FILL_REPORT_PREFIX}${providerId}.`))
    .map(([, value]) => value)
    .filter(isFillReportRecord)
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  return records[0] ?? null;
}

async function resolveMockTelemetryOrgId(): Promise<string> {
  const memberships = await listMyOrgs();
  if (memberships.length === 0) {
    throw new Error(
      "Choose an organization in Work cases before running a mock dry run.",
    );
  }
  if (memberships.length === 1) return memberships[0]!.orgId;
  const activeOrgId = await readActiveOrgId();
  if (
    activeOrgId &&
    memberships.some((membership) => membership.orgId === activeOrgId)
  ) {
    return activeOrgId;
  }
  throw new Error(
    "This mock dry run needs an organization for telemetry. Choose an organization in Work cases, then retry.",
  );
}

/**
 * Shared guard for the two US-5 sandbox actions (SANDBOX_FILL,
 * CLEAR_PORTAL_FORM): re-checks the roster's OWN `is_test_provider` flag for
 * `providerId` rather than trusting whatever the caller sent. Defense in
 * depth against a panel-side state bug (or any other caller) pointing a
 * sandbox action at a real, non-designated provider — a fill with no case
 * attribution, or a form clear on a live case, must never reach real data.
 */
async function assertSandboxProvider(
  providerId: string,
  message: string,
): Promise<void> {
  const roster = await listProviders();
  const target = roster.find((p) => p.id === providerId);
  if (!isSandboxProvider(target)) throw new Error(message);
}

/** Exported for the TE-10 harness — the side panel talks over messaging. */
export async function handleRequest(request: BgRequest): Promise<unknown> {
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
      if (previousOwner != null && previousOwner !== userId)
        await clearWorkbenchState();
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
    case "LIST_PORTALS":
      return listPortals();
    case "LIST_PROVIDERS":
      return browseableProviders(await listProviders());
    case "LIST_CASES":
      return listCases(request.providerId);
    case "SEARCH": {
      // E4.3 F4.3.5: both halves CONCURRENTLY, each degrading independently —
      // a server that predates ?q= fails the case half with its own message
      // while provider search still works (and vice versa).
      const query = request.query.trim();
      if (query === "") {
        const empty: SearchResults = {
          cases: [],
          providers: [],
          casesError: null,
          providersError: null,
        };
        return empty;
      }
      const [casesRes, providersRes] = await Promise.allSettled([
        searchCases(query),
        searchProviders(query),
      ]);
      const results: SearchResults = {
        cases: casesRes.status === "fulfilled" ? casesRes.value : [],
        providers:
          providersRes.status === "fulfilled"
            ? browseableProviders(providersRes.value)
            : [],
        casesError:
          casesRes.status === "rejected"
            ? failureMessage(casesRes.reason)
            : null,
        providersError:
          providersRes.status === "rejected"
            ? failureMessage(providersRes.reason)
            : null,
      };
      // Both halves down for the same reason (typically auth) — surface it as
      // a real failure so the panel runs its normal error handling.
      if (results.casesError != null && results.providersError != null) {
        if (casesRes.status === "rejected") throw casesRes.reason;
      }
      return results;
    }
    case "GET_CASE_CONTEXT":
      // Read-only case context (Epic 3d + E4.3 TE-2). Org-scoped —
      // getCaseContext goes through the same guarded, x-org-id-attaching
      // apiFetch as the case list.
      return getCaseContext(request.caseId);
    case "GET_ACTIVE_CASE":
      return getActiveCaseState();
    case "ENTER_ACTIVE_CASE":
      // TE-17: an in-panel selection enters the SAME active-case state as a
      // handoff — same record, same 60-minute/tab-close expiry.
      await enterActiveCase({
        caseId: request.caseId,
        providerId: request.providerId,
        orgId: request.orgId,
      });
      return null;
    case "CLEAR_ACTIVE_CASE":
      await clearActiveCase();
      return null;
    case "COMPLETE_TASK_STEP": {
      const result = await completeTaskStep(request.taskId, request.stepId);
      return { allDone: result.allDone };
    }
    // ---- S5.2/S5.4 capture ----
    case "GET_CAPTURE":
      return readCaptureSession();
    case "START_CAPTURE": {
      // Capture is a Train-forms job only — Work cases never proposes maps.
      if ((await readPanelMode()) !== "train") {
        throw new Error("Switch to Train forms to capture a portal.");
      }
      // Read the form's SHAPE from the bound tab (labels/selectors/types —
      // never a value), then ask the server what this org already knows about
      // each label so the review opens with suggestions, not a blank grid.
      // Inject content.js first when it isn't already there (any portal reached
      // portal), so capture works on any DB-registered portal, not just the
      // one with a static content_scripts match.
      await ensureContentScript(request.tabId);
      const scanned = (await chrome.tabs.sendMessage(request.tabId, {
        type: "SCAN_FIELDS",
      })) as
        | { ok?: boolean; data?: CapturedField[]; error?: string }
        | undefined;
      if (!scanned?.ok || !scanned.data) {
        throw new Error(
          scanned?.error ??
            "Could not read this form — reload the page and retry.",
        );
      }
      const previous = await readCaptureSession();
      const samePortal = previous?.portalKey === request.portalKey;
      // BITE-CAP-05 — identify the page AFTER the scan. The side panel sends a
      // collision-free candidate; we reuse an existing page when URL/heading/
      // selector-overlap evidence says so, so a genuine second page is not
      // collapsed onto the first (and mergePageCapture does not wipe it).
      const previousRows = samePortal && previous ? previous.rows : [];
      const pageStep = identifyCapturePage({
        previous: previousRows,
        scanned: scanned.data.map((f) => f.selector),
        candidate: request.pageStep?.trim() || "Page 1",
        urlTail: request.pageUrlTail ?? null,
        heading: null,
        mode: request.captureMode ?? "auto",
      });
      // E6.9 F6.9.8 — stamp the wizard page and DOM order. The scan yields
      // fields in document order, so sortOrder is positional within THIS page;
      // pages themselves order by the sequence the trainer walked them.
      const rows: CaptureRow[] = assignSortOrder(scanned.data).map((f) => ({
        label: f.label,
        selector: f.selector,
        fieldType: f.fieldType,
        formSection: f.formSection,
        suggestedToken: null,
        evidence: null,
        chosenToken: null,
        sent: false,
        pageStep,
        sortOrder: f.sortOrder,
        origin: "auto_detected",
        displayLabel: null,
        typeOverridden: false,
        ...(f.options !== undefined ? { options: f.options } : {}),
      }));
      // Re-capturing is DRIFT REPAIR, and it is PER PAGE: prior decisions on
      // the page being scanned carry over, and the other pages of a multi-page
      // run are kept verbatim (a plain diff would read them as removed and
      // drop them — see mergePageCapture).
      const merged =
        samePortal && previous
          ? mergePageCapture(previous.rows, rows, pageStep)
          : rows;
      const session: CaptureSession = {
        portalKey: request.portalKey,
        templateStepId: request.templateStepId ?? null,
        startedAt: new Date().toISOString(),
        rows: merged,
      };
      await writeCaptureSession(session);
      return session;
    }
    case "SET_CAPTURE_CHOICE": {
      const current = await readCaptureSession();
      if (current == null) throw new Error("No capture in progress");
      const next: CaptureSession = {
        ...current,
        rows: current.rows.map((r) =>
          r.selector === request.selector
            ? { ...r, chosenToken: request.token }
            : r,
        ),
      };
      await writeCaptureSession(next);
      return next;
    }
    // ---- 2026-08-19 manual mapping ----
    case "PICK_CAPTURE_FIELD": {
      // Same Train-only gate as capture itself: pointing at a field is
      // capturing one, and a proposal always lands in the shared library.
      if ((await readPanelMode()) !== "train") {
        throw new Error("Switch to Train forms to add a field.");
      }
      const current = await readCaptureSession();
      if (current == null)
        throw new Error("Capture this form first, then add missing fields.");
      await ensureContentScript(request.tabId);
      const picked = (await chrome.tabs.sendMessage(request.tabId, {
        type: "PICK_ELEMENT",
      })) as { ok?: boolean; data?: PickOutcome; error?: string } | undefined;
      if (!picked?.ok || !picked.data) {
        throw new Error(
          picked?.error ?? "Could not add a field — reload the page and retry.",
        );
      }
      // Cancelling is a normal outcome, not a failure: return the session
      // untouched so the panel simply leaves pick mode.
      if (picked.data.status === "cancelled") return current;

      const field = picked.data.field;
      const existing = current.rows.find((r) => r.selector === field.selector);
      if (existing) {
        // Already known. Say so by returning the session unchanged rather than
        // adding a duplicate row that would propose the same selector twice.
        throw new Error(
          `That field is already captured${
            rowDisplayName(existing) ? ` as "${rowDisplayName(existing)}"` : ""
          }.`,
        );
      }
      // A hand-added field joins the page the trainer is looking at, at the
      // END of it — its DOM position is not meaningful relative to rows the
      // scan ordered visually, and inventing one would reorder the page.
      const pageStep = request.pageStep?.trim() || null;
      const samePage = current.rows.filter(
        (r) => (r.pageStep ?? null) === pageStep,
      );
      const nextSort =
        samePage.reduce((max, r) => Math.max(max, r.sortOrder ?? 0), 0) + 1;
      const row: CaptureRow = {
        label: field.label,
        selector: field.selector,
        fieldType: field.fieldType,
        formSection: field.formSection,
        suggestedToken: null,
        evidence: null,
        chosenToken: null,
        sent: false,
        pageStep,
        sortOrder: nextSort,
        origin: "user_mapped",
        // A re-point carries the library's own name for the field it replaces;
        // an ordinary hand-add has none and falls back to the portal's text.
        displayLabel: request.displayLabel?.trim() || null,
        typeOverridden: false,
        ...(field.options !== undefined ? { options: field.options } : {}),
      };
      const next: CaptureSession = { ...current, rows: [...current.rows, row] };
      await writeCaptureSession(next);
      return next;
    }
    case "CANCEL_CAPTURE_PICK": {
      // Best-effort: the pick may already have resolved, or the tab may be
      // gone. Either way the panel is leaving pick mode, so never throw.
      try {
        await chrome.tabs.sendMessage(request.tabId, { type: "CANCEL_PICK" });
      } catch {
        // no content script / tab closed — nothing to cancel
      }
      return null;
    }
    case "EDIT_CAPTURE_ROW": {
      const current = await readCaptureSession();
      if (current == null) throw new Error("No capture in progress");
      // The rule itself is pure and lives beside mergePageCapture, which
      // depends on the same invariant: the selector IS the row's key.
      const outcome = applyRowEdit(current.rows, request.selector, {
        displayLabel: request.displayLabel,
        fieldType: request.fieldType,
        newSelector: request.newSelector,
      });
      if (!outcome.ok) throw new Error(outcome.reason);
      const next: CaptureSession = { ...current, rows: outcome.rows };
      await writeCaptureSession(next);
      return next;
    }
    case "REMOVE_CAPTURE_ROW": {
      const current = await readCaptureSession();
      if (current == null) throw new Error("No capture in progress");
      const next: CaptureSession = {
        ...current,
        rows: current.rows.filter((r) => r.selector !== request.selector),
      };
      await writeCaptureSession(next);
      return next;
    }
    // ---- US-5 sandbox ----
    case "SANDBOX_FILL": {
      // Case work only. Train forms has no org, so it cannot read a provider
      // at all — its equivalent is the synthetic mock dry run.
      if ((await readPanelMode()) === "train") {
        throw new Error("Switch to Work cases to run a sandbox fill.");
      }
      // Defense in depth against a panel-side state bug (leftover sandbox
      // chrome pointed at a real, non-designated provider): the worker is the
      // one place that can refuse the fill outright, so it re-checks the
      // roster's own `is_test_provider` flag rather than trusting whatever
      // provider id the panel sent. A real provider's data must never reach a
      // live portal through the no-case, no-attribution sandbox path.
      await assertSandboxProvider(
        request.providerId,
        "This provider isn't the organization's designated sandbox test profile — refusing to run a no-attribution fill against real provider data.",
      );
      await ensureContentScript(request.tabId);
      return sandboxFillPortal({
        tabId: request.tabId,
        providerId: request.providerId,
        portalKey: request.portalKey,
        state: request.state,
        facilityId: request.facilityId,
        orgId: await readActiveOrgId(),
      });
    }
    case "CLEAR_PORTAL_FORM": {
      // Same guard as SANDBOX_FILL, for the same reason: clearing every
      // control on the page is safe only against the sandbox's own
      // no-attribution provider — on a real case it would wipe a
      // coordinator's live typing.
      await assertSandboxProvider(
        request.providerId,
        "This provider isn't the organization's designated sandbox test profile — refusing to clear a form that may carry real, in-progress work.",
      );
      await ensureContentScript(request.tabId);
      const response = (await chrome.tabs.sendMessage(request.tabId, {
        type: "CLEAR_FORM",
      })) as { ok?: boolean; data?: number; error?: string } | undefined;
      if (!response?.ok || typeof response.data !== "number") {
        throw new Error(
          response?.error ??
            "Could not clear this form — reload the page and retry.",
        );
      }
      return { cleared: response.data };
    }
    case "REMOVE_CAPTURE_ROWS": {
      const current = await readCaptureSession();
      if (current == null) throw new Error("No capture in progress");
      const drop = new Set(request.selectors);
      const next: CaptureSession = {
        ...current,
        rows: current.rows.filter((r) => !drop.has(r.selector)),
      };
      await writeCaptureSession(next);
      return next;
    }
    case "TEST_CAPTURE_SELECTOR": {
      await ensureContentScript(request.tabId);
      const result = (await chrome.tabs.sendMessage(request.tabId, {
        type: "MATCH_SELECTOR",
        selector: request.selector,
        highlight: request.highlight === true,
      })) as
        | { ok?: boolean; data?: SelectorMatchReport; error?: string }
        | undefined;
      // The page reports the match SHAPE (how many, how many fillable, one
      // radio group?) — a bare count cannot tell a wrapper from a field.
      if (
        !result?.ok ||
        result.data == null ||
        typeof result.data.matches !== "number"
      ) {
        throw new Error(
          result?.error ?? "Could not check this field on the page.",
        );
      }
      return { selector: request.selector, ...result.data };
    }
    case "SEND_CAPTURE": {
      const current = await readCaptureSession();
      if (current == null) throw new Error("No capture in progress");
      // Capture / send is Train-only: proposals always land in the SHARED
      // library (`org_id IS NULL`). Work cases no longer proposes under an org.
      const mode = await readPanelMode();
      if (mode !== "train") {
        throw new Error("Switch to Train forms to send a capture.");
      }
      const rows: CaptureRow[] = [];
      for (const row of current.rows) {
        if (row.sent) {
          rows.push(row);
          continue;
        }
        await proposeSharedFieldMap({
          portal_key: current.portalKey,
          selector: row.selector,
          // The payer's own captured text is what `field_label` means, and a
          // rename must NOT overwrite it (E6.9 keeps the admin's name in
          // `display_label`, which the panel's field registry edits by row id).
          // The ONE exception is a field the portal never labelled at all —
          // then the trainer's name is the only name there is, and sending an
          // empty label instead would propose a row nobody can identify.
          field_label:
            row.label.trim() || (row.displayLabel ?? "").trim() || null,
          form_section: row.formSection,
          page_step: row.pageStep ?? null,
          field_type: row.fieldType,
          sort_order: row.sortOrder ?? null,
          control_options: row.options,
        });
        // The shared path returns the row itself, not a learned suggestion —
        // suggestions are org-scoped memory (field_dictionary) and training
        // has no org. Nothing to fold back; the trainer decides in the
        // editor, which is where the whole registry now lives.
        rows.push({ ...row, sent: true });
      }
      const next: CaptureSession = { ...current, rows };
      await writeCaptureSession(next);
      return next;
    }
    case "LIST_SHARED_PORTALS":
      return listSharedPortals();
    case "LIST_SHARED_FIELD_MAPS":
      return listSharedFieldMaps(request.portalKey);
    case "RUN_MOCK_DRY_RUN": {
      const orgId = await resolveMockTelemetryOrgId();
      await ensureContentScript(request.tabId);
      return fillMockPortal({
        tabId: request.tabId,
        portalKey: request.portalKey,
        orgId,
      });
    }
    case "MARK_PORTAL_PROVEN":
      await proveSharedPortal({ portalKey: request.portalKey });
      return null;
    case "GET_PANEL_MODE":
      return readPanelMode();
    case "SET_PANEL_MODE": {
      await writePanelMode(request.mode);
      return null;
    }
    case "CLEAR_CAPTURE":
      await chrome.storage.session.remove(CAPTURE_KEY);
      return null;
    case "RECORD_CAQH_ATTESTATION": {
      const result = await recordCaqhAttestation(request.providerId, {
        verifiedFields: request.verifiedFields,
      });
      return {
        caqhLastAttestedDate: result.caqhLastAttestedDate,
        verifiedFields: result.verifiedFields,
      };
    }
    case "PULL_CAQH_FIELD": {
      // S6.3: write ONE field the portal holds and we don't, stamping it
      // verified in the same breath (it was just read off the source). Uses
      // the existing provider PATCH — no new write surface.
      await patchProviderField(
        request.providerId,
        request.token,
        request.value,
      );
      return null;
    }
    case "GET_NEXT_BEST_ACTION":
      return getNextBestAction(request.limit);
    case "LOG_STRUCTURED_TOUCH": {
      // E4.3 F4.3.4/TE-5: validate locally (mirrors the server's 422 rules),
      // then append ONE structured touch. The panel-generated idempotency id
      // is reused across retries of the same draft, so a retry after a
      // network failure replays instead of double-logging.
      const validation = validateStructuredTouch(request.draft);
      if (!validation.ok) throw new Error(validation.message);
      const { touch } = await postSubmissionTouch(
        request.caseId,
        buildStructuredTouchBody(request.draft, request.idempotencyId),
      );
      await touchActiveCaseActivity();
      return touch;
    }
    case "GET_PROVIDER_FACILITIES": {
      // ONE audited profile read feeds both the facility picker and the Quick
      // Cards projection (E4.3 F4.3.5 / TE-12 — cards are a rendering of the
      // existing profile endpoint, never a second route). The raw token
      // payload stays in the worker; the panel receives display values only,
      // held in memory (TE-14). When facilityId is set, facility.*/
      // assignment.* tokens resolve for that location (multi-facility
      // providers otherwise leave them unresolved behind meta.needs_facility).
      // When state is set (B1.1), license.* resolves for that state instead
      // of staying ambiguous over several state licenses.
      const [{ profile, meta }, { layout, catalog }] = await Promise.all([
        getProviderProfile(request.providerId, {
          facilityId: request.facilityId,
          state: request.state,
        }),
        readCardLayout(),
      ]);
      const servedLabels = new Map(catalog.map((f) => [f.key, f.label]));
      // The panel owns facility SELECTION (sole auto-select, or the user's
      // per-provider pick remembered in session storage), so the server's
      // resolved selected_facility_id isn't threaded through here — only the
      // facility set and the needs-a-pick flag are.
      const info: ProviderFacilitiesInfo = {
        facilities: profile.facilities,
        needsFacility: meta?.needs_facility === true,
        cards: projectQuickCards(
          profile.tokens,
          profile.unresolved,
          layout,
          todayIso(),
          servedLabels,
        ),
        // The served picker catalog rides along so the Edit Layout form offers
        // exactly what the server will accept — no mirrored allowlist.
        catalog,
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
      await writeSessionString(
        SELECTED_CASE_PREFIX + request.providerId,
        request.caseId,
      );
      return null;
    case "GET_SELECTED_FACILITY":
      return readSessionString(SELECTED_FACILITY_PREFIX + request.providerId);
    case "SET_SELECTED_FACILITY":
      await writeSessionString(
        SELECTED_FACILITY_PREFIX + request.providerId,
        request.facilityId,
      );
      return null;
    case "SET_VIEW_PREFS":
      await putViewPrefs(request.fields);
      return null;
    case "GET_FILL_COVERAGE":
      // Read-only preview: reuse the fill flow's own field-maps + profile fetch
      // (coveragePortal calls the same getters fillPortal does) and compute
      // coverage. No content-script message, no fill-event write. caseId is part
      // of the selection but coverage doesn't depend on it, so it isn't threaded
      // into the fetch.
      return coveragePortal({
        providerId: request.providerId,
        portalKey: request.portalKey,
        state: request.state,
        facilityId: request.facilityId,
      });
    case "GET_FILL_REPORT":
      return readFillReport(request.providerId);
    case "FILL": {
      // F4.3.1: NEVER fill from expired context. When the active-case record
      // covers this case and has expired (bound tab closed / 60 minutes
      // idle), the fill is refused with the re-launch guidance — the panel
      // also gates this, but the worker is the enforcement point.
      const record = await readActiveCaseRecord();
      if (
        record != null &&
        record.caseId === request.caseId &&
        resolveActiveCaseState(record, Date.now()).status === "expired"
      ) {
        throw new Error(
          "This case's context expired - re-launch it from Minted Panel or re-select the case, then fill again.",
        );
      }
      // Inject content.js when it isn't already there (any dynamically-registered portal)
      // before fillPortal's pre-flight PING, so fill reaches any DB-registered
      // portal, not just the statically-matched one.
      await ensureContentScript(request.tabId);
      const summary = await fillPortal({
        tabId: request.tabId,
        providerId: request.providerId,
        caseId: request.caseId,
        portalKey: request.portalKey,
        state: request.state,
        facilityId: request.facilityId,
      });
      // The fill is this case's binding moment for an in-panel selection
      // (TE-17): the portal tab it ran in becomes the bound tab, and the
      // activity resets the idle clock.
      await bindFillTab(request.caseId, request.tabId);
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
      // PR C write-back (Stories 5-7) + Phase 4 close-out: the payer reference,
      // an optional WIP note, and the SOP task the human closed ride on the same
      // POST. buildSubmissionTouchBody drops blank fields to null (a no-op
      // server-side) and OMITS task_id unless one was selected — never sends it
      // as null/empty.
      const { touch, statusBump } = await postSubmissionTouch(
        request.caseId,
        buildSubmissionTouchBody({
          portalKey: request.portalKey,
          fillSessionId: request.fillSessionId,
          idempotencyId,
          payerReferenceId: request.payerReferenceId,
          wipNote: request.wipNote,
          taskId: request.taskId,
          bumpStatus: request.bumpStatus,
        }),
      );
      // Logging the submission is user activity on the case — reset the
      // active-case idle clock.
      await touchActiveCaseActivity();
      // Remember the submission on the stored report so a restored panel
      // shows "Logged to the case." instead of offering the button again.
      try {
        const key = fillReportKey(request.providerId, request.portalKey);
        const entry = await chrome.storage.session.get(key);
        const record = entry[key];
        if (isFillReportRecord(record) && record.caseId === request.caseId) {
          await chrome.storage.session.set({
            [key]: { ...record, submitted: true },
          });
        }
      } catch {
        // best-effort — the touch itself was logged
      }
      return { touch, statusBump };
    }
  }
}

function toFailure(error: unknown): BgResponse<never> {
  if (error instanceof AuthRequiredError) {
    return {
      ok: false,
      error: "Session expired - please sign in again.",
      code: 401,
    };
  }
  if (error instanceof ApiError)
    return { ok: false, error: error.message, code: error.status };
  if (error instanceof TypeError) {
    return {
      ok: false,
      error: "Could not reach Minted Panel - check your connection.",
    };
  }
  if (error instanceof Error) return { ok: false, error: error.message };
  return { ok: false, error: "Something went wrong." };
}

// The user-facing line for one degraded search half (SEARCH tolerates a
// partial failure; toFailure above stays the whole-request path).
function failureMessage(error: unknown): string {
  const failure = toFailure(error);
  return failure.ok ? "Something went wrong." : failure.error;
}

chrome.runtime.onMessage.addListener(
  (
    message: BgRequest,
    sender,
    sendResponse: (response: BgResponse<unknown>) => void,
  ) => {
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
