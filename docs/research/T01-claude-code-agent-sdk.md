# T01 Claude Code 与 Claude Agent SDK 作为引擎内核

> 调研日期：2026-09-04。本文以一手来源（docs.claude.com / code.claude.com / GitHub 官方仓库）为准，标注"[已交叉验证]"处表示由两个独立来源确认。

## 摘要

Claude Code 是一个以 CLI 进程为核心的 agent harness，对外提供四层接入面：(1) `claude -p` 无头模式的 NDJSON 双向协议（`--input-format/--output-format stream-json`），事件为 `system/init`→`assistant`/`user`/`stream_event`→`result`，含 `session_id`、usage、`total_cost_usd`、`permission_denials`、`capabilities[]`；(2) Agent SDK（TS `@anthropic-ai/claude-agent-sdk` v0.3.191↔CC v2.1.191，Python `claude-agent-sdk` 0.2.140+）以子进程 + stdio 驱动捆绑的 CLI，暴露 `query()/ClaudeSDKClient` 与 `allowedTools/permissionMode/canUseTool/hooks/mcpServers/systemPrompt/settingSources/agents/resume/forkSession/sessionId/sessionStore/maxTurns/maxBudgetUsd/cwd/sandbox` 等选项；(3) ACP 适配器 `@agentclientprotocol/claude-agent-acp`（原 zed-industries/claude-code-acp）；(4) 托管形态 Claude Code on the web / Routines / Slack(Claude Tag)，以及独立产品 Managed Agents（REST `/v1/agents|environments|sessions|events`，SSE 事件流）。

会话以 UUID 标识，转录为 `~/.claude/projects/<project>/<id>.jsonl`（官方声明格式内部不稳定，多租户宿主应使用 `CLAUDE_CONFIG_DIR`+`CLAUDE_CODE_PROJECT_DIR_NAME` 隔离目录而非解析文件）；续接靠 `--resume/--continue/--fork-session/--session-id`。权限模型 = 6 种模式（`default/acceptEdits/plan/auto/dontAsk/bypassPermissions`）+ `allow/deny/ask` 规则 + 30 余种 hook 事件（exit 2 阻断、`permissionDecision`、`updatedInput`）+ 管理设置 + Seatbelt/bubblewrap 沙箱。扩展资产：CLAUDE.md/rules、skills、commands、subagents(Markdown+YAML)、plugins、MCP、workflows(JS)；自动记忆为 `memory/MEMORY.md` 索引 + 主题文件。多 agent：子代理与 dynamic workflows（`agent/parallel/pipeline`）在 `-p`/SDK 下可用，Agent Teams 仅交互模式可用。可观测性：stream-json 逐消息事件 + OTel（`claude_code.*` 指标与事件，`app.entrypoint` 区分入口）。

对网关的建议：以 `claude -p --bare` stream-json 子进程为主接入面（语言无关、强隔离、能力可协商），TS/Python 网关可改用 SDK 进程内以获得 `canUseTool`/进程内 MCP/`sessionStore`；Managed Agents 作为第二种 Claude 引擎实现验证抽象；ACP 仅作兼容路径。公共能力（会话、工具白名单、权限模式、MCP、系统提示、成本、事件）可归一，Claude 特有扩展（hooks 粒度、dynamic workflow、agent teams、plugins、分类器 auto 模式、文件检查点）需以能力标签 + 参数集形式暴露。

## 关键事实（表格）

