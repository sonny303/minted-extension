import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAiFillAcrossBoundFrames,
  aggregateScannedFields,
  applyFillAcrossFrames,
  clearAiFillAcrossFrames,
  filterShellNoise,
  mergeFillPageResults,
  mergeSelectorReports,
  scanUnmappedControlsAcrossFrames,
} from "./frameMessaging";
import { FIELD_NOT_FOUND_REASON } from "../shared/fixit";
import type { CapturedField } from "../content/captureScan";
import type { ContentRequest, FillInstruction } from "../shared/fill";
import { createFillEventV2OpaqueKey } from "../shared/fillEventV2";
import type { ControlSummary } from "../shared/nanoAi";
import { JSDOM } from "jsdom";

afterEach(() => vi.unstubAllGlobals());

const field = (over: Partial<CapturedField> & { label: string }): CapturedField => ({
  label: over.label,
  selector: over.selector ?? `#${over.label}`,
  fieldType: over.fieldType ?? "text",
  formSection: over.formSection ?? null,
});

describe("filterShellNoise", () => {
  it("keeps top-frame fields when no subframe has any", () => {
    const rows = filterShellNoise([
      { ...field({ label: "Search by keyword" }), frameId: 0 },
      { ...field({ label: "NPI" }), frameId: 0 },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Search by keyword", "NPI"]);
  });

  it("drops shell search fields when a subframe has form fields", () => {
    const rows = filterShellNoise([
      { ...field({ label: "Search by keyword" }), frameId: 0 },
      { ...field({ label: "Service Location Name" }), frameId: 3 },
      { ...field({ label: "City" }), frameId: 3 },
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      "Service Location Name",
      "City",
    ]);
  });
});

describe("aggregateScannedFields", () => {
  it("merges frame replies and strips frameId", () => {
    const fields = aggregateScannedFields([
      {
        frameId: 0,
        ok: true,
        data: [field({ label: "Search by keyword", selector: "#keyword" })],
      },
      {
        frameId: 2,
        ok: true,
        data: [field({ label: "Street Address 1", selector: "#addr1" })],
      },
      { frameId: 9, ok: false },
    ]);
    expect(fields).toEqual([
      field({ label: "Street Address 1", selector: "#addr1" }),
    ]);
    expect(fields[0]).not.toHaveProperty("frameId");
  });
});

describe("mergeFillPageResults", () => {
  it("does not let a same-label result from another map suppress a gap", () => {
    const merged = mergeFillPageResults([
      {
        filled: ["Provider name"],
        skipped: [],
        pageFields: 1,
      },
      {
        filled: [],
        skipped: [{ label: "Provider name", reason: FIELD_NOT_FOUND_REASON, mapId: "m2" }],
        pageFields: 8,
      },
    ]);
    expect(merged.filled).toEqual(["Provider name"]);
    expect(merged.skipped).toEqual([
      { label: "Provider name", reason: FIELD_NOT_FOUND_REASON, mapId: "m2" },
    ]);
    expect(merged.pageFields).toBe(9);
  });

  it("keeps concrete apply failures over not-found", () => {
    const merged = mergeFillPageResults([
      {
        filled: [],
        skipped: [{ label: "State", reason: FIELD_NOT_FOUND_REASON }],
        pageFields: 0,
      },
      {
        filled: [],
        skipped: [{ label: "State", reason: 'dropdown: no option matches "ZZ"' }],
        pageFields: 5,
      },
    ]);
    expect(merged.skipped).toEqual([
      { label: "State", reason: 'dropdown: no option matches "ZZ"' },
    ]);
  });
});

describe("mergeSelectorReports", () => {
  it("sums matches across frames", () => {
    expect(
      mergeSelectorReports([
        { valid: true, matches: 0, fillable: 0, radioGroup: false },
        { valid: true, matches: 1, fillable: 1, radioGroup: false },
      ]),
    ).toEqual({ valid: true, matches: 1, fillable: 1, radioGroup: false });
  });
});

describe("applyFillAcrossFrames public probe/apply boundary", () => {
  const mapId = "4f0d6e10-4f6f-4a7d-8d80-5a3a16ea4e73";
  const instruction: FillInstruction = {
    mapId,
    label: "Synthetic identifier",
    selector: "#synthetic-id",
    selectorFallbacks: [],
    fieldType: "text",
    value: "synthetic-only",
    pageStep: "credentials",
  };
  const probeRow = (over: Record<string, unknown> = {}) => ({
    mapId,
    pageStatus: "eligible",
    targetStatus: "unique",
    pageSettled: true,
    radioGroup: false,
    pageFields: 1,
    ...over,
  });
  function installFrames(sendMessage: (message: ContentRequest, frameId: number) => unknown, frameIds = [0]): void {
    vi.stubGlobal("chrome", {
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue(frameIds.map((frameId) => ({ frameId, url: "https://payer.example/enrollment/credentials" }))),
      },
      tabs: {
        sendMessage: vi.fn((_: number, message: ContentRequest, options: { frameId: number }) => sendMessage(message, options.frameId)),
      },
    });
  }

  function installHiddenSurveyFrames(options: {
    frameDetails?: Array<{ frameId: number; url: string; parentFrameId?: number }>;
    iframeMarkup?: string;
    iframeSrc?: string;
    targetStatuses?: Record<number, string>;
    initialFrameRect?: { width: number; height: number };
    inaccessibleParent?: boolean;
    executeMode?: "normal" | "throw" | "missing_frame_id" | "wrong_frame_id" | "false";
    mutateOnSecondInspection?: "visible" | "navigate" | "sibling";
    frameUrlOnSecondInventory?: string;
    onInspection?: (count: number) => void;
    inspectionDelayMs?: number;
  } = {}) {
    const frameUrl = "https://survey.example/feedback";
    const frames = options.frameDetails ?? [
      { frameId: 0, url: "https://payer.example/enroll/enrollment/credentials", parentFrameId: -1 },
      { frameId: 1, url: frameUrl, parentFrameId: 0 },
    ];
    const iframeMarkup = options.iframeMarkup ?? `<iframe id="survey-frame" src="${options.iframeSrc ?? frameUrl}"></iframe>`;
    const dom = new JSDOM(`<main>${iframeMarkup}</main>`, {
      url: "https://payer.example/enroll/enrollment/credentials",
      runScripts: "outside-only",
    });
    const iframe = dom.window.document.querySelector("iframe, frame") as HTMLIFrameElement | HTMLFrameElement | null;
    const setRect = (element: HTMLIFrameElement | HTMLFrameElement, width: number, height: number) => {
      Object.defineProperty(element, "getBoundingClientRect", {
        configurable: true,
        value: () => ({ width, height }),
      });
    };
    if (iframe) setRect(iframe, options.initialFrameRect?.width ?? 0, options.initialFrameRect?.height ?? 0);
    let inspectionCount = 0;
    let inventoryCount = 0;
    const executeScript = vi.fn(async (details: { args?: unknown[]; func: (loadedUrl: string) => boolean }) => {
      inspectionCount += 1;
      options.onInspection?.(inspectionCount);
      if (options.inspectionDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.inspectionDelayMs));
      }
      if (options.mutateOnSecondInspection && inspectionCount === 2) {
        const current = dom.window.document.getElementById("survey-frame") as HTMLIFrameElement | null;
        if (options.mutateOnSecondInspection === "visible" && current) setRect(current, 300, 200);
        if (options.mutateOnSecondInspection === "navigate" && current) current.src = "https://survey.example/redirected";
        if (options.mutateOnSecondInspection === "sibling") {
          dom.window.document.querySelector("main")!.insertAdjacentHTML("beforeend", `<iframe src="${frameUrl}"></iframe>`);
        }
      }
      if (options.executeMode === "throw") throw new Error("parent cannot be inspected");
      const callback = dom.window.eval(`(${details.func.toString()})`) as (loadedUrl: string) => boolean;
      const result = options.executeMode === "false" ? false : callback(String(details.args?.[0] ?? ""));
      if (options.executeMode === "missing_frame_id") return [{ result }];
      if (options.executeMode === "wrong_frame_id") return [{ frameId: 99, result }];
      return [{ frameId: 0, result }];
    });
    const sendMessage = vi.fn(async (_tabId: number, message: ContentRequest, sendOptions: { frameId: number }) => {
      const frameId = sendOptions.frameId;
      if (frameId === 1 || (frameId === 0 && options.inaccessibleParent)) throw new Error("no content script");
      if (message.type === "PROBE_FILL") {
        const targetStatus = options.targetStatuses?.[frameId] ?? "unique";
        return { ok: true, data: [probeRow({ targetStatus, resolvedPage: "credentials" })] };
      }
      if (message.type === "APPLY_FILL") {
        const routed = message.instructions[0]!;
        const telemetry = routed.telemetry!;
        return {
          ok: true,
          data: {
            filled: [routed.label],
            attemptedLabels: [routed.label],
            skipped: [],
            pageFields: 1,
            fieldOutcomes: [{
              mapId: routed.mapId,
              targetKey: telemetry.targetKey,
              frameKey: telemetry.frameKey,
              stepKey: telemetry.stepKey,
              attempted: true,
              outcome: "unverified",
              reasonCode: "readback_unavailable",
            }],
          },
        };
      }
      throw new Error(`Unexpected message type: ${message.type}`);
    });
    vi.stubGlobal("chrome", {
      webNavigation: {
        getAllFrames: vi.fn().mockImplementation(async () => {
          inventoryCount += 1;
          if (options.frameUrlOnSecondInventory && inventoryCount === 2) {
            return frames.map((frame) => frame.frameId === 1
              ? { ...frame, url: options.frameUrlOnSecondInventory }
              : frame);
          }
          return frames;
        }),
      },
      tabs: { sendMessage },
      scripting: { executeScript },
    });
    return { dom, executeScript, sendMessage, frames };
  }

  it("treats malformed or incomplete probe rows as uncertainty and never applies", async () => {
    installFrames((message) => {
      if (message.type === "PROBE_FILL") return { ok: true, data: [{ ...probeRow(), pageSettled: "yes" }] };
      throw new Error("apply must not run after malformed probe data");
    });
    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(result.fieldOutcomes?.[0]).toMatchObject({
      outcome: "unverified",
      reasonCode: "context_changed",
      attempted: false,
    });
  });

  it("rejects duplicate map rows as an incomplete probe result", async () => {
    installFrames((message) => {
      if (message.type === "PROBE_FILL") return { ok: true, data: [probeRow(), probeRow()] };
      throw new Error("apply must not run after duplicate probe rows");
    });
    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(result.fieldOutcomes?.[0]).toMatchObject({
      outcome: "unverified",
      reasonCode: "context_changed",
      attempted: false,
    });
  });

  it("keeps an inaccessible frame as explicit uncertainty instead of applying elsewhere", async () => {
    installFrames((message, frameId) => {
      if (frameId === 1) throw new Error("no content script");
      if (message.type === "PROBE_FILL") return { ok: true, data: [probeRow()] };
      throw new Error("apply must not run with an unchecked frame");
    }, [0, 1]);
    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(result.fieldOutcomes?.[0]).toMatchObject({
      outcome: "unverified",
      reasonCode: "frame_inaccessible",
      attempted: false,
      frameKey: null,
    });
  });

  it("qualifies not-found only after a complete settled search", async () => {
    installFrames((message) => {
      if (message.type === "PROBE_FILL") return { ok: true, data: [probeRow({ targetStatus: "missing" })] };
      throw new Error("apply must not run for a qualified miss");
    });
    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(result.fieldOutcomes?.[0]).toMatchObject({
      outcome: "not_found",
      reasonCode: "target_missing",
      attempted: false,
      notFoundEvidence: {
        stepKnown: true,
        frameAccessible: true,
        pageSettled: true,
        searchComplete: true,
        targetAbsent: true,
      },
    });
  });

  it("revalidates after a delayed probe and propagates a stale mapping before apply", async () => {
    let releaseProbe!: () => void;
    const blockedProbe = new Promise<void>((resolve) => { releaseProbe = resolve; });
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
    let stale = false;
    const appliedMapIds: string[] = [];
    installFrames(async (message) => {
      if (message.type === "PROBE_FILL") {
        markProbeStarted();
        await blockedProbe;
        return { ok: true, data: [probeRow()] };
      }
      if (message.type === "APPLY_FILL") {
        appliedMapIds.push(message.instructions[0]?.mapId ?? "missing");
      }
      throw new Error("stale mapping must not reach APPLY_FILL");
    });
    const validate = vi.fn(async () => {
      if (stale) throw new Error("mapping generation changed");
    });

    const pending = applyFillAcrossFrames(1, [instruction], { validate });
    await probeStarted;
    stale = true;
    releaseProbe();

    await expect(pending).rejects.toThrow("mapping generation changed");
    expect(validate).toHaveBeenCalledTimes(2);
    expect(appliedMapIds).toEqual([]);
  });

  it("revalidates immediately before each map apply and stops after a stale first dispatch", async () => {
    const mapTwo = "52b2323d-902c-4cef-8f46-a9e60a67421e";
    const appliedMapIds: string[] = [];
    let stale = false;
    installFrames((message) => {
      if (message.type === "PROBE_FILL") {
        return { ok: true, data: [probeRow(), probeRow({ mapId: mapTwo })] };
      }
      if (message.type === "APPLY_FILL") {
        const routed = message.instructions[0];
        appliedMapIds.push(routed?.mapId ?? "missing");
        stale = true;
        return {
          ok: true,
          data: { filled: [routed?.label ?? "missing"], writes: [], skipped: [], pageFields: 1 },
        };
      }
      throw new Error("unexpected message type");
    });
    const validate = vi.fn(async () => {
      if (stale) throw new Error("mapping generation changed");
    });

    await expect(applyFillAcrossFrames(1, [
      instruction,
      { ...instruction, mapId: mapTwo, label: "Dependent field", selector: "#dependent" },
    ], { validate })).rejects.toThrow("mapping generation changed");

    expect(validate).toHaveBeenCalledTimes(4);
    expect(appliedMapIds).toEqual([mapId]);
  });

  it("invalidates later absence snapshots after an earlier apply can reveal a panel", async () => {
    const mapTwo = "52b2323d-902c-4cef-8f46-a9e60a67421e";
    installFrames((message) => {
      if (message.type === "PROBE_FILL") {
        return {
          ok: true,
          data: [
            probeRow({ mapId }),
            probeRow({ mapId: mapTwo, targetStatus: "missing" }),
          ],
        };
      }
      if (message.type !== "APPLY_FILL") throw new Error("unexpected message type");
      const routed = message.instructions[0] as FillInstruction;
      const telemetry = routed.telemetry!;
      return {
        ok: true,
        data: {
          filled: [routed.label],
          attemptedLabels: [routed.label],
          skipped: [],
          pageFields: 1,
          fieldOutcomes: [{
            mapId: routed.mapId,
            targetKey: telemetry.targetKey,
            frameKey: telemetry.frameKey,
            stepKey: telemetry.stepKey,
            attempted: true,
            outcome: "unverified",
            reasonCode: "readback_unavailable",
          }],
        },
      };
    });
    const result = await applyFillAcrossFrames(1, [
      instruction,
      { ...instruction, mapId: mapTwo, label: "Dependent field", selector: "#dependent" },
    ], { captureV2: true });
    expect(result.fieldOutcomes?.map(({ outcome, reasonCode, attempted }) => ({ outcome, reasonCode, attempted }))).toEqual([
      { outcome: "unverified", reasonCode: "readback_unavailable", attempted: true },
      { outcome: "unverified", reasonCode: "context_changed", attempted: false },
    ]);
  });

  it.each([true, false])("uses the matching apply identity only (identity match: %s)", async (identityMatches) => {
    installFrames((message) => {
      if (message.type === "PROBE_FILL") return { ok: true, data: [probeRow()] };
      if (message.type !== "APPLY_FILL") throw new Error("unexpected message type");
      const routed = message.instructions[0] as FillInstruction;
      const telemetry = routed.telemetry!;
      return {
        ok: true,
        data: {
          filled: [instruction.label],
          attemptedLabels: [instruction.label],
          skipped: [],
          pageFields: 1,
          fieldOutcomes: [{
            mapId,
            targetKey: identityMatches ? telemetry.targetKey : createFillEventV2OpaqueKey("t"),
            frameKey: telemetry.frameKey,
            stepKey: telemetry.stepKey,
            attempted: true,
            outcome: "unverified",
            reasonCode: "readback_unavailable",
          }],
        },
      };
    });
    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(result.fieldOutcomes).toHaveLength(1);
    expect(result.fieldOutcomes?.[0]?.outcome).toBe("unverified");
    if (identityMatches) {
      expect(result.fieldOutcomes?.[0]?.attempted).toBe(true);
      expect(result.fieldOutcomes?.[0]?.reasonCode).toBe("readback_unavailable");
    } else {
      expect(result.fieldOutcomes?.[0]?.attempted).toBe(false);
      expect(result.fieldOutcomes?.[0]?.reasonCode).toBe("context_changed");
    }
  });

  it("does not allow an unrelated blank frame reporting page_unknown to veto a unique candidate", async () => {
    let appliedFrameId: number | null = null;
    let appliedInstruction: FillInstruction | undefined;
    installFrames((message, frameId) => {
      if (message.type === "PROBE_FILL") {
        if (frameId === 0) {
          return { ok: true, data: [probeRow({ targetStatus: "unique", pageStatus: "eligible", resolvedPage: "credentials" })] };
        }
        // Frame 1 is e.g. an about:blank iframe that reports page_unknown
        return { ok: true, data: [probeRow({ targetStatus: "missing", pageStatus: "page_unknown", pageFields: 0 })] };
      }
      if (message.type === "APPLY_FILL") {
        appliedFrameId = frameId;
        appliedInstruction = message.instructions[0];
        return {
          ok: true,
          data: {
            filled: [appliedInstruction!.label],
            attemptedLabels: [appliedInstruction!.label],
            skipped: [],
            pageFields: 1,
            fieldOutcomes: [{
              mapId,
              targetKey: appliedInstruction!.telemetry!.targetKey,
              frameKey: appliedInstruction!.telemetry!.frameKey,
              stepKey: appliedInstruction!.telemetry!.stepKey,
              attempted: true,
              outcome: "unverified",
              reasonCode: "readback_unavailable",
            }],
          },
        };
      }
      throw new Error(`Unexpected message type: ${message.type}`);
    }, [0, 1]);

    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(appliedFrameId).toBe(0);
    expect((appliedInstruction as FillInstruction | undefined)?.resolvedPage).toBe("credentials");
    expect(result.filled).toEqual([instruction.label]);
    expect(result.fieldOutcomes?.[0]?.outcome).not.toBe("page_unknown");
  });

  // DYN-PAGE-03. Production `humana-tricare`: every approved map is on
  // "Page 2" and the URL tail is `index`. The content probe proves the bucket
  // by its own selectors (pinned in fillEngine.test.ts) and marks each found
  // control `pageEvidence: "fingerprint"`; a missing one comes back page_unknown.
  describe("a Page N bucket proven by its own selectors (Humana Tricare)", () => {
    const HUMANA_URL = "https://infocenter.humana-military.com/hgbprovider/providercertification/home/index?ProviderType=PT";
    const humanaMaps = ["#firstname", "#lastname", "#npi", "#dob"].map((selector, index): FillInstruction => ({
      ...instruction,
      mapId: `4f0d6e10-4f6f-4a7d-8d80-5a3a16ea4e7${index}`,
      label: selector,
      selector,
      pageStep: "Page 2",
    }));
    type FrameRows = Record<string, Record<string, unknown>>;

    function installHumana(
      rowsByFrame: Record<number, FrameRows>,
      pageFieldsByFrame: Record<number, number> = {},
    ): { applied: Array<{ frameId: number; instruction: FillInstruction }> } {
      const applied: Array<{ frameId: number; instruction: FillInstruction }> = [];
      vi.stubGlobal("chrome", {
        webNavigation: {
          getAllFrames: vi.fn().mockResolvedValue(Object.keys(rowsByFrame).map((frameId) => ({
            frameId: Number(frameId),
            url: Number(frameId) === 0 ? HUMANA_URL : "about:blank",
          }))),
        },
        tabs: {
          sendMessage: vi.fn(async (_: number, message: ContentRequest, options: { frameId: number }) => {
            if (message.type === "PROBE_FILL") {
              const rows = rowsByFrame[options.frameId] ?? {};
              return {
                ok: true,
                data: message.instructions.map((row) => probeRow({
                  mapId: row.mapId,
                  pageFields: pageFieldsByFrame[options.frameId] ?? 4,
                  ...(rows[row.selector] ?? { pageStatus: "page_unknown", targetStatus: "missing" }),
                })),
              };
            }
            if (message.type === "APPLY_FILL") {
              const routed = message.instructions[0]!;
              applied.push({ frameId: options.frameId, instruction: routed });
              return {
                ok: true,
                data: {
                  filled: [routed.label],
                  attemptedLabels: [routed.label],
                  skipped: [],
                  pageFields: 4,
                  fieldOutcomes: [{
                    mapId: routed.mapId,
                    targetKey: routed.telemetry!.targetKey,
                    frameKey: routed.telemetry!.frameKey,
                    stepKey: routed.telemetry!.stepKey,
                    attempted: true,
                    outcome: "verified",
                    reasonCode: null,
                  }],
                },
              };
            }
            throw new Error(`unexpected ${message.type}`);
          }),
        },
      });
      return { applied };
    }

    const proven = (targetStatus: string) => ({ pageStatus: "eligible", targetStatus, pageEvidence: "fingerprint" });

    it("writes each proven unique control, reports a hidden one as hidden, and a missing one as page_unknown", async () => {
      const { applied } = installHumana({
        0: { "#firstname": proven("unique"), "#lastname": proven("unique"), "#npi": proven("hidden") },
      });
      const result = await applyFillAcrossFrames(1, humanaMaps, { captureV2: true });
      expect(applied.map(({ frameId, instruction: routed }) => [frameId, routed.selector, routed.resolvedPage, routed.telemetry?.stepKey])).toEqual([
        [0, "#firstname", null, null],
        [0, "#lastname", null, null],
      ]);
      expect(result.filled).toEqual(["#firstname", "#lastname"]);
      expect(result.fieldOutcomes?.map((row) => [row.outcome, row.reasonCode])).toEqual([
        ["verified", null],
        ["verified", null],
        ["hidden", "field_hidden"],
        ["page_unknown", "page_unknown"],
      ]);
      expect(result.skipped).toEqual([
        { label: "#npi", reason: "field is hidden on this page", mapId: humanaMaps[2]!.mapId, kind: "hidden" },
        { label: "#dob", reason: "current wizard page could not be confirmed", mapId: humanaMaps[3]!.mapId, kind: "page_unknown" },
      ]);
      // Absence on a sequence page is never drift.
      expect(result.fieldOutcomes?.some((row) => row.outcome === "not_found")).toBe(false);
    });

    it("writes nothing when the probe could not prove the bucket", async () => {
      const { applied } = installHumana({ 0: {} });
      const result = await applyFillAcrossFrames(1, humanaMaps, { captureV2: true });
      expect(applied).toEqual([]);
      expect(result.filled).toEqual([]);
      expect(result.fieldOutcomes?.map((row) => [row.outcome, row.reasonCode])).toEqual(
        humanaMaps.map(() => ["page_unknown", "page_unknown"]),
      );
    });

    it("lets another frame with fields that could not place the map veto a proven write", async () => {
      const { applied } = installHumana({
        0: { "#firstname": proven("unique"), "#lastname": proven("unique"), "#npi": proven("unique") },
        3: {},
      });
      const result = await applyFillAcrossFrames(1, humanaMaps, { captureV2: true });
      expect(applied).toEqual([]);
      expect(result.fieldOutcomes?.every((row) => row.outcome === "page_unknown")).toBe(true);
    });

    it("ignores an unproven frame with no fields, as it does for an exact page", async () => {
      const { applied } = installHumana({
        0: { "#firstname": proven("unique"), "#lastname": proven("unique"), "#npi": proven("unique") },
        5: {},
      }, { 5: 0 });
      const result = await applyFillAcrossFrames(1, humanaMaps, { captureV2: true });
      expect(applied.map(({ instruction: routed }) => routed.selector)).toEqual(["#firstname", "#lastname", "#npi"]);
      expect(result.fieldOutcomes?.at(-1)).toMatchObject({ outcome: "page_unknown" });
    });
  });

  it("keeps page_unknown when another frame reports fields that could contain the target", async () => {
    let applied = false;
    installFrames((message, frameId) => {
      if (message.type === "PROBE_FILL") {
        return { ok: true, data: [probeRow(frameId === 0
          ? { targetStatus: "unique", resolvedPage: "credentials" }
          : { pageStatus: "page_unknown", targetStatus: "missing", pageFields: 2 })] };
      }
      applied = true;
      throw new Error("apply must not run when a nonempty unknown page remains");
    }, [0, 1]);
    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(applied).toBe(false);
    expect(result.fieldOutcomes?.[0]).toMatchObject({ outcome: "page_unknown", reasonCode: "page_unknown" });
  });

  it("sanitizes page and context markers without exposing raw portal reasons", async () => {
    const sentinel = "synthetic-sensitive-marker";
    installFrames((message) => {
      if (message.type === "PROBE_FILL") return { ok: true, data: [probeRow()] };
      return {
        ok: true,
        data: {
          filled: [],
          skipped: [
            { label: "Address", reason: `context_changed: ${sentinel}`, kind: "unverified" },
            { label: "Wizard field", reason: `page_unknown: ${sentinel}`, kind: "page_unknown" },
          ],
          pageFields: 1,
        },
      };
    });
    const result = await applyFillAcrossFrames(1, [instruction]);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result.skipped.map(({ reason }) => reason)).toEqual([
      "form changed during fill (context_changed)",
      "current wizard page could not be confirmed (page_unknown)",
    ]);
  });

  it.each([
    ["zero size", `<iframe id="survey-frame" src="https://survey.example/feedback"></iframe>`, { width: 0, height: 0 }],
    ["display none ancestor", `<div style="display:none"><iframe id="survey-frame" src="https://survey.example/feedback"></iframe></div>`, { width: 300, height: 200 }],
    ["visibility hidden on iframe", `<iframe id="survey-frame" style="visibility:hidden" src="https://survey.example/feedback"></iframe>`, { width: 300, height: 200 }],
    ["visibility collapse on iframe", `<iframe id="survey-frame" style="visibility:collapse" src="https://survey.example/feedback"></iframe>`, { width: 300, height: 200 }],
  ])("ignores one inaccessible leaf only when its parent DOM proves it is hidden (%s)", async (_name, iframeMarkup, initialFrameRect) => {
    const { executeScript, sendMessage } = installHiddenSurveyFrames({ iframeMarkup, initialFrameRect });
    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(result.filled).toEqual([instruction.label]);
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.some(([, message]) => message.type === "APPLY_FILL")).toBe(true);
    expect(result.fieldOutcomes?.[0]).toMatchObject({
      outcome: "unverified",
      reasonCode: "readback_unavailable",
      attempted: true,
    });
  });

  it("does not treat an ancestor visibility value as proof when the iframe overrides it", async () => {
    const { sendMessage } = installHiddenSurveyFrames({
      iframeMarkup: `<div style="visibility:hidden"><iframe id="survey-frame" style="visibility:visible" src="https://survey.example/feedback"></iframe></div>`,
      initialFrameRect: { width: 300, height: 200 },
    });
    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(result.filled).toEqual([]);
    expect(result.fieldOutcomes?.[0]).toMatchObject({ reasonCode: "frame_inaccessible", attempted: false });
    expect(sendMessage.mock.calls.some(([, message]) => message.type === "APPLY_FILL")).toBe(false);
  });

  it.each([
    ["visible child", { initialFrameRect: { width: 300, height: 200 } }],
    ["multiple parent DOM iframes", { iframeMarkup: `<iframe id="survey-frame" src="https://survey.example/feedback"></iframe><iframe src="https://other.example/frame"></iframe>` }],
    ["multiple direct child frames", {
      frameDetails: [
        { frameId: 0, url: "https://payer.example/enroll/enrollment/credentials", parentFrameId: -1 },
        { frameId: 1, url: "https://survey.example/feedback", parentFrameId: 0 },
        { frameId: 2, url: "https://payer.example/other", parentFrameId: 0 },
      ],
      targetStatuses: { 2: "missing" },
    }],
    ["redirected loaded URL", {
      frameDetails: [
        { frameId: 0, url: "https://payer.example/enroll/enrollment/credentials", parentFrameId: -1 },
        { frameId: 1, url: "https://survey.example/final", parentFrameId: 0 },
      ],
    }],
    ["missing parent metadata", {
      frameDetails: [
        { frameId: 0, url: "https://payer.example/enroll/enrollment/credentials", parentFrameId: -1 },
        { frameId: 1, url: "https://survey.example/feedback" },
      ],
    }],
    ["inaccessible parent frame", {
      inaccessibleParent: true,
      frameDetails: [
        { frameId: 0, url: "https://payer.example/enroll/enrollment/credentials", parentFrameId: -1 },
        { frameId: 1, url: "https://survey.example/feedback", parentFrameId: 0 },
        { frameId: 2, url: "https://payer.example/other", parentFrameId: 0 },
      ],
    }],
    ["nested descendant", {
      frameDetails: [
        { frameId: 0, url: "https://payer.example/enroll/enrollment/credentials", parentFrameId: -1 },
        { frameId: 1, url: "https://survey.example/feedback", parentFrameId: 0 },
        { frameId: 2, url: "https://survey.example/nested", parentFrameId: 1 },
      ],
      targetStatuses: { 2: "missing" },
    }],
    ["parent cannot be inspected", { executeMode: "throw" as const }],
    ["script result omits its frame id", { executeMode: "missing_frame_id" as const }],
    ["script result names a different frame", { executeMode: "wrong_frame_id" as const }],
  ])("keeps inaccessible frames fail closed when hidden evidence is incomplete (%s)", async (_name, options) => {
    const { sendMessage } = installHiddenSurveyFrames(options);
    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(result.filled).toEqual([]);
    expect(result.fieldOutcomes?.[0]).toMatchObject({
      outcome: "unverified",
      reasonCode: "frame_inaccessible",
      attempted: false,
      frameKey: null,
    });
    expect(sendMessage.mock.calls.some(([, message]) => message.type === "APPLY_FILL")).toBe(false);
  });

  it.each(["visible", "navigate", "sibling"] as const)("rechecks hidden state before applying when it changes (%s)", async (mutation) => {
    const { sendMessage } = installHiddenSurveyFrames({ mutateOnSecondInspection: mutation });
    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(result.filled).toEqual([]);
    expect(result.fieldOutcomes?.[0]).toMatchObject({ reasonCode: "frame_inaccessible", attempted: false });
    expect(sendMessage.mock.calls.some(([, message]) => message.type === "APPLY_FILL")).toBe(false);
  });

  it("rechecks the live frame inventory before applying, including loaded URL changes", async () => {
    const { dom, sendMessage } = installHiddenSurveyFrames({
      frameUrlOnSecondInventory: "https://survey.example/redirected",
    });
    const iframe = dom.window.document.getElementById("survey-frame")!;
    expect((iframe as HTMLIFrameElement).src).toBe("https://survey.example/feedback");
    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(result.filled).toEqual([]);
    expect(result.fieldOutcomes?.[0]).toMatchObject({ reasonCode: "frame_inaccessible", attempted: false });
    expect(sendMessage.mock.calls.some(([, message]) => message.type === "APPLY_FILL")).toBe(false);
  });

  it("revalidates the active case after the asynchronous hidden-frame inspection", async () => {
    let invalidated = false;
    const { sendMessage } = installHiddenSurveyFrames({
      inspectionDelayMs: 10,
      onInspection: (count) => { if (count === 2) invalidated = true; },
    });
    const validate = vi.fn(async () => {
      if (invalidated) throw new Error("case changed during iframe inspection");
    });
    await expect(applyFillAcrossFrames(1, [instruction], { captureV2: true, validate }))
      .rejects.toThrow("case changed during iframe inspection");
    expect(sendMessage.mock.calls.some(([, message]) => message.type === "APPLY_FILL")).toBe(false);
  });

  it("keeps frame_inaccessible when no unique target exists", async () => {
    const { sendMessage } = installHiddenSurveyFrames({
      initialFrameRect: { width: 300, height: 200 },
      targetStatuses: { 0: "missing" },
    });
    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(result.filled).toEqual([]);
    expect(result.fieldOutcomes?.[0]).toMatchObject({ reasonCode: "frame_inaccessible", attempted: false });
    expect(result.fieldOutcomes?.[0]?.reasonCode).not.toBe("target_missing");
    expect(sendMessage.mock.calls.some(([, message]) => message.type === "APPLY_FILL")).toBe(false);
  });

  it("keeps ambiguity when another reachable frame also has a unique target", async () => {
    const { sendMessage } = installHiddenSurveyFrames({
      frameDetails: [
        { frameId: 0, url: "https://payer.example/enroll/enrollment/credentials", parentFrameId: -1 },
        { frameId: 1, url: "https://survey.example/feedback", parentFrameId: 0 },
        { frameId: 2, url: "https://payer.example/other", parentFrameId: 0 },
      ],
    });
    const result = await applyFillAcrossFrames(1, [instruction], { captureV2: true });
    expect(result.filled).toEqual([]);
    expect(result.fieldOutcomes?.[0]).toMatchObject({ reasonCode: "ambiguous_target", attempted: false });
    expect(sendMessage.mock.calls.some(([, message]) => message.type === "APPLY_FILL")).toBe(false);
  });

  it("does not let an inaccessible frame outside a map's explicit URL scope veto its candidate", async () => {
    const { sendMessage } = installHiddenSurveyFrames({ initialFrameRect: { width: 300, height: 200 } });
    const scoped = { ...instruction, pageUrlScope: "https://payer.example/enroll/enrollment/credentials" };
    const result = await applyFillAcrossFrames(1, [scoped], { captureV2: true });
    expect(result.filled).toEqual([instruction.label]);
    expect(sendMessage.mock.calls.some(([, message]) => message.type === "APPLY_FILL")).toBe(true);
  });

  it("blocks a write when an initially out-of-scope inaccessible frame navigates into scope", async () => {
    const { sendMessage } = installHiddenSurveyFrames({
      frameUrlOnSecondInventory: "https://payer.example/enroll/enrollment/credentials",
    });
    const scoped = { ...instruction, pageUrlScope: "https://payer.example/enroll/enrollment/credentials" };

    const result = await applyFillAcrossFrames(1, [scoped], { captureV2: true });

    expect(result.filled).toEqual([]);
    expect(result.fieldOutcomes?.[0]).toMatchObject({ reasonCode: "frame_inaccessible", attempted: false });
    expect(sendMessage.mock.calls.some(([, message]) => message.type === "APPLY_FILL")).toBe(false);
  });
});

