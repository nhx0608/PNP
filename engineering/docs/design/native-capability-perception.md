# 引擎原生能力感知与会话历史：设计

> 生成于 2026-09-09。本文是设计记录，不是已实现状态；实现进度见文末「实施状态」。
> 约束来自项目所有者的原则：**网关感知引擎内部行为，不驱动它**；保留各引擎自身能力，不做最小公分母。

## 1. 结论

Native-capability preservation is already the implemented shape, not an aspiration: both drivers end their event switch with a passthrough (src/drivers/pi-rpc/channel.ts:292, src/drivers/acp/updates.ts:168), Core publishes those frames as engine.extension{namespace,nativeType,payload} without ever branching on engine identity (src/core/gateway-core.ts:608), the only engine state the gateway sets is the model the northbound spec mandates, and the two engines' native surfaces (Pi compaction/retry/queue/thinking levels vs ACP compaction/plan/modes/config options) are structurally different and deliberately left different. What is missing is perception and visibility, not control. (1) Pi's own capabilities are lost before they reach the passthrough: thinking and tool-argument streams are swallowed at channel.ts:243-248, usage/cost is stripped to {role,stopReason} at protocol.ts:92-98, unknown frames lose their name (protocol.ts:178), pre-prompt extension errors vanish (channel.ts:234), and ctx.ui.notify becomes a blocking question (channel.ts:300-310). (2) ACP compaction is only observable from an agent that violates a spec MUST because channel.ts:697 never advertises session.compaction, and ACP thought text pollutes the judge-facing final answer through gateway-core.ts:657. (3) The redactor (src/security/redaction.ts:3) blanks every token-count number: a live probe turned tokensBefore, estimatedTokensAfter, totalTokens and the whole tokens{} object into "[REDACTED]", so the compaction evidence the owner wants to see is unreadable today. (4) History cannot be queried by session or run: every event carries sessionID and runID and the events table has a session_id column (worker.ts:45-50), but the only reader is the global eventsSince cursor (worker.ts:161-170) and the only route is the live SSE stream. (5) None of engine.extension, run.usage, model.resolved, /diagnostics or docs/ARCHITECTURE.md is mentioned in INSTRUCTION.md, so the thesis the 20%/5%/5% buckets reward is invisible to a judge. Every package below is a perception change inside a driver, an additive read-only route over already-persisted data, or documentation; none drives an engine, none normalises the engines toward each other, and each names the test that pins it so the green gate stays green.

## 2. 设计原则

- Perceive, never drive: no package sends an engine a state-changing command it does not receive today (prompt, abort, session/set_config_option for the mandated model). Read-only pulls (Pi get_state, get_session_stats) and capability advertisements (ACP clientCapabilities) are perception.
- Asymmetry is the product: native frames keep their engine's own vocabulary under a namespace; only the envelope {namespace,nativeType,payload,sessionID,runID} is uniform. No canonical compaction/reasoning/plan event type is introduced.
- Core and Gateway branch on contract fields (event type, nativeType, namespace), never on engine id; adapters keep the AGENTS.md import boundary and touch neither storage nor HTTP.
- Additive northbound only: new GET routes and new event types; the 16 mandated routes keep their shape and status codes; the SSE frame shape {type,properties} is unchanged.
- Publication follows commit and session.idle stays the last event of a run (tests/kit/engine-contract.ts:25); nothing is published after it and nothing is batched or fire-and-forget.
- The durable journal is the lossless source; SSE is a live view that may evict under backpressure and is documented as such.
- Numbers are never credentials: redaction stays key-and-shape based so token counts survive while every string-valued secret is still blanked.
- Rank by points per effort under 70/20/5/5: a working-but-invisible capability is fixed before a new one is built; documentation of what already runs is the cheapest score.
- Every package states the regression it could cause and the test file and case that would catch it; no package claims verification it did not run.

## 3. 工作包

### WP-01 · P0 · Redaction keeps numbers: token counts survive, string secrets do not

**规模** S　**可并行** 是

**问题**

src/security/redaction.ts:3 `sensitiveKey = /authorization|api[-_]?key|token|password|secret|cookie|connectionstring|privatekey/i` and :30-31 replace the VALUE of any matching key with "[REDACTED]" regardless of its type. Live probe (scratchpad/redact-probe.mjs against the real module): {result:{tokensBefore:120000,estimatedTokensAfter:8000},tokens:{input:5,output:6},totalTokens:11} -> every one of those becomes "[REDACTED]". gateway-core.ts:608-609 passes every native payload through redactor.json, so Pi compaction_end.result, Pi message_end.usage, Pi session_stats and ACP usage_update payloads are unreadable on the wire and in history. run.usage (gateway-core.ts:605) is unaffected because it is not passed through json().

**设计**

src/security/redaction.ts: replace the single regex with two and a shape rule.

const credentialKey = /authorization|api[-_]?key|password|secret|cookie|connectionstring|privatekey/i;
/** `token` is ambiguous: access_token is a credential, inputTokens/tokensBefore/tokens{input,output} are counters. A credential token is always a string, so this key only redacts string values. */
const tokenKey = /token/i;
function redactedByKey(key: string, item: Json): boolean {
  if (item === null || typeof item === "number" || typeof item === "boolean") return false; // numbers and booleans are never credentials
  if (credentialKey.test(key)) return true; // strings, arrays and objects under a credential key are blanked whole
  return tokenKey.test(key) && typeof item === "string";
}

json(): `key, redactedByKey(key, item) ? "[REDACTED]" : this.json(item)`. text()/streamText() unchanged (known secrets, Bearer, userinfo URLs, key=value patterns still apply to every string leaf, so a token count next to a real secret string is still safe).

Behaviour table: {access_token:"abc"} -> redacted; {TOKEN:"x"} -> redacted; {refreshToken:"r"} -> redacted; {apiKey:"k"} -> redacted; {authorization:{scheme,value}} -> whole object redacted; {secrets:["a"]} -> redacted; {tokensBefore:120000} -> kept; {tokens:{input:5}} -> kept and recursed; {totalTokens:11} -> kept; {password:1234} -> kept (number).

**接口面**

No route change. Effect on the wire: an engine.extension frame such as {"type":"engine.extension","properties":{"sessionID":"ses_...","runID":"run_...","namespace":"pi","nativeType":"compaction_end","payload":{"type":"compaction_end","reason":"threshold","result":{"tokensBefore":150000,"estimatedTokensAfter":32000,"usage":{"input":32000,"output":1200,"totalTokens":33200}}}}} now carries its numbers; before this package every numeric field named *token* read "[REDACTED]".

**测试**

tests/unit/runtime.test.ts, extend "redaction covers structured secrets and raw output": (a) deepEqual json({tokensBefore:120000,estimatedTokensAfter:8000,tokens:{input:5,output:6},totalTokens:11,inputTokens:0}) === same object (proves counters survive); (b) deepEqual json({access_token:"abc",TOKEN:"x",refreshToken:"r",apiKey:"k",authorization:{scheme:"Bearer",value:"v"},secrets:["a"]}) === all six "[REDACTED]" (proves the credential guarantee is not weakened); (c) json({note:"key sk-live-x"}) with secret sk-live-x still text-redacts (proves value scanning still runs). tests/contract/gateway.test.ts, new test "engine.extension carries the driver's native frame verbatim, numbers included": monkeypatch MockPack.open (pattern of tests/unit/contracts.test.ts:370) so run() emits {type:"native",namespace:"t",eventName:"compaction_end",payload:{result:{tokensBefore:7},access_token:"leak"}}; after prompt_async 204, core.eventsSince(0) contains one engine.extension whose properties.namespace==="t", nativeType==="compaction_end", payload.result.tokensBefore===7, payload.access_token==="[REDACTED]", and sessionID/runID are set. This also pins the northbound frame shape the docs will describe.

