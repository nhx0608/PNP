# T17 多 Agent 编排框架的原语与"异构 agent 作为节点"抽象

> 调研日期：2026-09-03。所有事实均以联网抓取的一手资料为准（官方文档 / GitHub / 协议规范）。标注 **[已确认]** 表示在一手页面中直接读到；**[推测]** 表示基于已确认事实的推断；置信度 high/medium/low 见"关键事实"。

## 摘要

本专题横向拆解了 2026 年主流多 Agent 编排框架——LangGraph / LangSmith Agent Server、Microsoft Agent Framework (MAF, 已吸收 AutoGen 与 Semantic Kernel)、OpenAI Agents SDK、Google ADK 2.0、AgentScope 2.0（含 Agent Service 与 AgentTeams）、Eino ADK、DeerFlow 2.0，以及 CrewAI Flows、Mastra、Agno、Letta、CAMEL Workforce、MetaGPT、Dify、Coze Studio——的编排原语、会话与检查点模型、人机中断协议、以及"把外部/异构 agent 包装成节点"的四种手段（RemoteGraph、A2A 客户端、agent-as-tool、handoff）。

核心结论：

1. 所有框架都收敛到同一个最小节点契约：`run(input, session/thread, config) -> 事件流`，事件里携带 **输出增量 / 工具调用 / 状态增量 / 中断请求(request_info) / 路由动作(transfer、goto) / 结束**。Eino 的 `AgentEvent{Output, Action{Exit, Interrupted, TransferToAgent, BreakLoop}}`、MAF 的 `WorkflowEvent.type in {"output","intermediate","request_info"}`、LangGraph 的 `Command(goto/update/resume)` + `__interrupt__`、ADK 2.0 Event 新增 `node_info/output/route` 字段，本质是同一种东西。这正是我们网关"节点 = 引擎 + 能力配置"的落点。
2. 人机中断已经是一等协议：全部框架都有"暂停 → 暴露带 id 的待处理请求 → 用 `{request_id: response}` 恢复"的三段式，但 **恢复语义不同**（LangGraph 从节点开头重跑并要求幂等；MAF 从超步检查点重放并重新发出 pending 请求；OpenAI 把 `RunState` 序列化成 JSON 再喂回 `Runner.run(agent, state)`）。网关必须把"待处理请求"作为跨引擎统一对象，并把恢复语义作为引擎能力声明的一部分。
3. 跨框架接入外部 agent 的事实标准是 **A2A v1.0**（Linux Foundation，AgentCard + Task/Message + contextId/taskId + INPUT_REQUIRED/AUTH_REQUIRED 状态），MAF、ADK、AgentScope Runtime 均提供"一行代码暴露为 A2A 服务"和"一行代码消费远端 A2A agent"。A2A 的 `AgentCard.capabilities/skills/extensions/securitySchemes` 可以直接作为我们"能力识别→适配→认证"流程的数据载体。
4. 框架本身在剧烈演进（AutoGen 进入维护模式并让位于 MAF；AgentScope Runtime 归档并入 AgentScope 2.0；Mastra Agent Networks 被弃用；ADK 1→2 改为图运行时并破坏了 `_run_async_impl` 覆写；LangGraph 文档整体迁站），因此"引擎适配层"必须带版本号的能力清单，而不是硬编码接口。

## 关键事实（每条带来源与置信度）

