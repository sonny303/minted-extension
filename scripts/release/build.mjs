import {
  readFile,
  writeFile,
  readdir,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  open,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { build } from "vite";
import {
  targetFor,
  validatePublicConfiguration,
  releaseManifest,
  validateManifest,
  validateBundleText,
  sha256,
  canonicalDigest,
} from "./contract.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const allowedFile =
  /^(?:manifest\.json|sidepanel\.html|background\.js|content\.js|icons\/icon(?:16|32|48|128)\.png|fonts\/[a-zA-Z0-9_-]+\.woff2|fonts\/README\.md|assets\/[a-zA-Z0-9_-]+\.(?:js|css|woff2))$/;
const fail = (code) => {
  throw new Error(code);
};

async function filesUnder(directory, prefix = "") {
  const files = [];
  for (const entry of (await readdir(directory)).sort()) {
    const name = prefix ? `${prefix}/${entry}` : entry;
    const path = join(directory, entry);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) fail("SYMLINK_INPUT");
    if (stat.isDirectory()) files.push(...(await filesUnder(path, name)));
    else if (stat.isFile()) files.push(name);
    else fail("NONREGULAR_INPUT");
  }
  return files;
}

async function sourceSnapshot() {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const names = [
    "package.json",
    "package-lock.json",
    "sidepanel.html",
    "vite.config.ts",
    "vite.content.config.ts",
  ];
  for (const path of ["src", "public", "scripts/release"])
    for (const name of await filesUnder(join(repositoryRoot, path))) names.push(`${path}/${name}`);
  const files = [];
  for (const path of names.sort())
    files.push({ path, sha256: sha256(await readFile(join(repositoryRoot, path))) });
  return {
    sha: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: git("status", "--porcelain", "--untracked-files=all").length > 0,
    buildInputDigest: canonicalDigest(files),
  };
}

export async function inspectBundle(directory, target, config, version) {
  const names = await filesUnder(directory);
  if (!names.length || names.some((name) => !allowedFile.test(name))) fail("PACKAGE_FILE_SET");
  for (const name of ["manifest.json", "sidepanel.html", "background.js", "content.js"])
    if (!names.includes(name)) fail("PACKAGE_INCOMPLETE");
  validateManifest(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
    target,
    version,
  );
  const files = [];
  const textParts = [];
  const javascript = [];
  for (const path of names) {
    const bytes = await readFile(join(directory, path));
    files.push({ path, size: bytes.length, sha256: sha256(bytes) });
    if (/\.(?:js|css|json|html|md)$/.test(path)) {
      const text = bytes.toString("utf8");
      validateBundleText(text, target, config.VITE_SUPABASE_ANON_KEY);
      textParts.push(text);
      if (path.endsWith(".js")) javascript.push(text);
    }
  }
  // Vite may move worker/panel shared constants into an imported JS chunk.
  const runtime = javascript.join("\n");
  const expected = targetFor(target);
  if (
    ![
      config.VITE_API_BASE_URL,
      config.VITE_SUPABASE_URL,
      config.VITE_SUPABASE_ANON_KEY,
      ...expected.origins,
    ].every((value) => runtime.includes(value))
  )
    fail("RUNTIME_CONFIGURATION");
  if (textParts.join("\n").includes("__MINTED_RELEASE_HANDOFF_ORIGINS__"))
    fail("HANDOFF_CONFIGURATION");
  return files;
}

