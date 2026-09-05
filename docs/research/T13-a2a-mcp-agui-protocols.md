# T13 A2A / MCP / AG-UI 等 agent 互操作协议的能力协商设计

## 摘要
本报告调研了当前三类主流 agent 互操作协议——A2A（agent↔agent 协作，Linux Foundation 治理，2026-04-09 发布 1.0）、MCP（agent↔工具/上下文，JSON-RPC，2025-11-25 版本新增 Tasks/OAuth/扩展框架/Registry）、AG-UI（agent↔前端 UI 的事件流协议）——以及 ANP、NLIP、已并入 A2A 的 IBM ACP 等补充协议。三者代表了三种截然不同的能力发现/协商范式：A2A 是**连接前静态拉取的能力卡片**（AgentCard，含 capabilities/skills/securitySchemes/extensions）；MCP 是**连接建立时的双向握手协商**（`initialize` 中的 capabilities 交换，类似 LSP）；AG-UI 是**几乎无协商、靠事件类型隐式表达能力差异**的事件总线模型。核心结论：赛题"网关↔引擎"层（本地长连接进程、启动时选定引擎、不要求热切换）最适合借鉴 **MCP 式握手协商**思路做能力声明；"网关↔外部系统"层（跨组织、连接成本高）更适合 **A2A 式静态能力卡片**；而"统一可观测协议"目标可以直接复用 **AG-UI 的事件模型**（RUN_*/TEXT_MESSAGE_*/TOOL_CALL_*/STATE_DELTA/CUSTOM）作为各引擎日志/事件归一化的中间表示。扩展能力（dynamic workflow、agent team、room、自进化等）的治理机制上，三个协议均提供了"不破坏核心协议"的命名空间化扩展出口（A2A `extensions` 字段、MCP `_meta`/extension 框架、AG-UI `CUSTOM`/`RAW` 事件），可直接作为我们"公共能力 vs 引擎特有扩展能力"设计的参照范式。

## 关键事实（表格：事实 | 来源 | 置信度 | 是否交叉验证）

