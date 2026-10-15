import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { CaptureSession } from "../shared/capture";
import {
  CAPTURE_FILE_MAX_BYTES,
  captureImportConfirmation,
  captureImportSummaryText,
  parseCaptureFile,
} from "../shared/captureImport";

// Runs the unchanged main.ts import flow (`importCaptureFile`) against the real
// side-panel markup: what the trainer is asked, what goes to the worker, and
// what the panel shows after. The worker half is in the harness.
const source = readFileSync("src/sidepanel/main.ts", "utf8");
const tree = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
function code(names: string[]) {
  const selected = tree.statements.filter((node) =>
    ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""),
  ).map((node) => node.getText(tree)).join("\n");
  return ts.transpileModule(selected, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

const BLUEKC_TEXT = readFileSync("form-captures/bluekc-network-interest-form.capture.json", "utf8");
const TARGET = { portalKey: "bluekc-network-interest-form", mappingGeneration: 2, targetRevision: 7 };

function fileOf(text: string, size = text.length) {
  return { size, text: async () => text };
}

function buildScope(options: {
  captureSession?: CaptureSession | null;
  confirm?: boolean;
  response?: unknown;
}) {
  const doc = new JSDOM(readFileSync("sidepanel.html", "utf8")).window.document;
  const el = (id: string) => doc.getElementById(id) as HTMLElement & { disabled: boolean };
  const confirm = vi.fn(() => options.confirm ?? true);
  const sendToBackground = vi.fn(async (request: { fileText: string }) =>
    options.response ?? {
      ok: true,
      data: {
        session: { ...TARGET, templateStepId: null, startedAt: "x", rows: [] },
        summary: { fields: 89, pages: 22, suggested: 29, duplicates: 0, replaced: 0, importedFrom: null, request },
      },
    },
  );
  const renderCapture = vi.fn();
  const scope = createContext({
    document: doc,
    window: { confirm },
    captureImport: el("capture-import"),
    captureImportFile: el("capture-import-file"),
    capturePickStatus: el("capture-pick-status"),
    captureRestored: el("capture-restored"),
    captureSession: options.captureSession ?? null,
    captureAddedPage: true,
    batchSelection: new Set(["#old"]),
    editingSelector: "#old",
    selectorTestResult: null,
    rowDraft: null,
    loadGeneration: 1,
    isCurrent: () => true,
    currentTrainTargetRequest: () => TARGET,
    isCurrentTrainTargetRequest: () => true,
    captureSessionMatchesTrainTarget: (session: CaptureSession | null) =>
      session != null && session.portalKey === TARGET.portalKey,
    discardStaleTrainCaptureFromResponse: vi.fn(() => false),
    sendToBackground,
    renderCapture,
    parseCaptureFile,
    captureImportConfirmation,
    captureImportSummaryText,
    CAPTURE_FILE_MAX_BYTES,
  });
  runInContext(code(["setPickStatus", "importCaptureFile"]), scope);
  const run = async (file: ReturnType<typeof fileOf>) => {
    scope.__file = file;
    await runInContext("importCaptureFile(__file)", scope);
  };
  return { scope, el, confirm, sendToBackground, renderCapture, run };
}

const existingCapture: CaptureSession = {
  portalKey: TARGET.portalKey,
  mappingGeneration: TARGET.mappingGeneration,
  templateStepId: null,
  startedAt: "2026-10-01T00:00:00.000Z",
  rows: [{
    label: "NPI", selector: "#old", fieldType: "text", formSection: null, suggestedToken: null,
    evidence: null, chosenToken: null, sent: true,
  }],
};

describe("Train forms — Import file", () => {
  it("has an Import file control inside the capture card, taking .json files", () => {
    const doc = new JSDOM(readFileSync("sidepanel.html", "utf8")).window.document;
    const card = doc.getElementById("capture-section")!;
    expect(card.contains(doc.getElementById("capture-import"))).toBe(true);
    expect(doc.getElementById("capture-import")?.textContent?.trim()).toBe("Import file");
    expect(doc.getElementById("capture-import-file")?.getAttribute("accept")).toBe(".json,application/json");
  });

  it("imports a matching file into an empty capture without asking, and says what came in", async () => {
    const { scope, el, confirm, sendToBackground, renderCapture, run } = buildScope({});
    await run(fileOf(BLUEKC_TEXT));

    expect(confirm).not.toHaveBeenCalled();
    expect(sendToBackground).toHaveBeenCalledWith({
      type: "IMPORT_CAPTURE",
      ...TARGET,
      fileText: BLUEKC_TEXT,
      replaceExisting: false,
      acceptPortalKey: null,
    });
    expect(el("capture-restored").hidden).toBe(false);
    expect(el("capture-restored").textContent).toBe(
      "Imported 89 fields on 22 pages from the capture file. Claude suggested a token for 29; you decide each one in the web app. Nothing is sent until you choose Send for approval.",
    );
    expect(scope.captureSession).toMatchObject({ portalKey: TARGET.portalKey });
    // A fresh list: no stale selection or open editor from the old one.
    expect(scope.batchSelection.size).toBe(0);
    expect(scope.editingSelector).toBeNull();
    expect(scope.captureAddedPage).toBe(false);
    expect(el("capture-import").disabled).toBe(false);
    expect(el("capture-import").textContent).toBe("Import file");
    expect(renderCapture).toHaveBeenCalled();
  });

  it("asks once about a different key and a capture it replaces, and sends that answer", async () => {
    const renamed = BLUEKC_TEXT.replace(
      '"portalKey": "bluekc-network-interest-form"',
      '"portalKey": "bluekc-provisional"',
    );
    const { confirm, sendToBackground, run } = buildScope({ captureSession: existingCapture });
    await run(fileOf(renamed));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]).toEqual([
      'This file was captured as "bluekc-provisional", but the selected form is "bluekc-network-interest-form". Import it into the selected form?\n\nIt replaces the 1 field captured here. Fields already sent stay in the shared library.',
    ]);
    expect(sendToBackground).toHaveBeenCalledWith(expect.objectContaining({
      replaceExisting: true,
      acceptPortalKey: "bluekc-provisional",
    }));
  });

  it("does nothing when the trainer declines", async () => {
    const { scope, sendToBackground, run } = buildScope({ captureSession: existingCapture, confirm: false });
    await run(fileOf(BLUEKC_TEXT));
    expect(sendToBackground).not.toHaveBeenCalled();
    expect(scope.captureSession).toBe(existingCapture);
  });

  it("names a wrong or oversized file in the card and sends nothing", async () => {
    const { el, sendToBackground, run } = buildScope({});
    await run(fileOf('{"rows": []}'));
    expect(el("capture-pick-status").hidden).toBe(false);
    expect(el("capture-pick-status").textContent).toMatch(/isn't a form capture/);
    expect(el("capture-pick-status").classList.contains("capture-editor-warn")).toBe(true);

    await run(fileOf(BLUEKC_TEXT, CAPTURE_FILE_MAX_BYTES + 1));
    expect(el("capture-pick-status").textContent).toBe("That file is too large to be a form capture.");
    expect(sendToBackground).not.toHaveBeenCalled();
  });

  it("shows the worker's refusal and keeps the capture it had", async () => {
    const { scope, el, run } = buildScope({
      captureSession: null,
      response: { ok: false, error: "The selected form configuration is no longer available." },
    });
    await run(fileOf(BLUEKC_TEXT));
    expect(el("capture-pick-status").textContent).toBe("The selected form configuration is no longer available.");
    expect(scope.captureSession).toBeNull();
    expect(el("capture-import").disabled).toBe(false);
  });
});
