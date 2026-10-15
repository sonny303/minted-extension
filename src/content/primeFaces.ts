/** Narrow support for PrimeFaces SelectOneMenu's native backing select. The
 * focus input is not the value-bearing control, while the backing select is
 * intentionally aria-hidden and must be reviewed through its visible widget. */
export interface PrimeFacesSelectMenu {
  wrapper: HTMLElement;
  select: HTMLSelectElement;
  focusInput: HTMLInputElement | null;
}

export function primeFacesSelectMenu(el: Element): PrimeFacesSelectMenu | null {
  const wrapper = el.closest<HTMLElement>('.ui-selectonemenu[role="combobox"]');
  if (!wrapper) return null;
  const select = wrapper.querySelector<HTMLSelectElement>('select[id$="_input"]');
  if (!select) return null;
  const focusInput = wrapper.querySelector<HTMLInputElement>('input[id$="_focus"]');
  if (el !== select && el !== focusInput) return null;
  return { wrapper, select, focusInput };
}

export function isPrimeFacesFocusInput(el: Element): boolean {
  const menu = primeFacesSelectMenu(el);
  return Boolean(menu && el === menu.focusInput);
}

/** PrimeFaces SelectManyMenu (PrimeFaces 10 `SelectManyMenuRenderer`): a
 * `<select multiple>` parked 0×0 inside `.ui-helper-hidden-accessible`, drawn
 * as a list of `.ui-selectlistbox-item`s the person clicks. The select is the
 * value-bearing control (it is what the form posts); the list is what a person
 * sees. Only the select itself resolves — never the list or its filter box. */
export interface PrimeFacesSelectManyMenu {
  wrapper: HTMLElement;
  select: HTMLSelectElement;
}

export function primeFacesSelectManyMenu(el: Element): PrimeFacesSelectManyMenu | null {
  if (!(el instanceof HTMLSelectElement) || !el.multiple) return null;
  const wrapper = el.closest<HTMLElement>(".ui-selectmanymenu");
  if (!wrapper || wrapper.querySelector("select[multiple]") !== el) return null;
  return { wrapper, select: el };
}

/** The widget a person actually sees for a PrimeFaces backing select — what
 * visibility, reading order, and nearby captions are judged by. Null for
 * anything else. */
export function primeFacesWidget(el: Element): HTMLElement | null {
  if (!(el instanceof HTMLSelectElement)) return null;
  return primeFacesSelectMenu(el)?.wrapper ?? primeFacesSelectManyMenu(el)?.wrapper ?? null;
}

/** The backing select a node INSIDE a PrimeFaces menu widget stands for: a
 * click on a SelectManyMenu's list item, or on a SelectOneMenu's label, means
 * that menu's field. Null outside both widgets. */
export function primeFacesBackingSelect(node: Element): HTMLSelectElement | null {
  const many = node.closest(".ui-selectmanymenu")?.querySelector("select[multiple]");
  if (many instanceof HTMLSelectElement && primeFacesSelectManyMenu(many)) return many;
  const one = node.closest('.ui-selectonemenu[role="combobox"]')?.querySelector('select[id$="_input"]');
  return one instanceof HTMLSelectElement && primeFacesSelectMenu(one) ? one : null;
}

/** A SelectManyMenu's filter box (`filter="true"`) narrows the list on screen;
 * it bears no value and is not a field. */
export function isPrimeFacesListFilter(el: Element): boolean {
  return el instanceof HTMLInputElement &&
    el.classList.contains("ui-selectlistbox-filter") &&
    el.closest(".ui-selectmanymenu") != null;
}

export interface PrimeFacesListItem {
  item: HTMLElement;
  option: HTMLOptionElement;
}

const collapse = (text: string | null): string => (text ?? "").replace(/\s+/g, " ").trim();

/** Each visible item paired with the option it stands for. PrimeFaces 10 gives
 * items no value attribute — the widget maps item i to option i
 * (`options.eq(item.index())`) — so that index is the only bridge. Null when
 * the pairing can't be trusted (counts differ, or an item's text isn't its
 * option's, as with custom `var` column content): a wrong pair would click a
 * different answer than the one asked for. */
export function primeFacesListItems(menu: PrimeFacesSelectManyMenu): PrimeFacesListItem[] | null {
  const items = Array.from(
    menu.wrapper.querySelectorAll<HTMLElement>(".ui-selectlistbox-listcontainer .ui-selectlistbox-item"),
  );
  const options = Array.from(menu.select.options);
  if (items.length === 0 || items.length !== options.length) return null;
  const pairs: PrimeFacesListItem[] = [];
  for (const [index, item] of items.entries()) {
    const option = options[index] as HTMLOptionElement;
    if (collapse(item.textContent) !== collapse(option.text)) return null;
    pairs.push({ item, option });
  }
  return pairs;
}

/** Chosen as the widget shows it AND as the form will post it. */
export function isListItemChosen({ item, option }: PrimeFacesListItem): boolean {
  return option.selected && item.classList.contains("ui-state-highlight");
}

/** With `metaKeySelection="false"` every click clears the other choices first
 * (unless `showCheckbox` makes clicks toggle). PrimeFaces writes that flag into
 * the widget's init script (`<clientId>_s`) only when it is off. */
export function listClickClearsOthers(menu: PrimeFacesSelectManyMenu): boolean {
  const script = menu.wrapper.id
    ? menu.wrapper.ownerDocument.getElementById(`${menu.wrapper.id}_s`)?.textContent ?? ""
    : "";
  return /metaKeySelection\s*:\s*false/.test(script) && !/showCheckbox\s*:\s*true/.test(script);
}

/** Toggle one item the way a person adds to a multi-selection: a ctrl-click.
 * A plain click would make it the ONLY choice (`unselectAll` first). */
export function toggleListItem(item: HTMLElement): void {
  item.dispatchEvent(new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: true,
  }));
}
