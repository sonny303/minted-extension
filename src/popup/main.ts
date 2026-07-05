// Popup UI: sign in, pick a provider and case, fill the open portal page.
// All auth and API work happens in the background worker; this file only
// renders state and sends typed messages.
import "./popup.css";
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
const caseInput = el<HTMLInputElement>("case-input");
const caseHint = el<HTMLElement>("case-hint");
const portalStatus = el<HTMLElement>("portal-status");
const fillBtn = el<HTMLButtonElement>("fill-btn");
const fillResults = el<HTMLElement>("fill-results");
const fillSummaryBox = el<HTMLElement>("fill-summary");
const fillSkippedBox = el<HTMLElement>("fill-skipped");
const fillManualBox = el<HTMLElement>("fill-manual");
const fillEventWarn = el<HTMLElement>("fill-event-warn");

let providers: ProviderListItem[] = [];
let cases: CaseListItem[] = [];
// true once LIST_CASES came back 404 (cases route not deployed yet) — the
// popup falls back to a paste-the-case-id input.
let casesUnavailable = false;
let portal: PortalConfig | null = null;
let portalTabId: number | null = null;

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
  const value = casesUnavailable ? caseInput.value.trim() : caseSelect.value;
  return UUID_RE.test(value) ? value : null;
}

function providerLabel(p: ProviderListItem): string {
  const name = `${p.lastName}, ${p.firstName}`;
  return p.npi ? `${name} — ${p.npi}` : name;
}

function caseLabel(c: CaseListItem): string {
  const parts = [c.payerName ?? "Unknown payer"];
  if (c.state) parts.push(c.state);
  const label = parts.join(" — ");
  return c.statusLabel ? `${label} · ${c.statusLabel}` : label;
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
}

function updateFillReady(): void {
  const portalOpen = portal != null && portalTabId != null;
  portalStatus.textContent = portalOpen
    ? `${portal?.label} form detected in the current tab.`
    : "Open the BCBS KS enrollment form in the current tab to fill it.";
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
}

async function loadCases(providerId: string): Promise<void> {
  clearFillResults();
  casesUnavailable = false;
  caseInput.hidden = true;
  caseHint.hidden = true;
  caseSelect.hidden = false;
  caseSelect.disabled = true;
  caseSelect.replaceChildren(new Option("Loading cases…", ""));
  updateFillReady();

  const response = await sendToBackground({ type: "LIST_CASES", providerId });
  if (!response.ok && response.code === 404) {
    // Cases route not deployed yet — fall back to manual case id entry.
    casesUnavailable = true;
    caseSelect.hidden = true;
    caseInput.hidden = false;
    caseHint.hidden = false;
    caseHint.textContent =
      "Case lookup isn't available on the server yet — paste the case id from Minted Panel.";
    const remembered = await sendToBackground({ type: "GET_SELECTED_CASE", providerId });
    if (remembered.ok && remembered.data) caseInput.value = remembered.data;
    updateFillReady();
    return;
  }
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
    cases.length ? "Select a case…" : "No cases for this provider",
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

async function detectPortal(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    portal = matchPortal(tab?.url);
    portalTabId = portal != null && tab?.id != null ? tab.id : null;
  } catch {
    portal = null;
    portalTabId = null;
  }
  updateFillReady();
}

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

caseInput.addEventListener("input", () => {
  const providerId = selectedProviderId();
  if (providerId && selectedCaseId()) {
    void sendToBackground({ type: "SET_SELECTED_CASE", providerId, caseId: selectedCaseId() });
  }
  updateFillReady();
});

fillBtn.addEventListener("click", () => {
  const providerId = selectedProviderId();
  const caseId = selectedCaseId();
  if (!providerId || !caseId || !portal || portalTabId == null) return;
  void (async () => {
    setError(mainError, null);
    clearFillResults();
    fillBtn.disabled = true;
    fillBtn.textContent = "Filling…";
    const response = await sendToBackground({
      type: "FILL",
      tabId: portalTabId,
      providerId,
      caseId,
      portalKey: portal.key,
      state: portal.state,
    });
    fillBtn.textContent = "Fill this page";
    fillBtn.disabled = false;
    updateFillReady();
    if (!response.ok) {
      setError(mainError, response.error);
      return;
    }
    renderFillSummary(response.data);
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
