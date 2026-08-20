import { describe, expect, it } from "vitest";
import type { ProviderListItem } from "./apiTypes";
import { findSandboxProvider, isSandboxProvider, sandboxFillState } from "./sandbox";

function provider(over: Partial<ProviderListItem> = {}): ProviderListItem {
  return {
    id: over.id ?? "p1",
    firstName: "Ada",
    lastName: "Lovelace",
    npi: "1234567890",
    status: "active",
    ...over,
  } as ProviderListItem;
}

describe("findSandboxProvider", () => {
  it("finds the designated provider", () => {
    const target = provider({ id: "p2", isTestProvider: true });
    expect(findSandboxProvider([provider(), target, provider({ id: "p3" })])).toBe(target);
  });

  it("returns null when the org has designated nobody", () => {
    // The panel must say so honestly rather than offering a button that fails
    // when pressed, so "no sandbox" has to be distinguishable from "not loaded".
    expect(findSandboxProvider([provider(), provider({ id: "p2" })])).toBeNull();
  });

  it("returns null for an empty roster", () => {
    expect(findSandboxProvider([])).toBeNull();
  });

  it("never treats a missing flag as designated", () => {
    // A panel deployed before is_test_provider rides the list projection sends
    // no key at all; guessing would fill a real provider's data into a portal.
    expect(findSandboxProvider([provider({ isTestProvider: undefined })])).toBeNull();
    expect(findSandboxProvider([provider({ isTestProvider: false })])).toBeNull();
  });

  it("picks the first in roster order when several are flagged", () => {
    // Stable between panel opens: a sandbox that silently changed identity
    // would make a failed test impossible to interpret.
    const first = provider({ id: "a", isTestProvider: true });
    const second = provider({ id: "b", isTestProvider: true });
    expect(findSandboxProvider([first, second])).toBe(first);
    expect(findSandboxProvider([second, first])).toBe(second);
  });
});

describe("isSandboxProvider", () => {
  it("agrees with findSandboxProvider about what counts", () => {
    expect(isSandboxProvider(provider({ isTestProvider: true }))).toBe(true);
    expect(isSandboxProvider(provider())).toBe(false);
    expect(isSandboxProvider(null)).toBe(false);
    expect(isSandboxProvider(undefined)).toBe(false);
  });
});

describe("sandboxFillState", () => {
  it("stands the provider's home state in for the absent case", () => {
    expect(sandboxFillState(provider({ homeState: "NC" }))).toBe("NC");
  });

  it("trims", () => {
    expect(sandboxFillState(provider({ homeState: " KS " }))).toBe("KS");
  });

  it("is null when there is no home state — a legitimate answer", () => {
    // The profile endpoint then returns state-scoped tokens unresolved WITH
    // reasons, which still exercises the rest of the form.
    expect(sandboxFillState(provider({ homeState: null }))).toBeNull();
    expect(sandboxFillState(provider({ homeState: "   " }))).toBeNull();
    expect(sandboxFillState(provider({ homeState: undefined }))).toBeNull();
    expect(sandboxFillState(null)).toBeNull();
  });
});
