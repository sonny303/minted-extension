// Protocol-v2 exact Work owner/config/tab binding. The persisted record holds
// identifiers and a portal origin only; profile values and effective maps are
// fetched into worker memory immediately before each supported fill.
import { validateWorkContext, type ProviderProfileRequestOptions } from "./api";
import { isAllowedHandoffOrigin } from "../shared/handoff";
import {
  activeWorkTupleKey,
  canonicalizeWorkContextTuple,
  isActiveWorkExpired,
  isWorkContextTuple,
  isSafePortalFormUrl,
  parseSetActiveWork,
  parseWorkContextValidationResponse,
  resolveActiveWorkState,
  type ActiveWorkRecord,
  type ActiveWorkState,
  type CanonicalWorkContextTuple,
  type SetActiveWorkMessage,
  type WorkContextTuple,
  type WorkContextValidationResponse,
  type CaseWorkContextTuple,
  type ContractWorkContextTuple,
  tupleFromSetActiveWorkMessage,
  workFormUrlMatchesPage,
  workTuplesEqual,
} from "../shared/workContext";

export const ACTIVE_WORK_KEY = "minted.activeWork.v2";
export const ACTIVE_WORK_BLOCK_KEY = "minted.activeWork.v2.blocked";
export const ACTIVE_WORK_UPDATED = { type: "ACTIVE_WORK_UPDATED" } as const;
export const EXACT_WORK_TAB_CAPABILITY = "exact-work-tab-v2" as const;
const CREATED_TAB_COMMIT_TIMEOUT_MS = 10_000;
const CREATED_TAB_COMMIT_POLL_MS = 50;

interface NavigationMark {
  href: string | null;
  sequence: number;
}

interface CreatedTabNavigationMarks {
  before: NavigationMark | null;
  committed: NavigationMark | null;
}

type CreatedTabNavigation = CreatedTabNavigationMarks | null;

interface CreatedTabNavigationObserver {
  current(tabId: number): CreatedTabNavigation;
  dispose(): void;
}

class WorkTabBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkTabBindingError";
  }
}

export type ActiveWorkAck =
  | {
      ok: true;
      protocolVersion: 2;
      capability: typeof EXACT_WORK_TAB_CAPABILITY;
      launchReceiptId: string;
      tuple: CanonicalWorkContextTuple;
      tabId: number;
      portalUrl: string;
    }
  | {
      ok: false;
      code: "UPDATE_REQUIRED" | "INVALID_REQUEST" | "ORIGIN_REJECTED" | "VALIDATION_FAILED" | "CONTEXT_STALE" | "SUPERSEDED" | "TAB_BIND_FAILED";
    };

function isRecord(value: unknown): value is ActiveWorkRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ActiveWorkRecord>;
  return isWorkContextTuple(record.tuple) && Number.isSafeInteger(record.boundTabId) && typeof record.boundTabId === "number" && record.boundTabId > 0 &&
    typeof record.formOrigin === "string" && /^https:\/\//.test(record.formOrigin) &&
    typeof record.formPath === "string" && record.formPath.startsWith("/") && !/[?#]/.test(record.formPath) &&
    (record.caseType === null || record.caseType === "contract" || record.caseType === "enrollment" || record.caseType === "recredentialing") &&
    typeof record.createdAt === "string" && typeof record.lastActivityAt === "string";
}

function currentRecordMatches(value: unknown, expected: ActiveWorkRecord): value is ActiveWorkRecord {
  return isRecord(value) && value.boundTabId === expected.boundTabId &&
    activeWorkTupleKey(value.tuple) === activeWorkTupleKey(expected.tuple);
}

interface ActiveWorkBlock {
  orgId: string | null;
}

function isActiveWorkBlock(value: unknown): value is ActiveWorkBlock {
  return value != null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 && Object.hasOwn(value, "orgId") &&
    (typeof (value as { orgId?: unknown }).orgId === "string" || (value as { orgId?: unknown }).orgId === null);
}

let activeWorkEpoch = 0;
let pendingLaunch: AbortController | null = null;
let activeWorkMutationTail: Promise<void> = Promise.resolve();
let invalidateFillsForWorkSwitch: (() => Promise<void>) | null = null;
let commitValidatedWorkSelection: ((tuple: WorkContextTuple) => Promise<void>) | null = null;

