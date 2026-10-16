/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://portal.synthetic.invalid/enrollment/coverage" }
 */
// Pins for the per-field fresh PROBE_FILL that `applyFillAcrossFrames` sends
// before every field after the first. They drive the REAL worker routing
// against the REAL content engine (`probeFillOnPage` / `applyFillSettled`)
// so the two-stage re-probe behind `FAST_REPROBE_ENABLED` can be judged on
// outcomes, not on which message went out:
//
//   (a) a panel the page reveals late — on a timer, or on an earlier write —
//       still fills;
//   (b) a truly absent field still ends as "field not found on this page"
//       with settled not-found evidence;
//   (c) the fill-latency spike's synthetic 70-field page fills the same
//       fields, skips the same fields for the same reasons, and sends exactly
//       one APPLY_FILL per field.
//
// The page URL ends in `coverage`, so a map with `pageStep: "coverage"` is an
// exact page identity (DYN-PAGE-01) — the only kind the rescue re-probe for a
// write-revealed field applies to.
import { stub } from "./chromeStub";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FillInstruction } from "../shared/fill";
import { FIELD_NOT_FOUND_REASON } from "../shared/fixit";
import { HIDDEN_REASON } from "../shared/hiddenField";
import { buildHiddenDelayedPanelFixture } from "../__fixtures__/dom/portalScenarios";
import {
  buildPage,
  installContentBridge,
  installCssEscape,
  loadFillStack,
  pinDocumentComplete,
  validate,
  type BridgedMessage,
  type FillStack,
} from "./syntheticFillPage";

installCssEscape();

const TAB_ID = 41;
const PAGE = "coverage";
const TRIGGER_MAP = "6b0e2d4a-1c7f-4e3b-9a52-7d1f0c8e4a21";
const COVERAGE_MAP = "2f7c9b1e-5d3a-4c68-8e41-b9a0d6f3c512";
const ABSENT_MAP = "9c4d1e7a-3b2f-4a85-9d60-1e8f7c2b5a34";
const HIDDEN_MAP = "4a8f2c6d-7e1b-4d93-a57c-3f9e0b1d8c26";

/** The fixture's own markup (a hidden "Coverage identifier" panel) copied into
 * the global document, where the engine's `instanceof` checks resolve. The
 * fixture's timer only ever reveals its own detached DOM, so each test wires
 * the reveal it needs on this copy. */
function loadFixtureMarkup(): HTMLElement {
  const fixture = buildHiddenDelayedPanelFixture();
  document.body.innerHTML = fixture.dom.window.document.body.innerHTML;
  fixture.dispose();
  const panel = document.querySelector<HTMLElement>("#conditional-panel");
  if (!panel) throw new Error("fixture panel missing");
  return panel;
}

function revealPanel(panel: HTMLElement): void {
  panel.hidden = false;
  panel.style.display = "block";
}

function addTriggerField(): void {
  const main = document.querySelector("main");
  if (!main) throw new Error("fixture main missing");
  main.insertAdjacentHTML("afterbegin", '<label for="trigger">Trigger</label><input id="trigger" name="trigger" type="text">');
}

const triggerInstruction: FillInstruction = {
  mapId: TRIGGER_MAP,
  label: "Trigger",
  selector: "#trigger",
  selectorFallbacks: [],
  fieldType: "text",
  value: "first write",
  pageStep: PAGE,
};

const coverageInstruction: FillInstruction = {
  mapId: COVERAGE_MAP,
  label: "Coverage identifier",
  selector: "#coverage-id",
  selectorFallbacks: [],
  fieldType: "text",
  value: "coverage-0001",
  pageStep: PAGE,
};

const count = (log: BridgedMessage[], type: string): number => log.filter((m) => m.type === type).length;
const singleProbes = (log: BridgedMessage[]): BridgedMessage[] => log.filter((m) => m.type === "PROBE_FILL" && m.instructions === 1);

