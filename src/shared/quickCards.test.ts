// TS-101 (quick-card render rules: honest empties + expiry badges), TS-102
// (layout degrade), TS-103 (escape-hatch path) — the pure halves.
import { describe, expect, it } from "vitest";
import type { ProfileToken, UnresolvedToken } from "./apiTypes";
import {
  DEFAULT_QUICK_CARD_LAYOUT,
  MAX_LAYOUT_FIELDS,
  QUICK_CARD_FIELD_CATALOG,
  expiryStatus,
  isQuickCardField,
  isType2Field,
  projectQuickCards,
  providerWebappPath,
  resolveLayout,
} from "./quickCards";

const TODAY = "2026-07-17";

const tokens: ProfileToken[] = [
  { token: "provider.firstName", value: "Kay" },
  { token: "provider.lastName", value: "One" },
  { token: "provider.credentials", value: "PT, DPT" },
  { token: "provider.dateOfBirth", value: "1980-01-15" },
  { token: "provider.npi", value: "1234567890" },
  { token: "provider.caqhId", value: null },
  { token: "license.licenseNumber", value: "KS-12345" },
  { token: "license.state", value: "KS" },
  { token: "license.expirationDate", value: "2026-08-01" }, // 15 days out
  { token: "group.name", value: "Kansas Fitness Physio Group" },
  { token: "group.tin", value: "48-1234567" },
  { token: "group.npiType2", value: "1098765432" },
  { token: "groupInsurance.insurerName", value: "CoverWell Mutual" },
  { token: "groupInsurance.policyNumber", value: "MP-889900" },
  { token: "groupInsurance.policyEndDate", value: "2026-06-01" }, // already past
];

const unresolved: UnresolvedToken[] = [{ token: "provider.caqhId", reason: "empty on provider" }];

describe("closed catalog (TE-16 mirror)", () => {
  it("structurally excludes ssnLast4 and every vault/sensitive key", () => {
    expect(isQuickCardField("provider.ssnLast4")).toBe(false);
    expect(QUICK_CARD_FIELD_CATALOG).not.toContain("provider.ssnLast4");
    expect(isQuickCardField("provider.npi")).toBe(true);
  });

  it("keeps the default layout inside the catalog", () => {
    for (const key of DEFAULT_QUICK_CARD_LAYOUT) expect(isQuickCardField(key)).toBe(true);
  });

  it("caps a layout at the defaults plus 3 custom fields", () => {
    expect(MAX_LAYOUT_FIELDS).toBe(DEFAULT_QUICK_CARD_LAYOUT.length + 3);
  });
});

describe("resolveLayout (TE-15 degrade — never a broken card)", () => {
  it("returns a valid saved layout in the user's order", () => {
    const saved = ["group.tin", "provider.npi"];
    expect(resolveLayout(saved)).toEqual({ fields: saved, source: "saved" });
  });

  it.each([
    ["null", null],
    ["not an array", "provider.npi"],
    ["empty", []],
    ["unknown key", ["provider.npi", "provider.medicareId"]],
    ["excluded key", ["provider.ssnLast4"]],
    ["duplicate", ["provider.npi", "provider.npi"]],
    ["non-string", ["provider.npi", 5]],
  ])("degrades %s to the default layout", (_label, stored) => {
    expect(resolveLayout(stored)).toEqual({
      fields: [...DEFAULT_QUICK_CARD_LAYOUT],
      source: "default",
    });
  });
});

describe("expiryStatus (< 30-day amber rule)", () => {
  it("flags inside the window, passes outside, marks past dates expired", () => {
    expect(expiryStatus("2026-08-01", TODAY)).toBe("expiring"); // 15 days
    expect(expiryStatus("2026-08-16", TODAY)).toBe("ok"); // 30 days exactly
    expect(expiryStatus("2026-08-15", TODAY)).toBe("expiring"); // 29 days
    expect(expiryStatus("2027-01-01", TODAY)).toBe("ok");
    expect(expiryStatus("2026-06-01", TODAY)).toBe("expired");
    expect(expiryStatus("2026-07-17", TODAY)).toBe("expiring"); // today = 0 days
    expect(expiryStatus(null, TODAY)).toBeNull();
    expect(expiryStatus("garbage", TODAY)).toBeNull();
  });
});

describe("projectQuickCards (TS-101)", () => {
  const layout = resolveLayout(null);
  const cards = projectQuickCards(tokens, unresolved, layout, TODAY);

  it("renders the Type 1 header from the profile", () => {
    expect(cards.name).toBe("Kay One");
    expect(cards.credentials).toBe("PT, DPT");
    expect(cards.dateOfBirth).toBe("1980-01-15");
  });

  it("splits the default layout across the two cards by token family", () => {
    expect(cards.type1Fields.map((f) => f.key)).toEqual([
      "provider.npi",
      "provider.caqhId",
      "license.licenseNumber",
    ]);
    expect(cards.type2Fields.map((f) => f.key)).toEqual(["group.npiType2", "group.tin"]);
    expect(isType2Field("groupInsurance.policyNumber")).toBe(true);
    expect(isType2Field("license.licenseNumber")).toBe(false);
  });

  it("renders honest empties with the profile's unresolved reason", () => {
    const caqh = cards.type1Fields.find((f) => f.key === "provider.caqhId");
    expect(caqh?.value).toBeNull();
    expect(caqh?.reason).toBe("empty on provider");
  });

  it("flags the license expiring inside 30 days and the lapsed malpractice", () => {
    expect(cards.license.expiry).toBe("expiring");
    expect(cards.license.number.value).toBe("KS-12345");
    expect(cards.malpractice.expiry).toBe("expired");
    expect(cards.malpractice.insurer.value).toBe("CoverWell Mutual");
  });

  it("carries the group name and the layout provenance", () => {
    expect(cards.groupName).toBe("Kansas Fitness Physio Group");
    expect(cards.layoutSource).toBe("default");
  });

  it("falls back to legacy provider.* license columns when license.* is empty", () => {
    const legacyTokens: ProfileToken[] = [
      { token: "provider.licenseNumber", value: "LEGACY-1" },
      { token: "license.licenseNumber", value: null },
    ];
    const projected = projectQuickCards(legacyTokens, [], layout, TODAY);
    expect(projected.license.number.value).toBe("LEGACY-1");
  });
});

describe("escape hatch (TS-103, TE-13)", () => {
  it("deep-links the provider id only — never PHI in the URL", () => {
    expect(providerWebappPath("abc-123")).toBe("/providers/abc-123");
    expect(providerWebappPath("a/b")).toBe("/providers/a%2Fb");
  });
});
