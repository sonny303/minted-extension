// Side panel UI: sign in, pick a provider and case, fill the open portal
// page. All auth and API work happens in the background worker; this file
// only renders state and sends typed messages. Unlike the old popup, the
// panel stays open across tab switches, so portal detection follows the
// active tab and the fill re-checks the tab's URL at click time.
import "./sidepanel.css";
import type { CaseListItem, ProviderListItem } from "../shared/apiTypes";
import type { FillSummary, ReportedField } from "../shared/fill";
import { sendToBackground } from "../shared/messages";
import { matchPortal, type PortalConfig } from "../shared/portals";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
const refreshBtn = el<HTMLButtonElement>("refresh");
const providerSelect = el<HTMLSelectElement>("provider-select");
const mainError = el<HTMLElement>("main-error");
const providerCard = el<HTMLElement>("provider-card");
const providerName = el<HTMLElement>("provider-name");
const providerNpi = el<HTMLElement>("provider-npi");
const providerMeta = el<HTMLElement>("provider-meta");
const fillSection = el<HTMLElement>("fill-section");
const caseSelect = el<HTMLSelectElement>("case-select");
const portalStatus = el<HTMLElement>("portal-status");
const fillBtn = el<HTMLButtonElement>("fill-btn");
const fillResults = el<HTMLElement>("fill-results");
const fillSummaryBox = el<HTMLElement>("fill-summary");
const fillSkippedBox = el<HTMLElement>("fill-skipped");
const fillManualBox = el<HTMLElement>("fill-manual");
const fillEventWarn = el<HTMLElement>("fill-event-warn");
const submitHint = el<HTMLElement>("submit-hint");
const markSubmittedBtn = el<HTMLButtonElement>("mark-submitted");
const submitStatus = el<HTMLElement>("submit-status");

// The last successful fill, held so "Mark submitted" can log the touch
// against the right case and fill session. Cleared whenever the selection
// changes or a new fill starts.
interface LastFill {
  caseId: string;
  portalKey: string;
  fillSessionId: string | null;
}

let providers: ProviderListItem[] = [];
let cases: CaseListItem[] = [];
let portal: PortalConfig | null = null;
let portalTabId: number | null = null;
let lastFill: LastFill | null = null;

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
  return providerSelect.value || null;
}

function selectedCaseId(): string | null {
  const value = caseSelect.value;
  return UUID_RE.test(value) ? value : null;
}

function providerLabel(p: ProviderListItem): string {
  const name = `${p.lastName}, ${p.firstName}`;
  return p.npi ? `${name} — ${p.npi}` : name;
}

// The locked dropdown wording: "<payer> - <state> - <status>".
function caseLabel(c: CaseListItem): string {
  return [c.payerName ?? "Unknown payer", c.state, c.status ?? "No status"].join(" - ");
}

function renderProviderCard(provider: ProviderListItem | null): void {
  providerCard.hidden = provider == null;
  fillSection.hidden = provider == null;
  if (!provider) return;
  const credentials = provider.credentials ? `, ${provider.credentials}` : "";
  providerName.textContent = `${provider.firstName} ${provider.lastName}${credentials}`;
  providerNpi.textContent = provider.npi ? `NPI ${provider.npi}` : "No NPI on file";
  providerMeta.textContent = [provider.specialty, provider.status].filter(Boolean).join(" · ");
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
  fillSkippedBox.hidden = true;
  fillManualBox.hidden = true;
  fillEventWarn.hidden = true;
  submitHint.hidden = true;
  markSubmittedBtn.hidden = true;
  markSubmittedBtn.disabled = false;
  markSubmittedBtn.textContent = "Mark submitted";
  submitStatus.hidden = true;
  lastFill = null;
}

function updateFillReady(): void {
  const portalOpen = portal != null && portalTabId != null;
  portalStatus.textContent = portalOpen
    ? `${portal?.label} form detected in the current tab.`
    : "Open the BCBS KS enrollment form in the current tab to fill it.";
  // Case selection is REQUIRED (locked decision): no case, no fill.
  fillBtn.disabled = !(portalOpen && selectedProviderId() && selectedCaseId());
}

function fieldList(box: HTMLElement, heading: string, fields: ReportedField[]): void {
  box.hidden = fields.length === 0;
  if (!fields.length) return;
  const title = document.createElement("div");
  title.textContent = heading;
  const list = document.createElement("ul");
  for (const field of fields) {
    const item = document.createElement("li");
    item.textContent = `${field.label} — ${field.reason}`;
    list.append(item);
  }
  box.replaceChildren(title, list);
}

