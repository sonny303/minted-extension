/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  compareVisualPosition,
  isCapturableControl,
  isHiddenControl,
  scanCapturableFields,
} from "./captureScan";

// jsdom does not provide CSS.escape; captureScan uses it for ids/names.
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

/** jsdom reports zero-size rects for every element; stub a visible box so
 * attribute / style hiding is what the tests exercise. Optional top/left
 * place the control for visual-order assertions. */
function stubVisibleBox(
  el: Element,
  size: { width?: number; height?: number; top?: number; left?: number } = {},
): void {
  const width = size.width ?? 120;
  const height = size.height ?? 24;
  const top = size.top ?? 0;
  const left = size.left ?? 0;
  const rect = {
    x: left,
    y: top,
    top,
    left,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON() {
      return this;
    },
  };
  el.getBoundingClientRect = () => rect as DOMRect;
  el.getClientRects = () => [rect] as unknown as DOMRectList;
}

function stubZeroBox(el: Element): void {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON() {
      return this;
    },
  };
  el.getBoundingClientRect = () => rect as DOMRect;
  el.getClientRects = () => [] as unknown as DOMRectList;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("isHiddenControl (shared with the fill — DYN-PAGE-02)", () => {
  it("reports only POSITIVE hiding, never mere absence of geometry", () => {
    document.body.innerHTML = `
      <div style="display:none"><input id="d" type="text" /></div>
      <div hidden><input id="h" type="text" /></div>
      <div aria-hidden="true"><input id="a" type="text" /></div>
      <div style="visibility:hidden"><input id="v" type="text" /></div>
      <input id="ok" type="text" />
    `;
    for (const id of ["d", "h", "a", "v"]) {
      expect(isHiddenControl(document.getElementById(id)!)).toBe(true);
    }
    // No layout box in jsdom, yet NOT hidden: the fill must still write it.
    // Geometry is a scanner-quality filter, not evidence of an inactive panel.
    expect(isHiddenControl(document.getElementById("ok")!)).toBe(false);
    expect(isCapturableControl(document.getElementById("ok")!)).toBe(false);
  });
});

describe("isCapturableControl", () => {
  it("rejects controls with no client rects / zero size", () => {
    document.body.innerHTML = `<input id="a" type="text" />`;
    const el = document.getElementById("a")!;
    stubZeroBox(el);
    expect(isCapturableControl(el)).toBe(false);
  });

  it("rejects controls under [hidden] or [aria-hidden=true]", () => {
    document.body.innerHTML = `
      <div hidden><input id="h" type="text" /></div>
      <div aria-hidden="true"><input id="a" type="text" /></div>
      <input id="ok" type="text" />
    `;
    stubVisibleBox(document.getElementById("h")!);
    stubVisibleBox(document.getElementById("a")!);
    stubVisibleBox(document.getElementById("ok")!);
    expect(isCapturableControl(document.getElementById("h")!)).toBe(false);
    expect(isCapturableControl(document.getElementById("a")!)).toBe(false);
    expect(isCapturableControl(document.getElementById("ok")!)).toBe(true);
  });

  it("rejects controls under display:none or visibility:hidden ancestors", () => {
    document.body.innerHTML = `
      <div style="display:none"><input id="d" type="text" /></div>
      <div style="visibility:hidden"><input id="v" type="text" /></div>
      <input id="ok" type="text" />
    `;
    stubVisibleBox(document.getElementById("d")!);
    stubVisibleBox(document.getElementById("v")!);
    stubVisibleBox(document.getElementById("ok")!);
    expect(isCapturableControl(document.getElementById("d")!)).toBe(false);
    expect(isCapturableControl(document.getElementById("v")!)).toBe(false);
    expect(isCapturableControl(document.getElementById("ok")!)).toBe(true);
  });
});

