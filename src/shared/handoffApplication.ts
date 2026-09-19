import { activeCaseReceiptKey, type ActiveCaseRecord } from "./handoff";

export type HandoffRead<T> =
  | { status: "ok"; data: T }
  | { status: "error"; message: string; code?: "not-found" }
  | { status: "stale" };

export type HandoffOrgDecision =
  | { status: "ready" }
  | { status: "needs-org-switch"; orgId: string }
  | { status: "rejected"; reason: "nonmember-org" };

export interface HandoffContextFacts {
  providerId: string | null;
  // undefined or [] means the optional full case-location projection cannot
  // add a case-level restriction. The authenticated provider profile still
  // has to prove the explicit location. A nonempty projection is authoritative.
  facilityIds?: readonly string[];
  selectedFacilityId: string | null;
}

export interface HandoffApplicationInput {
  receipt: ActiveCaseRecord;
  currentReceipt: ActiveCaseRecord | null;
  memberOrgIds: readonly string[];
  resolvedOrgId: string | null;
  providers: HandoffRead<readonly string[]>;
  cases: HandoffRead<readonly string[]>;
  context: HandoffRead<HandoffContextFacts>;
  facilities: HandoffRead<readonly string[]>;
  selectedProviderId: string | null;
  selectedCaseId: string | null;
  selectedFacilityId: string | null;
}

/** The exact selection atomically committed for one received handoff. This is
 * panel-local state; the worker persists the same tuple as its Fill/write
 * authority marker. */
export interface AppliedHandoffSelection {
  receiptKey: string;
  providerId: string;
  caseId: string;
  facilityId: string | null;
}

export interface CurrentHandoffSelection {
  providerId: string | null;
  caseId: string | null;
  facilityId: string | null;
}

export type HandoffApplicationRejectionReason =
  | "stale-receipt"
  | "nonmember-org"
  | "wrong-org"
  | "required-read-failed"
  | "provider-unavailable"
  | "case-unavailable"
  | "provider-mismatch"
  | "selection-mismatch"
  | "facility-unavailable"
  | "facility-not-on-case"
  | "facility-selection-mismatch";

export type HandoffApplicationDecision =
  | { status: "applied"; facilityId: string | null }
  | {
      status: "rejected";
      reason: HandoffApplicationRejectionReason;
      message: string;
    };

export function evaluateHandoffOrg(
  receipt: ActiveCaseRecord,
  memberOrgIds: readonly string[],
  resolvedOrgId: string | null,
): HandoffOrgDecision {
  const orgId = receipt.orgId;
  if (orgId == null || !memberOrgIds.includes(orgId)) {
    return { status: "rejected", reason: "nonmember-org" };
  }
  if (resolvedOrgId !== orgId) return { status: "needs-org-switch", orgId };
  return { status: "ready" };
}

function rejection(
  reason: HandoffApplicationRejectionReason,
  message: string,
): HandoffApplicationDecision {
  return { status: "rejected", reason, message };
}

function readFailed(read: HandoffRead<unknown>): boolean {
  return read.status !== "ok";
}

/** Applied provenance and UI authority are valid only while the current DOM
 * selection still equals the receipt-pinned tuple accepted by the worker. */
export function matchesAppliedHandoffSelection(
  record: ActiveCaseRecord | null,
  activeStatus: "none" | "active" | "expired",
  applied: AppliedHandoffSelection | null,
  current: CurrentHandoffSelection,
): boolean {
  return Boolean(
    record?.source === "handoff" &&
      activeStatus === "active" &&
      applied != null &&
      applied.receiptKey === activeCaseReceiptKey(record) &&
      applied.providerId === record.providerId &&
      applied.caseId === record.caseId &&
      (record.facilityId == null || applied.facilityId === record.facilityId) &&
      applied.providerId === current.providerId &&
      applied.caseId === current.caseId &&
      applied.facilityId === current.facilityId,
  );
}

