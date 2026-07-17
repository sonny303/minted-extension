// TS-80 (pure half): the SET_ACTIVE_CASE receipt rules — strict shape
// validation, origin allowlisting, last-launch semantics live in the worker;
// expiry math and portal-origin matching are pinned here.
import { describe, expect, it } from "vitest";
import {
  ACTIVE_CASE_IDLE_MS,
  isActiveCaseExpired,
  isAllowedHandoffOrigin,
  isPortalOriginUrl,
  parseSetActiveCase,
  resolveActiveCaseState,
  type ActiveCaseRecord,
} from "./handoff";

const CASE_ID = "b7a90000-0000-4000-a000-0000000000c1";
const PROVIDER_ID = "49ad83a8-d8b6-419d-8dcc-88c04a54c4da";
const ORG_ID = "20563fd6-8e95-46a0-8e1c-cb3b968b3c3d";
const PORTAL_URL = "https://provider.bcbsks.com/enroll/form";

const validMessage = {
  type: "SET_ACTIVE_CASE",
  caseId: CASE_ID,
  providerId: PROVIDER_ID,
  orgId: ORG_ID,
  portalUrl: PORTAL_URL,
};

function record(overrides: Partial<ActiveCaseRecord> = {}): ActiveCaseRecord {
  return {
    caseId: CASE_ID,
    providerId: PROVIDER_ID,
    orgId: ORG_ID,
    portalUrl: PORTAL_URL,
    source: "handoff",
    boundTabId: null,
    tabClosedAt: null,
    createdAt: "2026-07-17T10:00:00.000Z",
    lastActivityAt: "2026-07-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("parseSetActiveCase", () => {
  it("accepts the locked TE-1 shape", () => {
    expect(parseSetActiveCase(validMessage)).toEqual(validMessage);
  });

  it("drops unknown fields — nothing beyond the contract rides into storage", () => {
    const parsed = parseSetActiveCase({ ...validMessage, ssn: "123-45-6789", extra: 1 });
    expect(parsed).toEqual(validMessage);
    expect(parsed).not.toHaveProperty("ssn");
  });

  it("rejects wrong type, missing ids, non-UUID ids, and bad URLs", () => {
    expect(parseSetActiveCase(null)).toBeNull();
    expect(parseSetActiveCase({ ...validMessage, type: "OTHER" })).toBeNull();
    expect(parseSetActiveCase({ ...validMessage, caseId: undefined })).toBeNull();
    expect(parseSetActiveCase({ ...validMessage, caseId: "not-a-uuid" })).toBeNull();
    expect(parseSetActiveCase({ ...validMessage, providerId: "123" })).toBeNull();
    expect(parseSetActiveCase({ ...validMessage, orgId: "" })).toBeNull();
    expect(parseSetActiveCase({ ...validMessage, portalUrl: "not a url" })).toBeNull();
    expect(parseSetActiveCase({ ...validMessage, portalUrl: "http://insecure.example" })).toBeNull();
  });
});

describe("origin rules", () => {
  it("allows only the approved app origins", () => {
    expect(isAllowedHandoffOrigin("https://mintedpanel.vercel.app")).toBe(true);
    expect(isAllowedHandoffOrigin("https://evil.example.com")).toBe(false);
    expect(isAllowedHandoffOrigin(undefined)).toBe(false);
  });

  it("matches portal tabs by origin, not prefix", () => {
    expect(isPortalOriginUrl(PORTAL_URL, "https://provider.bcbsks.com/login")).toBe(true);
    expect(isPortalOriginUrl(PORTAL_URL, "https://other.example.com/enroll")).toBe(false);
    expect(isPortalOriginUrl(null, "https://provider.bcbsks.com/x")).toBe(false);
    expect(isPortalOriginUrl(PORTAL_URL, undefined)).toBe(false);
  });
});

describe("expiry (TE-1: tab close or 60 minutes idle)", () => {
  const t0 = Date.parse("2026-07-17T10:00:00.000Z");

  it("stays active inside the idle window", () => {
    expect(isActiveCaseExpired(record(), t0 + ACTIVE_CASE_IDLE_MS - 1000)).toBe(false);
    expect(resolveActiveCaseState(record(), t0 + 1000).status).toBe("active");
  });

  it("expires after 60 idle minutes", () => {
    expect(isActiveCaseExpired(record(), t0 + ACTIVE_CASE_IDLE_MS + 1000)).toBe(true);
    expect(resolveActiveCaseState(record(), t0 + ACTIVE_CASE_IDLE_MS + 1000).status).toBe("expired");
  });

  it("hard-expires when the bound tab closed, regardless of idle time", () => {
    const closed = record({ tabClosedAt: "2026-07-17T10:05:00.000Z" });
    expect(isActiveCaseExpired(closed, t0 + 1000)).toBe(true);
  });

  it("activity resets the idle clock", () => {
    const touched = record({ lastActivityAt: "2026-07-17T10:50:00.000Z" });
    expect(isActiveCaseExpired(touched, t0 + ACTIVE_CASE_IDLE_MS + 1000)).toBe(false);
  });

  it("no record = none", () => {
    expect(resolveActiveCaseState(null, t0).status).toBe("none");
  });
});
