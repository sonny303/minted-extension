// Worker-owned active-case state: handoff receipt, tab binding, expiry.
// Pure rules live in src/shared/handoff.ts; this module handles Chrome storage.
//
// The stored record holds identifiers and URL only — no profile or token values.
import { PANEL_MODE_KEY } from "./mode";
import {
  activeCaseReceiptKey,
  isAllowedHandoffOrigin,
  isPortalOriginUrl,
  parseSetActiveCase,
  resolveActiveCaseState,
  type ActiveCaseRecord,
  type ActiveCaseState,
} from "../shared/handoff";

export const ACTIVE_CASE_KEY = "minted.activeCase";
export const APPLIED_HANDOFF_KEY = "minted.appliedHandoffReceipt";

export interface AppliedHandoffReceipt {
  receiptKey: string;
  providerId: string;
  caseId: string;
  facilityId: string | null;
}

// Every read-modify-write of the one active-case record shares this queue.
// MV3 events can overlap while awaiting storage; serializing them preserves
// invocation order so a stale receipt/tab event cannot overwrite a newer
// handoff or revive a context cleared by logout/org/account change.
let activeCaseMutationTail: Promise<void> = Promise.resolve();

function mutateActiveCase<T>(operation: () => Promise<T>): Promise<T> {
  const result = activeCaseMutationTail.then(operation, operation);
  activeCaseMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isRecord(value: unknown): value is ActiveCaseRecord {
  const r = value as ActiveCaseRecord | null;
  return (
    r != null &&
    typeof r === "object" &&
    (r.receiptId == null || typeof r.receiptId === "string") &&
    typeof r.caseId === "string" &&
    typeof r.providerId === "string" &&
    (r.source === "handoff" || r.source === "panel") &&
    typeof r.createdAt === "string" &&
    typeof r.lastActivityAt === "string"
  );
}

async function readStoredActiveCaseRecord(): Promise<ActiveCaseRecord | null> {
  const entry = await chrome.storage.session.get(ACTIVE_CASE_KEY);
  const value = entry[ACTIVE_CASE_KEY];
  return isRecord(value) ? value : null;
}

export async function readActiveCaseRecord(): Promise<ActiveCaseRecord | null> {
  await activeCaseMutationTail;
  return readStoredActiveCaseRecord();
}

async function writeActiveCaseRecord(record: ActiveCaseRecord | null): Promise<void> {
  if (record == null) {
    await chrome.storage.session.remove([ACTIVE_CASE_KEY, APPLIED_HANDOFF_KEY]);
  } else {
    await chrome.storage.session.set({ [ACTIVE_CASE_KEY]: record });
  }
}

export async function getActiveCaseState(): Promise<ActiveCaseState> {
  return resolveActiveCaseState(await readActiveCaseRecord(), Date.now());
}

export async function clearActiveCase(): Promise<void> {
  await clearActiveCaseForOrgChange(null);
}

/** Clear only the handoff the panel actually evaluated. A newer receipt that
 * arrives while an authenticated rejection is being decided must survive. */
export async function clearActiveCaseIfCurrent(receiptKey: string): Promise<boolean> {
  const changed = await mutateActiveCase(async () => {
    const record = await readStoredActiveCaseRecord();
    if (
      record == null ||
      record.source !== "handoff" ||
      activeCaseReceiptKey(record) !== receiptKey
    ) {
      return false;
    }
    await writeActiveCaseRecord(null);
    return true;
  });
  if (changed) notifyPanel();
  return changed;
}

/** Run an internal selection commit only while this exact received handoff is
 * still current. The commit shares the active-case mutation queue, so a newer
 * receipt, logout, org switch, or account clear wins according to invocation
 * order and an old panel completion cannot write afterward. */
export async function commitForCurrentHandoff(
  receiptKey: string,
  selection: {
    providerId: string;
    caseId: string;
    facilityId: string | null;
  },
  commit: () => Promise<void>,
): Promise<boolean> {
  return mutateCurrentHandoff(receiptKey, async (record) => {
    if (
      record.providerId !== selection.providerId ||
      record.caseId !== selection.caseId ||
      (record.facilityId != null && record.facilityId !== selection.facilityId)
    ) {
      return false;
    }
    await commit();
    return true;
  });
}

/** Serialize an extension-internal mutation against one exact active handoff.
 * The callback can add operation-specific identity checks before it writes. */
export async function mutateCurrentHandoff(
  receiptKey: string,
  mutation: (record: ActiveCaseRecord) => Promise<boolean>,
): Promise<boolean> {
  return mutateActiveCase(async () => {
    const record = await readStoredActiveCaseRecord();
    if (
      record == null ||
      record.source !== "handoff" ||
      activeCaseReceiptKey(record) !== receiptKey ||
      resolveActiveCaseState(record, Date.now()).status !== "active"
    ) {
      return false;
    }
    return mutation(record);
  });
}

/** Clear org-scoped context while allowing an explicit switch to the org named
 * by the pending handoff to preserve that exact record. The decision and
 * mutation share the active-case queue, so a concurrent newer receipt is
 * evaluated rather than removed by a stale snapshot. */
export async function clearActiveCaseForOrgChange(
  preserveHandoffOrgId: string | null,
): Promise<void> {
  const changed = await mutateActiveCase(async () => {
    const record = await readStoredActiveCaseRecord();
    if (
      preserveHandoffOrgId != null &&
      record?.source === "handoff" &&
      record.orgId === preserveHandoffOrgId
    ) {
      return false;
    }
    if (record == null) return false;
    await writeActiveCaseRecord(null);
    return true;
  });
  if (changed) notifyPanel();
}

// Tell an open panel the context changed under it (handoff arrived, second
// launch replaced it, bound tab closed). Best-effort: no receiver = no panel
// open, which is fine — the panel reads GET_ACTIVE_CASE when it opens.
function notifyPanel(): void {
  try {
    void chrome.runtime.sendMessage({ type: "ACTIVE_CASE_UPDATED" }).catch(() => {});
  } catch {
    // messaging unavailable (e.g. during teardown) — nothing to notify
  }
}

/** Record an IN-PANEL case selection (search result, active-cases click, NBA
 * handback, manual picker) — TE-17: the same active-case state as a handoff,
 * with the same expiry semantics. No portal URL yet; a fill binds the tab. */
export async function enterActiveCase(input: {
  caseId: string;
  providerId: string;
  orgId: string | null;
}): Promise<void> {
  await mutateActiveCase(async () => {
    const now = new Date().toISOString();
    await chrome.storage.session.set({
      [ACTIVE_CASE_KEY]: {
        caseId: input.caseId,
        providerId: input.providerId,
        orgId: input.orgId,
        portalUrl: null,
        // An in-panel selection has no launched portal and no case location: the
        // panel already knows both from its own selection state.
        portalKey: null,
        facilityId: null,
        source: "panel",
        boundTabId: null,
        tabClosedAt: null,
        createdAt: now,
        lastActivityAt: now,
      } satisfies ActiveCaseRecord,
      [APPLIED_HANDOFF_KEY]: null,
    });
  });
}

function isAppliedHandoffReceipt(value: unknown): value is AppliedHandoffReceipt {
  const receipt = value as AppliedHandoffReceipt | null;
  return (
    receipt != null &&
    typeof receipt === "object" &&
    typeof receipt.receiptKey === "string" &&
    typeof receipt.providerId === "string" &&
    typeof receipt.caseId === "string" &&
    (receipt.facilityId == null || typeof receipt.facilityId === "string")
  );
}

/** Worker authority for Fill. A handoff can fill only after its exact
 * receipt-pinned selection was committed, and only with that committed tuple. */
export async function assertFillMatchesActiveCase(input: {
  providerId: string;
  caseId: string;
  facilityId: string | null;
}): Promise<void> {
  await mutateActiveCase(async () => {
    const entry = await chrome.storage.session.get([
      ACTIVE_CASE_KEY,
      APPLIED_HANDOFF_KEY,
    ]);
    const record = isRecord(entry[ACTIVE_CASE_KEY])
      ? entry[ACTIVE_CASE_KEY]
      : null;
    if (record == null) return;
    if (
      record.caseId === input.caseId &&
      resolveActiveCaseState(record, Date.now()).status === "expired"
    ) {
      throw new Error(
        "This case's context expired - re-launch it from Minted Panel or re-select the case, then fill again.",
      );
    }
    if (record.source !== "handoff") return;

    const applied = entry[APPLIED_HANDOFF_KEY];
    if (
      !isAppliedHandoffReceipt(applied) ||
      applied.receiptKey !== activeCaseReceiptKey(record) ||
      applied.providerId !== record.providerId ||
      applied.caseId !== record.caseId ||
      (record.facilityId != null && applied.facilityId !== record.facilityId) ||
      applied.providerId !== input.providerId ||
      applied.caseId !== input.caseId ||
      applied.facilityId !== input.facilityId
    ) {
      throw new Error(
        "The active handoff changed - wait for the current case to finish loading, then fill again.",
      );
    }
  });
}

/** Worker authority for case writes that do not carry provider/facility. A
 * received handoff cannot write until its exact selection commit is current;
 * normal in-panel selections retain the existing manual workflow. */
export async function assertCaseWriteMatchesActiveCase(caseId: string): Promise<void> {
  await mutateActiveCase(async () => {
    const entry = await chrome.storage.session.get([
      ACTIVE_CASE_KEY,
      APPLIED_HANDOFF_KEY,
    ]);
    const record = isRecord(entry[ACTIVE_CASE_KEY])
      ? entry[ACTIVE_CASE_KEY]
      : null;
    if (record == null || record.source !== "handoff") return;

    const applied = entry[APPLIED_HANDOFF_KEY];
    if (
      resolveActiveCaseState(record, Date.now()).status !== "active" ||
      !isAppliedHandoffReceipt(applied) ||
      applied.receiptKey !== activeCaseReceiptKey(record) ||
      applied.providerId !== record.providerId ||
      applied.caseId !== record.caseId ||
      applied.caseId !== caseId ||
      (record.facilityId != null && applied.facilityId !== record.facilityId)
    ) {
      throw new Error(
        "The active handoff is not applied - re-select the case manually or wait for the handoff to finish.",
      );
    }
  });
}

/** Mark user activity on the active case so the 60-minute idle clock resets.
 * An already-expired record is never resurrected. */
export async function touchActiveCaseActivity(): Promise<void> {
  await mutateActiveCase(async () => {
    const record = await readStoredActiveCaseRecord();
    if (record == null) return;
    if (resolveActiveCaseState(record, Date.now()).status !== "active") return;
    await writeActiveCaseRecord({ ...record, lastActivityAt: new Date().toISOString() });
  });
}

/** A fill ran against `tabId` for `caseId`: bind the tab to the record (an
 * in-panel selection has no portal URL, so the fill IS its binding moment). */
export async function bindFillTab(caseId: string, tabId: number): Promise<void> {
  await mutateActiveCase(async () => {
    const record = await readStoredActiveCaseRecord();
    if (record == null || record.caseId !== caseId) return;
    if (resolveActiveCaseState(record, Date.now()).status !== "active") return;
    await writeActiveCaseRecord({
      ...record,
      boundTabId: tabId,
      lastActivityAt: new Date().toISOString(),
    });
  });
}

/** The SET_ACTIVE_CASE receipt. Validates origin + shape, stores the new
 * record — LAST LAUNCH WINS, a pending context is replaced never stacked —
 * and best-effort opens the side panel. Returns whether the message was
 * accepted (the webapp's sendMessage response). */
export async function handleExternalMessage(
  message: unknown,
  senderOrigin: string | undefined,
  senderTabId?: number,
  senderTabWindowId?: number,
): Promise<{ ok: boolean }> {
  if (!isAllowedHandoffOrigin(senderOrigin)) return { ok: false };
  const parsed = parseSetActiveCase(message);
  if (parsed == null) return { ok: false };
  const receiptId = crypto.randomUUID();
  const stored = await mutateActiveCase(async () => {
    const now = new Date().toISOString();
    try {
      const record: ActiveCaseRecord = {
        receiptId,
        caseId: parsed.caseId,
        providerId: parsed.providerId,
        orgId: parsed.orgId,
        portalUrl: parsed.portalUrl,
        // S3.5: carried through when the webapp sent them; null otherwise.
        portalKey: parsed.portalKey ?? null,
        facilityId: parsed.facilityId ?? null,
        source: "handoff",
        boundTabId: null,
        tabClosedAt: null,
        createdAt: now,
        lastActivityAt: now,
      };
      // Receipt truth is one atomic storage operation: the record and case
      // mode either both persist or neither replaces the prior valid state.
      await chrome.storage.session.set({
        [ACTIVE_CASE_KEY]: record,
        [PANEL_MODE_KEY]: "case",
        [APPLIED_HANDOFF_KEY]: null,
      });
      return true;
    } catch {
      return false;
    }
  });
  if (!stored) return { ok: false };
  notifyPanel();
  if (senderTabWindowId != null) {
    void reconcileFreshPortalTab(
      receiptId,
      parsed.portalUrl,
      senderTabWindowId,
      senderTabId,
    ).catch(() => {});
  }
  // Best-effort: open the side panel on the sender's window so the handoff
  // lands in front of the user. Requires a user gesture — the webapp's click
  // usually carries one — and quietly does nothing when it can't.
  try {
    if (senderTabWindowId != null) {
      const opening = chrome.sidePanel?.open({ windowId: senderTabWindowId });
      if (opening != null) void opening.catch(() => {});
    }
  } catch {
    // no gesture / no sidePanel API — the toolbar icon still opens the panel
  }
  return { ok: true };
}

async function reconcileFreshPortalTab(
  receiptKey: string,
  portalUrl: string,
  senderWindowId: number,
  senderTabId: number | undefined,
): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    // window.open commonly completes before external-message dispatch. The
    // active tab in the sender window is the only safe fresh-receipt recovery:
    // exclude the sending web tab and never infer an older background match.
    tabs = await chrome.tabs.query({ windowId: senderWindowId, active: true });
  } catch {
    return;
  }
  const matches = tabs.filter(
    (tab): tab is chrome.tabs.Tab & { id: number } =>
      tab.id != null &&
      tab.id !== senderTabId &&
      isPortalOriginUrl(portalUrl, tab.url),
  );
  if (matches.length !== 1) return;
  const matchedTab = matches[0];
  if (matchedTab == null) return;
  await mutateCurrentHandoff(receiptKey, async (record) => {
    if (record.boundTabId != null) return false;
    await writeActiveCaseRecord({
      ...record,
      boundTabId: matchedTab.id,
      lastActivityAt: new Date().toISOString(),
    });
    return true;
  });
}

