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
import type { FillCoverage, FillReportRecord, FillSummary, ReportedField } from "../shared/fill";
import { sendToBackground, type SearchResults } from "../shared/messages";
import { PREFIX_LABELS, labelForToken, looksLikeIsoDate, tokenPrefix } from "../shared/detailFields";
import { matchPortal, type PortalConfig } from "../shared/portals";
import { matchPortalTasks } from "../shared/submission";
import { API_BASE_URL } from "../shared/config";
import type { ActiveCaseRecord } from "../shared/handoff";
import {
  MAX_LAYOUT_FIELDS,
  QUICK_CARD_FIELD_CATALOG,
  providerWebappPath,
  type QuickCardField,
  type QuickCards,
} from "../shared/quickCards";
import { partitionGaps, providerFixPath, trainFlowPath } from "../shared/fixit";
import {
  STRUCTURED_TOUCH_TYPES,
  TOUCH_DISPOSITIONS,
  validateStructuredTouch,
  type StructuredTouchDraft,
} from "../shared/structuredTouch";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
const signoutBtn = el<HTMLButtonElement>("signout");
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
const providerSection = el<HTMLElement>("provider-section");
const refreshBtn = el<HTMLButtonElement>("refresh");
const providerSelect = el<HTMLSelectElement>("provider-select");
const facilitySelect = el<HTMLSelectElement>("facility-select");
const facilityHint = el<HTMLElement>("facility-hint");
const facilityAddress = el<HTMLElement>("facility-address");
const mainError = el<HTMLElement>("main-error");
const providerCard = el<HTMLElement>("provider-card");
const providerName = el<HTMLElement>("provider-name");
const providerDob = el<HTMLElement>("provider-dob");
const providerIds = el<HTMLElement>("provider-ids");
const openInPanelLink = el<HTMLAnchorElement>("open-in-panel");
const licenseRow = el<HTMLElement>("license-row");
const groupCard = el<HTMLElement>("group-card");
const groupName = el<HTMLElement>("group-name");
const groupIds = el<HTMLElement>("group-ids");
const malpracticeRow = el<HTMLElement>("malpractice-row");
const activeCasesBox = el<HTMLElement>("active-cases");
const activeCasesList = el<HTMLElement>("active-cases-list");
const viewSettingsBtn = el<HTMLButtonElement>("view-settings-btn");
const viewSettings = el<HTMLElement>("view-settings");
const viewSettingsFields = el<HTMLElement>("view-settings-fields");
const viewSettingsError = el<HTMLElement>("view-settings-error");
const viewSettingsSave = el<HTMLButtonElement>("view-settings-save");
const viewSettingsCancel = el<HTMLButtonElement>("view-settings-cancel");
const fillSection = el<HTMLElement>("fill-section");
const caseSelect = el<HTMLSelectElement>("case-select");
const caseStatusPill = el<HTMLElement>("case-status");
const caseNote = el<HTMLElement>("case-note");
const caseContextBox = el<HTMLElement>("case-context");
const portalStatus = el<HTMLElement>("portal-status");
const coveragePanel = el<HTMLElement>("coverage-panel");
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
let portal: PortalConfig | null = null;
let portalTabId: number | null = null;
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
  signoutBtn.hidden = name !== "main";
}

function setError(box: HTMLElement, message: string | null): void {
  box.hidden = message == null;
  box.textContent = message ?? "";
}

function selectedProviderId(): string | null {
  const value = providerSelect.value;
  return UUID_RE.test(value) ? value : null;
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
  return [c.payerName ?? "Unknown payer", c.state, c.status ?? "No status"].join(" - ");
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
  caseStatusPill.className = status == null ? "pill" : `pill ${pillClassFor(status)}`.trim();
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
  providerName.textContent = [
    `${provider.firstName} ${provider.lastName}`,
    provider.credentials,
    provider.specialty,
  ].filter(Boolean).join(", ");
  openInPanelLink.hidden = false;
  openInPanelLink.href = `${API_BASE_URL}${providerWebappPath(provider.id)}`;
}

// E4.3 F4.3.5 — the read-only Quick Cards, projected worker-side from ONE
// audited profile read. Held so the Edit Layout form can pre-check the fields
// the cards currently show. Values are in-memory only.
let currentCards: QuickCards | null = null;

