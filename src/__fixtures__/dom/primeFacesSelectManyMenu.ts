/**
 * PrimeFaces 10.0.0 SelectManyMenu, as BCBSKS's Network Enrollment Form serves
 * it (PrimeFaces 10.0.0 per the page's resource URLs).
 *
 * Provenance: the widget only renders after an AJAX reveal (Degree = APRN, CNS,
 * LCPC, LCP, LMFT, LMLP, LMSW or LPC), so it is absent from the page's static
 * HTML. The markup below is what `SelectManyMenuRenderer` 10.0.0 emits
 * (`encodeMarkup` / `encodeInput` / `encodeList` / `encodeItem`), with the
 * label wired the way that page wires every other `p:outputLabel` and the 40
 * options recorded on the live page on 2026-10-14
 * (form-captures/bcbs-ks-enrollment-1514e1bd8cbc.template-diff.md).
 * `wireSelectManyMenu` ports the widget's click handler
 * (`forms.selectmanymenu.js` 10.0.0) to plain DOM.
 */

/** [code, area] — value = code; label = `<code> - <area>`. Spellings are the payer's. */
export const BCBSKS_BEHAVIORAL_AREAS: ReadonlyArray<readonly [string, string]> = [
  ["A01", "ATTENTION DEFICIT DISORDER (ADD/ADHD)"],
  ["A02", "ADOPTION"],
  ["A03", "ANXIETY AND PANIC DISORDERS"],
  ["A04", "AUTISM SPECTRUM DISORDERS (AUTISM/PDD/ASPERGERS)"],
  ["A05", "BARIATRIC ASSESSMENT (add'l form here)"],
  ["A06", "BEHAVIOR MODIFICATION"],
  ["A07", "BIPOLAR DISORDERS/MANIC DEPRESSIVE ILLINESS"],
  ["A08", "CHEMICAL DEPENDENCY/CHEMICAL DEPENDENCY ASSESSMENT"],
  ["A09", "CHRISTIAN COUNSELING"],
  ["A10", "COMPULSIVE GAMBLING"],
  ["A11", "CULTURAL/ETHNIC ISSUES"],
  ["A12", "DEPRESSION"],
  ["A13", "DIALECTICAL BEHAVIORAL THERAPY (DBT)"],
  ["A14", "DIVORCE/BLENDED FAMILY ISSUES"],
  ["A15", "BEHAVIORAL THERAPY FOR AUTISM SPECTRUM DISORDERS"],
  ["A16", "EATING DISORDERS"],
  ["A17", "ELECTROCONVULSIVE THERPAY (ECT)"],
  ["A18", "FAMILY THERAPY"],
  ["A19", "GAY/LESBIAN/BISEXUAL ISSUES"],
  ["A20", "GROUP THERAPY"],
  ["A21", "HIV/AIDS RELATED ISSUES"],
  ["A22", "INFERTILITY"],
  ["A23", "MEDICATION MANAGEMENT"],
  ["A24", "MENS ISSUES"],
  ["A25", "NEUROPSYCHOLOGICAL TESTING"],
  ["A26", "OBSESSIVE COMPULSIVIE DISORDERS"],
  ["A27", "PAIN MANAGEMENT"],
  ["A28", "PERSONALITY DISORDERS"],
  ["A29", "PSYCHOLOGICAL TESTING"],
  ["A30", "SCHIZOPHRENIC DISORDERS"],
  ["A31", "TRANSGENDER ISSUES"],
  ["A32", "SEXUAL DISORDERS"],
  ["A33", "ABUSE, ASSAULT AND TRAUMA (PTSD)"],
  ["A34", "PRENATAL ISSUES"],
  ["A35", "WOMENS ISSUES"],
  ["A36", "POSTPARTUM ISSUES"],
  ["A37", "BRIEF SOLUTION FOCUSED"],
  ["A38", "END OF LIFE ISSUES"],
  ["A39", "GERIATRICS"],
  ["A40", "COGNITIVE BEHAVIORAL THERAPY (CBT)"],
];

export const BCBSKS_AREAS_ID = "networkEnrollmentForm:BehavioralAreasOfExpertise";
export const BCBSKS_AREAS_SELECTOR = "#networkEnrollmentForm\\:BehavioralAreasOfExpertise_input";
export const BCBSKS_AREAS_LABEL = "Behavioral health provider areas of expertise (select up to 10 areas)";

