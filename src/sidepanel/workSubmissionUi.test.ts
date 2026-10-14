import { readFileSync } from "node:fs";
import { createContext, runInContext, type Context } from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  logMovesToSubmitted,
  MOVES_TO_SUBMITTED_LINE,
  submissionPlanLine,
} from "../shared/closeOut";
import { matchPortalTasks } from "../shared/submission";

// Runs the unchanged main.ts close-out functions against a controlled DOM and
// state. 0.1.8: Log it works with or without a fill, the plan line replaces
// the Checklist task picker, and contract or recredentialing Work logs in
// Minted Panel.
const source = readFileSync("src/sidepanel/main.ts", "utf8");
const tree = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
function code(names: string[]) {
  const selected = tree.statements.filter((node) =>
    ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""),
  ).map((node) => node.getText(tree)).join("\n");
  return ts.transpileModule(selected, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

const CASE_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_TASK_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STEP_ONE_ID = "step-0";
const STEP_TWO_ID = "step-1";
const PORTAL_KEY = "same.enrollment.portal";
const BOUND_TAB = 21;

const workTuple = (stepId: string, ownerKind: "case" | "contract" = "case") => ({
  ownerKind,
  ownerId: CASE_ID,
  taskId: TASK_ID,
  stepId,
  stepIdentity: `case:task-1:${stepId}`,
  portalKey: PORTAL_KEY,
  portalId: "44444444-4444-4444-8444-444444444444",
  mappingGeneration: 3,
  effectiveMappingFingerprint: `sha256:${"a".repeat(64)}`,
});

const enrollmentTask = {
  id: TASK_ID,
  title: "Join Aetna network form",
  status: "in_progress",
  executionType: "extension_fill",
  sortOrder: 1,
  dueDate: null,
  steps: [
    { id: STEP_ONE_ID, label: "Enter provider details", order: 1, isCompleted: false, stepType: "portal", portalKey: PORTAL_KEY },
    { id: STEP_TWO_ID, label: "Submit application", order: 2, isCompleted: false, stepType: "portal", portalKey: PORTAL_KEY },
  ],
};

const IDS = [
  "log-link", "submit-details", "submit-title", "payer-ref-label", "mark-submitted", "dup-warn",
  "dup-cancel", "submit-back", "task-link", "task-link-single", "submit-moves", "submit-status", "submit-next",
] as const;

function buildScope(state: Record<string, unknown>): { scope: Context; el: (id: (typeof IDS)[number]) => HTMLElement } {
  const dom = new JSDOM(IDS.map((id) => `<div id="${id}" hidden></div>`).join(""));
  const doc = dom.window.document;
  const el = (id: (typeof IDS)[number]) => doc.getElementById(id) as HTMLElement;
  const scope = createContext({
    logLink: el("log-link"),
    submitDetails: el("submit-details"),
    submitTitle: el("submit-title"),
    payerRefLabel: el("payer-ref-label"),
    markSubmittedBtn: el("mark-submitted"),
    dupWarn: el("dup-warn"),
    dupCancelBtn: el("dup-cancel"),
    submitBackBtn: el("submit-back"),
    taskLink: el("task-link"),
    taskLinkSingle: el("task-link-single"),
    submitMoves: el("submit-moves"),
    submitStatus: el("submit-status"),
    submitNext: el("submit-next"),
    submissionPlanLine, logMovesToSubmitted, MOVES_TO_SUBMITTED_LINE,
    matchPortalTasks: vi.fn(matchPortalTasks),
    selectedCaseId: () => CASE_ID,
    currentSelectionAllowsCaseWork: () => true,
    isCurrentOrgReadOnly: () => false,
    lastFill: null,
    activeWorkState: { status: "none" },
    detectedTabId: BOUND_TAB,
    portal: { key: PORTAL_KEY },
    cases: [{ id: CASE_ID, payerName: "Aetna", status: "In Progress", portalTasks: [] }],
    caseContextData: { openTasks: [enrollmentTask], payer: { id: "p", name: "Aetna" } },
    submitPhase: "idle",
    fillRunning: false,
    lastLogFailure: null,
    dupConfirmPending: false,
    ...state,
  });
  runInContext(code([
    "caseStatusNow", "workRecordForSelectedCase", "workTupleForSelectedCase", "workIsLoggable",
    "payerLabel", "formTasks", "currentPlan", "workTabElsewhere", "canLogSubmission", "renderLogControls",
  ]), scope);
  return { scope, el };
}

const launch = (stepId: string, caseType: string | null = "enrollment", ownerKind: "case" | "contract" = "case") => ({
  status: "active",
  record: { tuple: workTuple(stepId, ownerKind), boundTabId: BOUND_TAB, caseType },
});

describe("0.1.8 close-out controls", () => {
  it("names each launched Work step in its own plan line, never a portal-key task match", () => {
    for (const [stepId, label] of [[STEP_ONE_ID, "Enter provider details"], [STEP_TWO_ID, "Submit application"]] as const) {
      const { scope, el } = buildScope({ activeWorkState: launch(stepId), submitPhase: "form" });
      runInContext('renderLogControls({ kind: "log" })', scope);

      expect(el("task-link").hidden).toBe(false);
      expect(el("task-link-single").textContent).toBe(`This completes the step “${label}.” The task has 1 more step.`);
      expect(el("mark-submitted").hidden).toBe(false);
      expect(el("mark-submitted").textContent).toBe("Log submission");
      expect(runInContext("matchPortalTasks", scope)).not.toHaveBeenCalled();
    }
  });

  it("offers Log it with no fill on the launched tab, even on a payer page that isn't the form", () => {
    const { scope, el } = buildScope({ activeWorkState: launch(STEP_ONE_ID), portal: null });
    expect(runInContext("canLogSubmission()", scope)).toBe(true);
    runInContext('renderLogControls({ kind: "noForm" })', scope);
    expect(el("log-link").hidden).toBe(false);
    expect(el("log-link").textContent).toBe("Submitted on Aetna? Log it");
  });

  it("hides Log it while the coordinator is on another tab", () => {
    const { scope } = buildScope({ activeWorkState: launch(STEP_ONE_ID), detectedTabId: 99 });
    expect(runInContext("canLogSubmission()", scope)).toBe(false);
  });

  it.each([
    ["recredentialing Work", launch(STEP_ONE_ID, "recredentialing")],
    ["contract Work", launch(STEP_ONE_ID, "contract", "contract")],
  ])("keeps %s out of Log it", (_label, activeWorkState) => {
    const { scope, el } = buildScope({ activeWorkState });
    expect(runInContext("canLogSubmission()", scope)).toBe(false);
    runInContext('renderLogControls({ kind: "ready" })', scope);
    expect(el("log-link").hidden).toBe(true);
  });

  it("states the manual plan instead of a task picker", () => {
    const twoTasks = [{ id: CASE_ID, payerName: "Aetna", status: "In Progress", portalTasks: [
      { taskId: TASK_ID, title: "Join Aetna network form", portalKey: PORTAL_KEY, status: "open" },
      { taskId: OTHER_TASK_ID, title: "Other task on this form", portalKey: PORTAL_KEY, status: "open" },
    ] }];
    const { scope, el } = buildScope({ cases: twoTasks, submitPhase: "form" });
    runInContext('renderLogControls({ kind: "log" })', scope);
    expect(el("task-link-single").textContent).toBe("This logs to the case. 2 tasks use this form.");

    const oneTask = [{ ...twoTasks[0], portalTasks: [twoTasks[0]!.portalTasks[1]] }];
    const single = buildScope({ cases: oneTask, submitPhase: "form" });
    runInContext('renderLogControls({ kind: "log" })', single.scope);
    expect(single.el("task-link-single").textContent).toBe("This also closes: Other task on this form.");
  });

  it("says logging moves the case to Submitted only from Not Started or In Progress", () => {
    const moving = buildScope({ submitPhase: "form" });
    runInContext('renderLogControls({ kind: "log" })', moving.scope);
    expect(moving.el("submit-moves").hidden).toBe(false);
    expect(moving.el("submit-moves").textContent).toBe("Logging moves this case to Submitted.");

    const past = buildScope({
      submitPhase: "form",
      cases: [{ id: CASE_ID, payerName: "Aetna", status: "In Review", portalTasks: [] }],
    });
    runInContext('renderLogControls({ kind: "log" })', past.scope);
    expect(past.el("submit-moves").hidden).toBe(true);
  });

  it("asks once before logging a recent duplicate, with a way out", () => {
    const { scope, el } = buildScope({ submitPhase: "form", dupConfirmPending: true });
    runInContext('renderLogControls({ kind: "log" })', scope);
    expect(el("dup-warn").hidden).toBe(false);
    expect(el("dup-cancel").hidden).toBe(false);
    expect(el("mark-submitted").textContent).toBe("Log again");
    expect(el("submit-back").hidden).toBe(true);
  });

  it("offers Try again only when the log never landed, keeping the entries", () => {
    const offline = buildScope({ submitPhase: "failed", lastLogFailure: { retry: true } });
    runInContext('renderLogControls({ kind: "logFailed" })', offline.scope);
    expect(offline.el("submit-details").hidden).toBe(false);
    expect(offline.el("mark-submitted").textContent).toBe("Try again");

    const changed = buildScope({ submitPhase: "failed", lastLogFailure: { retry: false } });
    runInContext('renderLogControls({ kind: "logFailed" })', changed.scope);
    expect(changed.el("submit-details").hidden).toBe(true);
    expect(changed.el("mark-submitted").hidden).toBe(true);
  });
});
