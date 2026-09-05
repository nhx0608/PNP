# T07 OpenAI Codex CLI / SDK / app-server 协议

> 调研日期：2026-09-04。本文以一手资料（openai/codex 仓库 docs、developers.openai.com/codex、npm 包文档）为准；"[已交叉验证]"表示该断言由两个独立来源确认。

## 摘要

OpenAI Codex 是 Rust 内核（codex-rs）的编码 Agent，提供三层可编程接入面：`codex exec --json`（一次性进程、JSONL 事件，`resume <id>` 续接，`--output-schema` 结构化输出）、`@openai/codex-sdk`（TS/Python，仅是 exec 的进程封装，`startThread/resumeThread/run/runStreamed`）与 `codex app-server`（长驻 JSON-RPC 2.0，stdio/ws/unix socket；`initialize → thread/start|resume|fork → turn/start|steer|interrupt`，item 通知流，审批为 server→client 请求 `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`，v1 名 `execCommandApproval`/`applyPatchApproval`）。官方 IDE 扩展与桌面 App 均建于 app-server 之上，也是网关接入的最佳方式。会话持久化为 `~/.codex/sessions/.../rollout-*.jsonl`（session_meta/response_item/event_msg/turn_context/compacted）并由 SQLite 索引，支持 resume/fork/revert/compact。权限模型是 `sandbox_mode(read-only|workspace-write|danger-full-access)` × `approval_policy(untrusted|on-request|on-failure|never)` × 新的 permission profiles，沙箱为 macOS Seatbelt / Linux bwrap+seccomp / Windows 原生，Docker 内需容器隔离。扩展资产包括 AGENTS.md、config.toml（150+ 键，`[model_providers.*]` 仅支持 Responses wire）、hooks.json（12 类生命周期事件）、SKILL.md、Plugins、MCP（client + `codex mcp-server`）、`dynamicTools`。记忆有用户级 Memories（`~/.codex/memories`）与 `thread/goal`、`thread/inject_items`。多 Agent v2 提供 `spawn_agent` 族工具与父子线程模型；Symphony（2026-04）是开源编排规范。可观测靠事件流 + `[otel]` OTLP 导出 + `LOG_FORMAT=json`。主要风险：协议实验性强、变化快；`thread/start` 会写用户 config 的 trusted projects；容器内沙箱退化。

## 关键事实（表格）

