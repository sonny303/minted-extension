/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { applyFill, applyFillOnPage, applyFillSettled, clearPortalForm, probeFillOnPage } from "./fillEngine";
import { describeSelectorMatches } from "./elementPicker";
import type { FillInstruction } from "../shared/fill";
import { OTHER_PAGE_KIND, OTHER_PAGE_REASON, PAGE_UNKNOWN_KIND, PAGE_UNKNOWN_REASON } from "../shared/fillPage";
import { HIDDEN_KIND, HIDDEN_REASON } from "../shared/hiddenField";
import { FIELD_NOT_FOUND_REASON } from "../shared/fixit";
import { createFillEventV2OpaqueKey } from "../shared/fillEventV2";
import { buildDateReversionFixture } from "../__fixtures__/dom/portalScenarios";
import {
  BCBSKS_AREAS_ID,
  BCBSKS_AREAS_SELECTOR,
  highlightedCodes,
  postedCodes,
  selectManyMenuMarkup,
  wireSelectManyMenu,
} from "../__fixtures__/dom/primeFacesSelectManyMenu";

// jsdom does not provide CSS.escape; applyRadio uses it to scope a NAMED radio
// group. Same shim the captureScan and elementPicker suites already carry —
// without it, every named-group radio path throws instead of applying.
if (typeof CSS === "undefined" || typeof CSS.escape !== "function") {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: {
      escape(value: string): string {
        return String(value).replace(/([^\w-])/g, "\\$1");
      },
    },
  });
}

