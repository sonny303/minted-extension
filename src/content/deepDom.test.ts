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

  it("captures standalone open-shadow checkbox (BCBS cf-checkbox)", () => {
    const host = mountShadowCheckbox({
      name: "groupEnrolled",
      value: "true",
      label: "Group already enrolled or group enrollment form has already been submitted.",
    });
    document.body.append(host);

    const fields = scanCapturableFields();
    expect(fields).toHaveLength(1);
    expect(fields[0]?.fieldType).toBe("checkbox");
    expect(fields[0]?.selector).toBe('cf-checkbox[name="groupEnrolled"]');
    expect(fields[0]?.label).toBe(
      "Group already enrolled or group enrollment form has already been submitted.",
    );
  });

  it("captures grouped checkboxes with fixed option values (BCBS ethnicity/languages)", () => {
    const group = document.createElement("lh-checkbox-group");
    const legend = document.createElement("lh-group-legend");
    legend.setAttribute("slot", "legend");
    legend.textContent = "Race / Ethnicity (select all that apply)";
    group.append(legend);

    const nativeEl = mountShadowCheckbox({
      name: "ethnicity",
      value: "American Indian or Alaska Native",
      label: "American Indian or Alaska Native",
    });
    const asianEl = mountShadowCheckbox({
      name: "ethnicity",
      value: "Asian",
      label: "Asian (Asian Indian, Bangladeshi, Bhutanese...)",
    });
    group.append(nativeEl, asianEl);
    document.body.append(group);

    const fields = scanCapturableFields();
    expect(fields).toHaveLength(2);
    expect(fields[0]?.fieldType).toBe("checkbox");
    expect(fields[0]?.selector).toBe(
      'cf-checkbox[name="ethnicity"][value="American Indian or Alaska Native"]',
    );
    expect(fields[0]?.formSection).toBe(
      "Race / Ethnicity (select all that apply)",
    );

    expect(fields[1]?.fieldType).toBe("checkbox");
    expect(fields[1]?.selector).toBe(
      'cf-checkbox[name="ethnicity"][value="Asian"]',
    );
    expect(fields[1]?.label).toBe(
      "Asian (Asian Indian, Bangladeshi, Bhutanese...)",
    );
    expect(fields[1]?.options).toEqual([
      {
        value: "Asian",
        label: "Asian (Asian Indian, Bangladeshi, Bhutanese...)",
      },
    ]);
  });

  it("fills open-shadow checkbox and toggles checked state", () => {
    const host = mountShadowCheckbox({
      name: "groupEnrolled",
      value: "true",
      label: "Group already enrolled or group enrollment form has already been submitted.",
    });
    document.body.append(host);

    const result = applyFill([
      instr({
        label: "Group already enrolled",
        selector: 'cf-checkbox[name="groupEnrolled"]',
        fieldType: "checkbox",
        value: "true",
      }),
    ]);

    expect(result.filled).toEqual(["Group already enrolled"]);
    expect((host as MockCheckboxHost).checked).toBe(true);
    const shadowInner = host.shadowRoot?.querySelector('[role="checkbox"]');
    expect(shadowInner?.getAttribute("aria-checked")).toBe("true");
  });

  it("never checks a checkbox when instruction value is 'false', even if value attribute is 'false'", () => {
    const host = mountShadowCheckbox({
      name: "groupEnrolled",
      value: "false",
      label: "Group enrolled",
    });
    document.body.append(host);

    const result = applyFill([
      instr({
        label: "Group enrolled",
        selector: 'cf-checkbox[name="groupEnrolled"]',
        fieldType: "checkbox",
        value: "false",
      }),
    ]);

    expect(result.filled).toEqual(["Group enrolled"]);
    expect((host as MockCheckboxHost).checked).toBe(false);
    const shadowInner = host.shadowRoot?.querySelector('[role="checkbox"]');
    expect(shadowInner?.getAttribute("aria-checked")).toBe("false");
  });

  it("unchecks an already checked checkbox when instruction value is 'false'", () => {
    const host = mountShadowCheckbox({
      name: "groupEnrolled",
      value: "true",
      label: "Group enrolled",
    });
    (host as MockCheckboxHost).checked = true;
    const shadowInner = host.shadowRoot?.querySelector('[role="checkbox"]');
    shadowInner?.setAttribute("aria-checked", "true");
    document.body.append(host);

    const result = applyFill([
      instr({
        label: "Group enrolled",
        selector: 'cf-checkbox[name="groupEnrolled"]',
        fieldType: "checkbox",
        value: "false",
      }),
    ]);

    expect(result.filled).toEqual(["Group enrolled"]);
    expect((host as MockCheckboxHost).checked).toBe(false);
    expect(shadowInner?.getAttribute("aria-checked")).toBe("false");
  });
});

interface MockCheckboxHost extends HTMLElement {
  checked: boolean;
}

function mountShadowCheckbox(opts: {
  tag?: string;
  name: string;
  value?: string;
  label: string;
}): HTMLElement {
  const host = document.createElement(opts.tag ?? "cf-checkbox") as MockCheckboxHost;
  host.setAttribute("name", opts.name);
  if (opts.value !== undefined) host.setAttribute("value", opts.value);
  host.checked = false;
  host.textContent = opts.label;

  const shadow = host.attachShadow({ mode: "open" });
  const inner = document.createElement("div");
  inner.setAttribute("role", "checkbox");
  inner.setAttribute("aria-checked", "false");
  inner.addEventListener("click", () => {
    host.checked = !host.checked;
    inner.setAttribute("aria-checked", String(host.checked));
  });
  shadow.append(inner);
  stubVisibleBox(host);
  stubVisibleBox(inner);
  return host;
}
