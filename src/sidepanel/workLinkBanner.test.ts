import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { caseReturnUrl } from "../shared/handoffApplication";
import type { ActiveWorkState } from "../shared/workContext";
import {
  carriedLaunchId,
  isLaunchReplacement,
  launchSwapLine,
  WORK_LINK_ENDED_LINE,
  workEndedCaseId,
  workEndedLine,
} from "../shared/workLinkNotice";

// Runs the unchanged renderHandoffBanner and refreshActiveWork from main.ts
// against a small DOM and a scripted worker, in the style of
// selectionSafety.test.ts. The copy itself is pinned in workLinkNotice.test.ts;
// this pins the wiring: which payer, which case link, and when D6 fires.
const source = readFileSync("src/sidepanel/main.ts", "utf8");
const tree = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
function code(names: string[]): string {
  const selected = tree.statements
    .filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""))
    .map((node) => node.getText(tree))
    .join("\n");
  return ts.transpileModule(selected, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}

const WEB = "https://mintedpanel.vercel.app";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_A = "22222222-2222-4222-8222-222222222222";
const CASE_B = "33333333-3333-4333-8333-333333333333";
const PROVIDER_B = "55555555-5555-4555-8555-555555555555";

function active(launchReceiptId: string, ownerId = CASE_A): ActiveWorkState {
  return {
    status: "active",
    record: {
      tuple: { launchReceiptId, ownerKind: "case", ownerId, providerId: PROVIDER_B, orgId: ORG },
      boundTabId: 7,
    } as never,
  };
}

function harness(options: {
  work: ActiveWorkState;
  selectedCaseId?: string | null;
  payer?: string;
  // What the reload after a launch change makes known.
  loaded?: { providers?: unknown[]; cases?: unknown[] };
}) {
  const dom = new JSDOM('<div id="handoff-banner" hidden></div><div id="org-switch" hidden></div>');
  const document = dom.window.document;
  const handoffBanner = document.querySelector<HTMLElement>("#handoff-banner")!;
  let nextWork: ActiveWorkState = options.work;
  const sendToBackground = vi.fn(async (request: { type: string }) =>
    request.type === "GET_PANEL_MODE" ? { ok: true, data: "case" } : { ok: true, data: nextWork });
  const scope = createContext({
    document,
    handoffBanner,
    orgSwitch: document.querySelector("#org-switch"),
    activeWorkState: options.work,
    handoffNotice: null,
    shownLaunchId: null,
    launchSwapNotice: null,
    activeCase: null,
    activeCaseStatus: "none",
    orgs: [],
    panelMode: "case",
    views: { main: { hidden: false } },
    providers: [],
    cases: [],
    caseContextCaseId: null,
    caseContextData: null,
    selectedCaseId: () => options.selectedCaseId ?? null,
    payerLabel: () => options.payer ?? "the payer",
    API_BASE_URL: WEB,
    caseReturnUrl,
    workEndedLine,
    workEndedCaseId,
    carriedLaunchId,
    isLaunchReplacement,
    launchSwapLine,
    sendToBackground,
    applyPanelMode: vi.fn(),
    bumpGeneration: () => 1,
    loadOrgs: vi.fn(async () => {
      if (options.loaded?.providers) scope.providers = options.loaded.providers;
      if (options.loaded?.cases) scope.cases = options.loaded.cases;
    }),
    refreshActiveCase: vi.fn(async () => {}),
    // B1 "opening the case" wrapper: runs the reload as-is here.
    whileWorkOpens: async (work: () => Promise<void>) => work(),
    detectPortal: vi.fn(async () => {}),
    updateFillReady: vi.fn(),
  });
  runInContext(code([
    "renderHandoffBanner", "bannerButton", "externalLink", "caseUrl",
    "refreshActiveWork", "launchSwapNames", "activeWorkStateIdentity",
  ]), scope);
  return {
    banner: handoffBanner,
    render: () => runInContext("renderHandoffBanner()", scope),
    // One ACTIVE_WORK_UPDATED refresh that reads `work` from the worker.
    refresh: async (work: ActiveWorkState) => {
      nextWork = work;
      await runInContext("refreshActiveWork()", scope);
    },
    text: () => handoffBanner.querySelector("span")?.textContent ?? null,
    link: () => handoffBanner.querySelector<HTMLAnchorElement>("a"),
  };
}

const blocked = (extra: Record<string, unknown>): ActiveWorkState =>
  ({ status: "blocked", orgId: ORG, ...extra }) as ActiveWorkState;