| # | 事实 | 来源 | 置信度 |
|---|------|------|--------|
| 1 | LangGraph `interrupt()` 恢复时 **整个节点从头重跑**，官方要求节点内操作幂等、`interrupt` 调用顺序稳定、不要用 try/except 包裹；多并行中断用 `Command(resume={interrupt_id: value})` 一次性恢复 | https://docs.langchain.com/oss/python/langgraph/interrupts | high |
| 2 | `RemoteGraph("agent", url=... 或 sync_client=...)` 可直接 `builder.add_node("child", remote_graph)` 作为子图；官方警告"不要用 RemoteGraph 调用同一部署内的图，会死锁与资源耗尽"，并建议 thread_id 用 UUID | https://docs.langchain.com/langsmith/use-remote-graph | high |
| 3 | LangSmith Deployment（原 LangGraph Platform）的 Assistants 是"图代码之外的配置版本化对象"（`assistant_id`/`graph_id`/`config`），更新必须整包提交不做合并；Double-texting 策略 `enqueue`(默认)/`reject`/`interrupt`/`rollback` 仅在托管版提供，OSS 没有 | https://docs.langchain.com/langsmith/assistants ; https://docs.langchain.com/langsmith/double-texting | high |
| 4 | Agent Server 架构：API 服务器不执行图，队列 worker 执行并写 Postgres 检查点，Redis 只做队列/取消/pubsub 不存数据；资源模型 Assistants/Threads/Runs/Cron + Checkpoints + Store | https://docs.langchain.com/langsmith/agent-server | high |
| 5 | 自定义认证：`@auth.authenticate` 返回 `{identity, ...}`，`@auth.on` 对 threads/assistants/runs/store/crons 的 create/read/update/delete/search 返回过滤器；`langgraph.json` 里 `"auth": {"path": "./auth.py:my_auth"}`；图内通过 `config["configurable"]["langgraph_auth_user"]` 取用户 | https://docs.langchain.com/langsmith/custom-auth | high |
| 6 | MAF 1.0 于 2026-04-03 GA（.NET + Python）；AutoGen 已进入维护模式（README 明示"will not receive new features"，60.8k star），官方给出 AutoGen→MAF 迁移指南 | https://techcommunity.microsoft.com/blog/azuredevcommunityblog/the-future-of-agentic-ai-inside-microsoft-agent-framework-1-0/4510698 ; https://github.com/microsoft/autogen | high(维护模式)/medium(GA 日期来自博客) |
| 7 | MAF 内置五种编排：Sequential / Concurrent / Handoff / Group Chat / Magentic；Handoff 是 **mesh 拓扑、无 orchestrator、各 agent 不共享 session、通过广播 user/agent 消息同步上下文，工具内容不广播**；默认交互式，`with_autonomous_mode(agents, prompts, turn_limits)` 可自治（.NET 默认 50 轮，续写提示 "User did not respond. Continue assisting autonomously.") | https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff | high |
| 8 | MAF Magentic 复刻 AutoGen Magentic-One：`MagenticBuilder(participants, manager_agent, max_round_count, max_stall_count, max_reset_count, enable_plan_review)`，事件 `PLAN_CREATED/REPLANNED/PROGRESS_LEDGER_UPDATED`，人审用 `MagenticPlanReviewRequest.approve()/revise()`；Python 默认关闭 plan review，.NET `RequirePlanSignoff` 默认开启 | https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic | high |
| 9 | MAF 检查点按 **superstep** 创建，内容含执行器状态、待发消息、pending 请求/响应、共享状态；Python 1.13.0 起增加入口检查点使整轮可重放；重建工作流必须保持拓扑与 agent `Id`/`Name` 稳定否则无法恢复；File/Cosmos 存储用受限 unpickler，需 `allowed_checkpoint_types` 白名单 | https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints | high |
| 10 | MAF `AgentExecutor(agent, session, id, context_mode="full"/"last_agent"/"custom", context_filter)`；下游收到 `AgentExecutorResponse{executor_id, agent_response, full_conversation}`；服务端会话（FoundryAgent）状态不进检查点 | https://learn.microsoft.com/en-us/agent-framework/concepts/workflows/advanced/agent-executor | high |
| 11 | MAF `workflow.as_agent()` 把整条工作流变成普通 Agent；`request_info` 请求被翻译成名为 `WorkflowAgent.REQUEST_INFO_FUNCTION_NAME` 的 function call，用 `Content.from_function_result(call_id, result)` 回填；只转发 `{"output","intermediate"}` 两类事件 | https://learn.microsoft.com/en-us/agent-framework/workflows/as-agents | high |
| 12 | MAF A2A：Python `pip install agent-framework-a2a --pre`，`A2AAgent(name, url|agent_card|client, auth_interceptor)` 消费远端；`A2AExecutor(agent, stream=True)` + a2a-sdk `DefaultRequestHandler/InMemoryTaskStore` 暴露服务，**A2A `context_id` 直接映射为 agent session 的 `session_id`**；.NET A2A v1 支持 2026-04-28 发布，`A2ACardResolver.GetAIAgentAsync()`、`AddA2AServer/MapA2AHttpJson/MapA2AJsonRpc/MapWellKnownAgentCard` | https://learn.microsoft.com/en-us/agent-framework/integrations/a2a ; https://devblogs.microsoft.com/agent-framework/a2a-v1-is-here-cross-platform-agent-communication-in-microsoft-agent-framework-for-net/ | high |
| 13 | MAF 提出 **Agent Harness** 概念（页面日期 2026-07-29）：`create_harness_agent(client, harness_instructions, agent_instructions, max_context_window_tokens, disable_todo/mode/file_memory/web_search/tool_auto_approval/compaction, skills_paths, context_providers)`；能力矩阵包含函数调用、逐次调用历史持久化、compaction、todo、plan/execute 模式、文件记忆、工具审批(standing approvals)、OTel、web search、Agent Skills、background agents、shell、looping | https://learn.microsoft.com/en-us/agent-framework/concepts/harness | high |
| 14 | OpenAI Agents SDK handoff 以工具 `transfer_to_<agent_name>` 呈现；`handoff(agent, tool_name_override, on_handoff, input_type, input_filter, is_enabled, nest_handoff_history)`；默认把完整历史交给接收方，`RunConfig.nest_handoff_history`（opt-in beta）把历史压成 `<CONVERSATION HISTORY>` 段；agent-as-tool (`Agent.as_tool(parameters=...)`) 不转移对话控制权 | https://openai.github.io/openai-agents-python/handoffs/ ; https://openai.github.io/openai-agents-python/tools/ | high |
| 15 | OpenAI HITL：`@function_tool(needs_approval=True | async fn(ctx, params, call_id))`；`result.interruptions` 暴露 `ToolApprovalItem`；`state = result.to_state()` → `state.approve/reject(always_*=True)` → `Runner.run(agent, state)`；`RunState.to_json()/from_json()` 可持久化，官方建议随状态存版本标记 | https://openai.github.io/openai-agents-python/human_in_the_loop/ | high |
| 16 | OpenAI Sessions 协议 = `get_items/add_items/pop_item/clear_session`（可选 `wrapper: RunContextWrapper` 做租户路由）；实现有 SQLite/AsyncSQLite/SQLAlchemy/Redis/MongoDB/Dapr/OpenAIConversations/OpenAIResponsesCompaction/AdvancedSQLite/Encrypted；同一次 run 不能同时用 session 与 `conversation_id/previous_response_id` | https://openai.github.io/openai-agents-python/sessions/ | high |
| 17 | OpenAI Tracing：trace 字段 `workflow_name/trace_id("trace_<32位>")/group_id/metadata`；span 类型 agent/generation/function/guardrail/handoff/custom/transcription/speech/speech_group/task/turn；`add_trace_processor` 与 `set_trace_processors`；`OPENAI_AGENTS_DISABLE_TRACING=1`；20+ 外部 processor（Langfuse、Braintrust、MLflow、Arize、Logfire、LangSmith…） | https://openai.github.io/openai-agents-python/tracing/ | high |
| 18 | OpenAI Sandbox agents（beta）：`SandboxAgent`、`SandboxRunConfig(session, session_state, snapshot)`、`Manifest/LocalDir`、`Capabilities`(filesystem/shell/skills/memory/compaction)、`UnixLocalSandboxClient`/`DockerSandboxClient` | https://openai.github.io/openai-agents-python/sandbox_agents/ | high |
| 19 | Google ADK 2.0：Python GA 2026-05-19、Go 2026-06-30、TS 2026-08-21；改为 **Workflow Runtime 图执行引擎**，Agents/Tools/Functions 皆为 `BaseNode`；Event 新增 `node_info/output/route`；HITL 内建 `RequestedInput`；自定义 `_run_async_impl` 覆写失效，改用 Before/AfterAgentCallback；Go 包路径 `google.golang.org/adk/v2` | https://adk.dev/2.0/ | high |
| 20 | ADK A2A：`RemoteA2aAgent(name, agent_card=<AgentCard|URL|文件>, description, config=A2aRemoteAgentConfig(converters, before_request/after_request))` 可直接放进 `sub_agents`；`to_a2a(agent, host, port, agent_card, runner)` 自动生成 `/.well-known/agent-card.json` 并以 `A2aAgentExecutor` 桥接；`adk api_server --a2a --port 8001`；A2A 跨边界保留 reasoning、long-running tools、artifacts | https://adk.dev/a2a/quickstart-consuming/ ; https://adk.dev/a2a/quickstart-exposing/ ; https://adk.dev/a2a/intro/ | high |
| 21 | A2A v1.0：AgentCard(`name/description/supportedInterfaces/version/capabilities{streaming,pushNotifications,extendedAgentCard,stateTransitionHistory}/skills/securitySchemes/signatures`)；Task(`id/contextId/status/artifacts/history/metadata`)；TaskState = SUBMITTED/WORKING/INPUT_REQUIRED/AUTH_REQUIRED/COMPLETED/FAILED/CANCELED/REJECTED；Message(`messageId/role/parts/contextId/taskId/referenceTaskIds/extensions`)；绑定 JSON-RPC 2.0 / gRPC / HTTP+JSON | https://a2a-protocol.org/latest/specification/ | high |
| 22 | AgentScope 2.0（30.5k star，Apache-2.0，Python≥3.11）分 Agent SDK 层与 Agent Service 层；Service 层多租户默认用 `X-User-ID` 头（**无认证，生产必须替换**），资源层级 User→Credential/Agent/Schedule→Session→Workspace/Messages，工作区隔离粒度 `per_agent/per_session/per_user`，单 session 同时只允许一个 run（重复提交 409），`POST /chat` 返回 `{"status":"started","session_id"}`，`GET /sessions/{id}/stream` SSE 带 replay；团队为 leader 用 `AgentCreate` 工具生成 worker（`custom_subagent_templates`），`TeamRecord` 持久化；Redis `MessageBus` 做 session 锁/replay/inbox/wakeup | https://github.com/agentscope-ai/agentscope ; https://docs.agentscope.io/versions/2.0.4/en/deploy/agent-service | high |
| 23 | AgentScope Runtime 已归档（只读，建议迁移到 AgentScope 2.0）；其 v1.1.0 (2026-02) 曾提供 A2A / Response API / AG-UI 暴露与 Docker/gVisor/K8s/FC 沙箱，兼容 AgentScope/LangGraph/MAF/Agno/AutoGen | https://github.com/agentscope-ai/agentscope-runtime/blob/main/README.md | high |
| 24 | AgentTeams（agentscope-ai，v1.2.2 2026-08-08，5.6k star）：用 **Matrix 房间**做多 agent 协作面（Tuwunel 服务器 + Element Web），Manager–Workers，Worker 运行时可为 OpenClaw/QwenPaw/Hermes，**Higress AI Gateway 持有真实凭证、worker 只拿 consumer token**，K8s 控制器管理 Worker/Team/Manager CRD | https://github.com/agentscope-ai/AgentTeams | high |
| 25 | Eino ADK（Go，12.9k star）：`Agent{Name, Description, Run(ctx,*AgentInput,...) *AsyncIterator[*AgentEvent]}`；`AgentEvent{AgentName, RunPath, Output, Action, Err}`；`AgentAction{Exit, Interrupted{InterruptInfo}, TransferToAgent, BreakLoop}`；`adk.NewRunner(ctx, RunnerConfig{Agent, EnableStreaming, CheckPointStore})`，`Run(..., WithCheckPointID("cp-123"))`、`Resume(ctx,"cp-123")`、`ResumeWithParams(Targets map[address]any)`；CheckPointStore 仅 `Set/Get []byte`，gob 序列化；多 agent 原语 Sequential/Parallel/Loop/Supervisor/PlanExecute/DeepAgents(WriteTodos+TaskTool)/AgentAsTool(`NewAgentTool`)/Transfer(`SetSubAgents`+`NewTransferToAgentAction`)；TurnLoop 支持 Push/Preempt/Stop，v0.9+ `CancelMode` | https://www.cloudwego.io/docs/eino/core_modules/eino_adk/agent_extension/ ; https://www.cloudwego.io/zh/docs/eino/overview/eino_adk0_1/ ; https://github.com/cloudwego/eino | high |
| 26 | DeerFlow 2.0（81.3k star，MIT，2026-02-28 发布，与 v1 零代码共享）：Gateway(FastAPI:8001) + Nginx(:2026) + Next.js(:3000)；agent 运行时是 LangGraph，**提供 LangGraph 兼容路由 `/api/langgraph/*`**；中间件链 ThreadData→Uploads→Sandbox→Summarization→Title→TodoList→ViewImage→Clarification；run 请求体含 `config.configurable{model_name, thread_id, thinking_enabled, is_plan_mode}`、`stream_mode`、`multitask_strategy: reject|interrupt|rollback`；PAT `dfp_` 前缀，scope `threads:read/write/delete, runs:create/read/cancel`；内部平台认证头 `X-DeerFlow-Internal-Token` + `X-DeerFlow-Owner-User-Id`；SSE 事件 `values/messages/end/gap`（gap 表示 replay 超出保留窗口，`recovery: reload_durable_state`） | https://github.com/bytedance/deer-flow ; https://raw.githubusercontent.com/bytedance/deer-flow/main/backend/docs/ARCHITECTURE.md ; https://raw.githubusercontent.com/bytedance/deer-flow/main/backend/docs/API.md | high |
| 27 | DeerFlow 持久化运行事件契约：信封字段 `thread_id, run_id, seq(严格递增), event_type(≤32), category(≤16), content, metadata, created_at`；事件 `run.start/run.end/llm.ai.response/llm.tool.result/llm.human.input/middleware:{tag}/context:memory/subagent.start|step|end`；后端 Memory/Db/Jsonl | https://raw.githubusercontent.com/bytedance/deer-flow/main/backend/docs/RUN_EVENT_STREAM.md | high |
| 28 | AG-UI 事件词表：RUN_STARTED(threadId, runId, parentRunId)/RUN_FINISHED(outcome success|interrupt)/STEP_*/TEXT_MESSAGE_START|CONTENT|END/TOOL_CALL_START|ARGS|END|RESULT/STATE_SNAPSHOT/STATE_DELTA(RFC 6902)/MESSAGES_SNAPSHOT/ACTIVITY_*/REASONING_*/SUBAGENT_STARTED|FINISHED|ERROR/RAW/CUSTOM | https://docs.ag-ui.com/concepts/events | high |
| 29 | Mastra Agent Networks 已 **deprecated**（建议迁到 supervisor agent）；工作流 `suspend()/run.resume({step, resumeData})`，状态 `success/failed/suspended/tripwire/paused`，快照持久化于 storage | https://mastra.ai/docs/agents/networks ; https://mastra.ai/en/docs/workflows/suspend-and-resume | high |
| 30 | CrewAI Flows：`@start/@listen/@router`、`or_/and_`、`@persist`(默认 SQLiteFlowPersistence)、`kickoff(inputs={"id":uuid})` 续跑 vs `restore_from_state_id` 分叉、`@human_feedback` | https://docs.crewai.com/en/concepts/flows | high |
| 31 | Agno AgentOS：`POST /agents|teams|workflows/{id}/runs`，字段 `message/session_id/user_id/stream/session_state/metadata/output_schema`，默认 SSE；认证 `none/security_key/jwt`（`GET /info` 可发现），PAT 前缀 `agno_pat_`；Team 模式 `TeamMode.route/coordinate/broadcast` | https://docs.agno.com/agent-os/using-the-api ; https://docs.agno.com/concepts/teams/introduction | high |
| 32 | Letta：一个 agent 可并行多个 conversation（各自上下文窗口，共享 memory blocks 与可检索消息历史）；`POST /v1/conversations`(agent_id) 创建，可按 conversation 覆盖模型，可 fork；共享 block 通过 `block_ids` 挂到多 agent，`read_only`；并发下 `memory_insert` 安全、`memory_rethink` 最后写者胜出 | https://docs.letta.com/guides/agents/conversations/ ; https://docs.letta.com/guides/agents/multi-agent-shared-memory/ | high |
| 33 | CAMEL Workforce：coordinator agent + task agent + new_worker_agent 三角色；`Workforce(description, coordinator_agent, task_agent, new_worker_agent, task_timeout_seconds, share_memory, callbacks)`，失败恢复三策略 retry/replan/新建 worker | https://docs.camel-ai.org/key_modules/workforce | high |
| 34 | Dify 1.13.0（2026-02-11）新增 Human Input 节点（暂停、表单改变量、按钮路由），全局超时 `HUMAN_INPUT_GLOBAL_TIMEOUT_SECONDS=604800`，工作流执行迁移到 Celery 队列 `workflow_based_app_execution` + Redis Pub/Sub；Agent 节点策略（Function Calling/ReAct）以插件形式分发 | https://github.com/langgenius/dify/discussions/32245 ; https://docs.dify.ai/en/use-dify/nodes/agent | high |
| 35 | Coze Studio（21.5k star，Apache-2.0，Go 1.23.4+）工作流引擎基于 Eino，画布基于 FlowGram，HTTP 基于 Hertz，提供 chat/workflow OpenAPI 与 PAT | https://github.com/coze-dev/coze-studio | high |

