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

const OTHER_CASE_ID = "33333333-3333-4333-8333-333333333333";
const LAUNCH_A = "launch-a";
const LAUNCH_B = "launch-b";

const workTuple = (stepId: string, ownerKind: "case" | "contract" = "case", launchReceiptId = LAUNCH_A) => ({
  launchReceiptId,
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
  "nba-section", "task-notice",
] as const;
type Id = (typeof IDS)[number] | "payer-ref-input" | "wip-note-input";

function buildScope(state: Record<string, unknown>): {
  scope: Context;
  el: (id: Id) => HTMLElement;
  input: (id: "payer-ref-input" | "wip-note-input") => HTMLInputElement;
  run: (source: string) => unknown;
} {
  const dom = new JSDOM(IDS.map((id) => `<div id="${id}" hidden></div>`).join("") +
    '<input id="payer-ref-input"><textarea id="wip-note-input"></textarea>');
  const doc = dom.window.document;
  const el = (id: Id) => doc.getElementById(id) as HTMLElement;
  const input = (id: "payer-ref-input" | "wip-note-input") => doc.getElementById(id) as HTMLInputElement;
  const scope = createContext({
    document: doc,
    payerRefInput: el("payer-ref-input"),
    wipNoteInput: el("wip-note-input"),
    nbaSection: el("nba-section"),
    taskNotice: el("task-notice"),
    logScope: null,
    lastLogMoved: false,
    providerAttentionKey: null,
    taskNoticeKey: null,
    setSectionOpen: vi.fn(),
    externalLink: (label: string, href: string) => {
      const link = doc.createElement("a");
      link.textContent = label;
      link.href = href;
      return link;
    },
    taskUrl: (id: string) => `https://panel.test/tasks/${id}`,
    caseUrl: (id: string) => `https://panel.test/cases/${id}`,
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
    "launchIdForSelectedCase", "logScopeKey", "dropLogStateOutsideScope", "resetLogState", "resetSubmitInputs",
    "renderSubmissionActions", "fillNotice", "setLiveRole", "openProviderDetailsOnce",
    "noticeButton", "focusTab", "showTaskNotice", "workOffForm", "renderTaskNotice",
  ]), scope);
  return { scope, el, input, run: (source: string) => runInContext(source, scope) };
}

