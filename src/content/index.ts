// Content script for payer portal pages. It reaches ANY registry-listed portal,
// not just the one the manifest statically matches: the worker injects this
// bundle on demand (src/background/inject.ts) once the origin is granted.
//
// Boundary rules: this file never fetches, never stores anything, and never
// sees tokens. It receives fully resolved fill values from the background
// worker via chrome runtime messaging, applies them through the fill engine
// (which fires input/change so the page's own validation runs), and reports
// per-field results back. It never throws across the messaging boundary.
import type { ContentRequest } from "../shared/fill";
import { applyFill } from "./fillEngine";
import { scanCapturableFields } from "./captureScan";

chrome.runtime.onMessage.addListener((message: ContentRequest, _sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({ ok: true, data: "pong" });
    return false;
  }
  if (message?.type === "SCAN_FIELDS") {
    // Capture reads the form's shape only: labels, selectors, control types.
    // No control's VALUE is ever read, so nothing here can carry PHI.
    try {
      sendResponse({ ok: true, data: scanCapturableFields() });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Could not read this form",
      });
    }
    return false;
  }
  if (message?.type === "APPLY_FILL") {
    try {
      sendResponse({ ok: true, data: applyFill(message.instructions ?? []) });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Fill failed on the page",
      });
    }
    return false;
  }
  return false;
});