describe("AI frame binding", () => {
  const control: ControlSummary = {
    selector: "#npi",
    label: "NPI",
    controlType: "text",
  };

  it("rejects selectors that are duplicated across frames", async () => {
    const sendMessage = vi.fn().mockImplementation((_tabId: number, message: { type: string }, options: { frameId: number }) => {
      expect(options.frameId).toBeGreaterThanOrEqual(0);
      if (message.type === "SCAN_UNMAPPED_CONTROLS") return { ok: true, data: [control] };
      return { ok: true, data: null };
    });
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, url: "https://portal.example/form" },
        { frameId: 3, url: "https://portal.example/embedded" },
      ]) },
    });

    const result = await scanUnmappedControlsAcrossFrames(7, "scan-1", []);
    expect(result.controls).toEqual([]);
    expect(result.ambiguousSelectors).toEqual(["#npi"]);
    expect(result.frames.map((frame) => frame.controls)).toEqual([[], []]);
  });

  it("sends a candidate only to its scanned frame, not every frame", async () => {
    const sendMessage = vi.fn().mockImplementation((_tabId: number, message: { type: string }, options: { frameId: number }) => {
      if (message.type === "APPLY_AI_FILL") {
        if (options.frameId !== 3) return { ok: false };
        return { ok: true, data: { filled: ["#npi"], writes: [{ selector: "#npi", kind: "ai", token: "provider.npi", confidence: 0.9 }], skipped: [], pageFields: 0 } };
      }
      return { ok: true, data: null };
    });
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, url: "https://portal.example/form" },
        { frameId: 3, url: "https://portal.example/embedded" },
      ]) },
    });
    const instruction: FillInstruction = {
      mapId: "ai:#npi", label: "#npi", selector: "#npi", selectorFallbacks: [],
      fieldType: "text", value: "123", pageStep: null, kind: "ai", token: "provider.npi", confidence: 0.9,
    };
    const result = await applyAiFillAcrossBoundFrames(7, "scan-2", "fill-2", [
      { frameId: 3, url: "https://portal.example/embedded", controls: [control] },
    ], [instruction]);

    expect(result.writes).toEqual([{
      selector: "#npi", kind: "ai", token: "provider.npi", confidence: 0.9,
      pageUrl: "https://portal.example/embedded",
    }]);
    const applyCalls = sendMessage.mock.calls.filter((call) => call[1].type === "APPLY_AI_FILL");
    expect(applyCalls.map((call) => call[2].frameId)).toEqual([3]);
  });

  it("refuses a frame whose URL changed after the scan", async () => {
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 3, url: "https://portal.example/new" },
      ]) },
    });
    const instruction: FillInstruction = {
      mapId: "ai:#npi", label: "#npi", selector: "#npi", selectorFallbacks: [],
      fieldType: "text", value: "123", pageStep: null, kind: "ai", token: "provider.npi", confidence: 0.9,
    };
    const result = await applyAiFillAcrossBoundFrames(7, "scan-3", "fill-3", [
      { frameId: 3, url: "https://portal.example/old", controls: [control] },
    ], [instruction]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.writes).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("AI frame changed after scan");
  });
});

