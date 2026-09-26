// Fill orchestration: fetch the portal's field maps and the provider's
// resolved token values, plan per-field instructions, hand them to the
// content script in the portal tab, then log the attempt via
// POST /api/fill-events (idempotency id = crypto.randomUUID per attempt).
//
// Planning rules (v0):
//   file fields            never attempted — listed for the user
//   source "manual"        never attempted — not tracked in Minted Panel
//   source "hardcoded"     fill with hardcoded_value
//   source "token"         fill with the profile value; null/empty = listed
//   source "manual_partial" fill the token value AND flag for manual review
//   status                 ONLY "approved" fills (S5.1, 2026-07-28); proposed
//                          rows are unreviewed observations and never fill
import type { PortalFieldMap, ProviderProfileResponse } from "../shared/apiTypes";
import type {
  FillCoverage,
  FillInstruction,
  FillPageResult,
  FillSummary,
  ReportedField,
  SandboxFillSummary,
} from "../shared/fill";
import {
  ApiError,
  getPortalFieldMaps,
  getPortalFieldMapsWithMeta,
  getProviderProfile,
  postFillEvent,
  postSharedTestFill,
} from "./api";
import {
  applyFillAcrossFrames,
  listTabFrames,
  sendToFrame,
} from "./frameMessaging";
import {
  buildFillEventV2Metadata,
  createFillEventV2OpaqueKey,
  FILL_EVENT_V2_LIMIT_ERROR,
  type FillEventV2FieldOutcome,
  type FillEventV2Metadata,
} from "../shared/fillEventV2";

const STATE_ABBREVS: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
};

// yyyy-mm-dd (or a full ISO timestamp) → mm/dd/yyyy, without timezone math.
function toMmDdYyyy(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;
  return `${match[2]}/${match[3]}/${match[1]}`;
}

export function applyTransform(value: string, transform: string | null): string {
  switch (transform) {
    case null:
      return value;
    case "date_mmddyyyy":
      return toMmDdYyyy(value);
    case "state_abbrev": {
      const trimmed = value.trim();
      if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
      return STATE_ABBREVS[trimmed.toLowerCase()] ?? value;
    }
    default:
      // Unknown transform: fill the raw value rather than dropping the field.
      return value;
  }
}

function humanLabel(map: PortalFieldMap): string {
  return map.selector.startsWith("label:") ? map.selector.slice("label:".length) : map.selector;
}

function safeLegacyReason(field: ReportedField): string {
  if (field.kind === "skipped" && field.reason === "field not found on this page") {
    return "field not found on this page";
  }
  switch (field.kind) {
    case "other_page": return "field belongs to another page";
    case "page_unknown": return "current wizard page could not be confirmed";
    case "hidden": return "field is hidden on this page";
    case "no_mapping": return "mapping needs review";
    case "no_value": return "required provider value is unavailable";
    case "manual":
    case "file":
    case "review": return "manual review is required";
    case "unverified": return "field could not be verified; review it on the portal";
    default:
      return /option|dropdown|radio/i.test(field.reason)
        ? "field option mismatch; review options on the portal"
        : "field not filled; review it on the portal";
  }
}

export function sanitizeLegacyFields(fields: ReportedField[]): ReportedField[] {
  return fields.map((field) => {
    const qualifiedMiss = field.kind === "skipped" && field.reason === "field not found on this page";
    const oldReaderNoEvidence = field.kind === "page_unknown" || field.kind === "unverified";
    return {
      ...field,
      // Old Panel releases only know these recognized no-evidence kinds. Keep
      // local reports truthful, but project unknown/context states into the
      // legacy hidden bucket so they cannot become inferred drift/success.
      kind: oldReaderNoEvidence || (field.kind == null && !qualifiedMiss) ? "hidden" : field.kind,
      reason: safeLegacyReason(field),
    };
  });
}