| # | 事实 | 来源 | 置信度 | 交叉验证 |
|---|------|------|--------|----------|
| 1 | `claude -p` 支持 `--output-format text/json/stream-json`，stream-json 每行一个 JSON 事件，首事件为 `system/init`（含 model、tools、mcp_servers、plugins、`capabilities[]`），末事件为 `result`（含 result、`session_id`、`total_cost_usd`、usage、`permission_denials`、`structured_output`） | https://code.claude.com/docs/en/headless | 高 | [已交叉验证] TS SDK 参考页 SDKResultMessage 字段一致 |
| 2 | 会话续接：`--continue`（最近会话）、`--resume <id或name>`（任意目录可按 ID 查找，v2.1.223+）、`--fork-session`（复制成新 session id）、`--session-id`（SDK 侧 `sessionId`/`session_id` 指定 UUID）；`-p`/SDK 会话不进入交互式 picker 但可 `--resume <id>` | https://code.claude.com/docs/en/sessions ; headless | 高 | [已交叉验证] sessions 页 + headless 页 + Python SDK 字段 `resume/fork_session/continue_conversation/session_id` |
| 3 | 转录存储：`~/.claude/projects/<project>/<session-id>.jsonl`，`<project>` 为 cwd 路径非字母数字替换为 `-`；官方明确"格式内部、随版本变化、勿直接解析"；可用 `CLAUDE_CONFIG_DIR` + `CLAUDE_CODE_PROJECT_DIR_NAME`（v2.1.234+）为多租户宿主指定目录 | https://code.claude.com/docs/en/sessions | 高 | [已交叉验证] 第三方分析文章（liambx、claude-dev.tools）字段 `uuid/parentUuid/isSidechain/sessionId/cwd/gitBranch` |
| 4 | Hooks 事件多达 30+（PreToolUse/PostToolUse/PostToolUseFailure/PostToolBatch/PermissionRequest/PermissionDenied/UserPromptSubmit/Stop/SubagentStart/SubagentStop/SessionStart/SessionEnd/PreCompact/PostCompact/Notification/TeammateIdle/TaskCreated/TaskCompleted/Elicitation/InstructionsLoaded/ConfigChange/PreModelSwitch/…）；hook 类型 `command/http/mcp_tool/prompt/agent`；exit 2 阻断；JSON 输出 `hookSpecificOutput.permissionDecision allow/deny/ask`、`updatedInput`、`additionalContext`、`decision/stopReason` | https://code.claude.com/docs/en/hooks | 高 | [已交叉验证] hooks 输入 `transcript_path` 在 sessions 页亦提及；SDK Options.hooks 字段存在 |
| 5 | 权限模式：`default`(Manual)/`acceptEdits`/`plan`/`auto`(分类器)/`dontAsk`/`bypassPermissions`；`-p` 起始模式为 Manual；`--permission-prompts none`（v2.1.259+）用于无人值守；管理员可用 `permissions.disableBypassPermissionsMode: "disable"` 禁用 bypass；deny 规则在所有模式含 bypass 下生效 | https://code.claude.com/docs/en/permission-modes ; headless | 高 | [已交叉验证] hooks 页 `permission_mode` 枚举、sub-agents 页 `permissionMode` 枚举一致 |
| 6 | Agent SDK：TS `@anthropic-ai/claude-agent-sdk`（v0.3.191 捆绑 Claude Code v2.1.191，通过 `@anthropic-ai/claude-agent-sdk-<platform>` 原生二进制），Python `claude-agent-sdk`（0.2.140+），均以子进程 + stdio 传输方式驱动 CLI；Python 可自定义 `Transport` | https://code.claude.com/docs/en/agent-sdk/typescript ; /python | 中-高 | [已交叉验证] 两份 SDK 参考页字段互相对应 |
| 7 | SDK Options 关键字段：`allowedTools/disallowedTools/tools`、`permissionMode`、`canUseTool`、`hooks`、`mcpServers`、`systemPrompt`(string 或 `{type:'preset',preset:'claude_code',append}`)、`settingSources ['user','project','local']`、`agents`、`resume/forkSession/continue/sessionId/persistSession/sessionStore`、`maxTurns/maxBudgetUsd`、`cwd/env/additionalDirectories`、`sandbox`、`plugins`、`outputFormat(json_schema)`、`includePartialMessages`、`forwardSubagentText`、`effort/thinking/model/fallbackModel` | 同上 | 高 | [已交叉验证] |
| 8 | 子代理定义为 Markdown+YAML frontmatter（`name/description/tools/disallowedTools/model/permissionMode/maxTurns/skills/mcpServers/hooks/memory/background/isolation: worktree/effort`），位置 `.claude/agents/`、`~/.claude/agents/`、plugin `agents/`、`--agents <json>`；stream-json 中子代理消息带 `parent_tool_use_id` | https://code.claude.com/docs/en/sub-agents ; headless | 高 | [已交叉验证] |
| 9 | Agent Teams 实验特性：`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`；lead + teammates + 共享任务列表 + 邮箱（`~/.claude/teams/{team}/inboxes/{agent}.json`、`~/.claude/tasks/{team}/`）；**在 `-p`/SDK 非交互模式下不会生成 teammate**（退化为普通子代理）；无法跨 session 恢复 in-process teammate | https://code.claude.com/docs/en/agent-teams | 高 | [已交叉验证] 第三方指南（alexop.dev 等）与 hooks 页 `TeammateIdle/TaskCreated/TaskCompleted` |
| 10 | Dynamic workflows：Claude 编写 JS 脚本，原语 `agent()/parallel()/pipeline()/phase()/log()`，`args` 全局；保存于 `.claude/workflows/`、`~/.claude/workflows/`、plugin `workflows/`；`ultracode` = xhigh effort + 自动 workflow；**在 `-p`/SDK 中可用**，需以 `Workflow`/`Workflow(<name>)` allow 规则或 canUseTool 放行；限制 16 并发 agent、1000 agent/run、4096 项/parallel；`disableWorkflows`/`CLAUDE_CODE_DISABLE_WORKFLOWS=1` | https://code.claude.com/docs/en/workflows | 高 | [已交叉验证] InfoQ 2026-06 报道与 claude.com 博客 |
| 11 | OTel：`CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_METRICS_EXPORTER/OTEL_LOGS_EXPORTER/OTEL_TRACES_EXPORTER(beta)`；指标 `claude_code.session.count/cost.usage/token.usage/lines_of_code.count/commit.count/pull_request.count/active_time.total/code_edit_tool.decision`；事件 `claude_code.user_prompt/assistant_response/tool_result/api_request/api_error/api_refusal/tool_decision/permission_mode_changed/auth/mcp_server_connection`；`app.entrypoint` 属性区分 `cli/sdk-cli/sdk-ts/sdk-py` | https://code.claude.com/docs/en/monitoring-usage | 高 | 单一来源（官方），第三方博客间接印证 |
| 12 | 自动记忆：`~/.claude/projects/<project>/memory/MEMORY.md` 索引（首 200 行/25KB 载入）+ 主题文件，frontmatter `type: user/feedback/project/reference`、`modified`；`autoMemoryEnabled`/`autoMemoryDirectory`/`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`；子代理 `memory: user/project/local` 分目录 | https://code.claude.com/docs/en/memory ; sub-agents | 高 | [已交叉验证] 第三方（claudefa.st、memoryplugin）一致 |
| 13 | ACP 适配器：`@zed-industries/claude-code-acp` 已更名为 `@agentclientprotocol/claude-agent-acp`（仓库 zed-industries/claude-agent-acp），基于 Claude Agent SDK 实现 ACP agent，支持 MCP 透传、slash commands、权限扩展、子代理会话、goal 扩展 | https://github.com/zed-industries/claude-agent-acp ; npm | 高 | [已交叉验证] npm 页面 + README |
| 14 | Managed Agents（公测 2026-04-08）：REST `/v1/agents`、`/v1/environments`、`/v1/sessions`、`/v1/sessions/{id}/events`（POST 发送、GET 轮询、`/events/stream` SSE）、`/v1/vaults`、`/v1/memory_stores`；beta 头 `anthropic-beta: managed-agents-2026-04-01`；事件 `user.message/agent.message/agent.tool_use/user.custom_tool_result`；按 session-hours 计费；与 Agent SDK 是独立产品 | anthropics/skills managed-agents-api-reference.md ; agent-sdk/overview | 高 | [已交叉验证] |
| 15 | Claude Code in Slack：@Claude 触发 claude.ai/code 云 session，线程内消息作为上下文；Team/Enterprise 正迁移到 Claude Tag（组织共享身份 + 组织共享环境）；仅频道可用，不支持 DM | https://code.claude.com/docs/en/slack | 高 | 单一官方来源 + claude.com 博客 |
| 16 | `--bare` 模式跳过 hooks/skills/plugins/MCP/auto memory/CLAUDE.md 自动发现，被推荐为脚本/SDK 调用模式，未来将成 `-p` 默认；bare 模式不读 OAuth，需 `ANTHROPIC_API_KEY` | https://code.claude.com/docs/en/headless | 高 | 单一来源 |

## 架构与工作原理

Claude Code 本体是一个 Node/Bun 打包的 CLI 进程（"harness"），内部包含：agent loop（模型调用 → tool_use → 工具执行 → 回填）、上下文管理（自动 compaction、CLAUDE.md/rules/skills 注入）、权限引擎（modes + allow/deny/ask 规则 + hooks + 可选分类器）、会话持久化（JSONL 转录）、扩展加载器（skills/commands/agents/plugins/MCP）、以及多 agent 运行时（Agent 工具、Agent Teams、Workflow 运行时）。

