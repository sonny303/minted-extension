import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFillEventV2OpaqueKey } from "../shared/fillEventV2";
import type { PortalFieldMap } from "../shared/apiTypes";

const mocks = vi.hoisted(() => ({
  listSharedFieldMapsWithMeta: vi.fn(),
  postSharedTestFill: vi.fn(),
  listTabFrames: vi.fn(),
  sendToFrame: vi.fn(),
  applyFillAcrossFrames: vi.fn(),
}));

vi.mock("./api", () => ({
  listSharedFieldMapsWithMeta: mocks.listSharedFieldMapsWithMeta,
  postSharedTestFill: mocks.postSharedTestFill,
}));
vi.mock("./frameMessaging", () => ({
  listTabFrames: mocks.listTabFrames,
  sendToFrame: mocks.sendToFrame,
  applyFillAcrossFrames: mocks.applyFillAcrossFrames,
}));

const map: PortalFieldMap = {
  id: "4f0d6e10-4f6f-4a7d-8d80-5a3a16ea4e73",
  orgId: null,
  portalKey: "synthetic",
  urlPattern: null,
  pageStep: null,
  mapType: "web",
  selector: "#synthetic-id",
  selectorFallbacks: null,
  source: "token",
  token: "provider.firstName",
  hardcodedValue: null,
  transform: null,
  fieldType: "text",
  notes: null,
  status: "approved",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("fillMockPortal local truth with a V1 server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSharedFieldMapsWithMeta.mockResolvedValue({ maps: [map], fillEventV2: false });
    mocks.postSharedTestFill.mockResolvedValue("fill-session-id");
    mocks.listTabFrames.mockResolvedValue([{ frameId: 0, url: "" }]);
    mocks.sendToFrame.mockResolvedValue({ ok: true });
    mocks.applyFillAcrossFrames.mockResolvedValue({
      filled: ["Synthetic identifier"],
      attemptedLabels: ["Synthetic identifier"],
      skipped: [{
        label: "Sensitive-shaped label",
        reason: "form context could not be checked because raw-value-secret appeared",
        mapId: map.id,
        kind: "unverified",
      }],
      pageFields: 1,
      fieldOutcomes: [{
        mapId: map.id,
        targetKey: createFillEventV2OpaqueKey("t"),
        frameKey: createFillEventV2OpaqueKey("f"),
        stepKey: null,
        attempted: true,
        outcome: "unverified",
        reasonCode: "readback_unavailable",
      }],
    });
  });

  it("keeps local attempts and the legacy no-evidence projection independent of capability", async () => {
    const { fillMockPortal } = await import("./mockFill");
    const summary = await fillMockPortal({ tabId: 1, portalKey: "synthetic", orgId: null });

    expect(mocks.applyFillAcrossFrames).toHaveBeenCalledWith(1, expect.any(Array), { captureV2: true });
    expect(summary).toMatchObject({
      fieldsAttempted: 1,
      fieldsVerified: 0,
      attemptedLabels: ["Synthetic identifier"],
      notChecked: [{ kind: "unverified" }],
    });
    expect(summary.pass).toBe(false);
    const payload = mocks.postSharedTestFill.mock.calls[0]?.[0];
    expect(payload.fieldsFilled).toBe(1); // V1 historical successful-setter count.
    expect(payload.fieldsSkipped).toEqual([{
      label: "Sensitive-shaped label",
      reason: "field could not be verified; review it on the portal",
      mapId: map.id,
      kind: "hidden",
    }]);
    expect(JSON.stringify(payload)).not.toContain("raw-value-secret");
  });
});
