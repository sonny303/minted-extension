/** Strict protocol-v2 Work handoff and server-validation DTOs.
 * This module is pure so malformed or stale handoffs can be rejected before
 * any Chrome tab or storage side effect occurs. It carries identifiers only.
 */
import type { PortalFieldMap } from "./apiTypes";

export const SET_ACTIVE_WORK_PROTOCOL_VERSION = 2 as const;
export const ACTIVE_WORK_IDLE_MS = 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PORTAL_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const FINGERPRINT_RE = /^sha256:[a-f0-9]{64}$/;

export interface WorkContextCommonTuple {
  protocolVersion: typeof SET_ACTIVE_WORK_PROTOCOL_VERSION;
  launchReceiptId: string;
  ownerKind: "case" | "contract";
  ownerId: string;
  contextVersion: number;
  sopTemplateId: string;
  sopVersion: number;
  portalId: string;
  portalKey: string;
  mappingGeneration: number;
  effectiveMappingFingerprint: string;
  providerId: string;
  orgId: string;
  facilityId: string | null;
}

export interface CaseWorkContextTuple extends WorkContextCommonTuple {
  ownerKind: "case";
  taskId: string;
  stepId: string;
  stepIdentity: string;
}

export interface ContractWorkContextTuple extends WorkContextCommonTuple {
  ownerKind: "contract";
  assignmentId: string;
  taskIndex: number;
  stepIndex: number;
  stepIdentity: string;
}

export type WorkContextTuple = CaseWorkContextTuple | ContractWorkContextTuple;
export type CanonicalWorkContextTuple =
  | Omit<CaseWorkContextTuple, "protocolVersion">
  | Omit<ContractWorkContextTuple, "protocolVersion">;
export type SetActiveWorkMessage = WorkContextTuple & { type: "SET_ACTIVE_WORK"; portalUrl: string };

export interface WorkContextValidationResponse {
  tuple: CanonicalWorkContextTuple;
  caseType: "contract" | "enrollment" | "recredentialing" | null;
  formUrl: string;
  requiresExplicitSelection: boolean;
  mappingGeneration: number;
  effectiveMappingFingerprint: string;
  effectiveWebMaps: PortalFieldMap[];
}

export interface ActiveWorkRecord {
  /** The authorized owner/config tuple, never provider values or maps. */
  tuple: WorkContextTuple;
  boundTabId: number;
  /** Safe URL rule only; query/hash data and provider values are not stored. */
  formOrigin: string;
  formPath: string;
  caseType: WorkContextValidationResponse["caseType"];
  createdAt: string;
  lastActivityAt: string;
}

export type ActiveWorkState =
  | { status: "none" }
  | { status: "blocked"; orgId: string | null }
  | { status: "active"; record: ActiveWorkRecord }
  | { status: "expired"; record: ActiveWorkRecord };

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isBoundedText(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= max && value === value.trim();
}

