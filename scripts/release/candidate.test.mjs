import { describe, expect, it } from "vitest";
import { URL } from "node:url";
import {
  createStagingCandidateVerifier,
  STAGING_CANDIDATE_PROVIDER,
  validateCandidateInput,
} from "./candidate.mjs";

const PANEL_SHA = "1".repeat(40);
const DEPLOYMENT_ID = "dpl_candidateSynthetic";
const ORIGIN = "https://mintedpanel-staging-candidate.vercel.app";
const now = Date.now();

function deployment(overrides = {}) {
  return {
    id: DEPLOYMENT_ID,
    projectId: STAGING_CANDIDATE_PROVIDER.projectId,
    ownerId: STAGING_CANDIDATE_PROVIDER.teamId,
    team: { id: STAGING_CANDIDATE_PROVIDER.teamId },
    project: { id: STAGING_CANDIDATE_PROVIDER.projectId },
    target: null,
    readyState: "READY",
    deletedAt: null,
    readySubstate: null,
    url: new URL(ORIGIN).hostname,
    alias: [],
    createdAt: now - 1000,
    ready: now,
    nodeVersion: "22.x",
    meta: {
      githubCommitSha: PANEL_SHA,
      githubCommitRef: "staging",
      mintedRepository: STAGING_CANDIDATE_PROVIDER.repository,
      mintedVercelEnvironment: "preview",
      mintedReleaseDigest: "2".repeat(64),
      mintedSourceTreeSha: "3".repeat(40),
      mintedSourceFileCount: "42",
    },
    ...overrides,
  };
}

function project(overrides = {}) {
  return {
    id: STAGING_CANDIDATE_PROVIDER.projectId,
    accountId: STAGING_CANDIDATE_PROVIDER.teamId,
    link: null,
    nodeVersion: "22.x",
    ...overrides,
  };
}

function environment() {
  return {
    envs: [
      {
        id: "env_synthetic",
        key: "SUPABASE_URL",
        type: "plain",
        target: ["preview"],
        customEnvironmentIds: [],
        configurationId: null,
        visibility: "config",
        createdAt: now - 1000,
        updatedAt: now,
        value: "redacted",
      },
    ],
    hiddenProductionEnvCount: 0,
    pagination: { next: null },
  };
}

function verifier(overrides = {}) {
  const responses = {
    deployment: deployment(),
    project: project(),
    environment: environment(),
  };
  Object.assign(responses, overrides);
  return createStagingCandidateVerifier({
    transport: async ({ path }) => {
      if (path.startsWith("/v13/deployments/")) return responses.deployment;
      if (path.startsWith("/v9/projects/")) return responses.project;
      if (path.startsWith("/v10/projects/")) return responses.environment;
      throw new Error("unexpected path");
    },
  });
}

describe("staging candidate provider verification", () => {
  it("accepts one exact provider-owned origin and binds panel/project/team/config identity", async () => {
    const candidate = await verifier().verify({
      origin: ORIGIN,
      deploymentId: DEPLOYMENT_ID,
      panelSha: PANEL_SHA,
    });
    expect(candidate.origin).toBe(ORIGIN);
    expect(candidate.deploymentId).toBe(DEPLOYMENT_ID);
    expect(candidate.panelSha).toBe(PANEL_SHA);
    expect(candidate.projectId).toBe(STAGING_CANDIDATE_PROVIDER.projectId);
    expect(candidate.teamId).toBe(STAGING_CANDIDATE_PROVIDER.teamId);
    expect(candidate.observedProjectConfigurationDigest).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(candidate.mintedReleaseDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate.mintedSourceTreeSha).toMatch(/^[a-f0-9]{40}$/);
    expect(candidate.mintedSourceFileCount).toBe("42");
    expect(candidate.deploymentConfigurationBinding).toBe("UNVERIFIED");
    expect(candidate.receiptBinding).toBe("UNVERIFIED");
    expect(candidate.releaseAdmission).toBe("BLOCKED");
    expect(candidate.verification).toBe("authenticated-read");
  });

  it.each([
    [
      "https://mintedpanel-staging-candidate.vercel.app/path",
      "CANDIDATE_ORIGIN",
    ],
    [
      "https://mintedpanel-staging-candidate.vercel.app?x=1",
      "CANDIDATE_ORIGIN",
    ],
    [
      "https://user:pass@mintedpanel-staging-candidate.vercel.app",
      "CANDIDATE_ORIGIN",
    ],
    ["http://mintedpanel-staging-candidate.vercel.app", "CANDIDATE_ORIGIN"],
    ["https://staging.mintedpanel.com", "CANDIDATE_ORIGIN"],
    ["https://mintedpanel.vercel.app", "CANDIDATE_ORIGIN"],
  ])("rejects unsafe or stable origin %s", (origin, code) => {
    expect(() =>
      validateCandidateInput({
        origin,
        deploymentId: DEPLOYMENT_ID,
        panelSha: PANEL_SHA,
      }),
    ).toThrow(code);
  });

  it("rejects a host that the provider did not attach to the deployment", async () => {
    await expect(
      verifier().verify({
        origin: "https://arbitrary.example.invalid",
        deploymentId: DEPLOYMENT_ID,
        panelSha: PANEL_SHA,
      }),
    ).rejects.toThrow("CANDIDATE_ORIGIN_UNVERIFIED");
  });

  it("rejects a different provider project", async () => {
    await expect(
      verifier({ project: project({ id: "prj_wrong" }) }).verify({
        origin: ORIGIN,
        deploymentId: DEPLOYMENT_ID,
        panelSha: PANEL_SHA,
      }),
    ).rejects.toThrow("CANDIDATE_PROJECT_MISMATCH");
  });

  it("rejects a stale or mismatched panel source SHA", async () => {
    await expect(
      verifier().verify({
        origin: ORIGIN,
        deploymentId: DEPLOYMENT_ID,
        panelSha: "2".repeat(40),
      }),
    ).rejects.toThrow("CANDIDATE_SOURCE_MISMATCH");
  });

  it("rejects a deployment that is not a ready preview candidate", async () => {
    await expect(
      verifier({ deployment: deployment({ target: "production" }) }).verify({
        origin: ORIGIN,
        deploymentId: DEPLOYMENT_ID,
        panelSha: PANEL_SHA,
      }),
    ).rejects.toThrow("CANDIDATE_NOT_READY");
  });

  it.each([
    [
      "a non-null git source",
      { gitSource: { type: "github", ref: "staging" } },
    ],
    ["a malformed release digest", { meta: { mintedReleaseDigest: "short" } }],
    ["a malformed source tree SHA", { meta: { mintedSourceTreeSha: "short" } }],
    ["a zero source file count", { meta: { mintedSourceFileCount: "0" } }],
    [
      "a non-decimal source file count",
      { meta: { mintedSourceFileCount: "4.2" } },
    ],
  ])("rejects %s", async (_description, overrides) => {
    const baseMeta = deployment().meta;
    await expect(
      verifier({
        deployment: deployment({
          ...overrides,
          meta: { ...baseMeta, ...overrides.meta },
        }),
      }).verify({
        origin: ORIGIN,
        deploymentId: DEPLOYMENT_ID,
        panelSha: PANEL_SHA,
      }),
    ).rejects.toThrow("CANDIDATE_SOURCE_MISMATCH");
  });
});