export function registerWorkSwitchInvalidator(invalidator: () => Promise<void>): void {
  invalidateFillsForWorkSwitch = invalidator;
}

export function registerValidatedWorkSelectionCommitter(committer: (tuple: WorkContextTuple) => Promise<void>): void {
  commitValidatedWorkSelection = committer;
}

function serializeActiveWorkMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = activeWorkMutationTail.then(operation, operation);
  activeWorkMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

function invalidatePendingWork(): number {
  activeWorkEpoch += 1;
  pendingLaunch?.abort();
  pendingLaunch = null;
  return activeWorkEpoch;
}

function notifyPanel(): void {
  try {
    void chrome.runtime.sendMessage(ACTIVE_WORK_UPDATED).catch(() => {});
  } catch {
    // No open panel is normal.
  }
}

async function readStoredRecord(): Promise<ActiveWorkRecord | null> {
  const entry = await chrome.storage.session.get(ACTIVE_WORK_KEY);
  const value = entry[ACTIVE_WORK_KEY];
  return isRecord(value) ? value : null;
}

async function readWorkBlock(): Promise<ActiveWorkBlock | null> {
  const entry = await chrome.storage.session.get(ACTIVE_WORK_BLOCK_KEY);
  const value = entry[ACTIVE_WORK_BLOCK_KEY];
  return isActiveWorkBlock(value) ? value : null;
}

async function writeWorkBlock(block: ActiveWorkBlock): Promise<void> {
  await chrome.storage.session.set({ [ACTIVE_WORK_BLOCK_KEY]: block });
}

export async function readActiveWorkRecord(): Promise<ActiveWorkRecord | null> {
  await activeWorkMutationTail;
  return readStoredRecord();
}

async function removeRecordIfCurrent(receiptId?: string): Promise<boolean> {
  return serializeActiveWorkMutation(async () => {
    const record = await readStoredRecord();
    if (record == null || (receiptId != null && record.tuple.launchReceiptId !== receiptId)) return false;
    await chrome.storage.session.remove(ACTIVE_WORK_KEY);
    return true;
  });
}

export async function clearActiveWork(options: { allowLegacyFallback?: boolean } = {}): Promise<void> {
  const epoch = invalidatePendingWork();
  const changed = await serializeActiveWorkMutation(async () => {
    if (epoch !== activeWorkEpoch) return false;
    const record = await readStoredRecord();
    const block = await readWorkBlock();
    if (options.allowLegacyFallback === true) {
      await chrome.storage.session.remove(ACTIVE_WORK_BLOCK_KEY);
    } else {
      await writeWorkBlock({ orgId: record?.tuple.orgId ?? block?.orgId ?? null });
    }
    if (record != null) await chrome.storage.session.remove(ACTIVE_WORK_KEY);
    return record != null ||
      (options.allowLegacyFallback === true ? block != null : block == null);
  });
  await invalidateFillsForWorkSwitch?.();
  if (changed) notifyPanel();
}

/** A legacy SET_ACTIVE_CASE launch revokes Work-v2 state before replacing the
 * legacy context. This is a mode switch, not a fallback from v2 failure. */
export async function revokeActiveWorkForLegacyLaunch(): Promise<void> {
  await clearActiveWork({ allowLegacyFallback: true });
}

export async function getActiveWorkState(): Promise<ActiveWorkState> {
  const record = await readActiveWorkRecord();
  const blocked = await readWorkBlock();
  if (blocked != null) return { status: "blocked", orgId: blocked.orgId };
  return resolveActiveWorkState(record, Date.now());
}

function responseMatchesRequest(
  response: WorkContextValidationResponse,
  tuple: WorkContextTuple,
): boolean {
  return workTuplesEqual(
    { ...response.tuple, protocolVersion: 2 } as WorkContextTuple,
    tuple,
  ) &&
    response.mappingGeneration === tuple.mappingGeneration &&
    response.effectiveMappingFingerprint === tuple.effectiveMappingFingerprint &&
    (tuple.ownerKind === "contract" ? response.caseType === "contract" : response.caseType !== "contract");
}

function contextStillCurrent(
  epoch: number,
  expected: ActiveWorkRecord,
  current: ActiveWorkRecord | null,
): boolean {
  return epoch === activeWorkEpoch && current != null && currentRecordMatches(current, expected) &&
    !isActiveWorkExpired(current, Date.now());
}

