# T12 ACP（Agent Client Protocol, agentclientprotocol.com）完整规范与生态

调研日期：2026-09-04

## 摘要

ACP（Agent Client Protocol）是 Zed 发起、现由 agentclientprotocol 组织（Zed + JetBrains 共同维护，Apache-2.0）治理的 "编辑器/宿主 ↔ coding agent" 协议：JSON-RPC 2.0 over stdio，Agent 作为 Client 子进程运行。v1 稳定（`protocolVersion: 1`），2026 年密集补齐了会话生命周期（`session/list` 03-09、`session/resume` 04-22、`session/close` 04-23、`session/delete` 06-05）、config options（模型/推理等级，02-04 起）、registry（03-09）、`usage_update`（06-05）、`messageId`、`$/cancel_request`、elicitation（07-22）、terminal auth（08-20，SDK 1.7.0），并于 07-20 发布 v2 草案（auth/* 命名空间、load/resume 合并、typed config、新 diff）。`session/update` 有 11 种事件（user/agent/thought chunk、tool_call(_update)、plan、available_commands、current_mode、config_option、session_info、usage）。`_meta` + `_vendor/` 方法提供向前兼容的扩展与能力协商。SDK：TS/Rust 1.x、Python、Kotlin、Java 官方，Go 为社区。生态 ≈40 个 Agent（Gemini CLI、Copilot、Goose、OpenCode、Kimi、Qwen、Hermes、OpenClaw 原生；Claude/Codex/Pi 为适配器）与数十个客户端（Zed、JetBrains、Neovim、Emacs、Obsidian、marimo、acpx、IM 桥）。缺口：远程传输仅 RFD（HTTP/WS Active）、权限粒度为单次调用且无策略通道、无 Client↔Agent 认证、无结构化日志/指标、历史只能回放、无多 agent/记忆/资产原语。结论：ACP 适合作为我们引擎适配层的基线协议，网关需补业务→session 映射、进程池/并发、权限策略、租户隔离、遥测归一化、能力画像与远程传输。

## 关键事实

| # | 事实 | 来源 | 置信度 | 交叉验证 |
|---|------|------|--------|----------|
| 1 | ACP 是 JSON-RPC 2.0 协议，Agent 通常作为 Client 的子进程运行，默认 stdio 传输；当前稳定协议版本 `protocolVersion: 1`（schema/v1），2026-07-20 发布 ACP v2 草案（schema/v2） | agentclientprotocol.com/protocol/overview；github.com/agentclientprotocol/agent-client-protocol；agentclientprotocol.com/updates | 高 | [已交叉验证] |
| 2 | Client→Agent 方法：`initialize`、`authenticate`、`logout`、`session/new`、`session/load`、`session/resume`、`session/list`、`session/delete`、`session/close`、`session/prompt`、`session/set_mode`、`session/set_config_option`；通知 `session/cancel`、`$/cancel_request` | agentclientprotocol.com/protocol/schema；CHANGELOG.md | 高 | [已交叉验证] |
| 3 | Agent→Client 方法：`session/request_permission`、`fs/read_text_file`、`fs/write_text_file`、`terminal/create|output|wait_for_exit|kill|release`、`elicitation/create`；通知 `session/update`、`elicitation/complete` | protocol/overview；protocol/schema | 高 | [已交叉验证] |
| 4 | `agentCapabilities` 字段：`loadSession`、`promptCapabilities{image,audio,embeddedContext}`、`mcpCapabilities{http,sse}`、`sessionCapabilities{list,delete,close,resume,configOptions,modes}`、`auth{logout}`；`clientCapabilities`：`fs{readTextFile,writeTextFile}`、`terminal`、`auth{terminal}`、`elicitation{form,url}`、`session{configOptions}` | protocol/schema | 高 | 与 CHANGELOG 稳定化条目一致 [已交叉验证] |
| 5 | 2026 年稳定化时间线：config options 02-04；registry + `session/list` + `session_info_update` 03-09；`session/resume` 04-22；`session/close` 04-23；`logout` 05-21；`additionalDirectories`/`session/delete`/`usage_update`/`messageId` 06-01~05；`model_config` 06-24；SDK 1.0.0 06-25；`$/cancel_request` 06-29；boolean config 07-06；v2 draft 07-20；elicitation 07-22；terminal auth 08-20（1.7.0） | agentclientprotocol.com/updates；CHANGELOG.md | 高 | [已交叉验证] |
| 6 | 官方 SDK：TypeScript `@agentclientprotocol/sdk`（npm）、Rust `agent-client-protocol`（crates.io）、Python `python-sdk`、Kotlin `acp-kotlin`、Java `java-sdk`；Rust/TS SDK 于 2026-06-25 达 1.0.0；最新 crate 1.7.0（2026-08-20） | GitHub README；updates；CHANGELOG | 高 | [已交叉验证] |
| 7 | `_meta` 扩展：所有类型均带 `_meta: {[key]: unknown}`；根级保留 `traceparent`/`tracestate`/`baggage` 用于 W3C trace context/OTel；自定义方法/通知以 `_` 前缀（如 `_zed.dev/workspace/buffers`）；自定义能力放在 capabilities 的 `_meta` 内 | protocol/extensibility | 高 | 单一来源（官方规范原文） |
| 8 | StopReason：`end_turn`、`max_tokens`、`max_turn_requests`、`refusal`、`cancelled`；ToolCall 状态 `pending/in_progress/completed/failed`；权限选项 kind：`allow_once/allow_always/reject_once/reject_always` | protocol/prompt-turn；protocol/schema | 高 | 部分（状态值两页一致） |
| 9 | `usage_update`（RFD Session Context Size and Cost）：`used`/`size` 上下文 token 与可选 `cost{amount,currency}`，2026-06-05 Completed | rfds/session-usage；updates | 高 | [已交叉验证] |
| 10 | 官方登记的 ACP Agent 约 40 个，含 Gemini CLI、Claude Agent（zed-industries/claude-agent-acp 适配器）、Codex CLI（zed-industries/codex-acp 适配器）、Copilot CLI（2026-01-28 公开预览）、Goose、OpenCode、Kimi CLI、Qwen Code、Junie、Cline、Cursor、Kiro、Hermes、OpenClaw、OpenHands、Pi（社区适配器 svkozak/pi-acp）、Mistral Vibe 等 | get-started/agents；github.blog changelog | 高 | 与 vscode-acp README 一致 [已交叉验证] |
| 11 | 客户端生态：Zed、JetBrains（原生，JetBrains 的 Sergey Ignatov 2026-02-18 成为 Lead Maintainer）、Neovim（CodeCompanion/avante 等）、Emacs agent-shell、Obsidian 多插件、VS Code 多扩展、marimo、Jupyter kernel、acpx（openclaw）、大量 IM 桥（Telegram/Slack/Discord/飞书/微信/QQ/Matrix）、框架（LangChain deepagents、Mastra、Koog、fast-agent） | get-started/clients；updates | 高 | 单来源（官方列表） |
| 12 | 2026-04-22 成立 Transports Working Group，目标标准化 WebSocket/HTTP 远程传输；目前官方规范仍只有 stdio，远程靠社区桥（acp_rpc_bridge、ACP Remote、stdio Bus、acp-gateway） | updates；get-started/clients | 高 | [已交叉验证] |
| 13 | 0.13.6（2026-06-05）删除了 MCP SSE 传输；`mcpCapabilities` 保留 `http`；`session/new` 参数 `cwd`、`mcpServers`、`additionalDirectories` | CHANGELOG；schema | 高 | [已交叉验证] |
| 14 | 社区公认缺口：无标准远程传输、无上下文/成本报告（已于 06 月补 usage_update）、历史导出/会话列举（session/list 03 月才稳定，历史仅靠 session/load 回放）、pi 讨论指出社区适配器缺 fs/terminal 委托、权限路径、MCP 透传、统一会话身份 | github pi discussion #4444；rfds/session-usage；org discussion #871 | 中-高 | 部分 |

## 架构与工作原理

**定位**：ACP（Agent Client Protocol）由 Zed 发起、现由独立 GitHub 组织 `agentclientprotocol` 治理（Apache-2.0，GOVERNANCE.md/MAINTAINERS.md，2026-02-18 JetBrains 的 Sergey Ignatov 加入为 Lead Maintainer），自称"连接任意编辑器与任意 Agent 的协议"，常被类比为"coding agent 的 LSP"。角色划分：**Client**（编辑器/IDE/IM 桥/网关）掌管用户环境（文件系统、终端、权限 UI）；**Agent**（harness）负责思考与工具执行。Agent 通常作为 Client 的**子进程**通过 **stdio 上的 JSON-RPC 2.0** 通信（来源：protocol/overview）。

**生命周期**（v1，`schema/v1/meta.json` 权威方法表，[已交叉验证] 与 docs schema 页一致）：

```
Client → Agent（agentMethods）:
  initialize, authenticate, logout,
  session/new, session/load, session/resume, session/list, session/delete, session/close,
  session/prompt, session/cancel(通知), session/set_mode, session/set_config_option
Agent → Client（clientMethods）:
  session/request_permission, session/update(通知),
  fs/read_text_file, fs/write_text_file,
  terminal/create, terminal/output, terminal/wait_for_exit, terminal/kill, terminal/release,
  elicitation/create, elicitation/complete(通知)
双向 protocolMethods: $/cancel_request(通知, 按 requestId 取消)
```

**握手**：`initialize{protocolVersion, clientCapabilities, clientInfo}` → `{protocolVersion, agentCapabilities, authMethods, agentInfo}`。`clientInfo/agentInfo` 为 `Implementation{name,title,version}`（2025-10-24 加入）。若 `authMethods` 非空则需 `authenticate{methodId}`；`AuthMethod` 有 `type: "terminal"` 变体（1.7.0 稳定 terminal auth，即让 Client 在终端里跑登录命令）。

**Prompt turn**：`session/prompt{sessionId, prompt: ContentBlock[]}` 阻塞直到本轮结束，返回 `{stopReason}`；期间 Agent 通过 `session/update{sessionId, update}` 流式推送，并可反向调用 Client 的 fs/terminal/permission/elicitation 方法。`ContentBlock` 类型：`text | image | audio | resource_link | resource`（与 MCP 内容块对齐；v2 进一步对齐最新 MCP 规范）。`StopReason`：`end_turn | max_tokens | max_turn_requests | refusal | cancelled`（来源：本地解析 schema/v1/schema.json，与 protocol/prompt-turn 页一致 [已交叉验证]）。

**`session/update` 的全部 `sessionUpdate` 判别值（v1 schema 实测 11 种）**：
`user_message_chunk`、`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`、`available_commands_update`、`current_mode_update`、`config_option_update`、`session_info_update`、`usage_update`。
- `tool_call`/`tool_call_update` 字段：`toolCallId, title, kind, status, content, locations, rawInput, rawOutput`；`kind ∈ read|edit|delete|move|search|execute|think|fetch|switch_mode|other`；`status ∈ pending|in_progress|completed|failed`；`content` 变体 `content | diff{path,oldText,newText} | terminal{terminalId}`。
- `plan{entries[{content, priority: high|medium|low, status: pending|in_progress|completed}]}`。
- `available_commands_update{availableCommands[{name, description, input}]}`：slash commands 由 Agent 动态公告，Client 以 `/name` 形式放进 prompt 文本发送。
- `current_mode_update{currentModeId}`；`session/new` 响应返回 `modes: SessionModeState{currentModeId, availableModes[{id,name,description}]}`，Client 用 `session/set_mode{sessionId, modeId}` 切换（如 ask/architect/code、plan/act）。
- `config_option_update` + `NewSessionResponse.configOptions`：`SessionConfigOption` 变体 `select | boolean`，`category ∈ mode|model|model_config|thought_level|其他`；Client 用 `session/set_config_option{sessionId, configId, value}` 修改（模型选择、推理等级等，2026-02-04 稳定；boolean 07-06 稳定；`model_config` 分类 06-24 稳定）。
- `session_info_update`（会话标题等元数据，03-09 稳定）；`usage_update{used,size,cost?{amount,currency}}`（06-05 稳定）。
- 1.7.0（2026-08-20）新增 *unstable* "session compaction updates"（PR #2002），对应社区讨论 #871 的 `context_compacted` 需求。

**v2 草案（2026-07-20，`schema/v2/meta.json` 实测）**：方法重命名/收敛：`auth/login`、`auth/logout`（auth/* 命名空间，必须支持 logout）；`session/load` 与 `session/resume` 合并；`session/list|delete|resume|close` 默认必需；clientMethods 仅列 `session/request_permission`、`session/update`、`elicitation/create|complete`（**fs/terminal 未出现在 v2 meta.json 中**，CHANGELOG 有"v2 terminal output surface""stdio opt-in"等条目，具体去向待确认——推测走 capability/内容面重构）；v2 要求 chunk 携带 `messageId`、"whole-message session updates"、流式 tool-call content、"more flexible permission requests"、tool call/plan 增加 `cancelled` 状态、typed config values、新 diff 格式。**结论：v1 稳定可用，v2 处于 unstable，网关适配层应先绑定 v1 并留升级钩子。**

**session fork**：在 v1/v2 的 meta.json 与 CHANGELOG 中均未找到 `session/fork` 方法；讨论 #871 提到的 `session/fork` 应是客户端（Zed）自身功能或早期 unstable 提案，**协议层不存在**（置信度中）。

## 可编程接入面

1. **进程模型**：网关 `spawn(command, args, env)` 启动 Agent 子进程，stdin/stdout 走换行分隔 JSON-RPC。启动命令可从 **ACP Registry** 获取：`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`，条目字段 `id, name, version, description, repository, distribution{npx|binary|pip|uvx|docker}, command, args, env, icon, authors`（`agent.schema.json`/`registry.schema.json`），CI 验证握手 `authMethods`，每小时 cron 自动同步包版本；目前 50+ 条目（来源：github.com/agentclientprotocol/registry；2026-03-09 发布 [已交叉验证]）。
2. **官方 SDK**：TypeScript `@agentclientprotocol/sdk`（npm）、Rust `agent-client-protocol`（crates.io，另有异步框架 `sacp`）、Python `python-sdk`、Kotlin `acp-kotlin`、Java `java-sdk`；TS/Rust 1.0.0 于 2026-06-25，最新 1.7.0（2026-08-20）。**Go 无官方 SDK**，社区有 `coder/acp-go-sdk`（v0.4.3，typed dispatchers）、`ironpark/acp-go`、`vzvince/acp-go` 等（来源：README、pkg.go.dev 搜索）。其他社区库：Elixir `acpex`、Vercel AI SDK provider `@mcpc/acp-ai-provider`。
3. **典型 Agent 启动命令**（一手/社区文档）：
   - Claude：`npx @agentclientprotocol/claude-agent-acp`（zed-industries/claude-agent-acp，基于 Claude Agent SDK；支持 @-mention、权限、编辑审阅、TODO/plan、嵌套子代理 transcript、交互/后台终端、自定义 slash commands、Client MCP、`goal`/`session failure`/`permission` 等 `_meta` 扩展、草案 `clientCapabilities.subagents`）
   - Codex：`codex-acp`（zed-industries/codex-acp 适配器）；Gemini CLI：`gemini --experimental-acp`（原生）；Copilot：`copilot --acp`（2026-01-28 公开预览）；Goose：`goose acp`；OpenCode/Kimi CLI/Qwen Code/Kiro/Cursor/Hermes/OpenHands/Mistral Vibe 等均为原生实现；Pi 为社区适配器 `svkozak/pi-acp`（Pi 官方 `--mode acp` 正在讨论 #4444，2026-05~07）。（具体 flag 以各自文档为准，此处 Gemini/Goose flag 为训练记忆+社区文章，置信度中。）
4. **Client 侧必须实现**：`session/request_permission` 处理器；可选 `fs.readTextFile/writeTextFile`（让 Agent 读未保存缓冲区/受控写入）、`terminal`（Agent 在 Client 环境执行命令，`terminal/create{sessionId,command,args,env,cwd,outputByteLimit}`，输出 `{output,truncated,exitStatus{exitCode,signal}}`）、`elicitation{form,url}`（结构化表单/URL 交互，07-22 稳定）、`session{configOptions}`、`auth{terminal}`。
5. **远程传输**：官方仅 stdio 稳定；RFD "Streamable HTTP & WebSocket Transport"（PR #721）2026-07-02 进入 Active，设计：单一 `/acp` 端点，POST（initialize 返回 200，其余 202）、GET 开 SSE 长流或 `Upgrade: websocket`、DELETE 结束连接；`Acp-Connection-Id`/`Acp-Session-Id` 头，要求 HTTP/2 与 cookie 粘性，鉴权走 header/查询参数/子协议；v1 不做消息重放，重连由客户端负责；参考实现在 Goose，随后 Rust `sacp`/TS SDK。当前可用的社区桥：`acp_rpc_bridge`（stdio→HTTP）、`acpkit` 的 ACP Remote（WebSocket）、`stdio Bus`、`agentrq/acp-gateway`、OpenClaw `openclaw acp`（stdio ACP ↔ Gateway WebSocket）。
6. **OpenClaw 的两种用法**（docs.openclaw.ai/cli/acp）：`openclaw acp --url wss://host:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main` 把 OpenClaw Gateway 暴露为 ACP Agent（默认每个 ACP 会话映射到 `acp-bridge:` 前缀的隔离 Gateway session key，`--session`/`--session-label`/`--reset-session` 控制映射）；反向用 `/acp spawn` 让 OpenClaw 作为 Client 拉起 Codex/Claude/Gemini 等 ACP harness；`acpx`（openclaw/acpx）是通用 ACP CLI 客户端，配置在 `~/.acpx/config.json` 的 `agents.<name>.command`。这正是"网关 ↔ 引擎"双向桥接的现成样板。

## 会话模型

- **创建**：`session/new{cwd(绝对路径), additionalDirectories?[], mcpServers[]}` → `{sessionId, modes?, configOptions?}`。`McpServer` 变体：stdio（`name, command, args, env[{name,value}]`，必须支持）、`type:"http"`（`url, headers[]`，需 `mcpCapabilities.http`）、`type:"sse"`（已弃用，0.13.6 从 v2 移除）。**MCP 服务器由 Client 注入**——这是网关向引擎下发统一 AI 资产（工具）的标准通道。
- **恢复**：`session/load{sessionId, cwd, mcpServers, additionalDirectories?}`（需 `agentCapabilities.loadSession`）：Agent 用一连串 `session/update`（`user_message_chunk`/`agent_message_chunk`/`tool_call`…，可带 `messageId`）**回放历史**后再响应——这是 ACP 唯一的"历史导出"途径，回放是有损的（只有 UI 可见事件，无原始 LLM 消息）。`session/resume`（04-22 稳定）重连**不回放**；`session/close`（04-23）取消进行中工作并释放资源但保留会话；`session/delete`（06-05）删除历史。
- **枚举**：`session/list{cwd?, cursor?}` → `{sessions[{sessionId, cwd, additionalDirectories, title, updatedAt}], nextCursor}`（03-09 稳定，能力位 `sessionCapabilities.list`）。仅返回元数据，不含消息。
- **并发**：协议未禁止一个 Agent 进程承载多个 session（所有消息都带 `sessionId`，Obsidian Agent Console 等客户端"并行运行多个 ACP agent"），但是否真正支持取决于 Agent 实现（许多适配器单进程单会话）。v2 文档专门"clarify idle session semantics"。
- **取消**：`session/cancel{sessionId}` 通知中断当前 turn（返回 `stopReason: cancelled`）；`$/cancel_request{requestId}`（06-29）取消任意 pending 请求（如挂起的 permission）。
- **模式与配置**：`modes`/`configOptions` 是每会话状态，Agent 可随时用 `current_mode_update`/`config_option_update` 推送变化。
- **子代理会话**：claude-agent-acp 通过草案 `clientCapabilities.subagents` 做"双边能力协商"把子代理 transcript 映射为嵌套会话；协议本身尚未稳定该字段。

## 权限与安全

- **权限请求**：`session/request_permission{sessionId, toolCall(ToolCallUpdate), options[{optionId, name, kind}]}`，`kind ∈ allow_once | allow_always | reject_once | reject_always`；响应 `outcome: {outcome:"selected", optionId} | {outcome:"cancelled"}`。粒度是**单次工具调用**，"always"语义（作用域=会话/项目/全局？）由 Agent 决定，协议未定义持久化，也没有"策略预授权"通道；网关若想做无人值守自动审批，只能在 Client 侧按 `toolCall.kind/locations/rawInput` 写规则自动回答。v2 计划"more flexible permission requests"（#1577）。
- **文件/终端沙箱**：Agent 若声明使用 Client 的 `fs`/`terminal` 能力，实际读写与命令执行发生在 Client 进程环境，Client 可以拒绝（返回 JSON-RPC 错误）或改写；但 Agent 也可以**绕过** Client 直接用自己的工具访问磁盘（协议不强制），因此权限限制必须叠加 OS 级沙箱（容器/cwd 限定）。`cwd`/`additionalDirectories` 表达工作区边界，但只是"建议"。
- **认证**：`authMethods[]` 在 initialize 中公告，`authenticate{methodId}`；`terminal` 类型让 Client 运行交互登录命令（`EnvVariable` 传凭证）；`logout`（05-21）。这是 Agent 与其 LLM 提供商之间的认证，**不是** Client↔Agent 的认证——stdio 子进程天然信任；远程传输 RFD 把鉴权放在 HTTP 头/子协议层，由部署方负责。
- **Elicitation**：`elicitation/create{message, mode: form(schema)|url}`，Agent 可向用户索要结构化输入或引导 OAuth URL 流程，`elicitation/complete` 通知 URL 流程结束。
- 安全缺口：无审计事件、无速率/配额、无每会话身份（谁在用），需网关补。

## 扩展机制与资产

- **`_meta`**：所有请求/响应/通知/嵌套类型（content block、tool call、plan entry、capability 对象）都有 `_meta: {[key]: unknown}`；根级 `traceparent/tracestate/baggage` 保留给 W3C Trace Context（与 MCP/OTel 互通）；厂商键建议用域名前缀如 `zed.dev/debugMode`。
- **自定义方法/通知**：`_` 前缀（`_zed.dev/workspace/buffers`），未识别方法返回 `-32601`，未识别通知 SHOULD 忽略——保证向前兼容。
- **自定义能力**：放在 `agentCapabilities._meta` / `clientCapabilities._meta`（如 `{"zed.dev": {"workspace": true}}`）。claude-agent-acp 实际用此机制暴露 goal/session-failure/permission/subagents 扩展——**这就是"公共能力 vs 引擎特有扩展"的协议级落点**。
- **资产表达**：ACP 不定义 skills/prompts/插件格式；可注入的资产只有 (a) `mcpServers`（工具），(b) prompt 中的 `resource`/`resource_link` 内容块（@-mention 文件/URL），(c) slash commands（由 Agent 公告、Client 调用），(d) modes/configOptions（Agent 公告、Client 设置）。系统提示、规则文件（CLAUDE.md/AGENTS.md）、skills 目录仍是各引擎私有资产，需由网关写到 `cwd` 或通过引擎私有 flag/env 下发。
- **Registry** 提供引擎的"安装/启动/认证方式"元数据，可作为网关"能力识别→适配→认证"流程的第一步数据源。

## 记忆

不适用（协议层）。ACP 只规定会话历史的回放（`session/load`）与列举（`session/list`），不定义长期记忆、向量存储或跨会话记忆 API；`usage_update` 报告上下文占用；压缩/摘要事件（compaction）仍是 1.7.0 的 unstable 特性（社区讨论 #871 提出 `context_compacted{compactedThroughMessageId, summary?}` 与 "Context ID" 引用方案，2026-03~05 未定论）。记忆需由网关在引擎之外（或经 MCP 注入记忆工具）实现。

## 多 Agent 与协作

协议本身是**单 Client ↔ 单 Agent、以 session 为单位**的模型，没有 agent team/room/handoff 原语。相关能力只能通过：(1) Client 并行开多个 session/进程（Obsidian Agent Console、Braide、CompozyOS "runs ACP agents as a team"、Jockey、RayClaw 等客户端在 Client 侧做编排）；(2) Agent 内部子代理通过 `agent_thought_chunk`/嵌套 tool_call 或 claude-agent-acp 的 `subagents` 草案能力暴露；(3) Agent 反过来做 Client（OpenClaw `/acp spawn`、pi-shell-acp）形成链式调用。**结论：多 agent 编排是网关层职责，ACP 只提供可被编排的原子会话。**

## 可观测性

- 协议内置：`session/update` 事件流本身就是最细粒度的执行轨迹（消息/思考/工具调用状态/计划/模式/配置/用量）；`_meta.traceparent/tracestate/baggage` 保留给 W3C Trace Context/OTel，网关可在每个请求注入 traceparent 让引擎（若支持）把 span 挂到同一 trace；`usage_update` 给出 token 与成本；`clientInfo/agentInfo` 提供实现名与版本。
- 缺失：无日志级别/结构化日志通道（stderr 是事实上的日志输出，各引擎格式不一）、无指标/健康检查方法、`rawInput/rawOutput` 是否填充由 Agent 决定、无 LLM 请求级遥测（模型名、延迟、prompt/completion tokens 分项）——只有 usage_update 的粗粒度 `used/size`。社区有 ACP Inspector（桌面调试器）可用于协议调试。
- 归一化建议：把 11 种 `sessionUpdate` + `request_permission` + fs/terminal 调用作为网关统一事件模型的**最小公共事件集**，各引擎私有事件通过 `_meta` 携带原始 payload。

## 对我们架构的启示

### 核心结论
**ACP 可以且应该作为"引擎适配层的基线协议"**：它是目前唯一被 ≈40 个 harness（含 Gemini CLI、Codex、Claude、Copilot、Goose、OpenCode、Kimi、Qwen Code、Hermes、OpenClaw、Pi 适配器）和数十个客户端共同实现、SDK 达 1.0、治理由 Zed+JetBrains 共同维护的 agent↔host 协议；协议已覆盖会话生命周期（new/load/resume/list/close/delete）、流式事件、工具调用、权限、模式/配置、用量、扩展协商。网关只需实现**一个 ACP Client**，即可零改动接入所有原生 ACP 引擎；对非 ACP 引擎（Claude Code 原生 SDK、pi RPC、dsh 等）写一个"引擎→ACP Agent"适配器（如 claude-agent-acp、codex-acp、pi-acp 的做法），把引擎差异封装在适配器内。这样上层网关只依赖 ACP v1 schema，引擎演进不破坏架构。

### 公共能力 vs 扩展能力映射表

| 能力 | ACP 归一化落点 | 公共/扩展 | 接入参数 |
|------|---------------|-----------|----------|
| 启动/安装/认证方式发现 | Registry `registry.json`（distribution/command/args/env）+ `initialize.authMethods` | 公共 | registry id、可执行路径、env |
| 版本/实现识别 | `initialize.agentInfo{name,version}`、`protocolVersion` | 公共 | — |
| 会话创建/隔离 | `session/new{cwd, additionalDirectories, mcpServers}` | 公共 | 每业务实体（群）一个 cwd + sessionId |
| 会话连续性 | `session/load`（需 `loadSession`）/`session/resume`（需 `sessionCapabilities.resume`） | 公共（能力位可选） | sessionId 持久化映射表 |
| 会话列举/删除/关闭 | `session/list|delete|close` | 公共（能力位可选） | cursor |
| 流式输出/思考/工具/计划 | 11 种 `sessionUpdate` | 公共 | — |
| 权限限制 | `session/request_permission` 的 Client 端策略自动应答 + OS 沙箱 | 公共 | 允许的 `kind`、路径白名单、命令白名单 |
| 文件/终端委托 | `clientCapabilities.fs/terminal` | 公共（Client 可选） | 是否把 fs/terminal 指向网关沙箱 |
| 模型/推理等级切换 | `configOptions`（category `model|model_config|thought_level`）+ `session/set_config_option` | 公共形态、值引擎特有 | configId/value |
| 模式（plan/act/ask） | `modes` + `session/set_mode` | 公共形态、值引擎特有 | modeId |
| slash commands | `available_commands_update` | 公共形态、内容引擎特有 | 命令名 |
| 工具资产注入 | `mcpServers`（stdio/http） | 公共 | MCP server 清单 |
| 用量/成本 | `usage_update` | 公共（可选） | — |
| 追踪 | `_meta.traceparent` | 公共（约定） | trace id |
| 子代理/agent team/room/dynamic workflow/自进化 | 仅 `_meta` 扩展或 `_vendor/...` 方法（claude-agent-acp 的 `subagents`/`goal` 是实例） | **扩展** | 每引擎单独声明在 `agentCapabilities._meta` |
| 规则文件/skills/系统提示 | 无协议表达 | **扩展** | 由适配器写入 cwd 或引擎私有 env/flag |
| 长期记忆 | 无协议表达 | **扩展** | 经 MCP 记忆服务器注入或网关外置 |
| 远程/多机部署 | stdio 稳定；HTTP/WS RFD Active | 公共（待稳定） | 先用 acp_rpc_bridge/ACP Remote/自建 |

### 网关需要补的部分（ACP 的缺口）
1. **业务→session 映射与持久化**：ACP 的 sessionId 由 Agent 生成、生命周期绑定进程（除非引擎持久化并支持 load）。网关必须维护 `业务键(群ID) → {engineId, sessionId, cwd, 进程句柄}`，并处理引擎不支持 `loadSession` 时的降级（自行保存转录并在新会话 prompt 中回灌）。
2. **多会话并发/进程池**：单 Agent 进程多 session 的支持度不一，网关应按引擎能力做"每会话一进程"或"进程池"策略，并处理 stdio 进程崩溃恢复。
3. **权限策略引擎**：把 `request_permission` 转成基于 `kind/locations/rawInput` 的策略判定；"allow_always"作用域由网关记账，不依赖引擎。
4. **认证与租户隔离**：Client↔Agent 无认证；每个业务租户的 API key/凭证通过 `env` 在 spawn 时注入，并用容器/用户级隔离。
5. **遥测归一化**：把 `session/update` 事件映射到统一事件模型（可直接用 ACP 的判别值作为公共事件名），补充 stderr 日志采集、时延/错误指标、LLM 级 token 分项（引擎私有埋点通过 `_meta` 附带）。
6. **能力协商登记表**：初始化时读取 `agentCapabilities`（含 `_meta`）与 `NewSessionResponse.modes/configOptions`，生成引擎"能力画像"供元编排层选择引擎与配置——ACP 的 config options 恰好是"每种能力的配置参数"的标准表达。
7. **历史导出**：只能通过 `session/load` 回放获得 UI 级历史；如需原始转录，走引擎私有存储（如 Claude Code 的 jsonl、opencode 的 SQLite）。
8. **远程传输**：跨机器要么等 HTTP/WS RFD 稳定，要么自行包一层（网关内部用 WebSocket 转发 JSON-RPC，参照 OpenClaw `openclaw acp` 做法）。

### 风险与坑
- v2 正在重构（auth/* 命名、load/resume 合并、fs/terminal 面变动、typed config、新 diff 格式）：适配层应以 v1 `protocolVersion: 1` 为基线并封装 schema 版本差异；SDK 1.x 仍在快速迭代（1.0→1.7 仅 2 个月）。
- 各引擎对可选能力（`loadSession`、`list`、`configOptions`、`terminal`）的实现参差；适配器（claude-agent-acp、codex-acp）与原生实现（Gemini CLI、Copilot）功能深度不同，Pi 讨论指出社区适配器常缺 fs/terminal 委托、权限路径、MCP 透传。
- `session/prompt` 是长阻塞请求，网关需要超时/取消（`session/cancel`）与心跳策略；stdio 无法多路复用到多机。
- `mcpServers` 的 SSE 已删除，只保留 stdio/http。
- Registry 只收录"支持用户认证"的 agent，且不含 Client 侧策略信息。

## 未解决问题
1. v2 中 fs/terminal 客户端方法的最终形态（meta.json 中已不见）——需跟踪 v2 稳定化。
2. compaction 事件（1.7.0 unstable）与 `messageId` 在各引擎中的实际支持率。
3. Streamable HTTP/WebSocket 传输何时进入 v1 稳定，Goose/SDK 参考实现进度。
4. 各原生实现（Gemini CLI、Copilot、OpenCode、Kimi、Qwen Code）分别实现了哪些可选能力位（需逐一用 `initialize` 探测，建议网关做自动化"能力探针"）。
5. 单进程多 session 的引擎支持矩阵。
6. Gemini `--experimental-acp`、Goose `goose acp` 等具体 CLI flag 未在本轮以一手来源核实。

## 来源列表
- https://agentclientprotocol.com/protocol/overview
- https://agentclientprotocol.com/protocol/schema
- https://agentclientprotocol.com/protocol/prompt-turn
- https://agentclientprotocol.com/protocol/session-setup
- https://agentclientprotocol.com/protocol/extensibility
- https://agentclientprotocol.com/updates
- https://agentclientprotocol.com/get-started/agents
- https://agentclientprotocol.com/get-started/clients
- https://agentclientprotocol.com/rfds/session-usage
- https://agentclientprotocol.com/rfds/streamable-http-websocket-transport
- https://github.com/agentclientprotocol/agent-client-protocol
- https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/CHANGELOG.md
- https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/schema.json
- https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v1/meta.json
- https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/schema/v2/meta.json
- https://github.com/agentclientprotocol/registry
- https://github.com/zed-industries/claude-agent-acp
- https://github.com/earendil-works/pi/discussions/4444
- https://github.com/orgs/agentclientprotocol/discussions/871
- https://docs.openclaw.ai/cli/acp
- https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/
- https://github.com/coder/acp-go-sdk
- https://github.com/formulahendry/vscode-acp
