// Capture probe — the extension's own scanner, packaged as a standalone IIFE so
// a Claude agent can inject it into a payer form from a browser tool (see the
// `payer-form-capture` skill). It is NOT part of the extension bundle and never
// talks to the panel: it only reads the page's shape and returns it.
//
// Same rule as capture: labels, selectors, control types, option vocabularies.
// Never a value — `scanCapturableFields` doesn't read one, and nothing here
// adds one. Reusing the scanner (rather than a second copy in the skill) is the
// point: an agent-captured row and an extension-captured row are the same row.
//
// v2 also records what a FUTURE automated walk would need, without doing any
// of it: which page this is (fingerprint), which control advances / goes back /
// submits (navigation), what popped up (dialogs), and what the payer refused
// (errors → gate conditions). The probe never clicks anything.
import {
  FILLABLE,
  isCapturableControl,
  isHiddenControl,
  scanCapturableFields,
  selectorFor,
  type CapturedField,
} from "../content/captureScan";
import { querySelectorAllDeep, querySelectorDeep } from "../content/deepDom";

export const PROBE_VERSION = 2;

export interface ProbeField extends CapturedField {
  /** DOM/visual position within this page, 0-based — the scanner's order. */
  sortOrder: number;
  /** The control (or any radio in its group) declares itself required. A
   * shape fact from attributes; a payer that only enforces it on Next
   * (Qualtrics forced response) shows up in `errors` instead. */
  required: boolean;
}

/** What clicking a control would do. `submit` is the one a walker and any
 * future runner must never click: the human submits. */
export type ActionKind = "advance" | "back" | "submit" | "save" | "dismiss" | "other";

export interface ProbeAction {
  kind: ActionKind;
  caption: string;
  selector: string;
  disabled: boolean;
}

export interface ProbeDialog {
  /** The dialog's own copy (payer text, ≤200 chars) — how a runner tells a
   * known interstitial ("Your session was outdated…") from a new one. */
  text: string;
  actions: ProbeAction[];
}

/** A validation message the payer is showing, tied to the field it is about
 * when we can tell. After a refused Next, these ARE the page's gate. A null
 * selector with a `question` is a required answer with no capturable control
 * (a canvas signature pad, a custom widget) — a gate only a person clears. */
export interface ProbeError {
  message: string;
  selector: string | null;
  /** The platform's question id (Qualtrics QID) the message sits in. */
  question: string | null;
}

export interface PageFingerprint {
  /** Stable identities of what is on the page: the platform's question ids
   * where it has them (Qualtrics QIDs), else the field selectors. Sorted. */
  keys: string[];
  /** FNV-1a over keys + heading (+ the page copy when there are no keys, so
   * an intro and a thank-you page differ). Same page → same hash in any
   * session; a re-built form → a new hash, which is how drift is caught. The
   * copy itself is never stored — it may pipe earlier answers back. */
  hash: string;
}

export interface ProbePage {
  probeVersion: number;
  /** origin + pathname only — portal query strings carry session ids. */
  url: string;
  title: string;
  /** First visible h1/h2/heading: the page's name as a reader sees it. */
  heading: string | null;
  /** A form platform the probe knows page identity for, else null. */
  platform: "qualtrics" | null;
  fingerprint: PageFingerprint;
  /** The page's own buttons, classified. Dialog buttons live under `dialogs`. */
  navigation: ProbeAction[];
  /** The page's copy says its advance control SUBMITS the form. Every
   * `advance` on such a page is reported as `submit`. */
  submitWarning: boolean;
  dialogs: ProbeDialog[];
  errors: ProbeError[];
  /** iframe srcs (origin + pathname). A form inside a cross-origin frame is
   * out of a top-frame probe's reach; navigating the tab to the frame's src
   * usually brings it in. */
  frames: string[];
  fields: ProbeField[];
}

const ACTION_SELECTOR =
  "button, input[type='submit'], input[type='button'], input[type='image'], [role='button']";
const DIALOG_SELECTOR =
  "[role='dialog'], [role='alertdialog'], dialog[open], .ui-dialog, .modal.show, .modal.in";
const ERROR_SELECTOR =
  "[role='alert'], .ValidationError, .error-message, .errorMessage, .field-error, .invalid-feedback";
const MAX_ACTIONS = 12;
const MAX_TEXT = 200;