| # | 事实 | 来源 | 置信度 | 交叉验证 |
|---|------|------|--------|----------|
| 1 | Codex CLI 由 Rust 实现（codex-rs），当前 npm `@openai/codex-sdk` latest=**0.153.2**（2026-09-03 发布），alpha 0.154.0 | registry.npmjs.org/@openai/codex-sdk | 高 | 是（npm registry + GitHub sdk/typescript） |
| 2 | 三个可编程接入面：`codex exec --json`（JSONL）、`@openai/codex-sdk`（TS，内部 spawn `codex exec --experimental-json`）、`codex app-server`（JSON-RPC 2.0，stdio/ws/unix socket） | sdk/typescript/src/exec.ts；app-server/README.md | 高 | [已交叉验证] |
| 3 | `codex exec --json` 事件类型：`thread.started / turn.started / turn.completed / turn.failed / item.started / item.updated / item.completed / error`；item 类型 `agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, todo_list, error` | sdk/typescript/src/events.ts, items.ts；learn.chatgpt.com/docs/non-interactive-mode | 高 | [已交叉验证] |
| 4 | app-server 核心方法：`initialize`→`thread/start|resume|fork`→`turn/start|steer|interrupt`；审批为 server→client 请求 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`（v2）；v1 兼容名为 `execCommandApproval`/`applyPatchApproval` | app-server/README.md；codex-rs/docs/codex_mcp_interface.md | 高 | [已交叉验证] |
| 5 | 审批决策值：`accept / acceptForSession / acceptWithExecpolicyAmendment / applyNetworkPolicyAmendment / decline / cancel` | app-server/README.md "Approvals" | 高 | 单源（一手） |
| 6 | `approval_policy` 取值 `untrusted / on-request / on-failure / never`；`sandbox_mode` 取值 `read-only / workspace-write / danger-full-access` | sdk threadOptions.ts；config-reference | 高 | [已交叉验证] |
| 7 | 沙箱实现：macOS Seatbelt(`sandbox-exec`)、Linux `bwrap`+`seccomp`（早期版本为 Landlock+seccomp）、Windows 原生沙箱；Docker 中建议容器隔离 + `--sandbox danger-full-access` | learn.chatgpt.com/docs/agent-approvals-security | 高 | 与 SDK/README 一致 |
| 8 | 会话持久化于 `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`，行类型含 `session_meta / response_item / event_msg / turn_context / compacted`；SQLite `state_5.sqlite` 作索引 | DeepWiki rollout 页；protocol.rs `SessionMeta`；dev.to 逆向文章 | 中高 | [已交叉验证] |
| 9 | `codex exec resume <SESSION_ID>` / `--last`；`--output-schema` 不能与 resume 同用 | non-interactive 文档 | 高 | [已交叉验证]（搜索摘要+文档） |
| 10 | Hooks 事件：`SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, PreCompact, PostCompact, Stop, SubagentStart, SubagentStop, Interrupt`；配置在 `~/.codex/hooks.json` 与 `<repo>/.codex/hooks.json`；exit 2 = block | learn.chatgpt.com/docs/hooks | 高 | 与 GitHub issue #14882/#19385 时间线一致 |
| 11 | Memories：`[features] memories=true`，存于 `~/.codex/memories/`，开关 `memories.use_memories` / `memories.generate_memories`；app-server 有 `thread/memoryMode/set` | learn.chatgpt.com/docs/customization/memories；app-server README | 高 | [已交叉验证] |
| 12 | 多 Agent：`[features] multi_agent` / `multi_agent_v2`，模型工具 `spawn_agent, send_message, wait_agent, close_agent, followup_task, list_agents, spawn_agents_on_csv`；`[agents] max_threads / max_depth`；app-server 中子线程有 `parentThreadId`，"Parent-owned Multi-Agent V2 subagents" 拒绝直接 `turn/start` | config-reference；app-server README；danielvaughan 指南 | 中高 | [已交叉验证]（官方 README + 二手指南） |
| 13 | OTel：`[otel] exporter = "none|otlp-http|otlp-grpc"`，`endpoint/protocol/headers`，`log_user_prompt`，`environment`；默认关闭 | config-reference | 高 | 与 Harmonic/majesticlabs 二手一致 |
| 14 | 自定义 provider：`[model_providers.<id>] base_url / env_key / wire_api="responses" / requires_openai_auth`；`oss_provider = "lmstudio|ollama"` | config-reference | 高 | 单源（一手） |
| 15 | Symphony：2026-04-27 发布的开源编排 **规范**（SPEC.md）+ Elixir 参考实现，Apache-2.0，"low-key engineering preview"，将 Linear 看板作为 Codex agent 的控制平面 | github.com/openai/symphony README；openai.com 博客（搜索摘要） | 高 | [已交叉验证] |
| 16 | `codex mcp-server` 可把 Codex 作为 MCP server 暴露（实验性）；作为 MCP client 通过 `[mcp_servers.<id>]` 配置 stdio/HTTP 服务器 | codex_mcp_interface.md；config-reference | 高 | [已交叉验证] |

## 架构与工作原理

Codex 是 OpenAI 的编码 Agent 产品族：CLI（TUI）、`codex exec` 无头模式、VS Code/JetBrains 扩展、桌面 App、Codex Cloud（云端沙箱）以及 GitHub Action。核心引擎 `codex-core` 用 Rust 编写，位于 `openai/codex` 仓库的 `codex-rs/` 下；所有"富客户端"（IDE 扩展、桌面 App）都通过 **app-server**（`codex-rs/app-server`）这一 JSON-RPC 2.0 接口驱动同一个引擎（来源：learn.chatgpt.com/docs/app-server："the interface Codex uses to power rich clients (for example, the Codex VS Code extension)"）。

核心原语（app-server README "Core Primitives"）：
- **Thread**：一次对话，持久化为 rollout 文件；有 `threadId`、`status`（`idle/active/systemError/notLoaded`）、`forkedFromId`、`parentThreadId`。
- **Turn**：用户一次输入触发的一轮 agent 执行，直到 `turn/completed`（status `completed/failed/interrupted`）。
- **Item**：Turn 内的持久化元素（`userMessage`、`agentMessage`、`commandExecution`、`fileChange`、`mcpToolCall`、`reasoning`、`webSearch`、`enteredReviewMode/exitedReviewMode`、`contextCompaction` 等），生命周期 `item/started → item/<type>/delta… → item/completed`。

执行链路：客户端提交 `turn/start` → 引擎调用 Responses API（`wire_api = "responses"`，目前唯一支持值）→ 模型发出工具调用（shell、apply_patch、MCP tool、web_search、子代理工具）→ 引擎在沙箱内执行，需要时向客户端发 server-initiated 审批请求 → 流式 item 通知 → `turn/completed` 携带 `tokenUsage`。

三层接入面对比（推测性归纳，基于一手文档）：
| 接入面 | 形态 | 会话连续 | 审批交互 | 适合 |
|---|---|---|---|---|
| `codex exec --json` | 一次性进程，JSONL 到 stdout | `exec resume <id>` 重开进程 | 无（只能靠 policy 预设 never/full-auto） | CI、批处理 |
| `@openai/codex-sdk` | 封装 exec，进程按 turn 启动 | `resumeThread(id)` | 无 | Node 服务快速集成 |
| `codex app-server` | 长驻进程，JSON-RPC 双向 | `thread/resume`，多线程并存、可 fork | 有（requestApproval 请求/响应） | 网关/IDE/桌面等富客户端 |

## 可编程接入面

### 1. `codex exec` 无头模式
来源：https://learn.chatgpt.com/docs/non-interactive-mode（developers.openai.com/codex/noninteractive 308 跳转至此）。

关键参数（已确认）：`--json`（stdout 变为 JSONL 事件流）、`--output-schema <path>`（最终回复符合 JSON Schema；官方注明需 gpt-5 系列模型且不能与 `resume` 同用）、`-o/--output-last-message <path>`、`--ephemeral`（不落盘 rollout）、`--sandbox <read-only|workspace-write|danger-full-access>`、`--dangerously-bypass-approvals-and-sandbox`、`--skip-git-repo-check`、`--model`、`--profile`、`-C/--cd <dir>`、`--add-dir`、`--image`、`-c key=value`（任意 config 覆盖）、`--ignore-user-config`、`--ignore-rules`；`--full-auto` 已标记 deprecated（改用 `--sandbox workspace-write`）。SDK 源码还显示 exec 支持 `--experimental-json` 与 `--thread-source`（sdk/typescript/src/exec.ts）。

stdin 模式：`npm test 2>&1 | codex exec "summarize failures"`（prompt + 管道上下文）或 `cat prompt.txt | codex exec -`。CI 认证：`CODEX_API_KEY=<key> codex exec --json "task"`；官方推荐 GitHub Action `openai/codex-action`。

JSONL 示例（官方文档原文）：
```
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"..."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"output_tokens":122}}
```
`usage` 完整字段（events.ts）：`input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens`。

恢复：`codex exec resume --last "next instruction"` / `codex exec resume <SESSION_ID> "instruction"`。

### 2. `@openai/codex-sdk`（TypeScript）与 Python SDK
来源：https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md、src/threadOptions.ts、src/exec.ts。

- SDK "spawns the CLI and exchanges JSONL events over stdin/stdout"，即本质是 `codex exec --experimental-json` 的进程封装，**没有**独立协议。
- `new Codex({ codexPathOverride?, baseUrl?, apiKey?, env?, config?, configOverrides? })`：`config` 对象被打平为 `--config key=value`；`baseUrl` 变成 `--config openai_base_url=...`。
- `codex.startThread(opts)` / `codex.resumeThread(threadId)`；`ThreadOptions`（原文）：`model, threadSource, sandboxMode, workingDirectory, skipGitRepoCheck, modelReasoningEffort ("minimal|low|medium|high|xhigh|max|ultra|persistent"), networkAccessEnabled, webSearchMode ("disabled|cached|live"), approvalPolicy ("never|on-request|on-failure|untrusted"), additionalDirectories`。
- `thread.run(prompt | [{type:"text"},{type:"local_image",path}], { outputSchema })` 返回 `{ finalResponse, items, usage }`；`thread.runStreamed()` 返回 `{ events }` 异步生成器；`thread.id` 可持久化后 `resumeThread`。
- 限制：无审批回调（只能靠 policy）；要求 cwd 是 git 仓库（`skipGitRepoCheck` 可跳过）；fork/backtrack 未暴露（issue #4972）。
- Python SDK `openai-codex`（`pip install openai-codex`）：`Codex().thread_start(model=..., sandbox=Sandbox.workspace_write)`、`thread.run()`，`AsyncCodex` 异步版（来源：learn.chatgpt.com/docs/codex-sdk）。

### 3. `codex app-server`（JSON-RPC 2.0）[已交叉验证]
来源：https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md（约 214 KB，极详尽）。

传输：`--listen stdio://`（默认，JSONL）、`--listen ws://IP:PORT`（实验、附 `GET /readyz`、`/healthz`）、`--listen unix://PATH`（默认 `$CODEX_HOME/app-server-control/app-server-control.sock`，HTTP Upgrade 握手）、`--listen off`；`--code-mode-host URL` 连接远程 gRPC 执行宿主（需 `code_mode_host` feature）。Schema 生成：`codex app-server generate-ts --out ./schemas`、`generate-json-schema`。