对外暴露的接入层次（由低到高）：

1. **CLI 非交互模式** `claude -p`：stdin/stdout 上的 NDJSON 协议（`--input-format stream-json` / `--output-format stream-json`），是所有上层 SDK 的底层传输。（来源：headless 页）
2. **Agent SDK**（TS/Python）：把 CLI 作为子进程拉起并通过 stdio 传输 NDJSON，向应用暴露 `query()`/`ClaudeSDKClient` 及类型化消息；SDK 包中**捆绑**了对应版本的 Claude Code 二进制（TS v0.3.191 ↔ CC v2.1.191）。Python 允许自定义 `Transport`（可用于远程/容器化传输）。（来源：TS/Python 参考页）
3. **ACP 适配器**：`claude-agent-acp` 用 Agent SDK 实现 Agent Client Protocol 的 agent 端，供 Zed 等 ACP 客户端（含 JetBrains、任何 ACP client）接入。
4. **托管形态**：Claude Code on the web（云 session + 云环境）、Routines（定时触发的云 session）、Claude in Slack / Claude Tag（Slack 线程 → 云 session）；以及独立产品 **Managed Agents**（REST API，Anthropic 托管沙箱与 session 状态）。

官方在 agent-sdk/overview 中明确定位：Agent SDK = "在你自己的进程内运行 agent loop 的库"；Managed Agents = "托管 REST API，Anthropic 运行 agent 与沙箱"，两者是独立产品。

## 可编程接入面

### 1. 无头模式 stream-json 协议（一手：headless 页 + SDK 参考）

```bash
claude -p "Explain recursion" --output-format stream-json --verbose --include-partial-messages
# 双向流式：
claude -p --input-format stream-json --output-format stream-json --verbose
```

输出事件（每行一个 JSON，`type` 判别）：
- `system` / `subtype: init`：session 元数据，字段含 `session_id`、`model`、`tools`、`mcp_servers[{name,status}]`、`mcp_server_errors[]`（v2.1.219+）、`plugins[{name,path}]`、`plugin_errors[]`、`capabilities[]`（v2.1.205+，如 `interrupt_receipt_v1`、`interrupt_cancel_queued_v1`，**官方建议用它做 feature-detect 而非比较版本号**）。init 之前可能先有 `system/plugin_install`、`hook_started/hook_progress/hook_response`（SessionStart/Setup hook 运行期间）。
- `system` / `subtype: api_retry`：`attempt/max_retries/retry_delay_ms/error_status/error(枚举: authentication_failed|rate_limit|overloaded|billing_error|…)/uuid/session_id`。
- `system` / `subtype: permission_denied`：在 `--permission-prompts none` 时出现。
- `assistant`：Anthropic Messages 格式的 assistant 消息（`message.content[]` 含 text/thinking/tool_use）；`parent_tool_use_id` 为 null 表示主线程，非 null 表示来自子代理（该值为派生它的 Agent 工具调用 ID，可重建嵌套树）。默认仅转发子代理 tool_use/tool_result，`--forward-subagent-text` 或 `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`（v2.1.211+）转发文本/thinking。
- `user`：tool_result 回填消息，同样带 `parent_tool_use_id`。
- `stream_event`（需 `--include-partial-messages`）：原始 API 流事件，`event.delta.type == "text_delta"` 等。
- `result`：`subtype: success | error_max_turns | …`，字段 `result`、`session_id`、`total_cost_usd`、`usage{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`、`num_turns`、`structured_output`（配 `--json-schema`）、`permission_denials[]`、per-model 成本分解。
- 另有 SDK 层可见的 `task_progress`、`hook_*`、`prompt_suggestion` 等辅助消息（TS 参考页）。

输入（`--input-format stream-json`，即 SDK "streaming input mode"）每行：
```json
{"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null,"session_id":"..."}
```
content 可为 Anthropic 内容块数组（text/image base64）。SDK 参考页提到 `SDKUserMessage.origin`（`{kind:"human"}` 时才允许 `ultracode` 关键词触发 workflow），说明输入消息还带 origin 元数据（中置信度）。

控制面（SDK 内部走同一 stdio 通道的 control_request/control_response：interrupt、set_permission_mode、set_model、can_use_tool 回调、hook_callback、mcp 状态等）——从 SDK 暴露方法（`interrupt()`, `setPermissionMode()`, `setModel()`, `mcpServerStatus()`, `supportedCommands()`, `rewindFiles()`, `accountInfo()`, `streamInput()`, Python `get_server_info/reconnect_mcp_server/toggle_mcp_server/stop_task`）可推断其存在；**具体 wire 字段名未在公开文档页列出，属推测，需读 SDK 源码确认**。

权限交互（无头）：三条路径——
- `--allowedTools "Bash(git diff *),Read"` + `--permission-mode acceptEdits|auto|dontAsk|bypassPermissions`；
- `--permission-prompt-tool <mcp_tool>`：把权限提示转交给一个 MCP 工具（宿主实现），SDK 中对应 `canUseTool` 回调 / `permissionPromptToolName`；
- `PermissionRequest` / `PreToolUse` hook 返回 allow/deny。
- `--permission-prompts none`（v2.1.259+）：无人值守时不等待宿主，直接拒绝并告知模型勿重试，同时移除 `AskUserQuestion` 等需人交互工具。

其他要点：`--bare`（跳过自动发现，未来 `-p` 默认）；stdin 上限 10MB；SIGTERM → 退出码 143 并运行 SessionEnd hook，未完成 turn 可在 resume 时继续；后台子代理/工作流等待上限 `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`（默认 10 分钟）；`--no-session-persistence` 不落盘；`--json-schema` 结构化输出；斜杠命令可内嵌在 prompt 中（`/skill-name`, `/model sonnet`, `/config key=value`）。

### 2. Agent SDK（TS/Python）

