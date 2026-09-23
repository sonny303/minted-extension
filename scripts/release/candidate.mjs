/* global fetch, AbortController */
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import { URL } from "node:url";
import { canonicalDigest, validateCandidateOrigin } from "./contract.mjs";

export const STAGING_CANDIDATE_PROVIDER = Object.freeze({
  api: "https://api.vercel.com",
  projectId: "prj_1t7NkRJMkjTuFXEBEP4GjfN4B6Ch",
  teamId: "team_230fpJ9MgCj9ssW3LiIckfyA",
  repository: "sonny303/mintedpanel",
  ref: "staging",
  environment: "preview",
});

const MAX_BYTES = 4 * 1024 * 1024;
const REQUEST_MS = 30_000;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max = 512) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  ![...value].some((character) => character.charCodeAt(0) < 0x20);
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positiveDecimal = (value) =>
  typeof value === "string" && /^[1-9][0-9]*$/.test(value);
const deploymentId = (value) =>
  typeof value === "string" && /^dpl_[A-Za-z0-9_]{1,100}$/.test(value);
const date = (value) =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const fail = (code) => {
  throw new Error(code);
};

function exactKeys(value, keys) {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function optionsOnly(value, keys, code) {
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key)))
    fail(code);
}

export function validateCandidateInput(value) {
  if (!exactKeys(value, ["origin", "deploymentId", "panelSha"]))
    fail("CANDIDATE_INPUT");
  const origin = validateCandidateOrigin(value.origin);
  if (!deploymentId(value.deploymentId)) fail("CANDIDATE_DEPLOYMENT_ID");
  if (!sha(value.panelSha)) fail("CANDIDATE_PANEL_SHA");
  return Object.freeze({
    origin,
    deploymentId: value.deploymentId,
    panelSha: value.panelSha,
  });
}

function pathFor(path) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}teamId=${encodeURIComponent(STAGING_CANDIDATE_PROVIDER.teamId)}`;
}

async function httpsRead({ credential, path, signal }) {
  if (typeof credential !== "string" || credential.length === 0)
    fail("CANDIDATE_PROVIDER_CREDENTIAL_MISSING");
  let response;
  try {
    response = await fetch(`${STAGING_CANDIDATE_PROVIDER.api}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal,
    });
  } catch {
    fail("CANDIDATE_PROVIDER_READ_FAILED");
  }
  if (!response.ok) fail("CANDIDATE_PROVIDER_READ_REJECTED");
  if (
    !/^application\/json(?:;|$)/i.test(
      response.headers.get("content-type") ?? "",
    )
  )
    fail("CANDIDATE_PROVIDER_RESPONSE_INVALID");
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) fail("CANDIDATE_PROVIDER_RESPONSE_TOO_LARGE");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("CANDIDATE_PROVIDER_")
    )
      throw error;
    fail("CANDIDATE_PROVIDER_RESPONSE_INVALID");
  }
}

function normalizeProject(value) {
  if (!object(value) || value.id !== STAGING_CANDIDATE_PROVIDER.projectId)
    fail("CANDIDATE_PROJECT_MISMATCH");
  if (value.accountId !== STAGING_CANDIDATE_PROVIDER.teamId)
    fail("CANDIDATE_TEAM_MISMATCH");
  if (value.link != null) fail("CANDIDATE_PROJECT_GIT_LINKED");
  const settings = {};
  for (const key of [
    "framework",
    "nodeVersion",
    "buildCommand",
    "devCommand",
    "installCommand",
    "outputDirectory",
    "rootDirectory",
    "commandForIgnoringBuildStep",
    "sourceFilesOutsideRootDirectory",
    "autoExposeSystemEnvs",
    "serverlessFunctionRegion",
    "resourceConfig",
    "ssoProtection",
    "protectionBypass",
    "autoAssignCustomDomains",
  ])
    settings[key] = value[key] ?? null;
  return {
    id: STAGING_CANDIDATE_PROVIDER.projectId,
    teamId: STAGING_CANDIDATE_PROVIDER.teamId,
    nodeVersion: value.nodeVersion ?? null,
    observedProjectConfigurationDigest: canonicalDigest(settings),
  };
}

