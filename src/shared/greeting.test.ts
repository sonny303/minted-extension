import { describe, expect, it } from "vitest";
import { accountGreeting } from "./greeting";

describe("accountGreeting", () => {
  it("greets by first name", () => {
    expect(accountGreeting("Sowmya Surapureddy", "sowmya@minted.com")).toBe("Hi, Sowmya");
  });

  it("falls back to the email when there is no name", () => {
    expect(accountGreeting(null, "sowmya@minted.com")).toBe("sowmya@minted.com");
    expect(accountGreeting("   ", "sowmya@minted.com")).toBe("sowmya@minted.com");
  });

  it("falls back to a neutral line when neither is known", () => {
    expect(accountGreeting(null, null)).toBe("Signed in");
  });
});
