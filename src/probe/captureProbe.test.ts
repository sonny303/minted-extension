/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { classifyAction, probePage } from "./captureProbe";

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

/** jsdom reports zero-size rects; give every element a visible box, stacked
 * top-to-bottom in DOM order. Positive hiding (display:none etc.) still
 * applies through getComputedStyle. */
function stubVisibleBoxes(): void {
  document.body.querySelectorAll("*").forEach((el, i) => {
    const rect = {
      x: 0, y: i * 40, top: i * 40, left: 0, right: 120, bottom: i * 40 + 24,
      width: 120, height: 24, toJSON() { return this; },
    };
    el.getBoundingClientRect = () => rect as DOMRect;
    el.getClientRects = () => [rect] as unknown as DOMRectList;
  });
}

function render(html: string): void {
  document.body.innerHTML = html;
  stubVisibleBoxes();
}

/** One Qualtrics page as BlueKC serves it: every question is a
 * `.QuestionOuter#QIDn`, nav buttons are #PreviousButton / #NextButton. */
function qualtricsPage(qids: string[], nextCaption = "Next"): string {
  const questions = qids
    .map((qid) => `
      <div class="QuestionOuter BorderColor TE ${qid}" id="${qid}">
        <label for="QR~${qid}" class="QuestionText">Question ${qid}</label>
        <input type="text" id="QR~${qid}" />
      </div>`)
    .join("");
  return `
    <div id="Questions">${questions}</div>
    <div id="Buttons">
      <button id="PreviousButton" class="PreviousButton Button">Back</button>
      <button id="NextButton" class="NextButton Button">${nextCaption}</button>
    </div>`;
}

describe("probePage — fields", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/enroll/step-2?session=abc123&npi=1999999984");
    document.title = "Provider Enrollment";
    render(`
      <h1>Practitioner Information</h1>
      <form>
        <label for="first">First Name</label>
        <input id="first" name="first" required value="TYPED-VALUE" />
        <label for="npi">NPI</label>
        <input id="npi" name="npi" aria-required="true" />
        <fieldset>
          <legend>Accepting new patients?</legend>
          <label><input type="radio" name="anp" value="Y" required /> Yes</label>
          <label><input type="radio" name="anp" value="N" checked /> No</label>
        </fieldset>
        <label for="spec">Specialty</label>
        <select id="spec"><option value="">--</option><option value="PT" selected>Physical Therapy</option></select>
        <button type="button" id="back">Back</button>
        <input type="submit" id="go" value="Next" />
      </form>
      <iframe src="https://docs.example.com/viewer/form.pdf?token=secret"></iframe>`);
  });

  it("returns the scanner's rows with position and required flags", () => {
    const page = probePage();
    expect(page.fields.map((f) => [f.label, f.fieldType, f.sortOrder, f.required])).toEqual([
      ["First Name", "text", 0, true],
      ["NPI", "text", 1, true],
      ["Accepting new patients?", "radio", 2, true],
      ["Specialty", "select", 3, false],
    ]);
  });

  it("never carries a typed, checked, or selected value", () => {
    const serialized = JSON.stringify(probePage());
    expect(serialized).not.toContain("TYPED-VALUE");
    expect(serialized).not.toContain('"checked"');
    expect(serialized).not.toContain('"selected"');
  });

  it("drops query strings from the page and frame urls", () => {
    const page = probePage();
    expect(page.url).toBe("http://localhost:3000/enroll/step-2");
    expect(page.frames).toEqual(["https://docs.example.com/viewer/form.pdf"]);
    expect(JSON.stringify(page)).not.toContain("1999999984");
  });

  it("names the page and labels its navigation with selectors", () => {
    const page = probePage();
    expect(page.heading).toBe("Practitioner Information");
    expect(page.title).toBe("Provider Enrollment");
    expect(page.platform).toBeNull();
    expect(page.navigation).toEqual([
      { kind: "back", caption: "Back", selector: "#back", disabled: false },
      { kind: "advance", caption: "Next", selector: "#go", disabled: false },
    ]);
  });
});

