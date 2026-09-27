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
import type { ControlSummary } from "../shared/nanoAi";
import type {
  AiFillCandidate,
  AiFillReview,
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
  getProviderProfile,
  getViewPrefs,
  postFillEvent,
  postSharedTestFill,
} from "./api";
import {
  applyFillAcrossFrames,
  applyAiFillAcrossBoundFrames,
  acceptAiFillAcrossFrames,
  clearAiFillAcrossFrames,
  clearAiScanAcrossFrames,
  listTabFrames,
  scanUnmappedControlsAcrossFrames,
  sendToFrame,
  type FramedAiScan,
  type AiFillApplyLifecycle,
} from "./frameMessaging";

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

export interface FillPlan {
  staticFills: FillInstruction[];
  aiFills: FillInstruction[];
  manual: ReportedField[];
}

export function planFill(maps: PortalFieldMap[], profile: ProviderProfileResponse): FillPlan {
  const tokenValues = new Map<string, unknown>(profile.tokens.map((t) => [t.token, t.value]));
  const unresolvedReasons = new Map<string, string>(
    profile.unresolved.map((u) => [u.token, u.reason]),
  );

  const staticFills: FillInstruction[] = [];
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
        reason: map.notes ?? "not tracked in Minted Panel - enter manually",
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
      const reason =
        map.token === "user.name"
          ? "Your name isn't set. Add it in Minted Panel under Settings so forms can list you as the preparer."
          : ((map.token != null ? unresolvedReasons.get(map.token) : null) ??
            "no value in Minted Panel");
      // A DATA gap: mapped, but the value is missing on the provider/case —
      // routes to the provider record, not the mapping flow (F4.3.3).
      manual.push({ label, reason, mapId: map.id, kind: "no_value" });
      continue;
    }

    staticFills.push({
      mapId: map.id,
      label,
      selector: map.selector,
      selectorFallbacks: map.selectorFallbacks ?? [],
      fieldType: map.fieldType,
      value: applyTransform(String(raw), map.transform),
      pageStep: map.pageStep ?? null,
      ...(map.learnedVia === "nano" ? { pageUrlScope: map.urlPattern ?? "" } : {}),
      kind: "static",
    });
    if (map.source === "manual_partial") {
      manual.push({
        label,
        reason: map.notes ?? "prefilled - review and complete manually",
        mapId: map.id,
        kind: "review",
      });
    }
  }

  return { staticFills, aiFills: [], manual };
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
  const { staticFills, manual } = planFill(maps, profile);
  return {
    available: staticFills.length,
    total: staticFills.length + manual.length,
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

export interface AiFillGuard {
  orgId: string | null;
  revision: number;
  selectionRevision: number;
  tabUrl: string;
  validate: () => Promise<void>;
}

interface PreparedAiFill {
  request: FillRequest;
  guard: AiFillGuard;
  maps: PortalFieldMap[];
  profile: ProviderProfileResponse;
  scanId: string;
  frames: FramedAiScan[];
  controls: ControlSummary[];
  tokenCatalog: string[];
  unprocessedControls: number;
  createdAt: number;
  operation?: AiFillOperation;
}

interface AiFillOperation {
  fillSessionId: string;
  cancelled: boolean;
  dispatchedFrameIds: Set<number>;
  abortController: AbortController;
}

export interface AcceptedAiFillReceipt {
  tabId: number;
  fillSessionId: string;
  providerId: string;
  caseId: string;
  portalKey: string;
  state: string;
  facilityId: string | null;
  orgId: string | null;
  actorId: string;
  selectionRevision: number;
  touchRecorded: boolean;
  learning: import("../shared/fill").AiLearningSummary;
  mappings: AiFillReview["writes"];
}

/** Strip query and fragment data before a portal URL enters a learning
 * receipt. Credentials and non-web schemes are never eligible. */
export function canonicalLearningPageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return null;
    }
    return `${url.origin}${url.pathname || "/"}`;
  } catch {
    return null;
  }
}

const preparedAiFills = new Map<string, PreparedAiFill>();
const activeAiOperations = new Map<string, { prepared: PreparedAiFill; operation: AiFillOperation }>();
const activeAiReviews = new Map<string, {
  request: FillRequest;
  guard: AiFillGuard;
  review: AiFillReview;
}>();
const AI_CONFIDENCE_THRESHOLD = 0.85;
const AI_PREPARED_MAX_AGE_MS = 120_000;