describe("scanCapturableFields", () => {
  it("keeps only visible fillable controls and still collapses radio groups", () => {
    document.body.innerHTML = `
      <div style="display:none">
        <label>Hidden NPI <input id="hidden-npi" name="npi_h" type="text" /></label>
        <label>Panel A Yes <input type="radio" name="accepting" value="y" /></label>
        <label>Panel A No <input type="radio" name="accepting" value="n" /></label>
      </div>
      <label for="visible-npi">NPI</label>
      <input id="visible-npi" type="text" />
      <fieldset>
        <legend>Accepting</legend>
        <label>Yes <input type="radio" name="accepting" value="y" /></label>
        <label>No <input type="radio" name="accepting" value="n" /></label>
      </fieldset>
      <div hidden>
        <select id="hidden-state"><option>KS</option></select>
      </div>
    `;
    stubVisibleBox(document.getElementById("visible-npi")!);
    for (const radio of document.querySelectorAll('fieldset input[type="radio"]')) {
      stubVisibleBox(radio);
    }
    // Hidden-panel controls keep jsdom's zero rects (and ancestor display:none /
    // [hidden]); leave them unstubbed so the scan skips them.

    const fields = scanCapturableFields();
    expect(fields.map((f) => f.selector)).toEqual([
      "#visible-npi",
      // Name selectors carry the input TYPE now: a form that reuses one name
      // across a radio and a hidden twin would otherwise collapse onto the
      // wrong control.
      'input[type="radio"][name="accepting"]',
    ]);
    expect(fields).toHaveLength(2);
    expect(fields[1]?.fieldType).toBe("radio");
    // The GROUP's question, not option 1's text ("Yes").
    expect(fields[1]?.label).toBe("Accepting");
    expect(fields[1]?.formSection).toBe("Accepting");
    expect(fields[1]?.options).toEqual([
      { value: "y", label: "Yes" },
      { value: "n", label: "No" },
    ]);
  });

  it("does not read control values while scanning", () => {
    document.body.innerHTML = `<input id="ssn" type="text" value="123-45-6789" />`;
    const el = document.getElementById("ssn") as HTMLInputElement;
    stubVisibleBox(el);
    const valueGetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.get!;
    let valueReads = 0;
    Object.defineProperty(el, "value", {
      configurable: true,
      get() {
        valueReads += 1;
        return valueGetter.call(this);
      },
    });

    const fields = scanCapturableFields();
    expect(fields).toEqual([
      {
        label: "",
        selector: "#ssn",
        fieldType: "text",
        formSection: null,
      },
    ]);
    expect(valueReads).toBe(0);
  });

  it("captures select/radio/checkbox option vocabulary without reading selected or checked state", () => {
    document.body.innerHTML = `
      <label for="st">Practice State</label>
      <select id="st">
        <option value="">Select a state</option>
        <option value="KS" selected>Kansas</option>
        <option value="MO">Missouri</option>
        <option value="NE">Nebraska</option>
      </select>
      <fieldset>
        <legend>Entity</legend>
        <label>Individual <input type="radio" name="entity" value="I" checked /></label>
        <label>Group <input type="radio" name="entity" value="G" /></label>
      </fieldset>
      <label>I agree <input id="agree" type="checkbox" checked /></label>
      <label>Plan <input id="plan" type="checkbox" value="PPO" /></label>
    `;
    const select = document.getElementById("st") as HTMLSelectElement;
    stubVisibleBox(select);
    for (const radio of document.querySelectorAll('input[type="radio"]')) stubVisibleBox(radio);
    stubVisibleBox(document.getElementById("agree")!);
    stubVisibleBox(document.getElementById("plan")!);

    let selectedReads = 0;
    let checkedReads = 0;
    const selectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.get!;
    Object.defineProperty(select, "value", {
      configurable: true,
      get() {
        selectedReads += 1;
        return selectValue.call(this);
      },
    });
    for (const input of document.querySelectorAll("input")) {
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")!.get!;
      Object.defineProperty(input, "checked", {
        configurable: true,
        get() {
          checkedReads += 1;
          return desc.call(this);
        },
      });
    }

    const fields = scanCapturableFields();
    const byId = Object.fromEntries(fields.map((f) => [f.selector, f]));
    expect(byId["#st"]?.options).toEqual([
      { value: "KS", label: "Kansas" },
      { value: "MO", label: "Missouri" },
      { value: "NE", label: "Nebraska" },
    ]);
    expect(byId['input[type="radio"][name="entity"]']?.options).toEqual([
      { value: "I", label: "Individual" },
      { value: "G", label: "Group" },
    ]);
    expect(byId["#agree"]?.options).toEqual([]);
    expect(byId["#plan"]?.options).toEqual([{ value: "PPO", label: "Plan" }]);
    expect(JSON.stringify(fields)).not.toMatch(/selected|checked/i);
    expect(selectedReads).toBe(0);
    expect(checkedReads).toBe(0);
  });

  it("orders by visual reading position, not DOM tree order (grid-style form)", () => {
    // DOM order: phone → fax → last → first (common when markup lists
    // contact blocks before name inputs). Painted order: last/first on the
    // first row, then phone/fax below — what the trainer sees.
    document.body.innerHTML = `
      <input id="phone" type="text" />
      <input id="fax" type="text" />
      <input id="last" type="text" />
      <input id="first" type="text" />
    `;
    stubVisibleBox(document.getElementById("phone")!, { top: 80, left: 0 });
    stubVisibleBox(document.getElementById("fax")!, { top: 80, left: 200 });
    stubVisibleBox(document.getElementById("last")!, { top: 10, left: 0 });
    stubVisibleBox(document.getElementById("first")!, { top: 10, left: 200 });

    expect(scanCapturableFields().map((f) => f.selector)).toEqual([
      "#last",
      "#first",
      "#phone",
      "#fax",
    ]);
  });

  it("treats near-equal tops as one row (left→right)", () => {
    document.body.innerHTML = `
      <input id="b" type="text" />
      <input id="a" type="text" />
    `;
    stubVisibleBox(document.getElementById("b")!, { top: 12, left: 200 });
    stubVisibleBox(document.getElementById("a")!, { top: 10, left: 0 });
    expect(compareVisualPosition(
      document.getElementById("a")!,
      document.getElementById("b")!,
    )).toBeLessThan(0);
    expect(scanCapturableFields().map((f) => f.selector)).toEqual(["#a", "#b"]);
  });
});