describe("probePage — option vocabulary", () => {
  it("keeps every option, past the panel's 50-option proposal cap", () => {
    const specialties = Array.from({ length: 146 }, (_, i) => `<option value="${i + 1}">Specialty ${i + 1}</option>`).join("");
    render(`<label for="spec">Primary specialty</label><select id="spec">${specialties}</select>`);
    const [field] = probePage().fields;
    expect(field?.options).toHaveLength(146);
    expect(field?.options?.[120]).toEqual({ value: "121", label: "Specialty 121" });
  });
});

describe("probePage — navigation, dialogs, errors", () => {
  it("classifies a Qualtrics last page's NextButton by its caption: Submit is never 'advance'", () => {
    render(qualtricsPage(["QID9"], "Submit"));
    expect(probePage().navigation.map((a) => [a.selector, a.kind])).toEqual([
      ["#PreviousButton", "back"],
      ["#NextButton", "submit"],
    ]);
  });

  it("reports Next as submit when the page says Next submits (BlueKC's last page)", () => {
    render(`
      <div id="Questions"><div class="QuestionOuter DB" id="QID181">
        <div class="QuestionText">Click on the "Next" button below to submit this form now. This form will not submit until you click the "Next" button.</div>
      </div></div>
      <div id="Buttons"><button id="PreviousButton">Back</button><button id="NextButton">Next</button></div>`);
    const page = probePage();
    expect(page.submitWarning).toBe(true);
    expect(page.navigation.map((a) => [a.selector, a.kind])).toEqual([
      ["#PreviousButton", "back"],
      ["#NextButton", "submit"],
    ]);
  });

  it("does not treat an intro's mention of submitting as a submit page", () => {
    render(`
      <div id="Questions"><div class="QuestionOuter DB" id="QID85">
        <div class="QuestionText">Upon submission, Blue KC will send a confirmation. Do not clear any cookies on your device until you have submitted the form.</div>
      </div></div>
      <div id="Buttons"><button id="NextButton">Next</button></div>`);
    const page = probePage();
    expect(page.submitWarning).toBe(false);
    expect(page.navigation[0]?.kind).toBe("advance");
  });

  it("reports a popup's buttons as dismiss actions, apart from page navigation", () => {
    render(`
      ${qualtricsPage(["QID1"])}
      <div role="dialog" id="info">
        <p>Your session was outdated, but we have updated you to your most recent response.</p>
        <button id="ok">OK</button>
      </div>`);
    const page = probePage();
    expect(page.dialogs).toEqual([
      {
        text: "Your session was outdated, but we have updated you to your most recent response. OK",
        actions: [{ kind: "dismiss", caption: "OK", selector: "#ok", disabled: false }],
      },
    ]);
    expect(page.navigation.map((a) => a.selector)).toEqual(["#PreviousButton", "#NextButton"]);
  });

  it("ties a forced-response message to the question's field — the page's gate", () => {
    render(`
      <div class="QuestionOuter MC QID180" id="QID180">
        <fieldset>
          <legend>Are you located in these counties?</legend>
          <input type="radio" id="QR~QID180~1" name="QR~QID180" value="1" /><label for="QR~QID180~1">Yes</label>
          <input type="radio" id="QR~QID180~2" name="QR~QID180" value="2" /><label for="QR~QID180~2">No</label>
        </fieldset>
        <div class="ValidationError" role="alert">Please answer this question.</div>
      </div>
      <input type="text" id="other" aria-invalid="true" />
      <div class="ValidationError" style="display:none">Stale message</div>`);
    expect(probePage().errors).toEqual([
      { message: "Please answer this question.", selector: "#QR\\~QID180\\~1", question: "QID180" },
      { message: "", selector: "#other", question: null },
    ]);
  });

  it("never pins a control-less question's error on a neighbouring field (BlueKC signature pad)", () => {
    render(`
      <div id="Questions">
        <div class="QuestionOuter MC QID180" id="QID180">
          <fieldset>
            <legend>Are you located in these counties?</legend>
            <input type="radio" id="QR~QID180~1" name="QR~QID180" value="1" /><label for="QR~QID180~1">Yes</label>
          </fieldset>
        </div>
        <div class="QuestionOuter Draw QID92" id="QID92">
          <div class="QuestionBody"><canvas width="300" height="100"></canvas></div>
          <div class="ValidationError" role="alert">Please answer this question.</div>
        </div>
      </div>`);
    expect(probePage().errors).toEqual([
      { message: "Please answer this question.", selector: null, question: "QID92" },
    ]);
  });

  it("reads a PrimeFaces button's caption past its empty aria-label (BCBSKS Submit)", () => {
    render(`
      <form id="networkEnrollmentForm">
        <input type="text" id="networkEnrollmentForm:ContactFirstName" />
        <button id="networkEnrollmentForm:submitBtn" name="networkEnrollmentForm:submitBtn" type="submit"
          class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only bcbsks-button blue-button"
          aria-label=""><span class="ui-button-text ui-c">Submit</span></button>
      </form>`);
    expect(probePage().navigation).toEqual([
      { kind: "submit", caption: "Submit", selector: "#networkEnrollmentForm\\:submitBtn", disabled: false },
    ]);
  });

  it("classifies captions conservatively", () => {
    expect(classifyAction("Save and Continue", "", false)).toBe("advance");
    expect(classifyAction("Save for later", "", false)).toBe("save");
    expect(classifyAction("Complete Application", "NextButton", false)).toBe("submit");
    expect(classifyAction("", "NextButton", false)).toBe("advance");
    expect(classifyAction("", "networkEnrollmentForm:submitBtn ui-button", false)).toBe("submit");
    expect(classifyAction("", "wizardNextOrFinish", false)).toBe("submit");
    expect(classifyAction("OK", "", false)).toBe("other");
    expect(classifyAction("OK", "", true)).toBe("dismiss");
  });

  it("reads Qualtrics' soft-required popup: skip is an advance, answering is a dismiss", () => {
    render(`
      ${qualtricsPage(["QID212"])}
      <div role="dialog">
        <p>Response Requested There is 1 unanswered question on this page. Would you like to continue?</p>
        <button id="skip">Continue Without Answering</button>
        <button id="answer">Answer the Question</button>
      </div>`);
    expect(probePage().dialogs[0]?.actions.map((a) => [a.selector, a.kind])).toEqual([
      ["#skip", "advance"],
      ["#answer", "dismiss"],
    ]);
  });
});

