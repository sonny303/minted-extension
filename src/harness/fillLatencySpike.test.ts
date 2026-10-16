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
// that ships. Each scenario runs with `FAST_REPROBE_ENABLED` off and on.
// Real timers, so this takes a minute or more — it is OFF unless
// FILL_LATENCY_SPIKE=1:
//
//   FILL_LATENCY_SPIKE=1 npx vitest run src/harness/fillLatencySpike.test.ts
//
// Findings: docs/fill-latency-spike.md. Set FILL_LATENCY_SPIKE_OUT to a
// path to also get the results as JSON.
import { stub } from "./chromeStub";
import { beforeEach, describe, expect, it } from "vitest";
import type { FillTimingSummary } from "../shared/fillTiming";
import { buildPage, installContentBridge, installCssEscape, loadFillStack, pinDocumentComplete, validate, type PageOptions } from "./syntheticFillPage";

installCssEscape();

const RUN = process.env.FILL_LATENCY_SPIKE === "1";
const spike = RUN ? describe : describe.skip;
const TAB_ID = 41;

interface ScenarioResult {
  name: string;
  fastReprobe: boolean;
  summary: FillTimingSummary;
  filled: number;
  skipped: number;
  /** Labels in fill order — synthetic "Text N" / "Select N" only. */
  filledLabels: string[];
  /** Panel-owned reason wording → count. Never a value. */
  skipReasons: Record<string, number>;
}

async function runScenario(name: string, page: PageOptions, fastReprobe: boolean): Promise<ScenarioResult> {
  const stack = await loadFillStack({ fastReprobe });
  const restore = installContentBridge(stack);
  const built = buildPage(page);
  stack.timing.setFillTimingEnabled(true);
  try {
    const result = await stack.applyFillAcrossFrames(TAB_ID, built.instructions, { captureV2: true, validate });
    const report = stack.timing.lastFillTimingReport();
    if (!report) throw new Error("timing gate did not report");
    const skipReasons: Record<string, number> = {};
    for (const field of result.skipped) skipReasons[field.reason] = (skipReasons[field.reason] ?? 0) + 1;
    return {
      name,
      fastReprobe,
      summary: stack.timing.summarizeFillTiming(report),
      filled: result.filled.length,
      skipped: result.skipped.length,
      filledLabels: [...result.filled],
      skipReasons,
    };
  } finally {
    stack.timing.setFillTimingEnabled(false);
    built.dispose();
    restore();
  }
}

function printScenario(result: ScenarioResult): void {
  const s = result.summary;
  const pct = (ms: number): string => `${((ms / s.totalMs) * 100).toFixed(0)}%`;
  const lines = [
    `=== ${result.name} [FAST_REPROBE_ENABLED=${result.fastReprobe}]: ${s.fields} fields (${s.regular} regular, ${s.primefaces} primefaces, ${s.skipped} skipped) — filled ${result.filled}, skipped ${result.skipped} — total ${(s.totalMs / 1000).toFixed(1)} s, ${(s.totalMs / s.fields).toFixed(0)} ms/field`,
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

function printComparison(off: ScenarioResult, on: ScenarioResult): void {
  const same = off.filledLabels.length === on.filledLabels.length &&
    off.filledLabels.every((label, index) => label === on.filledLabels[index]) &&
    JSON.stringify(off.skipReasons) === JSON.stringify(on.skipReasons);
  console.info(`--- ${off.name}: flag off ${(off.summary.totalMs / 1000).toFixed(1)} s → flag on ${(on.summary.totalMs / 1000).toFixed(1)} s; filled ${off.filled} → ${on.filled}, skipped ${off.skipped} → ${on.skipped}; lists ${same ? "identical" : "DIFFER"}`);
}

spike("fill latency spike (synthetic BCBS KS page)", () => {
  beforeEach(() => {
    stub.reset();
    pinDocumentComplete();
  });

  it("measures 40 text + 30 PrimeFaces selects on a quiet page, a ticking page, and an ajax-on-change page, flag off and on", async () => {
    const scenarios: Array<[string, PageOptions]> = [
      ["A quiet page", { texts: 40, selects: 30 }],
      ["B page mutates every 50 ms (timer/poll)", { texts: 40, selects: 30, tickerMs: 50 }],
      ["C p:ajax render 250 ms after each select change", { texts: 40, selects: 30, ajaxAfterChangeMs: 250 }],
    ];
    const results: ScenarioResult[] = [];
    const pairs: Array<[ScenarioResult, ScenarioResult]> = [];
    for (const [name, page] of scenarios) {
      const off = await runScenario(name, page, false);
      const on = await runScenario(name, page, true);
      results.push(off, on);
      pairs.push([off, on]);
    }
    for (const result of results) printScenario(result);
    for (const [off, on] of pairs) printComparison(off, on);
    // vitest keeps a passing test's console quiet in some reporters; the
    // numbers are the deliverable, so also write them where asked.
    if (process.env.FILL_LATENCY_SPIKE_OUT) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.FILL_LATENCY_SPIKE_OUT, JSON.stringify(results, null, 2));
    }
    for (const result of results) expect(result.summary.fields).toBe(70);
    // Flag off, A and C fill everything. Flag on, A (no mutations at all)
    // fills the same list; that is the one deterministic identity here.
    // B and C flag on are recorded, not asserted. B: a page that never goes
    // quiet makes every settled re-probe hit its 700 ms cap AND the apply
    // path refuse most fields as context_changed; the fast probe fills more
    // of it, not the same list. C: a render that lands 250 ms after a select
    // used to be absorbed by the NEXT field's settled probe; with the fast
    // probe it can land in the few ms between probe and apply, and that
    // field is refused as context_changed (about one or two per run). A
    // staging fill of a real form decides whether that costs real fields.
    for (const pair of [pairs[0], pairs[2]]) {
      if (!pair) throw new Error("scenario pair missing");
      const [off] = pair;
      expect(off.summary.primefaces).toBe(30);
      expect(off.summary.regular).toBe(40);
      expect(off.filled).toBe(70);
      expect(off.skipped).toBe(0);
    }
    const quiet = pairs[0];
    if (!quiet) throw new Error("scenario pair missing");
    expect(quiet[1].filled).toBe(70);
    expect(quiet[1].filledLabels).toEqual(quiet[0].filledLabels);
    expect(quiet[1].skipReasons).toEqual(quiet[0].skipReasons);
  }, 900_000);
});
