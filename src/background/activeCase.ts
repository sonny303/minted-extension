// E4.3 F4.3.1 / TE-1 — the worker-owned active-case context: receipt of the
// webapp's SET_ACTIVE_CASE handoff, the one stored record (last launch wins),
// portal-tab binding, and the tab-close / 60-minute-idle expiry. All the pure
// rules live in src/shared/handoff.ts; this module is the Chrome glue.
//
// The record carries IDENTIFIERS + URL only (parseSetActiveCase drops
// everything else), so chrome.storage.session stays PHI-free. Profile/token
// values only ever flow through the audited /api reads, never through the
// external message.
import {
  isAllowedHandoffOrigin,
  isPortalOriginUrl,
  parseSetActiveCase,
  resolveActiveCaseState,
  type ActiveCaseRecord,
  type ActiveCaseState,
} from "../shared/handoff";

export const ACTIVE_CASE_KEY = "minted.activeCase";

function isRecord(value: unknown): value is ActiveCaseRecord {
  const r = value as ActiveCaseRecord | null;
  return (
    r != null &&
    typeof r === "object" &&
    typeof r.caseId === "string" &&
    typeof r.providerId === "string" &&
    (r.source === "handoff" || r.source === "panel") &&
    typeof r.createdAt === "string" &&
    typeof r.lastActivityAt === "string"
  );
}

export async function readActiveCaseRecord(): Promise<ActiveCaseRecord | null> {
  const entry = await chrome.storage.session.get(ACTIVE_CASE_KEY);
  const value = entry[ACTIVE_CASE_KEY];
  return isRecord(value) ? value : null;
}

async function writeActiveCaseRecord(record: ActiveCaseRecord | null): Promise<void> {
  if (record == null) {
    await chrome.storage.session.remove(ACTIVE_CASE_KEY);
  } else {
    await chrome.storage.session.set({ [ACTIVE_CASE_KEY]: record });
  }
}

export async function getActiveCaseState(): Promise<ActiveCaseState> {
  return resolveActiveCaseState(await readActiveCaseRecord(), Date.now());
}

export async function clearActiveCase(): Promise<void> {
  await writeActiveCaseRecord(null);
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
  const now = new Date().toISOString();
  await writeActiveCaseRecord({
    caseId: input.caseId,
    providerId: input.providerId,
    orgId: input.orgId,
    portalUrl: null,
    source: "panel",
    boundTabId: null,
    tabClosedAt: null,
    createdAt: now,
    lastActivityAt: now,
  });
}

/** Mark user activity on the active case so the 60-minute idle clock resets.
 * An already-expired record is never resurrected. */
export async function touchActiveCaseActivity(): Promise<void> {
  const record = await readActiveCaseRecord();
  if (record == null) return;
  if (resolveActiveCaseState(record, Date.now()).status !== "active") return;
  await writeActiveCaseRecord({ ...record, lastActivityAt: new Date().toISOString() });
}

/** A fill ran against `tabId` for `caseId`: bind the tab to the record (an
 * in-panel selection has no portal URL, so the fill IS its binding moment). */
export async function bindFillTab(caseId: string, tabId: number): Promise<void> {
  const record = await readActiveCaseRecord();
  if (record == null || record.caseId !== caseId) return;
  if (resolveActiveCaseState(record, Date.now()).status !== "active") return;
  await writeActiveCaseRecord({
    ...record,
    boundTabId: tabId,
    lastActivityAt: new Date().toISOString(),
  });
}

/** The SET_ACTIVE_CASE receipt. Validates origin + shape, stores the new
 * record — LAST LAUNCH WINS, a pending context is replaced never stacked —
 * and best-effort opens the side panel. Returns whether the message was
 * accepted (the webapp's sendMessage response). */
export async function handleExternalMessage(
  message: unknown,
  senderOrigin: string | undefined,
  senderTabWindowId?: number,
): Promise<{ ok: boolean }> {
  if (!isAllowedHandoffOrigin(senderOrigin)) return { ok: false };
  const parsed = parseSetActiveCase(message);
  if (parsed == null) return { ok: false };
  const now = new Date().toISOString();
  await writeActiveCaseRecord({
    caseId: parsed.caseId,
    providerId: parsed.providerId,
    orgId: parsed.orgId,
    portalUrl: parsed.portalUrl,
    source: "handoff",
    boundTabId: null,
    tabClosedAt: null,
    createdAt: now,
    lastActivityAt: now,
  });
  notifyPanel();
  // Best-effort: open the side panel on the sender's window so the handoff
  // lands in front of the user. Requires a user gesture — the webapp's click
  // usually carries one — and quietly does nothing when it can't.
  try {
    if (senderTabWindowId != null) {
      await chrome.sidePanel?.open({ windowId: senderTabWindowId });
    }
  } catch {
    // no gesture / no sidePanel API — the toolbar icon still opens the panel
  }
  return { ok: true };
}

/** TE-1: associate the NEXT tab that lands on the handed-off portal's origin.
 * Called from tabs.onUpdated; binds once and counts as activity. */
export async function maybeBindPortalTab(tabId: number, url: string | undefined): Promise<void> {
  const record = await readActiveCaseRecord();
  if (record == null || record.source !== "handoff" || record.boundTabId != null) return;
  if (resolveActiveCaseState(record, Date.now()).status !== "active") return;
  if (!isPortalOriginUrl(record.portalUrl, url)) return;
  await writeActiveCaseRecord({
    ...record,
    boundTabId: tabId,
    lastActivityAt: new Date().toISOString(),
  });
}

/** Bound-tab activity (switching to it / navigating it) resets the idle
 * clock; closing it hard-expires the context (TE-1). */
export async function onTabActivity(tabId: number): Promise<void> {
  const record = await readActiveCaseRecord();
  if (record == null || record.boundTabId !== tabId) return;
  if (resolveActiveCaseState(record, Date.now()).status !== "active") return;
  await writeActiveCaseRecord({ ...record, lastActivityAt: new Date().toISOString() });
}

export async function onTabRemoved(tabId: number): Promise<void> {
  const record = await readActiveCaseRecord();
  if (record == null || record.boundTabId !== tabId || record.tabClosedAt != null) return;
  await writeActiveCaseRecord({ ...record, tabClosedAt: new Date().toISOString() });
  notifyPanel();
}

/** Wire the Chrome listeners. Top-level from the worker entry so every worker
 * restart re-registers them. */
export function registerActiveCaseListeners(): void {
  chrome.runtime.onMessageExternal?.addListener(
    (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
      void handleExternalMessage(message, sender.origin, sender.tab?.windowId).then(sendResponse);
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
}