## 架构与工作原理

### 1. 编排原语总表

下表把各框架的原语归一到 10 种模式。"节点承载"一列说明该框架里"一个 agent"以什么形态成为编排单元。

| 模式 | LangGraph | MAF | OpenAI Agents SDK | Google ADK 2.0 | Eino ADK | AgentScope 2.0 | 其他 |
|---|---|---|---|---|---|---|---|
| sequential | `add_edge` 链 | `SequentialBuilder` / `WorkflowBuilder.add_edge`（agent 自动包成 `AgentExecutor`） | 代码顺序调用 `Runner.run` | `SequentialAgent`；2.0 图节点 | `SequentialAgent` | `sequential_pipeline`(2026-08 新增 Pipeline) | CrewAI `@listen` 链、Mastra `.then()` |
| parallel / map-reduce | `Send("node", {...})` 动态扇出 + reducer 归并 | `ConcurrentBuilder`；superstep 内并行 | `asyncio.gather` 多 Runner | `ParallelAgent` | `ParallelAgent`(sync.WaitGroup) | `fanout_pipeline` | Mastra `.parallel()/.foreach()`、AutoGen GraphFlow |
| loop | 条件边回环 + `recursion_limit`(默认 1000)/`RemainingSteps` | 自定义 executor 回边；Harness 的 bounded looping | agent loop `max_turns` | `LoopAgent(max_iterations)` + `escalate` | `LoopAgent`(MaxIterations/ExitAction) | ReAct 循环 | Mastra `.dowhile/.dountil`、CrewAI `@router` 回环 |
| conditional | `add_conditional_edges` | 条件边 / `switch` | 模型自行选工具 | 2.0 图条件路由 `route` | ChatModelAgent 决策 | — | Dify 条件节点、Coze 条件节点 |
| handoff (mesh) | `Command(goto=..., graph=Command.PARENT)`；`langgraph-swarm` | `HandoffBuilder`（mesh，无 orchestrator） | `handoff()` → `transfer_to_<agent>` 工具 | `transfer_to_agent`（LLM 驱动委派） | `TransferToAgent` action | — | AutoGen `Swarm` + `HandoffMessage` |
| supervisor (star) | `langgraph-supervisor` `create_supervisor(output_mode=full_history/last_message)` | Group Chat 的 `orchestrator_agent` / Magentic manager | agent-as-tool | Collaborative workflow（coordinator + sub_agents） | `SupervisorAgent` | Team leader–worker（`AgentCreate` 工具） | Agno `TeamMode.coordinate`、CAMEL coordinator、Mastra supervisor |
| group chat | 自建 | `GroupChatBuilder(selection_func|orchestrator_agent)`；.NET `RoundRobinGroupChatManager` | — | — | — | `MsgHub` 广播 | AutoGen RoundRobin/SelectorGroupChat；AgentTeams Matrix room |
| swarm | `create_swarm(default_active_agent)`，`SwarmState.active_agent` | Handoff | handoffs | — | — | — | — |
| plan-execute | 自建/`deepagents` | Magentic（task ledger + progress ledger + stall/replan） | — | — | `PlanExecuteAgent`(Planner/Executor/Replanner)、`DeepAgents` | plan 工具 | CAMEL Workforce 任务分解、MetaGPT SOP |
| agent-as-tool | `@tool` 包裹 `create_agent` | `agent.as_tool()` 与 handoff 明确区分 | `Agent.as_tool(parameters, custom_output_extractor)` | `AgentTool` | `NewAgentTool` | 工具化 | Dify Agent 节点、Mastra sub-agents |