function isTransientBlankUrl(value: string | undefined): boolean {
  return value == null || value === "" || value === "about:blank";
}

function isExactCanonicalUrl(value: string | undefined, canonicalHref: string): boolean {
  if (typeof value !== "string" || value === "") return false;
  try {
    return new URL(value).href === canonicalHref;
  } catch {
    return false;
  }
}

/** `tabs.Tab.url` and `pendingUrl` are hidden unless the extension has host
 * access to the page. The manifest already grants webNavigation, which exposes
 * the exact main-frame URL without broadening host permissions. */
async function getMainFrameUrl(tabId: number): Promise<string | undefined> {
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    return typeof frame?.url === "string" ? frame.url : undefined;
  } catch {
    throw new WorkTabBindingError("Chrome could not verify the portal tab's main-frame URL.");
  }
}

function createCreatedTabNavigationObserver(): CreatedTabNavigationObserver {
  const states = new Map<number, CreatedTabNavigationMarks & { sequence: number }>();
  const stateFor = (tabId: number) => {
    let state = states.get(tabId);
    if (!state) {
      state = { before: null, committed: null, sequence: 0 };
      states.set(tabId, state);
    }
    return state;
  };
  const normalizedHref = (value: string): string | null => {
    try {
      return new URL(value).href;
    } catch {
      return null;
    }
  };
  const beforeNavigate = (details: chrome.webNavigation.WebNavigationBaseCallbackDetails) => {
    if (details.frameId !== 0) return;
    const state = stateFor(details.tabId);
    state.before = { href: normalizedHref(details.url), sequence: ++state.sequence };
  };
  const committed = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
    if (details.frameId !== 0) return;
    const state = stateFor(details.tabId);
    state.committed = { href: normalizedHref(details.url), sequence: ++state.sequence };
  };
  chrome.webNavigation.onBeforeNavigate.addListener(beforeNavigate);
  chrome.webNavigation.onCommitted.addListener(committed);
  return {
    current: (tabId) => {
      const state = states.get(tabId);
      return state == null ? null : { before: state.before, committed: state.committed };
    },
    dispose: () => {
      chrome.webNavigation.onBeforeNavigate.removeListener(beforeNavigate);
      chrome.webNavigation.onCommitted.removeListener(committed);
    },
  };
}

async function getCreatedTabIfCurrent(
  tabId: number,
  expectedWindowId: number,
): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  let activeTabs: chrome.tabs.Tab[];
  try {
    [tab, activeTabs] = await Promise.all([
      chrome.tabs.get(tabId),
      chrome.tabs.query({ active: true, lastFocusedWindow: true }),
    ]);
  } catch {
    throw new WorkTabBindingError("The newly created portal tab closed before it was ready.");
  }
  if (
    tab.id !== tabId || tab.windowId !== expectedWindowId ||
    activeTabs[0]?.id !== tabId || activeTabs[0]?.windowId !== expectedWindowId
  ) {
    throw new WorkTabBindingError("The active tab or window changed before the portal tab was ready.");
  }
  return tab;
}

