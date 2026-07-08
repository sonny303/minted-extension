import { describe, it, expect } from "vitest";
import type { CasePortalTask } from "./apiTypes";
import { buildSubmissionTouchBody, matchPortalTasks } from "./submission";

function task(overrides: Partial<CasePortalTask> = {}): CasePortalTask {
  return {
    taskId: "11111111-1111-1111-1111-111111111111",
    title: "BCBS KS enrollment",
    portalKey: "bcbs_ks_enrollment",
    status: "not_started",
    ...overrides,
  };
}

describe("matchPortalTasks", () => {
  it("returns the single task whose portalKey matches", () => {
    const t = task();
    const result = matchPortalTasks([t], "bcbs_ks_enrollment");
    expect(result).toEqual([t]);
  });

  it("returns every matching task when several share the page's portalKey", () => {
    const a = task({ taskId: "a", title: "Enrollment" });
    const b = task({ taskId: "b", title: "Roster add" });
    const other = task({ taskId: "c", title: "Aetna", portalKey: "aetna_oh" });
    const result = matchPortalTasks([a, b, other], "bcbs_ks_enrollment");
    expect(result).toEqual([a, b]);
  });

  it("returns [] when no task matches the page's portalKey", () => {
    const result = matchPortalTasks([task({ portalKey: "aetna_oh" })], "bcbs_ks_enrollment");
    expect(result).toEqual([]);
  });

  it("treats undefined portalTasks (older server) as an empty array", () => {
    expect(matchPortalTasks(undefined, "bcbs_ks_enrollment")).toEqual([]);
  });

  it("treats null portalTasks as an empty array", () => {
    expect(matchPortalTasks(null, "bcbs_ks_enrollment")).toEqual([]);
  });

  it("ignores entries with a falsy taskId", () => {
    const good = task({ taskId: "good" });
    const bad = task({ taskId: "" });
    expect(matchPortalTasks([bad, good], "bcbs_ks_enrollment")).toEqual([good]);
  });

  it("ignores entries with a falsy portalKey (never crashes on null keys)", () => {
    const good = task();
    // A malformed row with a null portalKey would throw under any re-normalize;
    // it must be filtered out, not blow up.
    const bad = { taskId: "x", title: "malformed", portalKey: null, status: "open" } as unknown as CasePortalTask;
    expect(matchPortalTasks([bad, good], "bcbs_ks_enrollment")).toEqual([good]);
  });

  it("matches literally — a differently-cased key does NOT match (no re-normalization)", () => {
    // The server already emits bare/lowercase keys; the extension must not
    // lowercase/slugify, so an upper-cased key on either side simply misses.
    expect(matchPortalTasks([task({ portalKey: "BCBS_KS_ENROLLMENT" })], "bcbs_ks_enrollment")).toEqual([]);
    expect(matchPortalTasks([task()], "BCBS_KS_ENROLLMENT")).toEqual([]);
  });
});

describe("buildSubmissionTouchBody", () => {
  const base = {
    portalKey: "bcbs_ks_enrollment",
    fillSessionId: "fs-1",
    idempotencyId: "idem-1",
  };

  it("always carries the fixed anchor fields", () => {
    const body = buildSubmissionTouchBody(base);
    expect(body.kind).toBe("portal_submission");
    expect(body.portal_key).toBe("bcbs_ks_enrollment");
    expect(body.fill_session_id).toBe("fs-1");
    expect(body.idempotency_id).toBe("idem-1");
  });

  it("includes task_id ONLY when a task was selected", () => {
    const body = buildSubmissionTouchBody({ ...base, taskId: "task-9" });
    expect(body.task_id).toBe("task-9");
    expect(Object.prototype.hasOwnProperty.call(body, "task_id")).toBe(true);
  });

  it("omits task_id entirely when no task was selected (null)", () => {
    const body = buildSubmissionTouchBody({ ...base, taskId: null });
    expect(Object.prototype.hasOwnProperty.call(body, "task_id")).toBe(false);
  });

  it("omits task_id entirely when taskId is undefined", () => {
    const body = buildSubmissionTouchBody(base);
    expect(Object.prototype.hasOwnProperty.call(body, "task_id")).toBe(false);
  });

  it("omits task_id when taskId is blank/whitespace (never sends empty)", () => {
    const body = buildSubmissionTouchBody({ ...base, taskId: "   " });
    expect(Object.prototype.hasOwnProperty.call(body, "task_id")).toBe(false);
  });

  it("cleans payer_reference_id and wip_note (blank → null, trimmed otherwise)", () => {
    expect(buildSubmissionTouchBody({ ...base, payerReferenceId: "  ", wipNote: "" })).toMatchObject({
      payer_reference_id: null,
      wip_note: null,
    });
    expect(buildSubmissionTouchBody({ ...base, payerReferenceId: "  REF-7 ", wipNote: " note " })).toMatchObject({
      payer_reference_id: "REF-7",
      wip_note: "note",
    });
  });

  it("carries a null fill_session_id through unchanged", () => {
    const body = buildSubmissionTouchBody({ ...base, fillSessionId: null });
    expect(body.fill_session_id).toBeNull();
  });
});
