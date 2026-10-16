// SPIKE(fill-latency): temporary, gated timing instrumentation for the static
// fill path. OFF by default (`setFillTimingEnabled(true)` turns it on; the
// latency spike harness does). Records durations and identifiers only — no
// field values, labels, or selectors ever enter a row.
//
// Phases, per `docs/fill-latency-spike.md`:
//   (a) the batch PROBE_FILL round trip (one per frame, before any write)
//   (b) each APPLY_FILL round trip, split PrimeFaces select vs regular control
//   (c) inside selectPrimeFacesItem: the menu-items wait and the value wait

export interface FillTimingWidget {
  mapId: string;
  /** Whole widget apply inside the content script, ms. */
  applyMs: number;
  /** waitForValue(menu items) inside selectPrimeFacesItem, ms; null if never reached. */
  menuWaitMs: number | null;
  /** waitForValue(posted value + label) inside selectPrimeFacesItem, ms; null if never reached. */
  valueWaitMs: number | null;
}

/** Content-side breakdown of one APPLY_FILL, attached to the page result only
 * while the gate is on. Numbers only. */
export interface FillTimingContent {
  regularMs: number;
  widgets: FillTimingWidget[];
  dateSettleMs: number;
  totalMs: number;
}

export interface FillTimingRow {
  mapId: string;
  kind: "regular" | "primefaces" | "skipped";
  listFramesMs: number;
  validateMs: number;
  freshProbeMs: number;
  applyMs: number;
  menuWaitMs: number | null;
  valueWaitMs: number | null;
  totalMs: number;
}

export interface FillTimingReport {
  batchProbeMs: number;
  rows: FillTimingRow[];
  totalMs: number;
}

export interface FillTimingSummary {
  fields: number;
  regular: number;
  primefaces: number;
  skipped: number;
  batchProbeMs: number;
  listFramesMs: number;
  validateMs: number;
  freshProbeMs: number;
  applyRegularMs: number;
  applyPrimefacesMs: number;
  menuWaitMs: number;
  valueWaitMs: number;
  /** Per-field total not covered by the phases above (loop overhead, IPC gaps). */
  otherMs: number;
  totalMs: number;
}

let enabled = false;
let lastReport: FillTimingReport | null = null;

export function setFillTimingEnabled(value: boolean): void {
  enabled = value;
}

export function fillTimingEnabled(): boolean {
  return enabled;
}

export function fillTimingNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function lastFillTimingReport(): FillTimingReport | null {
  return lastReport;
}

const round = (value: number): number => Math.round(value * 10) / 10;

export function summarizeFillTiming(report: FillTimingReport): FillTimingSummary {
  const sum = (pick: (row: FillTimingRow) => number | null, filter: (row: FillTimingRow) => boolean = () => true): number =>
    report.rows.filter(filter).reduce((acc, row) => acc + (pick(row) ?? 0), 0);
  const listFramesMs = sum((row) => row.listFramesMs);
  const validateMs = sum((row) => row.validateMs);
  const freshProbeMs = sum((row) => row.freshProbeMs);
  const applyRegularMs = sum((row) => row.applyMs, (row) => row.kind === "regular");
  const applyPrimefacesMs = sum((row) => row.applyMs, (row) => row.kind === "primefaces");
  const accounted = report.batchProbeMs + listFramesMs + validateMs + freshProbeMs + applyRegularMs + applyPrimefacesMs;
  return {
    fields: report.rows.length,
    regular: report.rows.filter((row) => row.kind === "regular").length,
    primefaces: report.rows.filter((row) => row.kind === "primefaces").length,
    skipped: report.rows.filter((row) => row.kind === "skipped").length,
    batchProbeMs: round(report.batchProbeMs),
    listFramesMs: round(listFramesMs),
    validateMs: round(validateMs),
    freshProbeMs: round(freshProbeMs),
    applyRegularMs: round(applyRegularMs),
    applyPrimefacesMs: round(applyPrimefacesMs),
    menuWaitMs: round(sum((row) => row.menuWaitMs)),
    valueWaitMs: round(sum((row) => row.valueWaitMs)),
    otherMs: round(report.totalMs - accounted),
    totalMs: round(report.totalMs),
  };
}

/** Logs the compact per-field table to the console of whichever context runs
 * `applyFillAcrossFrames` (the background worker in the extension). */
export function reportFillTiming(report: FillTimingReport): void {
  lastReport = report;
  if (typeof console === "undefined") return;
  const summary = summarizeFillTiming(report);
  console.info("[fill-timing] SPIKE summary (ms)", summary);
  console.table(report.rows.map((row) => ({
    mapId: row.mapId.slice(0, 8),
    kind: row.kind,
    frames: round(row.listFramesMs),
    validate: round(row.validateMs),
    freshProbe: round(row.freshProbeMs),
    apply: round(row.applyMs),
    menuWait: row.menuWaitMs == null ? "" : round(row.menuWaitMs),
    valueWait: row.valueWaitMs == null ? "" : round(row.valueWaitMs),
    total: round(row.totalMs),
  })));
}