**结论 [推测]**：sequential/parallel/loop/conditional 是"图层"原语（可由网关的 DAG 引擎自己执行）；handoff/supervisor/group-chat/swarm/plan-execute 是"对话层"原语（涉及上下文同步策略，最好委托给引擎，网关只声明能力与参数）。

### 2. 状态与检查点模型

| 框架 | 状态单元 | 检查点粒度 | 存储实现 | 恢复约束 |
|---|---|---|---|---|
| LangGraph | `StateGraph` 的 State（reducer 合并；`UntrackedValue` 不入检查点；`Overwrite` 绕过 reducer） | 每个 super-step 一个 checkpoint，按 `thread_id` 组织 | `InMemorySaver/SqliteSaver/PostgresSaver/AsyncPostgresSaver`；跨线程 `BaseStore` | thread_id <255 字符；节点从头重跑；图拓扑迁移对中断中的线程有限制 |
| MAF Workflows | 执行器私有状态 + shared state + pending messages + pending requests | 每个 superstep 结束（Python 1.13.0 起加入口检查点） | `InMemoryCheckpointStorage/FileCheckpointStorage/CosmosCheckpointStorage`；.NET `CheckpointManager` | 拓扑与执行器 Id 必须一致；受限 unpickler；服务端 session 不入检查点 |
| OpenAI Agents SDK | `RunState`（含审批、usage、嵌套 agent-as-tool 恢复点、trace 元数据） | 一次 run 被中断时整体序列化 | `RunState.to_json()` 自行持久化 | 建议存版本标记；`context` 需可序列化 |
| Google ADK | `Session{state, events}`；state 前缀 `user:/app:/temp:` | 每个 Event 追加 | `InMemory/Database/VertexAiSessionService` | 2.0 禁止直接 `context.session.events.append()` |
| Eino ADK | `AgentInput`+history+InterruptInfo | 每次中断按 `CheckPointID` 存 `[]byte`(gob) | `CheckPointStore{Set,Get}` 自定义 | 自定义类型须 `gob.RegisterName` |
| Mastra | step 输入输出 + workflow state | 每次 suspend 生成 snapshot | 配置的 storage provider | `resume({step, resumeData})` |
| CrewAI Flows | `self.state`（dict 或 Pydantic，自动 `id`） | 方法级 `@persist` | `SQLiteFlowPersistence` | 续跑 vs 分叉两种 hydration |
| DeerFlow | `ThreadState(AgentState)` + 运行事件存储 | LangGraph checkpointer + delta 模式 + Redis 缓存 | SQLite/Postgres | 分支/重生成基于检查点父链 |

### 3. 人机中断（HITL）协议对比

```text
共同三段式：
  (1) 引擎暂停并暴露  pending_request{ id, kind, payload, schema }
  (2) 外部系统持久化 request_id，异步收集人类决定
  (3) resume(session_ref, { request_id: response })
```

| 框架 | 触发 | 暴露形态 | 恢复调用 | 差异点 |
|---|---|---|---|---|
| LangGraph | `interrupt(payload)` | `result["__interrupt__"]` / `stream.interrupts[i].{id,value}` | `graph.invoke(Command(resume=v or {id:v}), config)` | 节点重跑、幂等要求；静态 `interrupt_before/after` 仅调试 |
| MAF | `ctx.request_info(request_data, response_type)`；`@tool(approval_mode="always_require")` | `WorkflowEvent.type=="request_info"`，`event.request_id`，数据为自定义类型或 `Content(type="function_approval_request")` / `HandoffAgentUserRequest` / `MagenticPlanReviewRequest` | `workflow.run(responses={request_id: resp}, checkpoint_id=...)` | 检查点恢复会重新发出 pending 请求；as_agent 后变成 function call |
| OpenAI | `needs_approval` | `RunResult.interruptions: [ToolApprovalItem]` | `Runner.run(agent, state)` | `always_approve` 粘性决定；hosted MCP `require_approval` |
| ADK 2.0 | 图节点内建 | `RequestedInput` 信号 | 框架内建恢复 | 1.x 需自定义工具 + LongRunningFunctionTool |
| Eino | `Interrupted{InterruptInfo}` action | `AgentEvent.Action.Interrupted` | `Runner.Resume(ctx, cpID)` / `ResumeWithParams(Targets)` | 可按 agent 地址精确回填 |
| Mastra | `suspend(payload)` | `result.status=="suspended"`, `result.suspended` | `run.resume({step, resumeData})` | 需 `resumeSchema` |
| CrewAI | `@human_feedback` | `HumanFeedbackResult` | 流程自动继续 | 可 `emit` 路由标签 |
| Dify | Human Input 节点 | 表单 + 按钮 | 平台内建（Celery worker 恢复） | 全局超时 7 天 |
| A2A | — | `TaskState=INPUT_REQUIRED / AUTH_REQUIRED` | 再发 `message/send` 带同一 `taskId` | 协议级语义，与引擎无关 |