| 事实 | 来源 | 置信度 | 交叉验证 |
|---|---|---|---|
| A2A Agent Card 含 `capabilities`（streaming/pushNotifications/extendedAgentCard）、`skills`、`securitySchemes`、`extensions` 字段，用于客户端在调用前做能力校验 | a2a-protocol.org/latest/specification | 高 | 是（与官方规范目录结构一致） |
| A2A Task 状态机：`SUBMITTED→WORKING→(INPUT_REQUIRED/AUTH_REQUIRED)→COMPLETED/FAILED/CANCELED/REJECTED` | a2a-protocol.org/latest/specification | 高 | 否 |
| A2A 1.0 于 2026-04-09 正式发布（Linux Foundation 治理），采用 `Major.Minor` 版本号，客户端需带 `A2A-Version` header，空值按 0.3 解释，不支持版本返回 `VersionNotSupportedError` | a2a-protocol.org/latest/specification；hpcwire 报道 | 高 | 是（规范原文 + 新闻稿口径一致） |
| A2A 1.0 新增 Signed Agent Cards（加密签名的身份/能力声明）、多租户（一个 endpoint 承载多个 agent）、多协议绑定（JSON+HTTP、gRPC、JSON-RPC 三选一或并存）、AgentCard 向后兼容同时声明支持 v0.3 与 v1.0 | a2a-protocol.org 迁移博客 | 高 | 否（单一来源，但与规范条款吻合） |
| A2A 治理：Linux Foundation 下运作，一年内（截至2026年4月）超150家组织参与，深度集成 Google/Microsoft/AWS | linuxfoundation.org 新闻稿；hpcwire | 高 | 是 |
| IBM 的 Agent Communication Protocol (ACP) 于 2025-08-27 并入 A2A，仓库归档，BeeAI 平台转为运行在 A2A 之上；ACP 不再作为独立协议演进 | lfaidata.foundation 官方博客 | 高 | 是（LF AI & Data 官方声明 + 多篇第三方报道口径一致） |
| MCP 基于 JSON-RPC 2.0，三方模型：Host/Client/Server，`initialize` 握手中做 server/client capabilities 协商；Server 侧能力：resources/prompts/tools；Client 侧能力：sampling（服务端发起的递归 LLM 调用）、roots（文件/URI 边界声明）、elicitation（服务端向用户请求补充信息） | modelcontextprotocol.io/specification/2025-06-18 | 高 | 是（规范原文直接陈述） |
| MCP 2025-11-25 版本新增：实验性 Tasks 原语（"call-now fetch-later"，长任务轮询+延迟取回结果，SEP-1686）、URL Mode Elicitation（SEP-1036，敏感流程如OAuth/支付跳转浏览器完成）、Sampling with Tools（SEP-1577，采样请求可带工具定义，支持服务端 agent loop）、OAuth 增强（OIDC Discovery、Protected Resource Metadata/RFC 9728、增量 scope 同意）、tools/resources/prompts 的 icons 元数据、JSON Schema 2020-12 默认方言、正式治理结构与 SDK 分级要求 | modelcontextprotocol.info/specification/2025-11-25/changelog | 高 | 是（WorkOS 博客 + 官方 changelog 口径一致） |
| MCP Registry 正式上线于 registry.modelcontextprotocol.io，采用标准 `server.json` 描述服务器名称/安装方式/发现数据，Anthropic/GitHub/PulseMCP/Microsoft 等参与共建，开源可自建子注册表 | blog.modelcontextprotocol.io/2025-09-08；github.com/modelcontextprotocol/registry | 高 | 是 |
| AG-UI 协议事件分 8 类：Lifecycle（RunStarted/RunFinished/RunError/StepStarted/StepFinished，其中 RunStarted+终止事件为强制边界）、Text Message（Start/Content(delta)/End/Chunk）、Tool Call（Start/Args/End/Result/Chunk）、State（StateSnapshot 全量、StateDelta 用 RFC 6902 JSON Patch 增量、MessagesSnapshot）、Activity、Reasoning（含加密推理值透传）、Subagent（Started/Finished/Error，带 subagentRunId 归因）、Special（Raw/Custom 扩展） | docs.ag-ui.com/concepts/events | 高 | 否（单一来源，但内容详实、字段名具体） |
| ANP（Agent Network Protocol）基于 DID（去中心化标识）与 JSON-LD 图谱做开放网络发现，1.1 版本拆分为多个 Profile：P1 Core Binding(JSON-RPC 2.0)、P2 Identity and Discovery(DID服务发现)，另有消息/加密/联邦相关 Profile | github.com/agent-network-protocol/AgentNetworkProtocol；agentnetworkprotocol.com | 中 | 否 |
| NLIP（Natural Language Interaction Protocol）由 Ecma International 于 2025-12-10 发布 5 项标准+1 技术报告，聚焦人-agent 及 agent-agent 的多轮自然语言交互标准化；Linux Foundation 于 2025-12 成立 Agentic AI Foundation(AAIF)，创始成员含 Anthropic/OpenAI/Block | ecma-international.org 新闻稿 | 中 | 否 |
| 微软已承诺全面支持 A2A（Microsoft Agent Framework 1.0 内置 MCP + A2A 支持，用于跨运行时 agent 协作），并计划在 Windows 11 中原生集成/加固 MCP | devblogs.microsoft.com/agent-framework；ciodive.com | 中 | 是（微软多篇官方博客口径一致） |
| arXiv:2505.02279《A survey of agent interoperability protocols》提出分层采用路线：MCP（工具访问层）→ ACP（多模态消息/会话层，现已并入A2A）→ A2A（协作任务执行层，基于Agent Card能力发现）→ ANP（去中心化开放市场层，基于DID+JSON-LD） | arxiv.org/abs/2505.02279 | 中 | 否（摘要总结，未逐段验证全文） |

## 架构与工作原理

