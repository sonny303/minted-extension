// Inject content.js into a portal tab before capture or fill.
// Static manifest scripts (if any) cover baked-in origins; all other portals
// get on-demand injection via chrome.scripting after the user grants access.
//
// Same content.js for every portal — shape-only capture, resolved-value fill.
// Never fetches and never holds tokens.

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

/** Inject content.js if the tab is not already answering PING. */
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
