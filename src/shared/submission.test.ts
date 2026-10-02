import { describe, it, expect } from "vitest";
import type { CasePortalTask } from "./apiTypes";
import { buildSubmissionTouchBody, matchPortalTasks } from "./submission";
import { canonicalizeWorkContextTuple } from "./workContext";

function task(overrides: Partial<CasePortalTask> = {}): CasePortalTask {
  return {
    taskId: "11111111-1111-1111-1111-111111111111",
    title: "Regional Health Plan enrollment",
    portalKey: "regional_enrollment",
    status: "not_started",
    ...overrides,
  };
}

describe("matchPortalTasks", () => {
  it("returns the single task whose portalKey matches", () => {
    const t = task();
    const result = matchPortalTasks([t], "regional_enrollment");
    expect(result).toEqual([t]);
  });

  it("returns every matching task when several share the page's portalKey", () => {
    const a = task({ taskId: "a", title: "Enrollment" });
    const b = task({ taskId: "b", title: "Roster add" });
    const other = task({ taskId: "c", title: "National Health Plan", portalKey: "example_enrollment" });
    const result = matchPortalTasks([a, b, other], "regional_enrollment");
    expect(result).toEqual([a, b]);
  });

  it("returns [] when no task matches the page's portalKey", () => {
    const result = matchPortalTasks([task({ portalKey: "example_enrollment" })], "regional_enrollment");
    expect(result).toEqual([]);
  });

  it("treats undefined portalTasks (older server) as an empty array", () => {
    expect(matchPortalTasks(undefined, "regional_enrollment")).toEqual([]);
  });

  it("treats null portalTasks as an empty array", () => {
    expect(matchPortalTasks(null, "regional_enrollment")).toEqual([]);
  });

  it("ignores entries with a falsy taskId", () => {
    const good = task({ taskId: "good" });
    const bad = task({ taskId: "" });
    expect(matchPortalTasks([bad, good], "regional_enrollment")).toEqual([good]);
  });

  it("ignores entries with a falsy portalKey (never crashes on null keys)", () => {
    const good = task();
    // A malformed row with a null portalKey would throw under any re-normalize;
    // it must be filtered out, not blow up.
    const bad = { taskId: "x", title: "malformed", portalKey: null, status: "open" } as unknown as CasePortalTask;
    expect(matchPortalTasks([bad, good], "regional_enrollment")).toEqual([good]);
  });

  it("matches literally — a differently-cased key does NOT match (no re-normalization)", () => {
    // The server already emits bare/lowercase keys; the extension must not
    // lowercase/slugify, so an upper-cased key on either side simply misses.
    expect(matchPortalTasks([task({ portalKey: "REGIONAL_ENROLLMENT" })], "regional_enrollment")).toEqual([]);
    expect(matchPortalTasks([task()], "REGIONAL_ENROLLMENT")).toEqual([]);
  });
});

describe("buildSubmissionTouchBody", () => {
  const base = {
    portalKey: "regional_enrollment",
    fillSessionId: "fs-1",
    idempotencyId: "idem-1",
  };

  it("always carries the fixed anchor fields", () => {
    const body = buildSubmissionTouchBody(base);
    expect(body.kind).toBe("portal_submission");
    expect(body.portal_key).toBe("regional_enrollment");
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

  it("sends a canonical exact Work tuple only under the snake-case outer key", () => {
    const workContext = canonicalizeWorkContextTuple({
      protocolVersion: 2,
      launchReceiptId: "11111111-1111-4111-8111-111111111111",
      ownerKind: "case",
      ownerId: "22222222-2222-4222-8222-222222222222",
      contextVersion: 4,
      sopTemplateId: "33333333-3333-4333-8333-333333333333",
      sopVersion: 3,
      portalId: "44444444-4444-4444-8444-444444444444",
      portalKey: "regional_enrollment",
      mappingGeneration: 2,
      effectiveMappingFingerprint: `sha256:${"a".repeat(64)}`,
      providerId: "55555555-5555-4555-8555-555555555555",
      orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      facilityId: null,
      taskId: "66666666-6666-4666-8666-666666666666",
      stepId: "77777777-7777-4777-8777-777777777777",
      stepIdentity: "case:task-1:step-2",
    });
    const body = buildSubmissionTouchBody({ ...base, workContext });
    expect(body.work_context).toEqual(workContext);
    expect(body.work_context).not.toHaveProperty("protocolVersion");
    expect(body).not.toHaveProperty("workContext");
  });
});
