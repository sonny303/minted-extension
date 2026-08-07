// E6.9 F6.9.7 — the panel's current job, owned by the background worker.
//
// It lives beside the active-org selection (orgState.ts) and for the same
// reason: the worker owns every API call, and the mode decides whether that
// call carries `x-org-id` at all. Reading it in the panel and passing it down
// per request would let a mode switch race a call in flight and send a training
// capture under an org header.
//
// `chrome.storage.session`, matching the rest of the worker's state: the job
// is chosen after sign-in and dies with the browser, so a trainer's session
// never silently persists into someone else's case work on a shared machine.
import { DEFAULT_PANEL_MODE, parsePanelMode, type PanelMode } from "../shared/panelMode";

const PANEL_MODE_KEY = "minted.panelMode";

export async function readPanelMode(): Promise<PanelMode> {
  const entry = await chrome.storage.session.get(PANEL_MODE_KEY);
  return parsePanelMode(entry[PANEL_MODE_KEY]) ?? DEFAULT_PANEL_MODE;
}

export async function writePanelMode(mode: PanelMode): Promise<void> {
  await chrome.storage.session.set({ [PANEL_MODE_KEY]: mode });
}
