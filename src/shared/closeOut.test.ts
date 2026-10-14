import { describe, expect, it } from "vitest";
import {
  afterLogView,
  logFailureView,
  logMovesToSubmitted,
  manualTaskToClose,
  submissionPlanLine,
  supportCode,
  taskCardNeedsAttention,
  taskCardPill,
  type FormTask,
} from "./closeOut";

const task = (title: string, otherOpenSteps = 0): FormTask => ({ taskId: title, title, otherOpenSteps });

describe("logMovesToSubmitted", () => {
  it("is true only for the two statuses the trigger moves", () => {
    expect(logMovesToSubmitted("Not Started")).toBe(true);
    expect(logMovesToSubmitted("In Progress")).toBe(true);
    expect(logMovesToSubmitted("in progress")).toBe(true);
    for (const status of ["Submitted", "In Review", "Action Required", "Approved", "Denied", "Not Pursuing"]) {
      expect(logMovesToSubmitted(status), status).toBe(false);
    }
    expect(logMovesToSubmitted(null)).toBe(false);
    expect(logMovesToSubmitted(undefined)).toBe(false);
  });
});

describe("submissionPlanLine", () => {
  it("names the exact Work step and whether the task closes", () => {
    expect(submissionPlanLine({ kind: "work", task: task("Join Aetna network form"), stepLabel: "Fill online form" }))
      .toBe("This completes the step “Fill online form.” The task closes with it.");
    expect(submissionPlanLine({ kind: "work", task: task("Join", 2), stepLabel: "Fill online form" }))
      .toBe("This completes the step “Fill online form.” The task has 2 more steps.");
    expect(submissionPlanLine({ kind: "work", task: task("Join", 1), stepLabel: "Fill" }))
      .toBe("This completes the step “Fill.” The task has 1 more step.");
    expect(submissionPlanLine({ kind: "work", task: null, stepLabel: null }))
      .toBe("This logs the submission to the case.");
  });

  it("follows the 9.2 table in manual mode, with no task picker", () => {
    expect(submissionPlanLine({ kind: "manual", tasks: [task("Join Aetna network form")] }))
      .toBe("This also closes: Join Aetna network form.");
    expect(submissionPlanLine({ kind: "manual", tasks: [task("Join", 1)] }))
      .toBe("This logs to the case. The task has other steps.");
    expect(submissionPlanLine({ kind: "manual", tasks: [] }))
      .toBe("This logs to the case. No task uses this form.");
    expect(submissionPlanLine({ kind: "manual", tasks: [task("A"), task("B"), task("C")] }))
      .toBe("This logs to the case. 3 tasks use this form.");
  });

  it("closes a task in manual mode only when it is the one task and nothing else is open", () => {
    expect(manualTaskToClose([task("A")])?.title).toBe("A");
    expect(manualTaskToClose([task("A", 1)])).toBeNull();
    expect(manualTaskToClose([task("A"), task("B")])).toBeNull();
    expect(manualTaskToClose([])).toBeNull();
  });
});

describe("afterLogView", () => {
  it("E5: task done and case moved", () => {
    expect(afterLogView({
      plan: { kind: "work", task: task("Join Aetna network form"), stepLabel: "Fill" },
      bump: { applied: true }, statusBefore: "Not Started", confirmationNumber: "RFP-1",
    })).toEqual({
      headline: "Logged. Task done: Join Aetna network form.",
      lines: ["Case moved to Submitted.", "Confirmation number RFP-1 saved."],
      link: null,
    });
  });

  it("E6: the step is done and the task has more steps", () => {
    expect(afterLogView({
      plan: { kind: "work", task: task("Join", 2), stepLabel: "Fill" },
      bump: { applied: true }, statusBefore: "In Progress", confirmationNumber: null,
    })).toEqual({
      headline: "Logged. This step is done.",
      lines: ["2 more steps are in Minted Panel.", "Case moved to Submitted."],
      link: "task",
    });
  });

  it("E7: manual logs that close no task point at the case or task", () => {
    const base = { bump: { applied: true }, statusBefore: "In Progress", confirmationNumber: null };
    expect(afterLogView({ ...base, plan: { kind: "manual", tasks: [] } })).toMatchObject({
      headline: "Logged to the case.", lines: ["No task was closed.", "Case moved to Submitted."], link: "case",
    });
    expect(afterLogView({ ...base, plan: { kind: "manual", tasks: [task("A"), task("B")] } })).toMatchObject({
      lines: ["Mark the right task done in Minted Panel.", "Case moved to Submitted."], link: "case",
    });
    expect(afterLogView({ ...base, plan: { kind: "manual", tasks: [task("A", 1)] } })).toMatchObject({
      lines: ["Finish the task in Minted Panel.", "Case moved to Submitted."], link: "task",
    });
  });

  it("E8: a case already past Submitted stays where it is", () => {
    expect(afterLogView({
      plan: { kind: "manual", tasks: [task("A")] },
      bump: { applied: false, reason: "The case is already past Submitted, so its status was left as it is." },
      statusBefore: "In Review", confirmationNumber: null,
    }).lines).toEqual(["The case stays at In Review."]);
  });

  it("says nothing about status when the panel did not report it", () => {
    expect(afterLogView({
      plan: { kind: "manual", tasks: [task("A")] }, bump: null, statusBefore: "In Progress", confirmationNumber: " ",
    }).lines).toEqual([]);
  });
});

