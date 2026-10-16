/**
 * @vitest-environment jsdom
 */
// SPIKE(fill-latency): where do 95 s go on a 70-field BCBS KS fill?
//
// Drives the REAL worker routing (`applyFillAcrossFrames`) against the REAL
// content engine (`probeFillOnPage` / `applyFillSettled`) over a synthetic
// page shaped like the BCBS KS Network Enrollment Form: 40 text inputs and
// 30 PrimeFaces 10 SelectOneMenus (28 AM/PM office-hour pickers plus gender,
// degree, taxonomy, specialty, state stand-ins). `chrome.tabs.sendMessage`
// is stubbed with a small simulated IPC delay; everything else is the code
// that ships. Real timers, so this takes tens of seconds — it is OFF unless
// FILL_LATENCY_SPIKE=1:
//
//   FILL_LATENCY_SPIKE=1 npx vitest run src/harness/fillLatencySpike.test.ts
//
// Findings: docs/fill-latency-spike.md. Not an optimisation; nothing here
// changes the fill.
import { stub } from "./chromeStub";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFillAcrossFrames } from "../background/frameMessaging";
import { applyFillSettled, probeFillOnPage } from "../content/fillEngine";
import type { FillInstruction } from "../shared/fill";
import { lastFillTimingReport, setFillTimingEnabled, summarizeFillTiming, type FillTimingSummary } from "../shared/fillTiming";

if (typeof CSS === "undefined" || typeof CSS.escape !== "function") {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { escape: (value: string): string => String(value).replace(/([^\w-])/g, "\\$1") },
  });
}

const RUN = process.env.FILL_LATENCY_SPIKE === "1";
const spike = RUN ? describe : describe.skip;
const TAB_ID = 41;

// One-way extension messaging hop (worker ↔ content) and one browser API call.
// Chrome measures low single-digit ms for both; keep them small so the
// page-side waits are what the table shows.
const IPC_HOP_MS = 1.5;
const BROWSER_API_MS = 1;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface PageOptions {
  texts: number;
  selects: number;
  /** A page element mutating every N ms (session timer, p:poll). 0 = quiet. */
  tickerMs?: number;
  /** Simulated p:ajax partial render N ms after each select change. 0 = none. */
  ajaxAfterChangeMs?: number;
}

interface SyntheticPage {
  instructions: FillInstruction[];
  dispose: () => void;
}

/** PrimeFaces 10 SelectOneMenu: value-bearing select parked in
 * `.ui-helper-hidden-accessible`, items pre-rendered in a hidden `_panel`
 * (no data-value, label only), trigger shows the panel, item click posts the
 * value, sets the label, hides the panel, and fires change — synchronously,
 * the way `PrimeFaces.widget.SelectOneMenu.selectItem` does. */
