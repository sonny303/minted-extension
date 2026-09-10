import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ensureContentScript", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubChrome(opts: {
    frames?: { frameId: number; url: string }[];
    pingOkFrameIds?: number[];
    executeScript?: ReturnType<typeof vi.fn>;
  }) {
    const frames = opts.frames ?? [{ frameId: 0, url: "https://portal.example/" }];
    const pingOk = new Set(opts.pingOkFrameIds ?? []);
    const executeScript =
      opts.executeScript ?? vi.fn().mockResolvedValue([{ result: null }]);
    const sendMessage = vi.fn(
      async (_tabId: number, _msg: unknown, options?: { frameId?: number }) => {
        const frameId = options?.frameId ?? 0;
        if (pingOk.has(frameId)) return { ok: true, data: "pong" };
        throw new Error("Receiving end does not exist");
      },
    );
    vi.stubGlobal("chrome", {
      tabs: { sendMessage },
      scripting: { executeScript },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue(frames),
      },
    });
    return { sendMessage, executeScript };
  }

  it("is a no-op when every frame already answers PING", async () => {
    const { executeScript } = stubChrome({
      frames: [
        { frameId: 0, url: "https://shell.example/" },
        { frameId: 2, url: "https://shell.example/app" },
      ],
      pingOkFrameIds: [0, 2],
    });

    const { ensureContentScript } = await import("./inject");
    await ensureContentScript(42);

    expect(executeScript).not.toHaveBeenCalled();
  });

  it("injects only into frames that do not answer PING", async () => {
    const { executeScript } = stubChrome({
      frames: [
        { frameId: 0, url: "https://shell.example/" },
        { frameId: 7, url: "https://shell.example/pdm-ui" },
      ],
      pingOkFrameIds: [0],
    });

    const { ensureContentScript } = await import("./inject");
    await ensureContentScript(7);

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [7] },
      files: ["content.js"],
    });
  });

  it("throws a clear reload message when chrome.scripting is missing", async () => {
    vi.stubGlobal("chrome", {
      tabs: { sendMessage: vi.fn().mockRejectedValue(new Error("no listener")) },
      webNavigation: {
        getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0, url: "" }]),
      },
    });

    const { ensureContentScript } = await import("./inject");
    await expect(ensureContentScript(1)).rejects.toThrow(/reload the page and retry/i);
  });

  it("throws grant/reload guidance when no frame can be injected", async () => {
    stubChrome({
      frames: [{ frameId: 0, url: "https://portal.example/" }],
      pingOkFrameIds: [],
      executeScript: vi.fn().mockRejectedValue(new Error("Cannot access contents")),
    });

    const { ensureContentScript } = await import("./inject");
    await expect(ensureContentScript(1)).rejects.toThrow(/grant access to this site/i);
  });
});
