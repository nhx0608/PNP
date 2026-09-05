# T02 pi-agent / Pi Agent Harness（earendil-works/pi，原 badlogic/pi-mono，pi.dev；也是 OpenClaw 的底层 agent SDK）

> 调研日期：2026-09-03。所有事实以当天可访问的一手资料为准（GitHub 仓库/raw 源码、npm registry、pi.dev 文档、CHANGELOG、官方博客）。文中标注 **[已确认]** 表示来自一手来源；**[推测]** 表示基于资料的推断。

## 摘要

pi 是由 Mario Zechner（badlogic，libGDX 作者）于 2025-08 创建的 TypeScript 单仓 "AI agent toolkit"，2026-05 转移至 Earendil Works（仓库 `earendil-works/pi`，npm 从 `@mariozechner/*` 更名为 `@earendil-works/*`，起始版本 0.74.0）。截至 2026-09-03，GitHub 101,300 stars / 12,584 forks，最新版 0.84.4（2026-08-28），MIT，Node ≥ 22.19。

它的核心哲学是"primitives, not features"：内置只有 read/write/edit/bash（+grep/find/ls）几个工具、极短的系统提示；**不内置** MCP、子代理、权限弹窗、plan mode、todo、后台 bash 和记忆——全部交给 TypeScript **extensions**（进程内钩子 + 工具注册 + UI）、**skills**（SKILL.md）、**prompt templates**、**themes** 与 **packages**（npm/git 分发）实现。

对网关接入最重要的三条接入面：(1) **SDK 嵌入**（`createAgentSession` / `AgentSession` / `SessionManager` / `ModelRuntime` / `DefaultResourceLoader`），OpenClaw 早期即以此方式嵌入；(2) **`--mode rpc`**：严格 LF 分隔的 JSONL 命令/事件协议（36 个 type，含 `extension_ui_request/response` 把扩展的 confirm/select 等交互桥接到宿主）；(3) **`--mode json` / `-p`** 单发流式事件。会话是 **JSONL 树**（`id/parentId`，`compaction`、`branch_summary`、`custom` 等条目类型，v3 格式），支持 `/tree` 原地分支、`/fork`、`/clone`。0.84.0 起 `pi-agent-core` 引入 v4 "lane-based" `Session/SessionStorage/SessionRepo` 与实验性 `pi-protocol`（CBOR）/`pi-client`/`pi-server` 远程会话栈，走向"一个服务、多会话、多客户端 attach"的形态。

一个必须注意的事实：OpenClaw 历史上确实嵌入了 `@mariozechner/pi-agent-core/pi-coding-agent/pi-ai/pi-tui`（曾 pin 0.49.3、0.57.1），但 **OpenClaw 2026.8.1 的 `package.json` 只剩 `@earendil-works/pi-tui 0.84.3` 一个依赖**，官方文档亦称 "no external agent framework packages remain"，运行时别名 `pi` 已归一为 `openclaw`。因此"OpenClaw = pi 引擎"的说法在今天需要修正为"OpenClaw 内化了 pi 的运行时设计"。

## 关键事实（每条带来源与置信度）

