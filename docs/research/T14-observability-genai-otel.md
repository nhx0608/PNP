# T14 Agent 可观测：OTel GenAI 语义约定、各引擎的埋点/日志与统一事件协议设计

> 调研日期：2026-09-04。本文以一手资料（官方文档/规范/GitHub）为准，标注"已确认"与"推测"，关键断言标注 [已交叉验证]。

## 摘要

1. **OTel GenAI 语义约定**已迁到独立仓库 `open-telemetry/semantic-conventions-genai`，2026-09 仍整体处于 Development（无任何 `gen_ai.*` 属性 GA）。Agent 侧定义了 `create_agent / invoke_agent / invoke_workflow / plan / execute_tool` 五类 span，会话键为 `gen_ai.conversation.id`，推理细节以 `gen_ai.client.inference.operation.details` 事件（`gen_ai.input.messages/output.messages/system_instructions` 结构化 parts）承载，新增 `gen_ai.conversation.compacted` 事件、memory 操作名和 `gen_ai.invoke_agent.*`/`gen_ai.execute_tool.duration` 指标。
2. **第三方平台**（OpenInference/Langfuse/OpenLLMetry 等）都收敛为"span 树 + kind 枚举 + session/user id + usage/cost + score"，只是字段名不同；Langfuse 与 Phoenix 均可直接吃 OTLP。
3. **引擎原生埋点差异大**：Claude Code（最完整：metrics+events+beta traces，逐次权限决策、成本、TRACEPARENT 传播）、Codex（OTLP logs/traces，无 cost，mcp-server 模式零遥测）、Gemini CLI（OTLP 三信号+GenAI 指标，但 `logPrompts` 默认 true）、OpenClaw（官方 diagnostics-otel，session key 故意脱敏）、dsh（内置 OTLP logs 但默认发厂商端点，有可换后端 seam）、opencode（无原生 OTel，靠 plugin event hook）、pi（RPC JSONL 事件自带 usage/cost）、Hermes（Langfuse 插件，metadata/sanitized/full 三级脱敏）。
4. **设计建议**：以 `agw.*` 作为网关内部稳定 schema（run/turn/step.llm/step.tool/permission/error/cost/artifact/memory.compact），导出时映射到 `gen_ai.*` span/metric；采用"适配器解析事件流为主、原生 OTLP 直通为辅、日志文件回放兜底"三策略；trace 上下文由网关生成并通过 `TRACEPARENT` env/`OTEL_RESOURCE_ATTRIBUTES` 注入子进程（目前仅 Claude Code `-p`/SDK 模式真正读取）；隐私分 L0-L3 四级并映射到各引擎的内容开关；在网关做尾采样与序号。

## 关键事实（表格）

