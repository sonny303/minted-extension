/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { isCapturableControl, scanCapturableFields } from "./captureScan";

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
 * attribute / style hiding is what the tests exercise. */
function stubVisibleBox(el: Element, size = { width: 120, height: 24 }): void {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: size.width,
    bottom: size.height,
    width: size.width,
    height: size.height,
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
    expect(fields.map((f) => f.selector)).toEqual(["#visible-npi", 'input[name="accepting"]']);
    expect(fields).toHaveLength(2);
    expect(fields[1]?.fieldType).toBe("radio");
    expect(fields[1]?.formSection).toBe("Accepting");
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
});