/** Complete local build only. Tests may provide a task-owned temporary outputRoot. */
export async function buildExtension({
  target,
  configuration,
  allowDirty = false,
  outputRoot = join(repositoryRoot, "release-artifacts"),
}) {
  const profile = targetFor(target);
  const config = validatePublicConfiguration(target, configuration);
  const source = await sourceSnapshot();
  if (source.dirty && !allowDirty) fail("DIRTY_SOURCE");
  await mkdir(outputRoot, { recursive: true });
  if ((await lstat(outputRoot)).isSymbolicLink()) fail("OUTPUT_SYMLINK");
  const lockPath = join(outputRoot, `.${target}.lock`);
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    fail("BUILD_LOCKED");
  }
  let temporary;
  const destination = join(outputRoot, target);
  const previous = join(outputRoot, `.previous-${target}-${randomUUID()}`);
  let savedPrevious = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    temporary = await mkdtemp(join(outputRoot, `.building-${target}-`));
    const outDir = join(temporary, "extension");
    const common = {
      root: repositoryRoot,
      envDir: false,
      envPrefix: "MINTED_RELEASE_UNUSED_",
      mode: "production",
      logLevel: "silent",
      define: {
        "import.meta.env": JSON.stringify({
          BASE_URL: "/",
          MODE: "production",
          DEV: false,
          PROD: true,
          SSR: false,
          ...config,
        }),
        ...Object.fromEntries(
          Object.entries(config).map(([key, value]) => [
            `import.meta.env.${key}`,
            JSON.stringify(value),
          ]),
        ),
        __MINTED_RELEASE_HANDOFF_ORIGINS__: JSON.stringify(profile.origins),
      },
    };
    await build({
      ...common,
      configFile: join(repositoryRoot, "vite.config.ts"),
      build: { outDir, emptyOutDir: true, sourcemap: false },
    });
    await build({
      ...common,
      configFile: join(repositoryRoot, "vite.content.config.ts"),
      build: { outDir, emptyOutDir: false, sourcemap: false },
    });
    const pkg = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
    const base = JSON.parse(await readFile(join(repositoryRoot, "public/manifest.json"), "utf8"));
    await writeFile(
      join(outDir, "manifest.json"),
      `${JSON.stringify(releaseManifest(base, target, pkg.version), null, 2)}\n`,
    );
    const files = await inspectBundle(outDir, target, config, pkg.version);
    const archive = join(temporary, "extension.zip");
    execFileSync("zip", ["-X", "-q", archive, "-@"], {
      cwd: outDir,
      input: `${files.map((file) => file.path).join("\n")}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (canonicalDigest(source) !== canonicalDigest(await sourceSnapshot()))
      fail("SOURCE_CHANGED_DURING_BUILD");
    const record = {
      schemaVersion: 1,
      target,
      distribution: target === "staging" ? "local-unpacked" : "restricted-store-candidate",
      repository: "sonny303/minted-extension",
      source,
      version: pkg.version,
      builtAt: new Date().toISOString(),
      nodeVersion: process.version,
      configurationDigest: canonicalDigest(config),
      apiOrigin: profile.api,
      webOrigins: profile.origins,
      supabaseRef: profile.ref,
      publicKeyDigest: sha256(config.VITE_SUPABASE_ANON_KEY),
      files,
      bundleDigest: canonicalDigest(files),
      archiveSha256: sha256(await readFile(archive)),
      localExtensionId: null,
      userManualResult: "PENDING",
      storeDestination: null,
      verificationType: "packaging-only",
      publicKeyValidation: "STRUCTURAL_ONLY",
      hostedApiResult: target === "staging" ? "BLOCKED_DEPLOYMENT_PROTECTION" : "UNVERIFIED",
    };
    await writeFile(join(temporary, "provenance.json"), `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    try {
      const stat = await lstat(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("OUTPUT_SYMLINK");
      await rename(destination, previous);
      savedPrevious = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (savedPrevious) await rename(previous, destination);
      throw error;
    }
    if (savedPrevious) await rm(previous, { recursive: true });
    return {
      ok: true,
      target,
      version: record.version,
      sourceSha: source.sha,
      sourceDirty: source.dirty,
      bundleDigest: record.bundleDigest,
      archiveSha256: record.archiveSha256,
      recordDigest: canonicalDigest(record),
      localPrerequisitesSatisfied: false,
      manualResult: "PENDING",
    };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function verifyPackage(directory, record, expectedTarget) {
  targetFor(expectedTarget);
  if (
    !record ||
    record.schemaVersion !== 1 ||
    record.target !== expectedTarget ||
    typeof record.version !== "string"
  )
    fail("ARTIFACT_MISMATCH");
  const extension = join(directory, "extension");
  const names = await filesUnder(extension);
  if (names.some((name) => !allowedFile.test(name))) fail("ARTIFACT_MISMATCH");
  for (const name of ["manifest.json", "sidepanel.html", "background.js", "content.js"])
    if (!names.includes(name)) fail("ARTIFACT_MISMATCH");
  const files = [];
  for (const path of names) {
    const bytes = await readFile(join(extension, path));
    files.push({ path, size: bytes.length, sha256: sha256(bytes) });
  }
  validateManifest(
    await readLocalJson(join(extension, "manifest.json")),
    expectedTarget,
    record.version,
  );
  const archive = join(directory, "extension.zip");
  const archiveStat = await lstat(archive);
  if (
    !archiveStat.isFile() ||
    archiveStat.isSymbolicLink() ||
    canonicalDigest(files) !== record.bundleDigest ||
    canonicalDigest(record.files) !== record.bundleDigest ||
    sha256(await readFile(archive)) !== record.archiveSha256
  )
    fail("ARTIFACT_MISMATCH");
}

export async function readLocalJson(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) fail("INPUT_FILE");
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index++) {
      const key = args[index];
      if (!["--target", "--config", "--allow-dirty"].includes(key) || Object.hasOwn(options, key))
        fail("ARGUMENTS");
      if (key === "--allow-dirty") options[key] = true;
      else {
        const value = args[++index];
        if (!value || value.startsWith("--")) fail("ARGUMENTS");
        options[key] = value;
      }
    }
    if (!options["--target"] || !options["--config"]) fail("ARGUMENTS");
    const result = await buildExtension({
      target: options["--target"],
      configuration: await readLocalJson(options["--config"]),
      allowDirty: options["--allow-dirty"] === true,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const known =
      /^(?:TARGET_REQUIRED|INVALID_CLOCK|PUBLIC_CONFIGURATION|CONFIGURATION_TARGET|PUBLIC_ANON_KEY|DIRTY_SOURCE|BUILD_LOCKED|SOURCE_CHANGED_DURING_BUILD|PACKAGE_VERSION|MANIFEST_IDENTITY|MANIFEST_TARGET|MANIFEST_PERMISSIONS|BUNDLE_WRONG_TARGET|BUNDLE_CREDENTIAL|PACKAGE_FILE_SET|PACKAGE_INCOMPLETE|RUNTIME_CONFIGURATION|HANDOFF_CONFIGURATION|SYMLINK_INPUT|NONREGULAR_INPUT|OUTPUT_SYMLINK|INPUT_FILE|ARGUMENTS)$/;
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: known.test(error.message) ? error.message : "BUILD_FAILED" })}\n`,
    );
    process.exitCode = 1;
  }
}