| # | 事实 | 来源 | 置信度 | 交叉验证 |
|---|------|------|--------|----------|
| 1 | OTel GenAI 语义约定已从 `semantic-conventions` 主仓迁出到独立仓库 `open-telemetry/semantic-conventions-genai`；opentelemetry.io 上旧的 gen-ai 页面仅剩"已迁移"提示 | https://opentelemetry.io/docs/specs/semconv/gen-ai/ ; https://github.com/open-telemetry/semantic-conventions-genai | 高 | [已交叉验证]（两处一致） |
| 2 | Agent spans 规范定义 `create_agent`、`invoke_agent`（CLIENT/INTERNAL 两种）、`invoke_workflow`、`plan`、`execute_tool` 五类 span，全部 **Development** 状态；`gen_ai.operation.name` Required，`gen_ai.provider.name` Required；引用主仓 v1.44.0 | raw docs/gen-ai/gen-ai-agent-spans.md | 高 | [已交叉验证] Gemini CLI telemetry.md 使用同名属性 `gen_ai.operation.name`(tool_call/llm_call/agent_call)、`gen_ai.agent.name`、`gen_ai.conversation.id` |
| 3 | 会话/记忆相关新操作名：`create_memory`、`create_memory_store`、`delete_memory` 等出现在 `gen_ai.operation.name` 枚举中；事件层新增 `gen_ai.conversation.compacted` 事件与 `gen_ai.evaluation.*` 属性 | raw gen-ai-agent-spans.md / gen-ai-events.md | 高 | 单一一手来源 |
| 4 | 事件 `gen_ai.client.inference.operation.details` 用聚合属性 `gen_ai.system_instructions` / `gen_ai.input.messages` / `gen_ai.output.messages` 取代了旧的逐消息事件；均为 Opt-In | raw gen-ai-events.md ; openobserve/greptime 博客 | 高 | [已交叉验证]（Gemini CLI 也直接发出该事件名） |
| 5 | GenAI metrics：`gen_ai.client.token.usage`(Histogram,{token})、`gen_ai.client.operation.duration`(Histogram,s)、`gen_ai.client.operation.time_to_first_chunk`、`time_per_output_chunk`、`gen_ai.server.*`、以及新增 `gen_ai.invoke_agent.duration` / `.inference_calls` / `.tool_calls`、`gen_ai.invoke_workflow.duration`、`gen_ai.execute_tool.duration`；全部 Development | raw gen-ai-metrics.md | 高 | [已交叉验证] Gemini CLI/OpenClaw/dsh 插件均发出前两个指标 |
| 6 | Claude Code：`CLAUDE_CODE_ENABLE_TELEMETRY=1` + 标准 `OTEL_*_EXPORTER`；metrics `claude_code.session.count/lines_of_code.count/pull_request.count/commit.count/cost.usage/token.usage/code_edit_tool.decision/active_time.total`；events `claude_code.user_prompt/assistant_response/tool_result/api_request/api_error/api_refusal/tool_decision/permission_mode_changed/auth/mcp_server_connection/api_request_body/api_response_body` | https://code.claude.com/docs/en/monitoring-usage | 高 | [已交叉验证] 与 opencode-plugin-otel README "mirroring the same signals as Claude Code" 一致 |
| 7 | Claude Code Traces（beta）：`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` + `OTEL_TRACES_EXPORTER`；span 树 `claude_code.interaction` → `claude_code.llm_request` / `claude_code.tool`(→ `.blocked_on_user`, `.execution`) / `claude_code.hook`；Bash 子进程继承 `TRACEPARENT`，`-p`/SDK 会话读取入站 `TRACEPARENT`/`TRACESTATE`，交互会话忽略 | 同上 | 高 | 单一一手来源（官方） |
| 8 | Codex：`~/.codex/config.toml` `[otel]` `exporter`(none/otlp-http/otlp-grpc)、`trace_exporter`、`environment`、`log_user_prompt`；事件 `codex.conversation_starts/api_request/sse_event/websocket_request/websocket_event/user_prompt/tool_decision/tool_result`；`service.name=codex-cli` | https://learn.chatgpt.com/docs/config-file/config-advanced | 高 | [已交叉验证] 第三方 codex.danielvaughan.com 及 SigNoz 文档同列 |
| 9 | Codex `mcp-server` 入口不发任何遥测，`codex exec` 无 metrics（issue #12913） | https://github.com/openai/codex/issues/12913 ; danielvaughan 博客 | 中 | 二手+issue 标题 |
| 10 | Gemini CLI：`.gemini/settings.json` `telemetry.{enabled,target(gcp/local),otlpEndpoint(默认 http://localhost:4317),otlpProtocol(grpc/http),outfile,logPrompts(默认 true),useCollector,traces}`，对应 `GEMINI_TELEMETRY_*` env；事件 `gemini_cli.tool_call/api_request/api_response/api_error/user_prompt/agent.start/agent.finish/hook_call/model_routing…`；同时发 `gen_ai.client.inference.operation.details` | raw docs/cli/telemetry.md | 高 | [已交叉验证]（搜索结果多站一致） |
| 11 | OpenClaw：官方 `diagnostics-otel` 扩展；配置 `diagnostics.otel.{enabled,endpoint,protocol(仅 http/protobuf),serviceName,traces,metrics,logs,logsExporter(otlp/stdout/both),sampleRate,captureContent,headers}`；span `openclaw.model.call/openclaw.run/openclaw.tool.execution/…`，metrics `openclaw.tokens/openclaw.cost.usd/openclaw.queue.lane.*/openclaw.session.*`；会话 key 默认脱敏不导出 | https://docs.openclaw.ai/gateway/opentelemetry | 高 | [已交叉验证]（GitHub extensions/diagnostics-otel、SigNoz 博客） |
| 12 | opencode：无原生 OTel（issue #14697 已关闭，社区插件 `@devtheops/opencode-plugin-otel`、`opencode-otel` 填补）；插件 `event` hook 可订阅 `session.*`、`message.part.updated`、`tool.execute.before/after`、`permission.asked/replied`、`file.edited` 等 | https://opencode.ai/docs/plugins/ ; issue #14697 | 高 | [已交叉验证] |
| 13 | pi：`--rpc` JSONL 事件流 `agent_start/agent_end/turn_start/turn_end/message_*/tool_execution_start/update/end/compaction_*/auto_retry_*/extension_ui_request`；assistant message 自带 `usage.{input,output,cacheRead,cacheWrite,cost.total}`；session 为 append-only JSONL 树(id/parentId) | raw packages/coding-agent/docs/rpc.md | 高 | 一手来源 |
| 14 | Hermes：内置 `plugins/observability/langfuse` 插件（`hermes plugins enable observability/langfuse`），env `HERMES_LANGFUSE_{PUBLIC_KEY,SECRET_KEY,BASE_URL,SAMPLE_RATE,MAX_CHARS,CAPTURE(metadata/sanitized/full),ENV,RELEASE,DEBUG}`；一 turn 一 span、一 API 调用一 generation、一工具一 observation；fail-open | raw plugins/observability/langfuse/README.md ; langfuse.com/integrations/other/hermes | 高 | [已交叉验证] |
| 15 | dsh：内置 `dsh-session-telemetry-otel` 插件（`DSH_TELEMETRY_MODE=FULL/DISABLED`，`DSH_TELEMETRY_DISABLED` 硬关），把 session 事件投影成 OTLP/HTTP **logs** 发往 DeepSeek 端点；有公开"telemetry seam"可换后端（社区 `dsh-plugin-langfuse`、`dsh-trace`）；session 为 append-only 日志 | signoz.io/docs/deepseek-harness-observability ; github linyp/dsh-plugin-langfuse | 中 | 二手（SigNoz）+社区仓库 README 摘要 |
| 16 | OpenInference：`openinference.span.kind` ∈ {LLM, EMBEDDING, CHAIN, RETRIEVER, RERANKER, TOOL, AGENT, GUARDRAIL, EVALUATOR, PROMPT}；`llm.token_count.{prompt,completion,total}`、`llm.cost.*`、`input.value/output.value`、`session.id`、`graph.node.*` | raw spec/semantic_conventions.md | 高 | [已交叉验证]（arize 文档） |
| 17 | Langfuse 三层：Session → Trace → Observation(span/generation/event/agent/tool/chain/retriever/evaluator/embedding/guardrail)，Score 可挂 trace/observation/session；接收 OTLP | langfuse.com/docs/observability/data-model ; observation-types | 高 | [已交叉验证] |

## 架构与工作原理

### 1. OpenTelemetry GenAI 语义约定现状（2026-09）

**组织形态**：GenAI SIG（2024-04 成立）已把 GenAI 约定从 `open-telemetry/semantic-conventions` 主仓拆到独立仓库 `open-telemetry/semantic-conventions-genai`（opentelemetry.io 上 `/docs/specs/semconv/gen-ai/*` 全部只剩"已迁移"提示；文档中交叉引用主仓 v1.44.0）。这意味着 GenAI 约定的发布节奏独立于主 semconv，**版本号不再与 semconv 1.x 对齐**，做归一化时要固定引用 semconv-genai 的 commit/tag 而非"semconv 1.3x"。

**稳定性**：截至本次抓取，agent spans、events、metrics 三份文档标题状态均为 `Development`；表格内除 `error.type`、`server.address/port` 等复用自主仓的属性是 Stable 外，**所有 `gen_ai.*` 属性均为 Development**。也就是说，2026 年内没有任何 `gen_ai.*` 属性已 GA。（已确认，一手：raw gen-ai-agent-spans.md）

**Span 模型**（gen-ai-agent-spans.md，已确认）：