async function discardPreparedAiFill(scanId: string, prepared: PreparedAiFill): Promise<void> {
  preparedAiFills.delete(scanId);
  if (prepared.operation) await cancelAiOperation(prepared, prepared.operation);
  await clearAiScanAcrossFrames(
    prepared.request.tabId,
    prepared.scanId,
    prepared.frames.map((frame) => frame.frameId),
  );
}

async function cancelAiOperation(prepared: PreparedAiFill, operation: AiFillOperation): Promise<void> {
  operation.cancelled = true;
  operation.abortController.abort();
  activeAiReviews.delete(operation.fillSessionId);
  await clearAiFillAcrossFrames(
    prepared.request.tabId,
    operation.fillSessionId,
    [...operation.dispatchedFrameIds],
  );
  await clearAiScanAcrossFrames(
    prepared.request.tabId,
    prepared.scanId,
    prepared.frames.map((frame) => frame.frameId),
  );
}

async function finishAiOperation(prepared: PreparedAiFill, operation: AiFillOperation): Promise<void> {
  activeAiOperations.delete(operation.fillSessionId);
  if (preparedAiFills.get(prepared.scanId) === prepared) preparedAiFills.delete(prepared.scanId);
  await clearAiScanAcrossFrames(
    prepared.request.tabId,
    prepared.scanId,
    prepared.frames.map((frame) => frame.frameId),
  );
}

function isAllowedAiToken(token: string): boolean {
  return token.length <= 80 && !/(^|[._])ssn/i.test(token);
}

function controlLooksSensitive(control: ControlSummary): boolean {
  return [control.label, control.placeholder, control.name, control.id, control.selector]
    .some((value) => typeof value === "string" && /\bssn\b|social[ _-]*security/i.test(value));
}

function sameFillRequest(a: FillRequest, b: FillRequest): boolean {
  return a.tabId === b.tabId && a.providerId === b.providerId && a.caseId === b.caseId &&
    a.portalKey === b.portalKey && a.state === b.state && a.facilityId === b.facilityId;
}

function isExactCandidate(value: unknown): value is AiFillCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "confidence,selector,token") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.selector === "string" && typeof candidate.token === "string" &&
    typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence);
}

/** Prepare a value-free local-model prompt and retain the value-bearing fill
 * source only in this worker's memory until the final request arrives. */
export async function prepareAiFillPortal(
  request: FillRequest,
  guard: AiFillGuard,
): Promise<import("../shared/fill").AiFillPreparation> {
  const [maps, { profile }, viewPrefs] = await Promise.all([
    getPortalFieldMaps(request.portalKey),
    getProviderProfile(request.providerId, { state: request.state, facilityId: request.facilityId }),
    getViewPrefs().catch(() => null),
  ]);
  await guard.validate();
  const scanId = crypto.randomUUID();
  const scan = await scanUnmappedControlsAcrossFrames(
    request.tabId,
    scanId,
    maps.filter((map) => map.mapType === "web").map((map) => ({
      selector: map.selector,
      selectorFallbacks: map.selectorFallbacks ?? [],
      ...(map.learnedVia === "nano" ? { pageUrlScope: map.urlPattern ?? "" } : {}),
    })),
  );
  try {
    await guard.validate();
  } catch (error) {
    await clearAiScanAcrossFrames(request.tabId, scanId, scan.frames.map((frame) => frame.frameId));
    throw error;
  }

  const cleanControls = scan.controls.filter((control) => !controlLooksSensitive(control));
  const safeTokens = new Set<string>();
  for (const token of [
    ...(viewPrefs?.catalog.map((entry) => entry.key) ?? []),
    ...profile.tokens.map((entry) => entry.token),
    ...profile.unresolved.map((entry) => entry.token),
  ]) {
    if (isAllowedAiToken(token)) safeTokens.add(token);
  }
  // Nano processes a bounded 32-control batch. Remaining controls are reported
  // explicitly as manual review; they are never silently dropped.
  const controls = cleanControls.slice(0, 32);
  const unprocessedControls = scan.ambiguousSelectors.length + (scan.controls.length - controls.length);
  const prepared: PreparedAiFill = {
    request,
    guard,
    maps,
    profile,
    scanId,
    frames: scan.frames.map((frame) => ({
      ...frame,
      controls: frame.controls.filter((control) => controls.some((candidate) => candidate.selector === control.selector)),
    })),
    controls,
    tokenCatalog: [...safeTokens],
    unprocessedControls,
    createdAt: Date.now(),
  };
  preparedAiFills.set(scanId, prepared);
  while (preparedAiFills.size > 4) {
    const oldest = preparedAiFills.keys().next().value;
    if (oldest == null) break;
    const expired = preparedAiFills.get(oldest);
    preparedAiFills.delete(oldest);
    if (expired) void clearAiScanAcrossFrames(expired.request.tabId, expired.scanId, expired.frames.map((frame) => frame.frameId));
  }
  return { scanId, controls, tokenCatalog: prepared.tokenCatalog, unprocessedControls };
}

