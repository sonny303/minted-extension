// E6.9 F6.9.8/F6.9.9 — the pure half of Train forms: which PAGE a capture came
// from, and whether the open page belongs to a form the system already knows.
//
// Both answers have to degrade rather than block. A payer wizard may keep one
// URL across five steps and may or may not carry a distinguishing heading; a
// portal row may exist under a URL that only prefix-matches. Capture is the
// scarce act — the trainer is standing on the page with the form open — so
// every ambiguity resolves to "capture it and let the admin rename it in the
// editor" (F6.9.5), never to a prompt and never to a refusal.

import type { PortalFieldMap, PortalRegistryRow } from "./apiTypes";
import { matchPortalByUrl, type MatchedPortal } from "./portals";

// ---------------------------------------------------------------------------
// Page identity (F6.9.8)
// ---------------------------------------------------------------------------

/** The fallback name for the Nth page of a capture run. */
export function sequencePageName(sequence: number): string {
  return `Page ${sequence}`;
}

/** The last non-empty URL path segment — stable page identity when headings
 * are missing. Exported for re-capture page matching (BITE-CAP-01). */
export function pageUrlTail(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    // The LAST non-empty path segment is what distinguishes step pages that
    // share a host and a form root (…/enroll/practice vs …/enroll/credentials).
    // Query and hash are deliberately ignored: enrollment forms carry volatile
    // session state there, which would make every visit look like a new page.
    const segments = u.pathname.split("/").filter(Boolean);
    return segments.length > 0 ? (segments[segments.length - 1] ?? null) : null;
  } catch {
    return null;
  }
}

function tidy(value: string | null | undefined): string | null {
  const text = (value ?? "").trim().replace(/\s+/g, " ");
  return text.length > 0 ? text : null;
}

export interface PageIdentityInput {
  url: string | null;
  /** The wizard heading read off the page (shape only — never a value). */
  heading: string | null;
  /** 1-based position of this capture within the run. */
  sequence: number;
  /** Page names already used in this run, so a repeat cannot collide. */
  used: readonly string[];
}

/**
 * Name the page a capture came from.
 *
 * Preference order is heading → URL tail → capture sequence: the heading is
 * what the trainer sees and will recognise in the editor, the URL tail is
 * stable but often opaque, and the sequence always works. A name already used
 * in this run means the two pages did not actually differ by that signal, so
 * it falls through to the sequence rather than silently merging two pages'
 * fields into one bucket.
 */
export function derivePageStep(input: PageIdentityInput): string {
  const used = new Set(input.used);
  const heading = tidy(input.heading);
  if (heading && !used.has(heading)) return heading;
  const tail = tidy(pageUrlTail(input.url));
  if (tail && !used.has(tail)) return tail;
  let sequence = input.sequence;
  let name = sequencePageName(sequence);
  while (used.has(name)) name = sequencePageName(++sequence);
  return name;
}

/**
 * DOM order within the captured page, 1-based.
 *
 * The scan already yields fields in document order, so this is deliberately
 * positional rather than clever: the trainer's list should read down the form
 * the way the form reads. Ordering is per PAGE; pages themselves order by
 * capture sequence, which is the order the trainer walked them.
 */
export function assignSortOrder<T>(rows: readonly T[]): (T & { sortOrder: number })[] {
  return rows.map((row, index) => ({ ...row, sortOrder: index + 1 }));
}

// ---------------------------------------------------------------------------
// New / existing recognition (F6.9.9)
// ---------------------------------------------------------------------------

/** What the trainer is looking at. */
export type FormRecognition =
  | { kind: "existing"; portal: MatchedPortal }
  | { kind: "new"; candidateName: string };

/**
 * Is the open page a form we already know?
 *
 * Recognition reuses the SAME registry match the fill engine uses
 * (`matchPortalByUrl`) — one rule, so the trainer and the filler can never
 * disagree about which portal a page is.
 *
 * Nothing here writes: a "new" result names a CANDIDATE portal, which the user
 * registers deliberately. Nothing is auto-attached to a template or a task
 * (D17) — the captured form goes to the shared library and is used on purpose.
 */
export function recognizeForm(
  url: string | null | undefined,
  rows: readonly PortalRegistryRow[],
  payerName: string | null,
): FormRecognition {
  const matched = matchPortalByUrl(url, [...rows]);
  if (matched) return { kind: "existing", portal: matched };
  return { kind: "new", candidateName: candidatePortalName(payerName, rows) };
}

/**
 * A name for a form this payer does not have registered yet.
 *
 * A payer legitimately has several forms (D15), and URL/heading often cannot
 * tell a genuinely new one from an existing row — so the honest move is a
 * NUMBERED candidate the admin renames, not a block and not a guess that
 * overwrites an existing row. Numbering counts the payer's existing rows, so
 * the second form is "<Payer> form 2".
 */
export function candidatePortalName(
  payerName: string | null,
  rows: readonly PortalRegistryRow[],
): string {
  const payer = tidy(payerName) ?? "Payer";
  const existing = rows.filter((r) => tidy(r.payerName ?? null) === payer).length;
  return existing === 0 ? `${payer} form` : `${payer} form ${existing + 1}`;
}

/** A key derived from a candidate name — lowercase, underscore-joined, the
 * shape `normalizePortalKey` folds to on the server. */
