import { describe, expect, it } from "vitest";
import type { ProviderListItem } from "./apiTypes";
import type { ReportedField, SandboxFillSummary } from "./fill";
import {
  findSandboxProvider,
  isSandboxProvider,
  SANDBOX_ENTRY_META,
  SANDBOX_LABEL,
  SANDBOX_NO_FORM_NOTE,
  sandboxClearView,
  sandboxEntryTitle,
  sandboxFilledCount,
  sandboxFillState,
  sandboxFillView,
  sandboxProfileName,
} from "./sandbox";

function provider(over: Partial<ProviderListItem> = {}): ProviderListItem {
  return {
    id: over.id ?? "p1",
    firstName: "Ada",
    lastName: "Lovelace",
    npi: "1234567890",
    status: "active",
    ...over,
  } as ProviderListItem;
}

describe("findSandboxProvider", () => {
  it("finds the designated provider", () => {
    const target = provider({ id: "p2", isTestProvider: true });
    expect(findSandboxProvider([provider(), target, provider({ id: "p3" })])).toBe(target);
  });

  it("returns null when the org has designated nobody", () => {
    // The panel must say so honestly rather than offering a button that fails
    // when pressed, so "no sandbox" has to be distinguishable from "not loaded".
    expect(findSandboxProvider([provider(), provider({ id: "p2" })])).toBeNull();
  });

  it("returns null for an empty roster", () => {
    expect(findSandboxProvider([])).toBeNull();
  });

  it("never treats a missing flag as designated", () => {
    // A panel deployed before is_test_provider rides the list projection sends
    // no key at all; guessing would fill a real provider's data into a portal.
    expect(findSandboxProvider([provider({ isTestProvider: undefined })])).toBeNull();
    expect(findSandboxProvider([provider({ isTestProvider: false })])).toBeNull();
  });

  it("picks the first in roster order when several are flagged", () => {
    // Stable between panel opens: a sandbox that silently changed identity
    // would make a failed test impossible to interpret.
    const first = provider({ id: "a", isTestProvider: true });
    const second = provider({ id: "b", isTestProvider: true });
    expect(findSandboxProvider([first, second])).toBe(first);
    expect(findSandboxProvider([second, first])).toBe(second);
  });
});

describe("isSandboxProvider", () => {
  it("agrees with findSandboxProvider about what counts", () => {
    expect(isSandboxProvider(provider({ isTestProvider: true }))).toBe(true);
    expect(isSandboxProvider(provider())).toBe(false);
    expect(isSandboxProvider(null)).toBe(false);
    expect(isSandboxProvider(undefined)).toBe(false);
  });
});

describe("sandboxFillState", () => {
  it("stands the provider's home state in for the absent case", () => {
    expect(sandboxFillState(provider({ homeState: "NC" }))).toBe("NC");
  });

  it("trims", () => {
    expect(sandboxFillState(provider({ homeState: " KS " }))).toBe("KS");
  });

  it("is null when there is no home state — a legitimate answer", () => {
    // The profile endpoint then returns state-scoped tokens unresolved WITH
    // reasons, which still exercises the rest of the form.
    expect(sandboxFillState(provider({ homeState: null }))).toBeNull();
    expect(sandboxFillState(provider({ homeState: "   " }))).toBeNull();
    expect(sandboxFillState(provider({ homeState: undefined }))).toBeNull();
    expect(sandboxFillState(null)).toBeNull();
  });
});

function summary(over: Partial<SandboxFillSummary> = {}): SandboxFillSummary {
  return {
    filled: 0,
    filledLabels: [],
    skipped: [],
    manual: [],
    pageFields: 4,
    fillSessionId: "3f2a9c1e-0000-4000-8000-000000000000",
    logError: null,
    fieldsAttempted: 3,
    fieldsVerified: 0,
    fieldsRejected: 0,
    ...over,
  };
}

function field(kind: ReportedField["kind"], label = "First name"): ReportedField {
  return { label, reason: "why", kind };
}

/** Everything a test-mode view puts on screen. */
function shownText(view: ReturnType<typeof sandboxFillView>): string[] {
  return [...view.lines, ...view.skipLines, ...(view.recordLine ? [view.recordLine] : [])];
}

describe("test profile naming (G1)", () => {
  it("titles the Search row with the provider's name, first name first", () => {
    expect(sandboxEntryTitle(provider())).toBe("Test profile: Ada Lovelace");
    expect(SANDBOX_ENTRY_META).toBe("No case needed.");
  });

  it("never says sandbox or shows an emoji", () => {
    for (const text of [SANDBOX_LABEL, SANDBOX_ENTRY_META, SANDBOX_NO_FORM_NOTE, sandboxEntryTitle(provider())]) {
      expect(text).not.toMatch(/sandbox/i);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toContain("—");
    }
  });

  it("trims and drops a blank part of the name", () => {
    expect(sandboxProfileName(provider({ firstName: " Ada ", lastName: "" }))).toBe("Ada");
    expect(sandboxEntryTitle(provider({ firstName: "", lastName: " " }))).toBe("Test profile");
  });
});