握手：每连接先发 `initialize`（`clientInfo{name,title,version}`，`capabilities.experimentalApi`、`capabilities.optOutNotificationMethods`）再发 `initialized` 通知；响应含 `userAgent, codexHome, platformFamily, platformOs`。

线程/回合方法（节选）：
- `thread/start`：`model, cwd, sandbox|permissions(profile id), approvalPolicy, personality, serviceTier, developer_instructions, ephemeral, projectId, historyMode("paginated"|"legacy"), environments[], sessionStartSource`。当传入 `cwd` 且沙箱为 workspace-write/full access 时会**把该项目写入用户 config.toml 的 trusted 列表**（网关侧要注意副作用）。
- `thread/resume`：同样接受配置覆盖；`excludeTurns: true` 配合 `thread/turns/list` / `thread/items/list` 分页。
- `thread/fork`：复制历史到新 threadId，`lastTurnId`/`beforeTurnId` 边界，`ephemeral: true` 内存 fork，返回 `forkedFromId`。
- `thread/list`（过滤 `cwd, archived, sortKey, searchTerm, modelProviders, parentThreadId/ancestorThreadId`）、`thread/read`、`thread/archive|unarchive|delete`、`thread/loaded/list`、`thread/unsubscribe`（无订阅者 60s 后卸载，`thread_unload_delay_secs` 可配）、`thread/compact/start`、`thread/rollback`(deprecated)、`thread/revert`、`thread/inject_items`、`thread/name/set`、`thread/goal/set|get|clear`、`thread/queue/*`（实验，每线程最多 100 条排队消息）。
- `turn/start`（`threadId, input[]（text/image）, clientUserMessageId, turnTrigger, permissions|sandboxPolicy, collaborationMode, toolOutput`）、`turn/steer`、`turn/interrupt`、`turn/settings/update`、`review/start`。
- 其他：`model/list`（返回 `supportedReasoningEfforts`、`multiAgentVersion(disabled|v1|v2)`、`serviceTiers`）、`skills/list`、`plugin/list|install|uninstall|reconcile`、`mcpServer/tool/call`、`mcpServer/oauth/login`、`mcpServerStatus/list`、`config/read`、`config/value/write`、`configRequirements/read`、`command/exec`（沙箱内单命令，`command/exec/outputDelta` base64 流）、`process/spawn`（无沙箱）、`fs/*`、`fs/watch`、`account/read`、`account/login/start`、`account/rateLimits/read`、`server/diagnostics`。

