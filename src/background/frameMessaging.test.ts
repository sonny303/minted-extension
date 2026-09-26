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
import type { ControlSummary } from "../shared/nanoAi";
import type { FillInstruction } from "../shared/fill";

afterEach(() => vi.unstubAllGlobals());

const field = (
  over: Partial<CapturedField> & { label: string },
): CapturedField => ({
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
    expect(rows.map((r) => r.label)).toEqual(["Service Location Name", "City"]);
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
        skipped: [
          { label: "NPI", reason: FIELD_NOT_FOUND_REASON, mapId: "m1" },
        ],
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
        skipped: [
          { label: "State", reason: 'dropdown: no option matches "ZZ"' },
        ],
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
    const sendMessage = vi
      .fn()
      .mockImplementation(
        (
          _tabId: number,
          message: { type: string },
          options: { frameId: number },
        ) => {
          expect(options.frameId).toBeGreaterThanOrEqual(0);
          if (message.type === "SCAN_UNMAPPED_CONTROLS")
            return { ok: true, data: [control] };
          return { ok: true, data: null };
        },
      );
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, url: "https://portal.example/form" },
          { frameId: 3, url: "https://portal.example/embedded" },
        ]),
      },
    });

    const result = await scanUnmappedControlsAcrossFrames(7, "scan-1", []);
    expect(result.controls).toEqual([]);
    expect(result.ambiguousSelectors).toEqual(["#npi"]);
    expect(result.frames.map((frame) => frame.controls)).toEqual([[], []]);
  });

  it("sends a candidate only to its scanned frame, not every frame", async () => {
    const sendMessage = vi
      .fn()
      .mockImplementation(
        (
          _tabId: number,
          message: { type: string },
          options: { frameId: number },
        ) => {
          if (message.type === "APPLY_AI_FILL") {
            if (options.frameId !== 3) return { ok: false };
            return {
              ok: true,
              data: {
                filled: ["#npi"],
                writes: [
                  {
                    selector: "#npi",
                    kind: "ai",
                    token: "provider.npi",
                    confidence: 0.9,
                  },
                ],
                skipped: [],
                pageFields: 0,
              },
            };
          }
          return { ok: true, data: null };
        },
      );
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, url: "https://portal.example/form" },
          { frameId: 3, url: "https://portal.example/embedded" },
        ]),
      },
    });
    const instruction: FillInstruction = {
      mapId: "ai:#npi",
      label: "#npi",
      selector: "#npi",
      selectorFallbacks: [],
      fieldType: "text",
      value: "123",
      pageStep: null,
      kind: "ai",
      token: "provider.npi",
      confidence: 0.9,
    };
    const result = await applyAiFillAcrossBoundFrames(
      7,
      "scan-2",
      "fill-2",
      [
        {
          frameId: 3,
          url: "https://portal.example/embedded",
          controls: [control],
        },
      ],
      [instruction],
    );

    expect(result.writes).toEqual([
      {
        selector: "#npi",
        kind: "ai",
        token: "provider.npi",
        confidence: 0.9,
        pageUrl: "https://portal.example/embedded",
      },
    ]);
    const applyCalls = sendMessage.mock.calls.filter(
      (call) => call[1].type === "APPLY_AI_FILL",
    );
    expect(applyCalls.map((call) => call[2].frameId)).toEqual([3]);
  });

  it("refuses a frame whose URL changed after the scan", async () => {
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: {
        getAllFrames: vi
          .fn()
          .mockResolvedValue([
            { frameId: 3, url: "https://portal.example/new" },
          ]),
      },
    });
    const instruction: FillInstruction = {
      mapId: "ai:#npi",
      label: "#npi",
      selector: "#npi",
      selectorFallbacks: [],
      fieldType: "text",
      value: "123",
      pageStep: null,
      kind: "ai",
      token: "provider.npi",
      confidence: 0.9,
    };
    const result = await applyAiFillAcrossBoundFrames(
      7,
      "scan-3",
      "fill-3",
      [{ frameId: 3, url: "https://portal.example/old", controls: [control] }],
      [instruction],
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.writes).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("AI frame changed after scan");
  });
});

