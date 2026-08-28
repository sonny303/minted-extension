import { describe, expect, it } from "vitest";
import {
  browseableProviders,
  providerGroupsLabel,
  providerMatchesQuery,
} from "./browseProviders";
import type { ProviderListItem } from "./apiTypes";

function provider(over: Partial<ProviderListItem> & Pick<ProviderListItem, "id">): ProviderListItem {
  return {
    firstName: "Taylor",
    lastName: "Example",
    credentials: "RD",
    npi: "1234567890",
    homeState: "KS",
    caqhId: null,
    caqhLastAttestedDate: null,
    taxonomyCode: null,
    status: "active",
    groupId: null,
    specialty: null,
    email: null,
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("browseableProviders", () => {
  it("drops terminated rows so the picker matches the webapp roster", () => {
    const rows = [
      provider({ id: "a", status: "active" }),
      provider({ id: "b", firstName: "Taylor", lastName: "Example", status: "terminated" }),
      provider({ id: "c", firstName: "Wednesday", lastName: "Test", npi: "1234123456" }),
    ];
    expect(browseableProviders(rows).map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("dedupes by id if the list emits the same provider twice", () => {
    const a = provider({ id: "a" });
    expect(browseableProviders([a, { ...a }, provider({ id: "c", firstName: "Wed" })]).map((p) => p.id)).toEqual([
      "a",
      "c",
    ]);
  });
});

// 2026-08-19 — the search result names the provider's groups, because the same
// human can be on two groups' rosters and the name alone can't tell them apart.
describe("providerGroupsLabel", () => {
  const group = (name: string, isPrimary = false) => ({ id: name, name, isPrimary });

  it("joins the groups in the order the server sent (primary first)", () => {
    expect(
      providerGroupsLabel({ groups: [group("Summit Health Group", true), group("Acme Health")] }),
    ).toBe("Summit Health Group · Acme Health");
  });

  it("truncates past the cap, keeping the primary and counting the rest", () => {
    const label = providerGroupsLabel({
      groups: [group("A", true), group("B"), group("C"), group("D")],
    });
    expect(label).toBe("A · B +2");
  });

  it("says NOTHING when the row carries no groups", () => {
    // Two situations that must not be told apart: a provider on no roster, and
    // a panel deployed before `groups` existed. A placeholder would assert one.
    expect(providerGroupsLabel({ groups: [] })).toBe("");
    expect(providerGroupsLabel({})).toBe("");
  });

  it("ignores blank or malformed group names rather than rendering a gap", () => {
    expect(providerGroupsLabel({ groups: [group("   "), group("Real Group")] })).toBe("Real Group");
  });
});

describe("providerMatchesQuery", () => {
  const withGroups = provider({
    id: "a",
    firstName: "Taylor",
    lastName: "Example",
    groups: [{ id: "g1", name: "Summit Health Group", isPrimary: true }],
  });
  const other = provider({
    id: "b",
    firstName: "Taylor",
    lastName: "Example",
    npi: "9999999999",
    groups: [{ id: "g2", name: "Acme Health", isPrimary: true }],
  });

  it("narrows two same-named providers by their group — the whole point", () => {
    expect(providerMatchesQuery(withGroups, "taylor summit")).toBe(true);
    expect(providerMatchesQuery(other, "taylor summit")).toBe(false);
  });

  it("matches name, NPI and email case-insensitively", () => {
    expect(providerMatchesQuery(withGroups, "EXAMPLE")).toBe(true);
    expect(providerMatchesQuery(withGroups, "1234567890")).toBe(true);
  });

  it("requires EVERY term to hit, so extra words narrow instead of widening", () => {
    expect(providerMatchesQuery(withGroups, "taylor nonsense")).toBe(false);
  });

  it("an empty query matches everything (the panel hides results itself)", () => {
    expect(providerMatchesQuery(withGroups, "   ")).toBe(true);
  });
});
