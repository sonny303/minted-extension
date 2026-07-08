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
  ProviderListItem,
  ProviderProfileFacility,
  UserOrgMembership,
} from "../shared/apiTypes";
import type { FillCoverage, FillReportRecord, FillSummary, ReportedField } from "../shared/fill";
import { sendToBackground, type ProviderIdentifiers } from "../shared/messages";
import { matchPortal, type PortalConfig } from "../shared/portals";

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
const accountEmail = el<HTMLElement>("account-email");
const orgSelect = el<HTMLSelectElement>("org-select");
const providerSection = el<HTMLElement>("provider-section");
const refreshBtn = el<HTMLButtonElement>("refresh");
const providerSelect = el<HTMLSelectElement>("provider-select");
const facilitySelect = el<HTMLSelectElement>("facility-select");
const facilityHint = el<HTMLElement>("facility-hint");
const mainError = el<HTMLElement>("main-error");
const providerCard = el<HTMLElement>("provider-card");
const providerName = el<HTMLElement>("provider-name");
const providerNpi = el<HTMLElement>("provider-npi");
const providerMeta = el<HTMLElement>("provider-meta");
const providerIds = el<HTMLElement>("provider-ids");
const fillSection = el<HTMLElement>("fill-section");
const caseSelect = el<HTMLSelectElement>("case-select");
const caseStatusPill = el<HTMLElement>("case-status");
const caseNote = el<HTMLElement>("case-note");
const caseContextBox = el<HTMLElement>("case-context");
const portalStatus = el<HTMLElement>("portal-status");
const coveragePanel = el<HTMLElement>("coverage-panel");
const coverageCount = el<HTMLElement>("coverage-count");
const coverageGaps = el<HTMLUListElement>("coverage-gaps");
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
  return p.npi ? `${name} — ${p.npi}` : name;
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
  // Identifiers arrive with the profile (loadFacilities), a beat after the card;
  // clear them here so a switch never shows the previous provider's ids.
  renderIdentifiers(null);
  if (!provider) return;
  const credentials = provider.credentials ? `, ${provider.credentials}` : "";
  providerName.textContent = `${provider.firstName} ${provider.lastName}${credentials}`;
  providerNpi.textContent = provider.npi ? `NPI ${provider.npi}` : "No NPI on file";
  providerMeta.textContent = [provider.specialty, provider.status].filter(Boolean).join(" · ");
}

// Story 4: the provider's key identifiers as a copy-able grid on the card. A
// missing value renders greyed ("—") with no copy button. Values are never
// logged; the copy button writes the raw value to the clipboard only.
const IDENTIFIER_ROWS: Array<{ key: keyof ProviderIdentifiers; label: string }> = [
  { key: "npi", label: "NPI" },
  { key: "license", label: "License #" },
  { key: "caqh", label: "CAQH ID" },
  { key: "tin", label: "TIN / EIN" },
  { key: "dea", label: "DEA" },
];

function renderIdentifiers(ids: ProviderIdentifiers | null): void {
  providerIds.replaceChildren();
  providerIds.hidden = ids == null;
  if (ids == null) return;
  for (const { key, label } of IDENTIFIER_ROWS) {
    const value = ids[key];
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    if (value == null) {
      dd.textContent = "—";
      dd.classList.add("id-empty");
    } else {
      const text = document.createElement("span");
      text.className = "id-value";
      text.textContent = value;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "id-copy";
      copy.textContent = "Copy";
      copy.setAttribute("aria-label", `Copy ${label}`);
      copy.addEventListener("click", () => void copyValue(value, copy));
      dd.append(text, copy);
    }
    providerIds.append(dt, dd);
  }
}

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

