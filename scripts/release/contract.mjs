import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export const TARGETS = Object.freeze({
  staging: Object.freeze({
    api: "https://staging.mintedpanel.com",
    origins: Object.freeze([
      "https://staging.mintedpanel.com",
      "https://mintedpanel-staging.vercel.app",
    ]),
    ref: "vmznysvietfaddakkegt",
    name: "Minted Panel Workbench — STAGING (Local)",
  }),
  production: Object.freeze({
    api: "https://mintedpanel.vercel.app",
    origins: Object.freeze(["https://mintedpanel.vercel.app", "https://www.mintedpanel.com"]),
    ref: "fkvuhfsqcmujywzgczmc",
    name: "Minted Panel Workbench",
  }),
});
export const PUBLIC_FIELDS = ["VITE_API_BASE_URL", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];
const fail = (code) => {
  throw new Error(code);
};
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const canonicalDigest = (value) => sha256(JSON.stringify(sort(value)));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sort(value[key])]),
    );
  return value;
}
const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const gitSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const itemId = (value) => typeof value === "string" && /^[a-p]{32}$/.test(value);
const date = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const versionParts = (value) =>
  typeof value === "string" &&
  /^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){0,3}$/.test(value) &&
  value
    .split(".")
    .map(Number)
    .every((part) => part <= 65535) &&
  value
    .split(".")
    .map(Number)
    .some((part) => part > 0)
    ? value.split(".").map(Number)
    : null;

export function targetFor(target) {
  if (target !== "staging" && target !== "production") fail("TARGET_REQUIRED");
  return TARGETS[target];
}

/** Public key classification is structural, not authentication/project verification. */
export function validatePublicConfiguration(target, config, now = Date.now()) {
  const expected = targetFor(target);
  if (!Number.isSafeInteger(now) || now < 0) fail("INVALID_CLOCK");
  if (
    !exactKeys(config, PUBLIC_FIELDS) ||
    !PUBLIC_FIELDS.every((key) => typeof config[key] === "string" && config[key].length > 0)
  )
    fail("PUBLIC_CONFIGURATION");
  if (
    config.VITE_API_BASE_URL !== expected.api ||
    config.VITE_SUPABASE_URL !== `https://${expected.ref}.supabase.co`
  )
    fail("CONFIGURATION_TARGET");
  const key = config.VITE_SUPABASE_ANON_KEY;
  if (/^sb_publishable_[A-Za-z0-9_-]{20,200}$/.test(key)) return { ...config };
  if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key) || key.length > 4096)
    fail("PUBLIC_ANON_KEY");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
  } catch {
    fail("PUBLIC_ANON_KEY");
  }
  if (
    payload?.role !== "anon" ||
    payload?.ref !== expected.ref ||
    payload?.iss !== "supabase" ||
    !Number.isSafeInteger(payload?.exp) ||
    payload.exp * 1000 <= now
  )
    fail("PUBLIC_ANON_KEY");
  return { ...config };
}

export function releaseManifest(base, target, version) {
  const expected = targetFor(target);
  if (base.version !== version || !versionParts(version)) fail("PACKAGE_VERSION");
  const manifest = JSON.parse(JSON.stringify(base));
  manifest.name = expected.name;
  manifest.action.default_title = expected.name;
  manifest.host_permissions = [
    ...expected.origins.map((origin) => `${origin}/*`),
    `https://${expected.ref}.supabase.co/*`,
  ];
  manifest.externally_connectable = { matches: expected.origins.map((origin) => `${origin}/*`) };
  if (target === "staging") manifest.version_name = `${version} staging local`;
  validateManifest(manifest, target, version);
  return manifest;
}

export function validateManifest(manifest, target, version) {
  const expected = targetFor(target);
  const keys = [
    "manifest_version",
    "name",
    "version",
    "description",
    "action",
    "side_panel",
    "background",
    "permissions",
    "externally_connectable",
    "host_permissions",
    "optional_host_permissions",
    "icons",
    ...(target === "staging" ? ["version_name"] : []),
  ];
  if (
    !exactKeys(manifest, keys) ||
    manifest.manifest_version !== 3 ||
    manifest.version !== version ||
    manifest.name !== expected.name ||
    manifest.action?.default_title !== expected.name
  )
    fail("MANIFEST_IDENTITY");
  if (
    !same(manifest.host_permissions, [
      ...expected.origins.map((origin) => `${origin}/*`),
      `https://${expected.ref}.supabase.co/*`,
    ]) ||
    !same(manifest.externally_connectable, {
      matches: expected.origins.map((origin) => `${origin}/*`),
    })
  )
    fail("MANIFEST_TARGET");
  if (
    !same(manifest.permissions, ["storage", "activeTab", "sidePanel", "scripting"]) ||
    !same(manifest.optional_host_permissions, ["https://*/*"]) ||
    !same(manifest.background, { service_worker: "background.js", type: "module" }) ||
    !same(manifest.side_panel, { default_path: "sidepanel.html" })
  )
    fail("MANIFEST_PERMISSIONS");
  if (target === "staging" && manifest.version_name !== `${version} staging local`)
    fail("MANIFEST_IDENTITY");
}