| # | 事实 | 来源 | 置信度 |
|---|------|------|--------|
| 1 | 仓库 `earendil-works/pi` 创建于 2025-08-09；2026-09-03 时 stars 101,300、forks 12,584、open issues 153、最近 push 2026-09-03；MIT；描述 "AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI" | GitHub API（search_repositories，2026-09-03） | high |
| 2 | 2026-05 项目转移到 Earendil Works，npm 命名空间自 0.74.0 起改为 `@earendil-works`；registry 记录 0.74.0 发布于 2026-05-07 | https://en.wikipedia.org/wiki/Pi_(AI_agent) ；npm registry `time` 字段 | high |
| 3 | `@earendil-works/pi-coding-agent` 最新 0.84.4，发布 2026-08-28；`engines.node >= 22.19.0`；依赖 pi-ai/pi-tui/pi-client/pi-protocol/pi-agent-core 同版本 + jiti 2.7.0 + typebox 1.3.7 + undici + proper-lockfile | https://registry.npmjs.org/@earendil-works/pi-coding-agent | high |
| 4 | 当前 `packages/` 目录：agent、ai、chord、client、coding-agent、evals、protocol、server、session-backends/sqlite-node、telemetry、tui（无 web-ui、无 mom） | https://github.com/earendil-works/pi/tree/main/packages | high |
| 5 | 运行模式四种：interactive、`-p/--print`、`--mode json`、`--mode rpc`，另有 SDK；RPC 协议为"strict LF-delimited JSONL"，客户端只能按 `\n` 切分 | packages/coding-agent/README.md、docs/rpc.md | high |
| 6 | RPC 命令类型（源码枚举）：abort, abort_bash, abort_retry, bash, clear_queue, clone, compact, cycle_model, cycle_thinking_level, export_html, extension_ui_request, extension_ui_response, follow_up, fork, get_available_models, get_available_thinking_levels, get_commands, get_entries, get_fork_messages, get_last_assistant_text, get_messages, get_session_stats, get_state, get_tree, new_session, prompt, response, set_auto_compaction, set_auto_retry, set_follow_up_mode, set_model, set_session_name, set_steering_mode, set_thinking_level, steer, switch_session | packages/coding-agent/src/modes/rpc/rpc-types.ts（grep） | high |
| 7 | 0.84.0（2026-08-06）破坏性变更：JSON/RPC `message_update` 只发 `assistantMessageEvent` 增量，移除累计 `message` 与 `partial` 字段 | https://pi.dev/news/releases/0.84.0 ；CHANGELOG | high |
| 8 | 会话文件：`~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`，首行 `{"type":"session","version":3,"id","timestamp","cwd"[,"parentSession"]}`；条目类型 message / model_change / thinking_level_change / compaction / branch_summary / label / custom / custom_message / session_info；每条含 `id`(8 hex)/`parentId`/`timestamp`，形成树 | docs/session-format.md | high |
| 9 | 自动 compaction 触发条件 `contextTokens > contextWindow - reserveTokens`；默认 `compaction.reserveTokens=16384`、`keepRecentTokens=20000`；扩展可通过 `session_before_compact` 返回自定义摘要（`fromHook`） | docs/compaction.md、docs/settings.md | high |
| 10 | pi 无内置权限系统："It runs with the permissions of the user account that starts it"；推荐容器/微 VM/OpenShell；提示注入"cannot be reliably prevented by pi" | docs/security.md、docs/containerization.md | high |
| 11 | 扩展 `tool_call` 钩子可返回 `{ block: true, reason, terminate? }` 阻断工具调用，也可直接改写 `event.input`；示例 `permission-gate.ts`、`protected-paths.ts`、`sandbox/`、`gondolin/` | docs/extensions.md、examples/extensions/README.md | high |
| 12 | 非交互模式（-p/json/rpc）不弹信任提示，按全局 `defaultProjectTrust`（ask/always/never，默认 ask→忽略项目资源）；`--approve/-a`、`--no-approve/-na` 单次覆盖；决定持久化在 `~/.pi/agent/trust.json` | README "Project Trust" | high |
| 13 | 官方 subagent 示例以子进程方式运行：`pi --mode json -p --no-session [--model] [--thinking] [--tools a,b] --append-system-prompt <tmpfile>`；`MAX_PARALLEL_TASKS=8`、`MAX_CONCURRENCY=4`、`PER_TASK_OUTPUT_CAP=50KB`；agent 定义为 `~/.pi/agent/agents/*.md` 或 `.pi/agents/*.md`（frontmatter：name/description/tools/model） | examples/extensions/subagent/index.ts 与 README.md | high |
| 14 | `pi-telemetry` 为"vendor-neutral"、不依赖 OpenTelemetry，无内置 exporter；提供 `NOOP_TELEMETRY_CONTEXT`、`InMemoryTelemetryContext`、`defineTelemetrySchema`、`createTypedSpanStarter`，显式传递 `telemetryContext` | packages/telemetry/README.md、packages/agent/src/index.ts | high |
| 15 | pi-ai：`createModels()` + provider 工厂，40+ provider；`stream/complete/streamSimple/completeSimple`；`cacheRetention: 'short'|'long'|'none'`（Anthropic 用 `cache_control`，OpenAI 依赖 `sessionId` 会话亲和）；跨 provider 切换时 thinking 块自动转成 `<thinking>` 文本 | packages/ai/README.md | high |
| 16 | 0.84.0：`pi-agent-core` 用 v4 lane-based `Session`/`SessionStorage`/`SessionRepo`（durable operation records、global facts、shared sequence numbers、tree-scoped lane views）替换旧 harness 会话模型；`JsonlSessionRepo`/`InMemorySessionRepo`/`SqliteSessionRepo` 实现同一契约；index.ts 导出 `AgentHarness`（`AgentLane`、`HookMap`、`LaneSnapshot`） | pi.dev 0.84.0 release notes；packages/agent/src/index.ts、harness/agent-harness.ts | high |
| 17 | 实验性远程栈：`pi-protocol` = 4 字节大端长度前缀 + CBOR，单帧 16 MiB；路由目标 `{serverId, sessionId, attachmentId}`；`pi-server` 支持一个 Session 多个 presentation attach；Unix socket 传输；**未实现 peer 认证**；`PiClient` 断线不自动重连/重放 | packages/protocol、server、client README | high |
| 18 | OpenClaw `package.json`（version 2026.8.1）中与 pi 相关的依赖只有 `@earendil-works/pi-tui 0.84.3`；docs.openclaw.ai/pi 称 "no external agent framework packages remain"，runtime 选项 `openclaw`(legacy alias `pi`)/`codex`/`auto` | https://raw.githubusercontent.com/openclaw/openclaw/main/package.json ；https://docs.openclaw.ai/pi | high |
| 19 | OpenClaw 早期嵌入方式：直接 `createAgentSession()`，入口 `runEmbeddedPiAgent({sessionId, sessionKey, sessionFile, workspaceDir, provider, model, timeoutMs, onBlockReply, onToolResult, onAgentEvent})`，7 层工具管道，会话存于 `~/.openclaw/agents/<agentId>/sessions/`（JSONL），曾 pin `@mariozechner/*` 0.49.3 / 0.57.1 | 腾讯云文章 2649100；openclawlab.com/en/docs/pi | medium（第三方转述，且已过时） |
| 20 | 旧 pi-mono 的 Slack 机器人包 `mom`（`@mariozechner/pi-mom`）已不在当前仓库；官方指向独立仓库 `earendil-works/pi-chat`（Discord/Telegram 桥，每个 channel 一个 Gondolin 微 VM 工作区，390 stars） | GitHub README、pi-chat 仓库 | high |
| 21 | 社区记忆扩展：`pi-memory`（jayzeng，pi.dev/packages 收录，全局 `~/.pi/agent/memory/` + 项目 `.pi/memory/`，可选 qmd 语义检索）、Mem0 插件、Honcho 集成；pi 自身无内置长期记忆 | github.com/jayzeng/pi-memory、pi.dev/packages/pi-memory、mem0.ai 博客 | high |
| 22 | 安全评估（2026-02-12）：默认不沙箱；`~/.pi/agent/auth.json` 明文存 API key/OAuth token（0600 + proper-lockfile）；扩展经 jiti 加载、无隔离 | https://agent-safehouse.dev/docs/agent-investigations/pi | medium |

