import { AD_HOC_CASE_SELECTION } from "../shared/messages";
import {
  sendToBackground as sendToWorker,
  type BgRequest,
  type BgResponse,
  type BgResponseMap,
} from "../shared/messages";
// Side panel UI: sign-in, org/provider/case selection, and fill controls.
// All API calls run in the background worker; this file renders state and
// sends typed messages. Portal detection follows the active tab.
import "./sidepanel.css";
import { getExtensionVersionInfo } from "../shared/version";
import type {
  CaseContext,
  CaseContextTask,
  CaseListItem,
  NextBestActionResult,
  ProviderGroupRef,
  ProviderListItem,
  ProviderProfileFacility,
  UserOrgMembership,
} from "../shared/apiTypes";
import type {
  FillCoverage,
  FillReportRecord,
  FillSummary,
  AiFillReview,
  MockDryRunSummary,
  ReportedField,
} from "../shared/fill";
import { canUseNano, matchUnmappedFields, NANO_LIMITS } from "../shared/nanoAi";
import { aiReviewStatusText, bindAiReviewActions } from "./aiReviewController";
import {
  type AuthState,
  type SearchResults,
  type SelectorTestResult,
} from "../shared/messages";
import { formatDisplayDate, looksLikeIsoDate } from "../shared/detailFields";
import {
  matchPortalByUrl,
  portalOriginPatterns,
  portalKeyEligibleForUrl,
  toMatchedPortal,
  type MatchedPortal,
} from "../shared/portals";
import type {
  NextBestActionItem,
  PortalFieldMap,
  PortalFieldType,
  PortalRegistryRow,
} from "../shared/apiTypes";
import { matchPortalTasks } from "../shared/submission";
import {
  afterLogView,
  logFailureView,
  logMovesToSubmitted,
  manualTaskToClose,
  MOVES_TO_SUBMITTED_LINE,
  submissionPlanLine,
  supportCode,
  taskCardNeedsAttention,
  taskCardPill,
  type AfterLogView,
  type FormTask,
  type LogFailureView,
  type SubmissionPlan,
  type TaskCardState,
} from "../shared/closeOut";
import { AI_FILL_ENABLED, API_BASE_URL } from "../shared/config";
import { activeCaseReceiptKey, type ActiveCaseRecord } from "../shared/handoff";
import {
  isActiveWorkExpired,
  workFormUrlMatchesPage,
  type ActiveWorkRecord,
  type ActiveWorkState,
  type CanonicalWorkContextTuple,
  type WorkPortalPermissionTarget,
} from "../shared/workContext";
import {
  carriedLaunchId,
  isLaunchReplacement,
  launchSwapLine,
  workEndedCaseId,
  workEndedLine,
} from "../shared/workLinkNotice";
import {
  caseReturnUrl,
  evaluateHandoffApplication,
  evaluateHandoffOrg,
  isTerminalHandoffRejection,
  matchesAppliedHandoffSelection,
  type AppliedHandoffSelection,
  type HandoffContextFacts,
  type HandoffRead,
} from "../shared/handoffApplication";
import {
  orderLayoutByCatalog,
  providerWebappPath,
  shouldRetryFacilityCards,
  type QuickCardField,
  type QuickCards,
} from "../shared/quickCards";
import {
  facilityAddressLines,
  facilityPickerScope,
  resolveCaseFacilitySelection,
} from "../shared/caseContext";
import type { QuickCardCatalogField } from "../shared/apiTypes";
import {
  countBrokenSelectors,
  dataFixAction,
  partialFillWarning,
  partitionGaps,
  trainFlowPath,
} from "../shared/fixit";
import {
  attestationFailureText,
  attestedOnFor,
  buildCaqhPushOffer,
} from "../shared/caqh";
import {
  canSendCapture,
  captureSessionMatchesTarget,
  captureCounts,
  CAPTURE_FIELD_TYPES,
  isNamedRow,
  nextPageSequence,
  restoredSummary,
  usedPageNames,
  type CaptureRow,
  type CaptureSession,
} from "../shared/capture";
import {
  draftEdit,
  draftForRow,
  draftTestReport,
  type CaptureRowDraft,
} from "../shared/captureDraft";
import { selectorVerdict } from "../shared/selectorMatch";
import {
  captureLibraryCounts,
  captureLibrarySummary,
  joinCaptureLibrary,
  type CaptureListRow,
} from "../shared/captureLibrary";
import { accountGreeting } from "../shared/greeting";
import {
  canTrainForms,
  DEFAULT_PANEL_MODE,
  fallbackModeFor,
  isCaptureMode,
  type PanelMode,
} from "../shared/panelMode";
import {
  CAPTURE_TAB_MISMATCH_ERROR,
  captureStateSummary,
  decideCaptureStart,
  derivePageStep,
  formCaptureState,
  pageUrlTail,
  portalTargetLabel,
  resolveTrainRecognition,
} from "../shared/trainForms";
import {
  browseableProviders,
  providerGroupsLabel,
  providerMatchesQuery,
} from "../shared/browseProviders";
import {
  findSandboxProvider,
  sandboxClearView,
  sandboxEntryTitle,
  sandboxFillState,
  sandboxFillView,
  sandboxProfileName,
  SANDBOX_ENTRY_META,
  SANDBOX_NO_FORM_NOTE,
  SANDBOX_UNAVAILABLE_NOTE,
  type SandboxFillSummary,
} from "../shared/sandbox";
import { providerDisplayName } from "../shared/providerName";
import {
  STRUCTURED_TOUCH_TYPES,
  TOUCH_DISPOSITIONS,
  validateStructuredTouch,
  type StructuredTouchDraft,
} from "../shared/structuredTouch";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Warn before logging a second submission on a case recently marked submitted.
// The human can still log anyway (one click).
const DUPLICATE_WINDOW_DAYS = 14;

// The registry-level site access ask (#portal-access). Case work fills these
// sites; training captures them, and keeps its own wording.
const CASE_ACCESS_TEXT =
  "On a payer form? Allow Minted on your organization's payer sites so it can fill them.";
const CASE_ACCESS_BUTTON = "Allow Minted on payer sites";
const TRAIN_ACCESS_TEXT =
  "On a payer portal? Give Minted access to this organization's portal sites so it can capture and fill their forms.";
const TRAIN_ACCESS_BUTTON = "Enable form capture & fill";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const views = {
  loading: el<HTMLElement>("view-loading"),
  signin: el<HTMLElement>("view-signin"),
  main: el<HTMLElement>("view-main"),
};
// Mode chooser and Train-forms UI.
const modeSearchBtn = el<HTMLButtonElement>("mode-search");
const modeCaseBtn = el<HTMLButtonElement>("mode-case");
const modeTrainBtn = el<HTMLButtonElement>("mode-train");
const trainSection = el<HTMLElement>("train-section");
const trainPayer = el<HTMLSelectElement>("train-payer");
const trainRecognition = el<HTMLElement>("train-recognition");
const trainPortalField = el<HTMLElement>("train-portal-field");
const trainPortal = el<HTMLSelectElement>("train-portal");
const trainHint = el<HTMLElement>("train-hint");
const trainDryRunSection = el<HTMLElement>("train-dry-run");
const trainProvenChip = el<HTMLElement>("train-proven-chip");
const runMockDryRunBtn = el<HTMLButtonElement>("run-mock-dry-run");
const markPortalProvenBtn = el<HTMLButtonElement>("mark-portal-proven");
const mockDryRunStatus = el<HTMLElement>("mock-dry-run-status");
const mockDryRunSkipped = el<HTMLElement>("mock-dry-run-skipped");
const mockDryRunGaps = el<HTMLElement>("mock-dry-run-gaps");
const orgField = el<HTMLElement>("org-field");
const signoutBtn = el<HTMLButtonElement>("signout");
const accountRow = el<HTMLElement>("account-row");
const avatarBtn = el<HTMLButtonElement>("avatar-btn");
const avatarMenu = el<HTMLElement>("avatar-menu");
const orgContext = el<HTMLElement>("org-context");
const signinForm = el<HTMLFormElement>("signin-form");
const emailInput = el<HTMLInputElement>("email");
const passwordInput = el<HTMLInputElement>("password");
const signinBtn = el<HTMLButtonElement>("signin-btn");
const signinError = el<HTMLElement>("signin-error");
const signinHandoffHint = el<HTMLElement>("signin-handoff-hint");
const signinExpiredHint = el<HTMLElement>("signin-expired-hint");
const accountEmail = el<HTMLElement>("account-email");
const accountVersion = el<HTMLElement>("account-version");
const panelVersion = el<HTMLElement>("panel-version");
const identityGuard = el<HTMLElement>("identity-guard");
const orgSelect = el<HTMLSelectElement>("org-select");
const handoffBanner = el<HTMLElement>("handoff-banner");
const searchSection = el<HTMLElement>("search-section");
const searchInput = el<HTMLInputElement>("search-input");
const searchResults = el<HTMLElement>("search-results");
const refreshBtn = el<HTMLButtonElement>("refresh");
const caseWork = el<HTMLElement>("case-work");
const providerBar = el<HTMLElement>("provider-bar");
const providerBarName = el<HTMLElement>("provider-bar-name");
const providerBarSwitch = el<HTMLButtonElement>("provider-bar-switch");
const groupField = el<HTMLElement>("group-field");
const groupSelect = el<HTMLSelectElement>("group-select");
const facilitySelect = el<HTMLSelectElement>("facility-select");
const facilityHint = el<HTMLElement>("facility-hint");
const facilityAddress = el<HTMLElement>("facility-address");
// Case location list (read-only; #facility-select is the fill target).
// Shown beside the facility picker for context.
const caseLocationsList = el<HTMLElement>("case-locations-list");
const mainError = el<HTMLElement>("main-error");
const providerCard = el<HTMLElement>("provider-card");
const providerName = el<HTMLElement>("provider-name");
const providerDob = el<HTMLElement>("provider-dob");
const providerIds = el<HTMLElement>("provider-ids");
const openInPanelLink = el<HTMLAnchorElement>("open-in-panel");
const groupCard = el<HTMLElement>("group-card");
const groupName = el<HTMLElement>("group-name");
const groupIds = el<HTMLElement>("group-ids");
const activeCasesBox = el<HTMLElement>("active-cases");
const activeCasesList = el<HTMLElement>("active-cases-list");
const viewSettingsBtn = el<HTMLButtonElement>("view-settings-btn");
const viewSettings = el<HTMLElement>("view-settings");
const viewSettingsFields = el<HTMLElement>("view-settings-fields");
const viewSettingsError = el<HTMLElement>("view-settings-error");
const viewSettingsSave = el<HTMLButtonElement>("view-settings-save");
const viewSettingsCancel = el<HTMLButtonElement>("view-settings-cancel");
const fillSection = el<HTMLElement>("fill-section");
const caseFill = el<HTMLElement>("case-fill");
const caseSelect = el<HTMLSelectElement>("case-select");
const caseStatusPill = el<HTMLElement>("case-status");
const caseNote = el<HTMLElement>("case-note");
const caseContextBox = el<HTMLElement>("case-context");
const portalStatus = el<HTMLElement>("portal-status");
const coveragePanel = el<HTMLElement>("coverage-panel");
const provenChip = el<HTMLElement>("proven-chip");
const driftStrip = el<HTMLElement>("drift-strip");
const unprovenNote = el<HTMLElement>("unproven-note");
const dupPickup = el<HTMLElement>("dup-pickup");
const caqhSection = el<HTMLElement>("caqh-section");
const caqhHeadline = el<HTMLElement>("caqh-headline");
const caqhAttested = el<HTMLElement>("caqh-attested");
const caqhAttest = el<HTMLButtonElement>("caqh-attest");
const caqhStatus = el<HTMLElement>("caqh-status");
const portalRegistryEmpty = el<HTMLElement>("portal-registry-empty");
const portalAccess = el<HTMLElement>("portal-access");
const portalAccessGrant = el<HTMLButtonElement>("portal-access-grant");
const portalAccessText = el<HTMLElement>("portal-access-text");
const workPortalAccess = el<HTMLElement>("work-portal-access");
const workPortalAccessGrant = el<HTMLButtonElement>("work-portal-access-grant");
const captureSection = el<HTMLElement>("capture-section");
const captureSummary = el<HTMLElement>("capture-summary");
const captureStart = el<HTMLButtonElement>("capture-start");
const captureNextPage = el<HTMLButtonElement>("capture-next-page");
const captureAddField = el<HTMLButtonElement>("capture-add-field");
const capturePickStatus = el<HTMLElement>("capture-pick-status");
const captureBatch = el<HTMLElement>("capture-batch");
const captureBatchCount = el<HTMLElement>("capture-batch-count");
const captureBatchDelete = el<HTMLButtonElement>("capture-batch-delete");
const captureBatchClear = el<HTMLButtonElement>("capture-batch-clear");
const sandboxEntry = el<HTMLButtonElement>("sandbox-entry");
const sandboxEntryHeading = el<HTMLElement>("sandbox-entry-title");
const sandboxEntryMeta = el<HTMLElement>("sandbox-entry-meta");
const sandboxUnavailable = el<HTMLElement>("sandbox-unavailable");
const sandboxBar = el<HTMLElement>("sandbox-bar");
const sandboxBarNote = el<HTMLElement>("sandbox-bar-note");
const sandboxFillBtn = el<HTMLButtonElement>("sandbox-fill");
const sandboxClearBtn = el<HTMLButtonElement>("sandbox-clear");
const sandboxExitBtn = el<HTMLButtonElement>("sandbox-exit");
const sandboxResult = el<HTMLElement>("sandbox-result");
const captureRestored = el<HTMLElement>("capture-restored");
const captureRows = el<HTMLElement>("capture-rows");
const captureActions = el<HTMLElement>("capture-actions");
const captureSend = el<HTMLButtonElement>("capture-send");
const captureClear = el<HTMLButtonElement>("capture-clear");
const captureSent = el<HTMLElement>("capture-sent");
const coverageCount = el<HTMLElement>("coverage-count");
const coverageGaps = el<HTMLUListElement>("coverage-gaps");
const refreshMapsBtn = el<HTMLButtonElement>("refresh-maps-btn");
const fillBtn = el<HTMLButtonElement>("fill-btn");
const fillNote = el<HTMLElement>("fill-note");
const fillResults = el<HTMLElement>("fill-results");
const fillReportTime = el<HTMLElement>("fill-report-time");
const fillSummaryBox = el<HTMLElement>("fill-summary");
const fillAttemptedBox = el<HTMLElement>("fill-attempted");
const fillNotCheckedBox = el<HTMLElement>("fill-not-checked");
const fillAiReview = el<HTMLElement>("fill-ai-review");
const fillAiStatus = el<HTMLElement>("fill-ai-status");
const fillAiAcceptBtn = el<HTMLButtonElement>("fill-ai-accept");
const fillAiClearBtn = el<HTMLButtonElement>("fill-ai-clear");
const fillAiRetryBtn = el<HTMLButtonElement>("fill-ai-retry");
const fillSkippedBox = el<HTMLElement>("fill-skipped");
const fillManualBox = el<HTMLElement>("fill-manual");
const fillEventWarn = el<HTMLElement>("fill-event-warn");
const gapFlag = el<HTMLElement>("gap-flag");
const submitDetails = el<HTMLElement>("submit-details");
const payerRefInput = el<HTMLInputElement>("payer-ref-input");
const wipNoteInput = el<HTMLTextAreaElement>("wip-note-input");
const taskLink = el<HTMLElement>("task-link");
const taskLinkSingle = el<HTMLElement>("task-link-single");
const submitMoves = el<HTMLElement>("submit-moves");
const submitTitle = el<HTMLElement>("submit-title");
const payerRefLabel = el<HTMLLabelElement>("payer-ref-label");
const dupWarn = el<HTMLElement>("dup-warn");
const dupCancelBtn = el<HTMLButtonElement>("dup-cancel");
const submitBackBtn = el<HTMLButtonElement>("submit-back");
const submitNext = el<HTMLElement>("submit-next");
const logLink = el<HTMLButtonElement>("log-link");
const markSubmittedBtn = el<HTMLButtonElement>("mark-submitted");
const submitStatus = el<HTMLElement>("submit-status");
const touchSection = el<HTMLElement>("touch-section");
const touchType = el<HTMLSelectElement>("touch-type");
const touchNote = el<HTMLInputElement>("touch-note");
const touchOutcome = el<HTMLSelectElement>("touch-outcome");
const touchFollowup = el<HTMLInputElement>("touch-followup");
const touchRecipientName = el<HTMLInputElement>("touch-recipient-name");
const touchRecipientContact = el<HTMLInputElement>("touch-recipient-contact");
const touchTracking = el<HTMLInputElement>("touch-tracking");
const touchError = el<HTMLElement>("touch-error");
const touchSaveBtn = el<HTMLButtonElement>("touch-save");
const touchStatus = el<HTMLElement>("touch-status");
const nbaSection = el<HTMLElement>("nba-section");
const queueSection = el<HTMLElement>("queue-section");
// 0.1.8 task card, the three collapsible sections, and the A6 org prompt.
const orgSwitch = el<HTMLElement>("org-switch");
const taskCard = el<HTMLElement>("task-card");
const taskToggle = el<HTMLButtonElement>("task-toggle");
const taskBody = el<HTMLElement>("task-body");
const taskTitle = el<HTMLElement>("task-title");
const taskPill = el<HTMLElement>("task-pill");
const taskSub = el<HTMLElement>("task-sub");
const taskOrigin = el<HTMLElement>("task-origin");
const taskBack = el<HTMLAnchorElement>("task-back");
const taskNotice = el<HTMLElement>("task-notice");
const readyTitle = el<HTMLElement>("ready-title");
const workAccessTitle = el<HTMLElement>("work-access-title");
const workAccessNote = el<HTMLElement>("work-access-note");
const fillProblem = el<HTMLElement>("fill-problem");
const fillYourTurn = el<HTMLElement>("fill-your-turn");
const fillAgainBtn = el<HTMLButtonElement>("fill-again");
const fillDetails = el<HTMLDetailsElement>("fill-details");
const fillDetailsBody = el<HTMLElement>("fill-details-body");
const openTaskLink = el<HTMLAnchorElement>("open-task-link");
const providerToggle = el<HTMLButtonElement>("provider-toggle");
const providerBody = el<HTMLElement>("provider-body");
const touchToggle = el<HTMLButtonElement>("touch-toggle");
const touchBody = el<HTMLElement>("touch-body");

// The last successful fill, held so "Mark submitted" can log the touch
// against the right case and fill session. Cleared whenever the selection
// changes or a new fill starts; restored from the persisted report when the
// panel reopens.
interface LastFill {
  providerId: string;
  caseId: string | null;
  portalKey: string;
  fillSessionId: string | null;
  isWorkFill: boolean;
  workContext: CanonicalWorkContextTuple | null;
  workCaseType: FillSummary["workCaseType"] | null;
  submitted: boolean;
}

function renderExtensionVersion(): void {
  const info = getExtensionVersionInfo();
  panelVersion.textContent = info.displayVersion;
  panelVersion.setAttribute("title", info.tooltip);
  accountVersion.textContent = info.displayVersion;
  accountVersion.setAttribute("title", info.tooltip);
}
renderExtensionVersion();

let selectedGroupId: string | null = null;
let fillSelectionRevision = 0;
let groupSelectionWrite: Promise<void> = Promise.resolve();
function syncSelectedGroup(): Promise<void> {
  const providerId = selectedProviderId();
  const groupId = selectedGroupId;
  if (!providerId) return Promise.resolve();
  groupSelectionWrite = groupSelectionWrite.catch(() => undefined).then(async () => {
    const response = await sendToBackground({ type: "SET_SELECTED_GROUP", providerId, groupId });
    if (!response.ok) throw new Error(response.error);
  });
  return groupSelectionWrite;
}

let lastAiReview: AiFillReview | null = null;
let lastFillTabId: number | null = null;
let lastFillPageUrl: string | null = null;

let orgs: UserOrgMembership[] = [];
// The multi-org pick (the worker sends it as x-org-id). Stays null in
// single-org mode — the server resolves the sole membership, no header.
let activeOrgId: string | null = null;
let providers: ProviderListItem[] = [];
let cases: CaseListItem[] = [];
// The provider whose case list last loaded; null while loading or after a
// failed read, so an empty list only reads as "no open cases" when it is.
let casesLoadedFor: string | null = null;
let facilities: ProviderProfileFacility[] = [];
let facilitiesLoaded = false;
// meta.needs_facility from the profile: several locations, server won't
// guess — the fill gate stays closed until the user picks one.
let needsFacility = false;
let portal: MatchedPortal | null = null;
let portalTabId: number | null = null;
let activeWorkState: ActiveWorkState = { status: "none" };
// Portal registry from the API, held in memory per org.
// Empty until the org resolves — matchPortalByUrl over [] recognizes nothing,
// which is the correct signed-out/org-less posture.
let portalRows: PortalRegistryRow[] = [];
let portalRegistryLoaded = false;
let workPortalAccessCandidate: (WorkPortalPermissionTarget & { pattern: string }) | null = null;
let portalAccessPromptRevision = 0;
// Panel mode and the shared portal registry used in Train forms.
// against. The worker owns the mode — it decides whether a call carries
// x-org-id — so the panel mirrors it rather than being its source of truth.
let panelMode: PanelMode = DEFAULT_PANEL_MODE;

// Has an org resolved? Every org-scoped surface (Search's results and all of
// Work cases) stays hidden until it has — a single-org user resolves the
// moment memberships load; a multi-org one after picking.
let orgReady = false;
// Have memberships (and therefore ROLES) arrived? Until they have, "may this
// user train?" is unknown, and the honest render is to leave the Train button
// as it was rather than flash it away and back.
let membershipsLoaded = false;
let sharedPortalRows: PortalRegistryRow[] = [];
// The shared field maps of the recognized form, for the "what this form
// already has" read-out. Empty for a form nothing has captured yet.
let trainFormMaps: PortalFieldMap[] = [];
let lastMockDryRunTarget: string | null = null;
let trainTargetIdentity: string | null = null;
let trainTargetRevision: number | null = null;
let desiredTrainTargetIdentity: string | null = null;
let trainTargetSyncTail: Promise<void> = Promise.resolve();
let trainRecognitionRevision = 0;
let trainRegistryRevision = 0;
let trainUrlCandidates: MatchedPortal[] = [];
let lastFill: LastFill | null = null;
// First "Mark submitted" click on a recently submitted case shows a warning;
// the next click logs anyway. Reset on selection change or a fresh fill.
let dupConfirmPending = false;
// 0.1.8 close-out and task card state.
type SubmitPhase = "idle" | "form" | "logging" | "done" | "failed";
let submitPhase: SubmitPhase = "idle";
let lastLogFailure: LogFailureView | null = null;
let lastLogMoved = false;
// The case and Work launch the log form, its entries and its result belong
// to (logScopeKey). A page change inside it keeps them; a different case or a
// new launch starts fresh. Null while nothing is being logged.
let logScope: string | null = null;
// The fill result on screen (null = none). Drives the pill and Details.
let lastSummary: FillSummary | null = null;
let fillRunning = false;
// Chrome said no to the one-time site access ask (B8).
let workAccessDenied = false;
// The attention state the task card last opened itself for (5a).
let taskAttentionKey: string | null = null;
// The state Provider details last opened itself for (fill by hand, access
// not allowed). It opens once per state, so closing it sticks.
let providerAttentionKey: string | null = null;
// The last coverage read, so the offer can be hidden and shown again.
let lastCoverage: FillCoverage | null = null;
// The tab the panel last detected, so a Work launch can tell "another tab"
// from "this tab left the form".
let detectedTabId: number | null = null;
// Coverage fetch key — de-dupes refreshCoverage calls. Null when not fill-ready.
// Depends on provider, facility, portal, and state — not the case.
let coverageKey: string | null = null;
// Case context fetch key — de-dupes refreshCaseContext calls. Null when no case
// is selected. With the generation guard, stale responses are discarded.
let caseContextCaseId: string | null = null;
// The last rendered case context — feeds the identity guard header and the
// case-selected facility auto-pick. In-memory only, cleared with the case.
let caseContextData: CaseContext | null = null;
// When a case is freshly chosen (search / dropdown / NBA / handoff), the
// case's facility_id wins over a remembered provider location. Cleared after
// maybeApplyCaseFacility runs (or when the case has no facility).
let preferCaseFacility = false;
// Active-case record from the worker and its expiry status. Re-read on open,
// on ACTIVE_CASE_UPDATED, and on a slow poll (expiry has a clock).
let activeCase: ActiveCaseRecord | null = null;
let activeCaseStatus: "none" | "active" | "expired" = "none";
// The exact receipt + selection tuple the worker accepted. Provenance, Fill,
// and case-write UI stay gated if any current picker drifts from this tuple.
let appliedHandoffSelection: AppliedHandoffSelection | null = null;
// While a received handoff is undergoing authenticated reads, no fill can use
// its partially loaded selection. Only the final pure application gate moves
// its exact tuple to appliedHandoffSelection.
let applyingHandoffKey: string | null = null;
// Terminal authenticated failures for one receipt. Cleared only by a newer
// receipt key so the 30s poll cannot re-hit audited profile/case reads.
let rejectedHandoffKey: string | null = null;
// Work launches the panel is still loading (B1). A counter, because a second
// launch can land while the first load is in flight.
let workLaunchesOpening = 0;
// Structured-touch idempotency id — created when a
// draft first saves, REUSED on every retry (a retry can never double-log),
// regenerated only after a success.
let touchDraftId: string | null = null;
// Unified search bookkeeping: debounce timer + a sequence counter so a slow
// response for an old query never renders over a newer one.
let searchTimer: number | undefined;
let searchSeq = 0;

// Drop stale async results after a provider/org/case switch.
// Each loader captures loadGeneration at start; after every await, discard
// the result if a newer switch bumped the counter. Prevents wrong-record fills.
let loadGeneration = 0;
function bumpGeneration(): number {
  return ++loadGeneration;
}

// ---------------------------------------------------------------------------
// 0.1.8: three collapsible sections (task card, Provider details, Log a call,
// email, or note). Open or closed is a per-viewer convenience kept in
// localStorage as a boolean; the task card also opens on its own when it
// needs the coordinator (PM decision 5a).
// ---------------------------------------------------------------------------
type SectionKey = "task" | "provider" | "touch";
const SECTION_DEFAULTS: Record<SectionKey, boolean> = { task: true, provider: false, touch: false };
const sectionParts: Record<SectionKey, { toggle: HTMLButtonElement; body: HTMLElement }> = {
  task: { toggle: taskToggle, body: taskBody },
  provider: { toggle: providerToggle, body: providerBody },
  touch: { toggle: touchToggle, body: touchBody },
};

function readSectionOpen(key: SectionKey): boolean {
  try {
    const stored = localStorage.getItem(`minted.section.${key}`);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    // Storage blocked: the defaults stand.
  }
  return SECTION_DEFAULTS[key];
}

function setSectionOpen(key: SectionKey, open: boolean, remember = false): void {
  const { toggle, body } = sectionParts[key];
  toggle.setAttribute("aria-expanded", String(open));
  body.hidden = !open;
  if (!remember) return;
  try {
    localStorage.setItem(`minted.section.${key}`, open ? "1" : "0");
  } catch {
    // Not remembered; the section still toggles.
  }
}

for (const key of Object.keys(sectionParts) as SectionKey[]) {
  setSectionOpen(key, readSectionOpen(key));
  sectionParts[key].toggle.addEventListener("click", () => {
    setSectionOpen(key, sectionParts[key].toggle.getAttribute("aria-expanded") !== "true", true);
  });
}

// The role in the org the panel is working as. Admin Details follow THIS
// org's role, not canTrainForms (admin in any org).
function currentMembership(): UserOrgMembership | null {
  return orgs.length === 1
    ? (orgs[0] ?? null)
    : (orgs.find((o) => o.orgId === activeOrgId) ?? null);
}

function isCurrentOrgAdmin(): boolean {
  return currentMembership()?.role === "admin";
}

function isCurrentOrgReadOnly(): boolean {
  return currentMembership()?.role === "billing";
}

// "Copy support code": version, short case and fill ids, time, error code.
// No names and no values, so a specialist can paste it anywhere.
function supportButton(
  code: string | number | null,
  fillId: string | null = null,
  tone: "danger" | "plain" = "plain",
): HTMLButtonElement {
  const text = supportCode({
    version: getExtensionVersionInfo().version,
    caseId: selectedCaseId(),
    fillId,
    at: new Date(),
    code,
  });
  const button = document.createElement("button");
  button.type = "button";
  button.className = tone === "danger" ? "link support-code danger" : "link support-code";
  button.textContent = "Copy support code";
  button.title = text;
  button.addEventListener("click", () => {
    void navigator.clipboard.writeText(text).then(
      () => {
        button.textContent = "Support code copied";
      },
      () => {
        // Clipboard refused: show the code so it can be copied by hand.
        button.textContent = text;
      },
    );
  });
  return button;
}

type NoticeTone = "ok" | "warn" | "danger" | "neutral";
type NoticeLine = string | { text: string; strong?: boolean };

// One notice box: tone, lines (the first may be a bold headline), then any
// buttons or links. Replaces the box's content and shows it.
function fillNotice(
  box: HTMLElement,
  tone: NoticeTone,
  lines: readonly NoticeLine[],
  extra: readonly HTMLElement[] = [],
): void {
  box.className = `notice notice-${tone}`;
  box.replaceChildren();
  for (const line of lines) {
    const span = document.createElement("span");
    if (typeof line === "string") {
      span.textContent = line;
    } else {
      span.textContent = line.text;
      if (line.strong) span.className = "notice-headline";
    }
    box.append(span);
  }
  box.append(...extra);
  box.hidden = false;
}

function externalLink(label: string, href: string, className = "link"): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = className;
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  return link;
}

function caseUrl(caseId: string): string {
  return caseReturnUrl(API_BASE_URL, caseId);
}

function taskUrl(taskId: string): string {
  return new URL(`/tasks/${encodeURIComponent(taskId)}`, API_BASE_URL).toString();
}
function isCurrent(generation: number): boolean {
  return generation === loadGeneration;
}

function showView(name: keyof typeof views): void {
  for (const [key, section] of Object.entries(views)) {
    section.hidden = key !== name;
  }
  accountRow.hidden = name !== "main";
  if (name !== "main") closeAvatarMenu();
}

function setError(box: HTMLElement, message: string | null): void {
  box.hidden = message == null;
  box.textContent = message ?? "";
}

// Currently selected provider id (set by search, case pick, handoff, or restore).
let selectedProvider: string | null = null;

function selectedProviderId(): string | null {
  return selectedProvider;
}

/** Set (or clear) the selection. Rejects a non-uuid the same way reading the
 * dropdown's placeholder value used to. */
function setSelectedProviderId(id: string | null): void {
  if (selectedProvider !== id) invalidateFillSelection();
  selectedProvider = id != null && UUID_RE.test(id) ? id : null;
  renderSelectedProvider();
}

function selectedCaseId(): string | null {
  const value = caseSelect.value;
  return UUID_RE.test(value) ? value : null;
}

function selectedFacilityId(): string | null {
  const value = facilitySelect.value;
  return UUID_RE.test(value) ? value : null;
}

// Single org resolves by itself (read-only, no header); several need a pick.
function orgResolved(): boolean {
  return orgs.length === 1 || (orgs.length > 1 && activeOrgId != null);
}

function activeWorkRecordForTab(
  tab: Pick<chrome.tabs.Tab, "id"> | null,
  pageUrl: string | null,
): ActiveWorkRecord | null {
  if (activeWorkState.status !== "active" || tab?.id == null) return null;
  const record = activeWorkState.record;
  return record.boundTabId === tab.id && workFormUrlMatchesPage(pageUrl ?? undefined, record.formOrigin, record.formPath)
    ? record
    : null;
}

/** Tabs only expose URL fields after host access is granted. Work already has
 * webNavigation permission, so use its main-frame URL for the exact bound-tab
 * path; legacy recognition keeps its existing tabs.url behavior. */
async function activePageUrlForTab(
  tab: Pick<chrome.tabs.Tab, "id" | "url"> | null,
  useWorkFrameUrl: boolean,
): Promise<string | null> {
  if (tab == null) return null;
  if (!useWorkFrameUrl) return tab.url ?? null;
  if (tab.id == null) return null;
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 });
    return typeof frame?.url === "string" && frame.url !== "" ? frame.url : null;
  } catch {
    return null;
  }
}

function activeWorkStateIdentity(state: ActiveWorkState): string {
  if (state.status === "none") return "none";
  if (state.status === "blocked") return `blocked:${state.orgId ?? "none"}`;
  return `${state.status}:${state.record.tuple.launchReceiptId}:${state.record.boundTabId}`;
}

function matchedActiveWorkPortal(record: ActiveWorkRecord): MatchedPortal {
  return {
    portalId: record.tuple.portalId,
    orgId: record.tuple.orgId,
    key: record.tuple.portalKey,
    label: `${record.tuple.portalKey} · selected Work`,
    formUrl: `${record.formOrigin}${record.formPath}`,
    caseType: record.caseType,
    mappingGeneration: record.tuple.mappingGeneration,
    payerId: null,
    proven: false,
    verified: true,
  };
}

function providerLabel(p: ProviderListItem): string {
  const name = `${p.lastName}, ${p.firstName}`;
  return p.npi ? `${name} - ${p.npi}` : name;
}

// The locked dropdown wording: "<payer> - <state> - <status>".
function caseLabel(c: CaseListItem): string {
  return [
    c.payerName ?? "Unknown payer",
    c.state,
    c.status ?? "No status",
  ].join(" - ");
}

// Design pill colors for the statuses the design shows; any other label gets
// the neutral pill. Purely presentational — the label itself is rendered
// verbatim from the cases response.
function pillClassFor(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "submitted":
      return "pill-blue";
    case "in progress":
      return "pill-indigo";
    case "in-network":
    case "in network":
      return "pill-green";
    default:
      return "";
  }
}

// The selected case's status, as a pill on the Case label row (a native
// <select> can't carry pills inside its options or closed face).
function renderCaseStatusPill(): void {
  const id = selectedCaseId();
  const status = cases.find((c) => c.id === id)?.status ?? null;
  caseStatusPill.hidden = status == null;
  caseStatusPill.textContent = status ?? "";
  caseStatusPill.className =
    status == null ? "pill" : `pill ${pillClassFor(status)}`.trim();
}