// The review state: filled count, the skipped/manual lists, and the
// "Mark submitted" button the human presses only after submitting the portal
// form themselves (the extension never automates the portal's submit).
function renderFillSummary(summary: FillSummary): void {
  fillResults.hidden = false;
  const attempted = summary.filled + summary.skipped.length;
  fillSummaryBox.textContent = `Filled ${summary.filled} of ${attempted} mapped fields.`;
  fieldList(fillSkippedBox, "Not filled:", summary.skipped);
  fieldList(fillManualBox, "Needs manual entry or review:", summary.manual);
  if (!summary.eventRecorded) {
    fillEventWarn.hidden = false;
    fillEventWarn.textContent = `The fill was applied but could not be logged to Minted Panel: ${summary.eventError ?? "unknown error"}. Retry from the case record.`;
  }
  submitHint.hidden = false;
  markSubmittedBtn.hidden = false;
  submitStatus.hidden = true;
}

async function loadCases(providerId: string): Promise<void> {
  clearFillResults();
  caseSelect.disabled = true;
  caseSelect.replaceChildren(new Option("Loading cases…", ""));
  updateFillReady();

  const response = await sendToBackground({ type: "LIST_CASES", providerId });
  if (!response.ok) {
    setError(mainError, response.error);
    caseSelect.replaceChildren(new Option("Unavailable", ""));
    updateFillReady();
    return;
  }

  cases = response.data;
  const remembered = await sendToBackground({ type: "GET_SELECTED_CASE", providerId });
  const rememberedId =
    remembered.ok && cases.some((c) => c.id === remembered.data) ? remembered.data : null;
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
  updateFillReady();
}

async function loadProviders(): Promise<void> {
  setError(mainError, null);
  clearFillResults();
  providerSelect.disabled = true;
  providerSelect.replaceChildren(new Option("Loading providers…", ""));
  renderProviderCard(null);

  const response = await sendToBackground({ type: "LIST_PROVIDERS" });
  if (!response.ok) {
    providerSelect.replaceChildren(new Option("Unavailable", ""));
    setError(mainError, response.error);
    return;
  }
  providers = response.data;

  const selected = await sendToBackground({ type: "GET_SELECTED_PROVIDER" });
  const selectedId =
    selected.ok && providers.some((p) => p.id === selected.data) ? selected.data : null;
  renderProviderOptions(selectedId);
  const provider = providers.find((p) => p.id === selectedId) ?? null;
  renderProviderCard(provider);
  if (provider) await loadCases(provider.id);
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
  void loadProviders();
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
  void (async () => {
    await sendToBackground({ type: "SIGN_OUT" });
    providers = [];
    cases = [];
    showSignin();
  })();
});

refreshBtn.addEventListener("click", () => void loadProviders());

providerSelect.addEventListener("change", () => {
  const id = selectedProviderId();
  void sendToBackground({ type: "SET_SELECTED_PROVIDER", providerId: id });
  renderProviderCard(providers.find((p) => p.id === id) ?? null);
  if (id) void loadCases(id);
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
  clearFillResults();
  updateFillReady();
});

fillBtn.addEventListener("click", () => {
  const providerId = selectedProviderId();
  const caseId = selectedCaseId();
  if (!providerId || !caseId) return;
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
    const response = await sendToBackground({
      type: "FILL",
      tabId: tab.id,
      providerId,
      caseId,
      portalKey: clickPortal.key,
      state: clickPortal.state,
    });
    fillBtn.textContent = "Fill this page";
    fillBtn.disabled = false;
    updateFillReady();
    if (!response.ok) {
      setError(mainError, response.error);
      return;
    }
    lastFill = {
      caseId,
      portalKey: clickPortal.key,
      fillSessionId: response.data.fillSessionId,
    };
    renderFillSummary(response.data);
  })();
});

// Pressed by the human only after they submit the portal form themselves.
// The background reuses one idempotency id per (case, fill session), so a
// retry after a failure can never double-log the touch.
markSubmittedBtn.addEventListener("click", () => {
  const context = lastFill;
  if (!context) return;
  void (async () => {
    setError(mainError, null);
    markSubmittedBtn.disabled = true;
    markSubmittedBtn.textContent = "Logging…";
    const response = await sendToBackground({
      type: "MARK_SUBMITTED",
      caseId: context.caseId,
      portalKey: context.portalKey,
      fillSessionId: context.fillSessionId,
    });
    if (!response.ok) {
      markSubmittedBtn.disabled = false;
      markSubmittedBtn.textContent = "Mark submitted";
      setError(mainError, response.error);
      return;
    }
    submitHint.hidden = true;
    markSubmittedBtn.hidden = true;
    submitStatus.hidden = false;
    submitStatus.textContent = "Logged to the case.";
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
