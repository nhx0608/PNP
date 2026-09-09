import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { MINIMUM_PYTHON, PYTHON_VARIABLE, describeUnavailable, resolvePython } from "../../../src/tools/pdf-mcp/python.ts";
import { startLauncherClient, structured } from "./harness.ts";

/**
 * The degradation behaviour, verified on a machine that *does* have Python.
 *
 * `config/settings.json` declares this server unconditionally, so what happens when the interpreter
 * is missing is not a hypothetical: it decides whether a judge's machine without Python gets a
 * reported fact or a broken tool set. Pointing `PNP_PYTHON` at nothing reproduces that state
 * deterministically, which is why these tests carry no skip.
 */

const MISSING = path.join(path.sep === "\\" ? "D:\\" : "/", "pnp-no-such-python", "python.exe");

test("an explicit PNP_PYTHON that resolves to nothing fails loudly instead of falling back to PATH", () => {
  const resolution = resolvePython({ [PYTHON_VARIABLE]: MISSING } as NodeJS.ProcessEnv);
  assert.equal(resolution.available, false);
  assert.ok(resolution.available === false);
  assert.match(resolution.reason, new RegExp(PYTHON_VARIABLE));
  const described = describeUnavailable(resolution);
  assert.match(described, /does not exist/);
  assert.ok(described.includes(MISSING), "the failure must name the path that was checked");
});

test("resolvePython names the version floor it enforces", () => {
  assert.deepEqual([...MINIMUM_PYTHON], [3, 9]);
  const resolution = resolvePython({ [PYTHON_VARIABLE]: MISSING } as NodeJS.ProcessEnv);
  assert.ok(resolution.available === false);
  assert.match(resolution.reason, /3\.9\+/);
});

type UnavailableInfo = {
  name: string;
  available: boolean;
  reason: string;
  detail: string;
  requiredPython: string;
  remedyVariable: string;
  serverEntry: string;
  tools: unknown[];
};

test("without an interpreter the server still starts and reports the gap instead of failing", async () => {
  const session = await startLauncherClient({ [PYTHON_VARIABLE]: MISSING });
  try {
    // Not a startup failure: the client completed `initialize` against a live server.
    const listed = await session.client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["server_info"],
      "an unavailable server publishes no PDF tool it cannot honour");
    const info = structured<UnavailableInfo>(await session.client.callTool({ name: "server_info", arguments: {} }));
    assert.equal(info.name, "pdf");
    assert.equal(info.available, false);
    assert.equal(info.remedyVariable, PYTHON_VARIABLE);
    assert.equal(info.requiredPython, "3.9+");
    assert.deepEqual(info.tools, []);
    assert.ok(info.detail.includes(MISSING), `the detail must name what was checked: ${info.detail}`);
    assert.match(info.reason, new RegExp(PYTHON_VARIABLE));
  } finally {
    await session.stop();
  }
});

test("the unavailable server's instructions tell the model the office tools are unaffected", async () => {
  const session = await startLauncherClient({ [PYTHON_VARIABLE]: MISSING });
  try {
    const instructions = session.client.getInstructions() ?? "";
    assert.match(instructions, /server_info/);
    assert.match(instructions, /[一-鿿]/, "instructions are bilingual like every other surface here");
    assert.match(instructions, /unaffected/);
  } finally {
    await session.stop();
  }
});