export interface SelectManyMenuOptions {
  id?: string;
  /** `p:outputLabel` text; null renders no label element at all. */
  label?: string | null;
  options?: ReadonlyArray<readonly [string, string]>;
  /** Codes rendered pre-selected (`ui-state-highlight` + `selected`). */
  selected?: readonly string[];
  /** Codes rendered disabled (`ui-state-disabled` + `disabled`). */
  disabled?: readonly string[];
  filter?: boolean;
  showCheckbox?: boolean;
  /** `metaKeySelection="false"`: PrimeFaces writes it into the init script. */
  metaKeySelection?: boolean;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `<label>` + widget + init script, exactly as the 10.0.0 renderer lays them out. */
export function selectManyMenuMarkup(config: SelectManyMenuOptions = {}): string {
  const id = config.id ?? BCBSKS_AREAS_ID;
  const label = config.label === undefined ? BCBSKS_AREAS_LABEL : config.label;
  const options = config.options ?? BCBSKS_BEHAVIORAL_AREAS;
  const selected = new Set(config.selected ?? []);
  const disabled = new Set(config.disabled ?? []);
  const labelId = `${id.split(":")[0]}:j_id_3z`;
  const text = ([code, area]: readonly [string, string]): string => escapeHtml(`${code} - ${area}`);
  const checkbox = (on: boolean): string => config.showCheckbox
    ? `<div class="ui-chkbox ui-widget"><div class="ui-chkbox-box ui-widget ui-corner-all ui-state-default${on ? " ui-state-active" : ""}"><span class="ui-chkbox-icon ui-c ${on ? "ui-icon ui-icon-check" : "ui-icon ui-icon-blank"}"></span></div></div>`
    : "";
  const optionTags = options.map((option) =>
    `<option value="${escapeHtml(option[0])}"${disabled.has(option[0]) ? ' disabled="disabled"' : ""}${selected.has(option[0]) ? ' selected="selected"' : ""}>${text(option)}</option>`,
  ).join("");
  const itemTags = options.map((option) => {
    const on = selected.has(option[0]);
    const classes = ["ui-selectlistbox-item ui-corner-all", disabled.has(option[0]) ? "ui-state-disabled" : "", on ? "ui-state-highlight" : ""]
      .filter(Boolean).join(" ");
    return `<li class="${classes}">${checkbox(on)}${text(option)}</li>`;
  }).join("");
  const filter = config.filter
    ? `<div class="ui-selectlistbox-filter-container"><span class="ui-icon ui-icon-search"></span><input class="ui-selectlistbox-filter ui-inputfield ui-widget ui-state-default ui-corner-all" id="${id}_filter" name="${id}_filter" type="text" autocomplete="off" aria-label="Filter" /></div>`
    : "";
  const cfg = [
    `id:"${id}"`,
    ...(config.showCheckbox ? ["showCheckbox:true"] : []),
    ...(config.metaKeySelection === false ? ["metaKeySelection:false"] : []),
    ...(config.filter ? ['filter:true', 'filterMatchMode:"contains"'] : []),
  ].join(",");
  return [
    `<div id="${id.split(":")[0]}:j_id_3y" class="ui-outputpanel ui-widget">`,
    label === null
      ? ""
      : `<label id="${labelId}" class="ui-outputlabel ui-widget" style="font-weight: bold" for="${id}_input">${escapeHtml(label)}<span class="ui-outputlabel-rfi">*</span></label>`,
    `<div id="${id}" class="ui-selectmanymenu ui-inputfield ui-widget ui-widget-content ui-corner-all">`,
    filter,
    `<div class="ui-helper-hidden-accessible">`,
    `<select id="${id}_input" name="${id}_input" multiple="multiple" size="2" aria-required="true"${label === null ? "" : ` aria-labelledby="${labelId}"`}>${optionTags}</select>`,
    `</div>`,
    `<div class="ui-selectlistbox-listcontainer" style="height:${options.length > 10 ? "200px" : "auto"}">`,
    `<ul class="ui-selectlistbox-list">${itemTags}</ul>`,
    `</div>`,
    `</div>`,
    `<script id="${id}_s" type="text/javascript">$(function(){PrimeFaces.cw("SelectManyMenu","widget_${id.replace(/:/g, "_")}",{${cfg}});});</script>`,
    `</div>`,
  ].join("");
}

/** Port of `PrimeFaces.widget.SelectManyMenu`'s item click handler (10.0.0):
 * a plain click makes the item the ONLY choice; a ctrl/meta click (when
 * `metaKeySelection` is on) or any click with `showCheckbox` toggles it.
 * Items map to options by index. Returns the change-event count. */
export function wireSelectManyMenu(
  wrapper: HTMLElement,
  cfg: { metaKeySelection?: boolean; showCheckbox?: boolean } = {},
): { changes: () => number } {
  const metaKeySelection = cfg.metaKeySelection ?? true;
  const select = wrapper.querySelector<HTMLSelectElement>("select[multiple]")!;
  const allItems = Array.from(wrapper.querySelectorAll<HTMLElement>(".ui-selectlistbox-item"));
  const items = allItems.filter((item) => !item.classList.contains("ui-state-disabled"));
  const options = () => Array.from(select.options);
  const selectItem = (item: HTMLElement): void => {
    item.classList.add("ui-state-highlight");
    item.classList.remove("ui-state-hover");
    options()[allItems.indexOf(item)]!.selected = true;
  };
  const unselectItem = (item: HTMLElement): void => {
    item.classList.remove("ui-state-highlight");
    options()[allItems.indexOf(item)]!.selected = false;
  };
  const unselectAll = (): void => {
    for (const item of items) item.classList.remove("ui-state-highlight");
    for (const option of options()) option.selected = false;
  };
  let changes = 0;
  for (const item of items) {
    item.addEventListener("click", (event) => {
      const metaKey = metaKeySelection && (event.metaKey || event.ctrlKey);
      if (!metaKey && !cfg.showCheckbox) unselectAll();
      if ((metaKey || cfg.showCheckbox) && item.classList.contains("ui-state-highlight")) unselectItem(item);
      else selectItem(item);
      changes += 1;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      event.preventDefault();
    });
  }
  return { changes: () => changes };
}

/** The codes the FORM would post (option.selected), in order. */
export function postedCodes(wrapper: Element): string[] {
  const select = wrapper.querySelector<HTMLSelectElement>("select[multiple]")!;
  return Array.from(select.selectedOptions).map((option) => option.value);
}

/** The codes the WIDGET shows as chosen, in order. */
export function highlightedCodes(wrapper: Element): string[] {
  const select = wrapper.querySelector<HTMLSelectElement>("select[multiple]")!;
  const options = Array.from(select.options);
  return Array.from(wrapper.querySelectorAll(".ui-selectlistbox-item"))
    .flatMap((item, index) => (item.classList.contains("ui-state-highlight") ? [options[index]!.value] : []));
}