// 2026-08-19 — the three scanner defects found by reproducing one example
// "Check status of certification application" page, where a radio group + an
// NPI box captured as one nameless row.
describe("scanCapturableFields — labelling and selector durability", () => {
  it("names a radio group by its QUESTION, not by whichever option came first", () => {
    // The reported failure: the row read "Practitioner certification
    // application" (option 1) instead of the question the group asks.
    document.body.innerHTML = `
      <p id="q">Please select which type of certification application you would like a status on:</p>
      <div role="radiogroup" aria-labelledby="q">
        <label for="t0">Practitioner certification application</label>
        <input type="radio" id="t0" name="type" value="practitioner" />
        <label for="t1">Facility/Autism Corporate Service Provider application</label>
        <input type="radio" id="t1" name="type" value="facility" />
      </div>
    `;
    for (const radio of document.querySelectorAll('input[type="radio"]')) stubVisibleBox(radio);

    const [group] = scanCapturableFields();
    expect(group?.label).toBe(
      "Please select which type of certification application you would like a status on:",
    );
    // The options keep their own text — the question replaces the ROW name only.
    expect(group?.options).toEqual([
      { value: "practitioner", label: "Practitioner certification application" },
      { value: "facility", label: "Facility/Autism Corporate Service Provider application" },
    ]);
  });

  it("falls back to nearby caption text when the form wires no label at all", () => {
    // One example NPI box: caption is a plain sibling <p>, no for=, no aria,
    // no placeholder — so the row captured nameless and unmappable.
    document.body.innerHTML = `
      <div id="npi-panel">
        <p>*Enter the NPI associated with the application:</p>
        <input type="text" id="npi" name="npi" />
      </div>
    `;
    stubVisibleBox(document.getElementById("npi")!);

    const [field] = scanCapturableFields();
    expect(field?.label).toBe("*Enter the NPI associated with the application:");
  });

  it("does not borrow the caption of a sibling that owns its own control", () => {
    document.body.innerHTML = `
      <div><p>First name</p><input type="text" id="first" /></div>
      <div><input type="text" id="second" /></div>
    `;
    stubVisibleBox(document.getElementById("first")!);
    stubVisibleBox(document.getElementById("second")!);

    const byId = Object.fromEntries(scanCapturableFields().map((f) => [f.selector, f]));
    expect(byId["#first"]?.label).toBe("First name");
    // Stealing "First name" here would mislabel a different field entirely.
    expect(byId["#second"]?.label).toBe("");
  });

  it("ignores a paragraph of prose as a label guess", () => {
    const prose = "x".repeat(200);
    document.body.innerHTML = `<div><p>${prose}</p><input type="text" id="lonely" /></div>`;
    stubVisibleBox(document.getElementById("lonely")!);
    expect(scanCapturableFields()[0]?.label).toBe("");
  });

  it("still prefers a wired label over nearby text", () => {
    document.body.innerHTML = `
      <div>
        <p>Some nearby heading</p>
        <label for="npi">NPI (Type 1)</label>
        <input type="text" id="npi" />
      </div>
    `;
    stubVisibleBox(document.getElementById("npi")!);
    expect(scanCapturableFields()[0]?.label).toBe("NPI (Type 1)");
  });

  it("gives an id-less, name-less control a selector that RESOLVES", () => {
    // The real bug: `input:nth-of-type(4)` came from the document-wide query
    // index while :nth-of-type counts among siblings, so it matched nothing —
    // the field could never be filled, nor re-found on re-capture.
    document.body.innerHTML = `
      <div id="wrap"><span>Extra</span><input type="text" /></div>
    `;
    const el = document.querySelector("#wrap input")!;
    stubVisibleBox(el);

    const [field] = scanCapturableFields();
    expect(field!.selector).toBe("#wrap > input:nth-child(2)");
    expect(document.querySelectorAll(field!.selector)).toHaveLength(1);
    expect(document.querySelector(field!.selector)).toBe(el);
  });

  it("anchors the structural path at the nearest id-bearing ancestor", () => {
    document.body.innerHTML = `
      <section id="anchor"><div><div><input type="text" /></div></div></section>
    `;
    const el = document.querySelector("#anchor input")!;
    stubVisibleBox(el);

    const [field] = scanCapturableFields();
    expect(field!.selector.startsWith("#anchor > ")).toBe(true);
    expect(document.querySelector(field!.selector)).toBe(el);
  });

  it("falls back to a body-rooted path when no ancestor has an id", () => {
    document.body.innerHTML = `<form><div><input type="text" /></div></form>`;
    const el = document.querySelector("input")!;
    stubVisibleBox(el);

    const [field] = scanCapturableFields();
    expect(field!.selector.startsWith("body > ")).toBe(true);
    expect(document.querySelector(field!.selector)).toBe(el);
  });
});
