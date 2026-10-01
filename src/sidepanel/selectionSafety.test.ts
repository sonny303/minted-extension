import { readFileSync } from "node:fs";
import { createContext, runInContext, type Context } from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

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