// One ID-grid entry: monospace value with 1-click hover-copy, or an honest
// empty (muted em-dash, plus the profile's unresolved reason as its tooltip).
function idGridEntry(field: QuickCardField): [HTMLElement, HTMLElement] {
  const dt = document.createElement("dt");
  dt.textContent = field.label;
  const dd = document.createElement("dd");
  if (field.value == null || field.value === "") {
    dd.textContent = "—";
    dd.classList.add("id-empty");
    if (field.reason) dd.title = field.reason;
  } else {
    const text = document.createElement("span");
    text.className = "id-value mono";
    text.textContent = looksLikeIsoDate(field.value) ? fmtContextDate(field.value) : field.value;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "id-copy";
    copy.textContent = "Copy";
    copy.setAttribute("aria-label", `Copy ${field.label}`);
    copy.addEventListener("click", () => void copyValue(field.value ?? "", copy));
    dd.append(text, copy);
  }
  return [dt, dd];
}

// A structural row (license / malpractice): label: value triplet line with an
// optional amber expiry badge (< 30 days) or red expired badge. Empty parts
// render as muted em-dashes — never silently dropped.
function structuralRow(
  box: HTMLElement,
  title: string,
  parts: QuickCardField[],
  expiry: "ok" | "expiring" | "expired" | null,
): void {
  box.replaceChildren();
  box.hidden = false;
  const label = document.createElement("span");
  label.className = "qc-struct-label";
  label.textContent = title;
  box.append(label);
  for (const part of parts) {
    const value = document.createElement("span");
    value.className = part.value ? "qc-struct-value mono" : "qc-struct-value id-empty";
    value.textContent = part.value
      ? looksLikeIsoDate(part.value)
        ? fmtContextDate(part.value)
        : part.value
      : "—";
    if (!part.value && part.reason) value.title = part.reason;
    box.append(value);
  }
  if (expiry === "expiring" || expiry === "expired") {
    const badge = document.createElement("span");
    badge.className = expiry === "expired" ? "badge badge-expired" : "badge badge-expiring";
    badge.textContent = expiry === "expired" ? "Expired" : "Expires soon";
    box.append(badge);
  }
}

function renderQuickCards(cards: QuickCards | null): void {
  currentCards = cards;
  // Any cards change (provider switch, refetch) closes the layout form — it
  // must never show one provider's layout over another's card.
  closeViewSettings();
  viewSettingsBtn.hidden = cards == null;
  providerIds.replaceChildren();
  providerIds.hidden = cards == null;
  providerDob.hidden = cards == null;
  providerDob.textContent = "";
  licenseRow.hidden = true;
  groupCard.hidden = true;
  if (cards == null) return;

  // Type 1 header: name + DOB (bold, compact). The profile's name wins over
  // the list row's when present.
  if (cards.name) {
    providerName.textContent = [cards.name, cards.credentials].filter(Boolean).join(", ");
  }
  providerDob.textContent = cards.dateOfBirth
    ? `DOB ${fmtContextDate(cards.dateOfBirth)}`
    : "DOB —";

  for (const field of cards.type1Fields) providerIds.append(...idGridEntry(field));
  structuralRow(
    licenseRow,
    "License",
    [cards.license.state, cards.license.number, cards.license.expiration],
    cards.license.expiry,
  );

  // Type 2: the group card, visually divided from Type 1.
  groupCard.hidden = false;
  groupName.textContent = cards.groupName ?? "No group on file";
  groupName.classList.toggle("id-empty", cards.groupName == null);
  groupIds.replaceChildren();
  groupIds.hidden = cards.type2Fields.length === 0;
  for (const field of cards.type2Fields) groupIds.append(...idGridEntry(field));
  structuralRow(
    malpracticeRow,
    "Malpractice",
    [cards.malpractice.insurer, cards.malpractice.policyNumber, cards.malpractice.expiration],
    cards.malpractice.expiry,
  );
}

function closeViewSettings(): void {
  viewSettings.hidden = true;
  viewSettingsFields.replaceChildren();
  setError(viewSettingsError, null);
  viewSettingsSave.disabled = false;
  viewSettingsSave.textContent = "Save layout";
}

