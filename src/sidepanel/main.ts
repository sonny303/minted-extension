// Side panel UI: sign in, resolve an organization, pick a provider, location,
// and case, fill the open portal page. All auth and API work happens in the
// background worker; this file only renders state and sends typed messages.
// Unlike the old popup, the panel stays open across tab switches, so portal
// detection follows the active tab and the fill re-checks the tab's URL at
// click time.
import "./sidepanel.css";
import type {
  CaseContext,
  CaseListItem,
  CasePortalTask,
  NextBestActionResult,
  ProviderListItem,
  ProviderProfileFacility,
  UserOrgMembership,
} from "../shared/apiTypes";
import type {
  FillCoverage,
  FillReportRecord,
  FillSummary,
  MockDryRunSummary,
  ReportedField,
} from "../shared/fill";
import {
  sendToBackground,
  type AuthState,
  type SearchResults,
  type SelectorTestResult,
} from "../shared/messages";
import { formatDisplayDate, looksLikeIsoDate } from "../shared/detailFields";
import {
  matchPortalByUrl,
  portalOriginPatterns,
  type MatchedPortal,
} from "../shared/portals";
import type {
  CaseContextTaskStep,
  NextBestActionItem,
  PortalFieldMap,
  PortalFieldType,
  PortalRegistryRow,
} from "../shared/apiTypes";
import { matchPortalTasks } from "../shared/submission";
import { API_BASE_URL } from "../shared/config";
import type { ActiveCaseRecord } from "../shared/handoff";
import {
  orderLayoutByCatalog,
  providerWebappPath,
  shouldRetryFacilityCards,
  type QuickCardField,
  type QuickCards,
} from "../shared/quickCards";
import {
  caseContextHasContent,
  facilityAddressLines,
  facilityPickerScope,
  resolveCaseFacilitySelection,
} from "../shared/caseContext";
import type { QuickCardCatalogField } from "../shared/apiTypes";
import {
  countBrokenSelectors,
  partitionGaps,
  providerFixPath,
  trainFlowPath,
} from "../shared/fixit";
import {
  attestationLine,
  attestedOnFor,
  buildCaqhPushOffer,
} from "../shared/caqh";
import {
  canSendCapture,
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
  resolveTrainRecognition,
} from "../shared/trainForms";
import {
  browseableProviders,
  providerGroupsLabel,
  providerMatchesQuery,
} from "../shared/browseProviders";
import {
  findSandboxProvider,
  sandboxFillState,
  SANDBOX_UNAVAILABLE_NOTE,
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

// Story 10: warn before logging a second submission on a case that was marked
// submitted within this window. The human can still log anyway (one click).
const DUPLICATE_WINDOW_DAYS = 14;

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
// E6.9 F6.9.7 — the job chooser and the Train-forms module.
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
const accountEmail = el<HTMLElement>("account-email");
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
const facilitySelect = el<HTMLSelectElement>("facility-select");
const facilityHint = el<HTMLElement>("facility-hint");
const facilityAddress = el<HTMLElement>("facility-address");
// E1.5 — every location the SELECTED CASE has on file (facility-select stays
// the one fill-target picker; this is read-only context beside it).
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
const sandboxEntryMeta = el<HTMLElement>("sandbox-entry-meta");
const sandboxUnavailable = el<HTMLElement>("sandbox-unavailable");
const sandboxBar = el<HTMLElement>("sandbox-bar");
const sandboxBarNote = el<HTMLElement>("sandbox-bar-note");
const sandboxFillBtn = el<HTMLButtonElement>("sandbox-fill");
const sandboxClearBtn = el<HTMLButtonElement>("sandbox-clear");
const sandboxExitBtn = el<HTMLButtonElement>("sandbox-exit");
const sandboxStatus = el<HTMLElement>("sandbox-status");
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
const fillSkippedBox = el<HTMLElement>("fill-skipped");
const fillManualBox = el<HTMLElement>("fill-manual");
const fillEventWarn = el<HTMLElement>("fill-event-warn");
const gapFlag = el<HTMLElement>("gap-flag");
const submitDetails = el<HTMLElement>("submit-details");
const payerRefInput = el<HTMLInputElement>("payer-ref-input");
const wipNoteInput = el<HTMLTextAreaElement>("wip-note-input");
const taskLink = el<HTMLElement>("task-link");
const taskLinkSingle = el<HTMLElement>("task-link-single");
const taskSelect = el<HTMLSelectElement>("task-select");
const submitHint = el<HTMLElement>("submit-hint");
const dupWarn = el<HTMLElement>("dup-warn");
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

// The last successful fill, held so "Mark submitted" can log the touch
// against the right case and fill session. Cleared whenever the selection
// changes or a new fill starts; restored from the persisted report when the
// panel reopens.
interface LastFill {
  providerId: string;
  caseId: string;
  portalKey: string;
  fillSessionId: string | null;
}

let orgs: UserOrgMembership[] = [];
// The multi-org pick (the worker sends it as x-org-id). Stays null in
// single-org mode — the server resolves the sole membership, no header.
let activeOrgId: string | null = null;
let providers: ProviderListItem[] = [];
let cases: CaseListItem[] = [];
let facilities: ProviderProfileFacility[] = [];
let facilitiesLoaded = false;
// meta.needs_facility from the profile: several locations, server won't
// guess — the fill gate stays closed until the user picks one.
let needsFacility = false;
let portal: MatchedPortal | null = null;
let portalTabId: number | null = null;
// The DB-driven portal registry (S3.2): fetched per org, held in memory only.
// Empty until the org resolves — matchPortalByUrl over [] recognizes nothing,
// which is the correct signed-out/org-less posture.
let portalRows: PortalRegistryRow[] = [];
// E6.9: the current job, and the SHARED (global) registry Train forms works
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
let lastMockDryRunPortalKey: string | null = null;
let lastFill: LastFill | null = null;
// Phase 4: the SOP task the "Mark submitted" touch will close, derived from the
// selected case's portalTasks matched against the current page's portal. null =
// no matching task (or the user chose "Don't close a task"). Re-derived by
// renderTaskLink() each time the submit block renders; cleared on selection
// change / fresh fill.
let selectedTaskId: string | null = null;
// Story 10: set true after the first "Mark submitted" click on a recently
// submitted case surfaces the warning; the next click logs anyway. Reset on any
// selection change or a fresh fill.
let dupConfirmPending = false;
// Epic 3a: the fill-ready selection the coverage panel currently reflects (or
// has a request in flight for). De-dupes the many updateFillReady() calls into
// one fetch per distinct selection; null when the selection isn't fill-ready
// (panel hidden). Depends only on what coverage depends on — provider, facility,
// portal, state — not the case, so switching cases doesn't refetch.
let coverageKey: string | null = null;
// Epic 3d: the case id whose context the block currently shows (or has a fetch
// in flight for). De-dupes redundant refreshCaseContext() calls and, together
// with the generation guard, lets a stale response for a previously-selected
// case be discarded on landing. null when no case is selected (block hidden).
let caseContextCaseId: string | null = null;
// The last rendered case context — feeds the identity guard header and the
// case-selected facility auto-pick. In-memory only, cleared with the case.
let caseContextData: CaseContext | null = null;
// When a case is freshly chosen (search / dropdown / NBA / handoff), the
// case's facility_id wins over a remembered provider location. Cleared after
// maybeApplyCaseFacility runs (or when the case has no facility).
let preferCaseFacility = false;
// E4.3 F4.3.1: the worker-owned active-case record as last read, and its
// expiry status. The panel re-reads on open, on the worker's
// ACTIVE_CASE_UPDATED broadcast, and on a slow poll (expiry has a clock).
let activeCase: ActiveCaseRecord | null = null;
let activeCaseStatus: "none" | "active" | "expired" = "none";
// The handoff launch the panel already applied (caseId + createdAt), so a
// re-read doesn't re-apply the same launch — but a SECOND launch (new
// createdAt, last-launch-wins) does apply.
let appliedHandoffKey: string | null = null;
// F4.3.4: the structured-touch draft's idempotency id — generated when a
// draft first saves, REUSED on every retry (a retry can never double-log),
// regenerated only after a success.
let touchDraftId: string | null = null;
// Unified search bookkeeping: debounce timer + a sequence counter so a slow
// response for an old query never renders over a newer one.
let searchTimer: number | undefined;
let searchSeq = 0;

// Request-generation guard against stale async responses (fill-safety: a slow
// response for provider A must never render A's cases or facilities under
// provider B after a fast switch — that is a wrong-record-fill risk). Any
// context switch that changes what the pickers should show — the initial /
// restore load, org switch, provider switch, refresh, sign-out — bumps this
// counter via bumpGeneration(). Every async loader captures the value at entry
// and, after each await, discards its result (no module-state write, no DOM
// rebuild) when a newer context has superseded it. The restore flow runs as a
// single uninterrupted generation, so the guard never starves it.
let loadGeneration = 0;
function bumpGeneration(): number {
  return ++loadGeneration;
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

// The selected provider (2026-08-19). It used to BE the retired dropdown's
// value; now it is plain panel state, set by a search pick, a case pick, a
// hand-off, or the worker's remembered selection on load. Every generation
// guard around it is unchanged — only the storage moved.
let selectedProvider: string | null = null;

function selectedProviderId(): string | null {
  return selectedProvider;
}

/** Set (or clear) the selection. Rejects a non-uuid the same way reading the
 * dropdown's placeholder value used to. */
function setSelectedProviderId(id: string | null): void {
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
  // values (TE-14 — values live only in this render).
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

// E4.3 F4.3.5 — the read-only Quick Cards, projected worker-side from ONE
// audited profile read. Held so the Edit Layout form can pre-check the fields
// the cards currently show. Values are in-memory only.
let currentCards: QuickCards | null = null;
// The served picker catalog (rides GET_PROVIDER_FACILITIES). Empty = the
// catalog read failed — the picker renders an honest failure note instead of
// a stale local list.
let currentCatalog: QuickCardCatalogField[] = [];
// S4.1: dead-selector count from the last REAL fill on the current portal —
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
    // S2.3: absent values read "Not on file" with an amber icon and are not
    // clickable; the profile's unresolved reason rides the tooltip.
    const empty = document.createElement("span");
    empty.className = "id-empty not-on-file";
    empty.textContent = "⚠ Not on file";
    if (field.reason) empty.title = field.reason;
    dd.append(empty);
  } else {
    const text = document.createElement("span");
    // Wrap, never truncate (S2.3) — long values break to the next line.
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

// S2.3: one section per catalog group inside the details area — heading, the
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
  // per-provider (a copied NPI for one provider is not "copied" for another).
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
    : "DOB —";

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
  // other (removed 2026-08-19 — see the note on the QuickCards type).

  // B1.3: still unresolved after this render, with a location selected? One
  // bounded re-read, never a loop — see maybeRetryFacilityCards.
  maybeRetryFacilityCards();
}

// B1.3: a location is selected but facility.*/assignment.* tokens are still
// unresolved after a card render — usually a dropped refresh (a concurrent
// loadFacilities reset the <select>'s value mid-flight and tripped
// refreshFacilityCards's own generation/provider/facility guard, discarding a
// resolved response for good; see the guard comments there). Keyed by
// provider+facility so this fires AT MOST ONCE per selection: a genuinely
// unassigned location still ends on "Not on file" with the server's own
// reason after that one retry, which is correct, not a bug to keep chasing.
const retriedFacilityCards = new Set<string>();

function maybeRetryFacilityCards(): void {
  const providerId = selectedProviderId();
  const facilityId = selectedFacilityId();
  if (providerId == null || facilityId == null) return;
  const key = `${providerId}|${facilityId}`;
  // The gate itself is pure (src/shared/quickCards.ts, B1.3) — this function
  // only supplies the live session state and fires the bounded retry.
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

// The Edit Layout form (S2.2): search over collapsible groups rendered from
// the SERVED catalog (GET /api/me/view-prefs `catalog` — schema-derived
// server-side, so the picker offers exactly what a PUT will accept; no local
// allowlist survives). Checkbox DOM order within the render is the saved
// order source; there is no layout-length cap (S2.1) — the closed served key
// set bounds what a layout can contain.
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
    // Empty groups hide (S2.2) — under a query AND when a group is empty.
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
    // "3 of 45" in primary when any picked, else "of 45" subtle (S2.2).
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
    // The no-results state renders the query back (S2.2).
    empty.textContent = q
      ? `No fields match "${query.trim()}".`
      : "The field list couldn't be loaded — close and reopen the panel to retry.";
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
// so it persists across machines and worker restarts, TS-102), then refetch
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
    // and re-discovering what was already known (B1.1).
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
// session (S2.3) — the mark set clears on provider switch/sign-out via
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
    button.textContent = "Copy blocked — press Ctrl+C";
    window.setTimeout(() => {
      button.textContent = "Copy";
    }, 2500);
  }
}

// Story 11: the selected case's latest touchlog note, shown under the case
// picker. Hidden when no case is selected or the case has no note.
// S4.2 — the duplicate-work guard, fired ON PICKUP (not at submit, where it
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
  text.textContent = `This case was marked submitted ${phrase}. Someone may already have done this work.`;
  dupPickup.append(text);

  const actions = document.createElement("div");
  actions.className = "dup-pickup-actions";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "link";
  dismiss.textContent = "Continue anyway";
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
  link.textContent = "See the touchlog ↗";
  actions.append(link);
  dupPickup.append(actions);
}

