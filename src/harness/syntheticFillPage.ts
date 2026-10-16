// Test support for driving the REAL worker routing (`applyFillAcrossFrames`)
// against the REAL content engine (`probeFillOnPage` / `applyFillSettled`)
// over a synthetic page, with `chrome.tabs.sendMessage` bridged in-process.
// Shared by the fill-latency spike harness and the fresh re-probe pins.
// Nothing here ships in the extension.
import { vi } from "vitest";
import type { FillInstruction } from "../shared/fill";

// One-way extension messaging hop (worker ↔ content) and one browser API call.
// Chrome measures low single-digit ms for both; keep them small so the
// page-side waits are what a timing table shows.
export const IPC_HOP_MS = 1.5;
export const BROWSER_API_MS = 1;

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface PageOptions {
  texts: number;
  selects: number;
  /** A page element mutating every N ms (session timer, p:poll). 0 = quiet. */
  tickerMs?: number;
  /** Simulated p:ajax partial render N ms after each select change. 0 = none. */
  ajaxAfterChangeMs?: number;
}

export interface SyntheticPage {
  instructions: FillInstruction[];
  dispose: () => void;
}

/** PrimeFaces 10 SelectOneMenu: value-bearing select parked in
 * `.ui-helper-hidden-accessible`, items pre-rendered in a hidden `_panel`
 * (no data-value, label only), trigger shows the panel, item click posts the
 * value, sets the label, hides the panel, and fires change — synchronously,
 * the way `PrimeFaces.widget.SelectOneMenu.selectItem` does. */
export function selectOneMenuMarkup(id: string, label: string, options: string[]): string {
  const opts = ['<option value="">Select One</option>', ...options.map((o) => `<option value="${o}">${o}</option>`)].join("");
  const items = options.map((o) => `<li class="ui-selectonemenu-item ui-selectonemenu-list-item ui-corner-all" data-label="${o}" tabindex="-1" role="option">${o}</li>`).join("");
  return `
    <label for="${id}_focus">${label}</label>
    <div id="${id}" class="ui-selectonemenu ui-widget ui-state-default ui-corner-all" role="combobox" aria-haspopup="listbox" aria-expanded="false">
      <div class="ui-helper-hidden-accessible"><input id="${id}_focus" name="${id}_focus" type="text" autocomplete="off" role="combobox" aria-label="${label}" /></div>
      <div class="ui-helper-hidden-accessible"><select id="${id}_input" name="${id}_input" tabindex="-1" aria-hidden="true" aria-label="${label}">${opts}</select></div>
      <label id="${id}_label" class="ui-selectonemenu-label ui-inputfield ui-corner-all">Select One</label>
      <div class="ui-selectonemenu-trigger ui-state-default ui-corner-right"><span class="ui-icon ui-icon-triangle-1-s ui-c"></span></div>
    </div>
    <div id="${id}_panel" class="ui-selectonemenu-panel ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow" style="display:none">
      <div class="ui-selectonemenu-items-wrapper"><ul class="ui-selectonemenu-items ui-selectonemenu-list ui-widget-content ui-widget ui-corner-all ui-helper-reset">${items}</ul></div>
    </div>`;
}

export function wireSelectOneMenu(id: string, ajaxAfterChangeMs: number): void {
  const wrapper = document.getElementById(id)!;
  const select = document.getElementById(`${id}_input`) as HTMLSelectElement;
  const label = document.getElementById(`${id}_label`)!;
  const panel = document.getElementById(`${id}_panel`)!;
  const messages = document.getElementById("form:messages")!;
  wrapper.querySelector<HTMLElement>(".ui-selectonemenu-trigger")!.addEventListener("click", () => {
    panel.style.display = "block";
    wrapper.setAttribute("aria-expanded", "true");
  });
  panel.querySelectorAll<HTMLElement>(".ui-selectonemenu-item").forEach((item) => {
    item.addEventListener("click", () => {
      const text = item.getAttribute("data-label") ?? "";
      const option = Array.from(select.options).find((o) => o.text === text);
      select.value = option?.value ?? "";
      label.textContent = text;
      panel.style.display = "none";
      wrapper.setAttribute("aria-expanded", "false");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      if (ajaxAfterChangeMs > 0) {
        // p:ajax update="messages": a partial render lands after the round trip.
        setTimeout(() => { messages.innerHTML = `<div class="ui-messages"><span>${Date.now()}</span></div>`; }, ajaxAfterChangeMs);
      }
    });
  });
}

/** Synthetic BCBS KS-shaped page: `texts` text inputs and `selects`
 * PrimeFaces 10 SelectOneMenus (the first five with a long vocabulary, the
 * rest AM/PM pickers), interleaved the way the real form is. Instructions
 * come back in page order with `pageStep: null`. */
