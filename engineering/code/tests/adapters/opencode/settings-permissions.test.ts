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

test("all-allow settings keep OpenCode native permissions unset", () => {
  assert.equal(buildNativePermissionConfig({ default: "allow", operations: {} }), undefined);
  const payload = buildNativeConfigPayload(model, [], "PNP_TEST_", "engine-default", { default: "allow", operations: {} });
  assert.equal("permission" in (payload.json as Record<string, unknown>), false);
});

test("settings default ask projects wildcard ask with explicit allow overrides", () => {
  assert.deepEqual(buildNativePermissionConfig({
    default: "ask",
    operations: { read: "allow", write: "ask" },
  }), { "*": "ask", read: "allow", edit: "ask" });
});

test("PNP deny is projected as native ask so the gateway remains the denial authority", () => {
  assert.deepEqual(buildNativePermissionConfig({
    default: "allow",
    operations: { write: "deny", bash: "ask" },
  }), { edit: "ask", bash: "ask" });
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
  });
});

test("legacy force-ask adds edit/bash but cannot remove prompts required by settings", () => {
  assert.deepEqual(buildNativePermissionConfig({
    default: "allow",
    operations: { webfetch: "ask" },
  }, "ask"), { webfetch: "ask", edit: "ask", bash: "ask" });
});
