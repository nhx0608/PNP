# T05 DeepSeek Harness (dsh) "Everything is a Plugin"

> 调研日期：2026-09-04。所有事实标注来源；"[已确认]" 表示来自一手来源（官方仓库/文档），"[推测]" 表示基于二手来源或推断。

## 摘要

DeepSeek Harness（`dsh`）是 DeepSeek AI 于 2026-08-13 开源（MIT，TypeScript，npm `@deepseek-ai/dsh`，当前 `0.1.2-rc.1`，2026-09-03）的 developer-preview agent harness，口号 "Everything is a Plugin"。它建立在 Cordis 插件框架之上：模型适配器、工具注册表、会话日志、沙箱、持久化、UI 乃至 agent loop 全部是可从配置替换的插件，运行时是由 bundle → profile `cordis.patch.yml` → home patch → `--patch` 有序叠加出的插件树（`dsh --profile <name> --dump-config` 可见）。会话是 append-only 的 `SessionEvent` 日志（"Model-visible means logged"），支持 resume/fork/compaction，JSONL 持久化但格式 v0 无兼容承诺。

程序化接入面有三条：`dsh --profile headless "task"`（一次性）、`dsh --profile sdk`（newline-delimited JSON-RPC stdio：`initialize`/`session/prompt`/`shutdown` + `session.event` 等通知，有 TS/Python 客户端，但无 cancel/审批回路）、`dsh --profile acp`（标准 ACP v1：`session/new|list|resume|close|prompt|cancel|set_config_option|request_permission`，支持按会话声明 MCP）。权限模型是两个独立旋钮：`SandboxMode`（`read-only|workspace-write|danger-full-access`，bwrap/Landlock/Seatbelt/Windows ACL，只限文件效果）与 `ApprovalPolicy`（`ask|never`），打包为 permission preset；`tools/pre-execute` waterfall 可挂策略插件。资产上兼容 `AGENTS.md`/`CLAUDE.md`、SKILL.md 目录、Claude Code/Codex `hooks.json`，MCP 仅客户端（`mcp__<server>__<tool>`）；无内置长期记忆（靠 MCP 记忆服务器 overlay）。多 agent 方面有多 provider 子代理 seam（含 Claude Code/Codex/ACP 后端、能力标志 fail-loud）、`workflow`/`ralph` 动态编排、实验性 Agent Teams。可观测靠事件流 + `SessionTelemetryRecord`（OTel logs，默认发往 DeepSeek 端点，需注意）+ 第三方 OTel traces 插件。

对网关的建议：以 ACP profile 作为首选适配通道（与其它 ACP 引擎共用适配器），需要全量事件时用 SDK JSON-RPC；按租户隔离 `DSH_HOME`、按群固定 `cwd` + `session_id`，用 `--patch` 注入权限预设/MCP；把自修改、workflow、Agent Teams、fork、presets 归为 dsh 特有扩展能力。主要风险是协议/格式日更且无兼容承诺、token 成本高、SDK 通道无取消与审批、遥测默认外发。

## 关键事实