export function createV2Outcomes(
  pageResult: FillPageResult,
  manual: ReportedField[],
  instructions: FillInstruction[],
): FillEventV2FieldOutcome[] {
  const outcomes: FillEventV2FieldOutcome[] = [...(pageResult.fieldOutcomes ?? [])];
  const instructionMaps = new Set(instructions.map((instruction) => instruction.mapId));
  for (const field of manual) {
    if (field.mapId && instructionMaps.has(field.mapId)) continue;
    const kind = field.kind;
    const outcome = kind === "no_value" ? "needs_value" : kind === "no_mapping" ? "needs_mapping" : "manual";
    const reasonCode = kind === "no_value" ? "missing_value" : kind === "no_mapping" ? "mapping_required" : "manual_required";
    const validMapId = field.mapId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(field.mapId)
      ? field.mapId
      : null;
    outcomes.push({
      mapId: validMapId,
      targetKey: createFillEventV2OpaqueKey("t"),
      frameKey: null,
      stepKey: null,
      attempted: false,
      outcome,
      reasonCode,
    });
  }
  return outcomes;
}

export function buildV2Outcomes(
  pageResult: FillPageResult,
  manual: ReportedField[],
  instructions: FillInstruction[],
): FillEventV2Metadata {
  return buildFillEventV2Metadata(createV2Outcomes(pageResult, manual, instructions));
}

function isNotChecked(field: ReportedField): boolean {
  return field.kind === "other_page" || field.kind === "page_unknown" ||
    field.kind === "hidden" || field.kind === "unverified";
}

export interface FillPlan {
  instructions: FillInstruction[];
  manual: ReportedField[];
}

export function planFill(maps: PortalFieldMap[], profile: ProviderProfileResponse): FillPlan {
  const tokenValues = new Map<string, unknown>(profile.tokens.map((t) => [t.token, t.value]));

  const instructions: FillInstruction[] = [];
  const manual: ReportedField[] = [];

  for (const map of maps) {
    // S5.1 invariant (2026-07-28, supersedes the v0 posture): ONLY approved
    // maps fill. A proposed row is an observation awaiting a human decision in
    // the panel's trainer — filling from it would let an unreviewed mapping
    // (incl. the extension's own propose-only writes, and trainer undos that
    // set a tokened row back to proposed) redirect what lands in a payer
    // form. Proposed rows still count in coverage surfaces as gaps, not fills.
    if (map.mapType !== "web" || map.status !== "approved") continue;
    const label = humanLabel(map);

    if (map.fieldType === "file") {
      manual.push({ label, reason: "file upload - attach manually", mapId: map.id, kind: "file" });
      continue;
    }
    if (map.source === "manual") {
      manual.push({
        label,
        reason: "not tracked in Minted Panel - enter manually",
        mapId: map.id,
        kind: "manual",
      });
      continue;
    }

    let raw: unknown;
    if (map.source === "hardcoded") {
      raw = map.hardcodedValue;
    } else if (map.token != null) {
      raw = tokenValues.get(map.token) ?? null;
    } else {
      // A MAPPING gap (F4.3.3): the row exists but links to no Minted Panel
      // field — the fix-it tie-in routes this to the train flow.
      manual.push({
        label,
        reason: "not linked to a Minted Panel field - enter manually",
        mapId: map.id,
        kind: "no_mapping",
      });
      continue;
    }
    if (raw == null || raw === "") {
      // user.name resolves from the caller's auth metadata (the server notes
      // the empty in meta.notes, not in unresolved) — tell the user where to
      // fix it rather than the generic no-value line.
      const reason = "no value in Minted Panel";
      // A DATA gap: mapped, but the value is missing on the provider/case —
      // routes to the provider record, not the mapping flow (F4.3.3).
      manual.push({ label, reason, mapId: map.id, kind: "no_value" });
      continue;
    }

    instructions.push({
      mapId: map.id,
      label,
      selector: map.selector,
      selectorFallbacks: map.selectorFallbacks ?? [],
      fieldType: map.fieldType,
      value: applyTransform(String(raw), map.transform),
      pageStep: map.pageStep ?? null,
    });
    if (map.source === "manual_partial") {
      manual.push({
        label,
        reason: "prefilled - review and complete manually",
        mapId: map.id,
        kind: "review",
      });
    }
  }

  return { instructions, manual };
}

