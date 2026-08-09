import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ensureContentScript", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is a no-op when PING already answers", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      scripting: { executeScript },
    });

    const { ensureContentScript } = await import("./inject");
    await ensureContentScript(42);

    expect(sendMessage).toHaveBeenCalledWith(42, { type: "PING" });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("injects content.js once when PING fails", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("Receiving end does not exist"));
    const executeScript = vi.fn().mockResolvedValue([{ result: null }]);
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      scripting: { executeScript },
    });

    const { ensureContentScript } = await import("./inject");
    await ensureContentScript(7);

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["content.js"],
    });
  });

  it("throws a clear reload message when chrome.scripting is missing", async () => {
    vi.stubGlobal("chrome", {
      tabs: { sendMessage: vi.fn().mockRejectedValue(new Error("no listener")) },
    });

    const { ensureContentScript } = await import("./inject");
    await expect(ensureContentScript(1)).rejects.toThrow(/reload the page and retry/i);
  });

  it("throws grant/reload guidance when executeScript fails", async () => {
    vi.stubGlobal("chrome", {
      tabs: { sendMessage: vi.fn().mockRejectedValue(new Error("no listener")) },
      scripting: {
        executeScript: vi.fn().mockRejectedValue(new Error("Cannot access contents")),
      },
    });

    const { ensureContentScript } = await import("./inject");
    await expect(ensureContentScript(1)).rejects.toThrow(/grant access to this site/i);
  });
});