| 事实 | 来源 | 置信度 | 交叉验证 |
|---|---|---|---|
| 仓库 `github.com/deepseek-ai/deepseek-harness`，CLI 名 `dsh`，npm 包 `@deepseek-ai/dsh`，MIT 许可证，TypeScript（pnpm workspaces，ESM） | README / AGENTS.md / LICENSE | 高 | [已交叉验证] README + segmentfault + justin3go |
| 公开发布日期 2026-08-13（developer preview）；npm 首个版本 `0.0.1-rc.1` 发布于 2026-08-10T19:41Z | open-harness.net / segmentfault / justin3go / npm registry `time` 字段 | 高 | [已交叉验证] 三个二手来源一致说 8-13；npm 时间戳为一手；（CSDN 一篇写 8-16，属误差） |
| npm 当前版本：`latest` = `0.1.2-rc.1`（2026-09-03），`alpha` = `0.1.2-alpha.5`（2026-09-02）；几乎每日发版 | registry.npmjs.org/@deepseek-ai/dsh | 高 | 一手（npm） |
| GitHub star：约 211k（2026-09-04 页面抓取，"211.3k stars, 24.8k forks"）；发布 28 小时 92.7k、6 天 161k | github.com 页面 / justin3go / segmentfault | 中（页面渲染数字，API 被代理拦截无法二次确认） | 部分（趋势一致） |
| 官方文档站 `https://deepseek-harness.github.io/deepseek-harness/`（VitePress，中英双语） | README | 高 | [已交叉验证] README + 搜索结果页面 |
| 底层框架 Cordis（`cordiverse/cordis`，vendored），论文 arXiv 2608.25512 "A Programming Paradigm for Spatiotemporal Composability" | README | 高 | [已交叉验证] README + segmentfault |
| 状态声明："THERE WILL BE COMPATIBILITY-BREAKING CHANGES"；`SESSION_FORMAT_VERSION` 固定为 0，无兼容承诺；未经安全审计 | README / AGENTS.md / SAFETY.md | 高 | 一手 |
| 默认 Web UI 端口 `127.0.0.1:3080`，`npx @deepseek-ai/dsh web` 启动 | README / apps/cli/reference | 高 | [已交叉验证] README + open-harness.net |
| 五个内置 profile：`web`、`headless`、`sdk`、`sdk-minimal`、`acp`；`dsh web` 是 `--profile web` 别名 | docs/architecture.md / apps/cli/README.md | 高 | [已交叉验证] 两份一手文档 |
| SDK 协议：newline-delimited JSON-RPC 2.0 over stdio；方法 `initialize`、`session/prompt`、`shutdown`；通知 `session.event`、`session.status`、`subagent.started`、`subagent.finished` | packages/sdk/protocol/README.md | 高 | [已交叉验证] python/sdk/README.md 描述一致 |
| ACP（Agent Client Protocol）v1 服务端：`dsh --profile acp`，支持 `session/new`、`session/list`、`session/resume`、`session/close`、`session/prompt`、`session/cancel`、`session/set_config_option`、`session/request_permission`、stdio/Streamable-HTTP MCP | packages/acp/acp/README.md | 高 | [已交叉验证] architecture.md + acp-app README |
| Python SDK `deepseek-harness-sdk`（附带 runtime wheel，无需系统 Node），入口 `DeepSeekHarness(dsh_home, cwd, provider, model, reasoning_effort, max_tokens, profile, patches)`；`harness.run(prompt, session_id=...)` | python/sdk/README.md / docs/user/guide/python-sdk.md | 高 | [已交叉验证] 两份一手文档 |
| 沙箱模式 `SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`；后端 Linux bwrap/Landlock、macOS Seatbelt、Windows ACL restricted token；审批策略 `ApprovalPolicy = 'ask' | 'never'`；预设 `workspace-write`(ws-write+ask)、`danger-full-access`(full+never) | docs/subsystems/sandbox.md / approval.md / permission-presets.md | 高 | [已交叉验证] 三份一手文档 + agenticcontrolplane 二手 |
| 会话 = append-only `SessionEvent` 日志（`turn/*`、`step/*`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`request/header`…），JSONL 持久化（可 zstd），"Model-visible means logged" 运行时不变量 | docs/subsystems/session.md / persistence.md | 高 | [已交叉验证] architecture.md |
| 子代理 provider：`spawn-in-process`、`fork-in-process`、`acp`、`codex`、`claude-code`、`dsh-sdk`，即可把 Claude Code / Codex 作为 dsh 子代理后端 | docs/subsystems/subagent.md | 高 | [已交叉验证] justin3go 评测提及 |
| MCP：仅客户端（`@deepseek-ai/dsh-mcp-client`），每服务器一个配置行，工具命名 `mcp__<serverName>__<tool>`；仅桥接 Tools（不支持 resources/prompts）；stdio + streamable-http | packages/mcp/README.md / docs/user/guide/mcp-memory.md | 高 | [已交叉验证] findharness 二手 |
| 遥测：`dsh-session-telemetry-otel` 通过 OTel Logs 上报，模式 `FULL`/`FEEDBACK_ONLY`/`DISABLED`（env `DSH_TELEMETRY_MODE`），默认发送到 DeepSeek 端点；第三方 `@loongsuite/dsh-plugin` 导出 OTLP traces | packages/session/README.md / docs/subsystems/session-telemetry.md / SigNoz docs | 高 | [已交叉验证] |
| 工作区指令文件：`AGENTS.md`/`CLAUDE.md`（`agent-instructions` 插件默认开启）；skills 目录 `.dsh/skills`、`.agents/skills`、`$DSH_HOME/skills` 等；可桥接 Claude Code / Codex 的 `hooks.json` | packages/context/README.md / docs/subsystems/skills.md / packages/hooks/README.md | 高 | 一手 |
| 社区评测：token 消耗显著高于 pi（约 47.6K vs 4.5K/任务；另一评测 88K vs Claude Code 650K），AGENTS.md+CLAUDE.md 重复注入 bug；第三方插件质量参差 | justin3go / composio / tencentcloud | 中 | 二手，数字互相不一致 |

## 架构与工作原理

### 1. 基本定位 [已确认]
DeepSeek Harness（`dsh`）是 DeepSeek AI 于 2026-08-13 以 developer preview 形式开源的 agent harness，MIT 许可，TypeScript 单仓（约 57 个 package group，`packages/<group>/<pkg>/` 布局，每个包发布为 `@deepseek-ai/dsh-<name>`）。官方口号 "Everything is a Plugin"：模型适配器、工具注册表、会话日志、沙箱、持久化、UI、甚至 agent loop 本身都是 Cordis 插件，"There is no privileged core to patch"（docs/architecture.md）。它同时是可直接使用的 coding agent（Web UI / headless）和可重组的底层框架。

### 2. Cordis 内核 [已确认]
- Cordis（`cordiverse/cordis`，源码 vendored 到 `vendor/`）提供：插件向共享 `ctx` 贡献 **service**、**typed event**、**reversible effect**。所有注册都是 effect（`ctx.effect()` / `ctx.on()`），插件卸载时自动回退——这就是论文所说的"时空可组合性"（temporal：卸载可逆；spatial：插件声明依赖，运行时响应式热替换）。
- 事件分派模式：普通广播、**waterfall**（监听者必须调用 `next()` 才向下传递，否则短路）、serial。`agent/pre-step`、`agent/request`、`llm/stream`、`tools/pre-execute|execute|post-execute` 是 waterfall；`agent/turn-stopping` 是 serial。
- 配置以 YAML 行（row）表示，`cordis.yml` 允许 `!!js` 表达式（如 `port: !!js ctx.webStartup.port ?? 3080`）。