// The coverage sensor (Epic 3a): reuse planFill so the "we can supply M of N"
// count and the gap list are derived from the exact same rules a real fill
// would follow — never a second, drifting derivation. `available` = the fields
// we have a value for, `total` = every fillable mapped field, `gaps` = the
// fields that need manual entry (with the server's reason). Pure; runs no fill.
export function computeCoverage(
  maps: PortalFieldMap[],
  profile: ProviderProfileResponse,
): FillCoverage {
  const { instructions, manual } = planFill(maps, profile);
  return {
    available: instructions.length,
    total: instructions.length + manual.length,
    gaps: manual,
  };
}

// What the panel requests to preview coverage without filling — the fill
// selection minus the tab (no page is touched). Mirrors FillRequest's data
// inputs; the case id rides along for selection parity but coverage depends
// only on the profile (provider + state + facility) and the portal's maps.
export interface CoverageRequest {
  providerId: string;
  portalKey: string;
  state: string;
  facilityId: string | null;
}

// Resolve the SAME field maps + profile the fill flow fetches and compute
// coverage — no new endpoint, no duplicated API calls (the two getters here are
// exactly what fillPortal uses). Read-only: it never messages the content
// script or logs a fill event.
export async function coveragePortal(request: CoverageRequest): Promise<FillCoverage> {
  const [maps, { profile }] = await Promise.all([
    getPortalFieldMaps(request.portalKey),
    getProviderProfile(request.providerId, {
      state: request.state,
      facilityId: request.facilityId,
    }),
  ]);
  return computeCoverage(maps, profile);
}

export interface FillRequest {
  tabId: number;
  providerId: string;
  caseId: string;
  portalKey: string;
  state: string;
  // The resolved location: the user's pick, or the provider's sole facility.
  // null when the provider has no facilities — facility.* tokens then come
  // back unresolved with a reason, which is correct, not an error.
  facilityId: string | null;
}

