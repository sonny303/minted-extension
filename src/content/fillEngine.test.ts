/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { applyFill } from "./fillEngine";
import type { FillInstruction } from "../shared/fill";

function instr(over: Partial<FillInstruction> & Pick<FillInstruction, "label" | "selector">): FillInstruction {
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
    const result = applyFill([instr({ label: "First Name", selector: "label:First Name", value: "Ada" })]);
    expect(result.filled).toEqual(["First Name"]);
    expect((document.getElementById("fn") as HTMLInputElement).value).toBe("Ada");
    expect((document.getElementById("pfn") as HTMLInputElement).value).toBe("");
  });

  it("fills by CSS selector and reports not-found with the pinned reason", () => {
    document.body.innerHTML = `<input id="npi" type="text" />`;
    const hit = applyFill([instr({ label: "NPI", selector: "#npi", value: "123" })]);
    expect(hit.filled).toEqual(["NPI"]);
    expect((document.getElementById("npi") as HTMLInputElement).value).toBe("123");

    const miss = applyFill([instr({ label: "Missing", selector: "#gone", value: "x" })]);
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
    expect((document.getElementById("alt") as HTMLInputElement).value).toBe("ok");
  });

  it("skips disabled/readonly and file inputs", () => {
    document.body.innerHTML = `
      <input id="ro" type="text" readonly />
      <input id="file" type="file" />
    `;
    const result = applyFill([
      instr({ label: "RO", selector: "#ro", value: "x" }),
      instr({ label: "File", selector: "#file", fieldType: "file", value: "x" }),
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
      instr({ label: "State", selector: "#st", fieldType: "select", value: "Missouri" }),
      instr({ label: "Agree", selector: "#cb", fieldType: "checkbox", value: "yes" }),
    ]);
    expect(result.filled).toEqual(["State", "Agree"]);
    expect((document.getElementById("st") as HTMLSelectElement).value).toBe("MO");
    expect((document.getElementById("cb") as HTMLInputElement).checked).toBe(true);
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
