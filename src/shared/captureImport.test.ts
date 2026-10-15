import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { captureCounts, parseCaptureSession, type CaptureSession } from "./capture";
import {
  CAPTURE_FILE_FORMAT,
  CAPTURE_FILE_MAX_BYTES,
  captureImportConfirmation,
  captureImportSummaryText,
  isOptionListCapRefusal,
  optionListHeldReason,
  parseCaptureFile,
  planCaptureImport,
  type CaptureFile,
} from "./captureImport";

const BLUEKC_TEXT = readFileSync(
  new URL("../../form-captures/bluekc-network-interest-form.capture.json", import.meta.url),
  "utf8",
);
const BLUEKC_RAW = JSON.parse(BLUEKC_TEXT) as {
  portalKey: string;
  rows: Array<{ selector: string; pageStep: string; sortOrder: number; suggestedToken: string | null }>;
};

function fileText(rows: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: CAPTURE_FILE_FORMAT,
    portalKey: "acme-enroll",
    templateStepId: null,
    startedAt: "2026-10-14T00:00:00.000Z",
    rows,
    ...extra,
  });
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: "NPI",
    selector: "#npi",
    fieldType: "text",
    formSection: null,
    pageStep: "Page 1",
    sortOrder: 0,
    origin: "auto_detected",
    displayLabel: null,
    suggestedToken: "provider.npi",
    evidence: "Claude: label 'NPI' → provider.npi.",
    decision: "token",
    confidence: "high",
    chosenToken: null,
    sent: false,
    ...overrides,
  };
}