export async function fillPortal(request: FillRequest): Promise<FillSummary> {
  const startedAt = new Date().toISOString();
  // The attempt's idempotency id doubles as the fill_sessions row PK; the
  // panel passes it back as fill_session_id when the human marks the
  // submission, tying the business log to this machine log.
  const fillSessionId = crypto.randomUUID();
  const [{ maps, fillEventV2 }, { profile }] = await Promise.all([
    getPortalFieldMapsWithMeta(request.portalKey),
    getProviderProfile(request.providerId, {
      state: request.state,
      facilityId: request.facilityId,
    }),
  ]);
  const { instructions, manual } = planFill(maps, profile);

  // Pre-flight ping: any frame answering is enough (Availity's form lives in
  // a child iframe). ensureContentScript already ran in the worker.
  try {
    const frames = await listTabFrames(request.tabId);
    let alive = false;
    for (const frame of frames) {
      try {
        const pong = (await sendToFrame(request.tabId, frame.frameId, {
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

  let pageResult: FillPageResult;
  try {
    // Keep local reporting truthful even when the server remains on V1. The
    // same run-local outcomes are serialized only when meta advertises V2.
    pageResult = await applyFillAcrossFrames(request.tabId, instructions, { captureV2: true });
  } catch (error) {
    // The pre-flight ping just proved the content script is reachable, so a
    // failure here is a genuine page/apply error. The one residual edge is a
    // tab that navigates away in the window between the ping and this call —
    // that reads as "Receiving end does not exist", for which the reload
    // guidance is still the right advice.
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      message.includes("Receiving end does not exist") ||
        message.includes("Could not reach the enrollment form")
        ? "Could not reach the enrollment form - open the portal page in the current tab and reload it."
        : `Fill failed on the page: ${message}`,
      { cause: error },
    );
  }
  const completedAt = new Date().toISOString();
  const localOutcomes = createV2Outcomes(pageResult, manual, instructions);
  const localAttempted = localOutcomes.filter((field) => field.attempted).length;
  const localVerified = localOutcomes.filter((field) => field.outcome === "verified").length;
  const localRejected = localOutcomes.filter((field) => field.outcome === "write_rejected").length;
  let telemetry: FillEventV2Metadata | null = null;
  let telemetryValidationError: string | null = null;
  if (fillEventV2) {
    try {
      telemetry = buildFillEventV2Metadata(localOutcomes);
    } catch (error) {
      telemetryValidationError = error instanceof Error && error.message === FILL_EVENT_V2_LIMIT_ERROR
        ? FILL_EVENT_V2_LIMIT_ERROR
        : "Fill telemetry validation failed; telemetry was not recorded.";
    }
  }

  // Log the attempt. A logging failure must not un-report a successful fill,
  // so it degrades to a warning in the summary instead of throwing.
  let eventRecorded = true;
  let eventError: string | null = null;
  try {
    if (telemetryValidationError) throw new Error(telemetryValidationError);
    await postFillEvent({
      id: fillSessionId,
      caseId: request.caseId,
      providerId: request.providerId,
      portalKey: request.portalKey,
      fillMode: "web",
      startedAt,
      completedAt,
      fieldsFilled: telemetry?.fieldsVerified ?? pageResult.filled.length,
      // Preserve producer kinds (other_page). Content not-found historically
      // omitted kind — default those to "skipped" so the panel drift predicate
      // still matches. Never blanket-overwrite every skip to "skipped".
      fieldsSkipped: telemetry ? [] : sanitizeLegacyFields([
        ...pageResult.skipped.map((f) => ({ ...f, kind: f.kind ?? "skipped" })),
        ...manual.map((f) => ({ ...f, kind: f.kind ?? "manual" })),
      ]),
      ...(telemetry ? { v2: telemetry } : {}),
    });
  } catch (error) {
    eventRecorded = false;
    // eventError is the COMPLETE warning line the panel shows verbatim. A 403
    // means the role can't write (billing is read-only) — retrying won't
    // help, so say what will.
    if (error instanceof ApiError && error.status === 403) {
      eventError =
        "Fill applied, but it couldn't be logged: your account is read-only in this organization. Ask an admin to upgrade your role.";
    } else if (error instanceof Error && error.message === FILL_EVENT_V2_LIMIT_ERROR) {
      eventError = FILL_EVENT_V2_LIMIT_ERROR;
    } else {
      eventError = "Fill applied, but telemetry could not be recorded to Minted Panel. Retry from the case record.";
    }
  }

  const notChecked = pageResult.skipped.filter(isNotChecked);
  const skipped = pageResult.skipped.filter((field) => !isNotChecked(field));

  return {
    filled: localVerified,
    filledLabels: [],
    skipped,
    manual,
    eventRecorded,
    eventError,
    // Only reference the session when the server actually stored it — the
    // touches route validates fill_session_id and 404s an unknown id.
    fillSessionId: eventRecorded ? fillSessionId : null,
    pageFields: pageResult.pageFields,
    fieldsAttempted: localAttempted,
    fieldsVerified: localVerified,
    fieldsRejected: localRejected,
    attemptedLabels: pageResult.attemptedLabels ?? [],
    notChecked,
    fieldOutcomes: localOutcomes,
    ... (telemetry ? { schemaVersion: 2 as const, telemetry } : {}),
  };
}

// ---------------------------------------------------------------------------
// US-5 — the sandbox fill.
//
// The bottleneck it removes: filling normally requires a case, and the 4-part
// case key means one case per provider x group x payer x state — so testing a
// 100+ field form repeatedly means manufacturing cases. The sandbox fills from
// a REAL provider (the org's designated test provider) so the values exercise
// the true profile pipeline, but writes NOTHING that belongs to a case.
//
// It is deliberately NOT the mock dry run: that one is for Train forms, which
// carries no org and therefore cannot read a provider at all. Two mechanisms,
// each correct for its mode.
// ---------------------------------------------------------------------------

export interface SandboxFillRequest {
  tabId: number;
  providerId: string;
  portalKey: string;
  /** From the provider's home state / chosen licence — there is no case to
   * take it from. Null resolves state-scoped tokens honestly unresolved. */
  state: string | null;
  facilityId: string | null;
  /** Telemetry only: /api/shared-test-fills is user-scoped and takes the org
   * in its body. */
  orgId: string | null;
}

export async function sandboxFillPortal(
  request: SandboxFillRequest,
): Promise<SandboxFillSummary> {
  const startedAt = new Date().toISOString();
  const fillSessionId = crypto.randomUUID();
  const [{ maps, fillEventV2 }, { profile }] = await Promise.all([
    getPortalFieldMapsWithMeta(request.portalKey),
    getProviderProfile(request.providerId, {
      state: request.state ?? undefined,
      facilityId: request.facilityId,
    }),
  ]);
  const { instructions, manual } = planFill(maps, profile);

  try {
    const frames = await listTabFrames(request.tabId);
    let alive = false;
    for (const frame of frames) {
      try {
        const pong = (await sendToFrame(request.tabId, frame.frameId, {
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

  let pageResult: FillPageResult;
  try {
    pageResult = await applyFillAcrossFrames(request.tabId, instructions, { captureV2: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(
      message.includes("Receiving end does not exist") ||
        message.includes("Could not reach the enrollment form")
        ? "Could not reach the enrollment form - open the portal page in the current tab and reload it."
        : `Sandbox fill failed on the page: ${message}`,
      { cause: error },
    );
  }
  const completedAt = new Date().toISOString();
  const localOutcomes = createV2Outcomes(pageResult, manual, instructions);
  const localAttempted = localOutcomes.filter((field) => field.attempted).length;
  const localVerified = localOutcomes.filter((field) => field.outcome === "verified").length;
  const localRejected = localOutcomes.filter((field) => field.outcome === "write_rejected").length;
  let telemetry: FillEventV2Metadata | null = null;
  let telemetryValidationError: string | null = null;
  if (fillEventV2) {
    try {
      telemetry = buildFillEventV2Metadata(localOutcomes);
    } catch (error) {
      telemetryValidationError = error instanceof Error && error.message === FILL_EVENT_V2_LIMIT_ERROR
        ? FILL_EVENT_V2_LIMIT_ERROR
        : "Fill telemetry validation failed; telemetry was not recorded.";
    }
  }

  // The machine log rides /api/shared-test-fills: is_test, NO case and NO
  // provider. That is what makes 5.2 true by construction rather than by
  // remembering not to call the case routes — there is no case id to send.
  // It also keeps these runs out of form-drift, which excludes test fills.
  let logError: string | null = null;
  let recordedId: string | null = null;
  try {
    if (telemetryValidationError) throw new Error(telemetryValidationError);
    recordedId = await postSharedTestFill({
      id: fillSessionId,
      portalKey: request.portalKey,
      fieldsFilled: telemetry?.fieldsVerified ?? pageResult.filled.length,
      fieldsSkipped: telemetry ? [] : sanitizeLegacyFields([
        ...pageResult.skipped,
        ...manual.map((f): ReportedField => ({ ...f, kind: "manual" })),
      ]),
      startedAt,
      completedAt,
      orgId: request.orgId,
      ...(telemetry ? { v2: telemetry } : {}),
    });
  } catch (error) {
    // A logging failure must not un-report a fill that really happened.
    logError = error instanceof Error && error.message === FILL_EVENT_V2_LIMIT_ERROR
      ? FILL_EVENT_V2_LIMIT_ERROR
      : "Sandbox fill applied, but telemetry could not be recorded.";
  }

  return {
    filled: localVerified,
    filledLabels: [],
    skipped: pageResult.skipped.filter((field) => !isNotChecked(field)),
    manual,
    pageFields: pageResult.pageFields,
    fillSessionId: recordedId,
    logError,
    fieldsAttempted: localAttempted,
    fieldsVerified: localVerified,
    fieldsRejected: localRejected,
    attemptedLabels: pageResult.attemptedLabels ?? [],
    notChecked: pageResult.skipped.filter(isNotChecked),
    fieldOutcomes: localOutcomes,
    ...(telemetry ? { schemaVersion: 2 as const } : {}),
  };
}