describe("probePage — fingerprint", () => {
  it("identifies a Qualtrics page by its QIDs, since every page shares one url", () => {
    render(qualtricsPage(["QID86", "QID180", "QID185"]));
    const first = probePage();
    expect(first.platform).toBe("qualtrics");
    expect(first.fingerprint.keys).toEqual(["QID180", "QID185", "QID86"]);

    render(qualtricsPage(["QID86", "QID180", "QID185"]));
    expect(probePage().fingerprint.hash).toBe(first.fingerprint.hash);

    render(qualtricsPage(["QID86", "QID181", "QID185"]));
    expect(probePage().fingerprint.hash).not.toBe(first.fingerprint.hash);
  });

  it("ignores questions hidden by display logic", () => {
    render(`${qualtricsPage(["QID1", "QID2"])}<div class="QuestionOuter" id="QID3" style="display:none"></div>`);
    expect(probePage().fingerprint.keys).toEqual(["QID1", "QID2"]);
  });

  it("tells field-less pages apart by their copy without storing it", () => {
    render(`<main><p>Welcome to the interest form.</p></main><button id="n">Next</button>`);
    const intro = probePage();
    render(`<main><p>Thank you, Dr. Example, we received it.</p></main><button id="n">Next</button>`);
    const done = probePage();
    expect(intro.fingerprint.keys).toEqual([]);
    expect(done.fingerprint.hash).not.toBe(intro.fingerprint.hash);
    expect(JSON.stringify(done)).not.toContain("Dr. Example");
  });
});