function instr(
  over: Partial<FillInstruction> & Pick<FillInstruction, "label" | "selector">,
): FillInstruction {
  return {
    mapId: over.mapId ?? "m1",
    label: over.label,
    selector: over.selector,
    selectorFallbacks: over.selectorFallbacks ?? [],
    fieldType: over.fieldType ?? "text",
    value: over.value ?? "Ada",
    pageStep: over.pageStep ?? null,
    ...(over.probeKey ? { probeKey: over.probeKey } : {}),
    ...(over.telemetry ? { telemetry: over.telemetry } : {}),
    ...(over.nativeDateValue ? { nativeDateValue: over.nativeDateValue } : {}),
    ...(over.exactSelectValue ? { exactSelectValue: true } : {}),
    ...(over.pageUrlScope !== undefined ? { pageUrlScope: over.pageUrlScope } : {}),
    ...(over.resolvedPage ? { resolvedPage: over.resolvedPage } : {})
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("applyFill", () => {
  it("fills by label: selector (exact match after normalize)", () => {
    document.body.innerHTML = `
      <label>First Name <input id="fn" type="text" /></label>
      <label>Provider's First Name <input id="pfn" type="text" /></label>
    `;
    const result = applyFill([
      instr({
        label: "First Name",
        selector: "label:First Name",
        value: "Ada",
      }),
    ]);
    expect(result.filled).toEqual(["First Name"]);
    expect((document.getElementById("fn") as HTMLInputElement).value).toBe(
      "Ada",
    );
    expect((document.getElementById("pfn") as HTMLInputElement).value).toBe("");
  });

  it("fills by CSS selector and reports not-found with the pinned reason", () => {
    document.body.innerHTML = `<input id="npi" type="text" />`;
    const hit = applyFill([
      instr({ label: "NPI", selector: "#npi", value: "123" }),
    ]);
    expect(hit.filled).toEqual(["NPI"]);
    expect((document.getElementById("npi") as HTMLInputElement).value).toBe(
      "123",
    );

    const miss = applyFill([
      instr({ label: "Missing", selector: "#gone", value: "x" }),
    ]);
    expect(miss.filled).toEqual([]);
    expect(miss.skipped).toEqual([
      {
        label: "Missing",
        reason: "field not found on this page",
        mapId: "m1",
        kind: "skipped",
      },
    ]);
  });

  it("uses selectorFallbacks when the primary selector misses", () => {
    document.body.innerHTML = `<input id="alt" type="text" />`;
    const result = applyFill([
      instr({
        label: "Alt",
        selector: "#missing",
        selectorFallbacks: ["#alt"],
        value: "ok",
      }),
    ]);
    expect(result.filled).toEqual(["Alt"]);
    expect((document.getElementById("alt") as HTMLInputElement).value).toBe(
      "ok",
    );
  });

  it("reports exact other-page maps without writing them (DYN-PAGE-01)", () => {
    document.body.innerHTML = `
      <input id="npi" type="text" />
      <input id="tin" type="text" />
    `;
    const result = applyFillOnPage(
      [
        instr({
          label: "NPI",
          selector: "#npi",
          value: "123",
          pageStep: "credentials",
          mapId: "m-npi",
        }),
        instr({
          label: "TIN",
          selector: "#tin",
          value: "99",
          pageStep: "tax-id",
          mapId: "m-tin",
        }),
      ],
      "https://payer.example/enroll/credentials",
    );
    expect(result.filled).toEqual(["NPI"]);
    expect((document.getElementById("npi") as HTMLInputElement).value).toBe("123");
    expect((document.getElementById("tin") as HTMLInputElement).value).toBe("");
    expect(result.skipped).toEqual([
      {
        label: "TIN",
        reason: OTHER_PAGE_REASON,
        mapId: "m-tin",
        kind: OTHER_PAGE_KIND,
      },
    ]);
  });

  it("applies a Nano-learned mapping only on its canonical origin and path", () => {
    document.body.innerHTML = '<input id="field" type="text" />';
    const scoped = instr({
      label: "First name",
      selector: "#field",
      value: "Ada",
      pageUrlScope: "https://portal.example/provider",
    });

    const samePage = applyFillOnPage([scoped], "https://portal.example/provider?case=private#step");
    expect(samePage.writes).toEqual([{ selector: "#field", kind: "static" }]);
    expect((document.querySelector("#field") as HTMLInputElement).value).toBe("Ada");

    document.body.innerHTML = '<input id="field" type="text" />';
    const differentPath = applyFillOnPage([scoped], "https://portal.example/billing");
    expect(differentPath.writes).toEqual([]);
    expect(differentPath.skipped[0]?.kind).toBe("other_page");
    expect((document.querySelector("#field") as HTMLInputElement).value).toBe("");

    document.body.innerHTML = '<input id="field" type="text" />';
    const differentOrigin = applyFillOnPage([scoped], "https://other.example/provider");
    expect(differentOrigin.writes).toEqual([]);
    expect((document.querySelector("#field") as HTMLInputElement).value).toBe("");
  });

  it("withholds all nonempty step-bound maps when page identity is ambiguous", () => {
    document.body.innerHTML = `<input id="npi" type="text" />`;
    const result = applyFillOnPage(
      [
        instr({
          label: "NPI",
          selector: "#npi",
          value: "1",
          pageStep: "credentials",
        }),
        instr({
          label: "TIN",
          selector: "#gone",
          value: "2",
          pageStep: "Page 2",
          mapId: "m-tin",
        }),
      ],
      "https://payer.example/enroll/unknown-step",
    );
    expect(result.filled).toEqual([]);
    expect(result.skipped).toEqual([
      {
        label: "NPI",
        reason: PAGE_UNKNOWN_REASON,
        mapId: "m1",
        kind: PAGE_UNKNOWN_KIND,
      },
      {
        label: "TIN",
        reason: PAGE_UNKNOWN_REASON,
        mapId: "m-tin",
        kind: PAGE_UNKNOWN_KIND,
      },
    ]);
    expect((document.getElementById("npi") as HTMLInputElement).value).toBe("");
  });

  it("withholds sequence-bound maps when page identity is unknown", () => {
    document.body.innerHTML = `<input id="legacy" type="text" />`;
    const result = applyFillOnPage(
      [instr({ label: "Legacy", selector: "#legacy", pageStep: "Page 2" })],
      "https://payer.example/enroll/unknown-step",
    );
    expect(result.filled).toEqual([]);
    expect((document.getElementById("legacy") as HTMLInputElement).value).toBe("");
    expect(result.skipped[0]?.kind).toBe(PAGE_UNKNOWN_KIND);
  });

  it("revalidates one visible target immediately before writing", () => {
    document.body.innerHTML = `<div style="display:none"><input id="same" /></div><input id="same" />`;
    const result = applyFill([
      instr({ label: "Field", selector: "#same", value: "safe" }),
    ]);
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("#same"));
    expect(result.filled).toEqual(["Field"]);
    expect(inputs.map((input) => input.value)).toEqual(["", "safe"]);
  });

  it("declines a newly ambiguous target instead of relying on query order", () => {
    document.body.innerHTML = `<input id="same" /><input id="same" />`;
    const result = applyFill([
      instr({ label: "Field", selector: "#same", value: "unsafe" }),
    ]);
    expect(result.filled).toEqual([]);
    expect(Array.from(document.querySelectorAll<HTMLInputElement>("#same")).map((input) => input.value)).toEqual(["", ""]);
    expect(result.skipped[0]?.kind).toBe("no_mapping");
  });

  it("does not classify Page N maps as other_page even on a known URL page", () => {
    document.body.innerHTML = `<input id="legacy" type="text" />`;
    const result = applyFillOnPage(
      [
        instr({
          label: "Legacy",
          selector: "#legacy",
          value: "ok",
          pageStep: "Page 1",
        }),
        instr({
          label: "On page",
          selector: "#missing-on-page",
          value: "x",
          pageStep: "credentials",
          mapId: "m-on",
        }),
      ],
      "https://payer.example/enroll/credentials",
    );
    // Page 1 is ambiguous → attempted; credentials on credentials → attempted.
    expect(result.filled).toEqual(["Legacy"]);
    expect(result.skipped).toEqual([
      {
        label: "On page",
        reason: FIELD_NOT_FOUND_REASON,
        mapId: "m-on",
        kind: "skipped",
      },
    ]);
  });

  // DYN-PAGE-02 — a wizard that keeps every step in the DOM and hides the
  // inactive ones. Writing into one is silent and survives into a submission.
  describe("hidden controls (DYN-PAGE-02)", () => {
    it("never writes a control inside a display:none panel", () => {
      document.body.innerHTML = `
        <div id="step1"><input id="npi" type="text" /></div>
        <div id="step2" style="display:none"><input id="tin" type="text" /></div>
      `;
      const result = applyFill([
        instr({ label: "NPI", selector: "#npi", value: "123" }),
        instr({ label: "TIN", selector: "#tin", value: "99", mapId: "m-tin" }),
      ]);
      expect(result.filled).toEqual(["NPI"]);
      expect((document.getElementById("tin") as HTMLInputElement).value).toBe(
        "",
      );
      expect(result.skipped).toEqual([
        {
          label: "TIN",
          reason: HIDDEN_REASON,
          mapId: "m-tin",
          kind: HIDDEN_KIND,
        },
      ]);
    });

    it("treats [hidden], [aria-hidden] and visibility:hidden the same way", () => {
      document.body.innerHTML = `
        <div hidden><input id="a" type="text" /></div>
        <div aria-hidden="true"><input id="b" type="text" /></div>
        <div style="visibility:hidden"><input id="c" type="text" /></div>
      `;
      const result = applyFill([
        instr({ label: "A", selector: "#a", value: "1" }),
        instr({ label: "B", selector: "#b", value: "2" }),
        instr({ label: "C", selector: "#c", value: "3" }),
      ]);
      expect(result.filled).toEqual([]);
      expect(result.skipped.map((s) => s.kind)).toEqual([
        HIDDEN_KIND,
        HIDDEN_KIND,
        HIDDEN_KIND,
      ]);
      for (const id of ["a", "b", "c"]) {
        expect((document.getElementById(id) as HTMLInputElement).value).toBe(
          "",
        );
      }
    });

    it("does not write a hidden select or checkbox either", () => {
      document.body.innerHTML = `
        <div style="display:none">
          <select id="st"><option value="">--</option><option value="KS">KS</option></select>
          <input id="agree" type="checkbox" />
        </div>
      `;
      const result = applyFill([
        instr({
          label: "State",
          selector: "#st",
          fieldType: "select",
          value: "KS",
        }),
        instr({
          label: "Agree",
          selector: "#agree",
          fieldType: "checkbox",
          value: "yes",
        }),
      ]);
      expect(result.filled).toEqual([]);
      expect((document.getElementById("st") as HTMLSelectElement).value).toBe(
        "",
      );
      expect(
        (document.getElementById("agree") as HTMLInputElement).checked,
      ).toBe(false);
      expect(result.skipped.map((s) => s.reason)).toEqual([
        HIDDEN_REASON,
        HIDDEN_REASON,
      ]);
    });

    // A radio group is ONE field made of N controls, and the member that gets
    // clicked need not be the one the selector resolved to. Guarding the
    // resolved element instead would skip a perfectly visible answer.
    it("guards the radio option it is about to click, not the resolved one", () => {
      document.body.innerHTML = `
        <div style="display:none">
          <input id="r-no" type="radio" name="ptn" value="No" />
        </div>
        <div>
          <input id="r-yes" type="radio" name="ptn" value="Yes" />
        </div>
      `;
      const result = applyFill([
        instr({
          label: "Accepting patients",
          selector: "#r-no",
          fieldType: "radio",
          value: "Yes",
        }),
      ]);
      expect(result.filled).toEqual(["Accepting patients"]);
      expect(
        (document.getElementById("r-yes") as HTMLInputElement).checked,
      ).toBe(true);
    });

    it("skips when the matching radio option is the hidden one", () => {
      document.body.innerHTML = `
        <div style="display:none">
          <input id="r-no" type="radio" name="ptn" value="No" />
        </div>
        <div><input id="r-yes" type="radio" name="ptn" value="Yes" /></div>
      `;
      const result = applyFill([
        instr({
          label: "Accepting patients",
          selector: "#r-yes",
          fieldType: "radio",
          value: "No",
          mapId: "m-ptn",
        }),
      ]);
      expect(result.filled).toEqual([]);
      expect(
        (document.getElementById("r-no") as HTMLInputElement).checked,
      ).toBe(false);
      expect(result.skipped).toEqual([
        {
          label: "Accepting patients",
          reason: HIDDEN_REASON,
          mapId: "m-ptn",
          kind: HIDDEN_KIND,
        },
      ]);
    });

    // The whole point of a separate reason: the selector RESOLVED. Reporting
    // not-found would send a trainer to re-map a working selector.
    it("is reported distinctly from not-found and from other_page", () => {
      expect(HIDDEN_REASON).toBe("field is hidden on this page");
      expect(HIDDEN_KIND).toBe("hidden");
      expect(
        new Set([HIDDEN_REASON, FIELD_NOT_FOUND_REASON, OTHER_PAGE_REASON])
          .size,
      ).toBe(3);
      expect(new Set([HIDDEN_KIND, "skipped", OTHER_PAGE_KIND]).size).toBe(3);
    });

    it("still fills a zero-size but displayed control — layout is not the rule", () => {
      // The scanner drops zero-box controls as list noise; the FILL must not,
      // or a coordinator waits on a field the extension silently declined.
      document.body.innerHTML = `<input id="tiny" type="text" style="width:0;height:0" />`;
      const result = applyFill([
        instr({ label: "Tiny", selector: "#tiny", value: "ok" }),
      ]);
      expect(result.filled).toEqual(["Tiny"]);
      expect((document.getElementById("tiny") as HTMLInputElement).value).toBe(
        "ok",
      );
    });
  });

  it("skips disabled/readonly and file inputs", () => {
    document.body.innerHTML = `
      <input id="ro" type="text" readonly />
      <input id="file" type="file" />
    `;
    const result = applyFill([
      instr({ label: "RO", selector: "#ro", value: "x" }),
      instr({
        label: "File",
        selector: "#file",
        fieldType: "file",
        value: "x",
      }),
    ]);
    expect(result.filled).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "field is disabled or read-only",
      "file inputs cannot be filled",
    ]);
  });

  it("applies select by option text and checkbox by truthy value", () => {
    document.body.innerHTML = `
      <select id="st"><option value="KS">Kansas</option><option value="MO">Missouri</option></select>
      <input id="cb" type="checkbox" />
    `;
    const result = applyFill([
      instr({
        label: "State",
        selector: "#st",
        fieldType: "select",
        value: "Missouri",
      }),
      instr({
        label: "Agree",
        selector: "#cb",
        fieldType: "checkbox",
        value: "yes",
      }),
    ]);
    expect(result.filled).toEqual(["State", "Agree"]);
    expect((document.getElementById("st") as HTMLSelectElement).value).toBe(
      "MO",
    );
    expect((document.getElementById("cb") as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("writes native date inputs in canonical ISO even when the display shape is different", () => {
    document.body.innerHTML = `<input id="start-date" type="date" />`;
    const result = applyFill([
      instr({
        label: "Start date",
        selector: "#start-date",
        fieldType: "date",
        value: "02/02/2025",
        nativeDateValue: "2025-02-02",
      }),
    ]);
    expect(result.filled).toEqual(["Start date"]);
    expect(document.querySelector<HTMLInputElement>("#start-date")?.value).toBe("2025-02-02");
  });

  it("feeds PrimeFaces datepicker's keydown-gated input model before blur", () => {
    document.body.innerHTML = `<span class="p-datepicker ui-calendar"><input id="effective-date" type="text" /></span>`;
    const input = document.querySelector<HTMLInputElement>("#effective-date")!;
    let keydownSeen = false;
    let modelValue = "";
    input.addEventListener("keydown", () => { keydownSeen = true; });
    input.addEventListener("input", () => {
      if (!keydownSeen) return;
      keydownSeen = false;
      modelValue = input.value;
    });
    input.addEventListener("blur", () => { input.value = modelValue; });

    const result = applyFill([
      instr({ label: "Effective date", selector: "#effective-date", fieldType: "date", value: "02/02/2026" }),
    ]);
    expect(result.filled).toEqual(["Effective date"]);
    expect(input.value).toBe("02/02/2026");
    expect(modelValue).toBe("02/02/2026");
  });

  it("selects a taxonomy code from a lazy PrimeFaces menu beyond the capture option cap", async () => {
    const targetCode = "251B00000X";
    const options = Array.from({ length: 856 }, (_, index) => {
      const code = index === 650 ? targetCode : `code-${String(index).padStart(4, "0")}`;
      return `<option value="${code}">${code}</option>`;
    }).join("");
    document.body.innerHTML = `
      <div id="taxonomy" class="ui-selectonemenu" role="combobox">
        <span class="ui-selectonemenu-label">Select One</span>
        <span class="ui-selectonemenu-trigger"></span>
        <input id="taxonomy_focus" type="text" aria-label="Taxonomy" />
        <select id="taxonomy_input" aria-hidden="true" aria-label="Taxonomy"><option value="">Select One</option>${options}</select>
      </div>
      <div id="taxonomy_panel" class="ui-selectonemenu-panel" style="display:none"><ul id="taxonomy_items"></ul></div>
    `;
    const select = document.querySelector<HTMLSelectElement>("#taxonomy_input")!;
    const wrapper = document.querySelector<HTMLElement>("#taxonomy")!;
    const label = wrapper.querySelector<HTMLElement>(".ui-selectonemenu-label")!;
    const panel = document.querySelector<HTMLElement>("#taxonomy_panel")!;
    wrapper.querySelector<HTMLElement>(".ui-selectonemenu-trigger")!.addEventListener("click", () => {
      panel.style.display = "block";
      panel.querySelector("ul")!.innerHTML = Array.from(select.options)
        .filter((option) => option.value)
        .map((option) => `<li class="ui-selectonemenu-item" role="option" data-label="${option.text}">${option.text}</li>`)
        .join("");
      panel.querySelectorAll<HTMLElement>(".ui-selectonemenu-item").forEach((item) => {
        item.addEventListener("click", () => {
          select.value = item.textContent ?? "";
          label.textContent = item.textContent;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
      });
    });

    const result = await applyFillSettled([
      instr({ label: "Taxonomy", selector: "#taxonomy_focus", fieldType: "select", value: targetCode, exactSelectValue: true }),
    ]);
    expect(select.value).toBe(targetCode);
    expect(label.textContent).toBe(targetCode);
    expect(result.filled).toEqual(["Taxonomy"]);
    expect(result.skipped).toEqual([]);
    expect(result.fieldOutcomes).toEqual([]);
  });

  it("keeps regular field success and value-free reporting when a PrimeFaces click throws", async () => {
    document.body.innerHTML = `
      <input id="name" type="text" />
      <div id="taxonomy" class="ui-selectonemenu" role="combobox">
        <span class="ui-selectonemenu-label">Select One</span><span class="ui-selectonemenu-trigger"></span>
        <input id="taxonomy_focus" type="text" aria-label="Taxonomy" />
        <select id="taxonomy_input" aria-hidden="true" aria-label="Taxonomy"><option value="">Select One</option><option value="code">code</option></select>
      </div>
    `;
    const secret = "provider-data-must-not-leak";
    document.querySelector<HTMLElement>("#taxonomy .ui-selectonemenu-trigger")!.click = () => { throw new Error(secret); };
    const result = await applyFillSettled([
      instr({ label: "Name", selector: "#name", value: "Ada" }),
      instr({ label: "Taxonomy", selector: "#taxonomy_focus", fieldType: "select", value: "code", exactSelectValue: true }),
    ]);
    expect(document.querySelector<HTMLInputElement>("#name")?.value).toBe("Ada");
    expect(result.filled).toContain("Name");
    expect(result.skipped).toContainEqual(expect.objectContaining({
      label: "Taxonomy",
      reason: "field could not be applied; review it on the portal",
      kind: "unverified",
    }));
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not report a date mask's delayed year corruption as filled", async () => {
    const fixture = buildDateReversionFixture();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      document.body.innerHTML = `<input id="effective-date" type="text" /><input id="same-label-other" type="text" />`;
      const date = document.querySelector<HTMLInputElement>("#effective-date")!;
      date.addEventListener("input", () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => { date.value = fixture.revertedValue; }, fixture.delayMs);
      });
      const result = await applyFillSettled([
        instr({ label: "Effective date", selector: "#effective-date", fieldType: "date", value: fixture.attemptedValue }),
        instr({ label: "Effective date", selector: "#same-label-other", value: "ok", mapId: "m-other" }),
      ]);
      expect(date.value).toBe("02/02/6100");
      expect(result.filled).toEqual(["Effective date"]);
      expect(result.writes?.map((write) => write.selector)).toEqual(["#same-label-other"]);
      expect(result.skipped).toContainEqual(expect.objectContaining({
        label: "Effective date",
        reason: "portal changed the date after fill; review this field on the portal",
        kind: "unverified",
      }));
      expect(JSON.stringify(result)).not.toContain("02/02/6100");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      fixture.dispose();
    }
  });

  it("checks a repeated date write even when the requested value was already present", async () => {
    const fixture = buildDateReversionFixture();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      document.body.innerHTML = `<input id="effective-date" type="text" value="${fixture.attemptedValue}" />`;
      const date = document.querySelector<HTMLInputElement>("#effective-date")!;
      date.addEventListener("input", () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => { date.value = fixture.revertedValue; }, fixture.delayMs);
      });
      const result = await applyFillSettled([
        instr({ label: "Effective date", selector: "#effective-date", fieldType: "date", value: fixture.attemptedValue }),
      ]);
      expect(date.value).toBe(fixture.revertedValue);
      expect(result.filled).toEqual([]);
      expect(result.skipped).toContainEqual(expect.objectContaining({
        label: "Effective date",
        kind: "unverified",
      }));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      fixture.dispose();
    }
  });

  it("shows an already-selected choice as not checked, not verified", () => {
    document.body.innerHTML = `<input id="agree" type="checkbox" checked />`;
    const result = applyFill([
      instr({ label: "Agree", selector: "#agree", fieldType: "checkbox", value: "yes" }),
    ]);
    expect(result.filled).toEqual(["Agree"]);
    expect(result.attemptedLabels).toEqual([]);
    expect(result.skipped).toEqual([{
      label: "Agree",
      reason: "field could not be verified; review it on the portal",
      mapId: "m1",
      kind: "unverified",
    }]);
    expect(result.fieldOutcomes).toEqual([]);
  });

  it("does not record or decorate controlled static fields that reject the target", () => {
    document.body.innerHTML = `
      <input id="name" type="text" />
      <select id="state"><option value="">Choose</option><option value="CO">Colorado</option><option value="NY">New York</option></select>
      <input id="agree" type="checkbox" />
    `;
    const name = document.querySelector<HTMLInputElement>("#name")!;
    const state = document.querySelector<HTMLSelectElement>("#state")!;
    const agree = document.querySelector<HTMLInputElement>("#agree")!;
    name.addEventListener("input", () => { name.value = ""; });
    state.addEventListener("change", () => { state.value = "NY"; });
    agree.addEventListener("click", () => { agree.checked = false; });

    const result = applyFill([
      instr({ label: "Name", selector: "#name", value: "Ada" }),
      instr({ label: "State", selector: "#state", fieldType: "select", value: "Colorado" }),
      instr({ label: "Agreement", selector: "#agree", fieldType: "checkbox", value: "yes" }),
    ]);

    expect(result.writes).toEqual([]);
    expect(result.filled).toEqual([]);
    expect(result.skipped).toHaveLength(3);
    expect(name.classList.contains("mp-fill-static")).toBe(false);
    expect(state.classList.contains("mp-fill-static")).toBe(false);
    expect(agree.classList.contains("mp-fill-static")).toBe(false);
  });

  it("reports an option mismatch without persisting the attempted or available values", () => {
    document.body.innerHTML = `
      <select id="st">
        <option value="">Select</option>
        <option value="KS">Kansas</option>
        <option value="MO">Missouri</option>
        <option value="NE">Nebraska</option>
        <option value="IA">Iowa</option>
      </select>
    `;
    const result = applyFill([
      instr({
        label: "State",
        selector: "#st",
        fieldType: "select",
        value: "Kansas",
      }),
    ]);
    // "Kansas" matches the option TEXT, so this path is the unmatched code.
    const miss = applyFill([
      instr({
        label: "State",
        selector: "#st",
        fieldType: "select",
        value: "Colorado",
      }),
    ]);
    expect(result.filled).toEqual(["State"]);
    expect(miss.skipped[0]?.reason).toBe("dropdown: no option matches the mapped value");
    expect(miss.skipped[0]?.reason).not.toContain("Colorado");
    expect(miss.skipped[0]?.reason).not.toContain("KS");
    expect(miss.skipped[0]?.reason).not.toBe("field not found on this page");
  });

  it("keeps selector-not-found wording distinct from a vocabulary miss", () => {
    document.body.innerHTML = `<select id="st"><option value="KS">Kansas</option></select>`;
    const gone = applyFill([
      instr({
        label: "State",
        selector: "#gone",
        fieldType: "select",
        value: "KS",
      }),
    ]);
    expect(gone.skipped).toEqual([
      {
        label: "State",
        reason: "field not found on this page",
        mapId: "m1",
        kind: "skipped",
      },
    ]);
  });

  it("counts page fields for coverage denominator", () => {
    document.body.innerHTML = `
      <input type="text" />
      <input type="hidden" />
      <select></select>
      <textarea></textarea>
      <input type="submit" />
    `;
    const result = applyFill([]);
    expect(result.pageFields).toBe(3);
  });
});