export function buildPage(options: PageOptions): SyntheticPage {
  const { texts, selects, tickerMs = 0, ajaxAfterChangeMs = 0 } = options;
  const parts: string[] = ['<form id="form"><div id="form:messages"></div><span id="form:timer">15:00</span>'];
  const instructions: FillInstruction[] = [];
  const hourOptions = ["AM", "PM"];
  const bigOptions = Array.from({ length: 60 }, (_, i) => `Option ${i + 1}`);
  // The real form interleaves: demographics (text), a few vocab menus, more
  // text (addresses, phones), then the 28 office-hour menus.
  let t = 0;
  let s = 0;
  const pushText = (): void => {
    const id = `form:text${t++}`;
    parts.push(`<label for="${id}">Text ${t}</label><input id="${id}" name="${id}" type="text" class="ui-inputfield ui-inputtext" />`);
    instructions.push({ mapId: `t${t}`, label: `Text ${t}`, selector: `#${CSS.escape(id)}`, selectorFallbacks: [], fieldType: "text", value: `value ${t}`, pageStep: null });
  };
  const pushSelect = (big: boolean): void => {
    const id = `form:select${s++}`;
    const opts = big ? bigOptions : hourOptions;
    parts.push(selectOneMenuMarkup(id, `Select ${s}`, opts));
    instructions.push({ mapId: `s${s}`, label: `Select ${s}`, selector: `#${CSS.escape(`${id}_focus`)}`, selectorFallbacks: [], fieldType: "select", value: big ? "Option 7" : (s % 2 ? "AM" : "PM"), pageStep: null });
  };
  for (let i = 0; i < 12 && t < texts; i += 1) pushText();
  for (let i = 0; i < 5 && s < selects; i += 1) pushSelect(true);
  while (t < texts) pushText();
  while (s < selects) pushSelect(false);
  parts.push("</form>");
  document.body.innerHTML = parts.join("");
  for (let i = 0; i < s; i += 1) wireSelectOneMenu(`form:select${i}`, ajaxAfterChangeMs);
  let ticker: ReturnType<typeof setInterval> | null = null;
  if (tickerMs > 0) {
    const timer = document.getElementById("form:timer")!;
    let n = 0;
    ticker = setInterval(() => { timer.textContent = `14:${String(59 - (n++ % 60)).padStart(2, "0")}`; }, tickerMs);
  }
  return {
    instructions,
    dispose: () => {
      if (ticker) clearInterval(ticker);
      document.body.innerHTML = "";
    },
  };
}

/** The production modules under test, loaded fresh so a test can choose the
 * `FAST_REPROBE_ENABLED` value the worker sees. Module state (the content
 * script's probed-target map, the timing gate) starts clean per load. */
export interface FillStack {
  applyFillAcrossFrames: typeof import("../background/frameMessaging")["applyFillAcrossFrames"];
  probeFillOnPage: typeof import("../content/fillEngine")["probeFillOnPage"];
  applyFillSettled: typeof import("../content/fillEngine")["applyFillSettled"];
  timing: typeof import("../shared/fillTiming");
}

export async function loadFillStack(options: { fastReprobe: boolean }): Promise<FillStack> {
  vi.resetModules();
  vi.doMock("../shared/config", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../shared/config")>()),
    FAST_REPROBE_ENABLED: options.fastReprobe,
  }));
  const [frameMessaging, fillEngine, timing] = await Promise.all([
    import("../background/frameMessaging"),
    import("../content/fillEngine"),
    import("../shared/fillTiming"),
  ]);
  return {
    applyFillAcrossFrames: frameMessaging.applyFillAcrossFrames,
    probeFillOnPage: fillEngine.probeFillOnPage,
    applyFillSettled: fillEngine.applyFillSettled,
    timing,
  };
}

/** One worker→content message as the bridge saw it: type, how many
 * instructions it carried, and the PROBE_FILL `settle` flag (undefined when
 * the worker sent none). Never a value. */
export interface BridgedMessage {
  type: string;
  instructions: number;
  settle: boolean | undefined;
}

/** Routes `chrome.tabs.sendMessage` to the content engine in-process with a
 * small simulated IPC delay, and `getAllFrames` to the one jsdom frame.
 * Returns the restore function. */
export function installContentBridge(
  engine: Pick<FillStack, "probeFillOnPage" | "applyFillSettled">,
  log: BridgedMessage[] = [],
): () => void {
  const previousSendMessage = chrome.tabs.sendMessage;
  const previousGetAllFrames = chrome.webNavigation.getAllFrames;
  chrome.webNavigation.getAllFrames = (async () => {
    await delay(BROWSER_API_MS);
    return [{ frameId: 0, url: location.href }];
  }) as unknown as typeof chrome.webNavigation.getAllFrames;
  chrome.tabs.sendMessage = (async (_tabId: number, rawMessage: unknown) => {
    const message = rawMessage as { type?: string; instructions?: unknown[]; requireUniqueTarget?: boolean; settle?: boolean };
    log.push({ type: message.type ?? "?", instructions: message.instructions?.length ?? 0, settle: message.settle });
    await delay(IPC_HOP_MS);
    let response: unknown;
    if (message.type === "PROBE_FILL") {
      response = { ok: true, data: await engine.probeFillOnPage((message.instructions ?? []) as Parameters<FillStack["probeFillOnPage"]>[0]) };
    } else if (message.type === "APPLY_FILL") {
      response = { ok: true, data: await engine.applyFillSettled((message.instructions ?? []) as FillInstruction[], message.requireUniqueTarget === true) };
    } else {
      throw new Error(`unexpected message ${message.type ?? "?"}`);
    }
    await delay(IPC_HOP_MS);
    return response;
  }) as typeof chrome.tabs.sendMessage;
  return () => {
    chrome.tabs.sendMessage = previousSendMessage;
    chrome.webNavigation.getAllFrames = previousGetAllFrames;
  };
}

/** The worker's per-field guard: a `chrome.storage.session` read plus the
 * equality checks. The stub's Map is synchronous, so add one API hop. */
export async function validate(): Promise<void> {
  await chrome.storage.session.get("minted.activeWork.v2");
  await delay(BROWSER_API_MS);
}

/** jsdom under vitest is "complete" by now, but pin it: `waitForPageSettled`
 * returns at once before load, which would hide the probe wait entirely. */
export function pinDocumentComplete(): void {
  if (document.readyState !== "complete") {
    Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
  }
}

/** jsdom does not provide CSS.escape; the engine uses it to scope a named
 * radio group and the page builder uses it for JSF ids. */
export function installCssEscape(): void {
  if (typeof CSS === "undefined" || typeof CSS.escape !== "function") {
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: { escape: (value: string): string => String(value).replace(/([^\w-])/g, "\\$1") },
    });
  }
}