/** TE-1: associate the NEXT tab that lands on the handed-off portal's origin.
 * Called from tabs.onUpdated; binds once and counts as activity. */
export async function maybeBindPortalTab(tabId: number, url: string | undefined): Promise<void> {
  await mutateActiveCase(async () => {
    const record = await readStoredActiveCaseRecord();
    if (record == null || record.source !== "handoff" || record.boundTabId != null) return;
    if (resolveActiveCaseState(record, Date.now()).status !== "active") return;
    if (!isPortalOriginUrl(record.portalUrl, url)) return;
    await writeActiveCaseRecord({
      ...record,
      boundTabId: tabId,
      lastActivityAt: new Date().toISOString(),
    });
  });
}

/** Recover an unbound handoff after an MV3 worker restart. A single existing
 * tab on the handed-off portal origin is unambiguous; several matching tabs
 * remain intentionally unresolved because the web wire carries no tab id. */
export async function reconcilePersistedPortalTab(): Promise<void> {
  await mutateActiveCase(async () => {
    const record = await readStoredActiveCaseRecord();
    if (record == null || record.source !== "handoff" || record.boundTabId != null) return;
    if (resolveActiveCaseState(record, Date.now()).status !== "active") return;

    let tabs: chrome.tabs.Tab[];
    try {
      tabs = await chrome.tabs.query({});
    } catch {
      return;
    }
    const matches = tabs.filter(
      (tab): tab is chrome.tabs.Tab & { id: number } =>
        tab.id != null && isPortalOriginUrl(record.portalUrl, tab.url),
    );
    const matchedTab = matches.length === 1 ? matches[0] : undefined;
    if (matchedTab == null) return;
    await writeActiveCaseRecord({
      ...record,
      boundTabId: matchedTab.id,
      lastActivityAt: new Date().toISOString(),
    });
  });
}