describe("probe-to-apply binding", () => {
  it("does not write to a replacement node with the same selector after probing", async () => {
    document.body.innerHTML = `<input id="target" />`;
    const probeKey = createFillEventV2OpaqueKey("t");
    const instruction = instr({
      label: "Field",
      selector: "#target",
      value: "synthetic",
      probeKey,
      telemetry: { targetKey: probeKey, frameKey: createFillEventV2OpaqueKey("f"), stepKey: null },
    });
    const probe = await probeFillOnPage([{
      mapId: instruction.mapId,
      probeKey,
      selector: instruction.selector,
      selectorFallbacks: [],
      fieldType: "text",
      pageStep: null,
    }]);
    expect(probe[0]?.targetStatus).toBe("unique");

    const oldTarget = document.querySelector<HTMLInputElement>("#target")!;
    const replacement = document.createElement("input");
    replacement.id = "target";
    oldTarget.replaceWith(replacement);
    const applied = applyFillOnPage([instruction], window.location.href, true);

    expect(replacement.value).toBe("");
    expect(applied.skipped[0]?.kind).toBe("unverified");
    expect(applied.fieldOutcomes?.[0]).toMatchObject({
      attempted: false,
      outcome: "unverified",
      reasonCode: "context_changed",
    });
  });

  it("rejects a replaced intended radio option even when the first group member remains", async () => {
    document.body.innerHTML = `
      <input id="first" type="radio" name="state" value="KS" />
      <input id="intended" type="radio" name="state" value="CO" />
    `;
    const probeKey = createFillEventV2OpaqueKey("t");
    const instruction = instr({
      label: "State",
      selector: 'input[type="radio"][name="state"]',
      fieldType: "radio",
      value: "CO",
      probeKey,
      telemetry: { targetKey: probeKey, frameKey: createFillEventV2OpaqueKey("f"), stepKey: null },
    });
    const probe = await probeFillOnPage([{
      mapId: instruction.mapId,
      probeKey,
      selector: instruction.selector,
      selectorFallbacks: [],
      fieldType: "radio",
      pageStep: null,
    }]);
    expect(probe[0]?.targetStatus).toBe("unique");

    const intended = document.querySelector<HTMLInputElement>("#intended")!;
    const replacement = document.createElement("input");
    replacement.id = "intended";
    replacement.type = "radio";
    replacement.name = "state";
    replacement.value = "CO";
    intended.replaceWith(replacement);
    const applied = applyFillOnPage([instruction], window.location.href, true);

    expect(document.querySelector<HTMLInputElement>("#first")!.checked).toBe(false);
    expect(replacement.checked).toBe(false);
    expect(applied.fieldOutcomes?.[0]).toMatchObject({
      attempted: false,
      outcome: "unverified",
      reasonCode: "context_changed",
    });
  });

  it("permits consecutive field writes with decoration without rejecting subsequent fields as context_changed", async () => {
    document.body.innerHTML = `
      <input id="first-name" type="text" />
      <input id="last-name" type="text" />
    `;
    const probeKey1 = createFillEventV2OpaqueKey("t");
    const probeKey2 = createFillEventV2OpaqueKey("t");
    const instr1 = instr({
      label: "First Name",
      selector: "#first-name",
      value: "Jane",
      mapId: "m-first",
      probeKey: probeKey1,
      telemetry: { targetKey: probeKey1, frameKey: createFillEventV2OpaqueKey("f"), stepKey: null },
    });
    const instr2 = instr({
      label: "Last Name",
      selector: "#last-name",
      value: "Doe",
      mapId: "m-last",
      probeKey: probeKey2,
      telemetry: { targetKey: probeKey2, frameKey: createFillEventV2OpaqueKey("f"), stepKey: null },
    });

    const probe = await probeFillOnPage([
      { mapId: instr1.mapId, probeKey: probeKey1, selector: instr1.selector, selectorFallbacks: [], fieldType: "text", pageStep: null },
      { mapId: instr2.mapId, probeKey: probeKey2, selector: instr2.selector, selectorFallbacks: [], fieldType: "text", pageStep: null },
    ]);
    expect(probe[0]?.targetStatus).toBe("unique");
    expect(probe[1]?.targetStatus).toBe("unique");

    const result1 = applyFillOnPage([instr1], window.location.href, true);
    expect(result1.filled).toEqual(["First Name"]);
    expect((document.getElementById("first-name") as HTMLInputElement).value).toBe("Jane");
    expect(document.getElementById("first-name")?.classList.contains("mp-fill-static")).toBe(true);

    const result2 = applyFillOnPage([instr2], window.location.href, true);
    expect(result2.filled).toEqual(["Last Name"]);
    expect((document.getElementById("last-name") as HTMLInputElement).value).toBe("Doe");
    expect(result2.skipped).toEqual([]);
    expect(result2.fieldOutcomes?.[0]?.reasonCode).not.toBe("context_changed");
  });

  it.each(["legend", "form", "class"])("rejects remaining fields when a native change handler changes their %s context", async (change) => {
    document.body.innerHTML = `
      <input id="entity-type" class="mp-fill-static" />
      <form id="practitioner"><fieldset><legend id="context">Practitioner</legend>
        <div id="npi-row"><label for="npi">NPI</label><input id="npi" /></div>
      </fieldset></form>
      <form id="group"></form>
    `;
    const npi = document.getElementById("npi") as HTMLInputElement;
    const instructions = [
      instr({ label: "Entity type", selector: "#entity-type", value: "Group" }),
      instr({ label: "Practitioner NPI", selector: "#npi", value: "1234567890" }),
    ].map((instruction, index) => ({
      ...instruction,
      mapId: `context-${index}`,
      probeKey: createFillEventV2OpaqueKey("t"),
      telemetry: { targetKey: createFillEventV2OpaqueKey("t"), frameKey: createFillEventV2OpaqueKey("f"), stepKey: null },
    }));
    document.getElementById("entity-type")!.addEventListener("change", () => {
      if (change === "legend") document.getElementById("context")!.textContent = "Group";
      else if (change === "form") document.getElementById("group")!.append(document.getElementById("npi-row")!);
      else document.getElementById("entity-type")!.classList.add("group-context");
    });
    const probes = await probeFillOnPage(instructions);
    expect(probes.every((probe) => probe.targetStatus === "unique")).toBe(true);

    const first = await applyFillSettled([instructions[0]!], true);
    expect(first.filled).toEqual(["Entity type"]);
    const second = await applyFillSettled([instructions[1]!], true);
    expect(document.getElementById("npi")).toBe(npi);
    expect(npi.isConnected).toBe(true);
    expect(npi.labels?.[0]?.textContent).toBe("NPI");
    expect(npi.value).toBe("");
    expect(second.fieldOutcomes?.[0]).toMatchObject({ attempted: false, reasonCode: "context_changed" });
  });

  it("rejects remaining fields when their context changes while a PrimeFaces menu is opening", async () => {
    document.body.innerHTML = `
      <div id="entity" class="ui-selectonemenu" role="combobox">
        <span class="ui-selectonemenu-label">Select One</span>
        <span class="ui-selectonemenu-trigger"></span>
        <input id="entity_focus" />
        <select id="entity_input" aria-hidden="true">
          <option value="">Select One</option><option value="group">Group</option>
        </select>
      </div>
      <div id="entity_panel" class="ui-selectonemenu-panel" style="display:none"><ul></ul></div>
      <fieldset><legend id="context">Practitioner</legend>
        <label for="npi">NPI</label><input id="npi" />
      </fieldset>
    `;
    const instructions = [
      instr({ label: "Entity type", selector: "#entity_focus", value: "Group", fieldType: "select" }),
      instr({ label: "Practitioner NPI", selector: "#npi", value: "1234567890" }),
    ].map((instruction, index) => ({
      ...instruction,
      mapId: `async-context-${index}`,
      probeKey: createFillEventV2OpaqueKey("t"),
      telemetry: { targetKey: createFillEventV2OpaqueKey("t"), frameKey: createFillEventV2OpaqueKey("f"), stepKey: null },
    }));
    document.querySelector<HTMLElement>(".ui-selectonemenu-trigger")!.addEventListener("click", () => {
      const panel = document.getElementById("entity_panel")!;
      panel.style.display = "block";
      setTimeout(() => {
        document.getElementById("context")!.textContent = "Group";
        panel.querySelector("ul")!.innerHTML = '<li class="ui-selectonemenu-item" data-value="group">Group</li>';
        panel.querySelector<HTMLElement>("li")!.addEventListener("click", () => {
          (document.getElementById("entity_input") as HTMLSelectElement).value = "group";
          document.querySelector(".ui-selectonemenu-label")!.textContent = "Group";
        });
      }, 20);
    });
    const probes = await probeFillOnPage(instructions);
    expect(probes.every((probe) => probe.targetStatus === "unique")).toBe(true);

    const first = await applyFillSettled([instructions[0]!], true);
    expect(first.filled).toEqual(["Entity type"]);
    expect(document.getElementById("context")!.textContent).toBe("Group");
    const second = await applyFillSettled([instructions[1]!], true);
    expect((document.getElementById("npi") as HTMLInputElement).value).toBe("");
    expect(second.fieldOutcomes?.[0]).toMatchObject({ attempted: false, reasonCode: "context_changed" });
  });

  it("rejects fill when a field's associated label changes after probing", async () => {
    document.body.innerHTML = `
      <label id="npi-label" for="npi">Practitioner NPI</label>
      <input id="npi" type="text" />
    `;
    const probeKey = createFillEventV2OpaqueKey("t");
    const instruction = instr({
      label: "Practitioner NPI",
      selector: "#npi",
      value: "1234567890",
      mapId: "m-npi",
      probeKey,
      telemetry: { targetKey: probeKey, frameKey: createFillEventV2OpaqueKey("f"), stepKey: null },
    });

    const probe = await probeFillOnPage([
      { mapId: instruction.mapId, probeKey, selector: instruction.selector, selectorFallbacks: [], fieldType: "text", pageStep: null },
    ]);
    expect(probe[0]?.targetStatus).toBe("unique");

    // Meaningful DOM change: label changes from Practitioner NPI to Group NPI
    document.getElementById("npi-label")!.textContent = "Group NPI";

    const applied = applyFillOnPage([instruction], window.location.href, true);
    expect(applied.filled).toEqual([]);
    expect((document.getElementById("npi") as HTMLInputElement).value).toBe("");
    expect(applied.fieldOutcomes?.[0]).toMatchObject({
      attempted: false,
      outcome: "unverified",
      reasonCode: "context_changed",
    });
  });

  it("rejects fill when a select option text changes after probing", async () => {
    document.body.innerHTML = `
      <label for="provider-type">Provider Type</label>
      <select id="provider-type">
        <option value="1">Specialist</option>
      </select>
    `;
    const probeKey = createFillEventV2OpaqueKey("t");
    const instruction = instr({
      label: "Provider Type",
      selector: "#provider-type",
      value: "Specialist",
      mapId: "m-type",
      probeKey,
      fieldType: "select",
      telemetry: { targetKey: probeKey, frameKey: createFillEventV2OpaqueKey("f"), stepKey: null },
    });

    const probe = await probeFillOnPage([
      { mapId: instruction.mapId, probeKey, selector: instruction.selector, selectorFallbacks: [], fieldType: "select", pageStep: null },
    ]);
    expect(probe[0]?.targetStatus).toBe("unique");

    // Meaningful DOM change: option text changes from Specialist to Hospitalist
    document.querySelector("#provider-type option")!.textContent = "Hospitalist";

    const applied = applyFillOnPage([instruction], window.location.href, true);
    expect(applied.filled).toEqual([]);
    expect(applied.fieldOutcomes?.[0]).toMatchObject({
      attempted: false,
      outcome: "unverified",
      reasonCode: "context_changed",
    });
  });

  it.each(["batch", "singleton"])("fills sequential PrimeFaces dropdowns with strictRevalidation (%s)", async (mode) => {
    document.body.innerHTML = `
      <div id="dropdown1" class="ui-selectonemenu" role="combobox">
        <span class="ui-selectonemenu-label">Select Option</span>
        <span class="ui-selectonemenu-trigger"></span>
        <input id="dropdown1_focus" type="text" aria-label="Dropdown 1" />
        <select id="dropdown1_input" aria-hidden="true" aria-label="Dropdown 1">
          <option value="">Select Option</option>
          <option value="optA">Option A</option>
        </select>
      </div>
      <div id="dropdown1_panel" class="ui-selectonemenu-panel" style="display:none">
        <ul id="dropdown1_items"></ul>
      </div>

      <div id="dropdown2" class="ui-selectonemenu" role="combobox">
        <span class="ui-selectonemenu-label">Select Option</span>
        <span class="ui-selectonemenu-trigger"></span>
        <input id="dropdown2_focus" type="text" aria-label="Dropdown 2" />
        <select id="dropdown2_input" aria-hidden="true" aria-label="Dropdown 2">
          <option value="">Select Option</option>
          <option value="optB">Option B</option>
        </select>
      </div>
      <div id="dropdown2_panel" class="ui-selectonemenu-panel" style="display:none">
        <ul id="dropdown2_items"></ul>
      </div>
    `;

    const wirePrimeFacesMenu = (id: string) => {
      const wrapper = document.getElementById(id)!;
      const select = wrapper.querySelector<HTMLSelectElement>(`#${id}_input`)!;
      const label = wrapper.querySelector<HTMLElement>(".ui-selectonemenu-label")!;
      const panel = document.getElementById(`${id}_panel`)!;
      wrapper.querySelector<HTMLElement>(".ui-selectonemenu-trigger")!.addEventListener("click", () => {
        panel.style.display = "block";
        panel.querySelector("ul")!.innerHTML = Array.from(select.options)
          .filter((opt) => opt.value)
          .map((opt) => `<li class="ui-selectonemenu-item" role="option" data-value="${opt.value}" data-label="${opt.text}">${opt.text}</li>`)
          .join("");
        panel.querySelectorAll<HTMLElement>(".ui-selectonemenu-item").forEach((item) => {
          item.addEventListener("click", () => {
            select.value = item.getAttribute("data-value") ?? "";
            label.textContent = item.getAttribute("data-label") ?? "";
            panel.style.display = "none";
            select.dispatchEvent(new Event("change", { bubbles: true }));
          });
        });
      });
    };

    wirePrimeFacesMenu("dropdown1");
    wirePrimeFacesMenu("dropdown2");

    const probeKey1 = createFillEventV2OpaqueKey("t");
    const probeKey2 = createFillEventV2OpaqueKey("t");
    const instr1 = instr({
      label: "Dropdown 1",
      selector: "#dropdown1_focus",
      fieldType: "select",
      value: "Option A",
      mapId: "m-d1",
      probeKey: probeKey1,
      telemetry: { targetKey: probeKey1, frameKey: createFillEventV2OpaqueKey("f"), stepKey: null },
    });
    const instr2 = instr({
      label: "Dropdown 2",
      selector: "#dropdown2_focus",
      fieldType: "select",
      value: "Option B",
      mapId: "m-d2",
      probeKey: probeKey2,
      telemetry: { targetKey: probeKey2, frameKey: createFillEventV2OpaqueKey("f"), stepKey: null },
    });

    const probe = await probeFillOnPage([
      { mapId: instr1.mapId, probeKey: probeKey1, selector: instr1.selector, selectorFallbacks: [], fieldType: "select", pageStep: null },
      { mapId: instr2.mapId, probeKey: probeKey2, selector: instr2.selector, selectorFallbacks: [], fieldType: "select", pageStep: null },
    ]);
    expect(probe[0]?.targetStatus).toBe("unique");
    expect(probe[1]?.targetStatus).toBe("unique");

    const results = mode === "batch"
      ? [await applyFillSettled([instr1, instr2], true)]
      : [await applyFillSettled([instr1], true), await applyFillSettled([instr2], true)];
    expect(results.flatMap((result) => result.filled)).toEqual(["Dropdown 1", "Dropdown 2"]);
    expect(results.flatMap((result) => result.skipped)).toEqual([]);
    expect((document.getElementById("dropdown1_input") as HTMLSelectElement).value).toBe("optA");
    expect((document.getElementById("dropdown2_input") as HTMLSelectElement).value).toBe("optB");
    expect(results.every((result) => result.fieldOutcomes?.every((f) => f.reasonCode !== "context_changed"))).toBe(true);
  });

  it("rejects a PrimeFaces selection if the option changes while the menu opens", async () => {
    document.body.innerHTML = `
      <div id="dropdown" class="ui-selectonemenu" role="combobox">
        <span class="ui-selectonemenu-label">Select Option</span>
        <span class="ui-selectonemenu-trigger"></span>
        <input id="dropdown_focus" type="text" aria-label="Dropdown" />
        <select id="dropdown_input" aria-hidden="true" aria-label="Dropdown">
          <option value="">Select Option</option>
          <option value="optA">Option A</option>
        </select>
      </div>
      <div id="dropdown_panel" class="ui-selectonemenu-panel" style="display:none">
        <ul id="dropdown_items"></ul>
      </div>
    `;

    const wrapper = document.getElementById("dropdown")!;
    const select = wrapper.querySelector<HTMLSelectElement>("#dropdown_input")!;
    const label = wrapper.querySelector<HTMLElement>(".ui-selectonemenu-label")!;
    const trigger = wrapper.querySelector<HTMLElement>(".ui-selectonemenu-trigger")!;
    const panel = document.getElementById("dropdown_panel")!;
    trigger.addEventListener("click", () => {
      panel.style.display = "block";
      setTimeout(() => {
        const option = select.options[1]!;
        option.value = "replacement";
        option.textContent = "Replacement Option";
        panel.querySelector("ul")!.innerHTML =
          `<li class="ui-selectonemenu-item" role="option" data-value="${option.value}" data-label="${option.text}">${option.text}</li>`;
        panel.querySelector<HTMLElement>(".ui-selectonemenu-item")!.addEventListener("click", () => {
          select.value = option.value;
          label.textContent = option.text;
          panel.style.display = "none";
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }, 30);
    });

    const probeKey = createFillEventV2OpaqueKey("t");
    const instruction = instr({
      label: "Dropdown",
      selector: "#dropdown_focus",
      fieldType: "select",
      value: "Option A",
      probeKey,
      telemetry: { targetKey: probeKey, frameKey: createFillEventV2OpaqueKey("f"), stepKey: null },
    });
    const probe = await probeFillOnPage([{
      mapId: instruction.mapId,
      probeKey,
      selector: instruction.selector,
      selectorFallbacks: [],
      fieldType: "select",
      pageStep: null,
    }]);
    expect(probe[0]?.targetStatus).toBe("unique");

    const result = await applyFillSettled([instruction], true);

    expect(result.filled).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ kind: "unverified" });
    expect(result.fieldOutcomes?.[0]).toMatchObject({
      attempted: true,
      outcome: "unverified",
      reasonCode: "context_changed",
    });
    expect(select.value).toBe("");
  });

  it("does not withhold singleton sequence-page instruction as page_unknown when resolvedPage is provided", async () => {
    document.body.innerHTML = `<input id="field" type="text" />`;
    const probeKey = createFillEventV2OpaqueKey("t");
    const instruction = instr({
      label: "Step Field",
      selector: "#field",
      value: "Value",
      pageStep: "Page 2",
      resolvedPage: "enrollment",
      probeKey,
      telemetry: { targetKey: probeKey, frameKey: createFillEventV2OpaqueKey("f"), stepKey: null },
    });
    // In production, the probe runs over the full batch including the URL-tail step
    const probe = await probeFillOnPage([
      {
        mapId: "m-tail",
        probeKey: createFillEventV2OpaqueKey("t"),
        selector: "#field",
        selectorFallbacks: [],
        fieldType: "text",
        pageStep: "enrollment",
      },
      {
        mapId: instruction.mapId,
        probeKey,
        selector: instruction.selector,
        selectorFallbacks: [],
        fieldType: "text",
        pageStep: "Page 2",
      },
    ], "https://payer.example/enroll/enrollment");

    expect(probe[1]?.targetStatus).toBe("unique");
    expect(probe[1]?.pageStatus).toBe("eligible");
    expect(probe[1]?.resolvedPage).toBe("enrollment");

    // Single-instruction apply receives the singleton routed instruction
    const result = applyFillOnPage([instruction], "https://payer.example/enroll/enrollment", true);
    expect(result.filled).toEqual(["Step Field"]);
    expect((document.getElementById("field") as HTMLInputElement).value).toBe("Value");
    expect(result.skipped).toEqual([]);
  });

  it("waits for a delayed panel before declaring a unique target", async () => {
    document.body.innerHTML = "";
    const probeKey = createFillEventV2OpaqueKey("t");
    setTimeout(() => {
      document.body.innerHTML = `<input id="late-panel" />`;
    }, 40);
    const probe = await probeFillOnPage([{
      mapId: "m1",
      probeKey,
      selector: "#late-panel",
      selectorFallbacks: [],
      fieldType: "text",
      pageStep: null,
    }]);
    expect(probe[0]).toMatchObject({ targetStatus: "unique", pageSettled: true });
  });

  it("does not report a page settled while a visible loading marker remains", async () => {
    document.body.innerHTML = `<div aria-busy="true"></div>`;
    const probe = await probeFillOnPage([{
      mapId: "m1",
      probeKey: createFillEventV2OpaqueKey("t"),
      selector: "#not-yet-rendered",
      selectorFallbacks: [],
      fieldType: "text",
      pageStep: null,
    }]);
    expect(probe[0]).toMatchObject({ targetStatus: "missing", pageSettled: false });
  });
});

