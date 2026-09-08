import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNativePermissionConfig, buildNativeConfigPayload } from "../../../src/engines/opencode/native-config.ts";
import type { ResolvedModel } from "../../../src/contracts/index.ts";

const model: ResolvedModel = {
  selection: { providerID: "test", modelID: "model" },
  protocol: "openai-chat",
  endpoint: "http://127.0.0.1:9000/v1",
  headers: {},
};

test("all-allow settings still write external_directory: allow, the one native default that is not allow", () => {
  // OpenCode's config reference says it "allows all operations" by default, but external_directory defaults to
  // ask (T03-opencode.md line 151). Every evaluation task touches absolute paths outside the session directory,
  // and nobody is at the keyboard, so the allow has to be explicit -- there is nothing else in the block.
  assert.deepEqual(buildNativePermissionConfig({ default: "allow", operations: {} }), { external_directory: "allow" });
  const payload = buildNativeConfigPayload(model, [], "PNP_TEST_", "engine-default", { default: "allow", operations: {} });
  assert.deepEqual((payload.json as Record<string, unknown>)["permission"], { external_directory: "allow" });
});

test("an operation that names external_directory is projected untouched, never overwritten with allow", () => {
  assert.deepEqual(buildNativePermissionConfig({
    default: "allow",
    operations: { external_directory: "ask" },
  }), { external_directory: "ask" });
  // A deny is projected as ask like any other operation: the gateway stays the denial authority.
  assert.deepEqual(buildNativePermissionConfig({
    default: "allow",
    operations: { external_directory: "deny" },
  }), { external_directory: "ask" });
  // An explicit allow under an allow default is redundant for every other key and is dropped there; for
  // external_directory it is the only thing standing between the run and OpenCode's native `ask`, so it is kept.
  assert.deepEqual(buildNativePermissionConfig({
    default: "allow",
    operations: { external_directory: "allow" },
  }), { external_directory: "allow" });
  // Under a non-allow default the wildcard carries the prompt and an explicit allow is projected as before.
  assert.deepEqual(buildNativePermissionConfig({
    default: "ask",
    operations: { external_directory: "allow" },
  }), { "*": "ask", external_directory: "allow" });
});

test("settings default ask projects wildcard ask with explicit allow overrides, and no implicit external allow", () => {
  assert.deepEqual(buildNativePermissionConfig({
    default: "ask",
    operations: { read: "allow", write: "ask" },
  }), { "*": "ask", read: "allow", edit: "ask" });
});

test("PNP deny is projected as native ask so the gateway remains the denial authority", () => {
  assert.deepEqual(buildNativePermissionConfig({
    default: "allow",
    operations: { write: "deny", bash: "ask" },
  }), { edit: "ask", bash: "ask", external_directory: "allow" });
});

test("common aliases map to OpenCode native permission names", () => {
  assert.deepEqual(buildNativePermissionConfig({
    default: "allow",
    operations: {
      "file.read": "ask",
      "file.write": "ask",
      "shell.execute": "ask",
      "web.fetch": "ask",
      "web.search": "ask",
      subagent: "ask",
    },
  }), {
    read: "ask",
    edit: "ask",
    bash: "ask",
    webfetch: "ask",
    websearch: "ask",
    task: "ask",
    external_directory: "allow",
  });
});

test("legacy force-ask adds edit/bash but cannot remove prompts required by settings", () => {
  assert.deepEqual(buildNativePermissionConfig({
    default: "allow",
    operations: { webfetch: "ask" },
  }, "ask"), { webfetch: "ask", external_directory: "allow", edit: "ask", bash: "ask" });
});
