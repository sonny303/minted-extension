import { describe, expect, it } from "vitest";
import {
  NO_MATCHES,
  selectorVerdict,
  type SelectorMatchReport,
} from "./selectorMatch";

const report = (
  over: Partial<SelectorMatchReport> = {},
): SelectorMatchReport => ({
  ...NO_MATCHES,
  ...over,
});

describe("selectorVerdict", () => {
  it("tells a typo from a field that is genuinely gone", () => {
    const typo = selectorVerdict(report({ valid: false }), "text");
    const gone = selectorVerdict(report({ matches: 0 }), "text");
    expect(typo.ok).toBe(false);
    expect(gone.ok).toBe(false);
    // The FIX differs, so the words must: one is "check the syntax", the other
    // "re-capture or add it by hand". Reporting a typo as 0 sent the trainer to
    // the wrong one.
    expect(typo.text).toMatch(/valid CSS/i);
    expect(typo.text).not.toMatch(/re-capture/i);
    expect(gone.text).toMatch(/re-capture/i);
  });

  it("refuses to bless a wrapper that matches once but cannot be typed into", () => {
    // Measured against the real engine: `#npi-field` on the div around an input
    // matches exactly one element and the fill skips it as "field not found".
    const verdict = selectorVerdict(
      report({ matches: 1, fillable: 0 }),
      "text",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.text).toMatch(/nothing that can be typed into/i);
  });

  it("reads a radio group as health, not ambiguity", () => {
    // The scanner's own selector for an id-less radio group is
    // `input[type="radio"][name="x"]`, which matches every option. Calling that
    // ambiguous is a false alarm on the exact defect this trainer was built for.
    const verdict = selectorVerdict(
      report({ matches: 3, fillable: 3, radioGroup: true }),
      "radio",
    );
    expect(verdict.ok).toBe(true);
    expect(verdict.text).toMatch(/3 options of one radio group/i);
  });

  it("names the mis-typed row when a radio group sits under a non-radio type", () => {
    const verdict = selectorVerdict(
      report({ matches: 3, fillable: 3, radioGroup: true }),
      "text",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.text).toMatch(/control type/i);
  });

  it("still passes a single field and still warns on real ambiguity", () => {
    expect(
      selectorVerdict(report({ matches: 1, fillable: 1 }), "text").ok,
    ).toBe(true);
    const ambiguous = selectorVerdict(
      report({ matches: 4, fillable: 4 }),
      "text",
    );
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.text).toMatch(/ambiguous/i);
  });

  it("counts the fillable matches, not the decorative ones, when it warns", () => {
    // A selector hitting 2 inputs inside 2 wrappers is 2-way ambiguous, not 4.
    expect(
      selectorVerdict(report({ matches: 4, fillable: 2 }), "text").text,
    ).toMatch(/Matches 2 fields/);
  });
});
