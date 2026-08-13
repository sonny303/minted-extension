// E6.9 — Train-forms synthetic dry run.
//
// The worker owns the synthetic values and resolves them before messaging the
// page. The content script receives the same value-bearing instructions as a
// real fill; it never sees tokens or talks to the API.

import type { PortalFieldMap } from "../shared/apiTypes";
import type { FillInstruction, FillPageResult, ReportedField } from "../shared/fill";
import { applyTransform } from "./fill";
import { listSharedFieldMaps, postSharedTestFill } from "./api";
import {
  MOCK_FILL_PROFILE_VERSION,
  mockValueForToken,
} from "../shared/mockFillProfile";
import { classifyFieldMap } from "../shared/fieldClassify";

export interface MockDryRunPlan {
  instructions: FillInstruction[];
  gaps: ReportedField[];
}

export interface MockDryRunSummary {
  pass: boolean;
  filled: number;
  skipped: ReportedField[];
  gaps: ReportedField[];
  fillSessionId: string;
  mockProfileVersion: number;
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
    });
  }

  return { instructions, gaps };
}

export async function fillMockPortal(input: {
  tabId: number;
  portalKey: string;
  orgId: string | null;
}): Promise<MockDryRunSummary> {
  const startedAt = new Date().toISOString();
  const fillSessionId = crypto.randomUUID();
  const maps = await listSharedFieldMaps(input.portalKey);
  const plan = planMockFill(maps);

  try {
    const pong = (await chrome.tabs.sendMessage(input.tabId, { type: "PING" })) as
      | { ok?: boolean }
      | undefined;
    if (pong?.ok !== true) throw new Error("the enrollment form did not answer the pre-flight ping");
  } catch (error) {
    throw new Error(
      "Could not reach the enrollment form - open the portal's enrollment page in the current tab and reload it.",
      { cause: error },
    );
  }

  let pageResult: FillPageResult;
  try {
    const response = (await chrome.tabs.sendMessage(input.tabId, {
      type: "APPLY_FILL",
      instructions: plan.instructions,
    })) as { ok: boolean; data?: FillPageResult; error?: string } | undefined;
    if (!response?.ok || !response.data) {
      throw new Error(response?.error ?? "the page didn't confirm the mock dry run");
    }
    pageResult = response.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      message.includes("Receiving end does not exist")
        ? "Could not reach the enrollment form - open the portal page in the current tab and reload it."
        : `Mock dry run failed on the page: ${message}`,
      { cause: error },
    );
  }

  const completedAt = new Date().toISOString();
  const skipped = pageResult.skipped;
  const fieldsSkipped = [...skipped, ...plan.gaps];
  const pass =
    plan.gaps.length === 0 &&
    skipped.length === 0 &&
    (pageResult.filled.length > 0 || plan.instructions.length === 0);
  const result = await postSharedTestFill({
    id: fillSessionId,
    portalKey: input.portalKey,
    fieldsFilled: pageResult.filled.length,
    fieldsSkipped,
    startedAt,
    completedAt,
    orgId: input.orgId,
    mockProfileVersion: MOCK_FILL_PROFILE_VERSION,
  });

  return {
    pass,
    filled: pageResult.filled.length,
    skipped,
    gaps: plan.gaps,
    fillSessionId: result,
    mockProfileVersion: MOCK_FILL_PROFILE_VERSION,
  };
}