/** Reject known credentials and wrong-target embedded endpoints/public JWTs. */
export function validateBundleText(text, target, publicKey) {
  const expected = targetFor(target);
  const other = TARGETS[target === "staging" ? "production" : "staging"];
  if (other.origins.some((origin) => text.includes(origin)) || text.includes(other.ref))
    fail("BUNDLE_WRONG_TARGET");
  for (const match of text.matchAll(/https:\/\/([a-z0-9]{20})\.supabase\.co/g))
    if (match[1] !== expected.ref) fail("BUNDLE_WRONG_TARGET");
  if (
    /(?:sb_secret_|sbp_(?:oauth_)?[a-f0-9]{20}|gh[pousr]_[A-Za-z0-9]{20}|SUPABASE_SERVICE_ROLE_KEY|VERCEL_AUTOMATION_BYPASS_SECRET|x-vercel-protection-bypass|CWS_CLIENT_SECRET|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/.test(
      text,
    )
  )
    fail("BUNDLE_CREDENTIAL");
  for (const match of text.matchAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g))
    if (match[0] !== publicKey) fail("BUNDLE_CREDENTIAL");
  for (const match of text.matchAll(/sb_publishable_[A-Za-z0-9_-]{20,200}/g))
    if (match[0] !== publicKey) fail("BUNDLE_CREDENTIAL");
}