// US-5.3 — "Clear portal form". Sandbox-only by construction: it resets every
// control on the page, which on a live case would wipe a coordinator's real
// typing. These pin the two things that make it safe to press repeatedly —
// it reports what it actually changed, and it goes through the same native
// setter path as a fill so a framework-controlled input really sees the clear.
describe("clearPortalForm", () => {
  it("clears text, textarea, select, checkbox and radio", () => {
    document.body.innerHTML = `
      <input id="t" type="text" value="Ada" />
      <textarea id="a">notes</textarea>
      <select id="s"><option value="">Choose</option><option value="x" selected>X</option></select>
      <input id="c" type="checkbox" checked />
      <input id="r" type="radio" name="g" checked />
    `;
    expect(clearPortalForm()).toBe(5);
    expect(document.querySelector<HTMLInputElement>("#t")!.value).toBe("");
    expect(document.querySelector<HTMLTextAreaElement>("#a")!.value).toBe("");
    expect(document.querySelector<HTMLSelectElement>("#s")!.value).toBe("");
    expect(document.querySelector<HTMLInputElement>("#c")!.checked).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#r")!.checked).toBe(false);
  });

  it("counts only what it actually changed", () => {
    // The count is the panel's whole feedback line, so an already-empty form
    // has to read "nothing to clear" rather than a fake success.
    document.body.innerHTML = `
      <input id="t" type="text" value="" />
      <input id="c" type="checkbox" />
      <select id="s"><option value="">Choose</option><option value="x">X</option></select>
    `;
    expect(clearPortalForm()).toBe(0);
  });

  it("leaves buttons and hidden inputs alone", () => {
    // Clearing a hidden field would destroy portal state (CSRF tokens, view
    // state) that the human never typed and cannot retype.
    document.body.innerHTML = `
      <input id="h" type="hidden" value="viewstate" />
      <input id="b" type="submit" value="Submit" />
      <input id="t" type="text" value="Ada" />
    `;
    expect(clearPortalForm()).toBe(1);
    expect(document.querySelector<HTMLInputElement>("#h")!.value).toBe(
      "viewstate",
    );
    expect(document.querySelector<HTMLInputElement>("#b")!.value).toBe(
      "Submit",
    );
  });

  it("fires input, change, blur, and focusout so controlled inputs see the clear", () => {
    // Same reason applyFill uses the native setter: a React-style portal that
    // only listens to events would otherwise re-render the old value straight
    // back, leaving the form visibly unchanged.
    document.body.innerHTML = `<input id="t" type="text" value="Ada" />`;
    const input = document.querySelector<HTMLInputElement>("#t")!;
    const seen: string[] = [];
    input.addEventListener("input", () => seen.push("input"));
    input.addEventListener("change", () => seen.push("change"));
    input.addEventListener("blur", () => seen.push("blur"));
    input.addEventListener("focusout", () => seen.push("focusout"));
    clearPortalForm();
    expect(seen).toEqual(["input", "change", "blur", "focusout"]);
  });

  it("keeps going when one control throws", () => {
    document.body.innerHTML = `
      <input id="bad" type="checkbox" checked />
      <input id="good" type="text" value="y" />
    `;
    const bad = document.querySelector<HTMLInputElement>("#bad")!;
    Object.defineProperty(bad, "checked", {
      get: () => true,
      set: () => {
        throw new Error("stubborn widget");
      },
    });
    expect(clearPortalForm()).toBe(1);
    expect(document.querySelector<HTMLInputElement>("#good")!.value).toBe("");
  });
});