const launch = (
  stepId: string,
  caseType: string | null = "enrollment",
  ownerKind: "case" | "contract" = "case",
  launchReceiptId = LAUNCH_A,
  status: "active" | "expired" = "active",
) => ({
  status,
  record: { tuple: workTuple(stepId, ownerKind, launchReceiptId), boundTabId: BOUND_TAB, caseType },
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
    // The worker logs enrollment only, so an unknown case type is not loggable.
    ["Work with no case type", launch(STEP_ONE_ID, null)],
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
    // The refusal stays readable, and Log it is a way back once she checked.
    expect(changed.el("submit-status").hidden).toBe(false);
    expect(changed.el("log-link").hidden).toBe(false);
  });

  it("hides the whole log form on another tab, and brings it back with the entries", () => {
    const { el, input, run } = buildScope({
      activeWorkState: launch(STEP_ONE_ID), detectedTabId: 99, submitPhase: "form", dupConfirmPending: false,
    });
    input("payer-ref-input").value = "RFP-204871";
    run('renderLogControls({ kind: "wrongTab" })');
    for (const id of ["submit-details", "mark-submitted", "submit-back", "dup-warn", "dup-cancel", "log-link"] as const) {
      expect(el(id).hidden, id).toBe(true);
    }

    run(`detectedTabId = ${BOUND_TAB}`);
    run('renderLogControls({ kind: "log" })');
    expect(el("submit-details").hidden).toBe(false);
    expect(el("mark-submitted").hidden).toBe(false);
    expect(el("mark-submitted").textContent).toBe("Log submission");
    expect(input("payer-ref-input").value).toBe("RFP-204871");
  });

  it("holds a failure Try again can fix, with its message, until she is back on the tab", () => {
    const { el, run } = buildScope({
      activeWorkState: launch(STEP_ONE_ID), detectedTabId: 99, submitPhase: "failed", lastLogFailure: { retry: true },
    });
    el("submit-status").textContent = "Not logged yet. Your entries are kept. Try again.";
    run('renderLogControls({ kind: "wrongTab" })');
    expect(el("submit-details").hidden).toBe(true);
    expect(el("mark-submitted").hidden).toBe(true);
    expect(el("submit-status").hidden).toBe(true);

    run(`detectedTabId = ${BOUND_TAB}`);
    run('renderLogControls({ kind: "logFailed" })');
    expect(el("submit-status").hidden).toBe(false);
    expect(el("mark-submitted").textContent).toBe("Try again");
  });

  it("names logging in the wrong-tab notice while a log form waits, and focuses the tab's window", async () => {
    const tabsUpdate = vi.fn(async () => ({ id: BOUND_TAB, windowId: 5 }));
    const windowsUpdate = vi.fn(async () => ({}));
    const { el, run } = buildScope({
      activeWorkState: launch(STEP_ONE_ID), detectedTabId: 99, submitPhase: "form",
      chrome: { tabs: { update: tabsUpdate, get: vi.fn() }, windows: { update: windowsUpdate } },
    });
    run('renderTaskNotice({ kind: "wrongTab" }, null)');
    expect(el("task-notice").textContent).toContain("You're on a different tab. Switch to the Aetna tab to log it.");
    const first = el("task-notice").firstChild;
    // The same notice again leaves the live region alone (no repeat read).
    run('renderTaskNotice({ kind: "wrongTab" }, null)');
    expect(el("task-notice").firstChild).toBe(first);

    el("task-notice").querySelector("button")!.click();
    await vi.waitFor(() => expect(windowsUpdate).toHaveBeenCalledWith(5, { focused: true }));
    expect(tabsUpdate).toHaveBeenCalledWith(BOUND_TAB, { active: true });

    run('submitPhase = "idle"');
    run('renderTaskNotice({ kind: "wrongTab" }, null)');
    expect(el("task-notice").textContent).toContain("Switch to the Aetna tab to fill.");
  });

  it("reads the window from the tab when the update returns none, and survives a closed tab", async () => {
    const windowsUpdate = vi.fn(async () => ({}));
    const get = vi.fn(async () => ({ id: BOUND_TAB, windowId: 9 }));
    const { run } = buildScope({
      chrome: { tabs: { update: vi.fn(async () => undefined), get }, windows: { update: windowsUpdate } },
    });
    await run(`focusTab(${BOUND_TAB})`);
    expect(get).toHaveBeenCalledWith(BOUND_TAB);
    expect(windowsUpdate).toHaveBeenCalledWith(9, { focused: true });

    const closed = buildScope({
      chrome: { tabs: { update: vi.fn(async () => { throw new Error("No tab"); }), get }, windows: { update: windowsUpdate } },
    });
    await expect(closed.run(`focusTab(${BOUND_TAB})`)).resolves.toBeUndefined();
  });
});

