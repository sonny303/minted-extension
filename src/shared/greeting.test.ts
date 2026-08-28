import { describe, expect, it } from "vitest";
import { accountGreeting } from "./greeting";

describe("accountGreeting", () => {
  it("greets by first name", () => {
    expect(accountGreeting("Maya Chen", "maya@example.com")).toBe("Hi, Maya");
  });

  it("falls back to the email when there is no name", () => {
    expect(accountGreeting(null, "maya@example.com")).toBe("maya@example.com");
    expect(accountGreeting("   ", "maya@example.com")).toBe("maya@example.com");
  });

  it("falls back to a neutral line when neither is known", () => {
    expect(accountGreeting(null, null)).toBe("Signed in");
  });
});