// The Selector Workshop's verdict is only worth reading if it agrees with the
// engine. `describeSelectorMatches` keeps its own notion of "a field the fill
// can write to" (input / select / textarea), which is a COPY of `bySelector`'s
// — so pin the two together rather than trusting the comment.
describe("workshop / engine parity on what counts as a field", () => {
  const cases = [
    {
      name: "text input by id",
      html: '<input id="t" type="text">',
      selector: "#t",
    },
    {
      name: "select",
      html: '<select id="s"><option value="x">x</option></select>',
      selector: "#s",
    },
    { name: "textarea", html: '<textarea id="a"></textarea>', selector: "#a" },
    {
      name: "wrapper div",
      html: '<div id="w"><input type="text"></div>',
      selector: "#w",
    },
    {
      name: "a label",
      html: '<label id="l">Name</label><input type="text">',
      selector: "#l",
    },
    { name: "nothing", html: "<p>hi</p>", selector: "#missing" },
    {
      name: "a label: selector",
      html: '<label for="fn">First Name</label><input id="fn" type="text">',
      selector: "label:First Name",
    },
    {
      name: "a label: selector the page lacks",
      html: '<label for="fn">First Name</label><input id="fn" type="text">',
      selector: "label:Last Name",
    },
  ];

  for (const c of cases) {
    it(`agrees on ${c.name}`, () => {
      document.body.innerHTML = c.html;
      const workshopSaysFillable =
        describeSelectorMatches(c.selector).fillable > 0;
      const report = applyFill([
        instr({ label: c.name, selector: c.selector, value: "x" }),
      ]);
      const engineFilled = report.filled.length > 0;
      expect(workshopSaysFillable).toBe(engineFilled);
    });
  }
});