// The Edit Layout form (F4.3.5 3.3): one checkbox per CLOSED-CATALOG field
// (TE-16 — the picker offers nothing the server wouldn't accept; sensitive/
// vault fields are structurally absent from the catalog), grouped by token
// prefix, pre-checked for the current layout. Checkbox DOM order is the saved
// order; the cap is defaults + up to 3 custom (MAX_LAYOUT_FIELDS).
function openViewSettings(cards: QuickCards): void {
  viewSettingsFields.replaceChildren();
  setError(viewSettingsError, null);
  const shown = new Set(cards.layout);
  let group: string | null = null;
  for (const key of QUICK_CARD_FIELD_CATALOG) {
    const prefix = tokenPrefix(key);
    if (prefix !== group) {
      group = prefix;
      const heading = document.createElement("p");
      heading.className = "view-settings-group";
      heading.textContent = PREFIX_LABELS[prefix] ?? prefix;
      viewSettingsFields.append(heading);
    }
    const row = document.createElement("label");
    row.className = "view-settings-field";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = key;
    checkbox.checked = shown.has(key);
    const text = document.createElement("span");
    text.textContent = labelForToken(key);
    row.append(checkbox, text);
    viewSettingsFields.append(row);
  }
  viewSettings.hidden = false;
}

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

// Save the checked fields as the layout (PUT /api/me/view-prefs — server-side,
// so it persists across machines and worker restarts, TS-102), then refetch
// the profile so the cards re-project under the new layout.
viewSettingsSave.addEventListener("click", () => {
  const providerId = selectedProviderId();
  const fields = Array.from(
    viewSettingsFields.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked"),
  ).map((box) => box.value);
  if (fields.length === 0) {
    setError(viewSettingsError, "Pick at least one field to show.");
    return;
  }
  if (fields.length > MAX_LAYOUT_FIELDS) {
    setError(
      viewSettingsError,
      `That's too many fields — the cards show at most ${MAX_LAYOUT_FIELDS} (the defaults plus up to 3 more).`,
    );
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
    if (providerId) await loadFacilities(providerId, generation);
  })();
});

// Copy a single identifier to the clipboard, with brief "Copied" feedback.
// Best-effort: a clipboard permission denial just leaves the label unchanged.
async function copyValue(value: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = "Copied";
    button.classList.add("copied");
    window.setTimeout(() => {
      button.textContent = "Copy";
      button.classList.remove("copied");
    }, 1200);
  } catch {
    // clipboard blocked — leave the button as-is
  }
}

// Story 11: the selected case's latest touchlog note, shown under the case
// picker. Hidden when no case is selected or the case has no note.
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

// "Jul 5, 2026" for a case-context note/touch timestamp; "" for a missing or
// unparseable value so the meta line just drops rather than showing "Invalid
// Date".
function fmtContextDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function contextRow(label: string): { row: HTMLDivElement; labelEl: HTMLSpanElement } {
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
  extension_fill: "Extension fill",
  auto_verify: "Auto verify",
  document_attach: "Document attach",
};

