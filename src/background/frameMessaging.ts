// Multi-frame tab messaging. Availity (and similar shells) render the real
// enrollment form inside a child iframe; `tabs.sendMessage(tabId, msg)` without
// `frameId` only reaches frame 0 (the shell). Frame IDs are ephemeral per load
// — never persist them on field maps. Capture aggregates; fill resolves by
// which live frame can see the selector.

import type { CapturedField } from "../content/captureScan";
import type { ContentRequest } from "../shared/fill";
import type { FillInstruction, FillPageResult, ReportedField } from "../shared/fill";
import { FIELD_NOT_FOUND_REASON } from "../shared/fixit";
import type { SelectorMatchReport } from "../shared/selectorMatch";
import type { PickOutcome } from "../content/elementPicker";

export interface TabFrame {
  frameId: number;
  url: string;
}

/** Frames in the tab, or `[{ frameId: 0 }]` when webNavigation is unavailable. */
export async function listTabFrames(tabId: number): Promise<TabFrame[]> {
  try {
    if (!chrome.webNavigation?.getAllFrames) {
      return [{ frameId: 0, url: "" }];
    }
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames || frames.length === 0) return [{ frameId: 0, url: "" }];
    return frames.map((f) => ({ frameId: f.frameId, url: f.url ?? "" }));
  } catch {
    return [{ frameId: 0, url: "" }];
  }
}

export async function sendToFrame(
  tabId: number,
  frameId: number,
  message: ContentRequest,
): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, message, { frameId });
}

type FrameResponse = { frameId: number; ok: true; data: unknown } | { frameId: number; ok: false };

/** Deliver `message` to every frame that has a content script; skip the rest. */
export async function sendToAllFrames(
  tabId: number,
  message: ContentRequest,
): Promise<FrameResponse[]> {
  const frames = await listTabFrames(tabId);
  const results = await Promise.all(
    frames.map(async (frame): Promise<FrameResponse> => {
      try {
        const raw = (await sendToFrame(tabId, frame.frameId, message)) as
          | { ok?: boolean; data?: unknown; error?: string }
          | undefined;
        if (raw?.ok) return { frameId: frame.frameId, ok: true, data: raw.data };
        return { frameId: frame.frameId, ok: false };
      } catch {
        return { frameId: frame.frameId, ok: false };
      }
    }),
  );
  return results;
}

interface FramedField extends CapturedField {
  frameId: number;
}

/** Drop obvious shell chrome (Availity keyword search) when a subframe has fields. */
export function filterShellNoise(fields: FramedField[]): CapturedField[] {
  const hasSubframeFields = fields.some((f) => f.frameId !== 0);
  const kept = hasSubframeFields
    ? fields.filter((f) => {
        if (f.frameId !== 0) return true;
        const label = (f.label ?? "").toLowerCase();
        const selector = (f.selector ?? "").toLowerCase();
        if (label.includes("search")) return false;
        if (label.includes("keyword")) return false;
        if (selector.includes("keyword")) return false;
        return true;
      })
    : fields;
  return kept.map(({ frameId: _fid, ...field }) => {
    void _fid;
    return field;
  });
}

/** Aggregate SCAN_FIELDS replies from every frame into one capture list. */
export function aggregateScannedFields(results: FrameResponse[]): CapturedField[] {
  const framed: FramedField[] = [];
  for (const result of results) {
    if (!result.ok) continue;
    const fields = Array.isArray(result.data) ? (result.data as CapturedField[]) : [];
    for (const field of fields) {
      framed.push({ ...field, frameId: result.frameId });
    }
  }
  return filterShellNoise(framed);
}

function reportKey(field: ReportedField): string {
  return field.mapId ?? field.label;
}

/**
 * Merge APPLY_FILL reports from every frame. A label that filled in any frame
 * wins over "not found" from another; pageFields is the sum of denominators.
 */
export function mergeFillPageResults(results: FillPageResult[]): FillPageResult {
  const filledLabels = new Set<string>();
  const skipped = new Map<string, ReportedField>();
  let pageFields = 0;

  for (const result of results) {
    pageFields += result.pageFields;
    for (const label of result.filled) filledLabels.add(label);
  }

  for (const result of results) {
    for (const skip of result.skipped) {
      if (filledLabels.has(skip.label)) continue;
      const key = reportKey(skip);
      const existing = skipped.get(key);
      if (!existing) {
        skipped.set(key, skip);
        continue;
      }
      // Prefer a concrete apply failure over "field not found".
      if (
        existing.reason === FIELD_NOT_FOUND_REASON &&
        skip.reason !== FIELD_NOT_FOUND_REASON
      ) {
        skipped.set(key, skip);
      }
    }
  }

  return {
    filled: [...filledLabels],
    skipped: [...skipped.values()],
    pageFields,
  };
}