- 安装：`npm install @anthropic-ai/claude-agent-sdk` / `pip install claude-agent-sdk`。SDK 捆绑 CLI，无需单独安装（TS 参考页），Python 也自带并以 `SubprocessTransport` 启动（Python 页）。
- 入口：TS `query({prompt, options})` 返回 `Query`（AsyncGenerator<SDKMessage> + 控制方法）；Python `query()`（单发）与 `ClaudeSDKClient`（长连接，`connect/query/receive_messages/receive_response/interrupt/set_permission_mode/set_model/rewind_files/get_mcp_status/...`）。
- 关键 Options（TS 命名 / Python 命名）：
  - 工具与权限：`allowedTools/allowed_tools`、`disallowedTools`、`tools`（列表或预设）、`permissionMode`、`canUseTool/can_use_tool`（返回 `{behavior:"allow", updatedInput, updatedPermissions}` 或 `{behavior:"deny", message, interrupt}`）、`permissionPromptToolName`、`allowDangerouslySkipPermissions`。
  - 提示词：`systemPrompt` 为字符串（完全替换）或 `{type:'preset', preset:'claude_code', append:'…'}`（保留默认再追加），Python 另有 `SystemPromptFile`。`planModeInstructions`。
  - 配置装载：`settingSources: ['user','project','local']`（默认不加载文件系统设置，需显式声明，这是 SDK 与 CLI 的重要差异）、`settings`（内联或路径）、`managedSettings`、`plugins: [{type:'local', path}]`、`skills`、`agents: {name: AgentDefinition}`、`agent`（会话级默认 agent）、`mcpServers`（stdio/sse/http 或进程内 `create_sdk_mcp_server`/`createSdkMcpServer` + `@tool`）、`strictMcpConfig`、`additionalDirectories/add_dirs`。
  - 会话：`continue`、`resume`、`resumeSessionAt`、`forkSession`、`sessionId`、`persistSession`、`sessionStore` + `sessionStoreFlush: 'batched'|'eager'`（**外部会话存储接口**，可把转录写到自有存储——对网关极有价值，需读源码确认接口形态）。
  - 运行：`cwd`、`env`、`model/fallbackModel`、`effort`、`thinking`、`maxTurns`、`maxBudgetUsd`、`taskBudget`、`sandbox: SandboxSettings`、`enableFileCheckpointing`、`betas`、`outputFormat: {type:'json_schema', schema}`、`includePartialMessages`、`forwardSubagentText`、`includeHookEvents`、`hooks: {PreToolUse:[{matcher, hooks:[callback]}]}`（进程内回调，无需 shell）、`onElicitation`、`stderr`、`extraArgs`、`pathToClaudeCodeExecutable/cli_path`、`spawnClaudeCodeProcess`（自定义拉起方式）。
- SDK 授权约束：官方注明第三方产品不得复用 claude.ai 登录/订阅额度，必须走 API key（或 Bedrock/Vertex/Foundry）。
- V2 API（`unstable_v2` createSession/resumeSession/send/stream）：搜索结果未获一手确认，本文不做断言。

### 3. ACP 适配器
`zed-industries/claude-agent-acp`（npm `@agentclientprotocol/claude-agent-acp`，旧名 `@zed-industries/claude-code-acp` 已弃用）基于 Agent SDK 实现 ACP agent：支持上下文 @mention、图片、工具调用权限流、编辑审阅、终端、自定义斜杠命令、客户端 MCP 透传、`goal` 扩展、session failure 扩展、权限扩展、子代理会话（能力协商）。ACP 本身定义 `new_session/load_session/resume_session/close_session/prompt/cancel/set_session_mode`（Zed DeepWiki）。适合"编辑器/IDE 型客户端"接入，而非服务端多租户网关。

### 4. Managed Agents（服务端 API）
资源模型 Agent → Environment → Session → Events：`POST /v1/sessions {agent, environment_id, title?, resources?, vault_ids?, budget?, metadata?}`；`POST /v1/sessions/{id}/events {"events":[{"type":"user.message","content":[{"type":"text","text":"..."}]}]}`；`GET /v1/sessions/{id}/events`（轮询）或 `/events/stream`（SSE）；事件 `agent.message`、`agent.tool_use`（自定义工具需 `user.custom_tool_result` 回复）、`session.status_*`（推测名，未逐一确认）。Agent 配置含 model、system、tools（`agent_toolset_20260401`）、mcp_servers；`archive` 不可逆；限速 300 RPM 创建 / 600 RPM 其他。按 session-hours 计费。**它不是 Claude Code CLI 的 API**，而是一个独立托管 harness——与 Claude Code 共享模型与工具理念但配置/事件格式不同。

## 会话模型

- **标识**：每个会话一个 UUID `session_id`，在 `system/init` 与 `result` 中返回；可用 `--session-id`（SDK `sessionId`）预先指定 UUID（便于网关把业务键→session 做确定性映射，中置信度：字段存在于 SDK，CLI flag 名由 SDK `extraArgs` 推断）。
- **存储**：`~/.claude/projects/<project>/<session-id>.jsonl`，append-only，每行含 `type(user|assistant|system|summary…)`、`uuid`、`parentUuid`、`isSidechain`、`sessionId`、`cwd`、`gitBranch`、`timestamp`、`message{role,content,usage}`（第三方逆向）；子代理转录在 `subagents/agent-<id>.jsonl`（`isSidechain: true`）；workflow 运行脚本与结果也写在该 session 目录下；自动记忆在 `<project>/memory/`。
- **可移植性**：官方明确"格式内部、随版本变化"，官方导出仅 `/export`（人读文本）。`--resume <id>` 在 v2.1.223+ 跨项目查找，但"手工复制的重复转录"会导致查找失败（要求唯一匹配）。多租户宿主的官方推荐做法：`CLAUDE_CONFIG_DIR=/srv/tenant-a CLAUDE_CODE_PROJECT_DIR_NAME=work`（v2.1.234+），每租户/每业务一个 config dir，转录与记忆都隔离；SDK 侧还有 `sessionStore` 外部存储接口（形态待源码确认）。**结论：可迁移（整目录搬迁 + 相同版本），不建议解析/改写 JSONL；应把网关自己的会话元数据存在网关侧，转录目录当作黑盒卷。**
- **续接语义**：`--continue`（同目录最近会话，跳过后台会话）、`--resume <id|name>`、`--fork-session`（新 ID、复制历史，"Allow for this session" 授权不带入新进程）、`/branch`（进程内分叉）。resume 恢复：完整历史、模型、`--agent`、权限模式（`-p` 下不恢复，除 plan 模式在 4 条件下）、goal、未过期 scheduled tasks；**不恢复** `--mcp-config/--settings/--plugin-dir/--add-dir`（需再传）。两处同时 resume 同一 ID 不 fork 会交错写入同一转录（并发风险）。
- **保留**：`cleanupPeriodDays`（默认 30 天）；`--no-session-persistence`/`CLAUDE_CODE_SKIP_PROMPT_HISTORY` 禁写。
- **压缩**：`/compact`、自动 compaction、PreCompact/PostCompact hook；Pro/Max 长时间闲置且 >100k tokens 的 resume 提供"从摘要恢复"。
- **命名**：`-n <name>`/`/rename`，名称可作 resume 句柄；`-p` 会话名不做重名检查。
- **托管形态**：Claude Code on the web 会话在云端环境中，CLI 可 `claude --cloud <session-id> -p "msg"` 向云 session 排队消息；Slack 中"一个 @Claude 请求 → 一个新云 session"，线程消息作为上下文输入，之后通过"View Session"在网页继续——**Slack 集成本身是按请求建 session，而非按线程持久映射**（官方 session flow 步骤 3 "A new Claude Code session is created"）；Claude Tag 为组织身份 + 按频道配置环境。Routines = 保存的 prompt+repo+connectors 配置，按 cron/一次性触发新云 session。Managed Agents 则由调用方显式管理 session 生命周期（创建/发事件/归档），是最接近"网关自持 session 映射"的官方托管形态。

