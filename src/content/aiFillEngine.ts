import type { FillInstruction, FillPageResult } from "../shared/fill";
import { scannedControlForAi } from "./controlScanner";
import {
  applyAiValue,
  decorateFill,
  restoreAiValue,
  type Fillable,
} from "./fillEngine";
import { describeControl, isCapturableControl } from "./captureScan";
import { FILLABLE, querySelectorAllDeep } from "./deepDom";

interface UndoSnapshot {
  control: Fillable;
  before: string | boolean;
  written: string | boolean;
  oldTitle: string | null;
  aiClassWasPresent: boolean;
  aiTitle: string;
}

const snapshotsByFill = new Map<string, UndoSnapshot[]>();

function liveValue(control: Fillable): string | boolean {
  if (control instanceof HTMLInputElement && (control.type === "radio" || control.type === "checkbox")) {
    return control.checked;
  }
  return control.value;
}

function resetDecoration(snapshot: UndoSnapshot): void {
  const { control } = snapshot;
  if (control.classList.contains("mp-fill-ai") && !snapshot.aiClassWasPresent) {
    control.classList.remove("mp-fill-ai");
  }
  if (control.getAttribute("title") === snapshot.aiTitle) {
    if (snapshot.oldTitle == null) control.removeAttribute("title");
    else control.setAttribute("title", snapshot.oldTitle);
  }
}

function currentSummaryStillMatches(control: Fillable, instruction: FillInstruction): boolean {
  const summary = describeControl(control, { includeOptions: false });
  return summary.selector === instruction.selector && isCapturableControl(control);
}

export function applyAiFill(
  scanId: string,
  fillSessionId: string,
  instructions: FillInstruction[],
): FillPageResult {
  const filled: string[] = [];
  const writes: NonNullable<FillPageResult["writes"]> = [];
  const skipped: FillPageResult["skipped"] = [];
  const sessionSnapshots: UndoSnapshot[] = [];

  for (const instruction of instructions) {
    const control = scannedControlForAi(scanId, instruction.selector);
    if (!control || !currentSummaryStillMatches(control, instruction)) {
      skipped.push({ label: instruction.selector, reason: "AI target changed after scan", kind: "skipped" });
      continue;
    }
    const previous = liveValue(control);
    const result = applyAiValue(control, instruction.value);
    if (!result.ok || !result.changed) {
      skipped.push({ label: instruction.selector, reason: result.ok ? "No value was written" : result.reason, kind: "skipped" });
      continue;
    }
    const target = result.target;
    const written = liveValue(target);
    const isToggle = target instanceof HTMLInputElement &&
      (target.type === "checkbox" || target.type === "radio");
    const readbackMatches = isToggle
      ? written === true
      : target instanceof HTMLSelectElement
        ? written !== previous
        : written === instruction.value;
    if (!readbackMatches || String(written) !== result.writtenValue) {
      if (written !== previous) restoreAiValue(target, previous);
      skipped.push({ label: instruction.selector, reason: "AI write did not read back", kind: "skipped" });
      continue;
    }
    const aiTitle = `AI Suggested: ${instruction.token ?? "field"}`;
    const snapshot: UndoSnapshot = {
      control: target,
      before: previous,
      written,
      oldTitle: target.getAttribute("title"),
      aiClassWasPresent: target.classList.contains("mp-fill-ai"),
      aiTitle,
    };
    decorateFill(target, "ai", instruction.token);
    sessionSnapshots.push(snapshot);
    filled.push(instruction.selector);
    writes.push({
      selector: instruction.selector,
      kind: "ai",
      ...(instruction.token ? { token: instruction.token } : {}),
      ...(instruction.confidence != null ? { confidence: instruction.confidence } : {}),
    });
  }

  snapshotsByFill.set(fillSessionId, sessionSnapshots);
  return { filled, writes, skipped, pageFields: querySelectorAllDeep(FILLABLE).length };
}

/** Undo only values that still equal this session's last write. Any later
 * human edit survives; decoration is restored independently. */
export function clearAiFill(fillSessionId: string): number {
  const snapshots = snapshotsByFill.get(fillSessionId) ?? [];
  let cleared = 0;
  for (const snapshot of [...snapshots].reverse()) {
    const { control } = snapshot;
    if (!control.isConnected) continue;
    if (liveValue(control) === snapshot.written) {
      restoreAiValue(control, snapshot.before);
      cleared += 1;
    }
    resetDecoration(snapshot);
  }
  snapshotsByFill.delete(fillSessionId);
  return cleared;
}

/** Acceptance keeps the page values and visual markers. Keep the raw undo
 * snapshots in this page's memory until the human clears or logs submission. */
export function acceptAiFill(fillSessionId: string): void {
  // The session remains explicitly clearable until the successful submission
  // touch. FINALIZE_AI_FILL releases it once that boundary is crossed.
  void fillSessionId;
}

/** The submission-touch boundary makes Clear inapplicable. Release the
 * value-bearing undo snapshots while leaving the accepted portal values. */
export function finalizeAiFill(fillSessionId: string): void {
  snapshotsByFill.delete(fillSessionId);
}