## 可编程接入面

### LangGraph / LangSmith Agent Server

```python
# 远端图作为本地子图（跨部署）
from langgraph.pregel.remote import RemoteGraph
remote = RemoteGraph("agent", url="<DEPLOYMENT_URL>")      # 或 sync_client=get_sync_client(url=...)
builder.add_node("child", remote)
graph.stream(input, config={"configurable": {"thread_id": uuid}}, subgraphs=True)

# 托管 API（SDK）
thread = await client.threads.create()
run = await client.runs.create(thread["thread_id"], assistant_id, input=..., multitask_strategy="enqueue")
await client.runs.join(thread["thread_id"], run["run_id"])           # status: pending -> success
state = await client.threads.get_state(thread["thread_id"])
```

- 资源：Assistants（配置版本）、Threads、Runs、Cron、Store。
- 认证：`langgraph.json` 的 `"auth": {"path": "./auth.py:my_auth"}`；`@auth.authenticate` / `@auth.on`。
- DeerFlow 直接复用了这套 API 形状（`/api/langgraph/*`、`stream_mode`、`multitask_strategy`），说明"LangGraph Server API"已成为一种事实上的网关接口风格 [已确认]。

### Microsoft Agent Framework

```python
# 把远端 A2A agent 当成普通 Agent 用
from agent_framework.a2a import A2AAgent
async with A2AAgent(name="remote", url="http://remote-agent/a2a", auth_interceptor=BearerAuth(token)) as agent:
    response = await agent.run("Hello!")
# 把本地 Agent 暴露为 A2A 服务：A2AExecutor(agent, stream=True) + a2a-sdk DefaultRequestHandler
# 把整个工作流当成 Agent：workflow.as_agent(name=...)
```

- Python 包：`agent-framework`, `agent-framework-a2a`, `agent-framework-azure-cosmos`（检查点）, `agent-framework-tools`（shell，预发布）。
- 事件：`workflow.run(task, stream=True)` 产生 `WorkflowEvent{type: output|intermediate|request_info, executor_id, request_id, data}`。
- .NET 暴露 A2A 后的调用形状：`POST /a2a/pirate/v1/message:stream` 带 `message.contextId`，同一 `contextId` 即同一对话。

### OpenAI Agents SDK

```python
result = await Runner.run(agent, "input", session=SQLiteSession("thread_abc"),
                          run_config=RunConfig(workflow_name="gw", group_id=biz_key,
                                               trace_metadata={...}, session_settings=SessionSettings(limit=50)))
if result.interruptions:
    state = result.to_state(); persist(state.to_json())
```

- 四原语 + tracing + sessions；durable 编排官方推荐 Dapr / Temporal / Restate / DBOS 集成。

### Google ADK

```python
from google.adk.agents.remote_a2a_agent import RemoteA2aAgent, AGENT_CARD_WELL_KNOWN_PATH
remote = RemoteA2aAgent(name="prime_agent", agent_card=f"http://localhost:8001/a2a/check_prime_agent{AGENT_CARD_WELL_KNOWN_PATH}")
root = Agent(name="root", sub_agents=[local_agent, remote])
# 暴露
from google.adk.a2a.utils.agent_to_a2a import to_a2a
a2a_app = to_a2a(root_agent, port=8001)   # uvicorn 启动；/.well-known/agent-card.json 自动生成
```

- CLI：`adk web`、`adk api_server --a2a --port 8001 <agent_dir>`（只暴露含 `agent.json` 的目录）。
- 多语言：Python `google-adk`、TS `@google/adk`、Go `google.golang.org/adk/v2`、Java/Kotlin `com.google.adk`。

### Eino ADK（Go）

```go
runner := adk.NewRunner(ctx, adk.RunnerConfig{Agent: agent, EnableStreaming: true, CheckPointStore: store})
iter := runner.Run(ctx, msgs, adk.WithSessionValues(map[string]any{"user":"alice"}), adk.WithCheckPointID("cp-123"))
for { ev, ok := iter.Next(); if !ok {break}; if ev.Action != nil && ev.Action.Interrupted != nil { /* 持久化 cp-123 */ } }
iter, _ = runner.ResumeWithParams(ctx, "cp-123", &adk.ResumeParams{Targets: map[string]any{"agent-address": data}})
```

### AgentScope 2.0 Agent Service

```text
POST /chat                         -> {"status":"started","session_id":"..."}   (X-User-ID 头标识租户；同 session 并发 -> 409)
GET  /sessions/{id}/stream          -> SSE（带 replay buffer）
POST /sessions/{id}/interrupt       -> 停止运行/parked 的 run
GET/POST/PATCH/DELETE /sessions | /agent | /credential | /schedule
GET/POST /workspace/mcp | /workspace/skill
GET  /model?provider=<name>         -> ModelCard
```

```python
from agentscope.app import create_app
app = create_app(storage=RedisStorage(...), message_bus=RedisMessageBus(...),
                 workspace_manager=LocalWorkspaceManager(basedir=..., ttl=3600),
                 extra_middlewares=[Middleware(AGUIProtocolMiddleware)],   # 协议适配（AG-UI / A2A）
                 extra_agent_middlewares=..., extra_agent_tools=..., custom_agent_cls=CustomAgent)
```

### DeerFlow 2.0 Gateway

```text
POST /api/threads                                   POST /api/threads/{tid}/runs/stream
POST /api/langgraph/runs/stream (无状态，自动建线程)   POST /api/threads/{tid}/runs/{rid}/cancel?action=interrupt|rollback
GET  /api/threads/{tid}/runs/{rid}/events            GET /api/models/{name} -> supports_thinking/supports_vision
Authorization: Bearer dfp_<pat>   或   X-DeerFlow-Internal-Token + X-DeerFlow-Owner-User-Id
```

请求体：`{"input":{"messages":[...]},"config":{"configurable":{"model_name":"gpt-4","thread_id":"...","thinking_enabled":false,"is_plan_mode":false}},"stream_mode":["values","messages-tuple","custom"],"multitask_strategy":"reject|interrupt|rollback"}`。

### Agno AgentOS / Letta / CrewAI / Mastra

- Agno：`POST /agents|teams|workflows/{id}/runs`，`session_id + user_id`，SSE；`GET /info` 发现认证模式与 MCP 挂载。
- Letta：`client.conversations.create(agent_id=..., model=...)`、`client.conversations.messages.create(cid, messages, stream_tokens=True)`；`client.blocks.create(...)` + `block_ids` 共享记忆。
- CrewAI：`Flow.kickoff(inputs={"id": uuid})` 续跑；Mastra：`run.start()` / `run.resume()` / `workflow.getWorkflowRunById()`。

## 会话模型