// The BCBSKS behavioral-health list (PrimeFaces 10 SelectManyMenu). Its
// backing `<select multiple>` is what the form posts; the list is what the
// coordinator sees. The fill drives the list — a ctrl-click per option, the
// way a person adds to a multi-selection — and checks both agree afterwards.
// Markup + widget port: src/__fixtures__/dom/primeFacesSelectManyMenu.ts.
describe("PrimeFaces SelectManyMenu fill", () => {
  const areas = (over: Partial<FillInstruction> = {}): FillInstruction =>
    instr({ label: "Areas of expertise", selector: BCBSKS_AREAS_SELECTOR, fieldType: "select", value: "A12", ...over });
  const wrapper = (): HTMLElement => document.getElementById(BCBSKS_AREAS_ID)!;
  const item = (code: string): HTMLElement =>
    wrapper().querySelectorAll<HTMLElement>(".ui-selectlistbox-item")[Number(code.slice(1)) - 1]!;

  it("adds the mapped option by clicking its visible item, keeping the coordinator's other choices", async () => {
    document.body.innerHTML = selectManyMenuMarkup();
    const widget = wireSelectManyMenu(wrapper());
    item("A03").click(); // the coordinator's own pick: a plain click
    expect(postedCodes(wrapper())).toEqual(["A03"]);

    const result = await applyFillSettled([areas({ value: "A12" })]);
    expect(result.filled).toEqual(["Areas of expertise"]);
    expect(result.skipped).toEqual([]);
    expect(result.writes).toEqual([{ selector: BCBSKS_AREAS_SELECTOR, kind: "static" }]);
    expect(postedCodes(wrapper())).toEqual(["A03", "A12"]);
    expect(highlightedCodes(wrapper())).toEqual(["A03", "A12"]);
    expect(widget.changes()).toBe(2);
    // The outline goes on the list the coordinator reviews.
    expect(wrapper().classList.contains("mp-fill-static")).toBe(true);
  });

  it("matches an option by its visible label too", async () => {
    document.body.innerHTML = selectManyMenuMarkup();
    wireSelectManyMenu(wrapper());
    const result = await applyFillSettled([areas({ value: "A40 - COGNITIVE BEHAVIORAL THERAPY (CBT)" })]);
    expect(result.filled).toEqual(["Areas of expertise"]);
    expect(postedCodes(wrapper())).toEqual(["A40"]);
    expect(highlightedCodes(wrapper())).toEqual(["A40"]);
  });

  it("works the same with showCheckbox, where every click toggles", async () => {
    document.body.innerHTML = selectManyMenuMarkup({ showCheckbox: true, selected: ["A01"] });
    wireSelectManyMenu(wrapper(), { showCheckbox: true });
    const result = await applyFillSettled([areas({ value: "A12" })]);
    expect(result.filled).toEqual(["Areas of expertise"]);
    expect(postedCodes(wrapper())).toEqual(["A01", "A12"]);
  });

  it("leaves an already-chosen option alone and reports no write", async () => {
    document.body.innerHTML = selectManyMenuMarkup({ selected: ["A12"] });
    const widget = wireSelectManyMenu(wrapper());
    const result = await applyFillSettled([areas({ value: "A12" })]);
    expect(result.filled).toEqual(["Areas of expertise"]);
    expect(result.attemptedLabels).toEqual([]);
    expect(result.writes).toEqual([]);
    expect(widget.changes()).toBe(0);
    expect(postedCodes(wrapper())).toEqual(["A12"]);
  });

  it("skips a list inside a hidden panel without touching it", async () => {
    document.body.innerHTML = `<div style="display:none">${selectManyMenuMarkup()}</div>`;
    const widget = wireSelectManyMenu(wrapper());
    const result = await applyFillSettled([areas()]);
    expect(result.filled).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ label: "Areas of expertise", reason: HIDDEN_REASON, kind: HIDDEN_KIND }),
    ]);
    expect(widget.changes()).toBe(0);
    expect(postedCodes(wrapper())).toEqual([]);
  });

  it("guards the ITEM about to be clicked: one the list filter hid is not written", async () => {
    document.body.innerHTML = selectManyMenuMarkup({ filter: true });
    const widget = wireSelectManyMenu(wrapper());
    item("A12").style.display = "none"; // the coordinator filtered the list
    const result = await applyFillSettled([areas({ value: "A12" })]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ reason: HIDDEN_REASON, kind: HIDDEN_KIND }),
    ]);
    expect(widget.changes()).toBe(0);
    expect(postedCodes(wrapper())).toEqual([]);
  });

  it("refuses when a click would replace the other choices (metaKeySelection off)", async () => {
    document.body.innerHTML = selectManyMenuMarkup({ selected: ["A03"], metaKeySelection: false });
    const widget = wireSelectManyMenu(wrapper(), { metaKeySelection: false });
    const result = await applyFillSettled([areas({ value: "A12" })]);
    expect(result.filled).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({
      reason: "this list replaces its other choices on click; review this field on the portal",
      kind: "unverified",
    })]);
    expect(widget.changes()).toBe(0);
    expect(postedCodes(wrapper())).toEqual(["A03"]);
  });

  it("reports, never claims, a click that cleared other choices anyway", async () => {
    // The init script says nothing, but the widget clears on every click.
    document.body.innerHTML = selectManyMenuMarkup({ selected: ["A03"] });
    wireSelectManyMenu(wrapper(), { metaKeySelection: false });
    const result = await applyFillSettled([areas({ value: "A12" })]);
    expect(result.filled).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({
      reason: "selecting it cleared the list's other choices; review this field on the portal",
      kind: "unverified",
    })]);
  });

  it("reports a vocabulary miss without the value", async () => {
    document.body.innerHTML = selectManyMenuMarkup();
    const widget = wireSelectManyMenu(wrapper());
    const result = await applyFillSettled([areas({ value: "Equine therapy" })]);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "dropdown: no option matches the mapped value" })]);
    expect(JSON.stringify(result)).not.toContain("Equine");
    expect(widget.changes()).toBe(0);
  });

  it("refuses a list whose items don't line up with its options", async () => {
    document.body.innerHTML = selectManyMenuMarkup();
    item("A12").textContent = "Something else";
    const result = await applyFillSettled([areas({ value: "A12" })]);
    expect(result.skipped).toEqual([expect.objectContaining({
      reason: "list items do not line up with the field's options; review this field on the portal",
    })]);
    expect(postedCodes(wrapper())).toEqual([]);
  });

  it("never writes the backing select behind the list (synchronous path)", () => {
    document.body.innerHTML = selectManyMenuMarkup();
    const result = applyFill([areas({ value: "A12" })]);
    expect(result.filled).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({
      reason: "multi-select list can only be filled through its visible items",
    })]);
    expect(postedCodes(wrapper())).toEqual([]);
  });

  it("keeps later probed fields valid under strictRevalidation (the click is not a form change)", async () => {
    document.body.innerHTML = `${selectManyMenuMarkup()}<input id="email" type="text" />`;
    wireSelectManyMenu(wrapper());
    const keyA = createFillEventV2OpaqueKey("t");
    const keyB = createFillEventV2OpaqueKey("t");
    const list = areas({ mapId: "m-list", probeKey: keyA, telemetry: { targetKey: keyA, frameKey: createFillEventV2OpaqueKey("f"), stepKey: null } });
    const email = instr({ label: "Email", selector: "#email", value: "a@b.co", mapId: "m-email", probeKey: keyB, telemetry: { targetKey: keyB, frameKey: createFillEventV2OpaqueKey("f"), stepKey: null } });
    const probe = await probeFillOnPage([
      { mapId: list.mapId, probeKey: keyA, selector: list.selector, selectorFallbacks: [], fieldType: "select", pageStep: null },
      { mapId: email.mapId, probeKey: keyB, selector: email.selector, selectorFallbacks: [], fieldType: "text", pageStep: null },
    ]);
    expect(probe.map((p) => p.targetStatus)).toEqual(["unique", "unique"]);

    const first = await applyFillSettled([list], true);
    const second = await applyFillSettled([email], true);
    expect([...first.filled, ...second.filled]).toEqual(["Areas of expertise", "Email"]);
    expect([...first.skipped, ...second.skipped]).toEqual([]);
    expect(postedCodes(wrapper())).toEqual(["A12"]);
    expect(highlightedCodes(wrapper())).toEqual(["A12"]);
  });

  it("is a field to the Selector Workshop, and the engine fills it", async () => {
    document.body.innerHTML = selectManyMenuMarkup();
    wireSelectManyMenu(wrapper());
    expect(describeSelectorMatches(BCBSKS_AREAS_SELECTOR)).toEqual({ valid: true, matches: 1, fillable: 1, radioGroup: false });
    expect((await applyFillSettled([areas()])).filled).toEqual(["Areas of expertise"]);
    expect(highlightedCodes(wrapper())).toEqual(["A12"]);
  });
});