| span | `gen_ai.operation.name` | span name | kind | 关键属性 |
|---|---|---|---|---|
| Create agent | `create_agent` | `create_agent {gen_ai.agent.name}` | CLIENT | `gen_ai.agent.{id,name,description,version}`、`gen_ai.request.model`、`gen_ai.system_instructions`(Opt-In) |
| Invoke agent (client) | `invoke_agent` | `invoke_agent {gen_ai.agent.name}` | CLIENT | 加 `gen_ai.conversation.id`、`gen_ai.data_source.id`、`gen_ai.output.type`、`gen_ai.usage.{input,output}_tokens`、`gen_ai.usage.cache_read/cache_write.input_tokens`、text/image/audio 细分 token、`gen_ai.input.messages`/`gen_ai.output.messages`/`gen_ai.tool.definitions`(Opt-In) |
| Invoke agent (internal) | `invoke_agent` | 同上 | INTERNAL | 本地框架内的 agent 循环 |
| Invoke workflow | `invoke_workflow` | `invoke_workflow {gen_ai.workflow.name}` | INTERNAL | `gen_ai.conversation.id`、input/output messages |
| Plan | `plan` | `plan {gen_ai.agent.name}` | INTERNAL | 规划步骤 |
| Execute tool | `execute_tool` | `execute_tool {gen_ai.tool.name}` | INTERNAL | `gen_ai.tool.name`、`gen_ai.tool.call.id`、`gen_ai.tool.description`、`gen_ai.tool.type` |

`gen_ai.operation.name` 枚举还包含 `chat`、`generate_content`、`text_completion`、`embeddings`，以及 **记忆操作** `create_memory_store`、`create_memory`、`delete_memory`（等，枚举被截断）——这是 2026 年 agentic SIG 新增的方向：把 memory 当一等操作建模。

**Events**（gen-ai-events.md）：核心事件名 `gen_ai.client.inference.operation.details`（一次推理的完整细节，含 `gen_ai.input.messages`/`gen_ai.output.messages`/`gen_ai.system_instructions` 的结构化 JSON），以及新增 `gen_ai.conversation.compacted`（上下文压缩事件，直接对应各 CLI 的 compaction）。属性集中还出现 `gen_ai.evaluation.{name,result,score.value,score.label,explanation}`、`gen_ai.prompt.{name,version,variable.*}`、`gen_ai.request.reasoning.level`、`gen_ai.request.previous_response.id`、`gen_ai.response.time_to_first_chunk`、`gen_ai.usage.reasoning.output_tokens`。旧的 `gen_ai.content.prompt`/`gen_ai.completion`/逐消息 `gen_ai.user.message` 等事件已废弃（二手：openobserve/greptime 博客，与一手事件文档一致）。

**Metrics**（gen-ai-metrics.md，已确认）：客户端 `gen_ai.client.token.usage`(Histogram, `{token}`)、`gen_ai.client.operation.duration`(Histogram, `s`)、`gen_ai.client.operation.time_to_first_chunk`、`gen_ai.client.operation.time_per_output_chunk`；服务端 `gen_ai.server.request.duration`、`time_per_output_token`、`time_to_first_token`；**agent 级** `gen_ai.invoke_agent.duration`、`gen_ai.invoke_agent.inference_calls`、`gen_ai.invoke_agent.tool_calls`、`gen_ai.invoke_workflow.duration`、`gen_ai.execute_tool.duration`。

**Messages JSON schema**：`gen_ai.input.messages` 采用 `[{role, parts:[{type:text|tool_call|tool_call_response, ...}]}]` 结构，`gen_ai.system_instructions` 采用 `[{type:text, content}]`，仓库内有 JSON schema（`model/gen-ai/gen-ai-system-instructions.json`）。这一 parts 结构可以直接作为我们统一事件里 message 内容的规范格式。

### 2. 第三方数据模型对照

| 平台 | 顶层容器 | 节点类型 | 评分/评估 | 传输 | 备注 |
|---|---|---|---|---|---|
| OpenInference (Arize/Phoenix) | trace（`session.id`、`user.id` 属性做会话聚合） | `openinference.span.kind` ∈ LLM/EMBEDDING/CHAIN/RETRIEVER/RERANKER/TOOL/AGENT/GUARDRAIL/EVALUATOR/PROMPT | Phoenix 侧 evaluation/annotation（推测） | 标准 OTLP span | 属性前缀 `llm.*`（`llm.model_name`、`llm.token_count.{prompt,completion,total}`、`llm.cost.{prompt,completion,total}`、`llm.input_messages`、`llm.tools`、`llm.invocation_parameters`、`llm.provider`、`llm.system`）、`tool.name`、`input.value`/`output.value`、`graph.node.{id,name,parent_id}`、`agent.name`、`metadata`、`tag.tags`。已确认 |
| OpenLLMetry (Traceloop) | workflow | `traceloop.span.kind` ∈ workflow/task/agent/tool（装饰器 @workflow/@task/@agent/@tool） | 无内置 | OTLP | 早期用 `llm.request.type`、`gen_ai.prompt.N.content` 等扩展；Traceloop 参与 OTel SIG，属性逐步向 `gen_ai.*` 收敛（二手：traceloop 文档摘要/MLflow 映射页） |
| Langfuse | Session → Trace → Observation（可嵌套，`parentObservationId`） | observation.type ∈ span/generation/event/agent/tool/chain/retriever/evaluator/embedding/guardrail | Score（挂在 trace/observation/session/dataset run；LLM-as-judge、标注队列、API） | 原生 SDK 或 OTLP（`/api/public/otel`），`user_id/session_id/tags/metadata` 在 trace 级、自动传播到全部 observation | 已确认（data-model、observation-types 页） |
| LangSmith | Project → Run（tree of runs） | run_type ∈ llm/chain/tool/retriever/prompt/parser/embedding | Feedback（key/score/comment） | SDK / OTLP 端点 | **推测（训练知识，未联网核实）** |
| AgentOps | Session → Agent/LLM/Tool/Action events | 自有 `agentops.*` 属性 + OTel | 无内置评分 | OTel SDK 上报 | **推测** |
| Braintrust | Experiment/Project → Span（type: llm/tool/task/function/scorer/eval） | spans | Scores（scorer 函数）；强调 eval | SDK / OTLP | **推测** |
| W&B Weave | Project → Call（op tree） | `weave.op` 调用树，attributes/summary | Feedback/Evaluation | SDK / OTLP | **推测** |

