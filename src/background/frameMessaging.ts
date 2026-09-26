// Multi-frame tab messaging. Availity (and similar shells) render the real
// enrollment form inside a child iframe; `tabs.sendMessage(tabId, msg)` without
// `frameId` only reaches frame 0 (the shell). Frame IDs are ephemeral per load
// — never persist them on field maps. Capture aggregates; fill resolves by
// which live frame can see the selector.

import type { CapturedField } from "../content/captureScan";
import type { ContentRequest } from "../shared/fill";
import type { FillInstruction, FillPageResult, FillProbeInstruction, FillProbeResult, ReportedField } from "../shared/fill";
import { FIELD_NOT_FOUND_REASON } from "../shared/fixit";
import type { SelectorMatchReport } from "../shared/selectorMatch";
import type { PickOutcome } from "../content/elementPicker";
import { createFillEventV2OpaqueKey, isFillEventV2FieldOutcome, type FillEventV2FieldOutcome, type FillEventV2Outcome, type FillEventV2ReasonCode } from "../shared/fillEventV2";
import { isExactFillPageIdentity, OTHER_PAGE_REASON, PAGE_UNKNOWN_REASON } from "../shared/fillPage";

export interface TabFrame {
  frameId: number;
  url: string;
}

function isFillProbeResult(value: unknown): value is FillProbeResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.mapId === "string" &&
    ["eligible", "other_page", "page_unknown"].includes(String(row.pageStatus)) &&
    ["unique", "hidden", "ambiguous", "missing", "unsupported"].includes(String(row.targetStatus)) &&
    typeof row.pageSettled === "boolean" && typeof row.radioGroup === "boolean" &&
    typeof row.pageFields === "number" && Number.isFinite(row.pageFields) && row.pageFields >= 0;
}

function isReportedField(value: unknown): value is ReportedField {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.label === "string" && typeof row.reason === "string" &&
    (row.mapId === undefined || typeof row.mapId === "string") &&
    (row.kind === undefined || typeof row.kind === "string");
}

function isFillPageResult(value: unknown): value is FillPageResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Array.isArray(row.filled) && row.filled.every((item) => typeof item === "string") &&
    (row.attemptedLabels === undefined || (Array.isArray(row.attemptedLabels) && row.attemptedLabels.every((item) => typeof item === "string"))) &&
    Array.isArray(row.skipped) && row.skipped.every(isReportedField) &&
    typeof row.pageFields === "number" && Number.isFinite(row.pageFields) && row.pageFields >= 0 &&
    (row.fieldOutcomes === undefined || (Array.isArray(row.fieldOutcomes) && row.fieldOutcomes.every(isFillEventV2FieldOutcome)));
}

function safeReason(field: ReportedField): string {
  if (field.kind === "skipped" && field.reason === FIELD_NOT_FOUND_REASON) return FIELD_NOT_FOUND_REASON;
  if (field.kind === "hidden") return "field is hidden on this page";
  if (field.kind === "other_page") return OTHER_PAGE_REASON;
  if (field.kind === "page_unknown") return PAGE_UNKNOWN_REASON;
  if (field.kind === "no_mapping") return "mapping needs review";
  if (field.kind === "no_value") return "required provider value is unavailable";
  if (field.kind === "manual" || field.kind === "file" || field.kind === "review") return "manual review is required";
  if (/option|dropdown|radio/i.test(field.reason)) return "field option mismatch; review options on the portal";
  if (field.kind === "unverified" || field.kind === "skipped") return "field could not be verified; review it on the portal";
  return "field could not be verified; review it on the portal";
}

function sanitizeReport(field: ReportedField): ReportedField {
  const qualifiedMiss = field.kind === "skipped" && field.reason === FIELD_NOT_FOUND_REASON;
  const knownKind = ["no_mapping", "no_value", "file", "manual", "review", "skipped", "other_page", "hidden", "page_unknown", "unverified"].includes(String(field.kind));
  return {
    ...field,
    kind: knownKind ? field.kind : "unverified",
    reason: qualifiedMiss ? FIELD_NOT_FOUND_REASON : safeReason(field),
  };
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
  return field.mapId ? `map:${field.mapId}` : `label:${field.label}`;
}

