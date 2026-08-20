import { describe, expect, it } from "vitest";
import { matchPortalByUrl, portalOriginPatterns } from "./portals";
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
      row({
        portalKey: "aetna",
        formUrl: "https://www.aetna.com/join/network?step=1",
      }),
      row({
        portalKey: "bcbsks",
        formUrl: "https://provider.bcbsks.com/form/x.faces",
      }),
    ]);
    expect(patterns).toEqual([
      "https://www.aetna.com/*",
      "https://provider.bcbsks.com/*",
    ]);
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

describe("matchPortalByUrl", () => {
  it("returns null for an empty registry (not a page mismatch signal)", () => {
    expect(
      matchPortalByUrl("https://provider.example.com/enroll", []),
    ).toBeNull();
  });

  it("matches the longest formUrl prefix", () => {
    const rows = [
      row({
        portalKey: "host",
        name: "Host",
        formUrl: "https://provider.example.com/",
      }),
      row({
        portalKey: "enroll",
        name: "Enroll",
        formUrl: "https://provider.example.com/enroll",
      }),
    ];
    const hit = matchPortalByUrl(
      "https://provider.example.com/enroll/step2?x=1",
      rows,
    );
    expect(hit?.key).toBe("enroll");
  });
});

describe("matched portal identity", () => {
  it("carries the payer id through, so a finished capture can link to its editor", () => {
    // The panel hands a sent capture to the payer's template editor in the web
    // app. Dropping the id here would leave the trainer with the instruction
    // and no way to follow it.
    const matched = matchPortalByUrl("https://p.example.com/form", [
      row({ formUrl: "https://p.example.com/form", payerId: "payer-1" }),
    ]);
    expect(matched?.payerId).toBe("payer-1");
  });

  it("is null for a registry row that names no payer", () => {
    const matched = matchPortalByUrl("https://p.example.com/form", [
      row({ formUrl: "https://p.example.com/form" }),
    ]);
    expect(matched?.payerId).toBeNull();
  });
});