结论：所有主流平台都收敛到"**层级 span 树 + 一个 kind 枚举 + 会话/用户 ID + usage/cost + score**"这一形态，差异只在字段命名。这正是我们统一事件 schema 可以取交集的基础。

## 可编程接入面（各引擎原生埋点：能拿到什么信号）

下表按"信号类别 × 引擎"归纳，✓=原生提供，◐=部分/需插件，✗=无。

| 引擎 | 开启方式 | 传输/格式 | token | cost | tool 调用 | permission 决策 | error | latency | 会话 ID | 内容(prompt/输出) |
|---|---|---|---|---|---|---|---|---|---|---|
| Claude Code | env `CLAUDE_CODE_ENABLE_TELEMETRY=1`、`OTEL_METRICS_EXPORTER/OTEL_LOGS_EXPORTER/OTEL_TRACES_EXPORTER`(otlp/console/prometheus)、`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` | OTLP metrics + log events + spans(beta)；`OTEL_EXPORTER_OTLP_PROTOCOL` grpc/http/json/http/protobuf | ✓ `claude_code.token.usage{type=input/output/cacheRead/cacheCreation}`；event `api_request.{input,output,cache_read,cache_creation}_tokens` | ✓ `claude_code.cost.usage`(USD)；`api_request.cost_usd/cost_usd_micros` | ✓ `claude_code.tool_result{tool_name,tool_use_id,success,duration_ms,error_type,tool_input_size_bytes}`；span `claude_code.tool` | ✓ `claude_code.tool_decision{decision,source=config/hook/user_permanent/user_temporary/user_abort/user_reject,tool_source}`、`claude_code.permission_mode_changed{from_mode,to_mode,trigger}`、span `claude_code.tool.blocked_on_user` | ✓ `claude_code.api_error{status_code,attempt}`、`api_refusal` | ✓ `api_request.duration_ms`、span `ttft_ms` | ✓ `session.id` 全信号；`prompt.id`、`message.uuid`、`agent_id/parent_agent_id`、`workflow.run_id` | 默认脱敏；`OTEL_LOG_USER_PROMPTS=1`、`OTEL_LOG_ASSISTANT_RESPONSES=1`、`OTEL_LOG_TOOL_DETAILS=1`、`OTEL_LOG_TOOL_CONTENT=1`、`OTEL_LOG_RAW_API_BODIES=1|file:<dir>` |
| Codex | `~/.codex/config.toml` `[otel] exporter="otlp-http"|"otlp-grpc"`、`trace_exporter`、`log_user_prompt`；`[otel.exporter.otlp-http] endpoint/protocol=binary|json/headers`；gRPC 支持 mTLS `tls.*`（二手） | OTLP **logs**（事件）+ traces；`service.name=codex-cli`、`env`、`conversation.id`、`app.version` | ✓ `codex.sse_event` 携带 input/output/cached/reasoning tokens | ✗（需自行按模型价目计算） | ✓ `codex.tool_result{success,duration,output excerpt}` | ✓ `codex.tool_decision{approved/denied/abort, source}` | ◐ `codex.api_request` 含 HTTP status/attempt | ✓ `codex.api_request` duration | ✓ `conversation.id` | `log_user_prompt=false` 默认脱敏 |
| Gemini CLI | `.gemini/settings.json` `telemetry.enabled=true`、`target=local|gcp`、`otlpEndpoint`(默认 `http://localhost:4317`)、`otlpProtocol=grpc|http`、`outfile`(写本地 JSON 文件)、`traces=true`；env `GEMINI_TELEMETRY_*` 覆盖 | OTLP logs + metrics + traces；同时发 GenAI semconv 名称 | ✓ `gemini_cli.token.usage{input,output,thought,cache,tool}` + `gen_ai.client.token.usage` | ✗ | ✓ `gemini_cli.tool_call` 事件、`gemini_cli.tool.call.count/latency` | ◐ `approval_mode_switch/approval_mode_duration/plan_execution` 事件（模式级，非逐次决策） | ✓ `gemini_cli.api_error`、`malformed_json_response`、`flash_fallback` | ✓ `gemini_cli.api.request.latency`、`model_routing.latency` | ✓ `gen_ai.conversation.id`（span） | `telemetry.logPrompts` **默认 true**（与 Claude/Codex 相反，接入时须显式关掉） |
| opencode | 无原生 OTel；社区插件 `@devtheops/opencode-plugin-otel`（env `OPENCODE_ENABLE_TELEMETRY=1`、`OPENCODE_OTLP_ENDPOINT`、`OPENCODE_OTLP_PROTOCOL`，"mirror Claude Code signals"）；官方能力是 **plugin event hook** + server SSE | JS 插件 `event` hook：`session.created/updated/idle/error/compacted/status`、`message.updated`、`message.part.updated`、`tool.execute.before/after`、`permission.asked/replied`、`file.edited`、`command.executed`、`lsp.client.diagnostics` 等；`client.app.log()` 结构化日志 | ◐ 由 `message.updated` 里的 assistant message 拿到 tokens/cost（推测：opencode message 结构含 `tokens`、`cost` 字段） | ◐ 同上 | ✓ `tool.execute.before/after` | ✓ `permission.asked/replied` | ✓ `session.error` | ◐ 自行用 before/after 时间差 | ✓ sessionID 在所有事件中 | 插件自行决定 |
| pi | `pi --rpc`（stdin/stdout JSONL）或 `--mode json`；SDK 也可直接订阅 | JSONL 事件：`agent_start/agent_end/agent_settled`、`turn_start/turn_end`、`message_start/update/end`、`tool_execution_start/update/end{toolCallId,partialResult,result}`、`compaction_start/end{reason}`、`auto_retry_start/end{attempt,maxAttempts,delayMs}`、`queue_update`、`extension_error`、`extension_ui_request` | ✓ assistant `usage.{input,output,cacheRead,cacheWrite}` | ✓ `usage.cost.{input,output,cacheRead,cacheWrite,total}`（引擎自算） | ✓ tool_execution_* | ◐ 无独立 permission 事件；`extension_ui_request` 承载扩展确认对话（推测可映射） | ✓ `auto_retry_*`、`extension_error`、agent_end 的错误消息 | ◐ 时间差 | ✓ `get_state.sessionId/sessionFile`；session JSONL 树（id/parentId，可分支） | 全量在事件里，脱敏由网关做 |
| Hermes | `hermes plugins enable observability/langfuse` + env `HERMES_LANGFUSE_{PUBLIC_KEY,SECRET_KEY,BASE_URL}` | 走 Langfuse SDK（非 OTLP），也可通过 Langfuse OTLP；插件 hook：pre/post_api_request、pre/post_tool_call、api_request_error、session finalize（hook 名来自 langfuse.com 集成页） | ✓ generation usage | ✓ cost | ✓ tool observation | ✗（Hermes 权限模型在 gateway 层，未见事件） | ✓ `api_request_error` | ✓ generation 时间 | ✓ trace 按 session，span 按 turn | `HERMES_LANGFUSE_CAPTURE=metadata|sanitized(默认)|full`、`MAX_CHARS`(默认 12000)、`SAMPLE_RATE` |
| OpenClaw | 配置 `diagnostics.otel.enabled=true`、`endpoint`、`protocol=http/protobuf`（仅此一种）、`traces/metrics/logs`、`logsExporter=otlp|stdout|both`、`sampleRate`、`captureContent`、`headers`、`serviceName`（默认 `openclaw`） | OTLP traces/metrics/logs（官方 `diagnostics-otel` 扩展）；也有 stdout JSONL | ✓ `openclaw.tokens{openclaw.token=input/output/cache}` + `gen_ai.client.token.usage` | ✓ `openclaw.cost.usd` | ✓ span `openclaw.tool.execution`、metric `openclaw.tool.execution.duration_ms/.blocked`、`gen_ai.tool.name` | ◐ `openclaw.tool.execution.blocked`、`openclaw.exec` | ✓ `openclaw.errorCategory`、`error.type`、`openclaw.failureKind` | ✓ `openclaw.run.duration_ms`、`openclaw.queue.lane.wait_ms` | ⚠ **session key 默认脱敏不导出**，仅 `openclaw.channel` 等低基数属性 | `captureContent` 默认 false |
| dsh | `DSH_TELEMETRY_MODE=FULL|DISABLED`（默认关闭），`DSH_TELEMETRY_DISABLED` 硬关；内置 `dsh-session-telemetry-otel` 把 session 事件投影为 OTLP/HTTP logs（默认发往 DeepSeek 自家端点，属产品分析）；有公开 telemetry backend 插件座（"telemetry seam"），社区 `dsh-plugin-langfuse`（GenAI semconv trace 树 → Langfuse OTLP）、`dsh-trace`、`@loongsuite/dsh-plugin`（ENTRY/AGENT/STEP/LLM/TOOL span） | 一手：append-only session log（system prompt、reasoning、tool call/result、子 agent 调度、context injection 全记录，可 resume/fork/replay） | ✓（插件） | ◐ | ✓ | ? 未核实 | ✓ | ✓ TTFT | ✓ session/turn | 二手信息，需实测 |

