/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  closestDeep,
  querySelectorAllDeep,
  querySelectorDeep,
} from "./deepDom";
import { applyFill, byLabel } from "./fillEngine";
import { scanCapturableFields } from "./captureScan";
import type { FillInstruction } from "../shared/fill";

// jsdom does not provide CSS.escape; captureScan / fillEngine use it.
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

function stubVisibleBox(el: Element): void {
  Object.defineProperty(el, "getClientRects", {
    configurable: true,
    value: () => [{ bottom: 1, height: 1, left: 0, right: 1, top: 0, width: 1 }],
  });
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 20,
      height: 20,
      left: 10,
      right: 110,
      top: 10,
      width: 100,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    }),
  });
}

function instr(over: Partial<FillInstruction> & { label: string; selector: string; value: string }): FillInstruction {
  return {
    mapId: over.mapId ?? "m1",
    label: over.label,
    selector: over.selector,
    selectorFallbacks: over.selectorFallbacks ?? [],
    fieldType: over.fieldType ?? "text",
    value: over.value,
    pageStep: over.pageStep ?? null,
  };
}

/** Litehouse-like open-shadow field: host carries the label, input is inside. */
function mountShadowInput(opts: {
  hostTag?: string;
  label: string;
  inputId: string;
  inputName?: string;
}): HTMLElement {
  const host = document.createElement(opts.hostTag ?? "lh-input");
  host.setAttribute("label", opts.label);
  const shadow = host.attachShadow({ mode: "open" });
  const input = document.createElement("input");
  input.id = opts.inputId;
  if (opts.inputName) input.name = opts.inputName;
  shadow.append(input);
  document.body.append(host);
  stubVisibleBox(input);
  return host;
}

describe("querySelectorAllDeep", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("finds controls inside open shadow roots", () => {
    mountShadowInput({ label: "CAQH ID Number", inputId: "caqh" });
    const light = document.createElement("input");
    light.id = "light";
    document.body.append(light);

    const found = querySelectorAllDeep("input");
    expect(found.map((el) => el.id).sort()).toEqual(["caqh", "light"]);
    expect(querySelectorDeep("#caqh")?.id).toBe("caqh");
  });

  it("closestDeep climbs onto the shadow host", () => {
    const group = document.createElement("lh-radio-group");
    group.setAttribute("role", "radiogroup");
    const host = document.createElement("lh-radio");
    const shadow = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "participation";
    input.value = "yes";
    shadow.append(input);
    group.append(host);
    document.body.append(group);

    expect(closestDeep(input, "lh-radio-group")).toBe(group);
  });
});

describe("shadow-aware capture and fill", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("scans a shadowed text input and names it from the host label", () => {
    mountShadowInput({
      label: "CAQH ID Number",
      inputId: "caqh-id",
      inputName: "caqhId",
    });
    const fields = scanCapturableFields();
    expect(fields).toHaveLength(1);
    expect(fields[0]?.label).toBe("CAQH ID Number");
    expect(fields[0]?.selector).toMatch(/caqh/i);
  });

  it("fills a shadowed input via #id and composed events", () => {
    mountShadowInput({ label: "CAQH ID Number", inputId: "caqh-id" });
    const input = querySelectorDeep("#caqh-id") as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener("input", (e) => {
      events.push(`input:${(e as Event).composed}`);
    });

    const result = applyFill([
      instr({ label: "CAQH ID Number", selector: "#caqh-id", value: "12345678" }),
    ]);
    expect(result.filled).toEqual(["CAQH ID Number"]);
    expect(input.value).toBe("12345678");
    expect(events).toContain("input:true");
  });

  it("resolves label: selectors against host label attributes", () => {
    mountShadowInput({ label: "CAQH ID Number", inputId: "caqh-id" });
    expect(byLabel("CAQH ID Number")?.id).toBe("caqh-id");
  });

  it("captures radio groups that live under shadowed hosts", () => {
    const group = document.createElement("lh-radio-group");
    group.setAttribute("role", "radiogroup");
    const legend = document.createElement("lh-group-legend");
    legend.setAttribute("slot", "legend");
    legend.textContent = "Choose one?";
    group.append(legend);

    for (const [value, text] of [
      ["participating", "Participating contract request"],
      ["non", "Non-participating enrollment"],
    ] as const) {
      const host = document.createElement("lh-radio");
      const shadow = host.attachShadow({ mode: "open" });
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "participationRequest";
      input.value = value;
      shadow.append(input);
      const caption = document.createElement("span");
      caption.textContent = text;
      host.append(caption);
      group.append(host);
      stubVisibleBox(input);
    }
    document.body.append(group);

    const fields = scanCapturableFields();
    expect(fields).toHaveLength(1);
    expect(fields[0]?.fieldType).toBe("radio");
    expect(fields[0]?.label).toBe("Choose one?");
    expect(fields[0]?.options?.map((o) => o.value)).toEqual([
      "participating",
      "non",
    ]);
  });
});