## 架构与工作原理

### 包分层（2026-09，v0.84.4）

依赖 DAG 自下而上：`telemetry` / `tui` / `protocol`（无内部依赖）→ `ai`（依赖 telemetry）→ `agent`（pi-agent-core，依赖 ai、telemetry、chord）→ `session-backends/sqlite-node` → `client`（依赖 protocol）→ `server` → `coding-agent`（依赖 ai、tui、client、protocol、agent-core）。[已确认：各包 package.json + iceyao 源码解析]

| 包 | npm | 职责 |
|---|---|---|
| ai | `@earendil-works/pi-ai` | 统一多 provider LLM API、流式事件、partial-json 工具参数增量解析、prompt cache、OAuth |
| agent | `@earendil-works/pi-agent-core` | `Agent` 类 + `agentLoop()` 双层循环（工具循环 + follow-up 队列）、`beforeToolCall/afterToolCall`、`transformContext/convertToLlm`、v4 harness（`AgentHarness`、Session/Lane、compaction、skills、prompt-templates、system-prompt、tools） |
| coding-agent | `@earendil-works/pi-coding-agent` | CLI/TUI、内置工具、`createAgentSession`、`SessionManager`、扩展/技能/模板/主题/包加载器、RPC/JSON/print 模式；exports：`.`、`./rpc-entry`、`./client`、`./experimental/plugin` |
| tui | `@earendil-works/pi-tui` | 差分渲染终端 UI（OpenClaw 仍依赖此包） |
| telemetry | `@earendil-works/pi-telemetry` | 厂商中立 span/attribute/event 契约与 TypeBox schema |
| protocol / client / server | `pi-protocol` / `pi-client` / `pi-server` | 实验性远程会话：CBOR 帧、路由信封、传输中立客户端、Unix socket 服务端 |
| chord | `@earendil-works/chord` | "application-composition runtime for services and RPC"（facet-service 原语） |
| session-backends/sqlite-node | `pi-session-backend-sqlite-node` | `SqliteSessionRepo`（node:sqlite），一 Session 一文件 |
| evals | — | 评测基建（未深入） |

### 运行循环

`pi-agent-core` 的 `runLoop()`：内层「注入 pending steering 消息 → 调 LLM → 解析工具调用 → 截断防御（`stopReason=="length"` 时对不完整工具回灌错误）→ 执行工具（默认 `Promise.all` 并行，结果按序回灌；工具可声明 `executionMode:"sequential"`；返回 `terminate:true` 可提前结束）→ 回灌」，外层处理 follow-up 队列。事件流 `agent_start → turn_start → message_start → message_update×N → message_end → tool_execution_start/update/end → turn_end → agent_end`，TUI、RPC、JSON 模式、遥测订阅同一事件流。`Agent.subscribe` 具有 barrier 语义（`message_end` 处理完再做工具 preflight）。[已确认：packages/agent/README.md]

消息管线：`AgentMessage[] → transformContext → convertToLlm → Message[] → LLM`。`AgentMessage` 通过 declaration merging 允许应用自定义 role（如 `notification`），这是 OpenClaw/网关注入非 LLM 消息（渠道事件、系统通知）的正统方式。[已确认]

### 资源与配置

- 配置目录 `~/.pi/agent/`（`PI_CODING_AGENT_DIR` 覆盖）：`settings.json`、`auth.json`、`models.json`、`trust.json`、`keybindings.json`、`sessions/`、`extensions/`、`skills/`、`prompts/`、`themes/`、`agents/`、`npm/`、`git/`。项目级 `.pi/` 同构（需信任）。
- 上下文文件：`AGENTS.md`/`CLAUDE.md`（全局 + 逐级父目录 + cwd 合并），`AGENTS.override.md` 替换本目录；`SYSTEM.md` 替换系统提示，`APPEND_SYSTEM.md` 追加；`--no-context-files/-nc` 关闭。
- shell 工具环境变量：`PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`。
- `PI_OFFLINE=1`/`--offline` 关闭所有启动网络操作；`PI_TELEMETRY=0` 或 `enableInstallTelemetry:false` 关闭安装遥测；`PI_CACHE_RETENTION=long` 延长缓存（Anthropic 1h、OpenAI 24h）。[已确认：README]

## 可编程接入面

### 1. SDK（Node/TS 进程内嵌入）

```ts
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager,
         DefaultResourceLoader, defineTool } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: true });
await modelRuntime.setRuntimeApiKey("anthropic", key);          // 运行时覆盖 > auth.json > env
const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [(pi) => {...}],
         additionalExtensionPaths: [...], systemPromptOverride: () => "...", skillsOverride, promptsOverride });
await loader.reload();
const { session } = await createAgentSession({
  cwd, agentDir, modelRuntime, model: modelRuntime.getModel("anthropic","claude-opus-4-5"),
  thinkingLevel: "medium", tools: ["read","bash","edit"], customTools: [myTool],
  sessionManager: SessionManager.open("/path/x.jsonl"),   // 或 create(cwd) / continueRecent(cwd) / inMemory(cwd,{id},entries)
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
  resourceLoader: loader,
});
const unsub = session.subscribe(ev => { /* message_update / tool_execution_* / agent_end / turn_end ... */ });
await session.prompt("...", { images, streamingBehavior: "steer" | "followUp" });
await session.steer("..."); await session.followUp("..."); await session.abort();
await session.compact(customInstructions); session.setModel(m); session.setThinkingLevel("high");
session.dispose();
```