// F4.3.1 identity guard: the strip under the header always names the org the
// panel operates as, plus — once a case is active — the provider, payer/state,
// and selected facility. A multi-org user can never be silently filling from
// the wrong org or case.
function renderIdentityGuard(): void {
  const parts: string[] = [];
  const org = orgs.length === 1 ? orgs[0] : (orgs.find((o) => o.orgId === activeOrgId) ?? null);
  if (org) parts.push(orgLabel(org));
  const caseId = selectedCaseId();
  const context = caseId != null ? caseContextData : null;
  if (context != null) {
    if (context.provider?.name) parts.push(context.provider.name);
    const payerState = [context.payer?.name, context.state].filter(Boolean).join(" · ");
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
// picked; the needs-facility gate resolves with it.
function maybeApplyCaseFacility(): void {
  const facility = caseContextData?.selectedFacility ?? null;
  if (facility == null || !facilitiesLoaded) return;
  if (selectedFacilityId() != null) return;
  if (!facilities.some((f) => f.id === facility.id)) return;
  facilitySelect.value = facility.id;
  const providerId = selectedProviderId();
  if (providerId) {
    void sendToBackground({ type: "SET_SELECTED_FACILITY", providerId, facilityId: facility.id });
  }
  renderFacilityAddress();
  updateFillReady();
}

// Epic 3d + E4.3 TE-2: render the selected case's workbench context — identity
// (provider/payer/state), pipeline state, tracking ID, open SOP tasks with
// execution types, latest note and touch — as a read-only card. A null
// argument (no case, an error, or nothing to show) hides the block. Purely
// informational — it never gates the fill/submit flow, and nothing here is
// persisted beyond this render.
function renderCaseContext(context: CaseContext | null): void {
  caseContextData = context;
  caseContextBox.replaceChildren();
  const refs = context?.referenceNumbers ?? [];
  const note = context?.latestNote ?? null;
  const touch = context?.latestTouch ?? null;
  const tasks = context?.openTasks ?? [];
  const pipeline = context?.payerPipelineState ?? null;
  const hasContent =
    refs.length > 0 || note != null || touch != null || tasks.length > 0 || pipeline != null;
  caseContextBox.hidden = context == null || !hasContent;
  renderIdentityGuard();
  if (context == null || !hasContent) return;
  maybeApplyCaseFacility();

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
    const { row } = contextRow(refs.length === 1 ? "Tracking ID" : "Tracking IDs");
    const value = document.createElement("span");
    value.className = "case-context-ref-value mono";
    value.textContent = refs.join(", ");
    row.append(value);
    caseContextBox.append(row);
  }

  // Open SOP tasks with execution types (E4.2 tee-up). Read-only in R6 —
  // marking a task done stays in the webapp.
  if (tasks.length > 0) {
    const { row } = contextRow(`Open tasks (${tasks.length})`);
    const list = document.createElement("ul");
    list.className = "case-task-list";
    for (const task of tasks) {
      const item = document.createElement("li");
      const title = document.createElement("span");
      title.className = "case-task-title";
      title.textContent = task.title;
      const chip = document.createElement("span");
      const isFill = task.executionType === "extension_fill";
      chip.className = isFill ? "exec-chip exec-chip-fill" : "exec-chip";
      chip.textContent = EXECUTION_TYPE_LABELS[task.executionType] ?? task.executionType;
      item.append(title, chip);
      if (task.dueDate) {
        const due = document.createElement("span");
        due.className = "case-task-due";
        due.textContent = `due ${fmtContextDate(task.dueDate)}`;
        item.append(due);
      }
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
    const response = await sendToBackground({ type: "GET_CASE_CONTEXT", caseId });
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
function recentSubmissionPhrase(caseItem: CaseListItem | undefined): string | null {
  if (!caseItem?.lastSubmittedAt) return null;
  const at = new Date(caseItem.lastSubmittedAt);
  if (Number.isNaN(at.getTime())) return null;
  const days = (Date.now() - at.getTime()) / 86_400_000;
  if (days > DUPLICATE_WINDOW_DAYS || days < 0) return null;
  if (days < 1) return "earlier today";
  const whole = Math.round(days);
  return whole === 1 ? "yesterday" : `${whole} days ago`;
}

function renderProviderOptions(selectedId: string | null): void {
  providerSelect.replaceChildren();
  const placeholder = new Option(
    providers.length ? "Select a provider…" : "No providers found",
    "",
    true,
    selectedId == null,
  );
  placeholder.disabled = providers.length > 0;
  providerSelect.add(placeholder);
  for (const p of providers) {
    providerSelect.add(new Option(providerLabel(p), p.id, false, p.id === selectedId));
  }
  providerSelect.disabled = providers.length === 0;
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
    activeCaseStatus === "expired" && activeCase != null && activeCase.caseId === selectedCaseId();
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
  const portalOpen = portal != null && portalTabId != null;
  portalStatus.textContent = portalOpen
    ? `${portal?.label} form detected in the current tab.`
    : "Open the BCBS KS enrollment form in the current tab to fill it.";
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
function coverageSelectionKey(): string | null {
  if (!isFillReady()) return null;
  return [selectedProviderId(), selectedFacilityId() ?? "none", portal?.key ?? "", portal?.state ?? ""].join(
    "|",
  );
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
      state: activePortal.state,
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

// "9:42 PM" today, "Jul 5, 9:42 PM" on any other day — a restored report is
// always labeled with when it ran so it can't pass for a fresh one.
function fmtReportTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "an earlier session";
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === new Date().toDateString()
    ? time
    : `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
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
  if (restored) fillReportTime.textContent = `Fill report from ${fmtReportTime(restored.completedAt)}.`;
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

async function loadCases(providerId: string, generation: number): Promise<void> {
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
  const remembered = await sendToBackground({ type: "GET_SELECTED_CASE", providerId });
  if (!isCurrent(generation)) return;
  const rememberedId =
    remembered.ok && cases.some((c) => c.id === remembered.data) ? remembered.data : null;
  // A remembered case that no longer exists (closed, or another org's) is
  // dropped silently — from storage too, not just the dropdown.
  if (remembered.ok && remembered.data != null && rememberedId == null) {
    void sendToBackground({ type: "SET_SELECTED_CASE", providerId, caseId: null });
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
    caseSelect.add(new Option(caseLabel(c), c.id, false, c.id === rememberedId));
  }
  caseSelect.disabled = cases.length === 0;
  renderCaseStatusPill();
  renderCaseNote();
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
  if (selectedCase == null) return;
  const response = await sendToBackground({ type: "GET_FILL_REPORT", providerId });
  if (!isCurrent(generation)) return;
  if (!response.ok || response.data == null) return;
  const record: FillReportRecord = response.data;
  if (record.caseId !== selectedCase) return;
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
  const facility = facilities.find((f) => f.id === selectedFacilityId()) ?? null;
  const street = [facility?.street, facility?.suite].filter(Boolean).join(", ");
  const locality = [facility?.city, [facility?.state, facility?.zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  const lines = [street, locality].filter(Boolean);
  facilityAddress.hidden = lines.length === 0;
  facilityAddress.replaceChildren();
  for (const line of lines) {
    const row = document.createElement("div");
    row.textContent = line;
    facilityAddress.append(row);
  }
}

// The provider's facility set, from the profile response. Exactly one:
// auto-selected read-only (the server resolves it the same way). Several:
// the user picks, remembered per provider and re-validated silently.
async function loadFacilities(providerId: string, generation: number): Promise<void> {
  facilities = [];
  facilitiesLoaded = false;
  needsFacility = false;
  facilitySelect.disabled = true;
  facilitySelect.replaceChildren(new Option("Loading locations…", ""));
  renderFacilityAddress();
  updateFillReady();

  const response = await sendToBackground({ type: "GET_PROVIDER_FACILITIES", providerId });
  // A newer provider/org selection superseded this load — discard silently.
  if (!isCurrent(generation)) return;
  if (!response.ok) {
    facilitySelect.replaceChildren(new Option("Unavailable", ""));
    setError(mainError, response.error);
    updateFillReady(); // facilitiesLoaded stays false — gate stays closed
    return;
  }
  facilities = response.data.facilities;
  needsFacility = response.data.needsFacility;
  facilitiesLoaded = true;
  // The quick cards ride on the same (single, audited) profile fetch as the
  // facility set.
  renderQuickCards(response.data.cards);

  if (facilities.length === 0) {
    // Nothing to resolve: facility tokens come back unresolved with a
    // reason, which is correct — not a fill blocker.
    facilitySelect.replaceChildren(new Option("No locations on file", ""));
    updateFillReady();
    return;
  }

  const sole = facilities.length === 1 ? facilities[0] : undefined;
  if (sole) {
    facilitySelect.replaceChildren(new Option(sole.name || "Location", sole.id, true, true));
    renderFacilityAddress();
    renderIdentityGuard();
    updateFillReady();
    return;
  }

  const remembered = await sendToBackground({ type: "GET_SELECTED_FACILITY", providerId });
  if (!isCurrent(generation)) return;
  const rememberedId =
    remembered.ok && facilities.some((f) => f.id === remembered.data) ? remembered.data : null;
  if (remembered.ok && remembered.data != null && rememberedId == null) {
    void sendToBackground({ type: "SET_SELECTED_FACILITY", providerId, facilityId: null });
  }
  facilitySelect.replaceChildren();
  const placeholder = new Option("Select a location…", "", true, rememberedId == null);
  placeholder.disabled = true;
  facilitySelect.add(placeholder);
  for (const facility of facilities) {
    facilitySelect.add(new Option(facility.name || facility.id, facility.id, false, facility.id === rememberedId));
  }
  facilitySelect.disabled = false;
  renderFacilityAddress();
  // E4.3: the case's explicit facility (from the context read) resolves the
  // pick when the user hasn't chosen one — the case selected it, not a guess.
  maybeApplyCaseFacility();
  renderIdentityGuard();
  updateFillReady();
}

async function loadProviders(generation: number): Promise<void> {
  setError(mainError, null);
  clearFillResults();
  providerSelect.disabled = true;
  providerSelect.replaceChildren(new Option("Loading providers…", ""));
  renderProviderCard(null);

  const response = await sendToBackground({ type: "LIST_PROVIDERS" });
  // A newer org switch / refresh superseded this load — discard silently.
  if (!isCurrent(generation)) return;
  if (!response.ok) {
    providerSelect.replaceChildren(new Option("Unavailable", ""));
    setError(mainError, response.error);
    return;
  }
  providers = response.data;

  const selected = await sendToBackground({ type: "GET_SELECTED_PROVIDER" });
  if (!isCurrent(generation)) return;
  const selectedId =
    selected.ok && providers.some((p) => p.id === selected.data) ? selected.data : null;
  // A remembered provider that isn't in the current org's list anymore is
  // dropped silently — from storage too, not just the dropdown.
  if (selected.ok && selected.data != null && selectedId == null) {
    void sendToBackground({ type: "SET_SELECTED_PROVIDER", providerId: null });
  }
  renderProviderOptions(selectedId);
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
  orgSelect.disabled = true;
  orgSelect.replaceChildren(new Option("Loading organizations…", ""));
  providerSection.hidden = true;
  // F4.3.5: search operates under an EXPLICIT org — hidden until one resolves
  // (the identity-guard rule applies to standalone mode too).
  searchSection.hidden = true;
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
    orgSelect.replaceChildren(new Option(orgLabel(sole), sole.orgId, true, true));
    providerSection.hidden = false;
    searchSection.hidden = false;
    renderIdentityGuard();
    await loadProviders(generation);
    return;
  }

  const stored = await sendToBackground({ type: "GET_ACTIVE_ORG" });
  if (!isCurrent(generation)) return;
  const storedId = stored.ok && orgs.some((o) => o.orgId === stored.data) ? stored.data : null;
  if (stored.ok && stored.data != null && storedId == null) {
    // Membership to the remembered org is gone: drop silently (the worker
    // clears that org's dependent state too).
    await sendToBackground({ type: "SET_ACTIVE_ORG", orgId: null });
    if (!isCurrent(generation)) return;
  }
  activeOrgId = storedId;
  orgSelect.replaceChildren();
  const placeholder = new Option("Select an organization…", "", true, storedId == null);
  placeholder.disabled = true;
  orgSelect.add(placeholder);
  for (const org of orgs) {
    orgSelect.add(new Option(orgLabel(org), org.orgId, false, org.orgId === storedId));
  }
  orgSelect.disabled = false;
  renderIdentityGuard();
  if (activeOrgId != null) {
    providerSection.hidden = false;
    searchSection.hidden = false;
    await loadProviders(generation);
  } else {
    updateFillReady();
  }
}

// The active tab in the panel's window. Its url is visible to us only for
// origins we hold host permissions on (the portals) — for every other page
// it comes back undefined, which matchPortal already treats as "no portal".
async function queryActiveTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  } catch {
    return null;
  }
}

async function detectPortal(): Promise<void> {
  const tab = await queryActiveTab();
  portal = matchPortal(tab?.url);
  portalTabId = portal != null && tab?.id != null ? tab.id : null;
  updateFillReady();
}

// The panel reflects the ACTIVE tab: re-detect on tab switch and on
// navigation in the active tab (a fill result stays on screen — the user
// hops to the portal tab to submit, then comes back for Mark submitted).
chrome.tabs.onActivated.addListener(() => void detectPortal());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active && (changeInfo.url != null || changeInfo.status === "complete")) {
    void detectPortal();
  }
});

function showMain(email: string | null): void {
  accountEmail.textContent = email ? `Signed in as ${email}` : "Signed in";
  showView("main");
  // Fresh context: this restore load (and every loader it chains into) runs
  // under one generation so it populates uninterrupted. The handoff check
  // runs AFTER orgs load — the org validation needs the membership list.
  void loadOrgs(bumpGeneration()).then(() => refreshActiveCase());
  void detectPortal();
}

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
    showMain(response.data.email);
  })();
});

signoutBtn.addEventListener("click", () => {
  // Invalidate any in-flight loader so a late response can't render into the
  // now-hidden main view after sign-out.
  bumpGeneration();
  void (async () => {
    await sendToBackground({ type: "SIGN_OUT" });
    orgs = [];
    activeOrgId = null;
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

refreshBtn.addEventListener("click", () => void loadProviders(bumpGeneration()));

orgSelect.addEventListener("change", () => {
  const orgId = orgSelect.value || null;
  if (orgId == null || orgId === activeOrgId) return;
  // Bump synchronously so any in-flight loader for the previous org is
  // invalidated the instant the switch happens.
  const generation = bumpGeneration();
  void (async () => {
    activeOrgId = orgId;
    // The worker wipes provider/case/facility/report state — including any
    // active-case context — before storing the new org; every call from here
    // on carries x-org-id.
    await sendToBackground({ type: "SET_ACTIVE_ORG", orgId });
    if (!isCurrent(generation)) return;
    clearFillResults();
    hideSearchResults();
    providerSection.hidden = false;
    searchSection.hidden = false;
    renderIdentityGuard();
    await loadProviders(generation);
    // A handoff pending for THIS org can now apply (the switch prompt's path).
    await refreshActiveCase();
  })();
});

providerSelect.addEventListener("change", () => {
  const id = selectedProviderId();
  // Bump synchronously so a slower in-flight case/facility load for the
  // previous provider discards itself instead of rendering under this one.
  const generation = bumpGeneration();
  void sendToBackground({ type: "SET_SELECTED_PROVIDER", providerId: id });
  renderProviderCard(providers.find((p) => p.id === id) ?? null);
  if (id) {
    void loadCases(id, generation);
    void loadFacilities(id, generation);
  }
});

facilitySelect.addEventListener("change", () => {
  const providerId = selectedProviderId();
  if (providerId) {
    void sendToBackground({
      type: "SET_SELECTED_FACILITY",
      providerId,
      facilityId: selectedFacilityId(),
    });
  }
  renderFacilityAddress();
  renderIdentityGuard();
  updateFillReady();
});

// The one case-selection routine every entry path funnels into: the manual
// dropdown, the active-cases rows, search case results, the NBA handback, and
// the handoff apply. A USER-initiated choice also enters the worker's
// active-case state (TE-17 — same record and expiry semantics as a handoff);
// the handoff apply passes recordEntry=false so it never overwrites the
// handoff record it is applying.
function applyCaseChoice(caseId: string | null, recordEntry: boolean): void {
  const providerId = selectedProviderId();
  if (providerId) {
    void sendToBackground({ type: "SET_SELECTED_CASE", providerId, caseId });
    if (recordEntry && caseId != null) {
      void (async () => {
        await sendToBackground({ type: "ENTER_ACTIVE_CASE", caseId, providerId, orgId: activeOrgId });
        // Entering a case supersedes any expired/previous context — re-read so
        // the banner and gates reflect the fresh record.
        await refreshActiveCase(false);
      })();
    }
  }
  renderCaseStatusPill();
  renderCaseNote();
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
    const clickPortal = matchPortal(tab?.url);
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
      state: clickPortal.state,
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
    if (phrase != null) {
      dupConfirmPending = true;
      dupWarn.hidden = false;
      dupWarn.textContent = `This case was marked submitted ${phrase}. Log another submission?`;
      markSubmittedBtn.textContent = "Log anyway";
      return;
    }
  }

  const buttonLabel = dupConfirmPending ? "Log anyway" : "Mark submitted";
  // Capture the task to close BEFORE the async work: a successful submit refetches
  // cases (mutating matchingPortalTasks), so read the id + title now.
  const closedTaskId = selectedTaskId;
  const closedTaskTitle = closedTaskId
    ? (matchingPortalTasks().find((t) => t.taskId === closedTaskId)?.title ?? null)
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
    });
    if (!response.ok) {
      // A 404 here can now also mean a cross-org/invalid task_id — surface the
      // server's message as-is and let the human retry. Never auto-retry with
      // the task stripped.
      markSubmittedBtn.disabled = false;
      markSubmittedBtn.textContent = buttonLabel;
      setError(mainError, response.error);
      return;
    }
    dupConfirmPending = false;
    dupWarn.hidden = true;
    submitDetails.hidden = true;
    taskLink.hidden = true;
    selectedTaskId = null;
    submitHint.hidden = true;
    markSubmittedBtn.hidden = true;
    submitStatus.hidden = false;
    submitStatus.textContent = closedTaskTitle
      ? `Logged to the case. Task closed: ${closedTaskTitle}`
      : "Logged to the case.";
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

function renderActiveCases(): void {
  const providerId = selectedProviderId();
  const show = providerId != null && cases.length > 0;
  activeCasesBox.hidden = !show;
  activeCasesList.replaceChildren();
  if (!show) return;
  const selected = selectedCaseId();
  for (const c of cases) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = c.id === selected ? "case-row case-row-selected" : "case-row";
    const title = document.createElement("span");
    title.className = "case-row-title";
    title.textContent = `${c.payerName ?? "Unknown payer"} · ${c.state}`;
    row.append(title);
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
async function selectProviderInPanel(provider: ProviderListItem): Promise<void> {
  const generation = bumpGeneration();
  if (!providers.some((p) => p.id === provider.id)) providers.push(provider);
  await sendToBackground({ type: "SET_SELECTED_PROVIDER", providerId: provider.id });
  if (!isCurrent(generation)) return;
  renderProviderOptions(provider.id);
  renderProviderCard(providers.find((p) => p.id === provider.id) ?? null);
  await Promise.all([loadCases(provider.id, generation), loadFacilities(provider.id, generation)]);
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
): Promise<void> {
  const generation = bumpGeneration();
  await sendToBackground({ type: "SET_SELECTED_PROVIDER", providerId });
  await sendToBackground({ type: "SET_SELECTED_CASE", providerId, caseId });
  if (recordEntry) {
    await sendToBackground({ type: "ENTER_ACTIVE_CASE", caseId, providerId, orgId: activeOrgId });
  }
  if (!isCurrent(generation)) return;
  resetTouchForm();
  if (!providers.some((p) => p.id === providerId)) {
    const response = await sendToBackground({ type: "LIST_PROVIDERS" });
    if (!isCurrent(generation)) return;
    if (response.ok) providers = response.data;
  }
  renderProviderOptions(providerId);
  renderProviderCard(providers.find((p) => p.id === providerId) ?? null);
  await Promise.all([loadCases(providerId, generation), loadFacilities(providerId, generation)]);
  if (recordEntry && isCurrent(generation)) await refreshActiveCase(false);
}

function renderSearchResults(data: SearchResults): void {
  searchResults.replaceChildren();
  searchResults.hidden = false;

  searchResults.append(searchGroupHeading("Cases"));
  if (data.casesError != null) {
    searchResults.append(searchEmptyLine(`Case search unavailable: ${data.casesError}`));
  } else if (data.cases.length === 0) {
    searchResults.append(searchEmptyLine("No matching cases."));
  } else {
    for (const row of data.cases) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "search-row";
      const title = document.createElement("span");
      title.className = "search-row-title";
      title.textContent = `${row.providerName || "Unknown provider"} — ${row.payerName ?? "Unknown payer"} · ${row.state}`;
      button.append(title);
      const meta = document.createElement("span");
      meta.className = "search-row-meta";
      meta.textContent = [row.status, row.payerReferenceId].filter(Boolean).join(" · ");
      if (meta.textContent) button.append(meta);
      button.addEventListener("click", () => {
        hideSearchResults();
        searchInput.value = "";
        void selectCaseInPanel(row.providerId, row.id, true);
      });
      searchResults.append(button);
    }
  }

  searchResults.append(searchGroupHeading("Providers"));
  if (data.providersError != null) {
    searchResults.append(searchEmptyLine(`Provider search unavailable: ${data.providersError}`));
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
      if (p.npi) {
        const meta = document.createElement("span");
        meta.className = "search-row-meta mono";
        meta.textContent = p.npi;
        button.append(meta);
      }
      button.addEventListener("click", () => {
        hideSearchResults();
        searchInput.value = "";
        void selectProviderInPanel(p);
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
  renderSearchResults(response.data);
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
    const resolvedOrg = orgs.length === 1 ? (orgs[0]?.orgId ?? null) : activeOrgId;
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
  orgSelect.value = target;
  await sendToBackground({ type: "SET_ACTIVE_ORG", orgId: target });
  if (!isCurrent(generation)) return;
  clearFillResults();
  hideSearchResults();
  providerSection.hidden = false;
  searchSection.hidden = false;
  renderIdentityGuard();
  await selectCaseInPanel(record.providerId, record.caseId, true);
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
    const resolvedOrg = orgs.length === 1 ? (orgs[0]?.orgId ?? null) : activeOrgId;
    if (resolvedOrg !== record.orgId) {
      // Member, but the panel is operating as a different org (or none yet):
      // the banner prompts the explicit switch. Nothing is applied.
      renderHandoffBanner();
      return;
    }
  }

  appliedHandoffKey = key;
  await selectCaseInPanel(record.providerId, record.caseId, false);
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
  if (applyHandoff && state.status === "active" && state.record.source === "handoff") {
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
  for (const t of STRUCTURED_TOUCH_TYPES) touchType.add(new Option(t.label, t.value));
  touchOutcome.replaceChildren();
  touchOutcome.add(new Option("None", "", true, true));
  for (const d of TOUCH_DISPOSITIONS) touchOutcome.add(new Option(d.label, d.value));
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
    deadline.className = item.deadline.overdue ? "nba-deadline overdue" : "nba-deadline";
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
      void selectCaseInPanel(item.providerId, item.caseId, true);
    });
    actions.append(work);
  }
  actions.append(nbaLink("Open in Minted Panel ↗", `${API_BASE_URL}${item.deepLink}`));
  card.append(actions);
  nbaSection.append(card);
}

void (async () => {
  const response = await sendToBackground({ type: "GET_AUTH_STATE" });
  if (response.ok && response.data.signedIn) {
    showMain(response.data.email);
  } else {
    showSignin();
  }
})();
