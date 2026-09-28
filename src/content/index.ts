// Content script for payer portal pages. It reaches ANY registry-listed portal,
// not just the one the manifest statically matches: the worker injects this
// bundle on demand (src/background/inject.ts) once the origin is granted.
//
// Boundary rules: this file never fetches, never stores anything, and never
// sees tokens. It receives fully resolved fill values from the background
// worker via chrome runtime messaging, applies them through the fill engine
// (which fires input/change so the page's own validation runs), and reports
// per-field results back. It never throws across the messaging boundary.
//
// Idempotent: all-frames re-injection must not stack duplicate listeners.
import type { ContentRequest } from "../shared/fill";
import { applyFill, clearPortalForm, probeFillOnPage } from "./fillEngine";
import { scanCapturableFields } from "./captureScan";
import { beginUnmappedControlScan, clearUnmappedControlScan } from "./controlScanner";
import { acceptAiFill, applyAiFill, clearAiFill, finalizeAiFill } from "./aiFillEngine";
import {
  cancelElementPick,
  describeSelectorMatches,
  highlightSelectorReport,
  startElementPick,
} from "./elementPicker";

const contentGlobal = globalThis as typeof globalThis & {
  __mintedPanelContentInstalled?: boolean;
};

if (!contentGlobal.__mintedPanelContentInstalled) {
  contentGlobal.__mintedPanelContentInstalled = true;

  chrome.runtime.onMessage.addListener(
    (message: ContentRequest, _sender, sendResponse) => {
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
            error:
              error instanceof Error ? error.message : "Could not read this form",
          });
        }
        return false;
      }
      if (message?.type === "SCAN_UNMAPPED_CONTROLS") {
        try {
          sendResponse({
            ok: true,
            data: beginUnmappedControlScan(message.scanId, message.activeMaps ?? []),
          });
        } catch {
          sendResponse({ ok: false, error: "Could not scan unmapped controls" });
        }
        return false;
      }
      if (message?.type === "CLEAR_AI_SCAN") {
        clearUnmappedControlScan(message.scanId);
        sendResponse({ ok: true, data: null });
        return false;
      }
      if (message?.type === "APPLY_AI_FILL") {
        try {
          sendResponse({
            ok: true,
            data: applyAiFill(message.scanId, message.fillSessionId, message.instructions ?? []),
          });
        } catch {
          sendResponse({ ok: false, error: "AI suggestions could not be applied" });
        }
        return false;
      }
      if (message?.type === "CLEAR_AI_FILL") {
        sendResponse({ ok: true, data: clearAiFill(message.fillSessionId) });
        return false;
      }
      if (message?.type === "ACCEPT_AI_FILL") {
        acceptAiFill(message.fillSessionId);
        sendResponse({ ok: true, data: null });
        return false;
      }
      if (message?.type === "FINALIZE_AI_FILL") {
        finalizeAiFill(message.fillSessionId);
        sendResponse({ ok: true, data: null });
        return false;
      }
      if (message?.type === "PICK_ELEMENT") {
        // ASYNC: the pick resolves only when the human clicks or cancels, so this
        // branch returns true to hold the message channel open. Every other branch
        // answers synchronously and returns false.
        startElementPick()
          .then((outcome) => sendResponse({ ok: true, data: outcome }))
          .catch((error) =>
            sendResponse({
              ok: false,
              error:
                error instanceof Error ? error.message : "Could not pick a field",
            }),
          );
        return true;
      }
      if (message?.type === "CANCEL_PICK") {
        cancelElementPick();
        sendResponse({ ok: true, data: null });
        return false;
      }
      if (message?.type === "MATCH_SELECTOR") {
        // Shape question only: how many elements does this selector hit, how many
        // of those could the engine fill, and are they one radio group? Never
        // reads what any of them contain. `highlight` also flashes them green so
        // the trainer can SEE which controls they just described.
        sendResponse({
          ok: true,
          data: message.highlight
            ? highlightSelectorReport(message.selector)
            : describeSelectorMatches(message.selector),
        });
        return false;
      }
      if (message?.type === "PROBE_FILL") {
        // The bounded mutation-quiet wait lets delayed panels render before a
        // selector miss is classified. The request contains shape only.
        probeFillOnPage(message.instructions ?? [])
          .then((result) => sendResponse({ ok: true, data: result }))
          .catch(() => sendResponse({ ok: false, error: "Could not inspect this form" }));
        return true;
      }
      if (message?.type === "CLEAR_FORM") {
        try {
          sendResponse({ ok: true, data: clearPortalForm() });
        } catch (error) {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Could not clear this form",
          });
        }
        return false;
      }
      if (message?.type === "APPLY_FILL") {
        try {
          sendResponse({ ok: true, data: applyFill(message.instructions ?? [], message.requireUniqueTarget === true) });
        } catch {
          sendResponse({
            ok: false,
            // Page exceptions can embed entered values; report a fixed reason.
            error: "Fill failed on the page",
          });
        }
        return false;
      }
      return false;
    },
  );
}