**A2A（Agent2Agent）**定位为"agent 之间"的对等协作协议（区别于 MCP 的"agent 到工具"）。核心对象：
- **AgentCard**：JSON 文档（通常发布于 `/.well-known/agent-card.json` 或类似路径），声明 `name`、`description`、`url`、`capabilities`（`streaming`、`pushNotifications`、`extendedAgentCard` 等布尔/对象开关）、`skills`（每个 skill 有 id/name/description/tags/examples）、`securitySchemes`（API Key、OAuth2、mTLS 等）、`extensions`（自定义能力扩展点，带 URI 标识与 `required` 标志）。这是**静态能力卡片**式发现——客户端在建立会话前先拉取卡片，据此判断对方支持哪些功能，再决定使用哪种交互模式。
- **Task 生命周期**：`SUBMITTED → WORKING → (INPUT_REQUIRED | AUTH_REQUIRED) → COMPLETED | FAILED | CANCELED | REJECTED`。Task 是 A2A 的核心工作单元，可跨多轮 Message 存在；`INPUT_REQUIRED` 让 agent 在处理中途请求澄清（这与我们网关需要的"人在回路/追问"场景高度相关）。
- **Message / Part**：Message 有 `role`（`ROLE_USER`/`ROLE_AGENT`）与 `parts`（文本/文件/结构化数据的容器）；协议明确"结果不应通过 Message 传递"，应使用 **Artifact**（独立于 Message 的产出物概念，类似"最终交付物"）——这一分离（对话消息 vs 产出物）是值得我们网关借鉴的设计。
- **Streaming**：HTTP/REST 绑定用 SSE，事件类型为 `TaskStatusUpdateEvent` 与 `TaskArtifactUpdateEvent`；也支持 gRPC 流。协议要求"事件必须按生成顺序投递"。
- **Push Notifications**：面向断连客户端的异步投递——agent 向客户端注册的 webhook URL POST 状态/产物更新，需 `capabilities.pushNotifications: true` 声明，带认证元数据和重试语义。
- **v0.3 → 1.0**：1.0（2026-04-09 发布）引入了 breaking changes（交互协议层面），但 AgentCard 保持向后兼容，允许同时声明支持 v0.3 与 v1.0 行为，实现渐进迁移；新增 Signed Agent Cards（跨组织信任的加密签名身份声明）、多租户单端点、JSON+HTTP/gRPC/JSON-RPC 三种协议绑定并存、"移除不再符合最佳实践的遗留安全模式"。治理上由 Linux Foundation 托管，一年内超 150 家组织参与，Google/Microsoft/AWS 深度集成。

**MCP（Model Context Protocol）**定位为"应用/agent 到工具与上下文"的协议，采用 Host/Client/Server 三方模型，JSON-RPC 2.0 消息，**有状态连接**，`initialize` 握手阶段做**双向 capabilities 协商**（不是静态卡片，而是连接建立时的握手协商，类似 LSP 的做法——MCP 官方文档明确说明其设计借鉴了 Language Server Protocol）。Server 端可声明的能力：`tools`（AI 模型可调用的函数）、`resources`（供用户或模型使用的上下文数据）、`prompts`（模板化消息/工作流）；Client 端可向 Server 声明的能力：`sampling`（服务端发起的递归 LLM 调用，即工具服务器可以"借用"客户端的模型能力）、`roots`（服务端询问客户端的文件系统/URI 操作边界）、`elicitation`（服务端向用户请求补充信息）。此外还有横切能力：`logging`、`progress`、`cancellation`。

2025-11-25 版本新增的关键能力：
- **Tasks**（实验性，SEP-1686）：任意请求可变为"call-now, fetch-later"模式，返回一个 task handle，客户端轮询状态、延迟取回结果——这直接对应我们赛题网关规范里的 `prompt_async` + `GET /session/{id}/message` 轮询模式，说明 MCP 社区正朝着与我们网关规范相似的"异步任务句柄"模型演进，值得作为网关↔引擎异步交互设计的参照。
- **URL Mode Elicitation**（SEP-1036）：敏感流程（OAuth、支付、API Key）不在 MCP 客户端内直接收集，而是发送一个 URL，让用户在浏览器中完成，之后回调。这是"权限/认证协商"的一种标准化解法。
- **Sampling with Tools**（SEP-1577）：采样请求可携带 `tools`/`toolChoice` 参数，使服务端能够发起完整的"bring your own agent loop"，模糊了"谁在跑 agent loop"的边界。
- **OAuth 强化**：OIDC Discovery、RFC 9728 Protected Resource Metadata、增量 scope 同意（通过 `WWW-Authenticate` 渐进式请求更多权限）。
- **扩展框架**：正式的 extension 命名/发现/配置机制，含轻量注册表/命名空间、显式扩展能力协商、扩展级配置项——允许在不 fork 核心规范的前提下由厂商添加私有能力，这与我们"公共能力 vs 引擎特有扩展能力"的设计目标高度一致。
- **MCP Registry**：官方 `registry.modelcontextprotocol.io`，`server.json` 标准元数据格式（名称、安装方式即 npm/Docker/远程 URL、执行指令），开源、支持自建子注册表联邦。这是一种**中心化/联邦式动态注册**发现模型，与 A2A 的"点对点静态卡片"和 AG-UI 的"无发现层、纯事件协议"形成对照。

