import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { MockDryRunSummary } from "../shared/fill";

const source = readFileSync("src/sidepanel/main.ts", "utf8");
const tree = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);

function code(names: string[]) {
  const selected = tree.statements
    .filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""))
    .map((node) => node.getText(tree))
    .join("\n");
  return ts.transpileModule(selected, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

describe("renderMockDryRunDetail diagnostic visibility", () => {
  it("renders skipped fields from notChecked with per-field reasons including page_unknown and context_changed", () => {
    const dom = new JSDOM(`
      <div id="mock-dry-run-skipped" hidden></div>
      <div id="mock-dry-run-gaps" hidden></div>
    `);
    const doc = dom.window.document;
    const mockDryRunSkipped = doc.getElementById("mock-dry-run-skipped")!;
    const mockDryRunGaps = doc.getElementById("mock-dry-run-gaps")!;

    const transpiled = code(["renderMockDryRunDetail", "fieldList", "bucketDetails"]);
    const context = createContext({
      document: doc,
      mockDryRunSkipped,
      mockDryRunGaps,
    });
    runInContext(transpiled, context);

    const summary: MockDryRunSummary = {
      pass: false,
      filled: 1,
      skipped: [
        { label: "Tax ID", reason: "field not found on this page", kind: "skipped", mapId: "m-tin" },
      ],
      notChecked: [
        {
          label: "Degree",
          reason: "form changed during fill; review this field on the portal",
          kind: "unverified",
          mapId: "m-deg",
        },
        {
          label: "License Number",
          reason: "current wizard page could not be confirmed",
          kind: "page_unknown",
          mapId: "m-lic",
        },
        {
          label: "Facility Name",
          reason: "a form frame could not be checked",
          kind: "unverified",
          mapId: "m-frame",
        },
      ],
      gaps: [
        { label: "Specialty", reason: "mapping needs review", kind: "no_mapping", mapId: "m-spec" },
      ],
      fieldOutcomes: [
        {
          mapId: "m-deg",
          targetKey: "t1",
          frameKey: "f1",
          stepKey: null,
          attempted: false,
          outcome: "unverified",
          reasonCode: "context_changed",
        },
        {
          mapId: "m-lic",
          targetKey: "t2",
          frameKey: null,
          stepKey: null,
          attempted: false,
          outcome: "page_unknown",
          reasonCode: "page_unknown",
        },
        {
          mapId: "m-frame",
          targetKey: "t3",
          frameKey: null,
          stepKey: null,
          attempted: false,
          outcome: "unverified",
          reasonCode: "frame_inaccessible",
        },
      ],
      fillSessionId: "session-1",
      mockProfileVersion: 1,
      fieldsAttempted: 1,
      fieldsVerified: 1,
      attemptedLabels: ["First Name"],
      logError: null,
    };
    (context as Record<string, unknown>).summary = summary;
    runInContext("renderMockDryRunDetail(summary)", context);

    expect(mockDryRunSkipped.hidden).toBe(false);
    const skippedText = mockDryRunSkipped.textContent ?? "";

    // Regular skipped field
    expect(skippedText).toContain("Tax ID");

    // notChecked fields rendered with visible per-field diagnostics
    expect(skippedText).toContain("Degree");
    expect(skippedText).toContain("context_changed");

    expect(skippedText).toContain("License Number");
    expect(skippedText).toContain("page_unknown");

    expect(skippedText).toContain("Facility Name");
    expect(skippedText).toContain("a form frame could not be checked");

    // Mapping gaps rendered in gaps container
    expect(mockDryRunGaps.hidden).toBe(false);
    expect(mockDryRunGaps.textContent).toContain("Specialty");
  });
});
