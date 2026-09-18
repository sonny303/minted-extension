import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalJson, verifyPackage } from "./build.mjs";
import { canonicalDigest, validateStoreDestination } from "./contract.mjs";

// No upload API, credentials, browser or automatic publishing is present here.
let result;
try {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !["--policy", "--observed", "--record-digest"].includes(key) ||
      Object.hasOwn(options, key) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error("ARGUMENTS");
    options[key] = value;
  }
  if (Object.keys(options).length !== 3 || !/^[a-f0-9]{64}$/.test(options["--record-digest"]))
    throw new Error("ARGUMENTS");
  const directory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../release-artifacts/production",
  );
  const record = await readLocalJson(join(directory, "provenance.json"));
  if (canonicalDigest(record) !== options["--record-digest"]) throw new Error("ARTIFACT_MISMATCH");
  await verifyPackage(directory, record, "production");
  const stagingDirectory = resolve(directory, "../staging");
  const stagingRecord = await readLocalJson(join(stagingDirectory, "provenance.json"));
  await verifyPackage(stagingDirectory, stagingRecord, "staging");
  result = validateStoreDestination({
    record,
    stagingRecord,
    policy: await readLocalJson(options["--policy"]),
    observed: await readLocalJson(options["--observed"]),
  });
} catch {
  result = { ok: false, localPrerequisitesSatisfied: false, code: "STORE_INPUT_OR_ARTIFACT" };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.ok ? 0 : 1;