**AG-UI** 定位与前两者都不同：它不是"agent 找 agent"或"agent 找工具"的协议，而是**agent 后端与前端 UI 之间的事件流协议**（events over SSE/WebSocket/其他 transport），目标是让任意前端能统一渲染任意 agent 后端的执行过程。核心是一个扁平的事件类型系统：
- Lifecycle：`RUN_STARTED`/`RUN_FINISHED`/`RUN_ERROR`（`RunStarted` 和终止事件是强制的运行边界）、`STEP_STARTED`/`STEP_FINISHED`（可选细粒度）。
- Text Message：`TEXT_MESSAGE_START`/`TEXT_MESSAGE_CONTENT`（`delta`增量）/`TEXT_MESSAGE_END`/`TEXT_MESSAGE_CHUNK`（便捷聚合）。
- Tool Call：`TOOL_CALL_START`/`TOOL_CALL_ARGS`（流式参数片段）/`TOOL_CALL_END`/`TOOL_CALL_RESULT`/`TOOL_CALL_CHUNK`。
- State：`STATE_SNAPSHOT`（全量状态初始化）+ `STATE_DELTA`（RFC 6902 JSON Patch 增量更新）+ `MESSAGES_SNAPSHOT`（含 activity/reasoning 的完整对话历史，"全有全无"语义——出现任一条目即视为完整集合，省略的条目在客户端视为已删除）。
- Activity：`ACTIVITY_SNAPSHOT`/`ACTIVITY_DELTA`，用于结构化的进行中状态（PLAN、SEARCH 等）暴露给前端，比纯文本更利于 UI 渲染进度条/步骤树。
- Reasoning：`REASONING_START`/`REASONING_MESSAGE_*`/`REASONING_ENCRYPTED_VALUE`（跨轮次透传加密的推理内容——这对应了如 OpenAI/Anthropic 部分模型"隐藏推理但需跨轮保留"的场景）。
- Subagent：`SUBAGENT_STARTED`/`SUBAGENT_FINISHED`/`SUBAGENT_ERROR`，带 `subagentRunId` 让前端归因并列渲染多个并发子 agent 的输出。
- 特殊：`RAW`（包裹外部系统事件）、`CUSTOM`（应用自定义扩展，`name`/`value` 键值对）。

AG-UI 的能力协商模型几乎是"无协商"——它假定后端全量实现事件类型集合，前端按需忽略不认识的事件（`CUSTOM`/`RAW` 兜底），这是一种**协议自身即事件总线，能力差异靠事件类型的存在与否隐式表达**，而非显式握手。

## 可编程接入面

- **A2A**：HTTP(S) REST/JSON-RPC/gRPC 三种绑定；Discovery 端点（`.well-known/agent-card.json` 或 `AgentInterface` 指定路径）；Task 相关操作（send message / get task / cancel task / list push notification configs）；官方多语言 SDK（Python/JS/Java/Go 等，由 8 家大厂共同维护，均在向 v1.0 兼容演进）。
- **MCP**：`initialize` (capabilities 握手) → `tools/list`、`tools/call`、`resources/list`、`resources/read`、`prompts/list`、`prompts/get`、`sampling/createMessage`（server→client）、`roots/list`（client→server 声明）、`elicitation/create`（server→client 请求用户输入）、日志/进度/取消的标准 JSON-RPC 通知；传输层支持 stdio（本地子进程）与 Streamable HTTP（远程，含 SSE）。CLI 层面常见形态：`npx @modelcontextprotocol/server-xxx`（stdio）或指定远程 HTTP endpoint + OAuth。
- **AG-UI**：SDK 提供 `Agent`/`RunAgentInput`/事件流封装，典型集成为后端把任意 agent 执行过程转译为 AG-UI 事件流（通过 SSE 或 WebSocket），前端（如 CopilotKit）订阅并按 `threadId`/`runId`/`messageId`/`toolCallId` 分组重建 UI 状态。

## 会话模型

