import type { ControlSummary, ControlType } from '../shared/nanoAi';
import { byLabel, LABEL_SELECTOR_PREFIX } from './fillEngine';
import {
  describeControl,
  isCapturableControl,
} from './captureScan';
import {
  ancestorsIncludingShadow,
  FILLABLE,
  querySelectorAllDeep,
  querySelectorDeep,
} from './deepDom';

export interface ActiveMapSelectors {
  selector: string;
  selectorFallbacks?: readonly string[] | null;
  /** Worker sends only scopes matching this frame; retained for wire typing. */
  pageUrlScope?: string;
}

interface ScannedControl {
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  summary: ControlSummary;
}

const MAX_LIVE_SCANS = 6;
const liveScans = new Map<string, Map<string, ScannedControl>>();

const UNSUPPORTED_INPUT_TYPES = new Set([
  'button',
  'file',
  'hidden',
  'image',
  'password',
  'reset',
  'submit',
]);

function isSupportedControl(el: Element): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !UNSUPPORTED_INPUT_TYPES.has(el.type.toLowerCase());
}

function isUsableControl(el: Element): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  if (!isSupportedControl(el) || !isCapturableControl(el) || el.matches(':disabled')) {
    return false;
  }
  if (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    el.readOnly
  ) {
    return false;
  }
  return !isOwnedByExtension(el);
}

function isOwnedByExtension(el: Element): boolean {
  for (const node of ancestorsIncludingShadow(el)) {
    if (
      node.id.startsWith('__minted-panel-') ||
      node.hasAttribute('data-minted-panel-owned')
    ) {
      return true;
    }
    // The picker toggles this class on <html>; that must not hide the whole
    // payer page from a scan. Its actual overlay nodes use the id prefix above.
    if (node !== document.documentElement) {
      for (const name of Array.from(node.classList)) {
        if (name.startsWith('__mp-')) return true;
      }
    }
  }
  return false;
}

function controlType(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): ControlType {
  if (el instanceof HTMLSelectElement) return 'select';
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el.type === 'radio') return 'radio';
  if (el.type === 'checkbox') return 'checkbox';
  if (el.type === 'date') return 'date';
  return 'text';
}

function sameRadioGroup(a: HTMLInputElement, b: HTMLInputElement): boolean {
  return (
    a.type === 'radio' &&
    b.type === 'radio' &&
    a.name !== '' &&
    a.name === b.name &&
    a.form === b.form &&
    a.getRootNode() === b.getRootNode()
  );
}

function radioGroupMembers(el: HTMLInputElement): HTMLInputElement[] {
  if (!el.name) return [el];
  const root = el.getRootNode();
  const searchRoot = root instanceof ShadowRoot ? root : el.form ?? document;
  return querySelectorAllDeep('input[type="radio"]', searchRoot).filter(
    (candidate): candidate is HTMLInputElement =>
      candidate instanceof HTMLInputElement && sameRadioGroup(candidate, el),
  );
}

function fillRadioGroupMatches(el: HTMLInputElement): HTMLInputElement[] {
  if (!el.name) return [el];
  const selector = `input[type="radio"][name="${CSS.escape(el.name)}"]`;
  return querySelectorAllDeep(selector, el.form ?? document).filter(
    (candidate): candidate is HTMLInputElement => candidate instanceof HTMLInputElement,
  );
}

function radioGroupSelector(el: HTMLInputElement): string | null {
  return el.name ? `input[type="radio"][name="${CSS.escape(el.name)}"]` : null;
}