function renderCaseNote(): void {
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

function contextRow(label: string): {
  row: HTMLDivElement;
  labelEl: HTMLSpanElement;
} {
  const row = document.createElement("div");
  row.className = "case-context-row";
  const labelEl = document.createElement("span");
  labelEl.className = "case-context-label";
  labelEl.textContent = label;
  row.append(labelEl);
  return { row, labelEl };
}

// "not_started" → "Not started" for the pipeline pill; the raw value is the
// server's E4.0 pipeline state key.
function humanizeStateKey(value: string): string {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// E4.2 execution-type labels for the open-task chips (read-only in R6:
// extension_fill tasks are the ones the Fill button serves; the rest are
// checklist context).
const EXECUTION_TYPE_LABELS: Record<string, string> = {
  manual: "Manual",
  extension_fill: "Auto-fill",
  auto_verify: "Auto verify",
  document_attach: "Document attach",
};

// F4.3.1 identity guard: the strip under the header always names the org the
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

// E4.3: the case explicitly selects a facility (credential_cases.facility_id,
// resolved server-side — an explicit relationship, not a guess). When the
// context carries one, it becomes the location pick unless the user already
// picked; a fresh case selection (preferCaseFacility) overrides a remembered
// provider location so search → case lands on the case's practice site.
function maybeApplyCaseFacility(): void {
  // Wait for both the facility list and case context — clearing preferCaseFacility
  // here would race loadFacilities finishing before GET_CASE_CONTEXT returns.
  if (!facilitiesLoaded || caseContextData == null) return;
  // The decision itself is pure (src/shared/caseContext.ts, B1.2) — this
  // function is only the DOM/network side effects of whatever it decides.
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
    void sendToBackground({
      type: "SET_SELECTED_FACILITY",
      providerId,
      facilityId: decision.facilityId,
    });
    void refreshFacilityCards(providerId, decision.facilityId, loadGeneration);
  }
  renderFacilityAddress();
  updateFillReady();
}

/** Re-fetch the profile with a chosen facilityId so facility.* / assignment.*
 * quick-card tokens resolve. The initial multi-facility load intentionally
 * omits facilityId (server sets needs_facility); without this refresh the
 * PRACTICE LOCATION card stays "Not on file" even after a dropdown pick.
 * B1.1: the case's state (selectedCaseState() — the same source the fill path
 * uses) rides along too, so a provider with several state licenses resolves
 * the right one instead of staying ambiguous. */
async function refreshFacilityCards(
  providerId: string,
  facilityId: string,
  generation: number,
): Promise<void> {
  const state = selectedCaseState();
  const response = await sendToBackground({
    type: "GET_PROVIDER_FACILITIES",
    providerId,
    facilityId,
    ...(state ? { state } : {}),
  });
  // Stale-response guards (generation/provider/facility all changed under us)
  // still discard this response's DATA exactly as before — a superseded
  // fetch must never paint the wrong provider's cards. B1.3 adds only a
  // retry PATH, never removes this staleness protection: even when one of
  // these trips, maybeRetryFacilityCards() below still runs and re-checks the
  // CURRENT (post-race) selection on its own terms, live, rather than acting
  // on anything this now-discarded response resolved.
  if (
    isCurrent(generation) &&
    selectedProviderId() === providerId &&
    selectedFacilityId() === facilityId &&
    response.ok
  ) {
    needsFacility = response.data.needsFacility;
    currentCatalog = response.data.catalog;
    renderQuickCards(response.data.cards);
    renderFacilityAddress();
    renderIdentityGuard();
    updateFillReady();
  }
  // B1.3: whether the response above was accepted or discarded, settle the
  // CURRENT selection once more — a discarded response (the race this ticket
  // targets: a concurrent loadFacilities reset the <select>'s value between
  // this request and its response) must not leave facility.*/assignment.*
  // stuck unresolved with nothing left to retry it. Bounded to one retry per
  // provider+facility regardless of how many times this runs.
  maybeRetryFacilityCards();
}

// Epic 3d + E4.3 TE-2: render the selected case's workbench context — identity
// (provider/payer/state), pipeline state, tracking ID, open SOP tasks with
// execution types, latest note and touch — as a read-only card. A null
// argument (no case, an error, or nothing to show) hides the block. Purely
// informational — it never gates the fill/submit flow, and nothing here is
// persisted beyond this render.
// S4.3 — one task's SOP steps. The step for the page in hand carries a THIS
// PAGE chip and a row tint. Ticking writes through the server, which owns the
// ordering rule; a rejection renders verbatim beneath the step and the
// checkbox reverts — never a false success (the cross-cutting gate).
function stepList(
  taskId: string,
  steps: readonly CaseContextTaskStep[],
): HTMLElement {
  const list = document.createElement("ul");
  list.className = "step-list";
  for (const step of steps) {
    const li = document.createElement("li");
    li.className = "step-row";
    const onThisPage = portal != null && step.portalKey === portal.key;
    if (onThisPage) li.classList.add("step-row-here");

    const label = document.createElement("label");
    label.className = "step-label";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = step.isCompleted;
    // A completed step is terminal here: un-ticking is a webapp correction,
    // not something the panel should offer mid-fill.
    box.disabled = step.isCompleted;
    const text = document.createElement("span");
    text.textContent = step.label;
    label.append(box, text);
    li.append(label);

    if (onThisPage) {
      const chip = document.createElement("span");
      chip.className = "pill this-page-chip";
      chip.textContent = "THIS PAGE";
      li.append(chip);
    }

    const error = document.createElement("p");
    error.className = "step-error";
    error.hidden = true;
    li.append(error);

    box.addEventListener("change", () => {
      if (!box.checked) return;
      const caseId = selectedCaseId();
      box.disabled = true;
      error.hidden = true;
      void (async () => {
        const response = await sendToBackground({
          type: "COMPLETE_TASK_STEP",
          taskId,
          stepId: step.id,
        });
        if (!response.ok) {
          // Explicit failure: revert the box and say why (the server's own
          // message, e.g. 'Complete "Upload W-9" first').
          box.checked = false;
          box.disabled = false;
          error.hidden = false;
          error.textContent = response.error;
          return;
        }
        // Re-read the context so the whole checklist reflects the server's
        // state (including a task that just rolled up to completed).
        if (caseId) refreshCaseContext();
      })();
    });
    list.append(li);
  }
  return list;
}

function renderCaseContext(context: CaseContext | null): void {
  caseContextData = context;
  caseContextBox.replaceChildren();
  // E1.5 — rescope #facility-select to this case's own locations (or widen
  // back to the provider's full set) BEFORE maybeApplyCaseFacility runs, so
  // the case's primary has an <option> to land on. Independent of the
  // hasContent gate below (a "quiet" case's location still matters) and of
  // the render list, which is purely cosmetic beside it.
  rescopeFacilitySelectOptions();
  renderCaseLocations(context);
  // B1.2: location adoption must never be gated on whether the card has
  // anything to SHOW — a freshly generated case with no note/touch/tasks/
  // pipeline/refs yet ("quiet") still has its own selectedFacility, and that
  // must still get adopted. Run this before the hasContent early return,
  // unconditionally (its own internal guards handle a null context safely).
  maybeApplyCaseFacility();
  const refs = context?.referenceNumbers ?? [];
  const note = context?.latestNote ?? null;
  const touch = context?.latestTouch ?? null;
  const tasks = context?.openTasks ?? [];
  const pipeline = context?.payerPipelineState ?? null;
  const hasContent = caseContextHasContent(context);
  caseContextBox.hidden = context == null || !hasContent;
  renderIdentityGuard();
  if (context == null || !hasContent) return;

  // Pipeline state (E4.0): where the payer is, read-only.
  if (pipeline != null) {
    const { row } = contextRow("Pipeline");
    const pill = document.createElement("span");
    pill.className = "pill pill-pipeline";
    pill.textContent = humanizeStateKey(pipeline);
    row.append(pill);
    caseContextBox.append(row);
  }

  // Reference id(s) — the case's tracking ID. Hidden when the case has none.
  if (refs.length > 0) {
    const { row } = contextRow(
      refs.length === 1 ? "Tracking ID" : "Tracking IDs",
    );
    const value = document.createElement("span");
    value.className = "case-context-ref-value mono";
    value.textContent = refs.join(", ");
    row.append(value);
    caseContextBox.append(row);
  }

  // S4.3 — Progress: the case's open tasks and their SOP steps, scoped to the
  // portal in hand when one is recognized. Ticking a step WRITES
  // (PATCH /api/tasks/:id/steps); the server owns the ordering rule and a
  // rejection is shown verbatim — never a false success.
  if (tasks.length > 0) {
    // Scope to the portal in hand: a task counts when any of its steps names
    // the detected portal. Off a recognized page, all open tasks show.
    const scoped = portal
      ? tasks.filter((t) =>
          (t.steps ?? []).some((st) => st.portalKey === portal?.key),
        )
      : [];
    const shown = scoped.length > 0 ? scoped : tasks;
    const { row } = contextRow(`Progress (${shown.length})`);
    const list = document.createElement("ul");
    list.className = "case-task-list";
    for (const task of shown) {
      const item = document.createElement("li");
      const title = document.createElement("span");
      title.className = "case-task-title";
      title.textContent = task.title;
      const chip = document.createElement("span");
      const isFill = task.executionType === "extension_fill";
      chip.className = isFill ? "exec-chip exec-chip-fill" : "exec-chip";
      chip.textContent =
        EXECUTION_TYPE_LABELS[task.executionType] ?? task.executionType;
      item.append(title, chip);
      if (task.dueDate) {
        const due = document.createElement("span");
        due.className = "case-task-due";
        due.textContent = `due ${fmtContextDate(task.dueDate)}`;
        item.append(due);
      }
      const steps = task.steps ?? [];
      if (steps.length > 0) item.append(stepList(task.id, steps));
      list.append(item);
    }
    row.append(list);
    caseContextBox.append(row);
  }

  // Latest note: the content, with a subtle author + date meta line.
  if (note != null) {
    const { row } = contextRow("Latest note");
    const body = document.createElement("span");
    body.className = "case-context-note-body";
    body.textContent = note.content;
    row.append(body);
    const date = fmtContextDate(note.createdAt);
    const metaText = [note.authorName, date].filter(Boolean).join(" · ");
    if (metaText) {
      const meta = document.createElement("span");
      meta.className = "case-context-meta";
      meta.textContent = metaText;
      row.append(meta);
    }
    caseContextBox.append(row);
  }

  // Last touch (optional): a compact "outcome · date" line.
  if (touch != null) {
    const { row } = contextRow("Last touch");
    const value = document.createElement("span");
    value.className = "case-context-touch-value";
    const date = touch.touchDate ? fmtContextDate(touch.touchDate) : "";
    value.textContent = [touch.outcome, date].filter(Boolean).join(" · ");
    row.append(value);
    caseContextBox.append(row);
  }
}

// Fetch and render the selected case's context whenever the case selection
// changes; hide the block when no case is selected. Mirrors the coverage
// sensor's staleness handling: it captures the case id AND the load generation
// at request time and discards the response on landing if a different case was
// selected (case switch — doesn't bump the generation) or a newer context
// superseded it (provider/org switch — does). Non-critical: on error it hides
// silently, never raising the error box.
function refreshCaseContext(): void {
  const caseId = selectedCaseId();
  // Same case already shown / in flight — leave the block as-is.
  if (caseId === caseContextCaseId) return;
  caseContextCaseId = caseId;
  if (caseId == null) {
    renderCaseContext(null);
    return;
  }
  // Hide while loading — the block is advisory, so no spinner/placeholder.
  renderCaseContext(null);
  const generation = loadGeneration;
  void (async () => {
    const response = await sendToBackground({
      type: "GET_CASE_CONTEXT",
      caseId,
    });
    // Discard a stale response: a newer generation (provider/org switch) or a
    // different case selected while we were in flight.
    if (!isCurrent(generation) || caseId !== caseContextCaseId) return;
    renderCaseContext(response.ok ? response.data : null);
  })();
}

// Story 5: prefill the payer-reference box from the selected case's stored
// reference; a fresh WIP note per case. Called on every case (re)selection.
function resetSubmitInputs(): void {
  const id = selectedCaseId();
  const caseItem = cases.find((c) => c.id === id) ?? null;
  payerRefInput.value = caseItem?.payerReferenceId ?? "";
  wipNoteInput.value = "";
}

// Phase 4: the just-filled case's open SOP tasks whose portal_key matches the
// portal on the current page — the tasks "Mark submitted" could close. Matched
// against the case backing the fill (lastFill), not whatever is selected now, so
// the offered task always belongs to what was actually filled. The compare is a
// literal string match on already-normalized keys (matchPortalTasks) — the
// extension never re-normalizes, exactly like the field-map → profile-token join.
function matchingPortalTasks(): CasePortalTask[] {
  const context = lastFill;
  if (!context || portal == null) return [];
  const caseItem = cases.find((c) => c.id === context.caseId);
  return matchPortalTasks(caseItem?.portalTasks, portal.key);
}

// Render the "close a task" affordance and set selectedTaskId. Zero matches →
// hidden, no task closed (today's behavior). One → auto-selected, shown as
// "Will close task: <title>". Several → a dropdown preselecting NONE (the human
// picks which), with a "Don't link a task" escape. Never blocks or changes the
// submit itself.
function renderTaskLink(): void {
  const matches = matchingPortalTasks();
  const first = matches[0];
  selectedTaskId = null;
  taskSelect.replaceChildren();
  taskSelect.hidden = true;
  taskLinkSingle.hidden = true;

  if (!first) {
    taskLink.hidden = true;
    return;
  }
  taskLink.hidden = false;

  if (matches.length === 1) {
    selectedTaskId = first.taskId;
    taskLinkSingle.hidden = false;
    taskLinkSingle.textContent = `Will close task: ${first.title}`;
    return;
  }

  taskSelect.hidden = false;
  taskSelect.add(new Option("Don't link a task", ""));
  for (const t of matches) taskSelect.add(new Option(t.title, t.taskId));
  taskSelect.selectedIndex = 0; // preselect none — the human chooses a task
  selectedTaskId = null;
}

// Story 10: how long ago the selected case was last marked submitted, when
// that is inside the duplicate window — else null (no warning).
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
}

