import { describe, expect, it } from "vitest";
import {
  DEFAULT_PANEL_MODE,
  isCaptureMode,
  parsePanelMode,
  shouldSendOrgHeader,
  USER_SCOPED_PATHS,
} from "./panelMode";

describe("parsePanelMode", () => {
  it("accepts the two jobs and rejects everything else", () => {
    expect(parsePanelMode("train")).toBe("train");
    expect(parsePanelMode("case")).toBe("case");
    for (const bad of ["Train", "", null, undefined, 1, {}, ["train"]]) {
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
  it("is true only for Train forms — Work cases never shows capture", () => {
    expect(isCaptureMode("train")).toBe(true);
    expect(isCaptureMode("case")).toBe(false);
  });
});

describe("shouldSendOrgHeader", () => {
  const ORG = "org-1";

  it("sends the header on org-scoped routes in case mode", () => {
    expect(shouldSendOrgHeader("case", "/api/cases", ORG)).toBe(true);
    expect(shouldSendOrgHeader("case", "/api/providers", ORG)).toBe(true);
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
