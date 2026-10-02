import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalFieldMap, PortalMappingMetadata, ProviderProfileResponse } from "../shared/apiTypes";
import type { FillPageResult } from "../shared/fill";
import type { ControlSummary } from "../shared/nanoAi";
import { createFillEventV2OpaqueKey } from "../shared/fillEventV2";
import { canonicalizeWorkContextTuple } from "../shared/workContext";

const mocks = vi.hoisted(() => ({
  getPortalFieldMaps: vi.fn(),
  getPortalFieldMapsWithMeta: vi.fn(),
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

const {
  fillPortal,
  prepareAiFillPortal,
  invalidatePendingAiScans,
  invalidateAiFillStateForConfiguration,
  PortalConfigurationValidationError,
  readActiveAiReview,
} = await import("./fill");

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

function attemptedUnverifiedOutcome(mapId: string | null) {
  return {
    mapId,
    targetKey: createFillEventV2OpaqueKey("t"),
    frameKey: createFillEventV2OpaqueKey("f"),
    stepKey: null,
    attempted: true,
    outcome: "unverified" as const,
    reasonCode: "readback_unavailable" as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPortalFieldMaps.mockResolvedValue([]);
  mocks.getPortalFieldMapsWithMeta.mockResolvedValue({
    maps: [], fillEventV2: false, portalMappings: [],
  });
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
  it("retains attempted-label summary and value-free V2 telemetry for an unverified static text write", async () => {
    const mapId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const outcome = attemptedUnverifiedOutcome(mapId);
    mocks.applyFillAcrossFrames.mockResolvedValue({
      ...pageResult([{ selector: "#synthetic-text" }]),
      attemptedLabels: ["Synthetic text field"],
      fieldOutcomes: [outcome],
    });

    const summary = await fillPortal(request, {
      maps: [{ ...portalMap("#synthetic-text"), id: mapId }],
      fillEventV2: true,
    });

    const event = mocks.postFillEvent.mock.calls[0]?.[0];
    expect(summary).toMatchObject({
      filled: 1,
      fieldsAttempted: 1,
      fieldsVerified: 0,
      fieldsRejected: 0,
      attemptedLabels: ["Synthetic text field"],
      fieldOutcomes: [outcome],
      telemetry: {
        schemaVersion: 2,
        fieldsAttempted: 1,
        fieldsVerified: 0,
        fieldsRejected: 0,
      },
    });
    expect(event).toMatchObject({
      fieldsFilled: 0,
      v2: {
        schemaVersion: 2,
        fieldsAttempted: 1,
        fieldsVerified: 0,
        fieldsRejected: 0,
        fieldOutcomes: [outcome],
      },
    });
    expect(event.v2).not.toHaveProperty("attemptedLabels");
    const wireTelemetry = JSON.stringify(event.v2);
    for (const privateDetail of ["Synthetic text field", "#synthetic-text", "provider.npi", "1234567890"]) {
      expect(wireTelemetry).not.toContain(privateDetail);
    }
  });

  it("combines static and AI attempted outcomes without sending labels or selectors", async () => {
    const staticMapId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const staticOutcome = attemptedUnverifiedOutcome(staticMapId);
    const aiOutcome = attemptedUnverifiedOutcome(null);
    const mapped = { ...portalMap("#static-text"), id: staticMapId };
    const guard = {
      orgId: "org-1", revision: 1, selectionRevision: 1,
      tabUrl: "https://portal.example/form", validate: vi.fn(),
    };
    const prepared = await prepareAiFillPortal(request, guard, {
      maps: [mapped], fillEventV2: true,
    });
    mocks.applyFillAcrossFrames.mockResolvedValue({
      ...pageResult([{ selector: "#static-text" }]),
      attemptedLabels: ["Synthetic static field"],
      fieldOutcomes: [staticOutcome],
    });
    mocks.applyAiFillAcrossBoundFrames.mockResolvedValue({
      ...pageResult([{ selector: "#npi", kind: "ai", token: "provider.npi", confidence: 0.91 }]),
      attemptedLabels: ["Synthetic AI field"],
      fieldOutcomes: [aiOutcome],
    });

    const summary = await fillPortal(request, {
      scanId: prepared.scanId,
      candidates: [{ selector: "#npi", token: "provider.npi", confidence: 0.91 }],
    });

    const event = mocks.postFillEvent.mock.calls[0]?.[0];
    expect(summary).toMatchObject({
      fieldsAttempted: 2,
      fieldsVerified: 0,
      attemptedLabels: ["Synthetic static field", "Synthetic AI field"],
      fieldOutcomes: [staticOutcome, aiOutcome],
    });
    expect(event).toMatchObject({
      fieldsFilled: 0,
      v2: { fieldsAttempted: 2, fieldsVerified: 0, fieldOutcomes: [staticOutcome, aiOutcome] },
    });
    const wireTelemetry = JSON.stringify(event.v2);
    for (const privateDetail of ["Synthetic static field", "Synthetic AI field", "#static-text", "#npi", "provider.npi"]) {
      expect(wireTelemetry).not.toContain(privateDetail);
    }
  });

  it("records a value-free canonical Work tuple with forced V2 telemetry and the successful fill id", async () => {
    const tuple = {
      protocolVersion: 2 as const,
      launchReceiptId: "11111111-1111-4111-8111-111111111111",
      ownerKind: "case" as const,
      ownerId: "22222222-2222-4222-8222-222222222222",
      contextVersion: 4,
      sopTemplateId: "33333333-3333-4333-8333-333333333333",
      sopVersion: 3,
      portalId: "44444444-4444-4444-8444-444444444444",
      portalKey: "known-portal",
      mappingGeneration: 2,
      effectiveMappingFingerprint: `sha256:${"a".repeat(64)}`,
      providerId: "55555555-5555-4555-8555-555555555555",
      orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      facilityId: null,
      taskId: "66666666-6666-4666-8666-666666666666",
      stepId: "77777777-7777-4777-8777-777777777777",
      stepIdentity: "case:task-1:step-2",
    };
    const canonical = canonicalizeWorkContextTuple(tuple);
    const workRequest = { ...request, caseId: tuple.ownerId, providerId: tuple.providerId, facilityId: null };
    mocks.applyFillAcrossFrames.mockResolvedValue(pageResult([{ selector: "#npi", kind: "static" }]));

    const summary = await fillPortal(workRequest, {
      maps: [portalMap("#npi")],
      fillEventV2: true,
      workContext: tuple,
      workCaseType: "enrollment",
    });

    expect(mocks.postFillEvent).toHaveBeenCalledTimes(1);
    const event = mocks.postFillEvent.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      id: summary.fillSessionId,
      caseId: tuple.ownerId,
      providerId: tuple.providerId,
      workContext: canonical,
      v2: { schemaVersion: 2 },
    });
    expect(event.workContext).not.toHaveProperty("protocolVersion");
    expect(summary).toMatchObject({
      eventRecorded: true,
      workContext: canonical,
      workCaseType: "enrollment",
    });
    expect(JSON.stringify(summary)).not.toContain("1234567890");
  });

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
    mocks.getPortalFieldMapsWithMeta.mockResolvedValue({
      maps: [mapped], fillEventV2: false, portalMappings: [],
    });
    mocks.applyFillAcrossFrames.mockResolvedValue(pageResult([
      { selector: "#static-npi", kind: "static" },
    ]));

    const summary = await fillPortal(request, { aiStatus: "unavailable", orgId: "org-1" });

    expect(mocks.applyFillAcrossFrames).toHaveBeenCalledWith(request.tabId, [expect.objectContaining({ selector: "#static-npi", value: "1234567890" })], expect.any(Function));
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
    const staticMapId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const staticOutcome = attemptedUnverifiedOutcome(staticMapId);
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
    }, {
      maps: [{ ...portalMap("#static-text"), id: staticMapId }],
      fillEventV2: true,
    });
    mocks.applyFillAcrossFrames.mockResolvedValue({
      ...pageResult([{ selector: "#static-text" }]),
      attemptedLabels: ["Synthetic static field"],
      fieldOutcomes: [staticOutcome],
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
    expect(summary).toMatchObject({
      filled: 1,
      staticFilled: 1,
      fieldsAttempted: 1,
      fieldsVerified: 0,
      attemptedLabels: ["Synthetic static field"],
      fieldOutcomes: [staticOutcome],
    });
    expect(readActiveAiReview(summary.fillSessionId ?? "missing")).toBeNull();
  });

  it("keeps a prepared review offline, then invalidates it after a confirmed reset on reconnect", async () => {
    const target = {
      ...request,
      portalId: "portal-config-1",
      mappingGeneration: 2,
    };
    const guard = {
      orgId: "org-1",
      revision: 1,
      selectionRevision: 1,
      tabUrl: "https://portal.example/form",
      validate: vi.fn(),
      validateConfiguration: vi.fn(async (expectedFingerprint?: string, known?: PortalMappingMetadata[] | null) => {
        let current: PortalMappingMetadata[];
        try {
          current = known ?? (await mocks.getPortalFieldMapsWithMeta(target.portalKey)).portalMappings;
        } catch {
          throw new PortalConfigurationValidationError(
            "Reconnect to Minted Panel to verify this form configuration before filling.",
          );
        }
        const row = current[0];
        if (!row) throw new Error("The exact form configuration metadata is missing.");
        if (row?.portal_id !== target.portalId || row?.mapping_generation !== target.mappingGeneration ||
          (expectedFingerprint != null && row?.effective_mapping_fingerprint !== expectedFingerprint)) {
          await invalidateAiFillStateForConfiguration({
            portalId: target.portalId,
            portalKey: target.portalKey,
            mappingGeneration: target.mappingGeneration,
          });
          throw new PortalConfigurationValidationError("This form configuration changed or was reset.");
        }
        return String(row.effective_mapping_fingerprint);
      }),
    };

    const staleMetadata = [{
      portal_key: target.portalKey,
      portal_id: target.portalId,
      mapping_generation: 2,
      active_field_count: 1,
      mapping_ready: true,
      effective_mapping_fingerprint: "sha256:before-reset",
    }];
    mocks.getPortalFieldMapsWithMeta.mockResolvedValueOnce({
      maps: [portalMap("#npi")], fillEventV2: false, portalMappings: staleMetadata,
    }).mockResolvedValueOnce({
      maps: [], fillEventV2: false, portalMappings: staleMetadata,
    });
    const prepared = await prepareAiFillPortal(target, guard);
    const fill = () => fillPortal(target, {
      scanId: prepared.scanId,
      candidates: [{ selector: "#npi", token: "provider.npi", confidence: 0.91 }],
      validateConfiguration: guard.validateConfiguration,
    });

    mocks.getPortalFieldMapsWithMeta.mockRejectedValueOnce(new Error("offline"));
    await expect(fill()).rejects.toThrow("Reconnect to Minted Panel");
    expect(mocks.clearAiScanAcrossFrames).not.toHaveBeenCalled();
    expect(mocks.applyFillAcrossFrames).not.toHaveBeenCalled();
    expect(mocks.applyAiFillAcrossBoundFrames).not.toHaveBeenCalled();

    mocks.getPortalFieldMapsWithMeta.mockResolvedValueOnce({
      maps: [], fillEventV2: false,
      portalMappings: [{ ...staleMetadata[0], mapping_generation: 3, effective_mapping_fingerprint: "sha256:after-reset" }],
    });
    await expect(fill()).rejects.toThrow("changed or was reset");
    expect(mocks.clearAiScanAcrossFrames).toHaveBeenCalledWith(target.tabId, prepared.scanId, [0]);
    expect(mocks.applyFillAcrossFrames).not.toHaveBeenCalled();
    expect(mocks.applyAiFillAcrossBoundFrames).not.toHaveBeenCalled();
  });

  it("invalidates a reset configuration's prepared scan without clearing a same-URL sibling", async () => {
    const sharedUrl = "https://portal.example/form";
    const first = { ...request, portalId: "config-a", mappingGeneration: 1 };
    const sibling = { ...request, portalId: "config-b", portalKey: "sibling", mappingGeneration: 1 };
    mocks.getPortalFieldMapsWithMeta.mockImplementation(async (portalKey: string) => ({
      maps: [],
      fillEventV2: false,
      portalMappings: [{
        portal_key: portalKey,
        portal_id: portalKey === first.portalKey ? first.portalId : sibling.portalId,
        case_type: null,
        requires_explicit_selection: false,
        mapping_generation: 1,
        active_field_count: 1,
        mapping_ready: true,
        is_verified: true,
        effective_mapping_fingerprint: `sha256:${portalKey}`,
      }],
    }));
    const guard = { orgId: "org-1", revision: 1, selectionRevision: 1, tabUrl: sharedUrl, validate: vi.fn() };
    const firstScan = await prepareAiFillPortal(first, guard);
    const siblingScan = await prepareAiFillPortal(sibling, guard);

    await invalidateAiFillStateForConfiguration({
      portalId: first.portalId!,
      portalKey: first.portalKey,
      mappingGeneration: first.mappingGeneration!,
    });

    expect(mocks.clearAiScanAcrossFrames).toHaveBeenCalledWith(first.tabId, firstScan.scanId, [0]);
    expect(mocks.clearAiScanAcrossFrames).not.toHaveBeenCalledWith(sibling.tabId, siblingScan.scanId, [0]);
    await expect(fillPortal(sibling, {
      scanId: siblingScan.scanId,
      candidates: [],
    })).resolves.toBeDefined();
  });

  it("keeps legacy generation-one mappings fillable when the exact metadata matches", async () => {
    const legacy = { ...request, portalId: "legacy-config", mappingGeneration: 1 };
    const metadata = [{
      portal_key: legacy.portalKey,
      portal_id: legacy.portalId,
      mapping_generation: 1,
      active_field_count: 1,
      mapping_ready: true,
      effective_mapping_fingerprint: "sha256:legacy",
    }];
    const validateConfiguration = vi.fn(async (expectedFingerprint?: string, known?: PortalMappingMetadata[] | null) => {
      const row = known?.[0] ?? metadata[0];
      if (!row) throw new Error("The exact legacy configuration metadata is missing.");
      if (row.portal_id !== legacy.portalId || row.mapping_generation !== legacy.mappingGeneration ||
        (expectedFingerprint != null && row.effective_mapping_fingerprint !== expectedFingerprint)) {
        throw new Error("The legacy configuration changed.");
      }
      return String(row.effective_mapping_fingerprint);
    });
    mocks.getPortalFieldMapsWithMeta.mockResolvedValue({
      maps: [portalMap("#static-npi")], fillEventV2: false, portalMappings: metadata,
    });
    mocks.applyFillAcrossFrames.mockResolvedValue(pageResult([{ selector: "#static-npi", kind: "static" }]));

    const summary = await fillPortal(legacy, { aiStatus: "unavailable", validateConfiguration });

    expect(summary.staticFilled).toBe(1);
    expect(validateConfiguration).toHaveBeenCalledWith("sha256:legacy");
    expect(mocks.postFillEvent).toHaveBeenCalledTimes(1);
  });
});