function selectorIsSafe(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  selector: string,
): boolean {
  let matches: Element[];
  try {
    matches = querySelectorAllDeep(selector);
  } catch {
    return false;
  }
  if (!matches.includes(el)) return false;

  if (!(el instanceof HTMLInputElement) || el.type !== 'radio') {
    return matches.length === 1 && matches[0] === el;
  }
  if (!el.name) return matches.length === 1 && matches[0] === el;

  const group = radioGroupMembers(el);
  const intendedGroupSelector = radioGroupSelector(el);
  const resolvesOneOption = matches.length === 1 && matches[0] === el;
  const resolvesWholeGroup =
    selector === intendedGroupSelector &&
    matches.length === group.length &&
    matches.every((match) => match instanceof HTMLInputElement && sameRadioGroup(match, el));
  if (!resolvesOneOption && !resolvesWholeGroup) return false;

  // fillEngine resolves a named radio by searching `form ?? document`. If
  // that query spans more than the actual form/root group, this selector is
  // unsafe for later fill even when an id uniquely points at one option.
  const fillGroup = fillRadioGroupMatches(el);
  return (
    fillGroup.length === group.length &&
    fillGroup.every((radio) => sameRadioGroup(radio, el))
  );
}

function mapTarget(selector: string): Element | null {
  if (!selector) return null;
  if (selector.startsWith(LABEL_SELECTOR_PREFIX)) {
    return byLabel(selector.slice(LABEL_SELECTOR_PREFIX.length));
  }
  try {
    return querySelectorDeep(selector);
  } catch {
    return null;
  }
}

function markMappedControl(target: Element, mapped: Set<Element>): void {
  if (target instanceof HTMLInputElement && target.type === 'radio' && target.name) {
    for (const member of radioGroupMembers(target)) mapped.add(member);
    return;
  }
  mapped.add(target);
}

function mappedControls(activeMaps: readonly ActiveMapSelectors[]): Set<Element> {
  const mapped = new Set<Element>();
  for (const map of activeMaps) {
    if (!map || typeof map.selector !== 'string') continue;
    const selectors = [map.selector, ...(map.selectorFallbacks ?? [])];
    for (const selector of selectors) {
      if (typeof selector !== 'string') continue;
      const target = mapTarget(selector);
      if (target) markMappedControl(target, mapped);
    }
  }
  return mapped;
}

function markRadioGroupSeen(
  el: HTMLInputElement,
  seen: Map<Node, Map<HTMLFormElement | null, Set<string>>>,
): boolean {
  if (!el.name) return true;
  const root = el.getRootNode();
  let byForm = seen.get(root);
  if (!byForm) {
    byForm = new Map();
    seen.set(root, byForm);
  }
  let names = byForm.get(el.form);
  if (!names) {
    names = new Set();
    byForm.set(el.form, names);
  }
  if (names.has(el.name)) return false;
  names.add(el.name);
  return true;
}

function optionalAttribute(el: Element, name: string): string | undefined {
  const value = el.getAttribute(name)?.replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, 160) : undefined;
}

/**
 * Extract visible, unmapped control metadata from this frame. Values, checked
 * state, option values, and selected state are never read. Cross-frame
 * orchestration belongs to the caller and no frame identifiers are retained.
 */
export function scanUnmappedControls(
  activeMaps: readonly ActiveMapSelectors[] = [],
): ControlSummary[] {
  const mapped = mappedControls(activeMaps);
  const seenRadioGroups = new Map<Node, Map<HTMLFormElement | null, Set<string>>>();
  const output: ControlSummary[] = [];

  for (const el of querySelectorAllDeep(FILLABLE)) {
    if (!isUsableControl(el) || mapped.has(el)) continue;

    if (el instanceof HTMLInputElement && el.type === 'radio') {
      if (!markRadioGroupSeen(el, seenRadioGroups)) continue;
    }

    const description = describeControl(el, { includeOptions: false });
    if (!selectorIsSafe(el, description.selector)) continue;

    const summary: ControlSummary = {
      selector: description.selector,
      controlType: controlType(el),
      ...(description.label.trim()
        ? { label: description.label.replace(/\s+/g, ' ').trim().slice(0, 160) }
        : {}),
      ...(optionalAttribute(el, 'placeholder')
        ? { placeholder: optionalAttribute(el, 'placeholder') }
        : {}),
      ...(optionalAttribute(el, 'name') ? { name: optionalAttribute(el, 'name') } : {}),
      ...(optionalAttribute(el, 'id') ? { id: optionalAttribute(el, 'id') } : {}),
    };
    output.push(summary);
  }

  return output;
}

