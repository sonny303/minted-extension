import { describe, expect, it } from "vitest";
import {
  canTrainForms,
  DEFAULT_PANEL_MODE,
  fallbackModeFor,
  isCaptureMode,
  isOrgScopedMode,
  PANEL_MODES,
  parsePanelMode,
  shouldSendOrgHeader,
  USER_SCOPED_PATHS,
  visiblePanelModes,
} from "./panelMode";

describe("parsePanelMode", () => {
  it("accepts the three jobs and rejects everything else", () => {
    expect(parsePanelMode("search")).toBe("search");
    expect(parsePanelMode("train")).toBe("train");
    expect(parsePanelMode("case")).toBe("case");
    for (const bad of ["Train", "Search", "", null, undefined, 1, {}, ["train"]]) {
      expect(parsePanelMode(bad)).toBeNull();
    }
  });

  it("defaults to case work", () => {
    // A hand-off is case work, and an unset/garbage mode must never strand one
    // in the trainer (where its calls would lose the org header).
    expect(DEFAULT_PANEL_MODE).toBe("case");
  });
});

describe("isCaptureMode", () => {
  it("is true only for Train forms — Work cases and Search never show capture", () => {
    expect(isCaptureMode("train")).toBe(true);
    expect(isCaptureMode("case")).toBe(false);
    expect(isCaptureMode("search")).toBe(false);
  });
});

describe("isOrgScopedMode", () => {
  it("covers Search and Work cases, never Train forms", () => {
    // Search reads /api/cases?q= and /api/providers?search= — org-scoped
    // exactly like the case work it feeds.
    expect(isOrgScopedMode("search")).toBe(true);
    expect(isOrgScopedMode("case")).toBe(true);
    expect(isOrgScopedMode("train")).toBe(false);
  });
});

describe("canTrainForms / visiblePanelModes (Train forms is admin-only)", () => {
  const admin = [{ role: "admin" }];
  const specialist = [{ role: "specialist" }];
  const billing = [{ role: "billing" }];

  it("admin in ANY org may train — the shared library belongs to no org", () => {
    expect(canTrainForms(admin)).toBe(true);
    expect(canTrainForms([...billing, ...admin])).toBe(true);
  });

  it("no admin membership, no trainer", () => {
    expect(canTrainForms(specialist)).toBe(false);
    expect(canTrainForms(billing)).toBe(false);
    expect(canTrainForms([])).toBe(false);
  });

  it("tolerates casing and padding on the stored role string", () => {
    expect(canTrainForms([{ role: " Admin " }])).toBe(true);
  });

  it("offers Search + Work cases to everyone, Train forms only to admins", () => {
    expect(visiblePanelModes(specialist)).toEqual(["search", "case"]);
    expect(visiblePanelModes(admin)).toEqual(["search", "case", "train"]);
    // Render order is the declared one, never re-sorted per user.
    expect(visiblePanelModes(admin)).toEqual([...PANEL_MODES]);
  });

  it("moves a non-admin off Train forms — never strand a user on hidden UI", () => {
    // Reachable for real: a stored session mode outlives a role change.
    expect(fallbackModeFor("train", specialist)).toBe(DEFAULT_PANEL_MODE);
    expect(fallbackModeFor("train", admin)).toBe("train");
    expect(fallbackModeFor("search", specialist)).toBe("search");
    expect(fallbackModeFor("case", billing)).toBe("case");
  });
});

describe("shouldSendOrgHeader", () => {
  const ORG = "org-1";

  it("sends the header on org-scoped routes in case mode", () => {
    expect(shouldSendOrgHeader("case", "/api/cases", ORG)).toBe(true);
    expect(shouldSendOrgHeader("case", "/api/providers", ORG)).toBe(true);
  });

  it("sends it in SEARCH mode too — the search routes are org-scoped", () => {
    // A multi-org user searching without the header gets a 400 from the
    // org-resolving guard, not results.
    expect(shouldSendOrgHeader("search", "/api/cases", ORG)).toBe(true);
    expect(shouldSendOrgHeader("search", "/api/providers", ORG)).toBe(true);
  });

  it("never sends it in training mode, even for a multi-org user", () => {
    // This is the whole point of the mode: a training capture writes the
    // SHARED library and runs on the user-scoped guard. An org header here
    // would scope the row to that org — the exact row we do not want.
    expect(shouldSendOrgHeader("train", "/api/shared-field-maps", ORG)).toBe(false);
    expect(shouldSendOrgHeader("train", "/api/shared-portals", ORG)).toBe(false);
    // Even a route that WOULD take one in case mode.
    expect(shouldSendOrgHeader("train", "/api/cases", ORG)).toBe(false);
  });

  it("never sends it on the user-scoped routes, in either mode", () => {
    for (const path of USER_SCOPED_PATHS) {
      expect(shouldSendOrgHeader("case", path, ORG)).toBe(false);
      expect(shouldSendOrgHeader("train", path, ORG)).toBe(false);
    }
  });

  it("sends nothing in single-org mode (the server resolves the sole membership)", () => {
    expect(shouldSendOrgHeader("case", "/api/cases", null)).toBe(false);
    expect(shouldSendOrgHeader("train", "/api/cases", null)).toBe(false);
  });

  it("keeps org discovery reachable so a stale stored org cannot brick recovery", () => {
    expect(USER_SCOPED_PATHS).toContain("/api/me/orgs");
    expect(shouldSendOrgHeader("case", "/api/me/orgs", "revoked-org")).toBe(false);
  });
});
