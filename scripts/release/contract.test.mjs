import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  targetFor,
  validatePublicConfiguration,
  releaseManifest,
  validateManifest,
  validateBundleText,
  validateStoreDestination,
} from "./contract.mjs";
import { publicConfig, storeFixture } from "./fixtures.mjs";

const base = JSON.parse(
  await readFile(new URL("../../public/manifest.json", import.meta.url), "utf8"),
);

describe("explicit environment configuration", () => {
  it("accepts only complete target-coherent public configuration", () => {
    for (const target of ["staging", "production"])
      expect(validatePublicConfiguration(target, publicConfig(target))).toEqual(
        publicConfig(target),
      );
    expect(() => targetFor()).toThrow("TARGET_REQUIRED");
    expect(() => targetFor("preview")).toThrow("TARGET_REQUIRED");
    expect(() => validatePublicConfiguration("staging", publicConfig(), Number.NaN)).toThrow(
      "INVALID_CLOCK",
    );
    for (const field of Object.keys(publicConfig())) {
      const config = publicConfig();
      delete config[field];
      expect(() => validatePublicConfiguration("staging", config)).toThrow("PUBLIC_CONFIGURATION");
    }
  });
  it("accepts a publishable key without claiming to verify its opaque project binding", () => {
    expect(
      validatePublicConfiguration("staging", {
        ...publicConfig(),
        VITE_SUPABASE_ANON_KEY: "sb_publishable_syntheticPublicFixtureNotForAuthentication",
      }).VITE_SUPABASE_ANON_KEY,
    ).toMatch(/^sb_publishable_/);
  });

  it("rejects foreign URLs, production defaults and secret-shaped config", () => {
    expect(() => validatePublicConfiguration("staging", publicConfig("production"))).toThrow(
      "CONFIGURATION_TARGET",
    );
    expect(() =>
      validatePublicConfiguration("staging", {
        ...publicConfig(),
        SUPABASE_SERVICE_ROLE_KEY: "private-sentinel",
      }),
    ).toThrow("PUBLIC_CONFIGURATION");
    for (const key of [
      "sb_secret_private-sentinel",
      "sb_publishable_unverified-project",
      "",
      publicConfig("production").VITE_SUPABASE_ANON_KEY,
    ]) {
      expect(() =>
        validatePublicConfiguration("staging", { ...publicConfig(), VITE_SUPABASE_ANON_KEY: key }),
      ).toThrow();
    }
    const key = publicConfig().VITE_SUPABASE_ANON_KEY.split(".");
    const payload = JSON.parse(Buffer.from(key[1], "base64url").toString());
    for (const replacement of [
      { ...payload, role: "service_role" },
      { ...payload, exp: 1 },
    ]) {
      key[1] = Buffer.from(JSON.stringify(replacement)).toString("base64url");
      expect(() =>
        validatePublicConfiguration("staging", {
          ...publicConfig(),
          VITE_SUPABASE_ANON_KEY: key.join("."),
        }),
      ).toThrow("PUBLIC_ANON_KEY");
    }
  });
});

describe("manifest and asset boundaries", () => {
  it("keeps exact environment-owned origins and separate names", () => {
    for (const target of ["staging", "production"]) {
      const manifest = releaseManifest(base, target, base.version);
      expect(manifest.externally_connectable.matches).toEqual(
        targetFor(target).origins.map((origin) => `${origin}/*`),
      );
      expect(manifest.host_permissions).toContain(`${publicConfig(target).VITE_SUPABASE_URL}/*`);
      expect(() => validateManifest(manifest, target, base.version)).not.toThrow();
      expect(() =>
        validateManifest(manifest, target === "staging" ? "production" : "staging", base.version),
      ).toThrow();
    }
    expect(releaseManifest(base, "staging", base.version).name).toContain("STAGING (Local)");
    expect(base.name).toBe("Minted Panel Workbench");
  });

  it("rejects broad permissions, foreign senders and version drift", () => {
    const manifest = releaseManifest(base, "staging", base.version);
    manifest.externally_connectable.matches.push("https://www.mintedpanel.com/*");
    expect(() => validateManifest(manifest, "staging", base.version)).toThrow("MANIFEST_TARGET");
    const permissions = releaseManifest(base, "staging", base.version);
    permissions.permissions.push("cookies");
    expect(() => validateManifest(permissions, "staging", base.version)).toThrow("MANIFEST_PERMISSIONS");
    const missingNavigation = releaseManifest(base, "staging", base.version);
    missingNavigation.permissions = missingNavigation.permissions.filter(
      (permission) => permission !== "webNavigation",
    );
    expect(() => validateManifest(missingNavigation, "staging", base.version)).toThrow(
      "MANIFEST_PERMISSIONS",
    );
    expect(() => releaseManifest(base, "staging", "9.9.9")).toThrow("PACKAGE_VERSION");
  });

  it("rejects wrong-target URLs and embedded credentials without echoing contents", () => {
    const config = publicConfig();
    expect(() =>
      validateBundleText(JSON.stringify(config), "staging", config.VITE_SUPABASE_ANON_KEY),
    ).not.toThrow();
    for (const value of [
      "https://mintedpanel.vercel.app",
      "https://www.mintedpanel.com",
      "fkvuhfsqcmujywzgczmc",
    ])
      expect(() => validateBundleText(value, "staging", config.VITE_SUPABASE_ANON_KEY)).toThrow(
        "BUNDLE_WRONG_TARGET",
      );
    for (const value of [
      "sb_secret_private-sentinel",
      "x-vercel-protection-bypass",
      publicConfig("production").VITE_SUPABASE_ANON_KEY,
    ])
      expect(() => validateBundleText(value, "staging", config.VITE_SUPABASE_ANON_KEY)).toThrow(
        "BUNDLE_CREDENTIAL",
      );
  });
});

