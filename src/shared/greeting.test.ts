import { describe, expect, it } from "vitest";
import { accountGreeting } from "./greeting";

describe("accountGreeting", () => {
  it("greets by first name", () => {
    expect(accountGreeting("Jamie Cole", "jamie@example.com")).toBe("Hi, Jamie");
  });

  it("falls back to the email when there is no name", () => {
    expect(accountGreeting(null, "jamie@example.com")).toBe("jamie@example.com");
    expect(accountGreeting("   ", "jamie@example.com")).toBe("jamie@example.com");
  });

  it("falls back to a neutral line when neither is known", () => {
    expect(accountGreeting(null, null)).toBe("Signed in");
  });
});