function parseTuple(value: unknown, withType: boolean): WorkContextTuple | null {
  if (!isObject(value)) return null;
  const tuple = value;
  if (withType && tuple.type !== "SET_ACTIVE_WORK") return null;
  if (withType && !isSafePortalFormUrl(tuple.portalUrl)) return null;
  if (tuple.protocolVersion !== SET_ACTIVE_WORK_PROTOCOL_VERSION) return null;
  if (tuple.ownerKind !== "case" && tuple.ownerKind !== "contract") return null;
  if (
    !isUuid(tuple.launchReceiptId) || !isUuid(tuple.ownerId) ||
    !isPositiveInteger(tuple.contextVersion) || !isUuid(tuple.sopTemplateId) ||
    !isPositiveInteger(tuple.sopVersion) || !isUuid(tuple.portalId) ||
    typeof tuple.portalKey !== "string" || !PORTAL_KEY_RE.test(tuple.portalKey) ||
    !isPositiveInteger(tuple.mappingGeneration) ||
    typeof tuple.effectiveMappingFingerprint !== "string" || !FINGERPRINT_RE.test(tuple.effectiveMappingFingerprint) ||
    !isUuid(tuple.providerId) || !isUuid(tuple.orgId) || (tuple.facilityId !== null && !isUuid(tuple.facilityId))
  ) return null;

  const commonKeys = [
    ...(withType ? ["type", "portalUrl"] : []), "protocolVersion", "launchReceiptId", "ownerKind", "ownerId",
    "contextVersion", "sopTemplateId", "sopVersion", "portalId", "portalKey",
    "mappingGeneration", "effectiveMappingFingerprint", "providerId", "orgId", "facilityId",
  ];
  if (tuple.ownerKind === "case") {
    if (
      !hasExactKeys(tuple, [...commonKeys, "taskId", "stepId", "stepIdentity"]) ||
      !isUuid(tuple.taskId) || !isUuid(tuple.stepId) || !isBoundedText(tuple.stepIdentity, 512)
    ) return null;
    return {
      protocolVersion: SET_ACTIVE_WORK_PROTOCOL_VERSION,
      launchReceiptId: tuple.launchReceiptId,
      ownerKind: "case",
      ownerId: tuple.ownerId,
      contextVersion: tuple.contextVersion,
      sopTemplateId: tuple.sopTemplateId,
      sopVersion: tuple.sopVersion,
      portalId: tuple.portalId,
      portalKey: tuple.portalKey,
      mappingGeneration: tuple.mappingGeneration,
      effectiveMappingFingerprint: tuple.effectiveMappingFingerprint,
      providerId: tuple.providerId,
      orgId: tuple.orgId,
      facilityId: tuple.facilityId,
      taskId: tuple.taskId,
      stepId: tuple.stepId,
      stepIdentity: tuple.stepIdentity,
    };
  }
  if (
    !hasExactKeys(tuple, [...commonKeys, "assignmentId", "taskIndex", "stepIndex", "stepIdentity"]) ||
    !isUuid(tuple.assignmentId) || !Number.isSafeInteger(tuple.taskIndex) || typeof tuple.taskIndex !== "number" || tuple.taskIndex < 0 ||
    !Number.isSafeInteger(tuple.stepIndex) || typeof tuple.stepIndex !== "number" || tuple.stepIndex < 0 ||
    !isBoundedText(tuple.stepIdentity, 512)
  ) return null;
  return {
    protocolVersion: SET_ACTIVE_WORK_PROTOCOL_VERSION,
    launchReceiptId: tuple.launchReceiptId,
    ownerKind: "contract",
    ownerId: tuple.ownerId,
    contextVersion: tuple.contextVersion,
    sopTemplateId: tuple.sopTemplateId,
    sopVersion: tuple.sopVersion,
    portalId: tuple.portalId,
    portalKey: tuple.portalKey,
    mappingGeneration: tuple.mappingGeneration,
    effectiveMappingFingerprint: tuple.effectiveMappingFingerprint,
    providerId: tuple.providerId,
    orgId: tuple.orgId,
    facilityId: tuple.facilityId,
    assignmentId: tuple.assignmentId,
    taskIndex: tuple.taskIndex,
    stepIndex: tuple.stepIndex,
    stepIdentity: tuple.stepIdentity,
  };
}

export type SetActiveWorkParseResult =
  | { ok: true; message: SetActiveWorkMessage }
  | { ok: false; code: "UPDATE_REQUIRED" | "INVALID_REQUEST" };