async function waitForCreatedTabCommit(
  tabId: number,
  expectedWindowId: number,
  canonicalHref: string,
  navigation: CreatedTabNavigationObserver,
  epoch: number,
): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + CREATED_TAB_COMMIT_TIMEOUT_MS;
  while (true) {
    if (epoch !== activeWorkEpoch) throw new Error("The Work launch was superseded.");
    const tab = await getCreatedTabIfCurrent(tabId, expectedWindowId);
    if (epoch !== activeWorkEpoch) throw new Error("The Work launch was superseded.");
    const frameUrl = await getMainFrameUrl(tabId);
    if (epoch !== activeWorkEpoch) throw new Error("The Work launch was superseded.");
    const observed = navigation.current(tabId);
    if (!isTransientBlankUrl(frameUrl) && !isExactCanonicalUrl(frameUrl, canonicalHref)) {
      throw new WorkTabBindingError("The new tab did not commit the validated portal form URL.");
    }
    if (observed?.before != null && !isExactCanonicalUrl(observed.before.href ?? undefined, canonicalHref)) {
      throw new WorkTabBindingError("The new tab began navigating away from the validated portal form URL.");
    }
    if (observed?.before != null && observed.committed != null &&
        observed.committed.sequence > observed.before.sequence &&
        isExactCanonicalUrl(observed.committed.href ?? undefined, canonicalHref) &&
        isExactCanonicalUrl(frameUrl, canonicalHref)) {
      return tab;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new WorkTabBindingError("The validated portal form URL did not commit before timeout.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(CREATED_TAB_COMMIT_POLL_MS, remaining)));
  }
}

async function assertCreatedTabCommittedAndCurrent(
  tabId: number,
  expectedWindowId: number,
  formOrigin: string,
  formPath: string,
  canonicalHref: string,
  navigation: CreatedTabNavigationObserver,
): Promise<chrome.tabs.Tab> {
  const tab = await getCreatedTabIfCurrent(tabId, expectedWindowId);
  const frameUrl = await getMainFrameUrl(tabId);
  const observed = navigation.current(tabId);
  if (!workFormUrlMatchesPage(frameUrl, formOrigin, formPath) ||
      !isExactCanonicalUrl(frameUrl, canonicalHref) ||
      observed?.before == null || observed.committed == null ||
      observed.committed.sequence <= observed.before.sequence ||
      !isExactCanonicalUrl(observed.before.href ?? undefined, canonicalHref) ||
      !isExactCanonicalUrl(observed.committed.href ?? undefined, canonicalHref)) {
    throw new WorkTabBindingError("The new tab left the validated portal form before Work was bound.");
  }
  return tab;
}

async function closeCreatedTabIfStillUnboundAtCanonicalUrl(
  tabId: number,
  expectedWindowId: number,
  canonicalHref: string,
  navigation: CreatedTabNavigationObserver,
): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.id !== tabId || tab.windowId !== expectedWindowId) return;
    const frameUrl = await getMainFrameUrl(tabId);
    const observed = navigation.current(tabId);
    const stillPending = isTransientBlankUrl(frameUrl) && observed?.before != null &&
      (observed.committed == null || observed.committed.sequence < observed.before.sequence) &&
      isExactCanonicalUrl(observed.before.href ?? undefined, canonicalHref);
    const stillCommitted = isExactCanonicalUrl(frameUrl, canonicalHref) && observed?.before != null &&
      observed.committed != null && observed.committed.sequence > observed.before.sequence &&
      isExactCanonicalUrl(observed.before.href ?? undefined, canonicalHref) &&
      isExactCanonicalUrl(observed.committed.href ?? undefined, canonicalHref);
    if (stillPending || stillCommitted) await chrome.tabs.remove(tabId);
  } catch {
    // Already gone or no longer our unbound portal tab.
  }
}

/** Process a typed external Work launch. A valid request immediately revokes
 * the prior Work receipt, online-validates the exact tuple, asks Chrome to
 * create the target tab, and binds only the returned tab id. */
