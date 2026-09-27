import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalFieldMap, ProviderProfileResponse } from "../shared/apiTypes";
import type { FillPageResult } from "../shared/fill";
import type { ControlSummary } from "../shared/nanoAi";

const mocks = vi.hoisted(() => ({
  getPortalFieldMaps: vi.fn(),
  getProviderProfile: vi.fn(),
  getViewPrefs: vi.fn(),
  postFillEvent: vi.fn(),
  postSharedTestFill: vi.fn(),
  scanUnmappedControlsAcrossFrames: vi.fn(),
  clearAiScanAcrossFrames: vi.fn(),
  listTabFrames: vi.fn(),
  sendToFrame: vi.fn(),
  applyFillAcrossFrames: vi.fn(),
  applyAiFillAcrossBoundFrames: vi.fn(),
  clearAiFillAcrossFrames: vi.fn(),
}));

vi.mock("./api", () => ({
  ...mocks,
  ApiError: class ApiError extends Error { status = 500; },
}));
vi.mock("./frameMessaging", () => ({
  ...mocks,
  acceptAiFillAcrossFrames: vi.fn(),
}));

const { fillPortal, prepareAiFillPortal, invalidatePendingAiScans, readActiveAiReview } = await import("./fill");

const request = {
  tabId: 7,
  providerId: "provider-1",
  caseId: "case-1",
  portalKey: "known-portal",
  state: "CO",
  facilityId: "facility-1",
};
const control: ControlSummary = { selector: "#npi", label: "NPI", controlType: "text" };
const profile: ProviderProfileResponse = {
  provider: { id: "provider-1" },
  tokens: [{ token: "provider.npi", value: "1234567890" }],
  unresolved: [],
  facilities: [],
  selected_facility_id: "facility-1",
};

