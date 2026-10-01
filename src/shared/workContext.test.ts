import { describe, expect, it } from "vitest";
import {
  ACTIVE_WORK_IDLE_MS,
  activeWorkTupleKey,
  canonicalizeWorkContextTuple,
  isActiveWorkExpired,
  parseSetActiveWork,
  parseWorkContextValidationResponse,
  resolveActiveWorkState,
  tupleFromSetActiveWorkMessage,
  workFormUrlMatchesPage,
  workTuplesEqual,
  type WorkContextTuple,
} from "./workContext";

const ids = {
  receipt: "11111111-1111-4111-8111-111111111111",
  owner: "22222222-2222-4222-8222-222222222222",
  sop: "33333333-3333-4333-8333-333333333333",
  portal: "44444444-4444-4444-8444-444444444444",
  provider: "55555555-5555-4555-8555-555555555555",
  org: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  task: "66666666-6666-4666-8666-666666666666",
  step: "77777777-7777-4777-8777-777777777777",
  assignment: "88888888-8888-4888-8888-888888888888",
  facility: "99999999-9999-4999-8999-999999999999",
};

const caseMessage = {
  type: "SET_ACTIVE_WORK",
  portalUrl: "https://portal.example.com/enroll",
  protocolVersion: 2,
  launchReceiptId: ids.receipt,
  ownerKind: "case",
  ownerId: ids.owner,
  contextVersion: 4,
  sopTemplateId: ids.sop,
  sopVersion: 3,
  portalId: ids.portal,
  portalKey: "regional_enrollment",
  mappingGeneration: 2,
  effectiveMappingFingerprint: `sha256:${"a".repeat(64)}`,
  providerId: ids.provider,
  orgId: ids.org,
  facilityId: ids.facility,
  taskId: ids.task,
  stepId: ids.step,
  stepIdentity: "case:task-1:step-2",
};

const contractMessage = {
  ...caseMessage,
  ownerKind: "contract",
  assignmentId: ids.assignment,
  taskIndex: 1,
  stepIndex: 0,
  stepIdentity: "contract:assignment:task-1:step-0",
};
delete (contractMessage as Partial<typeof contractMessage>).taskId;
delete (contractMessage as Partial<typeof contractMessage>).stepId;

function activeTuple(): WorkContextTuple {
  const parsed = parseSetActiveWork(caseMessage);
  if (!parsed.ok) throw new Error("invalid test tuple");
  return tupleFromSetActiveWorkMessage(parsed.message);
}

describe("SET_ACTIVE_WORK protocol v2", () => {
  it("strictly parses case tuple with context and exact step identity", () => {
    const result = parseSetActiveWork(caseMessage);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.ownerKind).toBe("case");
      expect(result.message.stepIdentity).toBe("case:task-1:step-2");
    }
  });

  it("strictly parses the Contract assignment/index tuple", () => {
    const result = parseSetActiveWork(contractMessage);
    expect(result.ok).toBe(true);
    if (result.ok && result.message.ownerKind === "contract") {
      expect(result.message.assignmentId).toBe(ids.assignment);
      expect(result.message.taskIndex).toBe(1);
      expect(result.message.stepIndex).toBe(0);
    }
  });

  it("accepts Panel portal keys and step identities within the shared bounds", () => {
    const message = {
      ...caseMessage,
      portalKey: "medicare.part-b_v2",
      stepIdentity: "s".repeat(512),
    };
    expect(parseSetActiveWork(message).ok).toBe(true);
  });

  it("accepts only the Panel canonical SHA-256 fingerprint format", () => {
    expect(parseSetActiveWork({ ...caseMessage, effectiveMappingFingerprint: `sha256:${"b".repeat(64)}` }).ok).toBe(true);
    for (const effectiveMappingFingerprint of [
      `sha256:${"B".repeat(64)}`,
      `sha256:${"c".repeat(63)}`,
      `sha256:${"d".repeat(65)}`,
      `sha-256:${"e".repeat(64)}`,
      `fingerprint_${"f".repeat(64)}`,
    ]) {
      expect(parseSetActiveWork({ ...caseMessage, effectiveMappingFingerprint }).ok).toBe(false);
    }
  });

  it("requires an update for unsupported protocol clients without legacy fallback", () => {
    expect(parseSetActiveWork({ ...caseMessage, protocolVersion: 1 })).toEqual({
      ok: false,
      code: "UPDATE_REQUIRED",
    });
  });

  it("rejects partial owner tuples, unknown fields, portal URLs, and bad generations", () => {
    expect(parseSetActiveWork({ ...caseMessage, taskId: undefined })).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(parseSetActiveWork({ ...caseMessage, extra: "not in v2" })).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(parseSetActiveWork({ ...caseMessage, portalUrl: "http://provider.example/form" })).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(parseSetActiveWork({ ...caseMessage, mappingGeneration: 0 })).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
    expect(parseSetActiveWork({ ...contractMessage, taskId: ids.task })).toEqual({
      ok: false,
      code: "INVALID_REQUEST",
    });
  });
});