function renderProviderCard(provider: ProviderListItem | null): void {
  providerCard.hidden = provider == null;
  fillSection.hidden = provider == null;
  // Card values arrive with the profile (loadFacilities), a beat after the
  // card; clear them here so a switch never shows the previous provider's
  // values — they live only in this render.
  renderQuickCards(null);
  renderActiveCases();
  if (!provider) return;
  providerName.textContent = providerDisplayName(
    `${provider.firstName} ${provider.lastName}`,
    provider.credentials,
    provider.specialty,
  );
  openInPanelLink.hidden = false;
  openInPanelLink.href = `${API_BASE_URL}${providerWebappPath(provider.id)}`;
}

// Quick Cards projected from one
// audited profile read. Held so the Edit Layout form can pre-check the fields
// the cards currently show. Values are in-memory only.
let currentCards: QuickCards | null = null;
// The served picker catalog (rides GET_PROVIDER_FACILITIES). Empty = the
// catalog read failed — the picker renders an honest failure note instead of
// a stale local list.
let currentCatalog: QuickCardCatalogField[] = [];
// Dead-selector count from the last fill on this portal —
// drives the drift strip. 0 = no known drift (also the pre-fill default).
let lastReportBrokenCount = 0;

// One ID-grid entry: monospace value with 1-click hover-copy, or an honest
// empty (muted em-dash, plus the profile's unresolved reason as its tooltip).
function idGridEntry(field: QuickCardField): [HTMLElement, HTMLElement] {
  const dt = document.createElement("dt");
  dt.textContent = field.label;
  const dd = document.createElement("dd");
  dd.classList.add("detail-row");
  if (field.value == null || field.value === "") {
    // Absent values read "Not on file" with an amber icon and are not
    // clickable; the profile's unresolved reason rides the tooltip.
    const empty = document.createElement("span");
    empty.className = "id-empty not-on-file";
    empty.textContent = "⚠ Not on file";
    if (field.reason) empty.title = field.reason;
    dd.append(empty);
  } else {
    const text = document.createElement("span");
    // Wrap, never truncate — long values break to the next line.
    text.className = "id-value mono wrap";
    text.textContent = looksLikeIsoDate(field.value)
      ? formatDisplayDate(field.value)
      : field.value;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "id-copy";
    copy.textContent = "Copy";
    copy.setAttribute("aria-label", `Copy ${field.label}`);
    copy.addEventListener(
      "click",
      () => void copyValue(field.value ?? "", copy, field.key, text),
    );
    if (copiedKeys.has(field.key)) dd.classList.add("copied-row");
    dd.append(text, copy);
  }
  return [dt, dd];
}

// One section per catalog group in the details area — heading, the
// picked fields of that group, and (when any field is absent) ONE fix
// footnote deep-linking the provider's webapp page. Groups render in served-
// catalog order; a group with no picked fields renders nothing.
function renderGroupedDetails(
  container: HTMLElement,
  fields: QuickCardField[],
  providerId: string | null,
): void {
  container.replaceChildren();
  container.hidden = fields.length === 0;
  if (fields.length === 0) return;

  const groupOf = new Map<string, { label: string; order: number }>();
  currentCatalog.forEach((f, i) => {
    if (!groupOf.has(f.group))
      groupOf.set(f.group, { label: f.groupLabel, order: i });
  });

  interface Section {
    group: string;
    label: string;
    order: number;
    fields: QuickCardField[];
  }
  const sections = new Map<string, Section>();
  for (const field of fields) {
    const prefix = field.key.split(".")[0] ?? "";
    const meta = groupOf.get(prefix) ?? {
      label: prefix,
      order: Number.MAX_SAFE_INTEGER,
    };
    let section = sections.get(prefix);
    if (!section) {
      section = {
        group: prefix,
        label: meta.label,
        order: meta.order,
        fields: [],
      };
      sections.set(prefix, section);
    }
    section.fields.push(field);
  }

  for (const section of [...sections.values()].sort(
    (a, b) => a.order - b.order,
  )) {
    const heading = document.createElement("p");
    heading.className = "detail-section-heading";
    heading.textContent = section.label;
    container.append(heading);
    const grid = document.createElement("dl");
    grid.className = "ids qc-grid";
    for (const field of section.fields) grid.append(...idGridEntry(field));
    container.append(grid);
    if (
      section.fields.some((f) => f.value == null || f.value === "") &&
      providerId
    ) {
      const note = document.createElement("a");
      note.className = "detail-fix-note";
      note.href = `${API_BASE_URL}${providerWebappPath(providerId)}`;
      note.target = "_blank";
      note.rel = "noreferrer";
      note.textContent = "Add missing details in Minted Panel ↗";
      container.append(note);
    }
  }
}

function renderQuickCards(cards: QuickCards | null): void {
  // A provider switch/sign-out clears the session copy marks — they are
  // per-provider (a copied NPI for Alex is not "copied" for Morgan).
  if (cards == null || cards !== currentCards) copiedKeys.clear();
  currentCards = cards;
  // Any cards change (provider switch, refetch) closes the layout form — it
  // must never show one provider's layout over another's card.
  closeViewSettings();
  viewSettingsBtn.hidden = cards == null;
  providerIds.replaceChildren();
  providerIds.hidden = cards == null;
  providerDob.hidden = cards == null;
  providerDob.textContent = "";
  groupCard.hidden = true;
  if (cards == null) return;

  // Type 1 header: name + DOB (bold, compact). The profile's name wins over
  // the list row's when present.
  if (cards.name) {
    providerName.textContent = providerDisplayName(
      cards.name,
      cards.credentials,
    );
  }
  providerDob.textContent = cards.dateOfBirth
    ? `DOB ${formatDisplayDate(cards.dateOfBirth)}`
    : "DOB not on file";

  renderGroupedDetails(providerIds, cards.type1Fields, selectedProviderId());
  // License facts live in the STATE LICENSE detail section from the layout —
  // no concatenated structural row (that duplicated number/state/expiration).

  // Type 2: the group card, visually divided from Type 1.
  groupCard.hidden = false;
  groupName.textContent = cards.groupName ?? "No group on file";
  groupName.classList.toggle("id-empty", cards.groupName == null);
  renderGroupedDetails(groupIds, cards.type2Fields, selectedProviderId());
  // No fixed Malpractice row: those groupInsurance.* fields are ordinary
  // catalog fields now, so they render through the layout above like any
  // other catalog fields.

  // Location tokens still empty after render? Retry once (see maybeRetryFacilityCards).
  maybeRetryFacilityCards();
}

// Retry facility cards once per provider+facility when location tokens stay unresolved.
// Usually fixes a race where a concurrent facilities load discarded a good response.
const retriedFacilityCards = new Set<string>();

function maybeRetryFacilityCards(): void {
  const providerId = selectedProviderId();
  const facilityId = selectedFacilityId();
  if (providerId == null || facilityId == null) return;
  const key = `${providerId}|${facilityId}`;
  // Gate logic is in shouldRetryFacilityCards (shared/quickCards.ts).
  if (
    !shouldRetryFacilityCards({
      facilitiesLoaded,
      facilityCount: facilities.length,
      cards: currentCards,
      alreadyRetried: retriedFacilityCards.has(key),
    })
  )
    return;
  retriedFacilityCards.add(key);
  void refreshFacilityCards(providerId, facilityId, loadGeneration);
}

function closeViewSettings(): void {
  viewSettings.hidden = true;
  viewSettingsFields.replaceChildren();
  setError(viewSettingsError, null);
  viewSettingsSave.disabled = false;
  viewSettingsSave.textContent = "Save layout";
}

// Edit Layout form: search over collapsible groups from the served catalog
// (GET /api/me/view-prefs `catalog`). Checkbox DOM order is the saved order;
// the served key set bounds what a layout can contain.
const viewSettingsSearch = el<HTMLInputElement>("view-settings-search");

interface PickerGroup {
  group: string;
  groupLabel: string;
  fields: QuickCardCatalogField[];
}

function groupCatalog(catalog: QuickCardCatalogField[]): PickerGroup[] {
  const groups: PickerGroup[] = [];
  const byKey = new Map<string, PickerGroup>();
  for (const field of catalog) {
    let group = byKey.get(field.group);
    if (!group) {
      group = { group: field.group, groupLabel: field.groupLabel, fields: [] };
      byKey.set(field.group, group);
      groups.push(group);
    }
    group.fields.push(field);
  }
  return groups;
}

// The picker's selection state, seeded from the current layout on open and
// mutated by checkbox clicks. Kept OUTSIDE the DOM so a search re-render
// never loses picks made on rows the filter currently hides.
let pickerSelection = new Set<string>();

function renderPickerRows(query: string): void {
  viewSettingsFields.replaceChildren();
  const q = query.trim().toLowerCase();
  const groups = groupCatalog(currentCatalog);
  let anyShown = false;

  for (const group of groups) {
    const matching = q
      ? group.fields.filter(
          (f) =>
            f.label.toLowerCase().includes(q) ||
            f.key.toLowerCase().includes(q) ||
            group.groupLabel.toLowerCase().includes(q),
        )
      : group.fields;
    // Empty groups hide under a query and when a group has no matches.
    if (matching.length === 0) continue;
    anyShown = true;

    const details = document.createElement("details");
    details.className = "view-settings-groupbox";
    // Matching groups auto-expand under a query; with no query, groups with
    // any picked field open, the rest start collapsed.
    const pickedCount = group.fields.filter((f) =>
      pickerSelection.has(f.key),
    ).length;
    details.open = q !== "" || pickedCount > 0;

    const summary = document.createElement("summary");
    summary.className = "view-settings-group";
    const name = document.createElement("span");
    name.textContent = group.groupLabel;
    const count = document.createElement("span");
    // "3 of 45" in primary when any picked, else "of 45" subtle.
    count.className =
      pickedCount > 0 ? "view-settings-count picked" : "view-settings-count";
    count.textContent =
      pickedCount > 0
        ? `${pickedCount} of ${group.fields.length}`
        : `of ${group.fields.length}`;
    summary.append(name, count);
    details.append(summary);

    for (const field of matching) {
      const row = document.createElement("label");
      row.className = "view-settings-field";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = field.key;
      checkbox.checked = pickerSelection.has(field.key);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) pickerSelection.add(field.key);
        else pickerSelection.delete(field.key);
        // Refresh the group counts without a full re-render churn.
        const picked = group.fields.filter((f) =>
          pickerSelection.has(f.key),
        ).length;
        count.className =
          picked > 0 ? "view-settings-count picked" : "view-settings-count";
        count.textContent =
          picked > 0
            ? `${picked} of ${group.fields.length}`
            : `of ${group.fields.length}`;
      });
      const text = document.createElement("span");
      text.textContent = field.label;
      row.append(checkbox, text);
      details.append(row);
    }
    viewSettingsFields.append(details);
  }

  if (!anyShown) {
    const empty = document.createElement("p");
    empty.className = "view-settings-empty";
    // No-results state echoes the query back.
    empty.textContent = q
      ? `No fields match "${query.trim()}".`
      : "The field list couldn't load. Close and reopen the panel to try again.";
    viewSettingsFields.append(empty);
  }
}

function openViewSettings(cards: QuickCards): void {
  setError(viewSettingsError, null);
  viewSettingsSearch.value = "";
  // Seed the selection from the current layout, keeping ONLY keys the served
  // catalog still offers (a key the server no longer serves can't be re-saved
  // anyway — the PUT would 422).
  const served = new Set(currentCatalog.map((f) => f.key));
  pickerSelection = new Set(cards.layout.filter((key) => served.has(key)));
  renderPickerRows("");
  viewSettings.hidden = false;
  viewSettingsSearch.focus();
}

viewSettingsSearch.addEventListener("input", () => {
  if (!viewSettings.hidden) renderPickerRows(viewSettingsSearch.value);
});

viewSettingsBtn.addEventListener("click", () => {
  const cards = currentCards;
  if (cards == null) return;
  if (!viewSettings.hidden) {
    closeViewSettings();
    return;
  }
  openViewSettings(cards);
});

viewSettingsCancel.addEventListener("click", () => closeViewSettings());

// Save the picked fields as the layout (PUT /api/me/view-prefs — server-side,
// persists across sessions), then refetch
// the profile so the cards re-project under the new layout. Order = the served
// catalog's listing order, i.e. exactly the order this picker shows.
viewSettingsSave.addEventListener("click", () => {
  const providerId = selectedProviderId();
  // The saved order IS the picker's order (see orderLayoutByCatalog): a field
  // ticked today lands where the list shows it, not appended after everything
  // saved earlier — which is what used to put First name pages from Last name.
  const fields = orderLayoutByCatalog(pickerSelection, currentCatalog);
  if (fields.length === 0) {
    setError(viewSettingsError, "Pick at least one field to show.");
    return;
  }
  const generation = loadGeneration;
  void (async () => {
    setError(viewSettingsError, null);
    viewSettingsSave.disabled = true;
    viewSettingsSave.textContent = "Saving…";
    const response = await sendToBackground({ type: "SET_VIEW_PREFS", fields });
    viewSettingsSave.disabled = false;
    viewSettingsSave.textContent = "Save layout";
    if (!isCurrent(generation)) return;
    if (!response.ok) {
      setError(viewSettingsError, response.error);
      return;
    }
    closeViewSettings();
    // The layout changed, not the selection — carry the current pick + case
    // state along so this reload resolves in one request instead of losing
    // without losing the current facility/state pick.
    if (providerId) {
      const state = selectedCaseState();
      await loadFacilities(providerId, generation, {
        facilityId: selectedFacilityId(),
        ...(state ? { state } : {}),
      });
    }
  })();
});

// Copy a single identifier to the clipboard. Copied rows stay marked for the
// session — the mark set clears on provider switch/sign-out via
// renderQuickCards(null). When the clipboard API is blocked, the fallback
// SELECTS the value text and says so, instead of failing silently.
const copiedKeys = new Set<string>();

async function copyValue(
  value: string,
  button: HTMLButtonElement,
  key?: string,
  valueNode?: HTMLElement,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = "Copied";
    button.classList.add("copied");
    if (key) {
      copiedKeys.add(key);
      button.closest(".detail-row")?.classList.add("copied-row");
    }
    window.setTimeout(() => {
      button.textContent = "Copy";
      button.classList.remove("copied");
    }, 1200);
  } catch {
    // Clipboard blocked (permission policy, headless contexts): select the
    // text so a manual Ctrl/Cmd+C works, and say what happened.
    if (valueNode) {
      const range = document.createRange();
      range.selectNodeContents(valueNode);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    button.textContent = "Copy blocked. Press Ctrl+C.";
    window.setTimeout(() => {
      button.textContent = "Copy";
    }, 2500);
  }
}

// Latest touchlog note for selected case, shown under the case
// picker. Hidden when no case is selected or the case has no note.
// Duplicate-work warning on case pickup (not at submit, where it
// arrives too late to save the work). Never blocks: "Continue anyway"
// dismisses it for this pickup, and "See the touchlog" opens the case in the
// webapp. Re-evaluated on every case change, so it survives a case switch.
const dismissedDupCaseIds = new Set<string>();

function renderDuplicateGuard(): void {
  const caseId = selectedCaseId();
  const caseItem = cases.find((c) => c.id === caseId);
  const phrase =
    caseId && !dismissedDupCaseIds.has(caseId)
      ? recentSubmissionPhrase(caseItem)
      : null;
  dupPickup.hidden = phrase == null;
  dupPickup.replaceChildren();
  if (phrase == null || caseId == null) return;

  const text = document.createElement("p");
  text.className = "dup-pickup-text";
  text.textContent = `This case was logged as submitted ${phrase}. Check before you work it again.`;
  dupPickup.append(text);

  const actions = document.createElement("div");
  actions.className = "dup-pickup-actions";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "link";
  dismiss.textContent = "Continue";
  dismiss.addEventListener("click", () => {
    dismissedDupCaseIds.add(caseId);
    renderDuplicateGuard();
  });
  actions.append(dismiss);

  const link = document.createElement("a");
  link.className = "link";
  link.href = `${API_BASE_URL}/cases/${caseId}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Open case ↗";
  actions.append(link);
  dupPickup.append(actions);
}

function renderCaseNote(): void {
  // B11: the list loaded and is empty. The ad hoc option stays in the picker.
  const providerId = selectedProviderId();
  const noCases = providerId != null && casesLoadedFor === providerId &&
    cases.length === 0 && selectedCaseId() == null
    ? providers.find((p) => p.id === providerId) ?? null
    : null;
  if (noCases != null) {
    const name = [noCases.firstName, noCases.lastName].filter(Boolean).join(" ");
    const line = document.createElement("span");
    line.className = "case-note-body";
    line.textContent = `${name} has no open cases. Search for another, or open Minted Panel.`;
    caseNote.replaceChildren(line);
    caseNote.hidden = false;
    return;
  }
  const id = selectedCaseId();
  const note = cases.find((c) => c.id === id)?.latestNote ?? null;
  caseNote.hidden = note == null;
  if (note == null) {
    caseNote.replaceChildren();
    return;
  }
  const label = document.createElement("span");
  label.className = "case-note-label";
  const who = note.author ? ` · ${note.author}` : "";
  label.textContent = `Latest note${who}`;
  const body = document.createElement("span");
  body.className = "case-note-body";
  body.textContent = note.text;
  caseNote.replaceChildren(label, body);
}

// Dates in the extension render as MM/DD/YYYY (see formatDisplayDate).
function fmtContextDate(iso: string): string {
  return formatDisplayDate(iso);
}


// "not_started" → "Not started" for the pipeline pill; the raw value is the
// server pipeline state key.
function humanizeStateKey(value: string): string {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Execution-type labels for open-task chips (read-only here:
// extension_fill tasks are the ones the Fill button serves; the rest are
// checklist context).
const EXECUTION_TYPE_LABELS: Record<string, string> = {
  manual: "Manual",
  extension_fill: "Auto-fill",
  auto_verify: "Auto verify",
  document_attach: "Document attach",
};

// Identity strip under the header always names the org the
// panel operates as, plus — once a case is active — the provider, payer/state,
// and selected facility. A multi-org user can never be silently filling from
// the wrong org or case.
function renderIdentityGuard(): void {
  const parts: string[] = [];
  const org =
    orgs.length === 1
      ? orgs[0]
      : (orgs.find((o) => o.orgId === activeOrgId) ?? null);
  if (org) parts.push(orgLabel(org));
  const caseId = selectedCaseId();
  const context = caseId != null ? caseContextData : null;
  if (context != null) {
    if (context.provider?.name) parts.push(context.provider.name);
    const payerState = [context.payer?.name, context.state]
      .filter(Boolean)
      .join(" · ");
    if (payerState) parts.push(payerState);
  } else {
    const provider = providers.find((p) => p.id === selectedProviderId());
    if (provider) parts.push(`${provider.firstName} ${provider.lastName}`);
  }
  const facility = facilities.find((f) => f.id === selectedFacilityId());
  if (facility && caseId != null) parts.push(facility.name || "Location");
  identityGuard.hidden = parts.length === 0;
  identityGuard.replaceChildren();
  parts.forEach((part, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "identity-sep";
      sep.textContent = "›";
      identityGuard.append(sep);
    }
    const span = document.createElement("span");
    span.className = index === 0 ? "identity-org" : "identity-part";
    span.textContent = part;
    identityGuard.append(span);
  });
}

// Adopt the case's facility into the location picker when present. (credential_cases.facility_id,
// resolved server-side — an explicit relationship, not a guess). When the
// context carries one, it becomes the location pick unless the user already
// picked; a fresh case selection (preferCaseFacility) overrides a remembered
// provider location so search → case lands on the case's practice site.
function maybeApplyCaseFacility(deferSelectionWrites = false): void {
  // Wait for both the facility list and case context — clearing preferCaseFacility
  // here would race loadFacilities finishing before GET_CASE_CONTEXT returns.
  if (!facilitiesLoaded || caseContextData == null) return;
  // Decision logic is in resolveCaseFacilitySelection (caseContext.ts); this
  // function applies the result to the DOM.
  const decision = resolveCaseFacilitySelection({
    selectedFacility: caseContextData.selectedFacility,
    facilityIds: facilities.map((f) => f.id),
    preferCaseFacility,
    currentFacilityId: selectedFacilityId(),
  });
  preferCaseFacility = false;
  if (!decision.apply) return;
  const providerId = selectedProviderId();
  if (decision.alreadyCurrent) {
    // Already on the case location — still re-resolve cards so PRACTICE
    // LOCATION isn't left "Not on file" from the needs_facility profile fetch.
    if (providerId)
      void refreshFacilityCards(providerId, decision.facilityId, loadGeneration);
    return;
  }
  facilitySelect.value = decision.facilityId;
  if (providerId) {
    if (!deferSelectionWrites) {
      void sendToBackground({
        type: "SET_SELECTED_FACILITY",
        providerId,
        facilityId: decision.facilityId,
      });
    }
    void refreshFacilityCards(providerId, decision.facilityId, loadGeneration);
  }
  renderFacilityAddress();
  updateFillReady();
}

/** Re-fetch profile for a facility pick so facility.* and assignment.* tokens resolve. */
async function refreshFacilityCards(
  providerId: string,
  facilityId: string,
  generation: number,
): Promise<void> {
  const state = selectedCaseState();
  const groupId = selectedGroupId;
  const caseId = selectedCaseId();
  const response = await sendToBackground({
    type: "GET_PROVIDER_FACILITIES",
    groupId,
    caseId,
    providerId,
    facilityId,
    ...(state ? { state } : {}),
  });
  // Discard stale responses — never paint another provider's cards.
  if (
    isCurrent(generation) &&
    selectedProviderId() === providerId &&
    selectedFacilityId() === facilityId &&
    selectedGroupId === groupId &&
    selectedCaseId() === caseId &&
    response.ok
  ) {
    needsFacility = response.data.needsFacility;
    currentCatalog = response.data.catalog;
    renderQuickCards(response.data.cards);
    renderFacilityAddress();
    renderIdentityGuard();
    updateFillReady();
  }
  // Retry once even if this response was discarded (concurrent load race).
  maybeRetryFacilityCards();
}

// Touch type value → its label ("portal" → "Portal Check").
function touchTypeLabel(value: string | null): string | null {
  if (value == null) return null;
  return STRUCTURED_TOUCH_TYPES.find((t) => t.value === value)?.label ?? humanizeStateKey(value);
}

function caseDetailRow(label: string, value: string, mono = false): void {
  const term = document.createElement("span");
  term.className = "case-context-label";
  term.textContent = label;
  const detail = document.createElement("span");
  detail.className = mono ? "case-context-value mono" : "case-context-value";
  detail.textContent = value;
  caseContextBox.append(term, detail);
}

// Case details at the foot of the task card: status, payer reference, last
// touch, last note. Read-only. The task list and step checkboxes are gone in
// 0.1.8 (current task only; step work lives in Minted Panel).
function renderCaseContext(
  context: CaseContext | null,
  deferSelectionWrites = false,
): void {
  caseContextData = context;
  caseContextBox.replaceChildren();
  // Rescope #facility-select to this case's locations (or widen back to the
  // provider's full set) BEFORE maybeApplyCaseFacility runs, so the case's
  // primary has an <option> to land on.
  rescopeFacilitySelectOptions();
  renderCaseLocations(context);
  // Adopt the case's facility even when the case has nothing else to show.
  maybeApplyCaseFacility(deferSelectionWrites);
  renderIdentityGuard();
  caseContextBox.hidden = context == null;
  if (context != null) {
    const status = caseStatusNow();
    const refs = context.referenceNumbers ?? [];
    const touch = context.latestTouch;
    const note = context.latestNote;
    caseDetailRow("Case status", status ?? "Not set");
    caseDetailRow("Payer reference", refs.length > 0 ? refs.join(", ") : "None yet", refs.length > 0);
    const touchText = touch == null
      ? ""
      : [
          touchTypeLabel(touch.touchType),
          touch.outcome ? humanizeStateKey(touch.outcome) : null,
          touch.touchDate ? fmtContextDate(touch.touchDate) : null,
        ].filter(Boolean).join(" · ");
    caseDetailRow("Last touch", touchText || "None yet");
    if (note != null) caseDetailRow("Last note", note.content);
  }
  renderTaskCard();
}

// Fetch and render the selected case's context whenever the case selection
// changes; hide the block when no case is selected. Mirrors the coverage
// sensor's staleness handling: it captures the case id AND the load generation
// at request time and discards the response on landing if a different case was
// selected (case switch — doesn't bump the generation) or a newer context
// superseded it (provider/org switch — does). Non-critical: on error it hides
// silently, never raising the error box.
let caseContextLoad: Promise<void> = Promise.resolve();
function refreshCaseContext(): Promise<void> {
  const caseId = selectedCaseId();
  // Same case already shown / in flight — leave the block as-is.
  if (caseId === caseContextCaseId) return caseContextLoad;
  caseContextCaseId = caseId;
  if (caseId == null) {
    renderCaseContext(null);
    caseContextLoad = Promise.resolve();
    return caseContextLoad;
  }
  // Hide while loading — the block is advisory, so no spinner/placeholder.
  renderCaseContext(null);
  const generation = loadGeneration;
  caseContextLoad = (async () => {
    const response = await sendToBackground({
      type: "GET_CASE_CONTEXT",
      caseId,
    });
    // Discard a stale response: a newer generation (provider/org switch) or a
    // different case selected while we were in flight.
    if (!isCurrent(generation) || caseId !== caseContextCaseId) return;
    renderCaseContext(response.ok ? response.data : null);
  })();
  return caseContextLoad;
}

// Prefill payer reference from the case and clear the WIP note on reselection.
function resetSubmitInputs(): void {
  const id = selectedCaseId();
  const caseItem = cases.find((c) => c.id === id) ?? null;
  payerRefInput.value = caseItem?.payerReferenceId ?? "";
  wipNoteInput.value = "";
}

// The selected case's status label ("In Progress"), from the case list.
function caseStatusNow(): string | null {
  const id = selectedCaseId();
  return cases.find((c) => c.id === id)?.status ?? null;
}

// The live Work launch, when it is for the selected case.
function workRecordForSelectedCase(): ActiveWorkRecord | null {
  if (activeWorkState.status !== "active") return null;
  const record = activeWorkState.record;
  const caseId = selectedCaseId();
  return caseId != null && record.tuple.ownerKind === "case" && record.tuple.ownerId === caseId
    ? record
    : null;
}

// The selected case arrived from Minted Panel and is still linked: a live
// Work launch, or an applied legacy handoff for this case.
function selectedCaseIsLaunched(): boolean {
  const caseId = selectedCaseId();
  return caseId != null && (workRecordForSelectedCase() != null ||
    (activeCase?.source === "handoff" && activeCase.caseId === caseId && currentHandoffSelectionIsApplied()));
}

// 0.1.8: a launched case pins the org, provider, group and case, so their
// pickers and the open-cases list step aside (`.launch-chrome` rows, hidden
// by CSS under `.is-launched`) until the link ends. The Location picker
// stays: it is the one fill-target control (E1.5). Work cases only; Search
// and Train forms keep their own chrome.
function renderLaunchChrome(): void {
  const launched = panelMode === "case" && selectedCaseIsLaunched();
  caseWork.classList.toggle("is-launched", launched);
  orgField.classList.toggle("is-launched", launched);
}

// The exact Work step this case is bound to: the live launch, or the saved
// fill report's tuple when the launch has since moved on.
function workTupleForSelectedCase(): CanonicalWorkContextTuple | null {
  const record = workRecordForSelectedCase();
  if (record != null) return record.tuple;
  const caseId = selectedCaseId();
  return lastFill?.isWorkFill && lastFill.caseId === caseId ? lastFill.workContext : null;
}

// Only enrollment case Work has a case submission. Contract,
// recredentialing and unknown case types log in Minted Panel (D7); the
// worker refuses anything else.
function workIsLoggable(): boolean {
  const record = workRecordForSelectedCase();
  if (record != null) {
    return record.tuple.ownerKind === "case" && record.caseType === "enrollment";
  }
  const caseId = selectedCaseId();
  if (lastFill?.isWorkFill && lastFill.caseId === caseId) {
    return lastFill.workContext?.ownerKind === "case" && lastFill.workCaseType === "enrollment";
  }
  return activeWorkState.status === "none" || activeWorkState.status === "blocked";
}

// The Work launch the selected case is under, live or timed out, else null.
// A timed-out launch keeps its id, so its log result stays readable.
function launchIdForSelectedCase(): string | null {
  if (activeWorkState.status !== "active" && activeWorkState.status !== "expired") return null;
  const tuple = activeWorkState.record.tuple;
  return tuple.ownerKind === "case" && tuple.ownerId === selectedCaseId() ? tuple.launchReceiptId : null;
}

// What a log belongs to: the case plus its Work launch ("manual" without
// one). Null when no case is picked.
function logScopeKey(): string | null {
  const caseId = selectedCaseId();
  return caseId == null ? null : `${caseId}|${launchIdForSelectedCase() ?? "manual"}`;
}

// Keeps the log form, its entries and its result through a page change in
// the same scope. A different case or a new launch starts fresh.
function dropLogStateOutsideScope(): void {
  if (submitPhase === "idle" || logScope === logScopeKey()) return;
  resetLogState();
  resetSubmitInputs();
}

function payerLabel(): string {
  const caseItem = cases.find((c) => c.id === selectedCaseId());
  return caseContextData?.payer?.name ?? caseItem?.payerName ?? "the payer";
}

// Open tasks on this case whose steps use the form on this tab. The case
// list names them; the context adds how many of their other steps are open.
function formTasks(): FormTask[] {
  if (portal == null) return [];
  const portalKey = portal.key;
  const caseItem = cases.find((c) => c.id === selectedCaseId());
  return matchPortalTasks(caseItem?.portalTasks, portalKey).map((match) => {
    const task = caseContextData?.openTasks?.find((t) => t.id === match.taskId);
    const otherOpenSteps = (task?.steps ?? [])
      .filter((step) => !step.isCompleted && step.portalKey !== portalKey).length;
    return { taskId: match.taskId, title: match.title, otherOpenSteps };
  });
}

// What logging will do, stated before the click (9.2). Work names its exact
// step; manual mode follows the fixed table and never shows a picker.
function currentPlan(): SubmissionPlan {
  const tuple = workTupleForSelectedCase();
  if (tuple != null && tuple.ownerKind === "case") {
    const task = caseContextData?.openTasks?.find((t) => t.id === tuple.taskId) ?? null;
    const step = task?.steps?.find((entry) => entry.id === tuple.stepId) ?? null;
    return {
      kind: "work",
      task: task == null
        ? null
        : {
            taskId: task.id,
            title: task.title,
            otherOpenSteps: (task.steps ?? []).filter((entry) => !entry.isCompleted && entry.id !== tuple.stepId).length,
          },
      stepLabel: step?.label ?? null,
    };
  }
  return { kind: "manual", tasks: formTasks() };
}

// The one task the card is about: the launched task, or the single task on
// this case that uses this form.
function taskForCard(): CaseContextTask | null {
  const tasks = caseContextData?.openTasks ?? [];
  // A timed-out launch still names its task, so the card keeps its title.
  const expired = activeWorkState.status === "expired" &&
    activeWorkState.record.tuple.ownerKind === "case" &&
    activeWorkState.record.tuple.ownerId === selectedCaseId()
    ? activeWorkState.record.tuple
    : null;
  const tuple = workTupleForSelectedCase() ?? expired;
  if (tuple != null && tuple.ownerKind === "case") {
    return tasks.find((t) => t.id === tuple.taskId) ?? null;
  }
  const matches = formTasks();
  const only = matches.length === 1 ? matches[0] : undefined;
  return only ? (tasks.find((t) => t.id === only.taskId) ?? null) : null;
}

// A Work launch is live but the coordinator is on another tab (B3, C8).
function workTabElsewhere(): boolean {
  if (activeWorkState.status !== "active") return false;
  return detectedTabId !== activeWorkState.record.boundTabId;
}

// Log it is offered on a recognized form for a picked or launched case, with
// or without a fill (B2). Never on ad hoc, read-only, or non-enrollment Work.
function canLogSubmission(): boolean {
  if (selectedCaseId() == null || isCurrentOrgReadOnly() || !currentSelectionAllowsCaseWork()) return false;
  if (!workIsLoggable() || activeWorkState.status === "expired") return false;
  // A launch keeps its case on any page of the payer's site in the launched
  // tab, so the confirmation page after Submit can log it (Q3).
  if (workRecordForSelectedCase() != null) return !workTabElsewhere();
  return portal != null;
}

// The launched tab is on a payer page that isn't the form (C6, D2).
function workOffForm(): boolean {
  return workRecordForSelectedCase() != null && !workTabElsewhere() && portal == null;
}

function computeTaskCardState(): TaskCardState {
  if (isCurrentOrgReadOnly()) return { kind: "readOnly" };
  if (activeWorkState.status === "expired") return { kind: "timedOut" };
  if (workTabElsewhere()) return { kind: "wrongTab" };
  if (!workPortalAccess.hidden) return workAccessDenied ? { kind: "denied" } : { kind: "access" };
  if (submitPhase === "logging") return { kind: "logging" };
  if (submitPhase === "done") return { kind: "logged", submitted: lastLogMoved };
  // A held log form shows only where it can be sent (renderLogControls).
  if (submitPhase === "failed" && (lastLogFailure?.retry !== true || canLogSubmission())) return { kind: "logFailed" };
  if (submitPhase === "form" && canLogSubmission()) return { kind: "log" };
  if (fillRunning) return { kind: "filling" };
  if (!fillProblem.hidden) return { kind: "failed" };
  if (lastSummary != null && !fillResults.hidden) {
    return lastSummary.filled > 0
      ? { kind: "filled", filled: lastSummary.filled, needYou: needsYou(lastSummary).length }
      : { kind: "nothing" };
  }
  if (workOffForm()) return { kind: "byHand" };
  if (portal == null) return { kind: "noForm" };
  if (caseSelect.value === AD_HOC_CASE_SELECTION) return { kind: "adHoc" };
  return { kind: "ready" };
}

function noticeButton(label: string, className: "primary" | "secondary", onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

// Brings the launched tab forward, and its window too: the tab may sit in
// another window. Best effort; a closed tab ends the link anyway.
async function focusTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    const windowId = tab?.windowId ?? (await chrome.tabs.get(tabId)).windowId;
    await chrome.windows.update(windowId, { focused: true });
  } catch {
    // The tab or window is gone; the worker ends the link.
  }
}

// What the task notice says now. A render with the same notice leaves the
// live region alone, so a screen reader doesn't read it again.
let taskNoticeKey: string | null = null;

function showTaskNotice(
  tone: NoticeTone,
  lines: readonly NoticeLine[],
  extra: readonly HTMLElement[] = [],
  salt = "",
): void {
  const key = JSON.stringify([tone, lines, extra.map((node) => node.outerHTML), salt]);
  if (!taskNotice.hidden && key === taskNoticeKey) return;
  taskNoticeKey = key;
  fillNotice(taskNotice, tone, lines, extra);
}

// The one notice for states where Fill is not the next step: view only,
// link timed out, wrong tab, and Work that logs in Minted Panel (D7).
// Returns true when it asks her to fill this page by hand.
function renderTaskNotice(state: TaskCardState, task: CaseContextTask | null): boolean {
  const payer = payerLabel();
  if (state.kind === "readOnly") {
    showTaskNotice("neutral", [
      { text: "Your account can view this case but not fill it.", strong: true },
      "Ask an admin to change your role. You can still copy values from Provider details.",
    ]);
    return false;
  }
  if (state.kind === "timedOut" && activeWorkState.status === "expired") {
    const caseId = activeWorkState.record.tuple.ownerKind === "case" ? activeWorkState.record.tuple.ownerId : null;
    showTaskNotice("neutral", [
      { text: "This link timed out after 60 minutes.", strong: true },
      "To keep provider data safe, Minted unlinks idle tabs. Open the case and click Work in portal again.",
    ], caseId == null ? [] : [externalLink("Back to case ↗", caseUrl(caseId), "secondary button-link")]);
    return false;
  }
  if (state.kind === "wrongTab" && activeWorkState.status === "active") {
    const tabId = activeWorkState.record.boundTabId;
    // A log form she opened waits for her on the launched tab.
    const next = submitPhase === "form" || submitPhase === "failed" ? "log it" : "fill";
    showTaskNotice("warn", [`You're on a different tab. Switch to the ${payer} tab to ${next}.`], [
      noticeButton(`Go to ${payer} tab`, "primary", () => {
        void focusTab(tabId);
      }),
    ], String(tabId));
    return false;
  }
  if (workOffForm() && submitPhase === "idle") {
    showTaskNotice("neutral", [
      "Minted hasn't learned this page yet. Fill it by hand. Provider details are open below.",
    ]);
    return true;
  }
  if (selectedCaseId() != null && !workIsLoggable() && activeWorkState.status === "active") {
    showTaskNotice("neutral", ["Log this work in Minted Panel."],
      task == null ? [] : [externalLink("Open task ↗", taskUrl(task.id), "link")]);
    return false;
  }
  taskNotice.hidden = true;
  taskNoticeKey = null;
  return false;
}