function normalizeEnvironment(value) {
  if (!object(value) || !Array.isArray(value.envs) || value.envs.length > 200)
    fail("CANDIDATE_ENVIRONMENT_INVALID");
  if (
    value.hiddenProductionEnvCount !== undefined &&
    value.hiddenProductionEnvCount !== 0
  )
    fail("CANDIDATE_ENVIRONMENT_HIDDEN");
  if (value.pagination && value.pagination.next != null)
    fail("CANDIDATE_ENVIRONMENT_PAGINATION");
  const entries = value.envs.map((entry) => {
    if (
      !object(entry) ||
      !text(entry.id) ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(entry.key) ||
      !["plain", "encrypted", "sensitive", "system", "secret"].includes(
        entry.type,
      )
    )
      fail("CANDIDATE_ENVIRONMENT_INVALID");
    const targets =
      typeof entry.target === "string" ? [entry.target] : entry.target;
    const customEnvironmentIds = entry.customEnvironmentIds ?? [];
    if (
      !Array.isArray(targets) ||
      !targets.every((target) =>
        ["production", "preview", "development"].includes(target),
      ) ||
      !Array.isArray(customEnvironmentIds) ||
      !customEnvironmentIds.every((entryId) => text(entryId))
    )
      fail("CANDIDATE_ENVIRONMENT_INVALID");
    if (
      !Number.isSafeInteger(entry.createdAt) ||
      !Number.isSafeInteger(entry.updatedAt) ||
      entry.updatedAt < entry.createdAt
    )
      fail("CANDIDATE_ENVIRONMENT_INVALID");
    return {
      id: entry.id,
      key: entry.key,
      type: entry.type,
      target: [...targets].sort(),
      gitBranch: entry.gitBranch ?? null,
      customEnvironmentIds: [...customEnvironmentIds].sort(),
      configurationId: entry.configurationId ?? null,
      visibility: entry.visibility ?? null,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
    fail("CANDIDATE_ENVIRONMENT_INVALID");
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeDeployment(value, input) {
  if (!object(value) || value.id !== input.deploymentId)
    fail("CANDIDATE_DEPLOYMENT_MISMATCH");
  if (value.projectId !== STAGING_CANDIDATE_PROVIDER.projectId)
    fail("CANDIDATE_PROJECT_MISMATCH");
  if (value.ownerId !== STAGING_CANDIDATE_PROVIDER.teamId)
    fail("CANDIDATE_TEAM_MISMATCH");
  if (
    (value.team && value.team.id !== STAGING_CANDIDATE_PROVIDER.teamId) ||
    (value.project && value.project.id !== STAGING_CANDIDATE_PROVIDER.projectId)
  )
    fail("CANDIDATE_DEPLOYMENT_MISMATCH");
  if (
    value.target != null ||
    value.readyState !== "READY" ||
    value.deletedAt != null ||
    value.softDeletedByRetention === true ||
    value.readySubstate === "ROLLING"
  )
    fail("CANDIDATE_NOT_READY");
  const providerPanelSha = value.meta?.githubCommitSha;
  const providerRef = value.meta?.githubCommitRef;
  const providerRepository = value.meta?.mintedRepository;
  if (
    providerPanelSha !== input.panelSha ||
    !sha(providerPanelSha) ||
    !["staging", "refs/heads/staging"].includes(providerRef) ||
    providerRepository !== STAGING_CANDIDATE_PROVIDER.repository ||
    value.gitSource != null ||
    !digest(value.meta?.mintedReleaseDigest) ||
    !sha(value.meta?.mintedSourceTreeSha) ||
    !positiveDecimal(value.meta?.mintedSourceFileCount) ||
    (value.meta?.mintedVercelEnvironment !== undefined &&
      value.meta.mintedVercelEnvironment !==
        STAGING_CANDIDATE_PROVIDER.environment)
  )
    fail("CANDIDATE_SOURCE_MISMATCH");
  const deploymentHost = text(value.url, 253) ? value.url : null;
  const aliases = Array.isArray(value.alias)
    ? value.alias.filter((alias) => text(alias, 253))
    : [];
  const providerHosts = new Set([deploymentHost, ...aliases].filter(Boolean));
  if (!providerHosts.has(new URL(input.origin).hostname))
    fail("CANDIDATE_ORIGIN_UNVERIFIED");
  const nodeVersion =
    value.nodeVersion ?? value.projectSettings?.nodeVersion ?? null;
  if (
    nodeVersion !== null &&
    (typeof nodeVersion !== "string" || !/^(?:20|22|24)\.x$/.test(nodeVersion))
  )
    fail("CANDIDATE_RUNTIME_INVALID");
  if (
    value.createdAt !== undefined &&
    (!Number.isSafeInteger(value.createdAt) ||
      !Number.isSafeInteger(value.ready) ||
      value.ready < value.createdAt)
  )
    fail("CANDIDATE_TIMESTAMPS_INVALID");
  return {
    origin: input.origin,
    deploymentId: input.deploymentId,
    panelSha: input.panelSha,
    projectId: STAGING_CANDIDATE_PROVIDER.projectId,
    teamId: STAGING_CANDIDATE_PROVIDER.teamId,
    provider: "vercel",
    verification: "authenticated-read",
    verifiedAt: new Date().toISOString(),
    url: `https://${new URL(input.origin).hostname}`,
    providerHosts: [...providerHosts].sort(),
    source: {
      repository: STAGING_CANDIDATE_PROVIDER.repository,
      ref: STAGING_CANDIDATE_PROVIDER.ref,
      sha: input.panelSha,
    },
    mintedReleaseDigest: value.meta.mintedReleaseDigest,
    mintedSourceTreeSha: value.meta.mintedSourceTreeSha,
    mintedSourceFileCount: value.meta.mintedSourceFileCount,
    deploymentConfigurationBinding: "UNVERIFIED",
    receiptBinding: "UNVERIFIED",
    releaseAdmission: "BLOCKED",
    runtime: { nodeVersion },
    _deployment: value,
  };
}

export function validateCandidateProvenance(value) {
  if (
    !exactKeys(value, [
      "origin",
      "deploymentId",
      "panelSha",
      "projectId",
      "teamId",
      "provider",
      "verification",
      "verifiedAt",
      "mintedReleaseDigest",
      "mintedSourceTreeSha",
      "mintedSourceFileCount",
      "observedProjectConfigurationDigest",
      "deploymentConfigurationBinding",
      "receiptBinding",
      "releaseAdmission",
      "candidateOnly",
    ])
  )
    fail("CANDIDATE_PROVENANCE");
  validateCandidateOrigin(value.origin);
  if (
    !deploymentId(value.deploymentId) ||
    !sha(value.panelSha) ||
    value.projectId !== STAGING_CANDIDATE_PROVIDER.projectId ||
    value.teamId !== STAGING_CANDIDATE_PROVIDER.teamId ||
    value.provider !== "vercel" ||
    value.verification !== "authenticated-read" ||
    value.candidateOnly !== true ||
    !date(value.verifiedAt) ||
    !digest(value.mintedReleaseDigest) ||
    !sha(value.mintedSourceTreeSha) ||
    !positiveDecimal(value.mintedSourceFileCount) ||
    !digest(value.observedProjectConfigurationDigest) ||
    value.deploymentConfigurationBinding !== "UNVERIFIED" ||
    value.receiptBinding !== "UNVERIFIED" ||
    value.releaseAdmission !== "BLOCKED"
  )
    fail("CANDIDATE_PROVENANCE");
  return value;
}

/**
 * Read-only authenticated Vercel verification for one staging deployment.
 * The default transport never accepts an arbitrary API URL and never logs the
 * bearer credential. Tests may inject a transport that returns provider JSON.
 */
export function createStagingCandidateVerifier(options = {}) {
  optionsOnly(
    options,
    ["credential", "transport"],
    "CANDIDATE_PROVIDER_OPTIONS",
  );
  if (
    options.transport !== undefined &&
    typeof options.transport !== "function"
  )
    fail("CANDIDATE_PROVIDER_TRANSPORT");
  if (options.transport && options.credential)
    fail("CANDIDATE_PROVIDER_OPTIONS");
  const transport =
    options.transport ??
    (({ path, signal }) =>
      httpsRead({ credential: options.credential, path, signal }));
  return Object.freeze({
    async verify(value) {
      const input = validateCandidateInput(value);
      const started = Date.now();
      const read = async (path) => {
        if (Date.now() - started > REQUEST_MS)
          fail("CANDIDATE_PROVIDER_TIMEOUT");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_MS);
        try {
          const response = await transport({ path, signal: controller.signal });
          if (!object(response)) fail("CANDIDATE_PROVIDER_RESPONSE_INVALID");
          if (Buffer.byteLength(JSON.stringify(response)) > MAX_BYTES)
            fail("CANDIDATE_PROVIDER_RESPONSE_TOO_LARGE");
          return response;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("CANDIDATE_"))
            throw error;
          fail("CANDIDATE_PROVIDER_READ_FAILED");
        } finally {
          clearTimeout(timer);
        }
      };
      const deployment = normalizeDeployment(
        await read(
          pathFor(
            `/v13/deployments/${encodeURIComponent(input.deploymentId)}?withGitRepoInfo=true`,
          ),
        ),
        input,
      );
      const project = normalizeProject(
        await read(
          pathFor(`/v9/projects/${STAGING_CANDIDATE_PROVIDER.projectId}`),
        ),
      );
      const environment = normalizeEnvironment(
        await read(
          pathFor(
            `/v10/projects/${STAGING_CANDIDATE_PROVIDER.projectId}/env?decrypt=false`,
          ),
        ),
      );
      const observedProjectConfigurationDigest = canonicalDigest({
        target: STAGING_CANDIDATE_PROVIDER,
        project,
        environment,
      });
      return validateCandidateProvenance({
        origin: input.origin,
        deploymentId: input.deploymentId,
        panelSha: input.panelSha,
        projectId: STAGING_CANDIDATE_PROVIDER.projectId,
        teamId: STAGING_CANDIDATE_PROVIDER.teamId,
        provider: "vercel",
        verification: "authenticated-read",
        verifiedAt: deployment.verifiedAt,
        mintedReleaseDigest: deployment.mintedReleaseDigest,
        mintedSourceTreeSha: deployment.mintedSourceTreeSha,
        mintedSourceFileCount: deployment.mintedSourceFileCount,
        observedProjectConfigurationDigest,
        deploymentConfigurationBinding: "UNVERIFIED",
        receiptBinding: "UNVERIFIED",
        releaseAdmission: "BLOCKED",
        candidateOnly: true,
      });
    },
  });
}
