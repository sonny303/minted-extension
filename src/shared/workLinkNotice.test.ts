import { describe, expect, it } from "vitest";
import {
  carriedLaunchId,
  isLaunchReplacement,
  launchSwapLine,
  WORK_LINK_ENDED_LINE,
  workEndedCaseId,
  workEndedLine,
} from "./workLinkNotice";
import type { ActiveWorkRecord, ActiveWorkState } from "./workContext";

const CASE_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function active(launchReceiptId: string): ActiveWorkState {
  return {
    status: "active",
    record: { tuple: { launchReceiptId } } as unknown as ActiveWorkRecord,
  };
}

const blocked = (extra: Partial<Extract<ActiveWorkState, { status: "blocked" }>> = {}) =>
  ({ status: "blocked", orgId: ORG_ID, ...extra }) as Extract<ActiveWorkState, { status: "blocked" }>;

describe("workEndedLine (D5)", () => {
  it("names the payer tab that closed", () => {
    expect(workEndedLine("tab_closed", "Aetna")).toBe("The Aetna tab was closed. Click Work in portal again.");
  });

  it("says the tab left the payer's site", () => {
    expect(workEndedLine("left_site", "Aetna")).toBe(
      "The Aetna tab left the payer's site. Open the case and click Work in portal again.",
    );
  });

  it("says the link timed out, with no payer needed", () => {
    expect(workEndedLine("expired", null)).toBe(
      "This link timed out after 60 minutes. Open the case and click Work in portal again.",
    );
  });

  it("keeps the generic line for ended and for an old block with no reason", () => {
    expect(workEndedLine("ended", "Aetna")).toBe(WORK_LINK_ENDED_LINE);
    expect(workEndedLine(undefined, "Aetna")).toBe(WORK_LINK_ENDED_LINE);
  });

  it("says payer when the name is unknown, and never doubles a leading 'the'", () => {
    expect(workEndedLine("tab_closed", null)).toBe("The payer tab was closed. Click Work in portal again.");
    // payerLabel()'s own fallback.
    expect(workEndedLine("tab_closed", "the payer")).toBe("The payer tab was closed. Click Work in portal again.");
    expect(workEndedLine("tab_closed", "The Hartford")).toBe("The Hartford tab was closed. Click Work in portal again.");
    expect(workEndedLine("left_site", "  ")).toMatch(/^The payer tab left/);
  });

  it("uses no em dashes in any line", () => {
    for (const reason of ["tab_closed", "left_site", "expired", "ended", undefined] as const) {
      expect(workEndedLine(reason, "Aetna")).not.toContain("—");
    }
  });
});

describe("workEndedCaseId (Back to case)", () => {
  it("links the ended case for the three explained reasons", () => {
    for (const reason of ["tab_closed", "left_site", "expired"] as const) {
      expect(workEndedCaseId(blocked({ reason, ownerKind: "case", ownerId: CASE_ID }))).toBe(CASE_ID);
    }
  });

  it("offers no link for ended, an old block, or a contract", () => {
    expect(workEndedCaseId(blocked({ reason: "ended", ownerKind: "case", ownerId: CASE_ID }))).toBeNull();
    expect(workEndedCaseId(blocked())).toBeNull();
    expect(workEndedCaseId(blocked({ reason: "tab_closed" }))).toBeNull();
    expect(workEndedCaseId(blocked({ reason: "tab_closed", ownerKind: "contract", ownerId: CASE_ID }))).toBeNull();
  });
});

describe("isLaunchReplacement (D6)", () => {
  it("is true when a different launch takes over from the one shown", () => {
    expect(isLaunchReplacement("launch-a", active("launch-b"))).toBe(true);
  });

  it("is false on the first launch and on a re-render of the same launch", () => {
    expect(isLaunchReplacement(null, active("launch-a"))).toBe(false);
    expect(isLaunchReplacement("launch-a", active("launch-a"))).toBe(false);
  });

  it("is false when nothing live replaced it", () => {
    expect(isLaunchReplacement("launch-a", blocked({ reason: "ended" }))).toBe(false);
    expect(isLaunchReplacement("launch-a", { status: "none" })).toBe(false);
  });
});

describe("carriedLaunchId", () => {
  it("tracks the live launch", () => {
    expect(carriedLaunchId(null, active("launch-a"))).toBe("launch-a");
    expect(carriedLaunchId("launch-a", active("launch-b"))).toBe("launch-b");
  });

  it("carries through the ended block a new launch writes, so a mid-launch poll still sees the swap", () => {
    let shown = carriedLaunchId(null, active("launch-a"));
    shown = carriedLaunchId(shown, blocked({ reason: "ended" }));
    expect(shown).toBe("launch-a");
    expect(isLaunchReplacement(shown, active("launch-b"))).toBe(true);
    // An old block with no reason behaves the same.
    expect(carriedLaunchId("launch-a", blocked())).toBe("launch-a");
  });

  it("drops the launch once the panel has explained why it ended", () => {
    for (const reason of ["tab_closed", "left_site", "expired"] as const) {
      const shown = carriedLaunchId("launch-a", blocked({ reason, ownerKind: "case", ownerId: CASE_ID }));
      expect(shown).toBeNull();
      expect(isLaunchReplacement(shown, active("launch-b"))).toBe(false);
    }
    expect(carriedLaunchId("launch-a", { status: "none" })).toBeNull();
    expect(carriedLaunchId("launch-a", { status: "expired", record: {} as ActiveWorkRecord })).toBeNull();
  });
});

describe("launchSwapLine (D6)", () => {
  it("names the provider, payer, and state", () => {
    expect(launchSwapLine({ provider: "Taylor Example", payer: "Aetna", state: "CO" })).toBe(
      "You opened another case from Minted Panel. This panel now shows Taylor Example, Aetna CO.",
    );
  });

  it("leaves out an unknown state", () => {
    expect(launchSwapLine({ provider: "Taylor Example", payer: "Aetna", state: null })).toBe(
      "You opened another case from Minted Panel. This panel now shows Taylor Example, Aetna.",
    );
  });

  it("falls back to the new case until the names are known", () => {
    const fallback = "You opened another case from Minted Panel. This panel now shows the new case.";
    expect(launchSwapLine({ provider: null, payer: null, state: null })).toBe(fallback);
    expect(launchSwapLine({ provider: "Taylor Example", payer: null, state: "CO" })).toBe(fallback);
    expect(launchSwapLine({ provider: " ", payer: "Aetna", state: "CO" })).toBe(fallback);
  });
});