// Log it, the log form, and the result of logging. Pure DOM state; the
// handlers set submitPhase and call renderTaskCard. The form shows only
// where it can be sent; elsewhere it is held, entries and all.
function renderLogControls(state: TaskCardState): void {
  const payer = payerLabel();
  const canLog = canLogSubmission();
  const retrying = submitPhase === "failed" && lastLogFailure?.retry === true;
  // A refusal Try again can't fix: its result stays, with its way forward.
  const refused = submitPhase === "failed" && !retrying;
  logLink.textContent = `Submitted on ${payer}? Log it`;
  logLink.hidden = !(canLog && submitPhase === "idle" && !fillRunning &&
    state.kind !== "access" && state.kind !== "denied");
  const formOpen = (submitPhase === "form" || retrying) && canLog;
  submitDetails.hidden = !formOpen;
  submitTitle.textContent = `Did you submit on ${payer}?`;
  payerRefLabel.textContent = `${payer} confirmation number (optional)`;
  markSubmittedBtn.hidden = !(formOpen || submitPhase === "logging");
  markSubmittedBtn.disabled = submitPhase === "logging";
  markSubmittedBtn.classList.toggle("filling", submitPhase === "logging");
  markSubmittedBtn.textContent = submitPhase === "logging"
    ? "Logging…"
    : retrying
      ? "Try again"
      : dupConfirmPending ? "Log again" : "Log submission";
  dupWarn.hidden = !(dupConfirmPending && submitPhase === "form" && canLog);
  dupCancelBtn.hidden = dupWarn.hidden;
  submitBackBtn.hidden = submitPhase !== "form" || dupConfirmPending || !canLog;
  if (formOpen) {
    taskLinkSingle.textContent = submissionPlanLine(currentPlan());
    submitMoves.textContent = MOVES_TO_SUBMITTED_LINE;
    submitMoves.hidden = !logMovesToSubmitted(caseStatusNow());
    taskLink.hidden = false;
  }
  // The result of logging. A failure Try again can fix waits with its form.
  const resultShown = submitPhase === "done" || refused || (retrying && canLog);
  submitStatus.hidden = !resultShown;
  submitNext.hidden = !resultShown || submitNext.childElementCount === 0;
}

// Provider details opens itself once per state that needs values typed by
// hand: each page Minted hasn't learned, and site access not allowed. Closing
// it then sticks until the state changes. Null: no such state.
function openProviderDetailsOnce(attention: string | null): void {
  if (attention != null && attention !== providerAttentionKey) setSectionOpen("provider", true);
  providerAttentionKey = attention;
}

// The task card: title, one pill, subtitle, provenance, and which of its
// parts show. Called after every state change; opens itself when the
// coordinator needs to act or read a result (5a).
function renderTaskCard(): void {
  const caseId = selectedCaseId();
  const adHoc = caseSelect.value === AD_HOC_CASE_SELECTION;
  const launched = selectedCaseIsLaunched();
  renderLaunchChrome();
  taskCard.hidden = caseId == null && !adHoc;
  if (taskCard.hidden) {
    portalStatus.hidden = false;
    taskAttentionKey = null;
    openProviderDetailsOnce(null);
    return;
  }
  dropLogStateOutsideScope();
  const state = computeTaskCardState();
  const task = adHoc ? null : taskForCard();
  const caseItem = cases.find((c) => c.id === caseId);
  const payer = payerLabel();

  taskTitle.textContent = task?.title ??
    (adHoc ? "Ad hoc fill" : caseItem ? `${caseItem.payerName ?? "Case"} · ${caseItem.state}` : "Fill this form");
  const pill = taskCardPill(state);
  taskPill.hidden = pill == null;
  if (pill != null) {
    taskPill.textContent = pill.text;
    taskPill.className = `pill pill-tone-${pill.tone}`;
  }
  const provider = providers.find((p) => p.id === selectedProviderId());
  const providerName = caseContextData?.provider?.name ??
    (provider ? `${provider.firstName} ${provider.lastName}` : null);
  const where = adHoc ? null : [caseItem ? payer : null, caseContextData?.state ?? caseItem?.state ?? null]
    .filter(Boolean).join(" ");
  const sub = [
    providerName,
    where || null,
    task?.dueDate ? `due ${fmtContextDate(task.dueDate)}` : null,
    task ? (EXECUTION_TYPE_LABELS[task.executionType] ?? null) : null,
  ].filter((part): part is string => Boolean(part));
  taskSub.textContent = sub.join(" · ");
  taskSub.hidden = sub.length === 0;

  taskOrigin.hidden = !launched;
  if (launched && caseId != null) taskBack.href = caseUrl(caseId);

  const byHand = renderTaskNotice(state, task);

  const parked = ["readOnly", "timedOut", "wrongTab", "access", "denied", "log", "logging", "logged", "logFailed"]
    .includes(state.kind);
  const showingResult = lastSummary != null && !fillResults.hidden;
  fillResults.classList.toggle("is-parked", submitPhase !== "idle");
  // The pickup warning has done its job once she is logging (E3 asks again).
  dupPickup.classList.toggle("is-parked", submitPhase !== "idle");
  fillBtn.hidden = parked || showingResult || portal == null;
  fillNote.hidden = fillBtn.hidden;
  fillNote.textContent = fillRunning
    ? "Some questions only appear after others are answered. Minted waits for them. Stay on this tab."
    : "You click Continue and Submit. Minted never submits.";
  coveragePanel.hidden = lastCoverage == null || parked || showingResult || fillRunning;
  readyTitle.hidden = !(state.kind === "ready" || state.kind === "adHoc");
  readyTitle.textContent = state.kind === "adHoc"
    ? "Ad hoc fill. Nothing is logged to a case."
    : `${caseItem ? payer : (portal?.label ?? "Payer")} form found on this tab.`;
  openProviderDetailsOnce(state.kind === "denied"
    ? "denied"
    : byHand ? `byHand:${detectedPageUrl ?? ""}` : null);
  portalStatus.hidden = portal != null || state.kind === "timedOut" || state.kind === "wrongTab" || workOffForm();

  renderLogControls(state);

  // One "Open task" link at a time: a log result may already carry it.
  openTaskLink.hidden = caseId == null || caseContextBox.hidden || !submitNext.hidden;
  if (caseId != null) {
    openTaskLink.textContent = task ? "Open task in Minted Panel ↗" : "Open case in Minted Panel ↗";
    openTaskLink.href = task ? taskUrl(task.id) : caseUrl(caseId);
  }

  const attention = taskCardNeedsAttention(state) ? JSON.stringify(state) : null;
  if (attention != null && attention !== taskAttentionKey) setSectionOpen("task", true);
  taskAttentionKey = attention;
}

// How long ago the selected case was last marked submitted, when inside the
// duplicate window — else null (no warning).
function recentSubmissionPhrase(
  caseItem: CaseListItem | undefined,
): string | null {
  if (!caseItem?.lastSubmittedAt) return null;
  const at = new Date(caseItem.lastSubmittedAt);
  if (Number.isNaN(at.getTime())) return null;
  const days = (Date.now() - at.getTime()) / 86_400_000;
  if (days > DUPLICATE_WINDOW_DAYS || days < 0) return null;
  if (days < 1) return "earlier today";
  const whole = Math.round(days);
  return whole === 1 ? "yesterday" : `${whole} days ago`;
}

function renderGroupSelector(provider: ProviderListItem | null): void {
  groupSelect.replaceChildren();
  if (!provider) {
    groupField.hidden = true;
    selectedGroupId = null;
    return;
  }

  const providerGroups: ProviderGroupRef[] =
    provider.groups && provider.groups.length > 0
      ? provider.groups
      : provider.groupId
      ? [{ id: provider.groupId, name: "Assigned Group", isPrimary: true }]
      : [];

  const activeCaseId = selectedCaseId();
  const activeCaseItem = activeCaseId
    ? cases.find((c) => c.id === activeCaseId) ?? null
    : null;
  const caseGroupId = activeCaseItem?.groupId ?? null;

  if (caseGroupId) {
    // If the active case has an assigned group, group selection is pinned to that case group.
    selectedGroupId = caseGroupId;
    const caseGroupName =
      providerGroups.find((g) => g.id === caseGroupId)?.name ?? "Case Group";
    groupSelect.add(new Option(caseGroupName, caseGroupId));
    groupSelect.value = caseGroupId;
    groupSelect.disabled = true;
    groupSelect.title = "Group is determined by the selected case";
    groupField.hidden = false;
    return;
  }

  // When no case is selected (or the case has no group), the operator can pick from
  // the provider's affiliated groups.
  groupSelect.disabled = false;
  groupSelect.title = "";

  if (providerGroups.length === 0) {
    groupField.hidden = true;
    selectedGroupId = null;
    return;
  }

  groupField.hidden = false;
  const groupPlaceholder = new Option("Pick the group for this case", "");
  groupPlaceholder.disabled = true;
  groupSelect.add(groupPlaceholder);

  const optgroup = document.createElement("optgroup");
  optgroup.label = "Affiliated Groups";
  for (const g of providerGroups) {
    optgroup.appendChild(
      new Option(g.isPrimary ? `${g.name} (Primary)` : g.name, g.id),
    );
  }
  groupSelect.appendChild(optgroup);

  if (
    selectedGroupId &&
    providerGroups.some((g) => g.id === selectedGroupId)
  ) {
    groupSelect.value = selectedGroupId;
  } else if (providerGroups.length > 0) {
    const primary = providerGroups.find((g) => g.isPrimary) ?? providerGroups[0];
    if (primary) {
      selectedGroupId = primary.id;
      groupSelect.value = primary.id;
    } else {
      selectedGroupId = null;
      groupSelect.value = "";
    }
  } else {
    selectedGroupId = null;
    groupSelect.value = "";
  }
}

/** The "who am I working on, and how do I change it" line above the cards.
 * With the dropdown retired, Search IS the switcher — so this states the
 * current provider and offers one button back to it. */
function renderSelectedProvider(): void {
  const provider = providers.find((p) => p.id === selectedProvider) ?? null;
  providerBar.hidden = panelMode !== "case";
  providerBarName.textContent = provider
    ? providerLabel(provider)
    : "No provider selected";
  providerBarName.classList.toggle("id-empty", provider == null);
  providerBarSwitch.textContent = provider ? "Change" : "Find a provider";
  renderGroupSelector(provider);
}

function invalidateFillSelection(): void {
  fillSelectionRevision += 1;
  clearFillResults();
}

function clearFillResults(): void {
  const previousReview = lastAiReview;
  const previousTabId = lastFillTabId;
  if (previousReview && !previousReview.cleared) {
    void sendToBackground({
      type: "CLEAR_AI_FILL",
      tabId: previousTabId,
      fillSessionId: previousReview.fillSessionId,
    });
  }
  lastAiReview = null;
  lastFillTabId = null;
  lastFillPageUrl = null;
  fillAiReview.hidden = true;
  fillAiStatus.textContent = "";
  fillAiAcceptBtn.disabled = false;
  fillAiClearBtn.disabled = false;
  fillAiRetryBtn.disabled = false;
  fillAiRetryBtn.hidden = true;
  fillResults.hidden = true;
  fillReportTime.hidden = true;
  fillAttemptedBox.hidden = true;
  fillNotCheckedBox.hidden = true;
  fillSkippedBox.hidden = true;
  fillManualBox.hidden = true;
  fillYourTurn.hidden = true;
  fillEventWarn.hidden = true;
  fillDetails.hidden = true;
  fillProblem.hidden = true;
  gapFlag.hidden = true;
  lastSummary = null;
  lastFill = null;
  // The log form, its entries and its result stay through a page change (the
  // payer's confirmation page, a tab switch) in the same case and launch.
  // A different case or a new launch starts fresh.
  dropLogStateOutsideScope();
}

// Back to "nothing logged yet": the log form closed, no result, no warning.
function resetLogState(): void {
  submitPhase = "idle";
  logScope = null;
  lastLogFailure = null;
  lastLogMoved = false;
  dupConfirmPending = false;
  taskLink.hidden = true;
  submitDetails.hidden = true;
  dupWarn.hidden = true;
  dupCancelBtn.hidden = true;
  submitBackBtn.hidden = true;
  markSubmittedBtn.hidden = true;
  markSubmittedBtn.disabled = false;
  markSubmittedBtn.classList.remove("filling");
  markSubmittedBtn.textContent = "Log submission";
  submitStatus.hidden = true;
  submitNext.hidden = true;
  submitNext.replaceChildren();
  nbaSection.hidden = true;
  nbaSection.replaceChildren();
}

function currentHandoffSelectionIsApplied(
  record: ActiveCaseRecord | null = activeCase,
): boolean {
  return matchesAppliedHandoffSelection(
    record,
    activeCaseStatus,
    appliedHandoffSelection,
    {
      providerId: selectedProviderId(),
      caseId: selectedCaseId(),
      facilityId: selectedFacilityId(),
    },
  );
}

/** A pending, rejected, expired, or picker-drifted handoff cannot expose case
 * work. Deliberately selecting a case through the normal panel path replaces
 * the active record with source=panel and restores ordinary manual work. */
function currentSelectionAllowsCaseWork(): boolean {
  if (activeCase?.source !== "handoff") return true;
  return currentHandoffSelectionIsApplied();
}

// Hard gates, same pattern as the case rule: org resolved, provider selected,
// facility resolved (loaded and not awaiting a pick), case selected — and the
// portal form in the active tab. Shared by the Fill button's disabled state and
// the coverage sensor's readiness check so the two can never disagree.
function isFillReady(): boolean {
  const portalOpen = portal != null && portalTabId != null;
  const visibleWorkRecord = activeWorkRecordForTab(
    portalTabId == null ? null : { id: portalTabId },
    detectedPageUrl,
  );
  const tabMatchesWork = visibleWorkRecord != null && portal?.key === visibleWorkRecord.tuple.portalKey;
  const workBlocksLegacy = activeWorkState.status !== "none" && !tabMatchesWork;
  const contractWork = visibleWorkRecord?.tuple.ownerKind === "contract";
  const facilityBlocked = needsFacility && selectedFacilityId() == null;
  // Block fill when active-case context expired — when the active-case record
  // covers the selected case and expired, the gate closes (the worker also
  // refuses; this keeps the button honest).
  const expiredBlocked =
    activeCaseStatus === "expired" &&
    activeCase != null &&
    selectedCaseId() != null &&
    activeCase.caseId === selectedCaseId();
  const unappliedHandoffBlocked =
    activeCase?.source === "handoff" &&
    !currentHandoffSelectionIsApplied();
  return Boolean(
    portalOpen &&
    !workBlocksLegacy &&
    orgResolved() &&
    selectedProviderId() &&
    facilitiesLoaded &&
    !facilityBlocked &&
    !expiredBlocked &&
    !unappliedHandoffBlocked &&
    (contractWork || selectedCaseId() != null || (caseSelect.value === AD_HOC_CASE_SELECTION &&
      selectedGroupId != null && selectedFacilityId() != null)),
  );
}

// A received launch is still being applied (B1): a handoff under its
// authenticated reads, or a Work launch the panel is loading.
function caseOpening(): boolean {
  return applyingHandoffKey != null || workLaunchesOpening > 0;
}

// The B1 line. Names come only from what the panel already holds.
function openingLine(): string {
  const work = workLaunchesOpening > 0 && activeWorkState.status === "active" &&
    activeWorkState.record.tuple.ownerKind === "case"
    ? activeWorkState.record.tuple
    : null;
  const handoff = applyingHandoffKey != null ? activeCase : null;
  const providerId = work?.providerId ?? handoff?.providerId ?? null;
  const caseId = work?.ownerId ?? handoff?.caseId ?? null;
  const provider = providers.find((p) => p.id === providerId);
  const caseItem = cases.find((c) => c.id === caseId);
  if (provider == null || !caseItem?.payerName || !caseItem.state) {
    return "Opening the case from Minted Panel…";
  }
  const name = [provider.firstName, provider.lastName].filter(Boolean).join(" ");
  return `Opening ${name}, ${caseItem.payerName} ${caseItem.state}…`;
}

// Loads a live Work launch with the B1 line up and the queue away.
async function whileWorkOpens(load: () => Promise<void>): Promise<void> {
  if (activeWorkState.status !== "active") return load();
  workLaunchesOpening += 1;
  updateFillReady();
  try {
    await load();
  } finally {
    workLaunchesOpening -= 1;
    updateFillReady();
  }
}

function updateFillReady(): void {
  syncQueueVisibility();
  const portalOpen = portal != null && portalTabId != null;
  const visibleWorkRecord = activeWorkRecordForTab(
    portalTabId == null ? null : { id: portalTabId },
    detectedPageUrl,
  );
  const formName = selectedCaseId() != null ? payerLabel() : (portal?.label ?? "Payer");
  portalStatus.textContent = activeWorkState.status === "blocked"
    ? "The link to the case ended. Pick a case here, or open it in Minted Panel and click Work in portal."
    : activeWorkState.status === "expired"
      ? "This link timed out after 60 minutes. Open the case and click Work in portal again."
      : activeWorkState.status === "active" && visibleWorkRecord == null
        ? `Switch to the ${formName} tab to keep working this case.`
        : portalOpen
          ? `${formName} form found on this tab.`
          : "Open the payer's form in this tab to fill it.";
  portalStatus.classList.toggle("detected", portalOpen);
  // B1: a received launch is still loading. Say so, neutrally.
  if (caseOpening()) {
    portalStatus.textContent = openingLine();
    portalStatus.classList.remove("detected");
  }
  // The server flagged several locations and none is picked yet.
  const facilityBlocked = needsFacility && selectedFacilityId() == null;
  facilityHint.hidden = !facilityBlocked;
  fillBtn.disabled = !isFillReady();
  // A manual case can log independently of Fill. A handoff case first needs
  // the same receipt-pinned applied tuple enforced by the worker.
  touchSection.hidden = selectedCaseId() == null || !currentSelectionAllowsCaseWork();
  // Provenance is selection-sensitive too. Any provider/case/facility drift
  // must remove the applied banner and return link in the same UI turn.
  renderHandoffBanner();
  // Every gate-state change routes through here, so this is the one place the
  // pre-fill coverage sensor re-evaluates itself.
  refreshCoverage();
  renderTaskCard();
}

// The coverage sensor reflects the profile (provider + state + facility) and the
// portal's field maps — NOT the case — but only shows for a fill-ready
// selection.
// Fill state comes from the selected case, not the registry row — a
// national portal serves many states, while every case names its own.
// When no case is selected, falls back to facility state or provider home state.
function selectedCaseState(): string {
  const caseItem = cases.find((c) => c.id === selectedCaseId());
  if (caseItem?.state) return caseItem.state;
  const facility = facilities.find((f) => f.id === selectedFacilityId());
  return facility?.state ?? "";
}

function coverageSelectionKey(): string | null {
  if (activeWorkState.status !== "none" || !isFillReady()) return null;
  return [
    selectedProviderId(),
    selectedFacilityId() ?? "none",
    selectedGroupId ?? "none",
    selectedCaseId() ?? caseSelect.value,
    portal?.key ?? "",
    selectedCaseState(),
  ].join("|");
}

// Request coverage when the fill-ready selection changes, and render it above
// the Fill button. Purely informational: it never enables/blocks the fill, and
// on error it just hides. Respects the generation guard exactly like the other
// loaders — a superseded selection's response is discarded, never rendered.
function refreshCoverage(): void {
  if (activeWorkState.status !== "none") {
    coverageKey = null;
    renderCoverage(null);
    return;
  }
  const key = coverageSelectionKey();
  // Unchanged selection (this also swallows the many redundant updateFillReady
  // calls fired during intermediate loading states) — keep the current panel /
  // in-flight request as-is.
  if (key === coverageKey) return;
  coverageKey = key;
  if (key == null) {
    renderCoverage(null);
    return;
  }
  const providerId = selectedProviderId();
  const caseId = selectedCaseId();
  const activePortal = portal;
  // Unreachable when key != null (isFillReady guaranteed all three), but keep
  // the narrowing explicit for the type checker.
  if (!providerId || activePortal == null) return;
  const facilityId = selectedFacilityId();
  // Capture the generation at request time, like every other loader: an org /
  // provider / refresh / sign-out switch bumps it and this response is dropped.
  const generation = loadGeneration;
  renderCoverageLoading();
  void (async () => {
    const response = await sendToBackground({
      type: "GET_FILL_COVERAGE",
      providerId,
      caseId: caseId ?? null,
      portalKey: activePortal.key,
      state: selectedCaseState(),
      facilityId,
      groupId: selectedGroupId,
    });
    // Discard a stale response: a newer generation superseded this selection,
    // OR the fill-ready selection changed to a different coverage key while we
    // were in flight (facility/case changes don't bump the generation, so the
    // key check is what catches those).
    if (!isCurrent(generation) || key !== coverageKey) return;
    if (!response.ok) {
      // Non-blocking sensor: hide on error, never raise the error box.
      renderCoverage(null);
      return;
    }
    renderCoverage(response.data);
  })();
}

function renderCoverageLoading(): void {
  coveragePanel.hidden = false;
  coverageCount.textContent = "Checking field coverage…";
  coverageGaps.replaceChildren();
}

// Fix-it link for one coverage gap. A MAPPING gap routes to the
// existing platform train flow with the portal/field context in the URL; a
// DATA gap routes to the provider record (the right fix, not the mapping
// flow). Opens in a new tab so the portal session is preserved; the
// extension itself never writes a mapping.
function gapActionLink(
  gap: ReportedField,
  portalKey: string | null,
  providerId: string | null,
): HTMLAnchorElement | null {
  let href: string | null = null;
  let label: string | null = null;
  if (gap.kind === "no_mapping" && portalKey != null) {
    href = `${API_BASE_URL}${trainFlowPath(portalKey, gap.label)}`;
    label = "Fix mapping ↗";
  } else if (gap.kind === "no_value") {
    const action = dataFixAction(gap.recordPath, providerId, API_BASE_URL);
    href = action?.href ?? null;
    label = action?.label ?? null;
  }
  if (href == null || label == null) return null;
  const link = document.createElement("a");
  link.className = "gap-action";
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  return link;
}

// Coverage panel: "Can fill M of N mapped fields" plus one row per gap.
// Read-only — labels and reasons only, never field values.
function renderCoverage(coverage: FillCoverage | null): void {
  lastCoverage = coverage;
  coveragePanel.hidden = coverage == null || !fillResults.hidden || submitPhase !== "idle";
  if (coverage == null) {
    coverageGaps.replaceChildren();
    refreshMapsBtn.hidden = true;
    return;
  }
  const noun = coverage.total === 1 ? "field" : "fields";
  coverageCount.textContent = `We can fill ${coverage.available} of ${coverage.total} ${noun} on this form.`;

  // A form without a test run still fills; it just says so (B16).
  const proven = portal?.proven === true;
  provenChip.hidden = !proven;
  unprovenNote.hidden = proven;
  unprovenNote.textContent = proven
    ? ""
    : "This form hasn't had a test run. Check the result before you submit.";

  // Mapping drift and the per-field gap list are admin detail (B16).
  const admin = isCurrentOrgAdmin();
  const broken = lastReportBrokenCount;
  driftStrip.hidden = broken === 0 || !admin;
  driftStrip.textContent =
    broken === 0
      ? ""
      : `${broken} mapped ${broken === 1 ? "field" : "fields"} went missing on the last fill. This form may have changed.`;
  coverageGaps.hidden = !admin || coverage.gaps.length === 0;

  coverageGaps.replaceChildren();
  const portalKey = portal?.key ?? null;
  const providerId = selectedProviderId();
  for (const gap of coverage.gaps) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "coverage-gap-label";
    label.textContent = gap.label;
    const reason = document.createElement("span");
    reason.className = "coverage-gap-reason";
    reason.textContent = gap.reason;
    li.append(label, reason);
    const action = gapActionLink(gap, portalKey, providerId);
    if (action) li.append(action);
    coverageGaps.append(li);
  }
  // After fix-it in the panel: after a fix-it completes in the platform, one click
  // refetches the maps + profile and re-checks coverage — the newly trained
  // field moves from the gap list into the fillable count.
  refreshMapsBtn.hidden = !admin || partitionGaps(coverage.gaps).mappingGaps.length === 0;
}

refreshMapsBtn.addEventListener("click", () => {
  // Drop the memoized selection key so refreshCoverage refetches even though
  // the selection didn't change (the SERVER data did).
  coverageKey = null;
  refreshCoverage();
});

// A report bucket: a collapsible <details> with the heading, an optional
// count pill, and the field rows — same data and wording as before, redressed
// per the design's fill-report card.
function bucketDetails(
  heading: string,
  count: number | null,
  rows: Array<string | HTMLElement>,
): HTMLDetailsElement {
  const details = document.createElement("details");
  details.open = true;
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.className = "bucket-heading";
  title.textContent = heading;
  summary.append(title);
  if (count != null) {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = String(count);
    summary.append(pill);
  }
  details.append(summary);
  if (rows.length) {
    const list = document.createElement("ul");
    for (const row of rows) {
      const item = document.createElement("li");
      if (typeof row === "string") item.textContent = row;
      else item.append(row);
      list.append(item);
    }
    details.append(list);
  }
  return details;
}

// A report bucket's rows. When `actions` carries the fill's portal/provider
// context, each gap row also offers a fix-it link in place — the
// specialist never has to re-find the field she just hit.
function fieldList(
  box: HTMLElement,
  heading: string,
  fields: ReportedField[],
  actions?: { portalKey: string | null; providerId: string | null },
): void {
  box.hidden = fields.length === 0;
  if (!fields.length) return;
  const rows = fields.map((field) => {
    const text = `${field.label} - ${field.reason}`;
    if (!actions) return text;
    const action = gapActionLink(field, actions.portalKey, actions.providerId);
    if (!action) return text;
    const wrap = document.createElement("span");
    wrap.className = "gap-row";
    const label = document.createElement("span");
    label.textContent = text;
    wrap.append(label, action);
    return wrap;
  });
  box.replaceChildren(bucketDetails(heading, fields.length, rows));
}

// "9:42 PM" today, "07/05, 9:42 PM" on any other day — a restored report is
// always labeled with when it ran so it can't pass for a fresh one.
function fmtReportTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "an earlier session";
  const time = at.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return at.toDateString() === new Date().toDateString()
    ? time
    : `${formatDisplayDate(iso)}, ${time}`;
}

// After a fill, the log state starts fresh. A restored report that was
// already logged shows as logged, in the current case and launch; one logged
// under an earlier launch of this case leaves the new launch to log fresh.
function renderSubmissionActions(
  restored?: { completedAt: string; submitted: boolean },
): void {
  if (restored == null) {
    resetLogState();
    return;
  }
  const caseId = selectedCaseId();
  if (restored.submitted !== true || lastFill?.caseId == null || lastFill.caseId !== caseId) return;
  const liveLaunch = launchIdForSelectedCase();
  if (liveLaunch != null && lastFill.workContext?.launchReceiptId !== liveLaunch) return;
  submitPhase = "done";
  logScope = logScopeKey();
  dupConfirmPending = false;
  lastLogFailure = null;
  lastLogMoved = false;
  setLiveRole(submitStatus, "status");
  fillNotice(submitStatus, "ok", [{ text: "Logged to the case.", strong: true }]);
  submitNext.replaceChildren();
  submitNext.hidden = true;
}

// Fields on this form that need the coordinator: missing data, uploads, and
// fields marked for a human. Everything else (drift, other pages, hidden
// controls) is engineering detail and lives in admin Details.
const NEED_REASONS: Partial<Record<NonNullable<ReportedField["kind"]>, string>> = {
  no_value: "not on file",
  file: "upload it by hand",
  manual: "fill it by hand",
  review: "check it by hand",
};

function needsYou(summary: FillSummary): ReportedField[] {
  return summary.manual.filter((field) => field.kind != null && field.kind in NEED_REASONS);
}

function needRow(field: ReportedField, providerId: string | null): HTMLElement {
  const row = document.createElement("span");
  row.className = "need-row";
  const label = document.createElement("span");
  label.textContent = `${field.label} · ${(field.kind && NEED_REASONS[field.kind]) ?? field.reason}`;
  row.append(label);
  if (field.kind === "no_value") {
    const action = dataFixAction(field.recordPath, providerId, API_BASE_URL);
    if (action) row.append(externalLink("Add in Minted Panel ↗", action.href));
  }
  return row;
}

// The engineer's view of a fill, for admins of the current org only:
// counts, the fill record, the form key and mapping, the work context, every
// skip with its reason, and Fix mapping.
function renderFillDetails(summary: FillSummary): void {
  fillDetails.hidden = !isCurrentOrgAdmin();
  if (fillDetails.hidden) return;
  const portalKey = lastFill?.portalKey ?? portal?.key ?? null;
  const lines: string[] = [`Fields written: ${summary.filled}`];
  if (summary.fieldsAttempted != null) {
    lines.push(`Setter attempts: ${summary.fieldsAttempted} · checked after writing: ${summary.fieldsVerified ?? 0}`);
  }
  if (summary.pageFields != null && summary.pageFields > 0) {
    lines.push(`Fillable controls on the page: about ${summary.pageFields}`);
  }
  lines.push(summary.eventRecorded
    ? "Fill record: saved"
    : `Fill record: not saved. ${summary.eventError ?? ""}`.trim());
  if (portalKey) lines.push(`Form: ${portalKey}${portal ? ` · mapping ${portal.mappingGeneration}` : ""}`);
  const tuple = summary.workContext;
  if (tuple) lines.push(`Work context: ${tuple.ownerKind} · ${tuple.portalKey} · mapping ${tuple.mappingGeneration}`);
  const warning = partialFillWarning(summary.manual, summary.skipped.length);
  if (warning) lines.push(warning);
  fillDetailsBody.replaceChildren(...lines.map((text) => {
    const line = document.createElement("p");
    line.textContent = text;
    return line;
  }));
  const links = document.createElement("p");
  links.className = "admin-details-links";
  if (portalKey) links.append(externalLink("Fix mapping ↗", `${API_BASE_URL}${trainFlowPath(portalKey)}`));
  links.append(supportButton(summary.eventRecorded ? "fill" : "record", summary.attemptId ?? summary.fillSessionId));
  fillDetailsBody.append(links);
  const actions = {
    portalKey,
    providerId: lastFill?.providerId ?? selectedProviderId(),
  };
  fieldList(fillSkippedBox, "Not filled on this page:", summary.skipped, actions);
  fieldList(fillNotCheckedBox, "Not checked:", summary.notChecked ?? []);
  fieldList(fillAttemptedBox, "Form-wide planning items (page not checked):", summary.manual, actions);
}