## 权限与安全

- **模式**：`default`(Manual：仅读)、`acceptEdits`(读+编辑+常见 fs 命令)、`plan`(只读探索，auto 可用时命令走分类器)、`auto`(分类器审查，Pro/Max/Team 交互默认)、`dontAsk`(仅预批准工具，其余拒绝，CI 首选)、`bypassPermissions`(全部放行，仅限隔离容器；`--dangerously-skip-permissions`)。`-p` 起始为 Manual。
- **规则**：`permissions.allow/deny/ask`，语法 `Tool(pattern)`，如 `Bash(git diff *)`、`Edit(*.ts)`、`Read(...)`、`Agent(Explore)`、`Workflow(<name>)`、`mcp__server__tool`。deny 在所有模式（含 bypass）生效；任何模式都不自动批准：显式 ask 规则、`AskUserQuestion`、`requiresUserInteraction` 的 MCP 工具、关键路径的 `rm`、`blockReadsOutsideWorkingDirectories` 下的越界读。
- **管理设置**：`managed-settings.json`（macOS `/Library/Application Support/ClaudeCode/`、Linux `/etc/claude-code/`）与服务端托管设置；键如 `permissions.disableBypassPermissionsMode: "disable"`、`allowManagedPermissionRulesOnly`（搜索命中，未展开确认）、`sandbox.enabled`、`env`、`forceLoginMethod/forceLoginOrgUUID`、`claudeMd`、`disableWorkflows`、`availableModels`。管理设置可锁定 OTel 变量。
- **沙箱**：内建 Bash 沙箱（macOS Seatbelt / Linux+WSL2 bubblewrap+socat），`/sandbox` 选择 auto-allow 或 regular 模式；仅约束 Bash 及子进程，内建文件工具/MCP/hooks 仍在宿主运行；更外层可用 `@anthropic-ai/sandbox-runtime`（srt）包裹整个 Claude Code 进程，或容器/VM。SDK `sandbox: SandboxSettings`（`enabled`、`timeout` 等，细项未逐一确认）。设置键 `sandbox.enabled/autoAllowBashIfSandboxed/allowUnsandboxedCommands/network.allowedDomains`（第三方指南提及，官方页未逐字验证，中置信度）。
- **信任边界**：`-p` 无 workspace trust 对话框，会直接运行项目 `.claude/settings.json` hooks 与 `.mcp.json`（除 `--bare`）——网关拉起时应固定 `--bare` + 显式传入 `--settings/--mcp-config/--plugin-dir/--agents`，避免被仓库内容注入。Agent 间消息（SendMessage/teammates/cross-session）被明确标记为"来自其他 Claude 会话"，不能代用户批准权限。
- **子代理权限**：frontmatter `permissionMode`；teammates 继承 lead 模式，权限提示冒泡到 lead。

## 扩展机制与资产

| 资产 | 格式/位置 | 加载方式 | 备注 |
|------|-----------|----------|------|
| CLAUDE.md | Markdown；managed(`/etc/claude-code/CLAUDE.md` 等)、`~/.claude/CLAUDE.md`、`./CLAUDE.md` 或 `./.claude/CLAUDE.md`、`CLAUDE.local.md`；`@path` 导入（≤4 跳）；HTML 注释剥离 | 启动时加载 cwd 及以上目录，子目录按需；作为 system prompt 之后的 user message 注入；`claudeMdExcludes` 排除；managed `claudeMd` 键可内联 | 支持 `@AGENTS.md` 导入以兼容其它 agent；`/import` 可迁移其它 agent 配置（v2.1.213+） |
| Rules | `.claude/rules/*.md`、`~/.claude/rules/`；frontmatter `paths: [...]` glob 条件加载 | 无 paths 的启动加载，有 paths 的读到匹配文件时加载 | `InstructionsLoaded` hook 可审计 |
| Skills | `.claude/skills/<name>/SKILL.md`（frontmatter 可含 hooks、`once`）；用户级 `~/.claude/skills/`；`--add-dir` 目录的 skills 在 bare 模式仍加载 | 模型按 description 自动触发或 `/name` 调用；`-p` 中 `/skill` 会被展开 | 内置 skill 如 `/workflow-authoring`、`/deep-research` |
| Commands | `.claude/commands/*.md`（旧式斜杠命令） | `/name` 展开；`UserPromptExpansion` hook 可拦截 | bare 模式跳过 |
| Subagents | `.claude/agents/*.md`、`~/.claude/agents/`、plugin `agents/`、`--agents <json>`、SDK `agents` | Agent 工具 `subagent_type`；`@agent-name` 强制委派；`--agent` 设为会话默认 | 见上文 frontmatter 字段 |
| Workflows | `.claude/workflows/*.js`、`~/.claude/workflows/`、plugin `workflows/`；`export const meta = {name, description, phases?}` + 顶层 await 脚本 | `/name`，`args` 全局传参；`/reload-skills` 热加载 | 脚本禁 `import()`、`Date.now()/Math.random()`（保证可重放） |
| Plugins | 目录含 `plugin.json` manifest + `skills/ agents/ commands/ hooks/hooks.json workflows/ .mcp.json`；`--plugin-dir <path>`、`--plugin-url <url>`、marketplace 安装；SDK `plugins:[{type:'local',path}]` | 命名空间 `plugin:skill`、`mcp__plugin_<plugin>_<server>__<tool>`；`${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}` | `system/init.plugins/plugin_errors` 可做加载校验；`CLAUDE_CODE_SYNC_PLUGIN_INSTALL` 触发 `plugin_install` 事件 |
| MCP | `.mcp.json`（项目）、用户/本地 scope、`--mcp-config <file-or-json>`、`--strict-mcp-config`、SDK `mcpServers`（含进程内 `createSdkMcpServer`）；传输 stdio/sse/http | 工具名 `mcp__<server>__<tool>`；`MCP_TIMEOUT` 默认 30s；elicitation 走 `Elicitation` hook / SDK `onElicitation` | `system/init.mcp_servers[].status`（含 `pending`） |
| Hooks | settings.json 各层、plugin hooks.json、skill/agent frontmatter、SDK 进程内回调 | 事件→matcher→handler 三层；类型 command/http/mcp_tool/prompt/agent | 详见"关键事实 #4" |
| Settings | `~/.claude/settings.json` < `.claude/settings.json` < `.claude/settings.local.json` < `--settings` < managed；SDK 默认 **不** 读取任何文件（`settingSources` 需显式） | `ConfigChange` hook；`disableAllHooks`；`env` 块可注入环境变量 | 网关可用 `--settings '<json>'` 完全内联 |

