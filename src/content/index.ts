// Content script for the BCBS KS enrollment portal (M0 stub).
//
// Boundary rules: this file never fetches, never stores anything, and never
// sees tokens. In M1 it will receive resolved fill values from the popup via
// chrome runtime messaging, apply the mapped selectors, and report per-field
// results back. For M0 it only answers a PING so the wiring is provable.
chrome.runtime.onMessage.addListener((message: { type?: string }, _sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({ ok: true, data: "pong" });
  }
  return false;
});
