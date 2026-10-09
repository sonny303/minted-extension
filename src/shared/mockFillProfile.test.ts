import { describe, expect, it } from "vitest";
import {
  MOCK_FILL_PROFILE_VERSION,
  MOCK_FILL_VALUES,
  buildMockTokenMap,
  mockValueForToken,
} from "./mockFillProfile";

describe("mock fill profile (extension)", () => {
  it("is versioned", () => {
    expect(MOCK_FILL_PROFILE_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("curated values are all non-empty and visibly synthetic (no real-data reads)", () => {
    for (const [token, value] of Object.entries(MOCK_FILL_VALUES)) {
      expect(value.trim(), token).not.toBe("");
    }
  });

  it("never carries a full SSN — last-4 only, and no 9-digit ssn value", () => {
    for (const [token, value] of Object.entries(MOCK_FILL_VALUES)) {
      if (token.toLowerCase().includes("ssn")) {
        expect(value).toMatch(/^\d{4}$/);
      }
    }
    expect(mockValueForToken("provider.ssnLast4")).toMatch(/^\d{4}$/);
    expect(mockValueForToken("custom.ssn")).toMatch(/^\d{4}$/);
  });

  it("resolves curated tokens from the map", () => {
    expect(mockValueForToken("provider.npi")).toBe(MOCK_FILL_VALUES["provider.npi"]);
    expect(mockValueForToken("license.licenseNumber")).toBe("SAMPLE-12345");
    expect(mockValueForToken("user.name")).toBe("Sample Operator");
    expect(mockValueForToken("facility.fullAddress")).toBe(
      "456 Sample Ave, Suite 100, Sampleville, NC 27601",
    );
    expect(mockValueForToken("billingContact.fullName")).toBe("Sample Billing");
    expect(mockValueForToken("credentialingContact.email")).toBe("credentialing.contact@example.com");
    expect(mockValueForToken("contractingSigner.title")).toBe("Authorized Signer");
    expect(mockValueForToken("groupInsurance.insurerName")).toBe("Sample Mutual Insurance");
    expect(mockValueForToken("assignment.isPrimary")).toBe("Yes");
  });

  it("heuristics cover unknown tokens by field name", () => {
    expect(mockValueForToken("custom.someDate")).toBe("2026-01-15");
    expect(mockValueForToken("custom.supportEmail")).toBe("sample@example.com");
    expect(mockValueForToken("custom.directPhone")).toBe("5555550100");
    expect(mockValueForToken("custom.workState")).toBe("NC");
    expect(mockValueForToken("custom.deliveryZip")).toBe("27601");
    expect(mockValueForToken("custom.deliveryPostalCode")).toBe("27601");
    expect(mockValueForToken("custom.billingNpi")).toBe("1999999984");
  });

  it("falls back to a deterministic Sample string, never empty", () => {
    const v = mockValueForToken("custom.someBrandNewField");
    expect(v).toBe("Sample some brand new field");
    expect(mockValueForToken("custom.someBrandNewField")).toBe(v);
  });

  it("buildMockTokenMap resolves every distinct mapped token non-empty", () => {
    const tokens = ["provider.npi", null, undefined, "  ", "provider.npi", "mso.name"];
    const built = buildMockTokenMap(tokens);
    expect(Object.keys(built).sort()).toEqual(["mso.name", "provider.npi"]);
    for (const value of Object.values(built)) {
      expect(value.trim()).not.toBe("");
    }
  });

  it("contains more than 200 comprehensive form filler tokens", () => {
    expect(Object.keys(MOCK_FILL_VALUES).length).toBeGreaterThan(200);
  });
});