通知：`thread/started`、`thread/status/changed`、`turn/started`、`item/started`、`item/agentMessage/delta`、`item/commandExecution/outputDelta`、`item/completed`、`turn/completed`、`thread/settings/updated`、`thread/closed`、`serverRequest/resolved`、`fs/changed`、`deprecationNotice`。背压：请求队列饱和返回 JSON-RPC error `-32001` "Server overloaded; retry later."。日志：`RUST_LOG`，`LOG_FORMAT=json` 输出结构化 stderr。

### 4. `codex mcp-server`
来源：codex-rs/docs/codex_mcp_interface.md。把 Codex 作为 MCP server（stdio）暴露，方法集与 app-server v2 一致（`thread/start`、`turn/start`…）并保留 v1 兼容（`getConversationSummary`、`fuzzyFileSearch`、审批 `applyPatchApproval`/`execCommandApproval`），事件通过 `codex/event` 通知流出。标注 experimental。

## 会话模型

- **标识**：`thread_id` 为 UUIDv7 风格时间可排序 id（示例 `0199a213-81c0-7800-8aa1-bbab2a035a53`）。
- **持久化**：rollout JSONL `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`；每行 `{timestamp, type, payload}`，`type` 取 `session_meta | response_item | event_msg | turn_context | compacted`（DeepWiki 还列出 `InterAgentCommunication`、`WorldState` 变体，置信度中）。冷数据 zstd 压缩，`state_5.sqlite` 作索引（DeepWiki，中置信）。`history.persistence = "save-all" | "none"`；`--ephemeral` 完全不落盘。
- `SessionMeta` 字段（protocol.rs 一手）：`session_id, id, forked_from_id, parent_thread_id, timestamp, cwd, originator, cli_version, source (Cli|VSCode|Exec|Mcp|Custom|SubAgent…), thread_source, agent_nickname, agent_role, agent_path, model_provider, base_instructions, dynamic_tools, selected_capability_roots, memory_mode, history_mode`；外层 `SessionMetaLine` 附 `git: GitInfo`。
- **resume/fork**：TUI `codex resume [id|--last]`；exec `codex exec resume`；app-server `thread/resume` / `thread/fork`（含 turn 边界与 ephemeral fork）。`thread/revert` 可把持久化历史截断到 `beforeTurnId` 之前并保留 threadId。
- **压缩**：自动 + `thread/compact/start` 手动，产生 `compacted` 行与 `contextCompaction` item。
- **隔离**：一个 app-server 进程可同时装载多个 thread；每 thread 有独立 `cwd`、沙箱策略、`environments`；多个连接可订阅同一 thread。