export async function handleExternalSetActiveWork(
  message: unknown,
  senderOrigin: string | undefined,
  senderTabWindowId?: number,
): Promise<ActiveWorkAck> {
  if (!isAllowedHandoffOrigin(senderOrigin)) return { ok: false, code: "ORIGIN_REJECTED" };
  const parsed = parseSetActiveWork(message);
  if (!parsed.ok) return { ok: false, code: parsed.code };

  const epoch = invalidatePendingWork();
  const controller = new AbortController();
  pendingLaunch = controller;
  const requestedTuple = tupleFromSetActiveWorkMessage(parsed.message);
  let createdTabId: number | null = null;
  let targetOrigin: string | null = null;
  let targetPath: string | null = null;
  let canonicalHref: string | null = null;
  let createdWindowId: number | null = null;
  let navigation: CreatedTabNavigationObserver | null = null;
  let recordPersisted = false;
  let launchSucceeded = false;
  try {
    const revoked = await serializeActiveWorkMutation(async () => {
      if (epoch !== activeWorkEpoch) return false;
      await writeWorkBlock({ orgId: requestedTuple.orgId });
      const prior = await readStoredRecord();
      if (prior != null) await chrome.storage.session.remove(ACTIVE_WORK_KEY);
      return true;
    });
    if (!revoked) return { ok: false, code: "SUPERSEDED" };
    await invalidateFillsForWorkSwitch?.();
    if (epoch !== activeWorkEpoch) return { ok: false, code: "SUPERSEDED" };
    const tuple = requestedTuple;
    const validation = await validateWorkContext(tuple, { signal: controller.signal });
    if (epoch !== activeWorkEpoch) return { ok: false, code: "SUPERSEDED" };
    if (!responseMatchesRequest(validation, tuple) || !isSafePortalFormUrl(validation.formUrl)) {
      return { ok: false, code: "CONTEXT_STALE" };
    }
    if (new URL(parsed.message.portalUrl).href !== new URL(validation.formUrl).href) {
      return { ok: false, code: "CONTEXT_STALE" };
    }
    const didCommitSelection = await serializeActiveWorkMutation(async () => {
      if (epoch !== activeWorkEpoch) return false;
      await commitValidatedWorkSelection?.(tuple);
      return epoch === activeWorkEpoch;
    });
    if (!didCommitSelection || epoch !== activeWorkEpoch) return { ok: false, code: "SUPERSEDED" };
    const form = new URL(validation.formUrl);
    targetOrigin = form.origin;
    targetPath = form.pathname;
    canonicalHref = form.href;
    navigation = createCreatedTabNavigationObserver();
    const tab = await chrome.tabs.create({
      url: validation.formUrl,
      active: true,
      ...(Number.isInteger(senderTabWindowId) ? { windowId: senderTabWindowId } : {}),
    });
    if (!Number.isSafeInteger(tab.id) || typeof tab.id !== "number" || tab.id <= 0) {
      throw new WorkTabBindingError("Chrome did not return the newly created portal tab id.");
    }
    createdTabId = tab.id;
    createdWindowId = Number.isSafeInteger(senderTabWindowId) ? senderTabWindowId! : tab.windowId ?? null;
    if (!Number.isSafeInteger(createdWindowId) || createdWindowId == null || tab.windowId !== createdWindowId) {
      throw new WorkTabBindingError("Chrome created the portal tab in a different window.");
    }
    await waitForCreatedTabCommit(tab.id, createdWindowId, canonicalHref, navigation, epoch);
    if (epoch !== activeWorkEpoch) return { ok: false, code: "SUPERSEDED" };
    const now = new Date().toISOString();
    const record: ActiveWorkRecord = {
      tuple,
      boundTabId: tab.id,
      formOrigin: targetOrigin,
      formPath: targetPath,
      caseType: validation.caseType,
      createdAt: now,
      lastActivityAt: now,
    };
    const didPersist = await serializeActiveWorkMutation(async () => {
      if (epoch !== activeWorkEpoch) return false;
      await assertCreatedTabCommittedAndCurrent(tab.id!, createdWindowId!, targetOrigin!, targetPath!, canonicalHref!, navigation!);
      if (epoch !== activeWorkEpoch) return false;
      await chrome.storage.session.set({ [ACTIVE_WORK_KEY]: record });
      recordPersisted = true;
      if (epoch !== activeWorkEpoch) return false;
      await chrome.storage.session.remove(ACTIVE_WORK_BLOCK_KEY);
      return epoch === activeWorkEpoch;
    });
    if (!didPersist || epoch !== activeWorkEpoch) {
      if (!recordPersisted && canonicalHref != null) {
        await closeCreatedTabIfStillUnboundAtCanonicalUrl(tab.id, createdWindowId!, canonicalHref, navigation!);
      }
      await removeRecordIfCurrent(parsed.message.launchReceiptId);
      return { ok: false, code: "SUPERSEDED" };
    }
    try {
      await assertCreatedTabCommittedAndCurrent(tab.id, createdWindowId, targetOrigin, targetPath, canonicalHref!, navigation!);
    } catch (error) {
      if (epoch === activeWorkEpoch) await clearActiveWork();
      else await removeRecordIfCurrent(parsed.message.launchReceiptId);
      if (error instanceof WorkTabBindingError) return { ok: false, code: "TAB_BIND_FAILED" };
      throw error;
    }
    if (epoch !== activeWorkEpoch) {
      await removeRecordIfCurrent(parsed.message.launchReceiptId);
      return { ok: false, code: "SUPERSEDED" };
    }
    notifyPanel();
    launchSucceeded = true;
    return {
      ok: true,
      protocolVersion: 2,
      capability: EXACT_WORK_TAB_CAPABILITY,
      launchReceiptId: parsed.message.launchReceiptId,
      tuple: canonicalizeWorkContextTuple(tuple),
      tabId: tab.id,
      portalUrl: validation.formUrl,
    };
  } catch (error) {
    if (recordPersisted) {
      await removeRecordIfCurrent(parsed.message.launchReceiptId);
    } else if (createdTabId != null && canonicalHref != null) {
      if (createdWindowId != null && navigation != null) {
        await closeCreatedTabIfStillUnboundAtCanonicalUrl(createdTabId, createdWindowId, canonicalHref, navigation);
      }
    }
    if (epoch !== activeWorkEpoch || (error instanceof Error && error.name === "AbortError")) {
      return { ok: false, code: "SUPERSEDED" };
    }
    if (error instanceof WorkTabBindingError) return { ok: false, code: "TAB_BIND_FAILED" };
    return {
      ok: false,
      code: error instanceof Error && /Work context|mapping changed|organization changed/i.test(error.message)
        ? "CONTEXT_STALE"
        : "VALIDATION_FAILED",
    };
  } finally {
    navigation?.dispose();
    if (pendingLaunch === controller) pendingLaunch = null;
    // The prior receipt is revoked before validation. Publish the settled
    // state after a failed current launch so an open panel drops stale UI;
    // superseded launches leave notification to their newer successor.
    if (!launchSucceeded && epoch === activeWorkEpoch) notifyPanel();
  }
}