describe("multi-select fill and clear", () => {
  it("adds to a native <select multiple> instead of replacing its selection", () => {
    document.body.innerHTML = `
      <select id="langs" multiple>
        <option value="en" selected>English</option><option value="es">Spanish</option><option value="fr">French</option>
      </select>`;
    const result = applyFill([instr({ label: "Languages", selector: "#langs", fieldType: "select", value: "Spanish" })]);
    expect(result.filled).toEqual(["Languages"]);
    const select = document.querySelector<HTMLSelectElement>("#langs")!;
    expect(Array.from(select.selectedOptions).map((option) => option.value)).toEqual(["en", "es"]);
  });

  it("clears a SelectManyMenu through its own list, and a native multi-select without choosing option 1", () => {
    document.body.innerHTML = `
      ${selectManyMenuMarkup({ selected: ["A03", "A12"] })}
      <select id="langs" multiple><option value="en" selected>English</option><option value="es">Spanish</option></select>
      <select id="empty" multiple><option value="x">X</option></select>`;
    const wrapper = document.getElementById(BCBSKS_AREAS_ID)!;
    const widget = wireSelectManyMenu(wrapper);
    expect(clearPortalForm()).toBe(2);
    expect(postedCodes(wrapper)).toEqual([]);
    expect(highlightedCodes(wrapper)).toEqual([]);
    expect(widget.changes()).toBe(2);
    expect(document.querySelector<HTMLSelectElement>("#langs")!.selectedOptions).toHaveLength(0);
    expect(document.querySelector<HTMLSelectElement>("#empty")!.selectedOptions).toHaveLength(0);
  });

  it("leaves a list it can't clear click-by-click alone (metaKeySelection off)", () => {
    document.body.innerHTML = selectManyMenuMarkup({ selected: ["A03", "A12"], metaKeySelection: false });
    const wrapper = document.getElementById(BCBSKS_AREAS_ID)!;
    wireSelectManyMenu(wrapper, { metaKeySelection: false });
    expect(clearPortalForm()).toBe(0);
    expect(postedCodes(wrapper)).toEqual(["A03", "A12"]);
  });
});