function clearFillResults(): void {
  nbaSection.hidden = true;
  nbaSection.replaceChildren();
  touchStatus.hidden = true;
  fillResults.hidden = true;
  fillReportTime.hidden = true;
  fillSkippedBox.hidden = true;
  fillManualBox.hidden = true;
  fillEventWarn.hidden = true;
  gapFlag.hidden = true;
  submitDetails.hidden = true;
  taskLink.hidden = true;
  selectedTaskId = null;
  submitHint.hidden = true;
  dupWarn.hidden = true;
  dupConfirmPending = false;
  markSubmittedBtn.hidden = true;
  markSubmittedBtn.disabled = false;
  markSubmittedBtn.textContent = "Mark submitted";
  submitStatus.hidden = true;
  lastFill = null;
}

// Hard gates, same pattern as the case rule: org resolved, provider selected,
// facility resolved (loaded and not awaiting a pick), case selected — and the
// portal form in the active tab. Shared by the Fill button's disabled state and
// the coverage sensor's readiness check so the two can never disagree.
function isFillReady(): boolean {
  const portalOpen = portal != null && portalTabId != null;
  const facilityBlocked = needsFacility && selectedFacilityId() == null;
  // F4.3.1: never fill from expired context — when the active-case record
  // covers the selected case and expired, the gate closes (the worker also
  // refuses; this keeps the button honest).
  const expiredBlocked =
    activeCaseStatus === "expired" &&
    activeCase != null &&
    activeCase.caseId === selectedCaseId();
  return Boolean(
    portalOpen &&
    orgResolved() &&
    selectedProviderId() &&
    facilitiesLoaded &&
    !facilityBlocked &&
    !expiredBlocked &&
    selectedCaseId(),
  );
}

function updateFillReady(): void {
  syncQueueVisibility();
  const portalOpen = portal != null && portalTabId != null;
  portalStatus.textContent = portalOpen
    ? `${portal?.label} form detected in the current tab.`
    : "Open a registered payer portal in the current tab to fill it.";
  portalStatus.classList.toggle("detected", portalOpen);
  // The server flagged several locations and none is picked yet.
  const facilityBlocked = needsFacility && selectedFacilityId() == null;
  facilityHint.hidden = !facilityBlocked;
  fillBtn.disabled = !isFillReady();
  // F4.3.4: the structured-touch form is available whenever a case is
  // selected — logging is manual and independent of a fill having run.
  touchSection.hidden = selectedCaseId() == null;
  // Every gate-state change routes through here, so this is the one place the
  // pre-fill coverage sensor re-evaluates itself.
  refreshCoverage();
}

// The coverage sensor reflects the profile (provider + state + facility) and the
// portal's field maps — NOT the case — but only shows for a fill-ready
// selection, so a case must be picked for the key to be non-null. null = not
// fill-ready = panel hidden.
// The enrollment state comes from the selected CASE (S3.2): the registry row
// carries no state — a national portal serves many — while every fill
// requires a case and every case names its state.
function selectedCaseState(): string {
  const caseItem = cases.find((c) => c.id === selectedCaseId());
  return caseItem?.state ?? "";
}

function coverageSelectionKey(): string | null {
  if (!isFillReady()) return null;
  return [
    selectedProviderId(),
    selectedFacilityId() ?? "none",
    portal?.key ?? "",
    selectedCaseState(),
  ].join("|");
}

