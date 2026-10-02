import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(async () => "test-token"),
  forceRefresh: vi.fn(async () => "refreshed-token"),
  readActiveOrgId: vi.fn(async () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  readPanelMode: vi.fn(async (): Promise<"case" | "train"> => "case"),
}));

vi.mock("./auth", () => ({
  getAccessToken: mocks.getAccessToken,
  forceRefresh: mocks.forceRefresh,
  AuthRequiredError: class AuthRequiredError extends Error {},
}));
vi.mock("./orgState", () => ({ readActiveOrgId: mocks.readActiveOrgId }));
vi.mock("./mode", () => ({ readPanelMode: mocks.readPanelMode }));

const { postFillEvent, validateWorkContext } = await import("./api");

const tuple = {
  protocolVersion: 2 as const,
  launchReceiptId: "11111111-1111-4111-8111-111111111111",
  ownerKind: "case" as const,
  ownerId: "22222222-2222-4222-8222-222222222222",
  contextVersion: 4,
  sopTemplateId: "33333333-3333-4333-8333-333333333333",
  sopVersion: 3,
  portalId: "44444444-4444-4444-8444-444444444444",
  portalKey: "regional.enrollment",
  mappingGeneration: 2,
  effectiveMappingFingerprint: `sha256:${"a".repeat(64)}`,
  providerId: "55555555-5555-4555-8555-555555555555",
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  facilityId: null,
  taskId: "66666666-6666-4666-8666-666666666666",
  stepId: "77777777-7777-4777-8777-777777777777",
  stepIdentity: "case:task-1:step-2",
};

function canonicalTuple(): Record<string, unknown> {
  const result: Record<string, unknown> = { ...tuple };
  delete result.protocolVersion;
  return result;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.readActiveOrgId.mockResolvedValue("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  mocks.readPanelMode.mockResolvedValue("case");
});

describe("Work context validation request", () => {
  it("sends the exact body org as x-org-id and requires the canonical org echo", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: {
        tuple: canonicalTuple(),
        caseType: "enrollment",
        formUrl: "https://portal.example.com/enroll",
        requiresExplicitSelection: true,
        mappingGeneration: tuple.mappingGeneration,
        effectiveMappingFingerprint: tuple.effectiveMappingFingerprint,
        effectiveWebMaps: [],
      },
      meta: null,
      error: null,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateWorkContext(tuple);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(String(url)).toContain("/api/work-context/validate");
    expect(headers.get("x-org-id")).toBe(tuple.orgId);
    expect(JSON.parse(String(init?.body))).toMatchObject({ orgId: tuple.orgId });
    expect(result.tuple.orgId).toBe(tuple.orgId);
  });

  it("fails closed if panel mode switches before validation starts", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    mocks.readPanelMode.mockResolvedValueOnce("train");

    await expect(validateWorkContext(tuple)).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Work fill receipt wire contract", () => {
  const eventBody = () => ({
    id: "99999999-9999-4999-8999-999999999999",
    caseId: tuple.ownerId,
    providerId: tuple.providerId,
    portalKey: tuple.portalKey,
    fillMode: "web" as const,
    startedAt: "2026-10-01T12:00:00.000Z",
    completedAt: "2026-10-01T12:00:01.000Z",
    fieldsFilled: 1,
    fieldsSkipped: [],
    v2: { schemaVersion: 2 as const, fieldsAttempted: 1, fieldsVerified: 1, fieldsRejected: 0, fieldOutcomes: [] },
    workContext: canonicalTuple() as never,
  });

  it("sends the protocol-free canonical tuple and verifies the persisted exact-step row", async () => {
    const body = eventBody();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: {
        id: body.id,
        caseId: tuple.ownerId,
        providerId: tuple.providerId,
        portalKey: tuple.portalKey,
        fillMode: "web",
        isTest: false,
        eventSchemaVersion: 2,
        caseTaskId: tuple.taskId,
        caseStepId: tuple.stepId,
        contractId: null,
        contractSopAssignmentId: null,
        taskIndex: null,
        stepIndex: null,
        contextVersion: tuple.contextVersion,
        sopTemplateId: tuple.sopTemplateId,
        sopVersion: tuple.sopVersion,
        portalId: tuple.portalId,
        mappingGeneration: tuple.mappingGeneration,
        effectiveMappingFingerprint: tuple.effectiveMappingFingerprint,
        facilityId: tuple.facilityId,
        launchReceiptId: tuple.launchReceiptId,
        stepIdentity: tuple.stepIdentity,
      },
      meta: null,
      error: null,
    }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await postFillEvent(body);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const sent = JSON.parse(String(init?.body));
    expect(sent.workContext).toEqual(canonicalTuple());
    expect(sent.workContext).not.toHaveProperty("protocolVersion");
    expect(sent).not.toHaveProperty("taskId");
  });

  it("rejects a persisted fill row from a different SOP step", async () => {
    const body = eventBody();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: {
        id: body.id,
        caseId: tuple.ownerId,
        providerId: tuple.providerId,
        portalKey: tuple.portalKey,
        fillMode: "web",
        isTest: false,
        eventSchemaVersion: 2,
        caseTaskId: tuple.taskId,
        caseStepId: "88888888-8888-4888-8888-888888888888",
        contractId: null,
        contractSopAssignmentId: null,
        taskIndex: null,
        stepIndex: null,
        contextVersion: tuple.contextVersion,
        sopTemplateId: tuple.sopTemplateId,
        sopVersion: tuple.sopVersion,
        portalId: tuple.portalId,
        mappingGeneration: tuple.mappingGeneration,
        effectiveMappingFingerprint: tuple.effectiveMappingFingerprint,
        facilityId: tuple.facilityId,
        launchReceiptId: tuple.launchReceiptId,
        stepIdentity: tuple.stepIdentity,
      },
      meta: null,
      error: null,
    }), { status: 201, headers: { "content-type": "application/json" } })));

    await expect(postFillEvent(body)).rejects.toMatchObject({ status: 502 });
  });

  it("does not treat a mismatched persisted fill row as a successful receipt", async () => {
    const body = eventBody();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: { id: "different-fill", providerId: tuple.providerId, portalKey: tuple.portalKey,
        caseId: tuple.ownerId, fillMode: "web", isTest: false, eventSchemaVersion: 2 },
      meta: null,
      error: null,
    }), { status: 201, headers: { "content-type": "application/json" } })));

    await expect(postFillEvent(body)).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      message: expect.stringContaining("fill receipt"),
    });
  });
});