- **A2A**：以 `contextId`/`taskId` 组织跨消息的会话与任务；Task 可长期存在，支持多轮 Message 与中途 `INPUT_REQUIRED` 挂起；无强制"进程内会话"语义，更贴近"任务工单"模型。
- **MCP**：连接级会话（一次 `initialize` 到断开为一个逻辑会话），2025-11-25 引入的 Tasks 原语则在此基础上叠加了跨越多个请求/响应的"任务句柄"异步语义，接近我们赛题网关的 `session` + `prompt_async` 模型。
- **AG-UI**：以 `threadId`（对话）+ `runId`（一次执行）为核心会话坐标，`RunStarted`/`RunFinished`是强制边界，`StateSnapshot`可用于会话恢复/重连后的状态对齐。

## 权限与安全

- **A2A**：`securitySchemes`在 AgentCard 中静态声明（API Key/OAuth2/OIDC/mTLS等），1.0 新增 Signed Agent Cards（对身份和能力的密码学签名，用于跨组织信任链），并"现代化安全流程、移除过时模式"。
- **MCP**：安全模型强调**用户显式同意**（consent-first）——Host 必须在暴露数据/调用工具/发起 sampling 前获得用户明确同意；工具的 annotations/描述被视为不可信（除非来自可信 server）；2025-11-25 引入 OAuth 2.0 Protected Resource Metadata（RFC 9728）、OIDC Discovery、增量 scope 同意（通过 `WWW-Authenticate` 渐进请求）、URL Mode Elicitation（把敏感凭据流程转移到浏览器完成，避免凭据经过 MCP 客户端）。
- **AG-UI**：协议本身不规定权限模型，权限/认证被视为 transport 层（HTTP header、连接建立时的认证）之外的事情，留给宿主应用处理。

## 扩展机制与资产

- **A2A**：显式 `extensions` 字段 + Extension URI + `required` 标志 + 版本兼容跟踪，是一种**声明式、可选/必选区分**的扩展治理模型。
- **MCP**：2025-11-25 正式形成 extension 命名/发现/配置框架（轻量注册表/命名空间、能力协商、扩展设置），此前更多依赖 `_meta` 字段等非正式扩展点；资产层面有 MCP Registry 的 `server.json` 标准元数据（名称、安装方式、执行指令）。
- **AG-UI**：`CUSTOM` 事件（`name`/`value`）与 `RAW`事件（透传外部系统事件，带`source`标识）是其扩展出口，非常轻量，几乎不做治理，把语义完全交给应用层约定。

## 记忆
三个协议均不原生定义"长期记忆"存储模型：
- A2A 的 Task/Message/Artifact 是任务级、有边界的会话产物，不等同于跨 session 的长期记忆；
- MCP 的 `resources` 可以把外部记忆存储（向量库、笔记系统）暴露为可读资源，但记忆的组织/检索逻辑完全由具体 MCP server 实现决定，协议本身只提供"读取上下文"的通道；
- AG-UI 的 `StateSnapshot`/`MESSAGES_SNAPSHOT` 是会话内状态同步机制，不是跨会话记忆。
结论：三者都把"记忆"视为**引擎/服务器侧的实现细节**，仅提供把记忆内容"暴露/传输"到协议另一端的通道，这与我们网关规范中"记忆模型需要在网关层做统一抽象、引擎各自实现"的设计方向一致。

## 多 Agent 与协作
- **A2A** 是天生的多 agent 协议——其存在理由就是"agent 之间对等协作/任务外包"，AgentCard 的 `skills` 让 orchestrator agent 能按能力做路由/委派。
- **MCP** 本身是单向"client 调用 server 工具"模型，但 `sampling` 能力让 server 反向借用 client 的 LLM，2025-11-25 的 Sampling with Tools 进一步让 server 可以驱动完整的子 agent loop，事实上具备了"MCP server 内嵌一个子 agent"的能力，模糊了 MCP 与 A2A 的边界。
- **AG-UI** 提供原生的 Subagent 事件族（`SUBAGENT_STARTED`/`FINISHED`/`ERROR` + `subagentRunId`），用于前端归因和并发渲染多个子 agent 的输出流，这是三者中对"多 agent 可视化"支持最直接的。

