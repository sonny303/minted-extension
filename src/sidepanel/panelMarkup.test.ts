// The side panel is vanilla TS over a static HTML document, wired by id: every
// handle is `el<T>("some-id")`, which THROWS on a miss. A renamed or removed
// element therefore takes the whole panel down at import time — a blank panel,
// not a broken control — and nothing else in this repo would catch it, because
// main.ts is a DOM entry point with no unit surface of its own.
//
// So this reads both files as text and checks they still agree. It is a
// linting-shaped test rather than a behavioural one, and that is the point:
// the failure it prevents is structural.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const HTML = readFileSync(new URL("../../sidepanel.html", import.meta.url), "utf8");
const MAIN = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

const doc = new JSDOM(HTML).window.document;

/** Source with comments stripped, for "this code path is gone" assertions —
 * a comment explaining WHY something was removed must not read as the thing. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every id main.ts looks up through the el() helper. */
function referencedIds(): string[] {
  const ids = new Set<string>();
  for (const match of MAIN.matchAll(/\bel<[^>]+>\(\s*"([^"]+)"\s*\)/g)) {
    ids.add(match[1]!);
  }
  return [...ids].sort();
}

describe("sidepanel markup ↔ main.ts wiring", () => {
  it("every el() lookup resolves against sidepanel.html", () => {
    const missing = referencedIds().filter((id) => doc.getElementById(id) == null);
    expect(missing).toEqual([]);
  });

  it("finds a meaningful number of handles (the regex still matches)", () => {
    // Guards the test itself: if el() is ever rewritten and the pattern stops
    // matching, the check above passes vacuously.
    expect(referencedIds().length).toBeGreaterThan(50);
  });

  it("no duplicate ids — getElementById would silently pick the first", () => {
    const counts = new Map<string, number>();
    for (const node of doc.querySelectorAll("[id]")) {
      const id = node.getAttribute("id")!;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect([...counts].filter(([, n]) => n > 1).map(([id]) => id)).toEqual([]);
  });

  // The 2026-08-19 three-mode split. These are the containers renderModeSurfaces
  // toggles; if one is renamed, the mode switch silently stops hiding a surface.
  it("carries the three mode buttons and the surfaces they toggle", () => {
    for (const id of [
      "mode-search",
      "mode-case",
      "mode-train",
      "search-section",
      "case-work",
      "train-section",
      "org-field",
    ]) {
      expect(doc.getElementById(id), `#${id}`).not.toBeNull();
    }
  });

  it("keeps every case-work surface INSIDE #case-work", () => {
    // renderModeSurfaces hides that one container instead of each card, so a
    // card that drifts outside it would stay on screen in Search and Train.
    const caseWork = doc.getElementById("case-work")!;
    for (const id of [
      "provider-card",
      "provider-bar",
      "fill-section",
      "active-cases",
      "queue-section",
      "handoff-banner",
      "touch-section",
      "nba-section",
    ]) {
      expect(caseWork.contains(doc.getElementById(id)), `#${id} inside #case-work`).toBe(true);
    }
  });

  it("keeps capture inside the trainer, and out of case work", () => {
    // E6.9's two-job split: capture is a Train-forms affordance only.
    const train = doc.getElementById("train-section")!;
    const caseWork = doc.getElementById("case-work")!;
    const capture = doc.getElementById("capture-section")!;
    expect(train.contains(capture)).toBe(true);
    expect(caseWork.contains(capture)).toBe(false);
  });

  it("carries the manual-mapping affordances inside the trainer", () => {
    // 2026-08-19: adding/correcting a field by hand is a Train-forms job, so
    // these must live under #train-section like capture itself.
    const train = doc.getElementById("train-section")!;
    for (const id of ["capture-add-field", "capture-pick-status"]) {
      const node = doc.getElementById(id);
      expect(node, `#${id}`).not.toBeNull();
      expect(train.contains(node), `#${id} inside #train-section`).toBe(true);
    }
  });

  it("carries the batch bar inside the trainer", () => {
    // US-3.3: bulk delete acts on capture rows, so it belongs to Train forms
    // like the rows themselves.
    const train = doc.getElementById("train-section")!;
    for (const id of ["capture-batch", "capture-batch-count", "capture-batch-delete"]) {
      expect(train.contains(doc.getElementById(id)), `#${id} inside #train-section`).toBe(true);
    }
  });

  it("offers the sandbox from Search and its controls from Work cases", () => {
    // US-5.1: the way IN is pinned above search results (it never depends on a
    // query); the fill controls live where the fill happens.
    expect(doc.getElementById("search-section")!.contains(doc.getElementById("sandbox-entry"))).toBe(
      true,
    );
    const caseWork = doc.getElementById("case-work")!;
    for (const id of ["sandbox-bar", "sandbox-fill", "sandbox-clear", "sandbox-exit"]) {
      expect(caseWork.contains(doc.getElementById(id)), `#${id} inside #case-work`).toBe(true);
    }
  });

  it("keeps every case-scoped surface inside #case-fill, and portal status OUT of it", () => {
    // renderSandboxBar hides #case-fill wholesale in the sandbox, which has no
    // case by design. Portal recognition is deliberately outside: a sandbox
    // fill needs to know whether this page is a portal every bit as much as a
    // real one does, so hiding it with the case block would blind the sandbox.
    const caseFill = doc.getElementById("case-fill")!;
    for (const id of ["case-select", "case-context", "coverage-panel", "fill-btn"]) {
      expect(caseFill.contains(doc.getElementById(id)), `#${id} inside #case-fill`).toBe(true);
    }
    expect(caseFill.contains(doc.getElementById("portal-status"))).toBe(false);
    // …but still within the fill section, so the location picker and the
    // banner stay together.
    expect(
      doc.getElementById("fill-section")!.contains(doc.getElementById("portal-status")),
    ).toBe(true);
  });

  it("keeps the E1.5 case-locations list beside the Location picker, inside #fill-section", () => {
    // Read-only context alongside facility-select, which stays the one
    // fill-target control — never inside #case-fill (it isn't case-SCOPED
    // work, it's location context) but still inside #fill-section, hence
    // #case-work, so renderModeSurfaces still hides it correctly.
    const fillSection = doc.getElementById("fill-section")!;
    expect(fillSection.contains(doc.getElementById("case-locations-list"))).toBe(true);
  });

  it("has retired the Browse-providers dropdown", () => {
    // Superseded by free-text search, which can name the group a provider
    // belongs to — the dropdown could not, so two same-named providers were
    // indistinguishable in it.
    expect(doc.getElementById("provider-select")).toBeNull();
    expect(doc.getElementById("provider-section")).toBeNull();
    expect(codeOf(MAIN)).not.toContain("provider-select");
  });

  it("has retired the hard-coded Malpractice row", () => {
    // Those groupInsurance.* fields are ordinary layout-picker fields now.
    // Comment-stripped, so the note explaining the removal doesn't fail it.
    expect(doc.getElementById("malpractice-row")).toBeNull();
    expect(codeOf(MAIN).toLowerCase()).not.toContain("malpractice");
  });
});