`AgentSession` 公开 `agent`、`messages`、`isStreaming`、`sessionId`。`createAgentSessionRuntime(factory, opts)` 提供 `newSession/switchSession/fork/importFromJsonl`，**替换后 `runtime.session` 会变，事件订阅必须重挂**。`ExtensionContext.mode` 取值 `"tui"|"rpc"|"json"|"print"`，扩展可据此决定是否弹 UI。[已确认：docs/sdk.md、docs/extensions.md]

### 2. `--mode rpc`（子进程 JSONL）

启动：`pi --mode rpc [--provider p] [--model m] [--session <path|id>] [--session-dir d] [--no-session] [--name n] [-e ext.ts] [--tools ...] [--append-system-prompt ...] [--approve]`。stdin 一行一个命令，stdout 一行一个响应/事件；可选 `id` 用于关联：

```json
{"id":"req-1","type":"prompt","message":"Hello","images":[{"type":"image","data":"<base64>","mimeType":"image/png"}],"streamingBehavior":"steer"}
{"id":"req-1","type":"response","command":"prompt","success":true,"data":{}}
{"type":"message_update","usage":{"input":100,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":101,"cost":{}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hi"}}
{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls"}}
{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{},"isError":false}
{"type":"agent_end","messages":[...],"willRetry":false}
{"type":"agent_settled"}
```

事件族：`agent_start/agent_end/agent_settled`、`turn_start/turn_end`、`message_start/update/end`、`tool_execution_start/update/end`、`queue_update{steering,followUp}`、`compaction_start{reason:"manual"|"threshold"|"overflow"}/compaction_end{result:{summary,firstKeptEntryId,tokensBefore,estimatedTokensAfter,usage}}`、`auto_retry_start/end`、`summarization_retry_*`、`session_compact_failed`、`extension_error{extensionPath,event,error}`、`bash_execution_update{id,delta}`、`extension_ui_request`。

**扩展 UI 桥接协议**（网关实现审批的关键）：扩展在 RPC 模式调用 `ctx.ui.confirm/select/input/editor` 时，stdout 发出 `{"type":"extension_ui_request","id":"uuid","method":"confirm","title":"Proceed?","message":"...","timeout":5000}` 并阻塞，宿主回 `{"type":"extension_ui_response","id":"uuid","confirmed":true}`（select/input/editor 回 `value`，或 `{"cancelled":true}`）；`notify/setStatus/setWidget/setTitle/set_editor_text` 为 fire-and-forget。[已确认：docs/rpc.md]

会话类命令：`new_session{parentSession?}`、`switch_session{path}`、`fork{entryId}`、`clone`、`get_fork_messages`、`get_entries{since}`（返回 `entries` + `leafId`）、`get_tree`、`set_session_name`、`export_html`、`get_session_stats`（token/cost）、`get_commands`（列出扩展/prompt/skill 注册的命令及 `source`/`location`/`path`）。此外 `bash{command}`/`abort_bash` 允许宿主直接在 agent 的 cwd 跑命令并以 `bashExecution` 角色记入会话。

内置 TS 客户端 `src/modes/rpc/rpc-client.ts` 的 `RpcClient({cliPath,cwd,env,provider,model,args})` 用 `spawn("node",[cliPath,"--mode","rpc",...])` 启动、按 id 匹配 pending 请求、stderr 收集——可直接参考实现网关侧的 pi 适配器。[已确认：源码]

### 3. `--mode json` 与 `-p`

`pi --mode json "prompt"`：stdout 先输出会话头 `{"type":"session","version":3,...}`，随后是与 RPC 相同的事件流（同样只发增量）；`-p` 输出最终文本并支持管道 stdin 合并（`cat README.md | pi -p "Summarize"`）。适合无状态单发任务与子代理。[已确认：docs/json.md、README]

### 4. 实验性远程会话（pi-protocol/pi-client/pi-server，0.84.0+）

传输中立 `PiClient`（`Client.connect({serverId, transportFactory})`），Unix socket 传输 `@earendil-works/pi-client/unix`（目录扫描、最多并发探测 16 个 socket）；`@earendil-works/pi-coding-agent/client` 的 `RemoteSession` 控制器带 transcript reducer。服务端由应用提供 `resolveSession()/openSession()`，一个 Session 可被多个 presentation attach（attach 幂等、返回 `attachmentId`）。**认证是应用策略，未实现**；断线后 pending 请求本地拒绝但远端可能仍执行；**无兼容性保证**。[已确认：三个 README]

## 会话模型