describe("D5: the banner says why the Work link ended", () => {
  it("names the selected case's payer and links back to the ended case", () => {
    const h = harness({
      work: blocked({ reason: "tab_closed", ownerKind: "case", ownerId: CASE_A }),
      selectedCaseId: CASE_A,
      payer: "Aetna",
    });
    h.render();
    expect(h.banner.hidden).toBe(false);
    expect(h.banner.classList.contains("banner-warn")).toBe(true);
    expect(h.text()).toBe("The Aetna tab was closed. Click Work in portal again.");
    expect(h.link()?.textContent).toBe("Back to case ↗");
    expect(h.link()?.href).toBe(caseReturnUrl(WEB, CASE_A));
    expect(h.link()?.target).toBe("_blank");
  });

  it("says payer when the selected case is not the one that ended, and still links the ended case", () => {
    const h = harness({
      work: blocked({ reason: "left_site", ownerKind: "case", ownerId: CASE_A }),
      selectedCaseId: CASE_B,
      payer: "Cigna",
    });
    h.render();
    expect(h.text()).toBe("The payer tab left the payer's site. Open the case and click Work in portal again.");
    expect(h.link()?.href).toBe(caseReturnUrl(WEB, CASE_A));
  });

  it("explains a timeout with a link back", () => {
    const h = harness({ work: blocked({ reason: "expired", ownerKind: "case", ownerId: CASE_A }), selectedCaseId: null });
    h.render();
    expect(h.text()).toBe("This link timed out after 60 minutes. Open the case and click Work in portal again.");
    expect(h.link()?.href).toBe(caseReturnUrl(WEB, CASE_A));
  });

  it("keeps the generic line and offers no link for ended or an old block", () => {
    for (const work of [blocked({ reason: "ended", ownerKind: "case", ownerId: CASE_A }), blocked({})]) {
      const h = harness({ work, selectedCaseId: CASE_A, payer: "Aetna" });
      h.render();
      expect(h.text()).toBe(WORK_LINK_ENDED_LINE);
      expect(h.link()).toBeNull();
    }
  });
});

describe("D6: a new launch replaced the one on screen", () => {
  const loaded = {
    providers: [{ id: PROVIDER_B, firstName: "Taylor", lastName: "Example" }],
    cases: [{ id: CASE_B, payerName: "Aetna", state: "CO" }],
  };

  it("shows a neutral, dismissable notice naming the new case", async () => {
    const h = harness({ work: active("launch-a"), loaded });
    await h.refresh(active("launch-b", CASE_B));
    expect(h.text()).toBe("You opened another case from Minted Panel. This panel now shows Taylor Example, Aetna CO.");
    expect(h.banner.hidden).toBe(false);
    expect(h.banner.classList.contains("banner-warn")).toBe(false);

    h.banner.querySelector("button")!.click();
    expect(h.banner.hidden).toBe(true);
    // Dismissed means gone: a later refresh of the same launch does not bring it back.
    await h.refresh(active("launch-b", CASE_B));
    expect(h.banner.hidden).toBe(true);
  });

  it("falls back to the new case when the names are not known yet", async () => {
    const h = harness({ work: active("launch-a") });
    await h.refresh(active("launch-b", CASE_B));
    expect(h.text()).toBe("You opened another case from Minted Panel. This panel now shows the new case.");
  });

  it("never shows on the first launch or on a re-render of the same launch", async () => {
    const h = harness({ work: { status: "none" }, loaded });
    await h.refresh(active("launch-a"));
    expect(h.banner.hidden).toBe(true);
    await h.refresh(active("launch-a"));
    expect(h.banner.hidden).toBe(true);
  });

  it("still fires when a poll lands while the new launch is being validated", async () => {
    const h = harness({ work: active("launch-a"), loaded });
    await h.refresh(blocked({ reason: "ended" }));
    expect(h.text()).toBe(WORK_LINK_ENDED_LINE);
    await h.refresh(active("launch-b", CASE_B));
    expect(h.text()).toMatch(/^You opened another case from Minted Panel\./);
  });

  it("does not fire after a link that ended for a reason the panel explained", async () => {
    const h = harness({ work: active("launch-a"), loaded });
    await h.refresh(blocked({ reason: "tab_closed", ownerKind: "case", ownerId: CASE_A }));
    await h.refresh(active("launch-b", CASE_B));
    expect(h.banner.hidden).toBe(true);
  });

  it("drops the notice once its launch is no longer live", async () => {
    const h = harness({ work: active("launch-a"), loaded });
    await h.refresh(active("launch-b", CASE_B));
    await h.refresh(blocked({ reason: "tab_closed", ownerKind: "case", ownerId: CASE_B }));
    expect(h.text()).toBe("The payer tab was closed. Click Work in portal again.");
  });
});