describe.each([
  { fastReprobe: false },
  { fastReprobe: true },
])("fresh re-probe pins (FAST_REPROBE_ENABLED = $fastReprobe)", ({ fastReprobe }) => {
  let stack: FillStack;
  let log: BridgedMessage[];
  let restore: () => void;

  beforeEach(async () => {
    stub.reset();
    pinDocumentComplete();
    stack = await loadFillStack({ fastReprobe });
    log = [];
    restore = installContentBridge(stack, log);
  });

  afterEach(() => {
    restore();
    document.body.innerHTML = "";
  });

  it("(a) fills a field inside a panel the page reveals on a timer", async () => {
    const panel = loadFixtureMarkup();
    setTimeout(() => revealPanel(panel), 40);

    const result = await stack.applyFillAcrossFrames(TAB_ID, [coverageInstruction], { captureV2: true, validate });

    expect(result.filled).toEqual(["Coverage identifier"]);
    expect(result.skipped).toEqual([]);
    expect(count(log, "APPLY_FILL")).toBe(1);
  });

  it("(a) fills a field inside a panel an earlier write reveals", async () => {
    const panel = loadFixtureMarkup();
    addTriggerField();
    // Absent until the first write lands: the portal attaches the dependent
    // panel after its own round trip.
    panel.remove();
    document.querySelector("#trigger")?.addEventListener("input", () => {
      setTimeout(() => {
        document.querySelector("main")?.append(panel);
        revealPanel(panel);
      }, 40);
    });

    const result = await stack.applyFillAcrossFrames(TAB_ID, [triggerInstruction, coverageInstruction], { captureV2: true, validate });

    expect(result.filled).toEqual(["Trigger", "Coverage identifier"]);
    expect(result.skipped).toEqual([]);
    expect(count(log, "APPLY_FILL")).toBe(2);
    // One batch probe, the settled rescue probe that found the revealed
    // panel, and the pre-apply refresh for the second field.
    expect(count(log, "PROBE_FILL")).toBe(3);
    // The rescue probe stays settled either way; only the pre-apply refresh
    // goes out unsettled when the flag is on (and finds the panel at once).
    expect(singleProbes(log).map((m) => m.settle)).toEqual([undefined, fastReprobe ? false : undefined]);
  });

  it.each([
    {
      shape: "missing",
      // The portal re-renders the dependent control after its round trip:
      // gone the instant the first write lands, back 40 ms later.
      disturb: (field: HTMLInputElement): (() => void) => {
        const parent = field.parentElement!;
        field.remove();
        return () => parent.append(field);
      },
    },
    {
      shape: "hidden",
      disturb: (field: HTMLInputElement): (() => void) => {
        field.hidden = true;
        return () => { field.hidden = false; };
      },
    },
    {
      shape: "ambiguous",
      // A transient duplicate (a validation re-render) matches the same selector.
      disturb: (field: HTMLInputElement): (() => void) => {
        const twin = field.cloneNode() as HTMLInputElement;
        twin.id = "";
        field.after(twin);
        return () => twin.remove();
      },
    },
  ])("(a) re-sends the pre-apply probe settled when the fast probe finds the target $shape, and the field still fills", async ({ disturb }) => {
    loadFixtureMarkup();
    addTriggerField();
    document.querySelector("#conditional-panel")?.remove();
    document.querySelector("main")?.insertAdjacentHTML("beforeend", '<label for="dependent">Dependent</label><input id="dependent" name="dependent" type="text">');
    const dependent = document.querySelector<HTMLInputElement>("#dependent")!;
    const dependentInstruction: FillInstruction = { ...coverageInstruction, label: "Dependent", selector: 'input[name="dependent"]', value: "second write" };
    document.querySelector("#trigger")?.addEventListener("input", () => {
      const undo = disturb(dependent);
      setTimeout(undo, 40);
    });

    const result = await stack.applyFillAcrossFrames(TAB_ID, [triggerInstruction, dependentInstruction], { captureV2: true, validate });

    expect(result.filled).toEqual(["Trigger", "Dependent"]);
    expect(result.skipped).toEqual([]);
    expect(dependent.value).toBe("second write");
    expect(count(log, "APPLY_FILL")).toBe(2);
    // Flag on: the fast probe did not find a unique target, so the settled
    // probe went out as before and found it once the page had settled.
    // Flag off: the settled probe alone, as before.
    expect(singleProbes(log).map((m) => m.settle)).toEqual(fastReprobe ? [false, undefined] : [undefined]);
  });

  it("(b) ends a truly absent field as not found with settled evidence", async () => {
    loadFixtureMarkup();
    addTriggerField();
    document.querySelector("#conditional-panel")?.remove();

    const result = await stack.applyFillAcrossFrames(TAB_ID, [coverageInstruction], { captureV2: true, validate });

    expect(result.filled).toEqual([]);
    expect(result.skipped).toEqual([
      { label: "Coverage identifier", reason: FIELD_NOT_FOUND_REASON, mapId: COVERAGE_MAP, kind: "skipped" },
    ]);
    expect(result.fieldOutcomes?.[0]).toMatchObject({
      mapId: COVERAGE_MAP,
      outcome: "not_found",
      reasonCode: "target_missing",
      attempted: false,
      notFoundEvidence: { stepKnown: true, frameAccessible: true, pageSettled: true, searchComplete: true, targetAbsent: true },
    });
    expect(count(log, "APPLY_FILL")).toBe(0);
  });

  it("(c) fills the spike's 70-field page with one APPLY_FILL per field and the same skips", async () => {
    const page = buildPage({ texts: 40, selects: 30 });
    // Two deliberate gaps beside the 70 fillable fields so the skip list is
    // not vacuous: a map nothing on the page matches, and a hidden control.
    document.querySelector("#form")?.insertAdjacentHTML("beforeend", '<input id="form:hiddenExtra" name="form:hiddenExtra" type="text" hidden>');
    const absent: FillInstruction = { mapId: ABSENT_MAP, label: "Absent", selector: "#form\\:absent", selectorFallbacks: [], fieldType: "text", value: "never", pageStep: PAGE };
    const hidden: FillInstruction = { mapId: HIDDEN_MAP, label: "Hidden", selector: "#form\\:hiddenExtra", selectorFallbacks: [], fieldType: "text", value: "never", pageStep: PAGE };
    const instructions = [absent, ...page.instructions, hidden];
    stack.timing.setFillTimingEnabled(true);
    try {
      const result = await stack.applyFillAcrossFrames(TAB_ID, instructions, { captureV2: true, validate });
      const report = stack.timing.lastFillTimingReport();
      console.info(`(c) FAST_REPROBE_ENABLED=${fastReprobe}: ${((report?.totalMs ?? 0) / 1000).toFixed(1)} s total, fresh probes ${(report ? stack.timing.summarizeFillTiming(report).freshProbeMs / 1000 : 0).toFixed(1)} s`);

      expect(result.filled).toEqual(page.instructions.map((instruction) => instruction.label));
      expect(result.skipped).toEqual([
        { label: "Absent", reason: FIELD_NOT_FOUND_REASON, mapId: ABSENT_MAP, kind: "skipped" },
        { label: "Hidden", reason: HIDDEN_REASON, mapId: HIDDEN_MAP, kind: "hidden" },
      ]);
      const applies = log.filter((m) => m.type === "APPLY_FILL");
      expect(applies).toHaveLength(70);
      expect(applies.every((m) => m.instructions === 1)).toBe(true);
      // One batch probe over all 72 maps, then one pre-apply refresh for every
      // fillable field after the first.
      expect(log.filter((m) => m.type === "PROBE_FILL" && m.instructions === 72)).toHaveLength(1);
      expect(singleProbes(log)).toHaveLength(69);
      // Flag on: every refresh went out unsettled and none needed the settled
      // fallback. Flag off: every refresh is the settled probe, as before.
      expect(singleProbes(log).map((m) => m.settle)).toEqual(Array.from({ length: 69 }, () => (fastReprobe ? false : undefined)));
    } finally {
      stack.timing.setFillTimingEnabled(false);
      page.dispose();
    }
  }, 120_000);
});