## 可观测性
- A2A：状态更新事件（`TaskStatusUpdateEvent`）与产物事件（`TaskArtifactUpdateEvent`）天然构成可观测轨迹，但协议未定义标准 OTel 映射。
- MCP：`logging`、`progress`、`cancellation` 是协议级横切能力，可作为最小可观测通道；社区已有把 MCP 调用映射到 OpenTelemetry span 的实践（非协议强制）。
- AG-UI：其"完整事件流"本身就是面向可观测/可视化设计的（每个 Text/Tool/Reasoning/Activity 都有 Start/Content/End 三段式），非常适合作为**统一可观测协议的事件模型基底**——这对我们"统一可观测协议（各引擎日志/埋点/事件归一化）"目标有直接借鉴价值：可以考虑让网关把各引擎（opencode server API 的 message.part.updated 等）的事件转译为 AG-UI 风格的事件流，对外暴露统一的可观测/前端集成接口。

## 对我们架构的启示（公共能力 vs 扩展能力映射表、接入参数、风险与坑）

**能力发现模型对比与选型建议**：
| 模型 | 代表协议 | 特点 | 适用层 |
|---|---|---|---|
| 静态能力卡片（Agent Card） | A2A | 连接前一次性拉取，声明式，易缓存/易做能力校验，但更新需要重新拉取 | 适合"网关↔外部系统"（跨组织、跨网络边界，连接建立成本高，需要提前决定是否可用某能力） |
| 握手协商（initialize capabilities） | MCP | 连接建立时双向协商，动态但仅在连接生命周期内有效，贴近 LSP 模式 | 适合"网关↔引擎"（本地/内网启动的长连接进程，一次协商全程有效，符合赛题"引擎通过启动参数选择、不要求热切换"的约束） |
| 事件类型隐式表达 | AG-UI | 无显式协商，靠事件类型的存在与否 + CUSTOM/RAW 兜底 | 适合"网关→前端/可观测消费者"这一单向展示层，不适合需要双向能力校验的场景 |
| 动态注册中心 | MCP Registry, A2A(间接) | 中心化/联邦式元数据仓库，`server.json` 标准化 | 适合"引擎/工具市场"发现场景，非运行时协商，是部署前的选型/安装环节 |
| `_meta`/extensions 字段扩展 | MCP `_meta`、A2A `extensions`、AG-UI `CUSTOM` | 三者都提供了"不破坏核心协议"的私有扩展出口，通常要求带命名空间/URI前缀防冲突 | 是我们"引擎特有扩展能力"（dynamic workflow/agent team/room/自进化）的直接参照实现模式 |