/** Sum MATCH_SELECTOR reports; valid if any frame parsed the selector. */
export function mergeSelectorReports(reports: SelectorMatchReport[]): SelectorMatchReport {
  if (reports.length === 0) {
    return { valid: true, matches: 0, fillable: 0, radioGroup: false };
  }
  let matches = 0;
  let fillable = 0;
  let valid = false;
  let radioGroup = false;
  for (const report of reports) {
    if (report.valid) valid = true;
    matches += report.matches;
    fillable += report.fillable;
    if (report.radioGroup) radioGroup = true;
  }
  // If every frame rejected the selector as invalid CSS, stay invalid.
  const anyInvalidOnly = reports.every((r) => !r.valid);
  return {
    valid: anyInvalidOnly ? false : valid || matches > 0,
    matches,
    fillable,
    radioGroup,
  };
}

/** APPLY_FILL across frames: every frame gets the full plan; merge outcomes. */
export async function applyFillAcrossFrames(
  tabId: number,
  instructions: FillInstruction[],
): Promise<FillPageResult> {
  const responses = await sendToAllFrames(tabId, {
    type: "APPLY_FILL",
    instructions,
  });
  const pageResults: FillPageResult[] = [];
  for (const response of responses) {
    if (!response.ok || !response.data) continue;
    pageResults.push(response.data as FillPageResult);
  }
  if (pageResults.length === 0) {
    throw new Error("Could not reach the enrollment form in any frame");
  }
  return mergeFillPageResults(pageResults);
}

/** SCAN_FIELDS across frames with shell-noise filtering. */
export async function scanFieldsAcrossFrames(tabId: number): Promise<CapturedField[]> {
  const responses = await sendToAllFrames(tabId, { type: "SCAN_FIELDS" });
  const fields = aggregateScannedFields(responses);
  // If every frame was silent, surface the same error the single-frame path did.
  if (responses.every((r) => !r.ok) && fields.length === 0) {
    throw new Error("Could not read this form — reload the page and retry.");
  }
  return fields;
}

export async function clearFormAcrossFrames(tabId: number): Promise<number> {
  const responses = await sendToAllFrames(tabId, { type: "CLEAR_FORM" });
  let cleared = 0;
  let any = false;
  for (const response of responses) {
    if (!response.ok) continue;
    any = true;
    if (typeof response.data === "number") cleared += response.data;
  }
  if (!any) throw new Error("Could not clear this form — reload the page and retry.");
  return cleared;
}

export async function matchSelectorAcrossFrames(
  tabId: number,
  selector: string,
  highlight?: boolean,
): Promise<SelectorMatchReport> {
  const responses = await sendToAllFrames(tabId, {
    type: "MATCH_SELECTOR",
    selector,
    highlight,
  });
  const reports: SelectorMatchReport[] = [];
  for (const response of responses) {
    if (!response.ok || !response.data) continue;
    reports.push(response.data as SelectorMatchReport);
  }
  if (reports.length === 0) {
    return { valid: true, matches: 0, fillable: 0, radioGroup: false };
  }
  return mergeSelectorReports(reports);
}

/**
 * Start pick mode in every frame; first successful pick wins and cancels the
 * rest. A click lands in one frame's document, so only that frame resolves.
 */
export async function pickElementAcrossFrames(tabId: number): Promise<PickOutcome> {
  const frames = await listTabFrames(tabId);
  if (frames.length === 0) return { status: "cancelled" };

  return new Promise<PickOutcome>((resolve) => {
    let remaining = frames.length;
    let settled = false;

    const cancelAll = (): void => {
      for (const frame of frames) {
        void sendToFrame(tabId, frame.frameId, { type: "CANCEL_PICK" }).catch(
          () => undefined,
        );
      }
    };

    for (const frame of frames) {
      void sendToFrame(tabId, frame.frameId, { type: "PICK_ELEMENT" })
        .then((raw) => {
          const data = (raw as { ok?: boolean; data?: PickOutcome } | undefined)
            ?.data;
          if (settled) return;
          if (data?.status === "picked") {
            settled = true;
            cancelAll();
            resolve(data);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          remaining -= 1;
          if (!settled && remaining <= 0) {
            settled = true;
            resolve({ status: "cancelled" });
          }
        });
    }
  });
}
