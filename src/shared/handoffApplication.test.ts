import { describe, expect, it } from "vitest";
import type { ActiveCaseRecord } from "./handoff";
import {
  caseReturnUrl,
  evaluateHandoffApplication,
  evaluateHandoffOrg,
  isTerminalHandoffRejection,
  matchesAppliedHandoffSelection,
  type HandoffApplicationInput,
  type HandoffApplicationRejectionReason,
} from "./handoffApplication";

const CASE_ID = "b7a90000-0000-4000-a000-0000000000c1";
const PROVIDER_ID = "49ad83a8-d8b6-419d-8dcc-88c04a54c4da";
const ORG_ID = "20563fd6-8e95-46a0-8e1c-cb3b968b3c3d";
const OTHER_ORG_ID = "30563fd6-8e95-46a0-8e1c-cb3b968b3c3d";
const PRIMARY_FACILITY_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECONDARY_FACILITY_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

function receipt(overrides: Partial<ActiveCaseRecord> = {}): ActiveCaseRecord {
  return {
    receiptId: "receipt-a",
    caseId: CASE_ID,
    providerId: PROVIDER_ID,
    orgId: ORG_ID,
    portalUrl: "https://portal.example.com/enroll",
    portalKey: "regional_enrollment",
    facilityId: SECONDARY_FACILITY_ID,
    source: "handoff",
    boundTabId: 7,
    tabClosedAt: null,
    createdAt: "2026-09-18T12:00:00.000Z",
    lastActivityAt: "2026-09-18T12:00:00.000Z",
    ...overrides,
  };
}

function validInput(overrides: Partial<HandoffApplicationInput> = {}): HandoffApplicationInput {
  const record = receipt();
  return {
    receipt: record,
    currentReceipt: record,
    memberOrgIds: [ORG_ID],
    resolvedOrgId: ORG_ID,
    providers: { status: "ok", data: [PROVIDER_ID] },
    cases: { status: "ok", data: [CASE_ID] },
    context: {
      status: "ok",
      data: {
        providerId: PROVIDER_ID,
        selectedFacilityId: PRIMARY_FACILITY_ID,
        facilityIds: [PRIMARY_FACILITY_ID, SECONDARY_FACILITY_ID],
      },
    },
    facilities: {
      status: "ok",
      data: [PRIMARY_FACILITY_ID, SECONDARY_FACILITY_ID],
    },
    selectedProviderId: PROVIDER_ID,
    selectedCaseId: CASE_ID,
    selectedFacilityId: SECONDARY_FACILITY_ID,
    ...overrides,
  };
}

describe("handoff org decision", () => {
  it("rejects a nonmember org and asks before a member-org switch", () => {
    expect(evaluateHandoffOrg(receipt(), [OTHER_ORG_ID], OTHER_ORG_ID)).toEqual({
      status: "rejected",
      reason: "nonmember-org",
    });
    expect(evaluateHandoffOrg(receipt(), [ORG_ID, OTHER_ORG_ID], OTHER_ORG_ID)).toEqual({
      status: "needs-org-switch",
      orgId: ORG_ID,
    });
  });

  it("is ready only when the member org is the resolved org", () => {
    expect(evaluateHandoffOrg(receipt(), [ORG_ID], ORG_ID)).toEqual({ status: "ready" });
  });
});

