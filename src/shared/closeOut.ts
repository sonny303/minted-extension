// Plain-language close-out and status rules for the Workbench side panel
// (UX review 2026-10-14, sections 9.2 and 9.3, decisions in section 10).
// Pure: no DOM, no chrome.*, no clock reads. The panel passes the time in.

/** Case statuses (panel `caseStatusLabel`) the submission trigger moves to
 * Submitted. Anything else was set by a person and stands. */
const MOVES_TO_SUBMITTED = new Set(["not started", "in progress"]);

/** True when logging a submission will move the case to Submitted. Unknown or
 * missing status: false, so the panel never promises a move it can't see. */
export function logMovesToSubmitted(caseStatus: string | null | undefined): boolean {
  return caseStatus != null && MOVES_TO_SUBMITTED.has(caseStatus.trim().toLowerCase());
}

export const MOVES_TO_SUBMITTED_LINE = "Logging moves this case to Submitted.";

/** One open task whose steps use the form on this tab. `otherOpenSteps`
 * counts the task's incomplete steps that are NOT on this form. */
export interface FormTask {
  taskId: string;
  title: string;
  otherOpenSteps: number;
}

export type SubmissionPlan =
  | { kind: "work"; task: FormTask | null; stepLabel: string | null }
  | { kind: "manual"; tasks: FormTask[] };

/** The task a manual log may close, or null. Only one task uses the form and
 * nothing else on it is open: closing it can't skip work. */
export function manualTaskToClose(tasks: readonly FormTask[]): FormTask | null {
  const only = tasks.length === 1 ? tasks[0] : undefined;
  return only != null && only.otherOpenSteps === 0 ? only : null;
}

/** The line above "Log submission" that says what logging will do. */
export function submissionPlanLine(plan: SubmissionPlan): string {
  if (plan.kind === "work") {
    if (plan.task == null || plan.stepLabel == null) {
      return "This logs the submission to the case.";
    }
    const more = plan.task.otherOpenSteps;
    const after = more === 0
      ? "The task closes with it."
      : `The task has ${more} more ${more === 1 ? "step" : "steps"}.`;
    return `This completes the step “${plan.stepLabel}.” ${after}`;
  }
  const { tasks } = plan;
  const closes = manualTaskToClose(tasks);
  if (closes) return `This also closes: ${closes.title}.`;
  if (tasks.length === 1) return "This logs to the case. The task has other steps.";
  if (tasks.length === 0) return "This logs to the case. No task uses this form.";
  return `This logs to the case. ${tasks.length} tasks use this form.`;
}

/** What the panel learned back from the server about the status move. */
export interface BumpReport {
  applied: boolean;
  reason?: string | null;
}

export type LogLink = "task" | "case" | null;

export interface AfterLogView {
  headline: string;
  lines: string[];
  link: LogLink;
}

/** The result card after a submission is logged (E5 to E8). */
export function afterLogView(input: {
  plan: SubmissionPlan;
  bump: BumpReport | null;
  /** The case status before logging, for "The case stays at …". */
  statusBefore: string | null;
  confirmationNumber: string | null;
}): AfterLogView {
  const lines: string[] = [];
  let headline: string;
  let link: LogLink = null;
  const { plan } = input;
  if (plan.kind === "work") {
    const task = plan.task;
    if (task == null) {
      headline = "Logged to the case.";
      link = "case";
    } else if (task.otherOpenSteps === 0) {
      headline = `Logged. Task done: ${task.title}.`;
    } else {
      headline = "Logged. This step is done.";
      const n = task.otherOpenSteps;
      lines.push(`${n} more ${n === 1 ? "step is" : "steps are"} in Minted Panel.`);
      link = "task";
    }
  } else {
    const closes = manualTaskToClose(plan.tasks);
    if (closes) {
      headline = `Logged. Task done: ${closes.title}.`;
    } else if (plan.tasks.length === 1) {
      headline = "Logged to the case.";
      lines.push("Finish the task in Minted Panel.");
      link = "task";
    } else if (plan.tasks.length === 0) {
      headline = "Logged to the case.";
      lines.push("No task was closed.");
      link = "case";
    } else {
      headline = "Logged to the case.";
      lines.push("Mark the right task done in Minted Panel.");
      link = "case";
    }
  }
  const bump = input.bump;
  if (bump?.applied) {
    lines.push("Case moved to Submitted.");
  } else if (bump != null && input.statusBefore != null && !logMovesToSubmitted(input.statusBefore)) {
    lines.push(`The case stays at ${input.statusBefore}.`);
  } else if (bump != null && bump.reason) {
    lines.push(bump.reason);
  }
  const confirmation = input.confirmationNumber?.trim();
  if (confirmation) lines.push(`Confirmation number ${confirmation} saved.`);
  return { headline, lines, link };
}

export interface LogFailureView {
  text: string;
  /** Try again can succeed: the request never landed. */
  retry: boolean;
  link: LogLink;
  tone: "danger" | "warn";
}

