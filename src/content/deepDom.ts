// Open-shadow DOM traversal. `document.querySelectorAll` cannot see into
// `#shadow-root (open)` trees (LitElement / Litehouse / many design systems),
// so capture and fill both miss every control that lives there. Closed shadow
// roots remain unreachable — that is a browser rule, not a gap we can close.
//
// These helpers pierce OPEN shadow roots only. They never read control values.

/** Same fillable set the scanner and fill engine share. */
export const FILLABLE =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea';

/**
 * Recursively query `selector` in `root` and every open shadow root beneath it.
 * Dedupes by element identity. Invalid CSS yields an empty array (never throws).
 */
export function querySelectorAllDeep(
  selector: string,
  root: ParentNode = document,
): Element[] {
  // Validate once so callers can tell a typo (`valid: false`) from zero matches.
  // Swallowing SyntaxError here made the Selector Workshop report invalid CSS
  // as "matches nothing".
  try {
    document.querySelector(selector);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new DOMException(`'${selector}' is not a valid selector`);
  }

  const out: Element[] = [];
  const seen = new Set<Element>();

  const visit = (node: ParentNode): void => {
    try {
      for (const el of Array.from(node.querySelectorAll(selector))) {
        if (seen.has(el)) continue;
        seen.add(el);
        out.push(el);
      }
    } catch {
      // Should not happen after the document-level validate above.
    }
    let elements: Element[];
    try {
      elements = Array.from(node.querySelectorAll("*"));
    } catch {
      return;
    }
    for (const el of elements) {
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };

  visit(root);
  return out;
}

/** First match from {@link querySelectorAllDeep}, or null. */
export function querySelectorDeep(
  selector: string,
  root: ParentNode = document,
): Element | null {
  return querySelectorAllDeep(selector, root)[0] ?? null;
}

/**
 * Walk `el` → ancestors, crossing open shadow boundaries via `ShadowRoot.host`.
 * `Element.parentElement` stops at the shadow root (null), which made
 * `isHiddenControl` and label discovery blind to a hidden host wrapping a
 * visible-looking control.
 */
export function* ancestorsIncludingShadow(el: Element): Generator<Element> {
  let node: Element | null = el;
  while (node) {
    yield node;
    if (node.parentElement) {
      node = node.parentElement;
      continue;
    }
    const root = node.getRootNode();
    if (root instanceof ShadowRoot) {
      node = root.host;
      continue;
    }
    node = null;
  }
}

/**
 * `Element.closest` that also climbs out of open shadow roots onto the host.
 * Needed for radio-group / fieldset discovery when the input lives inside
 * `<lh-radio>`'s shadow tree while the group host sits in the light DOM.
 */
export function closestDeep(el: Element, selector: string): Element | null {
  for (const node of ancestorsIncludingShadow(el)) {
    try {
      if (node.matches(selector)) return node;
    } catch {
      return null;
    }
  }
  return null;
}

/** True when `el` lives under an open shadow root (not in the light document). */
export function isInsideShadow(el: Element): boolean {
  return el.getRootNode() instanceof ShadowRoot;
}