要点：
- **原生 OTLP 直通**的引擎：Claude Code、Codex、Gemini CLI、OpenClaw（官方扩展）、dsh（内置插件但默认指向厂商端点）。
- **事件流/插件 hook** 型：opencode（plugin event）、pi（RPC JSONL）、Hermes（plugin hook → Langfuse）。
- 只有 Claude Code 明确文档化了 **W3C trace context 传播**（子进程 `TRACEPARENT` env、出站 `traceparent` header、`-p`/SDK 入站读取）；其余引擎均未见入站 trace context 支持（Codex/Gemini 是各自独立的 root span）。

## 会话模型

各引擎在遥测中暴露的"会话主键"不同，是做业务→session 映射的关键对齐点：

| 引擎 | 遥测中的会话标识 | 层级 |
|---|---|---|
| Claude Code | `session.id`（全部 metric/event/span）；`prompt.id` 关联一次用户输入下的全部事件；`message.uuid`；`agent_id/parent_agent_id`（子 agent）；`workflow.run_id` | session → prompt(interaction) → llm_request/tool → subagent |
| Codex | `conversation.id` | conversation → api_request/tool |
| Gemini CLI | `gen_ai.conversation.id`（span）、`gemini_cli.agent.start/finish` 事件 | session → prompt → agent run |
| opencode | 事件 payload 中 `sessionID`、`messageID`、`partID` | session → message → part |
| pi | `sessionId`+`sessionFile`；session JSONL 树 `id/parentId`，支持分支（`get_tree`, `leafId`） | session(tree) → turn → message → toolCall |
| Hermes | Langfuse trace = session，span = turn | session → turn → generation/tool |
| OpenClaw | **不导出** session key（安全策略），只可通过认证的 Gateway RPC 拿；导出 `openclaw.channel` | run → model.call → tool.execution |
| dsh | session 日志（append-only，可 fork）；插件投影 turn → step → llm/tool | session → turn → step |

OTel GenAI 侧对应属性是 `gen_ai.conversation.id`（"conversation (session, thread)"）。网关应把业务会话 ID（如群 ID）作为 **resource/baggage 级属性**（例如 `gateway.tenant`, `gateway.business_session`）注入，而把各引擎的原生 session id 作为 `gen_ai.conversation.id` 的值保留，二者都存。

## 权限与安全

- 逐次工具权限决策事件：Claude Code（`claude_code.tool_decision` + `code_edit_tool.decision` 指标 + `tool.blocked_on_user` span，可量化"等待人审时长"）、Codex（`codex.tool_decision` approved/denied/abort + source）、opencode（`permission.asked/replied` 插件事件）。Gemini CLI 只有 approval mode 切换事件；OpenClaw 只有 `tool.execution.blocked` 计数；pi/Hermes/dsh 无独立权限事件。
- 内容隐私默认值差异显著：Claude/Codex/OpenClaw 默认脱敏，**Gemini CLI `logPrompts` 默认 true**。Hermes 提供 `sanitized` 模式（正则脱密后截断）。Claude Code 还会把自定义命令名/插件名折叠为 `custom`/`third-party`，除非 `OTEL_LOG_TOOL_DETAILS=1`。
- 身份属性：Claude Code 输出 `user.email`、`user.account_uuid`、`organization.id`、`user.groups`（IdP）——企业接入时需在 collector 用 attributes processor 做 hash/删除。
- OpenClaw 把 session key 视为凭证级别信息、拒绝导出，这个思路值得网关借鉴：**遥测里只放不可逆的会话哈希**。