- **标识与定位**：会话 = 单个 JSONL 文件，路径按 cwd 编码（`--<path>--/<ts>_<uuid>.jsonl`），`--session` 接受路径或（部分）UUID；`--session-dir`/`sessionDir` 设置、`PI_CODING_AGENT_SESSION_DIR` 可重定向。`SessionManager.inMemory(cwd, {id}, entries)` 支持从外部存储恢复而不落盘。
- **树状结构**：每条 entry `id/parentId`，`leafId` 指向当前分支末端；`/tree` 原地切换分支（可自动生成 `branch_summary{fromId,summary}` 摘要被放弃的分支）；`/fork` 复制到分叉点生成新文件（头部 `parentSession`）；`/clone` 复制当前活动分支。RPC 对应 `fork/clone/get_tree/get_entries`。`label` 条目用于书签。
- **compaction**：`compaction{summary, tokensBefore, firstKeptEntryId | retainedTail, usage?, details?, fromHook?}`，触发 `contextTokens > contextWindow - reserveTokens`，保留最近 `keepRecentTokens`；摘要为结构化 markdown（Goal/Progress/Decisions/Next steps + `<read-files>`/`<modified-files>`）；溢出恢复时先 compact 再重试；0.84.x 起 compaction/branch summary 的用量计入会话总量、失败重试遵循 provider retry 策略、JSONL 原子发布（`FileSystem.renameFile()`）。
- **扩展状态**：`custom{customType,data}`（不进 LLM 上下文）与 `custom_message{customType,content,display,details}`（进上下文）；`session_start` 时扩展可遍历 `ctx.sessionManager.getEntries()/getBranch()` 重建状态，这是分支安全的持久化方式。
- **版本**：v1 线性 → v2 树 → v3（`hookMessage`→`custom`），加载时自动迁移。
- **v4（pi-agent-core harness）**：`Session/SessionStorage/SessionRepo` + lanes，`JsonlSessionRepo`、`InMemorySessionRepo`、`SqliteSessionRepo` 实现同一契约并附 conformance 测试（`./harness/session/testing`）；`AgentHarness.create()` 提供 `AgentLane`（acquire、drive、queue、abort、navigate、watch）与 `HookMap`；sqlite 后端明确 **不做跨进程锁**，"host lifecycle guarantees one writable owner per Session"。[已确认：release notes、index.ts、sqlite README] 这层 API 面向"网关持有多个会话"的形态，但仍标注实验/演进中。

## 权限与安全

- **默认模型**：无审批、无沙箱，以启动用户权限运行；bash 直接在宿主执行；`auth.json` 明文（0600）；扩展/包"run with full system access"。[已确认]
- **项目信任**：进入含 `.pi/settings.json`、`.pi/extensions|skills|prompts|themes`、`SYSTEM.md` 的目录需信任；决定按目录缓存于 `~/.pi/agent/trust.json`；信任前只加载上下文文件、用户/全局扩展、`-e` 扩展（它们可处理 `project_trust` 事件返回 `{trusted:"yes"|"no"|"undecided", remember?}`）。非交互模式用 `defaultProjectTrust`（默认 ask 等价于忽略），`--approve/--no-approve` 覆盖。
- **扩展内审批**（网关可复用的模式）：

```ts
pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event) && /rm -rf/.test(event.input.command)) {
    const ok = ctx.hasUI ? await ctx.ui.confirm("Dangerous!", "Allow rm -rf?") : false; // RPC 模式会变成 extension_ui_request
    if (!ok) return { block: true, reason: "Blocked by policy", terminate: true };
  }
  event.input.command = `source ~/.profile\n${event.input.command}`; // 也可改写参数
});
```
  配套：`protected-paths.ts`（禁写 .env/.git/node_modules）、`tool-override.ts`（替换内置工具加审计）、`setActiveTools(names)` 动态收窄工具、`--tools/--exclude-tools/--no-builtin-tools`、`tool_result` 钩子改写输出（output guard）。
- **沙箱三模式**（官方文档）：Gondolin 扩展（宿主保留 pi 与凭据，工具进 Linux 微 VM，挂载 `/workspace`，需 Node 23.6+ 与 QEMU）、整进程 Docker、NVIDIA OpenShell（策略沙箱，凭据可留在网关，沙箱内经 `https://inference.local` 推理）。注意"extensions run wherever the pi process runs"——工具入沙箱不等于扩展入沙箱。
- **提示注入**：官方明确不承诺可防，建议不受信代码一律容器化。

## 扩展机制与资产

- **Extensions**：`~/.pi/agent/extensions/*.ts|*/index.ts`、`.pi/extensions/`、settings `extensions[]`、`-e <path|npm:|git:>`、包。jiti 原生加载 TS，支持异步工厂与 `/reload` 热重载。`ExtensionAPI`：`on`、`registerTool`（TypeBox 参数、`execute(toolCallId, params, signal, onUpdate, ctx)`、`promptSnippet/promptGuidelines`、`renderCall/renderResult`、`prepareArguments`）、`registerCommand`、`registerShortcut`、`registerFlag`（自定义 CLI flag）、`registerProvider/unregisterProvider`（含 OAuth）、`registerMessageRenderer/EntryRenderer/MarkdownTransformer`、`sendMessage({customType,content,display,details},{deliverAs:"steer"|"followUp"|"nextTurn",triggerTurn})`、`sendUserMessage`、`appendEntry`、`setSessionName`、`setLabel`、`exec`、`getActiveTools/setActiveTools`、`setModel`、`events`（扩展间总线）。
- **事件全表**：启动 `project_trust`、`session_start{reason:startup|reload|new|resume|fork}`、`resources_discover`；会话 `session_info_changed`、`session_before_switch`、`session_before_fork`、`session_before_compact`、`session_compact_failed`、`session_tree`、`session_shutdown`；agent `before_agent_start`（改 systemPrompt/注入消息）、`agent_start/end/settled`、`turn_start/end`、`message_start/update/end`、`context`（非破坏性改写发给 LLM 的消息）；工具 `tool_call`（可阻断）、`tool_result`（可改写）、`tool_execution_*`；输入 `input{text,images,source:"interactive"|"rpc"|"extension"}`→`handled|transform|continue`、`user_bash`；模型 `model_select`、`thinking_level_select`；provider `before_provider_headers`、`before_provider_request`、`after_provider_response`；UI `ui_prompt_start/end`。命令上下文另有 `waitForIdle/newSession/fork/switchSession/compact/abort/shutdown/getContextUsage/getSystemPrompt`。
- **Skills**：agentskills.io 标准 `SKILL.md`（frontmatter `name`≤64、`description`≤1024、可选 `license/compatibility/metadata/allowed-tools/disable-model-invocation`），位置 `~/.pi/agent/skills/`、`~/.agents/skills/`、`.pi/skills/`、`.agents/skills/`、包 `skills/`、`--skill`；系统提示只注入名称+描述（渐进披露），模型按需 `read`；`/skill:name args` 显式触发，`enableSkillCommands` 控制。
- **Prompt templates**：`~/.pi/agent/prompts/*.md`、`.pi/prompts/`、包、`--prompt-template`；frontmatter `description`、`argument-hint`；`$1 $2 $@ $ARGUMENTS ${1:-default} ${@:N:L}`。
- **Themes**：JSON，`~/.pi/agent/themes/`，热重载。
- **Packages**：`pi install npm:@scope/pkg@1.2.3 | git:github.com/u/r@v1 | https://... | ssh://... | ./local`，`-l` 项目级（`.pi/npm/`、`.pi/git/`）；`package.json` 加 `keywords:["pi-package"]` 与 `pi:{extensions,skills,prompts,themes}`（glob、`!` 排除、`+`/`-` 强制），无 manifest 时按目录约定发现；settings `packages[]` 支持对象过滤；`pi update --all|--extensions|--models`、`pi list`、`pi config`；pi.dev/packages 为公共目录。
- **模型/provider 资产**：`~/.pi/agent/models.json` 定义自定义 provider（openai-completions/anthropic-messages/google 语法、`samplingParams`、vLLM `thinking_token_budget`、分层定价）；`enabledModels`、`modelThinkingLevels`；`pi auth print-api-key|print-bearer-token|check`。

