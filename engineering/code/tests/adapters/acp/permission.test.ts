import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_METHODS } from "@agentclientprotocol/sdk";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { InteractionRequest, InteractionResponse } from "../../../src/contracts/index.ts";
import { openAcpChannel } from "../../../src/drivers/acp/channel.ts";
import type { FakeAgent } from "../../kit/fake-host.ts";
import { definition, harness, nativePayload, RecordingServices, runTurn, waitFor } from "./harness.ts";
import { askPermission, baseScript, heldPrompt, NATIVE_SESSION, permissionRequest, promptResponse, update } from "./script.ts";

interface Asked {
  outcome: RequestPermissionResponse;
  services: RecordingServices;
  interactions: InteractionRequest[];
}

/** Runs one turn in which the engine asks for permission once, and reports what came back. */
async function askDuringTurn(options: {
  answer(request: InteractionRequest): Promise<InteractionResponse>;
  request?: RequestPermissionRequest;
  /** Session updates the engine sends before it asks, e.g. the `tool_call` that announces the call. */
  announce?(agent: FakeAgent): void;
}): Promise<Asked> {
  let outcome: RequestPermissionResponse | undefined;
  const fixture = harness({
    handlers: baseScript({
      prompt: async (_params: unknown, agent: FakeAgent) => {
        options.announce?.(agent);
        outcome = await askPermission(agent, options.request ?? permissionRequest());
        return promptResponse();
      },
    }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices({ answer: options.answer });
  try {
    await runTurn(channel, { services, integration: fixture.integration });
    if (outcome === undefined) throw new Error("The engine never received a permission outcome.");
    return { outcome, services, interactions: services.interactions };
  } finally {
    await channel.close();
  }
}

test("an approval selects the once-scoped option and reaches the engine", async () => {
  const asked = await askDuringTurn({
    answer: (): Promise<InteractionResponse> => Promise.resolve({ decision: "allow", source: "user" }),
  });
  assert.deepEqual(asked.outcome, { outcome: { outcome: "selected", optionId: "allow-once" } });
  assert.equal(asked.interactions.length, 1);
  assert.equal(asked.interactions[0]?.kind, "permission");
  assert.equal(asked.interactions[0]?.operation, "write");
  const resolved = nativePayload(asked.services, "permission.resolved");
  assert.equal(resolved["decision"], "allow");
  assert.equal(resolved["source"], "user");
  assert.equal(resolved["optionKind"], "allow_once");
});

test("an approval never widens itself into an always-allow", async () => {
  const asked = await askDuringTurn({
    answer: (): Promise<InteractionResponse> => Promise.resolve({ decision: "allow", source: "user" }),
    request: permissionRequest({
      options: [
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    }),
  });
  // Widening an approval is a policy decision the driver is not entitled to make, whatever the order of the options.
  assert.deepEqual(asked.outcome, { outcome: { outcome: "selected", optionId: "allow-once" } });
});

test("an engine that only offers always-allow gets no approval at all", async () => {
  const asked = await askDuringTurn({
    answer: (): Promise<InteractionResponse> => Promise.resolve({ decision: "allow", source: "user" }),
    request: permissionRequest({
      options: [
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-always", name: "Never allow", kind: "reject_always" },
      ],
    }),
  });
  // There is no once-scoped approval to give, so the driver declines rather than granting a standing one.
  assert.deepEqual(asked.outcome, { outcome: { outcome: "cancelled" } });
  const resolved = nativePayload(asked.services, "permission.resolved");
  assert.equal(resolved["decision"], "allow");
  assert.equal(resolved["optionId"], null);
  assert.deepEqual(resolved["selectable"], ["allow_always", "reject_always"]);
});

test("a refusal selects the once-scoped rejection", async () => {
  const asked = await askDuringTurn({
    answer: (): Promise<InteractionResponse> =>
      Promise.resolve({ decision: "deny", source: "policy", reasonCode: "org.deny.write" }),
  });
  assert.deepEqual(asked.outcome, { outcome: { outcome: "selected", optionId: "reject-once" } });
  const resolved = nativePayload(asked.services, "permission.resolved");
  assert.equal(resolved["decision"], "deny");
  assert.equal(resolved["source"], "policy");
  assert.equal(resolved["reasonCode"], "org.deny.write");
});

test("a refusal falls back to always-reject when no once-scoped rejection exists", async () => {
  const asked = await askDuringTurn({
    answer: (): Promise<InteractionResponse> => Promise.resolve({ decision: "deny", source: "policy" }),
    request: permissionRequest({
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-always", name: "Never allow", kind: "reject_always" },
      ],
    }),
  });
  // Widening a refusal is safe in the direction the organisation already chose.
  assert.deepEqual(asked.outcome, { outcome: { outcome: "selected", optionId: "reject-always" } });
});

test("an unanswered request times out into the conservative default and the turn still finishes", async () => {
  const asked = await askDuringTurn({
    answer: (): Promise<InteractionResponse> =>
      Promise.resolve({ decision: "deny", source: "timeout", reasonCode: "interaction.timeout" }),
  });
  // A timeout is not an approval, and it is not a reason to fail the whole evaluation round either.
  assert.deepEqual(asked.outcome, { outcome: { outcome: "selected", optionId: "reject-once" } });
  const resolved = nativePayload(asked.services, "permission.resolved");
  assert.equal(resolved["source"], "timeout");
  assert.equal(resolved["reasonCode"], "interaction.timeout");
});

test("an answer that is neither allow nor deny is treated conservatively", async () => {
  const asked = await askDuringTurn({
    answer: (): Promise<InteractionResponse> => Promise.resolve({ decision: "answer", answers: [["maybe"]] }),
  });
  assert.deepEqual(asked.outcome, { outcome: { outcome: "selected", optionId: "reject-once" } });
});

test("an interaction channel that is unavailable cancels the request and says so", async () => {
  const asked = await askDuringTurn({
    answer: (): Promise<InteractionResponse> => Promise.reject(new Error("no interaction transport")),
  });
  assert.deepEqual(asked.outcome, { outcome: { outcome: "cancelled" } });
  const unavailable = nativePayload(asked.services, "permission.unavailable");
  assert.equal(unavailable["toolCallId"], "call-1");
  assert.match(String(unavailable["detail"]), /no interaction transport/);
  assert.equal(asked.services.native("permission.resolved").length, 0);
});

test("the request payload carries what the approver needs to decide", async () => {
  const asked = await askDuringTurn({
    answer: (): Promise<InteractionResponse> => Promise.resolve({ decision: "allow", source: "user" }),
    request: {
      sessionId: "acp-session-42",
      toolCall: {
        toolCallId: "call-9", title: "Delete build output", name: "delete", kind: "delete",
        rawInput: { path: "dist" },
        // The shape OpenCode 1.18.29 uses for an edit: the proposed change travels in `content`.
        content: [{ type: "diff", path: "dist/manifest.txt", oldText: "keep", newText: "" }],
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  });
  const payload = asked.interactions[0]?.payload;
  assert.ok(payload !== null && typeof payload === "object" && !Array.isArray(payload));
  assert.equal(payload["toolCallId"], "call-9");
  assert.equal(payload["name"], "delete");
  assert.equal(payload["kind"], "delete");
  assert.deepEqual(payload["rawInput"], { path: "dist" });
  assert.deepEqual(payload["content"], [{ type: "diff", path: "dist/manifest.txt", oldText: "keep", newText: "" }]);
  assert.deepEqual(payload["options"], [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
  ]);
});

// --- the operation a policy can be written against ------------------------------------------------------------

test("a request that carries only a file path is authorised as the tool that was announced", async () => {
  const asked = await askDuringTurn({
    answer: (): Promise<InteractionResponse> => Promise.resolve({ decision: "allow", source: "user" }),
    // opencode 1.18.29 announces the call with its name, then asks with display fields only.
    announce: (agent: FakeAgent): void => {
      update(agent, {
        sessionUpdate: "tool_call", toolCallId: "call-7", title: "Write a file", name: "write",
        kind: "edit", status: "pending", rawInput: {},
      });
      update(agent, {
        sessionUpdate: "tool_call_update", toolCallId: "call-7", status: "in_progress",
        title: "C:\\workspace\\out.txt", rawInput: { filePath: "C:\\workspace\\out.txt", content: "hi" },
      });
    },
    request: {
      sessionId: NATIVE_SESSION,
      // No `name`, and `title` is the target path: keying on the title would make every file its own
      // operation, so `policy.operations.write` could never match.
      toolCall: {
        toolCallId: "call-7", title: "C:\\workspace\\out.txt", kind: "edit",
        rawInput: { filepath: "C:\\workspace\\out.txt", diff: "+hi" },
        content: [{ type: "diff", path: "C:\\workspace\\out.txt", oldText: null, newText: "hi" }],
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  });
  assert.equal(asked.interactions[0]?.operation, "write");
  // The payload still carries everything the approver sees, unchanged.
  const payload = asked.interactions[0]?.payload;
  assert.ok(payload !== null && typeof payload === "object" && !Array.isArray(payload));
  assert.equal(payload["title"], "C:\\workspace\\out.txt");
  assert.equal(payload["name"], null);
  assert.equal(payload["kind"], "edit");
});

test("without an announced name the ACP kind is preferred over the free-form title", async () => {
  const asked = await askDuringTurn({
    answer: (): Promise<InteractionResponse> => Promise.resolve({ decision: "allow", source: "user" }),
    request: {
      sessionId: NATIVE_SESSION,
      toolCall: { toolCallId: "call-8", title: "C:\\workspace\\out.txt", kind: "edit" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  });
  // A closed ACP vocabulary is at least writable in a policy; a per-file title is not.
  assert.equal(asked.interactions[0]?.operation, "edit");
});

test("the request's own name still wins when the mapper never saw the call", async () => {
  const asked = await askDuringTurn({
    answer: (): Promise<InteractionResponse> => Promise.resolve({ decision: "allow", source: "user" }),
    request: permissionRequest({ toolCallId: "call-never-announced", name: "bash" }),
  });
  assert.equal(asked.interactions[0]?.operation, "bash");
});

test("exercising a permission raises its evidence past a bare declaration", async () => {
  const fixture = harness({
    handlers: baseScript({
      prompt: async (_params: unknown, agent: FakeAgent) => {
        await askPermission(agent, permissionRequest());
        return promptResponse();
      },
    }),
  });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices({
    answer: (): Promise<InteractionResponse> => Promise.resolve({ decision: "allow", source: "user" }),
  });
  try {
    const before = channel.capabilities.extensions.find((entry) => entry.id === "acp.session.permission");
    assert.equal(before?.evidence, "declared");
    await runTurn(channel, { services, integration: fixture.integration });
    const after = channel.capabilities.extensions.find((entry) => entry.id === "acp.session.permission");
    assert.equal(after?.evidence, "verified");
  } finally {
    await channel.close();
  }
});

test("a permission asked after the turn was cancelled is refused without asking anyone", async () => {
  const held = heldPrompt();
  let outcome: RequestPermissionResponse | undefined;
  const fixture = harness({ handlers: baseScript({ prompt: held.handler }) });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices({
    answer: (): Promise<InteractionResponse> => Promise.resolve({ decision: "allow", source: "user" }),
  });
  try {
    const running = runTurn(channel, { services, integration: fixture.integration });
    await waitFor(() => fixture.agent.countOf(AGENT_METHODS.session_prompt) > 0, "the prompt");
    await channel.cancel("user");
    outcome = await askPermission(fixture.agent, permissionRequest());
    held.release(promptResponse({ stopReason: "cancelled" }));
    await running;
    // ACP requires a cancelled outcome once the client has stopped the turn, and no human is asked for nothing.
    assert.deepEqual(outcome, { outcome: { outcome: "cancelled" } });
    assert.equal(services.interactions.length, 0);
  } finally {
    await channel.close();
  }
});

test("a permission asked outside any turn is refused without asking anyone", async () => {
  const fixture = harness({ handlers: baseScript() });
  const channel = await openAcpChannel(definition(), fixture.input);
  const services = new RecordingServices({
    answer: (): Promise<InteractionResponse> => Promise.resolve({ decision: "allow", source: "user" }),
  });
  try {
    await runTurn(channel, { services, integration: fixture.integration });
    const outcome = await askPermission(fixture.agent, permissionRequest());
    assert.deepEqual(outcome, { outcome: { outcome: "cancelled" } });
    assert.equal(services.interactions.length, 0);
  } finally {
    await channel.close();
  }
});
