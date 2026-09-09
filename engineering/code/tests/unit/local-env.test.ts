import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CODE_ROOT } from "../../src/config/settings.ts";
import { DEFAULT_LOCAL_ENV_FILE, loadLocalEnvironment } from "../../src/config/local-env.ts";
import { removeTree } from "../kit/fs.ts";

test("the default local environment file lives beside the delivery's own runtime state", () => {
  // Not in the repository and not in the package: `runtime/` is created on the machine that runs the
  // gateway, which is the only place a deployment's own values may exist.
  assert.equal(DEFAULT_LOCAL_ENV_FILE, path.join(CODE_ROOT, "runtime", "local.env"));
});

test("a local environment file is applied by name, and the process environment wins", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-local-env-"));
  try {
    const file = path.join(dir, "local.env");
    await writeFile(file, [
      "# The deployment's own values.",
      "",
      "PNP_MODEL_ENDPOINT=https://model.test.invalid/v1",
      "  PNP_MODEL_ID = endpoint-model  ",
      'PNP_MODEL_HEADERS={"appid":"A1"}',
      "PNP_MODEL_API_KEY=\"quoted value\"",
      "PNP_ALREADY_SET=from-file",
      "PNP_EXPORTED_EMPTY=from-file",
    ].join("\n"), "utf8");
    const environment: NodeJS.ProcessEnv = { PNP_ALREADY_SET: "from-environment", PNP_EXPORTED_EMPTY: "" };
    const result = await loadLocalEnvironment({ environment, file });
    assert.equal(result.present, true);
    assert.equal(result.file, file);
    assert.equal(environment.PNP_MODEL_ENDPOINT, "https://model.test.invalid/v1");
    assert.equal(environment.PNP_MODEL_ID, "endpoint-model");
    assert.equal(environment.PNP_MODEL_HEADERS, '{"appid":"A1"}');
    // One layer of matching quotes is removed, the way the launcher reads the same file.
    assert.equal(environment.PNP_MODEL_API_KEY, "quoted value");
    // An operator who exported a variable for a single run is not overruled by the file.
    assert.equal(environment.PNP_ALREADY_SET, "from-environment");
    // A wrapper that exported a name without a value has said nothing, so the file still applies.
    assert.equal(environment.PNP_EXPORTED_EMPTY, "from-file");
    // The result carries NAMES only: this file holds credentials, so no value is ever reported.
    assert.deepEqual(result.names, [
      "PNP_MODEL_ENDPOINT", "PNP_MODEL_ID", "PNP_MODEL_HEADERS", "PNP_MODEL_API_KEY", "PNP_EXPORTED_EMPTY",
    ]);
    assert.equal(JSON.stringify(result).includes("quoted value"), false);
  } finally { await removeTree(dir); }
});

test("the file to load may be named relatively, and its absence is not a failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-local-env-path-"));
  try {
    const file = path.join(dir, "local.env");
    await writeFile(file, "PNP_MODEL_ID=endpoint-model\n", "utf8");
    // A deployment names the file relative to the package root because it cannot know where the
    // delivery was unpacked; the launcher's working directory must not decide which file that is.
    const relative: NodeJS.ProcessEnv = { PNP_LOCAL_ENV_FILE: path.relative(CODE_ROOT, file) };
    const loaded = await loadLocalEnvironment({ environment: relative });
    assert.equal(loaded.file, file);
    assert.equal(relative.PNP_MODEL_ID, "endpoint-model");
    // No file at all is the normal case for a deployment that exports its variables another way.
    const absent = await loadLocalEnvironment({ environment: {}, file: path.join(dir, "absent.env") });
    assert.deepEqual({ present: absent.present, names: absent.names }, { present: false, names: [] });
  } finally { await removeTree(dir); }
});

test("a malformed line is reported by position, never by content", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pnp-local-env-invalid-"));
  try {
    const file = path.join(dir, "local.env");
    await writeFile(file, "PNP_MODEL_ID=endpoint-model\nPNP_MODEL_API_KEY not-a-secret\n", "utf8");
    const environment: NodeJS.ProcessEnv = {};
    await assert.rejects(loadLocalEnvironment({ environment, file }), (error: unknown) => {
      const failure = error as { code: string; message: string };
      assert.equal(failure.code, "VALIDATION_ERROR");
      assert.match(failure.message, / 2;/);
      assert.doesNotMatch(failure.message, /not-a-secret/);
      return true;
    });
    // Validation is atomic. A caller that reports the error and keeps running cannot observe a
    // half-applied environment from the valid lines before the malformed one.
    assert.equal(environment.PNP_MODEL_ID, undefined);
  } finally { await removeTree(dir); }
});