**风险**

Could regress: a credential stored under a numeric-looking value (none exist: every binding value is a string). Could regress: a key such as `tokens` holding a string credential - it is still redacted because the value is a string. Caught by test (b) and by tests/adapters/pi/channel.test.ts:333-347 (model header never appears in native events) which stay untouched.

**计分理由**

Prerequisite for every other visibility gain: 20% (architecture claims about compaction/usage perception become inspectable numbers) and 5% innovation. Without it WP-07's captured frames would show [REDACTED] and read as a bug.

### WP-02 · P0 · History by session and run: GET /session/{id}/event, GET /session/{id}/run, and engine.capabilities in the trace

**规模** M　**可并行** 是

**问题**

Owner: "至少能根据session或者trace查询到会话历史". Events are persisted with session_id (src/storage/worker.ts:156-158) and every publisher sets sessionID and runID (gateway-core.ts:474,605,608; interactions.ts:133-178), but src/storage/protocol.ts:26 offers only eventsSince(afterSequence) and src/core/journal.ts:13 only since(); src/gateway/app.ts:158-221 has no per-session event route and GET /event (app.ts:222) replays only from a GLOBAL cursor, capped at 4096 (app.ts:27) and mixed across sessions. GET /session/{id}/message (app.ts:174) returns the message projection only: run.usage, model.resolved and every engine.extension are journal-only. Runs cannot be listed at all (runs table read only by id, worker.ts:226). EngineCapabilities (contracts/index.ts:115, AcpCapabilityLedger 17 records, Pi literal) is never returned by any route (grep of app.ts and gateway-core.ts: no `capabilities`).

**设计**

1) src/storage/protocol.ts, add to Operations:
  /** Committed events of one session in sequence order; read-only. runId narrows to one run, which is the trace. */
  eventsForSession: { input: { sessionId: string; afterSequence: number; limit?: number; runId?: string; type?: string }; output: PublicEvent[] };
  /** Every run of one session, oldest first; read-only. */
  runsForSession: { input: { sessionId: string }; output: Run[] };

2) src/storage/worker.ts, cases beside eventsSince (:161):
  case "eventsForSession": {
    const value = input<"eventsForSession">(request);
    const limit = Math.min(Math.max(Math.trunc(value.limit ?? 256), 1), 1000);
    const where = ["session_id=?", "sequence>?"];
    const params: (string | number)[] = [value.sessionId, Math.max(Math.trunc(value.afterSequence), 0)];
    if (value.runId !== undefined) { where.push("json_extract(properties,'$.runID')=?"); params.push(value.runId); }
    if (value.type !== undefined) { where.push("type=?"); params.push(value.type); }
    return db.prepare(`SELECT sequence,type,properties FROM events WHERE ${where.join(" AND ")} ORDER BY sequence LIMIT ?`)
      .all(...params, limit).map(rowToEvent);   // rowToEvent = the mapping already inlined in eventsSince, extracted to a function
  }
  case "runsForSession":
    return db.prepare("SELECT document FROM runs WHERE session_id=? ORDER BY rowid").all(input<"runsForSession">(request).sessionId).map((row) => parse<Run>(row));
  Add both names to the readOnly set at worker.ts:327-328 so a failed read is classified known-failed. No schema change (user_version stays 1; the index is WP-08).

3) src/core/journal.ts:
  async forSession(input: { sessionId: string; afterSequence?: number; limit?: number; runId?: string; type?: string }): Promise<PublicEvent[]> { return this.store.call("eventsForSession", { sessionId: input.sessionId, afterSequence: input.afterSequence ?? 0, ...limit/runId/type when defined }); }

4) src/core/gateway-core.ts, beside messages() (:306):
  async sessionEvents(id: string, query: { after?: number; limit?: number; run?: string; type?: string }): Promise<{ sessionID: string; events: PublicEvent[]; next: number | null }> {
    await this.getSession(id);   // 404 NOT_FOUND like messages()
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 256), 1), 1000);
    const events = await this.journal.forSession({ sessionId: id, afterSequence: query.after ?? 0, limit, runId: query.run, type: query.type });
    return { sessionID: id, events, next: events.length === limit ? events.at(-1)!.sequence : null };
  }
  async sessionRuns(id: string): Promise<Run[]> { await this.getSession(id); return this.store.call("runsForSession", { sessionId: id }); }

5) engine.capabilities event, gateway-core.ts immediately after `await this.store.call("bindNative", ...)` (:458), i.e. once per channel open, never on a reused resident channel:
  await this.journal.publish("engine.capabilities", { sessionID: sessionId, runID: run.id, engine: this.engineId, channel: this.channelId,
    native: { engineVersion: channel.native.engineVersion, protocolVersion: channel.native.protocolVersion ?? null },
    capabilities: redactor.json(capabilitiesJson(channel.capabilities)) });
  with `function capabilitiesJson(value: EngineCapabilities): Json { return JSON.parse(JSON.stringify(value)) as Json; }` (EngineCapabilities is plain data). nativeId/resumeToken are deliberately not included. A publish failure fails the run exactly like the other publish sites.