describe("sandboxFilledCount", () => {
  it("counts writes, not read-back checks (the engine never reads back)", () => {
    // The worker reports filled = fields checked after writing, which is 0 on
    // every v2 run. Counting it would call every good test fill a failure.
    expect(sandboxFilledCount(summary({ filled: 0, fieldsAttempted: 3 }))).toBe(3);
  });

  it("leaves out writes the portal rejected", () => {
    expect(sandboxFilledCount(summary({ fieldsAttempted: 3, fieldsRejected: 1 }))).toBe(2);
    expect(sandboxFilledCount(summary({ fieldsAttempted: 1, fieldsRejected: 2 }))).toBe(0);
  });

  it("falls back to filled when the worker sends no attempt count", () => {
    expect(sandboxFilledCount(summary({ filled: 2, fieldsAttempted: undefined }))).toBe(2);
  });
});

describe("sandboxFillView (G4)", () => {
  it("reads like a real fill when fields were written", () => {
    const view = sandboxFillView(summary({ fieldsAttempted: 12 }));
    expect(view).toEqual({
      filled: 12,
      tone: "ok",
      lines: ["Filled 12 fields on this page.", "Green outline on the page = filled by Minted."],
      skipLines: [],
      recordLine: null,
    });
  });

  it("says field, not fields, for one", () => {
    expect(sandboxFillView(summary({ fieldsAttempted: 1 })).lines[0]).toBe("Filled 1 field on this page.");
  });

  it("is red when nothing was written", () => {
    const view = sandboxFillView(summary({ fieldsAttempted: 0 }));
    expect(view.tone).toBe("danger");
    expect(view.lines[0]).toBe("Nothing was filled on this page.");
  });

  it("counts leave_blank maps apart, muted, never as a field that needs you", () => {
    const view = sandboxFillView(summary({
      fieldsAttempted: 2,
      manual: [],
      leftBlank: [field("leave_blank", "Middle Name"), field("leave_blank", "Suffix"), field("leave_blank", "Fax")],
    }));
    expect(view.skipLines).toEqual(["3 left blank on purpose."]);
    expect(shownText(view).join(" ")).not.toMatch(/needs? you/);
    expect(shownText(view).join(" ")).not.toContain("Middle Name");
  });

  it("reads neutral, not red, when every map was left blank on purpose", () => {
    const view = sandboxFillView(summary({
      fieldsAttempted: 0,
      leftBlank: [field("leave_blank", "Middle Name"), field("leave_blank", "Suffix")],
    }));
    expect(view).toEqual({
      filled: 0,
      tone: "neutral",
      lines: ["Nothing to fill on this page.", "2 left blank on purpose."],
      skipLines: [],
      recordLine: null,
    });
    // A planned field that went missing is still the drift case.
    const drifted = sandboxFillView(summary({
      fieldsAttempted: 0,
      skipped: [field("skipped", "NPI")],
      leftBlank: [field("leave_blank", "Middle Name")],
    }));
    expect(drifted.tone).toBe("danger");
    expect(drifted.skipLines).toContain("1 left blank on purpose.");
  });

  it("adds one neutral line per kind of skip, counts only", () => {
    const view = sandboxFillView(summary({
      skipped: [field("skipped", "NPI"), field(undefined, "Tax ID")],
      manual: [field("no_value", "DEA"), field("file", "W-9"), field("no_mapping", "Fax")],
    }));
    expect(view.skipLines).toEqual([
      "2 fields on this page were skipped.",
      "2 fields on this form need you: not on file, or filled by hand.",
    ]);
    // No labels on screen in this line, and never a selector.
    expect(view.skipLines.join(" ")).not.toMatch(/NPI|Tax ID|DEA|W-9|Fax/);
  });

  it("uses the singular for one skip", () => {
    const view = sandboxFillView(summary({ skipped: [field("skipped")], manual: [field("manual")] }));
    expect(view.skipLines).toEqual([
      "1 field on this page was skipped.",
      "1 field on this form needs you: not on file, or filled by hand.",
    ]);
  });

  it("says plainly when the test fill record did not save, without the raw error", () => {
    const view = sandboxFillView(summary({ logError: "Test fill applied, but Minted Panel didn't save a record of it." }));
    expect(view.tone).toBe("ok");
    expect(view.recordLine).toBe(
      "Minted Panel didn't save a record of this test fill. You can keep testing.",
    );
    expect(shownText(view).join(" ")).not.toMatch(/sandbox|telemetry/i);
  });

  it("uses plain words: no sandbox, no em dashes, no checking talk", () => {
    const views = [
      sandboxFillView(summary({ fieldsAttempted: 4, skipped: [field("skipped")], manual: [field("no_value")], logError: "x" })),
      sandboxFillView(summary({ fieldsAttempted: 0 })),
    ];
    for (const text of views.flatMap(shownText)) {
      expect(text).not.toMatch(/sandbox|verified|setter|telemetry/i);
      expect(text).not.toContain("—");
    }
  });
});

describe("sandboxClearView (G5)", () => {
  it("says so when there was nothing to clear", () => {
    expect(sandboxClearView(0)).toEqual({ tone: "neutral", text: "Nothing to clear." });
  });

  it("reports what it cleared", () => {
    expect(sandboxClearView(7)).toEqual({ tone: "ok", text: "Cleared 7 fields. Ready to test again." });
    expect(sandboxClearView(1).text).toBe("Cleared 1 field. Ready to test again.");
  });
});