## 权限与安全

两个正交维度（来源：learn.chatgpt.com/docs/agent-approvals-security；config-reference）：
- **sandbox_mode**（技术边界）：`read-only`（只读）、`workspace-write`（可写工作区，默认 **network off**，`<root>/.git`、`.agents`、`.codex` 受保护）、`danger-full-access`。`[sandbox_workspace_write] writable_roots = [...]`, `network_access = true|false`。
- **approval_policy**（何时停下来问）：`untrusted`（只自动执行已知安全命令）、`on-request`（模型认为需要时请求）、`on-failure`（沙箱失败后再请求；SDK 类型确认）、`never`；config-reference 还允许**粒度表**：`sandbox_approval, rules, mcp_elicitations, request_permissions, skill_approval` 布尔。默认（git 仓库内）为 "Auto"= workspace-write + on-request。
- 新一代 **permission profiles**（beta）：`permissionProfile/list`，`default_permissions = "audit"` 一类的 profile id，`permissions.<profile>.filesystem = {":root"="read", "/path/.env"="deny"}`（SDK README 示例）；app-server 中 `permissions` 与旧 `sandbox` 字段互斥。
- **沙箱实现**：macOS Seatbelt（`sandbox-exec`）；Linux 现为 `bwrap` + `seccomp`（文档原文），历史版本为 Landlock+seccomp；Windows 原生沙箱/WSL2；Docker 内若宿主禁 namespace，建议由容器提供隔离并 `--sandbox danger-full-access`。
- **网络代理**：`[features] network_proxy`，域名 allow/deny 规则（`*.example.com` 通配，deny 优先，`allow_local_binding=false` 默认阻断回环/内网）。审批可返回 `applyNetworkPolicyAmendment { host, action }` 动态放行。
- **自动审核（Guardian）**：`approvals_reviewer = "auto_review"`，由模型评估需审批动作的风险，低/中风险放行，高风险拒绝；app-server 有 `thread/approveGuardianDeniedAction`、`item/autoApprovalReview/*` 通知。
- **执行策略**：`acceptWithExecpolicyAmendment` 可持久化 execpolicy 规则；`.rules` 文件（`--ignore-rules` 跳过）。
- **企业托管**：`requirements.toml`/MDM 提供 `allowedApprovalPolicies, allowedSandboxModes, allowedPermissionProfiles, allowManagedHooksOnly, allowRemoteControl, network` 等硬约束，可通过 `configRequirements/read` 读取。
- **认证**：API key（`CODEX_API_KEY`/`OPENAI_API_KEY`）、ChatGPT 登录（浏览器/设备码）、Amazon Bedrock 凭据；app-server 提供 `account/login/start`、`account/rateLimits/read`。

## 扩展机制与资产