// The fill result: one plain headline, the fields that need her, her next
// steps, and the record line. No AI review in 0.1.8 (AI_FILL_ENABLED).
function renderFillSummary(
  summary: FillSummary,
  restored?: { completedAt: string; submitted: boolean },
): void {
  lastSummary = summary;
  fillResults.hidden = false;
  fillProblem.hidden = true;
  fillReportTime.hidden = restored == null;
  lastAiReview = AI_FILL_ENABLED ? (summary.aiReview ?? null) : null;
  if (restored) fillReportTime.textContent = `From ${fmtReportTime(restored.completedAt)}`;
  const providerId = lastFill?.providerId ?? selectedProviderId();
  const payer = selectedCaseId() != null ? payerLabel() : (portal?.label ?? "payer");
  const fillId = summary.attemptId ?? summary.fillSessionId;
  const needs = needsYou(summary);

  if (summary.filled > 0) {
    const noun = summary.filled === 1 ? "field" : "fields";
    fillNotice(fillSummaryBox, "ok", [
      { text: `Filled ${summary.filled} ${noun} on this page.`, strong: true },
      "Green outline on the page = filled by Minted.",
    ]);
  } else {
    fillNotice(fillSummaryBox, "danger", [
      { text: "Nothing was filled on this page.", strong: true },
      "Minted couldn't find this page's trained fields. The portal may have changed.",
    ], [supportButton("nothing-filled", fillId, "danger")]);
    // She fills it by hand: put the values in reach.
    setSectionOpen("provider", true);
  }

  if (needs.length > 0) {
    const head = `${needs.length} ${needs.length === 1 ? "field needs" : "fields need"} you`;
    fillNotice(fillManualBox, "warn", [{ text: head, strong: true }],
      needs.map((field) => needRow(field, providerId)));
  } else {
    fillManualBox.hidden = true;
  }

  if (summary.filled > 0) {
    const steps: string[] = [];
    if (needs.length > 0) steps.push(`Fill the ${needs.length === 1 ? "field" : `${needs.length} fields`} above on the ${payer} page.`);
    steps.push("Look over the green fields.");
    steps.push(`Click Continue or Submit on the ${payer} page.`);
    fillNotice(fillYourTurn, "neutral", [
      { text: "Your turn", strong: true },
      ...steps.map((step, index) => `${index + 1}. ${step}`),
    ]);
  } else {
    fillNotice(fillYourTurn, "neutral", [
      "Still nothing? Fill this page by hand, and tell your admin this form needs retraining.",
    ]);
  }

  const statusLines: HTMLElement[] = [];
  if (!summary.eventRecorded) {
    const line = document.createElement("span");
    line.textContent = "Minted Panel didn't save a record of this fill. That's on us. You can keep going.";
    statusLines.push(line, supportButton("record", fillId));
  }
  if (lastFill != null && lastFill.caseId == null) {
    const provider = providers.find((p) => p.id === lastFill?.providerId);
    const name = provider ? `${provider.firstName} ${provider.lastName}` : "the provider";
    const line = document.createElement("span");
    line.textContent = `This fill is saved under ${name}, not a case. To log a submission, pick the case.`;
    statusLines.push(line);
  }
  fillEventWarn.replaceChildren(...statusLines);
  fillEventWarn.hidden = statusLines.length === 0;
  gapFlag.hidden = true;

  fillAgainBtn.textContent = summary.filled > 0 ? "Fill this page again" : "Try again";
  fillAgainBtn.className = summary.filled > 0 ? "secondary" : "primary";

  renderAiReview(AI_FILL_ENABLED ? (summary.aiReview ?? null) : null, restored ?? null);
  renderFillDetails(summary);
  renderSubmissionActions(restored);
  renderTaskCard();
}

function renderAiReview(review: AiFillReview | null, restored: { completedAt: string; submitted: boolean } | null = null): void {
  lastAiReview = review;
  fillAiReview.hidden = review == null;
  if (!review) return;
  const count = review.writes.length;
  const learning = review.learning;
  fillAiStatus.textContent = aiReviewStatusText(review);
  const submitted = restored?.submitted === true || learning?.state === "pending" || learning?.state === "learned";
  const canClear = !submitted && !review.cleared && learning?.state !== "learned" && count > 0;
  const canAccept = canClear && !review.accepted && review.status === "ready" && lastFill?.fillSessionId != null;
  const canRetry = restored?.submitted === true && learning?.state === "failed" &&
    learning.reason !== "missing_page_scope" && lastFill?.fillSessionId != null;
  fillAiAcceptBtn.hidden = !canAccept;
  fillAiClearBtn.hidden = !canClear;
  fillAiRetryBtn.hidden = !canRetry;
  fillAiAcceptBtn.disabled = !canAccept;
  fillAiClearBtn.disabled = !canClear;
  fillAiRetryBtn.disabled = !canRetry;
}

interface LoadCasesOptions {
  preferredCaseId?: string;
  deferContext?: boolean;
  deferReport?: boolean;
}

async function loadCases(
  providerId: string,
  generation: number,
  options: LoadCasesOptions = {},
): Promise<HandoffRead<readonly string[]>> {
  invalidateFillSelection();
  // Drop the previous provider's rows NOW — the active-cases list must never
  // show provider A's cases under provider B while the fetch is in flight.
  cases = [];
  casesLoadedFor = null;
  renderActiveCases();
  caseSelect.disabled = true;
  caseSelect.replaceChildren(new Option("Loading cases…", ""));
  renderCaseStatusPill();
  renderCaseNote();
  // No valid case is selected during the load — hide any prior case's context.
  refreshCaseContext();
  updateFillReady();

  const response = await sendToBackground({ type: "LIST_CASES", providerId });
  // A newer provider/org selection superseded this load — discard silently.
  if (!isCurrent(generation)) return { status: "stale" };
  if (!response.ok) {
    setError(mainError, response.error);
    caseSelect.replaceChildren(new Option("Unavailable", ""));
    cases = [];
    renderCaseStatusPill();
    updateFillReady();
    return { status: "error", message: response.error };
  }

  cases = response.data;
  casesLoadedFor = providerId;
  let rememberedId: string | null;
  if (options.preferredCaseId != null) {
    rememberedId = cases.some((c) => c.id === options.preferredCaseId)
      ? options.preferredCaseId
      : null;
  } else {
    const remembered = await sendToBackground({
      type: "GET_SELECTED_CASE",
      providerId,
    });
    if (!isCurrent(generation)) return { status: "stale" };
    rememberedId =
      remembered.ok && (remembered.data === AD_HOC_CASE_SELECTION || cases.some((c) => c.id === remembered.data))
        ? remembered.data
        : null;
    // A remembered case that no longer exists (closed, or another org's) is
    // dropped silently — from storage too, not just the dropdown.
    if (remembered.ok && remembered.data != null && rememberedId == null) {
      void sendToBackground({
        type: "SET_SELECTED_CASE",
        providerId,
        caseId: null,
      });
    }
  }
  const rememberedGroup = await sendToBackground({ type: "GET_SELECTED_GROUP", providerId });
  if (!isCurrent(generation)) return { status: "stale" };
  selectedGroupId = rememberedGroup.ok ? rememberedGroup.data : null;
  caseSelect.replaceChildren();
  const placeholder = new Option("Pick a case", "", true, rememberedId == null);
  placeholder.disabled = true;
  caseSelect.add(placeholder);
  caseSelect.add(new Option("No case · Ad hoc fill", AD_HOC_CASE_SELECTION, false, rememberedId === AD_HOC_CASE_SELECTION));
  for (const c of cases) {
    caseSelect.add(new Option(caseLabel(c), c.id, false, c.id === rememberedId));
  }
  caseSelect.disabled = false;
  renderCaseStatusPill();
  renderCaseNote();
  renderDuplicateGuard();
  renderActiveCases();
  renderGroupSelector(providers.find((p) => p.id === selectedProviderId()) ?? null);
  // Load context for the restored case (or hide when none was restored). Runs
  // under this generation; a superseding switch discards its response.
  if (!options.deferContext) refreshCaseContext();
  if (!options.deferReport) {
    await restoreFillReport(providerId, rememberedId, generation);
  }
  updateFillReady();
  return { status: "ok", data: cases.map((c) => c.id) };
}

// Re-render the provider's persisted fill report when the panel reopens —
// only if it belongs to the case that is still open and still selected.
// Anything stale is skipped silently; the record itself expires with the
// browser session or the next fill.
async function restoreFillReport(
  providerId: string,
  selectedCase: string | null,
  generation: number,
): Promise<void> {
  lastReportBrokenCount = 0;
  const revision = fillSelectionRevision;
  const response = await sendToBackground({
    type: "GET_FILL_REPORT",
    providerId,
  });
  if (!isCurrent(generation) || revision !== fillSelectionRevision) return;
  if (!response.ok || response.data == null) return;
  const record: FillReportRecord = response.data;
  if (selectedCase == null || selectedCase !== caseSelect.value || selectedProviderId() !== providerId) return;
  if (record.portalKey !== portal?.key || (record.groupId ?? null) !== selectedGroupId ||
      (record.summary.facilityId ?? null) !== selectedFacilityId() ||
      (record.summary.state ?? "") !== selectedCaseState()) return;
  const isAdHoc = selectedCase === AD_HOC_CASE_SELECTION;
  if (isAdHoc) {
    // For ad hoc fills, restore reports where caseId is null and portal matches the active page.
    if (record.caseId != null) return;
    if (portal?.key && record.portalKey !== portal.key) return;
  } else {
    // For case-bound fills, the report must match the selected case.
    if (record.caseId !== selectedCase) return;
  }
  // Drift signal: dead selectors from this portal's last REAL fill.
  if (record.portalKey === portal?.key) {
    lastReportBrokenCount = countBrokenSelectors(record.summary.skipped ?? []);
  }
  lastFill = {
    providerId,
    caseId: record.caseId ?? null,
    portalKey: record.portalKey,
    fillSessionId: record.summary.fillSessionId,
    isWorkFill: record.summary.workContext != null,
    workContext: record.summary.workContext ?? null,
    workCaseType: record.summary.workCaseType ?? null,
    submitted: record.submitted,
  };
  renderFillSummary(record.summary, {
    completedAt: record.completedAt,
    submitted: record.submitted,
  });
}

// The selected location's practice address, under the Location picker. One
// line per part: street (+ suite), then "city, state zip". Hidden when no
// facility is selected or the facility carries no address fields.
function renderFacilityAddress(): void {
  const facility =
    facilities.find((f) => f.id === selectedFacilityId()) ?? null;
  const lines = facilityAddressLines(facility);
  facilityAddress.hidden = lines.length === 0;
  facilityAddress.replaceChildren();
  for (const line of lines) {
    const row = document.createElement("div");
    row.textContent = line;
    facilityAddress.append(row);
  }
}

// List every case location (context.facilities),
// primary badged. Read-only context beside the Location picker, which stays
// the ONE fill-target control. No new chrome for the common case: hidden
// entirely with 0 or 1 case location (a lone location is already what the
// select and the address box above show — this list only earns its place
// once there is more than one to disambiguate).
function renderCaseLocations(context: CaseContext | null): void {
  const locations = context?.facilities ?? [];
  caseLocationsList.replaceChildren();
  if (locations.length < 2) {
    caseLocationsList.hidden = true;
    return;
  }
  for (const loc of locations) {
    const li = document.createElement("li");
    li.className = "case-locations-row";
    const name = document.createElement("span");
    name.className = "case-locations-name";
    name.textContent = loc.name || "Location";
    li.append(name);
    if (loc.isPrimary) {
      const badge = document.createElement("span");
      badge.className = "pill pill-blue";
      badge.textContent = "Primary";
      li.append(badge);
    }
    const addressLine = facilityAddressLines(loc).join(" · ");
    if (addressLine) {
      const address = document.createElement("span");
      address.className = "case-locations-address";
      address.textContent = addressLine;
      li.append(address);
    }
    caseLocationsList.append(li);
  }
  caseLocationsList.hidden = false;
}

// Limit #facility-select options to the case's locations
// location set (facilityPickerScope, src/shared/caseContext.ts) whenever one
// is known, falling back to the provider's full assigned set otherwise —
// which is also what this is a no-op over when facilities aren't loaded yet,
// or the case carries none (today's loadFacilities-built options, untouched).
// Never performs a network call: it only rebuilds DOM from what's already in
// hand, preserving the CURRENT selection when it's still a member of the new
// scope (both a narrow — the case's own scope is always a subset of the
// provider's loaded set — and a widen-back, e.g. switching off a
// multi-location case, keep whatever was picked). maybeApplyCaseFacility,
// which runs right after every call site, is what actually PICKS the case's
// primary when nothing is picked yet — this function only makes sure the
// right <option> exists for it to land on.
function rescopeFacilitySelectOptions(): void {
  if (!facilitiesLoaded) return;
  const scope = facilityPickerScope(caseContextData?.facilities, facilities);
  const scopeIds = new Set(scope.map((f) => f.id));
  const currentOptionIds = new Set(
    Array.from(facilitySelect.options)
      .map((o) => o.value)
      .filter((v) => v !== ""),
  );
  if (
    currentOptionIds.size === scopeIds.size &&
    [...scopeIds].every((id) => currentOptionIds.has(id))
  ) {
    return; // already showing exactly this scope — nothing to rebuild
  }
  if (scope.length === 0) {
    facilitySelect.replaceChildren(new Option("No locations on file", ""));
    facilitySelect.disabled = true;
    return;
  }
  const only = scope.length === 1 ? scope[0] : undefined;
  if (only) {
    facilitySelect.replaceChildren(
      new Option(only.name || "Location", only.id, true, true),
    );
    facilitySelect.disabled = false;
    return;
  }
  const currentId = selectedFacilityId();
  const preselect = currentId != null && scopeIds.has(currentId) ? currentId : null;
  facilitySelect.replaceChildren();
  const placeholder = new Option(
    "Pick a location",
    "",
    true,
    preselect == null,
  );
  placeholder.disabled = true;
  facilitySelect.add(placeholder);
  for (const f of scope) {
    facilitySelect.add(new Option(f.name || f.id, f.id, false, f.id === preselect));
  }
  facilitySelect.disabled = false;
}

// The provider's facility set, from the profile response. Exactly one:
// auto-selected read-only (the server resolves it the same way). Several:
// the user picks, remembered per provider and re-validated silently.
//
// When caller already knows facilityId + state,
// a case-search row, an NBA item, a handoff payload, or a case already
// selected in the dropdown — sourced the same way the fill path already
// does (selectedCaseState()). When present, the FIRST GET_PROVIDER_FACILITIES
// read carries it, so a case whose location is known resolves PRACTICE
// LOCATION / FACILITY ASSIGNMENT / STATE LICENSE in that one request instead
// of a second round trip. When the caller doesn't know a facility, the
// provider's remembered pick (session-local, no network cost) is tried next
// — but never guessed past a 404: the server 404s a facilityId that isn't a
// live member of the provider's set (a remembered pick can go stale between
// sessions), and that failure retries ONCE with it dropped rather than
// taking the whole facility load down over it.
async function loadFacilities(
  providerId: string,
  generation: number,
  known: {
    facilityId?: string | null;
    state?: string;
    caseId?: string | null;
    strictFacility?: boolean;
    deferSelectionWrites?: boolean;
  } = {},
): Promise<HandoffRead<readonly string[]>> {
  const caseId = known.caseId !== undefined ? known.caseId : selectedCaseId();
  // A handoff supplies its case before the picker is populated. The server
  // derives that case's group; ordinary loads use the settled group selector.
  const groupId = known.deferSelectionWrites ? undefined : selectedGroupId;
  const state = known.state ?? cases.find((item) => item.id === caseId)?.state;
  facilities = [];
  facilitiesLoaded = false;
  needsFacility = false;
  facilitySelect.disabled = true;
  facilitySelect.replaceChildren(new Option("Loading locations…", ""));
  renderFacilityAddress();
  updateFillReady();

  let speculativeFacilityId = known.facilityId ?? null;
  if (speculativeFacilityId == null) {
    const remembered = await sendToBackground({
      type: "GET_SELECTED_FACILITY",
      providerId,
    });
    if (!isCurrent(generation)) return { status: "stale" };
    if (remembered.ok && remembered.data != null) {
      speculativeFacilityId = remembered.data;
    }
  }

  let response = await sendToBackground({
    type: "GET_PROVIDER_FACILITIES",
    providerId,
    caseId,
    groupId,
    ...(speculativeFacilityId ? { facilityId: speculativeFacilityId } : {}),
    ...(state ? { state } : {}),
  });
  // A newer provider/org selection superseded this load — discard silently.
  if (!isCurrent(generation)) return { status: "stale" };
  if (
    !response.ok &&
    speculativeFacilityId != null &&
    response.code === 404 &&
    known.strictFacility !== true
  ) {
    speculativeFacilityId = null;
    response = await sendToBackground({
      type: "GET_PROVIDER_FACILITIES",
      providerId,
      caseId,
      groupId,
      ...(state ? { state } : {}),
    });
    if (!isCurrent(generation)) return { status: "stale" };
  }
  if (!response.ok) {
    facilitySelect.replaceChildren(new Option("Unavailable", ""));
    setError(mainError, response.error);
    updateFillReady(); // facilitiesLoaded stays false — gate stays closed
    return {
      status: "error",
      message: response.error,
      ...(known.strictFacility === true && response.code === 404
        ? { code: "not-found" as const }
        : {}),
    };
  }
  facilities = response.data.facilities;
  needsFacility = response.data.needsFacility;
  facilitiesLoaded = true;
  // The quick cards AND the served picker catalog ride on the same (single,
  // audited) profile fetch as the facility set.
  currentCatalog = response.data.catalog;
  const cardsCurrent = caseId === selectedCaseId() && (groupId === undefined || groupId === selectedGroupId);
  renderQuickCards(cardsCurrent ? response.data.cards : null);

  if (facilities.length === 0) {
    // Nothing to resolve: facility tokens come back unresolved with a
    // reason, which is correct — not a fill blocker.
    facilitySelect.replaceChildren(new Option("No locations on file", ""));
    updateFillReady();
    return { status: "ok", data: [] };
  }

  // The server accepted the speculative id above (response.ok), so if it's
  // still a live member of this provider's set it's already proven — no
  // second GET_SELECTED_FACILITY round trip needed to re-derive what this
  // read just resolved.
  const resolvedSpeculativeId =
    speculativeFacilityId != null &&
    facilities.some((f) => f.id === speculativeFacilityId)
      ? speculativeFacilityId
      : null;

  const sole = facilities.length === 1 ? facilities[0] : undefined;
  if (sole) {
    facilitySelect.replaceChildren(
      new Option(sole.name || "Location", sole.id, true, true),
    );
    if (known.deferSelectionWrites !== true) {
      await sendToBackground({ type: "SET_SELECTED_FACILITY", providerId, facilityId: sole.id });
      if (!isCurrent(generation)) return { status: "stale" };
    }
    renderFacilityAddress();
    renderIdentityGuard();
    updateFillReady();
    if (known.deferSelectionWrites !== true && !cardsCurrent) {
      await refreshFacilityCards(providerId, sole.id, generation);
    }
    return { status: "ok", data: facilities.map((facility) => facility.id) };
  }

  let rememberedId = resolvedSpeculativeId;
  if (rememberedId == null) {
    const remembered = await sendToBackground({
      type: "GET_SELECTED_FACILITY",
      providerId,
    });
    if (!isCurrent(generation)) return { status: "stale" };
    rememberedId =
      remembered.ok && facilities.some((f) => f.id === remembered.data)
        ? remembered.data
        : null;
    if (
      known.deferSelectionWrites !== true &&
      remembered.ok &&
      remembered.data != null &&
      rememberedId == null
    ) {
      void sendToBackground({
        type: "SET_SELECTED_FACILITY",
        providerId,
        facilityId: null,
      });
    }
  }
  facilitySelect.replaceChildren();
  const placeholder = new Option(
    "Pick a location",
    "",
    true,
    rememberedId == null,
  );
  placeholder.disabled = true;
  facilitySelect.add(placeholder);
  for (const facility of facilities) {
    facilitySelect.add(
      new Option(
        facility.name || facility.id,
        facility.id,
        false,
        facility.id === rememberedId,
      ),
    );
  }
  facilitySelect.disabled = false;
  // Case context may arrive before facilities load (a case was
  // picked) before this facilities load completed: rescope down to it before
  // the freshly-built full-provider-set options above get a pick applied
  // over them. A no-op when no case (or a case with no locations) is in play.
  //
  // Handoff loads defer selection writes and must NOT rescope here: a prior
  // case's facilities can still be in memory on the parallel Promise.all arm
  // and a sole-scoped rebuild would clobber the receipt's explicit facility.
  if (known.deferSelectionWrites !== true) {
    rescopeFacilitySelectOptions();
    renderFacilityAddress();
    // Case facility from context resolves the
    // pick when the user hasn't chosen one — the case selected it, not a guess.
    maybeApplyCaseFacility(false);
  } else {
    renderFacilityAddress();
  }
  renderIdentityGuard();
  updateFillReady();
  // Multi-facility: a selection that ISN'T the id this read already resolved
  // (the case's own facility, applied above, differing from the speculative
  // pick — or a remembered pick the caller didn't already know) still needs a
  // re-fetch so PRACTICE LOCATION/FACILITY ASSIGNMENT populate. When it IS the
  // same id, this read already resolved it — no second profile request.
  const selectedId = selectedFacilityId();
  if (
    known.deferSelectionWrites !== true &&
    selectedId != null &&
    (!cardsCurrent || (facilities.length > 1 && selectedId !== resolvedSpeculativeId))
  ) {
    await refreshFacilityCards(providerId, selectedId, generation);
  }
  return { status: "ok", data: facilities.map((facility) => facility.id) };
}

// Settle case/group before the profile read, then restore only once the
// location and case context are ready. This keeps the initial cards and report
// on the same selection without adding another profile request on reopen.
async function loadProviderSelection(
  providerId: string,
  generation: number,
  known: { facilityId?: string | null; state?: string } = {},
): Promise<void> {
  facilitiesLoaded = false;
  renderQuickCards(null);
  const caseRead = await loadCases(providerId, generation, { deferContext: true, deferReport: true });
  if (caseRead.status !== "ok" || !isCurrent(generation)) return;
  const revision = fillSelectionRevision;
  await Promise.all([
    refreshCaseContext(),
    loadFacilities(providerId, generation, known),
  ]);
  if (!isCurrent(generation) || revision !== fillSelectionRevision) return;
  await restoreFillReport(providerId, caseSelect.value || null, generation);
}

async function loadProviders(generation: number): Promise<void> {
  setError(mainError, null);
  invalidateFillSelection();
  renderProviderCard(null);

  // The roster is still loaded (search filters it locally, the card reads it,
  // and a remembered selection is validated against it) — it just no longer
  // fills a dropdown.
  const response = await sendToBackground({ type: "LIST_PROVIDERS" });
  // A newer org switch / refresh superseded this load — discard silently.
  if (!isCurrent(generation)) return;
  if (!response.ok) {
    setError(mainError, response.error);
    return;
  }
  providers = browseableProviders(response.data);
  // The sandbox entry is derived from the roster, so it can only be honest
  // once the roster is in hand — before that it would claim "no test provider
  // designated" for every org.
  renderSandboxEntry();

  const selected = await sendToBackground({ type: "GET_SELECTED_PROVIDER" });
  if (!isCurrent(generation)) return;
  const selectedId =
    selected.ok && providers.some((p) => p.id === selected.data)
      ? selected.data
      : null;
  // A remembered provider that isn't in the current org's list anymore is
  // dropped silently — from storage too, not just the panel.
  if (selected.ok && selected.data != null && selectedId == null) {
    void sendToBackground({ type: "SET_SELECTED_PROVIDER", providerId: null });
  }
  setSelectedProviderId(selectedId);
  const provider = providers.find((p) => p.id === selectedId) ?? null;
  renderProviderCard(provider);
  // Same generation flows down: if a switch lands during these loads they
  // discard themselves, and loadProviders is never reached by a stale caller
  // (the checks above bail first).
  if (provider) await loadProviderSelection(provider.id, generation);
}

// Account row shows the active org's name beside the avatar —
// ellipsized by CSS at narrow widths, never dropped entirely (the 320px
// criterion). Empty until an org resolves.
function renderOrgContext(): void {
  const active = orgs.find((o) => o.orgId === activeOrgId);
  orgContext.textContent = active ? active.orgName : "";
  orgContext.title = active ? active.orgName : "";
}

function orgLabel(org: UserOrgMembership): string {
  return org.orgName || org.orgId;
}

// Org resolution comes first — everything below the org dropdown is
// org-scoped. One membership: shown read-only, no x-org-id ever sent
// (unchanged single-org behavior). Several: the user must pick before
// anything loads; the pick is remembered and re-validated silently.
async function loadOrgs(generation: number): Promise<void> {
  setError(mainError, null);
  orgs = [];
  activeOrgId = null;
  renderOrgContext();
  orgSelect.disabled = true;
  orgSelect.replaceChildren(new Option("Loading organizations…", ""));
  // Search requires a resolved org — hidden until one resolves
  // (the identity-guard rule applies to standalone mode too). Nothing
  // org-scoped shows until this load lands.
  orgReady = false;
  renderModeSurfaces();
  hideSearchResults();
  renderProviderCard(null);
  renderIdentityGuard();
  invalidateFillSelection();

  const response = await sendToBackground({ type: "LIST_MY_ORGS" });
  // A newer sign-out / re-entry superseded this load — discard silently.
  if (!isCurrent(generation)) return;
  if (!response.ok) {
    orgSelect.replaceChildren(new Option("Unavailable", ""));
    setError(mainError, response.error);
    return;
  }
  orgs = response.data;
  membershipsLoaded = true;
  // Roles are only known now, so this is the first honest moment to check
  // whether the stored job is still allowed. A session mode outlives a role
  // change, and leaving someone pressed into Train forms with the button
  // hidden would strand them on a surface they cannot leave.
  await enforceModePermission();
  if (!isCurrent(generation)) return;

  if (orgs.length === 0) {
    orgSelect.replaceChildren(new Option("No organizations", ""));
    setError(
      mainError,
      "Your account isn't a member of any organization in Minted Panel yet. Ask an admin to invite you.",
    );
    return;
  }

  const sole = orgs.length === 1 ? orgs[0] : undefined;
  if (sole) {
    const workOrgId = activeWorkState.status === "none"
      ? null
      : activeWorkState.status === "blocked"
        ? activeWorkState.orgId
        : activeWorkState.record.tuple.orgId;
    if (workOrgId === sole.orgId) {
      // Work-v2 requires the validated org id to remain selected so the
      // worker can pin every fill to the same membership.
      activeOrgId = sole.orgId;
    } else {
      // Clearing any stored org id also wipes stale multi-org leftovers in
      // the worker (SET_ACTIVE_ORG clears org-scoped state on change).
      await sendToBackground({ type: "SET_ACTIVE_ORG", orgId: null });
      if (!isCurrent(generation)) return;
      activeOrgId = null;
    }
    orgSelect.replaceChildren(
      new Option(orgLabel(sole), sole.orgId, true, true),
    );
    renderOrgContext();
    orgReady = true;
    renderModeSurfaces();
    renderIdentityGuard();
    await loadProviders(generation);
    void loadPortalRegistry(generation);
    return;
  }

  const stored = await sendToBackground({ type: "GET_ACTIVE_ORG" });
  if (!isCurrent(generation)) return;
  const storedId =
    stored.ok && orgs.some((o) => o.orgId === stored.data) ? stored.data : null;
  if (stored.ok && stored.data != null && storedId == null) {
    // Membership to the remembered org is gone: drop silently (the worker
    // clears that org's dependent state too).
    await sendToBackground({ type: "SET_ACTIVE_ORG", orgId: null });
    if (!isCurrent(generation)) return;
  }
  activeOrgId = storedId;
  renderOrgContext();
  orgSelect.replaceChildren();
  const placeholder = new Option(
    "Pick the organization you're working in",
    "",
    true,
    storedId == null,
  );
  placeholder.disabled = true;
  orgSelect.add(placeholder);
  for (const org of orgs) {
    orgSelect.add(
      new Option(orgLabel(org), org.orgId, false, org.orgId === storedId),
    );
  }
  orgSelect.disabled = false;
  renderIdentityGuard();
  orgReady = activeOrgId != null;
  renderModeSurfaces();
  if (activeOrgId != null) {
    await loadProviders(generation);
    void loadPortalRegistry(generation);
  } else {
    updateFillReady();
  }
}

// The active tab in the panel's window. Its url is visible to us only for
// origins we hold host permissions on (the portals) — for every other page
// it comes back undefined, which matchPortal already treats as "no portal".
async function queryActiveTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab ?? null;
  } catch {
    return null;
  }
}

// Fetch portal registry for the current org, then re-run portal
// detection — a page that wasn't recognized before the rows arrived becomes
// recognized the moment they do. A successful empty list is a loud empty-
// state (not "wrong page"); a fetch failure keeps the banner hidden and
// degrades recognition to nothing.
async function loadPortalRegistry(generation: number): Promise<void> {
  portalRegistryLoaded = false;
  const response = await sendToBackground({ type: "LIST_PORTALS" });
  if (!isCurrent(generation)) return;
  portalRegistryLoaded = response.ok;
  portalRows = response.ok ? response.data : [];
  portalRegistryEmpty.hidden = !(response.ok && portalRows.length === 0);
  void detectPortal();
}

let detectedPageUrl: string | null = null;
let detectedPortalIdentity: string | null = null;
async function detectPortal(): Promise<void> {
  // Train uses the shared registry + sticky selection messaging (TRAIN-DUAL).
  // Do not overwrite `portal` from the Work `portalRows` list while training.
  if (panelMode === "train") {
    await refreshTrainRecognition();
    return;
  }
  const tab = await queryActiveTab();
  const hasWorkContext = activeWorkState.status !== "none";
  const pageUrl = await activePageUrlForTab(tab, hasWorkContext);
  const workRecord = activeWorkRecordForTab(tab, pageUrl);
  const nextPortal = hasWorkContext
    ? workRecord == null ? null : matchedActiveWorkPortal(workRecord)
    : matchPortalByUrl(pageUrl, portalRows);
  const nextIdentity = nextPortal == null
    ? null
    : `${nextPortal.portalId}:${nextPortal.key}:${nextPortal.mappingGeneration}:${workRecord?.tuple.launchReceiptId ?? "legacy"}`;
  const pageChanged = portalTabId !== (nextPortal != null ? tab?.id ?? null : null) ||
    detectedPageUrl !== pageUrl || detectedPortalIdentity !== nextIdentity;
  if (pageChanged) {
    invalidateFillSelection();
    // A test-mode result belongs to the page it ran on.
    if (sandboxActive) {
      resetSandboxResult();
      renderSandboxBar();
    }
  }
  detectedPageUrl = pageUrl;
  detectedPortalIdentity = nextIdentity;
  detectedTabId = tab?.id ?? null;
  portal = nextPortal;
  portalTabId = portal != null && tab?.id != null ? tab.id : null;
  updateFillReady();
  // The active-cases heading + THIS PAGE chips reflect the detected page.
  renderActiveCases();
  renderCapture();
  renderCaqh();
  void refreshPortalAccessPrompt();
}

// The one-click grant for this org's registered portals. Recognition and the
// content-script injection both need host permission for the portal's origin,
// but the manifest may ship static access to specific portals — every other DB-registered portal
// stays unreadable until the user grants its origin. The prompt shows
// only when we're NOT already on a recognized portal AND we lack access to at
// least one registered origin; on a recognized page or once all are granted it
// stays hidden. Reads the registry we already fetched, so it needs no host
// permission to decide what to ask for.
async function refreshPortalAccessPrompt(): Promise<void> {
  const revision = await updatePortalAccessPrompt();
  // The ask sits in Fill's spot, so the task card follows whatever the
  // latest check decided (a stale check leaves it to the newer one).
  if (revision === portalAccessPromptRevision) renderTaskCard();
}

async function updatePortalAccessPrompt(): Promise<number> {
  const revision = ++portalAccessPromptRevision;
  portalAccess.hidden = true;
  workPortalAccess.hidden = true;
  workPortalAccessCandidate = null;

  // Work portals can intentionally be absent from LIST_PORTALS. Ask the
  // worker for a fresh Panel-validated target; the panel never derives a new
  // payer origin from the page or from the handoff message.
  if (panelMode === "case" && activeWorkState.status === "active") {
    const tab = await queryActiveTab();
    const pageUrl = await activePageUrlForTab(tab, true);
    const record = activeWorkRecordForTab(tab, pageUrl);
    if (
      record != null &&
      portal != null &&
      portalTabId === tab?.id &&
      portal.portalId === record.tuple.portalId &&
      (!portalRegistryLoaded || workPortalAbsentFromRegistry(record, portalRows))
    ) {
      const targetResponse = await sendToBackground({ type: "GET_WORK_PORTAL_PERMISSION_TARGET" });
      if (revision !== portalAccessPromptRevision) return revision;
      const target = targetResponse.ok ? targetResponse.data : null;
      const pattern = target == null ? null : workPortalPermissionPattern(target.origin);
      if (
        target != null && pattern != null &&
        workPortalGrantTargetMatches(target, record, tab?.id ?? null)
      ) {
        const alreadyGranted = await hasOriginPermissions([pattern]);
        if (revision !== portalAccessPromptRevision) return revision;
        if (!alreadyGranted) {
          workPortalAccessCandidate = { ...target, pattern };
          const payer = payerLabel();
          workAccessTitle.textContent = `One-time setup for this ${payer} site`;
          workPortalAccessGrant.textContent = `Allow Minted on this ${payer} site`;
          if (workAccessDenied) {
            fillNotice(workAccessNote, "warn", [
              `Minted can't fill this site without your OK. You can still copy values from Provider details below.`,
            ]);
          } else {
            workAccessNote.className = "btn-note";
            workAccessNote.textContent = "Chrome will ask. Click Allow.";
          }
          workPortalAccess.hidden = false;
        } else {
          workAccessDenied = false;
        }
        return revision;
      }
    }
  }

  if (portal != null) return revision;
  // The origins to ask for come from whichever registry this job works
  // against: the org's in case mode, the shared library's while training.
  const patterns = portalOriginPatterns(
    panelMode === "train" ? sharedPortalRows : portalRows,
  );
  if (patterns.length === 0) {
    portalAccess.hidden = true;
    return revision;
  }
  const training = panelMode === "train";
  portalAccessText.textContent = training ? TRAIN_ACCESS_TEXT : CASE_ACCESS_TEXT;
  portalAccessGrant.textContent = training ? TRAIN_ACCESS_BUTTON : CASE_ACCESS_BUTTON;
  portalAccess.hidden = await hasOriginPermissions(patterns);
  return revision;
}

function workPortalPermissionPattern(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "https:" || parsed.origin !== origin ||
      parsed.username !== "" || parsed.password !== ""
    ) return null;
    return `${parsed.origin}/` + "*";
  } catch {
    return null;
  }
}