function portalMap(selector: string): PortalFieldMap {
  return {
    id: "map-1", orgId: "org-1", portalKey: "known-portal", urlPattern: null,
    pageStep: null, mapType: "web", selector, selectorFallbacks: null,
    source: "token", token: "provider.npi", hardcodedValue: null, transform: null,
    fieldType: "text", notes: null, status: "approved",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

function pageResult(instructions: Array<{ selector: string; kind?: string; token?: string; confidence?: number }>): FillPageResult {
  return {
    filled: instructions.map((item) => item.selector),
    writes: instructions.map((item) => ({
      selector: item.selector,
      kind: item.kind === "ai" ? "ai" as const : "static" as const,
      ...(item.token ? { token: item.token, confidence: item.confidence } : {}),
    })),
    skipped: [],
    pageFields: instructions.length,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPortalFieldMaps.mockResolvedValue([]);
  mocks.getProviderProfile.mockResolvedValue({ profile });
  mocks.getViewPrefs.mockResolvedValue({
    fields: null,
    catalog: [{ key: "provider.npi", label: "NPI", group: "provider", groupLabel: "Provider" }],
  });
  mocks.postFillEvent.mockResolvedValue(undefined);
  mocks.scanUnmappedControlsAcrossFrames.mockImplementation(async (_tabId, _scanId, activeMaps) => ({
    controls: [control],
    ambiguousSelectors: [],
    frames: [{ frameId: 0, url: "https://portal.example/form?person=private#step", controls: [control] }],
    activeMaps,
  }));
  mocks.listTabFrames.mockResolvedValue([{ frameId: 0, url: "https://portal.example/form" }]);
  mocks.sendToFrame.mockResolvedValue({ ok: true });
  mocks.applyFillAcrossFrames.mockResolvedValue(pageResult([]));
  mocks.applyAiFillAcrossBoundFrames.mockImplementation(async (_tabId, _scanId, _sessionId, _frames, instructions) => pageResult(instructions));
  mocks.clearAiFillAcrossFrames.mockResolvedValue(0);
});

afterEach(() => vi.clearAllMocks());

describe("local AI fill orchestration", () => {
  it("scans a recognized zero-map portal and writes the valid suggestion in the single fill log", async () => {
    const guard = { orgId: "org-1", revision: 1, selectionRevision: 1, tabUrl: "https://portal.example/form", validate: vi.fn() };
    const prepared = await prepareAiFillPortal(request, guard);

    expect(mocks.scanUnmappedControlsAcrossFrames).toHaveBeenCalledWith(request.tabId, prepared.scanId, []);
    expect(prepared.controls).toEqual([control]);

    const summary = await fillPortal(request, {
      scanId: prepared.scanId,
      candidates: [{ selector: "#npi", token: "provider.npi", confidence: 0.91 }],
      orgId: "org-1",
    });

    expect(mocks.applyAiFillAcrossBoundFrames).toHaveBeenCalledWith(
      request.tabId,
      prepared.scanId,
      expect.any(String),
      prepared.controls.length ? [{ frameId: 0, url: "https://portal.example/form?person=private#step", controls: [control] }] : [],
      [expect.objectContaining({ selector: "#npi", value: "1234567890", kind: "ai" })],
      expect.objectContaining({
        isCancelled: expect.any(Function),
        validate: expect.any(Function),
        onDispatch: expect.any(Function),
      }),
    );
    expect(mocks.postFillEvent).toHaveBeenCalledTimes(1);
    expect(mocks.postFillEvent.mock.calls[0]?.[0]).toMatchObject({ fieldsFilled: 1, caseId: "case-1", providerId: "provider-1" });
    expect(summary).toMatchObject({ filled: 1, staticFilled: 0, aiFilled: 1, orgId: "org-1", facilityId: "facility-1" });
    expect(summary.aiReview?.writes).toEqual([{
      selector: "#npi", token: "provider.npi", confidence: 0.91,
      fieldType: "text", pageUrl: "https://portal.example/form",
    }]);
  });

  it("rejects forged selectors, tokens, and low-confidence suggestions before any page write", async () => {
    const prepared = await prepareAiFillPortal(request, {
      orgId: "org-1", revision: 1, selectionRevision: 1, tabUrl: "https://portal.example/form", validate: vi.fn(),
    });

    await expect(fillPortal(request, {
      scanId: prepared.scanId,
      candidates: [{ selector: "#other", token: "provider.npi", confidence: 0.99 }],
    })).rejects.toThrow("Invalid AI field suggestions");
    expect(mocks.applyFillAcrossFrames).not.toHaveBeenCalled();
    expect(mocks.applyAiFillAcrossBoundFrames).not.toHaveBeenCalled();
    expect(mocks.postFillEvent).not.toHaveBeenCalled();
  });

  it("uses static fills when Nano is unavailable and records zero AI writes honestly", async () => {
    const mapped = portalMap("#static-npi");
    mocks.getPortalFieldMaps.mockResolvedValue([mapped]);
    mocks.applyFillAcrossFrames.mockResolvedValue(pageResult([
      { selector: "#static-npi", kind: "static" },
    ]));

    const summary = await fillPortal(request, { aiStatus: "unavailable", orgId: "org-1" });

    expect(mocks.applyFillAcrossFrames).toHaveBeenCalledWith(request.tabId, [expect.objectContaining({ selector: "#static-npi", value: "1234567890" })]);
    expect(mocks.applyAiFillAcrossBoundFrames).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ filled: 1, staticFilled: 1, aiFilled: 0, aiReview: { status: "unavailable", writes: [] } });
    expect(mocks.postFillEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects stale context after scanning before any fill is applied", async () => {
    const validate = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("selection changed"));
    const prepared = await prepareAiFillPortal(request, {
      orgId: "org-1", revision: 1, selectionRevision: 1, tabUrl: "https://portal.example/form", validate,
    }).catch(() => null);

    // A stale selection after the DOM scan prevents application and releases
    // the content-side scan references immediately.
    expect(prepared).toBeNull();
    expect(mocks.scanUnmappedControlsAcrossFrames).toHaveBeenCalledTimes(1);
    expect(mocks.clearAiScanAcrossFrames).toHaveBeenCalledTimes(1);
    expect(mocks.applyFillAcrossFrames).not.toHaveBeenCalled();
    expect(mocks.applyAiFillAcrossBoundFrames).not.toHaveBeenCalled();
  });

  it("cancels a delayed AI apply on context invalidation and never recreates a review", async () => {
    let current = true;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const validate = vi.fn(async () => {
      if (!current) throw new Error("context changed");
    });
    const prepared = await prepareAiFillPortal(request, {
      orgId: "org-1", revision: 1, selectionRevision: 1,
      tabUrl: "https://portal.example/form", validate,
    });
    mocks.applyAiFillAcrossBoundFrames.mockImplementation(async (
      _tabId,
      _scanId,
      _sessionId,
      _frames,
      instructions,
      lifecycle,
    ) => {
      lifecycle?.onDispatch(0);
      markStarted();
      await blocked;
      if (lifecycle?.isCancelled()) throw new Error("cancelled");
      return pageResult(instructions);
    });

    const pending = fillPortal(request, {
      scanId: prepared.scanId,
      candidates: [{ selector: "#npi", token: "provider.npi", confidence: 0.91 }],
    });
    await started;
    current = false;
    await invalidatePendingAiScans(request.tabId);
    release();
    const summary = await pending;

    expect(mocks.clearAiFillAcrossFrames).toHaveBeenCalledWith(request.tabId, expect.any(String), [0]);
    expect(mocks.postFillEvent).not.toHaveBeenCalled();
    expect(summary.aiReview).toBeNull();
    expect(summary.aiFilled).toBe(0);
    expect(readActiveAiReview(summary.fillSessionId ?? "missing")).toBeNull();
  });
});
