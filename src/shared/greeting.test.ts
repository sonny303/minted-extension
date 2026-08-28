import { describe, expect, it } from "vitest";
import { accountGreeting } from "./greeting";

describe("accountGreeting", () => {
  it("greets by first name", () => {
    expect(accountGreeting("Alex Coordinator", "alex.coordinator@example.com")).toBe("Hi, Alex");
  });

  it("falls back to the email when there is no name", () => {
    expect(accountGreeting(null, "alex.coordinator@example.com")).toBe("alex.coordinator@example.com");
    expect(accountGreeting("   ", "alex.coordinator@example.com")).toBe("alex.coordinator@example.com");
  });

  it("falls back to a neutral line when neither is known", () => {
    expect(accountGreeting(null, null)).toBe("Signed in");
  });
});