function workPortalAbsentFromRegistry(
  record: ActiveWorkRecord,
  rows: PortalRegistryRow[],
): boolean {
  return !rows.some((row) => row.id === record.tuple.portalId || row.portalKey === record.tuple.portalKey);
}

function workPortalGrantTargetMatches(
  target: WorkPortalPermissionTarget,
  record: ActiveWorkRecord,
  activeTabId: number | null,
): boolean {
  return !isActiveWorkExpired(record, Date.now()) && activeTabId != null && target.tabId === activeTabId &&
    target.tabId === record.boundTabId && target.origin === record.formOrigin &&
    target.launchReceiptId === record.tuple.launchReceiptId;
}

async function hasOriginPermissions(origins: string[]): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins });
  } catch {
    return false;
  }
}

portalAccessGrant.addEventListener("click", () => {
  const patterns = portalOriginPatterns(
    panelMode === "train" ? sharedPortalRows : portalRows,
  );
  if (patterns.length === 0) return;
  portalAccessGrant.disabled = true;
  void (async () => {
    try {
      // Must run in the click's user gesture — request, then re-detect so a
      // now-readable portal tab is recognized without a reload.
      const granted = await chrome.permissions.request({ origins: patterns });
      if (granted) await detectPortal();
    } catch (error) {
      setError(
        mainError,
        error instanceof Error ? error.message : "Could not grant access",
      );
    } finally {
      portalAccessGrant.disabled = false;
    }
  })();
});

workPortalAccessGrant.addEventListener("click", () => {
  const candidate = workPortalAccessCandidate;
  if (candidate == null || workPortalAccess.hidden) return;
  const record = activeWorkState.status === "active" ? activeWorkState.record : null;
  if (record == null || !workPortalGrantTargetMatches(candidate, record, portalTabId)) {
    void refreshActiveWork(false);
    return;
  }
  workPortalAccessGrant.disabled = true;
  // This API call must stay synchronous in the click handler so Chrome sees
  // the user gesture. It requests one server-validated HTTPS origin only.
  let grantRequest: Promise<boolean>;
  try {
    grantRequest = chrome.permissions.request({ origins: [candidate.pattern] });
  } catch (error) {
    workPortalAccessGrant.disabled = false;
    setError(
      mainError,
      error instanceof Error ? error.message : "Could not grant access to this Work portal",
    );
    return;
  }
  void (async () => {
    try {
      const granted = await grantRequest;
      workAccessDenied = !granted;
      if (!granted) return;
      const response = await sendToBackground({ type: "GET_WORK_PORTAL_PERMISSION_TARGET" });
      const target = response.ok ? response.data : null;
      const currentRecord = activeWorkState.status === "active" ? activeWorkState.record : null;
      const stillCurrent = target != null && currentRecord != null && panelMode === "case" &&
        (!portalRegistryLoaded || workPortalAbsentFromRegistry(currentRecord, portalRows)) &&
        workPortalGrantTargetMatches(target, currentRecord, portalTabId);
      if (!stillCurrent || target == null || target.origin !== candidate.origin ||
          target.tabId !== candidate.tabId || target.launchReceiptId !== candidate.launchReceiptId) {
        // The exact Work may expire or switch while Chrome displays its grant
        // prompt. Revoke only the origin just granted if that authorization
        // no longer matches the server-validated Work target.
        await chrome.permissions.remove({ origins: [candidate.pattern] });
      }
      await refreshActiveWork(false);
    } catch (error) {
      setError(
        mainError,
        error instanceof Error ? error.message : "Could not grant access to this Work portal",
      );
    } finally {
      workPortalAccessGrant.disabled = false;
      await refreshPortalAccessPrompt();
    }
  })();
});

// The queue is the landing state: visible only while NOTHING is in hand
// (no provider/case selected in the panel). Selecting a case hides it;
// releasing shows it again — no confirmation either way.
function syncQueueVisibility(): void {
  const inHand = selectedProviderId() != null || selectedCaseId() != null;
  // B1: no queue under a launch that is still opening.
  if (inHand || caseOpening()) {
    queueSection.hidden = true;
    return;
  }
  if (queueSection.hidden && orgResolved()) void loadQueue(loadGeneration);
}

// The panel reflects the ACTIVE tab: re-detect on tab switch and on
// navigation in the active tab (a fill result stays on screen — the user
// hops to the portal tab to submit, then comes back for Mark submitted).
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (lastAiReview && !lastAiReview.accepted && tabId !== lastFillTabId) {
    lastAiReview = { ...lastAiReview, status: "error" };
    renderAiReview(lastAiReview);
  }
  void detectPortal();
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (
    _tabId === lastFillTabId && changeInfo.url != null &&
    changeInfo.url !== lastFillPageUrl && lastAiReview && !lastAiReview.accepted
  ) {
    lastAiReview = { ...lastAiReview, status: "error" };
    renderAiReview(lastAiReview);
  }
  if (
    tab.active &&
    (changeInfo.url != null || changeInfo.status === "complete")
  ) {
    void detectPortal();
  }
});

function showMain(auth: AuthState): void {
  renderAccountRow(auth.name, auth.email);
  showView("main");
  void (async () => {
    // The worker owns the mode (it decides whether a call carries x-org-id),
    // and a hand-off received while the panel was closed has already forced it
    // to case — so read it BEFORE deciding which loaders to run.
    const modeResponse = await sendToBackground({ type: "GET_PANEL_MODE" });
    panelMode = modeResponse.ok ? modeResponse.data : DEFAULT_PANEL_MODE;
    applyPanelMode();
    const workResponse = await sendToBackground({ type: "GET_ACTIVE_WORK" });
    if (workResponse.ok) activeWorkState = workResponse.data;
    if (panelMode === "train") {
      // Training loads no org, but the ADMIN gate is a fact about memberships
      // — so read them anyway (a user-scoped call, no org header) or a
      // trainer's own tab would render with its button hidden.
      void refreshTrainEligibility();
      await loadSharedRegistry();
      void restoreCapture();
      return;
    }
    // Fresh context: this restore load (and every loader it chains into) runs
    // under one generation so it populates uninterrupted. The handoff check
    // runs AFTER orgs load — the org validation needs the membership list.
    void whileWorkOpens(async () => {
      await loadOrgs(bumpGeneration());
      await refreshActiveCase();
    });
    void detectPortal();
    void restoreCapture();
  })();
}

// Account row: forest avatar circle with the user's white initial; the menu
// initial; the menu holds the email and Sign out. The initial comes from the
// same name source as the greeting (auth user_metadata, else the email's
// first letter).
function renderAccountRow(name: string | null, email: string | null): void {
  const greeting = accountGreeting(name, email);
  const source = (name ?? "").trim() || (email ?? "").trim();
  avatarBtn.textContent = (source.charAt(0) || "?").toUpperCase();
  avatarBtn.title = greeting;
  accountEmail.textContent = email ?? greeting;
}

function closeAvatarMenu(): void {
  avatarMenu.hidden = true;
  avatarBtn.setAttribute("aria-expanded", "false");
}

avatarBtn.addEventListener("click", () => {
  const open = avatarMenu.hidden;
  avatarMenu.hidden = !open;
  avatarBtn.setAttribute("aria-expanded", String(open));
});

// Click-away + Escape close the menu (it must never trap the panel).
document.addEventListener("click", (event) => {
  if (avatarMenu.hidden) return;
  const target = event.target as Node;
  if (!avatarMenu.contains(target) && !avatarBtn.contains(target))
    closeAvatarMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeAvatarMenu();
});

// `expired` is true only when a request came back 401 mid-work
// (handleSessionExpired). The worker keeps the linked case for the same user.
function showSignin(expired = false): void {
  signinForm.reset();
  setError(signinError, null);
  showView("signin");
  identityGuard.hidden = true;
  // Apply pending handoff after sign-in is a first-class path — the
  // sign-in view says a case is waiting instead of silently dropping it.
  signinHandoffHint.hidden = true;
  signinExpiredHint.hidden = true;
  void (async () => {
    const [caseResponse, workResponse] = await Promise.all([
      sendToBackground({ type: "GET_ACTIVE_CASE" }),
      expired ? sendToBackground({ type: "GET_ACTIVE_WORK" }) : Promise.resolve(null),
    ]);
    const record = caseResponse.ok && caseResponse.data.status === "active"
      ? caseResponse.data.record
      : null;
    const workLinked = workResponse?.ok === true && workResponse.data.status === "active";
    // A4 when the session ended with a case or launch linked, else A3.
    const showExpired = expired && (record != null || workLinked);
    signinExpiredHint.hidden = !showExpired;
    signinHandoffHint.hidden = showExpired || record?.source !== "handoff";
  })();
  emailInput.focus();
}

// The worker answers 401 only after its own refresh failed, so the session
// is gone (A4). Fall back to the sign-in view; worker state is kept.
function handleSessionExpired(): void {
  if (views.main.hidden) return;
  bumpGeneration();
  resetPanelSession();
  showSignin(true);
}

// Every panel request goes through here so a dead session reaches the
// sign-in view instead of an error box.
function sendToBackground<T extends BgRequest["type"]>(
  request: Extract<BgRequest, { type: T }>,
): Promise<BgResponse<BgResponseMap[T]>> {
  return sendToWorker<T>(request).then((response) => {
    if (!response.ok && response.code === 401) handleSessionExpired();
    return response;
  });
}

signinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    setError(signinError, null);
    signinBtn.disabled = true;
    signinBtn.textContent = "Signing in…";
    const response = await sendToBackground({
      type: "SIGN_IN",
      email: emailInput.value.trim(),
      password: passwordInput.value,
    });
    signinBtn.disabled = false;
    signinBtn.textContent = "Sign in";
    if (!response.ok) {
      setError(signinError, response.error);
      return;
    }
    showMain(response.data);
  })();
});

signoutBtn.addEventListener("click", () => {
  // Invalidate any in-flight loader so a late response can't render into the
  // now-hidden main view after sign-out.
  bumpGeneration();
  void (async () => {
    await sendToBackground({ type: "SIGN_OUT" });
    resetPanelSession();
    // A held log form and its entries never carry over to the next person.
    resetLogState();
    payerRefInput.value = "";
    wipNoteInput.value = "";
    showSignin();
  })();
});

// The panel's in-memory session. Sign-out and an expired session both clear
// it; on expiry the worker keeps its own state for the same user.
function resetPanelSession(): void {
  // The sandbox's designated provider is org-specific and the panel is
  // about to lose all org context — leaving it "active" would carry stale
  // sandbox chrome into the next sign-in.
  clearSandboxOnRealSelection();
  orgs = [];
  membershipsLoaded = false;
  orgReady = false;
  activeOrgId = null;
  renderOrgContext();
  providers = [];
  cases = [];
  casesLoadedFor = null;
  facilities = [];
  facilitiesLoaded = false;
  needsFacility = false;
  caseContextCaseId = null;
  // Sign-out clears in-memory values the panel holds —
  // cards, context, search results, banners, the touch draft.
  activeCase = null;
  activeCaseStatus = "none";
  appliedHandoffSelection = null;
  applyingHandoffKey = null;
  rejectedHandoffKey = null;
  handoffNotice = null;
  renderHandoffBanner();
  renderQuickCards(null);
  renderActiveCases();
  hideSearchResults();
  searchInput.value = "";
  resetTouchForm();
  renderCaseContext(null);
}

refreshBtn.addEventListener("click", () => {
  const generation = bumpGeneration();
  void loadProviders(generation);
  void loadPortalRegistry(generation);
});

orgSelect.addEventListener("change", () => {
  const orgId = orgSelect.value || null;
  if (orgId == null || orgId === activeOrgId) return;
  // Bump synchronously so any in-flight loader for the previous org is
  // invalidated the instant the switch happens.
  const generation = bumpGeneration();
  void (async () => {
    // The sandbox's designated provider is org-specific — a stale sandbox
    // from the org just left must not survive into the one being entered.
    clearSandboxOnRealSelection();
    activeOrgId = orgId;
    renderOrgContext();
    // The worker wipes provider/case/facility/report state — including any
    // active-case context — before storing the new org; every call from here
    // on carries x-org-id.
    await sendToBackground({ type: "SET_ACTIVE_ORG", orgId });
    if (!isCurrent(generation)) return;
    invalidateFillSelection();
    hideSearchResults();
    orgReady = true;
    renderModeSurfaces();
    renderIdentityGuard();
    await loadProviders(generation);
    void loadPortalRegistry(generation);
    // A handoff pending for THIS org can now apply (the switch prompt's path).
    await refreshActiveCase();
  })();
});

// The provider bar's one button: back to Search, which IS the switcher now.
providerBarSwitch.addEventListener("click", () => {
  void setPanelMode("search");
  searchInput.focus();
});

groupSelect.addEventListener("change", () => {
  selectedGroupId = groupSelect.value || null;
  invalidateFillSelection();
  renderQuickCards(null);
  void syncSelectedGroup().catch((error: unknown) => setError(mainError, error instanceof Error ? error.message : "Could not select group"));
  const providerId = selectedProviderId();
  const facilityId = selectedFacilityId();
  if (providerId && facilityId) void refreshFacilityCards(providerId, facilityId, loadGeneration);
  updateFillReady();
});

facilitySelect.addEventListener("change", () => {
  invalidateFillSelection();
  renderQuickCards(null);
  const providerId = selectedProviderId();
  const facilityId = selectedFacilityId();
  if (providerId && applyingHandoffKey == null) {
    void sendToBackground({
      type: "SET_SELECTED_FACILITY",
      providerId,
      facilityId,
    });
  }
  renderFacilityAddress();
  renderIdentityGuard();
  updateFillReady();
  if (providerId && facilityId) {
    void refreshFacilityCards(providerId, facilityId, loadGeneration);
  }
});

// The one case-selection routine every entry path funnels into: the manual
// dropdown, the active-cases rows, search case results, the NBA handback, and
// the handoff apply. A USER-initiated choice also enters the worker's
// active-case state (same semantics as a handoff);
// the handoff apply passes recordEntry=false so it never overwrites the
// handoff record it is applying.
function applyCaseChoice(caseId: string | null, recordEntry: boolean): void {
  // A real case selection always wins over a leftover sandbox: the sandbox
  // bar previously stayed up (and hid the real Fill button) until the
  // explicit Exit was clicked, which meant "Sandbox fill" could still run
  // against whatever provider a real case pick had since loaded. Clearing it
  // here — the funnel every real case pick goes through (dropdown,
  // active-cases row, NBA handback, handoff apply) — closes that gap.
  clearSandboxOnRealSelection();
  const providerId = selectedProviderId();
  // A case pick should land on that case's facility once context arrives —
  // not a leftover remembered location from another case on the same provider.
  preferCaseFacility = caseId != null;
  if (providerId) {
    void sendToBackground({ type: "SET_SELECTED_CASE", providerId, caseId: caseSelect.value === AD_HOC_CASE_SELECTION ? AD_HOC_CASE_SELECTION : caseId });
    if (recordEntry) {
      if (caseId != null) {
        void (async () => {
          await sendToBackground({
            type: "ENTER_ACTIVE_CASE",
            caseId,
            providerId,
            orgId: activeOrgId,
          });
          // Entering a case supersedes any expired/previous context — re-read so
          // the banner and gates reflect the fresh record.
          await refreshActiveCase(false);
        })();
      } else {
        void (async () => {
          await sendToBackground({
            type: "CLEAR_ACTIVE_CASE",
          });
          await refreshActiveCase(false);
        })();
      }
    }
  }
  renderCaseStatusPill();
  renderCaseNote();
  renderDuplicateGuard();
  renderActiveCases();
  renderGroupSelector(providers.find((p) => p.id === selectedProviderId()) ?? null);
  refreshCaseContext();
  invalidateFillSelection();
  renderQuickCards(null);
  const facilityId = selectedFacilityId();
  if (providerId && facilityId) void refreshFacilityCards(providerId, facilityId, loadGeneration);
  resetTouchForm();
  updateFillReady();
}

caseSelect.addEventListener("change", () => {
  applyCaseChoice(selectedCaseId(), true);
});

bindAiReviewActions(
  { accept: fillAiAcceptBtn, clear: fillAiClearBtn, retry: fillAiRetryBtn },
  {
    getReview: () => lastAiReview,
    getTabId: () => lastFillTabId,
    getFillSessionId: () => lastFill?.fillSessionId ?? null,
    isSubmitted: () => lastFill?.submitted === true || lastAiReview?.learning?.state === "pending" ||
      lastAiReview?.learning?.state === "learned",
    accept: (tabId, fillSessionId) => sendToBackground({ type: "ACCEPT_AI_FILL", tabId, fillSessionId }),
    clear: (tabId, fillSessionId) => sendToBackground({ type: "CLEAR_AI_FILL", tabId, fillSessionId }),
    retry: (fillSessionId) => sendToBackground({ type: "RETRY_AI_LEARNING", fillSessionId }),
    update: (review, submitted) => renderAiReview(review, { completedAt: "", submitted }),
    showError: (message) => setError(mainError, message),
  },
);

// Fill problems show on the task card with a support code (C7 to C11).
const FILL_TAB_MOVED = "The form's tab is no longer the active tab. Switch back to it, then click Fill this page again.";
const FILL_PAGE_CHANGED = "The page changed while Minted was filling, so nothing was filled. Click Fill this page again.";
const FILL_PAGE_MOVED_ON = "The page changed after Minted filled it. Check the form, then click Fill this page again if you need to.";
const FILL_SELECTION_CHANGED = "You changed the case while Minted was filling. The form may be partly filled. Check it, then click Fill this page again.";
const FILL_FAILED = "Something on this page stopped the fill. Try again, or fill it by hand.";

function fillLostPageText(): string {
  const payer = selectedCaseId() != null ? payerLabel() : (portal?.label ?? "payer");
  return `Minted lost touch with the ${payer} page. Reload it, then click Fill this page again.`;
}

// Who and where a fill is for. A different key after a fill means the
// coordinator changed the selection while it ran.
function fillSelectionKey(): string {
  return [selectedProviderId(), selectedCaseId() ?? caseSelect.value, selectedFacilityId(), selectedGroupId].join("|");
}

function showFillProblem(text: string, code: string | number | null, reloadTabId: number | null = null): void {
  const extra: HTMLElement[] = [];
  if (reloadTabId != null) {
    extra.push(noticeButton("Reload page", "secondary", () => {
      void chrome.tabs.reload(reloadTabId).catch(() => undefined);
    }));
  }
  extra.push(supportButton(code, null, "danger"));
  fillNotice(fillProblem, "danger", [text], extra);
  renderTaskCard();
}

fillBtn.addEventListener("click", () => {
  // Capture the selection generation at click. If the operator switches
  // provider/org/case while this fill is in flight, the generation changes and
  // the result is discarded rather than rendered under the wrong provider —
  // the same wrong-record guard the loaders use. The fill itself still ran and
  // is logged server-side against the click-time provider/case.
  if (!isFillReady()) return;
  invalidateFillSelection();
  const generation = loadGeneration;
  const revision = fillSelectionRevision;
  const groupId = selectedGroupId;
  const state = selectedCaseState();
  const isFillCurrent = () => isCurrent(generation) && revision === fillSelectionRevision;
  const providerId = selectedProviderId();
  const caseId = selectedCaseId();
  const facilityId = selectedFacilityId();
  // Same hard gates the disabled state enforces: org resolved, provider,
  // facility resolved. Case is optional for ad hoc fills.
  if (!orgResolved() || !providerId) return;
  if (!facilitiesLoaded || (needsFacility && facilityId == null)) return;
  const clickSelection = fillSelectionKey();
  void (async () => {
    // The panel outlives tab switches, so never trust detection state from
    // earlier: re-read the active tab and re-match its URL at click time.
    let tab: chrome.tabs.Tab | null;
    let hasWorkContext: boolean;
    let originalUrl: string | null;
    let workRecord: ActiveWorkRecord | null;
    try {
      tab = await queryActiveTab();
      if (!isFillCurrent()) return;
      hasWorkContext = activeWorkState.status !== "none";
      originalUrl = await activePageUrlForTab(tab, hasWorkContext);
      if (!isFillCurrent()) return;
      workRecord = activeWorkRecordForTab(tab, originalUrl);
      // A Work selection is valid only on its exact bound tab and URL. Keep a
      // stale or mismatched Work context closed instead of falling through to
      // legacy selection writes or URL-based fill recognition.
      if (hasWorkContext && workRecord == null) {
        showFillProblem(FILL_TAB_MOVED, "tab");
        return;
      }
      // Work carries its own provider/case/facility tuple. The UI's legacy
      // group selector may default to a primary group even though Work has no
      // group, so never persist that display-only value for an exact Work fill.
      if (workRecord == null) {
        await syncSelectedGroup();
        if (!isFillCurrent()) return;
        // Legacy selection persistence can take time. Re-read the active tab
        // after it settles so a tab switch cannot leave this fill bound to the
        // page captured before that await.
        tab = await queryActiveTab();
        if (!isFillCurrent()) return;
        hasWorkContext = activeWorkState.status !== "none";
        originalUrl = await activePageUrlForTab(tab, hasWorkContext);
        if (!isFillCurrent()) return;
        workRecord = activeWorkRecordForTab(tab, originalUrl);
        if (hasWorkContext && workRecord == null) {
          showFillProblem(FILL_TAB_MOVED, "tab");
          return;
        }
      }
    } catch (error) {
      showFillProblem(error instanceof Error ? error.message : "Could not save the group. Try again.", "group");
      return;
    }
    if (!isFillCurrent()) return;
    const fillGroupId = workRecord == null ? groupId : null;
    const clickPortal = hasWorkContext
      ? workRecord == null ? null : matchedActiveWorkPortal(workRecord)
      : matchPortalByUrl(tab?.url, portalRows);
    portal = clickPortal;
    portalTabId = clickPortal != null && tab?.id != null ? tab.id : null;
    updateFillReady();
    if (!clickPortal || tab?.id == null) {
      showFillProblem(FILL_TAB_MOVED, "tab");
      return;
    }
    setError(mainError, null);
    fillBtn.disabled = true;
    fillBtn.textContent = "Filling…";
    fillBtn.classList.add("filling");
    fillRunning = true;
    renderTaskCard();
    let response: Awaited<ReturnType<typeof sendToBackground<"FILL">>>;
    try {
      let aiScanId: string | undefined;
      let aiMatches: Array<{ selector: string; token: string; confidence: number }> = [];
      let aiStatus: "unavailable" | "no-matches" | "error" | undefined;
      const nanoReady = AI_FILL_ENABLED ? await canUseNano() : false;
      if (!isFillCurrent()) return;
      if (!AI_FILL_ENABLED) {
        // AI is off: no scan, no status, so the fill reports no AI review.
      } else if (!nanoReady) {
        aiStatus = "unavailable";
      } else {
        const prepared = await sendToBackground({
          type: "PREPARE_AI_FILL",
          tabId: tab.id,
          providerId,
          caseId: caseId ?? null,
          portalKey: clickPortal.key,
          portalId: clickPortal.portalId,
          mappingGeneration: clickPortal.mappingGeneration,
          state,
          facilityId,
          groupId: fillGroupId,
        });
        if (!isFillCurrent()) return;
        if (prepared.ok) {
          aiScanId = prepared.data.scanId;
          const boundedControls = prepared.data.controls.slice(0, NANO_LIMITS.maxControls);
          const matches = await matchUnmappedFields(boundedControls, prepared.data.tokenCatalog);
          aiMatches = matches.filter((match) => match.confidence >= 0.85);
          if (aiMatches.length === 0) aiStatus = "no-matches";
        } else if (/selection changed|form changed|expired/i.test(prepared.error)) {
          showFillProblem(prepared.error, "ai-prepare");
          return;
        } else {
          aiStatus = "error";
        }
      }

      // A delayed local prompt never gets to apply to another active tab or a
      // new document. The worker repeats this binding check before writes.
      const currentTab = await queryActiveTab();
      const currentPageUrl = await activePageUrlForTab(currentTab, hasWorkContext);
      const currentWorkRecord = activeWorkRecordForTab(currentTab, currentPageUrl);
      const currentPortal = hasWorkContext
        ? currentWorkRecord == null ? null : matchedActiveWorkPortal(currentWorkRecord)
        : matchPortalByUrl(currentTab?.url, portalRows);
      if (
        !isFillCurrent() || currentTab?.id !== tab.id ||
        currentPageUrl !== originalUrl ||
        currentPortal?.portalId !== clickPortal.portalId ||
        currentPortal?.key !== clickPortal.key ||
        currentPortal?.mappingGeneration !== clickPortal.mappingGeneration
      ) {
        showFillProblem(FILL_PAGE_CHANGED, "page-changed");
        return;
      }

      response = await sendToBackground({
        type: "FILL",
        tabId: tab.id,
        providerId,
        caseId: caseId ?? null,
        portalKey: clickPortal.key,
        portalId: clickPortal.portalId,
        mappingGeneration: clickPortal.mappingGeneration,
        state,
        facilityId,
        groupId: fillGroupId,
        ...(aiScanId ? { aiScanId, aiMatches } : {}),
        ...(aiStatus ? { aiStatus } : {}),
      });
    } catch (error) {
      showFillProblem(error instanceof Error ? error.message : FILL_FAILED, "fill");
      return;
    } finally {
      fillBtn.textContent = "Fill this page";
      fillBtn.disabled = false;
      fillBtn.classList.remove("filling");
      fillRunning = false;
      updateFillReady();
    }
    // Selection changed mid-fill: drop this result so it can't render under
    // the case now selected, and say so (C11): the form may be partly filled.
    if (!isFillCurrent()) {
      if (response.ok) {
        showFillProblem(
          fillSelectionKey() === clickSelection ? FILL_PAGE_MOVED_ON : FILL_SELECTION_CHANGED,
          "dropped",
        );
      }
      return;
    }
    if (!response.ok) {
      const lostPage = /could not establish connection|receiving end does not exist|could not reach the enrollment form|no tab with id|cannot access|cannot be scripted/i
        .test(response.error);
      if (lostPage) showFillProblem(fillLostPageText(), response.code ?? "no-page", tab.id);
      else showFillProblem(response.error, response.code ?? "fill");
      return;
    }
    lastFill = {
      providerId,
      caseId: caseId ?? null,
      portalKey: clickPortal.key,
      fillSessionId: response.data.fillSessionId,
      isWorkFill: response.data.workContext != null,
      workContext: response.data.workContext ?? null,
      workCaseType: response.data.workCaseType ?? null,
      submitted: false,
    };
    lastFillTabId = tab.id;
    lastFillPageUrl = originalUrl;
    renderFillSummary(response.data);
  })();
});

// After logging, refresh the case list so the status pill and the
// duplicate guard see the new state. Best-effort and generation-guarded.
async function refreshCasesAfterSubmit(providerId: string): Promise<void> {
  const generation = loadGeneration;
  const response = await sendToBackground({ type: "LIST_CASES", providerId });
  if (!isCurrent(generation) || !response.ok) return;
  cases = response.data;
  renderCaseStatusPill();
  renderCaseNote();
  renderTaskCard();
}

// Moves focus to the first of these that shows, once the control she used
// has hidden, so keyboard and screen reader users keep their place.
function focusFirstShown(...targets: HTMLElement[]): void {
  const target = targets.find((node) => node.isConnected && node.closest("[hidden]") == null);
  target?.focus({ preventScroll: true });
}

// A log failure interrupts; everything else waits its turn.
function setLiveRole(box: HTMLElement, role: "status" | "alert"): void {
  box.setAttribute("role", role);
  box.setAttribute("aria-live", role === "alert" ? "assertive" : "polite");
}

// "Submitted on {payer}? Log it": works with or without a fill (B2). After a
// refusal ("Log it again") the form opens with her entries.
function openLogForm(): void {
  if (!canLogSubmission()) return;
  if (submitPhase !== "failed") resetSubmitInputs();
  dupConfirmPending = false;
  lastLogFailure = null;
  submitPhase = "form";
  logScope = logScopeKey();
  renderTaskCard();
  focusFirstShown(payerRefInput, markSubmittedBtn);
}

logLink.addEventListener("click", openLogForm);

// A manual log picks its task again on every try, so after a refusal she can
// check the case and log again. Typed Work can't: the same launch sends the
// same step and gets the same answer (E10). Only a relaunch changes it, and a
// relaunch starts fresh anyway.
function relogButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link";
  button.textContent = "Log it again";
  button.addEventListener("click", openLogForm);
  return button;
}

// Closing the form puts focus back on Log it, or on the task title.
function closeLogForm(): void {
  resetLogState();
  renderTaskCard();
  focusFirstShown(logLink, taskToggle);
}

submitBackBtn.addEventListener("click", closeLogForm);

dupCancelBtn.addEventListener("click", closeLogForm);

fillAgainBtn.addEventListener("click", () => {
  fillBtn.click();
});

function logNextLink(link: "task" | "case" | null, caseId: string, taskId: string | null): HTMLElement[] {
  if (link === "task" && taskId != null) return [externalLink("Open task in Minted Panel ↗", taskUrl(taskId))];
  if (link === "case" || link === "task") return [externalLink("Open case in Minted Panel ↗", caseUrl(caseId))];
  return [];
}

// Pressed by the human only after they submit the portal form themselves.
// The worker reuses one idempotency id per attempt, so a retry after a
// failure can never double-log. Typed Work is bound to its exact launch or
// saved fill; a manual log closes a task only under the 9.2 rule.
markSubmittedBtn.addEventListener("click", () => {
  const caseId = selectedCaseId();
  const providerId = selectedProviderId();
  if (caseId == null || providerId == null || !canLogSubmission()) return;
  if (submitPhase !== "form" && submitPhase !== "failed") return;

  // E3: a case logged as submitted recently asks once, with a way out.
  if (!dupConfirmPending && submitPhase === "form") {
    const phrase = recentSubmissionPhrase(cases.find((c) => c.id === caseId));
    if (phrase != null && !dismissedDupCaseIds.has(caseId)) {
      dupConfirmPending = true;
      dupWarn.textContent = `This case was already logged as submitted ${phrase}. Log it again?`;
      renderTaskCard();
      return;
    }
  }

  const work = workRecordForSelectedCase();
  const fill = lastFill != null && lastFill.caseId === caseId ? lastFill : null;
  const isWork = work != null || fill?.isWorkFill === true;
  const plan = currentPlan();
  const taskId = !isWork && plan.kind === "manual" ? (manualTaskToClose(plan.tasks)?.taskId ?? null) : null;
  const linkTaskId = plan.kind === "work" ? (plan.task?.taskId ?? null) : (plan.tasks.length === 1 ? (plan.tasks[0]?.taskId ?? null) : null);
  const statusBefore = caseStatusNow();
  const confirmation = payerRefInput.value;
  const portalKey = work?.tuple.portalKey ?? fill?.portalKey ?? portal?.key ?? null;
  if (portalKey == null) return;
  const generation = loadGeneration;
  const scope = logScopeKey();

  submitPhase = "logging";
  logScope = scope;
  renderTaskCard();
  void (async () => {
    setError(mainError, null);
    const response = await sendToBackground({
      type: "MARK_SUBMITTED",
      providerId: fill?.providerId ?? providerId,
      caseId,
      portalKey,
      fillSessionId: fill?.fillSessionId ?? null,
      isWorkFill: isWork,
      payerReferenceId: confirmation,
      wipNote: wipNoteInput.value,
      taskId,
      // Asks the panel to report what its trigger did to the case status.
      // Every submission log moves a Not Started or In Progress case.
      bumpStatus: true,
    });
    // A different case or a new launch dropped this log's state already.
    if (!isCurrent(generation) || selectedCaseId() !== caseId || logScopeKey() !== scope) return;
    if (!response.ok) {
      // Entries stay in the form. Only a request that never landed offers
      // Try again; a refusal points where it can be fixed (E9 to E11).
      const view = logFailureView(response.code, response.error, isWork ? "work" : "manual");
      submitPhase = "failed";
      lastLogFailure = view;
      setLiveRole(submitStatus, "alert");
      fillNotice(submitStatus, view.tone, [view.text], [supportButton(response.code ?? "offline", fill?.fillSessionId ?? null)]);
      const next = [
        ...logNextLink(view.link, caseId, linkTaskId),
        ...(!isWork && !view.retry ? [relogButton()] : []),
      ];
      submitNext.replaceChildren(...next);
      submitNext.hidden = next.length === 0;
      renderTaskCard();
      focusFirstShown(submitStatus, taskToggle);
      return;
    }
    const view: AfterLogView = afterLogView({
      plan,
      bump: response.data.statusBump,
      statusBefore,
      confirmationNumber: confirmation,
    });
    if (fill && lastFill === fill) lastFill = { ...fill, submitted: true };
    submitPhase = "done";
    logScope = scope;
    lastLogFailure = null;
    lastLogMoved = response.data.statusBump?.applied === true;
    dupConfirmPending = false;
    setLiveRole(submitStatus, "status");
    fillNotice(submitStatus, "ok", [{ text: view.headline, strong: true }, ...view.lines]);
    const next = logNextLink(view.link, caseId, linkTaskId);
    submitNext.replaceChildren(...next);
    submitNext.hidden = next.length === 0;
    renderTaskCard();
    focusFirstShown(submitStatus, taskToggle);
    // The status, last touch and task list changed on the server.
    void refreshCasesAfterSubmit(providerId);
    caseContextCaseId = null;
    void refreshCaseContext();
    void refreshNextBestAction(caseId);
  })();
});

// ---------------------------------------------------------------------------
// Active cases list under quick cards: the provider's open
// cases as clickable rows; clicking one enters the same active-case state as
// a handoff and lands in the fill loop.
// ---------------------------------------------------------------------------

// True when an open task references the current portal. True when any of its open
// portal-linked tasks names the detected portal's key (already-normalized
// literal match, the portalTasks contract).
function caseUsesDetectedPortal(c: CaseListItem): boolean {
  if (portal == null) return false;
  return (c.portalTasks ?? []).some((t) => t.portalKey === portal?.key);
}

