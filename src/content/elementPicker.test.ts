/**
 * @vitest-environment jsdom
 */
// The manual element picker. The behaviours worth pinning are the ones that
// would be destructive on a live portal form: the pick must not activate the
// control it lands on, and it must not leave the page decorated when it ends.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelElementPick, countSelectorMatches, isPicking, startElementPick } from "./elementPicker";

// jsdom has no CSS.escape; captureScan (via describeControl) needs it.
if (typeof CSS === "undefined" || typeof CSS.escape !== "function") {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { escape: (v: string) => String(v).replace(/([^\w-])/g, "\\$1") },
  });
}

afterEach(() => {
  cancelElementPick();
  document.body.innerHTML = "";
});

function clickOn(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("startElementPick", () => {
  it("resolves with the clicked control, described exactly as a scan would", async () => {
    document.body.innerHTML = `
      <div id="wrap"><p>*Enter the NPI associated with the application:</p>
      <input type="text" id="npi" name="npi" /></div>
    `;
    const pick = startElementPick();
    clickOn(document.getElementById("npi")!);

    const outcome = await pick;
    expect(outcome.status).toBe("picked");
    if (outcome.status !== "picked") return;
    expect(outcome.field.selector).toBe("#npi");
    expect(outcome.field.fieldType).toBe("text");
    // The same nearby-caption rule the scanner uses — one description, not two.
    expect(outcome.field.label).toBe("*Enter the NPI associated with the application:");
  });

  it("resolves a clicked LABEL to the control it names", async () => {
    document.body.innerHTML = `
      <label for="npi">NPI</label><input type="text" id="npi" />
    `;
    const pick = startElementPick();
    clickOn(document.querySelector("label")!);

    const outcome = await pick;
    expect(outcome.status === "picked" && outcome.field.selector).toBe("#npi");
  });

  it("does NOT let the click reach the page", async () => {
    // Picking a radio on a live portal must not also select it, and picking
    // near a submit must not navigate the form away mid-training.
    document.body.innerHTML = `<input type="radio" id="opt" name="type" value="a" />`;
    const radio = document.getElementById("opt") as HTMLInputElement;
    const pageHandler = vi.fn();
    radio.addEventListener("click", pageHandler);

    const pick = startElementPick();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    radio.dispatchEvent(event);
    await pick;

    expect(pageHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("stays in pick mode when the click lands on nothing mappable", async () => {
    document.body.innerHTML = `<p id="prose">Just text</p><input type="text" id="npi" />`;
    const pick = startElementPick();

    clickOn(document.getElementById("prose")!);
    expect(isPicking()).toBe(true); // still waiting, not resolved as a miss

    clickOn(document.getElementById("npi")!);
    const outcome = await pick;
    expect(outcome.status === "picked" && outcome.field.selector).toBe("#npi");
  });

  it("cancels on Escape — a normal outcome, not an error", async () => {
    document.body.innerHTML = `<input type="text" id="npi" />`;
    const pick = startElementPick();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect((await pick).status).toBe("cancelled");
  });

  it("cancels from outside (panel closed / tab switched)", async () => {
    document.body.innerHTML = `<input type="text" id="npi" />`;
    const pick = startElementPick();
    cancelElementPick();
    expect((await pick).status).toBe("cancelled");
  });

  it("leaves no overlay, hint or cursor class behind when it ends", async () => {
    document.body.innerHTML = `<input type="text" id="npi" />`;
    const pick = startElementPick();
    expect(document.getElementById("__minted-panel-pick-overlay")).not.toBeNull();
    expect(document.documentElement.classList.contains("__mp-pick-active")).toBe(true);

    clickOn(document.getElementById("npi")!);
    await pick;

    expect(document.getElementById("__minted-panel-pick-overlay")).toBeNull();
    expect(document.getElementById("__minted-panel-pick-hint")).toBeNull();
    expect(document.documentElement.classList.contains("__mp-pick-active")).toBe(false);
    expect(isPicking()).toBe(false);
  });

  it("a second pick cancels the first instead of running two overlays", async () => {
    document.body.innerHTML = `<input type="text" id="npi" />`;
    const first = startElementPick();
    const second = startElementPick();
    expect((await first).status).toBe("cancelled");

    clickOn(document.getElementById("npi")!);
    expect((await second).status).toBe("picked");
    // Exactly one overlay existed at a time, and none survives.
    expect(document.querySelectorAll("#__minted-panel-pick-overlay")).toHaveLength(0);
  });

  it("never reads the control's value", async () => {
    document.body.innerHTML = `<input type="text" id="npi" value="1891243838" />`;
    const pick = startElementPick();
    clickOn(document.getElementById("npi")!);
    const outcome = await pick;
    expect(JSON.stringify(outcome)).not.toContain("1891243838");
  });
});

describe("countSelectorMatches", () => {
  it("answers the re-test question: 0 / 1 / ambiguous", () => {
    document.body.innerHTML = `
      <input type="text" id="npi" />
      <input type="text" class="dup" /><input type="text" class="dup" />
    `;
    expect(countSelectorMatches("#npi")).toBe(1);
    expect(countSelectorMatches("#nope")).toBe(0);
    expect(countSelectorMatches(".dup")).toBe(2);
  });

  it("treats an invalid selector as zero rather than throwing at the boundary", () => {
    // A hand-edited selector reaching the content script must not crash it.
    expect(countSelectorMatches("###")).toBe(0);
  });
});