describe("work-context validation response", () => {
  it("accepts only an exact canonical tuple and same-key web maps", () => {
    const tuple = canonicalizeWorkContextTuple(activeTuple());
    const map = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      orgId: null,
      portalKey: tuple.portalKey,
      mapType: "web",
      selector: "label:Provider NPI",
      source: "token",
      status: "approved",
    };
    const response = {
      tuple,
      caseType: "enrollment",
      formUrl: "https://portal.example.com/enroll",
      requiresExplicitSelection: true,
      mappingGeneration: tuple.mappingGeneration,
      effectiveMappingFingerprint: tuple.effectiveMappingFingerprint,
      effectiveWebMaps: [map],
    };
    expect(parseWorkContextValidationResponse(response)).toMatchObject(response);
    expect(parseWorkContextValidationResponse({ ...response, effectiveWebMaps: [{ ...map, portalKey: "other" }] })).toBeNull();
    expect(parseWorkContextValidationResponse({ ...response, formUrl: "https://user:secret@portal.example.com" })).toBeNull();
    expect(parseWorkContextValidationResponse({ ...response, tuple: { ...tuple, stepIdentity: "different" } })).not.toBeNull();
  });

  it("accepts the Panel SHA-256 fingerprint in both tuple and response fields", () => {
    const tuple = canonicalizeWorkContextTuple(activeTuple());
    const response = {
      tuple,
      caseType: "enrollment",
      formUrl: "https://portal.example.com/enroll",
      requiresExplicitSelection: false,
      mappingGeneration: tuple.mappingGeneration,
      effectiveMappingFingerprint: tuple.effectiveMappingFingerprint,
      effectiveWebMaps: [],
    };
    expect(parseWorkContextValidationResponse(response)).not.toBeNull();
    expect(parseWorkContextValidationResponse({
      ...response,
      effectiveMappingFingerprint: `sha256:${"A".repeat(64)}`,
    })).toBeNull();
    expect(parseWorkContextValidationResponse({
      ...response,
      tuple: { ...tuple, effectiveMappingFingerprint: `sha256:${"1".repeat(63)}` },
    })).toBeNull();
  });

  it("compares complete immutable tuples, including repeated-step identity", () => {
    const tuple = activeTuple();
    expect(workTuplesEqual(tuple, { ...tuple })).toBe(true);
    expect(workTuplesEqual(tuple, { ...tuple, stepIdentity: "another-step" })).toBe(false);
    expect(workTuplesEqual(tuple, { ...tuple, portalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).toBe(false);
  });
});

describe("active Work expiry", () => {
  const t0 = Date.parse("2026-10-01T12:00:00.000Z");
  const record = {
    tuple: activeTuple(),
    boundTabId: 53,
    formOrigin: "https://portal.example.com",
    formPath: "/enroll",
    caseType: "enrollment" as const,
    createdAt: new Date(t0).toISOString(),
    lastActivityAt: new Date(t0).toISOString(),
  };

  it("expires after one hour idle and stays live while refreshed", () => {
    expect(isActiveWorkExpired(record, t0 + ACTIVE_WORK_IDLE_MS + 1)).toBe(true);
    expect(isActiveWorkExpired({ ...record, lastActivityAt: new Date(t0 + 50 * 60_000).toISOString() }, t0 + ACTIVE_WORK_IDLE_MS + 1)).toBe(false);
    expect(resolveActiveWorkState(null, t0).status).toBe("none");
  });

  it("matches only the configured origin and path prefix", () => {
    expect(workFormUrlMatchesPage("https://portal.example.com/enroll/step-2?state=x", record.formOrigin, record.formPath)).toBe(true);
    expect(workFormUrlMatchesPage("https://portal.example.com/enrollment/step-2", record.formOrigin, record.formPath)).toBe(false);
    expect(workFormUrlMatchesPage("https://other.example.com/enroll", record.formOrigin, record.formPath)).toBe(false);
  });

  it("compares canonical tuple fields independently of object property order", () => {
    const tuple = activeTuple();
    const reversed = Object.fromEntries(Object.entries(tuple).reverse()) as WorkContextTuple;
    expect(workTuplesEqual(tuple, reversed)).toBe(true);
    expect(activeWorkTupleKey(tuple)).toBe(activeWorkTupleKey(reversed));
  });
});