function renderActiveCases(): void {
  const providerId = selectedProviderId();
  const show = providerId != null && cases.length > 0;
  activeCasesBox.hidden = !show;
  activeCasesList.replaceChildren();
  if (!show) return;
  const selected = selectedCaseId();

  // On a recognized portal, heading changes to "Cases that use
  // this page" and matching cases sort FIRST, each carrying a THIS PAGE chip.
  // Off a recognized page the list renders in server order under the default
  // heading. Stable within each half (no invented priority).
  const heading = activeCasesBox.querySelector<HTMLElement>(
    ".active-cases-heading",
  );
  const anyMatch =
    portal != null && cases.some((c) => caseUsesDetectedPortal(c));
  if (heading)
    heading.textContent = anyMatch ? "Cases that use this page" : "Open cases";
  const ordered = anyMatch
    ? [
        ...cases.filter(caseUsesDetectedPortal),
        ...cases.filter((c) => !caseUsesDetectedPortal(c)),
      ]
    : cases;

  for (const c of ordered) {
    const row = document.createElement("button");
    row.type = "button";
    row.className =
      c.id === selected ? "case-row case-row-selected" : "case-row";
    const title = document.createElement("span");
    title.className = "case-row-title";
    title.textContent = `${c.payerName ?? "Unknown payer"} · ${c.state}`;
    row.append(title);
    if (anyMatch && caseUsesDetectedPortal(c)) {
      const chip = document.createElement("span");
      chip.className = "pill this-page-chip";
      chip.textContent = "THIS PAGE";
      row.append(chip);
    }
    if (c.status) {
      const pill = document.createElement("span");
      pill.className = `pill ${pillClassFor(c.status)}`.trim();
      pill.textContent = c.status;
      row.append(pill);
    }
    row.addEventListener("click", () => {
      caseSelect.value = c.id;
      applyCaseChoice(c.id, true);
    });
    activeCasesList.append(row);
  }
}

// ---------------------------------------------------------------------------
// Unified search (no case selected) (the no-context empty state): one
// input querying cases AND providers in the resolved org. A case result opens
// the fill view; a provider result opens the quick cards.
// ---------------------------------------------------------------------------

function hideSearchResults(): void {
  searchResults.hidden = true;
  searchResults.replaceChildren();
}

function searchGroupHeading(text: string): HTMLElement {
  const heading = document.createElement("p");
  heading.className = "search-group";
  heading.textContent = text;
  return heading;
}

function searchEmptyLine(text: string): HTMLElement {
  const line = document.createElement("p");
  line.className = "search-empty";
  line.textContent = text;
  return line;
}

// Select a provider found via search (may not be in the browse list's first
// page) — quick cards + active cases load exactly as a dropdown pick.
async function selectProviderInPanel(
  provider: ProviderListItem,
): Promise<void> {
  // Real provider selection always wins over a leftover sandbox — see the
  // note on clearSandboxOnRealSelection. `enterSandbox` also routes through
  // here for the sandbox provider itself; it sets `sandboxActive` back to
  // true only AFTER this call returns, so clearing unconditionally here is
  // safe and never fights that flow.
  clearSandboxOnRealSelection();
  const generation = bumpGeneration();
  if (!providers.some((p) => p.id === provider.id)) providers.push(provider);
  await sendToBackground({
    type: "SET_SELECTED_PROVIDER",
    providerId: provider.id,
  });
  if (!isCurrent(generation)) return;
  setSelectedProviderId(provider.id);
  renderProviderCard(providers.find((p) => p.id === provider.id) ?? null);
  await loadProviderSelection(provider.id, generation);
}

// Select a case from anywhere (search result, NBA handback, handoff apply) —
// persists the selection worker-side first, then reuses the normal provider
// load path, whose restore logic lands on exactly this case. recordEntry
// mirrors applyCaseChoice: true for user choices, false when applying a
// handoff (its record already exists and must not be overwritten).
async function selectCaseInPanel(
  providerId: string,
  caseId: string,
  recordEntry: boolean,
  // Optional facilityId from the caller, recorded BEFORE facilities
  // load so the picker opens already resolved — "zero dropdowns". Ignored when
  // the provider isn't actually assigned to it (loadFacilities validates the
  // stored pick against the real set). Also set from case-search rows that
  // carry facilityId so search → case defaults to the case's practice site.
  preferredFacilityId?: string | null,
  // Optional state from the caller (a case-search row
  // or NBA item carries `state`) — threaded straight into the FIRST
  // GET_PROVIDER_FACILITIES read so STATE LICENSE resolves without a second
  // round trip. A handoff carries no state (not part of that locked payload),
  // so this stays undefined there — the case-context read that follows fills
  // it in via refreshFacilityCards once it lands.
  preferredState?: string | null,
): Promise<void> {
  // Real case selection always wins over a leftover sandbox — see the note
  // on clearSandboxOnRealSelection.
  clearSandboxOnRealSelection();
  const generation = bumpGeneration();
  preferCaseFacility = true;
  await sendToBackground({ type: "SET_SELECTED_PROVIDER", providerId });
  await sendToBackground({ type: "SET_SELECTED_CASE", providerId, caseId });
  if (recordEntry) {
    await sendToBackground({
      type: "ENTER_ACTIVE_CASE",
      caseId,
      providerId,
      orgId: activeOrgId,
    });
  }
  if (preferredFacilityId) {
    await sendToBackground({
      type: "SET_SELECTED_FACILITY",
      providerId,
      facilityId: preferredFacilityId,
    });
  }
  if (!isCurrent(generation)) return;
  resetTouchForm();
  if (!providers.some((p) => p.id === providerId)) {
    const response = await sendToBackground({ type: "LIST_PROVIDERS" });
    if (!isCurrent(generation)) return;
    if (response.ok) providers = browseableProviders(response.data);
  }
  setSelectedProviderId(providerId);
  renderProviderCard(providers.find((p) => p.id === providerId) ?? null);
  await loadProviderSelection(providerId, generation, {
    facilityId: preferredFacilityId,
    ...(preferredState ? { state: preferredState } : {}),
  });
  if (recordEntry && isCurrent(generation)) await refreshActiveCase(false);
}

interface HandoffSelectionEvidence {
  status: "loaded";
  generation: number;
  providers: HandoffRead<readonly string[]>;
  cases: HandoffRead<readonly string[]>;
  context: HandoffRead<HandoffContextFacts>;
  facilities: HandoffRead<readonly string[]>;
  contextData: CaseContext | null;
  selectedProviderId: string | null;
  selectedCaseId: string | null;
  selectedFacilityId: string | null;
}

type HandoffSelectionLoad = HandoffSelectionEvidence | { status: "stale" };

/** Load a received handoff without persisting any provider/case/facility pick.
 * The caller applies the pure authenticated gate first, then commits the three
 * selection keys. This prevents a failed or stale handoff from replacing an
 * unrelated valid remembered selection. */
async function loadHandoffSelection(
  record: ActiveCaseRecord,
): Promise<HandoffSelectionLoad> {
  clearSandboxOnRealSelection();
  const generation = bumpGeneration();
  preferCaseFacility = record.facilityId == null;

  let providerRead: HandoffRead<readonly string[]>;
  const providerResponse = await sendToBackground({ type: "LIST_PROVIDERS" });
  if (!isCurrent(generation)) return { status: "stale" };
  if (!providerResponse.ok) {
    providerRead = { status: "error", message: providerResponse.error };
  } else {
    providers = browseableProviders(providerResponse.data);
    providerRead = {
      status: "ok",
      data: providers.map((provider) => provider.id),
    };
  }

  if (
    providerRead.status !== "ok" ||
    !providerRead.data.includes(record.providerId)
  ) {
    const blocked: HandoffRead<readonly string[]> = {
      status: "error",
      message: "Provider unavailable",
    };
    return {
      status: "loaded",
      generation,
      providers: providerRead,
      cases: blocked,
      context: { status: "error", message: "Provider unavailable" },
      facilities: blocked,
      contextData: null,
      selectedProviderId: selectedProviderId(),
      selectedCaseId: selectedCaseId(),
      selectedFacilityId: selectedFacilityId(),
    };
  }

  setSelectedProviderId(record.providerId);
  renderProviderCard(
    providers.find((provider) => provider.id === record.providerId) ?? null,
  );
  const [caseRead, facilityRead, contextResponse] = await Promise.all([
    loadCases(record.providerId, generation, {
      preferredCaseId: record.caseId,
      deferContext: true,
      deferReport: true,
    }),
    loadFacilities(record.providerId, generation, {
      caseId: record.caseId,
      facilityId: record.facilityId,
      strictFacility: record.facilityId != null,
      deferSelectionWrites: true,
    }),
    sendToBackground({ type: "GET_CASE_CONTEXT", caseId: record.caseId }),
  ]);
  if (!isCurrent(generation)) return { status: "stale" };

  let contextData: CaseContext | null = null;
  let contextRead: HandoffRead<HandoffContextFacts>;
  if (!contextResponse.ok) {
    contextRead = {
      status: "error",
      message: contextResponse.error,
      ...(contextResponse.code === 404 ? { code: "not-found" as const } : {}),
    };
  } else {
    contextData = contextResponse.data;
    contextRead = {
      status: "ok",
      data: {
        providerId: contextData.provider?.id ?? null,
        selectedFacilityId: contextData.selectedFacility?.id ?? null,
        ...(contextData.facilities != null
          ? { facilityIds: contextData.facilities.map((facility) => facility.id) }
          : {}),
      },
    };
  }

  return {
    status: "loaded",
    generation,
    providers: providerRead,
    cases: caseRead,
    context: contextRead,
    facilities: facilityRead,
    contextData,
    selectedProviderId: selectedProviderId(),
    selectedCaseId: selectedCaseId(),
    selectedFacilityId: selectedFacilityId(),
  };
}

/**
 * Open Work cases mode before loading a search selection so the destination
 * is on screen during the async load. setPanelMode between two org-scoped
 * modes reloads nothing and does not bump generation.
 */
async function openInCaseWork(selection: Promise<void>): Promise<void> {
  await setPanelMode("case");
  await selection;
}

function renderSearchResults(data: SearchResults): void {
  searchResults.replaceChildren();
  searchResults.hidden = false;

  searchResults.append(searchGroupHeading("Cases"));
  if (data.casesError != null) {
    searchResults.append(
      searchEmptyLine(`Case search unavailable: ${data.casesError}`),
    );
  } else if (data.cases.length === 0) {
    searchResults.append(searchEmptyLine("No matching cases."));
  } else {
    for (const row of data.cases) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-row";
      const title = document.createElement("span");
      title.className = "search-row-title";
      title.textContent = [
        row.caseNumber != null ? `C-${row.caseNumber}` : null,
        row.providerName || "Unknown provider",
        `${row.payerName ?? "Unknown payer"} · ${row.state}`,
      ]
        .filter(Boolean)
        .join(" · ");
      button.append(title);
      const meta = document.createElement("span");
      meta.className = "search-row-meta";
      meta.textContent = [row.status, row.payerReferenceId]
        .filter(Boolean)
        .join(" · ");
      if (meta.textContent) button.append(meta);
      button.addEventListener("click", () => {
        hideSearchResults();
        searchInput.value = "";
        void openInCaseWork(
          selectCaseInPanel(
            row.providerId,
            row.id,
            true,
            row.facilityId ?? null,
            row.state,
          ),
        );
      });
      searchResults.append(button);
    }
  }

  searchResults.append(searchGroupHeading("Providers"));
  if (data.providersError != null) {
    searchResults.append(
      searchEmptyLine(`Provider search unavailable: ${data.providersError}`),
    );
  } else if (data.providers.length === 0) {
    searchResults.append(searchEmptyLine("No matching providers."));
  } else {
    for (const p of data.providers) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-row";
      const title = document.createElement("span");
      title.className = "search-row-title";
      title.textContent = `${p.lastName}, ${p.firstName}`;
      button.append(title);
      // The GROUP is what tells two same-named providers apart, so it leads
      // the meta line; the NPI follows as the exact identifier. A panel that
      // sends no groups yields "" and the row reads as it always did.
      const groups = providerGroupsLabel(p);
      if (groups) {
        const groupMeta = document.createElement("span");
        groupMeta.className = "search-row-meta search-row-group";
        groupMeta.textContent = groups;
        groupMeta.title = groups;
        button.append(groupMeta);
      }
      if (p.npi) {
        const meta = document.createElement("span");
        meta.className = "search-row-meta mono";
        meta.textContent = p.npi;
        button.append(meta);
      }
      button.addEventListener("click", () => {
        hideSearchResults();
        searchInput.value = "";
        void openInCaseWork(selectProviderInPanel(p));
      });
      searchResults.append(button);
    }
  }
}

async function runSearch(query: string): Promise<void> {
  const seq = ++searchSeq;
  const generation = loadGeneration;
  const response = await sendToBackground({ type: "SEARCH", query });
  // Discard stale results: a newer query, or an org/provider switch.
  if (seq !== searchSeq || !isCurrent(generation)) return;
  if (!response.ok) {
    searchResults.replaceChildren(searchEmptyLine(response.error));
    searchResults.hidden = false;
    return;
  }
  renderSearchResults(withGroupMatches(response.data, query));
}

/**
 * Merge roster providers the server search missed (group-name matches).
 *
 * `/api/providers?search=` matches name / NPI / email — not group names.
 * We also filter the loaded roster and merge anything the server missed.
 * Server rows keep their order; this only adds reach.
 *
 * Skipped when the provider half errored — a local subset would hide the failure.
 */
function withGroupMatches(data: SearchResults, query: string): SearchResults {
  if (data.providersError != null) return data;
  const seen = new Set(data.providers.map((p) => p.id));
  const extra = providers.filter(
    (p) => !seen.has(p.id) && providerMatchesQuery(p, query),
  );
  if (extra.length === 0) return data;
  return { ...data, providers: [...data.providers, ...extra] };
}

searchInput.addEventListener("input", () => {
  const query = searchInput.value.trim();
  if (searchTimer != null) window.clearTimeout(searchTimer);
  if (query.length < 2) {
    hideSearchResults();
    return;
  }
  searchTimer = window.setTimeout(() => void runSearch(query), 250);
});

// Handoff receipt: read active-case state from the worker, validate org membership,
// apply the case, and show explicit degraded states (expired, wrong org, signed out).

// A one-shot notice that outlives the record it describes (e.g. after a
// non-member context is discarded, the record is gone but the user must see
// why).
let handoffNotice: string | null = null;
// D6: the launch the panel last showed live (see carriedLaunchId), and the
// one-time neutral notice naming the launch that replaced it.
let shownLaunchId: string | null = null;
let launchSwapNotice: { launchReceiptId: string; text: string } | null = null;

function handoffKey(record: ActiveCaseRecord): string {
  return activeCaseReceiptKey(record);
}

function bannerButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link banner-action";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderHandoffBanner(): void {
  handoffBanner.replaceChildren();
  handoffBanner.hidden = true;
  handoffBanner.classList.remove("banner-warn");
  orgSwitch.replaceChildren();
  orgSwitch.hidden = true;

  if (handoffNotice != null) {
    // Before an org resolves #case-work is hidden, so a launch notice (A7)
    // shows above the org picker instead, like the A6 prompt.
    const box = orgReady ? handoffBanner : orgSwitch;
    box.hidden = false;
    box.classList.add("banner-warn");
    const text = document.createElement("span");
    text.textContent = handoffNotice;
    box.append(
      text,
      bannerButton("Dismiss", () => {
        handoffNotice = null;
        renderHandoffBanner();
      }),
    );
    return;
  }

  // D6: another launch replaced the one on screen. Neutral, shown once, and
  // only while the launch it names is still the live one.
  if (launchSwapNotice != null && activeWorkState.status === "active" &&
      activeWorkState.record.tuple.launchReceiptId === launchSwapNotice.launchReceiptId) {
    handoffBanner.hidden = false;
    const text = document.createElement("span");
    text.textContent = launchSwapNotice.text;
    handoffBanner.append(
      text,
      bannerButton("Dismiss", () => {
        launchSwapNotice = null;
        renderHandoffBanner();
      }),
    );
    return;
  }

  // A timed-out link is explained on the task card (D4). The live link's
  // technical line (owner, form key, mapping) is in admin Details now.
  if (activeWorkState.status === "expired" || activeWorkState.status === "active") return;
  if (activeWorkState.status === "blocked") {
    // D5: say why the link ended. The payer is named only when the selected
    // case is the one whose link ended.
    const ended = activeWorkState;
    const caseId = selectedCaseId();
    const payer = caseId != null && (ended.ownerId == null || ended.ownerId === caseId) ? payerLabel() : null;
    const endedCaseId = workEndedCaseId(ended);
    handoffBanner.hidden = false;
    handoffBanner.classList.add("banner-warn");
    const text = document.createElement("span");
    text.textContent = workEndedLine(ended.reason, payer);
    handoffBanner.append(text);
    if (endedCaseId != null) {
      handoffBanner.append(externalLink("Back to case ↗", caseUrl(endedCaseId), "link banner-action"));
    }
    return;
  }

  const record = activeCase;
  if (record == null) return;

  if (activeCaseStatus === "expired") {
    handoffBanner.hidden = false;
    handoffBanner.classList.add("banner-warn");
    const text = document.createElement("span");
    text.textContent =
      "This case's context expired (tab closed or 60 minutes idle). Re-launch it from Minted Panel, or pick the case again below.";
    handoffBanner.append(
      text,
      bannerButton("Dismiss", () => {
        void (async () => {
          await sendToBackground(
            record.source === "handoff"
              ? {
                  type: "CLEAR_ACTIVE_CASE_IF_CURRENT",
                  receiptKey: handoffKey(record),
                }
              : { type: "CLEAR_ACTIVE_CASE" },
          );
          await refreshActiveCase();
        })();
      }),
    );
    return;
  }

  if (record.source !== "handoff") return;

  // A handoff for an org the panel isn't operating as, but the account IS a
  // member of: prompt the org switch (explicit, never silent).
  if (record.orgId != null && orgs.length > 0) {
    const membership = orgs.find((o) => o.orgId === record.orgId) ?? null;
    const resolvedOrg =
      orgs.length === 1 ? (orgs[0]?.orgId ?? null) : activeOrgId;
    if (membership != null && resolvedOrg !== record.orgId) {
      // A6: above the org picker, so it shows before an org resolves.
      orgSwitch.hidden = panelMode !== "case";
      const text = document.createElement("span");
      text.textContent = `This case is in ${orgLabel(membership)}.`;
      orgSwitch.append(
        text,
        bannerButton(`Switch to ${orgLabel(membership)}`, () => {
          void switchOrgForHandoff(record);
        }),
      );
      return;
    }
  }

  // An applied handoff shows as "Opened from Minted Panel · Back to case"
  // on the task card.
}

// The org-switch path for a cross-org handoff. SET_ACTIVE_ORG clears prior
// org selections while preserving this exact pending handoff record.
async function switchOrgForHandoff(record: ActiveCaseRecord): Promise<void> {
  const target = record.orgId;
  if (target == null) return;
  const generation = bumpGeneration();
  const response = await sendToBackground({
    type: "SET_ACTIVE_ORG_FOR_HANDOFF",
    orgId: target,
    receiptKey: handoffKey(record),
  });
  if (!isCurrent(generation)) return;
  if (!response.ok) {
    handoffNotice = response.error;
    renderHandoffBanner();
    return;
  }
  if (!response.data) {
    await refreshActiveCase();
    return;
  }
  activeOrgId = target;
  renderOrgContext();
  orgSelect.value = target;
  invalidateFillSelection();
  hideSearchResults();
  orgReady = true;
  renderModeSurfaces();
  renderIdentityGuard();
  // The receipt-bound org switch preserves this matching handoff record. Re-read
  // it, then run the same authenticated application gate as a same-org launch.
  await refreshActiveCase();
  void loadPortalRegistry(loadGeneration);
}

// Apply handoff: validate org first — a
// mismatched context is discarded or prompts a switch, never rendered), then
// the selection lands via the normal case path. Applied once per launch;
// a SECOND launch (new createdAt) applies again — last launch wins.
async function maybeApplyHandoff(record: ActiveCaseRecord): Promise<void> {
  const key = handoffKey(record);
  if (currentHandoffSelectionIsApplied(record)) return;
  if (applyingHandoffKey === key) return;
  if (rejectedHandoffKey === key) return;
  if (orgs.length === 0) return; // orgs not loaded yet — the next refresh applies

  const resolvedOrg =
    orgs.length === 1 ? (orgs[0]?.orgId ?? null) : activeOrgId;
  const orgDecision = evaluateHandoffOrg(
    record,
    orgs.map((org) => org.orgId),
    resolvedOrg,
  );
  if (orgDecision.status === "rejected") {
    // Not this account's org: discard, say so explicitly. Receipt was real;
    // authenticated application was refused.
    const cleared = await sendToBackground({
      type: "CLEAR_ACTIVE_CASE_IF_CURRENT",
      receiptKey: key,
    });
    if (!cleared.ok) {
      handoffNotice = cleared.error;
      renderHandoffBanner();
      updateFillReady();
      return;
    }
    if (!cleared.data) {
      await refreshActiveCase();
      return;
    }
    activeCase = null;
    activeCaseStatus = "none";
    rejectedHandoffKey = key;
    handoffNotice =
      "This case is in an organization your account isn't part of. Sign in with the right account, or search.";
    renderHandoffBanner();
    updateFillReady();
    return;
  }
  if (orgDecision.status === "needs-org-switch") {
    // Member, but the panel is operating as a different org (or none yet):
    // the banner prompts the explicit switch. Nothing is applied.
    renderHandoffBanner();
    updateFillReady();
    return;
  }

  applyingHandoffKey = key;
  rejectedHandoffKey = null;
  handoffNotice = null;
  updateFillReady();
  const selection = await loadHandoffSelection(record);
  if (selection.status === "stale" || applyingHandoffKey !== key) {
    if (applyingHandoffKey === key) applyingHandoffKey = null;
    updateFillReady();
    return;
  }

  const currentResponse = await sendToBackground({ type: "GET_ACTIVE_CASE" });
  if (!isCurrent(selection.generation) || applyingHandoffKey !== key) {
    if (applyingHandoffKey === key) applyingHandoffKey = null;
    updateFillReady();
    return;
  }
  const currentReceipt =
    currentResponse.ok && currentResponse.data.status === "active"
      ? currentResponse.data.record
      : null;
  let decision = evaluateHandoffApplication({
    receipt: record,
    currentReceipt,
    memberOrgIds: orgs.map((org) => org.orgId),
    resolvedOrgId: resolvedOrg,
    providers: selection.providers,
    cases: selection.cases,
    context: selection.context,
    facilities: selection.facilities,
    selectedProviderId: selection.selectedProviderId,
    selectedCaseId: selection.selectedCaseId,
    selectedFacilityId: selection.selectedFacilityId,
  });
  if (decision.status === "rejected") {
    applyingHandoffKey = null;
    if (isTerminalHandoffRejection(decision.reason)) {
      rejectedHandoffKey = key;
    }
    handoffNotice = decision.message;
    renderHandoffBanner();
    updateFillReady();
    return;
  }

  // Render only verified case context. For an explicit facility, retain the
  // exact selected secondary (if any); case selectedFacility is the primary
  // compatibility field and must not silently replace it.
  if (selection.contextData != null) {
    caseContextCaseId = record.caseId;
    if (record.facilityId != null) preferCaseFacility = false;
    renderCaseContext(selection.contextData, true);
  }

  const committedSelection: AppliedHandoffSelection = {
    receiptKey: key,
    providerId: record.providerId,
    caseId: record.caseId,
    facilityId: selectedFacilityId(),
  };
  const selectionCommit = await sendToBackground({
    type: "COMMIT_HANDOFF_SELECTION",
    ...committedSelection,
  });
  if (!isCurrent(selection.generation) || applyingHandoffKey !== key) {
    if (applyingHandoffKey === key) applyingHandoffKey = null;
    updateFillReady();
    return;
  }
  if (!selectionCommit.ok) {
    applyingHandoffKey = null;
    handoffNotice = selectionCommit.error;
    renderHandoffBanner();
    updateFillReady();
    return;
  }
  if (!selectionCommit.data) {
    applyingHandoffKey = null;
    await refreshActiveCase();
    return;
  }

  // Re-read after persistence: logout/org/account change or a newer handoff
  // during the loaders/writes cannot be revived by this completion.
  const finalResponse = await sendToBackground({ type: "GET_ACTIVE_CASE" });
  if (!isCurrent(selection.generation) || applyingHandoffKey !== key) {
    if (applyingHandoffKey === key) applyingHandoffKey = null;
    updateFillReady();
    return;
  }
  const finalReceipt =
    finalResponse.ok && finalResponse.data.status === "active"
      ? finalResponse.data.record
      : null;
  decision = evaluateHandoffApplication({
    receipt: record,
    currentReceipt: finalReceipt,
    memberOrgIds: orgs.map((org) => org.orgId),
    resolvedOrgId: resolvedOrg,
    providers: selection.providers,
    cases: selection.cases,
    context: selection.context,
    facilities: selection.facilities,
    selectedProviderId: selectedProviderId(),
    selectedCaseId: selectedCaseId(),
    selectedFacilityId: selectedFacilityId(),
  });
  if (decision.status === "rejected") {
    applyingHandoffKey = null;
    if (isTerminalHandoffRejection(decision.reason)) {
      rejectedHandoffKey = key;
    }
    handoffNotice = decision.message;
    renderHandoffBanner();
    updateFillReady();
    return;
  }

  activeCase = finalReceipt;
  activeCaseStatus = "active";
  appliedHandoffSelection = committedSelection;
  applyingHandoffKey = null;
  rejectedHandoffKey = null;
  handoffNotice = null;
  const facilityId = selectedFacilityId();
  if (facilityId) await refreshFacilityCards(record.providerId, facilityId, selection.generation);
  if (!isCurrent(selection.generation)) return;
  await restoreFillReport(record.providerId, record.caseId, selection.generation);
  renderHandoffBanner();
  updateFillReady();
}

// Re-read the worker's active-case state. Runs when the panel opens, when the
// worker broadcasts a change, on a slow poll (expiry has a clock), and after
// in-panel entries. applyHandoff=false skips the apply pass (used right after
// the panel itself created the record).
async function refreshActiveCase(applyHandoff = true): Promise<void> {
  const response = await sendToBackground({ type: "GET_ACTIVE_CASE" });
  if (!response.ok) return;
  const state = response.data;
  activeCase = state.status === "none" ? null : state.record;
  activeCaseStatus = state.status;
  renderHandoffBanner();
  if (state.status === "expired") {
    // Never keep filling from expired context: close the gate by clearing the
    // selection of the expired case (the report restores on re-selection).
    if (selectedCaseId() === state.record.caseId) {
      caseSelect.value = "";
      applyCaseChoice(null, false);
    } else {
      updateFillReady();
    }
    return;
  }
  updateFillReady();
  if (
    applyHandoff &&
    state.status === "active" &&
    state.record.source === "handoff"
  ) {
    await maybeApplyHandoff(state.record);
  }
}

// D6 names for a launch, from what the panel has loaded for its ids. Null
// parts make launchSwapLine fall back to "the new case".
function launchSwapNames(record: ActiveWorkRecord): { provider: string | null; payer: string | null; state: string | null } {
  const tuple = record.tuple;
  const caseId = tuple.ownerKind === "case" ? tuple.ownerId : null;
  const context = caseId != null && caseContextCaseId === caseId ? caseContextData : null;
  const caseItem = caseId == null ? undefined : cases.find((c) => c.id === caseId);
  const listed = providers.find((p) => p.id === tuple.providerId);
  return {
    provider: context?.provider?.id === tuple.providerId
      ? context.provider.name
      : listed != null ? `${listed.firstName} ${listed.lastName}` : null,
    payer: context?.payer?.name ?? caseItem?.payerName ?? null,
    state: context?.state ?? caseItem?.state ?? null,
  };
}

async function refreshActiveWork(reloadSelections = true): Promise<void> {
  const previousIdentity = activeWorkStateIdentity(activeWorkState);
  const modeResponse = await sendToBackground({ type: "GET_PANEL_MODE" });
  if (modeResponse.ok && modeResponse.data !== panelMode) {
    panelMode = modeResponse.data;
    applyPanelMode();
  }
  const response = await sendToBackground({ type: "GET_ACTIVE_WORK" });
  if (!response.ok) return;
  // Read the prior launch and assign in one turn, so overlapping refreshes
  // (push and poll) see a replacement once.
  const previousLaunchId = activeWorkState.status === "active"
    ? activeWorkState.record.tuple.launchReceiptId
    : shownLaunchId;
  activeWorkState = response.data;
  shownLaunchId = carriedLaunchId(previousLaunchId, activeWorkState);
  const replacement = isLaunchReplacement(previousLaunchId, activeWorkState) &&
    activeWorkState.status === "active"
    ? activeWorkState.record
    : null;
  if (launchSwapNotice != null && launchSwapNotice.launchReceiptId !== shownLaunchId) launchSwapNotice = null;
  const changed = activeWorkStateIdentity(activeWorkState) !== previousIdentity;
  if (changed && activeWorkState.status !== "none" && reloadSelections &&
      !views.main.hidden && panelMode !== "train") {
    await whileWorkOpens(async () => {
      await loadOrgs(bumpGeneration());
      await refreshActiveCase();
    });
  }
  // Named after the reload so the new case's names are usually known. Set
  // only if that launch is still the live one.
  if (replacement != null && activeWorkState.status === "active" &&
      activeWorkState.record.tuple.launchReceiptId === replacement.tuple.launchReceiptId) {
    launchSwapNotice = {
      launchReceiptId: replacement.tuple.launchReceiptId,
      text: launchSwapLine(launchSwapNames(replacement)),
    };
  }
  await detectPortal();
  renderHandoffBanner();
  updateFillReady();
}

// The worker's push channel: a handoff arrived / the bound tab closed / a
// second launch replaced the context while the panel is open.
chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message?.type === "ACTIVE_CASE_UPDATED") void refreshActiveCase();
  if (message?.type === "ACTIVE_WORK_UPDATED") void refreshActiveWork();
});

// Slow poll: expiry is a clock, and no event fires when 60 idle minutes pass.
window.setInterval(() => {
  if (!views.main.hidden) {
    void refreshActiveCase();
    void refreshActiveWork();
  }
}, 30_000);

// ---------------------------------------------------------------------------
// Structured touch form and next-best-action after logging + the next-best-
// action read that follows a successful log.
// ---------------------------------------------------------------------------

function populateTouchSelects(): void {
  touchType.replaceChildren();
  const placeholder = new Option("Select type…", "", true, true);
  placeholder.disabled = true;
  touchType.add(placeholder);
  for (const t of STRUCTURED_TOUCH_TYPES)
    touchType.add(new Option(t.label, t.value));
  touchOutcome.replaceChildren();
  touchOutcome.add(new Option("None", "", true, true));
  for (const d of TOUCH_DISPOSITIONS)
    touchOutcome.add(new Option(d.label, d.value));
}
populateTouchSelects();

// Reset the form for a FRESH draft (case switch or a successful log). Never
// called on a failed save — the entered values and the draft's idempotency id
// Preserved across retries so context is not lost.
function resetTouchForm(): void {
  touchType.selectedIndex = 0;
  touchNote.value = "";
  touchOutcome.selectedIndex = 0;
  touchFollowup.value = "";
  touchRecipientName.value = "";
  touchRecipientContact.value = "";
  touchTracking.value = "";
  touchDraftId = null;
  setError(touchError, null);
  touchSaveBtn.disabled = false;
  touchSaveBtn.textContent = "Log it";
  touchStatus.hidden = true;
}

function readTouchDraft(): StructuredTouchDraft {
  return {
    touchType: touchType.value,
    note: touchNote.value,
    outcome: touchOutcome.value,
    recipientName: touchRecipientName.value,
    recipientContact: touchRecipientContact.value,
    followUpDate: touchFollowup.value,
    trackingId: touchTracking.value,
  };
}

touchSaveBtn.addEventListener("click", () => {
  const caseId = selectedCaseId();
  if (caseId == null) return;
  const draft = readTouchDraft();
  const validation = validateStructuredTouch(draft);
  if (!validation.ok) {
    setError(touchError, validation.message);
    return;
  }
  // One idempotency id per draft, REUSED on retries: a network failure
  // retried can never double-log (the server replays the stored touch).
  if (touchDraftId == null) touchDraftId = crypto.randomUUID();
  const idempotencyId = touchDraftId;
  const generation = loadGeneration;
  void (async () => {
    setError(touchError, null);
    touchSaveBtn.disabled = true;
    touchSaveBtn.textContent = "Logging…";
    const response = await sendToBackground({
      type: "LOG_STRUCTURED_TOUCH",
      caseId,
      idempotencyId,
      draft,
    });
    if (!isCurrent(generation)) return;
    if (!response.ok) {
      // Failed write: values stay in the form; the same id is reused, so
      // Try again can never double-log (F3).
      touchSaveBtn.disabled = false;
      touchSaveBtn.textContent = "Try again";
      const transient = response.code == null || response.code >= 500;
      fillNotice(touchError, "danger", [
        transient ? "Not saved yet. Your entries are kept. Try again." : `Not saved. ${response.error}`,
      ], [supportButton(response.code ?? "offline")]);
      touchError.className = "error";
      return;
    }
    resetTouchForm();
    touchStatus.hidden = false;
    touchStatus.textContent = "Saved to the case.";
    // The case's last touch changed.
    caseContextCaseId = null;
    void refreshCaseContext();
  })();
});

// After any successful log, fetch the next-best-action queue top and render
// one item — or an honest "queue clear" with handback and webapp deep link.
async function refreshNextBestAction(loggedCaseId: string): Promise<void> {
  const generation = loadGeneration;
  nbaSection.hidden = false;
  nbaSection.replaceChildren(searchEmptyLine("Finding what's next…"));
  const response = await sendToBackground({ type: "GET_NEXT_BEST_ACTION" });
  if (!isCurrent(generation)) return;
  if (!response.ok) {
    // Honest degrade (e.g. a server that predates the endpoint): the loop
    // continues in the webapp.
    nbaSection.hidden = true;
    nbaSection.replaceChildren();
    return;
  }
  renderNba(response.data, loggedCaseId);
}

function nbaLink(label: string, href: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.className = "link nba-link";
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = label;
  return link;
}

// Case pickup queue when nothing is selected. Order and reasons come from the server.

// How many queue rows to render before the "and N more" line. Server-bounded
// too (?limit=), this is the display cap.
const QUEUE_PAGE_SIZE = 8;