6) src/gateway/app.ts, two routes beside :174:
  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string; run?: string; type?: string } }>("/session/:id/event", async (request) => core.sessionEvents(request.params.id, parseEventQuery(request.query)));
  app.get<{ Params: { id: string } }>("/session/:id/run", async (request) => core.sessionRuns(request.params.id));
  parseEventQuery: after/limit must be non-negative integers (else 400 VALIDATION_ERROR), run and type are strings of at most 200 chars; unknown query keys ignored. Fastify keeps GET /session/status (static) ahead of /session/:id/*; no conflict with GET /event.

Paging contract: `after` is exclusive (same as Last-Event-ID), sequences are hole-tolerant (cascade deletes leave gaps), `next` is the last returned sequence when the page was full, else null. History of a deleted session is gone with the session (FK cascade, documented). The trace id is runID: it is on every event, on the session.status busy frame the moment a run starts, and in GET /session/{id}/run.

**接口面**

GET /session/{id}/event?after=<seq>&limit=<1..1000>&run=<runID>&type=<eventType>
Response 200: {"sessionID":"ses_9c...","events":[{"sequence":131,"type":"session.status","properties":{"sessionID":"ses_9c...","runID":"run_ca...","status":{"type":"busy"}}},{"sequence":133,"type":"engine.extension","properties":{"sessionID":"ses_9c...","runID":"run_ca...","messageID":"73f5...","namespace":"pi","nativeType":"message_end","payload":{"type":"message_end","message":{"role":"assistant","stopReason":"stop","usage":{"input":100,"output":50,"cost":{"total":0.00105}}}}}}],"next":null}
404 {"code":"NOT_FOUND","message":"Session not found."}; 400 {"code":"VALIDATION_ERROR",...} for a non-integer after/limit.

GET /session/{id}/run -> 200 [{"id":"run_ca...","sessionId":"ses_9c...","state":"completed","requestHash":"...","startedAt":"...","finishedAt":"...","nativeStopReason":"stop","taskOutcome":"unknown"}]

New SSE/journal event, once per channel open: {"type":"engine.capabilities","properties":{"sessionID":"ses_...","runID":"run_...","engine":"opencode","channel":"acp","native":{"engineVersion":"1.18.29","protocolVersion":"1"},"capabilities":{"sessionResume":true,"streaming":true,"cancellation":true,"nativeDelete":false,"extensions":[{"id":"acp.session.load","available":true,"evidence":"probed","configuration":"session","control":"none","observation":"native"}, ...]}}}

**测试**

tests/contract/gateway.test.ts new test "per-session history is queryable by session, run and type": create two sessions on MockPack, run one prompt on A and two on B; GET /session/B/event -> 200, events ascending and unique, every properties.sessionID===B, types include session.status, model.resolved, engine.capabilities (exactly one), message.part.updated, session.idle, and none of A's events; GET /session/B/run -> two runs, both state completed; GET /session/B/event?run=<second run id> -> only that run's events and its last type is session.idle; ?type=model.resolved -> exactly two; ?after=<seq of first event> excludes it; ?limit=3 -> 3 events with next === third sequence, and a follow-up ?after=next continues without duplicates; GET /session/unknown/event -> 404; ?after=x -> 400; DELETE B then GET /session/B/event -> 404 (history leaves with the session). tests/unit/core.test.ts new test "engine.capabilities is published once per channel open": run twice on one session -> one engine.capabilities event whose properties.capabilities.extensions is an array and engine==="mock"; assert types.at(-1)==="session.idle" still (invariant). Existing tests/contract/sse.test.ts and engine-contract.ts unchanged and must stay green.

**风险**

Could regress: session.idle-last invariant if the capabilities publish were placed after the run - it is placed at open, before driver events. Could regress: eventsSince paging if rowToEvent extraction changes shape - sse.test.ts:53-96 replay test catches it. Performance: WHERE session_id=? is a table scan until WP-08; judged databases hold one case at a time. json_extract requires SQLite JSON1, built into Node 24's node:sqlite.

**计分理由**

20% architecture: the owner's explicit ask is met with an additive read over already-committed data, touching none of the files ARCHITECTURE.md 5.4 lists as engine-facing. 5% innovation: capability ledger with evidence levels becomes an observable fact in the trace. 5% robustness: lossless history replaces replay-from-0 over a global stream.

### WP-03 · P0 · Pi perception: stop losing what Pi already tells us

**规模** M　**可并行** 是

**问题**

src/drivers/pi-rpc/channel.ts:243-248 returns after text_delta, so thinking_start/delta/end, toolcall_start/delta/end and per-update usage never reach even the native branch (rpc.md 955-990). protocol.ts:92-98 strips message objects to {role,stopReason}, discarding usage/cost/model (rpc.md 1444-1470); grep of `type: "usage"` in pi-rpc: none, and runtime/logs/audit-live-pi-fixed/events.jsonl has 0 run.usage vs OpenCode's per-turn run.usage. protocol.ts:130-134 drops tool_execution_update.partialResult (rpc.md 1025-1055). protocol.ts:178 + channel.ts:293 publish unenumerated frames (entry_appended, thinking_level_changed, summarization_retry_*) as nativeType "unknown". protocol.ts:80 enumerates session_compact_failed which is extension-runner only and never on the wire (failure arrives as compaction_end{result:null,errorMessage}). channel.ts:232-234 silently drops every frame outside a submitted prompt, including startup extension_error from pnp-bridge. channel.ts:300-310 turns fire-and-forget UI methods (notify, setStatus, setWidget, setTitle, set_editor_text; rpc.md:1190-1191) into question.asked interactions that block under PNP_QUESTION_POLICY=ask. channel.ts:217-229 discards the get_state reply except a version field real 0.85.1 does not have; Pi capabilities are a fixed literal (channel.ts:162-172). Pi's own get_session_stats (rpc.md:554-595: tokens, cost, contextUsage.percent) is never read.

**设计**

All changes inside src/drivers/pi-rpc/. No Core change, no contract change, no new command that mutates engine state (get_session_stats and get_state are reads).

protocol.ts:
- PiCommandType: add "get_session_stats".
- interface AssistantMessageEvent { type: string; contentIndex?: number; delta?: string; raw: Json } - raw is the whole decoded assistantMessageEvent object (thinking_end carries content, toolcall_end carries toolCall; verified in pi-ai dist/api/pi-messages.d.ts:57-75).
- PiMessageSummary: add optional usage?: Json; model?: string; provider?: string; api?: string; errorMessage?: string; timestamp?: number. asMessageSummary decodes them by allowlist; `content` is deliberately excluded (the answer text is canonical already and can be large).
- tool_execution_update: add toolName?: string; partialResult?: Json.
- unknown: { type: "unknown"; rawType: string; raw: Json } (rawType = wire type string).
- Remove the session_compact_failed case (a frame of that name would still pass through as unknown under its real name).
- extension_ui_request: add raw: Json (whole frame) for passthrough of fire-and-forget methods.

channel.ts:
- capabilities becomes `get capabilities(): EngineCapabilities { return this.capabilitySnapshot; }` over a private field initialised with today's literal. handshake(): after get_state, `this.capabilitySnapshot = { ...snapshot, extensions: [...snapshot.extensions, { id: "pi.session.state", available: true, configuration: "session", control: "none", observation: "native", evidence: "probed", parameterSchema: pickState(state) }] }` where pickState is an ALLOWLIST: thinkingLevel, steeringMode, followUpMode, autoCompactionEnabled, messageCount, sessionName, model:{id,name,provider,api,contextWindow,maxTokens,reasoning}. Never baseUrl, apiKey, headers or any other key.
- Preflight buffer: `private readonly preflight = { outOfPrompt: 0, kinds: new Map<string, number>(), notices: [] as DriverEvent[] }`. dispatch(): when run===undefined || !run.promptSubmitted -> notePreflight(event): outOfPrompt+=1, kinds[type or rawType]+=1, and if event.type==="extension_error" and notices.length<16 push {type:"native",namespace:"pi",eventName:"extension_error",payload:event}. run(): after the tools.unsupported-transport notice and before `prompt`, emit each buffered notice, then if outOfPrompt>0 emit native updates.unattributed {outOfPrompt, kinds:Object.fromEntries(kinds)}; reset. (Mirrors ACP channel.ts:480-492.)
- handleRunEvent message_update: const ev=event.assistantMessageEvent; if undefined return; switch(ev.type): text_delta -> unchanged (finalText += delta; emit text.delta); thinking_start | toolcall_start | toolcall_end -> emit native message_update payload {assistantMessageEvent: ev.raw, usage: event.usage ?? null}; thinking_delta -> tracker.thinking.set(idx, prev+delta) capped at 256 KiB (set truncated flag, stop appending), return; thinking_end -> emit native message_update payload {assistantMessageEvent: {...ev.raw, content: ev.raw.content ?? accumulated}, usage, ...(truncated?{truncated:true}:{})}, delete accumulator; text_start | text_end | toolcall_delta -> return (text is canonical; arguments arrive whole in toolcall_end). RunTracker gains `thinking: Map<number, { text: string; truncated: boolean }>`.
- tool_execution_update: keep tool.updated; additionally, when partialResult !== undefined, emit native tool_execution_update payload {toolCallId, toolName ?? null, partialResult}.
- message_end: if message.role==="assistant" and usage.input/usage.output are finite numbers -> emit {type:"usage", inputTokens: usage.input, outputTokens: usage.output, source:"engine"} (Pi usage is per assistant message, i.e. already an increment); then fall through to the default native passthrough so cost/model/stopReason stay visible under Pi's own names. turn_end and agent_end pass through with the richer summaries but emit no usage (would double count).
- agent_settled: before settle.resolve: `let stats: Json | undefined; try { stats = await this.client.send("get_session_stats", {}, 3_000); } catch { stats = undefined; /* diagnostic read; a dead or old process just yields no stats */ } if (stats !== undefined) await run.services.events.emit({ type: "native", namespace: "pi", eventName: "session_stats", payload: dropKeys(stats, ["sessionFile"]) });` - emit failures propagate (never swallowed), send failures are tolerated.
- default branch: eventName: event.type === "unknown" ? event.rawType : event.type; payload: event.type === "unknown" ? event.raw : event.
- bridgeInteraction: `const FIRE_AND_FORGET = new Set(["notify","setStatus","setWidget","setTitle","set_editor_text"])`; if the method is in it: build native {eventName: `extension_ui.${method}`, payload: event.raw}; if a prompt is active chain it on run.tracker.queue (ordered, rejection fails the run like handleRunEvent) else notePreflight notice; NEVER call respondUi for these. select/input/editor stay questions, confirm stays permission, exactly as today.

**接口面**

No route change. New engine.extension nativeTypes in namespace pi, all engine vocabulary: message_update (payload.assistantMessageEvent.type in thinking_start|thinking_end|toolcall_start|toolcall_end, with content or toolCall), tool_execution_update {toolCallId,toolName,partialResult}, session_stats {tokens:{input,output,cacheRead,cacheWrite,total},cost,contextUsage:{tokens,contextWindow,percent},...}, extension_ui.notify / extension_ui.setStatus / ... {method,message,notifyType,...}, updates.unattributed {outOfPrompt,kinds}, extension_error (also when it fired before the first prompt), plus previously anonymous frames under their real names (entry_appended, thinking_level_changed, summarization_retry_scheduled, ...). message_end/turn_end/agent_end payloads now carry usage/cost/model/api/provider. New run.usage frames for Pi: {"type":"run.usage","properties":{"sessionID":...,"runID":...,"type":"usage","inputTokens":100,"outputTokens":50,"source":"engine"}}. engine.capabilities (WP-02) for Pi gains extension id pi.session.state with parameterSchema {thinkingLevel,steeringMode,followUpMode,autoCompactionEnabled,model:{id,provider,api,contextWindow}}.

**测试**

tests/adapters/pi/protocol.test.ts: (1) message_update thinking_end decodes with raw.content; (2) tool_execution_update keeps partialResult and toolName; (3) message_end keeps usage/model/provider/api and drops content; (4) unknown frame {type:"thinking_level_changed",level:"high"} -> {type:"unknown",rawType:"thinking_level_changed",raw}; (5) session_compact_failed now decodes as unknown with rawType (documents the removal). tests/adapters/pi/channel.test.ts (fake process fixture): (6) thinking_start/3x thinking_delta/thinking_end -> exactly one native message_update with assistantMessageEvent.content equal to the joined deltas and no text.delta, finalText excludes it; (7) toolcall_start/delta/end -> two natives, none for delta; (8) message_end assistant with usage {input:100,output:50} -> one usage DriverEvent {inputTokens:100,outputTokens:50,source:"engine"} followed by the native message_end whose payload.message.usage.cost.total is present; user-role message_end emits no usage; (9) after agent_settled the next write is get_session_stats; answering it with data -> native session_stats emitted BEFORE run() resolves and payload lacks sessionFile; answering with success:false or never answering (3 s) -> run still resolves completed with no session_stats; (10) extension_ui_request method notify before any prompt -> no extension_ui_response written, and the first run emits native extension_ui.notify before prompt; during a prompt -> native emitted in order, still no response written; select still yields a question interaction and a value response; (11) extension_error pushed before the first prompt -> first run emits native extension_error then updates.unattributed {outOfPrompt:1,kinds:{extension_error:1}}; (12) unknown frame during a prompt -> native eventName === rawType; (13) extend "model credentials never appear...": drive handshake() with a get_state reply containing model:{baseUrl:"https://u:sk-live-DO-NOT-LEAK@h",apiKey:"sk-live-DO-NOT-LEAK",id:"m"} -> JSON.stringify(channel.capabilities) contains pi.session.state and "m" but not the secret or baseUrl. tests/adapters/pi/engine-contract.test.ts (real LocalProcessHost + fake-pi-cli.mjs) must stay green unchanged: fake-pi-cli does not answer get_session_stats, which exercises the tolerated path.

**风险**

Could regress: run settlement latency by up to 3 s if a wedged Pi never answers get_session_stats (bounded, tested in 9). Could regress: event volume - thinking is coalesced on Pi's own end marker and text/toolcall deltas are not forwarded, so per-turn native frames grow by a handful, not hundreds. Could regress: a pi build whose thinking_end lacks content - covered by the accumulator fallback (test 6 drives an end frame without content). The notify change removes a blocking question under ask policy; a third-party extension expecting a response to notify gets none, which is the documented protocol. Boundary script unaffected (driver imports only contracts, runtime, core/errors).

**计分理由**

20% and 5% innovation: Pi's reasoning, cost, context-window usage, retry/summarization and extension diagnostics become visible under Pi's own names, making the two engines' rollouts visibly different in exactly the way the thesis claims. 5% robustness: startup extension failures and stray notifications no longer vanish or block. Protects 70%: run.usage/statistics parity means the e2e/livecheck evidence no longer shows Pi as the engine that reports nothing.

### WP-04 · P1 · ACP perception: advertise what we can perceive, keep thoughts out of the answer

**规模** S　**可并行** 是

**问题**

src/drivers/acp/channel.ts:697 sends clientCapabilities {fs,terminal:false} only; SDK types.gen.d.ts:3991-3995 and 4033-4035: agents MUST only send compaction_update / compaction_summary_chunk when the client advertised ClientSessionCapabilities.compaction, so a spec-compliant OpenCode never shows compaction to this gateway. plan_update/plan_removed are likewise gated on clientCapabilities.plan and boolean config options on session.configOptions.boolean. establishSession (channel.ts:746-762) discards NewSessionResponse.modes. Out-of-turn current_mode_update / available_commands_update / session_info_update are only counted (channel.ts:333-335). updates.ts:117-120 emits thought chunks as text.delta{nativeType}; gateway-core.ts:475-490 appends every text.delta to rawText and :657 uses rawText as the final answer when the engine's final text is empty, so a reasoning-only turn yields an assistant message whose content is the reasoning - the judge reads that.

**设计**

src/drivers/acp/channel.ts:
- initialize params: clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {}, configOptions: { boolean: {} } }, plan: {} }. Pure advertisement of receive ability; the driver already passes every one of those update kinds through the default branch and KNOWN_UPDATE_KINDS (:57-61) already lists them.
- establishSession: after session/new or session/load, `if (created.modes) notices.push({ eventName: "session.modes", payload: toJson(created.modes) })` (same for loaded.modes). Emitted at the first turn by emitNotices like session.restored.
- handleUpdate out-of-turn branch: for sessionUpdate in {current_mode_update, available_commands_update, session_info_update} store the latest update in `this.parts.deferredUpdates: Map<string, Json>` instead of counting it; emitNotices flushes each as native_(kind, update) then clears. Other out-of-turn kinds keep the outOfTurn count.

src/drivers/acp/updates.ts (SessionUpdateMapper):
- private thought: { text: string; chunks: number; truncated: boolean } | undefined;
- case agent_thought_chunk with text: append (cap 256 KiB then truncated=true), sawStreamedContent=true, return { events: [], text: "" }.
- flush(): DriverEvent[] - if thought is set, return [nativeEvent("agent_thought_chunk", { content: { type: "text", text }, chunks, ...(truncated ? { truncated: true } : {}) })] and clear.
- map(): every non-thought kind returns { events: [...this.flush(), ...mapped], text } so the engine's own ordering (thought before the tool call it led to) is preserved.
- channel.execute(): after the prompt settles and turn.drain(), `const trailing = this.mapper.flush(); if (trailing.length > 0 && turn.accepting) await turn.emit(...trailing);` before closeOpenCalls. text.delta{nativeType} is no longer produced by this driver; the contract field stays (optional) for other drivers.

Result: Core's rawText only ever contains answer text, so gateway-core.ts:657 needs no change and Core still branches on nothing engine-specific.

**接口面**

No route change. Initialize wire change: {"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"session":{"compaction":{},"configOptions":{"boolean":{}}},"plan":{}}}. New/changed acp-namespace engine.extension frames: agent_thought_chunk {content:{type:"text",text},chunks} (coalesced per contiguous run of thoughts, never in message.part.updated any more), session.modes {currentModeId,availableModes:[{id,name,description}]}, current_mode_update / available_commands_update / session_info_update also when they arrived between turns, and - from a compliant engine - compaction_update {compactionId,status,summary?,error?} and compaction_summary_chunk, plan_update / plan_removed, exactly as the engine sends them.

**测试**

tests/adapters/acp/handshake.test.ts: extend "initialize negotiates...": request.clientCapabilities.session deepEqual {compaction:{},configOptions:{boolean:{}}} and clientCapabilities.plan deepEqual {}. tests/adapters/acp/updates.test.ts: rewrite :45-51 "a thought chunk is marked..." -> "thoughts are coalesced into one native frame and never enter the text": two agent_thought_chunk updates then one agent_message_chunk "answer" -> services.ofType("text.delta") is exactly [{text:"answer"}], services.native("agent_thought_chunk") has one entry with content.text === joined thoughts and chunks===2, and the emission order is thought-native then text.delta; new case: a turn that streams only thoughts -> after run() resolves one native agent_thought_chunk exists and EngineResult.finalText===""; new case: compaction_update{compactionId:"c1",status:"in_progress"} and compaction_summary_chunk pass through under their own names with payload intact; keep :78-85 (non-text thought degrades to agent_thought_chunk.content). tests/adapters/acp/lifecycle.test.ts (or handshake): session/new answering {sessionId, modes:{currentModeId:"build",availableModes:[{id:"build",name:"Build"}]}} -> first run emits native session.modes with that payload before any prompt; an available_commands_update delivered before run() -> emitted at the next run under its own kind. tests/unit/core.test.ts unaffected; the previously possible reasoning-leak is now structurally impossible (rawText only receives text.delta).

**风险**

Could regress: an engine that changes behaviour when compaction/plan is advertised - it only changes what it sends, and every gated kind is already in KNOWN_UPDATE_KINDS; verify by running `npm run e2e -- --engine opencode` (scripts/e2e/ci-smoke.mjs) and checking event-sequence has no schemaRejectedKinds. Could regress: thought ordering relative to tool calls - preserved by flushing inside map() before every non-thought kind (tested). Could regress: streaming granularity of thoughts - accepted; the durable frame carries the whole thought.

**计分理由**

Protects 70%: the LLM judge reads the final assistant content; reasoning text can no longer be presented as the answer. 20%/5%: the ACP-side compaction/plan/mode perception claim becomes spec-true instead of dependent on an engine violating a MUST.

### WP-05 · P1 · livecheck ninth check native-events and e2e vocabulary evidence

**规模** S　**可并行** 否

**问题**

scripts/e2e/live-check.mjs:577 and :814 record only event TYPE names (`event_types`), and run-e2e.mjs:731-761 the same, so both reports contain "engine.extension" but zero namespace:nativeType detail (runtime/logs/audit-final-*/e2e-report.json: ext payload count 0). INSTRUCTION.md:69-71 already tells the judge to run livecheck for both engines; today the two runs print identical PASS lines, so the one place a judge is told to look shows no engine difference.

**设计**

scripts/e2e/live-check.mjs:
- PLANNED_CHECKS (:257): insert "native-events" after "task3/abort" and before "question-and-permission".
- New check placed after task3/abort:
  await check("native-events", async (evidence) => {
    assert(sessionId !== null, "no session was created");
    const own = events.filter((e) => e.type === "engine.extension" && e.properties?.sessionID === sessionId);
    const tally = {}; for (const e of own) { const k = `${e.properties.namespace}:${e.properties.nativeType}`; tally[k] = (tally[k] ?? 0) + 1; }
    evidence.native_kinds = tally; evidence.native_count = own.length;
    const history = await call("GET", `/session/${sessionId}/event?type=engine.extension&limit=1000`);
    evidence.history = responseEvidence(history);
    assert(history.status === 200 && Array.isArray(history.json?.events), "GET /session/{id}/event must answer {events:[...]}", evidence.history);
    assert(history.json.events.every((e) => e.properties?.sessionID === sessionId), "history must be scoped to the session");
    assert(history.json.events.length >= own.length, "committed history must hold every native frame the live stream delivered", { live: own.length, history: history.json.events.length });
    const caps = await call("GET", `/session/${sessionId}/event?type=engine.capabilities`);
    evidence.engine_capabilities = caps.json?.events?.[0]?.properties ?? null;
    assert(evidence.engine_capabilities !== null, "one engine.capabilities record must exist for the session");
    await writeFile(path.join(artifacts, "native-events.json"), `${redact(JSON.stringify({ engine, tally, capabilities: evidence.engine_capabilities, events: history.json.events }, null, 2))}\n`, "utf8");
    const line = Object.entries(tally).sort().map(([k, n]) => `${k} x${n}`).join(", ");
    process.stdout.write(`       native vocabulary (${engine}): ${line || "(none observed)"}\n`);
  });
  The check asserts presence of the mechanism, not a particular vocabulary: a native_count of 0 is reported, not failed (a short turn on some engine may emit nothing), except that engine.capabilities must exist.
- summary.native_kinds = tally over all events (next to summary.event_types at :814).

scripts/e2e/run-e2e.mjs: in the event-sequence step (:730) add evidence.native_kinds (same tally) and report.native_kinds beside event_types (:760); no new assertion (the mock engine emits no native frames).

INSTRUCTION.md wording for the 8-check sentence is handled in WP-07 (9 checks).

**接口面**

Console output of `.\pnp.cmd livecheck --engine <id>` gains one line per run, e.g. `[PASS] native-events (312ms)` followed by `native vocabulary (pi): pi:message_end x4, pi:message_start x4, pi:message_update x2, pi:session_stats x2, pi:turn_end x2, ...` versus `native vocabulary (opencode): acp:assets.projected x1, acp:session.modes x1, acp:turn.settled x1, ...`. Artifact <artifacts>/native-events.json = {engine, tally, capabilities, events[]} (redacted by the script's existing redact()). e2e-report.json gains native_kinds.

**测试**

No unit test (scripts are exercised by running them). Verification commands: `node scripts/e2e/live-check.mjs --engine pi` and `--engine opencode` against the configured model -> 9/9 PASS and two different vocabulary lines; `npm run e2e -- --engine opencode` and `--engine pi` -> 21 steps, report.native_kinds non-empty for real engines; mock leg unchanged.

**风险**

Depends on WP-02's endpoint; without it the check fails by design (assert on 200). Writes native payloads to the artifacts directory: they may contain prompt text and workspace paths (never credentials: gateway-side redaction plus the script's redact()); artifacts live in the operator's temp dir, same as messages-*.json today.

**计分理由**

20% and 5% innovation: turns the thesis into something the judge sees in the two commands INSTRUCTION.md already prescribes. 5% robustness: the check proves live stream and committed history agree.

### WP-06 · P1 · SSE writer: native frames are evictable, replay honours drain, gaps close from the journal

**规模** S　**可并行** 否

**问题**

src/gateway/app.ts:20 CONTENT_EVENT_TYPES = {message.part.updated} is the only evictable class; :264-277 every engine.extension frame is non-evictable, evicts queued message.part.updated frames to make room, and once the non-evictable backlog exceeds sseMaxBufferedBytes (8 MiB, :116) the writer calls cleanup(true) -> reply.raw.destroy(). Measured share: audit-final-pi event_sequence has 100 engine.extension in the first 400 events; WP-03/04 add more. :33-48 replayMissedEvents emits up to 4096 rows without awaiting drain, so a large gap can destroy the socket during replay and the client reconnects into the same failure. :291-293 drops the 4097th live event during a replay silently, contradicting the comment at :29-31.

**设计**

src/gateway/app.ts:
- export const SSE_EVICTABLE_EVENT_TYPES = new Set<string>(["message.part.updated", "engine.extension"]); isContentEvent uses it. Journal rows are untouched; GET /session/{id}/event (WP-02) is the lossless path and the docs say so.
- Drain awareness inside the /event handler: `const drainWaiters: Array<() => void> = [];` onDrain(): after the queue empties and backpressured===false, resolve and clear drainWaiters; cleanup(): resolve waiters too (replay then observes stopped()). `const drained = (): Promise<void> => (closed || !backpressured) ? Promise.resolve() : new Promise((resolve) => drainWaiters.push(resolve));`
- replayMissedEvents(core, lastEventId, emit, stopped, drained): after each page `await drained();`.
- Gap closing: `let gapped = false;` receive(): during replay push while pendingLive.length < REPLAY_LIMIT, else gapped = true. After the first replay: `for (let round = 0; gapped && round < 3 && !closed; round++) { gapped = false; pendingLive.length = 0; resumed = await replayMissedEvents(core, resumed, send, () => closed, drained); }` then replaying=false and flush pendingLive with sequence > resumed. The journal, not memory, closes the gap; the comment at :29-31 becomes true. If after 3 rounds still gapped, send({type:"server.resync",properties:{lastSequence: resumed}}) once and continue live; documented as the signal to re-read history.

**接口面**

No shape change. Behavioural: under backpressure engine.extension frames may be dropped from the live stream (never from the journal); Last-Event-ID resumes never destroy the connection because of their own volume; a client that fell behind during a long replay receives every committed event in order. Optional control frame {"type":"server.resync","properties":{"lastSequence":N}} only when three replay rounds could not catch up.

**测试**

tests/contract/sse.test.ts: (1) "engine.extension is evictable": assert SSE_EVICTABLE_EVENT_TYPES.has("engine.extension") and !has("session.idle") (pins the classification). (2) "a large replay under a small buffer arrives complete and in order": buildApp(core, { sseMaxBufferedBytes: 32 * 1024 }); publish 1200 session.status events via core.journal.publish, each with a 2 KiB filler property; fetch /event with Last-Event-ID: 0 but wait 300 ms before reading the body; read until id: <last> arrives; assert ids strictly ascending, no duplicates, count === 1200, and the response stream was not destroyed (reader.read() does not throw). Before this package the same test tears the socket down (non-evictable backlog > 32 KiB during unawaited replay). (3) existing :53-96 replay test stays green.

**风险**

Could regress: a live client that relied on engine.extension being non-evictable under backpressure - documented trade, journal keeps the rows. Could regress: replay ordering if the gap loop mis-sets the cursor - test (2) plus the existing replay test catch it. Timing sensitivity of test (2) on a loaded runner: keep volume >= 2 MiB so loopback buffers cannot absorb it silently.

**计分理由**

5% robustness directly; protects 70% because the mandated session.status/idle stream is what a slow judge client must never lose to native volume.

### WP-07 · P0 · Judge-facing documentation: make the native surface and history visible

**规模** M　**可并行** 否

**问题**

INSTRUCTION.md:7-14 lists no docs/ though scripts/package-release.mjs:357-365 ships docs/ARCHITECTURE.md, spec, reference and engines; grep of INSTRUCTION.md for engine.extension, run.usage, model.resolved, diagnostics, Last-Event-ID, ARCHITECTURE: 0 hits; :125 and :153 name only session.status/idle/error; :174 and :196 point the judge to code/runtime/logs, which in a normal deployment holds only gateway stdout; :69 says 8 checks. ARCHITECTURE.md section 6 mentions engine.extension in one bullet with no frame and no asymmetry table. docs/reference/gateway-spec.md:52-64 lists only baseline events. docs/spec/contracts.md:36-55 route table lacks the extension routes. docs/engines/pi.md:113 claims session_compact_failed arrives on the wire.

**设计**

Write against what WP-01..06 built; every frame pasted must be copied from a real run (artifacts native-events.json / events.jsonl), never invented.

INSTRUCTION.md (Chinese, same voice):
1. Tree (:7-14): add `docs/ARCHITECTURE.md  设计记录（方案与架构，评审看这里）` and `docs/spec、docs/engines  契约与逐项证据`.
2. 第 3 步 (:69): "8 项检查" -> "9 项检查", add "native-events：把本轮引擎自己发出的原生事件按 引擎:事件名 统计并打印；两个引擎打印出的词表不同，这就是引擎能力被原样保留的证据".
3. New 第 7 步「看引擎自己在做什么：原生事件与会话历史」between 第 6 步 and 附录 A, containing: (a) event vocabulary table - server.connected/heartbeat, session.status, session.idle, session.error, message.part.updated, question/permission.asked/.resolved, model.resolved {requested,selected,resolution}, run.usage {inputTokens,outputTokens,source}, engine.capabilities {engine,channel,native,capabilities}, engine.extension {namespace,nativeType,payload}; (b) the rule in the owner's words: 上下文压缩、重试、思考、计划等由引擎自己决定与触发，网关不发起、不干预，只感知并记录; 引擎间不做归一化，各自的事件名与载荷原样保留在 engine.extension 里; (c) two real frames side by side: one pi frame (e.g. message_end with usage/cost or session_stats) and one acp frame (e.g. turn.settled or session.modes), plus one sentence naming the compaction frames each engine would emit when it compacts on its own (pi compaction_start{reason}/compaction_end{result.tokensBefore,estimatedTokensAfter}; opencode compaction_update{compactionId,status}) with the honest note that these appear only when the engine itself compacts; (d) history: `Invoke-RestMethod http://127.0.0.1:6217/session/{id}/event?type=engine.extension`, `.../event?run={runID}`, `.../run`, paging with after/next, and that runID (the trace id) is on every event and on session.status busy; (e) `Invoke-RestMethod http://127.0.0.1:6217/diagnostics`; (f) SSE resume with Last-Event-ID and that native frames may be evicted from a slow live connection but never from history.
4. :174 replace the logs sentence: gateway logs in runtime/logs; the engine's own session files are under runtime/data/<引擎>/native/... and are never rewritten by the gateway; what the engine did is answered by GET /session/{id}/message and GET /session/{id}/event.
5. 附录 A :196: point to 第 7 步.

