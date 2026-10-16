// The fill result's "fields need you" list and the muted "left blank on
// purpose" line, driven from main.ts's own functions (same technique as
// mockDryRunDetail.test.ts): a reviewed leave_blank map is never a needs-you
// row, never a gap, and is still shown as a count.
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { FillSummary, ReportedField } from "../shared/fill";
import { leftBlankLine } from "../shared/leaveBlank";

const source = readFileSync("src/sidepanel/main.ts", "utf8");
const tree = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);

/** Top-level functions and consts from main.ts, by name, as plain ES2022. */
function code(names: string[]) {
  const selected = tree.statements
    .filter((node) =>
      (ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? "")) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && names.includes(d.name.text))),
    )
    .map((node) => node.getText(tree))
    .join("\n");
  return ts.transpileModule(selected, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

function summary(over: Partial<FillSummary>): FillSummary {
  return {
    filled: 2,
    filledLabels: ["First Name", "Last Name"],
    skipped: [],
    manual: [],
    eventRecorded: true,
    eventError: null,
    fillSessionId: "3f2a9c1e-0000-4000-8000-000000000000",
    ...over,
  };
}

const leftBlank: ReportedField[] = [
  { label: "Middle Name", reason: "intentionally left blank", kind: "leave_blank", mapId: "m-mid" },
  { label: "Suffix", reason: "intentionally left blank", kind: "leave_blank", mapId: "m-suf" },
  { label: "Fax", reason: "intentionally left blank", kind: "leave_blank", mapId: "m-fax" },
];

describe("fill result and leave_blank maps", () => {
  it("needsYou never lists a leave_blank field, even one misfiled under manual", () => {
    const context = createContext({});
    runInContext(code(["NEED_REASONS", "needsYou"]), context);
    (context as Record<string, unknown>).summary = summary({
      manual: [
        { label: "DEA", reason: "no value in Minted Panel", kind: "no_value", mapId: "m-dea" },
        // Defensive: a leave_blank row is never put in manual, but if an
        // older report carried one there it still must not become a task.
        { label: "Middle Name", reason: "intentionally left blank", kind: "leave_blank", mapId: "m-mid" },
      ],
      leftBlank,
    });
    const needs = runInContext("needsYou(summary)", context) as ReportedField[];
    expect(needs.map((f) => f.label)).toEqual(["DEA"]);
  });

  it("renders the left-blank bucket in admin details apart from the gap buckets", () => {
    const dom = new JSDOM(`
      <div id="fill-attempted" hidden></div>
      <div id="fill-not-checked" hidden></div>
      <div id="fill-skipped" hidden></div>
      <div id="fill-left-blank-box" hidden></div>
    `);
    const doc = dom.window.document;
    const fillAttemptedBox = doc.getElementById("fill-attempted")!;
    const fillNotCheckedBox = doc.getElementById("fill-not-checked")!;
    const fillSkippedBox = doc.getElementById("fill-skipped")!;
    const fillLeftBlankBox = doc.getElementById("fill-left-blank-box")!;
    const context = createContext({
      document: doc,
      fillAttemptedBox,
      fillNotCheckedBox,
      fillSkippedBox,
      fillLeftBlankBox,
      gapActionLink: () => null,
    });
    runInContext(code(["fieldList", "bucketDetails"]), context);
    (context as Record<string, unknown>).summary = summary({ leftBlank });
    runInContext(`
      fieldList(fillSkippedBox, "Not filled on this page:", summary.skipped, { portalKey: null, providerId: null });
      fieldList(fillAttemptedBox, "Form-wide planning items (page not checked):", summary.manual, { portalKey: null, providerId: null });
      fieldList(fillLeftBlankBox, "Left blank on purpose:", summary.leftBlank ?? []);
    `, context);

    expect(fillSkippedBox.hidden).toBe(true);
    expect(fillAttemptedBox.hidden).toBe(true);
    expect(fillLeftBlankBox.hidden).toBe(false);
    expect(fillLeftBlankBox.querySelectorAll("li")).toHaveLength(3);
    expect(fillLeftBlankBox.textContent).toContain("Middle Name - intentionally left blank");
  });

  it("writes the muted count line the way the panel does, and nothing when there are none", () => {
    expect(leftBlankLine(leftBlank)).toBe("3 left blank on purpose");
    expect(leftBlankLine([leftBlank[0]!])).toBe("1 left blank on purpose");
    expect(leftBlankLine(undefined)).toBeNull();
    expect(leftBlankLine([])).toBeNull();
    // What renderFillSummary puts in #fill-left-blank (a restored report
    // from before the decision existed carries no list and shows nothing).
    const line = summary({ leftBlank }).leftBlank;
    expect(`${leftBlankLine(line)}.`).toBe("3 left blank on purpose.");
    expect(leftBlankLine(summary({}).leftBlank)).toBeNull();
  });
});