/**
 * Spike 2026-10-15 — BCBS KS Network Enrollment Form, fill 21813fea.
 * Nine mapped inputs (five phone/fax masks, three DatePicker inputs, one NPI
 * mask) were logged `context_changed`, attempted=false. The live page shows no
 * DOM mutation at all during a write; what differs is what the PrimeFaces 10
 * InputMask does to the VALUE. These tests mimic that widget as measured on
 * the live form (shape only, no portal markup): an OWN `value` accessor on the
 * input, re-masking of the raw DOM value on `input`, and — clearIncomplete +
 * clearMaskOnLostFocus — the widget writing its own buffer back on `blur`.
 * The fix writes a masked input through its own setter and judges retention
 * by the mask's content (alphanumerics), reporting a rejected write as
 * `write_rejected` / `readback_mismatch` instead of silence.
 * See docs/spike-context-changed-mask-dates.md.
 */
describe("PrimeFaces InputMask readback", () => {
  const phoneMask = (raw: string): string => {
    const digits = raw.replace(/\D/g, "").slice(0, 10);
    return digits.length === 10 ? `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}` : digits;
  };
  const npiMask = (raw: string): string => raw.replace(/\D/g, "").slice(0, 10);
  const dateMask = (raw: string): string => (/^\d{2}\/\d{2}\/\d{4}$/.test(raw) ? raw : "");

  /** `complete` says whether the widget's buffer satisfies the mask; an
   * incomplete buffer is cleared on blur (jquery.inputmask clearIncomplete).
   * `syncOnInput` false mimics the datetime alias, whose buffer the engine's
   * synthetic `input` event did not update on the live form. */
  function installInputMask(
    input: HTMLInputElement,
    mask: (raw: string) => string,
    complete: (masked: string) => boolean,
    { syncOnInput = true }: { syncOnInput?: boolean } = {},
  ): void {
    const proto = Object.getPrototypeOf(input) as object;
    const native = Object.getOwnPropertyDescriptor(proto, "value");
    if (!native?.get || !native.set) throw new Error("jsdom input has no prototype value accessor");
    const read = (): string => native.get!.call(input) as string;
    const write = (next: string): void => { native.set!.call(input, next); };
    let buffer = "";
    Object.defineProperty(input, "value", {
      configurable: true,
      get: read,
      set(raw: string) { buffer = mask(String(raw)); write(buffer); },
    });
    input.addEventListener("input", () => {
      if (!syncOnInput) return;
      buffer = mask(read());
      write(buffer);
    });
    input.addEventListener("blur", () => {
      if (!complete(buffer)) write("");
    });
    input.classList.add("ui-inputmask");
  }

  const telemetry = () => ({
    targetKey: createFillEventV2OpaqueKey("t"),
    frameKey: createFillEventV2OpaqueKey("f"),
    stepKey: null,
  });

  it("reports a mask's canonical readback as an attempted write, never as silence the worker files under context_changed", () => {
    document.body.innerHTML = `<label for="phone">Phone number</label><input id="phone" type="text" />`;
    installInputMask(document.querySelector("#phone")!, phoneMask, (m) => m.length === 13);
    const applied = applyFillOnPage([
      instr({ label: "Phone number", selector: "#phone", value: "(555) 555-0100", telemetry: telemetry() }),
    ], window.location.href);
    // Today: the retain check (fillEngine.ts applyValue) returns ok:false with
    // no outcome/reasonCode, so applyFillOnPage records nothing and
    // applyFillAcrossFrames labels the empty outcome list context_changed.
    expect(applied.fieldOutcomes).toHaveLength(1);
    expect(applied.fieldOutcomes?.[0]).toMatchObject({ attempted: true });
    expect(applied.fieldOutcomes?.[0]?.reasonCode).not.toBe("context_changed");
  });

  it("counts a phone the mask re-formatted as filled: the digits the portal will post are the digits asked for", () => {
    document.body.innerHTML = `<label for="phone">Phone number</label><input id="phone" type="text" />`;
    const phone = document.querySelector<HTMLInputElement>("#phone")!;
    installInputMask(phone, phoneMask, (m) => m.length === 13);
    const applied = applyFillOnPage([
      instr({ label: "Phone number", selector: "#phone", value: "(555) 555-0100", telemetry: telemetry() }),
    ], window.location.href);
    // The value IS on the page in the mask's own shape…
    expect(phone.value).toBe("(555)555-0100");
    // …and the engine should say so instead of "field did not retain the requested value".
    expect(applied.filled).toEqual(["Phone number"]);
    expect(applied.skipped).toEqual([]);
  });

  it("keeps a PrimeFaces DatePicker's masked date through the engine's synthetic blur", async () => {
    document.body.innerHTML = `
      <label id="dob-label">Date of birth</label>
      <span class="p-datepicker ui-calendar"><input id="dob" type="text" aria-labelledby="dob-label" inputmode="numeric" /></span>
    `;
    const dob = document.querySelector<HTMLInputElement>("#dob")!;
    installInputMask(dob, dateMask, (m) => m.length === 10, { syncOnInput: false });
    const applied = await applyFillSettled([
      instr({ label: "Date of birth", selector: "#dob", fieldType: "date", value: "02/02/1980", telemetry: telemetry() }),
    ]);
    // Live form, 2026-10-15: the prototype-setter write survives input/change
    // and is emptied by the widget on blur; a write through the input's own
    // (mask-installed) setter survives the same blur.
    expect(dob.value).toBe("02/02/1980");
    expect(applied.filled).toEqual(["Date of birth"]);
  });

  it("files a value the mask cannot hold as a rejected write with a reason (an 'n/a' into a 10-digit NPI mask)", () => {
    document.body.innerHTML = `<label for="npi">Supervising physician NPI</label><input id="npi" type="text" />`;
    const npi = document.querySelector<HTMLInputElement>("#npi")!;
    installInputMask(npi, npiMask, (m) => m.length === 10);
    const applied = applyFillOnPage([
      instr({ label: "Supervising physician NPI", selector: "#npi", value: "n/a", telemetry: telemetry() }),
    ], window.location.href);
    expect(npi.value).toBe("");
    expect(applied.filled).toEqual([]);
    expect(applied.fieldOutcomes?.[0]).toMatchObject({ attempted: true, outcome: "write_rejected" });
  });
});