| 引擎/框架 | 会话主键 | 用户/租户键 | 并发策略 | 上下文压缩 |
|---|---|---|---|---|
| LangGraph (OSS) | `configurable.thread_id`（<255，建议 UUID） | 无（由调用方在 `context_schema` 传） | 无（托管版 `multitask_strategy`） | 自建（DeerFlow 用 SummarizationMiddleware） |
| LangSmith Deployment | `thread_id` + `assistant_id` | `@auth.authenticate` identity；`@auth.on` 过滤器 | `enqueue/reject/interrupt/rollback` | — |
| MAF | `AgentSession`（agent 自建，不同 provider 实现不同，故编排时不共享）；A2A `context_id`→`session_id` | 应用层 | — | Harness compaction；`context_mode` |
| OpenAI Agents SDK | `session_id`（自管）或 `conversation_id/previous_response_id`（服务端） | `wrapper: RunContextWrapper` 做租户路由 | — | `OpenAIResponsesCompactionSession` |
| Google ADK | `(app_name, user_id, session_id)`；`Session.state` 前缀 `user:/app:/temp:` | `user_id` 一等公民 | — | — |
| Eino ADK | `WithCheckPointID` + `WithSessionValues` | 自定义 | TurnLoop Preempt | Summarization/Reduction 中间件 |
| AgentScope 2.0 | `session_id` | `X-User-ID`（默认无认证）；workspace `per_user/per_session/per_agent` | 单 session 单 run，409 | 自动 compaction + tool-result offload |
| DeerFlow | `thread_id`（UUID 或自定义） | PAT 所有者 / `X-DeerFlow-Owner-User-Id` | `multitask_strategy` | `/compact`、Summarization |
| Agno | `session_id` + `user_id` | jwt / security_key | — | — |
| Letta | `agent_id` + `conversation_id`（并行会话共享 memory blocks） | 项目/API key | 每 conversation 独立写入 | 自动 |
| A2A | `contextId`（会话）+ `taskId`（工作单元） | `securitySchemes` | 协议无规定 | — |

**对群助手场景的映射 [推测]**：`biz_key = (channel, group_id)` → 网关 `session_map[biz_key] = {engine, engine_session_ref, user_scope, version}`；同群连续性靠 engine_session_ref 复用，跨群隔离靠不同 ref + 引擎级 workspace 隔离（AgentScope `per_session`、DeerFlow `.deer-flow/threads/{thread_id}/`、OpenAI Sandbox `snapshot`）。

## 权限与安全

- **工具审批**：MAF `@tool(approval_mode="always_require")` / `ApprovalRequiredAIFunction`；OpenAI `needs_approval`（含 `always_approve` 粘性）；Harness "standing approvals + auto-approval rules"；AgentScope "confirmation and bypass modes"、explore 模式只读锁；DeerFlow `authorization.enabled` RBAC——按 principal 对 tool/route/model/skill/sandbox 做 allow/deny，**被拒工具直接从模型 schema 中移除**。
- **网关级凭证隔离**：AgentTeams 的模式最值得借鉴——Higress AI Gateway 持有真实 LLM/MCP 凭证，worker 只拿 consumer token；DeerFlow PAT 只有 thread/run 生命周期 scope、永不携带 admin；Agno `agno_pat_` 服务账号。
- **资源级授权**：LangSmith `@auth.on` 对 threads/assistants/runs/store/crons × create/read/update/delete/search 返回 owner 过滤器；AgentScope 所有资源按 `user_id` 归属并在路由层校验。
- **检查点是信任边界**：MAF 明确"never load checkpoints from untrusted sources"，pickle 受限白名单；Eino gob 同理 [推测]。
- **A2A 安全**：AgentCard `securitySchemes`（API Key / OAuth2 / OIDC / mTLS）、签名卡片、`agent/getAuthenticatedExtendedCard` 分级披露能力。

## 扩展机制与资产

| 资产类型 | 各框架形态 | 归一化建议 [推测] |
|---|---|---|
| 技能 (Skills) | DeerFlow `SKILL.md`（frontmatter：name/description/license/allowed-tools，`/mnt/skills/{public,custom,integrations}`）；MAF Agent Skills（`skills_paths`）；AgentScope Skill Hub（ClawHub）；OpenAI Sandbox `Capabilities.skills`；Eino `Skill` 中间件 | 采用 `SKILL.md` 目录约定作为公共资产格式，网关按引擎能力决定挂载方式 |
| MCP | DeerFlow `extensions_config.json`（stdio/SSE/HTTP，`tool_name_prefix`，OAuth）；OpenAI `MCPServerStdio/Sse/StreamableHttp` + `HostedMCPTool`；AgentScope `/workspace/mcp`；ADK/MAF 原生 | MCP server 清单是公共资产；审批策略是引擎参数 |
| 中间件/钩子 | DeerFlow 自定义 `AgentMiddleware`（`extensions.middlewares`）；AgentScope `extra_middlewares`/agent middlewares；Eino `ChatModelAgentMiddleware`（FileSystem/Skill/Summarization/Reduction/PlanTask/ToolSearch/PatchToolCalls/AgentsMD）；OpenAI hooks + guardrails；MAF middleware + context providers | 归一为"前置/后置拦截点"，但实现留在引擎侧 |
| 配置资产 | LangSmith Assistant 版本化配置；DeerFlow `config.yaml`（`use: langchain_openai:ChatOpenAI` 反射加载模型）；AgentScope Agent 模板 + Credential；Agno Agent/Team/WorkflowFactory 动态创建 | 网关维护"节点配置版本"，参考 Assistant 的整包更新语义 |
| 沙箱 | DeerFlow Local/Docker(AIO)/E2B/K8s provisioner；AgentScope local/Docker/Apple Container/Bubblewrap/E2B/OpenSandbox/Daytona/K8s；OpenAI `UnixLocalSandboxClient/DockerSandboxClient`；AgentScope Runtime（已归档）Base/Browser/Filesystem/GUI/Mobile | 沙箱类型与工作目录映射（`/mnt/workspace|outputs|uploads|skills`）是扩展能力参数 |

## 记忆

- **短期/线程内**：checkpointer（LangGraph）、Session（OpenAI/ADK/MAF）、conversation（Letta）。
- **跨线程长期**：LangGraph `BaseStore`（namespace + put/get/search）；ADK `MemoryService`（`VertexAiRagMemoryService`/`VertexAiMemoryBankService`）；AgentScope 可切换后端 ReMe/Mem0；DeerFlow 自动 capture/recall + OpenViking 后端；MAF Harness "file memory"；OpenAI Sandbox `Capabilities.memory`。
- **共享记忆作为协作原语**：Letta 共享 memory block（`block_ids`，`read_only`，并发建议 insert 安全 / rethink 不安全）；Eino `AddSessionValue/GetSessionValue` 单次 run 内共享 KV；ADK `session.state` + `output_key`；CAMEL `share_memory`。
- 归一化建议 [推测]：网关只定义"记忆句柄"（scope: session|user|app|team，backend ref），读写留给引擎；跨引擎共享时通过 MCP memory server（如 OpenViking 的 MCP 端点）而非复制。

## 多 Agent 与协作

### 上下文同步策略（跨引擎最大差异点）

| 策略 | 出处 | 参数 |
|---|---|---|
| 全量历史转移 | OpenAI handoff 默认；MAF handoff/group chat 广播（工具内容不广播） | `input_filter`, `nest_handoff_history` |
| 只传上一位输出 | MAF `context_mode="last_agent"`、`SequentialBuilder(chain_only_agent_responses=True)`；LangGraph supervisor `output_mode="last_message"` | — |
| 自定义过滤 | MAF `context_filter`；OpenAI `handoff_filters.remove_all_tools`；`RunConfig.handoff_input_filter` | callable |
| 隔离子上下文 | DeerFlow 子 agent "scoped context, tools, termination conditions"；Eino DeepAgents 子 agent 隔离上下文；OpenAI agent-as-tool | — |
| 共享房间 | AgentTeams Matrix room（人类始终在场）；AgentScope `MsgHub` | room id |