describe("restricted production Store prerequisite check", () => {
  const accepted = {
    ok: true,
    localPrerequisitesSatisfied: true,
    storeSubmission: "NOT_PERFORMED_BY_THIS_TOOL",
    googleAcceptance: "UNVERIFIED",
    storeInstallation: "UNVERIFIED",
    nativeBehavior: "UNVERIFIED",
  };
  it("leaves shipped prerequisite templates blocked", async () => {
    const value = storeFixture();
    for (const name of ["policy", "observed"])
      value[name] = JSON.parse(
        await readFile(
          new URL(`../../docs/release/store-${name}.example.json`, import.meta.url),
          "utf8",
        ),
      );
    expect(validateStoreDestination(value).localPrerequisitesSatisfied).toBe(false);
  });
  it("rejects an invalid clock and observations more than five minutes old", () => {
    const value = storeFixture();
    expect(validateStoreDestination({ ...value, now: Number.NaN })).toEqual({
      ok: false,
      localPrerequisitesSatisfied: false,
      code: "STORE_CLOCK",
    });
    value.observed.checkedAt = new Date(value.now - 300001).toISOString();
    expect(validateStoreDestination(value)).toEqual({
      ok: false,
      localPrerequisitesSatisfied: false,
      code: "STORE_EVIDENCE_AGE",
    });
  });
  it("accepts a complete synthetic candidate and exact observed private destination", () =>
    expect(validateStoreDestination(storeFixture())).toEqual(accepted));
  it("keeps immutable packaging records distinct from later supplied test evidence", () => {
    const value = storeFixture();
    expect(value.record.userManualResult).toBe("PENDING");
    expect(value.stagingRecord.localExtensionId).toBe(null);
    expect(value.record.publicKeyValidation).toBe("STRUCTURAL_ONLY");
    const before = JSON.stringify(value);
    expect(validateStoreDestination(value)).toEqual(accepted);
    expect(JSON.stringify(value)).toBe(before);
    delete value.policy.stagingManual;
    expect(validateStoreDestination(value).localPrerequisitesSatisfied).toBe(false);
  });
  for (const [name, mutate, code] of [
    [
      "missing staging package",
      (v) => {
        delete v.stagingRecord;
      },
      "STAGING_ARTIFACT_REQUIRED",
    ],
    [
      "unreviewed staging build inputs",
      (v) => {
        v.stagingRecord.source.buildInputDigest = "0".repeat(64);
      },
      "STAGING_ARTIFACT_REQUIRED",
    ],
    [
      "another staging source commit",
      (v) => {
        v.stagingRecord.source.sha = "0".repeat(40);
      },
      "STAGING_ARTIFACT_REQUIRED",
    ],
    [
      "different staging version",
      (v) => {
        v.stagingRecord.version = "0.9.0";
      },
      "STAGING_ARTIFACT_REQUIRED",
    ],
    [
      "unbound staging record",
      (v) => {
        v.stagingRecord.userManualResult = "PASS";
      },
      "STAGING_MANUAL_EVIDENCE",
    ],
    [
      "unreported local ID",
      (v) => {
        v.policy.stagingManual.localExtensionId = null;
      },
      "STAGING_MANUAL_EVIDENCE",
    ],
    [
      "production item used as local ID",
      (v) => {
        v.policy.stagingManual.localExtensionId = v.policy.itemId;
      },
      "STAGING_MANUAL_EVIDENCE",
    ],
    [
      "failed user report",
      (v) => {
        v.policy.stagingManual.status = "FAIL";
      },
      "STAGING_MANUAL_EVIDENCE",
    ],
    [
      "different report artifact",
      (v) => {
        v.policy.stagingManual.archiveSha256 = "0".repeat(64);
      },
      "STAGING_MANUAL_EVIDENCE",
    ],
    [
      "missing report digest",
      (v) => {
        v.policy.stagingManual.artifactDigest = null;
      },
      "STAGING_MANUAL_EVIDENCE",
    ],
    [
      "invented native verification label",
      (v) => {
        v.policy.stagingManual.evidenceType = "native-browser-verified";
      },
      "STAGING_MANUAL_EVIDENCE",
    ],
    [
      "missing actual key verification",
      (v) => {
        delete v.policy.productionVerification.checks.publicKeyProject;
      },
      "PRODUCTION_VERIFICATION",
    ],
    [
      "skipped production auth",
      (v) => {
        v.policy.productionVerification.checks.auth = "SKIP";
      },
      "PRODUCTION_VERIFICATION",
    ],
    [
      "blocked production API",
      (v) => {
        v.policy.productionVerification.checks.api = "BLOCKED";
      },
      "PRODUCTION_VERIFICATION",
    ],
    [
      "changed production key",
      (v) => {
        v.record.publicKeyDigest = "1".repeat(64);
      },
      "PRODUCTION_VERIFICATION",
    ],
    [
      "changed production configuration",
      (v) => {
        v.record.configurationDigest = "1".repeat(64);
      },
      "PRODUCTION_VERIFICATION",
    ],
    [
      "unknown proof field",
      (v) => {
        v.policy.productionVerification.skipAuth = true;
      },
      "PRODUCTION_VERIFICATION",
    ],
    [
      "staging report before build",
      (v) => {
        v.policy.stagingManual.reportedAt = new Date(v.now - 10001).toISOString();
      },
      "STORE_EVIDENCE_AGE",
    ],
    [
      "production verification before build",
      (v) => {
        v.policy.productionVerification.finishedAt = new Date(v.now - 10001).toISOString();
      },
      "STORE_EVIDENCE_AGE",
    ],
    [
      "future user report",
      (v) => {
        v.policy.stagingManual.reportedAt = new Date(v.now + 1).toISOString();
      },
      "STORE_EVIDENCE_AGE",
    ],
    [
      "future production verification",
      (v) => {
        v.policy.productionVerification.finishedAt = new Date(v.now + 1).toISOString();
      },
      "STORE_EVIDENCE_AGE",
    ],
  ])
    it(`rejects ${name}`, () => {
      const value = storeFixture();
      mutate(value);
      expect(validateStoreDestination(value)).toEqual({
        ok: false,
        localPrerequisitesSatisfied: false,
        code,
      });
    });
  for (const [name, mutate, code] of [
    [
      "staging upload",
      (v) => {
        v.record.target = "staging";
      },
      "PRODUCTION_ARTIFACT_REQUIRED",
    ],
    [
      "dirty source",
      (v) => {
        v.record.source.dirty = true;
      },
      "PRODUCTION_ARTIFACT_REQUIRED",
    ],
    [
      "missing item",
      (v) => {
        v.policy.itemId = null;
      },
      "STORE_DESTINATION",
    ],
    [
      "wrong item",
      (v) => {
        v.observed.itemId = "b".repeat(32);
      },
      "STORE_DESTINATION",
    ],
    [
      "wrong publisher",
      (v) => {
        v.observed.publisher = "other";
      },
      "STORE_DESTINATION",
    ],
    [
      "unlisted access",
      (v) => {
        v.policy.visibility = "unlisted";
      },
      "STORE_AUDIENCE",
    ],
    [
      "changed users",
      (v) => {
        v.observed.audience.users.push("other@example.invalid");
      },
      "STORE_AUDIENCE",
    ],
    [
      "missing permitted users",
      (v) => {
        v.policy.audience.users = [];
      },
      "STORE_AUDIENCE",
    ],
    [
      "unapproved domain publishing",
      (v) => {
        v.observed.audience.domainPublishing = true;
      },
      "STORE_AUDIENCE",
    ],
    [
      "changed archive",
      (v) => {
        v.policy.archiveSha256 = "0".repeat(64);
      },
      "STORE_ARTIFACT",
    ],
    [
      "unsupported web",
      (v) => {
        v.observed.servedWebSha = "0".repeat(40);
      },
      "STORE_COMPATIBILITY_SET",
    ],
    [
      "changed supported set",
      (v) => {
        v.observed.supportedWebVersions.pop();
      },
      "STORE_COMPATIBILITY_SET",
    ],
    [
      "failed compatibility",
      (v) => {
        v.policy.compatibility.status = "FAIL";
      },
      "STORE_COMPATIBILITY",
    ],
    [
      "wrong compatibility artifact",
      (v) => {
        v.policy.compatibility.subjectDigest = "0".repeat(64);
      },
      "STORE_COMPATIBILITY",
    ],
    [
      "stale evidence",
      (v) => {
        v.now += 86400001;
      },
      "STORE_EVIDENCE_AGE",
    ],
    [
      "future evidence",
      (v) => {
        v.now -= 2000;
      },
      "STORE_EVIDENCE_AGE",
    ],
    [
      "unchanged Store version",
      (v) => {
        v.observed.currentVersion = "0.1.1";
      },
      "STORE_VERSION",
    ],
    [
      "unknown Store state",
      (v) => {
        v.observed.itemState = "UNVERIFIED";
        v.observed.currentVersion = null;
      },
      "STORE_VERSION",
    ],
  ])
    it(`rejects ${name}`, () => {
      const value = storeFixture();
      mutate(value);
      expect(validateStoreDestination(value)).toEqual({
        ok: false,
        localPrerequisitesSatisfied: false,
        code,
      });
    });
  it("requires explicit verified unpublished state for a first Store version", () => {
    const value = storeFixture();
    value.observed.itemState = "unpublished";
    value.observed.currentVersion = null;
    expect(validateStoreDestination(value)).toEqual(accepted);
  });
});