/** Pure prerequisite check, never an upload or authentication of dashboard data. */
export function validateStoreDestination({
  record,
  stagingRecord,
  policy,
  observed,
  now = Date.now(),
}) {
  const reject = (code) => ({ ok: false, localPrerequisitesSatisfied: false, code });
  const accepted = {
    ok: true,
    localPrerequisitesSatisfied: true,
    storeSubmission: "NOT_PERFORMED_BY_THIS_TOOL",
    googleAcceptance: "UNVERIFIED",
    storeInstallation: "UNVERIFIED",
    nativeBehavior: "UNVERIFIED",
  };
  const sourceValid = (source) =>
    source?.dirty === false &&
    gitSha(source.sha) &&
    gitSha(source.tree) &&
    digest(source.buildInputDigest);
  const packageValid = (value, target, distribution) =>
    value?.schemaVersion === 1 &&
    value.repository === "sonny303/minted-extension" &&
    value.target === target &&
    value.distribution === distribution &&
    sourceValid(value.source) &&
    digest(value.bundleDigest) &&
    digest(value.archiveSha256) &&
    digest(value.configurationDigest) &&
    digest(value.publicKeyDigest) &&
    value.apiOrigin === TARGETS[target].api &&
    value.supabaseRef === TARGETS[target].ref &&
    same(value.webOrigins, TARGETS[target].origins) &&
    date(value.builtAt) &&
    Date.parse(value.builtAt) <= now;
  if (!Number.isSafeInteger(now) || now < 0) return reject("STORE_CLOCK");
  if (!packageValid(record, "production", "restricted-store-candidate"))
    return reject("PRODUCTION_ARTIFACT_REQUIRED");
  if (
    !packageValid(stagingRecord, "staging", "local-unpacked") ||
    canonicalDigest(stagingRecord.source) !== canonicalDigest(record.source) ||
    stagingRecord.version !== record.version
  )
    return reject("STAGING_ARTIFACT_REQUIRED");
  const policyKeys = [
    "itemId",
    "publisher",
    "visibility",
    "audience",
    "archiveSha256",
    "supportedWebVersions",
    "apiContractDigest",
    "compatibility",
    "stagingManual",
    "productionVerification",
  ];
  const observedKeys = [
    "itemId",
    "publisher",
    "visibility",
    "audience",
    "itemState",
    "currentVersion",
    "servedWebSha",
    "supportedWebVersions",
    "apiContractDigest",
    "checkedAt",
  ];
  if (!exactKeys(policy, policyKeys) || !exactKeys(observed, observedKeys))
    return reject("STORE_PREREQUISITES");
  if (
    !itemId(policy.itemId) ||
    !itemId(observed.itemId) ||
    policy.itemId !== observed.itemId ||
    typeof policy.publisher !== "string" ||
    !policy.publisher.trim() ||
    policy.publisher.length > 200 ||
    policy.publisher !== observed.publisher
  )
    return reject("STORE_DESTINATION");
  const audience = policy.audience;
  const addresses = (values) =>
    Array.isArray(values) &&
    values.length <= 100 &&
    values.every(
      (member) =>
        typeof member === "string" &&
        /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(member),
    ) &&
    new Set(values).size === values.length;
  if (
    policy.visibility !== "private" ||
    observed.visibility !== "private" ||
    !exactKeys(audience, ["users", "groups", "domainPublishing"]) ||
    audience.domainPublishing !== false ||
    !addresses(audience.users) ||
    !addresses(audience.groups) ||
    audience.users.length + audience.groups.length === 0 ||
    canonicalDigest(audience) !== canonicalDigest(observed.audience)
  )
    return reject("STORE_AUDIENCE");
  if (record.archiveSha256 !== policy.archiveSha256) return reject("STORE_ARTIFACT");
  const manual = policy.stagingManual;
  if (
    !exactKeys(manual, [
      "evidenceType",
      "recordDigest",
      "bundleDigest",
      "archiveSha256",
      "sourceSha",
      "buildInputDigest",
      "localExtensionId",
      "status",
      "reportedAt",
      "artifactDigest",
    ]) ||
    manual.evidenceType !== "user-reported" ||
    manual.status !== "PASS" ||
    manual.recordDigest !== canonicalDigest(stagingRecord) ||
    manual.bundleDigest !== stagingRecord.bundleDigest ||
    manual.archiveSha256 !== stagingRecord.archiveSha256 ||
    manual.sourceSha !== record.source.sha ||
    manual.buildInputDigest !== record.source.buildInputDigest ||
    !itemId(manual.localExtensionId) ||
    manual.localExtensionId === policy.itemId ||
    !digest(manual.artifactDigest)
  )
    return reject("STAGING_MANUAL_EVIDENCE");
  const production = policy.productionVerification;
  if (
    !exactKeys(production, ["status", "subjectDigest", "artifactDigest", "finishedAt", "checks"]) ||
    production.status !== "PASS" ||
    !exactKeys(production.checks, ["publicKeyProject", "auth", "api"]) ||
    !Object.values(production.checks).every((status) => status === "PASS") ||
    !digest(production.artifactDigest) ||
    production.subjectDigest !==
      canonicalDigest({
        archiveSha256: record.archiveSha256,
        configurationDigest: record.configurationDigest,
        publicKeyDigest: record.publicKeyDigest,
        supabaseRef: record.supabaseRef,
        apiOrigin: record.apiOrigin,
      })
  )
    return reject("PRODUCTION_VERIFICATION");
  if (
    !Array.isArray(policy.supportedWebVersions) ||
    !policy.supportedWebVersions.length ||
    policy.supportedWebVersions.length > 100 ||
    !policy.supportedWebVersions.every(gitSha) ||
    new Set(policy.supportedWebVersions).size !== policy.supportedWebVersions.length ||
    !same(policy.supportedWebVersions, observed.supportedWebVersions) ||
    !policy.supportedWebVersions.includes(observed.servedWebSha) ||
    !digest(policy.apiContractDigest) ||
    policy.apiContractDigest !== observed.apiContractDigest
  )
    return reject("STORE_COMPATIBILITY_SET");
  const proof = policy.compatibility;
  if (
    !exactKeys(proof, ["status", "subjectDigest", "artifactDigest", "finishedAt"]) ||
    proof.status !== "PASS" ||
    !digest(proof.artifactDigest) ||
    proof.subjectDigest !==
      canonicalDigest({
        archiveSha256: record.archiveSha256,
        supportedWebVersions: policy.supportedWebVersions,
        apiContractDigest: policy.apiContractDigest,
      })
  )
    return reject("STORE_COMPATIBILITY");
  for (const [value, maxAge, earliest] of [
    [
      observed.checkedAt,
      300000,
      Math.max(Date.parse(record.builtAt), Date.parse(stagingRecord.builtAt)),
    ],
    [proof.finishedAt, 86400000, Date.parse(record.builtAt)],
    [manual.reportedAt, 86400000, Date.parse(stagingRecord.builtAt)],
    [production.finishedAt, 86400000, Date.parse(record.builtAt)],
  ])
    if (
      !date(value) ||
      now - Date.parse(value) < 0 ||
      now - Date.parse(value) > maxAge ||
      Date.parse(value) < earliest
    )
      return reject("STORE_EVIDENCE_AGE");
  const candidate = versionParts(record.version);
  const current = versionParts(observed.currentVersion);
  if (
    !candidate ||
    !["unpublished", "published"].includes(observed.itemState) ||
    (observed.itemState === "published" && !current) ||
    (observed.itemState === "unpublished" && observed.currentVersion !== null)
  )
    return reject("STORE_VERSION");
  if (observed.itemState === "unpublished") return accepted;
  let newer = false;
  for (let i = 0; i < 4; i++) {
    if ((candidate[i] ?? 0) !== (current[i] ?? 0)) {
      newer = (candidate[i] ?? 0) > (current[i] ?? 0);
      break;
    }
  }
  return newer ? accepted : reject("STORE_VERSION");
}
