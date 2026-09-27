import { JSDOM } from "jsdom";

/**
 * R0 fixture provenance. These builders contain synthetic markup only. No
 * authenticated payer page or installed-extension capture was available.
 */
export const PORTAL_DOM_FIXTURE_MANIFEST = {
  id: "portal-dom-r0-synthetic-v1",
  provenance: "synthetic-local-builder",
  liveEvidenceAvailable: false,
  liveEvidenceUnavailableFor: ["Aetna", "BCBS", "Optum"],
  productionFixEvidence: false,
  notes: [
    "Generic scenarios inspired by the requirements in SPIKE-PORTAL-FILLER-01.",
    "No payer-specific page, field selector, or accepted-value rule is reproduced.",
    "Fixture integrity tests validate the generated scenarios only.",
  ],
} as const;

export interface StaticWizardPage {
  readonly stepId: string;
  readonly url: string;
  readonly heading: string;
  readonly html: string;
}

const SYNTHETIC_ORIGIN = "https://portal.synthetic.invalid";

const WIZARD_STEPS = [
  { stepId: "provider", heading: "Provider Details", field: "providerName" },
  { stepId: "practice", heading: "Practice Details", field: "practiceName" },
  { stepId: "contact", heading: "Contact Details", field: "contactEmail" },
  { stepId: "licensure", heading: "Licensure Details", field: "licenseNumber" },
  { stepId: "coverage", heading: "Coverage Details", field: "coverageStartDate" },
  { stepId: "practice-review", heading: "Practice Details", field: "practiceIdentifier" },
  { stepId: "review", heading: "Review and Attest", field: "reviewAcknowledgement" },
] as const;