function selectOneMenuMarkup(id: string, label: string, options: string[]): string {
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

function wireSelectOneMenu(id: string, ajaxAfterChangeMs: number): void {
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

function buildPage(options: PageOptions): SyntheticPage {
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

function installContentBridge(): () => void {
  const previousSendMessage = chrome.tabs.sendMessage;
  const previousGetAllFrames = chrome.webNavigation.getAllFrames;
  chrome.webNavigation.getAllFrames = (async () => {
    await delay(BROWSER_API_MS);
    return [{ frameId: 0, url: location.href }];
  }) as unknown as typeof chrome.webNavigation.getAllFrames;
  chrome.tabs.sendMessage = (async (_tabId: number, rawMessage: unknown) => {
    const message = rawMessage as { type?: string; instructions?: unknown[]; requireUniqueTarget?: boolean };
    await delay(IPC_HOP_MS);
    let response: unknown;
    if (message.type === "PROBE_FILL") {
      response = { ok: true, data: await probeFillOnPage((message.instructions ?? []) as Parameters<typeof probeFillOnPage>[0]) };
    } else if (message.type === "APPLY_FILL") {
      response = { ok: true, data: await applyFillSettled((message.instructions ?? []) as FillInstruction[], message.requireUniqueTarget === true) };
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
async function validate(): Promise<void> {
  await chrome.storage.session.get("minted.activeWork.v2");
  await delay(BROWSER_API_MS);
}

interface ScenarioResult {
  name: string;
  summary: FillTimingSummary;
  filled: number;
  skipped: number;
  /** Panel-owned reason wording → count. Never a value. */
  skipReasons: Record<string, number>;
}

async function runScenario(name: string, page: PageOptions): Promise<ScenarioResult> {
  const built = buildPage(page);
  try {
    const result = await applyFillAcrossFrames(TAB_ID, built.instructions, { captureV2: true, validate });
    const report = lastFillTimingReport();
    if (!report) throw new Error("timing gate did not report");
    const skipReasons: Record<string, number> = {};
    for (const field of result.skipped) skipReasons[field.reason] = (skipReasons[field.reason] ?? 0) + 1;
    return { name, summary: summarizeFillTiming(report), filled: result.filled.length, skipped: result.skipped.length, skipReasons };
  } finally {
    built.dispose();
  }
}

function printScenario(result: ScenarioResult): void {
  const s = result.summary;
  const pct = (ms: number): string => `${((ms / s.totalMs) * 100).toFixed(0)}%`;
  const lines = [
    `=== ${result.name}: ${s.fields} fields (${s.regular} regular, ${s.primefaces} primefaces, ${s.skipped} skipped) — filled ${result.filled}, skipped ${result.skipped} — total ${(s.totalMs / 1000).toFixed(1)} s, ${(s.totalMs / s.fields).toFixed(0)} ms/field`,
    `  batch PROBE_FILL (a)          ${s.batchProbeMs.toFixed(0).padStart(7)} ms  ${pct(s.batchProbeMs)}`,
    `  per-field fresh PROBE_FILL    ${s.freshProbeMs.toFixed(0).padStart(7)} ms  ${pct(s.freshProbeMs)}`,
    `  per-field getAllFrames        ${s.listFramesMs.toFixed(0).padStart(7)} ms  ${pct(s.listFramesMs)}`,
    `  per-field validate            ${s.validateMs.toFixed(0).padStart(7)} ms  ${pct(s.validateMs)}`,
    `  APPLY_FILL regular (b)        ${s.applyRegularMs.toFixed(0).padStart(7)} ms  ${pct(s.applyRegularMs)}`,
    `  APPLY_FILL primefaces (b)     ${s.applyPrimefacesMs.toFixed(0).padStart(7)} ms  ${pct(s.applyPrimefacesMs)}`,
    `    of which menu wait (c)      ${s.menuWaitMs.toFixed(0).padStart(7)} ms`,
    `    of which value wait (c)     ${s.valueWaitMs.toFixed(0).padStart(7)} ms`,
    `  other (loop, IPC gaps)        ${s.otherMs.toFixed(0).padStart(7)} ms  ${pct(s.otherMs)}`,
    ...Object.entries(result.skipReasons).map(([reason, count]) => `  skipped ×${count}: ${reason}`),
  ];
  console.info(lines.join("\n"));
}

spike("fill latency spike (synthetic BCBS KS page)", () => {
  let restore: () => void;

  beforeEach(() => {
    stub.reset();
    if (document.readyState !== "complete") {
      // waitForPageSettled returns at once before load; jsdom under vitest is
      // "complete" by now, but pin it so the probe wait is the real one.
      Object.defineProperty(document, "readyState", { configurable: true, value: "complete" });
    }
    restore = installContentBridge();
    setFillTimingEnabled(true);
  });

  afterEach(() => {
    setFillTimingEnabled(false);
    restore();
  });

  it("measures 40 text + 30 PrimeFaces selects on a quiet page, a ticking page, and an ajax-on-change page", async () => {
    const results: ScenarioResult[] = [];
    results.push(await runScenario("A quiet page", { texts: 40, selects: 30 }));
    results.push(await runScenario("B page mutates every 50 ms (timer/poll)", { texts: 40, selects: 30, tickerMs: 50 }));
    results.push(await runScenario("C p:ajax render 250 ms after each select change", { texts: 40, selects: 30, ajaxAfterChangeMs: 250 }));
    for (const result of results) printScenario(result);
    // vitest keeps a passing test's console quiet in some reporters; the
    // numbers are the deliverable, so also write them where asked.
    if (process.env.FILL_LATENCY_SPIKE_OUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.FILL_LATENCY_SPIKE_OUT, JSON.stringify(results, null, 2));
    }
    for (const result of results) expect(result.summary.fields).toBe(70);
    // A and C fill everything. B is recorded, not asserted: a page that never
    // goes quiet for 120 ms makes every re-probe hit its 700 ms cap AND the
    // apply path refuse most fields as context_changed — a finding, not a
    // pass/fail bar for this spike.
    for (const result of [results[0], results[2]]) {
      expect(result?.summary.primefaces).toBe(30);
      expect(result?.summary.regular).toBe(40);
      expect(result?.filled).toBe(70);
      expect(result?.skipped).toBe(0);
    }
  }, 600_000);
});