describe("log scope: one case and one Work launch", () => {
  const casesWithRef = [{ id: CASE_ID, payerName: "Aetna", status: "In Progress", portalTasks: [], payerReferenceId: "CASE-REF" }];

  it("keeps the open form and its entries through a page change in the same case and launch", () => {
    for (const activeWorkState of [launch(STEP_ONE_ID), { status: "none" }]) {
      const { input, run } = buildScope({ activeWorkState, cases: casesWithRef });
      run('submitPhase = "form"; logScope = logScopeKey()');
      input("payer-ref-input").value = "RFP-204871";
      input("wip-note-input").value = "Called the payer";
      // What clearFillResults runs when the page changes.
      run("dropLogStateOutsideScope()");
      expect(run("submitPhase")).toBe("form");
      expect(input("payer-ref-input").value).toBe("RFP-204871");
      expect(input("wip-note-input").value).toBe("Called the payer");
    }
  });

  it("keeps a failed log and a logged result through a page change", () => {
    for (const phase of ["failed", "done"]) {
      const { run } = buildScope({ activeWorkState: launch(STEP_ONE_ID), lastLogFailure: { retry: true } });
      run(`submitPhase = "${phase}"; logScope = logScopeKey()`);
      run("dropLogStateOutsideScope()");
      expect(run("submitPhase")).toBe(phase);
    }
  });

  it("keeps the scope when the launch times out, so a logged result stays readable", () => {
    const { run } = buildScope({ activeWorkState: launch(STEP_ONE_ID), submitPhase: "done" });
    run("logScope = logScopeKey()");
    expect(run("logScope")).toBe(`${CASE_ID}|${LAUNCH_A}`);
    run(`activeWorkState = ${JSON.stringify(launch(STEP_ONE_ID, "enrollment", "case", LAUNCH_A, "expired"))}`);
    run("dropLogStateOutsideScope()");
    expect(run("submitPhase")).toBe("done");
  });

  it("starts fresh when she relaunches the same case", () => {
    const { el, input, run } = buildScope({ activeWorkState: launch(STEP_ONE_ID), cases: casesWithRef });
    run('submitPhase = "done"; logScope = logScopeKey()');
    el("submit-status").hidden = false;
    el("submit-next").append(el("submit-next").ownerDocument.createElement("a"));
    input("payer-ref-input").value = "RFP-204871";
    input("wip-note-input").value = "Called the payer";

    run(`activeWorkState = ${JSON.stringify(launch(STEP_ONE_ID, "enrollment", "case", LAUNCH_B))}`);
    run("dropLogStateOutsideScope()");
    expect(run("submitPhase")).toBe("idle");
    expect(run("logScope")).toBeNull();
    expect(input("payer-ref-input").value).toBe("CASE-REF");
    expect(input("wip-note-input").value).toBe("");
    run('renderLogControls({ kind: "ready" })');
    expect(el("submit-status").hidden).toBe(true);
    expect(el("submit-next").hidden).toBe(true);
    expect(el("log-link").hidden).toBe(false);
  });

  it("starts fresh on a different case, and when a manual log meets a new launch", () => {
    let current = CASE_ID;
    const { run } = buildScope({ selectedCaseId: () => current });
    run('submitPhase = "form"; logScope = logScopeKey()');
    expect(run("logScope")).toBe(`${CASE_ID}|manual`);
    current = OTHER_CASE_ID;
    run("dropLogStateOutsideScope()");
    expect(run("submitPhase")).toBe("idle");

    current = CASE_ID;
    run('submitPhase = "done"; logScope = logScopeKey()');
    run(`activeWorkState = ${JSON.stringify(launch(STEP_ONE_ID))}`);
    run("dropLogStateOutsideScope()");
    expect(run("submitPhase")).toBe("idle");
  });

  it("shows a restored report that was already logged as done, and keeps it", () => {
    const lastFill = { caseId: CASE_ID, isWorkFill: true, workContext: workTuple(STEP_ONE_ID), workCaseType: "enrollment" };
    const { el, run } = buildScope({ activeWorkState: launch(STEP_ONE_ID), lastFill });
    run('renderSubmissionActions({ completedAt: "2026-10-14T12:00:00Z", submitted: true })');
    expect(run("submitPhase")).toBe("done");
    expect(run("logScope")).toBe(`${CASE_ID}|${LAUNCH_A}`);
    expect(el("submit-status").textContent).toBe("Logged to the case.");
    expect(el("submit-status").getAttribute("role")).toBe("status");

    // renderTaskCard runs this next; the done card used to vanish here.
    run("dropLogStateOutsideScope()");
    run('renderLogControls({ kind: "logged", submitted: false })');
    expect(run("submitPhase")).toBe("done");
    expect(el("submit-status").hidden).toBe(false);
    expect(el("log-link").hidden).toBe(true);
  });

  it("shows a restored logged report as done after its launch ended, or with no launch at all", () => {
    for (const [activeWorkState, workContext] of [
      [{ status: "blocked", orgId: null }, workTuple(STEP_ONE_ID)],
      [{ status: "none" }, null],
    ] as const) {
      const lastFill = { caseId: CASE_ID, isWorkFill: workContext != null, workContext, workCaseType: "enrollment" };
      const { run } = buildScope({ activeWorkState, lastFill });
      run('renderSubmissionActions({ completedAt: "2026-10-14T12:00:00Z", submitted: true })');
      expect(run("submitPhase")).toBe("done");
      expect(run("logScope")).toBe(`${CASE_ID}|manual`);
    }
  });

  it("leaves a new launch to log fresh when the restored report was logged under an earlier one", () => {
    const lastFill = { caseId: CASE_ID, isWorkFill: true, workContext: workTuple(STEP_ONE_ID), workCaseType: "enrollment" };
    const { run } = buildScope({ activeWorkState: launch(STEP_ONE_ID, "enrollment", "case", LAUNCH_B), lastFill });
    run('renderSubmissionActions({ completedAt: "2026-10-14T12:00:00Z", submitted: true })');
    expect(run("submitPhase")).toBe("idle");

    const unsubmitted = buildScope({ activeWorkState: launch(STEP_ONE_ID), lastFill });
    unsubmitted.run('renderSubmissionActions({ completedAt: "2026-10-14T12:00:00Z", submitted: false })');
    expect(unsubmitted.run("submitPhase")).toBe("idle");
  });

  it("starts the log fresh after a new fill", () => {
    const { run } = buildScope({ activeWorkState: launch(STEP_ONE_ID) });
    run('submitPhase = "done"; logScope = logScopeKey()');
    run("renderSubmissionActions()");
    expect(run("submitPhase")).toBe("idle");
    expect(run("logScope")).toBeNull();
  });
});