// Order matters: a Qualtrics last page keeps id="NextButton" but says
// "Submit", so the caption's submit wins over any advance hint.
const SUBMIT = /\b(submit|finish|complete|send|attest|e-?sign|sign\s*(and|&)\s*submit)\b/i;
// "Continue Without Answering" is Qualtrics' soft-required ("Response
// Requested") popup letting the page go on unanswered — an advance, and the
// only one there.
const ADVANCE = /^(next|next\s*page|continue|continue\s+without\s+answering|skip|proceed|save\s*(and|&)\s*continue|>>|→|›|»)$/i;
const BACK = /^(back|previous|prev|<<|←|‹|«)$/i;
const SAVE = /^save(\s+(for\s+later|draft|progress))?$/i;
const DISMISS = /^(ok|okay|close|dismiss|got\s*it|×|x|cancel|answer\s+the\s+question|go\s+back)$/i;
// Copy that says the "Next" button submits. BlueKC's last page: 'Click on the
// "Next" button below to submit this form now. This form will not submit until
// you click the "Next" button.' — the caption says Next, the page says submit,
// and the page wins. Narrow on purpose: an intro saying "until you have
// submitted the form" names no button and must not trip it.
const SUBMIT_COPY =
  /\b(click|press|select|tap)\b[^.]{0,60}\b(next|continue|button|>>)\b[^.]{0,60}\bsubmit|\bwill\s+not\s+(be\s+)?submit(ted)?\s+until\b/i;