function queueRow(item: NextBestActionItem): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "case-row queue-row";

  const main = document.createElement("span");
  main.className = "queue-row-main";
  const title = document.createElement("span");
  title.className = "case-row-title";
  title.textContent = `${item.providerName} · ${item.payerName} · ${item.state}`;
  main.append(title);
  const reason = document.createElement("span");
  reason.className = "queue-row-reason";
  // The server's reason line, rendered verbatim.
  reason.textContent = item.reason || item.action;
  main.append(reason);
  row.append(main);

  if (item.deadline != null) {
    const due = document.createElement("span");
    due.className = item.deadline.overdue ? "pill pill-red" : "pill";
    due.textContent = `${item.deadline.overdue ? "Overdue" : "Due"} ${fmtContextDate(item.deadline.date)}`;
    row.append(due);
  }

  row.addEventListener("click", () => {
    queueSection.hidden = true;
    // Queue row carries state; facility resolves from context — no facilityId on
    // this row (NBA doesn't carry one), so the location still resolves via
    // the case-context refresh once it lands.
    void selectCaseInPanel(item.providerId, item.caseId, true, undefined, item.state);
  });
  return row;
}

function renderQueue(items: NextBestActionItem[]): void {
  queueSection.replaceChildren();
  const heading = document.createElement("p");
  heading.className = "section-title";
  heading.textContent = "Pick up where you left off";
  queueSection.append(heading);

  if (items.length === 0) {
    const clear = document.createElement("p");
    clear.className = "nba-clear";
    clear.textContent = "Nothing needs you right now.";
    queueSection.append(clear);
    return;
  }
  for (const item of items.slice(0, QUEUE_PAGE_SIZE))
    queueSection.append(queueRow(item));
  if (items.length > QUEUE_PAGE_SIZE) {
    const more = document.createElement("p");
    more.className = "queue-more";
    more.textContent = `and ${items.length - QUEUE_PAGE_SIZE} more in Minted Panel`;
    queueSection.append(more);
  }
}

// Load the queue for the no-context empty state. Loading / empty / failed are
// all explicit (doc 04 §4.4); a failure never blanks the panel — search and
// the manual picker stay available beneath it.
async function loadQueue(generation: number): Promise<void> {
  if (!orgResolved()) {
    queueSection.hidden = true;
    return;
  }
  queueSection.hidden = false;
  queueSection.replaceChildren(searchEmptyLine("Loading your list…"));
  const response = await sendToBackground({ type: "GET_NEXT_BEST_ACTION" });
  if (!isCurrent(generation)) return;
  if (!response.ok) {
    queueSection.replaceChildren(
      searchEmptyLine("Can't load your list right now. Use Search."),
    );
    return;
  }
  // Older API may return only `item`; degrade to that single entry
  // rather than showing an empty queue.
  const items =
    response.data.items ?? (response.data.item ? [response.data.item] : []);
  renderQueue(items);
}

// "Up next" under a logged submission (E5, E12): one item, or a plain
// "nothing else needs you".
function renderNba(result: NextBestActionResult, loggedCaseId: string): void {
  nbaSection.replaceChildren();
  nbaSection.hidden = false;
  const heading = document.createElement("p");
  heading.className = "lbl";
  heading.textContent = "Up next";
  nbaSection.append(heading);

  const item = result.item;
  if (item == null || item.caseId === loggedCaseId) {
    const done = document.createElement("p");
    done.className = "nba-clear";
    done.textContent = "Nothing else needs you right now.";
    nbaSection.append(done);
    return;
  }

  const card = document.createElement("div");
  card.className = "nba-card";
  const title = document.createElement("p");
  title.className = "nba-title";
  title.textContent = `${item.providerName} · ${item.payerName} · ${item.state}`;
  card.append(title);
  const action = document.createElement("p");
  action.className = "nba-action";
  action.textContent = item.reason || item.action;
  card.append(action);
  if (item.deadline != null) {
    const deadline = document.createElement("p");
    deadline.className = item.deadline.overdue
      ? "nba-deadline overdue"
      : "nba-deadline";
    deadline.textContent = `${item.deadline.overdue ? "Overdue" : "Due"} ${fmtContextDate(item.deadline.date)}`;
    card.append(deadline);
  }
  const actions = document.createElement("div");
  actions.className = "nba-actions";
  const work = document.createElement("button");
  work.type = "button";
  work.className = "secondary nba-work";
  work.textContent = "Open case";
  work.addEventListener("click", () => {
    nbaSection.hidden = true;
    // State rides along from the queue row; facility resolves from context.
    void selectCaseInPanel(item.providerId, item.caseId, true, undefined, item.state);
  });
  actions.append(work, nbaLink("Open in Minted Panel ↗", `${API_BASE_URL}${item.deepLink}`));
  card.append(actions);
  nbaSection.append(card);
}

// CAQH: push attestation from panel data. Exception-strip pull UI is not shipped yet.

// Whether the tab in hand is a CAQH portal. Registry-driven like every other
// Uses portal registry, not a hardcoded host.
function isCaqhPortal(): boolean {
  return portal != null && /caqh/i.test(`${portal.key} ${portal.label}`);
}

let caqhOffer: ReturnType<typeof buildCaqhPushOffer> | null = null;

function renderCaqh(): void {
  const cards = currentCards;
  caqhSection.hidden = !isCaqhPortal() || cards == null;
  if (caqhSection.hidden || cards == null) return;

  // The offer counts fields we actually hold — see buildCaqhPushOffer.
  const tokens = [...cards.type1Fields, ...cards.type2Fields]
    .filter((f) => f.value != null)
    .map((f) => ({ token: f.key, value: f.value }));
  // The date comes from the roster row (see attestedOnFor) — never a module
  // variable, which is what made this read "Never attested" for everyone.
  caqhOffer = buildCaqhPushOffer(
    tokens,
    attestedOnFor(selectedProviderId(), providers),
    localToday(),
  );
  // B15: one line with the date. The relative age would only repeat it.
  caqhHeadline.textContent = caqhOffer.headline;
  caqhAttested.textContent = "";
  caqhAttested.hidden = true;
  // Recently attested profiles use de-emphasized styling rather than nags.
  caqhSection.classList.toggle("de-emphasized", caqhOffer.deEmphasize);
}

caqhAttest.addEventListener("click", () => {
  const providerId = selectedProviderId();
  const offer = caqhOffer;
  if (!providerId || offer == null) return;
  const generation = loadGeneration;
  caqhAttest.disabled = true;
  caqhAttest.textContent = "Recording…";
  caqhStatus.hidden = true;
  void (async () => {
    const response = await sendToBackground({
      type: "RECORD_CAQH_ATTESTATION",
      providerId,
      verifiedFields: offer.fieldKeys,
    });
    caqhAttest.disabled = false;
    caqhAttest.textContent = "Record attestation";
    if (!isCurrent(generation)) return;
    if (!response.ok) {
      // Said on the card, beside the button that failed.
      caqhStatus.hidden = false;
      caqhStatus.textContent = attestationFailureText(response);
      return;
    }
    // Write the server-authoritative date back onto the roster row, which is
    // what renderCaqh reads. Keeping it here rather than in a side variable is
    // why a provider switch cannot show another provider's attestation.
    const row = providers.find((p) => p.id === providerId);
    if (row) row.caqhLastAttestedDate = response.data.caqhLastAttestedDate;
    caqhStatus.hidden = false;
    caqhStatus.textContent = `Attestation recorded. ${response.data.verifiedFields} ${
      response.data.verifiedFields === 1 ? "field" : "fields"
    } stamped as verified.`;
    renderCaqh();
  })();
});

// ---------------------------------------------------------------------------
// Capture UI: "we recognise N of M" with per-row evidence, gaps that are
// actionable but never blocking, and a send that works even when we
// recognised nothing (a form we understand none of is the one worth
// capturing). Approving stays in the webapp: this only proposes.
// ---------------------------------------------------------------------------

let captureSession: CaptureSession | null = null;
/** Set when the last capture added a page to an existing session — drives the
 * Page count suffix for capture summary. */
let captureAddedPage = false;
// Which capture row's inline editor is open (one at a time
// — two open editors on one list is a way to save the wrong row), the last
// re-test answer, and whether a pick is waiting on the page.
let editingSelector: string | null = null;
let selectorTestResult: SelectorTestResult | null = null;
// Unsaved inline-editor values (panel state, not DOM). Panel state, not DOM
// state: renderCapture() rebuilds the editor for reasons the trainer did not
// ask for (a selector test, a tab switch, a pick), and anything left in the
// inputs would go with it.
let rowDraft: CaptureRowDraft | null = null;
let pickInFlight = false;
// Rows selected for batch delete, keyed by selector. Kept OUTSIDE the
// DOM so a re-render (after an edit, a pick, a re-test) never silently drops a
// selection the trainer made.
const batchSelection = new Set<string>();

function trainTargetIdentityFor(portal: Pick<MatchedPortal, "key" | "mappingGeneration"> | null): string | null {
  return portal == null ? null : `${portal.key}\u0000${portal.mappingGeneration}`;
}

function clearTrainTargetLocalState(): void {
  captureSession = null;
  captureAddedPage = false;
  batchSelection.clear();
  editingSelector = null;
  selectorTestResult = null;
  rowDraft = null;
  pickInFlight = false;
  trainFormMaps = [];
  lastMockDryRunTarget = null;
  portal = null;
  portalTabId = null;
  trainUrlCandidates = [];
  mockDryRunStatus.hidden = true;
  clearMockDryRunDetail();
  captureRestored.hidden = true;
  captureStart.disabled = false;
  captureNextPage.disabled = false;
  captureStart.textContent = "Capture this form";
  captureSend.disabled = false;
  captureSend.textContent = "Send for approval";
  trainRecognition.textContent = "Looking up the selected form…";
  trainHint.textContent = "";
  renderTrainDryRun();
  renderCapture();
}

const STALE_TRAIN_GENERATION_MESSAGE =
  "This form configuration's mapping generation changed. Refresh Train forms, select its current generation, and recapture before continuing.";

function discardStaleTrainCaptureFromResponse(response: { ok: boolean; code?: number; error?: string }): boolean {
  if (response.ok || response.code !== 409 || response.error !== STALE_TRAIN_GENERATION_MESSAGE) return false;
  clearTrainTargetLocalState();
  void loadSharedRegistry();
  return true;
}

/**
 * Pin the worker to one exact configuration. Requests are queued so a fast
 * A→B→A picker sequence cannot leave an older SET_TRAIN_TARGET as the worker's
 * final selection. A key OR generation change clears the local proof/capture.
 */
async function syncTrainTarget(
  target: Pick<MatchedPortal, "key" | "mappingGeneration"> | null,
): Promise<number | null> {
  const identity = trainTargetIdentityFor(target);
  if (desiredTrainTargetIdentity === identity && trainTargetRevision != null) {
    return trainTargetRevision;
  }
  if (desiredTrainTargetIdentity !== identity || trainTargetRevision == null) {
    if (trainTargetIdentity !== identity) clearTrainTargetLocalState();
    trainTargetIdentity = identity;
    trainTargetRevision = null;
    desiredTrainTargetIdentity = identity;
  }

  const work = trainTargetSyncTail.then(async () => {
    if (desiredTrainTargetIdentity !== identity) return null;
    const response = await sendToBackground({
      type: "SET_TRAIN_TARGET",
      portalKey: target?.key ?? null,
      mappingGeneration: target?.mappingGeneration ?? null,
    });
    if (desiredTrainTargetIdentity !== identity) return null;
    if (!response.ok) {
      trainTargetRevision = null;
      setError(mainError, response.error);
      return null;
    }
    trainTargetIdentity = identity;
    trainTargetRevision = response.data.revision;
    return trainTargetRevision;
  });
  trainTargetSyncTail = work.then(() => undefined, () => undefined);
  return work;
}

interface TrainTargetRequestContext {
  portalKey: string;
  mappingGeneration: number;
  targetRevision: number;
}

function selectedTrainTargetRequest(): TrainTargetRequestContext | null {
  if (
    panelMode !== "train" || trainTargetRevision == null ||
    trainTargetIdentity == null || trainTargetIdentity !== desiredTrainTargetIdentity
  ) return null;
  const separator = trainTargetIdentity.lastIndexOf("\u0000");
  if (separator <= 0) return null;
  const portalKey = trainTargetIdentity.slice(0, separator);
  const mappingGeneration = Number(trainTargetIdentity.slice(separator + 1));
  if (!Number.isSafeInteger(mappingGeneration) || mappingGeneration <= 0) return null;
  return {
    portalKey,
    mappingGeneration,
    targetRevision: trainTargetRevision,
  };
}

function currentTrainTargetRequest(): TrainTargetRequestContext | null {
  const selected = selectedTrainTargetRequest();
  if (selected == null || portal == null) return null;
  return trainTargetIdentityFor(portal) === trainTargetIdentity ? selected : null;
}

function captureSessionMatchesTrainTarget(
  session: CaptureSession | null,
  target: TrainTargetRequestContext | null,
): session is CaptureSession {
  return target != null && captureSessionMatchesTarget(session, target);
}

function isCurrentTrainTargetRequest(target: TrainTargetRequestContext): boolean {
  return trainTargetRevision === target.targetRevision &&
    trainTargetIdentity === `${target.portalKey}\u0000${target.mappingGeneration}` &&
    desiredTrainTargetIdentity === trainTargetIdentity;
}

// Sandbox mode active (test provider, no case). Panel-only state: it is a way of
// WORKING, not a stored selection, and it must never survive into a real case
// (switching provider or case leaves it, below).
let sandboxActive = false;
// The test-mode run in flight ("fill" or "clear"), the fields the last test
// fill wrote (null when no fill result is showing), and a counter that drops
// a late answer once test mode was left or re-entered.
let sandboxBusy: "fill" | "clear" | null = null;
let sandboxFilledFields: number | null = null;
let sandboxGeneration = 0;

// CAQH exception strip UI is not shipped yet.
// findCaqhGaps + PULL_CAQH_FIELD remain for a future value-reading path.
// Capture is shape-only today; reading CAQH values would cross that boundary.

// Date-only today for the pure CAQH module (it never reads a clock itself).
function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function renderCapture(): void {
  // Capture UI is Train-forms only.
  const training = isCaptureMode(panelMode);
  const target = currentTrainTargetRequest();
  const captureMatchesTarget =
    target != null && captureSessionMatchesTrainTarget(captureSession, target);
  captureSection.hidden =
    !training || portal == null || portalTabId == null || target == null ||
    (captureSession != null && !captureMatchesTarget);
  if (captureSection.hidden) return;

  const counts = captureCounts(captureSession);
  const pageCount = usedPageNames(captureSession).length;
  // List joins scan rows against the shared library already in hand, so it
  // survives the session storage dying with the browser and can say which
  // library fields this page no longer has.
  const listRows = joinCaptureLibrary(
    captureSession?.rows ?? [],
    trainFormMaps,
  );
  let summary = captureLibrarySummary(captureLibraryCounts(listRows));
  if (captureSession == null && listRows.length > 0) {
    summary = `${summary} Not captured in this browser — re-capture to check the form against the page.`;
  }
  if (captureSession && captureAddedPage && pageCount > 0) {
    summary = `${summary} · Page ${pageCount} of ${pageCount}`;
  }
  captureSummary.textContent = summary;
  captureStart.textContent = captureSession
    ? "Re-capture"
    : "Capture this form";
  // "Capture next page" only makes sense when there is already a session to
  // add a page to.
  captureNextPage.hidden = captureSession == null;
  captureNextPage.disabled = false;
  // Adding a field by hand needs something to add it TO, and a live tab to
  // point at.
  captureAddField.hidden = captureSession == null;
  captureAddField.disabled = pickInFlight || portalTabId == null;

  captureRows.replaceChildren();
  captureActions.hidden = !canSendCapture(captureSession);
  captureSend.disabled = false;
  captureSent.hidden = counts.sent === 0;
  if (counts.sent > 0) {
    // Training writes the SHARED library, so the review happens in the web
    // app's Submit-form task editor (D18) — say where, and TAKE them there.
    // Naming a destination the trainer then has to go and find, in a different
    // product, is where this loop was ending; the registry row already carries
    // the payer id, so the link costs nothing.
    const note = document.createElement("span");
    note.textContent = `${counts.sent} sent to the shared form library. Nothing fills until they are mapped in the web app's Submit-form task editor.`;
    captureSent.replaceChildren(note);
    if (portal?.payerId) {
      captureSent.append(
        " ",
        nbaLink(
          "Map them now ↗",
          `${API_BASE_URL}/admin/payer-admin/setup/${portal.payerId}?tab=templates`,
        ),
      );
    }
  }
  renderBatchBar();
  for (const group of groupCaptureRowsByPage(listRows)) {
    if (group.page != null) {
      const heading = document.createElement("p");
      heading.className = "capture-page-heading";
      heading.textContent = group.page;
      captureRows.append(heading);
    }
    for (const item of group.rows) {
      captureRows.append(renderCaptureRow(item));
    }
  }
}

/** Group rows by pageStep in the order pages were first walked. */
function groupCaptureRowsByPage(
  rows: readonly CaptureListRow[],
): Array<{ page: string | null; rows: CaptureListRow[] }> {
  const order: Array<string | null> = [];
  const groups = new Map<string | null, CaptureListRow[]>();
  for (const row of rows) {
    const page = row.page;
    if (!groups.has(page)) {
      order.push(page);
      groups.set(page, []);
    }
    groups.get(page)!.push(row);
  }
  return order.map((page) => ({ page, rows: groups.get(page)! }));
}

function renderCaptureRow(entry: CaptureListRow): HTMLDivElement {
  const row = entry.row;
  const item = document.createElement("div");
  // A gap is a field with nothing behind it in the library — the trainer's
  // actual to-do. A drifted row is worse, and says so in its own chip.
  item.className = entry.library ? "capture-row" : "capture-row gap";

  // Batch actions edit the LOCAL capture, so a library-only row has nothing
  // to tick: deleting it here would suggest the library changed, and it does
  // not.
  if (row) {
    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.className = "capture-row-tick";
    tick.checked = batchSelection.has(row.selector);
    tick.setAttribute("aria-label", `Select ${entry.name}`);
    tick.addEventListener("change", () => {
      if (tick.checked) batchSelection.add(row.selector);
      else batchSelection.delete(row.selector);
      renderBatchBar();
    });
    item.append(tick);
  }

  const label = document.createElement("span");
  label.className = "capture-row-label";
  label.textContent = entry.name;
  // A row the portal never named needs a human name before anyone can act on
  // it later; say so rather than rendering a blank and hoping.
  if (row && !isNamedRow(row)) label.classList.add("id-empty");
  label.title = entry.selector;
  item.append(label);

  // Second column shows what the library says about the field, which is
  // the only thing here that decides whether it will fill.
  const value = document.createElement("span");
  value.className = "capture-row-token mono";
  value.textContent = entry.library
    ? entry.library.note
    : "Not in the shared library";
  item.append(value);

  if (entry.state === "drifted") {
    const chip = document.createElement("span");
    chip.className = "pill";
    chip.textContent = "Not found on this page";
    item.append(chip);
  } else if (entry.state === "library-only") {
    const chip = document.createElement("span");
    chip.className = "pill";
    chip.textContent = "In the library";
    item.append(chip);
  } else if (entry.state === "new") {
    const chip = document.createElement("span");
    chip.className = "pill";
    chip.textContent = "New in this scan";
    item.append(chip);
  }

  if (row?.origin === "user_mapped") {
    const chip = document.createElement("span");
    chip.className = "pill";
    chip.textContent = "Added by hand";
    item.append(chip);
  }

  if (row?.evidence) {
    const evidence = document.createElement("span");
    evidence.className = "capture-row-evidence";
    evidence.textContent = row.evidence;
    item.append(evidence);
  }

  if (row?.sent) {
    const chip = document.createElement("span");
    chip.className = "pill";
    chip.textContent = "Sent";
    item.append(chip);
  }

  // A LIBRARY row (drifted, or library-only before a capture) has no captured
  // row to edit — and used to have no actions at all, which made the "needs
  // updating" half of the job a dead end: the list named the problem and
  // offered nothing to do about it. Two things are honest here without
  // deciding anything the web app owns.
  if (row == null) item.append(renderLibraryRowActions(entry));

  if (row) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "link capture-row-edit";
    edit.textContent = "Edit";
    edit.setAttribute(
      "aria-expanded",
      String(editingSelector === row.selector),
    );
    edit.addEventListener("click", () => {
      editingSelector = editingSelector === row.selector ? null : row.selector;
      selectorTestResult = null;
      rowDraft = null;
      renderCapture();
    });
    item.append(edit);

    if (editingSelector === row.selector)
      item.append(renderCaptureRowEditor(row));
  }
  return item;
}

/**
 * What a trainer can do about a field the LIBRARY holds and this page did not
 * yield — the drift half of the job.
 *
 * "Check page" is first because "not found on this page" is a fact about the
 * SCAN, not about the page: a field revealed only after an earlier answer is
 * genuinely present and simply was not rendered when the scan ran, which is
 * the exact situation the picker exists for. Testing the library's own
 * selector live separates that from a selector that really has gone stale, and
 * costs one click instead of a re-capture.
 *
 * "Re-point" is the repair: click where the field moved to, and the proposal
 * carries the library's name for it. It PROPOSES at the new selector — the old
 * map stays until someone retires it in the web app, because what a re-trained
 * selector does to an approved map is the web app's decision, not this
 * panel's. The copy says so rather than implying the library was edited.
 */
function renderLibraryRowActions(entry: CaptureListRow): HTMLElement {
  const box = document.createElement("div");
  box.className = "capture-editor-actions";

  const check = document.createElement("button");
  check.type = "button";
  check.className = "link";
  check.textContent = "Check page";
  check.disabled = portalTabId == null;
  check.addEventListener(
    "click",
    () => void testCaptureSelector(entry.selector),
  );
  box.append(check);

  // Re-pointing adds a row to the capture, so it needs one to add to.
  if (captureSession != null) {
    const repoint = document.createElement("button");
    repoint.type = "button";
    repoint.className = "link";
    repoint.textContent = "Re-point";
    repoint.disabled = pickInFlight || portalTabId == null;
    repoint.addEventListener("click", () => void repointLibraryField(entry));
    box.append(repoint);
  }

  // The verdict from a live check, keyed to THIS row's selector so one row's
  // answer never appears under another.
  if (
    selectorTestResult != null &&
    selectorTestResult.selector === entry.selector
  ) {
    const { valid, matches, fillable, radioGroup } = selectorTestResult;
    const verdict = selectorVerdict(
      { valid, matches, fillable, radioGroup },
      entry.fieldType,
    );
    const line = document.createElement("p");
    line.className = verdict.ok ? "capture-editor-note" : "capture-editor-warn";
    line.textContent = verdict.ok
      ? `${verdict.text} It was not in this scan — capture this page again to pick it up.`
      : verdict.text;
    box.append(line);
  }
  return box;
}

/** The inline correction panel for one captured row: rename it, re-type it,
 * check the selector still resolves, or drop it. Everything here edits the
 * LOCAL capture session; nothing is proposed until Send for approval. */
function renderCaptureRowEditor(row: CaptureRow): HTMLElement {
  // Render from draft; inputs write back to it on every keystroke. The
  // editor is thrown away and rebuilt whenever anything
  // re-renders the list, so the inputs cannot be the source of truth.
  const draft = draftForRow(row, rowDraft);
  rowDraft = draft;

  const box = document.createElement("div");
  box.className = "capture-row-editor";

  const nameField = document.createElement("label");
  nameField.className = "capture-editor-field";
  nameField.textContent = "Field name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = draft.displayLabel;
  nameInput.placeholder = row.label || "Name this field";
  nameInput.addEventListener("input", () => {
    draft.displayLabel = nameInput.value;
  });
  nameField.append(nameInput);
  box.append(nameField);

  // The payer's own words, kept visible as the evidence behind a rename —
  // renaming must never make it look like the portal said something it didn't.
  if (row.label.trim()) {
    const captured = document.createElement("p");
    captured.className = "capture-editor-note";
    captured.textContent = `Portal calls it: ${row.label.trim()}`;
    box.append(captured);
  }

  const typeField = document.createElement("label");
  typeField.className = "capture-editor-field";
  typeField.textContent = "Control type";
  const typeSelect = document.createElement("select");
  for (const option of CAPTURE_FIELD_TYPES) {
    typeSelect.add(
      new Option(
        option.label,
        option.value,
        false,
        option.value === draft.fieldType,
      ),
    );
  }
  typeSelect.addEventListener("change", () => {
    draft.fieldType = typeSelect.value as PortalFieldType;
  });
  typeField.append(typeSelect);
  box.append(typeField);

  // Selector workshop: edit and test CSS selectors. The auto-captured selector is a starting
  // point, not a verdict: a fragile one can be replaced with anything CSS can
  // express, and tested against the live page before it is saved.
  const selectorField = document.createElement("label");
  selectorField.className = "capture-editor-field";
  selectorField.textContent = "CSS selector";
  const selectorInput = document.createElement("input");
  selectorInput.type = "text";
  selectorInput.className = "mono";
  selectorInput.value = draft.selectorText;
  selectorInput.spellcheck = false;
  selectorInput.addEventListener("input", () => {
    draft.selectorText = selectorInput.value;
  });
  selectorField.append(selectorInput);
  box.append(selectorField);

  if (row.selectorOverridden) {
    const note = document.createElement("p");
    note.className = "capture-editor-note";
    note.textContent =
      "Selector written by hand — a re-capture will not overwrite it.";
    box.append(note);
  }

  // The verdict answers the TYPED selector, so it is keyed to the draft —
  // keyed to the stored one it could only ever appear for a selector the
  // trainer had not edited, which is the case the workshop does not exist for.
  // The words come from the shared `selectorVerdict`, which reads the match
  // SHAPE: a bare count called a wrapper healthy, a radio group ambiguous and
  // a typo a missing field, all three wrongly.
  const report = draftTestReport(draft, selectorTestResult);
  if (report != null) {
    const verdict = selectorVerdict(report, draft.fieldType);
    const result = document.createElement("p");
    result.className = verdict.ok
      ? "capture-editor-note"
      : "capture-editor-warn";
    result.textContent = verdict.text;
    box.append(result);
  }

  const actions = document.createElement("div");
  actions.className = "capture-editor-actions";

  const save = document.createElement("button");
  save.type = "button";
  save.className = "secondary";
  save.textContent = "Save";
  // `draftEdit` sends only what actually changed: EDIT_CAPTURE_ROW reads a
  // present fieldType/newSelector as a human override, which must not be set
  // by merely opening the editor and saving a rename.
  save.addEventListener(
    "click",
    () => void editCaptureRow(row, draftEdit(row, draft)),
  );
  actions.append(save);

  const test = document.createElement("button");
  test.type = "button";
  test.className = "link";
  test.textContent = "Test selector";
  // Tests what is TYPED, not what is saved — the point is to try a candidate
  // before committing to it. The matches flash green on the page.
  test.addEventListener(
    "click",
    () => void testCaptureSelector(draft.selectorText.trim()),
  );
  actions.append(test);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link";
  remove.textContent = row.sent ? "Remove from list" : "Remove";
  remove.addEventListener("click", () => void removeCaptureRow(row));
  actions.append(remove);

  box.append(actions);

  if (row.sent) {
    const note = document.createElement("p");
    note.className = "capture-editor-note";
    // Be honest about reach: the panel's propose call already happened.
    note.textContent =
      "Already sent — removing it here drops it from this list, not from the shared library.";
    box.append(note);
  }
  return box;
}

/** Batch action bar appears on the first tick and states exactly what a
 * bulk action would hit, because "Delete selected" is irreversible. */
function renderBatchBar(): void {
  // A selection can outlive the rows it named (a re-capture, a single delete),
  // so prune to what is actually on screen before counting.
  const live = new Set((captureSession?.rows ?? []).map((r) => r.selector));
  for (const selector of [...batchSelection]) {
    if (!live.has(selector)) batchSelection.delete(selector);
  }
  const count = batchSelection.size;
  captureBatch.hidden = count === 0;
  captureBatchCount.textContent = `${count} ${count === 1 ? "field" : "fields"} selected`;
}

async function deleteSelectedCaptureRows(): Promise<void> {
  const target = currentTrainTargetRequest();
  if (!target) return;
  const selectors = [...batchSelection];
  if (selectors.length === 0) return;
  const plural = selectors.length === 1 ? "field" : "fields";
  // Say the same thing the single-row editor says: this list is the local
  // capture, and a row already proposed stays in the shared library either
  // way. "Delete 12 fields" with no qualifier reads like a library purge.
  const sent = (captureSession?.rows ?? []).filter(
    (r) => r.sent && batchSelection.has(r.selector),
  ).length;
  const sentNote =
    sent > 0
      ? ` ${sent} of them ${sent === 1 ? "was" : "were"} already sent — removing them here drops them from this list, not from the shared library.`
      : "";
  if (
    !window.confirm(
      `Delete ${selectors.length} ${plural} from this capture?${sentNote}`,
    )
  ) {
    return;
  }
  // ONE write: deleting row by row would leave the list and the stored session
  // disagreeing if the worker failed halfway.
  const response = await sendToBackground({
    type: "REMOVE_CAPTURE_ROWS",
    selectors,
    ...target,
  });
  if (!isCurrentTrainTargetRequest(target)) return;
  if (!response.ok) {
    setPickStatus(response.error, true);
    return;
  }
  if (!captureSessionMatchesTrainTarget(response.data, target)) return;
  captureSession = response.data;
  batchSelection.clear();
  editingSelector = null;
  selectorTestResult = null;
  rowDraft = null;
  setPickStatus(`Deleted ${selectors.length} ${plural}.`);
  renderCapture();
}

async function editCaptureRow(
  row: CaptureRow,
  patch: {
    displayLabel?: string | null;
    fieldType?: PortalFieldType;
    newSelector?: string;
  },
): Promise<void> {
  const target = currentTrainTargetRequest();
  if (!target) return;
  const response = await sendToBackground({
    type: "EDIT_CAPTURE_ROW",
    selector: row.selector,
    ...patch,
    ...target,
  });
  if (!isCurrentTrainTargetRequest(target)) return;
  if (!response.ok) {
    setPickStatus(response.error, true);
    return;
  }
  if (!captureSessionMatchesTrainTarget(response.data, target)) return;
  captureSession = response.data;
  editingSelector = null;
  selectorTestResult = null;
  rowDraft = null;
  setPickStatus(null);
  renderCapture();
}

async function removeCaptureRow(row: CaptureRow): Promise<void> {
  const target = currentTrainTargetRequest();
  if (!target) return;
  const response = await sendToBackground({
    type: "REMOVE_CAPTURE_ROW",
    selector: row.selector,
    ...target,
  });
  if (!isCurrentTrainTargetRequest(target)) return;
  if (!response.ok) {
    setPickStatus(response.error, true);
    return;
  }
  if (!captureSessionMatchesTrainTarget(response.data, target)) return;
  captureSession = response.data;
  editingSelector = null;
  selectorTestResult = null;
  rowDraft = null;
  renderCapture();
}

async function testCaptureSelector(selector: string): Promise<void> {
  const target = currentTrainTargetRequest();
  if (!target) return;
  if (portalTabId == null) {
    setPickStatus("Open the portal tab to test this field.", true);
    return;
  }
  if (selector === "") {
    setPickStatus("Type a selector to test.", true);
    return;
  }
  const response = await sendToBackground({
    type: "TEST_CAPTURE_SELECTOR",
    tabId: portalTabId,
    selector,
    ...target,
    // Flash the matches on the page: a count alone cannot tell the trainer
    // they matched the WRONG control, which is the failure that matters.
    highlight: true,
  });
  if (!isCurrentTrainTargetRequest(target)) return;
  if (!response.ok) {
    discardStaleTrainCaptureFromResponse(response);
    setPickStatus(response.error, true);
    return;
  }
  selectorTestResult = response.data;
  setPickStatus(null);
  renderCapture();
}

function setPickStatus(message: string | null, isError = false): void {
  capturePickStatus.hidden = message == null;
  capturePickStatus.textContent = message ?? "";
  capturePickStatus.classList.toggle("capture-editor-warn", isError);
}

/** F1 — "+ Add field": hand the page a crosshair and wait for the trainer to
 * click the control the scan missed. The panel stays responsive throughout;
 * the pick resolves when they click or press Escape. */
async function addFieldByPicking(): Promise<void> {
  const target = currentTrainTargetRequest();
  if (portalTabId == null || captureSession == null || !target) return;
  const tabId = portalTabId;
  pickInFlight = true;
  captureAddField.disabled = true;
  setPickStatus("Click the field on the portal page · Esc to cancel");
  const response = await sendToBackground({
    type: "PICK_CAPTURE_FIELD",
    tabId,
    pageStep: currentCapturePage(),
    ...target,
  });
  if (!isCurrentTrainTargetRequest(target)) return;
  pickInFlight = false;
  captureAddField.disabled = false;
  if (!response.ok) {
    discardStaleTrainCaptureFromResponse(response);
    setPickStatus(response.error, true);
    return;
  }
  if (!captureSessionMatchesTrainTarget(response.data, target)) return;
  const before = captureSession?.rows.length ?? 0;
  captureSession = response.data;
  const added = captureSession.rows.length - before;
  // Cancelling returns the session untouched — say nothing rather than
  // claiming a field was added.
  setPickStatus(
    added > 0 ? "Field added. Name it under Edit if the portal didn't." : null,
  );
  renderCapture();
}

/**
 * Re-point a drifted library field: the trainer clicks where it moved to, and
 * the resulting proposal carries the LIBRARY's name for it rather than
 * whatever the portal calls the new control — so a reviewer in the web app can
 * see it is the same field, not a stranger.
 *
 * It PROPOSES; it does not retire the old map. That decision belongs to the
 * web app (the extension has no approval write at all), so the status line
 * says what actually happened instead of implying the library was repaired.
 */