| 资产 | 位置/格式 | 说明 | 来源 |
|---|---|---|---|
| AGENTS.md | 仓库根到 cwd 链式发现，`~/.codex/AGENTS.md` 全局；`project_doc_max_bytes` 限制大小，`project_doc_fallback_filenames` 备选名 | 项目指令，与 Claude 的 CLAUDE.md 同位 | config-reference |
| config.toml | `$CODEX_HOME/config.toml`（用户）、`<repo>/.codex/config.toml`（项目，需 trusted）、`requirements.toml`（托管）；优先级 CLI `-c` > 项目 > profile > 用户 > 系统 > 默认 | 150+ 键；`[profiles.<name>]` 或独立 `~/.codex/<name>.config.toml` | config-reference；majesticlabs |
| Hooks | `~/.codex/hooks.json`、`<repo>/.codex/hooks.json`，托管 hooks 在 requirements.toml；结构 事件→matcher→handlers[{type:"command",command,timeout(默认 600s)}]；托管还支持 `mcp_tool` handler | 事件见关键事实 #10；stdin JSON `session_id, cwd, hook_event_name, tool_name, tool_input`；exit 2 = block，或输出 `{"decision":"block"|"allow","additionalContext":...}`；`[features] hooks=false` 关闭 | docs/hooks |
| Skills | `SKILL.md`（`.codex/skills`、`~/.codex/skills`、`.agents/skills`），app-server `skills/list`，`turn/start` 可"invoke a skill"；`skill_approval` 审批项 | 与 Claude Agent Skills 格式相近（推测，官方 skills 页 404 未能核实细节） | app-server README；config-reference |
| Plugins | marketplace 插件，`plugin/list|install|uninstall|reconcile`，可捆绑 hooks、MCP servers、skills，`appsNeedingAuth` | 安装范围见 README "Plugin configuration scope" | app-server README |
| MCP client | `[mcp_servers.<id>] command/args/env`（stdio）或 `url` + `bearer_token_env_var`（Streamable HTTP），`enabled_tools` 白名单，`startup_timeout_sec`（默认 10s）；`codex mcp add/list` 管理；OAuth 登录 `mcpServer/oauth/login` | 工具调用出现为 `mcp_tool_call` item；MCP elicitation 转成审批 | config-reference；README |
| MCP server | `codex mcp-server` | 见上 | codex_mcp_interface.md |
| Apps | `app/list`，ChatGPT Apps（connectors）在 turn 中 "invoke an app" | 需 ChatGPT 认证 | README |
| Dynamic tools | `thread/start` 传 `dynamicTools[]`，客户端自带工具，调用通过 `item/tool/call` 请求回到客户端（实验） | 网关侧注入业务工具的正规入口 | README "Dynamic tool calls" |
| 自定义 provider | `[model_providers.<id>] base_url, env_key, wire_api="responses", requires_openai_auth`；`oss_provider="ollama"|"lmstudio"`，`codex --oss` | 仅支持 Responses wire 协议，Chat Completions 已移除（config-reference："currently `responses` (only supported value)"） | config-reference |

## 记忆

- 原生 **Memories**（v0.119+ 引入，默认关闭）：`[features] memories = true`；文件在 `~/.codex/memories/`（Markdown，视为生成状态）；两开关 `memories.use_memories`（读入）与 `memories.generate_memories`（写出）；`memories.disable_on_external_context`（使用 MCP/web search 时不生成）、`memories.min_rate_limit_remaining_percent`；`/memories` 命令按对话排除；自动脱敏。机制（二手，mem0 博客）：会话空闲约 6 小时后抽取摘要→后台合并→下次启动注入。app-server：`thread/memoryMode/set`（enabled/disabled）、`SessionMeta.memory_mode`。
- 其他记忆载体：AGENTS.md（项目级静态记忆）、rollout 历史（可 resume/fork）、`thread/goal`（跨 turn 持久目标与 tokenBudget）、`thread/inject_items`（外部注入 Responses API items，可用于网关级 RAG/记忆注入）。

## 多 Agent 与协作

- **子代理**（实验）：`[features] multi_agent = true`（v1）/ `multi_agent_v2 = true`；文档称 Ultra reasoning effort 会启用 "proactive multi-agent behavior"，旧 `multiAgentMode` 参数已被忽略。模型侧工具：`spawn_agent(message, task_name, agent_type?, model?, reasoning_effort?, fork_turns?)`、`send_message`、`followup_task(interrupt?)`、`wait_agent`、`list_agents`、`close_agent`、`spawn_agents_on_csv`（批量）。限流 `[agents] max_threads`（默认 6）、`max_depth`（默认 1）；自定义角色 `[agents.<name>]`（config_file 指向独立 toml）或 `.codex/agents/<role>.md`（二手来源，中置信）。v2 用路径寻址 `/root/researcher/summarizer`。
- app-server 视角：子代理是独立 thread，`parentThreadId`/`ancestorThreadId` 可列出后代；"Parent-owned Multi-Agent V2 subagents" 拒绝直接 `turn/start`、`turn/steer`、goal/compact 等，仅允许 `turn/interrupt` 和只读查询；`thread/read.canAcceptDirectInput` 标识是否可直接输入。`SessionSource::SubAgent`、`agent_role/agent_path` 写入 rollout 元数据。
- **协作模式**：`collaborationMode/list` 预设（Plan 等）；`review/start` 内置 reviewer；`thread/realtime/*` 语音实时会话（实验）。
- **Codex Cloud**：云端沙箱任务（ChatGPT 侧），CLI `codex cloud` 子命令；本次未获取一手协议文档（未解决问题）。
- **Symphony**（2026-04-27）：开源"规范优先"的编排层——SPEC.md 描述如何把 Linear 等看板作为控制平面，每个 issue 一个隔离工作区，轮询看板、拉起 agent、崩溃重启、并发上限；提供 Elixir 参考实现；Apache-2.0；明确为 "low-key engineering preview"、不作为独立产品维护。与"harness engineering"博文关联。

