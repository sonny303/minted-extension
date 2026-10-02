import { describe, expect, it } from "vitest";
import {
  bestPortalCandidatesByUrl,
  matchPortalByUrl,
  portalMappingState,
  portalCandidatesByUrl,
  portalKeyEligibleForUrl,
  portalOriginPatterns,
} from "./portals";
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
        portalKey: "national",
        formUrl: "https://portal.example.com/national/join/network?step=1",
      }),
      row({
        portalKey: "regional",
        formUrl: "https://portal.example.com/regional/form/x",
      }),
    ]);
    expect(patterns).toEqual([
      "https://portal.example.com/*",
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

  it("keeps all equal-URL candidates and orders specific paths first", () => {
    const rows = [
      row({ portalKey: "host", formUrl: "https://provider.example.com/" }),
      row({ portalKey: "contract", formUrl: "https://provider.example.com/enroll", caseType: "contract" }),
      row({ portalKey: "enrollment", formUrl: "https://provider.example.com/enroll", caseType: "enrollment" }),
    ];
    const all = portalCandidatesByUrl("https://provider.example.com/enroll/step2?x=1", rows);
    expect(all.map((candidate) => candidate.key)).toEqual(["contract", "enrollment", "host"]);
    expect(bestPortalCandidatesByUrl("https://provider.example.com/enroll/step2", rows).map((x) => x.key)).toEqual([
      "contract",
      "enrollment",
    ]);
  });

  it("enforces a path boundary for candidate eligibility", () => {
    const rows = [row({ portalKey: "enroll", formUrl: "https://provider.example.com/enroll" })];
    expect(portalKeyEligibleForUrl("enroll", "https://provider.example.com/enrollment", rows)).toBe(false);
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
    expect(matched?.portalId).toBe("id");
    expect(matched?.mappingGeneration).toBe(1);
  });

  it("is null for a registry row that names no payer", () => {
    const matched = matchPortalByUrl("https://p.example.com/form", [
      row({ formUrl: "https://p.example.com/form" }),
    ]);
    expect(matched?.payerId).toBeNull();
  });
});

describe("current portal mapping identity", () => {
  const target = { portalId: "org-config", portalKey: "enrollment", mappingGeneration: 3 };
  const metadata = {
    portal_key: "enrollment",
    portal_id: "org-config",
    case_type: "enrollment",
    requires_explicit_selection: false,
    mapping_generation: 3,
    active_field_count: 2,
    mapping_ready: true,
    is_verified: true,
    effective_mapping_fingerprint: "sha256:current",
  };

  it("requires the selected exact id, key, generation, and a ready map set", () => {
    expect(portalMappingState([metadata], target)).toBe("ready");
    expect(portalMappingState([metadata], { ...target, portalId: "shared-config" })).toBe("changed");
    expect(portalMappingState([metadata], { ...target, mappingGeneration: 2 })).toBe("changed");
    expect(portalMappingState([], target)).toBe("missing");
    expect(portalMappingState([{ ...metadata, active_field_count: 0, mapping_ready: false }], target)).toBe("unready");
    expect(portalMappingState([{ ...metadata, requires_explicit_selection: true }], target)).toBe("unready");
  });

  it("fails closed when URL matching picked the shared row but org-over-global metadata selected the org row", () => {
    const sharedCandidate = { ...target, portalId: "shared-config" };
    expect(portalMappingState([metadata], sharedCandidate)).toBe("changed");
    expect(portalMappingState([metadata, metadata], target)).toBe("missing");
  });

  it("detects reset or mapping edits while an AI review is open", () => {
    expect(portalMappingState([{ ...metadata, mapping_generation: 4 }], target)).toBe("changed");
    expect(portalMappingState([metadata], target, "sha256:before-edit")).toBe("changed");
  });
});
