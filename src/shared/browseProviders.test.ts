import { describe, expect, it } from "vitest";
import { browseableProviders } from "./browseProviders";
import type { ProviderListItem } from "./apiTypes";

function provider(over: Partial<ProviderListItem> & Pick<ProviderListItem, "id">): ProviderListItem {
  return {
    firstName: "Addie",
    lastName: "Jones",
    credentials: "RD",
    npi: "1891243838",
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
      provider({ id: "b", firstName: "Addie", lastName: "Jones", status: "terminated" }),
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
