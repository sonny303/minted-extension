// TS-101 (quick-card render rules: honest empties + expiry badges), TS-102
// (layout degrade), TS-103 (escape-hatch path) — the pure halves.
import { describe, expect, it } from "vitest";
import type { ProfileToken, UnresolvedToken } from "./apiTypes";
import {
  DEFAULT_QUICK_CARD_LAYOUT,
  expiryStatus,
  isType2Field,
  orderLayoutByCatalog,
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

// The catalog is SERVED (GET /api/me/view-prefs `catalog`) — this module no
// longer carries a mirror, so there is nothing here to pin about which keys
// exist. Membership enforcement lives server-side (a PUT naming a non-catalog
// key 422s); resolveLayout only validates against the served set, below.

describe("resolveLayout (TE-15 degrade — never a broken card)", () => {
  const SERVED = new Set([
    "provider.npi",
    "provider.caqhId",
    "provider.ssnLast4",
    "group.tin",
    "group.npiType2",
    "license.licenseNumber",
  ]);

  it("returns a valid saved layout in the user's order", () => {
    const saved = ["group.tin", "provider.npi"];
    expect(resolveLayout(saved, SERVED)).toEqual({ fields: saved, source: "saved" });
  });

  it("accepts ssnLast4 when the served catalog offers it (2026-07-28 decision)", () => {
    const saved = ["provider.ssnLast4", "provider.npi"];
    expect(resolveLayout(saved, SERVED)).toEqual({ fields: saved, source: "saved" });
  });

  it.each([
    ["null", null],
    ["not an array", "provider.npi"],
    ["empty", []],
    ["a key the served catalog lacks", ["provider.npi", "provider.medicareId"]],
    ["duplicate", ["provider.npi", "provider.npi"]],
    ["non-string", ["provider.npi", 5]],
  ])("degrades %s to the default layout", (_label, stored) => {
    expect(resolveLayout(stored, SERVED)).toEqual({
      fields: [...DEFAULT_QUICK_CARD_LAYOUT],
      source: "default",
    });
  });

  it("with NO served set (catalog fetch failed) validates shape only — a saved layout survives", () => {
    // The keys were server-validated at PUT time; a failed catalog read must
    // not nuke the layout. Shape problems still degrade.
    const saved = ["anything.theServerAccepted", "group.tin"];
    expect(resolveLayout(saved, null)).toEqual({ fields: saved, source: "saved" });
    expect(resolveLayout(["dup", "dup"], null).source).toBe("default");
    expect(resolveLayout([""], null).source).toBe("default");
  });

  it("with an EMPTY served set behaves like no set (a degraded server never wipes layouts)", () => {
    const saved = ["group.tin"];
    expect(resolveLayout(saved, new Set())).toEqual({ fields: saved, source: "saved" });
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

  it("flags the license expiring inside 30 days", () => {
    expect(cards.license.expiry).toBe("expiring");
    expect(cards.license.number.value).toBe("KS-12345");
  });

  it("carries NO fixed malpractice row — those are ordinary layout fields now", () => {
    // Removed 2026-08-19: the hard-coded triplet duplicated catalog fields the
    // picker already offers, and a user could not remove it. A malpractice
    // field reaches a card only by being in the layout.
    expect(cards).not.toHaveProperty("malpractice");
    const withMalpractice = projectQuickCards(
      tokens,
      unresolved,
      { fields: ["groupInsurance.insurerName"], source: "saved" },
      TODAY,
    );
    expect(withMalpractice.type2Fields.map((f) => f.value)).toEqual(["CoverWell Mutual"]);
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

describe("served labels", () => {
  it("prefers the served catalog label over the local derivation, per key", () => {
    const layout = { fields: ["provider.npi", "group.tin"], source: "saved" as const };
    const labels = new Map([["provider.npi", "NPI (Type 1)"]]);
    const projected = projectQuickCards(tokens, [], layout, TODAY, labels);
    expect(projected.type1Fields.find((f) => f.key === "provider.npi")?.label).toBe("NPI (Type 1)");
    // group.tin has no served label here -> falls back to the local rule.
    expect(projected.type2Fields.find((f) => f.key === "group.tin")?.label).toBe("Tax ID (TIN)");
  });
});

describe("escape hatch (TS-103, TE-13)", () => {
  it("deep-links the provider id only — never PHI in the URL", () => {
    expect(providerWebappPath("abc-123")).toBe("/providers/abc-123");
    expect(providerWebappPath("a/b")).toBe("/providers/a%2Fb");
  });
});

// 2026-08-19 — the saved layout follows the picker's own order, so related
// fields (first/last name) stay together instead of drifting apart as they are
// ticked over time.
describe("orderLayoutByCatalog", () => {
  const catalog = [
    { key: "provider.firstName" },
    { key: "provider.lastName" },
    { key: "provider.npi" },
    { key: "group.tin" },
  ];

  it("orders by the catalog, not by when a field was picked", () => {
    // The old rule appended newly-ticked fields after the saved ones, which is
    // exactly how First name ended up separated from Last name.
    const picked = new Set(["provider.lastName", "provider.npi", "provider.firstName"]);
    expect(orderLayoutByCatalog(picked, catalog)).toEqual([
      "provider.firstName",
      "provider.lastName",
      "provider.npi",
    ]);
  });

  it("drops nothing and duplicates nothing", () => {
    const picked = ["group.tin", "provider.npi"];
    const ordered = orderLayoutByCatalog(picked, catalog);
    expect(ordered).toEqual(["provider.npi", "group.tin"]);
    expect(new Set(ordered).size).toBe(ordered.length);
  });

  it("keeps a key the catalog no longer serves, at the end", () => {
    // Discarding it silently would remove a field the user still sees ticked;
    // the server is the one that rejects a stale key, at PUT time.
    const ordered = orderLayoutByCatalog(["legacy.gone", "provider.npi"], catalog);
    expect(ordered).toEqual(["provider.npi", "legacy.gone"]);
  });

  it("returns an empty list for an empty selection (the save guard's input)", () => {
    expect(orderLayoutByCatalog([], catalog)).toEqual([]);
  });

  it("survives an empty catalog by preserving the caller's order", () => {
    expect(orderLayoutByCatalog(["b", "a"], [])).toEqual(["b", "a"]);
  });
});
