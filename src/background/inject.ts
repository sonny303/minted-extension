// Ensure the content script is live in a portal tab before the worker messages
// it. The static content_scripts entry (if any) only covers portals baked into
// the manifest at build time; every OTHER DB-registered portal (S3.2 — "a portal
// is a registry row, never an extension release") is reached by injecting content.js on demand with
// chrome.scripting. Injection needs the "scripting" permission plus host access
// for the tab's origin (granted at capture/fill time from the side panel's
// optional_host_permissions request).
//
// Boundary unchanged: the injected script is the SAME content.js — it reads
// form SHAPE for capture and applies resolved values for fill, never fetches,
// never holds tokens. Nothing here loosens that.

const CONTENT_SCRIPT = "content.js";

async function pingTab(tabId: number): Promise<boolean> {
  try {
    const pong = (await chrome.tabs.sendMessage(tabId, { type: "PING" })) as
      | { ok?: boolean }
      | undefined;
    return pong?.ok === true;
  } catch {
    // "Receiving end does not exist" — no content script in this tab yet.
    return false;
  }
}

/** Make sure content.js is answering in `tabId`. A no-op when it already is
 * (a static manifest script, or a prior injection); otherwise inject it once.
 * Injecting twice would double-bind the message listener, so this only fires
 * when the pre-flight PING goes unanswered. Throws clear reload guidance when
 * the page can't be scripted (missing host permission, blocked by CSP, or a
 * Chromium build without the scripting API). */
export async function ensureContentScript(tabId: number): Promise<void> {
  if (await pingTab(tabId)) return;
  if (!chrome.scripting) {
    throw new Error("Could not reach the enrollment form — reload the page and retry.");
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  } catch (error) {
    throw new Error(
      "Could not load the capture helper into this page — grant access to this site and reload the portal page, then retry.",
      { cause: error },
    );
  }
}