/** Bound-tab activity (switching to it / navigating it) resets the idle
 * clock; closing it hard-expires the context (TE-1). */
export async function onTabActivity(tabId: number): Promise<void> {
  await mutateActiveCase(async () => {
    const record = await readStoredActiveCaseRecord();
    if (record == null || record.boundTabId !== tabId) return;
    if (resolveActiveCaseState(record, Date.now()).status !== "active") return;
    await writeActiveCaseRecord({ ...record, lastActivityAt: new Date().toISOString() });
  });
}

export async function onTabRemoved(tabId: number): Promise<void> {
  const changed = await mutateActiveCase(async () => {
    const record = await readStoredActiveCaseRecord();
    if (record == null || record.boundTabId !== tabId || record.tabClosedAt != null) return false;
    await writeActiveCaseRecord({ ...record, tabClosedAt: new Date().toISOString() });
    return true;
  });
  if (changed) notifyPanel();
}

/** Wire the Chrome listeners. Top-level from the worker entry so every worker
 * restart re-registers them. */
export function registerActiveCaseListeners(): void {
  chrome.runtime.onMessageExternal?.addListener(
    (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
      let replied = false;
      const replyOnce = (response: { ok: boolean }): void => {
        if (replied) return;
        replied = true;
        try {
          sendResponse(response);
        } catch {
          // The page closed its reply channel. The receipt result is already
          // final; retrying could double-deliver to a reused callback.
        }
      };
      void handleExternalMessage(
        message,
        sender.origin,
        sender.tab?.id,
        sender.tab?.windowId,
      ).then(
        replyOnce,
        () => replyOnce({ ok: false }),
      );
      return true; // keep the channel open for the async response
    },
  );
  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.url != null) {
      void maybeBindPortalTab(tabId, changeInfo.url).then(() => onTabActivity(tabId));
    }
  });
  chrome.tabs?.onActivated?.addListener((info) => void onTabActivity(info.tabId));
  chrome.tabs?.onRemoved?.addListener((tabId) => void onTabRemoved(tabId));
  void reconcilePersistedPortalTab().catch(() => {});
}