describe("Nano learned page scopes", () => {
  it("excludes a learned selector only in the frame with the same canonical URL", async () => {
    const control: ControlSummary = {
      selector: "#field",
      label: "Name",
      controlType: "text",
    };
    const sendMessage = vi
      .fn()
      .mockImplementation(
        (_tabId: number, message: { type: string; activeMaps?: unknown[] }) => {
          if (message.type === "SCAN_UNMAPPED_CONTROLS")
            return { ok: true, data: [control] };
          return { ok: true, data: null };
        },
      );
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          {
            frameId: 0,
            url: "https://portal.example/provider?case=private#form",
          },
          { frameId: 3, url: "https://portal.example/billing" },
          { frameId: 4, url: "https://other.example/provider" },
        ]),
      },
    });

    const result = await scanUnmappedControlsAcrossFrames(7, "scan-scope", [
      {
        selector: "#field",
        pageUrlScope: "https://portal.example/provider",
      },
    ]);

    const scans = sendMessage.mock.calls.filter(
      (call) => call[1].type === "SCAN_UNMAPPED_CONTROLS",
    );
    expect(scans.map((call) => [call[2].frameId, call[1].activeMaps])).toEqual([
      [
        0,
        [
          {
            selector: "#field",
            pageUrlScope: "https://portal.example/provider",
          },
        ],
      ],
      [3, []],
      [4, []],
    ]);
    expect(result.ambiguousSelectors).toEqual(["#field"]);
  });

  it("sends learned static values only to the matching frame", async () => {
    const sendMessage = vi
      .fn()
      .mockImplementation(
        (
          _tabId: number,
          message: { type: string; instructions?: FillInstruction[] },
          options: { frameId: number },
        ) => {
          if (message.type === "APPLY_FILL") {
            const writes = (message.instructions ?? []).map((instruction) => ({
              selector: instruction.selector,
              kind: "static" as const,
            }));
            return {
              ok: true,
              data: {
                filled: writes.map((write) => write.selector),
                writes,
                skipped: [],
                pageFields:
                  options.frameId === 0 ? 4 : options.frameId === 3 ? 20 : 0,
              },
            };
          }
          return { ok: true, data: null };
        },
      );
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, url: "https://portal.example/provider?case=private" },
          { frameId: 3, url: "https://portal.example/billing" },
        ]),
      },
    });
    const instruction: FillInstruction = {
      mapId: "learned",
      label: "Name",
      selector: "#field",
      selectorFallbacks: [],
      fieldType: "text",
      value: "Ada",
      pageStep: null,
      pageUrlScope: "https://portal.example/provider",
    };

    const result = await applyFillAcrossFrames(7, [instruction]);

    const applies = sendMessage.mock.calls.filter(
      (call) => call[1].type === "APPLY_FILL",
    );
    expect(
      applies.map((call) => [
        call[2].frameId,
        call[1].instructions?.map((item: FillInstruction) => item.selector),
      ]),
    ).toEqual([
      [0, ["#field"]],
      [3, []],
    ]);
    expect(result.writes).toEqual([{ selector: "#field", kind: "static" }]);
    expect(result.pageFields).toBe(24);
  });

  it("counts an unmapped page when every frame receives an empty static plan", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      data: { filled: [], writes: [], skipped: [], pageFields: 48 },
    });
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: {
        getAllFrames: vi
          .fn()
          .mockResolvedValue([
            { frameId: 0, url: "https://portal.example/unmapped" },
          ]),
      },
    });

    const result = await applyFillAcrossFrames(7, []);

    expect(sendMessage).toHaveBeenCalledWith(
      7,
      { type: "APPLY_FILL", instructions: [] },
      { frameId: 0 },
    );
    expect(result.pageFields).toBe(48);
  });

  it("stops after invalidation during a delayed frame response and clears late writes", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let cancelled = false;
    const appliedFrames: number[] = [];
    const clearedFrames: number[] = [];
    const sendMessage = vi
      .fn()
      .mockImplementation(
        async (
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
                writes: [
                  {
                    selector: message.instructions?.[0]?.selector ?? "#missing",
                    kind: "ai",
                    token: "provider.npi",
                    confidence: 0.95,
                  },
                ],
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
        },
      );
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([
          { frameId: 0, url: "https://portal.example/form" },
          { frameId: 3, url: "https://portal.example/embedded" },
        ]),
      },
    });
    const first: FillInstruction = {
      mapId: "ai:#npi",
      label: "#npi",
      selector: "#npi",
      selectorFallbacks: [],
      fieldType: "text",
      value: "123",
      pageStep: null,
      kind: "ai",
      token: "provider.npi",
      confidence: 0.95,
    };
    const second: FillInstruction = {
      ...first,
      mapId: "ai:#state",
      label: "#state",
      selector: "#state",
    };
    const npiControl: ControlSummary = {
      selector: "#npi",
      label: "NPI",
      controlType: "text",
    };
    const stateControl: ControlSummary = {
      selector: "#state",
      label: "State",
      controlType: "text",
    };
    const lifecycle = {
      isCancelled: () => cancelled,
      validate: async () => {
        if (cancelled) throw new Error("context changed");
      },
      onDispatch: vi.fn(),
    };
    const pending = applyAiFillAcrossBoundFrames(
      7,
      "scan-race",
      "fill-race",
      [
        {
          frameId: 0,
          url: "https://portal.example/form",
          controls: [npiControl],
        },
        {
          frameId: 3,
          url: "https://portal.example/embedded",
          controls: [stateControl],
        },
      ],
      [first, second],
      lifecycle,
    );

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
