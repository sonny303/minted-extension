/**
 * The messaging boundary must never reject.
 *
 * Panel click handlers are wired `() => void someAsyncThing()`, so a rejection
 * here has nowhere to land: it becomes an unhandled rejection in a console the
 * user never opens, and the button they pressed does NOTHING — no result, no
 * error. That was the "Check page does nothing" report, and with 68 call sites
 * against 4 try blocks it was latent behind most of the panel's buttons.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendToBackground } from "./messages";

function stubSendMessage(impl: () => unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn(impl) },
  };
}

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("sendToBackground never rejects", () => {
  it("passes a success envelope straight through", async () => {
    stubSendMessage(() => Promise.resolve({ ok: true, data: "train" }));
    await expect(sendToBackground({ type: "GET_PANEL_MODE" })).resolves.toEqual(
      {
        ok: true,
        data: "train",
      },
    );
  });

  it("passes a worker-side failure through unchanged", async () => {
    // The worker already catches its own throws; that envelope must survive
    // verbatim so the panel shows the real reason, not a generic one.
    stubSendMessage(() =>
      Promise.resolve({
        ok: false,
        error: "Switch to Train forms to add a field.",
      }),
    );
    const response = await sendToBackground({ type: "GET_CAPTURE" });
    expect(response).toEqual({
      ok: false,
      error: "Switch to Train forms to add a field.",
    });
  });

  it("turns a reload-disconnect into an actionable message, not a crash", async () => {
    // Reloading the unpacked extension with the panel open is the everyday
    // cause. Chrome's own wording names no remedy; ours does.
    for (const raw of [
      "Extension context invalidated.",
      "Could not establish connection. Receiving end does not exist.",
      "The message port closed before a response was received.",
    ]) {
      stubSendMessage(() => Promise.reject(new Error(raw)));
      const response = await sendToBackground({ type: "GET_CAPTURE" });
      expect(response.ok).toBe(false);
      if (response.ok) throw new Error("unreachable");
      expect(response.error).toMatch(/reopen the side panel/i);
      // Chrome's jargon must not reach the user.
      expect(response.error).not.toContain("context invalidated");
    }
  });

  it("keeps an unrecognised transport error's own text", async () => {
    stubSendMessage(() => Promise.reject(new Error("Tab was discarded")));
    const response = await sendToBackground({ type: "GET_CAPTURE" });
    expect(response).toEqual({ ok: false, error: "Tab was discarded" });
  });

  it("reports a listener that answered with nothing", async () => {
    // A listener returning without calling sendResponse yields undefined —
    // callers reading `response.ok` off it would throw just as silently.
    for (const nothing of [undefined, null]) {
      stubSendMessage(() => Promise.resolve(nothing));
      const response = await sendToBackground({ type: "GET_CAPTURE" });
      expect(response.ok).toBe(false);
      if (response.ok) throw new Error("unreachable");
      expect(response.error).toMatch(/did not respond/i);
    }
  });

  it("reports a garbled response rather than passing it on as success", async () => {
    stubSendMessage(() => Promise.resolve({ unexpected: true }));
    const response = await sendToBackground({ type: "GET_CAPTURE" });
    expect(response.ok).toBe(false);
  });
});
