import { readFileSync } from "node:fs";
import { createContext, runInContext, type Context } from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { matchPortalByUrl, portalMappingState } from "../shared/portals";
import type { PortalMappingMetadata, PortalRegistryRow } from "../shared/apiTypes";
import { workFormUrlMatchesPage } from "../shared/workContext";

// Execute the unchanged entry-point functions/listeners with controlled DOM,
// network timing, and selection state. No copied implementation or source-text
// expectation: the oracles assert the documented selection safety contract.
const source = readFileSync("src/sidepanel/main.ts", "utf8");
const tree = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
function code(names: string[], listenerTargets: string[] = []) {
  const selected = tree.statements.filter((node) => {
    if (ts.isFunctionDeclaration(node)) return names.includes(node.name?.text ?? "");
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
    return listenerTargets.some((target) => (node.expression as ts.CallExpression).expression.getText(tree) === `${target}.addEventListener`);
  }).map((node) => node.getText(tree)).join("\n");
  return ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}

describe("fill selection safety", () => {
  it("uses webNavigation main-frame URL for Work while preserving legacy tabs.url", async () => {
    const getFrame = vi.fn(async () => ({ url: "https://portal.example/form?payer=A" }));
    const scope = createContext({ chrome: { webNavigation: { getFrame } } });
    runInContext(code(["activePageUrlForTab"]), scope);

    await expect(runInContext('activePageUrlForTab({ id: 7 }, true)', scope))
      .resolves.toBe("https://portal.example/form?payer=A");
    await expect(runInContext('activePageUrlForTab({ id: 7, url: "https://legacy.example/form" }, false)', scope))
      .resolves.toBe("https://legacy.example/form");
    expect(getFrame).toHaveBeenCalledOnce();
    expect(getFrame).toHaveBeenCalledWith({ tabId: 7, frameId: 0 });
  });

  it("detects a bound Work page from webNavigation when tabs.Tab.url is hidden", async () => {
    const record = {
      tuple: { launchReceiptId: "receipt", portalKey: "portal", mappingGeneration: 1 },
      boundTabId: 7,
      formOrigin: "https://portal.example",
      formPath: "/form",
    };
    const getFrame = vi.fn(async () => ({ url: "https://portal.example/form?payer=A" }));
    const scope = createContext({
      chrome: { webNavigation: { getFrame } },
      panelMode: "case",
      activeWorkState: { status: "active", record },
      queryActiveTab: async () => ({ id: 7 }),
      workFormUrlMatchesPage,
      portalRows: [], sharedPortalRows: [],
      portal: null, portalTabId: null,
      detectedPageUrl: null, detectedPortalIdentity: null,
      invalidateFillSelection: vi.fn(),
      updateFillReady: vi.fn(), renderActiveCases: vi.fn(), renderCapture: vi.fn(),
      renderCaqh: vi.fn(), refreshPortalAccessPrompt: vi.fn(),
    });
    runInContext(code(["activePageUrlForTab", "activeWorkRecordForTab", "matchedActiveWorkPortal", "detectPortal"]), scope);

    await runInContext("detectPortal()", scope);

    expect(runInContext("detectedPageUrl", scope)).toBe("https://portal.example/form?payer=A");
    expect(runInContext("portalTabId", scope)).toBe(7);
    expect(runInContext("portal", scope)).toMatchObject({ key: "portal", mappingGeneration: 1 });
    expect(getFrame).toHaveBeenCalledWith({ tabId: 7, frameId: 0 });
  });

  it.each([false, true])("sends initial profile context without borrowing the previous location state (handoff: %s)", async (handoff) => {
    const dom = new JSDOM('<select id="facility"></select>');
    const sendToBackground = vi.fn<(request: unknown) => Promise<unknown>>(async () => ({ ok: true, data: {
      facilities: [{ id: "location", name: "Clinic", state: "MO" }],
      needsFacility: false, cards: {}, catalog: [],
    } }));
    const refreshFacilityCards = vi.fn();
    const scope = createContext({
      facilities: [{ id: "old-location", state: "KS" }], facilitiesLoaded: true,
      needsFacility: false, currentCatalog: [], selectedGroupId: "group-B", cases: [],
      selectedCaseId: () => null, selectedCaseState: () => "KS",
      selectedFacilityId: () => "location", isCurrent: () => true,
      facilitySelect: dom.window.document.querySelector("select"), Option: dom.window.Option,
      renderFacilityAddress: vi.fn(), updateFillReady: vi.fn(), renderIdentityGuard: vi.fn(),
      renderQuickCards: vi.fn(), refreshFacilityCards, sendToBackground,
    });
    runInContext(code(["loadFacilities"]), scope);
    await runInContext(`loadFacilities("provider", 1, {
      facilityId: "location", ${handoff ? 'caseId: "case", deferSelectionWrites: true' : ""}
    })`, scope);
    expect(sendToBackground.mock.calls[0]?.[0]).toMatchObject({
      type: "GET_PROVIDER_FACILITIES", providerId: "provider", facilityId: "location",
      caseId: handoff ? "case" : null, groupId: handoff ? undefined : "group-B",
    });
    expect(sendToBackground.mock.calls[0]?.[0]).not.toHaveProperty("state");
    expect(refreshFacilityCards).not.toHaveBeenCalled();
  });

  it("waits for case/group, then location/context, before restoring a report", async () => {
    let finishCases!: (result: unknown) => void;
    let finishFacilities!: () => void;
    let finishContext!: () => void;
    const loadCases = vi.fn(() => new Promise((resolve) => { finishCases = resolve; }));
    const loadFacilities = vi.fn(() => new Promise<void>((resolve) => { finishFacilities = resolve; }));
    const refreshCaseContext = vi.fn(() => new Promise<void>((resolve) => { finishContext = resolve; }));
    const restoreFillReport = vi.fn();
    const scope = createContext({
      facilitiesLoaded: true, fillSelectionRevision: 0, renderQuickCards: vi.fn(),
      loadCases, loadFacilities, refreshCaseContext, restoreFillReport,
      isCurrent: () => true, caseSelect: { value: "__ad_hoc__" },
    });
    runInContext(code(["loadProviderSelection"]), scope);
    const load = runInContext('loadProviderSelection("provider", 1)', scope);
    expect(loadFacilities).not.toHaveBeenCalled();
    finishCases({ status: "ok" });
    await vi.waitFor(() => expect(loadFacilities).toHaveBeenCalledOnce());
    expect(restoreFillReport).not.toHaveBeenCalled();
    finishFacilities();
    await Promise.resolve();
    expect(restoreFillReport).not.toHaveBeenCalled();
    finishContext();
    await load;
    expect(restoreFillReport).toHaveBeenCalledWith("provider", "__ad_hoc__", 1);
  });

  it.each([
    ["__ad_hoc__", null, null, false],
    ["__ad_hoc__", "group", null, false],
    ["__ad_hoc__", null, "location", false],
    ["", "group", "location", false],
    ["__ad_hoc__", "group", "location", true],
  ])("checks explicit ad hoc choice %s, group %s, location %s", (choice, group, location, ready) => {
    const scope: Context = createContext({
      portal: { key: "portal" }, portalTabId: 7,
      detectedPageUrl: "https://portal.example/form",
      activeWorkState: { status: "none" }, activeWorkRecordForTab: () => null,
      orgResolved: () => true, selectedProviderId: () => "provider",
      facilitiesLoaded: true, needsFacility: false,
      selectedFacilityId: () => location, selectedGroupId: group,
      caseSelect: { value: choice }, AD_HOC_CASE_SELECTION: "__ad_hoc__",
      selectedCaseId: () => null, activeCaseStatus: "none", activeCase: null,
    });
    runInContext(code(["isFillReady"]), scope);
    expect(runInContext("isFillReady()", scope)).toBe(ready);
  });

  it("allows an exact Contract Work tab without borrowing a selected case", () => {
    const workRecord = {
      tuple: { ownerKind: "contract", portalKey: "portal" },
      boundTabId: 7,
    };
    const scope: Context = createContext({
      portal: { key: "portal" }, portalTabId: 7,
      detectedPageUrl: "https://portal.example/form",
      activeWorkState: { status: "active", record: workRecord },
      activeWorkRecordForTab: () => workRecord,
      orgResolved: () => true, selectedProviderId: () => "provider",
      facilitiesLoaded: true, needsFacility: false,
      selectedFacilityId: () => "location", selectedGroupId: null,
      caseSelect: { value: "" }, AD_HOC_CASE_SELECTION: "__ad_hoc__",
      selectedCaseId: () => null, activeCaseStatus: "none", activeCase: null,
    });
    runInContext(code(["isFillReady"]), scope);
    expect(runInContext("isFillReady()", scope)).toBe(true);
  });

  it("blocks legacy URL recognition while an exact Work context is revoked", () => {
    const scope: Context = createContext({
      portal: { key: "portal" }, portalTabId: 7,
      detectedPageUrl: "https://portal.example/form",
      activeWorkState: { status: "blocked", orgId: "org" },
      activeWorkRecordForTab: () => null,
      orgResolved: () => true, selectedProviderId: () => "provider",
      facilitiesLoaded: true, needsFacility: false,
      selectedFacilityId: () => "location", selectedGroupId: "group",
      caseSelect: { value: "case-id" }, AD_HOC_CASE_SELECTION: "__ad_hoc__",
      selectedCaseId: () => "case-id", activeCaseStatus: "none", activeCase: null,
    });
    runInContext(code(["isFillReady"]), scope);
    expect(runInContext("isFillReady()", scope)).toBe(false);
  });

  it.each([false, true])("discards a delayed fill after changing group (return to original: %s)", async (returnToOriginal) => {
    const dom = new JSDOM('<select id="group"><option value="A">A</option><option value="B">B</option></select><button id="fill"></button>');
    const groupSelect = dom.window.document.querySelector("select")!;
    const fillBtn = dom.window.document.querySelector("button")!;
    let finishFill!: (value: unknown) => void;
    const pendingFill = new Promise((resolve) => { finishFill = resolve; });
    const sendToBackground = vi.fn<(request: unknown) => Promise<unknown>>(() => pendingFill);
    const renderFillSummary = vi.fn();
    const clearFillResults = vi.fn();
    const scope: Context = createContext({
      groupSelect, fillBtn, selectedGroupId: "A", loadGeneration: 1, fillSelectionRevision: 0,
      isFillReady: () => true, syncSelectedGroup: async () => {},
      renderQuickCards: vi.fn(), refreshFacilityCards: vi.fn(),
      portal: null, portalTabId: null, lastFill: null, lastFillTabId: null, lastFillPageUrl: null,
      activeWorkState: { status: "none" }, activeWorkRecordForTab: () => null,
      activePageUrlForTab: async (tab: { url?: string }) => tab.url ?? null,
      matchedActiveWorkPortal: () => null,
      selectedProviderId: () => "provider", selectedCaseId: () => null,
      selectedFacilityId: () => "facility", orgResolved: () => true,
      facilitiesLoaded: true, needsFacility: false, selectedCaseState: () => "CO",
      queryActiveTab: async () => ({ id: 7, url: "https://portal.example/form" }),
      matchPortalByUrl: () => ({ key: "portal" }), portalRows: [],
      updateFillReady: vi.fn(), refreshCoverage: vi.fn(), setError: vi.fn(),
      mainError: {}, clearFillResults, fillNote: {}, canUseNano: async () => false,
      isCurrent: (generation: number) => generation === scope.loadGeneration,
      sendToBackground, renderFillSummary,
    });
    runInContext(code(["invalidateFillSelection"], ["groupSelect", "fillBtn"]), scope);
    fillBtn.click();
    await vi.waitFor(() => expect(sendToBackground).toHaveBeenCalledTimes(1));
    expect(sendToBackground.mock.calls[0]?.[0]).toMatchObject({ type: "FILL", groupId: "A" });
    groupSelect.value = "B";
    groupSelect.dispatchEvent(new dom.window.Event("change"));
    expect(scope.selectedGroupId).toBe("B");
    if (returnToOriginal) {
      groupSelect.value = "A";
      groupSelect.dispatchEvent(new dom.window.Event("change"));
    }
    finishFill({ ok: true, data: { fillSessionId: "group-A-session" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderFillSummary).not.toHaveBeenCalled();
  });

  it("pins the active-org override from same-key URL rows through AI prepare and Fill", async () => {
    const dom = new JSDOM('<button id="fill"></button>');
    const fillBtn = dom.window.document.querySelector("button")!;
    const sharedRow: PortalRegistryRow = {
      id: "shared-config", orgId: null, portalKey: "legacy-enrollment", name: "A Shared Portal",
      payerId: null, caseType: "enrollment", mappingGeneration: 1, formUrl: "https://portal.example/form",
      isVerified: true, lastVerifiedAt: null, provenAt: null, urlChangedAt: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    };
    const orgRow: PortalRegistryRow = {
      ...sharedRow, id: "org-config", orgId: "active-org", name: "Z Organization Portal", mappingGeneration: 4,
    };
    const portalRows = [sharedRow, orgRow];
    const selectedMapMetadata: PortalMappingMetadata[] = [{
      portal_key: "legacy-enrollment", portal_id: "org-config", case_type: "enrollment",
      requires_explicit_selection: false, mapping_generation: 4, active_field_count: 2,
      mapping_ready: true, is_verified: true, effective_mapping_fingerprint: "sha256:org-map",
    }];
    const matchedPortal = matchPortalByUrl("https://portal.example/form/step?session=1", portalRows);
    expect(matchedPortal).toMatchObject({ portalId: "org-config", key: "legacy-enrollment", mappingGeneration: 4 });
    expect(portalMappingState(selectedMapMetadata, {
      portalId: matchedPortal!.portalId,
      portalKey: matchedPortal!.key,
      mappingGeneration: matchedPortal!.mappingGeneration,
    })).toBe("ready");

    const requests: Array<Record<string, unknown>> = [];
    const sendToBackground = vi.fn(async (request: Record<string, unknown>) => {
      requests.push(request);
      if (request.type === "PREPARE_AI_FILL") {
        return { ok: true, data: { scanId: "scan-org", controls: [], tokenCatalog: [], unprocessedControls: 0 } };
      }
      if (request.type === "FILL") return { ok: true, data: { fillSessionId: "fill-org" } };
      return { ok: true, data: null };
    });
    const scope: Context = createContext({
      fillBtn, selectedGroupId: "group", loadGeneration: 1, fillSelectionRevision: 0,
      isFillReady: () => true, syncSelectedGroup: async () => {}, clearFillResults: vi.fn(),
      portal: null, portalTabId: null, lastFill: null, lastFillTabId: null, lastFillPageUrl: null,
      activeWorkState: { status: "none" }, activeWorkRecordForTab: () => null,
      activePageUrlForTab: async (tab: { url?: string }) => tab.url ?? null,
      matchedActiveWorkPortal: () => null,
      selectedProviderId: () => "provider", selectedCaseId: () => null,
      selectedFacilityId: () => "facility", orgResolved: () => true,
      facilitiesLoaded: true, needsFacility: false, selectedCaseState: () => "CO",
      queryActiveTab: async () => ({ id: 7, url: "https://portal.example/form/step?session=1" }),
      matchPortalByUrl, portalRows,
      updateFillReady: vi.fn(), refreshCoverage: vi.fn(), setError: vi.fn(),
      mainError: {}, fillNote: {}, canUseNano: async () => true,
      NANO_LIMITS: { maxControls: 40 }, matchUnmappedFields: async () => [],
      isCurrent: (generation: number) => generation === scope.loadGeneration,
      sendToBackground, renderFillSummary: vi.fn(),
    });

    runInContext(code(["invalidateFillSelection"], ["fillBtn"]), scope);
    fillBtn.click();
    await vi.waitFor(() => expect(requests.some((request) => request.type === "FILL")).toBe(true));
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "PREPARE_AI_FILL", portalId: "org-config", portalKey: "legacy-enrollment", mappingGeneration: 4,
      }),
      expect.objectContaining({
        type: "FILL", portalId: "org-config", portalKey: "legacy-enrollment", mappingGeneration: 4,
      }),
    ]));
  });

  it.each([null, "MO"])("uses the selected location state (%s) without guessing the home state", (state) => {
    const scope: Context = createContext({
      cases: [], selectedCaseId: () => null,
      facilities: [{ id: "missouri-location", name: "Missouri Clinic", state }],
      selectedFacilityId: () => "missouri-location",
      providers: [{ id: "provider", homeState: "KS" }],
      selectedProviderId: () => "provider",
    });
    runInContext(code(["selectedCaseState"]), scope);
    expect(runInContext("selectedCaseState()", scope)).toBe(state ?? "");
  });
});