export function parseSetActiveWork(value: unknown): SetActiveWorkParseResult {
  if (!isObject(value) || value.type !== "SET_ACTIVE_WORK") {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  if (value.protocolVersion !== SET_ACTIVE_WORK_PROTOCOL_VERSION) {
    return { ok: false, code: "UPDATE_REQUIRED" };
  }
  const tuple = parseTuple(value, true);
  return tuple == null
    ? { ok: false, code: "INVALID_REQUEST" }
    : { ok: true, message: { type: "SET_ACTIVE_WORK", ...tuple, portalUrl: value.portalUrl as string } };
}

export function isWorkContextTuple(value: unknown): value is WorkContextTuple {
  return parseTuple(value, false) != null;
}

/** Strictly validate the protocol-free tuple stored in reports and nested API
 * payloads. The live handoff carries protocolVersion; canonical receipts do
 * not. */
export function parseCanonicalWorkContextTuple(value: unknown): CanonicalWorkContextTuple | null {
  if (!isObject(value) || Object.prototype.hasOwnProperty.call(value, "protocolVersion")) return null;
  const parsed = parseTuple({ ...value, protocolVersion: SET_ACTIVE_WORK_PROTOCOL_VERSION }, false);
  return parsed == null ? null : canonicalizeWorkContextTuple(parsed);
}

export function isCanonicalWorkContextTuple(value: unknown): value is CanonicalWorkContextTuple {
  return parseCanonicalWorkContextTuple(value) != null;
}

export function isSafePortalFormUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname !== "" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

/** Same-origin/path-prefix rule used for the bound Work tab. Query and hash
 * are intentionally ignored because portal forms often carry transient state. */
export function workFormUrlMatchesPage(
  pageUrl: string | undefined | null,
  formOrigin: string,
  formPath: string,
): boolean {
  if (typeof pageUrl !== "string" || !formPath.startsWith("/") || /[?#]/.test(formPath)) return false;
  try {
    const page = new URL(pageUrl);
    if (page.protocol !== "https:" || page.origin !== formOrigin) return false;
    if (formPath.endsWith("/")) return page.pathname.startsWith(formPath);
    return page.pathname === formPath || page.pathname.startsWith(`${formPath}/`);
  } catch {
    return false;
  }
}

function isWebMapForKey(value: unknown, portalKey: string): value is PortalFieldMap {
  if (!isObject(value) || value.portalKey !== portalKey || value.mapType !== "web") return false;
  return typeof value.id === "string" && UUID_RE.test(value.id) && typeof value.selector === "string" &&
    ["token", "manual", "manual_partial", "hardcoded"].includes(String(value.source)) &&
    ["proposed", "approved", "retired"].includes(String(value.status));
}

export function parseWorkContextValidationResponse(value: unknown): WorkContextValidationResponse | null {
  if (!isObject(value)) return null;
  if (!isObject(value.tuple) || Object.hasOwn(value.tuple, "protocolVersion")) return null;
  const tuple = parseTuple({ ...value.tuple, protocolVersion: SET_ACTIVE_WORK_PROTOCOL_VERSION }, false);
  if (
    tuple == null ||
    !(value.caseType === null || value.caseType === "contract" || value.caseType === "enrollment" || value.caseType === "recredentialing") ||
    !isSafePortalFormUrl(value.formUrl) || typeof value.requiresExplicitSelection !== "boolean" ||
    !isPositiveInteger(value.mappingGeneration) ||
    typeof value.effectiveMappingFingerprint !== "string" || !FINGERPRINT_RE.test(value.effectiveMappingFingerprint) ||
    !Array.isArray(value.effectiveWebMaps) || value.effectiveWebMaps.length > 1000 ||
    !value.effectiveWebMaps.every((map) => isWebMapForKey(map, tuple.portalKey))
  ) return null;
  return {
    tuple: canonicalizeWorkContextTuple(tuple),
    caseType: value.caseType,
    formUrl: value.formUrl,
    requiresExplicitSelection: value.requiresExplicitSelection,
    mappingGeneration: value.mappingGeneration,
    effectiveMappingFingerprint: value.effectiveMappingFingerprint,
    effectiveWebMaps: value.effectiveWebMaps,
  };
}

export function workTuplesEqual(left: WorkContextTuple, right: WorkContextTuple): boolean {
  return stableTupleKey(left, "protocolVersion") === stableTupleKey(right, "protocolVersion");
}

export function canonicalizeWorkContextTuple(tuple: WorkContextTuple): CanonicalWorkContextTuple {
  const canonical: Record<string, unknown> = { ...tuple };
  delete canonical.protocolVersion;
  return canonical as unknown as CanonicalWorkContextTuple;
}

export function tupleFromSetActiveWorkMessage(message: SetActiveWorkMessage): WorkContextTuple {
  const tuple: Record<string, unknown> = { ...message };
  delete tuple.type;
  delete tuple.portalUrl;
  return tuple as unknown as WorkContextTuple;
}

export function activeWorkTupleKey(tuple: WorkContextTuple): string {
  return stableTupleKey(tuple);
}

function stableTupleKey(tuple: object, omitKey?: string): string {
  const fields = tuple as Record<string, unknown>;
  return JSON.stringify(Object.keys(fields).filter((key) => key !== omitKey).sort().map((key) => [key, fields[key]]));
}

export function isActiveWorkExpired(record: ActiveWorkRecord, nowMs: number): boolean {
  const last = Date.parse(record.lastActivityAt);
  return !Number.isFinite(last) || nowMs - last > ACTIVE_WORK_IDLE_MS;
}

export function resolveActiveWorkState(record: ActiveWorkRecord | null, nowMs: number): ActiveWorkState {
  if (record == null) return { status: "none" };
  return isActiveWorkExpired(record, nowMs) ? { status: "expired", record } : { status: "active", record };
}