### 3. Profiles / Bundles / Patch 分层 [已确认]
运行中的 dsh 是"启动时按有序层组合出来的插件树"：
- **bundle**：发行格式，一个 `package.json` 的 `dsh.bundle` 指向其 patch 文件（`cordis.patch.yml`）。内置 bundle：`dsh-base`（模型适配器、工具、持久化、沙箱与审批策略、settings、credentials、telemetry）、`dsh-web-app`、`dsh-headless`、`dsh-sdk-app`、`dsh-acp-app`、`dsh-sdk-minimal`（唯一不叠加 base 的独立最小树）。
- **profile**：`$DSH_HOME/profiles/<name>/`，含 `package.json`（`dsh.profile.bundles` 有序列表 + `patchReload: live|startup`）与用户自己的 `cordis.patch.yml`。
- 叠加顺序：bundle patches（按序）→ profile `cordis.patch.yml` → home 级 `$DSH_HOME/cordis.patch.yml` → 每个 `--patch <file>` 覆盖层。**patch 以 row id 定位并整体替换该行 `config`（不 deep-merge），或 `insert` 新行**。
- `dsh --profile web --dump-config` 打印机器实际启动的完整树，任何一行都可被自己的 patch 替换。`web` profile 是 live reload；`headless/sdk/sdk-minimal/acp` 只在启动时应用一次（stdio 应用不能中途换依赖）。
- 外部插件用 `dsh plugin --profile <name> add <pkg|file:/path>`（转发 pnpm）安装到 profile 的 `node_modules`。

### 4. 插件类型（按能力 seam 分） [已确认]
官方没有"插件类型枚举"，而是以 **capability seam**（Service Definition / Service Provider / Consumer 三角色）组织。核心 `ctx` key 与包组：

| 能力 | ctx key / 包组 | 内置 provider |
|---|---|---|
| 模型 | `ctx.llm`（`llm/`） | `deepseek-official`；`llm-pi-ai` 适配器接入 pi-ai 目录（Anthropic/OpenAI/Bedrock/Vertex/Azure/Codex OAuth、自定义 OpenAI-compatible endpoint） |
| 工具注册表 | `ctx.tools`（`core/tools`） | scoped 注册 + guarded 执行管线 |
| Agent 接口/循环 | `ctx.agents`（`core/agent`）、`ctx.agentLoop`（`core/agent-loop`，可整体替换） | |
| 会话/持久化 | `ctx.sessions`、`ctx.sessionPersistence`、`ctx.sessionProjections` | JSONL（可 zstd）；文档提到 SQLite（`SCHEMA_VERSION`）用于 session-query 全文检索 |
| Shell / 子进程 / 终端 | `ctx.shell`、`ctx.subprocess`、`ctx.terminals` | 本地 bash/pwsh、PTY |
| 沙箱 | `ctx.sandbox`、`ctx.sandboxPolicy` | bwrap/Landlock、Seatbelt、Windows ACL；E2B 远程（POC） |
| 文件系统 / LSP / Web | `ctx.fs`、`lsp/`、`web/`（search/fetch） | |
| Skills | `ctx.skills` + `skill` 工具 | 本地目录 provider、bundled badge |
| 压缩 | `ctx.compaction`、`ctx.toolResultPruner` | `compaction-basic`、`/compact` |
| 子代理 | `ctx.subagents`（多 provider 共存） | in-process spawn/fork、acp、codex、claude-code、dsh-sdk |
| Workflow | `ctx.workflowEngine` + `workflow`/`ralph` 工具 | worker-thread 引擎 |
| 后台任务 / 计划 / 目标 | `ctx.jobs`、`schedule/`、`ctx.goals`、`plan/`、`todo_write` | |
| 人机交互 | `ctx.commands`、`ctx.approval`、`ctx.permissionPresets`、`ctx.userQuestions`（`ask_user_question`） | |
| 设置 / 凭证 / 存储 | `settings/`（`$DSH_HOME/settings.yaml`）、`credentials/`（`.credentials.yaml`、env/.env）、`storage/` | |
| 遥测 | `ctx.sessionTelemetry` | OTel logs backend |
| Webhook | `ctx.webhookRuntime` | GitHub 签名适配器 |
| MCP | `mcp-client` | stdio / streamable-http |
| 自修改 | `extensions/`（`tool-cordis` 七个工具、`ctx.dynamicCordisRunner`） | 模型在运行时定义/挂载/卸载动态 Cordis 包（仅内存） |
| 每会话组合 | `preset/`（`agent.cordis.yml`）、`persona` | 同进程多种不同组合的 agent |
| UI | `host/`（API gateway + HTTP）、`client/`（浏览器 `ui-*` 插件） | |

社区插件按 `dsh-plugin` topic 发现；第三方导航站统计 9 类（Model/Tools/Skills/Session/Sandbox/Storage/Loop/Scheduling/UI），8 月中已超 3000 个（V2EX，二手，[推测]质量参差）。

### 5. Turn / Step 流程 [已确认]
```text
turn/start
  claim next-step input (+ one queued message)
  assemble prompt sections + tool schemas
  -> agent/pre-step (waterfall: reject | enter(messages))
     step/start
     append user/message
     derive model history from log
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
  -> agent/turn-stopping
turn/end
```
`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*` 是持久化会话事件；`agent/*`、`tools/*`、`fs/*`、`telemetry/*` 是活动扩展点。外部上下文通过 `agent.inject()` 进入 inbox，在下一次被接纳的请求中出现。

## 可编程接入面