## 扩展机制与资产

与可观测相关的扩展点：
- **Claude Code**：hooks（PreToolUse/PostToolUse/PermissionRequest 等）本身也是一个"埋点旁路"——hook 脚本收到 JSON stdin，可把事件转发到网关；trace 里有 `claude_code.hook` span 记录 hook 数量/成功/阻塞。`otelHeadersHelper`（settings.json）允许动态生成 OTLP 认证头（每 29 分钟刷新），适合网关按租户签发短期 token。
- **opencode**：插件（`.opencode/plugins/`、`~/.config/opencode/plugins/` 或 `opencode.json` 的 `"plugin"` npm 数组）通过返回 hooks 对象订阅事件，是唯一官方可观测扩展面。
- **Hermes**：`plugins/observability/*` 是插件类别之一（可类比再写 `observability/otel`）。
- **OpenClaw**：`extensions/diagnostics-otel` 是官方扩展，配置在 `diagnostics.otel.*`；社区另有 openclaw-observability-plugin。
- **dsh**：公开的 telemetry backend seam，社区已有 Langfuse/yiTrace 后端实现，证明可插拔。
- **Codex / Gemini CLI**：无遥测插件机制，只有配置项；Gemini `telemetry.outfile` 可把 OTLP JSON 写文件供解析。

资产格式：OTel 侧无"资产"概念；Langfuse 的 Prompt Management（`gen_ai.prompt.name/version` 属性可在 OTel 中引用）、Braintrust/Weave 的 dataset/experiment 可视为评估资产（推测）。

## 记忆

OTel GenAI 已在 `gen_ai.operation.name` 中加入 `create_memory_store`/`create_memory`/`delete_memory`（等）操作，并有 `gen_ai.conversation.compacted` 事件；`gen_ai.data_source.id` 用于标识检索源。各引擎原生信号中与记忆相关的只有 compaction：Claude Code `query_source=compact`、pi `compaction_start/end{reason}`、opencode `session.compacted`、Gemini `gemini_cli.chat_compression`。Hermes 的记忆系统未见遥测事件（未核实）。统一 schema 里应保留 `memory.read/write/compact` 三类 step 事件。

## 多 Agent 与协作

- Claude Code：span 属性 `agent_id/parent_agent_id`、`query_source=subagent`、`tool_parameters.subagent_type`、指标维度 `agent.name`，子 agent 的 `llm_request/tool` span 挂在父 `claude_code.tool`（Agent/Task）下。
- Gemini CLI：`gemini_cli.agent.start/finish` 事件、`gemini_cli.agent.run.count/duration/turns` 指标（agent = 子代理运行）。
- dsh：session 日志记录"子 agent 调度"；插件 AGENT/STEP 层级。
- OTel：`invoke_agent` 嵌套 + `gen_ai.agent.{id,name}` 即可表达 agent team；`invoke_workflow` 对应 dynamic workflow。
- Hermes/OpenClaw/pi/opencode/Codex：多 agent 在遥测中无显式父子标识（OpenClaw 有 `openclaw.run` 但 session 脱敏）。归一化时需要网关自己维护 `parent_run_id`。

## 可观测性（统一事件协议设计建议）

### 1. 统一事件 schema（草案）

以 OTel span 树为骨架、以事件为主要载荷（因为多数引擎只给事件/日志），字段命名尽量直接采用 `gen_ai.*`，网关扩展用 `agw.*` 前缀：

```yaml
# 公共 envelope（每条事件都有）
event.name: agw.run.start | agw.run.end | agw.turn.start | agw.turn.end |
            agw.step.llm | agw.step.tool.start | agw.step.tool.end |
            agw.permission.request | agw.permission.decision |
            agw.error | agw.cost | agw.artifact | agw.memory.compact
event.sequence: int                # 会话内单调递增
time: RFC3339
trace_id / span_id / parent_span_id  # W3C；无原生 trace 的引擎由网关生成
agw.engine: claude_code|codex|gemini_cli|opencode|pi|hermes|openclaw|dsh
agw.engine.version: string
agw.tenant, agw.business, agw.business_session   # 群ID等，hash 后
gen_ai.conversation.id: 引擎原生 session id
agw.run_id, agw.turn_id, agw.parent_run_id        # 子 agent 用 parent_run_id
gen_ai.agent.name / gen_ai.agent.id               # 子 agent/角色
# step.llm 载荷
gen_ai.provider.name, gen_ai.request.model, gen_ai.response.model
gen_ai.usage.input_tokens / output_tokens / cache_read.input_tokens / cache_write.input_tokens / reasoning.output_tokens
gen_ai.response.finish_reasons, gen_ai.response.id, gen_ai.response.time_to_first_chunk
agw.cost.usd (引擎给则透传；否则网关按价目表计算，标 agw.cost.source=engine|gateway)
gen_ai.input.messages / gen_ai.output.messages / gen_ai.system_instructions  # Opt-In，parts 结构
# step.tool 载荷
gen_ai.tool.name, gen_ai.tool.call.id, gen_ai.tool.type(function|mcp|builtin|skill|subagent)
agw.tool.input_bytes, agw.tool.output_bytes, agw.tool.success, agw.tool.duration_ms, error.type
# permission 载荷
agw.permission.decision: allow|deny|abort ; agw.permission.source: policy|hook|user_once|user_always|user_reject|timeout
agw.permission.wait_ms
# artifact 载荷
agw.artifact.kind: file_edit|commit|pr|message ; agw.artifact.ref ; agw.artifact.lines_added/removed
```

对应 OTel span：`agw.run` ↔ `invoke_agent {engine}`（INTERNAL）、`agw.turn` ↔ 子 `invoke_agent`/`invoke_workflow`、`agw.step.llm` ↔ `chat {model}`、`agw.step.tool` ↔ `execute_tool {name}`；同时导出 `gen_ai.client.token.usage`、`gen_ai.client.operation.duration`、`gen_ai.invoke_agent.tool_calls` 等 metrics，这样 Langfuse/Phoenix/SigNoz 等后端零改动即可消费。