/** The panel's typed-case refusal (manual mode on a typed case). */
const TYPED_CASE_NEEDS_WORK = /exact work context is required/i;

/** One plain line and one way forward for a failed log (E9 to E11).
 * `code` is the HTTP status when the failure came from Minted Panel. */
export function logFailureView(
  code: number | undefined,
  message: string,
  mode: "work" | "manual",
): LogFailureView {
  if (code == null || code === 0 || code >= 500) {
    return { text: "Not logged yet. Your entries are kept. Try again.", retry: true, link: null, tone: "danger" };
  }
  if (code === 401) {
    return { text: "Your sign-in expired. Sign in again. The case stays linked.", retry: false, link: null, tone: "warn" };
  }
  if (code === 403) {
    return {
      text: "Your account can view this case but not log to it. Ask an admin to change your role.",
      retry: false, link: null, tone: "warn",
    };
  }
  if (code === 409) {
    return {
      text: "This task changed in Minted Panel. Open it to check.",
      retry: false, link: mode === "work" ? "task" : "case", tone: "danger",
    };
  }
  if (code === 422 && TYPED_CASE_NEEDS_WORK.test(message)) {
    return {
      text: "Log this from the case: in Minted Panel, click Work in portal.",
      retry: false, link: "case", tone: "warn",
    };
  }
  return { text: `Not logged. ${message}`, retry: false, link: "case", tone: "danger" };
}

/** A short code a specialist can paste to support. Ids are cut to 8
 * characters; no names and no values. Example:
 * `MP 0.1.8 · case 74354240 · fill 3f2a9c1e · 14:32 · 422`. */
export function supportCode(input: {
  version: string;
  caseId: string | null;
  fillId: string | null;
  at: Date;
  code: string | number | null;
}): string {
  const parts = [`MP ${input.version}`];
  if (input.caseId) parts.push(`case ${input.caseId.slice(0, 8)}`);
  if (input.fillId) parts.push(`fill ${input.fillId.slice(0, 8)}`);
  const hh = String(input.at.getHours()).padStart(2, "0");
  const mm = String(input.at.getMinutes()).padStart(2, "0");
  parts.push(`${hh}:${mm}`);
  if (input.code != null && input.code !== "") parts.push(String(input.code));
  return parts.join(" · ");
}

export type PillTone = "ok" | "warn" | "danger" | "neutral" | "tint";

export type TaskCardState =
  | { kind: "access" }
  | { kind: "denied" }
  | { kind: "ready" }
  | { kind: "filling" }
  | { kind: "filled"; filled: number; needYou: number }
  | { kind: "nothing" }
  | { kind: "failed" }
  | { kind: "noForm" }
  | { kind: "log" }
  | { kind: "logging" }
  | { kind: "logged"; submitted: boolean }
  | { kind: "logFailed" }
  | { kind: "wrongTab" }
  | { kind: "timedOut" }
  | { kind: "readOnly" }
  | { kind: "adHoc" }
  | { kind: "test" }
  | { kind: "none" };

/** The one pill on the task card header: what the panel needs from the
 * coordinator right now. */
export function taskCardPill(state: TaskCardState): { text: string; tone: PillTone } | null {
  switch (state.kind) {
    case "access": return { text: "Needs one-time setup", tone: "warn" };
    case "denied": return { text: "Access not allowed", tone: "warn" };
    case "ready": return { text: "Ready to fill", tone: "tint" };
    case "filling": return { text: "Filling…", tone: "neutral" };
    case "filled":
      return state.needYou > 0
        ? { text: `Filled ${state.filled} · ${state.needYou} need you`, tone: "warn" }
        : { text: `Filled ${state.filled} · your turn`, tone: "ok" };
    case "nothing": return { text: "Nothing filled", tone: "danger" };
    case "failed": return { text: "Fill did not finish", tone: "danger" };
    case "noForm": return { text: "No form here", tone: "neutral" };
    case "log": return { text: "Ready to log", tone: "tint" };
    case "logging": return { text: "Logging submission", tone: "neutral" };
    case "logged": return state.submitted
      ? { text: "Done · Submitted", tone: "ok" }
      : { text: "Logged", tone: "ok" };
    case "logFailed": return { text: "Not logged yet", tone: "danger" };
    case "wrongTab": return { text: "Switch tabs", tone: "warn" };
    case "timedOut": return { text: "Link timed out", tone: "neutral" };
    case "readOnly": return { text: "View only", tone: "neutral" };
    case "adHoc": return { text: "Ad hoc", tone: "neutral" };
    case "test": return { text: "Test mode", tone: "warn" };
    case "none": return null;
  }
}

/** The task card opens on its own when the coordinator needs to act or read
 * a result (PM decision 5a). Quiet states leave her choice alone. */
export function taskCardNeedsAttention(state: TaskCardState): boolean {
  switch (state.kind) {
    case "access":
    case "denied":
    case "filled":
    case "nothing":
    case "failed":
    case "log":
    case "logged":
    case "logFailed":
    case "wrongTab":
      return true;
    default:
      return false;
  }
}