/** Retain only DOM references in this frame so an AI proposal can be checked
 * against the exact node the metadata came from. Values are never read here. */
export function beginUnmappedControlScan(
  scanId: string,
  activeMaps: readonly ActiveMapSelectors[] = [],
): ControlSummary[] {
  if (!scanId) return [];
  const mapped = mappedControls(activeMaps);
  const seenRadioGroups = new Map<Node, Map<HTMLFormElement | null, Set<string>>>();
  const controls = new Map<string, ScannedControl>();

  for (const el of querySelectorAllDeep(FILLABLE)) {
    if (!isUsableControl(el) || mapped.has(el)) continue;
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      if (!markRadioGroupSeen(el, seenRadioGroups)) continue;
    }
    const description = describeControl(el, { includeOptions: false });
    if (!selectorIsSafe(el, description.selector) || controls.has(description.selector)) continue;
    const summary: ControlSummary = {
      selector: description.selector,
      controlType: controlType(el),
      ...(description.label.trim()
        ? { label: description.label.replace(/\s+/g, ' ').trim().slice(0, 160) }
        : {}),
      ...(optionalAttribute(el, 'placeholder')
        ? { placeholder: optionalAttribute(el, 'placeholder') }
        : {}),
      ...(optionalAttribute(el, 'name') ? { name: optionalAttribute(el, 'name') } : {}),
      ...(optionalAttribute(el, 'id') ? { id: optionalAttribute(el, 'id') } : {}),
    };
    controls.set(summary.selector, { element: el, summary });
  }

  liveScans.delete(scanId);
  liveScans.set(scanId, controls);
  while (liveScans.size > MAX_LIVE_SCANS) {
    const oldest = liveScans.keys().next().value;
    if (oldest == null) break;
    liveScans.delete(oldest);
  }
  return [...controls.values()].map(({ summary }) => summary);
}

export function scannedControlForAi(
  scanId: string,
  selector: string,
): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null {
  const scanned = liveScans.get(scanId)?.get(selector);
  if (!scanned || !isUsableControl(scanned.element)) return null;
  let matches: Element[];
  try {
    matches = querySelectorAllDeep(selector);
  } catch {
    return null;
  }
  const singleExact = matches.length === 1 && matches[0] === scanned.element;
  const exactRadioGroup =
    scanned.element instanceof HTMLInputElement &&
    scanned.element.type === 'radio' &&
    matches.includes(scanned.element) &&
    matches.length === radioGroupMembers(scanned.element).length &&
    matches.every((match) => match instanceof HTMLInputElement && sameRadioGroup(match, scanned.element as HTMLInputElement));
  if ((!singleExact && !exactRadioGroup) || !selectorIsSafe(scanned.element, selector)) return null;
  const current = describeControl(scanned.element, { includeOptions: false });
  if (
    current.selector !== scanned.summary.selector ||
    controlType(scanned.element) !== scanned.summary.controlType ||
    (current.label.replace(/\s+/g, ' ').trim().slice(0, 160) || undefined) !== scanned.summary.label ||
    optionalAttribute(scanned.element, 'placeholder') !== scanned.summary.placeholder ||
    optionalAttribute(scanned.element, 'name') !== scanned.summary.name ||
    optionalAttribute(scanned.element, 'id') !== scanned.summary.id ||
    !selectorIsSafe(scanned.element, selector)
  ) {
    return null;
  }
  return scanned.element;
}

export function clearUnmappedControlScan(scanId: string): void {
  liveScans.delete(scanId);
}