### A. CLI [已确认]
```sh
npx @deepseek-ai/dsh web                       # Web UI, 127.0.0.1:3080
dsh --profile web --port 8080 --host 0.0.0.0 --trusted-host x --no-open
dsh --profile headless "run the tests"          # 一次性任务：stdout=最终答案，stderr=`dsh: reasoning:` 推理增量，exit 0/1
dsh --profile sdk                               # JSON-RPC stdio server
dsh --profile sdk-minimal                       # 最小树（bash + editor + JSONL）
dsh --profile acp                               # ACP v1 stdio server
dsh --profile <name> --patch a.yml --patch b.yml
dsh --profile web --dump-config | --dump-default-config
dsh plugin --profile <name> add <pkg>           # 转发 pnpm
```
关键点：launcher 只解析自己的 flag，遇到首个未知 token 后全部交给 profile 内的 app 插件（`ctx.cmdlineArgs`）。headless 一次只跑一个任务、**无 resume 参数**（每次创建新的持久化 Agent）；`--resume <id>` 仅在社区 `tui` profile 示例中出现。环境变量：`DSH_HOME`、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DSH_TELEMETRY_MODE`、`DSH_TOOLS_MODE`（PTC 模式）、`DSH_MAX_TOKENS_AS_SUCCESS`。

### B. SDK JSON-RPC 协议（`dsh --profile sdk`） [已确认]
- 传输：JSON-RPC 2.0，每行一帧 `\n` 分隔，stdout 只承载协议帧。
- 请求（client→server）：`initialize`（`InitializeParams`：provider、model、cwd、可选 `reasoningEffort`、`maxTokens`）→ `InitializeResult`（`serverInfo.name = "deepseek-harness-sdk-runtime"`，`version` 目前恒为 `0.0.1`，无版本协商）；`session/prompt`（`SessionPromptParams`，内容块含 `SdkEncodedImageBlock {type:"image", data, mimeType}`）→ `SessionPromptResult.messageId`（只是入队回执，不是回答）；`shutdown`。
- 通知（server→client）：`session.event`（**运行时内所有会话的每条 SessionEvent，不过滤**）、`session.status`（whole-agent `running`/`idle`）、`subagent.started`、`subagent.finished`（含 `lastAssistantMessage`）。
- 已知限制：**没有 cancel、没有 session/close、没有 server→client 请求（审批流暂不可用）**；放弃一个 turn 只能杀进程；错误码 `-32601`/`-32603`。
- 客户端：TypeScript `@deepseek-ai/dsh-sdk-client`（spawn 子进程）；Python `deepseek-harness-sdk`（镜像同一协议）。会话续接靠 **同一个 `dsh_home` + 同一个 `session_id`**：`harness.run(prompt, session_id="x")` 重复调用即续写同一持久化会话；`RunResult(session_id, final_response, finish_reason, events, notifications)`，`finish_reason` 取自根会话最后 `turn/end.reason.kind`（`completed`/`max-tokens`/`error`）。

```python
from deepseek_harness import DeepSeekHarness
with DeepSeekHarness(dsh_home="/srv/dsh-home", cwd="/srv/ws/group-42",
                     provider="deepseek-official", model="deepseek-v4-flash",
                     reasoning_effort="max", max_tokens=49_152,
                     profile="sdk", patches=("/srv/policy.patch.yml",)) as h:
    r = h.run("总结今天的讨论", session_id="group-42")
print(r.final_response, r.finish_reason)
```

### C. ACP 服务端（`dsh --profile acp`） [已确认]
面向自动化（非 UI）的标准 Agent Client Protocol v1，stdio JSON-RPC。一个连接可并发多个 session。方法矩阵：`initialize`（声明 ACP v1 + `session/list`/`resume`/`close` + Streamable HTTP MCP）、`authenticate`（直接成功，无鉴权）、`session/new`（绝对 `cwd` + 可选 stdio/HTTP MCP 声明 + 返回配置选项状态）、`session/list`（newest-first 分页，`sessionListPageSize` 默认 100，可按 `cwd` 过滤）、`session/resume`（恢复日志、不重放旧 update）、`session/close`、`session/set_config_option`（`model` / `reasoning_effort`）、`session/prompt`（每会话一次一个 in-flight prompt）、`session/cancel`、`session/update`（assistant 消息、thoughts、通用 tool lifecycle、配置变化、context usage）、`session/request_permission`（一次性 allow/reject，客户端可自动回答）。**不支持**：`session/load`、删除、fork、transcript 重放、modes、commands、plans、terminals、elicitation。配置：
```yaml
- name: '@deepseek-ai/dsh-acp'
  config: { provider: deepseek-official, model: deepseek-v4-pro }