function parsedFile(text: string): CaptureFile {
  const parsed = parseCaptureFile(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.file;
}

const TARGET = { portalKey: "acme-enroll", mappingGeneration: 3 };

describe("parseCaptureFile — the BlueKC capture", () => {
  const file = parsedFile(BLUEKC_TEXT);

  it("reads every row, under the file's own key", () => {
    expect(file.portalKey).toBe("bluekc-network-interest-form");
    expect(file.rows).toHaveLength(BLUEKC_RAW.rows.length);
    expect(file.duplicates).toBe(0);
  });

  it("keeps each row's page and position exactly as the walk recorded them", () => {
    expect(file.rows.map((r) => [r.selector, r.pageStep, r.sortOrder])).toEqual(
      BLUEKC_RAW.rows.map((r) => [r.selector, r.pageStep, r.sortOrder]),
    );
  });

  it("keeps Claude's suggestions to read and leaves every decision open", () => {
    expect(file.rows.filter((r) => r.suggestedToken != null)).toHaveLength(
      BLUEKC_RAW.rows.filter((r) => r.suggestedToken != null).length,
    );
    for (const r of file.rows) {
      expect(r.chosenToken).toBeNull();
      expect(r.sent).toBe(false);
      expect(r.heldReason).toBeNull();
    }
  });

  it("carries the long option lists whole (the send decides, not the import)", () => {
    expect(Math.max(...file.rows.map((r) => r.options?.length ?? 0))).toBe(146);
  });

  it("carries no key outside the capture row contract", () => {
    const allowed = new Set([
      "label", "selector", "fieldType", "formSection", "suggestedToken", "evidence",
      "chosenToken", "sent", "heldReason", "pageStep", "sortOrder", "options", "origin",
      "displayLabel", "typeOverridden", "selectorOverridden",
    ]);
    for (const r of file.rows) {
      for (const key of Object.keys(r)) expect(allowed, key).toContain(key);
    }
    expect(JSON.stringify(file.rows)).not.toMatch(/suggestedValue|"decision"|"confidence"|revealedBy/);
  });
});

describe("parseCaptureFile — refusals", () => {
  it("names a file that is not JSON", () => {
    expect(parseCaptureFile("{nope")).toEqual({ ok: false, reason: expect.stringMatching(/isn't valid JSON/) });
  });

  it("refuses JSON that is not a v1 capture", () => {
    expect(parseCaptureFile("[]")).toMatchObject({ ok: false });
    expect(parseCaptureFile(JSON.stringify({ portalKey: "x", rows: [row()] }))).toEqual({
      ok: false,
      reason: expect.stringContaining(CAPTURE_FILE_FORMAT),
    });
    expect(parseCaptureFile(fileText([row()], { format: "minted.form-capture/v9" }))).toMatchObject({ ok: false });
  });

  it("refuses a damaged file rather than importing part of it", () => {
    expect(parseCaptureFile(fileText([row(), { label: "No selector" }]))).toEqual({
      ok: false,
      reason: expect.stringMatching(/damaged/),
    });
    expect(parseCaptureFile(fileText([row()], { portalKey: "" }))).toMatchObject({ ok: false });
  });

  it("refuses a file too large to be a capture before parsing it", () => {
    expect(parseCaptureFile(" ".repeat(CAPTURE_FILE_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: "That file is too large to be a form capture.",
    });
  });

  it("refuses an empty file and a blank selector", () => {
    expect(parseCaptureFile(fileText([]))).toEqual({ ok: false, reason: expect.stringMatching(/no fields/) });
    expect(parseCaptureFile(fileText([row({ selector: "  " })]))).toEqual({
      ok: false,
      reason: expect.stringMatching(/no selector/),
    });
  });

  it("refuses a control type the fill cannot apply, naming the field", () => {
    expect(parseCaptureFile(fileText([row({ fieldType: "signature", displayLabel: "Signature pad" })]))).toEqual({
      ok: false,
      reason: expect.stringMatching(/"Signature pad".*signature/),
    });
  });
});

describe("parseCaptureFile — normalizing", () => {
  it("never imports a decision or a sent flag, whatever the file claims", () => {
    const file = parsedFile(fileText([row({ chosenToken: "provider.npi", sent: true, heldReason: "x" })]));
    expect(file.rows[0]).toMatchObject({ chosenToken: null, sent: false, heldReason: null });
  });

  it("keeps the first row on a repeated selector and counts the rest", () => {
    const file = parsedFile(
      fileText([
        row({ label: "NPI" }),
        row({ label: "NPI again", pageStep: "Page 2" }),
        row({ label: "TIN", selector: " #tin " }),
      ]),
    );
    expect(file.rows.map((r) => [r.label, r.selector])).toEqual([
      ["NPI", "#npi"],
      ["TIN", "#tin"],
    ]);
    expect(file.duplicates).toBe(1);
  });

  it("groups pages in walk order and orders each page by position", () => {
    const file = parsedFile(
      fileText([
        row({ selector: "#b", pageStep: "Page 2", sortOrder: 1 }),
        row({ selector: "#a", pageStep: "Page 1", sortOrder: 2 }),
        row({ selector: "#c", pageStep: "Page 2", sortOrder: 0 }),
        row({ selector: "#d", pageStep: "Page 1", sortOrder: null }),
        row({ selector: "#e", pageStep: "Page 1", sortOrder: 0 }),
      ]),
    );
    expect(file.rows.map((r) => r.selector)).toEqual(["#c", "#b", "#e", "#a", "#d"]);
  });
});

describe("planCaptureImport", () => {
  const file = parsedFile(fileText([row(), row({ selector: "#tin", pageStep: "Page 2", suggestedToken: null })]));
  const existing: CaptureSession = {
    portalKey: TARGET.portalKey,
    mappingGeneration: TARGET.mappingGeneration,
    templateStepId: null,
    startedAt: "2026-10-01T00:00:00.000Z",
    rows: [{ ...file.rows[0]!, sent: true }],
  };

  it("builds the selected form's session at its current generation", () => {
    const plan = planCaptureImport({ file, target: TARGET, existing: null, replaceExisting: false, acceptPortalKey: null });
    expect(plan).toMatchObject({
      ok: true,
      session: { portalKey: "acme-enroll", mappingGeneration: 3, rows: file.rows },
      summary: { fields: 2, pages: 2, suggested: 1, duplicates: 0, replaced: 0, importedFrom: null },
    });
  });

  it("matches keys the way the panel normalizes them (trim + lowercase)", () => {
    const plan = planCaptureImport({
      file,
      target: { ...TARGET, portalKey: "ACME-Enroll" },
      existing: null,
      replaceExisting: false,
      acceptPortalKey: null,
    });
    expect(plan).toMatchObject({ ok: true, session: { portalKey: "ACME-Enroll" } });
  });

  it("refuses a file captured under another key until the trainer accepts it", () => {
    const target = { portalKey: "acme_network_form", mappingGeneration: 1 };
    expect(planCaptureImport({ file, target, existing: null, replaceExisting: false, acceptPortalKey: null })).toEqual({
      ok: false,
      reason: expect.stringMatching(/captured for "acme-enroll", not the selected form "acme_network_form"/),
    });
    expect(
      planCaptureImport({ file, target, existing: null, replaceExisting: false, acceptPortalKey: "some-other-key" }),
    ).toMatchObject({ ok: false });
    expect(
      planCaptureImport({ file, target, existing: null, replaceExisting: false, acceptPortalKey: "acme-enroll" }),
    ).toMatchObject({
      ok: true,
      session: { portalKey: "acme_network_form" },
      summary: { importedFrom: "acme-enroll" },
    });
  });

  it("refuses to replace a capture until the trainer confirms", () => {
    expect(planCaptureImport({ file, target: TARGET, existing, replaceExisting: false, acceptPortalKey: null })).toEqual({
      ok: false,
      reason: expect.stringMatching(/already has a capture/),
    });
    const plan = planCaptureImport({ file, target: TARGET, existing, replaceExisting: true, acceptPortalKey: null });
    expect(plan).toMatchObject({ ok: true, summary: { replaced: 1 } });
    // The replaced row's sent flag does not survive: a re-send is idempotent.
    expect(plan.ok && plan.session.rows.every((r) => !r.sent)).toBe(true);
  });

  it("asks exactly what the plan would refuse without", () => {
    expect(captureImportConfirmation(file, TARGET, null)).toBeNull();
    expect(captureImportConfirmation(file, TARGET, { ...existing, rows: [] })).toBeNull();
    expect(captureImportConfirmation(file, TARGET, existing)).toBe(
      "It replaces the 1 field captured here. Fields already sent stay in the shared library.",
    );
    const both = captureImportConfirmation(file, { portalKey: "acme_form", mappingGeneration: 1 }, existing);
    expect(both).toMatch(/^This file was captured as "acme-enroll", but the selected form is "acme_form"/);
    expect(both).toMatch(/replaces the 1 field/);
  });

  it("summarizes what came in and that nothing was sent", () => {
    expect(
      captureImportSummaryText({ fields: 89, pages: 22, suggested: 29, duplicates: 0, replaced: 0, importedFrom: null }),
    ).toBe(
      "Imported 89 fields on 22 pages from the capture file. Claude suggested a token for 29; you decide each one in the web app. Nothing is sent until you choose Send for approval.",
    );
    expect(
      captureImportSummaryText({ fields: 1, pages: 1, suggested: 0, duplicates: 2, replaced: 0, importedFrom: null }),
    ).toBe(
      "Imported 1 field on 1 page from the capture file. 2 repeated selectors were skipped. Nothing is sent until you choose Send for approval.",
    );
  });
});

describe("option lists over the panel's cap", () => {
  it("recognizes only the panel's control_options refusal", () => {
    expect(isOptionListCapRefusal(422, "control_options cannot exceed 50 entries")).toBe(true);
    expect(isOptionListCapRefusal(422, "selector is required")).toBe(false);
    expect(isOptionListCapRefusal(409, "control_options cannot exceed 50 entries")).toBe(false);
  });

  it("says the cap, the count, and what to do", () => {
    expect(optionListHeldReason(146, "control_options cannot exceed 50 entries")).toBe(
      "Not sent: Minted Panel accepts up to 50 options per field and this one has 146. Send again once the panel takes longer lists.",
    );
  });

  it("survives a worker restart and counts as held only while unsent", () => {
    const restored = parseCaptureSession({
      portalKey: "acme-enroll",
      rows: [
        { label: "Specialty", selector: "#spec", sent: false, heldReason: "Not sent: too long" },
        { label: "NPI", selector: "#npi", sent: true, heldReason: null },
      ],
    });
    expect(restored?.rows[0]?.heldReason).toBe("Not sent: too long");
    expect(captureCounts(restored)).toMatchObject({ sent: 1, held: 1 });
  });
});