## 可观测性

- **事件流本身**即最完整的可观测源：exec JSONL（含 `usage`）、app-server 通知（`turn/completed.tokenUsage`、`thread/status/changed`、item delta）、rollout 文件（离线回放）。
- **OTel**（默认关闭，config-reference）：
```toml
[otel]
environment = "prod"          # 默认 "dev"
exporter = "otlp-http"        # none | otlp-http | otlp-grpc
log_user_prompt = false       # 是否导出原始 prompt
[otel.exporter.otlp-http]     # 文档写法为 otel.exporter.<id>.*
endpoint = "https://collector/v1/logs"
protocol = "binary"           # binary | json
headers = { "x-api-key" = "..." }
```
  企业可放在 `requirements.toml` 强制；`Gallager` issue 等社区讨论表明导出内容含 token、延迟、模型、审批模式。
- **日志**：`RUST_LOG` 级别，`LOG_FORMAT=json` 结构化 stderr；`$CODEX_HOME/log/`；`server/diagnostics` 进程指标。
- **通知钩子**：`notify = ["cmd"]` 接收 JSON 通知负载；Hooks `Stop/PostToolUse` 可作埋点旁路。

## 对我们架构的启示

### 接入方式选择
**推荐：网关以 `codex app-server`（stdio 或 unix socket）作为引擎适配层的主接口**，理由：(1) 单进程多 thread，天然对应"群→session"映射与隔离（每 thread 独立 cwd/sandbox/environments）；(2) 审批是显式 JSON-RPC 请求，网关可把 `item/commandExecution/requestApproval` 转成业务侧审批消息（群里点按钮）再回 `{decision}`；(3) `thread/list/read/turns/list` 提供无须解析磁盘的会话检索；(4) 有 `-32001` 背压、`thread/unsubscribe` 卸载与 `thread_unload_delay_secs` 生命周期控制；(5) `generate-json-schema` 可自动生成类型以做兼容性回归。`codex exec --json` / SDK 作为**降级路径**（无审批需求的批处理节点、CI）。

### 公共能力 vs 扩展能力映射
| 归一化公共能力 | Codex 实现 | 接入参数 |
|---|---|---|
| session.create/resume/fork | `thread/start` / `thread/resume` / `thread/fork`（exec: `resume <id>`） | `cwd, model, approvalPolicy, sandbox|permissions, developer_instructions, ephemeral` |
| turn.run/stream/interrupt | `turn/start` + 通知流 / `turn/interrupt` / `turn/steer` | `input[]{text,image}, clientUserMessageId, turnTrigger` |
| event 归一化 | `turn.*`、`item.*`（exec 名为 snake_case：`command_execution`；app-server 为 camelCase：`commandExecution`） | 需要两套映射表 |
| 审批/权限 | `item/*/requestApproval` ↔ `{decision}`；策略 `approval_policy × sandbox_mode × permission profile` | 网关统一为 `allow/allow_session/deny/cancel` 四态，Codex 特有 `acceptWithExecpolicyAmendment / applyNetworkPolicyAmendment` 作扩展 |
| 结构化输出 | `--output-schema` / SDK `outputSchema` | app-server 侧未见等价字段（未解决问题） |
| 工具扩展 | MCP client 配置；`dynamicTools`（客户端工具回调） | `[mcp_servers.*]`、`dynamicTools[]` |
| 指令/资产 | AGENTS.md、SKILL.md、hooks.json、config.toml | 按 cwd 投放文件 或 `-c` 覆盖 |
| 用量/可观测 | `usage/tokenUsage`、OTel `[otel]`、rollout JSONL | `otel.exporter.*` 指向网关 collector |
| 记忆 | AGENTS.md（静态）+ Memories（自动）+ `thread/inject_items`（注入） | `features.memories`, `memoryMode` |
| 模型/Provider | `model/list`；`[model_providers.*]`（仅 Responses wire） | `model, model_reasoning_effort, service_tier` |

**Codex 特有扩展能力**（能力协商时应作为 `codex.*` 命名空间暴露）：多 Agent v2（`spawn_agent` 族、`agents.max_threads/max_depth`、路径寻址子线程）、Guardian 自动审批、permission profiles、网络代理域名策略、`thread/goal`（目标+tokenBudget）、queued turns、`review/start`、collaboration modes、realtime 语音、`command/exec`/`process/spawn`/`fs/*` 宿主工具、Plugins marketplace、Apps、Codex Cloud、Symphony 编排规范。

