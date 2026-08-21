// BITE-TRAIN-01 — the row editor's draft survives a re-render.
import { describe, expect, it } from "vitest";
import { draftEdit, draftForRow, draftTestReport, type CaptureRowDraft } from "./captureDraft";
import type { CaptureRow } from "./capture";

function row(over: Partial<CaptureRow> = {}): CaptureRow {
  return {
    label: "NPI",
    selector: "#npi",
    fieldType: "text",
    formSection: null,
    suggestedToken: null,
    evidence: null,
    chosenToken: null,
    sent: false,
    ...over,
  };
}

describe("draftForRow", () => {
  it("seeds from the stored row when nothing is in hand", () => {
    const draft = draftForRow(row({ displayLabel: "Provider NPI" }), null);
    expect(draft).toEqual({
      rowSelector: "#npi",
      displayLabel: "Provider NPI",
      fieldType: "text",
      selectorText: "#npi",
    });
  });

  it("keeps the typed values across a re-render of the same row", () => {
    const typed: CaptureRowDraft = {
      rowSelector: "#npi",
      displayLabel: "Individual NPI",
      fieldType: "select",
      selectorText: "input[name='npi']",
    };
    expect(draftForRow(row(), typed)).toBe(typed);
  });

  it("does not carry one row's draft into another row's editor", () => {
    const typed: CaptureRowDraft = {
      rowSelector: "#npi",
      displayLabel: "Individual NPI",
      fieldType: "text",
      selectorText: "input[name='npi']",
    };
    const other = draftForRow(row({ selector: "#tin", label: "TIN" }), typed);
    expect(other.rowSelector).toBe("#tin");
    expect(other.selectorText).toBe("#tin");
    expect(other.displayLabel).toBe("");
  });
});

describe("draftEdit", () => {
  it("saves what was typed", () => {
    const stored = row();
    const draft = draftForRow(stored, null);
    draft.displayLabel = "Individual NPI";
    draft.selectorText = "  input[name='npi']  ";
    draft.fieldType = "select";
    expect(draftEdit(stored, draft)).toEqual({
      displayLabel: "Individual NPI",
      fieldType: "select",
      newSelector: "input[name='npi']",
    });
  });

  it("omits the type and the selector when neither changed", () => {
    const stored = row({ displayLabel: "NPI" });
    const draft = draftForRow(stored, null);
    draft.displayLabel = "Individual NPI";
    expect(draftEdit(stored, draft)).toEqual({ displayLabel: "Individual NPI" });
  });

  it("never proposes an empty selector", () => {
    const stored = row();
    const draft = draftForRow(stored, null);
    draft.selectorText = "   ";
    expect(draftEdit(stored, draft)).toEqual({ displayLabel: "" });
  });
});

describe("draftTestReport", () => {
  const stored = row();
  const report = (matches: number) => ({
    valid: true,
    matches,
    fillable: matches,
    radioGroup: false,
  });

  it("shows 0, 1 and N against the selector that was tested", () => {
    const draft = draftForRow(stored, null);
    draft.selectorText = "input[name='npi']";
    for (const matches of [0, 1, 3]) {
      expect(
        draftTestReport(draft, { selector: "input[name='npi']", ...report(matches) }),
      ).toEqual(report(matches));
    }
  });

  it("carries the whole shape, not just the count — a wrapper and a field both match once", () => {
    const draft = draftForRow(stored, null);
    draft.selectorText = "#wrapper";
    expect(
      draftTestReport(draft, {
        selector: "#wrapper",
        valid: true,
        matches: 1,
        fillable: 0,
        radioGroup: false,
      }),
    ).toEqual({ valid: true, matches: 1, fillable: 0, radioGroup: false });
  });

  it("ignores whitespace the trainer typed around the selector", () => {
    const draft = draftForRow(stored, null);
    draft.selectorText = "  #npi  ";
    expect(draftTestReport(draft, { selector: "#npi", ...report(1) })).toEqual(report(1));
  });

  it("withholds a verdict once the trainer keeps typing", () => {
    const draft = draftForRow(stored, null);
    draft.selectorText = "input[name='npi2']";
    expect(draftTestReport(draft, { selector: "input[name='npi']", ...report(1) })).toBeNull();
    expect(draftTestReport(draft, null)).toBeNull();
  });
});
