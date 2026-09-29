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