### "异构 agent 作为节点"的四条路径

1. **RemoteGraph（同构远程）**：仅 LangGraph→LangGraph；子图共享 `thread_id`；同部署内禁用。适合把 DeerFlow 这类 LangGraph 服务当子图。
2. **A2A 客户端（异构远程，推荐）**：ADK `RemoteA2aAgent`、MAF `A2AAgent`、AgentScope（Runtime 期 A2A 暴露；2.0 通过协议中间件）。契约 = AgentCard + Message/Task；会话 = `contextId`；长任务 = Task 状态机 + streaming/push；中断 = `INPUT_REQUIRED`。
3. **agent-as-tool（进程内/函数式）**：结构化入参、不转移会话控制权、父 agent 保留 ownership（MAF 文档把这条与 handoff 的区别写得最清楚）。
4. **handoff（对话所有权转移）**：接收方获得完整上下文与任务所有权。

**对"节点 = 引擎 + 能力配置"的启示 [推测]**：一个节点描述应包含 `{engine, engine_version, endpoint/adapter, session_binding(policy), capabilities_required, capability_params, context_policy(full|last|filter|isolated), resume_semantics(rerun_node|replay_checkpoint|state_blob), auth_scheme}`。其中前四项可由 AgentCard 自动填充；后三项来自引擎能力清单。

## 可观测性

- **OpenAI**：内建 trace/span 词表（agent/generation/function/guardrail/handoff/custom/task/turn），`TracingProcessor` 可多路导出；敏感数据开关。
- **MAF**：Harness 默认开启 OpenTelemetry；工作流事件流本身可观测（`executor_id`、`request_id`）。
- **ADK 2.0**：Event 新增 `node_info`（发出节点）、`output`、`route`——天然可映射为 span 属性。
- **Eino**：callbacks OnStart/OnEnd/OnError/OnStartWithStreamInput/OnEndWithStreamOutput；`AgentEvent.RunPath` 给出执行路径。
- **DeerFlow**：持久化运行事件契约（`seq` 严格递增、`event_type`/`category`、`subagent.start|step|end`）+ LangSmith/Langfuse/Monocle(OTel) + `X-Trace-Id` 跨服务关联 + SSE `gap` 事件的重放缺口语义。
- **AgentScope**：统一事件总线 + Studio 可视化 + tracing（OTel 兼容）。
- **AG-UI**：前端事件协议覆盖 run/step/message/tool/state/reasoning/subagent，`STATE_DELTA` 用 RFC 6902。

归一化建议 [推测]：网关统一事件 = AG-UI 词表 ∪ {`request_info`, `route/transfer`, `checkpoint`}；每条事件带 `{biz_key, engine, engine_session_ref, run_id, seq, node_id, parent_run_id}`；同时用 OTel GenAI 语义约定导出 span，把 DeerFlow 的 `seq + gap` 作为断线重放规范。

## 对我们架构的启示（公共能力 vs 扩展能力映射表、接入参数、风险与坑）

### 公共能力（可归一化）

| 公共能力 | 归一化接口 | 各引擎落点 |
|---|---|---|
| 会话创建/续接 | `session.create(biz_key) -> ref`, `session.resolve` | thread_id / session_id / contextId / conversation_id |
| 运行与流式事件 | `run(ref, input, config) -> events` | `runs.stream` / `workflow.run(stream=True)` / `Runner.run_streamed` / `runner.Run` / `/chat`+`/stream` |
| 取消/抢占 | `run.cancel(ref, run_id, mode=interrupt|rollback)` | LangSmith rollback、DeerFlow `?action=`、Eino CancelMode/TurnLoop Preempt、AgentScope `/interrupt`、AutoGen CancellationToken |
| 并发策略 | `double_text_policy` | enqueue/reject/interrupt/rollback（仅部分引擎） |
| 中断/审批 | `pending_requests[]` + `resume(ref, {request_id: resp})` | 见 HITL 表 |
| 检查点/回放 | `checkpoint.list/branch` | LangGraph/MAF/CrewAI/Mastra |
| 工具/MCP 挂载 | `tools.attach(ref, mcp_manifest, approval_policy)` | 全部 |
| 技能挂载 | `skills.attach(ref, SKILL.md paths)` | DeerFlow/MAF/AgentScope/OpenAI Sandbox/Eino |
| 记忆句柄 | `memory.bind(scope, backend_ref)` | Store/MemoryService/ReMe/Mem0/blocks |
| 观测 | 统一事件 + OTel span | 全部 |
| 认证 | AgentCard `securitySchemes` / PAT / JWT | A2A、DeerFlow、Agno、LangSmith |

### 引擎特有扩展能力（须能力协商）

| 扩展能力 | 引擎 | 关键配置参数 |
|---|---|---|
| dynamic workflow / 图运行时 | LangGraph、ADK 2.0、Eino Graph、MAF Workflows | `recursion_limit`、`Send` 扇出、`node_info` 路由 |
| plan-execute / Magentic | MAF、Eino PlanExecute/DeepAgents、CAMEL Workforce | `max_round_count/max_stall_count/max_reset_count/enable_plan_review`；Workforce `task_timeout_seconds/share_memory` |
| handoff / swarm | OpenAI、MAF、LangGraph swarm | `nest_handoff_history`、`with_autonomous_mode(turn_limits, prompts)`、`default_active_agent` |
| agent team（leader-worker） | AgentScope 2.0、AgentTeams、Agno Team | `custom_subagent_templates`、`TeamMode.route/coordinate/broadcast`、Worker CRD |
| room（人类可见协作房间） | AgentTeams（Matrix）、AgentScope MsgHub | room/hub id、参与者列表 |
| background agents / offload | MAF Harness、AgentScope ToolOffloadMiddleware、DeerFlow batch_task | `BackgroundAgents`、wakeup 队列 |
| 沙箱/工作区 | DeerFlow、AgentScope、OpenAI Sandbox | provider(local/docker/e2b/k8s)、`snapshot`、mount 映射 |
| 自进化/记忆重写 | Letta（agent 自编辑 block、sleep-time agent）、AgentScope Agentic Memory | block 所有权、并发写策略 |
| 并行会话共享记忆 | Letta conversations | `agent_id` + per-conversation model override |
| 定时/自治调度 | AgentScope Schedule、LangSmith Cron | cron、stateful/stateless |
| 多语言运行时 | ADK(Py/TS/Go/Java/Kotlin)、MAF(.NET/Py/Go)、Eino(Go) | 进程内 vs A2A |

### 新引擎接入标准流程（能力识别→适配→认证）[推测，基于上述事实]

1. **识别**：优先抓 `/.well-known/agent-card.json`（A2A）；无 A2A 则读取引擎自带发现接口（Agno `GET /info`、DeerFlow `GET /api/models`、AgentScope `GET /model`）；生成"能力清单 v{engine_version}"。
2. **适配**：实现 `EngineAdapter{create_session, run_stream, resume, cancel, attach_tools, attach_skills, checkpoint}`，并声明 `resume_semantics` 与 `context_policy` 支持集；对 LangGraph 系引擎可直接复用 LangGraph Server API 客户端（DeerFlow 已证明该 API 可被独立实现）。
3. **认证**：把引擎凭证留在网关（AgentTeams/Higress 模式），向引擎会话下发短期 consumer token；对外用 PAT scope（DeerFlow 的 `threads:*`/`runs:*` 是很好的最小集）。
4. **一致性测试**：跑一套跨引擎 conformance（多轮连续性、跨群隔离、中断-恢复、取消、事件 seq 单调、检查点重建）。

