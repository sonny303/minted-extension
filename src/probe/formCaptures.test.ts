// Contract for Claude-written capture files (form-captures/*.capture.json,
// payer-form-capture skill). They are reviewed by humans and loaded as an
// extension CaptureSession, so they must: round-trip through
// parseCaptureSession without losing a row, suggest only catalog tokens,
// leave every decision to a human, and carry no form values.
//
// Pages also carry what a FUTURE automated walk would need — fingerprint,
// labeled navigation, the advance control, its gates, the routes out — and a
// readiness flag this test RECOMPUTES, so it can never be declared optimistically.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCaptureSession } from "../shared/capture";

const CAPTURE_DIR = new URL("../../form-captures/", import.meta.url);
const CATALOG = readFileSync(
  new URL("../../.claude/skills/payer-form-capture/token-catalog.md", import.meta.url),
  "utf8",
);

/** Every backticked `family.field` in the catalog. */
const CATALOG_TOKENS = new Set(
  [...CATALOG.matchAll(/`([a-zA-Z]+\.[a-zA-Z0-9]+)`/g)].map((m) => m[1]),
);

const DECISIONS = new Set(["token", "fixed", "human", "undecided"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);
const ACTION_KINDS = new Set(["advance", "back", "submit", "save", "dismiss", "other"]);
const CHOICE_TYPES = new Set(["radio", "select", "checkbox"]);
const ROW_KEYS = new Set([
  "label", "selector", "fieldType", "formSection", "options", "pageStep",
  "sortOrder", "required", "origin", "displayLabel", "suggestedToken",
  "evidence", "decision", "confidence", "suggestedValue", "revealedBy",
  "chosenToken", "sent",
]);

interface Row {
  label: string;
  selector: string;
  fieldType: string;
  pageStep: string;
  options?: { value: string; label: string }[];
  decision: string;
  confidence: string;
  suggestedToken: string | null;
  suggestedValue?: string;
  [key: string]: unknown;
}

/** A refused Next's requirement. `uncapturable` = required answer with no
 * capturable control (canvas signature pad): only a person clears it. */
interface Gate {
  selector: string | null;
  question: string | null;
  kind: "answer" | "nonEmpty" | "uncapturable";
  message: string;
}
/** One answer condition on a route: the choice picked (`option`), or any
 * choice except one (`notOption`) when the walk only knows which path it was. */
type Branch = { selector: string; option: string } | { selector: string; notOption: string };
/** Where Next goes from this page under these answers. A page whose answers
 * change what follows (BlueKC Page 16) carries one route per path walked;
 * re-walking with a changed answer ADDS a route, never overwrites one. */
interface Route { branch: Branch[]; leadsTo: string | null; condition?: string }
interface Page {
  pageStep: string;
  fingerprint: { keys: string[]; hash: string };
  navigation: { kind: string; caption: string; selector: string }[];
  advance: { selector: string; requires: Gate[]; routes: Route[] } | null;
  /** A popup seen on the way through. `proceedSelector` is set when the popup
   * itself offers the way on (Qualtrics "Continue Without Answering"). */
  interstitials: { text: string; dismissSelector: string; proceedSelector?: string }[];
  /** Questions with no capturable control: signature pads, file uploads whose
   * input only exists after a click. Data for later, never rows. */
  uncapturedQuestions: { question: string; kind: string; required: boolean; text: string }[];
  readyOnceApproved: boolean;
  automationBlockers: string[];
}

/** Would a runner be able to take this page alone, once every suggestion on
 * it is approved exactly as suggested? The human still submits: a page whose
 * only way on is a submit is never ready. */
export function pageBlockers(page: Page, rows: Row[]): string[] {
  const blockers: string[] = [];
  if (!page.advance) blockers.push("no recorded advance");
  for (const row of rows) {
    if (row.decision !== "token" && row.decision !== "fixed") blockers.push(`${row.label}: ${row.decision}`);
    else if (row.confidence !== "high") blockers.push(`${row.label}: ${row.confidence} confidence`);
  }
  // A soft-required popup is the payer asking for an answer the runner would
  // have to skip (BlueKC's roster upload) — not something to do unattended.
  for (const stop of page.interstitials) {
    if (stop.proceedSelector) blockers.push(`soft-required prompt: ${stop.text.slice(0, 60)}`);
  }
  for (const gate of page.advance?.requires ?? []) {
    if (gate.kind === "uncapturable") blockers.push(`gate a person must clear: ${gate.question}`);
    else if (!rows.some((r) => r.selector === gate.selector)) blockers.push(`gate on uncaptured field ${gate.selector}`);
  }
  return blockers;
}

const files = readdirSync(CAPTURE_DIR).filter((f) => f.endsWith(".capture.json"));

describe("token catalog snapshot", () => {
  it("parses into a non-trivial set of bare family.field keys", () => {
    expect(CATALOG_TOKENS.size).toBeGreaterThan(100);
    expect(CATALOG_TOKENS.has("provider.npi")).toBe(true);
    expect(CATALOG_TOKENS.has("group.tin")).toBe(true);
  });
});

describe.each(files)("%s", (file) => {
  const raw = JSON.parse(readFileSync(new URL(file, CAPTURE_DIR), "utf8"));
  const rows: Row[] = raw.rows;
  const pages: Page[] = raw.pages;
  const rowsOn = (page: Page) => rows.filter((r) => r.pageStep === page.pageStep);

  it("is a v1 capture whose name matches its portal key", () => {
    expect(raw.format).toBe("minted.form-capture/v1");
    expect(file).toBe(`${raw.portalKey}.capture.json`);
    expect(raw.formUrl).not.toContain("?");
    expect(raw.capturedWith.probeVersion).toBeGreaterThanOrEqual(2);
  });

  it("round-trips through parseCaptureSession without dropping a row", () => {
    const session = parseCaptureSession(raw);
    expect(session).not.toBeNull();
    expect(session!.rows).toHaveLength(rows.length);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("keys every row by a unique selector within a known page", () => {
    const keys = rows.map((r) => `${r.pageStep}\u0000${r.selector}`);
    expect(new Set(keys).size).toBe(keys.length);
    const steps = new Set(pages.map((p) => p.pageStep));
    for (const row of rows) expect(steps, row.label).toContain(row.pageStep);
  });

  it("suggests only web-fillable catalog tokens, with evidence", () => {
    for (const row of rows) {
      if (row.suggestedToken == null) continue;
      expect(CATALOG_TOKENS, row.label).toContain(row.suggestedToken);
      expect(String(row.evidence)).toMatch(/^Claude: /);
    }
  });

  it("leaves every decision to a human", () => {
    for (const row of rows) {
      expect(row.chosenToken).toBeNull();
      expect(row.sent).toBe(false);
      expect(DECISIONS).toContain(row.decision);
      expect(CONFIDENCE).toContain(row.confidence);
      if (row.decision === "token") expect(row.suggestedToken).toBeTruthy();
      if (row.decision === "fixed") {
        expect(row.suggestedValue, row.label).toBeTruthy();
        if (row.fieldType === "checkbox") {
          // applyCheckbox (fillEngine) checks only on a truthy word; the box's
          // own value attr ("Selected" on Qualtrics) would UNcheck it.
          expect(row.suggestedValue, row.label).toMatch(/^(Yes|No)$/);
        } else if (CHOICE_TYPES.has(row.fieldType)) {
          expect(row.options?.map((o) => o.value), row.label).toContain(row.suggestedValue);
        }
      } else {
        expect(row.suggestedValue, row.label).toBeUndefined();
      }
    }
  });

  it("carries shape only — no value-bearing keys", () => {
    for (const row of rows) {
      for (const key of Object.keys(row)) expect(ROW_KEYS, key).toContain(key);
    }
  });

  it("identifies every page by a distinct fingerprint", () => {
    const steps = pages.map((p) => p.pageStep);
    expect(new Set(steps).size).toBe(steps.length);
    const hashes = pages.map((p) => p.fingerprint.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("labels navigation and only ever advances through an advance control", () => {
    const hashes = new Set(pages.map((p) => p.fingerprint.hash));
    for (const page of pages) {
      // A page whose copy says its Next submits has no advance: the human submits.
      if ((page as Page & { submitWarning?: boolean }).submitWarning) {
        expect(page.advance, page.pageStep).toBeNull();
        expect(page.navigation.some((a) => a.kind === "advance"), page.pageStep).toBe(false);
      }
      for (const action of page.navigation) {
        expect(ACTION_KINDS).toContain(action.kind);
        expect(action.selector).toBeTruthy();
      }
      for (const stop of page.interstitials) {
        expect(stop.dismissSelector).toBeTruthy();
        if ("proceedSelector" in stop) expect(stop.proceedSelector).toBeTruthy();
      }
      if (!page.advance) continue;
      const via = page.navigation.find((a) => a.selector === page.advance!.selector);
      expect(via?.kind, page.pageStep).toBe("advance");
      expect(page.advance.routes.length, page.pageStep).toBeGreaterThan(0);
      for (const route of page.advance.routes) {
        if (route.leadsTo != null) expect(hashes).toContain(route.leadsTo);
      }
      // Two routes that go to different pages must differ in their conditions.
      if (new Set(page.advance.routes.map((r) => r.leadsTo)).size > 1) {
        for (const route of page.advance.routes) expect(route.branch.length, page.pageStep).toBeGreaterThan(0);
      }
    }
  });

  it("records gates and branches against captured fields only", () => {
    for (const page of pages) {
      const onPage = rowsOn(page);
      for (const gate of page.advance?.requires ?? []) {
        if (gate.kind === "uncapturable") {
          expect(gate.selector, `${page.pageStep} uncapturable gate`).toBeNull();
          expect(gate.question, `${page.pageStep} uncapturable gate`).toBeTruthy();
          continue;
        }
        const row = onPage.find((r) => r.selector === gate.selector);
        expect(row, `${page.pageStep} gate ${gate.selector}`).toBeDefined();
        expect(gate.kind).toBe(CHOICE_TYPES.has(row!.fieldType) ? "answer" : "nonEmpty");
      }
      for (const branch of (page.advance?.routes ?? []).flatMap((r) => r.branch)) {
        const row = onPage.find((r) => r.selector === branch.selector);
        expect(CHOICE_TYPES.has(row?.fieldType ?? ""), `${page.pageStep} branch`).toBe(true);
        const value = "option" in branch ? branch.option : branch.notOption;
        expect(row!.options?.map((o) => o.value)).toContain(value);
      }
    }
  });

  it("lists every control-less question, and gates only on listed ones", () => {
    for (const page of pages) {
      for (const q of page.uncapturedQuestions) {
        expect(q.question).toBeTruthy();
        expect(["signature", "file", "widget"]).toContain(q.kind);
      }
      for (const gate of page.advance?.requires ?? []) {
        if (gate.kind !== "uncapturable") continue;
        const listed = page.uncapturedQuestions.find((q) => q.question === gate.question);
        expect(listed?.required, `${page.pageStep} ${gate.question}`).toBe(true);
      }
    }
  });

  it("states readiness exactly as the rule computes it", () => {
    for (const page of pages) {
      const blockers = pageBlockers(page, rowsOn(page));
      expect(page.readyOnceApproved, page.pageStep).toBe(blockers.length === 0);
      expect(page.automationBlockers.length > 0, page.pageStep).toBe(blockers.length > 0);
    }
  });
});
