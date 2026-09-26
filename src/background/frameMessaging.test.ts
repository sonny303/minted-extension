import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateScannedFields,
  applyFillAcrossFrames,
  filterShellNoise,
  mergeFillPageResults,
  mergeSelectorReports,
} from "./frameMessaging";
import { FIELD_NOT_FOUND_REASON } from "../shared/fixit";
import type { CapturedField } from "../content/captureScan";
import type { ContentRequest, FillInstruction } from "../shared/fill";
import { createFillEventV2OpaqueKey } from "../shared/fillEventV2";

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
});