export async function invalidatePendingAiScans(tabId?: number): Promise<void> {
  for (const [scanId, prepared] of [...preparedAiFills]) {
    if (tabId != null && prepared.request.tabId !== tabId) continue;
    preparedAiFills.delete(scanId);
    if (prepared.operation) await cancelAiOperation(prepared, prepared.operation);
    else await clearAiScanAcrossFrames(prepared.request.tabId, scanId, prepared.frames.map((frame) => frame.frameId));
  }
}

export function readActiveAiReview(fillSessionId: string): {
  request: FillRequest;
  guard: AiFillGuard;
  review: AiFillReview;
} | null {
  return activeAiReviews.get(fillSessionId) ?? null;
}

export function removeActiveAiReview(fillSessionId: string): void {
  activeAiReviews.delete(fillSessionId);
}

export async function invalidateActiveAiReviews(tabId?: number): Promise<void> {
  for (const { prepared, operation } of [...activeAiOperations.values()]) {
    if (tabId != null && prepared.request.tabId !== tabId) continue;
    await cancelAiOperation(prepared, operation);
  }
  for (const [fillSessionId, active] of activeAiReviews) {
    if (tabId != null && active.request.tabId !== tabId) continue;
    activeAiReviews.delete(fillSessionId);
    await clearAiFillAcrossFrames(active.request.tabId, fillSessionId);
  }
}

export async function acceptActiveAiReview(
  fillSessionId: string,
  tabId: number,
): Promise<boolean> {
  const active = activeAiReviews.get(fillSessionId);
  if (!active || active.request.tabId !== tabId || active.review.writes.length === 0) return false;
  await active.guard.validate();
  await acceptAiFillAcrossFrames(tabId, fillSessionId);
  activeAiReviews.delete(fillSessionId);
  return true;
}

export async function clearAiReviewInTab(tabId: number, fillSessionId: string): Promise<number> {
  const cleared = await clearAiFillAcrossFrames(tabId, fillSessionId);
  activeAiReviews.delete(fillSessionId);
  return cleared;
}

export interface FillPortalOptions {
  scanId?: string;
  candidates?: AiFillCandidate[];
  aiStatus?: "unavailable" | "no-matches" | "error";
  orgId?: string | null;
}