function wizardPageMarkup(stepId: string, heading: string, field: string): string {
  const progress = WIZARD_STEPS.map(({ stepId: id, heading: label }) =>
    `<li data-step-id="${id}"${id === stepId ? ' aria-current="step" data-current-step="true"' : ""}>${label}</li>`,
  ).join("");

  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Synthetic enrollment fixture</title></head>
  <body>
    <main data-fixture="synthetic" data-wizard-id="seven-step-static-url">
      <nav aria-label="Enrollment progress"><ol>${progress}</ol></nav>
      <section data-step-id="${stepId}" data-active-step="true">
        <h1>${heading}</h1>
        <form autocomplete="off">
          <label for="${field}">${heading} field</label>
          <input id="${field}" name="${field}" type="text">
        </form>
      </section>
    </main>
  </body>
</html>`;
}

/** Build seven snapshots at one static URL, distinguished by active step identity. */
export function buildSevenStepStaticWizardFixture(): readonly StaticWizardPage[] {
  return WIZARD_STEPS.map(({ stepId, heading, field }) => ({
    stepId,
    url: `${SYNTHETIC_ORIGIN}/enrollment`,
    heading,
    html: wizardPageMarkup(stepId, heading, field),
  }));
}

export interface StepIdentityFixtures {
  readonly unknown: StaticWizardPage;
  readonly ambiguous: StaticWizardPage;
  readonly repeatedHeading: readonly [StaticWizardPage, StaticWizardPage];
}

/** Build identity edge cases without encoding any production resolver result. */
export function buildStepIdentityFixtures(): StepIdentityFixtures {
  const unknown: StaticWizardPage = {
    stepId: "unknown",
    url: `${SYNTHETIC_ORIGIN}/enrollment/pending`,
    heading: "Loading enrollment section",
    html: `<!doctype html><html lang="en"><body>
      <main data-fixture="synthetic"><h1>Loading enrollment section</h1>
      <p>No active step marker is present in this fixture.</p></main>
    </body></html>`,
  };

  const ambiguous: StaticWizardPage = {
    stepId: "ambiguous",
    url: `${SYNTHETIC_ORIGIN}/enrollment/ambiguous`,
    heading: "Practice Details",
    html: `<!doctype html><html lang="en"><body>
      <main data-fixture="synthetic">
        <nav aria-label="Enrollment progress"><ol>
          <li data-step-id="practice-a" aria-current="step" data-current-step="true">Practice Details</li>
          <li data-step-id="practice-b" aria-current="step" data-current-step="true">Practice Details</li>
        </ol></nav>
        <h1>Practice Details</h1><h1>Practice Details</h1>
      </main>
    </body></html>`,
  };

  const pages = buildSevenStepStaticWizardFixture();
  const firstPracticePage = pages.find((page) => page.stepId === "practice");
  const secondPracticePage = pages.find((page) => page.stepId === "practice-review");
  if (!firstPracticePage || !secondPracticePage) {
    throw new Error("Synthetic wizard is missing its repeated-heading pages");
  }

  return {
    unknown,
    ambiguous,
    repeatedHeading: [firstPracticePage, secondPracticePage],
  };
}

export interface DisposableDomFixture {
  readonly dom: JSDOM;
  dispose(): void;
}

/** A hidden section becomes visible after a deterministic, test-controlled delay. */
export function buildHiddenDelayedPanelFixture(delayMs = 40): DisposableDomFixture {
  const dom = new JSDOM(`<!doctype html><html lang="en"><body>
    <main data-fixture="synthetic">
      <h1>Coverage Details</h1>
      <section id="conditional-panel" hidden style="display: none">
        <label for="coverage-id">Coverage identifier</label>
        <input id="coverage-id" name="coverageId" type="text">
      </section>
    </main>
  </body></html>`, { url: `${SYNTHETIC_ORIGIN}/enrollment/coverage` });
  const panel = dom.window.document.querySelector<HTMLElement>("#conditional-panel");
  if (!panel) throw new Error("Synthetic delayed panel was not created");

  const timer = setTimeout(() => {
    panel.hidden = false;
    panel.style.display = "block";
  }, delayMs);

  return {
    dom,
    dispose() {
      clearTimeout(timer);
      dom.window.close();
    },
  };
}

export interface FrameFixture {
  readonly name: string;
  readonly url: string;
  readonly dom: JSDOM;
}

export interface DuplicateLabelFramesFixture {
  readonly host: JSDOM;
  readonly frames: readonly [FrameFixture, FrameFixture];
  dispose(): void;
}

function frameMarkup(inputName: string): string {
  return `<!doctype html><html lang="en"><body>
    <form autocomplete="off">
      <label for="state">State</label>
      <select id="state" name="${inputName}"><option value="">Choose a state</option></select>
    </form>
  </body></html>`;
}

/** Build two independent frame documents with the same visible label. */
export function buildDuplicateLabelFramesFixture(): DuplicateLabelFramesFixture {
  const frameA = {
    name: "billing-frame",
    url: "https://billing.synthetic.invalid/frame-a",
    dom: new JSDOM(frameMarkup("billingState"), { url: "https://billing.synthetic.invalid/frame-a" }),
  } as const;
  const frameB = {
    name: "practice-frame",
    url: "https://practice.synthetic.invalid/frame-b",
    dom: new JSDOM(frameMarkup("practiceState"), { url: "https://practice.synthetic.invalid/frame-b" }),
  } as const;
  const host = new JSDOM(`<!doctype html><html lang="en"><body>
    <main data-fixture="synthetic">
      <iframe title="Billing section" name="${frameA.name}" data-fixture-frame="${frameA.name}" src="${frameA.url}"></iframe>
      <iframe title="Practice section" name="${frameB.name}" data-fixture-frame="${frameB.name}" src="${frameB.url}"></iframe>
    </main>
  </body></html>`, { url: `${SYNTHETIC_ORIGIN}/enrollment/frames` });

  return {
    host,
    frames: [frameA, frameB],
    dispose() {
      host.window.close();
      frameA.dom.window.close();
      frameB.dom.window.close();
    },
  };
}

export interface DateReversionFixture extends DisposableDomFixture {
  readonly delayMs: number;
  readonly attemptedValue: string;
  readonly revertedValue: string;
}

/**
 * Simulate a generic delayed date-field reversion. This is a synthetic failure
 * shape, not a reproduction of any payer mask or extension behavior.
 */
export function buildDateReversionFixture(delayMs = 50): DateReversionFixture {
  const attemptedValue = "02/02/2025";
  const revertedValue = "02/02/6100";
  const dom = new JSDOM(`<!doctype html><html lang="en"><body>
    <main data-fixture="synthetic" data-fixture-behavior="delayed-date-reversion">
      <label for="effective-date">Effective date</label>
      <input id="effective-date" name="effectiveDate" type="text" inputmode="numeric" value="">
    </main>
  </body></html>`, { url: `${SYNTHETIC_ORIGIN}/enrollment/coverage` });
  const input = dom.window.document.querySelector<HTMLInputElement>("#effective-date");
  if (!input) throw new Error("Synthetic date field was not created");

  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      input.value = revertedValue;
      timer = undefined;
    }, delayMs);
  });

  return {
    dom,
    delayMs,
    attemptedValue,
    revertedValue,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      dom.window.close();
    },
  };
}

/**
 * Generic input constraints for identifiers where spaces are part of the
 * synthetic display shape. These are examples for adapter tests, not a payer
 * field specification.
 */
export function buildIdentifierConstraintsFixture(): DisposableDomFixture {
  const dom = new JSDOM(`<!doctype html><html lang="en"><body>
    <main data-fixture="synthetic" data-constraints="illustrative-only">
      <form autocomplete="off">
        <label for="group-npi">Group NPI</label>
        <input id="group-npi" name="groupNpi" type="text" inputmode="numeric"
          maxlength="12" pattern="[0-9]{3} [0-9]{3} [0-9]{4}" placeholder="123 456 7890">
        <label for="provider-id">Provider ID</label>
        <input id="provider-id" name="providerId" type="text" inputmode="text"
          maxlength="24" pattern="[A-Za-z0-9]+( [A-Za-z0-9]+)*" placeholder="AB 12345 67890">
      </form>
    </main>
  </body></html>`, { url: `${SYNTHETIC_ORIGIN}/enrollment/identifiers` });

  return { dom, dispose: () => dom.window.close() };
}