describe("authenticated handoff application", () => {
  it("applies an explicit secondary facility without substituting the primary", () => {
    expect(evaluateHandoffApplication(validInput())).toEqual({
      status: "applied",
      facilityId: SECONDARY_FACILITY_ID,
    });
  });

  it("rejects a stale completion after a newer receipt or clear", () => {
    expect(
      evaluateHandoffApplication(
        validInput({ currentReceipt: receipt({ receiptId: "receipt-b" }) }),
      ),
    ).toMatchObject({ status: "rejected", reason: "stale-receipt" });
    expect(
      evaluateHandoffApplication(validInput({ currentReceipt: null })),
    ).toMatchObject({ status: "rejected", reason: "stale-receipt" });
  });

  it("rejects failed required reads, missing providers/cases, and provider mismatch", () => {
    expect(
      evaluateHandoffApplication(
        validInput({ cases: { status: "error", message: "case read failed" } }),
      ),
    ).toMatchObject({ status: "rejected", reason: "required-read-failed" });
    expect(
      evaluateHandoffApplication(validInput({ providers: { status: "ok", data: [] } })),
    ).toMatchObject({ status: "rejected", reason: "provider-unavailable" });
    expect(
      evaluateHandoffApplication(validInput({ cases: { status: "ok", data: [] } })),
    ).toMatchObject({ status: "rejected", reason: "case-unavailable" });
    expect(
      evaluateHandoffApplication(
        validInput({
          context: {
            status: "ok",
            data: {
              providerId: "59ad83a8-d8b6-419d-8dcc-88c04a54c4da",
              facilityIds: [SECONDARY_FACILITY_ID],
              selectedFacilityId: SECONDARY_FACILITY_ID,
            },
          },
        }),
      ),
    ).toMatchObject({ status: "rejected", reason: "provider-mismatch" });
  });

  it("rejects an unavailable or case-unauthorized explicit facility", () => {
    expect(
      evaluateHandoffApplication(
        validInput({ facilities: { status: "ok", data: [PRIMARY_FACILITY_ID] } }),
      ),
    ).toMatchObject({ status: "rejected", reason: "facility-unavailable" });
    expect(
      evaluateHandoffApplication(
        validInput({
          context: {
            status: "ok",
            data: {
              providerId: PROVIDER_ID,
              selectedFacilityId: PRIMARY_FACILITY_ID,
              facilityIds: [PRIMARY_FACILITY_ID],
            },
          },
        }),
      ),
    ).toMatchObject({ status: "rejected", reason: "facility-not-on-case" });
  });

  it("allows provider-verified explicit facilities when E1.4 case locations are empty", () => {
    expect(
      evaluateHandoffApplication(
        validInput({
          context: {
            status: "ok",
            data: {
              providerId: PROVIDER_ID,
              selectedFacilityId: PRIMARY_FACILITY_ID,
              facilityIds: [],
            },
          },
        }),
      ),
    ).toEqual({ status: "applied", facilityId: SECONDARY_FACILITY_ID });

    expect(
      evaluateHandoffApplication(
        validInput({
          context: {
            status: "ok",
            data: {
              providerId: PROVIDER_ID,
              selectedFacilityId: PRIMARY_FACILITY_ID,
            },
          },
        }),
      ),
    ).toEqual({ status: "applied", facilityId: SECONDARY_FACILITY_ID });

    expect(
      evaluateHandoffApplication(
        validInput({
          context: {
            status: "ok",
            data: {
              providerId: PROVIDER_ID,
              selectedFacilityId: PRIMARY_FACILITY_ID,
              facilityIds: [PRIMARY_FACILITY_ID],
            },
          },
        }),
      ),
    ).toMatchObject({ status: "rejected", reason: "facility-not-on-case" });
  });

  it("rejects provider, case, or explicit facility selection drift", () => {
    expect(
      evaluateHandoffApplication(validInput({ selectedProviderId: null })),
    ).toMatchObject({ status: "rejected", reason: "selection-mismatch" });
    expect(
      evaluateHandoffApplication(validInput({ selectedCaseId: null })),
    ).toMatchObject({ status: "rejected", reason: "selection-mismatch" });
    expect(
      evaluateHandoffApplication(
        validInput({ selectedFacilityId: PRIMARY_FACILITY_ID }),
      ),
    ).toMatchObject({
      status: "rejected",
      reason: "facility-selection-mismatch",
    });
  });

  it("keeps the base-case compatibility when the optional facility is absent", () => {
    expect(
      evaluateHandoffApplication(
        validInput({
          receipt: receipt({ facilityId: null }),
          currentReceipt: receipt({ facilityId: null }),
          selectedFacilityId: PRIMARY_FACILITY_ID,
        }),
      ),
    ).toEqual({ status: "applied", facilityId: null });
  });
});

describe("applied handoff selection authority", () => {
  const applied = {
    receiptKey: "receipt-a",
    providerId: PROVIDER_ID,
    caseId: CASE_ID,
    facilityId: SECONDARY_FACILITY_ID,
  };
  const current = {
    providerId: PROVIDER_ID,
    caseId: CASE_ID,
    facilityId: SECONDARY_FACILITY_ID,
  };

  it("requires the active receipt and exact committed provider/case/facility tuple", () => {
    expect(matchesAppliedHandoffSelection(receipt(), "active", applied, current)).toBe(true);
    expect(
      matchesAppliedHandoffSelection(receipt(), "active", applied, {
        ...current,
        facilityId: PRIMARY_FACILITY_ID,
      }),
    ).toBe(false);
    expect(
      matchesAppliedHandoffSelection(
        receipt({ receiptId: "receipt-b" }),
        "active",
        applied,
        current,
      ),
    ).toBe(false);
    expect(matchesAppliedHandoffSelection(receipt(), "expired", applied, current)).toBe(false);
    expect(matchesAppliedHandoffSelection(receipt(), "active", null, current)).toBe(false);
  });
});

describe("same-case return", () => {
  it("uses the configured web environment and exact case without a write", () => {
    expect(caseReturnUrl("https://staging.mintedpanel.com", CASE_ID)).toBe(
      `https://staging.mintedpanel.com/cases/${CASE_ID}`,
    );
  });
});

describe("terminal handoff rejection", () => {
  it("latches permanent failures and leaves recoverable races/reads open", () => {
    const terminal: HandoffApplicationRejectionReason[] = [
      "nonmember-org",
      "provider-unavailable",
      "case-unavailable",
      "provider-mismatch",
      "facility-unavailable",
      "facility-not-on-case",
    ];
    const transient: HandoffApplicationRejectionReason[] = [
      "stale-receipt",
      "wrong-org",
      "required-read-failed",
      "selection-mismatch",
      "facility-selection-mismatch",
    ];
    for (const reason of terminal) {
      expect(isTerminalHandoffRejection(reason)).toBe(true);
    }
    for (const reason of transient) {
      expect(isTerminalHandoffRejection(reason)).toBe(false);
    }
  });
});