## 记忆

- **CLAUDE.md（人写）** 与 **自动记忆（Claude 写）** 双系统，均在每次会话开始载入。
- 自动记忆目录 `~/.claude/projects/<project>/memory/`（按 git 仓库归一，worktree 共享；非 git 用项目根）：`MEMORY.md` 索引（一条一行，前 200 行/25KB 载入，超限报错要求重写）+ 主题文件（`user_role.md`、`feedback_testing.md` …，按需读取）；frontmatter `type: user|feedback|project|reference`、`modified`（ISO 8601，v2.1.214+）。不随 `cleanupPeriodDays` 清理；机器本地、不同步云端。
- 开关：`autoMemoryEnabled`（用户/项目 settings）、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`、`autoMemoryDirectory`（任意 settings 层，绝对路径或 `~/`）；`--bare` 不加载。
- 子代理不继承主会话自动记忆（fork 除外）；`memory: user|project|local` 让子代理拥有独立目录（`~/.claude/agent-memory/<name>/`、`.claude/agent-memory/<name>/`、`.claude/agent-memory-local/<name>/`）。
- 与网关的关系：记忆是纯 Markdown 文件，可由网关注入/导出/审阅；多租户下用 `CLAUDE_CONFIG_DIR`+`CLAUDE_CODE_PROJECT_DIR_NAME` 或 `autoMemoryDirectory` 做"业务实体（群）→记忆目录"映射。Managed Agents 另有服务端 `memory_stores` 资源（不同模型）。

## 多 Agent 与协作

| 机制 | 谁持有计划 | 中间结果位置 | 规模 | 非交互(-p/SDK)可用性 | 网关接入参数 |
|------|-----------|--------------|------|----------------------|--------------|
| Subagents（Agent 工具） | 主 Claude 逐轮决定 | 主上下文 | 每轮几个；并发默认 20（`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`）、嵌套深度 3（`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`） | 可用；stream-json 中以 `parent_tool_use_id` 区分 | `--agents/agents`、`Agent(<name>)` allow 规则、`--forward-subagent-text` |
| 命名子代理 + SendMessage | 主 Claude | 各自上下文 | 少量 | 可用 | 无特殊参数 |
| Agent Teams（实验） | lead 逐轮 | 共享任务列表 `~/.claude/tasks/`、邮箱 `~/.claude/teams/*/inboxes/*.json` | 3-5 个长活 teammate | **不可用**（`-p`/SDK 下命名子代理退化为普通子代理） | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`、`teammateMode: in-process|tmux|iterm2|auto`、hooks `TeammateIdle/TaskCreated/TaskCompleted` |
| Dynamic Workflows | 脚本 | 脚本变量 | 数十至数百（16 并发、1000/run） | **可用**（无审批提示，走权限评估：`Workflow` allow 规则 / canUseTool / auto / bypass） | `ultracode` 关键词（仅 origin=human）、`--effort ultracode`、`workflowSizeGuideline: small|medium|large|unrestricted`、`disableWorkflows`、`CLAUDE_CODE_DISABLE_WORKFLOWS`、`CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS`、`subagentPromptCacheTtl` |
| Cross-session messaging / Remote Control / agent view | 用户 | — | — | 部分 | `claude agents --json` 列运行中会话 |

Workflow 脚本原语：`agent(prompt, {schema, label, model?, ...})` → 结果或 `null`；`parallel([...])`；`pipeline(items, fn)`（≤4096 项）；`phase(title)`；`log()`；`args`。运行可暂停/恢复/重放（按 agent 启动顺序缓存结果），脚本文件写在 session 目录下。Workflow 运行时对上游可观测：`/workflows` TUI、task panel、SDK `task_progress` 消息（中置信度）。

## 可观测性

- **结构化事件流**：stream-json 本身即最细粒度的逐消息事件（含 usage、cost、tool_use/tool_result、api_retry、permission_denied、hook 事件、subagent 归属）。这是网关归一化的首选数据源，且随 SDK 类型化。
- **OpenTelemetry**：`CLAUDE_CODE_ENABLE_TELEMETRY=1`；exporters `OTEL_METRICS_EXPORTER=otlp|prometheus|console`、`OTEL_LOGS_EXPORTER=otlp|console`、`OTEL_TRACES_EXPORTER`（beta，需 `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`）；`OTEL_EXPORTER_OTLP_PROTOCOL=grpc|http/json|http/protobuf`、`_ENDPOINT`、`_HEADERS`、per-signal 覆盖、mTLS；内容开关 `OTEL_LOG_USER_PROMPTS/OTEL_LOG_ASSISTANT_RESPONSES/OTEL_LOG_TOOL_DETAILS/OTEL_LOG_TOOL_CONTENT/OTEL_LOG_RAW_API_BODIES(=1|file:<dir>)`；导出间隔 `OTEL_METRIC_EXPORT_INTERVAL`(60000ms)/`OTEL_LOGS_EXPORT_INTERVAL`(5000ms)；属性开关 `OTEL_METRICS_INCLUDE_SESSION_ID/ACCOUNT_UUID/VERSION/ENTRYPOINT/RESOURCE_ATTRIBUTES`。
- **指标**：`claude_code.session.count{start_type}`、`lines_of_code.count{type,model}`、`pull_request.count`、`commit.count`、`cost.usage{model,query_source,speed,effort,agent.name,skill.name,plugin.name,mcp_server.name,mcp_tool.name}`、`token.usage{type=input|output|cacheRead|cacheCreation,...}`、`code_edit_tool.decision{tool_name,decision,source,language}`、`active_time.total{type=user|cli}`。
- **事件（logs）**：`claude_code.user_prompt`、`assistant_response`、`tool_result{tool_name,tool_use_id,success,duration_ms,decision_source,...}`、`api_request{model,cost_usd,duration_ms,input_tokens,...,request_id,query_source,effort}`、`api_error`、`api_refusal`、`tool_decision{decision,source,tool_source}`、`permission_mode_changed{from_mode,to_mode,trigger}`、`auth`、`mcp_server_connection`、`api_request_body/api_response_body`。关联属性 `prompt.id`、`message.uuid`、`client_request_id`；资源属性 `session.id`、`app.version`、`app.entrypoint(cli|sdk-cli|sdk-ts|sdk-py|claude-vscode)`、`organization.id`、`user.id/email`、`terminal.type`、`OTEL_RESOURCE_ATTRIBUTES`。
- **成本**：`result.total_cost_usd` 与 per-model 分解为客户端估算；`maxBudgetUsd` 可硬止损；`/cost`。
- **日志/调试**：SDK `debug/debugFile`、`stderr` 回调；hooks 输入 `transcript_path` 可在 `SessionEnd` 归档转录；`InstructionsLoaded`、`ConfigChange` 审计配置加载。
- **托管侧**：Managed Agents 的 events 流是服务端事件总线（`agent.message/agent.tool_use/...`），语义与 stream-json 不同，需单独映射。

## 对我们架构的启示

### 接入面选型（问题 10）

| 接入面 | 优点 | 缺点 | 适用 |
|--------|------|------|------|
| **子进程 `claude -p --input-format stream-json --output-format stream-json`** | 语言无关（网关可用 Go/Java/Rust）；协议 = SDK 底层协议，字段稳定且有 `capabilities[]` 特性检测；`--bare` + 全部内联配置可完全受控；一进程一 session，天然隔离，便于 cgroup/容器限额；`CLAUDE_CONFIG_DIR` 按租户隔离转录与记忆 | 权限回调需 `--permission-prompt-tool`（自建 MCP 工具）或 hooks(http) 间接实现；控制面（interrupt/set_model）wire 格式未公开文档化；进程启动开销（bare 缓解）；需自行做心跳/超时/SIGINT vs SIGTERM 语义 | **推荐为主接入面**：网关本身多语言、需强隔离和可审计 |
| **Agent SDK 进程内（TS/Python）** | 类型化消息、`canUseTool` 进程内回调、`hooks` 进程内回调、进程内 MCP（`createSdkMcpServer`）把网关工具零 IPC 暴露给引擎、`sessionStore` 外部会话存储、`interrupt/setPermissionMode/setModel` 一等方法、`includeHookEvents/forwardSubagentText` | 绑定 Node/Python；SDK 版本与捆绑 CLI 版本强耦合（0.3.191↔2.1.191）；仍是子进程，隔离要自己做；许可条款要求 API key（不能借用 claude.ai 订阅） | 网关用 TS/Python 时的首选；或做成一个"Claude 引擎 sidecar"进程，向网关暴露统一 gRPC/HTTP |
| **ACP（claude-agent-acp）** | 标准协议，同一客户端可切换 Gemini CLI/Codex/opencode 等 ACP agent；权限、模式、MCP 透传已有规范 | 面向编辑器单用户交互（fs/terminal 由 client 提供），服务端多租户语义弱；能力集受 ACP 规范上限，Claude 特有能力（workflows/teams/hooks/记忆）暴露不足；多一层适配延迟 | 若网关已决定以 ACP 为"公共能力协议"，可用它做 Claude 的兼容路径，但特有能力需旁路 |
| **Managed Agents REST** | 无需自管沙箱/进程；session 生命周期显式 API（正是网关想要的 business→session 映射）；SSE 事件流；vault/memory_stores 服务端资源 | 独立产品，非 Claude Code（无 CLAUDE.md/skills/hooks/plugins 生态，工具集 `agent_toolset_20260401`）；按 session-hours 计费；数据在 Anthropic 云；公测 API 变动风险 | 云原生、不想运维沙箱的场景；作为"第二种 Claude 引擎实现"接入以验证网关抽象 |
| Claude Code on the web / Slack / Routines | 现成的 Slack 群助手能力 | 无公开编程 API（仅 `claude --cloud <id> -p` 排队消息）；Slack 按请求建 session，不做线程持久映射 | 参考其 UX，不作为引擎接入面 |

### 公共能力 vs 引擎特有扩展能力（映射表）

| 能力 | 归类 | Claude Code 实现 | 网关接入参数 |
|------|------|------------------|--------------|
| 单轮/多轮对话、流式输出 | 公共 | stream-json `assistant/result/stream_event` | `--output-format stream-json --include-partial-messages` |
| session 创建/续接/分叉 | 公共 | `--session-id`/`--resume`/`--fork-session`/`--continue` | 网关维护 businessKey→session_id；fork 用于"重试/分支" |
| 工作目录/文件隔离 | 公共 | `cwd`、`--add-dir`、`CLAUDE_CONFIG_DIR` | 每群一个 workspace + config dir |
| 工具白/黑名单 | 公共 | `--allowedTools/--disallowedTools`、`permissions.allow/deny/ask` 规则语法 | 网关权限策略→规则字符串 |
| 权限模式 | 公共（枚举需归一） | `default/acceptEdits/plan/auto/dontAsk/bypassPermissions` | 群助手建议 `dontAsk` 或 `auto` + deny 列表 |
| 权限审批回调（人在环） | 公共 | `--permission-prompt-tool`/`canUseTool`/`PermissionRequest` hook | 网关实现审批 MCP 工具，把请求转发到群里让管理员点按钮 |
| 中断/取消 | 公共 | SIGINT / SDK `interrupt()`；`capabilities: interrupt_receipt_v1` | — |
| 系统提示定制 | 公共 | `--system-prompt`/`--append-system-prompt(-file)`、SDK preset+append | 群画像/规则注入 |
| 结构化输出 | 公共 | `--json-schema`/`outputFormat` | — |
| 外部工具（MCP） | 公共 | `--mcp-config`、`mcpServers`（含进程内） | 网关把业务工具作为 MCP server 注入 |
| 指令文件/规则 | 公共（格式各异） | CLAUDE.md、`.claude/rules`、`claudeMd` 管理键；兼容 `@AGENTS.md` | 网关维护统一 AGENTS.md，Claude 侧生成 `CLAUDE.md` 含 `@AGENTS.md` |
| 长期记忆 | 公共（模型各异） | auto memory Markdown 目录、`autoMemoryDirectory` | 网关可挂载/备份该目录，或用 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 改用网关记忆 |
| 成本/用量 | 公共 | `result.usage/total_cost_usd`、`maxBudgetUsd`、OTel `cost.usage` | 每群预算 |
| 事件/可观测 | 公共（需归一） | stream-json + OTel metrics/events + hooks(http) | 网关消费 stream-json 归一为统一事件；OTel 直连采集 |
| 子代理 | 公共（多数引擎有） | `agents` 定义、`Agent()` 规则、`parent_tool_use_id` | — |
| Skills/Commands | 半公共 | `.claude/skills`（SKILL.md 格式已成事实标准） | 网关资产库→挂载目录 |
| Hooks 生命周期拦截 | **Claude 特有**（粒度远超他家） | 30+ 事件、5 种 handler、exit 2 阻断、`updatedInput` 改写 | `--settings '{"hooks":...}'`；http hook 指向网关 |
| Dynamic workflow | **Claude 特有** | Workflow 工具、`agent/parallel/pipeline` 脚本、`ultracode` | `Workflow` allow 规则、`workflowSizeGuideline`、`--effort ultracode` |
| Agent Teams | **Claude 特有且仅交互式** | teammates/邮箱/任务列表 | 网关不可用；若需要需走 tmux 交互会话（不推荐） |
| Plugins/marketplace | **Claude 特有** | `--plugin-dir/--plugin-url`、`plugin_install` 事件 | — |
| 分类器 auto 模式 | Claude 特有 | `--permission-mode auto` | 需账号满足条件 |
| Sandbox | 半公共 | 内建 Bash 沙箱 + `sandbox-runtime` | 建议网关统一容器隔离而不依赖引擎沙箱 |
| 文件检查点/回滚 | Claude 特有 | `enableFileCheckpointing`、`rewindFiles` | — |
| Effort/thinking | 半公共 | `--effort low..max|ultracode`、`thinking` | — |

### 接入 Claude 引擎的最小参数集（建议）

```bash
CLAUDE_CONFIG_DIR=/data/tenants/<group>/claude \
CLAUDE_CODE_PROJECT_DIR_NAME=work \
CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=otlp OTEL_EXPORTER_OTLP_ENDPOINT=http://otel:4318 \
claude -p --bare \
  --session-id <uuid-derived-from-group>   # 首轮；后续 --resume <id>
  --input-format stream-json --output-format stream-json --verbose --include-partial-messages \
  --permission-mode dontAsk --permission-prompts none \
  --allowedTools "Read,Grep,Glob,mcp__gateway__*" \
  --settings '{"permissions":{"deny":["Bash(rm *)"]},"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"http","url":"http://gateway/hooks"}]}]}}' \
  --mcp-config '{"mcpServers":{"gateway":{"type":"http","url":"http://gateway/mcp"}}}' \
  --append-system-prompt-file /data/tenants/<group>/persona.md \
  --max-turns 30 --json-schema '<schema>'   # 可选
```

### 风险与坑
1. 版本漂移快（文档中大量 "v2.1.2xx 起" 语句）：用 `system/init.capabilities[]` 与 `claude --version` 做能力协商，不要硬编码版本。
2. JSONL 转录非稳定格式：不要解析；用 stream-json 副本作为网关自己的权威记录。
3. `-p` 无信任对话框会执行仓库内 hooks/MCP：务必 `--bare`。
4. 同一 session 并发 resume 会交错写转录：网关需对 session 加锁/串行化（群消息队列）。
5. `--continue` 语义依赖 cwd，多租户下只用 `--resume <id>`。
6. Agent Teams 在非交互模式不可用，勿把它列入网关可编排能力。
7. 第三方产品不得复用 claude.ai 登录额度，需 API key/Bedrock/Vertex/Foundry；`--bare` 亦不读 OAuth。
8. Workflows/子代理会显著放大 token 成本，需 `maxBudgetUsd`、`workflowSizeGuideline`、并发上限环境变量。
9. `dontAsk` 下 `AskUserQuestion` 与 `requiresUserInteraction` MCP 工具被拒——群助手想"反问"需网关自定义工具。
10. 后台 Bash 任务在 `-p` 结束后 5 秒被杀；背景子代理等待上限 10 分钟。

## 未解决问题
- stream-json 控制面（control_request/control_response：interrupt、set_permission_mode、can_use_tool、hook_callback）的精确 wire 字段名，需读 `claude-agent-sdk-python` 源码（`_internal/transport`、`query.py`）确认。
- SDK `sessionStore`/`SessionStore` 接口的方法签名与是否可完全替代磁盘 JSONL。
- `--session-id` 作为 CLI flag 的确切名称与"预置 UUID 但转录不存在时"的行为。
- V2 `unstable_v2` API（createSession/send/stream）是否已在当前 SDK 发布。
- Claude Tag 的频道→session 映射策略（是否每线程持久 session）及是否有 API。
- `sandbox` 设置的完整键集合（`network.allowedDomains` 等）与 SDK `SandboxSettings` 字段。
- Managed Agents 事件类型全集（`session.status_idle`、`tool_confirmation` 等仅在搜索摘要出现，未在一手页确认）。
- ACP 适配器对 Claude 特有能力（workflows、hooks、auto memory）的暴露程度。

## 来源列表
- https://code.claude.com/docs/en/headless （无头模式/stream-json/权限/续接）
- https://code.claude.com/docs/en/hooks （Hooks 参考）
- https://code.claude.com/docs/en/monitoring-usage （OpenTelemetry）
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/python
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/permission-modes
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/workflows
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/slack
- https://github.com/zed-industries/claude-agent-acp （README）
- https://www.npmjs.com/package/@zed-industries/claude-code-acp （更名说明）
- https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/managed-agents-api-reference.md
- https://www.infoq.com/news/2026/06/dynamic-workflows-claude-code/ （交叉验证）
- https://claude.com/blog/introducing-dynamic-workflows-in-claude-code （交叉验证）
- https://alexop.dev/posts/from-tasks-to-swarms-agent-teams-in-claude-code/ （交叉验证）
- https://liambx.com/blog/claude-code-log-analysis-with-duckdb 、https://claude-dev.tools/docs/jsonl-format （JSONL 字段，第三方）
- https://claudefa.st/blog/guide/mechanics/auto-memory （交叉验证）
- https://help.apiyi.com/en/anthropic-claude-managed-agents-public-beta-launch-en.html （Managed Agents 发布日期，第三方）
