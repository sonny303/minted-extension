import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyAiFillAcrossBoundFrames,
  aggregateScannedFields,
  filterShellNoise,
  mergeFillPageResults,
  mergeSelectorReports,
  scanUnmappedControlsAcrossFrames,
} from "./frameMessaging";
import { FIELD_NOT_FOUND_REASON } from "../shared/fixit";
import type { CapturedField } from "../content/captureScan";
import type { ControlSummary } from "../shared/nanoAi";
import type { FillInstruction } from "../shared/fill";

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
  it("lets a fill in one frame win over not-found in another", () => {
    const merged = mergeFillPageResults([
      {
        filled: [],
        skipped: [{ label: "NPI", reason: FIELD_NOT_FOUND_REASON, mapId: "m1" }],
        pageFields: 1,
      },
      {
        filled: ["NPI"],
        skipped: [],
        pageFields: 8,
      },
    ]);
    expect(merged.filled).toEqual(["NPI"]);
    expect(merged.skipped).toEqual([]);
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