/** Pure final gate for the word "applied". Receipt has already happened; this
 * requires the current authenticated org plus all exact case/provider/facility
 * reads and selections to still describe that same receipt. */
export function evaluateHandoffApplication(
  input: HandoffApplicationInput,
): HandoffApplicationDecision {
  if (
    input.currentReceipt == null ||
    input.currentReceipt.source !== "handoff" ||
    activeCaseReceiptKey(input.currentReceipt) !== activeCaseReceiptKey(input.receipt)
  ) {
    return rejection(
      "stale-receipt",
      "A newer handoff or account change replaced this launch. Use the current case instead.",
    );
  }

  const org = evaluateHandoffOrg(
    input.receipt,
    input.memberOrgIds,
    input.resolvedOrgId,
  );
  if (org.status === "rejected") {
    return rejection(
      "nonmember-org",
      "This account is not a member of the organization for this handoff.",
    );
  }
  if (org.status === "needs-org-switch") {
    return rejection(
      "wrong-org",
      "Switch to the handoff organization before using this case.",
    );
  }

  if (input.providers.status !== "ok") {
    return rejection(
      "required-read-failed",
      "Minted could not verify every required handoff read. Retry from the case.",
    );
  }
  if (!input.providers.data.includes(input.receipt.providerId)) {
    return rejection(
      "provider-unavailable",
      "The handed-off provider is not available in this organization.",
    );
  }
  if (input.cases.status !== "ok") {
    return rejection(
      "required-read-failed",
      "Minted could not verify every required handoff read. Retry from the case.",
    );
  }
  if (!input.cases.data.includes(input.receipt.caseId)) {
    return rejection(
      "case-unavailable",
      "The handed-off case is missing, closed, or unavailable in this organization.",
    );
  }
  if (
    input.receipt.facilityId != null &&
    input.facilities.status === "error" &&
    input.facilities.code === "not-found"
  ) {
    return rejection(
      "facility-unavailable",
      "The selected handoff location is unavailable for this provider. Pick an authorized location explicitly.",
    );
  }
  if (readFailed(input.context) || readFailed(input.facilities)) {
    return rejection(
      "required-read-failed",
      "Minted could not verify every required handoff read. Retry from the case.",
    );
  }

  // Narrowing above proves the remaining required reads have data.
  if (
    input.context.status !== "ok" ||
    input.context.data.providerId !== input.receipt.providerId
  ) {
    return rejection(
      "provider-mismatch",
      "The handed-off case no longer belongs to the expected provider.",
    );
  }
  if (
    input.selectedProviderId !== input.receipt.providerId ||
    input.selectedCaseId !== input.receipt.caseId
  ) {
    return rejection(
      "selection-mismatch",
      "The selected provider or case changed before the handoff finished.",
    );
  }

  const explicitFacilityId = input.receipt.facilityId;
  if (explicitFacilityId != null) {
    if (
      input.facilities.status !== "ok" ||
      !input.facilities.data.includes(explicitFacilityId)
    ) {
      return rejection(
        "facility-unavailable",
        "The selected handoff location is unavailable for this provider. Pick an authorized location explicitly.",
      );
    }
    const projectedFacilities = input.context.data.facilityIds;
    if (
      projectedFacilities != null &&
      projectedFacilities.length > 0 &&
      !projectedFacilities.includes(explicitFacilityId)
    ) {
      return rejection(
        "facility-not-on-case",
        "The selected handoff location is not available on this case. Pick a case location explicitly.",
      );
    }
    if (input.selectedFacilityId !== explicitFacilityId) {
      return rejection(
        "facility-selection-mismatch",
        "The selected location changed before the handoff finished.",
      );
    }
  }

  return { status: "applied", facilityId: explicitFacilityId };
}

/** Read-only return target for an applied handoff. API_BASE_URL is the web
 * environment root by release contract (it never includes `/api`). */
export function caseReturnUrl(webBaseUrl: string, caseId: string): string {
  return new URL(`/cases/${encodeURIComponent(caseId)}`, webBaseUrl).toString();
}