export async function fillPortal(
  request: FillRequest,
  options: FillPortalOptions = {},
): Promise<FillSummary> {
  const startedAt = new Date().toISOString();
  // The attempt's idempotency id doubles as the fill_sessions row PK; the
  // panel passes it back as fill_session_id when the human marks the
  // submission, tying the business log to this machine log.
  const fillSessionId = crypto.randomUUID();
  let prepared: PreparedAiFill | null = null;
  let operation: AiFillOperation | null = null;
  if (options.scanId) {
    prepared = preparedAiFills.get(options.scanId) ?? null;
    if (!prepared || !sameFillRequest(prepared.request, request)) {
      if (prepared) await discardPreparedAiFill(options.scanId, prepared);
      throw new Error("The form changed during AI review. Run Fill again.");
    }
    if (Date.now() - prepared.createdAt > AI_PREPARED_MAX_AGE_MS) {
      await discardPreparedAiFill(options.scanId, prepared);
      throw new Error("The AI review expired. Run Fill again.");
    }
    const candidates = options.candidates ?? [];
    if (candidates.length > 32 || candidates.some((candidate) => !isExactCandidate(candidate))) {
      await discardPreparedAiFill(options.scanId, prepared);
      throw new Error("Invalid AI field suggestions. Run Fill again.");
    }
    const candidateSelectors = new Set<string>();
    const knownControls = new Set(prepared.controls.map((control) => control.selector));
    const knownTokens = new Set(prepared.tokenCatalog);
    for (const candidate of candidates) {
      if (
        candidateSelectors.has(candidate.selector) ||
        !knownControls.has(candidate.selector) ||
        !knownTokens.has(candidate.token) ||
        !isAllowedAiToken(candidate.token) ||
        candidate.confidence < AI_CONFIDENCE_THRESHOLD ||
        candidate.confidence > 1
      ) {
        await discardPreparedAiFill(options.scanId, prepared);
        throw new Error("Invalid AI field suggestions. Run Fill again.");
      }
      candidateSelectors.add(candidate.selector);
    }
    try {
      await prepared.guard.validate();
    } catch (error) {
      await discardPreparedAiFill(options.scanId, prepared);
      throw error;
    }
    if (prepared.operation) {
      throw new Error("This AI fill is already being applied.");
    }
    operation = {
      fillSessionId,
      cancelled: false,
      dispatchedFrameIds: new Set(),
      abortController: new AbortController(),
    };
    prepared.operation = operation;
    activeAiOperations.set(fillSessionId, { prepared, operation });
  } else if (options.candidates?.length) {
    throw new Error("AI suggestions have no matching form scan. Run Fill again.");
  }

  const resolvedData = prepared
    ? { maps: prepared.maps, profile: prepared.profile }
    : await (async () => {
        const [maps, { profile }] = await Promise.all([
          getPortalFieldMaps(request.portalKey),
          getProviderProfile(request.providerId, {
            state: request.state,
            facilityId: request.facilityId,
          }),
        ]);
        return { maps, profile };
      })();
  const { staticFills, manual } = planFill(resolvedData.maps, resolvedData.profile);

  const assertPreparedCurrent = async (): Promise<void> => {
    if (!prepared || !operation) return;
    if (operation.cancelled || preparedAiFills.get(prepared.scanId) !== prepared) {
      throw new Error("The form or selection changed during AI review. Run Fill again.");
    }
    await prepared.guard.validate();
    if (operation.cancelled || preparedAiFills.get(prepared.scanId) !== prepared) {
      throw new Error("The form or selection changed during AI review. Run Fill again.");
    }
  };

  // Resolve only catalog values already retained by the worker. The panel
  // sends selector/token/confidence triples, never provider values.
  const tokenValues = new Map(resolvedData.profile.tokens.map((entry) => [entry.token, entry.value]));
  const controlTypes = new Map((prepared?.controls ?? []).map((control) => [control.selector, control.controlType]));
  const aiInstructions: FillInstruction[] = [];
  for (const candidate of options.candidates ?? []) {
    const raw = tokenValues.get(candidate.token);
    if (raw == null || raw === "" || !["string", "number", "boolean"].includes(typeof raw)) continue;
    const type = controlTypes.get(candidate.selector);
    if (!type) continue;
    aiInstructions.push({
      mapId: `ai:${candidate.selector}`,
      label: candidate.selector,
      selector: candidate.selector,
      selectorFallbacks: [],
      fieldType: type === "select" ? "select" : type === "radio" ? "radio" : type === "checkbox" ? "checkbox" : type === "date" ? "date" : "text",
      value: String(raw),
      pageStep: null,
      kind: "ai",
      token: candidate.token,
      confidence: candidate.confidence,
    });
  }

  // Pre-flight ping: any frame answering is enough (Availity's form lives in
  // a child iframe). ensureContentScript already ran in the worker.
  try {
    await assertPreparedCurrent();
    const frames = await listTabFrames(request.tabId);
    await assertPreparedCurrent();
    let alive = false;
    for (const frame of frames) {
      try {
        await assertPreparedCurrent();
        const pong = (await sendToFrame(request.tabId, frame.frameId, {
          type: "PING",
        })) as { ok?: boolean } | undefined;
        await assertPreparedCurrent();
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
    if (prepared && operation) {
      await cancelAiOperation(prepared, operation);
      await finishAiOperation(prepared, operation);
    }
    throw new Error(
      "Could not reach the enrollment form - open the portal's enrollment page in the current tab and reload it.",
      { cause: error },
    );
  }

  let pageResultStatic: FillPageResult;
  try {
    await assertPreparedCurrent();
    pageResultStatic = await applyFillAcrossFrames(request.tabId, staticFills);
    await assertPreparedCurrent();
  } catch (error) {
    if (prepared && operation) {
      await cancelAiOperation(prepared, operation);
      await finishAiOperation(prepared, operation);
    }
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

  let aiStatus: AiFillReview["status"] | undefined = options.aiStatus ?? (prepared ? "ready" : undefined);
  let aiPageResult: FillPageResult = { filled: [], writes: [], skipped: [], pageFields: 0 };
  if (prepared) {
    try {
      await assertPreparedCurrent();
      const lifecycle: AiFillApplyLifecycle = {
        isCancelled: () => operation?.cancelled === true || preparedAiFills.get(prepared!.scanId) !== prepared,
        validate: () => prepared!.guard.validate(),
        onDispatch: (frameId) => operation?.dispatchedFrameIds.add(frameId),
      };
      aiPageResult = await applyAiFillAcrossBoundFrames(
        request.tabId,
        prepared.scanId,
        fillSessionId,
        prepared.frames,
        aiInstructions,
        lifecycle,
      );
      await assertPreparedCurrent();
      aiStatus = aiInstructions.length > 0 && aiPageResult.writes?.length
        ? "ready"
        : "no-matches";
    } catch {
      if (operation) await cancelAiOperation(prepared, operation);
      aiPageResult = { filled: [], writes: [], skipped: [], pageFields: 0 };
      aiStatus = "error";
    } finally {
      await clearAiScanAcrossFrames(request.tabId, prepared.scanId, prepared.frames.map((frame) => frame.frameId));
    }
  }

  const combinePageResult = (): FillPageResult => ({
    filled: [...pageResultStatic.filled, ...aiPageResult.filled],
    writes: [...(pageResultStatic.writes ?? []), ...(aiPageResult.writes ?? [])],
    skipped: [...pageResultStatic.skipped, ...aiPageResult.skipped],
    pageFields: pageResultStatic.pageFields,
  });
  let pageResult = combinePageResult();
  const completedAt = new Date().toISOString();

  // Log the attempt. A logging failure must not un-report a successful fill,
  // so it degrades to a warning in the summary instead of throwing.
  let eventRecorded = true;
  let eventError: string | null = null;
  try {
    await assertPreparedCurrent();
    await postFillEvent({
      id: fillSessionId,
      caseId: request.caseId,
      providerId: request.providerId,
      portalKey: request.portalKey,
      fillMode: "web",
      startedAt,
      completedAt,
      fieldsFilled: pageResult.writes?.length ?? pageResult.filled.length,
      // Preserve producer kinds (other_page). Content not-found historically
      // omitted kind — default those to "skipped" so the panel drift predicate
      // still matches. Never blanket-overwrite every skip to "skipped".
      fieldsSkipped: [
        ...pageResult.skipped.map((f) => ({ ...f, kind: f.kind ?? "skipped" })),
        ...manual.map((f) => ({ ...f, kind: f.kind ?? "manual" })),
      ],
    }, { signal: operation?.abortController.signal });
  } catch (error) {
    eventRecorded = false;
    // eventError is the COMPLETE warning line the panel shows verbatim. A 403
    // means the role can't write (billing is read-only) — retrying won't
    // help, so say what will.
    if (error instanceof ApiError && error.status === 403) {
      eventError =
        "Fill applied, but it couldn't be logged: your account is read-only in this organization. Ask an admin to upgrade your role.";
    } else {
      const detail = error instanceof Error ? error.message : "unknown error";
      eventError = `Fill applied, but it couldn't be logged to Minted Panel: ${detail}. Retry from the case record.`;
    }
  }

  if (prepared && operation) {
    try {
      await assertPreparedCurrent();
    } catch {
      await cancelAiOperation(prepared, operation);
    }
    if (operation.cancelled) {
      aiPageResult = { filled: [], writes: [], skipped: [], pageFields: 0 };
      aiStatus = "error";
      pageResult = combinePageResult();
    }
  }

  const staticFilled = pageResult.writes?.filter((write) => write.kind === "static").length ?? pageResult.filled.length;
  const aiFilled = pageResult.writes?.filter((write) => write.kind === "ai").length ?? 0;
  const reviewWrites = (pageResult.writes ?? [])
    .filter((write) => write.kind === "ai" && write.token && write.confidence != null)
    .map((write) => {
      const instruction = aiInstructions.find((candidate) => candidate.selector === write.selector);
      const sourceFrame = prepared?.frames.find((candidate) =>
        candidate.controls.some((control) => control.selector === write.selector),
      );
      const sourceUrl = write.pageUrl !== undefined
        ? write.pageUrl
        : sourceFrame?.url || (sourceFrame?.frameId === 0 ? prepared?.guard.tabUrl : "") || "";
      return {
        selector: write.selector,
        token: write.token!,
        confidence: write.confidence!,
        fieldType: instruction?.fieldType && instruction.fieldType !== "file"
          ? instruction.fieldType
          : "text",
        pageUrl: canonicalLearningPageUrl(sourceUrl),
      };
    });
  const aiReview: AiFillReview | null = !operation?.cancelled && (prepared || options.aiStatus)
    ? {
        scanId: prepared?.scanId ?? null,
        fillSessionId,
        status: aiStatus ?? "no-matches",
        writes: reviewWrites,
        unprocessedControls: prepared?.unprocessedControls ?? 0,
        accepted: false,
      }
    : null;
  if (prepared && operation && !operation.cancelled &&
    preparedAiFills.get(prepared.scanId) === prepared && reviewWrites.length > 0 && eventRecorded) {
    activeAiReviews.set(fillSessionId, {
      request,
      guard: prepared.guard,
      review: aiReview!,
    });
  }
  const summary: FillSummary = {
    filled: staticFilled + aiFilled,
    filledLabels: pageResult.filled,
    skipped: pageResult.skipped,
    manual,
    eventRecorded,
    eventError,
    // Only reference the session when the server actually stored it — the
    // touches route validates fill_session_id and 404s an unknown id.
    fillSessionId: eventRecorded ? fillSessionId : null,
    pageFields: pageResult.pageFields,
    staticFilled,
    aiFilled,
    writtenSelectors: [...new Set((pageResult.writes ?? []).map((write) => write.selector))],
    aiReview,
    orgId: prepared?.guard.orgId ?? options.orgId ?? null,
    facilityId: request.facilityId,
    state: request.state,
  };
  if (prepared && operation) await finishAiOperation(prepared, operation);
  return summary;
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
  const [maps, { profile }] = await Promise.all([
    getPortalFieldMaps(request.portalKey),
    getProviderProfile(request.providerId, {
      state: request.state ?? undefined,
      facilityId: request.facilityId,
    }),
  ]);
  const { staticFills, manual } = planFill(maps, profile);

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
    pageResult = await applyFillAcrossFrames(request.tabId, staticFills);
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

  // The machine log rides /api/shared-test-fills: is_test, NO case and NO
  // provider. That is what makes 5.2 true by construction rather than by
  // remembering not to call the case routes — there is no case id to send.
  // It also keeps these runs out of form-drift, which excludes test fills.
  let logError: string | null = null;
  let recordedId: string | null = null;
  try {
    recordedId = await postSharedTestFill({
      id: fillSessionId,
      portalKey: request.portalKey,
      fieldsFilled: pageResult.filled.length,
      fieldsSkipped: [
        ...pageResult.skipped,
        ...manual.map((f): ReportedField => ({ ...f, kind: "manual" })),
      ],
      startedAt,
      completedAt,
      orgId: request.orgId,
    });
  } catch (error) {
    // A logging failure must not un-report a fill that really happened.
    const detail = error instanceof Error ? error.message : "unknown error";
    logError = `Sandbox fill applied, but the test log could not be written: ${detail}`;
  }

  // The selectors we actually wrote — the exact set "Clear portal form"
  // resets, so it can never touch something the extension did not type.
  const filledLabelSet = new Set(pageResult.filled);
  const filledSelectors = staticFills
    .filter((i) => filledLabelSet.has(i.label))
    .map((i) => i.selector);

  return {
    filled: pageResult.filled.length,
    filledLabels: pageResult.filled,
    skipped: pageResult.skipped,
    manual,
    pageFields: pageResult.pageFields,
    filledSelectors,
    fillSessionId: recordedId,
    logError,
  };
}
