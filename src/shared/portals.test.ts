import { describe, expect, it } from "vitest";
import { portalOriginPatterns } from "./portals";
import type { PortalRegistryRow } from "./apiTypes";

function row(overrides: Partial<PortalRegistryRow>): PortalRegistryRow {
  return {
    id: "id",
    orgId: null,
    portalKey: "portal",
    name: "Portal",
    payerId: null,
    formUrl: null,
    isVerified: false,
    lastVerifiedAt: null,
    provenAt: null,
    urlChangedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("portalOriginPatterns", () => {
  it("returns a host match pattern per https form origin", () => {
    const patterns = portalOriginPatterns([
      row({ portalKey: "aetna", formUrl: "https://www.aetna.com/join/network?step=1" }),
      row({ portalKey: "bcbsks", formUrl: "https://provider.bcbsks.com/form/x.faces" }),
    ]);
    expect(patterns).toEqual(["https://www.aetna.com/*", "https://provider.bcbsks.com/*"]);
  });

  it("collapses many rows on one host to a single pattern", () => {
    const patterns = portalOriginPatterns([
      row({ portalKey: "a", formUrl: "https://portal.example.com/a" }),
      row({ portalKey: "b", formUrl: "https://portal.example.com/b" }),
    ]);
    expect(patterns).toEqual(["https://portal.example.com/*"]);
  });

  it("skips rows with no form url, a malformed url, or a non-https scheme", () => {
    const patterns = portalOriginPatterns([
      row({ formUrl: null }),
      row({ formUrl: "not a url" }),
      row({ formUrl: "http://insecure.example.com/form" }),
      row({ portalKey: "ok", formUrl: "https://ok.example.com/form" }),
    ]);
    expect(patterns).toEqual(["https://ok.example.com/*"]);
  });

  it("is empty for an empty registry", () => {
    expect(portalOriginPatterns([])).toEqual([]);
  });
});
