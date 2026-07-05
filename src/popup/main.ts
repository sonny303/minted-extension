// Popup UI: sign in, pick a provider, see name + NPI. All auth and API work
// happens in the background worker; this file only renders state and sends
// typed messages.
import "./popup.css";
import type { ProviderListItem } from "../shared/apiTypes";
import { sendToBackground } from "../shared/messages";

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

let providers: ProviderListItem[] = [];

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

function providerLabel(p: ProviderListItem): string {
  const name = `${p.lastName}, ${p.firstName}`;
  return p.npi ? `${name} — ${p.npi}` : name;
}

function renderProviderCard(provider: ProviderListItem | null): void {
  providerCard.hidden = provider == null;
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

async function loadProviders(): Promise<void> {
  setError(mainError, null);
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
  renderProviderCard(providers.find((p) => p.id === selectedId) ?? null);
}

function showMain(email: string | null): void {
  accountEmail.textContent = email ? `Signed in as ${email}` : "Signed in";
  showView("main");
  void loadProviders();
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
    showSignin();
  })();
});

refreshBtn.addEventListener("click", () => void loadProviders());

providerSelect.addEventListener("change", () => {
  const id = providerSelect.value || null;
  void sendToBackground({ type: "SET_SELECTED_PROVIDER", providerId: id });
  renderProviderCard(providers.find((p) => p.id === id) ?? null);
});

void (async () => {
  const response = await sendToBackground({ type: "GET_AUTH_STATE" });
  if (response.ok && response.data.signedIn) {
    showMain(response.data.email);
  } else {
    showSignin();
  }
})();