## 记忆

pi **无内置长期记忆**（官方 "What's intentionally absent" 列表未列 memory，但内核只有 AGENTS.md 上下文 + 会话内 compaction 摘要 + 扩展 `appendEntry` 状态）。可用替代：
1. `AGENTS.md`/`.pi/SYSTEM.md`/`APPEND_SYSTEM.md`：静态项目记忆。
2. 会话树 + compaction 摘要 + branch summary：会话内记忆。
3. 扩展 `appendEntry("my-state", data)` + `session_start` 回放：扩展私有状态（不进上下文）。
4. 社区包：`pi-memory`（jayzeng；`~/.pi/agent/memory/` 全局 + `<repo>/.pi/memory/` 项目级 markdown，daily log/scratchpad，qmd 混合检索，工具 `memory_status` 等）、Mem0 官方插件、Honcho、db0.ai。[已确认来源见事实 21]
对网关而言，记忆应放在网关层（统一记忆服务），通过 `before_agent_start`/`context` 钩子或 `customTools` 注入，避免绑定某个社区包。

## 多 Agent 与协作

- **内核立场**：无子代理、无 agent team、无 room；官方建议 tmux 或扩展。
- **官方 subagent 示例**（examples/extensions/subagent）：工具 `subagent` 三模式 `{agent,task}` / `{tasks:[...]}`（≤8 任务、并发 4）/ `{chain:[...]}`（`{previous}` 占位）；子进程命令 `pi --mode json -p --no-session --model X --thinking Y --tools a,b --append-system-prompt <tmp>`（未指定 model 时继承父会话模型与 thinking）；agent 定义 `~/.pi/agent/agents/*.md`（`agentScope: "user"|"project"|"both"`，`confirmProjectAgents`）；每任务输出上限 50KB 回填父模型；预置 `/implement`（scout→planner→worker）、`/scout-and-plan`、`/implement-and-review`。
- **RPC worker 模式**（社区 Kimball）：主会话用 `pi --mode rpc` + 隔离 session dir 起持久 worker，`task_start/status/send/wait/close/reply`，3 槽并发；子进程的 `extension_ui_request` 作为 checkpoint 冒泡到主会话由 `task_reply` 回答；坑：忘 close 即泄漏进程、steer 不打断推理中、失败回退只在"未产生副作用"时重放。
- **生态**：`pi-agent-harness`（团队工厂）、`pi-agents-team`、`pi-agent-extensions`（17 扩展）、`pi-cc-plugins`（运行 Claude Code 插件）、`oh-my-pi` fork（内置 subagents/LSP/DAP/浏览器工具）；Armin Ronacher 的 `/control` 扩展做 agent 间通信。
- **进程内多实例**：`pi-chat` 为每个 channel 建独立 pi agent 实例；OpenClaw 历史实现亦在一个 Node 进程内以 `createAgentSession` 管理多会话。[推测：SDK 未明文保证多 AgentSession 同进程并发，但 OpenClaw/pi-chat 实践表明可行，需自行隔离 cwd/agentDir/settings]

## 可观测性