/** Return an active authorization only for its exact tab. Any mismatch is a
 * hard failure rather than a fallback to legacy portal-key reads. */
export async function requireActiveWorkForTab(tabId: number): Promise<ActiveWorkRecord | null> {
  if (pendingLaunch != null) {
    throw new Error("A Work context is being validated. Wait for the exact portal tab to open.");
  }
  if (await readWorkBlock() != null) {
    throw new Error("The prior exact Work context ended. Re-launch or make a manual selection before filling.");
  }
  const record = await readActiveWorkRecord();
  if (record == null) return null;
  if (isActiveWorkExpired(record, Date.now())) {
    await clearActiveWork();
    throw new Error("This Work context expired. Reopen the task from Minted Panel.");
  }
  if (record.boundTabId !== tabId) {
    await clearActiveWork();
    throw new Error("This Work context is bound to a different portal tab.");
  }
  try {
    await chrome.tabs.get(record.boundTabId);
  } catch {
    await clearActiveWork();
    throw new Error("The bound Work tab closed. Reopen the task from Minted Panel.");
  }
  if (!workFormUrlMatchesPage(await getMainFrameUrl(record.boundTabId), record.formOrigin, record.formPath)) {
    await clearActiveWork();
    throw new Error("The bound Work tab changed pages. Reopen the task from Minted Panel.");
  }
  await touchActiveWork(tabId);
  return record;
}

/** Revalidate at start and immediately before DOM writes. The return maps are
 * for this worker operation only and never enter chrome.storage.session. */
export async function revalidateActiveWork(
  expected: ActiveWorkRecord,
  epoch: number,
): Promise<WorkContextValidationResponse> {
  const current = await readActiveWorkRecord();
  if (!contextStillCurrent(epoch, expected, current)) {
    throw new Error("The Work context changed. Reopen the task from Minted Panel.");
  }
  const validation = await validateWorkContext(expected.tuple);
  if (!responseMatchesRequest(validation, expected.tuple)) {
    throw new Error("The Work context or portal mapping changed. Reopen the task from Minted Panel.");
  }
  const currentAfterValidation = await readActiveWorkRecord();
  if (!contextStillCurrent(epoch, expected, currentAfterValidation) ||
      !isSafePortalFormUrl(validation.formUrl) || new URL(validation.formUrl).origin !== expected.formOrigin ||
      new URL(validation.formUrl).pathname !== expected.formPath) {
    throw new Error("The Work context changed during validation. Reopen the task from Minted Panel.");
  }
  await chrome.tabs.get(expected.boundTabId);
  if (!workFormUrlMatchesPage(await getMainFrameUrl(expected.boundTabId), expected.formOrigin, expected.formPath)) {
    throw new Error("The bound Work tab changed pages. Reopen the task from Minted Panel.");
  }
  return validation;
}

export function currentActiveWorkEpoch(): number {
  return activeWorkEpoch;
}

