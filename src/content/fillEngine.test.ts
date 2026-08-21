/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { applyFill, clearPortalForm } from "./fillEngine";
import { describeSelectorMatches } from "./elementPicker";
import type { FillInstruction } from "../shared/fill";

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
      { label: "Missing", reason: "field not found on this page", mapId: "m1" },
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

  it("TS-162 — names the control and a bounded option sample when a dropdown misses", () => {
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
    expect(miss.skipped[0]?.reason).toBe(
      'dropdown: no option matches "Colorado" (KS, MO, NE; 1 more)',
    );
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
      { label: "State", reason: "field not found on this page", mapId: "m1" },
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

  it("fires input+change so a controlled input sees the clear", () => {
    // Same reason applyFill uses the native setter: a React-style portal that
    // only listens to events would otherwise re-render the old value straight
    // back, leaving the form visibly unchanged.
    document.body.innerHTML = `<input id="t" type="text" value="Ada" />`;
    const input = document.querySelector<HTMLInputElement>("#t")!;
    const seen: string[] = [];
    input.addEventListener("input", () => seen.push("input"));
    input.addEventListener("change", () => seen.push("change"));
    clearPortalForm();
    expect(seen).toEqual(["input", "change"]);
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
