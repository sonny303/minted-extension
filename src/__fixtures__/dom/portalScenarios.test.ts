import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDateReversionFixture,
  buildDuplicateLabelFramesFixture,
  buildHiddenDelayedPanelFixture,
  buildIdentifierConstraintsFixture,
  buildSevenStepStaticWizardFixture,
  buildStepIdentityFixtures,
  PORTAL_DOM_FIXTURE_MANIFEST,
} from "./portalScenarios";

afterEach(() => vi.useRealTimers());

describe("R0 synthetic DOM fixture integrity", () => {
  it("records that fixtures are synthetic and no live payer evidence is available", () => {
    expect(PORTAL_DOM_FIXTURE_MANIFEST.provenance).toBe("synthetic-local-builder");
    expect(PORTAL_DOM_FIXTURE_MANIFEST.liveEvidenceAvailable).toBe(false);
    expect(PORTAL_DOM_FIXTURE_MANIFEST.liveEvidenceUnavailableFor).toEqual([
      "Aetna",
      "BCBS",
      "Optum",
    ]);
    expect(PORTAL_DOM_FIXTURE_MANIFEST.productionFixEvidence).toBe(false);
  });

  it("builds seven same-URL wizard snapshots with unique active step identities", () => {
    const pages = buildSevenStepStaticWizardFixture();
    expect(pages).toHaveLength(7);
    expect(new Set(pages.map(({ url }) => url)).size).toBe(1);
    expect(new Set(pages.map(({ stepId }) => stepId)).size).toBe(7);

    for (const page of pages) {
      const dom = new JSDOM(page.html, { url: page.url });
      const document = dom.window.document;
      expect(page.url).toBe("https://portal.synthetic.invalid/enrollment");
      expect(document.querySelector("main[data-fixture='synthetic']")).not.toBeNull();
      expect(document.querySelector("h1")?.textContent).toBe(page.heading);
      expect(document.querySelectorAll("[data-current-step='true']")).toHaveLength(1);
      expect(document.querySelector("[data-current-step='true']")?.getAttribute("data-step-id"))
        .toBe(page.stepId);
      expect(document.querySelector("section[data-active-step='true']")?.getAttribute("data-step-id"))
        .toBe(page.stepId);
      dom.window.close();
    }
  });

  it("includes unknown, ambiguous, and repeated-heading identity shapes", () => {
    const { unknown, ambiguous, repeatedHeading } = buildStepIdentityFixtures();
    const unknownDom = new JSDOM(unknown.html, { url: unknown.url });
    const ambiguousDom = new JSDOM(ambiguous.html, { url: ambiguous.url });
    try {
      expect(unknownDom.window.document.querySelectorAll("[data-current-step='true']")).toHaveLength(0);
      expect(ambiguousDom.window.document.querySelectorAll("[data-current-step='true']")).toHaveLength(2);
      expect(ambiguousDom.window.document.querySelectorAll("h1")).toHaveLength(2);
      expect(repeatedHeading).toHaveLength(2);
      expect(repeatedHeading[0].heading).toBe(repeatedHeading[1].heading);
      expect(repeatedHeading[0].stepId).not.toBe(repeatedHeading[1].stepId);
      expect(repeatedHeading[0].url).toBe(repeatedHeading[1].url);
      for (const page of repeatedHeading) {
        const dom = new JSDOM(page.html, { url: page.url });
        expect(dom.window.document.querySelector("h1")?.textContent).toBe(page.heading);
        expect(dom.window.document.querySelector("[data-current-step='true']")?.getAttribute("data-step-id"))
          .toBe(page.stepId);
        dom.window.close();
      }
    } finally {
      unknownDom.window.close();
      ambiguousDom.window.close();
    }
  });

  it("keeps a conditional panel hidden until its scheduled reveal", () => {
    vi.useFakeTimers();
    const fixture = buildHiddenDelayedPanelFixture(40);
    try {
      const panel = fixture.dom.window.document.querySelector<HTMLElement>("#conditional-panel");
      expect(panel).not.toBeNull();
      expect(panel?.hidden).toBe(true);
      vi.advanceTimersByTime(39);
      expect(panel?.hidden).toBe(true);
      vi.advanceTimersByTime(1);
      expect(panel?.hidden).toBe(false);
      expect(panel?.style.display).toBe("block");
    } finally {
      fixture.dispose();
    }
  });

  it("places duplicate visible labels in distinct frame documents", () => {
    const fixture = buildDuplicateLabelFramesFixture();
    try {
      expect(fixture.host.window.document.querySelectorAll("iframe[data-fixture-frame]")).toHaveLength(2);
      expect(fixture.frames).toHaveLength(2);
      expect(new URL(fixture.frames[0].url).origin).not.toBe(new URL(fixture.frames[1].url).origin);
      for (const frame of fixture.frames) {
        expect(fixture.host.window.document.querySelector(`iframe[data-fixture-frame='${frame.name}']`))
          .not.toBeNull();
        expect(frame.dom.window.document.querySelector("label")?.textContent).toBe("State");
      }
      expect(fixture.frames[0].dom.window.document.querySelector("select")?.name).toBe("billingState");
      expect(fixture.frames[1].dom.window.document.querySelector("select")?.name).toBe("practiceState");
    } finally {
      fixture.dispose();
    }
  });

  it("simulates a date field reverting after the configured delay", () => {
    vi.useFakeTimers();
    const fixture = buildDateReversionFixture(50);
    try {
      const input = fixture.dom.window.document.querySelector<HTMLInputElement>("#effective-date");
      expect(input).not.toBeNull();
      if (!input) throw new Error("Date fixture input missing");
      input.value = fixture.attemptedValue;
      input.dispatchEvent(new fixture.dom.window.Event("input", { bubbles: true }));
      vi.advanceTimersByTime(fixture.delayMs - 1);
      expect(input.value).toBe(fixture.attemptedValue);
      vi.advanceTimersByTime(1);
      expect(input.value).toBe(fixture.revertedValue);
      expect(fixture.dom.window.document.querySelector("main")?.dataset.fixtureBehavior)
        .toBe("delayed-date-reversion");
    } finally {
      fixture.dispose();
    }
  });

  it("encodes illustrative identifier length and space constraints", () => {
    const fixture = buildIdentifierConstraintsFixture();
    try {
      const document = fixture.dom.window.document;
      const groupNpi = document.querySelector<HTMLInputElement>("#group-npi");
      const providerId = document.querySelector<HTMLInputElement>("#provider-id");
      expect(document.querySelector("main")?.dataset.constraints).toBe("illustrative-only");
      expect(groupNpi?.maxLength).toBe(12);
      expect(groupNpi?.pattern).toBe("[0-9]{3} [0-9]{3} [0-9]{4}");
      if (!groupNpi || !providerId) throw new Error("Identifier fixture inputs missing");
      groupNpi.value = "123 456 7890";
      providerId.value = "AB 12345 67890";
      expect(groupNpi.checkValidity()).toBe(true);
      expect(providerId.maxLength).toBe(24);
      expect(providerId.checkValidity()).toBe(true);
      providerId.value = "AB 123  ";
      expect(providerId.checkValidity()).toBe(false);
    } finally {
      fixture.dispose();
    }
  });
});