describe("Provider details opens itself once per state", () => {
  it("opens for a by-hand page or denied access once, and again only when the state changes", () => {
    const { scope, run } = buildScope({});
    const open = scope.setSectionOpen as ReturnType<typeof vi.fn>;
    run('openProviderDetailsOnce("byHand:https://payer.test/confirm")');
    run('openProviderDetailsOnce("byHand:https://payer.test/confirm")');
    run('openProviderDetailsOnce("byHand:https://payer.test/confirm")');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("provider", true);

    run('openProviderDetailsOnce("byHand:https://payer.test/next-page")');
    expect(open).toHaveBeenCalledTimes(2);
    run('openProviderDetailsOnce("denied")');
    run('openProviderDetailsOnce("denied")');
    expect(open).toHaveBeenCalledTimes(3);
    // Leaving the state and coming back counts as a change.
    run("openProviderDetailsOnce(null)");
    run('openProviderDetailsOnce("denied")');
    expect(open).toHaveBeenCalledTimes(4);
  });

  it("is the only way the task card opens Provider details for these states", () => {
    const body = (name: string) => tree.statements.find((node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(tree);
    expect(body("renderTaskNotice")).not.toContain("setSectionOpen");
    expect(body("renderTaskCard")).not.toContain("setSectionOpen(\"provider\"");
    expect(body("renderTaskCard")).toContain("openProviderDetailsOnce(");
    // Page changes keep the log through the scope check, never a case id.
    expect(body("clearFillResults")).toContain("dropLogStateOutsideScope()");
    expect(body("renderTaskCard")).toContain("dropLogStateOutsideScope()");
  });
});

describe("focus after a log control hides", () => {
  it("moves focus to the first target that shows", () => {
    const dom = new JSDOM(`
      <div hidden><button id="hidden-inside">Log it</button></div>
      <button id="hidden-self" hidden>Back</button>
      <div id="status" tabindex="-1">Logged.</div>
      <button id="title">Task</button>`);
    const doc = dom.window.document;
    const scope = createContext({});
    runInContext(code(["focusFirstShown"]), scope);
    const byId = (id: string) => doc.getElementById(id)!;
    (scope.focusFirstShown as (...targets: HTMLElement[]) => void)(byId("hidden-inside"), byId("hidden-self"), byId("status"), byId("title"));
    expect(doc.activeElement).toBe(byId("status"));
    (scope.focusFirstShown as (...targets: HTMLElement[]) => void)(byId("hidden-inside"), byId("title"));
    expect(doc.activeElement).toBe(byId("title"));
  });
});