async function repointLibraryField(entry: CaptureListRow): Promise<void> {
  const target = currentTrainTargetRequest();
  if (portalTabId == null || captureSession == null || !target) return;
  const tabId = portalTabId;
  pickInFlight = true;
  renderCapture();
  setPickStatus(`Click "${entry.name}" where it is now · Esc to cancel`);
  const response = await sendToBackground({
    type: "PICK_CAPTURE_FIELD",
    tabId,
    pageStep: currentCapturePage(),
    displayLabel: entry.name,
    ...target,
  });
  if (!isCurrentTrainTargetRequest(target)) return;
  pickInFlight = false;
  if (!response.ok) {
    discardStaleTrainCaptureFromResponse(response);
    setPickStatus(response.error, true);
    renderCapture();
    return;
  }
  if (!captureSessionMatchesTrainTarget(response.data, target)) return;
  const before = captureSession?.rows.length ?? 0;
  captureSession = response.data;
  const added = captureSession.rows.length - before;
  setPickStatus(
    added > 0
      ? `"${entry.name}" re-pointed. Send the capture to propose it — the old one stays in the library until it is retired in the web app.`
      : null,
  );
  renderCapture();
}

/** The page a hand-added field belongs to: the one the trainer is looking at,
 * which is the page the most recent rows were captured from. */
function currentCapturePage(): string | null {
  const rows = captureSession?.rows ?? [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const page = rows[i]?.pageStep?.trim();
    if (page) return page;
  }
  return null;
}

async function startCapture(mode: "auto" | "next-page"): Promise<void> {
  // Early presence check only — do not capture portalTabId for START_CAPTURE.
  // Re-query the active tab after awaits so a mid-click tab switch cannot pair
  // a fresh URL with a stale tab id (TRAIN-DUAL review).
  const activePortal = portal;
  const target = currentTrainTargetRequest();
  if (portalTabId == null || activePortal == null || target == null) return;
  const recognitionRevision = trainRecognitionRevision;
  const generation = loadGeneration;
  captureStart.disabled = true;
  captureNextPage.disabled = true;
  captureStart.textContent = "Reading the form…";
  const tab = await queryActiveTab();
  if (!isCurrentTrainTargetRequest(target)) return;
  const tabUrl = tab?.url ?? null;
  const registry = sharedPortalRows;
  const decision = decideCaptureStart({
    portalKey: activePortal.key,
    tabId: tab?.id ?? null,
    tabUrl,
    rows: registry,
  });
  if (!decision.ok) {
    captureStart.disabled = false;
    captureNextPage.disabled = false;
    captureStart.textContent = captureSession
      ? "Re-capture"
      : "Capture this form";
    if (panelMode === "train") {
      await refreshTrainRecognition();
    } else {
      await detectPortal();
    }
    setError(mainError, CAPTURE_TAB_MISMATCH_ERROR);
    return;
  }
  if (
    decision.portalKey !== target.portalKey ||
    decision.mappingGeneration !== target.mappingGeneration ||
    recognitionRevision !== trainRecognitionRevision
  ) {
    captureStart.disabled = false;
    captureNextPage.disabled = false;
    captureStart.textContent = captureSession ? "Re-capture" : "Capture this form";
    return;
  }
  // Always send a fresh, collision-free pageStep candidate via derivePageStep;
  // the background decides whether to reuse it via
  // identifyCapturePage after the scan. CAP-HEAD: tab.title is not a wizard
  // heading — pass null until the content script can report form headings.
  const candidate = derivePageStep({
    url: tabUrl,
    heading: null,
    sequence: nextPageSequence(captureSession),
    used: usedPageNames(captureSession),
  });
  const pagesBefore = usedPageNames(captureSession).length;
  const hadSession = captureSession != null;
  const response = await sendToBackground({
    type: "START_CAPTURE",
    tabId: decision.tabId,
    portalKey: decision.portalKey,
    mappingGeneration: decision.mappingGeneration,
    targetRevision: target.targetRevision,
    pageStep: candidate,
    pageUrlTail: pageUrlTail(tabUrl),
    captureMode: mode,
  });
  if (!isCurrent(generation) || !isCurrentTrainTargetRequest(target)) return;
  captureStart.disabled = false;
  captureNextPage.disabled = false;
  if (!response.ok) {
    discardStaleTrainCaptureFromResponse(response);
    captureStart.textContent = captureSession
      ? "Re-capture"
      : "Capture this form";
    setError(mainError, response.error);
    return;
  }
  if (!captureSessionMatchesTrainTarget(response.data, target)) return;
  captureSession = response.data;
  captureAddedPage =
    hadSession && usedPageNames(captureSession).length > pagesBefore;
  captureRestored.hidden = true;
  renderCapture();
}

captureStart.addEventListener("click", () => {
  void startCapture("auto");
});

captureAddField.addEventListener("click", () => void addFieldByPicking());
captureBatchDelete.addEventListener(
  "click",
  () => void deleteSelectedCaptureRows(),
);
captureBatchClear.addEventListener("click", () => {
  batchSelection.clear();
  renderCapture();
});

captureNextPage.addEventListener("click", () => {
  void startCapture("next-page");
});

captureSend.addEventListener("click", () => {
  const target = currentTrainTargetRequest();
  if (!target) return;
  const generation = loadGeneration;
  captureSend.disabled = true;
  captureSend.textContent = "Sending…";
  void (async () => {
    const response = await sendToBackground({ type: "SEND_CAPTURE", ...target });
    if (!isCurrent(generation) || !isCurrentTrainTargetRequest(target)) return;
    captureSend.textContent = "Send for approval";
    if (!response.ok) {
      captureSend.disabled = false;
      discardStaleTrainCaptureFromResponse(response);
      setError(mainError, response.error);
      return;
    }
    if (!captureSessionMatchesTrainTarget(response.data, target)) return;
    captureSession = response.data;
    renderCapture();
  })();
});

captureClear.addEventListener("click", () => {
  const target = currentTrainTargetRequest();
  if (!target) return;
  void (async () => {
    const response = await sendToBackground({ type: "CLEAR_CAPTURE", ...target });
    if (!isCurrentTrainTargetRequest(target)) return;
    if (!response.ok) {
      setPickStatus(response.error, true);
      return;
    }
    captureSession = null;
    captureAddedPage = false;
    captureRestored.hidden = true;
    renderCapture();
  })();
});

// Restore in-flight capture session after a worker restart / panel reopen,
// and SAY what came back (labels and counts; there are no values to restore).
async function restoreCapture(): Promise<void> {
  const target = selectedTrainTargetRequest();
  if (target == null) {
    captureSession = null;
    captureRestored.hidden = true;
    renderCapture();
    return;
  }
  const response = await sendToBackground({ type: "GET_CAPTURE", ...target });
  if (!isCurrentTrainTargetRequest(target)) return;
  captureSession = response.ok ? response.data : null;
  captureAddedPage = false;
  if (captureSession) {
    captureRestored.hidden = false;
    captureRestored.textContent = restoredSummary(captureSession);
  } else {
    captureRestored.hidden = true;
  }
  renderCapture();
}

// ---------------------------------------------------------------------------
// Sandbox test profile (org-designated provider, no case).
//
// Fills a real portal from the org's DESIGNATED test provider, with no case in
// play: no touch, no status change, no case lifecycle consumed. That is what
// makes testing a 100+ field form a matter of seconds instead of manufacturing
// a case per attempt.
// ---------------------------------------------------------------------------

/** The sandbox provider for the loaded roster, or null when the org has
 * designated none. */
function sandboxProvider(): ProviderListItem | null {
  return findSandboxProvider(providers);
}

/** G1/G2: the pinned Search entry. Rendered from the roster, so an org that
 * has not designated a test provider gets the honest reason instead of a
 * button that fails when pressed. */
function renderSandboxEntry(): void {
  const provider = sandboxProvider();
  const offer = panelMode === "search" && orgReady;
  sandboxEntry.hidden = !offer || provider == null;
  sandboxUnavailable.hidden = !offer || provider != null;
  if (provider) {
    sandboxEntryHeading.textContent = sandboxEntryTitle(provider);
    sandboxEntryMeta.textContent = SANDBOX_ENTRY_META;
  } else {
    sandboxUnavailable.textContent = SANDBOX_UNAVAILABLE_NOTE;
  }
}

/** G3/G4: the in-case-work test-mode chrome. Clear form lives here and ONLY
 * here: it resets every input on the page, which on a live case would wipe a
 * coordinator's real typing. */
function renderSandboxBar(): void {
  const showing = sandboxActive && panelMode === "case";
  sandboxBar.hidden = !showing;
  // The sandbox has no case, so the whole case block goes with it — one
  // container, the same rule renderModeSurfaces uses, for the same reason:
  // reaching into the cards inside would clobber state they own. Portal
  // recognition deliberately sits OUTSIDE it and stays visible.
  caseFill.hidden = showing;
  if (!showing) return;
  const provider = providers.find((p) => p.id === selectedProviderId()) ?? null;
  const state = sandboxFillState(provider);
  sandboxBarNote.textContent = provider
    ? `Filling as ${sandboxProfileName(provider)}${state ? ` (${state})` : ""}.`
    : "The test profile is no longer on this organization's provider list.";
  // G4: once a test fill wrote fields, Clear form is the next step, so it
  // takes the primary spot (CSS orders the primary button first).
  const clearNext = sandboxFilledFields != null && sandboxFilledFields > 0;
  sandboxFillBtn.className = clearNext ? "secondary" : "primary";
  sandboxClearBtn.className = clearNext ? "primary" : "secondary";
  sandboxFillBtn.classList.toggle("filling", sandboxBusy === "fill");
  sandboxFillBtn.textContent = sandboxBusy === "fill"
    ? "Filling…"
    : clearNext ? "Run test fill again" : "Run test fill";
  sandboxClearBtn.textContent = sandboxBusy === "clear" ? "Clearing…" : "Clear form";
  // Whether a form is open is checked at the click, not here: this bar is not
  // re-rendered on every page change, so a disabled state would go stale.
  sandboxFillBtn.disabled = provider == null || sandboxBusy != null;
  sandboxClearBtn.disabled = provider == null || sandboxBusy != null;
}

/** Replace what the test-mode result area says. An empty list hides it. */
function setSandboxResult(parts: readonly HTMLElement[]): void {
  sandboxResult.replaceChildren(...parts);
  sandboxResult.hidden = parts.length === 0;
}

/** A standalone notice box in the 0.1.8 result look. */
function sandboxNotice(
  tone: NoticeTone,
  lines: readonly NoticeLine[],
  extra: readonly HTMLElement[] = [],
): HTMLElement {
  const box = document.createElement("div");
  fillNotice(box, tone, lines, extra);
  return box;
}

/** A test-mode error: the error text and Copy support code, never a bare
 * string. */
function showSandboxError(text: string, code: string | number | null): void {
  setSandboxResult([sandboxNotice("danger", [text], [supportButton(code, null, "danger")])]);
}

/** Forget any result and drop any answer still on its way. */
function resetSandboxResult(): void {
  sandboxGeneration += 1;
  sandboxBusy = null;
  sandboxFilledFields = null;
  setSandboxResult([]);
}

/** G4: the same result look as a real fill (C3), inside the test-mode bar. */
function renderSandboxFillResult(summary: SandboxFillSummary): void {
  const view = sandboxFillView(summary);
  sandboxFilledFields = view.filled;
  const parts: HTMLElement[] = [
    sandboxNotice(
      view.tone,
      [{ text: view.lines[0], strong: true }, view.lines[1]],
      view.tone === "danger"
        ? [supportButton("test-nothing-filled", summary.fillSessionId, "danger")]
        : [],
    ),
  ];
  if (view.skipLines.length > 0) parts.push(sandboxNotice("neutral", view.skipLines));
  // A failed machine log is reported, never swallowed, but it does not make
  // the fill a failure, because the fill happened.
  if (view.recordLine != null) {
    const line = document.createElement("p");
    line.className = "status-line";
    const text = document.createElement("span");
    text.textContent = view.recordLine;
    line.append(text, supportButton("test-record", summary.fillSessionId));
    parts.push(line);
  }
  setSandboxResult(parts);
}

/**
 * Clear the sandbox because a REAL provider or case was just selected.
 *
 * Previously the Exit button was the ONLY thing that cleared `sandboxActive`,
 * so picking a real case while the sandbox was up left the sandbox bar
 * showing (hiding the real Fill button) and let "Sandbox fill" run against
 * whatever real, non-designated provider had since loaded — a fill with no
 * case attribution and no `is_test_provider` check of its own. Called from
 * every funnel a real selection goes through (`applyCaseChoice`,
 * `selectCaseInPanel`, `selectProviderInPanel`); a no-op when the sandbox
 * isn't active, so it's safe to call unconditionally from all three.
 */
function clearSandboxOnRealSelection(): void {
  if (!sandboxActive) return;
  sandboxActive = false;
  resetSandboxResult();
  renderSandboxBar();
}

/** Enter the sandbox: select the designated provider and land in Work cases.
 * Deliberately reuses the normal provider-selection path, so quick cards,
 * facilities and the portal gate all behave exactly as they do for a real
 * provider — the ONLY difference is that no case is required.
 *
 * `sandboxActive` is set only AFTER the provider selection resolves:
 * `selectProviderInPanel` unconditionally clears a stale sandbox on every
 * real selection (above), and this IS that selection, so flipping the flag
 * first would have it immediately clobbered back to false. */
async function enterSandbox(): Promise<void> {
  const provider = sandboxProvider();
  if (provider == null) return;
  resetSandboxResult();
  hideSearchResults();
  searchInput.value = "";
  await openInCaseWork(selectProviderInPanel(provider));
  sandboxActive = true;
  renderSandboxBar();
  updateFillReady();
}

function leaveSandbox(): void {
  clearSandboxOnRealSelection();
  updateFillReady();
}

async function runSandboxFill(): Promise<void> {
  if (sandboxBusy != null) return;
  const providerId = selectedProviderId();
  if (providerId == null) return;
  const activePortal = portal;
  const tabId = portalTabId;
  if (activePortal == null || tabId == null) {
    sandboxFilledFields = null;
    setSandboxResult([sandboxNotice("warn", [SANDBOX_NO_FORM_NOTE])]);
    renderSandboxBar();
    return;
  }
  const provider = providers.find((p) => p.id === providerId) ?? null;
  const generation = sandboxGeneration;
  sandboxBusy = "fill";
  sandboxFilledFields = null;
  setSandboxResult([]);
  renderSandboxBar();
  let response: Awaited<ReturnType<typeof sendToBackground<"SANDBOX_FILL">>>;
  try {
    response = await sendToBackground({
      type: "SANDBOX_FILL",
      tabId,
      providerId,
      portalKey: activePortal.key,
      state: sandboxFillState(provider),
      facilityId: selectedFacilityId(),
    });
  } catch {
    response = { ok: false, error: "Minted couldn't run the test fill. Reload the page, then try again." };
  }
  // Test mode was left (or re-entered) while this ran: the answer is stale.
  if (generation !== sandboxGeneration) return;
  sandboxBusy = null;
  if (response.ok) {
    renderSandboxFillResult(response.data);
  } else {
    showSandboxError(response.error, response.code ?? "test-fill");
  }
  renderSandboxBar();
}

async function clearPortalFormFromPanel(): Promise<void> {
  if (sandboxBusy != null) return;
  const providerId = selectedProviderId();
  if (providerId == null) return;
  const tabId = portalTabId;
  if (tabId == null) {
    sandboxFilledFields = null;
    setSandboxResult([sandboxNotice("warn", [SANDBOX_NO_FORM_NOTE])]);
    renderSandboxBar();
    return;
  }
  const generation = sandboxGeneration;
  sandboxBusy = "clear";
  renderSandboxBar();
  let response: Awaited<ReturnType<typeof sendToBackground<"CLEAR_PORTAL_FORM">>>;
  try {
    response = await sendToBackground({
      type: "CLEAR_PORTAL_FORM",
      tabId,
      providerId,
    });
  } catch {
    response = { ok: false, error: "Minted couldn't clear the form. Reload the page, then try again." };
  }
  if (generation !== sandboxGeneration) return;
  sandboxBusy = null;
  if (response.ok) {
    // G5: what the clear actually changed. The fill result is no longer true.
    const view = sandboxClearView(response.data.cleared);
    sandboxFilledFields = null;
    setSandboxResult([sandboxNotice(view.tone, [view.text])]);
  } else {
    // The fill result stays true, so Clear form keeps the primary spot.
    showSandboxError(response.error, response.code ?? "test-clear");
  }
  renderSandboxBar();
}

sandboxEntry.addEventListener("click", () => void enterSandbox());
sandboxExitBtn.addEventListener("click", () => leaveSandbox());
sandboxFillBtn.addEventListener("click", () => void runSandboxFill());
sandboxClearBtn.addEventListener(
  "click",
  () => void clearPortalFormFromPanel(),
);

// Mode chooser + Train-forms surfaces (Search / Work cases / Train forms).

/** Toggle the four top-level mode containers. Child cards manage their own visibility. */
function renderModeSurfaces(): void {
  const training = panelMode === "train";
  const searching = panelMode === "search";

  modeSearchBtn.setAttribute("aria-pressed", String(searching));
  modeCaseBtn.setAttribute("aria-pressed", String(panelMode === "case"));
  modeTrainBtn.setAttribute("aria-pressed", String(training));
  // Train forms is admin-only; a non-admin never sees the button at all.
  // Before memberships land the answer is unknown, so leave it alone.
  if (membershipsLoaded) modeTrainBtn.hidden = !canTrainForms(orgs);

  trainSection.hidden = !training;
  // The org picker belongs to both org-scoped jobs and to neither of
  // training's concerns.
  orgField.hidden = training;
  renderLaunchChrome();
  searchSection.hidden = !(searching && orgReady);
  caseWork.hidden = training || searching || !orgReady;
  // The A6 org prompt belongs to Work cases only; re-rendered with the banner.
  renderHandoffBanner();

  if (training) hideSearchResults();
  renderSelectedProvider();
  renderSandboxEntry();
  renderSandboxBar();
  renderCapture();
  void refreshPortalAccessPrompt();
}

/** Re-render after a mode change — kept as a named function for the call
 * sites that mean "the job changed, re-render". */
function applyPanelMode(): void {
  renderModeSurfaces();
}

/** Memberships for the admin gate ALONE — training itself is org-free, so
 * this deliberately does not touch the org picker, providers or portals. */
async function refreshTrainEligibility(): Promise<void> {
  const response = await sendToBackground({ type: "LIST_MY_ORGS" });
  if (!response.ok) return; // unknown stays unknown; the button keeps its state
  orgs = response.data;
  membershipsLoaded = true;
  await enforceModePermission();
  renderModeSurfaces();
}

/** Move a user off a job they may no longer do, worker-side too so the next
 * panel open agrees. A no-op for everyone who is allowed to be where they are. */
async function enforceModePermission(): Promise<void> {
  const allowed = fallbackModeFor(panelMode, orgs);
  if (allowed === panelMode) return;
  panelMode = allowed;
  await sendToBackground({ type: "SET_PANEL_MODE", mode: allowed });
  renderModeSurfaces();
}

async function setPanelMode(mode: PanelMode): Promise<void> {
  if (panelMode === mode) return;
  const previous = panelMode;
  panelMode = mode;
  await sendToBackground({ type: "SET_PANEL_MODE", mode });
  renderModeSurfaces();
  if (mode === "train") {
    await loadSharedRegistry();
    return;
  }
  // Search and Work cases are BOTH org-scoped and share every loaded cache,
  // so switching between them is pure presentation — no reload, no generation
  // bump (which would discard an in-flight pick made from a search result).
  // Only coming back from training has to re-enter the org-scoped load path.
  if (previous === "train") {
    void loadOrgs(bumpGeneration()).then(() => refreshActiveCase());
    void detectPortal();
  }
}

modeSearchBtn.addEventListener("click", () => void setPanelMode("search"));
modeCaseBtn.addEventListener("click", () => void setPanelMode("case"));
modeTrainBtn.addEventListener("click", () => void setPanelMode("train"));

/** The trained-form library: every payer's shared portals, plus what the open
 * page is recognized as. */
async function loadSharedRegistry(): Promise<void> {
  if (panelMode !== "train") return;
  const registryRevision = ++trainRegistryRevision;
  trainRecognitionRevision += 1;
  portal = null;
  portalTabId = null;
  trainFormMaps = [];
  trainUrlCandidates = [];
  renderTrainDryRun();
  renderCapture();
  trainRecognition.textContent = "Looking up this form…";
  const [response, targetResponse] = await Promise.all([
    sendToBackground({ type: "LIST_SHARED_PORTALS" }),
    sendToBackground({ type: "GET_TRAIN_TARGET" }),
  ]);
  if (registryRevision !== trainRegistryRevision || panelMode !== "train") return;
  if (!response.ok) {
    sharedPortalRows = [];
    trainPayer.value = "";
    trainPortal.value = "";
    await syncTrainTarget(null);
    trainRecognition.textContent = response.error;
    trainHint.textContent = "Choose the form again after the shared registry is available.";
    renderTrainPayers();
    renderTrainPortals();
    renderTrainDryRun();
    renderCapture();
    return;
  }
  // Coerce to [] — null data crashes `for…of` during render and blanks the panel.
  sharedPortalRows = Array.isArray(response.data) ? response.data : [];
  renderTrainPayers();

  const savedTarget = targetResponse.ok ? targetResponse.data : null;
  const savedRow = savedTarget?.portalKey == null
    ? null
    : sharedPortalRows.find((row) => row.portalKey === savedTarget.portalKey) ?? null;
  const savedPortal = savedRow ? toMatchedPortal(savedRow) : null;
  if (
    savedTarget && savedRow && savedPortal &&
    savedPortal.mappingGeneration === savedTarget.mappingGeneration
  ) {
    trainTargetIdentity = trainTargetIdentityFor(savedPortal);
    desiredTrainTargetIdentity = trainTargetIdentity;
    trainTargetRevision = savedTarget.revision;
    trainPayer.value = (savedRow.payerName ?? "").trim();
    trainPortal.value = savedRow.portalKey;
  } else if (savedTarget && savedTarget.portalKey == null) {
    trainTargetIdentity = null;
    desiredTrainTargetIdentity = null;
    trainTargetRevision = savedTarget.revision;
    trainPortal.value = "";
  } else {
    // The API's current generation no longer agrees with the worker's saved
    // target. Explicitly clear the stale target before recognition resumes.
    trainTargetIdentity = savedTarget?.portalKey == null
      ? null
      : `${savedTarget.portalKey}\u0000${savedTarget.mappingGeneration}`;
    desiredTrainTargetIdentity = trainTargetIdentity;
    trainTargetRevision = savedTarget?.revision ?? null;
    trainPortal.value = "";
    await syncTrainTarget(null);
  }
  if (registryRevision !== trainRegistryRevision || panelMode !== "train") return;
  renderTrainPortals();
  await refreshTrainRecognition();
}

function trainPayerNames(): string[] {
  const names = new Set<string>();
  for (const row of sharedPortalRows) {
    const name = (row.payerName ?? "").trim();
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function renderTrainPayers(): void {
  const names = trainPayerNames();
  const previous = trainPayer.value;
  trainPayer.replaceChildren();
  const placeholder = new Option("Select a payer…", "", true, previous === "");
  trainPayer.add(placeholder);
  for (const name of names) {
    trainPayer.add(new Option(name, name, false, name === previous));
  }
  trainPayer.disabled = names.length === 0;
}

/** Portals for the selected payer — manual pick when the open tab is not the form. */
function renderTrainPortals(): void {
  const payerName = trainPayer.value;
  const previous = trainPortal.value;
  const ambiguousChoices = previous === "" ? trainUrlCandidates : [];
  const rows = ambiguousChoices.length > 1
    ? ambiguousChoices.flatMap((candidate) => {
      const row = sharedPortalRows.find((item) => item.portalKey === candidate.key);
      return row ? [row] : [];
    })
    : sharedPortalRows.filter((row) => (row.payerName ?? "") === payerName);
  trainPortalField.hidden = rows.length === 0;
  trainPortal.replaceChildren();
  trainPortal.add(new Option(
    ambiguousChoices.length > 1
      ? "Choose the exact matching form…"
      : "Select a form configuration…",
    "",
    true,
    previous === "",
  ));
  for (const row of rows) {
    trainPortal.add(
      new Option(
        portalTargetLabel(toMatchedPortal(row)),
        row.portalKey,
        false,
        row.portalKey === previous,
      ),
    );
  }
}

function renderTrainDryRun(): void {
  const recognized =
    currentTrainTargetRequest() != null && portal != null && portalTabId != null;
  trainDryRunSection.hidden = !recognized;
  runMockDryRunBtn.disabled = !recognized;
  markPortalProvenBtn.disabled = !recognized;
  trainProvenChip.hidden = !recognized || portal?.proven !== true;
  if (!recognized) {
    mockDryRunStatus.hidden = true;
    clearMockDryRunDetail();
  }
}

/** Mock dry-run results, bucketed the same way the
 * fill report uses. The engine already returns each failure with its reason;
 * rendering only the counts made the trainer re-derive them on the page. */
function renderMockDryRunDetail(summary: MockDryRunSummary): void {
  const notFilled = [
    ...(summary.skipped ?? []),
    ...(summary.notChecked ?? []),
  ].map((field) => {
    let reason = field.reason;
    if (field.kind === "page_unknown" && !reason.includes("page_unknown")) {
      reason = `${reason} (page_unknown)`;
    } else if (
      (field.kind === "unverified" && /form changed|context/i.test(reason)) ||
      summary.fieldOutcomes?.some((o) => o.mapId === field.mapId && o.reasonCode === "context_changed")
    ) {
      if (!reason.includes("context_changed")) {
        reason = `${reason} (context_changed)`;
      }
    }
    return { ...field, reason };
  });
  fieldList(mockDryRunSkipped, "Not filled on the page:", notFilled);
  fieldList(mockDryRunGaps, "Mapping gaps:", summary.gaps);
}

function clearMockDryRunDetail(): void {
  mockDryRunSkipped.hidden = true;
  mockDryRunSkipped.replaceChildren();
  mockDryRunGaps.hidden = true;
  mockDryRunGaps.replaceChildren();
}

/** What the open page and the exact Train/Test target are. */
async function refreshTrainRecognition(): Promise<void> {
  if (panelMode !== "train") return;
  const recognitionRevision = ++trainRecognitionRevision;
  const selectedAtStart = sharedPortalRows.find(
    (row) => row.portalKey === trainPortal.value,
  ) ?? null;
  const targetAtStart = selectedAtStart ? toMatchedPortal(selectedAtStart) : null;
  const targetSyncAtStart = syncTrainTarget(targetAtStart);
  const tab = await queryActiveTab();
  if (recognitionRevision !== trainRecognitionRevision || panelMode !== "train") return;
  const view = resolveTrainRecognition({
    url: tab?.url,
    rows: sharedPortalRows,
    payerName: trainPayer.value || null,
    selectedPortalKey: trainPortal.value,
  });
  trainUrlCandidates = view.status === "ambiguous" ? view.candidates : [];

  // Preserve a unique legacy match as an exact target choice. Equal matches
  // remain blank until the trainer chooses one by its full label and key.
  if (view.status === "matched" && !view.selected && trainPortal.value === "") {
    const row = sharedPortalRows.find((candidate) => candidate.portalKey === view.portal.key);
    if (row) {
      trainPayer.value = (row.payerName ?? "").trim();
      trainPortal.value = row.portalKey;
    }
  }

  const selectedRow = sharedPortalRows.find((row) => row.portalKey === trainPortal.value) ?? null;
  const target = selectedRow ? toMatchedPortal(selectedRow) : null;
  const targetRevision = trainTargetIdentityFor(target) === trainTargetIdentityFor(targetAtStart)
    ? await targetSyncAtStart
    : await syncTrainTarget(target);
  if (
    recognitionRevision !== trainRecognitionRevision ||
    trainTargetRevision !== targetRevision ||
    panelMode !== "train"
  ) return;

  if (view.status === "matched") {
    portal = view.portal;
    portalTabId = tab?.id ?? null;
    const request = currentTrainTargetRequest();
    if (request == null || request.portalKey !== view.portal.key) {
      portal = null;
      portalTabId = null;
      trainRecognition.textContent = "Select the exact form configuration before continuing.";
      trainHint.textContent = "Capture, mock testing, and proof belong to one selected configuration.";
      renderTrainPortals();
      renderTrainDryRun();
      renderCapture();
      return;
    }
    const maps = await sendToBackground({
      type: "LIST_SHARED_FIELD_MAPS",
      ...request,
    });
    if (
      recognitionRevision !== trainRecognitionRevision ||
      !isCurrentTrainTargetRequest(request)
    ) return;
    trainFormMaps = maps.ok ? maps.data : [];
    const state = formCaptureState(trainFormMaps);
    trainRecognition.textContent = `${portalTargetLabel(view.portal)} — already trained: ${captureStateSummary(state)}.`;
    trainHint.textContent =
      state.undecided > 0
        ? `${state.undecided} captured ${state.undecided === 1 ? "field is" : "fields are"} still waiting for a decision in the web app. Re-capture only if the form itself changed.`
        : "Re-capture only if the form changed — nothing here changes a mapping on its own.";
    const identity = trainTargetIdentityFor(view.portal);
    if (lastMockDryRunTarget !== identity) {
      lastMockDryRunTarget = null;
      mockDryRunStatus.hidden = true;
    }
  } else {
    portal = null;
    portalTabId = null;
    trainFormMaps = [];
    lastMockDryRunTarget = null;
    mockDryRunStatus.hidden = true;
    trainRecognition.textContent = view.recognitionText;
    trainHint.textContent = view.hintText;
  }
  renderTrainPortals();
  renderTrainDryRun();
  renderCapture();
  void refreshPortalAccessPrompt();
}

trainPayer.addEventListener("change", () => {
  // A payer change starts a new target choice. Never leave the prior payer's
  // form key selected behind the filtered options.
  trainPortal.value = "";
  renderTrainPortals();
  void refreshTrainRecognition();
});
trainPortal.addEventListener("change", () => {
  const row = sharedPortalRows.find((r) => r.portalKey === trainPortal.value);
  if (row) trainPayer.value = (row.payerName ?? "").trim();
  else lastMockDryRunTarget = null;
  // Sticky selection updates mismatch/match copy immediately; opening the
  // form is how the trainer reaches the selected configuration's URL.
  renderTrainPortals();
  void refreshTrainRecognition();
  if (!row?.formUrl) return;
  void chrome.tabs.create({ url: row.formUrl });
});

runMockDryRunBtn.addEventListener("click", () => {
  const activePortal = portal;
  const activeTabId = portalTabId;
  const target = currentTrainTargetRequest();
  if (activePortal == null || activeTabId == null || target == null) return;
  const recognitionRevision = trainRecognitionRevision;
  const generation = loadGeneration;
  runMockDryRunBtn.disabled = true;
  markPortalProvenBtn.disabled = true;
  mockDryRunStatus.hidden = false;
  mockDryRunStatus.textContent =
    "Filling the live form with synthetic Sample values…";
  void (async () => {
    const tab = await queryActiveTab();
    if (
      tab?.id == null || tab.id !== activeTabId ||
      !portalKeyEligibleForUrl(activePortal.key, tab.url, sharedPortalRows)
    ) {
      await refreshTrainRecognition();
      if (isCurrent(generation)) {
        mockDryRunStatus.hidden = false;
        mockDryRunStatus.textContent =
          "This tab no longer matches the recognized form. Open the registered form and retry.";
      }
      return;
    }
    if (
      !isCurrentTrainTargetRequest(target) ||
      recognitionRevision !== trainRecognitionRevision
    ) return;
    const response = await sendToBackground({
      type: "RUN_MOCK_DRY_RUN",
      tabId: tab.id,
      ...target,
    });
    if (
      !isCurrent(generation) ||
      !isCurrentTrainTargetRequest(target) ||
      recognitionRevision !== trainRecognitionRevision
    ) return;
    if (!response.ok) {
      discardStaleTrainCaptureFromResponse(response);
      mockDryRunStatus.textContent = response.error;
      renderTrainDryRun();
      clearMockDryRunDetail();
      mockDryRunStatus.hidden = false;
      return;
    }
    lastMockDryRunTarget = trainTargetIdentityFor(activePortal);
    const { filled, skipped, gaps, pass } = response.data;
    mockDryRunStatus.textContent = response.data.fieldsAttempted != null
      ? `Mock dry run attempted ${response.data.fieldsAttempted} setter write${response.data.fieldsAttempted === 1 ? "" : "s"}; semantic verification is not available. Review the live form before marking it proven.`
      : pass
        ? `Mock dry run passed: filled ${filled} field${filled === 1 ? "" : "s"}. Review the live form, then mark it proven manually.`
        : `Mock dry run needs attention: filled ${filled}, skipped ${skipped.length}, and ${gaps.length} mapping gap${gaps.length === 1 ? "" : "s"}.`;
    if (response.data.logError) mockDryRunStatus.textContent += ` ${response.data.logError}`;
    renderTrainDryRun();
    // A passing run has nothing in either bucket, so `fieldList` hides them
    // and the result stays the one line it was.
    renderMockDryRunDetail(response.data);
    mockDryRunStatus.hidden = false;
  })();
});

markPortalProvenBtn.addEventListener("click", () => {
  const activePortal = portal;
  const target = currentTrainTargetRequest();
  if (activePortal == null || target == null) return;
  const recognitionRevision = trainRecognitionRevision;
  const generation = loadGeneration;
  markPortalProvenBtn.disabled = true;
  mockDryRunStatus.hidden = false;
  mockDryRunStatus.textContent = "Marking the shared form proven…";
  void (async () => {
    const response = await sendToBackground({
      type: "MARK_PORTAL_PROVEN",
      ...target,
    });
    if (
      !isCurrent(generation) ||
      !isCurrentTrainTargetRequest(target) ||
      recognitionRevision !== trainRecognitionRevision
    ) return;
    if (!response.ok) {
      discardStaleTrainCaptureFromResponse(response);
      mockDryRunStatus.textContent = response.error;
      renderTrainDryRun();
      mockDryRunStatus.hidden = false;
      return;
    }
    const row = sharedPortalRows.find(
      (candidate) => candidate.portalKey === activePortal.key,
    );
    if (row) row.provenAt = new Date().toISOString();
    portal = { ...activePortal, proven: true };
    mockDryRunStatus.textContent =
      "Marked proven. This manual stamp records that you reviewed the filled form.";
    renderTrainDryRun();
    mockDryRunStatus.hidden = false;
  })();
});

void (async () => {
  const response = await sendToBackground({ type: "GET_AUTH_STATE" });
  if (response.ok && response.data.signedIn) {
    showMain(response.data);
  } else {
    showSignin();
  }
})();