function urlWithoutQuery(raw: string): string {
  try {
    const url = new URL(raw, location.href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function collapse(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function isShown(el: Element): boolean {
  if (el.getClientRects().length === 0) return false;
  const { width, height } = el.getBoundingClientRect();
  return width > 0 && height > 0 && !isHiddenControl(el);
}

/** 32-bit FNV-1a, hex. Not security — just a stable, short page identity. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isRequired(field: CapturedField): boolean {
  let controls: Element[];
  try {
    controls = field.fieldType === "radio"
      ? querySelectorAllDeep(field.selector)
      : [querySelectorDeep(field.selector)].filter((el): el is Element => el != null);
  } catch {
    return false;
  }
  return controls.some(
    (el) => el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
  );
}

function pageHeading(): string | null {
  for (const el of querySelectorAllDeep("h1, h2, [role='heading']")) {
    if (!isShown(el)) continue;
    const text = collapse(el.textContent);
    if (text && text.length <= 160) return text;
  }
  return null;
}

function actionCaption(el: Element): string {
  if (el instanceof HTMLInputElement) return collapse(el.value || el.alt);
  return collapse(el.getAttribute("aria-label") ?? el.textContent);
}

export function classifyAction(caption: string, hint: string, inDialog: boolean): ActionKind {
  if (SUBMIT.test(caption)) return "submit";
  if (inDialog && DISMISS.test(caption)) return "dismiss";
  if (ADVANCE.test(caption)) return "advance";
  if (BACK.test(caption)) return "back";
  if (SAVE.test(caption)) return "save";
  // Icon-only buttons: fall back to the control's own id/class.
  if (!caption || caption.length <= 2) {
    if (/next|continue|forward/i.test(hint)) return "advance";
    if (/prev|back/i.test(hint)) return "back";
  }
  return "other";
}

function describeAction(el: Element, inDialog: boolean): ProbeAction {
  const caption = actionCaption(el);
  const hint = `${el.id} ${typeof el.className === "string" ? el.className : ""}`;
  return {
    kind: classifyAction(caption, hint, inDialog),
    caption,
    selector: selectorFor(el),
    disabled:
      (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true",
  };
}

function visibleDialogs(): Element[] {
  const shown = querySelectorAllDeep(DIALOG_SELECTOR).filter(isShown);
  // Keep the outermost of nested matches (.ui-dialog > [role=dialog]).
  return shown.filter((el) => !shown.some((other) => other !== el && other.contains(el)));
}

function pageNavigation(dialogs: Element[]): ProbeAction[] {
  const out: ProbeAction[] = [];
  for (const el of querySelectorAllDeep(ACTION_SELECTOR)) {
    if (out.length >= MAX_ACTIONS) break;
    if (!isShown(el) || dialogs.some((d) => d.contains(el))) continue;
    const action = describeAction(el, false);
    if (action.caption.length > 60) continue;
    if (out.some((a) => a.selector === action.selector)) continue;
    out.push(action);
  }
  return out;
}

function dialogSummaries(dialogs: Element[]): ProbeDialog[] {
  return dialogs.map((dialog) => ({
    text: collapse(dialog.textContent).slice(0, MAX_TEXT),
    actions: querySelectorAllDeep(ACTION_SELECTOR, dialog)
      .filter(isShown)
      .map((el) => describeAction(el, true)),
  }));
}

/** Containers that ARE one question. Climbing out of one would borrow a
 * neighbour's field: BlueKC's signature-pad error (a canvas, no input) was
 * pinned on the county radio above it, which had no error at all. */
const QUESTION_BOUNDARY = ".QuestionOuter, fieldset, [role='group'], [role='radiogroup'], .form-group";

/** The capturable field a message is about: climb from the message until an
 * ancestor holds one, never past the question the message belongs to. */
function fieldNear(el: Element): string | null {
  let node: Element | null = el;
  for (let depth = 0; node && node !== document.body && depth < 6; depth += 1) {
    const control = querySelectorAllDeep(FILLABLE, node).find(isCapturableControl);
    if (control) return selectorFor(control);
    if (node.matches(QUESTION_BOUNDARY)) return null;
    node = node.parentElement;
  }
  return null;
}

function questionOf(el: Element): string | null {
  return el.closest(".QuestionOuter[id^='QID']")?.id ?? null;
}

function pageErrors(): ProbeError[] {
  const errors: ProbeError[] = [];
  const seen = new Set<string>();
  for (const el of querySelectorAllDeep(ERROR_SELECTOR)) {
    if (!isShown(el)) continue;
    const message = collapse(el.textContent).slice(0, MAX_TEXT);
    if (!message) continue;
    const selector = fieldNear(el);
    const question = questionOf(el);
    const key = `${selector}\u0000${question}\u0000${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push({ message, selector, question });
  }
  for (const el of querySelectorAllDeep("[aria-invalid='true']")) {
    if (!el.matches(FILLABLE) || !isCapturableControl(el)) continue;
    const selector = selectorFor(el);
    if (errors.some((e) => e.selector === selector)) continue;
    errors.push({ message: "", selector, question: questionOf(el) });
  }
  return errors;
}

/** Qualtrics renders every question — including text-only ones — as
 * `.QuestionOuter#QIDn`, and every page of a survey shares ONE url, so the
 * QID set is the page's identity. */
function qualtricsQuestionIds(): string[] | null {
  const outers = querySelectorAllDeep(".QuestionOuter[id^='QID']");
  if (outers.length === 0) return null;
  return outers.filter((el) => !isHiddenControl(el)).map((el) => el.id);
}

function pageCopy(): string {
  const root = document.querySelector("#Questions, main, form") ?? document.body;
  return collapse(root.textContent);
}

function mainText(): string {
  return pageCopy().slice(0, MAX_TEXT);
}

function fingerprintFor(fields: CapturedField[], heading: string | null, qids: string[] | null): PageFingerprint {
  const keys = [...new Set(qids ?? fields.map((f) => f.selector))].sort();
  const basis = [...keys, `#heading:${heading ?? ""}`];
  if (keys.length === 0) basis.push(`#text:${mainText()}`);
  return { keys, hash: fnv1a(basis.join("\n")) };
}

export function probePage(): ProbePage {
  // Uncapped: a capture file never crosses the panel's 50-option write
  // boundary, and a truncated vocabulary hides the very option a mapping needs
  // (BlueKC's 'Physical Therapist' is #121 of 146).
  const fields = scanCapturableFields({ optionsCap: Infinity }).map((field, sortOrder) => ({
    ...field,
    sortOrder,
    required: isRequired(field),
  }));
  const heading = pageHeading();
  const qids = qualtricsQuestionIds();
  const dialogs = visibleDialogs();
  const submitWarning = SUBMIT_COPY.test(pageCopy());
  const navigation = pageNavigation(dialogs).map((action) =>
    submitWarning && action.kind === "advance" ? { ...action, kind: "submit" as const } : action,
  );
  return {
    probeVersion: PROBE_VERSION,
    url: urlWithoutQuery(location.href),
    title: collapse(document.title),
    heading,
    platform: qids ? "qualtrics" : null,
    fingerprint: fingerprintFor(fields, heading, qids),
    navigation,
    submitWarning,
    dialogs: dialogSummaries(dialogs),
    errors: pageErrors(),
    frames: [...document.querySelectorAll("iframe[src]")]
      .map((frame) => urlWithoutQuery(frame.getAttribute("src") ?? ""))
      .filter(Boolean),
    fields,
  };
}

(globalThis as { __mintedCaptureProbe?: unknown }).__mintedCaptureProbe = {
  version: PROBE_VERSION,
  scan: probePage,
};