ARCHITECTURE.md: section 6 add the asymmetry table (permission source, compaction, thinking, plan/todo, modes/queue modes, commands, model listing, steering queue, session tree, title, retry, usage - one row each with the engine's own event/command names and the driver path), the two real frames, the sentence that only text/tool call/result/stop reason/usage/permission shape are normalised (contracts/index.ts:66-101) and everything else is namespaced passthrough, and the history endpoint; section 3 step 6 add engine.capabilities; section 3.1 SSE row mention lossless history; section 10 add a row for the native-events livecheck evidence (probed); section 11 add the two routes and WP files.

docs/reference/gateway-spec.md: extend the events table with model.resolved, run.usage, engine.capabilities, engine.extension and a "扩展路由" list (GET /session/{id}/event, GET /session/{id}/run, GET /diagnostics) marked 项目扩展.
docs/spec/contracts.md section 3 table: two rows `GET /session/:id/event` and `GET /session/:id/run` as 本地扩展，只读.
docs/engines/pi.md: fix :113 (session_compact_failed is extension-runner only; failure arrives as compaction_end{result:null,errorMessage}); add the WP-03 perception list (thinking coalescing, usage, session_stats, notify passthrough, preflight notices, pi.session.state capability).
docs/engines/opencode.md: add rows: sessionCapabilities.compaction/configOptions.boolean/plan advertised (declared); compaction_update observed on real 1.18.29: not yet (record the run when it is).

**接口面**

None. Documents the contracts introduced by WP-02 (routes and engine.capabilities), WP-03/04 (native vocabularies), WP-06 (eviction/resume semantics).

**测试**

Documentation is checked by scripts/package-release.mjs (INSTRUCTION.md must exist and the PRIMARY_INSTRUCTIONS credential scan at :182-227 must pass) and by re-running `.\pnp.cmd livecheck --engine pi` / `--engine opencode` and confirming every command in the new 第 7 步 returns what the text says (paste outputs into docs/engines/*.md as probed evidence). Reviewer checklist: no frame in the docs that is not present in a captured artifact; no claim of compaction observation on OpenCode until a run recorded it.

**风险**

Overclaiming: mitigated by the copy-from-artifact rule and the explicit 'appears only when the engine compacts' wording. Stale numbers (9 checks) if WP-05 is not merged - keep the count in one place.

**计分理由**

The cheapest points in the entry: 20% (judge is finally told where the design record is and can verify section 6 with an HTTP client), 5% innovation (namespaced native passthrough is shown, not asserted), 5% robustness (/diagnostics and resume semantics documented).

### WP-08 · P2 · Storage index for per-session history (schema version 2)

**规模** S　**可并行** 否

**问题**

src/storage/worker.ts:45-50 events has only the sequence primary key; `SELECT ... WHERE session_id=? ORDER BY sequence` is a full scan (EXPLAIN QUERY PLAN: SCAN events). worker.ts:17-18 rejects user_version > 1 and creates the schema only at version 0, so an index needs a migration branch. AGENTS.md: SQL version changes are an independent, dual-reviewed change.

**设计**

src/storage/worker.ts:
  const version = Number(...user_version);
  if (version > 2) throw new Error("Database schema is newer than this executable.");
  if (version === 0) { existing CREATE block, but `PRAGMA user_version=2` and add `CREATE INDEX events_by_session ON events(session_id, sequence);` inside the same transaction }
  else if (version === 1) { db.exec("BEGIN IMMEDIATE; CREATE INDEX IF NOT EXISTS events_by_session ON events(session_id, sequence); PRAGMA user_version=2; COMMIT;"); }
Forward-only; no down migration (judge boxes start from an empty runtime/data). eventsForSession's `session_id=? AND sequence>? ORDER BY sequence` then uses the index; the run filter stays json_extract inside the session's slice.

**接口面**

None.

**测试**

tests/unit/runtime.test.ts new test "a version-1 database is migrated forward in place": create a temp DB with node:sqlite executing the exact version-1 DDL (copied verbatim from the old worker) and PRAGMA user_version=1, insert one session and two events, open StateStore on it, call eventsForSession -> both rows; then query `PRAGMA user_version` via a fresh DatabaseSync -> 2 and sqlite_master lists events_by_session; a DB with user_version=3 makes StateStore report unavailable (store.available false after the worker error) rather than corrupting. Existing "SQLite and native session survive a clean process lifecycle" (core.test.ts:254) stays green (new DBs are version 2).

**风险**

Could regress: opening any pre-existing runtime/data database if the migration branch is wrong - the migration test opens a hand-built v1 file. WAL + BEGIN IMMEDIATE keeps the index creation atomic.

**计分理由**

5% robustness at scale only; correctness is already given by WP-02. Kept separate because AGENTS.md requires SQL-version changes to be reviewed on their own.

## 4. 明确拒绝的设计

记录在案，避免以后重新提出。多数是因为违反「只感知不驱动」或会抹平引擎差异。

- **Gateway-managed context compaction: send Pi `compact` / `set_auto_compaction` or ACP `session/set_config_option` for context, or expose a northbound /session/{id}/compact.**
  - 拒绝理由：Violates the owner's rule verbatim (触发上下文压缩应该是agent内部触发了...只要我们网关系统感知到了就可以). Compaction is the engine's decision; the gateway only records compaction_start/compaction_end (pi) and compaction_update (acp) when the engine emits them.
- **A canonical cross-engine event family (e.g. context.compacted, reasoning.delta, plan.updated) mapped from both engines' native frames.**
  - 拒绝理由：The lowest-common-denominator failure the entry argues against: Pi's compaction carries reason/tokensBefore/estimatedTokensAfter/usage and ACP's carries an ID-addressed status with patch semantics; a shared schema would drop one or invent the other. Namespaced passthrough keeps both whole; consumers filter on namespace:nativeType.
- **Exposing engine-internal controls northbound: ACP session/set_mode, Pi set_thinking_level / set_steering_mode / set_auto_retry / steer / follow_up.**
  - 拒绝理由：Gateway-side control over engine internals (要保持各个引擎各自本身的能力 means the engine keeps deciding). The driver perceives thinking_level_changed, queue_update, auto_retry_* and session.modes instead.
- **Rendering Pi/ACP reasoning as a `reasoning` part in GET /session/{id}/message via a new text.delta.kind contract field interpreted by Core.**
  - 拒绝理由：Requires a public contract change plus Core interpretation of engine semantics, and normalises reasoning across engines. WP-03/04 keep reasoning under each engine's own frame names in engine.extension with zero Core change, and it stops leaking into the answer.
- **Building history by parsing the engines' own files (Pi session.jsonl, OpenCode's xdg-data SQLite) or exposing their paths through the API.**
  - 拒绝理由：The engine owns its history format and resume mechanism (ACP session/load, Pi --session); the gateway's history is what it perceived. Parsing engine files couples the gateway to engine internals and versions; exposing the private data root adds nothing a judge needs.
- **Accepting a caller-supplied trace_id in the prompt body and storing it on runs/events.**
  - 拒绝理由：PromptRequest is a public contract type (independent dual-reviewed change) and nothing in the competition client sends one that must be honoured (schemas.ts:1-6 deliberately ignores it). runID already is the trace: it is on every event, on session.status busy, and listable via GET /session/{id}/run. Revisit only if a real caller needs correlation with its own ids.
- **Returning the run id on the mandated POST /session/{id}/prompt_async (header on the 204).**
  - 拒绝理由：Touches a mandated route for no functional gain: the run id is published on the session.status busy frame before the engine starts and is listable afterwards.
- **Retaining events after DELETE /session/{id} (dropping the FK cascade) so history survives teardown.**
  - 拒绝理由：Changes deletion semantics the contract spec fixes (DELETE removes gateway data and native history) and the judged workload deletes each case's session by design; an operator who wants a keepsake fetches GET /session/{id}/event before deleting, which WP-05 does automatically into the artifacts directory.
- **Batching native events into one journal row, or publishing engine.extension fire-and-forget to cut fsync cost.**
  - 拒绝理由：Breaks publication-follows-commit (gateway-core.ts:744) and the ordering the SSE contract tests rely on; volume is bounded instead by driver-side coalescing on the engine's own end markers (WP-03/04) and by SSE eviction (WP-06).
- **Reading Pi get_available_models / get_commands / get_available_thinking_levels at open() into the capability snapshot.**
  - 拒绝理由：Perception, so not wrong, but low value now: none of it changes a rollout and each pull is another place a real 0.85.1 shape must be probed. Deferred; pi.session.state from the already-sent get_state gives the comparable honesty.
- **A ?session= filter on the mandated GET /event stream.**
  - 拒绝理由：Harmless but unnecessary once GET /session/{id}/event exists; the mandated stream keeps its global semantics untouched.

## 5. 给评委的演示

PowerShell on the judge box (INSTRUCTION.md 第 4 步 already has the gateway running). Run the block once per engine; only the first line changes.

$env:AGENT_ENGINE = 'pi'          # second pass: 'opencode'
# window 1: .\gateway.cmd     (Ctrl+C it between passes)
# window 2:
do { Start-Sleep 2; $ready = try { (Invoke-RestMethod http://127.0.0.1:6217/health/ready).status } catch { '' } } until ($ready -eq 'ready')
$s = Invoke-RestMethod -Method Post http://127.0.0.1:6217/session -ContentType 'application/json' -Body '{"title":"native-demo","directory":"D:/pnp-demo"}'
Invoke-RestMethod -Method Post "http://127.0.0.1:6217/session/$($s.id)/prompt_async" -ContentType 'application/json' -Body '{"parts":[{"type":"text","text":"在工作目录新建 hello.txt，内容只有一行 hello；写完后用一句话说明你做了什么。"}],"model":{"providerID":"any","modelID":"any"}}'
(Invoke-RestMethod "http://127.0.0.1:6217/session/$($s.id)/event?type=engine.extension&limit=1000").events | Group-Object { "$($_.properties.namespace):$($_.properties.nativeType)" } | Sort-Object Name | Format-Table Count, Name
(Invoke-RestMethod "http://127.0.0.1:6217/session/$($s.id)/event?type=engine.capabilities").events[0].properties | ConvertTo-Json -Depth 6
Invoke-RestMethod "http://127.0.0.1:6217/session/$($s.id)/run" | Format-Table id, state, nativeStopReason
(Invoke-RestMethod "http://127.0.0.1:6217/session/$($s.id)/message")[-1].info

What the judge sees change between the two passes, with the same API, the same prompt and no engine-specific request: the vocabulary table (pi:message_update / pi:message_end / pi:session_stats / pi:turn_end / pi:agent_start ... versus acp:assets.projected / acp:session.modes / acp:turn.settled / acp:agent_thought_chunk ...), the capabilities record (pi.session.state{thinkingLevel,steeringMode,followUpMode,autoCompactionEnabled,model} versus the 17-entry ACP ledger with declared/probed/verified evidence), the engine's own stop reason (info.nativeFinish stop/aborted versus end_turn/cancelled) beside the identical normalised info.finish, and per-engine usage/cost frames under each engine's own field names. If either engine compacts during the run, its own compaction frames appear in the same table (pi compaction_start/compaction_end with token numbers; opencode compaction_update) without the gateway having asked for it. One-command form after WP-05: `.\pnp.cmd livecheck --engine pi` then `.\pnp.cmd livecheck --engine opencode` - the [PASS] native-events line prints each engine's vocabulary.

## 6. 不能破坏的性质

- The 16 mandated routes keep their paths, bodies, status codes and response shapes (POST /session 200, prompt_async 204 after a real terminal state, abort/stop {ok:true}, DELETE {ok:true}, GET /session/status, /session/{id}, /session/{id}/message, /event SSE, question/permission list and reply).
- session.idle is the last event of every run and publication follows commit (tests/kit/engine-contract.ts:25, gateway-core.ts:744); nothing is published after idle and no event is batched or fire-and-forget.
- engine.extension keeps property names namespace / nativeType / payload plus sessionID / runID / messageID; DriverEvent native shape {type,namespace,eventName,payload} is only ever extended with optional fields.
- Core and Gateway contain no engine-name branch and import no engine SDK; adapters import no Fastify, node:sqlite, GatewayCore, src/storage, src/gateway, src/config or child_process (scripts/check-boundaries.mjs must print PASS).
- AGENTS.md code rules: TypeScript strict, ESM, no any, no TS enum, no constructor parameter properties, no unobserved Promise, no empty catch hiding a business failure; npm ci with the existing lockfile; no new dependency.
- Credentials never reach events, files or errors: tests/adapters/pi/channel.test.ts:333-347 and the opencode native-config tests stay green; the redactor still blanks every string-valued authorization/apiKey/password/secret/token and known secret values (WP-01 test b).
- Existing gate: 478 unit/adapter tests, 10 contract tests, foundation:check, strip-only check, PowerShell encoding check, e2e 21 steps on both real engines and livecheck 8 (becoming 9) checks all pass.
- user_version stays 1 in every package except WP-08, and WP-08 opens an existing version-1 database without data loss.
- Offline deployability on a judge's Windows box: no network, no internal model, no new binary; Node 24 bundled as today.
- Deletion semantics: DELETE removes only gateway records and engine-owned native history; the workspace directory and task products are untouched (livecheck session/delete check).
- The Pi driver still settles only on agent_settled or process exit; the ACP driver still settles only on the session/prompt response; cancel ACK is never stop evidence.
- Redaction of native payloads stays on the Core path (gateway-core.ts:608 redactor.json) - drivers never write payloads to disk or logs themselves.

## 7. 实施状态

截至 2026-09-09，本设计中已落地的部分见 git 历史（`fix(perception)`、`feat(gateway)` 两个提交）：
WP-01 脱敏、WP-02 的按会话事件查询与 schema v2 索引、WP-06 的 SSE 缺口通知已实现并验证。
**WP-03（Pi 感知补全）、WP-04（ACP 思考不入答案 / 已声明压缩能力的另一半）、WP-05（livecheck 原生事件项）、
WP-07（评委文档）、WP-08 尚未实现。**
