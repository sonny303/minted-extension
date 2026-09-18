import { Buffer } from "node:buffer";
import { canonicalDigest, TARGETS } from "./contract.mjs";

// Invalid signature deliberately: these keys exercise packaging, never live Auth.
export function publicConfig(target = "staging") {
  const ref = target === "staging" ? "vmznysvietfaddakkegt" : "fkvuhfsqcmujywzgczmc";
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iss: "supabase", ref, role: "anon", exp: 4102444800 }),
  ).toString("base64url");
  return {
    VITE_API_BASE_URL:
      target === "staging" ? "https://staging.mintedpanel.com" : "https://mintedpanel.vercel.app",
    VITE_SUPABASE_URL: `https://${ref}.supabase.co`,
    VITE_SUPABASE_ANON_KEY: `${header}.${payload}.syntheticSignatureNotForAuthentication`,
  };
}

export function storeFixture() {
  const archiveSha256 = "a".repeat(64);
  const supportedWebVersions = ["b".repeat(40), "c".repeat(40)];
  const apiContractDigest = "d".repeat(64);
  const now = Date.now();
  const checkedAt = new Date(now - 1000).toISOString();
  const packageRecord = (target) => ({
    schemaVersion: 1,
    repository: "sonny303/minted-extension",
    target,
    distribution: target === "staging" ? "local-unpacked" : "restricted-store-candidate",
    source: {
      sha: "1".repeat(40),
      tree: "2".repeat(40),
      dirty: false,
      buildInputDigest: "3".repeat(64),
    },
    archiveSha256: target === "staging" ? "4".repeat(64) : archiveSha256,
    bundleDigest: target === "staging" ? "5".repeat(64) : "6".repeat(64),
    version: "0.1.1",
    builtAt: new Date(now - 10000).toISOString(),
    configurationDigest: target === "staging" ? "7".repeat(64) : "8".repeat(64),
    publicKeyDigest: target === "staging" ? "9".repeat(64) : "0".repeat(64),
    apiOrigin: TARGETS[target].api,
    webOrigins: TARGETS[target].origins,
    supabaseRef: TARGETS[target].ref,
    localExtensionId: null,
    userManualResult: "PENDING",
    publicKeyValidation: "STRUCTURAL_ONLY",
  });
  const record = packageRecord("production");
  const stagingRecord = packageRecord("staging");
  const policy = {
    itemId: "a".repeat(32),
    publisher: "synthetic-publisher",
    visibility: "private",
    audience: { users: ["synthetic-tester@example.invalid"], groups: [], domainPublishing: false },
    archiveSha256,
    supportedWebVersions,
    apiContractDigest,
    compatibility: {
      status: "PASS",
      subjectDigest: canonicalDigest({ archiveSha256, supportedWebVersions, apiContractDigest }),
      artifactDigest: "f".repeat(64),
      finishedAt: checkedAt,
    },
    stagingManual: {
      evidenceType: "user-reported",
      recordDigest: canonicalDigest(stagingRecord),
      bundleDigest: stagingRecord.bundleDigest,
      archiveSha256: stagingRecord.archiveSha256,
      sourceSha: stagingRecord.source.sha,
      buildInputDigest: stagingRecord.source.buildInputDigest,
      localExtensionId: "b".repeat(32),
      status: "PASS",
      reportedAt: checkedAt,
      artifactDigest: "f".repeat(64),
    },
    productionVerification: {
      status: "PASS",
      subjectDigest: canonicalDigest({
        archiveSha256,
        configurationDigest: record.configurationDigest,
        publicKeyDigest: record.publicKeyDigest,
        supabaseRef: record.supabaseRef,
        apiOrigin: record.apiOrigin,
      }),
      artifactDigest: "e".repeat(64),
      finishedAt: checkedAt,
      checks: { publicKeyProject: "PASS", auth: "PASS", api: "PASS" },
    },
  };
  const observed = {
    itemId: policy.itemId,
    publisher: policy.publisher,
    visibility: "private",
    audience: policy.audience,
    itemState: "published",
    currentVersion: "0.1.0",
    servedWebSha: supportedWebVersions[0],
    supportedWebVersions,
    apiContractDigest,
    checkedAt,
  };
  return JSON.parse(
    JSON.stringify({
      record,
      stagingRecord,
      policy,
      observed,
      now,
    }),
  );
}