export function profileOptionsForActiveWork(
  record: ActiveWorkRecord & { tuple: CaseWorkContextTuple },
): Extract<ProviderProfileRequestOptions, { contractContext?: undefined }>;
export function profileOptionsForActiveWork(
  record: ActiveWorkRecord & { tuple: ContractWorkContextTuple },
): Extract<ProviderProfileRequestOptions, { contractContext: object }>;
export function profileOptionsForActiveWork(record: ActiveWorkRecord): ProviderProfileRequestOptions;
export function profileOptionsForActiveWork(record: ActiveWorkRecord): ProviderProfileRequestOptions {
  const tuple = record.tuple;
  if (tuple.ownerKind === "case") {
    return {
      caseId: tuple.ownerId,
      facilityId: tuple.facilityId,
    };
  }
  return {
    contractContext: {
      contractId: tuple.ownerId,
      assignmentId: tuple.assignmentId,
      contextVersion: tuple.contextVersion,
      sopTemplateId: tuple.sopTemplateId,
      sopVersion: tuple.sopVersion,
      stepIdentity: tuple.stepIdentity,
    },
    ...(tuple.facilityId != null ? { facilityId: tuple.facilityId } : {}),
  };
}

export async function touchActiveWork(tabId: number): Promise<void> {
  await serializeActiveWorkMutation(async () => {
    const record = await readStoredRecord();
    if (record == null || record.boundTabId !== tabId || isActiveWorkExpired(record, Date.now())) return;
    await chrome.storage.session.set({
      [ACTIVE_WORK_KEY]: { ...record, lastActivityAt: new Date().toISOString() },
    });
  });
}

export async function onActiveWorkTabActivated(tabId: number): Promise<void> {
  const record = await readActiveWorkRecord();
  if (record == null) return;
  if (record.boundTabId !== tabId) {
    await clearActiveWork();
    return;
  }
  await touchActiveWork(tabId);
}

export async function onActiveWorkTabUpdated(tabId: number, url: string | undefined): Promise<void> {
  const record = await readActiveWorkRecord();
  if (record == null || record.boundTabId !== tabId || !url) return;
  try {
    if (!workFormUrlMatchesPage(url, record.formOrigin, record.formPath)) {
      await clearActiveWork();
      return;
    }
  } catch {
    await clearActiveWork();
    return;
  }
  await touchActiveWork(tabId);
}

export async function onActiveWorkTabRemoved(tabId: number): Promise<void> {
  const record = await readActiveWorkRecord();
  if (record?.boundTabId === tabId) await clearActiveWork();
}

/** The tab id is persisted, so worker restart revalidates that precise tab;
 * it never searches by URL or rebinds among equal-URL tabs. */
export async function reconcileActiveWorkTab(): Promise<void> {
  const blocked = await readWorkBlock();
  if (blocked != null) {
    await removeRecordIfCurrent();
    return;
  }
  const record = await readActiveWorkRecord();
  if (record == null) return;
  if (isActiveWorkExpired(record, Date.now())) {
    await clearActiveWork();
    return;
  }
  try {
    await chrome.tabs.get(record.boundTabId);
    if (!workFormUrlMatchesPage(await getMainFrameUrl(record.boundTabId), record.formOrigin, record.formPath)) await clearActiveWork();
  } catch {
    await clearActiveWork();
  }
}

function ignoreTabFailure(operation: Promise<unknown>): void {
  void operation.catch(() => {});
}

export function registerActiveWorkListeners(): void {
  chrome.tabs?.onActivated?.addListener((info) => ignoreTabFailure(onActiveWorkTabActivated(info.tabId)));
  const checkMainFrame = (details: chrome.webNavigation.WebNavigationBaseCallbackDetails) => {
    if (details.frameId === 0) ignoreTabFailure(onActiveWorkTabUpdated(details.tabId, details.url));
  };
  chrome.webNavigation?.onBeforeNavigate?.addListener(checkMainFrame);
  chrome.webNavigation?.onCommitted?.addListener(checkMainFrame);
  chrome.webNavigation?.onHistoryStateUpdated?.addListener(checkMainFrame);
  chrome.tabs?.onRemoved?.addListener((tabId) => ignoreTabFailure(onActiveWorkTabRemoved(tabId)));
  void reconcileActiveWorkTab().catch(() => {});
}

/** Narrow helper used by tests to verify a server response remains attached
 * to the exact owner/config revision captured at launch. */
export function workResponseMatchesTuple(value: unknown, tuple: SetActiveWorkMessage): boolean {
  const parsed = parseWorkContextValidationResponse(value);
  return parsed != null && responseMatchesRequest(parsed, tupleFromSetActiveWorkMessage(tuple));
}