### 风险与坑

- LangGraph interrupt 的"节点重跑"会重复副作用；网关在中断前后要求节点幂等，或把外部副作用放到 `@task`。
- MAF 检查点重建强依赖 agent `Id/Name` 稳定；网关生成节点 id 时不能用会话/请求 id。
- MAF 与 OpenAI 的 HITL 都会因为 SDK/prompt 变更导致旧 pending 状态不兼容——必须随 pending 请求保存 `engine_version` 与 `node_config_version`。
- A2A `contextId` 由服务端也可生成（MAF 文档：不传则自动生成），网关必须以首个响应回填映射表。
- AgentScope Agent Service 默认 `X-User-ID` 无认证；DeerFlow 内部认证头绕过 users 表——两者都要求网关是唯一入口。
- RemoteGraph 不能在同一部署内自调用；Mastra Networks 已弃用；AgentScope Runtime 已归档——接入面要选长期维护的路径（A2A / Agent Service）。
- 框架事件词表不一致（MAF `intermediate` vs LangGraph `updates` vs DeerFlow `middleware:{tag}`），归一化时保留 `raw_event` 字段（AG-UI `RAW` 的做法）。

## 未解决问题

1. A2A v1 对"工具审批"没有专门状态（只有 `INPUT_REQUIRED/AUTH_REQUIRED`），审批载荷格式需以 A2A extension 约定；尚未找到跨厂商共识。
2. ADK 2.0 图工作流的具体 Python API（节点/边构造函数、条件路由写法）本次仅从 2.0 概览页确认了运行时模型，细节页（`docs/workflows/patterns.md`、`collaboration.md`）未抓到全文。
3. AgentScope 2.0 的 `pipeline`（2026-08 新增）与 `MsgHub` 精确 API 未在一手页面读到（文档站路径 404），仅从 README 确认存在。
4. LangGraph `durability` 模式（"exit"/"async"/"sync"）与 `StateSnapshot` 字段的页面抓取不完整，需回到参考站核实。
5. Eino ADK 是否原生提供 A2A server/client（eino-ext）未确认；仅确认 MCP 与 Coze Studio 基于 Eino。
6. MAF Python 侧 A2A "session_id ← context_id" 的反向映射（任务级 `taskId` 如何对应 workflow checkpoint）未见文档。
7. 各引擎在同一 `biz_key` 下热切换（A→B）时的历史迁移格式（OpenAI `to_input_list()`、LangGraph `messages`、A2A `history`）需要一个中立的 transcript schema，本次未找到现成标准。

## 来源列表

- https://docs.langchain.com/oss/python/langgraph/graph-api
- https://docs.langchain.com/oss/python/langgraph/interrupts
- https://docs.langchain.com/oss/python/langgraph/persistence
- https://docs.langchain.com/oss/python/langchain/multi-agent
- https://docs.langchain.com/langsmith/use-remote-graph
- https://docs.langchain.com/langsmith/assistants
- https://docs.langchain.com/langsmith/double-texting
- https://docs.langchain.com/langsmith/agent-server
- https://docs.langchain.com/langsmith/custom-auth
- https://docs.langchain.com/langsmith/background-run
- https://reference.langchain.com/python/langgraph-supervisor/supervisor
- https://reference.langchain.com/python/langgraph-swarm/swarm
- https://learn.microsoft.com/en-us/agent-framework/
- https://learn.microsoft.com/en-us/agent-framework/concepts/harness
- https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/
- https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff
- https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic
- https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat
- https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop
- https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints
- https://learn.microsoft.com/en-us/agent-framework/workflows/agents-in-workflows
- https://learn.microsoft.com/en-us/agent-framework/workflows/as-agents
- https://learn.microsoft.com/en-us/agent-framework/concepts/workflows/advanced/agent-executor
- https://learn.microsoft.com/en-us/agent-framework/integrations/a2a
- https://devblogs.microsoft.com/agent-framework/a2a-v1-is-here-cross-platform-agent-communication-in-microsoft-agent-framework-for-net/
- https://techcommunity.microsoft.com/blog/azuredevcommunityblog/the-future-of-agentic-ai-inside-microsoft-agent-framework-1-0/4510698
- https://github.com/microsoft/autogen
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html
- https://openai.github.io/openai-agents-python/
- https://openai.github.io/openai-agents-python/handoffs/
- https://openai.github.io/openai-agents-python/human_in_the_loop/
- https://openai.github.io/openai-agents-python/sessions/
- https://openai.github.io/openai-agents-python/tracing/
- https://openai.github.io/openai-agents-python/tools/
- https://openai.github.io/openai-agents-python/guardrails/
- https://openai.github.io/openai-agents-python/running_agents/
- https://openai.github.io/openai-agents-python/sandbox_agents/
- https://adk.dev/
- https://adk.dev/2.0/
- https://adk.dev/workflows/
- https://adk.dev/sessions/
- https://adk.dev/a2a/intro/
- https://adk.dev/a2a/quickstart-consuming/
- https://adk.dev/a2a/quickstart-exposing/
- https://github.com/google/adk-docs/tree/main/docs/workflows
- https://a2a-protocol.org/latest/specification/
- https://github.com/agentscope-ai/agentscope
- https://raw.githubusercontent.com/agentscope-ai/agentscope/main/README_zh.md
- https://docs.agentscope.io/versions/2.0.4/en/deploy/agent-service
- https://github.com/agentscope-ai/agentscope-runtime/blob/main/README.md
- https://github.com/agentscope-ai/AgentTeams
- https://github.com/cloudwego/eino
- https://www.cloudwego.io/docs/eino/core_modules/eino_adk/
- https://www.cloudwego.io/docs/eino/core_modules/eino_adk/agent_preview/
- https://www.cloudwego.io/docs/eino/core_modules/eino_adk/agent_extension/
- https://www.cloudwego.io/docs/eino/core_modules/eino_adk/agent_implementation/
- https://www.cloudwego.io/zh/docs/eino/overview/eino_adk0_1/
- https://github.com/bytedance/deer-flow
- https://raw.githubusercontent.com/bytedance/deer-flow/main/README.md
- https://raw.githubusercontent.com/bytedance/deer-flow/main/backend/docs/ARCHITECTURE.md
- https://raw.githubusercontent.com/bytedance/deer-flow/main/backend/docs/API.md
- https://raw.githubusercontent.com/bytedance/deer-flow/main/backend/docs/RUN_EVENT_STREAM.md
- https://github.com/bytedance/deer-flow/tree/main/backend/docs
- https://docs.crewai.com/en/concepts/flows
- https://mastra.ai/docs/agents/networks
- https://mastra.ai/en/docs/workflows/suspend-and-resume
- https://mastra.ai/docs/workflows/overview
- https://docs.agno.com/agent-os/using-the-api
- https://docs.agno.com/concepts/teams/introduction
- https://docs.letta.com/guides/agents/conversations/
- https://docs.letta.com/guides/agents/multi-agent-shared-memory/
- https://docs.letta.com/guides/agents/multi-agent/
- https://docs.camel-ai.org/key_modules/workforce
- https://github.com/geekan/MetaGPT
- https://github.com/langgenius/dify/discussions/32245
- https://docs.dify.ai/en/use-dify/nodes/agent
- https://github.com/coze-dev/coze-studio
- https://docs.ag-ui.com/concepts/events