### 2. 引擎信号 → 统一 schema 的三种映射策略

| 策略 | 适用引擎 | 做法 | 优点 | 坑 |
|---|---|---|---|---|
| A. 原生 OTLP 直通 + Collector 转换 | Claude Code、Codex、Gemini CLI、OpenClaw、dsh | 引擎直接把 OTLP 发到网关自带的 Collector；用 `transform`/`attributes` processor 把 `claude_code.*`/`codex.*`/`gemini_cli.*`/`openclaw.*` 重命名为 `agw.*`/`gen_ai.*`，并从 resource 注入 `agw.tenant` 等 | 零侵入，metrics/trace 天然完整 | 各引擎事件名/单位不同（Claude `cost_usd_micros` vs OpenClaw `openclaw.cost.usd`）；Codex 无 cost；OpenClaw 无 session id；Gemini 默认记录 prompt；Claude trace 仍 beta |
| B. 适配器解析 stream 事件 | pi（RPC JSONL）、opencode（plugin event/SSE）、Claude Code `-p --output-format stream-json`、Codex `exec --json`、Hermes plugin hook | 网关的 engine adapter 在读事件流的同时产出统一事件，并由网关 SDK 创建 span | 网关完全掌控语义，与会话映射同一处；权限事件最全（这是网关本来就要拦截的） | 事件流不含服务端 latency 细节；需要为每个引擎维护解析器，引擎升级易破坏 |
| C. 解析本地日志/session 文件 | pi session JSONL、dsh session log、Claude `~/.claude/projects/*.jsonl`、Gemini `telemetry.outfile` | 离线/补偿式回放 | 可事后审计、重建 trace | 非实时；格式无契约保证 |

建议：**B 为主、A 为辅、C 兜底**。B 保证每个引擎至少有 run/turn/step/tool/permission 五类事件；A 用于补充 token/latency/TTFT 与引擎内部 span；C 用于审计回放。归一化处理在网关（而非 Collector）里做，Collector 只负责路由与脱敏。

### 3. Trace 上下文传播

- 网关为每个业务请求生成 root span（`invoke_agent {engine}`），把 `TRACEPARENT`/`TRACESTATE` 注入引擎子进程 env。目前**只有 Claude Code 文档化了读取入站 TRACEPARENT（仅 `-p`/SDK 模式）并向 Bash 子进程/MCP HTTP 请求透传**（已确认）。其它引擎会生成独立 trace，需要用 Collector 的 `transform` 把 `gen_ai.conversation.id`/`conversation.id` 反查为网关 trace id（或由网关在 B 策略中把引擎 span 作为 span link 附上）。
- 对使用 `ANTHROPIC_BASE_URL` 走网关代理的场景，Claude Code 需 `CLAUDE_CODE_PROPAGATE_TRACEPARENT=1` 才会向自定义代理发 `traceparent`——如果我们的 LLM 网关在中间，这一开关必须打开。
- 引擎自身无入站 trace 时的退路：把网关 root span 的 trace_id 通过 `OTEL_RESOURCE_ATTRIBUTES=agw.trace_id=...,agw.run_id=...` 注入（Claude Code/Gemini 支持 `OTEL_RESOURCE_ATTRIBUTES`；Codex 用 `[otel] environment` 或 headers；OpenClaw 用 `headers`）。

### 4. 采样与隐私脱敏

- 采样：Hermes `HERMES_LANGFUSE_SAMPLE_RATE`、OpenClaw `diagnostics.otel.sampleRate` 为引擎侧头采样；建议在网关做 **尾采样**（错误/高成本/被拒绝的权限决策 100% 保留），并对 `gen_ai.input.messages` 类重载荷单独采样。
- 脱敏分级（映射到各引擎开关）：L0 元数据（默认）；L1 tool 详情（Claude `OTEL_LOG_TOOL_DETAILS`、Codex 无、Hermes `metadata`）；L2 prompt/响应（Claude `OTEL_LOG_USER_PROMPTS/OTEL_LOG_ASSISTANT_RESPONSES`、Codex `log_user_prompt`、Gemini `logPrompts`、OpenClaw `captureContent`、Hermes `full`）；L3 原始 API body（Claude `OTEL_LOG_RAW_API_BODIES=file:<dir>`）。网关按租户策略决定级别并统一下发。
- Collector 端固定规则：删除/哈希 `user.email`、`user.account_uuid`、`workspace.host_paths`、`file_path`、`full_command`；对 `gen_ai.*.messages` 做正则脱密；长度上限对齐 Claude 的 `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH`（默认 61440 UTF-16 单元）与 Hermes `MAX_CHARS`(12000)。
- 基数控制：Claude Code 提供 `OTEL_METRICS_INCLUDE_SESSION_ID/VERSION/ACCOUNT_UUID/ENTRYPOINT`；对 metrics 默认**去掉 session.id**，只在 events/spans 保留。

## 对我们架构的启示

### 公共能力 vs 扩展能力映射表（可观测维度）

| 能力 | 类型 | Claude Code | Codex | Gemini CLI | opencode | pi | Hermes | OpenClaw | dsh |
|---|---|---|---|---|---|---|---|---|---|
| run/turn 生命周期 | 公共 | span/interaction | conversation_starts | agent.start/finish | session.* | agent_start/end, turn_* | turn span | openclaw.run | turn |
| token usage | 公共 | ✓ | ✓(sse_event) | ✓ | ✓(message) | ✓ | ✓ | ✓ | ✓(插件) |
| cost | 公共（部分引擎缺，网关补算） | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ◐ |
| tool start/end | 公共 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| permission decision | 公共（部分引擎缺） | ✓ 最细 | ✓ | ◐ | ✓ | ◐ | ✗ | ◐ | ? |
| error 分类 | 公共 | ✓ | ◐ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| OTLP 原生导出 | 扩展 | ✓ | ✓ | ✓ | 插件 | ✗ | ✗(Langfuse) | ✓ | ✓(厂商端点) |
| 入站 trace context | 扩展 | ✓(-p/SDK) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| 子 agent 父子标识 | 扩展 | ✓ | ✗ | ◐ | ✗ | ✗ | ✗ | ◐ | ✓ |
| hook 执行遥测 | 扩展 | ✓ claude_code.hook | ✗ | ✓ hook_call | ✗ | extension_error | ✗ | ✗ | ✗ |
| 队列/背压指标 | 扩展 | ✗ | ✗ | tool.queue.depth | ✗ | queue_update | ✗ | ✓ queue.lane.* | ✗ |
| compaction 事件 | 公共 | query_source=compact | ✗ | chat_compression | session.compacted | compaction_* | ? | memory.pressure | ? |
| 原始 API body 落盘 | 扩展 | ✓ file: 模式 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