describe("Nano learned page scopes", () => {
  it("excludes a learned selector only in the frame with the same canonical URL", async () => {
    const control: ControlSummary = { selector: "#field", label: "Name", controlType: "text" };
    const sendMessage = vi.fn().mockImplementation((_tabId: number, message: { type: string; activeMaps?: unknown[] }) => {
      if (message.type === "SCAN_UNMAPPED_CONTROLS") return { ok: true, data: [control] };
      return { ok: true, data: null };
    });
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, url: "https://portal.example/provider?case=private#form" },
        { frameId: 3, url: "https://portal.example/billing" },
        { frameId: 4, url: "https://other.example/provider" },
      ]) },
    });

    const result = await scanUnmappedControlsAcrossFrames(7, "scan-scope", [{
      selector: "#field",
      pageUrlScope: "https://portal.example/provider",
    }]);

    const scans = sendMessage.mock.calls.filter((call) => call[1].type === "SCAN_UNMAPPED_CONTROLS");
    expect(scans.map((call) => [call[2].frameId, call[1].activeMaps])).toEqual([
      [0, [{ selector: "#field", pageUrlScope: "https://portal.example/provider" }]],
      [3, []],
      [4, []],
    ]);
    expect(result.ambiguousSelectors).toEqual(["#field"]);
  });

  it("sends learned static values only to the matching frame", async () => {
    const sendMessage = vi.fn().mockImplementation((_tabId: number, message: { type: string; instructions?: Array<{ mapId: string; selector: string }> }, options: { frameId: number }) => {
      if (message.type === "PROBE_FILL") {
        return {
          ok: true,
          data: (message.instructions ?? []).map((instruction) => ({
            mapId: instruction.mapId,
            pageStatus: "eligible",
            targetStatus: "unique",
            pageSettled: true,
            radioGroup: false,
            pageFields: options.frameId === 0 ? 4 : 20,
          })),
        };
      }
      if (message.type === "APPLY_FILL") {
        const writes = (message.instructions ?? []).map((instruction) => ({
          selector: instruction.selector,
          kind: "static" as const,
        }));
        return { ok: true, data: { filled: writes.map((write: { selector: string }) => write.selector), writes, skipped: [], pageFields: options.frameId === 0 ? 4 : 20 } };
      }
      return { ok: true, data: null };
    });
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, url: "https://portal.example/provider?case=private" },
        { frameId: 3, url: "https://portal.example/billing" },
      ]) },
    });
    const instruction: FillInstruction = {
      mapId: "learned", label: "Name", selector: "#field", selectorFallbacks: [],
      fieldType: "text", value: "Ada", pageStep: null,
      pageUrlScope: "https://portal.example/provider",
    };

    const result = await applyFillAcrossFrames(7, [instruction]);

    const probes = sendMessage.mock.calls.filter((call) => call[1].type === "PROBE_FILL");
    expect(probes.map((call) => [call[2].frameId, call[1].instructions?.map((item: FillInstruction) => item.selector)])).toEqual([
      [0, ["#field"]],
      [3, []],
    ]);
    const applies = sendMessage.mock.calls.filter((call) => call[1].type === "APPLY_FILL");
    expect(applies.map((call) => [call[2].frameId, call[1].instructions?.map((item: FillInstruction) => item.selector)])).toEqual([
      [0, ["#field"]],
    ]);
    expect(result.writes).toEqual([{ selector: "#field", kind: "static" }]);
    expect(result.pageFields).toBe(4);
  });

  it("counts an unmapped page when every frame receives an empty static plan", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      data: { filled: [], writes: [], skipped: [], pageFields: 48 },
    });
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, url: "https://portal.example/unmapped" },
      ]) },
    });

    const result = await applyFillAcrossFrames(7, []);

    expect(sendMessage).toHaveBeenCalledWith(7, { type: "APPLY_FILL", instructions: [] }, { frameId: 0 });
    expect(result.pageFields).toBe(48);
  });

  it("revalidates before every empty-plan frame apply and aborts after a stale first frame", async () => {
    const appliedFrames: number[] = [];
    let stale = false;
    const sendMessage = vi.fn((_tabId: number, message: ContentRequest, options: { frameId: number }) => {
      if (message.type !== "APPLY_FILL") throw new Error("empty plans do not probe");
      appliedFrames.push(options.frameId);
      stale = true;
      return { ok: true, data: { filled: [], writes: [], skipped: [], pageFields: 1 } };
    });
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, url: "https://portal.example/form" },
        { frameId: 3, url: "https://portal.example/embedded" },
      ]) },
    });
    const validate = vi.fn(async () => {
      if (stale) throw new Error("mapping generation changed");
    });

    await expect(applyFillAcrossFrames(1, [], { validate })).rejects.toThrow("mapping generation changed");

    expect(validate).toHaveBeenCalledTimes(2);
    expect(appliedFrames).toEqual([0]);
  });

  it("stops after invalidation during a delayed frame response and clears late writes", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let cancelled = false;
    const appliedFrames: number[] = [];
    const clearedFrames: number[] = [];
    const sendMessage = vi.fn().mockImplementation(async (
      _tabId: number,
      message: { type: string; instructions?: FillInstruction[] },
      options: { frameId: number },
    ) => {
      if (message.type === "APPLY_AI_FILL") {
        appliedFrames.push(options.frameId);
        if (options.frameId === 0) {
          markStarted();
          await blocked;
        }
        return {
          ok: true,
          data: {
            filled: [message.instructions?.[0]?.selector ?? "#missing"],
            writes: [{ selector: message.instructions?.[0]?.selector ?? "#missing", kind: "ai", token: "provider.npi", confidence: 0.95 }],
            skipped: [],
            pageFields: 1,
          },
        };
      }
      if (message.type === "CLEAR_AI_FILL") {
        clearedFrames.push(options.frameId);
        return { ok: true, data: 1 };
      }
      return { ok: true, data: null };
    });
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: { getAllFrames: vi.fn().mockResolvedValue([
        { frameId: 0, url: "https://portal.example/form" },
        { frameId: 3, url: "https://portal.example/embedded" },
      ]) },
    });
    const first: FillInstruction = {
      mapId: "ai:#npi", label: "#npi", selector: "#npi", selectorFallbacks: [],
      fieldType: "text", value: "123", pageStep: null, kind: "ai", token: "provider.npi", confidence: 0.95,
    };
    const second: FillInstruction = { ...first, mapId: "ai:#state", label: "#state", selector: "#state" };
    const npiControl: ControlSummary = { selector: "#npi", label: "NPI", controlType: "text" };
    const stateControl: ControlSummary = { selector: "#state", label: "State", controlType: "text" };
    const lifecycle = {
      isCancelled: () => cancelled,
      validate: async () => { if (cancelled) throw new Error("context changed"); },
      onDispatch: vi.fn(),
    };
    const pending = applyAiFillAcrossBoundFrames(7, "scan-race", "fill-race", [
      { frameId: 0, url: "https://portal.example/form", controls: [npiControl] },
      { frameId: 3, url: "https://portal.example/embedded", controls: [stateControl] },
    ], [first, second], lifecycle);

    await started;
    cancelled = true;
    await clearAiFillAcrossFrames(7, "fill-race", [0]);
    release();
    await expect(pending).rejects.toThrow(/cancelled|context changed/i);

    expect(appliedFrames).toEqual([0]);
    expect(lifecycle.onDispatch.mock.calls).toEqual([[0]]);
    expect(clearedFrames.length).toBeGreaterThanOrEqual(2);
    expect(clearedFrames.every((frameId) => frameId === 0)).toBe(true);
  });
});