/**
 * Merge legacy reports without using labels to suppress another map's result.
 * Production filling routes one unique map target to one frame before apply.
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
  options: { captureV2?: boolean } = {},
): Promise<FillPageResult> {
  if (instructions.length === 0) return { filled: [], skipped: [], pageFields: 0, fieldOutcomes: [] };
  const frames = await listTabFrames(tabId);
  const frameKeys = new Map(frames.map((frame) => [frame.frameId, options.captureV2 ? createFillEventV2OpaqueKey("f") : ""]));
  // Probe/apply correlation is always enabled, even for a V1 server. V2
  // serialization remains gated separately by endpoint capability.
  const targetKeys = new Map(instructions.map((instruction) => [instruction, createFillEventV2OpaqueKey("t")]));
  const stepKeys = new Map<string, string>();
  const probes: FillProbeInstruction[] = instructions.map((instruction) => ({
    mapId: instruction.mapId,
    probeKey: targetKeys.get(instruction) as string,
    selector: instruction.selector,
    selectorFallbacks: instruction.selectorFallbacks,
    fieldType: instruction.fieldType,
    pageStep: instruction.pageStep,
  }));
  const responses = await Promise.all(frames.map(async (frame): Promise<FrameResponse> => {
    try {
      const raw = (await sendToFrame(tabId, frame.frameId, { type: "PROBE_FILL", instructions: probes })) as
        | { ok?: boolean; data?: unknown }
        | undefined;
      return raw?.ok ? { frameId: frame.frameId, ok: true, data: raw.data } : { frameId: frame.frameId, ok: false };
    } catch {
      return { frameId: frame.frameId, ok: false };
    }
  }));
  if (responses.every((response) => !response.ok)) throw new Error("Could not reach the enrollment form in any frame");

  const probeByFrame = new Map<number, Map<string, FillProbeResult>>();
  let pageFields = 0;
  for (const response of responses) {
    if (!response.ok) continue;
    const rows = Array.isArray(response.data) ? response.data.filter(isFillProbeResult) : [];
    const rowMap = new Map(rows.map((row) => [row.mapId, row]));
    const expectedMapIds = new Set(instructions.map((instruction) => instruction.mapId));
    const exactCompleteResult = Array.isArray(response.data) && rows.length === response.data.length &&
      rows.length === expectedMapIds.size && rowMap.size === expectedMapIds.size &&
      [...expectedMapIds].every((mapId) => rowMap.has(mapId));
    probeByFrame.set(response.frameId, exactCompleteResult ? rowMap : new Map());
    if (exactCompleteResult) pageFields += rows[0]?.pageFields ?? 0;
  }

  const filled: string[] = [];
  const attemptedLabels: string[] = [];
  const skipped: ReportedField[] = [];
  const fieldOutcomes: FillEventV2FieldOutcome[] = [];
  let priorApplyMayHaveChangedPage = false;
  const uuid = (value: string): string | null => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
  const pushOutcome = (
    instruction: FillInstruction,
    outcome: FillEventV2Outcome,
    reasonCode: FillEventV2ReasonCode | null,
    frameId: number | null,
    stepKey: string | null,
    evidence?: FillEventV2FieldOutcome["notFoundEvidence"],
  ): void => {
    if (!options.captureV2) return;
    const row: FillEventV2FieldOutcome = {
      mapId: uuid(instruction.mapId),
      targetKey: targetKeys.get(instruction) as string,
      frameKey: frameId == null ? null : (frameKeys.get(frameId) ?? null),
      stepKey,
      attempted: outcome === "unverified" && reasonCode === "readback_unavailable",
      outcome,
      reasonCode,
    };
    if (evidence) row.notFoundEvidence = evidence;
    fieldOutcomes.push(row);
  };
  const skip = (instruction: FillInstruction, outcome: FillEventV2Outcome, reasonCode: FillEventV2ReasonCode, reason: string, kind: ReportedField["kind"], frameId: number | null = null, stepKey: string | null = null, evidence?: FillEventV2FieldOutcome["notFoundEvidence"]): void => {
    skipped.push({ label: instruction.label, reason, mapId: instruction.mapId, kind });
    pushOutcome(instruction, outcome, reasonCode, frameId, stepKey, evidence);
  };

  for (const instruction of instructions) {
    const reachableFrames = responses.filter((response) => response.ok);
    const incompleteProbe = reachableFrames.some((response) =>
      !probeByFrame.get(response.frameId)?.has(instruction.mapId),
    );
    if (incompleteProbe) {
      skip(instruction, "unverified", "context_changed", "form context could not be fully checked", "unverified");
      continue;
    }
    const rows = responses.filter((response) => response.ok).flatMap((response) => {
      const probe = probeByFrame.get(response.frameId)?.get(instruction.mapId);
      return probe ? [{ frameId: response.frameId, probe }] : [];
    });
    const hasInaccessibleFrame = responses.some((response) => !response.ok);
    const knownPage = isExactFillPageIdentity(instruction.pageStep);
    const eligible = rows.filter(({ probe }) => probe.pageStatus === "eligible");
    const unknownPage = rows.some(({ probe }) => probe.pageStatus === "page_unknown");
    const otherPage = rows.length > 0 && rows.every(({ probe }) => probe.pageStatus === "other_page");
    const ambiguous = eligible.find(({ probe }) => probe.targetStatus === "ambiguous");
    const hidden = eligible.find(({ probe }) => probe.targetStatus === "hidden");
    const unsupported = eligible.find(({ probe }) => probe.targetStatus === "unsupported");
    const candidates = eligible.filter(({ probe }) => probe.targetStatus === "unique");

    if (ambiguous || candidates.length > 1 || hidden && candidates.length > 0) {
      skip(instruction, "needs_mapping", "ambiguous_target", "multiple visible controls or frames match this mapping", "no_mapping");
      continue;
    }
    if (hasInaccessibleFrame) {
      skip(instruction, "unverified", "frame_inaccessible", "a form frame could not be checked", "unverified");
      continue;
    }
    if (unknownPage && knownPage) {
      skip(instruction, "page_unknown", "page_unknown", PAGE_UNKNOWN_REASON, "page_unknown");
      continue;
    }
    if (otherPage && knownPage) {
      skip(instruction, "other_page", "other_page", OTHER_PAGE_REASON, "other_page");
      continue;
    }
    if (hidden) {
      skip(instruction, "hidden", "field_hidden", "field is hidden on this page", "hidden", hidden.frameId);
      continue;
    }
    if (unsupported) {
      skip(instruction, "unsupported", "unsupported_control", "mapping does not resolve to a fillable control", "unverified", unsupported.frameId);
      continue;
    }
    if (candidates.length === 0) {
      if (unknownPage) {
        skip(instruction, "page_unknown", "page_unknown", PAGE_UNKNOWN_REASON, "page_unknown");
      } else if (priorApplyMayHaveChangedPage && knownPage && eligible.length > 0) {
        // Earlier setters can reveal dependent panels. Do not turn a pre-write
        // absence snapshot into drift for later maps in this same run.
        skip(instruction, "unverified", "context_changed", "form context may have changed during the fill", "unverified");
      } else if (knownPage && eligible.length > 0 && rows.every(({ probe }) => probe.pageSettled) && eligible.every(({ probe }) => probe.targetStatus === "missing")) {
        const frameId = eligible[0]?.frameId ?? null;
        let stepKey: string | null = null;
        if (options.captureV2 && instruction.pageStep) {
          stepKey = stepKeys.get(instruction.pageStep) ?? createFillEventV2OpaqueKey("s");
          stepKeys.set(instruction.pageStep, stepKey);
        }
        skip(instruction, "not_found", "target_missing", FIELD_NOT_FOUND_REASON, "skipped", frameId, stepKey, {
          stepKnown: true,
          frameAccessible: true,
          pageSettled: true,
          searchComplete: true,
          targetAbsent: true,
        });
      } else if (knownPage && eligible.length > 0) {
        skip(instruction, "unverified", "context_changed", "form is still changing; review this field", "unverified");
      } else {
        skip(instruction, "needs_mapping", "mapping_required", "mapping needs review on this page", "no_mapping");
      }
      continue;
    }

    const targetFrame = candidates[0];
    if (!targetFrame) continue;
    let stepKey: string | null = null;
    if (options.captureV2 && knownPage && instruction.pageStep) {
      stepKey = stepKeys.get(instruction.pageStep) ?? createFillEventV2OpaqueKey("s");
      stepKeys.set(instruction.pageStep, stepKey);
    }
    const routed: FillInstruction = {
      ...instruction,
      probeKey: targetKeys.get(instruction) as string,
      ...(options.captureV2 ? {
        telemetry: {
          targetKey: targetKeys.get(instruction) as string,
          frameKey: frameKeys.get(targetFrame.frameId) as string,
          stepKey,
        },
      } : {}),
    };
    try {
      priorApplyMayHaveChangedPage = true;
      const raw = (await sendToFrame(tabId, targetFrame.frameId, { type: "APPLY_FILL", instructions: [routed], requireUniqueTarget: true })) as
        | { ok?: boolean; data?: unknown }
        | undefined;
      if (!raw?.ok || !isFillPageResult(raw.data)) {
        skip(instruction, "unverified", "context_changed", "form changed while the field was being applied", "unverified", targetFrame.frameId, stepKey);
        continue;
      }
      const result = raw.data;
      filled.push(...result.filled);
      skipped.push(...result.skipped.map(sanitizeReport));
      if (options.captureV2) {
        const routedIdentity = routed.telemetry;
        const outcomes = result.fieldOutcomes ?? [];
        const matchingOutcome = outcomes.length === 1 && routedIdentity &&
          outcomes[0]?.targetKey === routedIdentity.targetKey &&
          outcomes[0]?.frameKey === routedIdentity.frameKey &&
          outcomes[0]?.stepKey === routedIdentity.stepKey &&
          outcomes[0]?.mapId === uuid(instruction.mapId)
          ? outcomes[0]
          : null;
        if (matchingOutcome) {
          fieldOutcomes.push(matchingOutcome);
          if (matchingOutcome.attempted) attemptedLabels.push(instruction.label);
        } else {
          // Older or mixed content-script versions may apply a setter without
          // returning the exact run identity. The historical filled label is
          // not enough to bind an attempt to this target, so preserve only
          // uncertainty locally and in telemetry.
          skipped.push({
            label: instruction.label,
            reason: "field could not be verified; review it on the portal",
            mapId: instruction.mapId,
            kind: "unverified",
          });
          pushOutcome(
            instruction,
            "unverified",
            "context_changed",
            targetFrame.frameId,
            stepKey,
          );
        }
      }
    } catch {
      skip(instruction, "unverified", "context_changed", "form changed while the field was being applied", "unverified", targetFrame.frameId, stepKey);
    }
  }

  return { filled, attemptedLabels, skipped, pageFields, fieldOutcomes };
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