**给我们网关+引擎架构的具体建议**：
1. **网关↔引擎**（本地进程，端口 6217，opencode 风格 HTTP+SSE）应采用 **MCP 式握手协商**思路的变体：引擎启动时通过一次 `GET /capabilities`（或复用规范里 `server.connected` SSE 事件的 payload）声明其支持的公共能力集合（是否支持 `/question`、`/permission`、多轮 `prompt_async` 并发、abort 语义等）与扩展能力（dynamic workflow、agent team、room、自进化，各自带配置 schema），网关据此做适配层选择——这本质是把 A2a 的 AgentCard 思路和 MCP 的握手协商思路结合：**静态清单 + 启动时一次性声明**，因为赛题明确"不要求热切换"，无需运行时重新协商。
2. **公共能力** 建议对齐赛题网关规范本身已定义的原语：session 创建/查询/删除、prompt_async（阻塞至本轮结束）、message 轨迹（user/assistant/tool call/tool result/step-finish）、abort、事件流（server.connected/heartbeat/session.status/session.idle/session.error/message.part.updated/question.asked/permission.asked）。这些应作为**跨引擎强制实现**的最小公共能力集，类比 MCP 的 core protocol。
3. **扩展能力**（每个引擎特有）应仿照 A2A `extensions` 字段与 MCP `_meta`/extension 框架的做法：用命名空间化的字段（如 `x-hermes-agentTeam`、`x-opencode-room`）承载，并要求引擎在能力声明里附上该扩展的**配置 JSON Schema**，供网关/上层编排层做参数校验与 UI 生成，同时不影响不支持该扩展的其他引擎正常工作。
4. **可观测性归一化**：建议把各引擎原生事件（如 opencode 的 `message.part.updated`）映射到一套类 AG-UI 的中间事件模型（`TEXT_MESSAGE_*`/`TOOL_CALL_*`/`STATE_DELTA`/`RUN_*`），作为网关对外（日志/UI/评测轨迹）输出的统一格式；这与赛题"统一可观测协议"目标直接对应，且 AG-UI 已经是一个被 CopilotKit 等前端框架验证过的事件模型，可以直接复用其事件命名和语义，降低自造协议的风险。
5. **权限模型**：MCP 的"consent-first + 敏感操作走浏览器 URL（URL Mode Elicitation）"模式适合我们赛题里"Windows 即时通讯发消息"等高风险操作——可以让引擎在需要用户确认的操作上复用赛题网关已定义的 `/permission` 端点语义（`permission.asked` 事件），网关侧统一做二次确认 UI，而不是让每个引擎各自实现确认逻辑。
6. **风险与坑**：
   - A2A/MCP 的版本演进速度很快（A2A 半年内从 0.3 到 1.0，MCP 每年两个大版本），如果把某个协议的具体字段名/版本硬编码进网关核心，未来升级成本高——建议只借鉴其**协商模式的思想**（静态卡片/握手/事件总线/动态注册四种范式的取舍），而不是照搬某协议的当前 schema。
   - AG-UI 的 `STATE_DELTA` 采用 RFC 6902 JSON Patch，实现增量同步时要注意 patch 顺序错乱/丢包会导致状态漂移，需要靠周期性 `STATE_SNAPSHOT`兜底重新同步——我们做多引擎统一事件流时也要设计类似的"快照兜底"机制，避免 SSE 断连后状态不一致。
   - MCP 的 `sampling`/Sampling-with-Tools 让工具服务器可以反向驱动模型甚至跑子 agent loop，如果我们把某个"引擎"实现为 MCP server 挂载在另一个引擎下，要注意递归调用与权限升级的风险（一个引擎的工具服务器背后又跑了一个完整 agent loop，可能绕过网关的会话/权限边界）。
   - ACP（IBM）已并入 A2A（2025-08-27 仓库归档），如果技术选型时看到"ACP"字样，需要先确认指的是哪个 ACP（历史上至少存在多个同名"ACP"，包括 IBM 版本和其他社区的 Agent Communication/Coordination Protocol），避免调研和选型时张冠李戴。

## 未解决问题
- A2A 1.0 的官方 SDK 是否已经全部完成多语言（尤其 .NET/Go）的 1.0 兼容适配，需要进一步核实各 SDK 仓库的 release tag。
- MCP Tasks 原语（2025-11-25 实验性）截至 2026-09 是否已转正（是否在更新的 2026-07-28 RC/正式版中稳定），本次调研未展开抓取该版本细节，需要后续如涉及具体实现时再核实。
- ANP、NLIP 目前在生产环境的真实采用案例较少，本次调研未找到权威的"生产落地"证据，其成熟度评估仍偏推测性质。
- AG-UI 协议是否有官方治理组织（是否已捐赠给某基金会）及其版本号历史，本次未深入核实，只确认了其事件模型本身。

## 来源列表
- https://a2a-protocol.org/latest/specification/
- https://a2a-protocol.org/latest/announcing-1.0/ （重定向至下条）
- https://a2a-protocol.org/latest/blog/2026/03/12/a2a-protocol-ships-v10-production-ready-standard-for-agent-to-agent-communication/
- https://www.hpcwire.com/aiwire/2026/04/09/linux-foundation-a2a-protocol-marks-one-year-with-broad-enterprise-and-cloud-adoption/
- https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
- https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/
- https://modelcontextprotocol.io/specification/2025-06-18
- https://modelcontextprotocol.info/specification/2025-11-25/changelog/
- https://workos.com/blog/mcp-2025-11-25-spec-update （搜索摘要引用）
- https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/
- https://github.com/modelcontextprotocol/registry
- https://registry.modelcontextprotocol.io/
- https://docs.ag-ui.com/concepts/events
- https://arxiv.org/abs/2505.02279 （A survey of agent interoperability protocols: MCP, ACP, A2A, ANP）
- https://github.com/agent-network-protocol/AgentNetworkProtocol
- https://ecma-international.org/news/ecma-international-approves-nlip-standards-suite-for-universal-ai-agent-communication/
- https://devblogs.microsoft.com/agent-framework/a2a-v1-is-here-cross-platform-agent-communication-in-microsoft-agent-framework-for-net/
- https://www.ciodive.com/news/-Microsoft-AI-agent-standard-Google-a2a-interoperability/747593/
