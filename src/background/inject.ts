// Inject content.js into a portal tab before capture or fill.
// Static manifest scripts (if any) cover baked-in origins; all other portals
// get on-demand injection via chrome.scripting after the user grants access.
//
// Same content.js for every portal — shape-only capture, resolved-value fill.
// Never fetches and never holds tokens.
//
// Availity-style shells put the real form in a child iframe. Injection and
// PING are therefore per-frame: frame 0 answering is not enough when pdm-ui
// loaded later into another frame.

import { listTabFrames, sendToFrame } from "./frameMessaging";

const CONTENT_SCRIPT = "content.js";

async function pingFrame(tabId: number, frameId: number): Promise<boolean> {
  try {
    const pong = (await sendToFrame(tabId, frameId, { type: "PING" })) as
      | { ok?: boolean }
      | undefined;
    return pong?.ok === true;
  } catch {
    // "Receiving end does not exist" — no content script in this frame yet.
    return false;
  }
}

/** Inject content.js into every frame that is not already answering PING. */
export async function ensureContentScript(tabId: number): Promise<void> {
  const frames = await listTabFrames(tabId);

  // Fast path: every known frame already answers. The harness stubs PING on
  // frame 0 without chrome.scripting — keep that working.
  let anyAlive = false;
  let anyMissing = false;
  for (const frame of frames) {
    if (await pingFrame(tabId, frame.frameId)) {
      anyAlive = true;
    } else {
      anyMissing = true;
    }
  }
  if (anyAlive && !anyMissing) return;

  if (!chrome.scripting) {
    if (anyAlive) return;
    throw new Error("Could not reach the enrollment form — reload the page and retry.");
  }

  let injectedAny = false;
  let lastError: unknown;

  for (const frame of frames) {
    if (await pingFrame(tabId, frame.frameId)) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        files: [CONTENT_SCRIPT],
      });
      injectedAny = true;
    } catch (error) {
      // Cross-origin frames without host permission, unloaded frames, etc.
      lastError = error;
    }
  }

  // At least one frame must answer — prefer frame 0, else any subframe.
  if (await pingFrame(tabId, 0)) return;
  for (const frame of frames) {
    if (frame.frameId === 0) continue;
    if (await pingFrame(tabId, frame.frameId)) return;
  }

  // Blanket allFrames inject as a last resort (late-created iframes, etc.).
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [CONTENT_SCRIPT],
    });
    injectedAny = true;
  } catch (error) {
    lastError = error;
  }

  if (await pingFrame(tabId, 0)) return;
  for (const frame of frames) {
    if (await pingFrame(tabId, frame.frameId)) return;
  }

  throw new Error(
    injectedAny
      ? "Could not reach the enrollment form — reload the page and retry."
      : "Could not load the capture helper into this page — grant access to this site and reload the portal page, then retry.",
    { cause: lastError },
  );
}