- **无 OpenTelemetry 直连**。`pi-telemetry` 定义 span/attribute/event/status 契约与 schema（`defineTelemetrySchema`、`createTypedSpanStarter`、`startAttributes/endAttributes`、敏感度/基数元数据），无 exporter、无全局 current-span；`pi-agent-core` 重导出 `NOOP_TELEMETRY_CONTEXT`、`InMemoryTelemetryContext`、`TelemetryContext`，0.84.0 加入 "agent-owned typed AI-request and harness schemas"。接 OTel 需自写 adapter 实现 `TelemetryContext`。
- **事件流即埋点**：`session.subscribe`/RPC/JSON 事件含 `usage{input,output,cacheRead,cacheWrite,totalTokens,cost}`、`toolCallId`、`stopReason`；`get_session_stats` 返回 token/cost/上下文占用；`showCacheMissNotices` 提示缓存未命中；`session_compact_failed`、`extension_error`、`auto_retry_*` 提供故障信号。
- **provider 层钩子**：`before_provider_headers`（可注入 `x-session-id` 等追踪头）、`before_provider_request`（查看/替换 payload）、`after_provider_response{status,headers}`。
- **日志**：`~/.pi/agent/` 下 debug 日志（agent-safehouse 报告提及）；stderr 用于诊断（RpcClient 收集）。
- **产品遥测**：仅安装/更新 ping 至 `pi.dev/api/report-install` 与版本检查 `pi.dev/api/latest-version`，`PI_TELEMETRY=0`/`PI_OFFLINE=1` 关闭。`enableAnalytics` 默认 false。

## 对我们架构的启示（公共能力 vs 扩展能力映射表、接入参数、风险与坑）

### 接入方式选择

| 方式 | 适用 | 优点 | 代价 |
|---|---|---|---|
| A. RPC 子进程（`pi --mode rpc`），每业务会话一进程 | 首选，语言无关 | 隔离强、协议稳定文档化、`RpcClient` 可参考、扩展 UI 可桥接 | 进程开销、需进程池/空闲回收、`switch_session` 需 cwd 一致 |
| B. SDK 进程内嵌（Node 网关） | 需要深度定制/多会话一进程 | 直接注入 customTools、自定义 AgentMessage role、`SettingsManager.inMemory` 免磁盘 | 与 pi 版本强耦合（0.80→0.84 多次破坏性变更）、扩展与网关同进程同权限 |
| C. pi-server/pi-client | 观察 | 原生多 attach、durable Session | 实验性、无认证、无兼容承诺 |
| D. `--mode json -p` | 无状态单发/子代理 | 最简单 | 无会话连续性（可配 `--session` 续写但需自管） |

### 业务→session 映射（群助手示例）

`sessionKey = tenant/group` → 文件 `<sessionDir>/<tenant>/<group>.jsonl`；启动 `pi --mode rpc --session <file> --session-dir <dir> --name <group> --tools read,grep,find,ls[,bash] -e gateway-policy.ts --no-approve`，并用 `PI_CODING_AGENT_DIR=<tenant-dir>` 隔离 settings/auth/trust/extensions；上下文隔离靠不同 cwd + 不同 session 文件；连续性靠 `--session`/`switch_session`；权限靠 `--tools` 白名单 + `tool_call` 阻断扩展 + 容器。冷启动可用 `SessionManager.inMemory(cwd,{id},entries)`（SDK）或 `/import`（JSONL）从网关存储恢复。

### 公共能力 vs pi 扩展能力

