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
import type { ControlSummary } from "../shared/nanoAi";
import { pageScopeMatches } from "../shared/pageScope";

export interface TabFrame {
  frameId: number;
  url: string;
}

export interface FramedAiScan {
  frameId: number;
  url: string;
  controls: ControlSummary[];
}

export interface AiScanAcrossFrames {
  frames: FramedAiScan[];
  controls: ControlSummary[];
  ambiguousSelectors: string[];
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
  const writes: NonNullable<FillPageResult["writes"]> = [];
  const skipped = new Map<string, ReportedField>();
  let pageFields = 0;

  for (const result of results) {
    pageFields += result.pageFields;
    for (const label of result.filled) filledLabels.add(label);
    writes.push(...(result.writes ?? []));
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
    writes,
    skipped: [...skipped.values()],
    pageFields,
  };
}

/** Scan each frame locally. Frame IDs and URLs remain worker-owned and are
 * returned only to the caller, never to the panel or a stored field map. */
export async function scanUnmappedControlsAcrossFrames(
  tabId: number,
  scanId: string,
  activeMaps: Array<{ selector: string; selectorFallbacks?: string[] | null; pageUrlScope?: string }>,
): Promise<AiScanAcrossFrames> {
  const frames = await listTabFrames(tabId);
  const scanned = await Promise.all(frames.map(async (frame): Promise<FramedAiScan | null> => {
    try {
      const raw = (await sendToFrame(tabId, frame.frameId, {
        type: "SCAN_UNMAPPED_CONTROLS",
        scanId,
        activeMaps: activeMaps.filter((map) => pageScopeMatches(map.pageUrlScope, frame.url)),
      })) as { ok?: boolean; data?: unknown } | undefined;
      if (!raw?.ok || !Array.isArray(raw.data)) return null;
      return {
        frameId: frame.frameId,
        url: frame.url,
        controls: raw.data as ControlSummary[],
      };
    } catch {
      return null;
    }
  }));
  const live = scanned.filter((item): item is FramedAiScan => item != null);
  if (live.length === 0) throw new Error("Could not scan the enrollment form");

  const occurrences = new Map<string, number>();
  for (const frame of live) {
    for (const control of frame.controls) {
      occurrences.set(control.selector, (occurrences.get(control.selector) ?? 0) + 1);
    }
  }
  const ambiguousSelectors = [...occurrences]
    .filter(([, count]) => count > 1)
    .map(([selector]) => selector);
  const ambiguous = new Set(ambiguousSelectors);
  for (const frame of live) {
    frame.controls = frame.controls.filter((control) => !ambiguous.has(control.selector));
  }
  return {
    frames: live,
    controls: live.flatMap((frame) => frame.controls),
    ambiguousSelectors,
  };
}

export async function clearAiScanAcrossFrames(
  tabId: number,
  scanId: string,
  frameIds: number[],
): Promise<void> {
  await Promise.all(frameIds.map((frameId) => sendToFrame(tabId, frameId, {
    type: "CLEAR_AI_SCAN",
    scanId,
  }).catch(() => undefined)));
}

export async function clearAiFillAcrossFrames(
  tabId: number,
  fillSessionId: string,
  frameIds?: number[],
): Promise<number> {
  const responses = frameIds == null
    ? await sendToAllFrames(tabId, { type: "CLEAR_AI_FILL", fillSessionId })
    : await Promise.all(frameIds.map(async (frameId): Promise<FrameResponse> => {
        try {
          const raw = (await sendToFrame(tabId, frameId, {
            type: "CLEAR_AI_FILL",
            fillSessionId,
          })) as { ok?: boolean; data?: unknown } | undefined;
          return raw?.ok
            ? { frameId, ok: true, data: raw.data }
            : { frameId, ok: false };
        } catch {
          return { frameId, ok: false };
        }
      }));
  return responses.reduce((count, response) =>
    response.ok && typeof response.data === "number" ? count + response.data : count,
  0);
}

export interface AiFillApplyLifecycle {
  isCancelled: () => boolean;
  validate: () => Promise<void>;
  onDispatch?: (frameId: number) => void;
}

export async function acceptAiFillAcrossFrames(
  tabId: number,
  fillSessionId: string,
): Promise<void> {
  await sendToAllFrames(tabId, { type: "ACCEPT_AI_FILL", fillSessionId });
}