describe("logFailureView", () => {
  it("E9: offline or server down keeps the entries and offers Try again", () => {
    for (const code of [undefined, 0, 500, 503]) {
      expect(logFailureView(code, "x", "work")).toMatchObject({ retry: true, link: null });
    }
    expect(logFailureView(undefined, "x", "work").text).toBe("Not logged yet. Your entries are kept. Try again.");
  });

  it("E10: a changed task never offers a retry that repeats the 409", () => {
    expect(logFailureView(409, "x", "work")).toEqual({
      text: "This task changed in Minted Panel. Open it to check.", retry: false, link: "task", tone: "danger",
    });
    expect(logFailureView(409, "x", "manual").link).toBe("case");
  });

  it("E11: a typed case picked in the panel goes back through Work in portal", () => {
    expect(logFailureView(422, "Exact Work context is required for typed cases", "manual")).toEqual({
      text: "Log this from the case: in Minted Panel, click Work in portal.", retry: false, link: "case", tone: "warn",
    });
  });

  it("other refusals say what happened and never retry", () => {
    expect(logFailureView(404, "Case not found", "manual")).toMatchObject({ text: "Not logged. Case not found", retry: false });
    expect(logFailureView(403, "", "work").retry).toBe(false);
    expect(logFailureView(401, "", "work").text).toContain("sign-in expired");
  });
});

describe("supportCode", () => {
  it("carries version, short ids, time and code, and nothing else", () => {
    expect(supportCode({
      version: "0.1.8",
      caseId: "74354240-1111-4111-8111-111111111111",
      fillId: "3f2a9c1e-2222-4222-8222-222222222222",
      at: new Date(2026, 9, 14, 14, 32),
      code: 422,
    })).toBe("MP 0.1.8 · case 74354240 · fill 3f2a9c1e · 14:32 · 422");
    expect(supportCode({ version: "0.1.8", caseId: null, fillId: null, at: new Date(2026, 0, 1, 9, 5), code: null }))
      .toBe("MP 0.1.8 · 09:05");
  });
});

describe("task card pill and auto-open", () => {
  it("reads the state the coordinator is in", () => {
    expect(taskCardPill({ kind: "filled", filled: 14, needYou: 0 })).toEqual({ text: "Filled 14 · your turn", tone: "ok" });
    expect(taskCardPill({ kind: "filled", filled: 12, needYou: 3 })).toEqual({ text: "Filled 12 · 3 need you", tone: "warn" });
    expect(taskCardPill({ kind: "logged", submitted: true })?.text).toBe("Done · Submitted");
    expect(taskCardPill({ kind: "byHand" })?.text).toBe("Fill by hand");
    expect(taskCardPill({ kind: "none" })).toBeNull();
  });

  it("opens on results and problems, not on quiet states", () => {
    expect(taskCardNeedsAttention({ kind: "filled", filled: 1, needYou: 0 })).toBe(true);
    expect(taskCardNeedsAttention({ kind: "failed" })).toBe(true);
    expect(taskCardNeedsAttention({ kind: "wrongTab" })).toBe(true);
    expect(taskCardNeedsAttention({ kind: "ready" })).toBe(false);
    expect(taskCardNeedsAttention({ kind: "filling" })).toBe(false);
  });
});