| 能力 | 归类 | pi 中的对应 | 接入参数 |
|---|---|---|---|
| 发送消息/流式增量 | 公共 | `prompt` + `message_update.assistantMessageEvent.text_delta` | `message, images[], streamingBehavior` |
| 中断/排队/追加 | 公共 | `abort`、`steer`、`follow_up`、`clear_queue`、`set_steering_mode` | `steeringMode: all|one-at-a-time` |
| 会话创建/恢复/列出 | 公共 | `--session/--continue`、`new_session/switch_session`、`SessionManager.list` | `sessionDir, sessionFile, name` |
| 会话分支/fork | **pi 扩展能力** | `fork/clone/get_tree/get_entries`、`branch_summary` | `entryId` |
| 上下文压缩 | 公共（参数化） | `compact`、`set_auto_compaction`、`compaction.{reserveTokens,keepRecentTokens}` | 三键 + `customInstructions` |
| 模型/思考等级切换 | 公共 | `set_model`、`set_thinking_level`、`--models` | `provider, modelId, thinkingLevel(off…max)` |
| 工具白名单 | 公共 | `--tools/--exclude-tools/--no-builtin-tools`、`setActiveTools` | 工具名列表 |
| 审批/拦截 | 公共（实现方式引擎特有） | 扩展 `tool_call` 返回 `block` + RPC `extension_ui_request/response` | 策略脚本路径、`timeout` |
| 自定义工具注入 | 公共 | `customTools`(SDK)/`registerTool`(ext) | TypeBox schema |
| 上下文/记忆注入 | 公共 | `before_agent_start`、`context`、`AGENTS.md`、`--append-system-prompt` | 文本/消息 |
| 技能/提示模板/包 | 公共资产（格式：agentskills.io SKILL.md；模板 `$1/$@`） | `--skill`、`--prompt-template`、`pi install` | 路径/`npm:`/`git:` |
| 用量/成本统计 | 公共 | `usage.cost`、`get_session_stats` | — |
| 遥测适配 | 公共（需 adapter） | `TelemetryContext` | 自定义 adapter |
| 子代理/agent team | **pi 扩展能力**（社区/示例） | subagent 扩展、agents/*.md | `agentScope, MAX_CONCURRENCY` |
| 沙箱 | **引擎外** | Gondolin/Docker/OpenShell | 容器参数 |
| 项目信任 | pi 特有 | `defaultProjectTrust`、`--approve` | ask/always/never |
| provider 自定义/OAuth | pi 特有强项 | `models.json`、`registerProvider`、`ModelRuntime.setRuntimeApiKey` | baseUrl/api/apiKey |
| TUI/主题/快捷键 | 不适用（网关无终端） | — | — |

### 能力识别→适配→认证流程（针对 pi）

1. 识别：`pi --version`（≥0.84 则 `message_update` 为增量）；`get_state`、`get_available_models`、`get_commands`（探测扩展/skill 注册命令）、`get_available_thinking_levels`。
2. 适配：注入网关策略扩展（`-e`）实现 tool_call 门禁、`before_provider_headers` 打 trace 头、`appendEntry` 记录网关元数据；把 `extension_ui_request` 映射到网关审批流。
3. 认证：`pi auth check`；多租户凭据用独立 `PI_CODING_AGENT_DIR`/`ModelRuntime.create({authPath})`，避免共享 `auth.json`。

### 风险与坑

1. **协议细节**：仅 `\n` 分隔；`message_update` 只含 delta（客户端自行累计）；`bash_execution_update` 是唯一带 `id` 的事件；事件无 `id`，需用状态机关联 `agent_settled`。
2. **无内建权限**：任何"审批"都是扩展 + 宿主 UI 桥接；RPC 里 `ctx.ui.confirm` 若宿主不回复会一直阻塞（应设 `timeout`）；`-p/json` 模式 `hasUI=false`，扩展需降级为直接 block。
3. **信任模型**：非交互模式默认忽略项目 `.pi/` 资源，若依赖项目级扩展必须 `--approve` 或 `defaultProjectTrust:"always"`（安全权衡）。
4. **一进程一会话**：RPC 天然单会话；`switch_session` 到不同 cwd 的会话会触发信任解析；sqlite/JSONL 均要求单写者，网关必须保证同一 session 不被两个进程同时打开。
5. **版本漂移**：0.80.8 `ModelRegistry.refresh()` 变异步、0.83 TypeBox 1.3.7、0.84 RPC delta/`ModelsRequestTransforms`/`context.stored`；建议锁定精确版本（pi 自身发布带 `npm-shrinkwrap.json`）。
6. **启动成本与网络**：启动会做版本检查/包更新/模型目录刷新，服务端务必 `PI_OFFLINE=1` 或 `--offline`；jiti 编译扩展有首启延迟。
7. **凭据**：`auth.json` 明文；容器化时优先 OpenShell 式"凭据留网关"或 `ANTHROPIC_AUTH_TOKEN` 网关 bearer。
8. **compaction 是 LLM 调用**：会产生费用、可能失败（`session_compact_failed`），对长期群会话需在网关侧设定预算与失败兜底。
9. **OpenClaw 路线已分叉**：若比赛选择"基于 OpenClaw 再接一个引擎"，OpenClaw 现在并不通过 pi 包运行，其 `runtime: pi` 只是历史别名；把 pi 当作独立引擎接入更清晰。

## 未解决问题

1. SDK 是否官方支持同一 Node 进程内并发运行多个 `AgentSession`（共享 `ModelRuntime`/`SettingsManager` 的线程安全边界）——OpenClaw/pi-chat 实践可行，但文档未承诺。
2. v4 `AgentHarness`/lane API 与 `pi-server` 的稳定时间表；何时提供认证与重连；是否会取代 RPC 模式。
3. `extension_ui_request` 在无宿主响应时的默认超时/取消语义（文档给出可选 `timeout`，未说明缺省）。
4. `--mode json` 与 `--session` 组合续写会话的官方支持程度（docs/json.md 未明说）。
5. OpenClaw 内化 pi 运行时的确切版本/日期（只确认 2026.8.1 已不依赖 pi-agent-core），以及其内部会话格式是否仍与 pi JSONL 兼容。
6. pi-telemetry 是否已有官方或社区 OTel adapter（本次未找到）。
7. `pi-session-backend-sqlite-node` 的 "S3 projection" 搜索服务的位置与形态。

## 来源列表

- https://github.com/earendil-works/pi （仓库首页；GitHub API 元数据 2026-09-03）
- https://github.com/earendil-works/pi/tree/main/packages ；https://github.com/earendil-works/pi/tree/main/packages/agent/src
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/README.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/session-format.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sessions.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/compaction.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/settings.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/security.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/containerization.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/skills.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/packages.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/prompt-templates.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/json.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/package.json
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/rpc/rpc-types.ts
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/rpc/rpc-client.ts
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/README.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/subagent/README.md ；…/subagent/index.ts
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/agent/README.md ；…/agent/package.json ；…/agent/src/index.ts ；…/agent/src/harness/agent-harness.ts
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/ai/README.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/telemetry/README.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/protocol/README.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/client/README.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/server/README.md
- https://raw.githubusercontent.com/earendil-works/pi/main/packages/session-backends/sqlite-node/README.md
- https://pi.dev ；https://pi.dev/docs/latest ；https://pi.dev/news/releases/0.84.0
- https://registry.npmjs.org/@earendil-works/pi-coding-agent ；https://data.jsdelivr.com/v1/package/npm/@earendil-works/pi-agent-core@0.84.4/flat
- https://en.wikipedia.org/wiki/Pi_(AI_agent)
- https://lucumr.pocoo.org/2026/1/31/pi/
- https://www.iceyao.com.cn/post/2026-08-11-pi-agent-harness源码深度技术解析/
- https://docs.openclaw.ai/pi ；https://raw.githubusercontent.com/openclaw/openclaw/main/package.json
- https://cloud.tencent.com/developer/article/2649100
- https://github.com/earendil-works/pi-chat
- https://deepwiki.com/earendil-works/pi/2.3-session-management-and-compaction
- https://agent-safehouse.dev/docs/agent-investigations/pi
- https://brian-kimball.com/blog/custom-pi-agent-workflow/
- https://github.com/jayzeng/pi-memory ；https://pi.dev/packages/pi-memory