// Request coverage when the fill-ready selection changes, and render it above
// the Fill button. Purely informational: it never enables/blocks the fill, and
// on error it just hides. Respects the generation guard exactly like the other
// loaders — a superseded selection's response is discarded, never rendered.
function refreshCoverage(): void {
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
  if (!providerId || !caseId || activePortal == null) return;
  const facilityId = selectedFacilityId();
  // Capture the generation at request time, like every other loader: an org /
  // provider / refresh / sign-out switch bumps it and this response is dropped.
  const generation = loadGeneration;
  renderCoverageLoading();
  void (async () => {
    const response = await sendToBackground({
      type: "GET_FILL_COVERAGE",
      providerId,
      caseId,
      portalKey: activePortal.key,
      state: selectedCaseState(),
      facilityId,
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

// F4.3.3: the in-place fix-it action for one gap. A MAPPING gap routes to the
// existing platform train flow with the portal/field context in the URL; a
// DATA gap routes to the provider record (the right fix, not the mapping
// flow). Opens in a new tab so the portal session is preserved; the extension
// itself never writes a mapping (TE-4).
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
  } else if (gap.kind === "no_value" && providerId != null) {
    href = `${API_BASE_URL}${providerFixPath(providerId)}`;
    label = "Add the data ↗";
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

// "Can fill M of N mapped fields." plus one row per gap (label + reason + the
// F4.3.3 fix action). A null argument hides the panel. The gap list is empty
// (and CSS-collapsed) at full coverage. Read-only — no field values are shown,
// only labels and reasons.
function renderCoverage(coverage: FillCoverage | null): void {
  coveragePanel.hidden = coverage == null;
  if (coverage == null) {
    coverageGaps.replaceChildren();
    refreshMapsBtn.hidden = true;
    return;
  }
  const noun = coverage.total === 1 ? "field" : "fields";
  coverageCount.textContent = `Can fill ${coverage.available} of ${coverage.total} mapped ${noun}.`;

  // S4.1 — PROVEN only when a dry run actually proved this form. An unproven
  // form still fills; it just says so and the button drops to secondary.
  const proven = portal?.proven === true;
  provenChip.hidden = !proven;
  unprovenNote.hidden = proven;
  unprovenNote.textContent = proven
    ? ""
    : "This form hasn't been proven by a dry run — check the result before you submit.";
  fillBtn.classList.toggle("secondary", !proven);
  fillBtn.classList.toggle("primary", proven);

  // S4.1 — drift: dead selectors from the LAST REAL fill on this portal mean
  // the form changed. Stated before the run, with the count, so a partial
  // fill is never a surprise.
  const broken = lastReportBrokenCount;
  driftStrip.hidden = broken === 0;
  driftStrip.textContent =
    broken === 0
      ? ""
      : `${broken} mapped ${broken === 1 ? "field" : "fields"} went missing on the last fill — this form may have changed.`;

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
  // TE-4's return path: after a fix-it completes in the platform, one click
  // refetches the maps + profile and re-checks coverage — the newly trained
  // field moves from the gap list into the fillable count.
  refreshMapsBtn.hidden = partitionGaps(coverage.gaps).mappingGaps.length === 0;
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
// context, each gap row also offers its F4.3.3 fix action in place — the
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

// The review state: filled count, the skipped/manual lists, and the
// "Mark submitted" button the human presses only after submitting the portal
// form themselves (the extension never automates the portal's submit).
// `restored` marks a report re-rendered from the persisted record: it gets a
// when-it-ran label, and an already-submitted one shows the logged state
// instead of the button.
function renderFillSummary(
  summary: FillSummary,
  restored?: { completedAt: string; submitted: boolean },
): void {
  fillResults.hidden = false;
  fillReportTime.hidden = restored == null;
  if (restored)
    fillReportTime.textContent = `Fill report from ${fmtReportTime(restored.completedAt)}.`;
  const attempted = summary.filled + summary.skipped.length;
  // The heading carries the counts, so no pill; the rows are the filled field
  // LABELS from the page result — values are never retained (PHI). The page
  // denominator keeps coverage honest: "24 mapped" on a ~117-field form is
  // partial coverage, not a fully trained form.
  const pageNote =
    summary.pageFields != null && summary.pageFields > 0
      ? ` The page has ~${summary.pageFields} fillable fields.`
      : "";
  fillSummaryBox.replaceChildren(
    bucketDetails(
      `Filled ${summary.filled} of ${attempted} mapped fields.${pageNote}`,
      null,
      summary.filledLabels,
    ),
  );
  fieldList(fillSkippedBox, "Not filled:", summary.skipped);
  // The manual/gap bucket carries the fix-it actions (F4.3.3), scoped to the
  // fill that actually ran (lastFill), not whatever is selected now.
  fieldList(fillManualBox, "Needs manual entry or review:", summary.manual, {
    portalKey: lastFill?.portalKey ?? portal?.key ?? null,
    providerId: lastFill?.providerId ?? selectedProviderId(),
  });
  if (!summary.eventRecorded) {
    fillEventWarn.hidden = false;
    // The background composes the full warning line (it knows the failure
    // kind); render it as-is.
    fillEventWarn.textContent =
      summary.eventError ??
      "Fill applied, but it couldn't be logged to Minted Panel. Retry from the case record.";
  }

  // Story 9: the field-gap flag — mapped fields that came back without a value
  // (skipped + needs-manual). Shown BEFORE the submit affordances so the human
  // sees the gaps first; submitting is never blocked.
  const gapCount = summary.skipped.length + summary.manual.length;
  gapFlag.hidden = gapCount === 0;
  if (gapCount > 0) {
    gapFlag.textContent =
      `${gapCount} mapped ${gapCount === 1 ? "field has" : "fields have"} no value yet - ` +
      "review the lists above and complete them on the portal before you submit.";
  }

  const submitted = restored?.submitted === true;
  // Stories 5/6: the payer-reference + WIP-note boxes show while the human can
  // still act; an already-logged (restored) report hides them.
  submitDetails.hidden = submitted;
  if (!submitted) {
    resetSubmitInputs();
    renderTaskLink();
  } else {
    taskLink.hidden = true;
    selectedTaskId = null;
  }
  submitHint.hidden = submitted;
  dupWarn.hidden = true;
  dupConfirmPending = false;
  markSubmittedBtn.hidden = submitted;
  markSubmittedBtn.disabled = false;
  markSubmittedBtn.textContent = "Mark submitted";
  submitStatus.hidden = !submitted;
  if (submitted) submitStatus.textContent = "Logged to the case.";
}

async function loadCases(
  providerId: string,
  generation: number,
): Promise<void> {
  clearFillResults();
  // Drop the previous provider's rows NOW — the active-cases list must never
  // show provider A's cases under provider B while the fetch is in flight.
  cases = [];
  renderActiveCases();
  caseSelect.disabled = true;
  caseSelect.replaceChildren(new Option("Loading cases…", ""));
  renderCaseStatusPill();
  // No valid case is selected during the load — hide any prior case's context.
  refreshCaseContext();
  updateFillReady();

  const response = await sendToBackground({ type: "LIST_CASES", providerId });
  // A newer provider/org selection superseded this load — discard silently.
  if (!isCurrent(generation)) return;
  if (!response.ok) {
    setError(mainError, response.error);
    caseSelect.replaceChildren(new Option("Unavailable", ""));
    cases = [];
    renderCaseStatusPill();
    updateFillReady();
    return;
  }

  cases = response.data;
  const remembered = await sendToBackground({
    type: "GET_SELECTED_CASE",
    providerId,
  });
  if (!isCurrent(generation)) return;
  const rememberedId =
    remembered.ok && cases.some((c) => c.id === remembered.data)
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
  caseSelect.replaceChildren();
  const placeholder = new Option(
    cases.length ? "Select a case…" : "No open cases for this provider",
    "",
    true,
    rememberedId == null,
  );
  placeholder.disabled = cases.length > 0;
  caseSelect.add(placeholder);
  for (const c of cases) {
    caseSelect.add(
      new Option(caseLabel(c), c.id, false, c.id === rememberedId),
    );
  }
  caseSelect.disabled = cases.length === 0;
  renderCaseStatusPill();
  renderCaseNote();
  renderDuplicateGuard();
  renderActiveCases();
  // Load context for the restored case (or hide when none was restored). Runs
  // under this generation; a superseding switch discards its response.
  refreshCaseContext();
  await restoreFillReport(providerId, rememberedId, generation);
  updateFillReady();
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
  if (selectedCase == null) return;
  const response = await sendToBackground({
    type: "GET_FILL_REPORT",
    providerId,
  });
  if (!isCurrent(generation)) return;
  if (!response.ok || response.data == null) return;
  const record: FillReportRecord = response.data;
  if (record.caseId !== selectedCase) return;
  // S4.1 drift signal: dead selectors from this portal's last REAL fill.
  if (record.portalKey === portal?.key) {
    lastReportBrokenCount = countBrokenSelectors(record.summary.skipped ?? []);
  }
  lastFill = {
    providerId,
    caseId: record.caseId,
    portalKey: record.portalKey,
    fillSessionId: record.summary.fillSessionId,
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

// E1.5 — every location the selected CASE has on file (context.facilities),
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

// E1.5 — rescopes #facility-select's populated OPTIONS to the case's own
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
    "Select a location…",
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
// B1.1: `known` carries a location/state the CALLER already has in hand —
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
  known: { facilityId?: string | null; state?: string } = {},
): Promise<void> {
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
    if (!isCurrent(generation)) return;
    if (remembered.ok && remembered.data != null) {
      speculativeFacilityId = remembered.data;
    }
  }

  let response = await sendToBackground({
    type: "GET_PROVIDER_FACILITIES",
    providerId,
    ...(speculativeFacilityId ? { facilityId: speculativeFacilityId } : {}),
    ...(known.state ? { state: known.state } : {}),
  });
  // A newer provider/org selection superseded this load — discard silently.
  if (!isCurrent(generation)) return;
  if (!response.ok && speculativeFacilityId != null && response.code === 404) {
    speculativeFacilityId = null;
    response = await sendToBackground({
      type: "GET_PROVIDER_FACILITIES",
      providerId,
      ...(known.state ? { state: known.state } : {}),
    });
    if (!isCurrent(generation)) return;
  }
  if (!response.ok) {
    facilitySelect.replaceChildren(new Option("Unavailable", ""));
    setError(mainError, response.error);
    updateFillReady(); // facilitiesLoaded stays false — gate stays closed
    return;
  }
  facilities = response.data.facilities;
  needsFacility = response.data.needsFacility;
  facilitiesLoaded = true;
  // The quick cards AND the served picker catalog ride on the same (single,
  // audited) profile fetch as the facility set.
  currentCatalog = response.data.catalog;
  renderQuickCards(response.data.cards);

  if (facilities.length === 0) {
    // Nothing to resolve: facility tokens come back unresolved with a
    // reason, which is correct — not a fill blocker.
    facilitySelect.replaceChildren(new Option("No locations on file", ""));
    updateFillReady();
    return;
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
    renderFacilityAddress();
    renderIdentityGuard();
    updateFillReady();
    return;
  }

  let rememberedId = resolvedSpeculativeId;
  if (rememberedId == null) {
    const remembered = await sendToBackground({
      type: "GET_SELECTED_FACILITY",
      providerId,
    });
    if (!isCurrent(generation)) return;
    rememberedId =
      remembered.ok && facilities.some((f) => f.id === remembered.data)
        ? remembered.data
        : null;
    if (remembered.ok && remembered.data != null && rememberedId == null) {
      void sendToBackground({
        type: "SET_SELECTED_FACILITY",
        providerId,
        facilityId: null,
      });
    }
  }
  facilitySelect.replaceChildren();
  const placeholder = new Option(
    "Select a location…",
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
  // E1.5 — covers the ordering where case context already arrived (a case was
  // picked) before this facilities load completed: rescope down to it before
  // the freshly-built full-provider-set options above get a pick applied
  // over them. A no-op when no case (or a case with no locations) is in play.
  rescopeFacilitySelectOptions();
  renderFacilityAddress();
  // E4.3: the case's explicit facility (from the context read) resolves the
  // pick when the user hasn't chosen one — the case selected it, not a guess.
  maybeApplyCaseFacility();
  renderIdentityGuard();
  updateFillReady();
  // Multi-facility: a selection that ISN'T the id this read already resolved
  // (the case's own facility, applied above, differing from the speculative
  // pick — or a remembered pick the caller didn't already know) still needs a
  // re-fetch so PRACTICE LOCATION/FACILITY ASSIGNMENT populate. When it IS the
  // same id, this read already resolved it — no second profile request.
  const selectedId = selectedFacilityId();
  if (
    selectedId != null &&
    facilities.length > 1 &&
    selectedId !== resolvedSpeculativeId
  ) {
    await refreshFacilityCards(providerId, selectedId, generation);
  }
}

async function loadProviders(generation: number): Promise<void> {
  setError(mainError, null);
  clearFillResults();
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
  if (provider)
    await Promise.all([
      loadCases(provider.id, generation),
      loadFacilities(provider.id, generation),
    ]);
}

// S1.5: the account row shows the active org's name beside the avatar —
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
  // F4.3.5: search operates under an EXPLICIT org — hidden until one resolves
  // (the identity-guard rule applies to standalone mode too). Nothing
  // org-scoped shows until this load lands.
  orgReady = false;
  renderModeSurfaces();
  hideSearchResults();
  renderProviderCard(null);
  renderIdentityGuard();
  clearFillResults();

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
    // Clearing any stored org id also wipes stale multi-org leftovers in
    // the worker (SET_ACTIVE_ORG clears org-scoped state on change).
    await sendToBackground({ type: "SET_ACTIVE_ORG", orgId: null });
    if (!isCurrent(generation)) return;
    orgSelect.replaceChildren(
      new Option(orgLabel(sole), sole.orgId, true, true),
    );
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
    "Select an organization…",
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

// S3.2: fetch the portal registry for the resolved org, then re-run portal
// detection — a page that wasn't recognized before the rows arrived becomes
// recognized the moment they do. A successful empty list is a loud empty-
// state (not "wrong page"); a fetch failure keeps the banner hidden and
// degrades recognition to nothing.
async function loadPortalRegistry(generation: number): Promise<void> {
  const response = await sendToBackground({ type: "LIST_PORTALS" });
  if (!isCurrent(generation)) return;
  portalRows = response.ok ? response.data : [];
  portalRegistryEmpty.hidden = !(response.ok && portalRows.length === 0);
  void detectPortal();
}

async function detectPortal(): Promise<void> {
  // Train uses the shared registry + sticky selection messaging (TRAIN-DUAL).
  // Do not overwrite `portal` from the Work `portalRows` list while training.
  if (panelMode === "train") {
    await refreshTrainRecognition();
    return;
  }
  const tab = await queryActiveTab();
  portal = matchPortalByUrl(tab?.url, portalRows);
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
// but the manifest only ships with BCBS KS — every other DB-registered portal
// (S3.2) is unreadable until the user grants its origin here. The prompt shows
// only when we're NOT already on a recognized portal AND we lack access to at
// least one registered origin; on a recognized page or once all are granted it
// stays hidden. Reads the registry we already fetched, so it needs no host
// permission to decide what to ask for.
async function refreshPortalAccessPrompt(): Promise<void> {
  if (portal != null) {
    portalAccess.hidden = true;
    return;
  }
  // The origins to ask for come from whichever registry this job works
  // against: the org's in case mode, the shared library's while training.
  const patterns = portalOriginPatterns(
    panelMode === "train" ? sharedPortalRows : portalRows,
  );
  if (patterns.length === 0) {
    portalAccess.hidden = true;
    return;
  }
  portalAccess.hidden = await hasOriginPermissions(patterns);
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

// The queue is the landing state: visible only while NOTHING is in hand
// (no provider/case selected in the panel). Selecting a case hides it;
// releasing shows it again — no confirmation either way.
function syncQueueVisibility(): void {
  const inHand = selectedProviderId() != null || selectedCaseId() != null;
  if (inHand) {
    queueSection.hidden = true;
    return;
  }
  if (queueSection.hidden && orgResolved()) void loadQueue(loadGeneration);
}

// The panel reflects the ACTIVE tab: re-detect on tab switch and on
// navigation in the active tab (a fill result stays on screen — the user
// hops to the portal tab to submit, then comes back for Mark submitted).
chrome.tabs.onActivated.addListener(() => void detectPortal());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
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
    void loadOrgs(bumpGeneration()).then(() => refreshActiveCase());
    void detectPortal();
    void restoreCapture();
  })();
}

// S1.5 — the account row: a 26px forest avatar circle with the user's white
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

function showSignin(): void {
  signinForm.reset();
  setError(signinError, null);
  showView("signin");
  identityGuard.hidden = true;
  // F4.3.1: a pending handoff while signed out is a first-class path — the
  // sign-in view says a case is waiting instead of silently dropping it.
  signinHandoffHint.hidden = true;
  void (async () => {
    const response = await sendToBackground({ type: "GET_ACTIVE_CASE" });
    signinHandoffHint.hidden = !(
      response.ok &&
      response.data.status === "active" &&
      response.data.record.source === "handoff"
    );
  })();
  emailInput.focus();
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
    facilities = [];
    facilitiesLoaded = false;
    needsFacility = false;
    caseContextCaseId = null;
    // TE-3/TE-14: sign-out clears every in-memory value the panel holds —
    // cards, context, search results, banners, the touch draft.
    activeCase = null;
    activeCaseStatus = "none";
    appliedHandoffKey = null;
    handoffNotice = null;
    renderHandoffBanner();
    renderQuickCards(null);
    renderActiveCases();
    hideSearchResults();
    searchInput.value = "";
    resetTouchForm();
    renderCaseContext(null);
    showSignin();
  })();
});

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
    clearFillResults();
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

facilitySelect.addEventListener("change", () => {
  const providerId = selectedProviderId();
  const facilityId = selectedFacilityId();
  if (providerId) {
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
// active-case state (TE-17 — same record and expiry semantics as a handoff);
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
    void sendToBackground({ type: "SET_SELECTED_CASE", providerId, caseId });
    if (recordEntry && caseId != null) {
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
    }
  }
  renderCaseStatusPill();
  renderCaseNote();
  renderDuplicateGuard();
  renderActiveCases();
  refreshCaseContext();
  clearFillResults();
  resetTouchForm();
  updateFillReady();
}

caseSelect.addEventListener("change", () => {
  applyCaseChoice(caseSelect.value || null, true);
});

fillBtn.addEventListener("click", () => {
  // Capture the selection generation at click. If the operator switches
  // provider/org/case while this fill is in flight, the generation changes and
  // the result is discarded rather than rendered under the wrong provider —
  // the same wrong-record guard the loaders use. The fill itself still ran and
  // is logged server-side against the click-time provider/case.
  const generation = loadGeneration;
  const providerId = selectedProviderId();
  const caseId = selectedCaseId();
  const facilityId = selectedFacilityId();
  // Same hard gates the disabled state enforces: org resolved, provider,
  // facility resolved, case selected.
  if (!orgResolved() || !providerId || !caseId) return;
  if (!facilitiesLoaded || (needsFacility && facilityId == null)) return;
  void (async () => {
    // The panel outlives tab switches, so never trust detection state from
    // earlier: re-read the active tab and re-match its URL at click time.
    const tab = await queryActiveTab();
    const clickPortal = matchPortalByUrl(tab?.url, portalRows);
    portal = clickPortal;
    portalTabId = clickPortal != null && tab?.id != null ? tab.id : null;
    updateFillReady();
    if (!clickPortal || tab?.id == null) {
      setError(
        mainError,
        "The enrollment form is no longer the active tab - switch back to it and try again.",
      );
      return;
    }
    setError(mainError, null);
    clearFillResults();
    fillBtn.disabled = true;
    fillBtn.textContent = "Filling…";
    fillBtn.classList.add("filling");
    fillNote.hidden = false;
    const response = await sendToBackground({
      type: "FILL",
      tabId: tab.id,
      providerId,
      caseId,
      portalKey: clickPortal.key,
      state: selectedCaseState(),
      facilityId,
    });
    fillBtn.textContent = "Fill this page";
    fillBtn.disabled = false;
    fillBtn.classList.remove("filling");
    fillNote.hidden = true;
    updateFillReady();
    // Selection changed mid-fill: drop this result so it can't render under the
    // provider now selected. Button chrome above is already restored.
    if (!isCurrent(generation)) return;
    if (!response.ok) {
      setError(mainError, response.error);
      return;
    }
    lastFill = {
      providerId,
      caseId,
      portalKey: clickPortal.key,
      fillSessionId: response.data.fillSessionId,
    };
    renderFillSummary(response.data);
  })();
});

// Several matching tasks: the human picks which one (or none) to close.
taskSelect.addEventListener("change", () => {
  selectedTaskId = taskSelect.value || null;
});

// Phase 4, point 6: after a submit that closed a task, refetch the provider's
// cases so the now-completed task drops out of portalTasks and can't be
// re-offered on a later fill of the same case. Reuses the case-picker's existing
// GET /api/cases call — no new endpoint. Best-effort and generation-guarded: a
// stale response (provider/org switched meanwhile) is discarded, and an error
// leaves the last-known cases in place (never raises the error box).
async function refreshCasesAfterSubmit(providerId: string): Promise<void> {
  const generation = loadGeneration;
  const response = await sendToBackground({ type: "LIST_CASES", providerId });
  if (!isCurrent(generation) || !response.ok) return;
  cases = response.data;
  renderCaseStatusPill();
  renderCaseNote();
}

// Pressed by the human only after they submit the portal form themselves.
// The background reuses one idempotency id per (case, fill session), so a
// retry after a failure can never double-log the touch. On submit it also
// carries the payer reference (Story 5), the WIP note (Story 6), and the
// task_id of the SOP task to close (Phase 4), when one was matched.
markSubmittedBtn.addEventListener("click", () => {
  const context = lastFill;
  if (!context) return;

  // Story 10: on a case submitted inside the duplicate window, the first click
  // surfaces a warning and re-labels the button; the next click logs anyway.
  if (!dupConfirmPending) {
    const caseItem = cases.find((c) => c.id === context.caseId);
    const phrase = recentSubmissionPhrase(caseItem);
    // S4.2 moved the duplicate WARNING to pickup, where it can still save the
    // work. Submitting stays a one-click confirm rather than a second warning:
    // by here the human has already seen the pickup notice and done the fill.
    if (phrase != null && !dismissedDupCaseIds.has(caseItem?.id ?? "")) {
      dupConfirmPending = true;
      dupWarn.hidden = false;
      dupWarn.textContent = `This case was marked submitted ${phrase}. Log another submission?`;
      markSubmittedBtn.textContent = "Log anyway";
      return;
    }
  }
  // Capture the task to close BEFORE the async work: a successful submit refetches
  // cases (mutating matchingPortalTasks), so read the id + title now.
  const closedTaskId = selectedTaskId;
  const closedTaskTitle = closedTaskId
    ? (matchingPortalTasks().find((t) => t.taskId === closedTaskId)?.title ??
      null)
    : null;
  void (async () => {
    setError(mainError, null);
    markSubmittedBtn.disabled = true;
    markSubmittedBtn.textContent = "Logging…";
    const response = await sendToBackground({
      type: "MARK_SUBMITTED",
      providerId: context.providerId,
      caseId: context.caseId,
      portalKey: context.portalKey,
      fillSessionId: context.fillSessionId,
      payerReferenceId: payerRefInput.value,
      wipNote: wipNoteInput.value,
      taskId: closedTaskId,
      // S4.4: request the In Progress -> Submitted bump alongside the touch.
      // Explicit and per-request — the R2 rule that the extension never
      // changes status IMPLICITLY still holds.
      bumpStatus: true,
    });
    if (!response.ok) {
      // A 404 here can now also mean a cross-org/invalid task_id — surface the
      // server's message as-is and let the human retry. Never auto-retry with
      // the task stripped.
      //
      // S4.4 offline/failure contract: the typed values stay on screen, the
      // state says UNSENT in as many words, and the button becomes an explicit
      // retry. The worker reuses the same idempotency id across retries, so a
      // retry after a network drop replays the anchor rather than double-
      // logging — the safe thing to do is press it again.
      markSubmittedBtn.disabled = false;
      markSubmittedBtn.textContent = "Retry — mark submitted";
      submitStatus.hidden = false;
      submitStatus.classList.add("partial");
      submitStatus.textContent = navigator.onLine
        ? "Not logged yet — nothing was recorded on the case. Your entries are kept; press retry."
        : "You're offline — nothing was recorded on the case. Your entries are kept; retry when you reconnect.";
      setError(mainError, response.error);
      return;
    }
    dupConfirmPending = false;
    dupWarn.hidden = true;
    submitStatus.classList.remove("partial");
    submitDetails.hidden = true;
    taskLink.hidden = true;
    selectedTaskId = null;
    submitHint.hidden = true;
    markSubmittedBtn.hidden = true;
    submitStatus.hidden = false;
    // S4.4 — report the touch AND the bump, separately and honestly. A
    // skipped bump is not a failed touch: the submission IS recorded, and the
    // reason (illegal edge, role, concurrency) comes from the server.
    const bump = response.data.statusBump;
    const lines = [
      closedTaskTitle
        ? `Logged to the case. Task closed: ${closedTaskTitle}`
        : "Logged to the case.",
    ];
    if (bump?.applied) lines.push("Case moved to Submitted.");
    else if (bump && !bump.applied) {
      lines.push(
        `Status unchanged — ${bump.reason ?? "the case couldn't be moved to Submitted."}`,
      );
    }
    submitStatus.textContent = lines.join(" ");
    submitStatus.classList.toggle("partial", bump != null && !bump.applied);
    // Point 6: drop the now-closed task from the case's portalTasks so a later
    // fill of the same case won't re-offer it.
    if (closedTaskId) void refreshCasesAfterSubmit(context.providerId);
    // F4.3.4: the loop continues from here — surface the queue top.
    void refreshNextBestAction(context.caseId);
  })();
});

// ---------------------------------------------------------------------------
// E4.3 F4.3.5 — active cases beneath the quick cards: the provider's open
// cases as clickable rows; clicking one enters the same active-case state as
// a handoff and lands in the fill loop.
// ---------------------------------------------------------------------------

// S3.4: does this case USE the recognized page? True when any of its open
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

  // S3.4: on a recognized payer form the heading flips to "Cases that use
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
// E4.3 F4.3.5 — unified standalone search (the no-context empty state): one
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
  await Promise.all([
    loadCases(provider.id, generation),
    loadFacilities(provider.id, generation),
  ]);
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
  // S3.5: the case's location from the C1 payload. Recorded BEFORE facilities
  // load so the picker opens already resolved — "zero dropdowns". Ignored when
  // the provider isn't actually assigned to it (loadFacilities validates the
  // stored pick against the real set). Also set from case-search rows that
  // carry facilityId so search → case defaults to the case's practice site.
  preferredFacilityId?: string | null,
  // B1.1: the case's state, when the caller already has it (a case-search row
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
  await Promise.all([
    loadCases(providerId, generation),
    loadFacilities(providerId, generation, {
      facilityId: preferredFacilityId,
      ...(preferredState ? { state: preferredState } : {}),
    }),
  ]);
  if (recordEntry && isCurrent(generation)) await refreshActiveCase(false);
}

/**
 * Picking a search result IS the hand-off into Work cases (2026-08-19).
 *
 * The mode flips FIRST so the destination is already on screen while the
 * provider/case load runs — landing on an empty Search pane and being moved
 * afterwards reads as a glitch. `setPanelMode` between two org-scoped modes
 * reloads nothing and does not bump the generation, so the selection in
 * flight here survives it.
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
        .join(" — ");
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
 * Fold in providers the SERVER's search cannot find (2026-08-19).
 *
 * `/api/providers?search=` matches name / NPI / email — not group names. But
 * the group is exactly what a user reaches for when two people share a name
 * ("ada riverbend"), so we also narrow the roster the panel already holds
 * and merge anything the server missed. Local-only, no extra request, and
 * server rows keep their order and their position at the top: this ADDS
 * reach, it never reorders or hides what the server decided.
 *
 * Skipped entirely when the provider half errored — presenting a locally
 * filtered subset as if it were the answer would hide the failure.
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

// ---------------------------------------------------------------------------
// E4.3 F4.3.1 — handoff receipt in the panel: read the worker's active-case
// record, validate the org against the caller's memberships, apply the case,
// and render every degraded path explicitly (expired / wrong org / signed
// out) — never silently, never another org's case.
// ---------------------------------------------------------------------------

// A one-shot notice that outlives the record it describes (e.g. after a
// non-member context is discarded, the record is gone but the user must see
// why).
let handoffNotice: string | null = null;

function handoffKey(record: ActiveCaseRecord): string {
  return `${record.caseId}:${record.createdAt}`;
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

  if (handoffNotice != null) {
    handoffBanner.hidden = false;
    handoffBanner.classList.add("banner-warn");
    const text = document.createElement("span");
    text.textContent = handoffNotice;
    handoffBanner.append(
      text,
      bannerButton("Dismiss", () => {
        handoffNotice = null;
        renderHandoffBanner();
      }),
    );
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
          await sendToBackground({ type: "CLEAR_ACTIVE_CASE" });
          activeCase = null;
          activeCaseStatus = "none";
          renderHandoffBanner();
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
      handoffBanner.hidden = false;
      const text = document.createElement("span");
      text.textContent = `A case was handed off in ${orgLabel(membership)}.`;
      handoffBanner.append(
        text,
        bannerButton(`Switch to ${orgLabel(membership)}`, () => {
          void switchOrgForHandoff(record);
        }),
      );
      return;
    }
  }

  // Applied handoff: a quiet provenance line while the context is live.
  if (appliedHandoffKey === handoffKey(record)) {
    handoffBanner.hidden = false;
    const text = document.createElement("span");
    text.textContent = "Working from a Minted Panel handoff.";
    handoffBanner.append(text);
  }
}

// The org-switch path for a cross-org handoff. The switch itself wipes the
// worker's org-scoped state (including the handoff record — TE-3), so the
// context is captured FIRST and re-entered as a fresh active-case record
// after the switch.
async function switchOrgForHandoff(record: ActiveCaseRecord): Promise<void> {
  const target = record.orgId;
  if (target == null) return;
  appliedHandoffKey = handoffKey(record);
  const generation = bumpGeneration();
  activeOrgId = target;
  renderOrgContext();
  orgSelect.value = target;
  await sendToBackground({ type: "SET_ACTIVE_ORG", orgId: target });
  if (!isCurrent(generation)) return;
  clearFillResults();
  hideSearchResults();
  orgReady = true;
  renderModeSurfaces();
  renderIdentityGuard();
  await selectCaseInPanel(
    record.providerId,
    record.caseId,
    true,
    record.facilityId,
  );
  renderHandoffBanner();
}

// Apply an active handoff to the panel: org checks first (F4.3.1 — a
// mismatched context is discarded or prompts a switch, never rendered), then
// the selection lands via the normal case path. Applied once per launch;
// a SECOND launch (new createdAt) applies again — last launch wins.
async function maybeApplyHandoff(record: ActiveCaseRecord): Promise<void> {
  const key = handoffKey(record);
  if (appliedHandoffKey === key) return;
  if (orgs.length === 0) return; // orgs not loaded yet — the next refresh applies

  if (record.orgId != null) {
    const member = orgs.some((o) => o.orgId === record.orgId);
    if (!member) {
      // Not this account's org: discard, say so explicitly.
      appliedHandoffKey = key;
      await sendToBackground({ type: "CLEAR_ACTIVE_CASE" });
      activeCase = null;
      activeCaseStatus = "none";
      handoffNotice =
        "A case was handed off for an organization this account isn't a member of, so it was discarded. Sign in with the right account, or use search below.";
      renderHandoffBanner();
      return;
    }
    const resolvedOrg =
      orgs.length === 1 ? (orgs[0]?.orgId ?? null) : activeOrgId;
    if (resolvedOrg !== record.orgId) {
      // Member, but the panel is operating as a different org (or none yet):
      // the banner prompts the explicit switch. Nothing is applied.
      renderHandoffBanner();
      return;
    }
  }

  appliedHandoffKey = key;
  // B1.1: the same-org handoff path was dropping record.facilityId entirely
  // (switchOrgForHandoff, just above, already threads it) — a launch from the
  // webapp that named a location still had to wait for the case-context
  // refresh to discover it. No state: not part of the locked handoff payload.
  await selectCaseInPanel(
    record.providerId,
    record.caseId,
    false,
    record.facilityId,
  );
  renderHandoffBanner();
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

// The worker's push channel: a handoff arrived / the bound tab closed / a
// second launch replaced the context while the panel is open.
chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message?.type === "ACTIVE_CASE_UPDATED") void refreshActiveCase();
});

// Slow poll: expiry is a clock, and no event fires when 60 idle minutes pass.
window.setInterval(() => {
  if (!views.main.hidden) void refreshActiveCase();
}, 30_000);

// ---------------------------------------------------------------------------
// E4.3 F4.3.4 — log-and-advance: the structured touch form + the next-best-
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
// survive for the retry (F4.3.4: the one line of context is never lost).
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
  touchSaveBtn.textContent = "Log touch";
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
      // Failed write: values stay in the form, the draft id stays, the button
      // becomes the retry (F4.3.4 AC).
      touchSaveBtn.disabled = false;
      touchSaveBtn.textContent = "Retry — log touch";
      setError(touchError, response.error);
      return;
    }
    resetTouchForm();
    touchStatus.hidden = false;
    touchStatus.textContent = "Touch logged to the case.";
    void refreshNextBestAction(caseId);
  })();
});

// After ANY successful log (structured touch or Mark submitted), fetch the
// server-derived queue top and render exactly one item — or the honest
// "queue clear" — with the handback + webapp deep link (TE-6).
async function refreshNextBestAction(loggedCaseId: string): Promise<void> {
  const generation = loadGeneration;
  nbaSection.hidden = false;
  nbaSection.replaceChildren(searchEmptyLine("Finding the next best action…"));
  const response = await sendToBackground({ type: "GET_NEXT_BEST_ACTION" });
  if (!isCurrent(generation)) return;
  if (!response.ok) {
    // Honest degrade (e.g. a server that predates the endpoint): the loop
    // continues in the webapp.
    nbaSection.replaceChildren(
      searchEmptyLine(`Next best action unavailable: ${response.error}`),
    );
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

// ---------------------------------------------------------------------------
// S3.3 — the case pickup queue. The panel opens to it when nothing is in hand
// (no active case selected): ORDER AND THE REASON LINE COME FROM THE SERVER —
// the extension never ranks (the cross-cutting "no invented priority" gate).
// Release returns here without a confirmation.
// ---------------------------------------------------------------------------

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
  title.textContent = `${item.providerName} — ${item.payerName} · ${item.state}`;
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
    // B1.1: the queue item already names the case's state — no facilityId on
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
    clear.textContent = "Queue clear — nothing needs action right now.";
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
  queueSection.replaceChildren(searchEmptyLine("Loading your queue…"));
  const response = await sendToBackground({ type: "GET_NEXT_BEST_ACTION" });
  if (!isCurrent(generation)) return;
  if (!response.ok) {
    queueSection.replaceChildren(
      searchEmptyLine(`Queue unavailable: ${response.error}`),
    );
    return;
  }
  // A server predating S3.3 sends only `item`; degrade to that single entry
  // rather than showing an empty queue.
  const items =
    response.data.items ?? (response.data.item ? [response.data.item] : []);
  renderQueue(items);
}

function renderNba(result: NextBestActionResult, loggedCaseId: string): void {
  nbaSection.replaceChildren();
  nbaSection.hidden = false;
  const heading = document.createElement("p");
  heading.className = "section-title";
  heading.textContent = "Next best action";
  nbaSection.append(heading);

  const item = result.item;
  if (item == null) {
    const done = document.createElement("p");
    done.className = "nba-clear";
    done.textContent = "Queue clear — nothing needs action right now.";
    nbaSection.append(done);
    return;
  }

  const card = document.createElement("div");
  card.className = "nba-card";
  const title = document.createElement("p");
  title.className = "nba-title";
  title.textContent =
    item.caseId === loggedCaseId
      ? "Next up is still this case:"
      : `Next: ${item.providerName} — ${item.payerName} · ${item.state}`;
  card.append(title);
  const action = document.createElement("p");
  action.className = "nba-action";
  action.textContent = item.action;
  card.append(action);
  if (item.reason) {
    const reason = document.createElement("p");
    reason.className = "nba-reason";
    reason.textContent = item.reason;
    card.append(reason);
  }
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
  if (item.caseId !== loggedCaseId) {
    const work = document.createElement("button");
    work.type = "button";
    work.className = "secondary nba-work";
    work.textContent = "Work this case";
    work.addEventListener("click", () => {
      nbaSection.hidden = true;
      // B1.1: same as the queue row — state rides along, no facilityId on
      // this row.
      void selectCaseInPanel(item.providerId, item.caseId, true, undefined, item.state);
    });
    actions.append(work);
  }
  actions.append(
    nbaLink("Open in Minted Panel ↗", `${API_BASE_URL}${item.deepLink}`),
  );
  card.append(actions);
  nbaSection.append(card);
}

// ---------------------------------------------------------------------------
// S6.2/S6.3 — CAQH. PUSH ONLY: we fill CAQH from Minted Panel and record the
// attestation. The exception strip (S6.3) is the single narrow pull — a field
// CAQH holds where we are blank — and appears ONLY when such a gap exists.
// There is no reconciliation of disagreements anywhere: Minted Panel is the
// source of truth.
// ---------------------------------------------------------------------------

// Whether the tab in hand is a CAQH portal. Registry-driven like every other
// portal check (S3.2) — no hardcoded host.
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
  caqhHeadline.textContent = caqhOffer.headline;
  caqhAttested.textContent = attestationLine(caqhOffer);
  // S6.2: a recently-attested profile de-emphasizes rather than nags.
  caqhSection.classList.toggle("de-emphasized", caqhOffer.deEmphasize);
}

caqhAttest.addEventListener("click", () => {
  const providerId = selectedProviderId();
  const offer = caqhOffer;
  if (!providerId || offer == null) return;
  const generation = loadGeneration;
  caqhAttest.disabled = true;
  caqhAttest.textContent = "Recording…";
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
      setError(mainError, response.error);
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
// S5.4 — capture: "we recognise N of M" with per-row evidence, gaps that are
// actionable but never blocking, and a send that works even when we
// recognised nothing (a form we understand none of is the one worth
// capturing). Approving stays in the webapp: this only proposes.
// ---------------------------------------------------------------------------

let captureSession: CaptureSession | null = null;
/** Set when the last capture added a page to an existing session — drives the
 * "· Page N of N" summary suffix (BITE-CAP-05). */
let captureAddedPage = false;
// 2026-08-19 manual mapping: which row's inline editor is open (one at a time
// — two open editors on one list is a way to save the wrong row), the last
// re-test answer, and whether a pick is waiting on the page.
let editingSelector: string | null = null;
let selectorTestResult: SelectorTestResult | null = null;
// BITE-TRAIN-01 — the open editor's UNSAVED values. Panel state, not DOM
// state: renderCapture() rebuilds the editor for reasons the trainer did not
// ask for (a selector test, a tab switch, a pick), and anything left in the
// inputs would go with it.
let rowDraft: CaptureRowDraft | null = null;
let pickInFlight = false;
// US-3.3 — rows ticked for a batch action, keyed by selector. Kept OUTSIDE the
// DOM so a re-render (after an edit, a pick, a re-test) never silently drops a
// selection the trainer made.
const batchSelection = new Set<string>();

// US-5 — is the sandbox profile in hand? Panel-only state: it is a way of
// WORKING, not a stored selection, and it must never survive into a real case
// (switching provider or case leaves it, below).
let sandboxActive = false;

// S6.3 — the CAQH EXCEPTION strip (fields CAQH holds where Minted Panel is
// blank) is QUARANTINED as of 3M Slice 2, not deleted.
//
// The panel-side half of it — a `caqhGapRows: CaqhGap[]` that was only ever
// `[]`, the row rendering that looped over it, the `#caqh-gaps` container and
// its CSS — is REMOVED here. Nothing ever populated that array, so every one
// of those branches was unreachable: the strip could not appear, and the code
// read as shippable UI when it was a stub.
//
// What REMAINS, deliberately, is the finished and tested machinery the feature
// would be rebuilt on: the pure `findCaqhGaps` reducer (shared/caqh.ts, with
// its unit tests) and the PULL_CAQH_FIELD message + worker handler. Those are
// correct; they just have no producer.
//
// The missing half is a PHI boundary decision, not an oversight: populating
// gaps means reading VALUES off the CAQH page, whereas the S5.2 capture scan
// reads form SHAPE only (labels and selectors, never values). Restoring the
// strip means a value-reading content script and a real CAQH account to verify
// against — a deliberate capability change, not a wiring task.
//
// The PUSH half of S6.2 (offer + attestation) is live and untouched.

// Date-only today for the pure CAQH module (it never reads a clock itself).
function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function renderCapture(): void {
  // Capture lives ONLY on Train forms (E6.9 two-job split). Work cases is the
  // case workflow — never the field trainer. A leftover session from a prior
  // Train visit stays in the worker but stays hidden here until Train is on.
  const training = isCaptureMode(panelMode);
  captureSection.hidden = !training || portal == null || portalTabId == null;
  if (captureSection.hidden) return;

  const counts = captureCounts(captureSession);
  const pageCount = usedPageNames(captureSession).length;
  // BITE-TRAIN-03 — the list is the scan JOINED to the shared library that is
  // already in hand, so it survives the session storage dying with the browser
  // and can say which library fields this page no longer has.
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

  // BITE-TRAIN-03 — the second column is what the LIBRARY says about the
  // field, which is the only thing here that decides whether it will fill.
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
  // BITE-TRAIN-01 — render FROM the draft, write back to it on every
  // keystroke. The editor is thrown away and rebuilt whenever anything
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

  // US-3.2 — the Selector Workshop. The auto-captured selector is a starting
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

/** US-3.3 — the batch bar appears on the first tick and states exactly what a
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
  });
  if (!response.ok) {
    setPickStatus(response.error, true);
    return;
  }
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
  const response = await sendToBackground({
    type: "EDIT_CAPTURE_ROW",
    selector: row.selector,
    ...patch,
  });
  if (!response.ok) {
    setPickStatus(response.error, true);
    return;
  }
  captureSession = response.data;
  editingSelector = null;
  selectorTestResult = null;
  rowDraft = null;
  setPickStatus(null);
  renderCapture();
}

async function removeCaptureRow(row: CaptureRow): Promise<void> {
  const response = await sendToBackground({
    type: "REMOVE_CAPTURE_ROW",
    selector: row.selector,
  });
  if (!response.ok) {
    setPickStatus(response.error, true);
    return;
  }
  captureSession = response.data;
  editingSelector = null;
  selectorTestResult = null;
  rowDraft = null;
  renderCapture();
}

async function testCaptureSelector(selector: string): Promise<void> {
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
    // Flash the matches on the page: a count alone cannot tell the trainer
    // they matched the WRONG control, which is the failure that matters.
    highlight: true,
  });
  if (!response.ok) {
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
  if (portalTabId == null || captureSession == null) return;
  const tabId = portalTabId;
  pickInFlight = true;
  captureAddField.disabled = true;
  setPickStatus("Click the field on the portal page · Esc to cancel");
  const response = await sendToBackground({
    type: "PICK_CAPTURE_FIELD",
    tabId,
    pageStep: currentCapturePage(),
  });
  pickInFlight = false;
  captureAddField.disabled = false;
  if (!response.ok) {
    setPickStatus(response.error, true);
    return;
  }
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
  if (portalTabId == null || captureSession == null) return;
  const tabId = portalTabId;
  pickInFlight = true;
  renderCapture();
  setPickStatus(`Click "${entry.name}" where it is now · Esc to cancel`);
  const response = await sendToBackground({
    type: "PICK_CAPTURE_FIELD",
    tabId,
    pageStep: currentCapturePage(),
    displayLabel: entry.name,
  });
  pickInFlight = false;
  if (!response.ok) {
    setPickStatus(response.error, true);
    renderCapture();
    return;
  }
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
  if (portalTabId == null || activePortal == null) return;
  const generation = loadGeneration;
  captureStart.disabled = true;
  captureNextPage.disabled = true;
  captureStart.textContent = "Reading the form…";
  const tab = await queryActiveTab();
  const tabUrl = tab?.url ?? null;
  const registry = panelMode === "train" ? sharedPortalRows : portalRows;
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
  // BITE-CAP-05 — the side panel always sends a fresh collision-free candidate
  // via derivePageStep; the background decides whether to reuse via
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
    pageStep: candidate,
    pageUrlTail: pageUrlTail(tabUrl),
    captureMode: mode,
  });
  captureStart.disabled = false;
  captureNextPage.disabled = false;
  if (!isCurrent(generation)) return;
  if (!response.ok) {
    captureStart.textContent = captureSession
      ? "Re-capture"
      : "Capture this form";
    setError(mainError, response.error);
    return;
  }
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
  const generation = loadGeneration;
  captureSend.disabled = true;
  captureSend.textContent = "Sending…";
  void (async () => {
    const response = await sendToBackground({ type: "SEND_CAPTURE" });
    captureSend.textContent = "Send for approval";
    if (!isCurrent(generation)) return;
    if (!response.ok) {
      captureSend.disabled = false;
      setError(mainError, response.error);
      return;
    }
    captureSession = response.data;
    renderCapture();
  })();
});

captureClear.addEventListener("click", () => {
  void (async () => {
    await sendToBackground({ type: "CLEAR_CAPTURE" });
    captureSession = null;
    captureAddedPage = false;
    captureRestored.hidden = true;
    renderCapture();
  })();
});

// S5.2 — restore an in-flight capture after a worker restart / panel reopen,
// and SAY what came back (labels and counts; there are no values to restore).
async function restoreCapture(): Promise<void> {
  const response = await sendToBackground({ type: "GET_CAPTURE" });
  captureSession = response.ok ? response.data : null;
  captureAddedPage = false;
  if (captureSession) {
    captureRestored.hidden = false;
    captureRestored.textContent = restoredSummary(captureSession);
  }
  renderCapture();
}

// ---------------------------------------------------------------------------
// US-5 — the sandbox test profile.
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

/** The pinned Search entry. Rendered from the roster, so an org that has not
 * designated a test provider gets the honest reason instead of a button that
 * fails when pressed. */
function renderSandboxEntry(): void {
  const provider = sandboxProvider();
  const offer = panelMode === "search" && orgReady;
  sandboxEntry.hidden = !offer || provider == null;
  sandboxUnavailable.hidden = !offer || provider != null;
  if (provider) {
    sandboxEntryMeta.textContent = `${providerLabel(provider)} · no case needed`;
  } else {
    sandboxUnavailable.textContent = SANDBOX_UNAVAILABLE_NOTE;
  }
}

/** The in-case-work sandbox chrome. Clear portal form lives here and ONLY
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
    ? `Filling as ${providerLabel(provider)}${state ? ` · ${state}` : ""}. Nothing is logged to a case.`
    : "Sandbox provider is no longer on this roster.";
  const ready = provider != null && portal != null && portalTabId != null;
  sandboxFillBtn.disabled = !ready;
  sandboxClearBtn.disabled = portalTabId == null;
}

function setSandboxStatus(message: string | null, isError = false): void {
  sandboxStatus.hidden = message == null;
  sandboxStatus.textContent = message ?? "";
  sandboxStatus.classList.toggle("capture-editor-warn", isError);
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
  setSandboxStatus(null);
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
  setSandboxStatus(null);
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
  const providerId = selectedProviderId();
  const activePortal = portal;
  if (providerId == null || activePortal == null || portalTabId == null) return;
  const provider = providers.find((p) => p.id === providerId) ?? null;
  sandboxFillBtn.disabled = true;
  setSandboxStatus("Filling…");
  const response = await sendToBackground({
    type: "SANDBOX_FILL",
    tabId: portalTabId,
    providerId,
    portalKey: activePortal.key,
    state: sandboxFillState(provider),
    facilityId: selectedFacilityId(),
  });
  sandboxFillBtn.disabled = false;
  if (!response.ok) {
    setSandboxStatus(response.error, true);
    return;
  }
  const summary = response.data;
  const parts = [
    `Filled ${summary.filled} of ${summary.pageFields} fields on this page`,
  ];
  if (summary.skipped.length > 0)
    parts.push(`${summary.skipped.length} skipped`);
  if (summary.manual.length > 0)
    parts.push(`${summary.manual.length} need manual entry`);
  // A failed machine log is reported, never swallowed — but it does not make
  // the fill a failure, because the fill happened.
  setSandboxStatus(
    summary.logError
      ? `${parts.join(" · ")}. ${summary.logError}`
      : `${parts.join(" · ")}.`,
    summary.logError != null,
  );
}

async function clearPortalFormFromPanel(): Promise<void> {
  const providerId = selectedProviderId();
  if (portalTabId == null || providerId == null) return;
  sandboxClearBtn.disabled = true;
  const response = await sendToBackground({
    type: "CLEAR_PORTAL_FORM",
    tabId: portalTabId,
    providerId,
  });
  sandboxClearBtn.disabled = false;
  if (!response.ok) {
    setSandboxStatus(response.error, true);
    return;
  }
  const { cleared } = response.data;
  setSandboxStatus(
    cleared === 0
      ? "Nothing to clear — the form is already empty."
      : `Cleared ${cleared} ${cleared === 1 ? "field" : "fields"}. Ready to re-test.`,
  );
}

sandboxEntry.addEventListener("click", () => void enterSandbox());
sandboxExitBtn.addEventListener("click", () => leaveSandbox());
sandboxFillBtn.addEventListener("click", () => void runSandboxFill());
sandboxClearBtn.addEventListener(
  "click",
  () => void clearPortalFormFromPanel(),
);

// ---------------------------------------------------------------------------
// E6.9 F6.9.7 + 2026-08-19 — the job chooser (Search / Work cases / Train
// forms), and F6.9.9 — Train forms.
// ---------------------------------------------------------------------------

/**
 * THE one place that decides what is on screen.
 *
 * Two inputs: the current job, and whether an org has resolved (everything
 * org-scoped stays hidden until it has — the F4.3.5 rule, which now covers
 * Search too since it reads org-scoped routes).
 *
 * It sets only the four top-level containers and never the individual cards
 * inside #case-work. That is deliberate: those manage their own `hidden` as
 * data arrives, and a mode switch that reached in would either reveal a card
 * with nothing in it or clobber a state it did not set. Hiding the parent
 * hides them regardless; showing it restores exactly what each had decided.
 */
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
  searchSection.hidden = !(searching && orgReady);
  caseWork.hidden = training || searching || !orgReady;

  if (training) hideSearchResults();
  renderSelectedProvider();
  renderSandboxEntry();
  renderSandboxBar();
  renderCapture();
  void refreshPortalAccessPrompt();
}

/** Kept as the pre-2026-08-19 name for the call sites that mean "the job
 * changed, re-render". */
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
  trainRecognition.textContent = "Looking up this form…";
  const response = await sendToBackground({ type: "LIST_SHARED_PORTALS" });
  if (!response.ok) {
    sharedPortalRows = [];
    trainRecognition.textContent = response.error;
    return;
  }
  // A non-array here is fatal, not cosmetic: renderTrainPayers iterates this
  // DURING render, so `for (… of null)` takes the whole panel down rather than
  // just the payer select. An `ok` envelope carrying a null `data` is a shape
  // the wire permits, so treat anything unexpected as an empty library — the
  // trainer then sees "no payers" instead of a blank panel.
  sharedPortalRows = Array.isArray(response.data) ? response.data : [];
  renderTrainPayers();
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
  placeholder.disabled = names.length > 0;
  trainPayer.add(placeholder);
  for (const name of names) {
    trainPayer.add(new Option(name, name, false, name === previous));
  }
  trainPayer.disabled = names.length === 0;
}

/** Portals belonging to the selected payer — the "find/select" half of the
 * F6.9.7 flow, for when the open tab is not the form (or is not yet granted). */
function renderTrainPortals(): void {
  const payerName = trainPayer.value;
  const rows = sharedPortalRows.filter(
    (r) => (r.payerName ?? "") === payerName,
  );
  trainPortalField.hidden = payerName === "" || rows.length === 0;
  const previous = trainPortal.value;
  trainPortal.replaceChildren();
  for (const row of rows) {
    trainPortal.add(
      new Option(row.name, row.portalKey, false, row.portalKey === previous),
    );
  }
}

function renderTrainDryRun(): void {
  const recognized =
    panelMode === "train" && portal != null && portalTabId != null;
  trainDryRunSection.hidden = !recognized;
  runMockDryRunBtn.disabled = !recognized;
  markPortalProvenBtn.disabled = !recognized;
  trainProvenChip.hidden = !recognized || portal?.proven !== true;
  if (!recognized) {
    mockDryRunStatus.hidden = true;
    clearMockDryRunDetail();
  }
}

/** BITE-TRAIN-02 — the dry run's per-field diagnosis, in the same buckets the
 * fill report uses. The engine already returns each failure with its reason;
 * rendering only the counts made the trainer re-derive them on the page. */
function renderMockDryRunDetail(summary: MockDryRunSummary): void {
  fieldList(mockDryRunSkipped, "Not filled on the page:", summary.skipped);
  fieldList(mockDryRunGaps, "Mapping gaps:", summary.gaps);
}

function clearMockDryRunDetail(): void {
  mockDryRunSkipped.hidden = true;
  mockDryRunSkipped.replaceChildren();
  mockDryRunGaps.hidden = true;
  mockDryRunGaps.replaceChildren();
}

/**
 * What is the open page, and what does the system already know about it?
 *
 * Capture bind is URL-only (TRAIN-DUAL D-TD.1 C amended). The dropdown is
 * sticky navigation/messaging — it never sets `portal`. A RECOGNIZED form
 * shows pages/fields already mapped; re-capture is the user's choice. When a
 * form is selected but the tab does not match (login / SSO / wizard redirect),
 * copy says so and capture stays off — it must not claim a "new form".
 */
async function refreshTrainRecognition(): Promise<void> {
  const tab = await queryActiveTab();
  const view = resolveTrainRecognition({
    url: tab?.url,
    rows: sharedPortalRows,
    payerName: trainPayer.value || null,
    selectedPortalKey: trainPortal.value,
  });

  if (view.status === "matched") {
    portal = view.portal;
    portalTabId = tab?.id ?? null;
    const maps = await sendToBackground({
      type: "LIST_SHARED_FIELD_MAPS",
      portalKey: view.portal.key,
    });
    trainFormMaps = maps.ok ? maps.data : [];
    const state = formCaptureState(trainFormMaps);
    trainRecognition.textContent = `${view.portal.label} — already trained: ${captureStateSummary(state)}.`;
    trainHint.textContent =
      state.undecided > 0
        ? `${state.undecided} captured ${state.undecided === 1 ? "field is" : "fields are"} still waiting for a decision in the web app. Re-capture only if the form itself changed.`
        : "Re-capture only if the form changed — nothing here changes a mapping on its own.";
    if (lastMockDryRunPortalKey !== view.portal.key) {
      lastMockDryRunPortalKey = null;
      mockDryRunStatus.hidden = true;
    }
  } else {
    portal = null;
    portalTabId = null;
    trainFormMaps = [];
    lastMockDryRunPortalKey = null;
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
  renderTrainPortals();
  void refreshTrainRecognition();
});
trainPortal.addEventListener("change", () => {
  const row = sharedPortalRows.find((r) => r.portalKey === trainPortal.value);
  // Sticky selection updates mismatch/match copy immediately; opening the
  // form is how the trainer reaches the registered URL for capture bind.
  void refreshTrainRecognition();
  if (!row?.formUrl) return;
  void chrome.tabs.create({ url: row.formUrl });
});

runMockDryRunBtn.addEventListener("click", () => {
  const activePortal = portal;
  const activeTabId = portalTabId;
  if (activePortal == null || activeTabId == null) return;
  const generation = loadGeneration;
  runMockDryRunBtn.disabled = true;
  markPortalProvenBtn.disabled = true;
  mockDryRunStatus.hidden = false;
  mockDryRunStatus.textContent =
    "Filling the live form with synthetic Sample values…";
  void (async () => {
    const tab = await queryActiveTab();
    const currentPortal = matchPortalByUrl(tab?.url, sharedPortalRows);
    if (tab?.id == null || currentPortal?.key !== activePortal.key) {
      await refreshTrainRecognition();
      if (isCurrent(generation)) {
        mockDryRunStatus.hidden = false;
        mockDryRunStatus.textContent =
          "This tab no longer matches the recognized form. Open the registered form and retry.";
      }
      return;
    }
    const response = await sendToBackground({
      type: "RUN_MOCK_DRY_RUN",
      tabId: tab.id,
      portalKey: activePortal.key,
    });
    if (!isCurrent(generation)) return;
    if (!response.ok) {
      mockDryRunStatus.textContent = response.error;
      renderTrainDryRun();
      clearMockDryRunDetail();
      mockDryRunStatus.hidden = false;
      return;
    }
    lastMockDryRunPortalKey = activePortal.key;
    const { filled, skipped, gaps, pass } = response.data;
    mockDryRunStatus.textContent = pass
      ? `Mock dry run passed: filled ${filled} field${filled === 1 ? "" : "s"}. Review the live form, then mark it proven manually.`
      : `Mock dry run needs attention: filled ${filled}, skipped ${skipped.length}, and ${gaps.length} mapping gap${gaps.length === 1 ? "" : "s"}.`;
    renderTrainDryRun();
    // A passing run has nothing in either bucket, so `fieldList` hides them
    // and the result stays the one line it was.
    renderMockDryRunDetail(response.data);
    mockDryRunStatus.hidden = false;
  })();
});

markPortalProvenBtn.addEventListener("click", () => {
  const activePortal = portal;
  if (activePortal == null) return;
  const generation = loadGeneration;
  markPortalProvenBtn.disabled = true;
  mockDryRunStatus.hidden = false;
  mockDryRunStatus.textContent = "Marking the shared form proven…";
  void (async () => {
    const response = await sendToBackground({
      type: "MARK_PORTAL_PROVEN",
      portalKey: activePortal.key,
    });
    if (!isCurrent(generation)) return;
    if (!response.ok) {
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