/** Release value-bearing undo snapshots after the successful submission touch. */
export async function finalizeAiFillAcrossFrames(
  tabId: number,
  fillSessionId: string,
): Promise<void> {
  await sendToAllFrames(tabId, { type: "FINALIZE_AI_FILL", fillSessionId });
}

/** Target AI instructions only to the frame that produced each selector. */
export async function applyAiFillAcrossBoundFrames(
  tabId: number,
  scanId: string,
  fillSessionId: string,
  frames: FramedAiScan[],
  instructions: FillInstruction[],
  lifecycle?: AiFillApplyLifecycle,
): Promise<FillPageResult> {
  const assertCurrent = async (): Promise<void> => {
    if (lifecycle?.isCancelled()) throw new Error("AI fill operation was cancelled");
    await lifecycle?.validate();
    if (lifecycle?.isCancelled()) throw new Error("AI fill operation was cancelled");
  };
  await assertCurrent();
  const results: FillPageResult[] = [];
  for (const frame of frames) {
    await assertCurrent();
    const liveFrames = await listTabFrames(tabId);
    await assertCurrent();
    const stillLive = liveFrames.some((current) =>
      current.frameId === frame.frameId && current.url === frame.url,
    );
    const bound = new Set(frame.controls.map((control) => control.selector));
    const forFrame = instructions.filter((instruction) => bound.has(instruction.selector));
    if (forFrame.length === 0) continue;
    if (!stillLive) {
      results.push({
        filled: [],
        writes: [],
        skipped: forFrame.map((instruction) => ({
          label: instruction.selector,
          reason: "AI frame changed after scan",
          kind: "skipped",
        })),
        pageFields: 0,
      });
      continue;
    }
    await assertCurrent();
    lifecycle?.onDispatch?.(frame.frameId);
    try {
      const raw = (await sendToFrame(tabId, frame.frameId, {
        type: "APPLY_AI_FILL",
        scanId,
        fillSessionId,
        instructions: forFrame,
      })) as { ok?: boolean; data?: unknown } | undefined;
      try {
        await assertCurrent();
      } catch (error) {
        // Invalidation may race a content reply. Clear this frame after the
        // reply as well as during cancellation so late writes cannot survive.
        await clearAiFillAcrossFrames(tabId, fillSessionId, [frame.frameId]);
        throw error;
      }
      if (raw?.ok && raw.data) {
        const result = raw.data as FillPageResult;
        // The transient frame binding lets learning preserve each iframe's
        // actual page scope without persisting an ephemeral frame id.
        results.push({
          ...result,
          writes: result.writes?.map((write) => ({ ...write, pageUrl: frame.url })),
        });
      } else {
        results.push({
          filled: [],
          writes: [],
          skipped: forFrame.map((instruction) => ({
            label: instruction.selector,
            reason: "AI target could not be applied",
            kind: "skipped",
          })),
          pageFields: 0,
        });
      }
    } catch {
      if (lifecycle) {
        try {
          await assertCurrent();
        } catch (error) {
          await clearAiFillAcrossFrames(tabId, fillSessionId, [frame.frameId]);
          throw error;
        }
      }
      if (lifecycle?.isCancelled()) {
        await clearAiFillAcrossFrames(tabId, fillSessionId, [frame.frameId]);
        throw new Error("AI fill operation was cancelled");
      }
      results.push({
        filled: [],
        writes: [],
        skipped: forFrame.map((instruction) => ({
          label: instruction.selector,
          reason: "AI frame changed before apply",
          kind: "skipped",
        })),
        pageFields: 0,
      });
    }
  }
  await assertCurrent();
  return mergeFillPageResults(results);
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

/** APPLY_FILL across frames: each frame gets only in-scope values. Empty plans
 * still reach content.js so every reachable frame contributes its page count. */
export async function applyFillAcrossFrames(
  tabId: number,
  instructions: FillInstruction[],
): Promise<FillPageResult> {
  const frames = await listTabFrames(tabId);
  const responses = await Promise.all(frames.map(async (frame): Promise<FrameResponse> => {
    const scoped = instructions.filter((instruction) =>
      pageScopeMatches(instruction.pageUrlScope, frame.url),
    );
    try {
      const raw = (await sendToFrame(tabId, frame.frameId, {
        type: "APPLY_FILL",
        instructions: scoped,
      })) as { ok?: boolean; data?: unknown } | undefined;
      return raw?.ok
        ? { frameId: frame.frameId, ok: true, data: raw.data }
        : { frameId: frame.frameId, ok: false };
    } catch {
      return { frameId: frame.frameId, ok: false };
    }
  }));
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
