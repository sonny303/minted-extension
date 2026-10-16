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
import { lastFillTimingReport, setFillTimingEnabled, summarizeFillTiming, type FillTimingSummary } from "../shared/fillTiming";
import { buildPage, installContentBridge, installCssEscape, pinDocumentComplete, validate, type PageOptions } from "./syntheticFillPage";

installCssEscape();

const RUN = process.env.FILL_LATENCY_SPIKE === "1";
const spike = RUN ? describe : describe.skip;
const TAB_ID = 41;

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
    pinDocumentComplete();
    restore = installContentBridge({ probeFillOnPage, applyFillSettled });
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
