/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { applyFill, applyFillOnPage, clearPortalForm, probeFillOnPage } from "./fillEngine";
import { describeSelectorMatches } from "./elementPicker";
import type { FillInstruction } from "../shared/fill";
import { OTHER_PAGE_KIND, OTHER_PAGE_REASON, PAGE_UNKNOWN_KIND, PAGE_UNKNOWN_REASON } from "../shared/fillPage";
import { HIDDEN_KIND, HIDDEN_REASON } from "../shared/hiddenField";
import { FIELD_NOT_FOUND_REASON } from "../shared/fixit";
import { createFillEventV2OpaqueKey } from "../shared/fillEventV2";

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
    ...(over.pageUrlScope !== undefined ? { pageUrlScope: over.pageUrlScope } : {}),
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