### 能力识别流程建议
1. `initialize`（打开 `experimentalApi`）→ 读 `userAgent` 得版本；2. `model/list` 得 `multiAgentVersion`、`supportedReasoningEfforts`、`serviceTiers`；3. `experimentalFeature/list`、`permissionProfile/list`、`configRequirements/read` 得功能开关与企业限制；4. `skills/list`、`mcpServerStatus/list`、`plugin/list` 得资产清单；5. 用 `generate-json-schema` 做协议指纹并对比缓存版本。

### 风险与坑
- app-server 协议**变化极快**且大量方法标 experimental（realtime、queue、process、permissions），README 中已有 deprecated（`thread/rollback`、`multiAgentMode`、`--full-auto`、detached review）；需锁定 CLI 版本并用 schema diff 做回归。
- `thread/start` 带 `cwd` + 可写沙箱会**修改用户 config.toml 的 trusted projects**，多租户网关需隔离 `CODEX_HOME`（每租户/每群一个 HOME 或使用 `--ignore-user-config`）。
- Linux 沙箱依赖 `bwrap`/seccomp，容器内常不可用→需要容器级隔离 + `danger-full-access`，权限模型退化到网关侧。
- `--output-schema` 仅 gpt-5 系列且不能与 resume 并用；自定义 provider 仅 Responses API，接 OSS 模型需 Responses 兼容代理（Ollama/LM Studio 已内置）。
- exec 与 app-server 事件命名风格不一致（snake_case vs camelCase），归一化层要覆盖两套。
- rollout 文件格式与 `state_5.sqlite` 索引为内部实现，不宜直接读写；应通过 `thread/*` API。
- Memories 为用户级（`~/.codex/memories`）而非 thread 级，群隔离场景需按租户隔离 HOME 或关闭 `generate_memories`。
- ChatGPT 订阅登录有 rate limit（`account/rateLimits/read`），生产网关应走 API key 或企业配置。

## 未解决问题
1. app-server `turn/start` 是否有与 `--output-schema` 等价的结构化输出参数（README 极长，本次未定位到）。
2. 官方 Skills / Subagents / AGENTS.md 文档页（learn.chatgpt.com 路径）返回 404，Skills 目录发现顺序与 front-matter 字段、内置角色（explorer/worker）名称未能一手核实。
3. Codex Cloud 的编程接口（是否经 app-server `environment/add` + `execServerUrl` 或独立 API）未获取一手文档。
4. rollout 行类型的最新完整枚举（`InterAgentCommunication`、`WorldState`）来自 DeepWiki 二手，未在 protocol.rs 中直接定位。
5. Linux 沙箱从 Landlock 切换到 bwrap 的具体版本号未确认。
6. 多 Agent v2 自定义角色是 `[agents.<name>]` toml 还是 `.codex/agents/*.md`，两种二手说法并存。

## 来源列表
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md （app-server 协议一手）
- https://learn.chatgpt.com/docs/app-server （developers.openai.com/codex/app-server 跳转）
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/docs/codex_mcp_interface.md
- https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md
- https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/threadOptions.ts
- https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/exec.ts
- https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/events.ts
- https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/items.ts
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/protocol.rs （SessionMeta/SessionSource）
- https://learn.chatgpt.com/docs/codex-sdk
- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://learn.chatgpt.com/docs/agent-approvals-security
- https://learn.chatgpt.com/docs/hooks
- https://learn.chatgpt.com/docs/customization/memories
- https://registry.npmjs.org/@openai/codex-sdk （版本 0.153.2）
- https://github.com/openai/symphony （README）
- https://openai.com/index/open-source-codex-orchestration-symphony/ （经搜索摘要）
- https://deepwiki.com/openai/codex/3.5.2-rollout-persistence-and-replay （二手）
- https://codex.danielvaughan.com/2026/04/11/codex-cli-multi-agent-orchestration-v2-complete-guide/ （二手）
- https://majesticlabs.dev/blog/202607/codex-cli-configuration-guide （二手）
- https://dev.to/milkoor/reverse-engineering-codex-cli-rollout-traces-3b9b （二手，搜索摘要）
- https://mem0.ai/blog/how-memory-works-in-codex-cli （二手，搜索摘要）
- https://github.com/openai/codex/issues/4972 、#14882 、#19385 （搜索摘要）