```

### D. Web/HTTP 与 Webhook [已确认/部分推测]
`web` profile 有 `host/`（API gateway + HTTP route server，Typert RPC）与浏览器客户端，但文档未把 HTTP API 作为公开稳定接口，[推测] 不适合作为网关接入面。`webhook/` 组提供认证后的外部事件 → 规则 → 在 Web Workspace 内创建根 Session（fire-and-forget，无队列/重试/去重），内置 GitHub 签名适配器；`config/examples/` 有 GitHub review webhook 示例。

### E. 进程内 / 其他
官方明确禁止"直接进程内挂载插件"作为应用入口（`verify-application-entrypoints` 门禁）：一切从 `dsh --profile` 启动。因此网关只能以子进程 + stdio 协议（SDK JSON-RPC 或 ACP）或 CLI 方式接入。

## 会话模型

[已确认] 来源：docs/subsystems/session.md、persistence.md、architecture.md。
- **Session = append-only 的 `SessionEvent` 日志**，是 agent 全部交互历史的唯一真相；LLM 消息历史由 `deriveMessages()` 从日志投影，从不单独存储。`seq` 连续，每条事件都是无损 JSON（`Session.append` 用 `isJsonValue` 校验）。
- 事件词汇（`SessionEventMap`，可用 declaration merging 扩展）：`turn/start|end`（`TurnEndReason`）、`step/start|end`、`user/message`（`source` 区分人类 prompt / `agent.inject()` 注入 / goal continuation）、`assistant/chunk`（token 级回放）、`assistant/message`（含 `usage`、`interrupted`）、`tool/call`（`callId`、原始 `arguments` 字符串）、`tool/result`（`error`、`meta`）、`request/header`（`EpochHeader`：call config + system prompt + tool schemas，reason `initial|resume|change|series`）、`request/context`、`session/end-seed`；插件合并的还有 `compaction/start|summary|end`、`hook/invoked|result`、`approval/asked|decided|policy`、`sandbox/mode`、`permission/preset`、`workflow/*` 等。
- **不变量 "Model-visible ⟺ logged"**：任何进入模型请求的内容必须能从日志重建，运行时断言；所以每个 request 都是日志的纯函数，可重放/fork/resume/转录。
- **Fork**：`ctx.agents.create({ sessionId, seed, meta: { parentSession, seedLength } })` 在 turn 边界分叉；`session/end-seed` 标记 seed 边界；子会话头部记录 `parentSession`、`seedLength`。
- **持久化 seam**：`ctx.sessionPersistence` 提供 `create/open/stat/list/export`，`SessionHandle`（`read/append/flush/close`）单写者所有权（第二个 `open(id,'write')` 抛 `SessionAlreadyOwnedError`）。内置 JSONL 后端（每会话一个文件，`$DSH_HOME/sessions/`，可 zstd）；`session-checkpoint-policy` 保证每次模型请求/顶层工具副作用/完成的 step 在下一动作前落盘；`flush()` 是唯一的持久化屏障。写后端可替换（如云存储、数据库）。
- **投影**：`ctx.sessionProjections` 增量折叠事件得到状态（stats、turnOutline、permissions…），`session-projection-cache` 持久化 checkpoint 加速冷读；`session-query/` 提供跨会话检索（SQLite FTS）。
- **上下文管理/压缩**：`compaction/` 家族——`compaction-basic` 按 token 压力自动把旧历史压缩成摘要（写入 `compaction/*` 事件），`/compact` 命令手动触发，`compaction-tool-result-pruner` 先裁剪超大工具输出；`spill/` 把超大工具结果溢写到存储。默认在 `dsh-base` 启用。
- **多会话/隔离**：一个进程可同时运行多个 Agent；每会话有不可变 `cwd`（既是工作区又是沙箱 workspace-write 边界）；`preset/` 允许同一进程内不同会话挂载不同工具/persona/skills（`agent.cordis.yml`，需要 `isolate` realm 的 service row）。
- **会话标识**：`SessionId` 为 branded 类型；ACP 与 SDK 均允许调用方指定/复用 session id（Python `session_id`，ACP `session/resume`）。
- 版本：`SESSION_FORMAT_VERSION = 0`，明确"后端拒绝旧的磁盘格式"，无兼容承诺（AGENTS.md）。

## 权限与安全

[已确认] 来源：docs/subsystems/sandbox.md、approval.md、permission-presets.md、SAFETY.md、mcp-memory.md。
- **两个独立旋钮**：
  1. `sandbox/mode`（`SandboxMode`）：`read-only`（默认，fail-safe）| `workspace-write`（可写 workspace root + 后端临时区）| `danger-full-access`（绕过）。**只管文件效果，不管网络与进程可见性**。后端：Linux bwrap / Landlock（`@deepseek-ai/node-addon-landlock-run` 原生模块）、macOS Seatbelt、Windows ACL restricted token；`SandboxEnforcement = 'full' | 'partial'` 如实报告（旧 Landlock ABI、Windows ACL 为 partial）。策略按调用解析（`ctx.sandboxPolicy.resolve({session, mode})`：显式批准的 mode > 会话最后一条 `sandbox/mode` 事件 > 部署默认），`ctx.sandbox.confine(argv, policy)` 返回包裹后的 argv，找不到可用后端时抛 `SANDBOX_UNAVAILABLE`，**禁止静默降级为不受限执行**。
  2. `approval/policy`（`ApprovalPolicy`）：`ask`（走 answerer waterfall，无人应答则 `unavailable` → 拒绝）| `never`（无人机 headless/CI 立场，一律 `rejected`）。`ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，只有 `allowed-once` 放行且只放行这一次；每次询问在会话日志写入 `approval/asked`/`approval/decided` 审计对（不进模型上下文）。
- **Permission presets**（`ctx.permissionPresets`）：把两个旋钮打包成命名预设，默认表 `workspace-write`（workspace-write + ask）和 `danger-full-access`（danger-full-access + never）；`custom` 为派生态。切换写入 `permission/preset` 事件再各自写旋钮。可通过配置 `presets` 表自定义（例如为群助手定义 `readonly-never`）。
- **工具级策略扩展点**：`tools/pre-execute` waterfall——社区 `dsh-tool-policy` 在此按工具名 + JSON-Pointer 参数规则做 deny / ask / allow；`dsh-approve-for-me` 做规则 + LLM 审核的自动审批。子代理可用 `toolFilter`（`tools.restrict()`，工具在提示词中消失且拒绝执行）与 `maxDepth`。
- **凭证**：`$DSH_HOME/.credentials.yaml` 与 env/.env provider；settings 只保存引用；MCP stdio 子进程启动前剔除疑似凭证的环境变量与所有 `DSH_*`。
- **审批在自动化接口的可达性**：ACP 有 `session/request_permission`（客户端可自动应答）；**SDK JSON-RPC 目前没有 server→client 请求，审批流不可达**，因此 SDK 模式下要么 `never`（全拒）、要么用 preset/插件自动放行。
- 官方安全声明：未经安全审计，沙箱/审批"不能保证隔离"，建议一次性 VM/容器最小权限运行。

## 扩展机制与资产

[已确认]
- **插件 = npm 包 + Cordis plugin**（`apply(ctx, config)` 风格；所有注册通过 `ctx.effect()`，返回 disposer）。约定：ESM、`@deepseek-ai/cordis` 为 peerDependency、Config 用 schema 校验、"misconfiguration fails loud"、无硬编码可调参数。插件依赖 Service Definition 而非具体 provider。
- **分发**：GitHub topic `dsh-plugin`；不接受外部 PR 进主仓，扩展独立发布。安装：`dsh plugin --profile <p> add <pkg>`，然后在 `cordis.patch.yml` 里 `insert` 行；或 `--patch` 覆盖层临时挂载。
- **开发流程**（社区总结，[推测]）：Creator 预设/`extensions` 组让模型在运行时用 `tool-cordis` 七个工具定义、运行、停止动态包（仅内存），验证后打包成 bundle 挂到 profile。
- **配置资产**：`$DSH_HOME/profiles/<name>/package.json`、`cordis.patch.yml`、`$DSH_HOME/cordis.patch.yml`、`$DSH_HOME/settings.yaml`（如 `llm-pi-ai.providers.<id>: {api: openai-completions, baseURL, apiKeyEnv, models[], compat{supportsDeveloperRole,maxTokensField,thinkingFormat}, defaultInput}`）、`.credentials.yaml`、`sessions/`、`skills/`。生成的 `docs/config-catalog.md`、`tool-catalog.md`、`persistence-catalog.md` 枚举全部字段。
- **工作区指令**：`AGENTS.md` / `CLAUDE.md`（`agent-instructions` 插件默认开启，子目录 AGENTS.md 按需注入，编辑后刷新）；`.dsh/skills`、`.agents/skills`、`$DSH_HOME/skills`、`<agentsHome>/skills`（SKILL.md 形式，模型通过 `skill` 工具按需加载，用户可 `/name` 调用）。
- **Hooks 桥接**：`hooks-claude-code`、`hooks-codex` 插件直接复用现有 Claude Code / Codex `hooks.json`（session start、prompt submit、pre/post tool、stop），可阻断、附加上下文、强制继续。
- **MCP**：客户端 `@deepseek-ai/dsh-mcp-client`，配置行字段 `serverName, transport: stdio|streamable-http, command, args, env, cwd | url, headers`；工具名 `mcp__<serverName>__<tool>`；自动重连（有尝试预算）；不支持 resources/prompts；**dsh 自身不提供 MCP server**。
- **Agent presets**：`agent.cordis.yml` 目录 = 一种 agent 组合（工具 + prompt sections + skills + persona），同一进程多组合并存。

## 记忆

[已确认] dsh **没有内置长期记忆子系统**（packages 目录无 memory 组）。官方提供三个默认关闭的参考 overlay，通过 MCP 客户端接第三方记忆服务器：Memorix、`@modelcontextprotocol/server-memory`（知识图谱）、Engram（`apps/cli/config/examples/mcp-memory/*.cordis.yml`），用 `dsh web --patch <file>` 启用，并明确"不代表背书"。第三方 Hindsight 提供原生 Cordis 记忆插件。同会话内的"记忆"靠：append-only 日志 + compaction 摘要 + `session-reference`（把其他会话的只读快照作为上下文引用）+ `session-query`（跨会话 FTS 检索工具）+ `goal/`（同会话目标持久化）。[推测] 对网关而言，跨群/跨引擎的记忆应放在网关侧，通过 MCP 或注入上下文供给。

## 多 Agent 与协作

[已确认]
- **Subagent seam**（`ctx.subagents`，多 provider 按名注册）：一次性 `start()` 与可续接 `prepareContinuable`。能力标志 `SubagentCapabilities {agentOptions, outputSchema, depthLimit, toolFilter, persona}`——请求需要 provider 不支持的能力时抛 `SubagentError('UNSUPPORTED_CAPABILITY')`（"fail loud, no silent degradation"）。`SubagentStartRequest` 字段：`label, prompt, parent, signal, agentOptions{provider,model,reasoningEffort,maxTokens}, outputSchema, maxDepth, toolFilter, persona`。
- Provider：`spawn-in-process`、`fork-in-process`（继承父上下文）、`acp`（任何 ACP agent）、`codex`、`claude-code`、`dsh-sdk`（另一个 dsh 进程）。控制工具：`send_message`、`interrupt_agent`、`list_agents`。这套"能力声明 + 多后端"设计本身就是一个"引擎适配层"的参考实现。
- **Workflow**（`ctx.workflowEngine`）：模型编写的编排脚本在 worker thread 中运行，fan-out 多个子代理并返回值（`workflow` 工具）；`ralph` 工具为固定的"新鲜 agent 迭代循环"。这即赛题所说的 dynamic workflow 能力；引擎声明"containment, not a security boundary"。
- **Agent Teams（experimental，私有 opt-in）**：`ctx.agentTeams`——durable roster（`TeamMemberSnapshot`）、任务 DAG（`TeamTaskSnapshot`，`blockedBy`、`writeScopes` 建议性写范围、compare-and-set `revision`）、durable mailbox（Steer 投递：运行中在 step 边界收，空闲则开新 turn，inactive 冷恢复）；API `spawnTeammate/sendMessage/createTask/updateTask/waitForChange/interrupt`。全部折叠自 Lead Session 的日志。未正式发布。
- **Jobs / Schedule / Webhook**：`ctx.jobs` 后台任务（`job_*` 工具）、session-local 定时跟进、webhook 触发新 Session。

## 可观测性

[已确认]
- **日志即事件流**：所有持久化会话事件通过 `session/event` 同步广播；SDK 通知 `session.event` 把运行时全部会话事件（未过滤）推给客户端；ACP 只推标准语义 update。这意味着网关可直接消费 `SessionEvent`（`{type, seq, time, data}`）做统一埋点。
- **Telemetry seam**：`ctx.sessionTelemetry` 把每条 session 事件（`channel:'ledger'`）和运行信号（`channel:'ops'`：`agent-error`、`shutdown`）投影为 `SessionTelemetryRecord {channel, time, severity: info|warn|error, attributes{session.id, event.type, event.seq, session.cwd, session.parent_id, agent.id, turn, step, error.name}, body}`；每 (turn, step) 只上报第一条 `assistant/chunk`；有 `session-telemetry/record` 脱敏 waterfall；best-effort（可丢可重，按 `(session.id, event.seq)` 去重）。内置后端 `dsh-session-telemetry-otel` 走 OpenTelemetry Logs，模式 `FULL | FEEDBACK_ONLY | DISABLED`（`DSH_TELEMETRY_MODE`），**默认目标是 DeepSeek 自己的端点**（隐私注意，可通过 patch 改 exporter 或 DISABLED）。`/feedback` 命令会显示 sharing 状态。
- **Traces**：官方无 OTel trace 导出；阿里 `@loongsuite/dsh-plugin`（Apache-2.0）hook 生命周期导出 OTLP/HTTP，span 种类 `enter_ai_application_system`（turn 根）、`invoke_agent deepseek-harness`、`react step`、`chat <model>`、`execute_tool <tool>`，用 `OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS`、`OTEL_SERVICE_NAME` 或 patch 配置（`endpoint, serviceName, headers, resourceAttributes, captureContent, exportMetrics`）（SigNoz 文档，二手但具体）。
- **Token 计量**：`assistant/message.usage`（`TokenUsage`）随事件；ACP `session/update` 有 context usage；`session-stats` 投影统计轮次与时长。
- **审计**：`approval/asked|decided`、`sandbox/mode`、`permission/preset`、`hook/invoked|result` 等 log-only 事件天然形成审计轨迹；`session-log-deepseek` 可把增量日志作为 DeepSeek 官方请求元数据上传（可选）。
- 进程级：headless 的 stderr `dsh: reasoning:` 与 `dsh: <code>: <message>`；exit code 0/1。

## 对我们架构的启示

### 1. 与 Claude Code / opencode / pi 的对比（综合一手文档与二手评测）

| 维度 | dsh | Claude Code | opencode | pi |
|---|---|---|---|---|
| 定位 | 可重组的 agent 运行时/框架，附带 coding agent | 成品 coding agent + 生态 | 终端优先的成品 coding agent | 极简、agent 自扩展 |
| 无头/程序化接口 | headless CLI、JSON-RPC stdio SDK（TS/Python）、ACP v1 server | `claude -p`、Agent SDK、（ACP 需第三方桥） | HTTP server / SDK、ACP | RPC/SDK |
| 会话模型 | append-only 事件日志 + fork/resume，格式 v0 无兼容承诺 | JSONL transcript | 数据库 | append-only |
| 权限 | sandbox mode × approval policy，内核级沙箱（bwrap/Landlock/Seatbelt） | permission rules/modes、hooks | permission config | 极简 |
| 扩展 | Cordis 插件（任何层，含 loop）、MCP client、skills、hooks 桥 | plugins/skills/hooks/MCP client+server | plugins/MCP | extensions |
| 子代理/其他引擎 | 原生把 Claude Code / Codex / ACP agent 作为子代理后端 | Task 子代理 | 子代理 | — |
| 成熟度 | developer preview，日更，破坏性变更 | 成熟 | 较成熟 | 成熟 |
| 社区评价 | 架构最激进、可审计性最强；被指过度工程、token 消耗高（10× pi）、插件质量参差、文档"写给 agent 看" | 最完整 | 最稳的日用 | 最省 token |

### 2. 公共能力 vs dsh 独有扩展能力映射

| 网关抽象能力（公共） | dsh 对应 | 接入参数 / 备注 |
|---|---|---|
| 创建会话 / 会话续接 | SDK：同 `dsh_home` + `session_id` 重复 `run`；ACP：`session/new` / `session/resume`（`cwd`） | `dsh_home`（按租户隔离）、`cwd`（按群/业务隔离）、`session_id` |
| 发送消息 / 流式输出 | SDK `session/prompt` + `session.event` 通知；ACP `session/prompt` + `session/update` | 内容块（text/image） |
| 取消 | ACP `session/cancel`；**SDK 无 cancel（只能杀进程）** | 选 ACP 若需要取消 |
| 模型选择 / 推理强度 | `initialize{provider, model, reasoningEffort, maxTokens}`；ACP `session/set_config_option{model, reasoning_effort}` | provider 须在 profile 组合中注册 |
| 权限限制 | `sandbox/mode`、`approval/policy`、permission preset、`tools/pre-execute` 策略插件、子代理 `toolFilter` | 通过 `cordis.patch.yml` / `--patch` 固化；ACP 可由网关自动答复 `session/request_permission` |
| 工具扩展（MCP） | `dsh-mcp-client` 行（stdio/streamable-http） | 每服务器一行 patch |
| 指令/技能资产 | `AGENTS.md`、`.dsh/skills`/`.agents/skills`（SKILL.md）、hooks.json 桥 | 与 Claude Code/Codex 资产高度兼容 |
| 事件/可观测 | `SessionEvent` 流（`type/seq/time/data`）、`SessionTelemetryRecord`、OTel logs；第三方 OTel traces | 网关做归一化：turn/step/tool/usage 字段齐全 |
| 压缩 / 上下文管理 | compaction 自动 + `/compact` | 引擎内置，网关无需干预 |
| 子代理 | `ctx.subagents` 多 provider | 公共能力（有能力标志） |
| **dsh 独有扩展** | 运行时自修改（`tool-cordis` 动态包）、`workflow`/`ralph` 动态编排脚本、Agent Teams（实验）、agent presets（同进程多组合）、fork 会话、session-reference/session-query、PTC 模式（`DSH_TOOLS_MODE`）、Landlock 级沙箱、把 Claude Code/Codex 当子代理 | 这些应在能力协商时作为 `extensions` 暴露，配置项为 patch 行（如 `@deepseek-ai/dsh-tool-workflow`、`@deepseek-ai/dsh-acp` 的 `provider/model`、preset 表） |

### 3. 作为引擎接入网关的推荐方式
1. **首选 ACP profile（`dsh --profile acp`）**：标准协议、天然多会话、有 `session/list|resume|close|cancel`、`request_permission` 可由网关代答、MCP 可按会话声明；与其它支持 ACP 的引擎（opencode、pi、Gemini CLI 等）共用同一适配器，最符合"网关稳定、引擎可换"。缺点：无 fork、无 transcript 重放、只有标准语义 update（拿不到 dsh 私有卡片）。
2. **需要全量事件时用 SDK JSON-RPC profile**：`session.event` 给出所有会话的原始事件，最适合可观测归一化；但无 cancel/close/审批回路，需一个群一个子进程或自行管理。
3. **一次性任务用 headless**：`dsh --profile headless "task"`，CI/批处理，不可续接。
4. **隔离策略**：每租户一个 `DSH_HOME`（profile、凭证、sessions 全隔离）；每群一个 `cwd`（同时是沙箱 workspace-write 边界）+ 固定 `session_id`；用 `--patch` 注入群级权限预设与 MCP 行。
5. **能力识别→适配→认证流程建议**：`dsh --version` + `dsh --profile acp --dump-config` 读取组合树（判断挂载了哪些能力行，如 `dsh-tool-workflow`、`dsh-mcp-client`、`dsh-acp`）；ACP `initialize` 返回声明的能力；SDK `initialize` 拒绝不可用 provider/model（fail loud）。以此生成能力清单再做映射。

### 4. 风险与坑
- **格式与协议不稳定**：`SESSION_FORMAT_VERSION=0`、SDK `serverInfo.version=0.0.1` 无协商、README 明言破坏性变更、npm 几乎每日 rc；网关适配器必须锁定版本（`npx @deepseek-ai/dsh@0.1.2-rc.1`）并做快照测试。
- **遥测默认指向 DeepSeek 端点**（`DSH_TELEMETRY_MODE` 需显式 `DISABLED`）；`session-log-deepseek` 可上传会话日志。企业接入要审查。
- **SDK 通知不过滤会话**：多群共用一个 SDK 进程时网关必须按 `session.id` 分流；且无 cancel。
- **审批在 SDK 通道不可达**：只能 `never` 或自动放行插件；无人值守时应配 `read-only` + `never` 或自定义 preset。
- **sandbox 只限制文件效果**，网络/进程不受限；Windows 与旧内核为 `partial`。
- **token 成本**：评测显示系统提示与工具 schema 庞大（约 10× pi），且有 AGENTS.md/CLAUDE.md 重复注入 bug；群助手这类高频短对话场景成本敏感，可用 `sdk-minimal` profile 或 preset 精简工具集。
- **运行依赖**：Node ≥22.19 或 24；Python SDK 附带 runtime wheel 但仅 Linux x64/arm64、macOS 14+ arm64、Windows x64；Landlock 需原生 addon；`dsh plugin` 需要 pnpm。
- **自修改/动态包**只存内存、重启即失；Agent Teams 为 experimental 私有能力，不应列入公共能力。
- 直接进程内嵌入被官方门禁禁止，只能子进程接入；每个子进程冷启动要加载整棵插件树（[推测] 启动延迟数秒）。

## 未解决问题
1. GitHub API 在本环境被代理拦截，star/fork 数只能依赖页面渲染（约 211k）与二手文章，未能用 API 复核。
2. SDK JSON-RPC 的 `InitializeParams` 完整字段列表（是否含 `cwd`、`profile`）只从 Python 文档反推，未读 `src/types.ts` 原文。
3. ACP `session/update` 中 dsh 具体的 `stopReason` 映射（`src/codec.ts`）与 context usage 字段名未核实。
4. Web `host/` 的 HTTP API（Typert RPC）是否可作为稳定的远程接入面，文档未明确承诺。
5. `sdk` profile 下多群共享一个进程时的并发上限与资源模型未见文档。
6. 社区 token 消耗数据（47.6K vs 4.5K；88K vs 650K）口径不一致，需要自测。
7. 是否存在官方 Docker 镜像 / 远程沙箱（E2B 为 POC）在生产的可用性未知。

## 来源列表
- https://github.com/deepseek-ai/deepseek-harness （README、stars 页面）
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/AGENTS.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/SAFETY.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/architecture.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/apps/cli/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/apps/cli/reference/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/sdk/protocol/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/sdk/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/bundle/sdk-app/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/bundle/acp-app/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/bundle/headless/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/acp/acp/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/python/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/python/sdk/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/guide/python-sdk.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/guide/index.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/guide/providers.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/guide/mcp-memory.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/session.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/persistence.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/sandbox.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/approval.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/permission-presets.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/subagent.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/agent-team.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/skills.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/session-telemetry.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/session/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/mcp/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/skill/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/hooks/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/compaction/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/workflow/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/interaction/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/webhook/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/extensions/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/context/README.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/preset/README.md
- https://registry.npmjs.org/@deepseek-ai/dsh （版本与时间戳）
- https://www.open-harness.net/
- https://codepick.dev/en/guides/deepseek-harness-intro/
- https://justin3go.com/en/posts/2026/08/15-deepseek-harness-review
- https://signoz.io/docs/deepseek-harness-observability/
- https://segmentfault.com/a/1190000048178183 （403，仅用搜索摘要）
- 搜索摘要：https://composio.dev/content/deepseek-harness-vs-claude-code 、https://www.tencentcloud.com/techpedia/147665 、https://www.v2ex.com/t/1234767 、https://github.com/deepseek-ai/deepseek-harness/discussions/174 、https://github.com/timeance/dsh-approve-for-me 、https://agenticcontrolplane.com/controls/dsh 、https://findharness.com/blog/deepseek-harness-mcp-guide
