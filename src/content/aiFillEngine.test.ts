/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { applyAiFill, acceptAiFill, clearAiFill, finalizeAiFill } from "./aiFillEngine";
import { beginUnmappedControlScan } from "./controlScanner";
import { applyFill } from "./fillEngine";

if (typeof CSS === "undefined" || typeof CSS.escape !== "function") {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { escape: (value: string) => value.replace(/([^\w-])/g, "\\$1") },
  });
}

function visible(el: Element): void {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 24, width: 100, height: 24 };
  el.getClientRects = () => [rect] as unknown as DOMRectList;
  el.getBoundingClientRect = () => rect as DOMRect;
}

function scan(id: string): string {
  for (const el of document.querySelectorAll("input,select,textarea")) visible(el);
  const controls = beginUnmappedControlScan(id);
  expect(controls.length).toBeGreaterThan(0);
  return controls[0]!.selector;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("AI fill review", () => {
  it("writes an amber value with the catalog tooltip and Clear restores the original", () => {
    document.body.innerHTML = '<label for="npi">NPI</label><input id="npi" title="portal help">';
    const selector = scan("scan-clear");
    const result = applyAiFill("scan-clear", "fill-clear", [{
      mapId: "ai:#npi", label: selector, selector, selectorFallbacks: [], fieldType: "text",
      value: "12345", pageStep: null, kind: "ai", token: "provider.npi", confidence: 0.91,
    }]);
    const input = document.querySelector("#npi") as HTMLInputElement;
    expect(result.writes).toEqual([{ selector: "#npi", kind: "ai", token: "provider.npi", confidence: 0.91 }]);
    expect(input.value).toBe("12345");
    expect(input.classList.contains("mp-fill-ai")).toBe(true);
    expect(input.title).toBe("AI Suggested: provider.npi");

    expect(clearAiFill("fill-clear")).toBe(1);
    expect(input.value).toBe("");
    expect(input.classList.contains("mp-fill-ai")).toBe(false);
    expect(input.title).toBe("portal help");
  });

  it("preserves later human edits and their later tooltip during Clear", () => {
    document.body.innerHTML = '<input id="name" title="original">';
    const selector = scan("scan-human-edit");
    applyAiFill("scan-human-edit", "fill-human-edit", [{
      mapId: "ai:#name", label: selector, selector, selectorFallbacks: [], fieldType: "text",
      value: "Suggested", pageStep: null, kind: "ai", token: "provider.name", confidence: 0.9,
    }]);
    const input = document.querySelector("#name") as HTMLInputElement;
    input.value = "Human edit";
    input.title = "human tooltip";

    expect(clearAiFill("fill-human-edit")).toBe(0);
    expect(input.value).toBe("Human edit");
    expect(input.title).toBe("human tooltip");
    expect(input.classList.contains("mp-fill-ai")).toBe(false);
  });

  it("rejects nonempty or replaced targets after scan", () => {
    document.body.innerHTML = '<input id="field">';
    let selector = scan("scan-nonempty");
    const input = document.querySelector("#field") as HTMLInputElement;
    input.value = "typed by human";
    const nonempty = applyAiFill("scan-nonempty", "fill-nonempty", [{
      mapId: "ai:#field", label: selector, selector, selectorFallbacks: [], fieldType: "text",
      value: "suggested", pageStep: null, kind: "ai", token: "provider.name", confidence: 0.9,
    }]);
    expect(nonempty.writes).toEqual([]);
    expect(input.value).toBe("typed by human");

    document.body.innerHTML = '<input id="field">';
    selector = scan("scan-replaced");
    const original = document.querySelector("#field") as HTMLInputElement;
    original.replaceWith(Object.assign(document.createElement("input"), { id: "field" }));
    const replaced = applyAiFill("scan-replaced", "fill-replaced", [{
      mapId: "ai:#field", label: selector, selector, selectorFallbacks: [], fieldType: "text",
      value: "suggested", pageStep: null, kind: "ai", token: "provider.name", confidence: 0.9,
    }]);
    expect(replaced.writes).toEqual([]);
    expect((document.querySelector("#field") as HTMLInputElement).value).toBe("");
  });

  it("does not count a matching disabled radio option as an AI write", () => {
    document.body.innerHTML = `
      <form>
        <label><input type="radio" name="plan" value="Basic">Basic</label>
        <label><input type="radio" name="plan" value="Premium" disabled>Premium</label>
      </form>`;
    const selector = scan("scan-disabled-radio");
    const result = applyAiFill("scan-disabled-radio", "fill-disabled-radio", [{
      mapId: "ai:radio", label: selector, selector, selectorFallbacks: [], fieldType: "radio",
      value: "Premium", pageStep: null, kind: "ai", token: "provider.plan", confidence: 0.9,
    }]);
    expect(result.writes).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("field is disabled or read-only");
    expect([...document.querySelectorAll<HTMLInputElement>('input[name="plan"]')].some((input) => input.checked)).toBe(false);
  });

  it("does not report a controlled input that rejects the attempted value", () => {
    document.body.innerHTML = '<input id="controlled">';
    const selector = scan("scan-readback");
    const input = document.querySelector<HTMLInputElement>("#controlled")!;
    input.addEventListener("input", () => { input.value = ""; });
    const result = applyAiFill("scan-readback", "fill-readback", [{
      mapId: "ai:#controlled", label: selector, selector, selectorFallbacks: [], fieldType: "text",
      value: "suggested", pageStep: null, kind: "ai", token: "provider.name", confidence: 0.9,
    }]);
    expect(result.writes).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("AI write did not read back");
    expect(input.value).toBe("");
  });

  it("keeps accepted writes clearable until submission, then gives static writes the green decoration", () => {
    document.body.innerHTML = '<input id="first"><input id="second">';
    scan("scan-accept");
    const first = document.querySelector("#first") as HTMLInputElement;
    const second = document.querySelector("#second") as HTMLInputElement;
    applyAiFill("scan-accept", "fill-accepted", [{
      mapId: "ai:#first", label: "#first", selector: "#first", selectorFallbacks: [], fieldType: "text",
      value: "Ada", pageStep: null, kind: "ai", token: "provider.firstName", confidence: 0.96,
    }]);
    acceptAiFill("fill-accepted");
    expect(clearAiFill("fill-accepted")).toBe(1);
    expect(first.value).toBe("");

    const acceptedAgain = scan("scan-finalize");
    applyAiFill("scan-finalize", "fill-finalized", [{
      mapId: "ai:#first", label: acceptedAgain, selector: acceptedAgain, selectorFallbacks: [], fieldType: "text",
      value: "Ada", pageStep: null, kind: "ai", token: "provider.firstName", confidence: 0.96,
    }]);
    finalizeAiFill("fill-finalized");
    expect(clearAiFill("fill-finalized")).toBe(0);
    expect(first.value).toBe("Ada");

    applyFill([{
      mapId: "m1", label: "Second", selector: "#second", selectorFallbacks: [],
      fieldType: "text", value: "Grace", pageStep: null, kind: "static",
    }]);
    expect(second.value).toBe("Grace");
    expect(second.classList.contains("mp-fill-static")).toBe(true);
  });
});
