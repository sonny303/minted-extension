import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildExtension, inspectBundle, verifyPackage } from "./build.mjs";
import { publicConfig } from "./fixtures.mjs";
import { canonicalDigest, sha256, targetFor } from "./contract.mjs";
import {
  createStagingCandidateVerifier,
  STAGING_CANDIDATE_PROVIDER,
} from "./candidate.mjs";

describe("complete extension builds with synthetic public keys", () => {
  it("runs both passes per target with separate output and exact provenance", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "minted-extension-package-"),
    );
    vi.stubEnv("VITE_API_BASE_URL", "https://mintedpanel.vercel.app");
    vi.stubEnv("VITE_G5_SYNTHETIC_SECRET", "sb_secret_synthetic-sentinel");
    try {
      for (const [target, keyFormat] of [
        ["staging", "legacy"],
        ["production", "legacy"],
        ["staging", "publishable"],
      ]) {
        const config = publicConfig(target);
        if (keyFormat === "publishable")
          config.VITE_SUPABASE_ANON_KEY =
            "sb_publishable_syntheticPublicFixtureNotForAuthentication";
        const result = await buildExtension({
          target,
          configuration: config,
          allowDirty: true,
          outputRoot,
        });
        expect(result.ok).toBe(true);
        expect(result.localPrerequisitesSatisfied).toBe(false);
        const directory = join(outputRoot, target);
        const record = JSON.parse(
          await readFile(join(directory, "provenance.json"), "utf8"),
        );
        expect(record.source.sha).toMatch(/^[a-f0-9]{40}$/);
        expect(record.configurationDigest).toBe(canonicalDigest(config));
        expect(record.files.map((file) => file.path)).toContain("content.js");
        expect(record.archiveSha256).toBe(
          sha256(await readFile(join(directory, "extension.zip"))),
        );
        const entries = execFileSync(
          "unzip",
          ["-Z1", join(directory, "extension.zip")],
          {
            encoding: "utf8",
          },
        )
          .trim()
          .split("\n")
          .sort();
        expect(entries).toEqual(record.files.map((file) => file.path).sort());
        expect(record.localExtensionId).toBe(null);
        expect(record.userManualResult).toBe("PENDING");
        await expect(
          verifyPackage(directory, record, target),
        ).resolves.toBeUndefined();
        await expect(
          verifyPackage(
            directory,
            record,
            target === "staging" ? "production" : "staging",
          ),
        ).rejects.toThrow("ARTIFACT_MISMATCH");
      }
      const staging = join(outputRoot, "staging", "extension");
      const manifest = JSON.parse(
        await readFile(join(staging, "manifest.json"), "utf8"),
      );
      expect(manifest.name).toContain("STAGING");
      await writeFile(join(staging, "secret.env"), "private-sentinel");
      await expect(
        inspectBundle(staging, "staging", publicConfig(), "0.1.0"),
      ).rejects.toThrow("PACKAGE_FILE_SET");
      const production = join(outputRoot, "production");
      const productionRecord = JSON.parse(
        await readFile(join(production, "provenance.json"), "utf8"),
      );
      await writeFile(join(production, "extension.zip"), "tampered");
      await expect(
        verifyPackage(production, productionRecord, "production"),
      ).rejects.toThrow("ARTIFACT_MISMATCH");
    } finally {
      vi.unstubAllEnvs();
      await rm(outputRoot, { recursive: true, force: true });
    }
  }, 60000);

  it("rejects missing configuration before creating build output", async () => {
    await expect(
      buildExtension({ target: "staging", configuration: {} }),
    ).rejects.toThrow("PUBLIC_CONFIGURATION");
  });

  it("CLI rejects missing targets/configuration and does not echo input secrets", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "minted-extension-cli-"));
    try {
      const config = join(temporary, "public.local");
      await writeFile(
        config,
        JSON.stringify({ SUPABASE_SERVICE_ROLE_KEY: "private-sentinel" }),
      );
      const cli = fileURLToPath(new URL("./build.mjs", import.meta.url));
      for (const args of [
        [],
        ["--target", "preview", "--config", config],
        ["--target", "staging", "--config", config],
        ["--target", "staging", "--target", "production"],
      ]) {
        const result = spawnSync(process.execPath, [cli, ...args], {
          encoding: "utf8",
          timeout: 5000,
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toContain("private-sentinel");
        expect(JSON.parse(result.stdout).ok).toBe(false);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("builds a candidate package with authenticated provider provenance", async () => {
    const outputRoot = await mkdtemp(
      join(tmpdir(), "minted-extension-candidate-package-"),
    );
    const origin = "https://mintedpanel-staging-candidate.vercel.app";
    const deploymentId = "dpl_candidateBuildSynthetic";
    const panelSha = "1".repeat(40);
    const now = Date.now();
    const verifier = createStagingCandidateVerifier({
      transport: async ({ path }) => {
        if (path.startsWith("/v13/deployments/"))
          return {
            id: deploymentId,
            projectId: STAGING_CANDIDATE_PROVIDER.projectId,
            ownerId: STAGING_CANDIDATE_PROVIDER.teamId,
            target: null,
            readyState: "READY",
            deletedAt: null,
            url: new URL(origin).hostname,
            alias: [],
            createdAt: now - 1000,
            ready: now,
            meta: {
              githubCommitSha: panelSha,
              githubCommitRef: "staging",
              mintedRepository: STAGING_CANDIDATE_PROVIDER.repository,
              mintedVercelEnvironment: "preview",
              mintedReleaseDigest: "2".repeat(64),
              mintedSourceTreeSha: "3".repeat(40),
              mintedSourceFileCount: "42",
            },
          };
        if (path.startsWith("/v9/projects/"))
          return {
            id: STAGING_CANDIDATE_PROVIDER.projectId,
            accountId: STAGING_CANDIDATE_PROVIDER.teamId,
            link: null,
            nodeVersion: "22.x",
          };
        if (path.startsWith("/v10/projects/"))
          return {
            envs: [],
            hiddenProductionEnvCount: 0,
            pagination: { next: null },
          };
        throw new Error("unexpected provider path");
      },
    });
    try {
      const result = await buildExtension({
        target: "staging",
        configuration: publicConfig(),
        candidate: { origin, deploymentId, panelSha },
        candidateVerifier: verifier,
        allowDirty: true,
        outputRoot,
      });
      const directory = join(outputRoot, "staging");
      const record = JSON.parse(
        await readFile(join(directory, "provenance.json"), "utf8"),
      );
      const manifest = JSON.parse(
        await readFile(join(directory, "extension", "manifest.json"), "utf8"),
      );
      expect(result.ok).toBe(true);
      expect(record.apiOrigin).toBe(origin);
      expect(record.webOrigins).toEqual([
        ...targetFor("staging").origins,
        origin,
      ]);
      expect(record.candidate).toMatchObject({
        origin,
        deploymentId,
        panelSha,
        projectId: STAGING_CANDIDATE_PROVIDER.projectId,
        teamId: STAGING_CANDIDATE_PROVIDER.teamId,
        provider: "vercel",
        verification: "authenticated-read",
      });
      expect(record.candidate.observedProjectConfigurationDigest).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(record.candidate.mintedReleaseDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(record.candidate.mintedSourceTreeSha).toMatch(/^[a-f0-9]{40}$/);
      expect(record.candidate.mintedSourceFileCount).toBe("42");
      expect(record.candidate.deploymentConfigurationBinding).toBe(
        "UNVERIFIED",
      );
      expect(record.candidate.receiptBinding).toBe("UNVERIFIED");
      expect(record.candidate.releaseAdmission).toBe("BLOCKED");
      expect(record.releaseAdmission).toBe("BLOCKED");
      expect(record.candidate.candidateOnly).toBe(true);
      expect(manifest.host_permissions).toContain(`${origin}/*`);
      expect(manifest.externally_connectable.matches).toContain(`${origin}/*`);
      const javascript = await Promise.all(
        record.files
          .filter(({ path }) => path.endsWith(".js"))
          .map(({ path }) =>
            readFile(join(directory, "extension", path), "utf8"),
          ),
      );
      expect(javascript.join("\n")).toContain(origin);
      await expect(
        verifyPackage(directory, record, "staging"),
      ).resolves.toBeUndefined();
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  }, 60000);

  it("rejects candidate input for production before writing output", async () => {
    await expect(
      buildExtension({
        target: "production",
        configuration: publicConfig("production"),
        candidate: {
          origin: "https://mintedpanel-staging-candidate.vercel.app",
          deploymentId: "dpl_candidateBuildSynthetic",
          panelSha: "1".repeat(40),
        },
        allowDirty: true,
        outputRoot: await mkdtemp(
          join(tmpdir(), "minted-extension-production-candidate-"),
        ),
      }),
    ).rejects.toThrow("CANDIDATE_TARGET");
  });

  it("Store CLI rejects incomplete/unknown arguments without echoing input", () => {
    const cli = fileURLToPath(new URL("./check-store.mjs", import.meta.url));
    for (const args of [
      [],
      ["--token", "private-sentinel"],
      ["--policy", "private-sentinel"],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        localPrerequisitesSatisfied: false,
        code: "STORE_INPUT_OR_ARTIFACT",
      });
    }
  });
});
