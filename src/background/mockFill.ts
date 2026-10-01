// E6.9 — Train-forms synthetic dry run.
//
// The worker owns the synthetic values and resolves them before messaging the
// page. The content script receives the same value-bearing instructions as a
// real fill; it never sees tokens or talks to the API.

import type { PortalFieldMap } from "../shared/apiTypes";
import type { FillInstruction, FillPageResult, MockDryRunSummary, ReportedField } from "../shared/fill";
import { applyTransform, createV2Outcomes, sanitizeLegacyFields } from "./fill";
import { listSharedFieldMapsWithMeta, postSharedTestFill } from "./api";
import {
  applyFillAcrossFrames,
  listTabFrames,
  sendToFrame,
} from "./frameMessaging";
import {
  MOCK_FILL_PROFILE_VERSION,
  mockValueForToken,
} from "../shared/mockFillProfile";
import { classifyFieldMap } from "../shared/fieldClassify";
import { buildFillEventV2Metadata, FILL_EVENT_V2_LIMIT_ERROR, type FillEventV2Metadata } from "../shared/fillEventV2";

export interface MockDryRunPlan {
  instructions: FillInstruction[];
  gaps: ReportedField[];
}

function humanLabel(map: PortalFieldMap): string {
  return map.selector.startsWith("label:") ? map.selector.slice("label:".length) : map.selector;
}

function gapFor(map: PortalFieldMap, reason: string, kind: ReportedField["kind"] = "no_mapping"): ReportedField {
  return {
    label: humanLabel(map),
    reason,
    mapId: map.id,
    kind,
  };
}

export function planMockFill(maps: PortalFieldMap[]): MockDryRunPlan {
  const instructions: FillInstruction[] = [];
  const gaps: ReportedField[] = [];

  for (const map of maps) {
    const classification = classifyFieldMap(map);
    if (classification.decision === "human" || classification.decision === "stale") continue;
    if (map.fieldType === "file") {
      gaps.push(gapFor(map, "File fields must be attached manually", "file"));
      continue;
    }
    if (classification.needsDecision || classification.decision === "invalid") {
      gaps.push(gapFor(map, classification.reason));
      continue;
    }
    if (map.mapType !== "web") {
      gaps.push(gapFor(map, "This map is not a web field"));
      continue;
    }

    const value =
      classification.decision === "fixed"
        ? map.hardcodedValue?.trim() ?? ""
        : map.token
          ? mockValueForToken(map.token)
          : "";
    if (value === "") {
      gaps.push(gapFor(map, "No synthetic value is available"));
      continue;
    }
    instructions.push({
      mapId: map.id,
      label: humanLabel(map),
      selector: map.selector,
      selectorFallbacks: map.selectorFallbacks ?? [],
      fieldType: map.fieldType,
      value: applyTransform(value, map.transform),
      pageStep: map.pageStep ?? null,
    });
  }

  return { instructions, gaps };
}

export async function fillMockPortal(input: {
  tabId: number;
  portalKey: string;
  orgId: string | null;
  /** Revalidates the exact Train/Test target across asynchronous boundaries. */
  validateTarget?: () => Promise<void>;
}): Promise<MockDryRunSummary> {
  const startedAt = new Date().toISOString();
  const fillSessionId = crypto.randomUUID();
  await input.validateTarget?.();
  const { maps, fillEventV2 } = await listSharedFieldMapsWithMeta(input.portalKey);
  await input.validateTarget?.();
  const plan = planMockFill(maps);

  try {
    const frames = await listTabFrames(input.tabId);
    let alive = false;
    for (const frame of frames) {
      try {
        const pong = (await sendToFrame(input.tabId, frame.frameId, {
          type: "PING",
        })) as { ok?: boolean } | undefined;
        if (pong?.ok === true) {
          alive = true;
          break;
        }
      } catch {
        // try next frame
      }
    }
    if (!alive) throw new Error("the enrollment form did not answer the pre-flight ping");
  } catch (error) {
    throw new Error(
      "Could not reach the enrollment form - open the portal's enrollment page in the current tab and reload it.",
      { cause: error },
    );
  }

  await input.validateTarget?.();
  let pageResult: FillPageResult;
  try {
    // Always capture local truth; only serialization is capability-gated.
    pageResult = await applyFillAcrossFrames(input.tabId, plan.instructions, { captureV2: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      message.includes("Receiving end does not exist") ||
        message.includes("Could not reach the enrollment form")
        ? "Could not reach the enrollment form - open the portal page in the current tab and reload it."
        : `Mock dry run failed on the page: ${message}`,
      { cause: error },
    );
  }

  await input.validateTarget?.();
  const completedAt = new Date().toISOString();
  const notChecked = pageResult.skipped.filter((field) => ["other_page", "page_unknown", "hidden", "unverified"].includes(String(field.kind)));
  const skipped = pageResult.skipped.filter((field) => !notChecked.includes(field));
  const fieldsSkipped = [...pageResult.skipped, ...plan.gaps];
  const localOutcomes = createV2Outcomes(pageResult, plan.gaps, plan.instructions);
  const localAttempted = localOutcomes.filter((field) => field.attempted).length;
  const localVerified = localOutcomes.filter((field) => field.outcome === "verified").length;
  let telemetry: FillEventV2Metadata | null = null;
  let logError: string | null = null;
  if (fillEventV2) {
    try {
      telemetry = buildFillEventV2Metadata(localOutcomes);
    } catch (error) {
      logError = error instanceof Error && error.message === FILL_EVENT_V2_LIMIT_ERROR
        ? FILL_EVENT_V2_LIMIT_ERROR
        : "Fill telemetry validation failed; telemetry was not recorded.";
    }
  }
  let resultId: string | null = null;
  try {
    if (fillEventV2 && !telemetry) throw new Error(logError ?? "Fill telemetry validation failed; telemetry was not recorded.");
    await input.validateTarget?.();
    resultId = await postSharedTestFill({
      id: fillSessionId,
      portalKey: input.portalKey,
      fieldsFilled: telemetry?.fieldsVerified ?? pageResult.filled.length,
      fieldsSkipped: telemetry ? [] : sanitizeLegacyFields(fieldsSkipped),
      startedAt,
      completedAt,
      orgId: input.orgId,
      mockProfileVersion: MOCK_FILL_PROFILE_VERSION,
      ...(telemetry ? { v2: telemetry } : {}),
    });
  } catch (error) {
    logError = error instanceof Error && error.message === FILL_EVENT_V2_LIMIT_ERROR
      ? FILL_EVENT_V2_LIMIT_ERROR
      : "Mock fill ran, but telemetry could not be recorded.";
  }
  await input.validateTarget?.();
  // R1 has no semantic readback, so a setter-accepted synthetic run cannot be
  // called passed even when the V2 server capability is absent.
  const pass = localVerified > 0 && plan.gaps.length === 0 && skipped.length === 0;

  return {
    pass,
    filled: localVerified,
    skipped,
    gaps: plan.gaps,
    fillSessionId: resultId ?? "",
    mockProfileVersion: MOCK_FILL_PROFILE_VERSION,
    fieldsAttempted: localAttempted,
    fieldsVerified: localVerified,
    attemptedLabels: pageResult.attemptedLabels ?? [],
    notChecked,
    fieldOutcomes: localOutcomes,
    logError,
    ...(telemetry ? { schemaVersion: 2 as const } : {}),
  };
}