// Epic 3d: render the selected case's reference number(s), latest note, and
// latest touch as a small read-only card. A null argument (no case, an error,
// or nothing to show) hides the block. Purely informational — it never gates
// the fill/submit flow, and nothing here is persisted beyond this render.
function renderCaseContext(context: CaseContext | null): void {
  caseContextBox.replaceChildren();
  const refs = context?.referenceNumbers ?? [];
  const note = context?.latestNote ?? null;
  const touch = context?.latestTouch ?? null;
  const hasContent = refs.length > 0 || note != null || touch != null;
  caseContextBox.hidden = context == null || !hasContent;
  if (context == null || !hasContent) return;

  // Reference id(s): hidden entirely when the case carries none.
  if (refs.length > 0) {
    const { row } = contextRow(refs.length === 1 ? "Reference" : "References");
    const value = document.createElement("span");
    value.className = "case-context-ref-value";
    value.textContent = refs.join(", ");
    row.append(value);
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
    const date = fmtContextDate(touch.touchDate);
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
// against the case backing the fill (lastFill), not whatever is selected now,
// so the offered task always belongs to what was actually filled. Keys are
// compared case-insensitively (both sides are already normalized bare/lowercase,
// so this is belt-and-suspenders).
function matchingPortalTasks(): CasePortalTask[] {
  const context = lastFill;
  if (!context || portal == null) return [];
  const caseItem = cases.find((c) => c.id === context.caseId);
  const key = portal.key.toLowerCase();
  return (caseItem?.portalTasks ?? []).filter((t) => t.portalKey.toLowerCase() === key);
}

// Render the "close a task" affordance and set selectedTaskId. Zero matches →
// hidden, no task closed (today's behavior). One → auto-selected, shown as
// "Will close task: <title>". Several → a dropdown defaulting to the first, with
// a "Don't close a task" escape. Never blocks or changes the submit itself.
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
  taskSelect.add(new Option("Don't close a task", ""));
  for (const t of matches) taskSelect.add(new Option(t.title, t.taskId));
  taskSelect.selectedIndex = 1; // default to the first matching task
  selectedTaskId = first.taskId;
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
  return Boolean(
    portalOpen &&
      orgResolved() &&
      selectedProviderId() &&
      facilitiesLoaded &&
      !facilityBlocked &&
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

// "Can fill M of N mapped fields." plus one row per gap (label + reason). A null
// argument hides the panel. The gap list is empty (and CSS-collapsed) at full
// coverage. Read-only — no field values are shown, only labels and reasons.
function renderCoverage(coverage: FillCoverage | null): void {
  coveragePanel.hidden = coverage == null;
  if (coverage == null) {
    coverageGaps.replaceChildren();
    return;
  }
  const noun = coverage.total === 1 ? "field" : "fields";
  coverageCount.textContent = `Can fill ${coverage.available} of ${coverage.total} mapped ${noun}.`;
  coverageGaps.replaceChildren();
  for (const gap of coverage.gaps) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "coverage-gap-label";
    label.textContent = gap.label;
    const reason = document.createElement("span");
    reason.className = "coverage-gap-reason";
    reason.textContent = gap.reason;
    li.append(label, reason);
    coverageGaps.append(li);
  }
}

// A report bucket: a collapsible <details> with the heading, an optional
// count pill, and the field rows — same data and wording as before, redressed
// per the design's fill-report card.
function bucketDetails(heading: string, count: number | null, rows: string[]): HTMLDetailsElement {
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
      item.textContent = row;
      list.append(item);
    }
    details.append(list);
  }
  return details;
}

function fieldList(box: HTMLElement, heading: string, fields: ReportedField[]): void {
  box.hidden = fields.length === 0;
  if (!fields.length) return;
  box.replaceChildren(
    bucketDetails(
      heading,
      fields.length,
      fields.map((field) => `${field.label} — ${field.reason}`),
    ),
  );
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
  // LABELS from the page result — values are never retained (PHI).
  fillSummaryBox.replaceChildren(
    bucketDetails(`Filled ${summary.filled} of ${attempted} mapped fields.`, null, summary.filledLabels),
  );
  fieldList(fillSkippedBox, "Not filled:", summary.skipped);
  fieldList(fillManualBox, "Needs manual entry or review:", summary.manual);
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
      `${gapCount} mapped ${gapCount === 1 ? "field has" : "fields have"} no value yet — ` +
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

// The provider's facility set, from the profile response. Exactly one:
// auto-selected read-only (the server resolves it the same way). Several:
// the user picks, remembered per provider and re-validated silently.
async function loadFacilities(providerId: string, generation: number): Promise<void> {
  facilities = [];
  facilitiesLoaded = false;
  needsFacility = false;
  facilitySelect.disabled = true;
  facilitySelect.replaceChildren(new Option("Loading locations…", ""));
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
  // Story 4: the identifiers ride on the same profile fetch as the facilities.
  renderIdentifiers(response.data.identifiers);

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
  renderProviderCard(null);
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
  if (activeOrgId != null) {
    providerSection.hidden = false;
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
  // under one generation so it populates uninterrupted.
  void loadOrgs(bumpGeneration());
  void detectPortal();
}

function showSignin(): void {
  signinForm.reset();
  setError(signinError, null);
  showView("signin");
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
    // The worker wipes provider/case/facility/report state before storing
    // the new org; every call from here on carries x-org-id.
    await sendToBackground({ type: "SET_ACTIVE_ORG", orgId });
    if (!isCurrent(generation)) return;
    clearFillResults();
    providerSection.hidden = false;
    await loadProviders(generation);
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
  updateFillReady();
});

caseSelect.addEventListener("change", () => {
  const providerId = selectedProviderId();
  if (providerId) {
    void sendToBackground({
      type: "SET_SELECTED_CASE",
      providerId,
      caseId: caseSelect.value || null,
    });
  }
  renderCaseStatusPill();
  renderCaseNote();
  refreshCaseContext();
  clearFillResults();
  updateFillReady();
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
        "The enrollment form is no longer the active tab — switch back to it and try again.",
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
      taskId: selectedTaskId,
    });
    if (!response.ok) {
      markSubmittedBtn.disabled = false;
      markSubmittedBtn.textContent = buttonLabel;
      setError(mainError, response.error);
      return;
    }
    dupConfirmPending = false;
    dupWarn.hidden = true;
    submitDetails.hidden = true;
    taskLink.hidden = true;
    submitHint.hidden = true;
    markSubmittedBtn.hidden = true;
    submitStatus.hidden = false;
    submitStatus.textContent = selectedTaskId
      ? "Logged to the case. SOP task marked done."
      : "Logged to the case.";
  })();
});

void (async () => {
  const response = await sendToBackground({ type: "GET_AUTH_STATE" });
  if (response.ok && response.data.signedIn) {
    showMain(response.data.email);
  } else {
    showSignin();
  }
})();