### 接入参数（每接一个引擎需向适配器声明）

```yaml
observability:
  native_otlp: {supported: bool, signals: [metrics, logs, traces], protocol: [grpc, http/protobuf, http/json],
                enable_env: {...}, endpoint_env: ..., headers_env: ..., resource_attrs_env: ...}
  inbound_trace_context: {supported: bool, mode: env|header, only_in_modes: ["-p", "sdk"]}
  event_stream: {kind: jsonl|sse|plugin_hook|none, session_id_field: "...", usage_fields: {...}, cost_field: "...|null"}
  session_id_attr: "session.id|conversation.id|gen_ai.conversation.id|sessionID|redacted"
  content_flags: {prompt: ENV, response: ENV, tool_details: ENV, raw_body: ENV, default_on: bool}
  cost_source: engine|gateway_pricing
  sampling: {engine_side: ENV|null}
```

### 风险与坑
1. **GenAI semconv 仍是 Development**，属性名可能再改（历史上已从 `gen_ai.system` 改为 `gen_ai.provider.name`，从逐消息事件改为聚合 messages）。网关内部 schema 应以 `agw.*` 为稳定名，`gen_ai.*` 作为导出映射层，一次升级只改映射表。Claude Code span 里同时还在用旧名 `gen_ai.system`。
2. Claude Code traces 是 beta、需要额外 flag；metrics 默认 delta temporality（Prometheus 后端需改 cumulative）。
3. Codex `mcp-server` 模式零遥测、`exec` 无 metrics：若通过 MCP 方式接 Codex，遥测必须走 B/C 策略。
4. Gemini `logPrompts` 默认 true，OTLP 默认端口 4317/grpc；企业接入需在模板里显式关闭。
5. OpenClaw 故意不导出 session key，业务→session 关联必须由网关在 B 策略中完成。
6. dsh 内置遥测默认指向 DeepSeek 端点，属于数据外发；生产需 `DSH_TELEMETRY_DISABLED=1` 后使用自建后端插件。
7. 各引擎的 token 分类不同（Claude cacheRead/cacheCreation、Codex cached/reasoning、Gemini thought/cache/tool、pi cacheRead/cacheWrite）——统一到 `gen_ai.usage.cache_read.input_tokens / cache_write.input_tokens / reasoning.output_tokens`，多出的类别放 `agw.usage.extra`。
8. 事件顺序：Claude 有 `event.sequence`，pi 有流序，其它没有；网关必须自己打序号，否则异步 OTLP 批量导出会乱序。

## 未解决问题
1. semconv-genai 仓库的正式 release/tag 编号与时间未能通过 API 获取（请求被代理拒绝）；需人工确认当前引用的 commit。
2. Codex `metrics_exporter=statsig|otlp-*` 与 `codex.api_request.duration_ms` 等 metrics 名称仅来自第三方博客，未在官方页面核实。
3. dsh 的 telemetry seam 接口签名、session 日志文件路径/格式、是否有 permission 事件，需要读源码（`deepseek-ai/deepseek-harness`）确认。
4. opencode 的 `message.updated` payload 中 token/cost 字段名（推测为 `tokens`/`cost`）与 server `/event` SSE 端点需要对照 `opencode.ai/docs/server` 核实。
5. Hermes 是否有 OTLP 原生输出（SigNoz 文档提到"用 OpenTelemetry 监控 Hermes"，可能是通过 Langfuse OTLP 或自定义），以及 gateway 会话/子 agent 的 Langfuse 追踪（issue #1501）是否已合并。
6. LangSmith / AgentOps / Braintrust / Weave 的 2026 数据模型未联网核实，表中标为推测。
7. OTel GenAI SIG 对 MCP（`mcp.*`）的约定草案状态未查到一手资料。

## 来源列表
- https://opentelemetry.io/docs/specs/semconv/gen-ai/ （迁移提示）
- https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/ （迁移提示）
- https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/ ；/gen-ai-metrics/ （迁移提示）
- https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-agent-spans.md
- https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-events.md
- https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-metrics.md
- https://opentelemetry.io/blog/2026/genai-observability/
- https://code.claude.com/docs/en/monitoring-usage （原 docs.claude.com/en/docs/claude-code/monitoring-usage 301）
- https://learn.chatgpt.com/docs/config-file/config-advanced （原 developers.openai.com/codex/config-advanced 308）
- https://codex.danielvaughan.com/2026/04/20/codex-cli-observability-opentelemetry-traces-metrics-production-monitoring/
- https://github.com/openai/codex/issues/12913
- https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/telemetry.md
- https://raw.githubusercontent.com/Arize-ai/openinference/main/spec/semantic_conventions.md
- https://langfuse.com/docs/observability/data-model ；https://langfuse.com/docs/observability/features/observation-types
- https://langfuse.com/integrations/other/hermes
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/plugins/observability/langfuse/README.md
- https://docs.openclaw.ai/gateway/opentelemetry ；https://docs.openclaw.ai/plugins/reference/diagnostics-otel
- https://github.com/anomalyco/opencode/issues/14697 ；https://opencode.ai/docs/plugins/
- https://github.com/DEVtheOPS/opencode-plugin-otel
- https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/rpc.md
- https://signoz.io/docs/deepseek-harness-observability/ ；https://github.com/linyp/dsh-plugin-langfuse ；https://github.com/vibeinging/dsh-trace
- https://www.traceloop.com/docs/openllmetry/contributing/semantic-conventions ；https://mlflow.org/docs/latest/genai/tracing/opentelemetry/attribute-mapping/
- https://www.arthur.ai/column/openinference-vs-opentelemetry-genai-conventions-agent-tracing ；https://openobserve.ai/blog/opentelemetry-genai-semantic-conventions/ ；https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions
