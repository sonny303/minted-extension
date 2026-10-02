import { readFileSync } from "node:fs";
import { createContext, runInContext, type Context } from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

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
const STEP_ONE_ID = "77777777-7777-4777-8777-777777777777";
const STEP_TWO_ID = "88888888-8888-4888-8888-888888888888";
const FILL_SESSION_ID = "99999999-9999-4999-8999-999999999999";
const workTuple = (stepId: string, stepIdentity: string) => ({
  ownerKind: "case" as const,
  ownerId: CASE_ID,
  taskId: TASK_ID,
  stepId,
  stepIdentity,
  portalKey: "same.enrollment.portal",
  portalId: "44444444-4444-4444-8444-444444444444",
  mappingGeneration: 3,
  effectiveMappingFingerprint: `sha256:${"a".repeat(64)}`,
});

function buildScope(lastFill: Record<string, unknown>): {
  scope: Context;
  elements: Record<string, HTMLElement>;
  matchPortalTasks: ReturnType<typeof vi.fn>;
} {
  const dom = new JSDOM(`
    <div id="task-link" hidden><label id="task-link-label"></label>
      <p id="task-link-single" hidden></p><select id="task-select" hidden></select></div>
    <div id="submit-details"></div><p id="submit-hint"></p><div id="dup-warn"></div>
    <button id="mark-submitted"></button><div id="submit-status"></div>
  `);
  const doc = dom.window.document;
  const elements = Object.fromEntries([
    "task-link", "task-link-label", "task-link-single", "task-select", "submit-details",
    "submit-hint", "dup-warn", "mark-submitted", "submit-status",
  ].map((id) => [id, doc.getElementById(id) as HTMLElement]));
  const matchPortalTasks = vi.fn((tasks: Array<{ portalKey: string }>, portalKey: string) =>
    tasks.filter((task) => task.portalKey === portalKey));
  const task = {
    id: TASK_ID,
    title: "Enrollment application",
    status: "in_progress",
    executionType: "extension_fill",
    sortOrder: 1,
    dueDate: null,
    steps: [
      { id: STEP_ONE_ID, label: "Enter provider details", order: 1, isCompleted: false, stepType: "portal", portalKey: "same.enrollment.portal" },
      { id: STEP_TWO_ID, label: "Submit application", order: 2, isCompleted: false, stepType: "portal", portalKey: "same.enrollment.portal" },
    ],
  };
  const scope = createContext({
    lastFill,
    selectedTaskId: "stale-task-choice",
    taskLink: elements["task-link"],
    taskLinkLabel: elements["task-link-label"],
    taskLinkSingle: elements["task-link-single"],
    taskSelect: elements["task-select"],
    submitDetails: elements["submit-details"],
    submitHint: elements["submit-hint"],
    dupWarn: elements["dup-warn"],
    markSubmittedBtn: elements["mark-submitted"],
    submitStatus: elements["submit-status"],
    dupConfirmPending: false,
    selectedCaseId: () => CASE_ID,
    resetSubmitInputs: vi.fn(),
    Option: dom.window.Option,
    matchPortalTasks,
    portal: { key: "same.enrollment.portal" },
    cases: [{ id: CASE_ID, portalTasks: [
      { taskId: TASK_ID, title: "Legacy task-level match", portalKey: "same.enrollment.portal", status: "open" },
      { taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Other same-portal task", portalKey: "same.enrollment.portal", status: "open" },
    ] }],
    caseContextData: { openTasks: [task] },
  });
  runInContext(code([
    "workSubmissionMode", "exactWorkStepLabel", "submissionUnavailableMessage",
    "submissionSuccessLine", "matchingPortalTasks", "renderTaskLink", "renderSubmissionActions",
  ]), scope);
  return { scope, elements, matchPortalTasks };
}

describe("typed Work submission controls", () => {
  it("pins two same-config portal steps to their own receipt and success copy", () => {
    const { scope, elements, matchPortalTasks } = buildScope({
      providerId: "provider",
      caseId: CASE_ID,
      portalKey: "same.enrollment.portal",
      fillSessionId: FILL_SESSION_ID,
      isWorkFill: true,
      workCaseType: "enrollment",
      workContext: workTuple(STEP_ONE_ID, "case:task-1:step-1"),
    });

    for (const [stepId, expectedStep] of [
      [STEP_ONE_ID, "Enter provider details"],
      [STEP_TWO_ID, "Submit application"],
    ] as const) {
      runInContext(`lastFill = { ...lastFill, workContext: ${JSON.stringify(workTuple(stepId, `case:task-1:${stepId === STEP_ONE_ID ? "step-1" : "step-2"}`))} }; renderSubmissionActions();`, scope);

      expect(elements["mark-submitted"]!.hidden).toBe(false);
      expect(elements["task-link"]!.hidden).toBe(false);
      expect(elements["task-link-label"]!.textContent).toBe("Work step");
      expect(elements["task-link-single"]!.textContent).toContain(expectedStep);
      expect(elements["task-select"]!.hidden).toBe(true);
      expect(runInContext("selectedTaskId", scope)).toBeNull();
      expect(matchPortalTasks).not.toHaveBeenCalled();
      expect(runInContext(
        `submissionSuccessLine(lastFill, "${FILL_SESSION_ID}", "Legacy task-level match", caseContextData)`,
        scope,
      )).toContain(expectedStep);
    }
  });

  it.each([
    ["contract", "contract", "Contract Work has no case submission action"],
    ["case", "recredentialing", "only for Enrollment Work"],
  ] as const)("blocks %s %s Mark submitted UI", (ownerKind, caseType, guidance) => {
    const context = {
      providerId: "provider",
      caseId: ownerKind === "case" ? CASE_ID : null,
      portalKey: "same.enrollment.portal",
      fillSessionId: FILL_SESSION_ID,
      isWorkFill: true,
      workCaseType: caseType,
      workContext: ownerKind === "case"
        ? workTuple(STEP_ONE_ID, "case:task-1:step-1")
        : { ownerKind: "contract" },
    };
    const { scope, elements, matchPortalTasks } = buildScope(context);

    runInContext("renderSubmissionActions()", scope);

    expect(elements["mark-submitted"]!.hidden).toBe(true);
    expect(elements["submit-details"]!.hidden).toBe(true);
    expect(elements["task-link"]!.hidden).toBe(true);
    expect(elements["submit-status"]!.textContent).toContain(guidance);
    expect(matchPortalTasks).not.toHaveBeenCalled();
  });

  it("preserves the legacy same-portal task picker", () => {
    const { scope, elements, matchPortalTasks } = buildScope({
      providerId: "provider",
      caseId: CASE_ID,
      portalKey: "same.enrollment.portal",
      fillSessionId: FILL_SESSION_ID,
      isWorkFill: false,
      workContext: null,
      workCaseType: null,
    });

    runInContext("renderTaskLink()", scope);

    expect(elements["task-select"]!.hidden).toBe(false);
    expect((elements["task-select"]! as HTMLSelectElement).options).toHaveLength(3);
    expect(matchPortalTasks).toHaveBeenCalledOnce();
  });
});