export function candidatePortalKey(candidateName: string): string {
  return candidateName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---------------------------------------------------------------------------
// What a known form already has (F6.9.9)
// ---------------------------------------------------------------------------

export interface FormCaptureState {
  pagesSeen: number;
  fieldsCaptured: number;
  mapped: number;
  undecided: number;
}

/**
 * The state the panel shows for a RECOGNIZED form, so the trainer can decide
 * whether re-capturing is worth it.
 *
 * `mapped` mirrors the panel's registry classifier: a row counts only when it
 * is approved AND actually carries something to fill with. An approved row
 * with an empty token or an empty literal is not mapped — counting it would
 * report a form as trained that fills nothing, which is the exact failure the
 * epic exists to remove. `manual` is a deliberate human-fill decision: decided,
 * but not mapped.
 */
export function formCaptureState(maps: readonly PortalFieldMap[]): FormCaptureState {
  const live = maps.filter((m) => m.status !== "retired");
  const pages = new Set<string>();
  let mapped = 0;
  let undecided = 0;
  for (const m of live) {
    const page = tidy(m.pageStep);
    if (page) pages.add(page);
    if (m.status === "proposed") {
      undecided += 1;
      continue;
    }
    if (m.status !== "approved") continue;
    if (m.source === "token" || m.source === "manual_partial") {
      if (tidy(m.token)) mapped += 1;
    } else if (m.source === "hardcoded") {
      if (tidy(m.hardcodedValue)) mapped += 1;
    }
  }
  return { pagesSeen: pages.size, fieldsCaptured: live.length, mapped, undecided };
}

/** The one-line summary under a recognized form. */
export function captureStateSummary(state: FormCaptureState): string {
  const pages =
    state.pagesSeen === 0
      ? "no pages recorded"
      : `${state.pagesSeen} ${state.pagesSeen === 1 ? "page" : "pages"} seen`;
  return `${pages} · ${state.fieldsCaptured} captured · ${state.mapped} mapped`;
}

// ---------------------------------------------------------------------------
// Train capture bind + mismatch copy (TRAIN-DUAL / D-TD.1 C amended + D-TD.3 C1)
// ---------------------------------------------------------------------------

/**
 * What Train should show and bind for capture on the open tab.
 *
 * Capture bind is URL-only (shared-library poison guard). The dropdown is
 * sticky navigation/messaging intent — it never auto-sets the capture key.
 * When a form is selected and the URL does not match, copy must NOT claim a
 * "new form" (login walls / SSO / wizard redirects are the real gap).
 */
export type TrainRecognitionView =
  | { status: "matched"; portal: MatchedPortal }
  | {
      status: "mismatch";
      portal: null;
      selectedName: string;
      recognitionText: string;
      hintText: string;
    }
  | {
      status: "new";
      portal: null;
      candidateName: string;
      recognitionText: string;
      hintText: string;
    }
  | { status: "no-tab"; portal: null; recognitionText: string; hintText: string };

export interface TrainRecognitionInput {
  url: string | null | undefined;
  rows: readonly PortalRegistryRow[];
  payerName: string | null;
  /** Dropdown `portal_key` (empty string = none selected). */
  selectedPortalKey: string;
}

/** Honest mismatch line when selection exists but the tab URL does not match. */
export function trainMismatchRecognitionText(selectedName: string): string {
  return `This page doesn’t match ${selectedName} — finish login or open the registered form URL.`;
}

export const TRAIN_MISMATCH_HINT =
  "Capture stays off until this tab matches the selected form. Opening the form from the list navigates to the registered URL.";

export const TRAIN_NEW_HINT =
  "Register the form in the web app first, then come back and capture each section of it here.";

export const TRAIN_NO_TAB_HINT = TRAIN_NEW_HINT;

/**
 * Resolve Train recognition UI + capture bind from URL + sticky selection.
 *
 * `portal` is non-null only on `matched` — the sole automatic capture bind.
 */
export function resolveTrainRecognition(input: TrainRecognitionInput): TrainRecognitionView {
  const recognition = recognizeForm(input.url, input.rows, input.payerName);
  if (recognition.kind === "existing") {
    return { status: "matched", portal: recognition.portal };
  }

  if (!input.url) {
    return {
      status: "no-tab",
      portal: null,
      recognitionText: "Open the payer's form in this tab to train it.",
      hintText: TRAIN_NO_TAB_HINT,
    };
  }

  const selectedKey = input.selectedPortalKey.trim();
  if (selectedKey) {
    const selected = input.rows.find((r) => r.portalKey === selectedKey);
    const selectedName = tidy(selected?.name) ?? selectedKey;
    return {
      status: "mismatch",
      portal: null,
      selectedName,
      recognitionText: trainMismatchRecognitionText(selectedName),
      hintText: TRAIN_MISMATCH_HINT,
    };
  }

  const candidateName = recognition.candidateName;
  return {
    status: "new",
    portal: null,
    candidateName,
    recognitionText: `New form — nothing matches this page yet. It will be registered as “${candidateName}”.`,
    hintText: TRAIN_NEW_HINT,
  };
}

/**
 * Shared-library invariant: the only portal_key capture may send is the one
 * `matchPortalByUrl` returns for the active tab. A dropdown selection that
 * disagrees with the tab must never win automatically.
 */
export function capturePortalKeyForUrl(
  url: string | null | undefined,
  rows: readonly PortalRegistryRow[],
): string | null {
  return matchPortalByUrl(url, [...rows])?.key ?? null;
}

/** True when `portalKey` is exactly the URL-matched registry key (or both absent). */
export function captureKeyAgreesWithTabUrl(
  portalKey: string | null | undefined,
  url: string | null | undefined,
  rows: readonly PortalRegistryRow[],
): boolean {
  const allowed = capturePortalKeyForUrl(url, rows);
  const key = (portalKey ?? "").trim();
  if (!key) return allowed == null;
  return allowed === key;
}
