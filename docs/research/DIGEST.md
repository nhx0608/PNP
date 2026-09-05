# 调研总摘要（DIGEST）

共 33 个专题；有结构化摘要的 26 个；已事实核查的 0 个。

## T01 Claude Code 与 Claude Agent SDK 作为引擎内核
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T01-claude-code-agent-sdk.md

**摘要**：Claude Code 是以 CLI 进程为核心的 harness，提供四层接入面：claude -p 的 stream-json 双向 NDJSON 协议（system/init→assistant/user/stream_event→result，含 session_id、usage、cost、capabilities[]）；Agent SDK（TS v0.3.191 捆绑 CC v2.1.191，Python 0.2.140+）以子进程驱动 CLI，暴露 allowedTools/permissionMode/canUseTool/hooks/mcpServers/systemPrompt/settingSources/agents/resume/forkSession/sessionId/sessionStore/maxBudgetUsd/sandbox 等；ACP 适配器 claude-agent-acp；托管形态（web/Routines/Slack/Claude Tag）与独立产品 Managed Agents REST API。会话为 UUID + ~/.claude/projects/<project>/<id>.jsonl（官方称格式不稳定，多租户用 CLAUDE_CONFIG_DIR+CLAUDE_CODE_PROJECT_DIR_NAME 隔离）。权限=6 模式+allow/deny/ask 规则+30 余 hook 事件+管理设置+沙箱。子代理与 dynamic workflows 在 -p/SDK 可用，Agent Teams 仅交互式。可观测靠 stream-json 与 OTel claude_code.* 指标/事件。建议网关以 claude -p --bare stream-json 子进程为主接入面，Managed Agents 作第二实现，ACP 仅兼容路径。

**接入面**：主接入面：`claude -p --bare --input-format stream-json --output-format stream-json --verbose` 子进程（NDJSON 双向协议，system/init.capabilities[] 做能力协商，--session-id/--resume 做业务→session 映射，CLAUDE_CONFIG_DIR+CLAUDE_CODE_PROJECT_DIR_NAME 做租户隔离，--settings/--mcp-config/--agents/--plugin-dir 全部内联，--permission-prompt-tool 或 http hooks 做审批回调）。备选：Agent SDK 进程内（TS/Python，canUseTool/hooks 回调、进程内 MCP、sessionStore）；Managed Agents REST（/v1/sessions + events SSE）作为第二种 Claude 引擎实现；ACP（claude-agent-acp）仅作兼容路径。

**公共能力**：多轮对话与流式输出（assistant/result/stream_event）；session 创建/续接/分叉（--session-id/--resume/--fork-session/--continue）；工作目录与租户隔离（cwd、--add-dir、CLAUDE_CONFIG_DIR）；工具白/黑名单与权限规则（--allowedTools/--disallowedTools、permissions.allow/deny/ask）；权限模式枚举（default/acceptEdits/plan/auto/dontAsk/bypassPermissions）；人在环权限审批回调（--permission-prompt-tool / canUseTool / PermissionRequest hook）；中断/取消（SIGINT、interrupt()）；系统提示定制（--system-prompt/--append-system-prompt(-file)）；结构化输出（--json-schema / outputFormat）；MCP 外部工具接入（--mcp-config/mcpServers）；指令文件（CLAUDE.md、@AGENTS.md 导入、.claude/rules）；子代理（agents 定义、parent_tool_use_id）；Skills/Commands（SKILL.md）；成本与用量（result.usage/total_cost_usd、maxBudgetUsd）；事件与可观测（stream-json 事件流、OTel 指标/事件、hooks http）；长期记忆（auto memory Markdown 目录）

**扩展能力**：Hooks 生命周期拦截（30+ 事件、command/http/mcp_tool/prompt/agent handler、exit 2 阻断、updatedInput 改写）；Dynamic workflows（Workflow 工具、agent/parallel/pipeline/phase 脚本、ultracode、workflowSizeGuideline、可重放恢复）；Agent Teams（teammates/邮箱/共享任务列表，仅交互模式，CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS）；Plugins/marketplace（--plugin-dir/--plugin-url、plugin_install 事件）；分类器 auto 权限模式；内建 Bash 沙箱（Seatbelt/bubblewrap）与 sandbox-runtime；文件检查点与回滚（enableFileCheckpointing、rewindFiles）；Effort/thinking 控制（--effort low..max|ultracode）；子代理 worktree 隔离与子代理持久记忆（isolation: worktree、memory: user/project/local）；会话外部存储接口（SDK sessionStore）；Managed Agents 服务端资源（environments/vaults/memory_stores）；Claude Code on the web / Routines / Claude Tag 托管会话

**设计启示**：
- 网关应以 stream-json 子进程为主接入面并用 system/init.capabilities[] 与 claude --version 做能力协商，而不是硬编码版本；Claude Code 文档中大量“v2.1.2xx 起”说明能力演进极快，接入层需容忍未知事件/字段。
- 不要解析或迁移 ~/.claude/projects JSONL（官方声明不稳定）；网关应把 stream-json 输出作为自有权威事件记录，并把引擎转录目录当作按租户挂载的黑盒卷（CLAUDE_CONFIG_DIR + CLAUDE_CODE_PROJECT_DIR_NAME），同时对同一 session 的并发 resume 加锁串行化。
- 业务→session 映射可用确定性 UUID（--session-id/sessionId）首轮创建、后续 --resume；避免 --continue（依赖 cwd）。fork-session 可用于“重试/分支”场景。
- 权限归一化模型可直接借鉴 Claude 的三层结构：模式（基线）+ allow/deny/ask 规则（Tool(pattern) 语法）+ 拦截回调（hook/canUseTool）；群助手推荐 dontAsk 或 auto + deny 列表 + --permission-prompts none，人工审批通过网关自建 MCP 工具（--permission-prompt-tool）转到群内按钮。
- 可观测归一化应以 stream-json 逐消息事件为主源（含 usage、cost、tool_use/result、api_retry、permission_denied、subagent 归属），OTel（claude_code.* 指标/事件，app.entrypoint 区分入口）作为旁路指标；hooks 的 http handler 可把生命周期事件实时推给网关。
- 能力清单应区分可归一公共能力（会话、工具白名单、权限模式、MCP、系统提示、成本、事件、子代理、skills）与 Claude 特有扩展（hooks 粒度、dynamic workflow、agent teams、plugins、auto 分类器、文件检查点），扩展能力以“能力标签 + 参数集（如 Workflow allow 规则、workflowSizeGuideline、CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS）”暴露给 LLM 元编排层；Agent Teams 在非交互模式不可用，不应列入网关可编排能力。
- 安全基线：网关拉起引擎必须 --bare 并显式内联 --settings/--mcp-config/--agents/--plugin-dir，避免 -p 无信任对话框直接执行仓库内 hooks 与 .mcp.json；隔离依赖容器/sandbox-runtime 而非仅靠引擎内建 Bash 沙箱。
- Managed Agents 的 Agent→Environment→Session→Events 资源模型与网关目标高度同构，可作为第二种“Claude 引擎实现”验证网关抽象（同一业务→session 映射既能落到本地子进程也能落到托管 REST）。

**关键事实**：
- [high] claude -p 支持 --output-format text/json/stream-json 与 --input-format stream-json；stream-json 首事件 system/init（含 model、tools、mcp_servers、plugins、capabilities[] v2.1.205+），末事件 result（result、session_id、total_cost_usd、usage、num_turns、permission_denials、structured_output） (https://code.claude.com/docs/en/headless)
- [high] 续接：--continue（同目录最近会话）、--resume <id|name>（v2.1.223+ 跨项目按 ID 查找）、--fork-session（新 ID 复制历史）；-p/SDK 会话不进入交互 picker 但可 --resume；SDK 有 sessionId/session_id、persistSession、sessionStore 选项 (https://code.claude.com/docs/en/sessions ; https://code.claude.com/docs/en/agent-sdk/python)
- [high] 转录存于 ~/.claude/projects/<project>/<session-id>.jsonl（cwd 路径非字母数字替换为 -），官方声明格式内部且随版本变化勿解析；多租户宿主用 CLAUDE_CONFIG_DIR + CLAUDE_CODE_PROJECT_DIR_NAME（v2.1.234+）隔离转录与记忆 (https://code.claude.com/docs/en/sessions)
- [high] Hooks 事件 30+（PreToolUse/PostToolUse/PostToolUseFailure/PostToolBatch/PermissionRequest/PermissionDenied/UserPromptSubmit/Stop/SubagentStart/SubagentStop/SessionStart/SessionEnd/PreCompact/PostCompact/Notification/TeammateIdle/TaskCreated/TaskCompleted/Elicitation/InstructionsLoaded/ConfigChange/PreModelSwitch 等），handler 类型 command/http/mcp_tool/prompt/agent，exit 2 阻断，JSON 输出 hookSpecificOutput.permissionDecision allow/deny/ask、updatedInput、additionalContext、decision/stopReason (https://code.claude.com/docs/en/hooks)
- [high] 权限模式 default(Manual)/acceptEdits/plan/auto(分类器)/dontAsk/bypassPermissions；-p 起始为 Manual；--permission-prompts none（v2.1.259+）用于无人值守；deny 规则在所有模式含 bypass 生效；管理设置 permissions.disableBypassPermissionsMode 可禁用 bypass (https://code.claude.com/docs/en/permission-modes ; https://code.claude.com/docs/en/headless)
- [medium] Agent SDK：TS @anthropic-ai/claude-agent-sdk v0.3.191 捆绑 Claude Code v2.1.191（原生二进制 @anthropic-ai/claude-agent-sdk-<platform>）；Python claude-agent-sdk 0.2.140+ 以 SubprocessTransport 拉起捆绑 CLI，可自定义 Transport；第三方产品必须用 API key 而非 claude.ai 登录 (https://code.claude.com/docs/en/agent-sdk/typescript ; https://code.claude.com/docs/en/agent-sdk/python ; https://code.claude.com/docs/en/agent-sdk/overview)
- [high] SDK Options 含 allowedTools/disallowedTools/tools、permissionMode、canUseTool、hooks（进程内回调）、mcpServers（含进程内 createSdkMcpServer）、systemPrompt（string 或 {type:'preset',preset:'claude_code',append}）、settingSources['user','project','local']（默认不读文件）、agents、resume/forkSession/continue/sessionId、maxTurns/maxBudgetUsd、cwd/env/additionalDirectories、sandbox、plugins、outputFormat(json_schema)、includePartialMessages、forwardSubagentText、effort/thinking (https://code.claude.com/docs/en/agent-sdk/typescript ; https://code.claude.com/docs/en/agent-sdk/python)
- [high] 子代理定义为 Markdown+YAML frontmatter（name/description/tools/disallowedTools/model/permissionMode/maxTurns/skills/mcpServers/hooks/memory/background/isolation:worktree/effort），位于 .claude/agents、~/.claude/agents、plugin agents/、--agents JSON；stream-json 中子代理消息以 parent_tool_use_id 标识，--forward-subagent-text（v2.1.211+）转发文本 (https://code.claude.com/docs/en/sub-agents ; https://code.claude.com/docs/en/headless)
- [high] Agent Teams 为实验特性（CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1），lead+teammates+共享任务列表（~/.claude/tasks/）+邮箱（~/.claude/teams/{team}/inboxes/{agent}.json）；在 -p/SDK 非交互模式下不生成 teammate；in-process teammate 不能随 session resume (https://code.claude.com/docs/en/agent-teams)
- [high] Dynamic workflows：Claude 编写 JS 脚本，原语 agent()/parallel()/pipeline()/phase()/log() 与 args 全局；保存于 .claude/workflows、~/.claude/workflows、plugin workflows/；ultracode = xhigh effort + 自动 workflow；在 -p/SDK 可用且不弹审批，需 Workflow 或 Workflow(<name>) allow 规则/canUseTool；限制 16 并发、1000 agent/run、4096 项/parallel；disableWorkflows / CLAUDE_CODE_DISABLE_WORKFLOWS=1 (https://code.claude.com/docs/en/workflows ; https://www.infoq.com/news/2026/06/dynamic-workflows-claude-code/)
- [high] OTel：CLAUDE_CODE_ENABLE_TELEMETRY=1 + OTEL_METRICS_EXPORTER/OTEL_LOGS_EXPORTER/OTEL_TRACES_EXPORTER(beta)；指标 claude_code.session.count/cost.usage/token.usage/lines_of_code.count/commit.count/pull_request.count/active_time.total/code_edit_tool.decision；事件 claude_code.user_prompt/assistant_response/tool_result/api_request/api_error/api_refusal/tool_decision/permission_mode_changed/auth/mcp_server_connection；属性 session.id、app.entrypoint(cli|sdk-cli|sdk-ts|sdk-py)、prompt.id (https://code.claude.com/docs/en/monitoring-usage)
- [high] 自动记忆位于 ~/.claude/projects/<project>/memory/MEMORY.md（首 200 行/25KB 载入）+ 主题文件，frontmatter type: user/feedback/project/reference、modified；开关 autoMemoryEnabled、autoMemoryDirectory、CLAUDE_CODE_DISABLE_AUTO_MEMORY=1；子代理 memory: user/project/local 独立目录；CLAUDE.md 可 @AGENTS.md 导入 (https://code.claude.com/docs/en/memory ; https://code.claude.com/docs/en/sub-agents)
- [high] ACP 适配器 @zed-industries/claude-code-acp 已更名 @agentclientprotocol/claude-agent-acp（仓库 zed-industries/claude-agent-acp），基于 Claude Agent SDK 实现 ACP agent，支持 MCP 透传、slash commands、权限扩展、goal 扩展、子代理会话 (https://github.com/zed-industries/claude-agent-acp ; https://www.npmjs.com/package/@zed-industries/claude-code-acp)
- [high] Managed Agents（公测 2026-04-08）REST：/v1/agents、/v1/environments、/v1/sessions、/v1/sessions/{id}/events（POST 发送、GET 轮询、/events/stream SSE）、/v1/vaults、/v1/memory_stores；beta 头 anthropic-beta: managed-agents-2026-04-01；事件 user.message/agent.message/agent.tool_use/user.custom_tool_result；按 session-hours 计费；与 Agent SDK 为独立产品 (https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/managed-agents-api-reference.md ; https://code.claude.com/docs/en/agent-sdk/overview)
- [high] Claude Code in Slack：每次 @Claude 请求创建一个新的 claude.ai/code 云 session，线程消息作为上下文，仅频道可用不支持 DM；Team/Enterprise 正迁移到 Claude Tag（组织共享身份+组织共享环境）；CLI 可用 claude --cloud <session-id> -p 向云 session 排队消息 (https://code.claude.com/docs/en/slack ; https://code.claude.com/docs/en/headless)
- [high] --bare 模式跳过 hooks/skills/commands/subagents/plugins/MCP/auto memory/CLAUDE.md 自动发现且不读 OAuth，被官方推荐为脚本/SDK 调用模式并将成为 -p 默认；无 --bare 的 -p 会无信任对话框直接运行项目 hooks 与 .mcp.json (https://code.claude.com/docs/en/headless)

**未解决问题**：
- stream-json 控制面（control_request/control_response：interrupt、set_permission_mode、can_use_tool、hook_callback、mcp 状态）的精确 wire 字段名，需读 claude-agent-sdk-python 源码确认
- SDK sessionStore/SessionStore 接口签名与能否完全替代磁盘 JSONL
- --session-id CLI flag 的确切名称及预置 UUID 但转录不存在时的行为
- V2 unstable_v2 API（createSession/send/stream）是否已发布
- Claude Tag 的频道→session 映射策略（是否每线程持久 session）及是否有编程 API
- sandbox 设置完整键集合（network.allowedDomains 等）与 SDK SandboxSettings 字段
- Managed Agents 事件类型全集（session.status_idle、tool_confirmation 等未在一手页确认）
- ACP 适配器对 Claude 特有能力（workflows、hooks、auto memory）的暴露程度

## T02 pi-agent / Pi Agent Harness（earendil-works/pi，原 badlogic/pi-mono，pi.dev；也是 OpenClaw 的底层 agent SDK）
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T02-pi-harness.md

（结构化摘要缺失，请直接阅读文件）

## T03 OpenCode (sst/opencode / opencode.ai) 客户端-服务端架构
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T03-opencode.md

**摘要**：OpenCode（anomalyco/opencode，原 sst/opencode，MIT，约203.6k star，稳定版 v1.18.27 于 2026-09-02 发布）是 client/server 分离的开源编码 Agent。`opencode serve` 在 127.0.0.1:4096 暴露 OpenAPI 3.1 描述的 REST+SSE 接口（162 条路径、93 种事件），TUI/Desktop/Web/VS Code/SDK/ACP 均为其客户端。会话以 ses_* 为核心，支持 parentID 子会话、fork/revert、share、自动 compaction、metadata 与会话级 PermissionRuleset，`?directory=` 实现项目隔离。权限 allow/ask/deny+glob 三级覆盖，运行时审批走 SSE permission.asked → POST /permission/{id}/reply {once|always|reject}。扩展面含 agents、commands、skills（兼容 .claude/skills）、AGENTS.md、MCP、插件 hooks；无内建长期记忆与 OTel。2.0 处于 beta（opencode2，新 /api/* 契约、新插件 API，V1 插件不兼容）。建议网关以长驻 serve+SSE 分拣接入，ACP 作为跨引擎通用适配备选。

**接入面**：首选：长驻 `opencode serve`（HTTP REST + SSE，OpenAPI 3.1 于 GET /doc，Basic Auth 经 OPENCODE_SERVER_PASSWORD），网关用 `?directory=<abs>` 为每个业务实体分配工作目录，`POST /session {metadata, agent, model, permission}` 创建并记录 sessionID，`POST /session/{id}/message` 或 `prompt_async` 发消息，订阅 `GET /event` 按 properties.sessionID 分拣（子会话经 parentID 回溯），`permission.asked` → `POST /permission/{id}/reply {once|always|reject}`，`POST /session/{id}/abort` 中断；TypeScript 可直接用 @opencode-ai/sdk（由 openapi 生成）。备选：`opencode acp`（stdio JSON-RPC，跨引擎标准）作为通用适配层；降级：`opencode run --format json --session --auto` 子进程。能力探测：GET /global/health、/experimental/capabilities、/agent、/skill、/command、/experimental/tool/ids、/config/providers、/doc 指纹比对。归一化逻辑亦可打包为 OpenCode 插件（permission.ask、tool.execute.*、event hooks）。

**公共能力**：创建/继续会话（POST /session, POST /session/{id}/message|prompt_async）与目录级上下文隔离（?directory=）；流式输出与生命周期事件（SSE message.part.delta / session.idle / session.status / session.error）；权限规则（allow/ask/deny + glob，全局/agent/会话三级）与运行时审批（permission.asked → reply once/always/reject）；用户提问通道（question.asked → /question/{id}/reply|reject）；中断/取消（/abort, v2 /interrupt）；按消息切换模型/agent/工具开关（model, agent, tools 字段）；系统提示与规则注入（system 字段、AGENTS.md、instructions）；结构化输出（format json_schema）；MCP 挂载（local/remote + OAuth）；Skills / Commands 资产（兼容 .claude/skills 的 SKILL.md）；用量与成本（Session.cost, tokens）；日志（~/.local/share/opencode/log, POST /log）

**扩展能力**：树状子会话委派（task 工具、parentID、subtask part、permission.task glob）；后台子代理（experimental capabilities.backgroundSubagents, POST /experimental/session/{id}/background）；会话 fork / revert / unrevert 与文件快照回滚（session.diff）；Share 公开链接（/share, share: manual|auto|disabled）；v2 steer/queue 插话（delivery 字段）与 /wait；跨目录迁移会话（/experimental/control-plane/move-session）；worktree / workspace 环境隔离（experimental）；IDE 向能力：PTY、LSP、VCS diff/apply、文件浏览、TUI 遥控端点；插件 hooks（permission.ask、tool.execute.before/after、chat.params/headers、tool.definition、experimental.chat.*.transform）；自动 compaction 参数（compaction.auto/keep.tokens/buffer）与 compaction 事件；Provider/Auth 管理 API（PUT /auth/{providerID}, /provider/{id}/oauth/*）与 OpenCode Zen（opencode/<model>）

**设计启示**：
- OpenCode 已经是'引擎即服务'形态：一个长驻 serve 进程通过 ?directory= 服务多个项目实例，网关只需维护 业务ID→{directory, sessionID} 映射即可实现会话连续性与隔离，无需每业务一进程。
- 会话级 PermissionRuleset 可在 POST /session 时注入（openapi 确认），加上 agent 级与全局级规则，让网关能把业务权限编译为引擎原生规则；未覆盖情形再通过 permission.asked 事件转人审，统一回复枚举需归一为 once/always/reject ↔ allow_once/allow_always/deny。
- 事件总线是全局 SSE 流而非每会话流（v1），网关适配器必须按 sessionID 分拣并用 parentID 把子会话事件归属到业务会话；93 种事件可映射到统一事件模型（lifecycle/token/tool/approval/error），且 session.next.tool.called/success/failed 已提供工具级细粒度埋点。
- 能力识别应基于运行时探针而非硬编码：GET /global/health 版本 + GET /doc OpenAPI 指纹 + /experimental/capabilities + /agent /skill /command /tool/ids，能自动发现引擎演进（例如 v2 /api/* 端点出现、backgroundSubagents 开启）。
- v1/v2 双轨与实验端点提示要在适配器中做版本分支与'稳定/实验'能力分级；核心公共能力只依赖 session/message/event/permission 四组稳定端点，扩展能力（fork、share、steer、worktree）显式标记为 OpenCode 特有。
- OpenCode 的资产格式（SKILL.md、AGENTS.md/CLAUDE.md、.opencode/agents/*.md、MCP JSON）与 Claude Code 高度兼容，统一 AI 资产模型可以以 SKILL.md + AGENTS.md + MCP 配置为最小公分母。
- OpenCode 缺少长期记忆与 OTel 导出，正是网关统一记忆层与观测层的价值所在；同时可通过编写一个 OpenCode 插件（permission.ask/tool.execute.*/event hooks + 反向 SDK client）把网关策略下沉到引擎内部执行。
- ACP 作为第二适配层值得投入：OpenCode、Zed、Gemini CLI 等都支持 ACP stdio JSON-RPC，可让'所有 ACP 引擎共享一个 adapter'，但 OpenCode 特有能力（子会话列表、share、config、fork）仍需走 serve API。

**关键事实**：
- [high] 当前稳定版 v1.18.27（2026-09-02），@opencode-ai/sdk 与 @opencode-ai/plugin npm 版本同为 1.18.27；OpenCode 2.0 仍为 beta（opencode2，@opencode-ai/cli@beta） (https://github.com/anomalyco/opencode/releases ; packages/opencode/package.json ; https://opencode.ai/v2/docs/migrate-v1)
- [high] GitHub star 约 203.6k，fork 26.6k，MIT，仓库已从 sst/opencode 迁至 anomalyco/opencode (https://github.com/anomalyco/opencode ; https://www.developersdigest.tech/blog/opencode-developer-guide-2026)
- [high] opencode serve 默认 127.0.0.1:4096，GET /doc 返回 OpenAPI 3.1，Basic Auth 由 OPENCODE_SERVER_PASSWORD/OPENCODE_SERVER_USERNAME 开启，--cors/--mdns 可选 (https://opencode.ai/docs/server/)
- [high] openapi.json 共 162 条路径；绝大多数端点接受 ?directory= 与 ?workspace= query 参数路由到项目实例；v1 路径与 v2 /api/* 路径在同一 server 并存 (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/sdk/openapi.json)
- [high] POST /session body 支持 parentID/title/agent/model{providerID,id,variant}/metadata/permission(PermissionRuleset=[{permission,pattern,action}])/workspaceID；POST /session/{id}/message 支持 agent/model/tools/system/format(json_schema)/noReply/parts[text|file|agent|subtask] (openapi.json)
- [high] 权限值 allow/ask/deny，键含 read/edit/glob/grep/bash/task/skill/lsp/question/webfetch/websearch/external_directory/doom_loop，支持 glob（最后匹配生效）与 agent 级覆盖；运行时回复枚举 once/always/reject，端点 POST /permission/{requestID}/reply {reply,message?}（旧：POST /session/{id}/permissions/{pid} {response}） (https://opencode.ai/docs/permissions/ ; openapi.json)
- [high] SSE 事件流 GET /event（实例）、GET /global/event（全局）、v2 GET /api/session/{id}/event；Event 联合类型 93 种，含 session.created/updated/idle/status/error/compacted、message.part.updated/delta、permission.asked/replied、question.*、session.next.tool.called/success/failed、mcp.tools.changed 等 (openapi.json ; https://opencode.ai/docs/plugins/)
- [high] 插件 hooks（源码确认）：event, config, tool, auth, chat.message, chat.params, chat.headers, permission.ask, tool.execute.before/after, tool.definition, shell.env, command.execute.before, experimental.session.compacting 等；插件收 {project, client, $, directory, worktree} (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/plugin/src/index.ts ; https://opencode.ai/docs/plugins/)
- [high] 内置 agent：primary build/plan，subagent general/explore/scout；agent 定义在 opencode.json 或 .opencode/agents/*.md（description/mode/model/temperature/prompt/permission/steps/color/hidden/disable）；task 委派创建带 parentID 的子会话，permission.task 以 glob 控制可委派对象 (https://opencode.ai/docs/agents/ ; openapi Agent schema)
- [high] compaction 自动触发条件为估算 tokens > context − max(output, buffer)，配置 compaction.auto/keep.tokens(15000)/buffer(20000)；手动 v1 POST /session/{id}/summarize、v2 POST /api/session/{id}/compact；生成结构化摘要 checkpoint 而不删历史 (https://opencode.ai/v2/docs/compaction/ ; openapi.json ; prompt.ts)
- [high] opencode acp 以 stdio JSON-RPC 实现 ACP，支持 Zed/JetBrains/Avante.nvim/CodeCompanion.nvim，支持工具/MCP/AGENTS.md/agents/权限，不支持 /undo /redo (https://opencode.ai/docs/acp/)
- [medium] 数据目录 ~/.local/share/opencode/（auth.json、log/ 保留10个、<project-slug>/storage/），配置 ~/.config/opencode/opencode.json(c)，缓存 ~/.cache/opencode；早期存储格式为 session/{projectID}/{sid}.json、message/{sid}/msg_*.json；1.18.x 源码含 #db 映射（db.bun.ts/db.node.ts），SQLite 层存在但 schema 未核实 (https://opencode.ai/docs/troubleshooting/ ; https://ccusage.com/guide/opencode/ ; packages/opencode/package.json)
- [high] MCP 配置 type local{command,environment,enabled,timeout} / remote{url,headers,oauth,enabled}，远程自动 OAuth DCR；CLI opencode mcp auth/list/logout/debug；API GET/POST /mcp、/mcp/{name}/auth、/connect、/disconnect (https://opencode.ai/docs/mcp-servers/ ; openapi.json)
- [high] Skills 位置 .opencode/skills/<name>/SKILL.md、~/.config/opencode/skills/、兼容 .claude/skills 与 .agents/skills；模型经原生 skill 工具按需加载；permission.skill glob；GET /skill 列出 (https://opencode.ai/docs/skills/ ; openapi.json)
- [high] v2 API 新增 delivery: steer|queue、/wait、/interrupt、/context、/history、/api/permission/saved；v2 使用新包 @opencode-ai/client，plugin 配置改为 plugins:[{package,options}]，V1 插件在 V2 不可用 (openapi.json ; https://opencode.ai/v2/docs/migrate-v1)
- [medium] 企业版提供中心化配置、SSO、内部 AI 网关限制、share 禁用（"share":"disabled"）、按席位计费；share 自托管在路线图 (https://opencode.ai/docs/enterprise/ ; https://opencode.ai/docs/share/)
- [medium] 无内建跨会话长期记忆与 OTel 导出；Session 对象内置 cost 与 tokens{input,output,reasoning,cache{read,write}}；POST /log 允许客户端写入引擎日志 (docs 全站 ; openapi Session schema)

**未解决问题**：
- 1.18.x 实际持久化格式（SQLite 表结构 vs JSON 文件）未从一手源码完整核实（db.bun.ts 路径 404）
- OpenCode 2.0 正式发布时间与 /api/* 契约冻结时间（截至 2026-09-04 仍 beta）
- permission always[] 的保存范围（会话级 vs 项目级）在 v1 与 v2 是否不同
- GET /global/event 在多目录场景下 payload 的 directory 字段与 instance 生命周期细节
- ACP 模式下权限/子会话事件的完整映射，issue #18672（session/update 时序）是否已修复
- 企业版中心化配置的分发机制与 SSO 集成细节

## T04 Hermes Agent (NousResearch/hermes-agent) 自进化助手引擎
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T04-hermes-agent.md

**摘要**：Hermes Agent（Nous Research，MIT，Python）是长期伴随型、跨平台、自我改进的通用助手 harness。最新 v0.21.0（2026-08-31），8 月一月 7 版。它本身是"网关+引擎"合体：hermes gateway 守护进程承载 30+ 消息平台适配器、OpenAI 兼容 API server（:8642）、60s tick 的 cron 与 outbound webhooks；命令在 local/docker/ssh/singularity/modal/daytona/vercel_sandbox 执行。会话存 SQLite state.db（sessions/messages/messages_fts/gateway_routing），key 形如 agent:main:<platform>:group:<chat_id>:<user_id>，默认不自动重置。最佳接入面是 /api/sessions/* + X-Hermes-Session-Key 与 /v1/runs（events SSE、approval、steer），GET /v1/capabilities 可做能力协商；另有 ACP、hermes mcp serve、CLI -z/-Q。记忆为 MEMORY.md/USER.md 快照 + FTS5 session_search，向量交由 Honcho 等 8 个 provider。技能遵循 agentskills.io，agent 经 skill_manage 自建/自修补（独有自进化能力）。多 agent 有 delegate_task（orchestrator、实时 steer）、带记忆 cron、A2A、Bot Mode。安全为 approvals.mode + 硬 blocklist + allowlist/DM pairing。观测靠 SSE 事件、HMAC 签名 webhooks、26 个 hooks，无原生 OTel。接入需注意双网关叠层、profile 级记忆、无人值守审批默认 deny。

**接入面**：首选：hermes gateway 启动的 OpenAI 兼容 API server（:8642，Bearer）——用 POST /api/sessions 与 /api/sessions/{id}/chat[/stream]（事件 assistant.delta/tool.started/tool.completed/run.completed）做显式"业务→session"映射，用 X-Hermes-Session-Key 把业务 id 编码为 agent:<profile>:<biz>:group:<gid>[:<uid>] 控制隔离与记忆域；长任务用 POST /v1/runs（Idempotency-Key）+ GET /v1/runs/{id}/events SSE + POST .../approval（审批中继）+ .../steer；GET /v1/capabilities、/v1/toolsets、/v1/skills、/health/detailed 用于能力识别与健康检查。备选：CLI 一次性 hermes -z -Q -q "..." --resume <id> -p <profile>；ACP（hermes acp，IDE 场景，进程内会话）；hermes mcp serve；Python import run_agent.AIAgent。被动观测：outbound webhooks（HMAC X-Hermes-Signature-256）与 plugin hooks。多租户通过 profile（-p，独立 ~/.hermes/profiles/<p>/）隔离。

**公共能力**：会话创建/续接/重置（/api/sessions, X-Hermes-Session-Id/Key, /new, session_reset.*）；会话隔离粒度参数化（group_sessions_per_user 或网关自编 key）；同步与 SSE 流式对话（/api/sessions/{id}/chat/stream, /v1/chat/completions）；模型与推理强度选择（model, provider, model_options.reasoning_effort）；工具面裁剪（agent.disabled_toolsets, -t/--toolsets, GET /v1/toolsets）；危险操作审批闸门（approvals.mode/timeout/unattended_mode/deny[], POST /v1/runs/{id}/approval）；执行沙箱选择（terminal.backend: local|docker|ssh|modal|daytona|vercel_sandbox|singularity）；事件/观测流（SSE 事件名、outbound webhooks events[] + HMAC 签名、usage 字段）；技能资产（agentskills.io SKILL.md，hermes skills install，GET /v1/skills）；记忆抽象（MEMORY.md/USER.md + memory provider）；能力发现（GET /v1/capabilities.features{}）；健康检查（/health, /health/detailed）

**扩展能力**：技能自进化：agent 自动创建/自修补 skills（skill_manage，skills.write_approval, skills.guard_agent_created）；子代理编排：delegate_task leaf/orchestrator、max_spawn_depth、实时 steer/stop、JSON-schema 输出校验（delegation.*）；带记忆的 cron / Jobs API（continuity, context_from, deliver 目标, reasoning_effort per job）；Bot Mode / A2A v1.0 / hermes peer（agent 社会、群房间、agent 间 DM）；多平台原生投递 send_message 与 DM pairing 准入；execute_code RPC 批处理工具调用；外部记忆 provider（Honcho dialectic 用户建模，sessionStrategy/userPeerAliases）；hermes mcp serve 把自身暴露为 MCP server；ACP 编辑器模式；OpenClaw 资产迁移（hermes claw migrate）；语音/唤醒词、桌面浏览器控制（v0.20+）

**设计启示**：
- Hermes 本身是'网关+引擎'合体：接入时必须让我们的网关成为唯一入口——关闭其他平台适配器、显式设置 approvals.unattended_mode、决定是否禁用 send_message/cronjob toolset，否则出现双网关叠层与权限旁路。
- '业务→session'映射的最佳做法是由外部网关生成 session key（agent:<profile>:<biz>:group:<gid>[:<uid>]）并通过 X-Hermes-Session-Key/X-Hermes-Session-Id 传入，把 transcript 与记忆作用域解耦——这个'两个 id 分离'的模式值得作为我们统一会话协议的字段设计（session_id + memory_scope_key）。
- GET /v1/capabilities 返回 features{} 的做法可直接借鉴为引擎能力协商协议；对演进极快的引擎（一月 7 版）应在运行时协商 + 锁 tag，而不是静态配置。
- 记忆并非天然按业务分片：MEMORY.md/USER.md 是 profile 级全局文件，多租户群助手需要每租户一个 profile（独立端口/进程）或依赖 Honcho 的 peer 映射；统一记忆模型应区分'引擎内置小记忆'与'外挂记忆 provider'两层。
- 审批闸门应建模为异步事件流：Runs API 的 approval 事件 → 网关转发到群 → POST /approval 回填；无人值守默认 deny 意味着不做中继就会静默失败。
- 可观测归一化的两条通道：SSE 事件名（assistant.delta/tool.started/tool.completed/run.completed/subagent.start）与 HMAC 签名 webhooks（事件名对应 26 个 plugin hooks）；这套 hook 名可作为我们统一事件模型的候选词表。
- Hermes 的'自进化'是引擎特有扩展能力，只有安全扫描而无效果评估；接入时应默认 skills.write_approval=true 并把技能目录纳入网关的资产治理，而不是放任引擎自改。
- ACP 虽存在但会话进程内、工具面裁剪，不适合群助手；OpenAI 兼容 API 才是该引擎的稳定接入面——说明'协议种类'不等于'适合的接入面'，能力识别流程应记录每种协议的会话持久性与工具面差异。

**关键事实**：
- [high] 最新版本 v0.21.0 'Pantheon Release'（tag v2026.8.31，2026-08-31），自 v0.20.0 起约 5,800 commits/2,475 PR；版本采用语义号与日期 tag 双号制 (https://github.com/NousResearch/hermes-agent/releases)
- [high] 内置 OpenAI 兼容 API server：/v1/chat/completions、/v1/responses、/v1/runs(+/events,/approval,/stop,/steer)、/api/sessions/*、/api/jobs、/v1/capabilities、/v1/skills、/v1/toolsets、/health；默认端口 8642，Bearer API_SERVER_KEY，随 hermes gateway 启动 (https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md)
- [high] 请求头 X-Hermes-Session-Id 绑定 transcript，X-Hermes-Session-Key（≤256 chars，如 agent:main:webui:dm:user-42）独立指定长期记忆作用域 (https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md)
- [high] 会话持久化于 SQLite ~/.hermes/state.db（WAL），表 sessions/messages/messages_fts(FTS5)/gateway_routing；session key 形如 agent:main:<platform>:dm:<chat_id> 与 agent:main:<platform>:group:<chat_id>:<user_id>，群聊默认按用户隔离（group_sessions_per_user） (https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md)
- [high] session_reset.mode 默认 none，可选 idle/daily/both（idle_minutes、daily_at）；重置前给 agent 一轮保存记忆/技能；压缩生成带 parent_session_id 的续接会话 (https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md)
- [high] 记忆 = ~/.hermes/memories/MEMORY.md(2,200 chars) + USER.md(1,375 chars)，会话开始冻结快照注入；memory 工具动作 add/replace/remove；8 个外部 provider（Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory）为附加 (https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)
- [high] Honcho 集成：memory.provider: honcho，配置 recallMode(hybrid|context|tools)、sessionStrategy(per-directory|per-repo|per-session|global)、userPeerAliases、pinUserPeer；新增 honcho_profile/honcho_search/honcho_context/honcho_reasoning/honcho_conclude 五个工具 (https://hermes-agent.nousresearch.com/docs/user-guide/features/honcho)
- [high] 技能遵循 agentskills.io，位于 ~/.hermes/skills/<category>/<name>/SKILL.md；agent 通过 skill_manage(create/patch/edit/delete/write_file/remove_file) 自建自修补；hub 源 official/skills-sh/well-known/url/github/clawhub/lobehub/browse-sh；安装安全扫描，dangerous 不可 --force (https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md)
- [high] delegate_task 参数 goal/context/max_iterations(50)/role(leaf|orchestrator)/tasks[]，不接受 toolsets；子代理零上下文且禁用 memory/send_message/cronjob/clarify；delegation.max_spawn_depth 默认 1；v0.21.0 支持 action=list/steer/stop 实时 steering (https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/delegation.md)
- [high] cronjob 工具支持 continuity 与 context_from（带记忆的 cron），schedule 支持自然语言与 5 字段 cron，存储 ~/.hermes/cron/jobs.json，调度器在 gateway 守护进程每 60s tick，deliver 支持 telegram:<chat_id> 等目标 (https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)
- [high] 安全：approvals.mode smart|manual|off（默认 smart），cron_mode/single_query_mode/unattended_mode 默认 deny；YOLO 不覆盖硬编码 blocklist；分层准入 TELEGRAM_ALLOWED_USERS/GATEWAY_ALLOWED_USERS/DM pairing；docker 后端跳过危险命令检查 (https://hermes-agent.nousresearch.com/docs/user-guide/security)
- [high] 终端执行后端 7 种：local/docker/ssh/singularity/modal/daytona/vercel_sandbox（terminal.backend） (https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- [high] Hermes 支持 ACP：hermes acp 启动 stdio JSON-RPC 服务，会话由进程内 session manager 管理，使用精简 hermes-acp toolset（排除消息投递与 cron） (https://hermes-agent.nousresearch.com/docs/user-guide/features/acp)
- [medium] Outbound webhooks（v0.20.0）：配置 name/url/events[]/secret_env，事件为 plugin hook 集合（pre_tool_call/post_tool_call/on_session_start/on_session_end/subagent_start...），HMAC-SHA256 签名头 X-Hermes-Signature-256，去重头 X-Hermes-Delivery (https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks (via search summary) + https://github.com/NousResearch/hermes-agent/pull/69406)
- [high] CLI 无头：-q/--query、--oneshot、-Q/--quiet、-z（纯一次性）、-m/--provider/-t/-s/-p profile；退出码 0/1/2/75；hermes mcp serve 可把自身暴露为 MCP server (https://hermes-agent.nousresearch.com/docs/reference/cli-commands)
- [high] 消息平台 30+：Telegram/Discord/Slack/WhatsApp/Signal/SMS/Email/Mattermost/Matrix/DingTalk/Feishu/WeCom/Weixin/QQ/Teams/LINE/ntfy/Webhooks 等；API server 实现为 gateway/platforms/api_server.py 平台适配器 (https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md)

**未解决问题**：
- 通过 /api/sessions 创建的会话能否与同 key 的消息平台会话在 gateway_routing 中互通（未实测）
- Outbound webhook payload 完整 schema、重试策略、是否含 token 用量
- 是否有原生 OpenTelemetry 导出；hermes logs 底层日志格式
- Bot Mode / A2A / hermes peer 是否有可被外部网关调用的协议级接口
- 审批超时默认值（security 页 300s vs 搜索摘要 60s）需源码确认
- 整群共享会话时多用户并发的 turn lease 语义（排队还是丢弃）
- 技能自进化是否有质量评估/回归机制

## T05 DeepSeek Harness (dsh) "Everything is a Plugin"
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T05-deepseek-harness-dsh.md

**摘要**：DeepSeek Harness（dsh）是 DeepSeek 于 2026-08-13 开源的 MIT/TypeScript developer-preview agent harness（npm @deepseek-ai/dsh，当前 0.1.2-rc.1），基于 Cordis 插件框架，模型适配器、工具、会话日志、沙箱、持久化、UI 乃至 agent loop 全是可替换插件，运行时由 bundle→profile→home→--patch 有序叠加。会话是 append-only SessionEvent 日志（可 resume/fork/compaction，JSONL，格式 v0 无兼容承诺）。接入面：headless CLI、JSON-RPC stdio SDK（TS/Python，无 cancel/审批）、ACP v1 server（session/new|list|resume|close|prompt|cancel|request_permission，按会话声明 MCP）。权限=SandboxMode(read-only|workspace-write|danger-full-access) × ApprovalPolicy(ask|never) 预设。兼容 AGENTS.md/CLAUDE.md、SKILL.md、Claude Code/Codex hooks.json，MCP 仅客户端，无内置长期记忆。多 agent：多 provider 子代理（含 Claude Code/Codex/ACP 后端）、workflow/ralph 动态编排、实验性 Agent Teams。可观测：事件流 + OTel logs telemetry（默认外发 DeepSeek）。建议网关以 ACP 为首选通道，按租户隔离 DSH_HOME、按群固定 cwd+session_id；风险为协议日更、token 成本高、SDK 无取消。

**接入面**：三条程序化接入通道，均为子进程：(1) `dsh --profile headless "task"` 一次性，stdout 最终答案、stderr `dsh: reasoning:`、exit 0/1，不可续接；(2) `dsh --profile sdk`：newline-delimited JSON-RPC 2.0 stdio，`initialize{provider,model,cwd,reasoningEffort,maxTokens}` → `session/prompt` → 通知 `session.event`(全部会话原始 SessionEvent)/`session.status`/`subagent.*`，`shutdown`；TS 客户端 @deepseek-ai/dsh-sdk-client 与 Python deepseek-harness-sdk（DeepSeekHarness(dsh_home, cwd, provider, model, profile, patches).run(prompt, session_id)），续接靠同 dsh_home+session_id；无 cancel/close/审批回路；(3) `dsh --profile acp`：标准 ACP v1 stdio，`session/new(cwd, mcpServers)`、`session/list`、`session/resume`、`session/close`、`session/prompt`、`session/cancel`、`session/set_config_option(model, reasoning_effort)`、`session/update`、`session/request_permission`（网关可自动应答）。配置注入用 `--patch <cordis.patch.yml>`（权限预设、MCP 行、模型路由），隔离用 `DSH_HOME`（租户）+ `cwd`（群/沙箱边界）+ `session_id`。Web host HTTP API 与 webhook 存在但非公开稳定接口。进程内嵌入被官方门禁禁止。

**公共能力**：会话创建/续接/列举/关闭（ACP session/new|resume|list|close；SDK 同 dsh_home+session_id）；消息发送与流式事件输出（session/prompt + session.event / session/update）；取消（仅 ACP session/cancel）；模型/provider/reasoning_effort/max_tokens 选择（initialize 或 session/set_config_option）；权限限制：sandbox mode + approval policy + permission preset + tools/pre-execute 策略 + 子代理 toolFilter；MCP 工具接入（客户端，stdio/streamable-http）；工作区指令与技能资产（AGENTS.md/CLAUDE.md、SKILL.md 目录）；Hooks（Claude Code/Codex hooks.json 桥接）；上下文压缩（自动 compaction + /compact + tool result pruning）；子代理委派（多 provider，能力标志）；事件/日志归一化（SessionEvent{type,seq,time,data}，assistant/message.usage token 计量）；OpenTelemetry 导出（内置 OTel logs；第三方 OTel traces）；审批请求回调（仅 ACP session/request_permission）；工作区 cwd 隔离与文件沙箱

**扩展能力**：运行时自修改：tool-cordis 七个工具在进程内定义/运行/停止/移除动态 Cordis 包（仅内存）；dynamic workflow：模型编写的编排脚本（workflow 工具，worker thread fan-out）与 ralph 新鲜 agent 迭代循环；Agent Teams（experimental）：durable roster、任务 DAG（blockedBy/writeScopes/revision CAS）、mailbox Steer 投递；会话 fork（seed/parentSession/seedLength）与 session-reference（引用其他会话快照）、session-query 跨会话 FTS 检索；Agent presets：同一进程内按 agent.cordis.yml 组合不同工具/persona/skills 的会话；把 Claude Code / Codex / 任意 ACP agent / 另一 dsh 作为子代理后端（subagent-claude-code、subagent-codex、subagent-acp、subagent-dsh-sdk）；整棵插件树可替换（包括 agent loop、persistence 后端、sandbox 后端、UI），--patch / cordis.patch.yml 配置层叠加，--dump-config 能力自省；内核级沙箱（bwrap/Landlock/Seatbelt/Windows ACL）与 enforcement full/partial 报告；PTC 代码执行模式（DSH_TOOLS_MODE，code-runtime 组）；Jobs 后台任务、session-local schedule、webhook 触发 Session、goal/plan/todo 持久化；会话遥测 sharing 策略（FULL/FEEDBACK_ONLY/DISABLED）与 session-log-deepseek 日志上传

**设计启示**：
- 网关的引擎适配层应优先走 ACP：dsh、opencode、pi 等都提供 ACP v1 server，一个 ACP 适配器即可覆盖会话创建/续接/取消/权限回调/MCP 声明，最符合“上层稳定、引擎可换”；dsh 的 SDK JSON-RPC 缺 cancel 与审批回路，只适合做全量事件采集。
- 会话映射建议三级键：租户→DSH_HOME（profile/凭证/sessions 全隔离），群→cwd（同时是沙箱 workspace-write 边界），会话→固定 session_id；dsh 允许调用方指定 session id，天然支持“同群连续、群间隔离”。
- 权限模型可归一化为两维：文件/执行沙箱级别（read-only / workspace-write / full）× 审批策略（ask / never / auto-rule）；dsh 的 permission preset 表正是这种打包，网关可用统一枚举映射到各引擎（Claude Code permission mode、opencode permission config 等）。
- 可观测归一化的最小公共事件集可直接借用 dsh 的 SessionEvent 词汇：turn/start|end、step/start|end、user/message、assistant/message(usage)、tool/call|result、approval/asked|decided；网关按 (session.id, seq) 去重、以 turn/step 作为 span 层级，与 OTel GenAI 语义（invoke_agent / chat / execute_tool）对齐。
- 能力识别→适配→认证流程可参考 dsh 子代理 seam 的“能力标志 + fail loud”设计：引擎适配器声明 capabilities（cancel、resume、fork、approval-callback、mcp、workflow、team…），网关在编排时对缺失能力显式拒绝而非静默降级；对 dsh 可通过 `dsh --version` + `--dump-config` + ACP initialize 自动生成能力清单。
- 引擎特有扩展能力（dsh 的自修改、workflow、Agent Teams、presets、fork）应以 `extensions.<engine>.<capability>` 的命名空间暴露给 LLM 元编排层，配置参数就是 dsh 的 patch 行（插件名 + config），网关不解释其语义只透传。
- 接入 developer-preview 引擎必须锁版本并做快照回归：dsh 协议无版本协商、会话格式 v0、日更 rc；适配器应记录引擎版本到会话元数据，遥测默认外发（DSH_TELEMETRY_MODE）需在 patch 中显式 DISABLED。
- 资产层可复用性高：AGENTS.md/CLAUDE.md、SKILL.md 目录、hooks.json、MCP 配置在 dsh、Claude Code、Codex 间基本互通，网关的统一资产模型可以这四种文件形态为公共格式，引擎特有格式（cordis.patch.yml）作为渲染目标。

**关键事实**：
- [high] 仓库 github.com/deepseek-ai/deepseek-harness，CLI 名 dsh，npm 包 @deepseek-ai/dsh，MIT 许可证，TypeScript/pnpm/ESM 单仓 (https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/README.md ; AGENTS.md)
- [high] 公开发布日 2026-08-13（developer preview）；npm 首版 0.0.1-rc.1 于 2026-08-10；当前 latest 0.1.2-rc.1（2026-09-03），几乎每日发 rc/alpha (https://registry.npmjs.org/@deepseek-ai/dsh ; https://www.open-harness.net/ ; https://justin3go.com/en/posts/2026/08/15-deepseek-harness-review)
- [medium] GitHub star 约 211k（2026-09-04 页面）；发布 28 小时 92.7k (https://github.com/deepseek-ai/deepseek-harness ; justin3go 评测)
- [high] 底层为 Cordis 插件框架（vendored），论文 arXiv 2608.25512；所有注册是可逆 effect；waterfall 事件监听者必须调用 next() (README.md ; docs/architecture.md ; AGENTS.md)
- [high] 内置 profile：web(3080 端口)、headless、sdk、sdk-minimal、acp；配置层叠加顺序 bundle patches → profile cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch；patch 按 row id 整体替换 config 或 insert；dsh --profile X --dump-config 可见完整树 (docs/architecture.md ; apps/cli/README.md ; apps/cli/reference/README.md)
- [high] SDK 协议为 newline-delimited JSON-RPC 2.0 over stdio：请求 initialize/session/prompt/shutdown，通知 session.event（全部会话未过滤）/session.status/subagent.started/subagent.finished；无 cancel、无 session close、无 server→client 请求（审批不可达），serverInfo.version 恒 0.0.1 无协商 (packages/sdk/protocol/README.md ; python/sdk/README.md)
- [high] ACP v1 服务端 dsh --profile acp 支持 initialize/authenticate/session/new/list/resume/close/set_config_option/prompt/cancel/update/request_permission，支持 stdio 与 streamable-http MCP；不支持 session/load、fork、删除、modes、plans、terminals、elicitation (packages/acp/acp/README.md ; packages/bundle/acp-app/README.md)
- [high] Python SDK deepseek-harness-sdk 附带 runtime wheel（无需系统 Node），DeepSeekHarness(dsh_home, cwd, provider, model, reasoning_effort, max_tokens, profile, patches)，harness.run(prompt, session_id) 复用 session_id 即续接会话，RunResult 含 final_response/finish_reason/events (python/sdk/README.md ; docs/user/guide/python-sdk.md)
- [high] 会话是 append-only SessionEvent 日志（turn/*, step/*, user/message, assistant/chunk|message, tool/call|result, request/header 等），运行时不变量 Model-visible ⟺ logged，支持 fork（ctx.agents.create seed/parentSession）与 resume；JSONL 持久化可 zstd；SESSION_FORMAT_VERSION=0 无兼容承诺 (docs/subsystems/session.md ; docs/subsystems/persistence.md ; AGENTS.md)
- [high] 权限=SandboxMode('read-only'|'workspace-write'|'danger-full-access'，仅限文件效果，bwrap/Landlock/Seatbelt/Windows ACL，enforcement full|partial，无可用后端时 fail-closed) × ApprovalPolicy('ask'|'never'，outcome allowed-once|rejected|cancelled|unavailable)；预设 workspace-write 与 danger-full-access；tools/pre-execute waterfall 可挂策略插件 (docs/subsystems/sandbox.md ; approval.md ; permission-presets.md)
- [high] 子代理 seam 多 provider 并存：spawn-in-process、fork-in-process、acp、codex、claude-code、dsh-sdk；能力标志 SubagentCapabilities{agentOptions,outputSchema,depthLimit,toolFilter,persona}，不支持时抛 UNSUPPORTED_CAPABILITY (docs/subsystems/subagent.md)
- [high] workflow 包组提供模型编写的编排脚本（worker thread）fan-out 子代理，workflow 与 ralph 工具；Agent Teams（roster/任务 DAG/mailbox）为 experimental 私有能力 (packages/workflow/README.md ; docs/subsystems/agent-team.md)
- [high] MCP 仅客户端 @deepseek-ai/dsh-mcp-client（stdio/streamable-http），工具命名 mcp__<serverName>__<tool>，仅桥接 Tools；无内置长期记忆，官方提供 Memorix/MCP reference memory/Engram 三个默认关闭 overlay (packages/mcp/README.md ; docs/user/guide/mcp-memory.md)
- [high] 资产兼容：AGENTS.md/CLAUDE.md（agent-instructions 默认开启）、skills 目录 .dsh/skills、.agents/skills、$DSH_HOME/skills；hooks-claude-code / hooks-codex 桥接现有 hooks.json；settings.yaml 中 llm-pi-ai.providers 配置自定义 OpenAI-compatible 端点 (packages/context/README.md ; docs/subsystems/skills.md ; packages/hooks/README.md ; docs/user/guide/providers.md)
- [high] 遥测：dsh-session-telemetry-otel 通过 OTel Logs 上报 SessionTelemetryRecord{channel,time,severity,attributes,body}，模式 FULL/FEEDBACK_ONLY/DISABLED（DSH_TELEMETRY_MODE），默认发往 DeepSeek 端点；第三方 @loongsuite/dsh-plugin 导出 OTLP traces（turn/agent/step/llm/tool span） (docs/subsystems/session-telemetry.md ; packages/session/README.md ; https://signoz.io/docs/deepseek-harness-observability/)
- [medium] 社区评测：token 消耗远高于 pi（约 47.6K vs 4.5K/任务），AGENTS.md+CLAUDE.md 重复注入 bug，第三方插件质量参差，被指过度工程；架构可审计性与开放性受赞 (https://justin3go.com/en/posts/2026/08/15-deepseek-harness-review ; https://composio.dev/content/deepseek-harness-vs-claude-code)
- [high] 官方禁止进程内直接挂载作为应用入口（verify-application-entrypoints 门禁），一切从 dsh --profile 启动，网关只能子进程+stdio 协议或 CLI 接入 (docs/architecture.md#application-launch ; AGENTS.md)

**未解决问题**：
- GitHub API 被代理拦截，star/fork（约 211k）仅来自页面渲染与二手文章，未能 API 复核
- SDK InitializeParams 完整字段（是否含 cwd/profile）未读 src/types.ts 原文，仅从 Python 文档反推
- ACP session/update 的 stopReason 映射与 context usage 字段名未核实
- Web host HTTP API（Typert RPC）是否可作为稳定远程接入面，文档无承诺
- 单个 sdk/acp 进程承载多群会话的并发上限与资源模型无文档
- 社区 token 消耗数据口径不一致（47.6K vs 4.5K；88K vs 650K），需自测
- 官方 Docker 镜像 / 远程沙箱（E2B POC）在生产的可用性未知

## T06 "opendesk" 是什么 + 通用 Harness API 的先行者
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T06-opendesk-and-universal-harness-api.md

**摘要**："opendesk"无法确认为Agent引擎：唯一命中的vitalops/opendesk是Computer-Use MCP工具服务器（约86 stars），Harness-Bench、best-of榜单(160+项)、Tencent Cloud对比均无此名，推测为OpenHands/OpenClaw误写或内部代号，需澄清。通用Harness API分两路线：(a)库级适配器openharness.ai(jeffrschneider/OpenHarness, MIT)适配Letta/Goose/Deep Agents，Claude Code CLI仅为aspirational，其Capability Manifest(11 domain×{supported,operations,limitations}+501)与统一事件词汇最值得复用；(b)进程级网关HarnessRouter(Apache-2.0, 2026-08-14开源)+UHP 2026-08-11：Responses同形/v1/responses+SSE+previous_response_id驱动Claude Code/Codex/Pi/DSH/Hermes上游CLI，harness/task/session三层、per-session OS用户隔离、63项conformance分三档，与赛题形态几乎重合。HKUDS与AgentBoardTT是Claude Code重实现，印证四态权限/SKILL.md/hooks已成事实标准。建议：三层对象+Responses同形API为稳定上层，manifest做能力协商，memory/subagent放extensions，认证=跑conformance。

**接入面**：UHP/HarnessRouter：HTTP，OpenAI Responses同形 `POST /v1/responses {input, model, metadata.harness_id, stream}` + SSE，`previous_response_id`续聊，`GET /v1/harnesses`发现，harness CRUD(base/model/instructions/limits/skills/MCP/disabled tools)，Docker `-p 127.0.0.1:3000:3000 -v harnessrouter:/data`，env `HR_AUTH_USER/HR_AUTH_PASSWORD/HR_SECRET_GLOBAL_HARNESS_CONN_*`，conformance CLI `uhp-conformance --base-url --api-key --class core|extended|full`。Open Harness：REST `https://api.openharness.org/v1` Bearer + SSE/WebSocket/Webhook，`GET /harnesses/{id}/capabilities`，ExecuteRequest/RegisterToolRequest/ConnectMcpServerRequest，语言包 `@openharness/adapter-anthropic-agent`、`openharness-letta/goose/deepagent`。AgentBoardTT：Python `harness.run(...)` 异步迭代。HKUDS：CLI `oh -p "..."` headless、`ohmo gateway start`。vitalops/opendesk：MCP server `{"mcpServers":{"opendesk":{"command":"opendesk-mcp"}}}`，`opendesk pair/pair-with/serve`，工具参数 `peer=`。

**公共能力**：单轮任务执行 sync/stream/cancel（input, model, stream, timeout）；session create/resume/history（session_id / previous_response_id / --resume）；权限模式四态 default/accept_edits/plan/bypass（Claude Code系事实标准）；MCP服务器挂载（mcp_servers[]{name, transport, command/url}）；Skills：SKILL.md目录资产（格式微差可用harness-loom式编译器抹平）；文件输入/工件输出（attachments[], artifacts[]）；统一事件流 text/thinking/tool_call_start|delta|end/tool_result/artifact/progress/error/done；能力清单发现 GET /engines/{id}/capabilities + 501语义；错误信封 {error:{type,code,message}} 与幂等键

**扩展能力**：session fork / named / read-only share（UHP Full级可选，多数引擎❌）；工具级审批回传 prompt/stdin/permission request（Open Harness WS有，UHP未定义）；Hooks PreToolUse/PostToolUse/Stop（仅Claude Code系）；Memory blocks/archival/search（仅Letta原生，CLI型需网关模拟渲染进instructions）；Subagents/team/delegation（Claude Code Task、HKUDS team registry、Deep Agents各异，透传engine_options）；运行时多模型切换 model_switch（Claude Code❌）；Planning/todos任务追踪（Deep Agent✅，其余⚠️）；Agent lifecycle create/clone/export/import（仅Letta）；Computer-use工具（vitalops/opendesk作为MCP资产，远端peer=）；工作流录制与定时调度（opendesk learn/schedule）

**设计启示**：
- 采用UHP的harness(配置)/task(一次运行)/session(跨task对话)三层对象模型；群助手场景=群↔session绑定表，每条群消息一个task，previous_response_id保证连续性，per-session OS用户/workspace保证隔离
- 上层接口对齐OpenAI Responses形态（SSE + previous_response_id + metadata扩展），已有SDK/流解析器零改动；引擎私有能力全部放metadata/extensions，永不改变既有字段语义
- 能力协商采用Open Harness式Capability Manifest：按domain声明{supported, operations[], limitations[]}，不支持返回501；网关按manifest做fail-fast/降级/feature flag，LLM元编排层可直接读manifest决定路由
- 赛题引擎(pi/opencode/hermes/dsh)均为CLI/进程型，库级SDK适配路线已被openharness.ai证明走不通（Claude Code CLI至今aspirational）；应选HarnessRouter式进程网关：上游CLI首启安装、版本钉死、子进程运行、事件解析器映射到公共词汇
- '认证'环节=运行conformance套件并按class授予接入等级；重点检查渐进流(S-09)与真取消(C-03)，这是最常见的适配缺陷
- memory与subagent是差异最大的域，UHP选择不定义而保持稳定；我们的v1协议应把它们放extensions，只做能力标记+参数透传，不归一化执行语义
- 警惕'通用API'退化为'某一家的API'：Open Harness每个domain只有一家全✅（覆盖率24%-59%）；公共能力准入标准应是'多数引擎可原生实现'
- 统一资产模型可借鉴harness-loom：一份canonical资产源(.harness/loom/)编译为各引擎原生配置(CLAUDE.md/AGENTS.md/skills/hooks)，而非要求引擎读统一格式
- opendesk若按字面接入只能得到一个MCP工具，不满足'接入一种引擎'口径；方案中标注待澄清并准备OpenHands/OpenClaw适配器兜底

**关键事实**：
- [high] agent语境下唯一命中的开源'opendesk'是vitalops/opendesk：Computer-Use框架，以MCP server(opendesk-mcp)接入Claude Code/Cursor，含screenshot/ui/mouse/keyboard/ocr/learn/schedule工具与X25519+ChaCha20多机远控，MIT，约86 stars (https://github.com/vitalops/opendesk)
- [medium] Harness-Bench论文、best-of-Agent-Harnesses(160+项目)、Tencent Cloud五harness对比文均未出现'opendesk'，推测赛题所指为OpenHands/OpenClaw误写或内部代号 (https://arxiv.org/html/2605.27922v1 ; https://github.com/RyanAlberts/best-of-Agent-Harnesses ; https://www.tencentcloud.com/techpedia/147665)
- [high] openharness.ai = jeffrschneider/OpenHarness (MIT)，适配Letta/Goose/LangChain Deep Agent/Anthropic Agent SDK；仓库矩阵将Claude Code CLI标为aspirational('No public API')，与官网称其为production adapter不一致 (https://raw.githubusercontent.com/jeffrschneider/OpenHarness/main/spec/HARNESS_SUPPORT_MATRIX.md ; https://openharness.ai/)
- [high] Open Harness Capability Manifest v0.1.0：GET /harnesses/{harnessId}/capabilities 返回按domain(agents/skills/mcp/execution/sessions/memory/subagents/files/hooks/planning/models)的{supported,operations[],limitations[]}，不支持操作返回501，协商策略fail-fast/graceful degradation/feature flags (https://raw.githubusercontent.com/jeffrschneider/OpenHarness/main/spec/CAPABILITY_MANIFEST.md)
- [high] Open Harness API v0.2.0事件词汇：text/thinking/tool_call_start/tool_call_delta/tool_call_end/tool_result/artifact/progress/error/done；WS会话client→message/stdin/cancel，server→text/tool_call/stdout/prompt/done；ExecuteRequest{harnessId,message,agent_id,skills[],model,max_tokens,temperature} (https://openharness.ai/api-reference.html)
- [high] HarnessRouter (Apache-2.0) 于2026-08-14开源Community Edition并发布Unified Harness Protocol版本2026-08-11；单Docker容器端口3000、SQLite+volume，首启安装Claude Code/Codex/Pi/DSH/Hermes五个CLI（日志：backends available: claude codex hermes pi dsh），官网另列OpenCode/Qwen Code/Cline共8个 (https://raw.githubusercontent.com/HarnessRouter/harnessrouter/main/README.md ; https://harnessrouter.ai/open-source ; https://aijourn.com/harnessrouter-open-sources-the-worlds-first-unified-interface-for-agent-harnesses-and-the-unified-harness-protocol/)
- [high] UHP任务面刻意与OpenAI Responses API同形：POST /v1/responses {input, model, metadata.harness_id, stream}，SSE流最后事件携带完整response含artifacts，续聊用previous_response_id，扩展只放metadata与少量附加字段 (https://unifiedharnessprotocol.org/ ; https://raw.githubusercontent.com/HarnessRouter/harnessrouter/main/protocol/README.md)
- [high] UHP有10个规范章节(Architecture/Lifecycle/Harnesses/Tasks/Streaming/Sessions/Files/Errors/Security/Schema)、OpenAPI 3.1+JSON Schema 2020-12、63项conformance检查分Core(40)/Extended(+8)/Full(+15)；S-09要求流渐进、C-03要求取消真正终止 (https://raw.githubusercontent.com/HarnessRouter/harnessrouter/main/protocol/conformance/README.md)
- [high] HarnessRouter隔离模型：容器root启动后降权，每session一个OS用户独占workspace，agent进程环境不含产品secret；provider连接HR_SECRET_GLOBAL_HARNESS_CONN_*与per-backend …POLICY_CLAUDE/CODEX/HERMES策略绑定；Claude Code与hermes因许可不能打进镜像只能首启下载，DSH版本钉死 (https://raw.githubusercontent.com/HarnessRouter/harnessrouter/main/README.md)
- [high] HKUDS/OpenHarness (MIT, v0.1.0 2026-04-01, 页面显示15.6k stars)：Python重实现Claude Code式harness，13子系统、43+工具、权限Default/Auto/Plan、MEMORY.md、Coordinator团队子agent；Ohmo通过`ohmo gateway start`接入Feishu/Slack/Telegram/Discord (https://github.com/HKUDS/OpenHarness)
- [high] AgentBoardTT/openharness (MIT, 页面显示12 stars)：harness.run(task, provider, model, permission_mode∈{default,accept_edits,plan,bypass}, max_turns)异步产出TextMessage/ToolUse/Result，JSONL持久session，4子agent general/explore/plan/review (https://github.com/AgentBoardTT/openharness)
- [high] Harness-Bench (arXiv 2605.27922, 2026-05-27)：106任务、5194轨迹、6个harness(OpenClaw/ZeroClaw/Hermes/Moltis/NullClaw/NanoBot)+Codex、8模型；指标Completion/Security(门控)/Process(Robustness+Tool Use+Consistency)/Efficiency；主张按model-harness配置报告能力 (https://arxiv.org/abs/2605.27922 ; https://arxiv.org/html/2605.27922v1)
- [medium] harness-loom (KingGyuSuh, 2026-04-20)：非引擎而是配置工厂，.harness/loom/一份canonical规则派生Claude/Codex/Gemini三家CLI原生配置 (https://dev.to/kinggyusuh/open-sourcing-my-personal-ai-agent-harness-for-production-harness-loom-3mob)
- [high] Open Harness支持矩阵显示各domain仅一家全✅（memory仅Letta、subagents仅Deep Agent、hooks仅Claude Code），覆盖率24%-59%，session fork几乎无人原生支持 (https://raw.githubusercontent.com/jeffrschneider/OpenHarness/main/spec/HARNESS_SUPPORT_MATRIX.md)

**未解决问题**：
- 赛题'opendesk'的真实指代：vitalops/opendesk工具、OpenHands/OpenClaw误写、还是主办方内部引擎代号
- UHP streaming.md/lifecycle.md的具体事件名、GET /v1/harnesses返回体的capability字段结构、是否定义工具级审批——需读protocol/versions/2026-08-11/*.md与schema/uhp-2026-08-11.openapi.yaml
- HarnessRouter CE对OpenCode/Qwen Code/Cline的支持是否已落地（官网8个 vs 容器日志5个 vs README正文3个）
- Open Harness的OAF(Open Agent Format)是否有正式spec；api.openharness.org是否真实可用
- 各项目star数仅为页面快照，GitHub API本环境返回空未能核验
- HKUDS/OpenHarness的ohmo gateway如何做群/频道→session映射与隔离，与赛题群助手最接近，值得单独调研
- UHP与ACP的关系为推测：所抓页面均未提及ACP，二者层次不同(产品↔多harness网关 vs 客户端↔单agent进程)可叠加，需验证pi/opencode的ACP实现能否作为网关下行驱动

## T07 OpenAI Codex CLI / SDK / app-server 协议
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T07-openai-codex.md

**摘要**：Codex 是 Rust 内核的编码 Agent，三层接入面：codex exec --json（JSONL、resume、--output-schema）、@openai/codex-sdk（exec 进程封装，startThread/resumeThread/run/runStreamed）、codex app-server（长驻 JSON-RPC 2.0，thread/start|resume|fork、turn/start|steer|interrupt，审批为 server→client 请求 item/commandExecution|fileChange/requestApproval，决策 accept/acceptForSession/decline/cancel 等）。会话持久化为 ~/.codex/sessions rollout JSONL + SQLite 索引，支持 resume/fork/revert/compact。权限 = sandbox_mode × approval_policy × permission profiles；沙箱 Seatbelt/bwrap+seccomp/Windows。扩展：AGENTS.md、config.toml、hooks.json（12 事件）、SKILL.md、Plugins、MCP client/server、dynamicTools。记忆：用户级 Memories、thread/goal、inject_items。多 Agent v2 spawn_agent 族与父子线程；Symphony 为开源编排规范。可观测：事件流 + [otel] OTLP + LOG_FORMAT=json。网关应以 app-server 为主接口，注意协议实验性、trusted project 副作用与容器内沙箱退化。

**接入面**：主接口：codex app-server（JSON-RPC 2.0 over stdio/unix socket/ws），initialize→thread/start|resume|fork→turn/start→通知流；审批 item/*/requestApproval 请求-响应；thread/list|read|turns/list 检索；dynamicTools 注入客户端工具；config/-c 覆盖；generate-json-schema 做协议指纹。降级：codex exec --json（JSONL，resume <id>，--output-schema）与 @openai/codex-sdk（TS/Python，exec 封装）。另有 codex mcp-server 把 Codex 暴露为 MCP server。

**公共能力**：session.create/resume/fork (thread/start|resume|fork; exec resume)；turn.run/stream/interrupt/steer (turn/start, item/* 通知, turn/interrupt, turn/steer)；event 归一化 (turn.*/item.* 事件；exec snake_case vs app-server camelCase)；审批/权限 (approval_policy × sandbox_mode × permission profiles; requestApproval 四态决策)；结构化输出 (--output-schema / SDK outputSchema)；工具扩展 MCP client ([mcp_servers.*]) 与 dynamicTools；指令与资产 (AGENTS.md, SKILL.md, hooks.json, config.toml)；用量与可观测 (usage/tokenUsage, [otel] OTLP, rollout JSONL, LOG_FORMAT=json)；记忆 (AGENTS.md 静态 + Memories + thread/inject_items)；模型/Provider 选择 (model/list, [model_providers.*], model_reasoning_effort)

**扩展能力**：codex.multi_agent_v2: spawn_agent/send_message/wait_agent/close_agent/followup_task/spawn_agents_on_csv, [agents] max_threads/max_depth, 父子 thread (parentThreadId)；codex.guardian: approvals_reviewer=auto_review 自动风险审核, thread/approveGuardianDeniedAction；codex.permission_profiles 与 execpolicy/network policy amendment 持久化；codex.network_proxy 域名 allow/deny 策略；codex.thread_goal (objective + tokenBudget) 与 queued turns；codex.review (review/start 内置 reviewer) 与 collaborationMode 预设；codex.realtime 语音会话 thread/realtime/*；codex.host_tools: command/exec, process/spawn, fs/*, fs/watch；codex.plugins marketplace 与 ChatGPT Apps；codex.cloud 与 Symphony 编排规范；codex.mcp_server (作为 MCP server 暴露)

**设计启示**：
- 网关适配层应以 app-server 长驻进程为主接口：一个进程多 thread，每 thread 独立 cwd/sandbox/environments，天然对应群→session 映射与隔离；exec/SDK 只作无审批批处理的降级路径。
- 把 Codex 的审批请求（item/commandExecution|fileChange/requestApproval）映射为网关统一四态 allow/allow_session/deny/cancel，Codex 特有的 execpolicy/network amendment 作为 codex.* 扩展决策暴露。
- 能力识别流程可完全在线完成：initialize(userAgent) → model/list(multiAgentVersion, reasoning efforts) → experimentalFeature/list + permissionProfile/list + configRequirements/read → skills/list + mcpServerStatus/list + plugin/list，并用 generate-json-schema 生成协议指纹做版本回归。
- 多租户必须隔离 CODEX_HOME（或 --ignore-user-config）：thread/start 会写用户 config.toml 的 trusted projects，Memories 是用户级而非 thread 级，rollout/sqlite 也在 HOME 下。
- 事件归一化要同时覆盖 exec 的 snake_case 与 app-server 的 camelCase 两套命名，并将 turn/completed.tokenUsage、item 状态、OTel 导出统一到网关的可观测协议。
- 容器化部署时 Linux 沙箱(bwrap/seccomp)通常不可用，需由容器提供隔离并使用 danger-full-access，权限控制退化到网关侧（approval_policy + hooks PreToolUse 拦截）。
- 自定义/OSS 模型接入只支持 Responses wire API，需 Responses 兼容代理；结构化输出仅限 gpt-5 系列且与 resume 互斥，编排层需按节点选择。

**关键事实**：
- [high] @openai/codex-sdk 最新版 0.153.2（2026-09-03），alpha 0.154.0；SDK 本质是 spawn `codex exec --experimental-json` 并通过 stdin/stdout 交换 JSONL (https://registry.npmjs.org/@openai/codex-sdk ; https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/exec.ts)
- [high] codex exec --json 事件类型为 thread.started/turn.started/turn.completed/turn.failed/item.started/item.updated/item.completed/error；item 类型 agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, todo_list, error；usage 含 input_tokens/cached_input_tokens/cache_write_input_tokens/output_tokens/reasoning_output_tokens (https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/events.ts ; https://learn.chatgpt.com/docs/non-interactive-mode)
- [high] codex exec resume <SESSION_ID> / resume --last 可续接无头会话；--output-schema 需 gpt-5 系列且不能与 resume 同用；--full-auto 已 deprecated (https://learn.chatgpt.com/docs/non-interactive-mode)
- [high] app-server 支持 --listen stdio:// (默认) / ws://IP:PORT (实验，附 /readyz /healthz) / unix://PATH / off；可用 codex app-server generate-ts|generate-json-schema 生成协议 schema (https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md ; https://learn.chatgpt.com/docs/app-server)
- [high] app-server 生命周期：initialize(clientInfo, capabilities.experimentalApi) → thread/start|resume|fork → turn/start(threadId,input[]) → 通知 turn/started, item/started, item/agentMessage/delta, item/completed, turn/completed(tokenUsage)；turn/interrupt、turn/steer；背压错误 -32001 (https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md)
- [high] 审批为 server→client JSON-RPC 请求 item/commandExecution/requestApproval 与 item/fileChange/requestApproval，响应 {decision: accept|acceptForSession|acceptWithExecpolicyAmendment|applyNetworkPolicyAmendment|decline|cancel}，随后 serverRequest/resolved 与 item/completed(status completed|failed|declined)；v1/MCP 接口名为 execCommandApproval/applyPatchApproval (https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md ; https://raw.githubusercontent.com/openai/codex/main/codex-rs/docs/codex_mcp_interface.md)
- [high] approval_policy 取值 untrusted|on-request|on-failure|never（另支持粒度表）；sandbox_mode 取值 read-only|workspace-write|danger-full-access；workspace-write 默认关闭网络，.git/.agents/.codex 受保护 (https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/src/threadOptions.ts ; https://learn.chatgpt.com/docs/config-file/config-reference ; https://learn.chatgpt.com/docs/agent-approvals-security)
- [high] 沙箱实现：macOS Seatbelt(sandbox-exec)，Linux bwrap+seccomp，Windows 原生沙箱/WSL2；Docker 内建议容器隔离并 --sandbox danger-full-access (https://learn.chatgpt.com/docs/agent-approvals-security)
- [medium] 会话 rollout 存于 ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl，行类型 session_meta/response_item/event_msg/turn_context/compacted；SessionMeta 含 id, forked_from_id, parent_thread_id, cwd, cli_version, source, agent_role, model_provider, memory_mode 等；SQLite state_5.sqlite 索引 (https://raw.githubusercontent.com/openai/codex/main/codex-rs/protocol/src/protocol.rs ; https://deepwiki.com/openai/codex/3.5.2-rollout-persistence-and-replay)
- [high] Hooks 事件：SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, PreCompact, PostCompact, Stop, SubagentStart, SubagentStop, Interrupt；配置于 ~/.codex/hooks.json 与 <repo>/.codex/hooks.json；handler type command，timeout 默认 600s；exit 2 = block (https://learn.chatgpt.com/docs/hooks)
- [high] Memories 默认关闭，[features] memories=true 开启，存 ~/.codex/memories/，开关 memories.use_memories 与 memories.generate_memories；app-server 有 thread/memoryMode/set (https://learn.chatgpt.com/docs/customization/memories ; app-server README)
- [medium] 多 Agent：features.multi_agent / multi_agent_v2，工具 spawn_agent/send_message/wait_agent/close_agent/followup_task/list_agents/spawn_agents_on_csv，[agents] max_threads(默认 6) max_depth(默认 1)；app-server 中子代理为独立 thread 带 parentThreadId，Parent-owned V2 子代理拒绝直接 turn/start (https://learn.chatgpt.com/docs/config-file/config-reference ; app-server README ; https://codex.danielvaughan.com/2026/04/11/codex-cli-multi-agent-orchestration-v2-complete-guide/)
- [high] OTel 默认关闭：[otel] exporter = none|otlp-http|otlp-grpc，exporter.<id>.endpoint/protocol(binary|json)/headers，log_user_prompt，environment；日志 RUST_LOG 与 LOG_FORMAT=json (https://learn.chatgpt.com/docs/config-file/config-reference ; app-server README)
- [high] 自定义 provider [model_providers.<id>] base_url/env_key/wire_api（仅 responses）/requires_openai_auth；oss_provider = lmstudio|ollama；MCP client [mcp_servers.<id>] command/args/env/url/bearer_token_env_var/enabled_tools/startup_timeout_sec(10s) (https://learn.chatgpt.com/docs/config-file/config-reference)
- [high] Symphony 于 2026-04-27 发布：开源编排规范 SPEC.md + Elixir 参考实现，Apache-2.0，把 Linear 看板作为 Codex agent 控制平面，标注 low-key engineering preview (https://github.com/openai/symphony ; https://openai.com/index/open-source-codex-orchestration-symphony/)
- [high] thread/start 传入 cwd 且沙箱为 workspace-write/full access 时会把该项目写入用户 config.toml 的 trusted 列表；thread/unsubscribe 后无订阅者 60s 卸载（thread_unload_delay_secs） (https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md)

**未解决问题**：
- app-server turn/start 是否有与 --output-schema 等价的结构化输出参数
- 官方 Skills/Subagents/AGENTS.md 文档页 404，Skills 发现顺序、front-matter 字段与内置角色名未一手核实
- Codex Cloud 的编程接口（environment/add + execServerUrl 还是独立 API）未获取一手文档
- rollout 行类型完整枚举（InterAgentCommunication、WorldState）仅来自 DeepWiki 二手
- Linux 沙箱从 Landlock 切换到 bwrap 的版本号
- 多 Agent v2 自定义角色是 [agents.<name>] toml 还是 .codex/agents/*.md，二手说法并存

## T08 Gemini CLI 及其衍生/中文 CLI 引擎（Qwen Code、Kimi CLI、iFlow CLI）
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T08-gemini-cli-qwen-kimi-iflow.md

**摘要**：调研了 Gemini CLI 及其三个衍生/中文 CLI 引擎。Gemini CLI 架构最完整：headless（-p --output-format json/stream-json）+ ACP server（--experimental-acp，stdio JSON-RPC 2.0）双接入面，Policy Engine（allow/deny/ask_user 三态+多维匹配+分层优先级，headless下ask_user自动降级为deny），Subagents（进程内工具隔离委派）与A2A（跨进程远程委派，RFC阶段）双多agent模型，OTel标准遥测，Windows管理员策略路径原生支持。Qwen Code是Gemini CLI fork，多协议模型接入（OpenAI/Anthropic/Gemini/Qwen）更贴合本赛题硬约束，headless会话恢复（--continue/--resume sessionId）与五档审批模式(plan/default/auto-edit/auto/yolo)比Gemini CLI更完整。Kimi CLI正迁移至Kimi Code，ACP优先设计（kimi acp/kimi mcp），存在已知坑（ACP-transport下MCP被静默丢弃、YOLO模式在Zed场景有bug）。iFlow CLI已被官方宣布2026-04-17停运，不建议作为正式候选。

**接入面**：Gemini CLI/Qwen Code提供两种可编程接入面：(1) headless CLI（-p + --output-format json/stream-json，JSONL事件流init/message/tool_use/tool_result/error/result，退出码语义化）可直接映射为网关的prompt_async+message轨迹查询；(2) ACP server模式（--experimental-acp，stdio+JSON-RPC 2.0）可作为需要"长驻会话+实时审批"场景的备选传输层，网关需实现ACP client去桥接。Qwen Code额外提供--resume sessionId的显式会话寻址，与网关GET/DELETE /session/{id}语义天然对齐。权限层面Policy Engine（Gemini CLI系）与approval-mode五档（Qwen Code）是两种不同粒度的归一化目标；headless模式下审批自动降级为deny是关键限制，网关若需真实运行时审批必须走ACP或引擎daemon模式。MCP、GEMINI.md分层记忆、OTel遥测是主要的公共能力归一化点。

**公共能力**：headless prompt执行（-p + JSON/stream-JSON输出，可映射prompt_async/message轨迹）；MCP client支持（工具/数据源扩展，transport支持面各引擎略有差异）；分层记忆文件（GEMINI.md及各引擎的等价物，按目录层级合并注入上下文）；会话/对话检查点或历史保存（形式和寻址能力各引擎不同）

**扩展能力**：Policy Engine细粒度工具级授权（allow/deny/ask_user三态+多维匹配+分层优先级，Gemini CLI系独有且最完整）；Subagents进程内工具隔离型委派（agents/*.md定义）；A2A跨进程远程agent委派协议（contextId/taskId状态维持，RFC阶段）；ACP作为可插拔传输层（stdio+JSON-RPC 2.0，可承载实时审批与流式更新，替代headless CLI满足会话常驻需求）；OpenTelemetry标准化遥测集成（OTLP/gRPC或HTTP，可作为统一可观测层的输入源之一）；approval-mode五档快速权限映射（Qwen Code：plan/default/auto-edit/auto/yolo）

**设计启示**：
- 网关的权限系统应支持两种粒度并存：粗粒度approval-mode枚举（易映射，适配大多数引擎）与细粒度Policy DSL（工具名/参数正则/命令前缀/MCP名/subagent/环境维度，可借鉴Gemini CLI Policy Engine设计一套跨引擎的统一权限策略语言，接入时编译为各引擎的本地格式）
- headless CLI在无头场景下会自动拒绝一切'需要用户确认'的操作（ask_user→deny），若赛题评测环境要求真实的运行时审批交互，网关对Gemini CLI系引擎应优先考虑ACP传输模式而非纯headless CLI包装，或者退化为预先在Policy层放行的静态策略
- ACP协议（stdio+JSON-RPC 2.0）正呈现'事实标准'趋势（Gemini CLI/Qwen Code/Kimi CLI/OpenCode均支持），可作为网关到引擎的第二套传输后端：当引擎headless协议无法满足会话常驻+实时事件推送需求时切换到ACP client桥接，把ACP消息映射为网关自身的SSE事件
- GEMINI.md等分层记忆文件应作为网关'记忆资产'类型的一等公民，新引擎接入只需配置'文件名+加载层级规则'映射表，无需改变上层记忆接口契约
- Windows部署优先级：Gemini CLI官方文档明确列出Windows管理员Policy路径，说明该引擎系对Windows有一定原生考虑；但Qwen Code因多协议模型接入（尤其OpenAI/Anthropic兼容端点为一等公民）更贴合本赛题'内部部署模型'硬约束，建议在Windows评测环境下优先验证Qwen Code而非原生Gemini CLI作为该系代表引擎
- 候选引擎的可持续性尽职调查同样重要：iFlow CLI已官方停运（2026-04-17），Kimi CLI正在向Kimi Code迁移过渡期，二者的资料时效性风险需在架构文档中明确标注，避免赛后维护性风险
- OTel应作为网关统一可观测层的首选归一化输入协议之一（而非发明私有日志格式），因为Gemini CLI系已提供标准OTLP导出，天然可插拔进任何OTel后端

**关键事实**：
- [high] Gemini CLI headless模式：-p/--prompt触发，--output-format json（单对象，含response/stats/error字段）或stream-json（JSONL，事件类型init/message/tool_use/tool_result/error/result），退出码0成功/1一般错误/42输入错误/53超回合限制 (https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md)
- [high] Gemini CLI --experimental-acp启动ACP server模式，stdio+JSON-RPC 2.0，被Zed/IntelliJ驱动；忘记该flag会导致CLI挂起在交互式终端 (https://geminicli.com/docs/cli/acp-mode/ , https://zed.dev/acp/agent/gemini-cli)
- [high] Gemini CLI Policy Engine三态决策allow/deny/ask_user，ask_user在headless/非交互模式下被当作deny处理 (https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md)
- [high] Policy Engine规则匹配字段含toolName通配符、argsPattern正则、commandPrefix/commandRegex、mcpName、subagent、工具注解、交互/非交互环境；优先级=tier_base+toml_priority/1000 (https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md)
- [high] Policy配置路径含Windows管理员层C:\ProgramData\gemini-cli\policies，有严格属主校验，可用--admin-policy追加路径 (https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md)
- [high] Gemini CLI Subagents通过agents/*.md定义，实现工具隔离与细粒度权限，是预览特性 (https://developers.googleblog.com/subagents-have-arrived-in-gemini-cli/)
- [medium] Gemini CLI通过A2A协议支持远程agent委派：RemoteAgentInvocation工具类型，agents.toml中kind="remote"声明，用contextId/taskId维持状态，官方RFC提议A2A成为未来所有集成的标准协议 (https://github.com/google-gemini/gemini-cli/pull/16013 , https://github.com/google-gemini/gemini-cli/discussions/7822)
- [high] Gemini CLI OTel集成通过.gemini/settings.json的telemetry对象配置，支持OTLP/gRPC或OTLP/HTTP，官方提供一键脚本搭建local(otelcol+Jaeger)或gcp目标 (https://geminicli.com/docs/cli/telemetry/)
- [high] Qwen Code基于Gemini CLI v0.8.2 fork，现支持OpenAI/Anthropic/Gemini/Qwen多协议API及本地模型(Ollama/vLLM)，原生支持ACP与headless (https://github.com/QwenLM/qwen-code)
- [high] Qwen Code headless支持--continue续接最近会话、--resume [sessionId]恢复指定会话、--approval-mode plan|default|auto-edit|auto|yolo五档审批、--max-session-turns/--max-wall-time/--max-tool-calls预算控制 (https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/)
- [high] Kimi CLI官方README已声明正向Kimi Code CLI(MoonshotAI/kimi-code)迁移，旧项目将逐步停用；新项目提供kimi acp（ACP server子命令）与kimi mcp（MCP管理子命令） (https://github.com/MoonshotAI/kimi-cli README , https://moonshotai.github.io/kimi-code/en/guides/ides)
- [high] Kimi CLI在ACP transport下声明的MCP servers会被静默丢弃；GitHub Issue #1542指出ACP/Zed场景下YOLO模式不受支持、API错误时静默失败 (https://moonshotai.github.io/kimi-code/en/guides/ides , https://github.com/MoonshotAI/kimi-cli/issues/1542)
- [medium] iFlow CLI官方宣布维护于2026-03-20结束，服务于2026-04-17（北京时间）正式关停，官方推荐迁移至Qoder (https://linux.do/t/topic/1786495 , https://platform.iflow.cn/en/cli/changelog)

**未解决问题**：
- Gemini CLI原生headless CLI是否支持类似--resume sessionId的无头会话恢复（本次仅确认交互式/chat resume <tag>，未确认headless层面等价能力）
- Gemini CLI/Qwen Code是否存在类似opencode的常驻HTTP server模式，还是只有CLI单次调用+ACP stdio两种形态，这直接决定网关适配层的进程管理策略
- Qwen Code的ACP支持是否使用与Gemini CLI完全相同的--experimental-acp flag命名
- Kimi Code在无IDE场景下的headless编程接入面（JSON输出schema、退出码、错误处理）具体字段未获一手资料确认
- Qwen Code、Kimi Code是否支持OpenTelemetry或类似标准化可观测协议
- iFlow CLI停运后其残留代码/文档是否仍值得作为架构参考（如多模型路由设计）

## T09 其他主流编码引擎接入面速览（Goose、Aider、Cline、Roo/Kilo、Amp、Cursor CLI、Copilot CLI/SDK、Droid、Crush、Auggie）
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T09-other-coding-engines.md

**摘要**：调研了 Goose、Aider、Cline、Kilo Code、Amp、Cursor CLI、Copilot CLI/SDK、Factory Droid、Charm Crush、Auggie 十个引擎的可编程接入面。核心发现：ACP 正成为收敛点（Goose 2.0 全面转向 ACP 并计划废弃自建 goosed server；Kilo 原生 `kilo acp`），但 Amp、Crush 仍靠第三方桥接或未确认合并；Amp 的 stream-json 与 Claude Code 协议兼容，是第二个隐性收敛点；权限模型颗粒度差异大（Goose 四态 vs Cline 脚本网关），建议只归一化"自动/需确认"两档；Goose Recipe、Cline Workflows/MCP Marketplace 是统一资产模型的参照对象；多数引擎已证实支持自定义 OpenAI 兼容端点/BYOK，满足赛题硬约束。报告含公共能力/扩展能力映射表、接入参数建议、6 项未解决问题。

**接入面**：十个引擎的接入面分三类：(1)已原生支持ACP协议(Goose 2.0、Kilo Code)，可用统一ACP-adapter层接入；(2)自定义headless JSON/NDJSON协议但未上ACP(Amp、Cursor CLI、Droid、Cline)，需各自写协议转换器，其中Amp/Cursor/Droid的事件schema三段式(system/assistant/tool_call)高度相似可复用转换逻辑；(3)无标准协议纯CLI(Aider、Auggie、Crush)，需要适配层自建session registry并解析终端输出。多数引擎支持自定义OpenAI/Anthropic兼容endpoint或BYOK，满足赛题内部模型约束。

**公共能力**：headless一次性执行(-p/-x/exec/run)可统一映射为网关prompt_async；NDJSON/JSONL事件流归一化后可映射为赛题要求的message轨迹(user/assistant/tool call/tool result/step-finish)；会话续接(resume/continue/session id)可映射为网关session到引擎session/thread id的持久化表；权限二态(自动执行 vs 需确认)可作为公共基线；MCP扩展机制几乎所有引擎都支持，是天然的公共能力锚点

**扩展能力**：Goose smart_approve(LLM风险分类器)与四态权限模式；Goose Recipe/Sub-Recipe(YAML工作流资产)；Cline Team(共享看板/agent间邮箱/mission log多agent协作)、hook-command策略网关、cron调度；Amp Oracle强推理子代理与/handoff线程移交；Kilo Orchestrator Mode编排、fork/cloud-fork会话分叉；Crush对AGENTS.md标准的原生支持；Auggie反向暴露自身为MCP server供其他引擎调用；Copilot SDK内置OpenTelemetry追踪

**设计启示**：
- ACP正成为跨引擎收敛协议，但收敛程度不均：Goose/Kilo原生支持，Amp/Crush仅靠第三方桥接或未确认，不能假设'支持ACP'等于开箱即用，需以官方CHANGELOG二次确认
- Amp的stream-json与Claude Code协议兼容是第二个隐性收敛点，说明'Claude-Code兼容JSONL'可作为我们统一观测协议的候选基线格式，能降低多个引擎的适配成本
- 权限模型颗粒度差异巨大(Goose四态 vs Cline任意脚本网关)，网关层应只归一化'自动/需确认'两档最小公共分母，细粒度策略作为引擎扩展参数透传，不要在网关层强行统一语义
- Goose Recipe(YAML: instructions+extensions+params)和Cline Workflows/MCP Marketplace是设计统一AI资产/插件模型时的具体范式参照，Crush对AGENTS.md的原生支持提示可考虑复用该标准
- 多agent/team协作差异极大(Cline Team vs Amp Oracle+Subagents vs Kilo Orchestrator Mode)，不建议在v1做归一化，应作为引擎特有扩展能力单独声明配置参数
- 会话语义差异大，Aider没有真正session对象，接入这类引擎时必须在适配层自建session registry模拟赛题要求的POST /session接口，不能假设引擎原生提供session id
- 多数引擎(Copilot SDK、Cursor、Amp)已证实支持自定义OpenAI/Anthropic兼容端点或BYOK，满足赛题内部模型硬约束，但计费/额度限制(如Amp ACP桥接仅付费可用)可能伪装成技术限制，需要在评测沙箱中提前验证

**关键事实**：
- [high] Goose 项目治理已于2026年4月从 Block 转移给 Agentic AI Foundation (AAIF)，仓库变为 aaif-goose/goose (github.com/block/goose Discussion #7309; aaif.io blog)
- [high] Goose 2.0 架构统一收敛到 ACP，计划移除旧 goosed（Axum REST+SSE，103端点）与旧 Rust CLI (goose-docs.ai/blog/2026/04/08/goose-acp-and-new-tui/)
- [high] Goose 提供四态权限模式 auto/approve/smart_approve/chat，smart_approve 用 LLM 分类器 PermissionJudge 判断风险 (goose-docs.ai/docs/guides/goose-permissions/)
- [high] Kilo Code CLI 原生支持 kilo acp 子命令，ndjson over stdio，与 Hermes/Devin/Kimi CLI 并列为 ACP agent (kilo.ai/docs/code-with-ai/platforms/cli-reference; zed.dev/acp/agent/kilo)
- [medium] Amp 的 -x --stream-json 输出采用与 Claude Code 兼容的 JSONL 协议（type discriminator: system/assistant/tool_use） (littlebearapps.com AMP stream-json cheatsheet)
- [high] Amp 官方不原生支持 ACP，第三方 acp-amp 桥接要求付费额度，免费额度不可用 (github.com/SuperagenticAI/acp-amp)
- [high] GitHub Copilot SDK 2026-06-02 GA，通过 JSON-RPC 与 Copilot CLI 通信，内置 OpenTelemetry，支持 BYOK（OpenAI/Foundry/Anthropic/Ollama等） (github.blog changelog 2026-06-02; docs.github.com BYOK)
- [medium] Cline CLI 于2026-02-13完成从IDE侧边栏到独立终端CLI的重写，支持--json无头输出、--hook-command策略网关、--team-name多agent协作(共享看板/邮箱) (cline.bot/cli)
- [high] Cursor CLI (cursor-agent -p) 支持 --output-format text|json|stream-json，stream-json为NDJSON含system/assistant/tool_call事件 (cursor.com/docs/cli/headless; cursor.com/docs/cli/reference/output-format)
- [medium] Factory Droid的droid exec支持--stream-jsonrpc，第三方droid-acp项目用它作为ACP adapter传输层；支持droid.load_session恢复会话 (docs.factory.ai/droid-exec/overview; github.com/yaonyan/droid-acp)
- [medium] Charm Crush使用FSL-1.1-MIT许可证（非OSI认证），社区正讨论/实现ACP支持但未确认已合并 (github.com/charmbracelet/crush licenses; issues #990/#2091)
- [high] Aider无原生session对象，靠--message一次性调用+外部适配层按工作目录维护chat history模拟会话隔离 (aider.chat/docs/scripting.html; GitHub issue #4923)
- [medium] Cursor可通过Override OpenAI Base URL配置自定义OpenAI兼容端点 (WebSearch结果汇总官方设置说明)

**未解决问题**：
- Crush官方是否已经/何时正式合并ACP支持(client端还是agent端)，需查charmbracelet/crush最新CHANGELOG/release notes
- Cursor CLI官方权限/审批模型及--output-format stream-json完整event schema字段清单需要直接抓取官方文档原文核实
- Goose 2.0的ACP-over-HTTP/WS transport最终端口号与URL路径规范未公开，需跟踪aaif-goose/goose Issue #6642后续更新
- Amp官方execute-mode文档页被登录墙拦截，未获得官方一手完整参数表，仅通过第三方cheatsheet交叉验证
- 十个引擎是否有独立于session历史之外的长期语义记忆/检索式记忆能力，本次检索未发现一手证据
- Factory Droid、Auggie的细粒度权限审批(allow-list/deny-list配置)未深入核实，需补充查证官方权限专题页

## T11 OpenClaw（openclaw/openclaw）网关架构深度调研
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T11-openclaw.md

**摘要**：OpenClaw（MIT，2026.8.1）是单进程 Node 的个人 AI 助手网关：一个 Gateway 同时提供多渠道接入、会话路由/存储、内置 agent runtime、Control UI、WS RPC（端口 18789，req/res/event 帧，协议 v4，operator/node/worker 角色+scope）、可选 OpenAI 兼容 HTTP（/v1/chat/completions、/v1/responses，默认关闭）和 cron/heartbeat/webhook。会话以字符串 key 标识（agent:<id>:main、agent:<id>:<channel>:group:<gid>、subagent/acp 等），dmScope/groupScope/identityLinks/bindings 控制隔离，群聊默认 mention gating，lanes+steer/followup/collect/interrupt 排队，SQLite database-first 存储，daily/idle reset。多 agent 由 agents.entries+bindings（most-specific wins）路由，sessions_send/spawn 通信。核心发现：OpenClaw 已是"网关+harness 注册表"——内置 runtime id openclaw（源于 pi，2026.8 已内化为 @openclaw/agent-core，pi 仅为别名）、插件 harness（codex）、以及 @openclaw/acpx 驱动的 ACP 外部 harness（Claude Code/Codex/Gemini CLI/opencode/cursor/copilot/droid/pi），按 agentRuntime.id 或 runtime.type:"acp" 选择。权限分层 dmPolicy→tool policy→Docker sandbox（不包裹 ACP），官方定位一 Gateway 一信任域；2026 年有 CSWSH RCE、pairing 提权、ClawHub 供应链事件。OTel 通过 diagnostics-otel 插件输出。方案 3 最低改造点是给 acpx 注册新 harness id，更深是实现插件 harness。

**接入面**：主接入面：(1) WebSocket RPC ws://host:18789（@openclaw/gateway-client），connect{role:'operator',scopes,auth:{token}} 后调用 chat.send{sessionKey,queueMode,fastMode}、sessions.list/create/send/patch、agents.list/create、config.get/patch、plugins.*，订阅 chat/session.message/session.tool/sessions.changed/presence 事件，支持 traceparent；(2) OpenAI 兼容 HTTP（需开启 gateway.http.endpoints.chatCompletions/responses）：POST /v1/chat/completions、/v1/responses、GET /v1/models，Authorization: Bearer <gateway token>，model:'openclaw/<agentId>'，头 x-openclaw-agent-id / x-openclaw-session-key / x-openclaw-model / x-openclaw-scopes，user 字段派生 session key，SSE 流式；(3) Admin HTTP RPC 插件 POST /api/v1/admin/rpc {id,method,params}；(4) CLI openclaw agent/sessions --json/config set/plugins install/skills install/acp；(5) 作为引擎宿主：agents.entries.<id>.runtime{type:'acp',acp{agent,backend:'acpx',mode,cwd}} 与 agentRuntime.id 选择 harness，sessions_spawn({runtime:'acp'})；(6) Plugin SDK openclaw/plugin-sdk/* 的 definePluginEntry + api.register*；(7) openclaw acp 将 Gateway 反向暴露为 ACP server。鉴权注意：gateway token 等同完整 operator 权限，多租户需多 Gateway 实例或上层网关自行鉴权。

**公共能力**：会话创建/续接/列举：字符串 sessionKey（agent:<id>:<scope>...），chat.send{sessionKey} 或 HTTP x-openclaw-session-key；会话隔离粒度参数化：dmScope(main/per-peer/per-channel-peer/per-account-channel-peer)、groupScope(per-group/main)、identityLinks；会话重置与过期：reset{mode:none|daily|idle,atHour,idleMinutes}、resetByType/resetByChannel、/new /reset；并发排队：queue mode steer/followup/collect/interrupt + cap/drop/debounce，per-session lane 串行；上下文压缩 compaction（/compact，自动，压缩前 memoryFlush）；工具权限：tools.profile/allow/deny/elevated，可按 agent/群/发送者逐层收紧；exec 审批（operator.approvals）；模型路由与故障转移：provider/model 引用，model{primary,fallbacks}，models.providers 自定义 baseUrl/apiKey；流式输出与事件：WS chat/session.message/session.tool 事件，HTTP SSE；记忆：markdown 文件（MEMORY.md/daily notes）+ hybrid 向量检索工具 memory_search/memory_get；技能资产：SKILL.md（agentskills 风格 frontmatter），目录优先级与热更新；可观测：OTel OTLP http/protobuf，GenAI 语义约定指标（gen_ai.client.token.usage），traceparent 透传，harness.run.* 诊断事件；配置：JSON5 单文件严格 schema，${ENV} 与 SecretRef，hot reload

**扩展能力**：ACP 外部 harness 编排：runtime.type:'acp'，harness id 注册表（claude/codex/gemini/opencode/cursor/copilot/droid/pi…），/acp spawn|steer|cancel|close|permissions|model|timeout，运行时选项按后端广告动态映射；插件 harness 注册（src/agents/harness/ 注册表，agentRuntime.id auto 选择，如 codex app-server 原生路径）；多 agent 与路由：agents.entries + bindings（match channel/accountId/peer/guildId/teamId/roles，most-specific wins）；agent 间通信与子代理：sessions_send/sessions_spawn/sessions_history/session_status，tools.agentToAgent.allow，subagents maxConcurrent/maxSpawnDepth，subagent lane；群聊 mention gating 与 groupPolicy、/activation、toolsBySender；Docker sandbox（mode/scope/workspaceAccess/setupCommand），但不包裹 ACP harness；多渠道内置接入（WhatsApp/Telegram/Slack/Discord/Signal/iMessage/Google Chat + 微信/飞书/企微/钉钉/QQ 插件）与渠道插件 SDK；cron / heartbeat / webhook 自动化（hook 会话 agent:<id>:hook:<hookId>，cron lane）；Plugin API：registerTool/Hook/Channel/Provider/GatewayMethod/HttpRoute/Memory/ContextEngine 与 8 个生命周期 hook；记忆扩展：dreaming 后台整合、Honcho/LanceDB 后端、可替换 context engine、memory provenance；设备/节点能力（node 角色：camera/screen/location/voice/talk）、Control UI incognito 会话、ClawHub 技能市场、openclaw acp 反向 ACP server

**设计启示**：
- OpenClaw 自身已是'网关 + harness 注册表'结构（内置 openclaw runtime / 插件 harness / ACP 外部 harness 三层），其 agentRuntime.id + auto 选择策略、以及 ACP 作为外部引擎统一协议的做法，可直接作为我们'引擎适配层'的参考实现；赛题方案 3 的最小改造点是给 acpx 注册新 harness id，深度改造是实现 @openclaw/agent-core 的插件 harness。
- 会话模型可借鉴其字符串 session key 语法（agent:<agentId>:<channel>:group:<gid> 等）与 dmScope/groupScope/identityLinks 的策略参数化：网关层把 业务标识→sessionKey 的映射做成纯函数，引擎只认 key，可跨引擎归一化。
- bindings 的 most-specific-wins 优先级链（peer>父peer>通配>guild+roles>guild/team>account>channel>默认）是业务→agent/引擎路由的成熟范式，可复用为我们的'业务→引擎/能力配置'路由规则。
- ACP 的运行时选项协商（/acp permissions → permissionProfile|approval_policy|permission_mode，thinking → effort|reasoning_effort|thought_level，按后端广告的控制项映射）正是'能力识别与协商'的现成模型：引擎在 spawn 时广告可控项，网关做参数名映射而非硬编码。
- 可观测归一化应以 OTel GenAI 语义约定为公共协议：OpenClaw 的 gen_ai.client.token.usage、openclaw.tool.execution span、harness.run.started/completed/error 事件与 WS 帧 traceparent 透传，说明'trace 由网关注入、引擎沿用'是可行的统一方案。
- 安全边界必须由我们的网关承担：OpenClaw 官方声明一 Gateway 一信任域、token 等同完整 operator 权限、ACP harness 不受其 sandbox 包裹、skills 无沙箱且有供应链事件——多租户隔离需按租户拆 Gateway 实例或在上层做鉴权与工具策略注入，并对接入引擎的版本与插件白名单严格锁定。
- 排队语义是引擎能力差异点：OpenClaw 的 steer（把新消息注入进行中的 turn）不是所有引擎都支持，公共能力应只承诺 queue/interrupt/collect，steer 作为扩展能力按引擎能力协商启用。

**关键事实**：
- [high] Gateway 默认端口 18789，WebSocket 与 HTTP 同端口复用；WS 帧为 {type:req|res|event}，协议版本 4，connect 握手携带 role/scopes/auth.token/device 签名，hello-ok 返回 features/policy (https://docs.openclaw.ai/gateway/protocol ; https://raw.githubusercontent.com/openclaw/openclaw/main/README.md)
- [high] 协议与客户端以 npm 包 @openclaw/gateway-protocol（含 protocol.schema.json）与 @openclaw/gateway-client 发布，稳定版 2026.8.1；package.json version 2026.8.1，license MIT，Node >=22.22.3/24.15/25.9 (https://docs.openclaw.ai/gateway/protocol ; https://raw.githubusercontent.com/openclaw/openclaw/main/package.json)
- [high] OpenAI 兼容端点默认关闭，gateway.http.endpoints.chatCompletions.enabled / responses.enabled 开启；model 字段 openclaw/<agentId> 选 agent，头 x-openclaw-session-key 指定会话，user 字段派生稳定 session key，stream:true 为 SSE；gateway token 等同完整 operator 权限 (https://docs.openclaw.ai/gateway/openai-http-api ; https://raw.githubusercontent.com/openclaw/openclaw/main/docs/gateway/openai-http-api.md)
- [high] session key 形态：agent:<id>:main、agent:<id>:<channel>:group:<gid>、agent:<id>:thread:<rootTs>、agent:<id>:hook:<hookId>、agent:<id>:subagent:<uuid>、agent:<id>:acp:<uuid>；session.dmScope=main|per-peer|per-channel-peer|per-account-channel-peer，groupScope=per-group|main，identityLinks 合并跨渠道身份 (https://docs.openclaw.ai/concepts/session ; https://docs.openclaw.ai/channels/groups ; https://docs.openclaw.ai/concepts/multi-agent)
- [high] Reset 策略 session.reset{mode:none|daily|idle, atHour, idleMinutes}，可按 resetByType/resetByChannel 覆盖，先到先生效；存储为 ~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite（database-first）+ sessions/ 归档 transcript；maintenance{pruneAfter:30d,maxEntries:500} (https://docs.openclaw.ai/concepts/session)
- [high] 排队：messages.queue.mode = steer(默认)|followup|collect|interrupt，cap:20，drop:summarize|old|new，byChannel/debounceMsByChannel；lanes main(min(16,max(8,CPU)))、session:<key>、cron、cron-nested、subagent(8)、nested、background(3) (https://docs.openclaw.ai/concepts/queue)
- [high] 群聊默认 requireMention（channels.<ch>.groups['*'].requireMention），groupPolicy open|allowlist|disabled，messages.groupChat.mentionPatterns 正则补充，/activation mention|always；群级 tools.deny 与 toolsBySender 逐层收紧 (https://docs.openclaw.ai/channels/groups)
- [high] 多 agent：agents.entries.<id>{workspace,agentDir,model,tools,sandbox}；bindings 匹配 channel/accountId/peer/guildId/teamId/roles，优先级 peer>父peer>peer通配>guild+roles>guild/team>account>channel>默认；工具 sessions_send/sessions_spawn/sessions_history/sessions_list/session_status，tools.agentToAgent{enabled,allow}，subagents{maxConcurrent:4,runTimeoutSeconds:300,maxSpawnDepth:3} (https://docs.openclaw.ai/concepts/multi-agent)
- [high] ACP 外部 harness：官方插件 @openclaw/acpx 支持 harness id claude/codex/copilot/cursor/droid/gemini/opencode/fast-agent/iflow/kilocode/kimi/kiro/mux/qoder/qwen/trae/openclaw/pi；配置 acp{enabled,dispatch,allowedAgents,defaultAgent,backend} 与 agents.entries.<id>.runtime{type:'acp',acp{agent,backend,mode:persistent|oneshot,cwd}}，bindings[].type='acp'；sessions_spawn({runtime:'acp',agentId,mode,thread,cwd,resumeSessionId,streamTo,model,thinking}) 与 /acp spawn|steer|cancel|close|permissions|model 等命令；运行时选项按后端广告动态映射（thinking→effort/reasoning_effort，permissions→approval_policy/permission_mode） (https://docs.openclaw.ai/tools/acp-agents)
- [high] OpenClaw 的 sandbox 策略不包裹 ACP harness 执行；被沙箱化的会话不能 spawn ACP；runtime:'acp' 不支持 sandbox:'require'；内部上下文转成纯文本 prompt 发给 harness (https://docs.openclaw.ai/tools/acp-agents)
- [high] 内置 runtime id 为 openclaw，pi 为 legacy alias，codex-app-server 归一为 codex；插件 harness 可注册额外 runtime id；agentRuntime.id 按 model/provider 作用域配置，auto 优先选支持当前 provider 路由的插件 harness，否则回落内置 runtime；代码位于 src/agents/harness/（harness registry）与 packages/agent-core（@openclaw/agent-core） (https://raw.githubusercontent.com/openclaw/openclaw/main/docs/agent-runtime-architecture.md)
- [high] 2026.8.1 主干已不依赖 @mariozechner/pi-agent-core/pi-ai/pi-coding-agent（'no external agent framework packages remain'），仅剩 @earendil-works/pi-tui@0.84.3；src/agents/pi-embedded* 文件已不存在；早期（2026-01）曾嵌入 pi 的 createAgentSession() (https://raw.githubusercontent.com/openclaw/openclaw/main/docs/agent-runtime-architecture.md ; https://raw.githubusercontent.com/openclaw/openclaw/main/package.json ; https://lucumr.pocoo.org/2026/1/31/pi/)
- [high] 权限分层：dmPolicy pairing(默认)|allowlist|open|disabled → tools.profile(minimal/messaging/coding/full)/allow/deny/elevated → agents.defaults.sandbox{mode:off|non-main|all, scope:session|agent|shared, workspaceAccess:none|ro|rw, docker}；gateway.auth.mode token|password|trusted-proxy|none；官方声明一 Gateway 一信任域，不适合敌对多租户；openclaw security audit --fix (https://docs.openclaw.ai/gateway/security)
- [high] 可观测：插件 clawhub:@openclaw/diagnostics-otel，diagnostics.otel{enabled,endpoint,protocol:'http/protobuf',serviceName,traces,metrics,logs,logsExporter,sampleRate,captureContent,headers,metricNamePrefix}；指标 openclaw.tokens/openclaw.cost.usd/gen_ai.client.token.usage；span openclaw.run/model.call/tool.execution；诊断事件 harness.run.started|completed|error、session.stalled、queue.lane.*；WS 帧支持 traceparent (https://docs.openclaw.ai/gateway/opentelemetry ; https://raw.githubusercontent.com/openclaw/openclaw/main/CHANGELOG.md)
- [high] 插件 API：openclaw.plugin.json 清单（id,contracts,activation,configSchema,toolMetadata）；definePluginEntry/defineChannelPluginEntry；api.registerTool/registerHook/registerChannel/registerProvider/registerService/registerGatewayMethod/registerCommand/registerHttpRoute/registerCli/registerMemory/registerContextEngine；hooks before_agent_start/agent_end/before_tool_call/after_tool_call/message_received/message_sending/session_start/session_end (https://docs.openclaw.ai/plugins/building-plugins)
- [high] Skills：SKILL.md YAML frontmatter name/description/metadata.openclaw.{requires.bins|env|config, always, primaryEnv, install}；优先级 workspace/skills > .agents/skills > ~/.agents/skills > state-dir/skills > bundled；skills.entries.<name>{enabled,apiKey,env}；ClawHub openclaw skills install @owner/slug、skills verify；以 XML 块注入 system prompt (https://docs.openclaw.ai/skills)
- [high] 记忆：workspace 下 USER.md/MEMORY.md/memory/YYYY-MM-DD.md/DREAMS.md；memory_search（hybrid 向量+关键词，SQLite 内置）与 memory_get；embedding provider OpenAI/Gemini/Voyage/Mistral/Bedrock/本地；agents.defaults.compaction.memoryFlush.enabled 默认 true；后端 builtin/Honcho/LanceDB，插件可替换 context engine (https://docs.openclaw.ai/concepts/memory)
- [medium] 渠道：核心 WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage；插件 Mattermost/MS Teams/LINE/Zalo/微信(@tencent-weixin/openclaw-weixin 腾讯官方)/企业微信/飞书(larksuite/openclaw-lark 官方，需≥2026.2.26)/钉钉/QQ（社区 openclaw-china） (https://raw.githubusercontent.com/openclaw/openclaw/main/README.md ; https://github.com/larksuite/openclaw-lark ; https://github.com/BytePioneer-AI/openclaw-china)
- [medium] 2026 安全事件：CVE-2026-25253（CSWSH 一键 RCE，CVSS 8.8，修复于 2026.1.29）、CVE-2026-32922（pairing token 提权至 admin+RCE，CVSS 9.9，2026-03-29）、ClawHub 供应链 ClawHavoc（341→824+ 恶意 skills，投放 AMOS） (https://adversa.ai/blog/openclaw-security-101-vulnerabilities-hardening-2026/ ; https://www.armosec.io/blog/cve-2026-32922-openclaw-privilege-escalation-cloud-security/ ; https://clawtrust.ai/blog/openclaw-security-341-malicious-skills-and-what-we-do-about-it)
- [medium] 社区规模：2026-04 报道 355K stars、1,200+ 贡献者；2026.8.1 于 2026-08-31 发布并被称为 OpenClaw 2.0（16,000+ PR）；GitHub API 本会话不可访问，当前 star 数未一手核实 (https://en.wikipedia.org/wiki/OpenClaw ; https://tech-insider.org/openclaw-2-0-release-credential-security-2026/)
- [high] 配置 ~/.openclaw/openclaw.json（JSON5），严格 schema（未知 key 拒绝启动），hot reload 模式 hybrid，${ENV} 替换与 SecretRef{source:env|file|exec|store}；模型引用 provider/model，agents.defaults.model{primary,fallbacks}，models.providers.<name>{baseUrl,apiKey} (https://docs.openclaw.ai/gateway/configuration)

**未解决问题**：
- src/agents/harness/ 的插件 harness 注册接口是否已在 openclaw/plugin-sdk 公开、签名与生命周期契约如何（未读源码）
- exec approvals 的精确配置字段（tools.exec.*）与审批 RPC 流程细节
- 当前 star/fork 数（GitHub API 在本会话不可访问，二手数据为 2026-04 的 355K）
- hooks.* webhook 与 heartbeat 的精确配置字段与语义（仅从 docs 索引与 lane 名推断）
- 2026.8 database-first 迁移后 transcript 的持久化 schema（/reference/database-schemas 未抓取）
- 飞书/钉钉/企业微信插件在 bindings.match.peer.id 中的标识格式
- 群会话 key 两处文档形态不一致（agent:<id>:group:<gid> vs agent:<id>:<channel>:group:<gid>），需实测 sessions.list 确认

## T12 ACP（Agent Client Protocol, agentclientprotocol.com）完整规范与生态
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T12-acp-agent-client-protocol.md

（结构化摘要缺失，请直接阅读文件）

## T13 A2A / MCP / AG-UI 等 agent 互操作协议的能力协商设计
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T13-a2a-mcp-agui-protocols.md

**摘要**：调研了A2A(Linux Foundation治理, 2026-04-09发布1.0)、MCP(2025-06-18与2025-11-25两版规范)、AG-UI三大agent互操作协议的能力协商机制，以及ACP(已并入A2A)、ANP、NLIP等补充协议。A2A用静态AgentCard(capabilities/skills/securitySchemes/extensions)做连接前能力发现；MCP用initialize握手做双向capabilities协商(tools/resources/prompts/sampling/roots/elicitation)，2025-11-25新增实验性Tasks原语(call-now fetch-later)、URL Mode Elicitation、Sampling with Tools、OAuth增强、extension框架与MCP Registry；AG-UI是面向前端的事件流协议(RUN_*/TEXT_MESSAGE_*/TOOL_CALL_*/STATE_DELTA/CUSTOM等)，几乎无显式协商。报告给出了三种协商范式(静态卡片/握手协商/事件隐式表达)与网关↔引擎、网关↔外部系统两层适用性的映射建议，以及公共能力/扩展能力设计的具体参照。

**接入面**：A2A: HTTP(S) REST/JSON-RPC/gRPC三种绑定+AgentCard发现端点(.well-known/agent-card.json)+多语言官方SDK；MCP: JSON-RPC 2.0 over stdio或Streamable HTTP，initialize/tools.call/resources.read/sampling.createMessage/elicitation.create等方法；AG-UI: SSE/WebSocket事件流，Agent/RunAgentInput SDK封装，前端按threadId/runId/messageId/toolCallId分组重建状态。三者均提供命名空间化扩展出口(A2A extensions字段、MCP _meta/extension框架、AG-UI CUSTOM/RAW事件)可直接映射为我们网关的"公共能力/引擎扩展能力"声明格式。

**公共能力**：A2A: streaming, pushNotifications, task状态跟踪(SUBMITTED/WORKING/INPUT_REQUIRED/COMPLETED等)；MCP: tools, resources, prompts, sampling, roots, elicitation, logging, progress, cancellation；AG-UI: RUN_*生命周期事件, TEXT_MESSAGE_*, TOOL_CALL_*, STATE_SNAPSHOT/STATE_DELTA

**扩展能力**：A2A: extensions字段(带URI标识+required标志+版本兼容跟踪), Signed Agent Cards(1.0新增)；MCP: extension命名/发现/配置框架(2025-11-25新增,含轻量注册表/命名空间), Tasks原语(实验性), URL Mode Elicitation, Sampling with Tools(服务端子agent loop)；AG-UI: CUSTOM事件(name/value自定义), RAW事件(透传外部系统事件), Subagent事件族(多agent归因)；ANP: DID身份+JSON-LD图谱的去中心化发现Profile

**设计启示**：
- 网关↔引擎(本地长连接、启动时选定、不要求热切换)最适合借鉴MCP式握手协商：引擎启动后一次性声明capabilities(公共能力+扩展能力及其配置schema)，网关据此选择适配层，无需运行时重新协商
- 网关↔外部系统(跨组织、连接成本高)更适合A2A式静态AgentCard：提前拉取能力清单做校验，适合评测/集成前的能力校验场景
- 统一可观测协议应直接复用AG-UI的事件模型(RUN_*/TEXT_MESSAGE_*/TOOL_CALL_*/STATE_DELTA)作为各引擎(如opencode的message.part.updated)事件归一化的中间表示，这是被CopilotKit等前端框架验证过的成熟模型，可降低自造协议风险
- 扩展能力(dynamic workflow/agent team/room/自进化)应采用命名空间化字段(如x-hermes-agentTeam)+配置JSON Schema的方式声明，参照A2A extensions字段与MCP _meta/extension框架的治理模式，确保不支持该扩展的其他引擎不受影响
- 高风险操作(如Windows IM发消息)的权限确认可复用MCP的consent-first+URL Mode Elicitation思路，让敏感操作走独立确认通道，对应赛题网关规范中的/permission端点与permission.asked事件
- AG-UI的STATE_DELTA用RFC 6902 JSON Patch增量同步，需配合周期性STATE_SNAPSHOT兜底防止断连后状态漂移，我们做多引擎统一事件流时应设计类似的快照兜底机制
- 不应把某协议当前版本的具体字段名/schema硬编码进网关核心——A2A半年内0.3到1.0、MCP每年两次大版本更新，应只借鉴其协商范式(静态卡片/握手/事件总线/动态注册)的设计思想，保持上层架构对协议版本演进的免疫力

**关键事实**：
- [high] A2A Agent Card含capabilities(streaming/pushNotifications/extendedAgentCard)、skills、securitySchemes、extensions字段，是连接前的静态能力发现机制 (https://a2a-protocol.org/latest/specification/)
- [high] A2A Task生命周期状态机为SUBMITTED→WORKING→(INPUT_REQUIRED/AUTH_REQUIRED)→COMPLETED/FAILED/CANCELED/REJECTED (https://a2a-protocol.org/latest/specification/)
- [high] A2A 1.0于2026-04-09正式发布，Linux Foundation治理，一年内超150家组织参与，新增Signed Agent Cards、多租户、JSON+HTTP/gRPC/JSON-RPC三种协议绑定，AgentCard向后兼容0.3与1.0并存声明 (https://a2a-protocol.org/latest/blog/2026/03/12/a2a-protocol-ships-v10-production-ready-standard-for-agent-to-agent-communication/; https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
- [high] IBM的ACP(Agent Communication Protocol)于2025-08-27并入A2A，仓库归档，BeeAI平台转为运行在A2A之上，ACP不再独立演进 (https://lfaidata.foundation/communityblog/2025/08/29/acp-joins-forces-with-a2a-under-the-linux-foundations-lf-ai-data/)
- [high] MCP基于JSON-RPC 2.0，Host/Client/Server三方模型，initialize握手做capabilities协商；Server端能力为tools/resources/prompts，Client端能力为sampling/roots/elicitation (https://modelcontextprotocol.io/specification/2025-06-18)
- [high] MCP 2025-11-25版本新增实验性Tasks原语(SEP-1686,call-now fetch-later)、URL Mode Elicitation(SEP-1036)、Sampling with Tools(SEP-1577)、OAuth强化(OIDC Discovery/RFC 9728/增量scope同意)、正式extension框架与轻量注册表 (https://modelcontextprotocol.info/specification/2025-11-25/changelog/)
- [high] MCP Registry正式上线于registry.modelcontextprotocol.io，用标准server.json元数据描述服务器，开源支持子注册表联邦，Anthropic/GitHub/PulseMCP/Microsoft参与共建 (https://blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview/; https://github.com/modelcontextprotocol/registry)
- [high] AG-UI事件分8类：Lifecycle(RUN_STARTED/FINISHED/ERROR)、Text Message(START/CONTENT/END/CHUNK)、Tool Call(START/ARGS/END/RESULT/CHUNK)、State(SNAPSHOT全量+DELTA用RFC6902 JSON Patch增量)、Activity、Reasoning(含加密推理跨轮透传)、Subagent(带subagentRunId归因)、Special(RAW/CUSTOM扩展) (https://docs.ag-ui.com/concepts/events)
- [medium] ANP基于DID去中心化标识与JSON-LD图谱做开放网络agent发现，1.1版本拆分为P1 Core Binding(JSON-RPC2.0)、P2 Identity and Discovery等多个Profile (https://github.com/agent-network-protocol/AgentNetworkProtocol)
- [medium] arXiv:2505.02279《A survey of agent interoperability protocols》提出分层采用路线：MCP(工具访问)→ACP(消息/会话,已并入A2A)→A2A(协作任务执行)→ANP(去中心化开放市场) (https://arxiv.org/abs/2505.02279)
- [medium] 微软已在Microsoft Agent Framework 1.0中内置MCP与A2A支持，用于跨运行时agent协作，并计划在Windows 11中原生集成MCP (https://devblogs.microsoft.com/agent-framework/a2a-v1-is-here-cross-platform-agent-communication-in-microsoft-agent-framework-for-net/)

**未解决问题**：
- A2A 1.0官方SDK各语言(尤其.NET/Go)是否已全部完成1.0兼容适配，需核实各仓库release tag
- MCP Tasks原语(2025-11-25实验性)在2026-07-28 RC/正式版中是否已转正，本次未深入抓取该版本细节
- ANP、NLIP目前生产环境真实采用案例较少，成熟度评估仍偏推测性质，缺乏权威落地证据
- AG-UI协议是否已有官方治理组织/基金会归属及完整版本号历史，本次仅确认了其事件模型本身

## T14 Agent 可观测：OTel GenAI 语义约定、各引擎的埋点/日志与统一事件协议设计
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T14-observability-genai-otel.md

**摘要**：OTel GenAI 语义约定已迁到独立仓库 semantic-conventions-genai，2026-09 仍全部 Development：定义 create_agent/invoke_agent/invoke_workflow/plan/execute_tool 五类 span、gen_ai.conversation.id 会话键、gen_ai.client.inference.operation.details 事件（结构化 input/output messages）、gen_ai.conversation.compacted 事件、memory 操作名和 invoke_agent.*/execute_tool.duration 指标。第三方平台（OpenInference/Langfuse/OpenLLMetry 等）都收敛为 span 树+kind 枚举+session id+usage/cost+score。各引擎原生埋点差异大：Claude Code 最完整（metrics+events+beta traces，逐次权限决策、成本、TRACEPARENT 传播）；Codex 有 OTLP logs/traces 但无 cost 且 mcp-server 模式零遥测；Gemini CLI 三信号齐全但 logPrompts 默认开；OpenClaw 官方 diagnostics-otel 但 session key 脱敏；dsh 内置 OTLP logs 默认发厂商端点；opencode 靠 plugin event hook；pi RPC JSONL 自带 usage/cost；Hermes 走 Langfuse 插件。建议网关用 agw.* 稳定 schema 并映射到 gen_ai.*，采用"事件流适配器为主、OTLP 直通为辅、日志回放兜底"，网关生成 trace 上下文注入子进程，四级隐私脱敏与尾采样。

**接入面**：可观测接入面分三类：(1) 原生 OTLP 直通——Claude Code（env CLAUDE_CODE_ENABLE_TELEMETRY + OTEL_*_EXPORTER，metrics/logs/beta traces，支持 TRACEPARENT 入站/出站传播与 otelHeadersHelper 动态认证头）、Codex（config.toml [otel] exporter/trace_exporter，OTLP logs+traces）、Gemini CLI（settings.json telemetry.* / GEMINI_TELEMETRY_* env，三信号+GenAI 指标）、OpenClaw（diagnostics.otel.*，http/protobuf 三信号）、dsh（DSH_TELEMETRY_MODE，OTLP logs，可换后端插件）；(2) 事件流/插件 hook——pi（--rpc JSONL 事件含 usage/cost）、opencode（plugin event hook：session.*/message.part.updated/tool.execute.*/permission.*）、Hermes（observability/langfuse 插件，pre/post_api_request、pre/post_tool_call hook）；(3) 本地 session/日志文件回放——pi session JSONL 树、dsh append-only session log、Gemini telemetry.outfile。网关侧统一采用 OTLP Collector 接收 + 适配器在解析事件流时生成 agw.* 事件与 gen_ai.* span/metric。

**公共能力**：run/turn 生命周期事件（所有引擎均可从原生事件或 span 得到）；LLM 调用 token usage（input/output/cache，各引擎分类名不同需归一到 gen_ai.usage.*）；tool 调用 start/end 与成功/失败/时长；错误事件与分类（api_error/error.type）；会话标识（session.id / conversation.id / gen_ai.conversation.id / sessionID，OpenClaw 例外需网关补）；context compaction 事件（Claude compact、pi compaction_*、opencode session.compacted、Gemini chat_compression → gen_ai.conversation.compacted）；内容脱敏开关（prompt/response/tool 详情级别）；成本（引擎给则透传，否则网关按价目表计算并标注 cost.source）

**扩展能力**：原生 OTLP 三信号导出（Claude Code/Codex/Gemini/OpenClaw/dsh 有，opencode/pi/Hermes 无）；入站 W3C trace context（仅 Claude Code -p/SDK 模式读取 TRACEPARENT/TRACESTATE；CLAUDE_CODE_PROPAGATE_TRACEPARENT 向自定义代理透传）；逐次工具权限决策事件（Claude tool_decision 含 source 六种、Codex tool_decision、opencode permission.asked/replied；Gemini 仅模式切换；Hermes/pi/dsh 无）；子 agent 父子标识（Claude agent_id/parent_agent_id、Gemini agent.start/finish、dsh 子 agent 调度；其它无）；hook 执行遥测（Claude claude_code.hook span、Gemini hook_call）；队列/背压指标（OpenClaw queue.lane.*、Gemini tool.queue.depth、pi queue_update）；原始 API body 落盘（Claude OTEL_LOG_RAW_API_BODIES=file:<dir>）；动态 OTLP 认证头（Claude otelHeadersHelper）；引擎侧头采样（Hermes SAMPLE_RATE、OpenClaw sampleRate）；API refusal / model fallback 事件（Claude api_refusal、Gemini flash_fallback）

**设计启示**：
- 网关内部使用稳定的 agw.* 事件 schema（run/turn/step.llm/step.tool/permission/error/cost/artifact/memory.compact），导出层再映射为 gen_ai.* span（invoke_agent/chat/execute_tool）与 gen_ai.client.token.usage 等指标；因 GenAI semconv 仍 Development 且属性名已多次变更（gen_ai.system→gen_ai.provider.name，逐消息事件→聚合 messages），升级只改映射表。
- 映射策略采用'适配器解析事件流为主（pi RPC、opencode plugin、Claude stream-json、Codex exec --json、Hermes hook）、原生 OTLP 直通为辅（补 TTFT/内部 span/metrics）、session 日志回放兜底（审计）'；归一化在网关做，Collector 只做路由与脱敏。
- trace 上下文由网关生成 root span 并通过 TRACEPARENT/TRACESTATE env 注入子进程；仅 Claude Code -p/SDK 真正读取，其余引擎用 OTEL_RESOURCE_ATTRIBUTES/headers 注入 agw.run_id 再在 Collector 用 conversation.id 反查或加 span link；走自建 LLM 代理时需打开 CLAUDE_CODE_PROPAGATE_TRACEPARENT=1。
- 业务会话映射：把群 ID 等业务键哈希后作为 resource/baggage 属性 agw.business_session，引擎原生 session id 保存在 gen_ai.conversation.id；对 OpenClaw（故意不导出 session key）必须在适配器层关联；metrics 默认去掉 session.id 控制基数，仅 events/spans 保留。
- 隐私分 L0 元数据/L1 tool 详情/L2 prompt&响应/L3 原始 body 四级，按租户策略统一下发到各引擎开关（OTEL_LOG_USER_PROMPTS、log_user_prompt、telemetry.logPrompts、captureContent、HERMES_LANGFUSE_CAPTURE）；注意 Gemini logPrompts 默认 true、dsh 默认发厂商端点、Claude 会导出 user.email/account_uuid，需 Collector attributes processor 哈希/删除。
- 权限可观测是网关本职：即使引擎无 permission 事件，网关拦截层也应生成 agw.permission.request/decision（decision=allow|deny|abort，source=policy|hook|user_once|user_always|user_reject|timeout，wait_ms），并对被拒/高成本/错误 trace 做 100% 尾采样。
- token 分类归一：Claude cacheRead/cacheCreation、Codex cached/reasoning、Gemini thought/cache/tool、pi cacheRead/cacheWrite 统一到 gen_ai.usage.cache_read.input_tokens / cache_write.input_tokens / reasoning.output_tokens，多余类别放 agw.usage.extra；cost 缺失引擎（Codex/Gemini）由网关按价目表补算并标 cost.source=gateway。
- 新引擎接入时的可观测能力声明清单：native_otlp{signals,protocol,enable_env}、inbound_trace_context{mode,only_in_modes}、event_stream{kind,session_id_field,usage_fields,cost_field}、content_flags{default_on}、cost_source、sampling——作为'能力识别→适配→认证'流程中的可观测子项。

**关键事实**：
- [high] OTel GenAI 语义约定已从主仓迁出到 open-telemetry/semantic-conventions-genai，opentelemetry.io 旧页面只剩迁移提示；agent spans/events/metrics 文档状态均为 Development，所有 gen_ai.* 属性未 GA (https://opentelemetry.io/docs/specs/semconv/gen-ai/ ; https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-agent-spans.md)
- [high] Agent spans 定义 create_agent(CLIENT)、invoke_agent(CLIENT/INTERNAL)、invoke_workflow、plan、execute_tool；gen_ai.operation.name 与 gen_ai.provider.name 为 Required；会话键为 gen_ai.conversation.id；操作名枚举含 create_memory_store/create_memory/delete_memory (https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-agent-spans.md)
- [high] 事件 gen_ai.client.inference.operation.details 以聚合属性 gen_ai.input.messages/gen_ai.output.messages/gen_ai.system_instructions（Opt-In，parts 结构）替代旧逐消息事件；另有 gen_ai.conversation.compacted 事件与 gen_ai.evaluation.* 属性 (https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-events.md)
- [high] GenAI metrics：gen_ai.client.token.usage(Histogram,{token})、gen_ai.client.operation.duration(s)、time_to_first_chunk、time_per_output_chunk、gen_ai.server.*，以及 gen_ai.invoke_agent.duration/inference_calls/tool_calls、gen_ai.invoke_workflow.duration、gen_ai.execute_tool.duration (https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-metrics.md)
- [high] Claude Code：CLAUDE_CODE_ENABLE_TELEMETRY=1 + OTEL_METRICS/LOGS/TRACES_EXPORTER；metrics claude_code.{session.count,lines_of_code.count,pull_request.count,commit.count,cost.usage,token.usage,code_edit_tool.decision,active_time.total}；events claude_code.{user_prompt,assistant_response,tool_result,api_request,api_error,api_refusal,tool_decision,permission_mode_changed,auth,mcp_server_connection,api_request_body,api_response_body} (https://code.claude.com/docs/en/monitoring-usage)
- [high] Claude Code traces(beta) 需 CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1；span 树 claude_code.interaction → llm_request / tool(→blocked_on_user, execution) / hook；Bash 子进程继承 TRACEPARENT，-p/SDK 会话读取入站 TRACEPARENT/TRACESTATE，交互会话忽略；CLAUDE_CODE_PROPAGATE_TRACEPARENT=1 才向自定义 ANTHROPIC_BASE_URL 代理发 traceparent (https://code.claude.com/docs/en/monitoring-usage)
- [high] Codex：~/.codex/config.toml [otel] exporter=none|otlp-http|otlp-grpc、trace_exporter、environment、log_user_prompt(默认 false)；事件 codex.{conversation_starts,api_request,sse_event,websocket_request,websocket_event,user_prompt,tool_decision,tool_result}；service.name=codex-cli，带 conversation.id；无 cost 信号 (https://learn.chatgpt.com/docs/config-file/config-advanced)
- [medium] Codex mcp-server 入口不发任何遥测，codex exec 无 metrics（issue #12913） (https://github.com/openai/codex/issues/12913 ; https://codex.danielvaughan.com/2026/04/20/codex-cli-observability-opentelemetry-traces-metrics-production-monitoring/)
- [high] Gemini CLI：.gemini/settings.json telemetry.{enabled,traces,target=local|gcp,otlpEndpoint 默认 http://localhost:4317,otlpProtocol=grpc|http,outfile,logPrompts 默认 true,useCollector}，env GEMINI_TELEMETRY_*；事件 gemini_cli.{tool_call,api_request,api_response,api_error,user_prompt,agent.start,agent.finish,hook_call,model_routing,...} 并直接发 gen_ai.client.inference.operation.details；指标 gemini_cli.token.usage 及 gen_ai.client.token.usage/operation.duration (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/cli/telemetry.md)
- [high] OpenClaw 官方 diagnostics-otel 扩展：diagnostics.otel.{enabled,endpoint,protocol(仅 http/protobuf),serviceName,traces,metrics,logs,logsExporter=otlp|stdout|both,sampleRate,captureContent,headers}；span openclaw.{model.call,run,tool.execution,exec,...}；metrics openclaw.{tokens,cost.usd,run.duration_ms,queue.lane.*,session.*}；session key 默认不导出 (https://docs.openclaw.ai/gateway/opentelemetry)
- [high] opencode 无原生 OTel（issue #14697），社区插件 @devtheops/opencode-plugin-otel 填补；官方 plugin event hook 提供 session.created/updated/idle/error/compacted、message.updated、message.part.updated、tool.execute.before/after、permission.asked/replied、file.edited 等事件 (https://opencode.ai/docs/plugins/ ; https://github.com/anomalyco/opencode/issues/14697)
- [high] pi --rpc 输出 JSONL 事件 agent_start/agent_end/agent_settled、turn_start/turn_end、message_start/update/end、tool_execution_start/update/end、compaction_start/end、auto_retry_start/end、queue_update、extension_error、extension_ui_request；assistant message 自带 usage.{input,output,cacheRead,cacheWrite,cost.total}；session 为 append-only JSONL 树(id/parentId) (https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/rpc.md)
- [high] Hermes 内置 plugins/observability/langfuse：hermes plugins enable observability/langfuse；env HERMES_LANGFUSE_{PUBLIC_KEY,SECRET_KEY,BASE_URL,SAMPLE_RATE,MAX_CHARS(12000),CAPTURE=metadata|sanitized|full,ENV,RELEASE,DEBUG}；一 turn 一 span、一 API 调用一 generation、一工具一 observation；fail-open (https://raw.githubusercontent.com/NousResearch/hermes-agent/main/plugins/observability/langfuse/README.md ; https://langfuse.com/integrations/other/hermes)
- [medium] dsh 内置 dsh-session-telemetry-otel 插件（DSH_TELEMETRY_MODE=FULL|DISABLED，DSH_TELEMETRY_DISABLED 硬关），把 session 事件投影为 OTLP/HTTP logs 发往 DeepSeek 端点；有可替换的 telemetry backend seam，社区有 dsh-plugin-langfuse/dsh-trace/@loongsuite/dsh-plugin（ENTRY/AGENT/STEP/LLM/TOOL span） (https://signoz.io/docs/deepseek-harness-observability/ ; https://github.com/linyp/dsh-plugin-langfuse)
- [high] OpenInference：openinference.span.kind ∈ {LLM,EMBEDDING,CHAIN,RETRIEVER,RERANKER,TOOL,AGENT,GUARDRAIL,EVALUATOR,PROMPT}；llm.token_count.{prompt,completion,total}、llm.cost.*、input.value/output.value、session.id、user.id、graph.node.*；Langfuse 三层 Session→Trace→Observation(span/generation/event/agent/tool/chain/...)+Score，接收 OTLP (https://raw.githubusercontent.com/Arize-ai/openinference/main/spec/semantic_conventions.md ; https://langfuse.com/docs/observability/data-model)

**未解决问题**：
- semantic-conventions-genai 仓库当前 release/tag 与日期未能通过 GitHub API 获取（代理拒绝），需人工确认引用的 commit
- Codex metrics_exporter=statsig|otlp-* 与 codex.api_request.duration_ms 等 metrics 名仅来自第三方博客，未在官方页面核实
- dsh 的 telemetry seam 接口签名、session 日志路径/格式、是否有 permission 事件需读 deepseek-ai/deepseek-harness 源码确认
- opencode message.updated payload 中 token/cost 字段名（推测 tokens/cost）与 server /event SSE 端点需对照 opencode.ai/docs/server 核实
- Hermes 是否有 OTLP 原生输出、gateway 会话/子 agent 的 Langfuse 追踪（issue #1501）是否已合并
- LangSmith/AgentOps/Braintrust/Weave 的 2026 数据模型未联网核实，报告中标为推测
- OTel GenAI SIG 对 MCP（mcp.*）约定草案状态未查到一手资料

## T17 多 Agent 编排框架的原语与"异构 agent 作为节点"抽象
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T17-multiagent-frameworks-orchestration.md

（结构化摘要缺失，请直接阅读文件）

## T18 Dynamic Workflow 与 LLM 元编排（自动决定流程/节点/引擎）
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T18-dynamic-workflow-meta-orchestration.md

（结构化摘要缺失，请直接阅读文件）

## T19 Agent 自进化（skills/prompt/memory/workflow 的自动改进）与安全门禁
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T19-self-evolution.md

**摘要**：调研了 Agent 自进化的三代技术脉络（经验/技能库→上下文/代码进化算法→产品化落地）与安全门禁实践。第一代：Voyager(代码技能库)、ExpeL(自然语言insight)、AWM(workflow归纳,离线/在线两模式)。第二代：ACE(Generator/Reflector/Curator三角色,解决brevity bias/context collapse)、GEPA(反思式进化+多目标搜索,已入DSPy)、Dynamic Cheatsheet(推理时演化记忆)、SICA与Darwin Gödel Machine(代码级自我修改,经验证的开放式演化,依赖Docker沙箱但无内建人工门禁)、EvoAgent(进化multi-agent结构)、Alita(进化MCP工具而非文本技能)。第三代产品化：Anthropic Agent Skills开放规范(agentskills.io,2025-12-18发布,SKILL.md极简格式)、Hermes Agent的skill_manage工具+可选人工审批暂存区、OpenClaw的skill_workshop四段治理流程(propose→inspect→evaluate→apply)、Claude Code Auto Memory与Codex CLI Memories的轻量事实记忆自动抽取。安全侧：Snyk ToxicSkills研究显示36.82%技能存在安全缺陷,91%恶意技能使用prompt injection,证实技能投毒是真实供应链风险。核心架构启示：应把"进化"拆成引擎无关的资产层(用agentskills.io规范+版本+网关统一审批门禁)与进化算法层(在线Reflector/Curator可做成独立公共服务;离线GEPA/MIPRO走CI流水线;DGM/SICA式代码自改进因风险不建议纳入本次赛题Windows沙箱评测范围)。

**接入面**：技能/记忆/工作流的CRUD工具调用(如Hermes skill_manage、OpenClaw skill_workshop)是主要可编程接入面；Agent Skills规范(agentskills.io)的SKILL.md目录格式是跨引擎资产互操作的实用基础；ACE式Reflector/Curator可做成读取任意引擎GET /session/{id}/message轨迹的独立后处理服务，不依赖具体引擎实现

**公共能力**：静态资产格式(SKILL.md/agentskills.io规范)；渐进式披露三层加载机制；事实型记忆读写接口约定；进化产物的审批门禁(应由网关统一收口)；轨迹驱动的在线上下文进化(ACE/Dynamic Cheatsheet思路,可做成引擎无关服务)

**扩展能力**：技能自创建/自改进的具体工具接口(skill_manage/skill_workshop,各引擎形态不同)；代码级自我修改(DGM/SICA,风险极高)；Multi-agent结构进化(EvoAgent)；MCP工具自动生成(Alita)；引擎原生的自动记忆抽取合并算法(Codex两阶段/Claude Code Auto Memory)

**设计启示**：
- 把进化拆成资产层(引擎无关,统一格式+版本+门禁)与算法层(在线Reflector/Curator可独立于引擎;离线GEPA/MIPRO走CI;代码级自改进不建议纳入)
- 网关应统一定义asset.proposed/approved/rejected/rolledback等事件类型作为可观测协议一等公民,不完全信任引擎自带审批以防绕过
- agentskills.io规范未定义签名/来源认证,网关落盘资产前应打created_by/origin_session_id等溯源标签以应对技能投毒风险
- 记忆(常驻小事实)与技能(按需大程序)在存储机制上常常同构但触发方式不同,归一化时需保留颗粒度元数据而非合并为同一资产类型
- 多租户/多群会话场景下,现有产品文档均未明确技能资产的session/tenant隔离策略,需要网关自行设计asset namespace与session/directory绑定
- DGM/SICA式代码自改进与赛题Windows沙箱受控评测的可比性要求冲突,应默认禁用或强隔离
- 离线prompt编译(GEPA/MIPRO)依赖训练集与reward函数,短期ROI有限,更适合作为未来演进方向而非本次参赛必答项

**关键事实**：
- [high] ACE论文arXiv:2510.04618(2025-10)提出Generator/Reflector/Curator三角色分工进行上下文进化,解决brevity bias和context collapse两个问题,agent任务+10.6%,延迟-86.9%,成本-83.6% (https://arxiv.org/abs/2510.04618)
- [high] GEPA(arXiv:2507.19457)已被ICLR 2026接收为Oral,是反思式prompt/文本进化算法,已集成为dspy.GEPA API (https://arxiv.org/abs/2507.19457; https://dspy.ai/api/optimizers/GEPA/overview/)
- [high] Darwin Gödel Machine(arXiv:2505.22954,2025-05-29首发,v3更新至2026-03-12,ICLR 2026论文)用SWE-bench/Polyglot经验验证自我代码修改,Apache-2.0开源,依赖Docker沙箱但README未提供人工监督/kill-switch机制 (https://arxiv.org/abs/2505.22954; https://github.com/jennyzzt/dgm)
- [high] Anthropic于2025-12-18在agentskills.io发布Agent Skills开放规范,SKILL.md仅name(≤64字符,小写字母数字连字符)和description(≤1024字符)两个必填字段,采用渐进式披露三层加载 (https://agentskills.io/specification; https://simonwillison.net/2025/Dec/19/agent-skills/)
- [high] Hermes Agent用skill_manage工具(create/patch/edit/delete/write_file/remove_file)让agent自主管理技能,配置skills.write_approval:true时写入先暂存到~/.hermes/pending/skills/,需人工/skills approve才生效,前台/后台写入均受此门禁约束 (https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [medium] OpenClaw的skill_workshop工具走propose-create/propose-update→inspect→evaluate→apply四段治理流程,区分个人/workspace/已发布三种技能作用域 (https://docs.openclaw.ai/tools/creating-skills)
- [medium] Snyk ToxicSkills研究显示ClawHub上36.82%的agent skills存在至少一项安全缺陷,13.4%含关键级问题,已确认恶意技能中100%含恶意代码模式、91%同时用prompt injection (https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub)
- [high] Agent Workflow Memory(AWM,arXiv:2409.07429,ICML 2025 Poster)归纳可复用workflow,支持离线预归纳和在线即时归纳两种模式,在Mind2Web/WebArena上相对成功率+24.6%/+51.1% (https://arxiv.org/abs/2409.07429; https://icml.cc/virtual/2025/poster/45496)
- [high] SICA(arXiv:2504.15228)让agent直接编辑自身代码库,用meta-agent从表现最好的历史版本archive中挑选并实施改进,SWE-bench Verified子集从17%提升到53% (https://arxiv.org/abs/2504.15228)
- [medium] Codex CLI记忆架构分静态AGENTS.md(团队规则)+生成层Memories(两阶段:会话结束抽取脱敏,再全局锁定合并写diff) (https://mem0.ai/blog/how-memory-works-in-codex-cli)
- [high] Alita(arXiv:2505.20286)走最小预定义/最大自我进化路线,agent仅一个核心求解组件,进化对象是自主生成的MCP工具而非技能文本;后继Alita-G(arXiv:2510.23601)把通用agent端到端转化为领域专家 (https://arxiv.org/abs/2505.20286; https://arxiv.org/html/2510.23601)
- [high] Voyager(arXiv:2305.16291)用自动课程+不断增长的代码技能库+迭代prompting实现Minecraft终身学习,无需微调,发现物品数是此前SOTA的3.3倍 (https://arxiv.org/abs/2305.16291)

**未解决问题**：
- Agent Skills规范是否已有官方技能签名/来源认证扩展提案,需持续跟踪agentskills/agentskills仓库
- Hermes/OpenClaw审批门禁在多租户/多群会话下是否有资产隔离机制,两方文档均未提及
- 是否存在DGM类学术自进化系统的工业级安全沙箱+人工卡点参考实现
- ACE论文Generator/Reflector/Curator循环的算法级细节(如delta更新的具体数据结构)需要二次抓取arXiv全文或alphaXiv详细页确认

## T20 Agent 记忆系统与跨引擎统一记忆层
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T20-memory-systems.md

**摘要**：调研了 Mem0/Letta/Zep-Graphiti/Cognee/LangMem/Supermemory/Honcho/MemOS 等独立记忆服务，以及 Claude memory tool、Claude Code CLAUDE.md、Codex AGENTS.md/memories、Gemini CLI GEMINI.md/save_memory、Hermes+Honcho、OpenClaw markdown+sqlite-vec 等引擎原生记忆机制的数据模型与API。给出记忆分类（工作/情景/语义/程序）与作用域（用户/群/租户/agent/会话）映射表、LoCoMo/LongMemEval/MemBench 基准概述，以及网关级统一记忆服务的接口草案（/memory/write、/memory/read、/memory/consolidate）与群记忆隔离设计（room_id 命名空间 + 工作目录物理隔离，参照 Honcho peer/session 模型）。报告含关键事实表（12条，含来源与置信度）、公共能力vs扩展能力映射表、风险与坑（双写冲突、Windows sqlite-vec/git 依赖、检索延迟拖累阻塞式 prompt_async）。

**接入面**：网关级统一记忆服务应实现 Claude memory tool 式的客户端 handler 协议（view/create/str_replace/insert/delete/rename 语义），并提供独立于引擎的 /memory/write、/memory/read（支持 scope: user_id/room_id/tenant_id/agent_id/session_id 及 type: episodic/semantic/working/procedural）、/memory/consolidate 三个HTTP接口；对接引擎时，读路径把检索结果注入 system prompt 或引擎期望的 Markdown 文件（CLAUDE.md/AGENTS.md/GEMINI.md/MEMORY.md），写路径从 GET /session/{id}/message 轨迹（finish=stop 后）异步抽取并调用 /memory/write；引擎原生记忆机制（Auto Memory、Dreaming、sleep-time、Codex memories）作为可选扩展能力开关，与网关统一记忆互斥启用避免双写冲突。

**公共能力**：分层Markdown记忆文件的路径解析与作用域合并（用户<项目<租户/managed policy）；客户端memory工具（view/create/str_replace/insert/delete/rename语义，网关可直接复用Claude模式实现给所有引擎共享）；动态检索注入（网关调用统一记忆服务search后拼入prompt/system，不依赖引擎原生检索能力）；记忆写入的路径穿越防护与容量/过期治理（网关侧强制基线）；按 user_id/room_id/tenant_id/agent_id/session_id 五轴作用域隔离记忆命名空间

**扩展能力**：Letta MemFS：git版本化记忆存储与sleep-time后台巩固（引擎特有，需git+worktree环境）；Honcho dialectic双层注入与peer/session模型（引擎绑定的专用记忆服务集成）；Mem0/Zep原生知识图谱构建与bi-temporal事实演化查询（需图数据库或托管API）；OpenClaw Dreaming后台巩固进程与sqlite-vec混合检索（Windows下需验证sqlite-vec原生编译兼容性）；MemOS MemCube跨任务技能复用与参数级记忆（研究阶段，生产成熟度有限）

**设计启示**：
- 记忆应设计为网关级公共能力（统一read/write/consolidate接口），引擎原生记忆机制作为可选扩展能力开关，两者不应在同一轮评测中同时写入以避免事实重复抽取/覆盖冲突
- 群助手记忆隔离建议采用Honcho式peer/session双轴模型：room_id映射为记忆命名空间前缀，同时引擎工作目录（POST /session的directory参数）做物理隔离，双重保证群间不串memory
- 静态注入（CLAUDE.md/AGENTS.md/GEMINI.md会话开始时全量加载）与动态检索注入（Mem0/Zep/Honcho按需search）是两种根本不同的读取模式，统一记忆层必须同时兼容，不能只支持一种
- Claude memory tool的六命令协议因为是纯tool_use/tool_result消息，天然被现有的message轨迹协议完整记录，可观测性优于引擎内部黑盒文件读写；后台巩固类写入（Dreaming/sleep-time）不在单轮轨迹内，需要新增memory.consolidated类事件类型弥补
- 动态检索注入会在阻塞式prompt_async调用前增加一次网络往返延迟，直接计入任务耗时，需设超时降级（跳过记忆注入）以保鲁棒性评分；Windows部署还需提前检查git/sqlite-vec等隐藏依赖的原生兼容性
- 记忆分类可按工作/情景/语义/程序四类映射到具体产品能力（工作记忆≈context editing/compaction，情景记忆≈episode/session日志，语义记忆≈fact/CLAUDE.md，程序记忆≈agent-owned skills），程序记忆层在多数产品中仍不成熟，是可差异化创新的方向
- 相对赛题Windows办公任务的客观分主战场，长程记忆能力更偏架构完整性/创新加分项，不建议投入过多资源，但网关级统一记忆接口的存在本身即可作为架构合理性得分点

**关键事实**：
- [high] Claude 官方 memory tool（beta type: memory_20250818）是纯客户端工具，六命令 view/create/str_replace/insert/delete/rename 全部限定 /memories 前缀，服务端不存储数据，安全校验（路径穿越防护）由调用方实现 (https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [high] Mem0 Platform 的 Graph Memory 已演进为内置原生图（无需 enable_graph，relations 字段恒为空列表）；标准 API 为 add/search/get_all/update/delete，作用域参数 user_id/agent_id/run_id (https://docs.mem0.ai/platform/features/graph-memory)
- [medium] Zep 由 Graphiti 驱动构建 bi-temporal 知识图谱，每条边带 valid_at/invalid_at 有效期区间，旧事实失效而非删除；自建需接 Neo4j/FalkorDB/Kuzu，Zep Cloud 托管 (https://arxiv.org/abs/2501.13956; https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/)
- [medium] Letta 采用 MemFS（git 版本化记忆文件系统）+ Memory Block（label/value/char limit，可跨agent共享，可API直接CRUD）双层记忆，后台 sleep-time agent 在独立 git worktree 中巩固记忆并自动合并 (https://docs.letta.com/letta-agent/memory; https://www.letta.com/blog/memory-blocks/)
- [medium] Hermes Agent 原生绑定 Honcho：base layer（session summary+representation+peer card）+ dialectic supplement（LLM推理，1-3 pass）双层注入，暴露 honcho_profile/search/context/reasoning/conclude 五工具，多实例共享用户时 peer 隔离各自观察与结论 (https://hermes-agent.nousresearch.com/docs/user-guide/features/honcho; https://honcho.dev/docs/v3/guides/integrations/hermes)
- [high] OpenClaw 记忆完全为纯文本：USER.md+MEMORY.md+memory/YYYY-MM-DD.md+DREAMS.md，辅以 memory.sqlite（sqlite-vec扩展做向量检索），暴露 memory_search/memory_get/intent 三工具，Dreaming 后台进程做阈值化巩固 (https://docs.openclaw.ai/concepts/memory)
- [medium] Codex CLI 记忆分两层：静态 AGENTS.md（32KiB上限，超出静默截断）+ 生成层 ~/.codex/memories/（后台会话摘要），纯本地单机存储，Memories 功能在 EEA/UK/瑞士被屏蔽 (https://mem0.ai/blog/how-memory-works-in-codex-cli（二手，未抓一手OpenAI文档）)
- [high] Gemini CLI 通过 save_memory 工具写Markdown，按仓库GEMINI.md/项目私有/全局~/.gemini/GEMINI.md三层路由，/memory show 查看拼接后完整上下文 (https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/memory.md; https://geminicli.com/docs/tools/memory/)
- [high] Claude Code 记忆分CLAUDE.md（人写指令）与Auto Memory（Claude自写便签）两机制，作用域从广到窄：Managed policy>用户>项目>本地（CLAUDE.local.md），/memory命令浏览编辑 (https://code.claude.com/docs/en/memory)
- [medium] MemOS 提出 MemCube（Metadata Header+Memory Payload）统一调度明文/激活态/参数级三种异构记忆，三层架构Interface/Operation/Infrastructure，GitHub README声称已支持DeepSeek Harness接入 (https://arxiv.org/abs/2507.03724; https://github.com/MemTensor/MemOS)
- [medium] LoCoMo为50组对话（最长35 session、约300 turn、约200 QA，覆盖single/multi-hop/open-domain/temporal），LongMemEval为500题6大类（可扩展至百万token对话），MemBench聚焦信息抽取/多跳推理/知识更新/偏好遵循/时间推理五维度 (https://mem0.ai/research（二手摘要综合多篇arXiv论文）)
- [medium] Supermemory 核心概念Space（团队/项目容器）+Memory Graph（记忆为六边形节点、文档为矩形节点），add_memory支持action:forget主动遗忘，search_memory默认附带稳定+近期用户画像上下文 (https://supermemory.ai/docs/concepts/how-it-works; https://supermemory.ai/docs/concepts/graph-memory)
- [low] opencode/pi/dsh三引擎的记忆机制信息均来自二手技术博客而非官方一手文档：dsh加载~/.dsh/AGENTS.md+项目AGENTS.md链，opencode配置在~/.config/opencode/opencode.json，pi通过第三方插件（pi-plugin/MemoryCore）对接外部记忆服务 (https://github.com/fatwang2/pi-dsh; https://github.com/zilliztech/memsearch（二手，未交叉验证）)

**未解决问题**：
- opencode、pi、dsh三个候选引擎各自记忆机制的官方一手文档未获取，仅有二手技术博客描述，需后续直接查阅官方仓库源码/docs交叉确认
- A-Mem（Zettelkasten式自组织记忆）本次未获取一手资料
- Claude Code的Auto Memory与Claude API的memory tool是否共享底层存储/协议、能否互操作，官方未明确说明
- Honcho的honcho_*工具集精确参数schema未抓到API Reference原文，仅有功能性描述
- LoCoMo/LongMemEval/MemBench的具体评测指标定义与最新SOTA分数未直接核对原论文表格

## T21 会话模型、并发/隔离与沙箱运行时
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T21-sessions-isolation-sandbox.md

**摘要**：八个引擎的 session 模型分两派：CLI/SDK 型（Claude Code、Codex、pi）以本地 JSONL + 一次性进程为单位，无跨进程锁，并发与队列须由网关实现；服务型（opencode、OpenClaw、Hermes、OpenHands）由常驻进程持有 session 并内建 lane/队列，OpenClaw 的 session lane + queue mode + maxConcurrent 最完整。分叉能力差异大（pi 单文件树；Claude/Codex/opencode 复制式 fork；Hermes/OpenClaw 无；ACP fork 为草案），压缩仅 opencode/pi/OpenClaw/Hermes 可程序化触发。沙箱分 OS 进程级（srt/Codex，毫秒级无快照）与 microVM/容器级（E2B/Daytona/Modal/Docker，秒级可 pause/snapshot）。建议网关做 BusinessKey→EngineBinding→RuntimeBinding 三级注册表与 NEW/ACTIVE/WARM/ARCHIVED 状态机，resume 参数全部由网关重放。

**接入面**：Claude Code: CLI `-p --output-format json/stream-json`, `--resume/--continue/--fork-session/-n`, env CLAUDE_CONFIG_DIR + CLAUDE_CODE_PROJECT_DIR_NAME, hooks (transcript_path, SessionEnd/PreCompact)；Codex: SDK startThread/resumeThread/run + sandboxMode + workingDirectory, CLI `codex exec --json`/`codex resume`；opencode: HTTP server + generated SDK session.create/chat/fork/abort/compact；pi: CLI --session/--fork/--no-session + JSONL tree file；OpenClaw: gateway sessionKey + config session.dmScope/groupScope/reset + messages.queue.* + agents.defaults.maxConcurrent；Hermes: gateway per-chat keys + config session_reset/sessions.*；ACP: JSON-RPC session/new, session/load, session/fork(RFD), session/update；沙箱: srt settings JSON / SandboxManager, E2B Sandbox.create/pause/connect, Daytona snapshot/warm pool/archive, Modal Sandbox snapshot, OpenHands DockerSandboxService。

**公共能力**：session.create / session.resume（所有引擎，参数 cwd、configDir、model、permissionProfile、env）；session.fork（复制式：Claude Code、Codex CLI、opencode、pi、ACP RFD；Hermes/OpenClaw 需网关降级）；session.compact（opencode/pi/OpenClaw/Hermes 可程序化；Claude/Codex best-effort 斜杠命令）；session lane 串行化 + 入站排队策略 steer/followup/collect/interrupt（网关层实现即可归一，OpenClaw 原生）；session reset policy none/idle/daily/both（网关层实现，OpenClaw/Hermes 原生）；业务 key 语法 <tenant>:<channel>:<scope>:<id>[:<user>]（OpenClaw/Hermes 已成熟）；sandbox policy IR：fs allow/deny read/write + net allowedDomains/deniedDomains（以 srt 键为基线）；transcript 归档与 session 列表/token 计数（各引擎均有 JSONL 或 SQLite）

**扩展能力**：pi：树内分支 /tree + branch summary + compaction 作为可回溯 entry（独有）；opencode：parentID 子 session 树 + per-session permission 参数 + session.timeline/revert；OpenClaw：多 lane 队列（main/cron/nested/subagent）、cap/drop=summarize、非 main 会话 docker 沙箱、pre-compaction NO_REPLY 记忆 flush；Hermes：群内按 user_id 隔离、FTS5 全文检索、/compress 生成谱系续篇会话；Claude Code：--fork-session、/branch 后后台 subagent 归属新分支、resume-from-summary 对话框、config dir 级租户隔离；Codex：thread 内强制单 turn、sandboxMode 三档；E2B：内存级 pause/resume（4s/GiB、1s）；Daytona：warm pool/archive；Modal：7 天内存快照；OpenHands：每 conversation 容器状态机；ACP：session/load 需 loadSession 能力声明、session/fork 草案

**设计启示**：
- SessionRegistry 做三级映射 BusinessKey → EngineBinding(engine, engineSessionRef, cwd, configDir, permissionProfile, 启动参数) → RuntimeBinding(kind, instanceId, state, snapshotRef)，引擎会话与运行时实例解耦，允许在不同沙箱上恢复同一引擎会话
- CLI 型引擎（Claude Code/pi）无跨进程锁，网关必须为每个 BusinessKey 建 session lane 串行化，并暴露 steer/followup/collect/interrupt 入站策略与全局 maxConcurrent（直接采用 OpenClaw 枚举）
- resume 不能信任引擎恢复配置：Claude Code 不恢复 --mcp-config/--settings/--add-dir 且 permission mode 恢复规则复杂、--fork-session 丢失授权；网关每次 resume 应从 binding 完整重放所有启动参数与 --permission-mode
- 生命周期状态机 NEW→ACTIVE→WARM(进程退出/沙箱 pause)→ARCHIVED(transcript 归档+沙箱 kill/archive)，reset(/new、daily、idle) 生成新 engineSessionRef 并把旧 binding 标 superseded；E2B 暂停态无 TTL、Modal 内存快照 7 天，ARCHIVED 转换必须显式清理
- 群助手 scope 策略必须显式配置：OpenClaw per-group 是全群共享上下文，Hermes 群 key 含 user_id 是群内按人隔离，二者语义相反；网关 dmScope/groupScope 需支持 per-group 与 group+user 两种并映射到各引擎
- 沙箱分层选型：可信单租户/防误操作用 srt/Codex sandboxMode（毫秒级、无快照），硬多租户用 microVM（E2B/Daytona VM），并用 srt 的 allow/deny 键作为统一沙箱策略 IR 翻译到各运行时
- 密钥注入优先走运行时代理/挂载而非 create 参数：Daytona 带 secrets/env 的 create 不命中 warm pool；Claude Code 用 CLAUDE_CONFIG_DIR 每租户隔离 settings/transcript/memory
- 树形会话（pi）与复制式 fork（Claude/Codex/opencode）应在能力协商中区分为 session.tree 与 session.fork 两种能力，Hermes/OpenClaw 无 fork 时由网关用 transcript 复制降级

**关键事实**：
- [high] Claude Code 支持 `claude --resume <id|name>`、`--continue`、`--fork-session`（新 session id，原会话不变）及交互内 `/branch`；`claude -p --resume <id> --output-format json` 可脚本化追问 (https://code.claude.com/docs/en/sessions)
- [high] Claude Code 同一 session 在两个终端同时 resume（不 fork）会交织写入同一 transcript，无锁；resume 不恢复 --mcp-config/--settings/--add-dir，permission mode 恢复规则复杂 (https://code.claude.com/docs/en/sessions)
- [high] Claude Code 用 CLAUDE_CONFIG_DIR + CLAUDE_CODE_PROJECT_DIR_NAME（v2.1.234+）可为每个租户/会话隔离 transcript 与 auto memory 目录 (https://code.claude.com/docs/en/sessions)
- [high] Codex SDK：startThread()/resumeThread(threadId)/thread.run()，sandboxMode 取值 read_only|workspace_write|full_access，每个 thread 一次只处理一个 turn (https://learn.chatgpt.com/docs/codex-sdk)
- [medium] opencode SDK 提供 session.create({parentID, permission})、session.fork()、session.abort()、session.compact、session.timeline；子 agent 是带 parentID 的子 session (https://deepwiki.com/anomalyco/opencode/3.1-session-management; https://github.com/anomalyco/opencode/issues/12916)
- [high] pi 会话是单文件 JSONL 树（每条 entry 有 id/parentId，含 compaction 与 branch summary 条目），/tree 树内切换，/fork /clone 与 pi --fork <path|id> 产生新文件，pi --no-session 无痕 (https://pi.dev/docs/latest/sessions)
- [high] OpenClaw session key 形如 agent:<agentId>:main / agent:<agentId>:<channel>:group:<id> / cron:<job.id> / hook:<uuid>；session.dmScope=main|per-peer|per-channel-peer|per-account-channel-peer，groupScope=per-group|main；reset.mode=none|daily|idle (https://docs.openclaw.ai/reference/session-management-compaction; https://docs.openclaw.ai/concepts/session)
- [high] OpenClaw 队列：session lane session:<key> 保证同一 session 只有一个 run；全局 lane 受 agents.defaults.maxConcurrent 限制；messages.queue.mode=steer|followup|collect|interrupt，cap/drop(summarize|old|new) (https://docs.openclaw.ai/concepts/queue)
- [high] OpenClaw 会话存储已迁到 SQLite ~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite，压缩有三种触发（溢出重试、用量投影、会话内阈值）且压缩前用 NO_REPLY 静默 flush 记忆 (https://docs.openclaw.ai/reference/session-management-compaction)
- [high] Hermes 用 ~/.hermes/state.db（SQLite WAL+FTS5）；群 key agent:main:<platform>:group:<chat_id>:<user_id>（群内按人隔离）；session_reset.mode=none|idle|daily|both；/compress 生成 'name #2' 续篇 (https://hermes-agent.nousresearch.com/docs/user-guide/sessions)
- [high] ACP session/fork 是 RFD 草案（2025-11/12），请求同 session/load（sessionId, cwd, mcpServers），能力声明 session: { fork: {} }；session/load 通过 session/update 回放历史 (https://agentclientprotocol.com/rfds/session-fork)
- [high] Anthropic srt：macOS Seatbelt、Linux bubblewrap+去 netns+seccomp、Windows alpha WFP；网络经宿主 HTTP/SOCKS5 代理按 allowedDomains/deniedDomains 过滤；配置 ~/.srt-settings.json；API SandboxManager.initialize/wrapWithSandbox (https://raw.githubusercontent.com/anthropic-experimental/sandbox-runtime/main/README.md)
- [high] E2B pause 保留文件系统+内存+进程，约 4s/GiB，resume 约 1s，暂停态无 TTL 无自动删除；默认 timeout 5 分钟，onTimeout 可设 pause；连续运行 Pro 24h/Hobby 1h (https://docs.e2b.dev/sandbox/persistence)
- [medium] Modal Sandbox memory snapshot 7 天过期且只能同实例类型恢复，filesystem snapshot 默认 30 天 TTL；Daytona 容器沙箱冷快照、VM 沙箱热快照，warm pool 需精确匹配且不含自定义 env/secrets (https://modal.com/docs/guide/sandbox-snapshots; https://www.daytona.io/docs/en/snapshots/)
- [medium] OpenHands DockerSandboxService 每 conversation 一个 agent-server 容器，状态 STARTING→RUNNING→PAUSED→ERROR→MISSING，容器启动 30–60s (https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox)

**未解决问题**：
- Gemini CLI 的 session/resume/checkpoint 语义未抓取一手页面
- Codex CLI --json 事件完整枚举、fork 命令形态、compaction 阈值需查 openai/codex 仓库
- opencode server HTTP 路径与 SessionStatus 取值需查 OpenAPI spec；是否支持多目录/worktree
- OpenClaw agents.defaults.sandbox.mode 及 docker 参数键名需在 gateway/sandboxing 文档核实
- Cloudflare Sandbox、Vercel Sandbox 的启动延迟与快照能力未核实；Modal 是否已从 gVisor 转向 microVM
- Claude Agent SDK 的 resume/forkSession 字段名与 --session-id 预设 uuid 行为需确认
- 自建 Firecracker 快照恢复延迟数据未收集

## T22 权限/策略/安全：跨引擎的统一策略模型
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T22-permissions-policy-safety.md

**摘要**：调研 Claude Code、opencode、Codex、Gemini CLI、OpenClaw、Hermes、Goose、pi 及 ACP 协议的权限/审批机制，并参照 AgentCore Policy（Cedar）、Entra Agent ID、SPIFFE、MCP OAuth 与 OWASP ASI 2026。各引擎权限系统可归纳为三种形态：静态声明式规则、运行时回调（hook/canUseTool/ACP request_permission）与 OS 沙箱兜底；2026 年新共性是"LLM 作为审批者"的 review 档位。规则冲突语义各异（首个命中/最后命中/数值优先级），网关应持单一策略源（deny 优先）经编译器生成各引擎配置，运行时以 hook/ACP 作统一审批通道；主体与 allow_always 记忆由网关按群分片，不下沉引擎。主要坑：Bash 包装器绕过、非交互下 ask 静默变 deny、白名单跨群泄漏、MCP OAuth 混合多用户凭据。

**接入面**：编译期：网关策略编译器生成各引擎原生配置——Claude managed settings.json（permissions.allow/ask/deny、defaultMode=dontAsk、allowManagedPermissionRulesOnly）、Codex config.toml（approval_policy/sandbox_mode/mcp_servers.*.approval_mode）、Gemini Admin tier TOML、opencode permission 对象（需反转顺序）、OpenClaw tools.exec.mode=allowlist + agents.<群id> allowlist、Hermes approvals.*。运行时：Claude PreToolUse hook / SDK canUseTool、ACP session/request_permission、OpenClaw gateway exec.approval 事件、Hermes 群内 yes/no 作为统一审批通道；审计事件含 subject/session/engine/tool/effect/decided_by。

**公共能力**：效果三值 allow/deny/ask（所有引擎均可映射）；客体 = 工具名 + 参数 glob/前缀匹配；运行时审批请求抽象 PermissionRequest{session,tool,kind,rawInput,options}（ACP 原型）；allow_once 语义透传引擎；文件系统根 + 网络开关的沙箱兜底；deny 优先的冲突解决（Cedar forbid 同构）；审批与执行审计事件流

**扩展能力**：review 档位（LLM 审批者）：Claude auto、Hermes smart、Goose smart_approve、OpenClaw exec.mode auto；Claude hook defer 与 updatedInput 参数改写；OpenClaw sha256:argv 精确参数哈希白名单；Codex granular 五类审批种类开关；Gemini allowRedirection、Extension tier 自带策略；Hermes 容器后端跳过审批；Hermes/OpenClaw 消息平台原生用户白名单与 channel 级策略；Dogwood temporal policy（先审批/限频/累计阈值）

**设计启示**：
- 网关应持有单一策略源（Cedar/Rego 风格、deny 优先），通过策略编译器分别生成各引擎配置，因为规则冲突语义相反（Claude 首个命中 vs opencode 最后命中 vs Gemini 数值优先级）
- 主体（群/用户/租户）不下沉到引擎；引擎只见当前 session 的有效策略，用户鉴权在网关层完成（与 Hermes 网关/agent 分工一致）
- allow_always 审批记忆必须由网关按群/租户分片持有，只把 allow_once 透传引擎，并清空或隔离引擎侧全局白名单，防止跨群泄漏
- review（LLM 审批）作为引擎特有扩展效果值，在群聊多用户等高敏场景默认降级为 ask，因各引擎 reviewer 不可互换、不可审计
- 非交互/无人值守模式下 ask 会静默变 deny（Gemini、Claude dontAsk），网关需预先把 ask 规则转成运行时审批请求，并定义审批超时兜底（对应 OpenClaw askFallback）
- MCP OAuth token 应由网关集中持有并按群/用户下发短期凭据，经 header 注入引擎，避免引擎内授权码流程混合多用户凭据
- 审批消息必须展示原始命令/参数而非模型摘要，并校验审批者身份、忽略来自工具输出或 agent 自身内容的审批语句（ASI09）；子代理需 hook 层兜底继承策略
- 沙箱与审批互补而非替代：即使引擎容器化，网络与消息发送等外部副作用仍需审批

**关键事实**：
- [high] Claude Code 权限规则求值顺序固定为 deny → ask → allow，首个匹配生效；裸工具名 deny 会把工具从模型上下文移除 (https://code.claude.com/docs/en/permissions)
- [high] Claude Code 权限模式共 6 种：default/acceptEdits/plan/auto/dontAsk/bypassPermissions，managed settings 可锁死 bypass 与 auto (https://code.claude.com/docs/en/permissions)
- [high] Claude Code PreToolUse hook 输出 permissionDecision ∈ {allow,deny,ask,defer} 可附 updatedInput；exit code 2 无条件阻断；多 hook 取最严格 (https://code.claude.com/docs/en/hooks)
- [medium] Agent SDK 处理顺序：PreToolUse Hook → Deny → Allow → Ask → Permission Mode → canUseTool (https://code.claude.com/docs/en/agent-sdk/permissions)
- [high] opencode permission 配置最后匹配的规则胜出（与 Claude Code 相反）；.env* 默认 deny，doom_loop/external_directory 默认 ask (https://opencode.ai/docs/permissions/)
- [high] Codex approval_policy ∈ {untrusted,on-request,never,granular{...}}，sandbox_mode ∈ {read-only,workspace-write,danger-full-access}，workspace-write 默认无网络 (https://learn.chatgpt.com/docs/config-file/config-reference)
- [high] Gemini CLI Policy Engine 用 TOML [[rule]] + 五层 tier（Default..Admin），最终优先级 = tier_base + priority/1000；非交互下 ask_user 视为 deny (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/policy-engine.md)
- [high] ACP session/request_permission 请求含 toolCall{kind,rawInput} 与 options[kind ∈ allow_once/allow_always/reject_once/reject_always]，响应 outcome selected/cancelled (https://agentclientprotocol.com/protocol/tool-calls)
- [high] OpenClaw exec allowlist 项含 argPattern sha256:argv 精确哈希，按 agents.<agentId> 分作用域，审批经 gateway 事件 exec.approval.requested/resolve (https://docs.openclaw.ai/tools/exec-approvals)
- [high] Hermes approvals.mode ∈ {smart,manual,off}，docker/modal 后端跳过审批检查，用户授权靠 *_ALLOWED_USERS 分层白名单 (https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/security.md)
- [high] AWS AgentCore Policy 基于 Cedar（默认拒绝、forbid 优先），JWT sub → principal，tool call → action；Dogwood 扩展支持 session 内先审批/限频/累计阈值 (https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-core-concepts.html)
- [high] OWASP Top 10 for Agentic Applications 2026 列出 ASI01-ASI10（目标劫持、工具滥用、身份特权滥用、供应链、意外代码执行、记忆投毒、代理间通信、级联失败、人机信任利用、失控代理） (https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
- [high] MCP 授权规范（2025-06-18 起）要求 server 作为 OAuth 2.0 Resource Server 实现 RFC 9728，客户端带 RFC 8707 resource 参数 (modelcontextprotocol.io/specification 及 descope/logto/auth0 博客)
- [high] Claude Code 文件权限规则只认 Read/Edit，Write/Glob 路径规则被接受但不生效；Bash(devbox run *) 类环境运行器不剥离内层命令 (https://code.claude.com/docs/en/permissions)

**未解决问题**：
- Codex CLI 标志 --full-auto/--dangerously-bypass-approvals-and-sandbox 与 app-server 审批请求 JSON-RPC 形态未从一手页核实
- opencode 是否有官方运行时拦截点（插件 tool.execute.before 能否返回 deny）
- Goose/Gemini 在 ACP 模式下 ask 是否严格映射为 request_permission，allow_always 持久化位置
- Claude Code auto 模式分类器判定标准与可审计性
- Cedar 无 ask 效果，review 标签→ask 映射需原型验证；Dogwood 是否可离线使用
- SPIFFE WIT-SVID/WIMSE 落地时点
- 各引擎审批通道超时默认值与超时后效果

## T23 能力发现/协商/分层的设计模式（跨领域借鉴）与 Capability Manifest 设计
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T23-capability-negotiation-design.md

**摘要**：调研了 MCP、ACP、A2A、LSP、WIT(Wasm Component Model)、K8s Conformance/CRD Conditions、Terraform Provider Protocol、OpenFeature、VS Code 扩展模型等跨领域能力协商机制，归纳出四种架构原型：静态请求-响应协商（MCP/ACP initialize、A2A AgentCard）、静态声明+运行时动态注册（LSP registerCapability）、schema内嵌能力位驱动优化（Terraform Capabilities字段）、一致性测试套件作为能力可执行定义（K8s Conformance+Sonobuoy）。据此给出面向赛题网关的Capability Manifest JSON草案（namespace:capability@version命名、core/standard/extension/experimental四层tier、supported/polyfilled/unsupported三态status、depends_on/conflicts_with/conformance_test_ref/cost_profile字段）与四阶段协商流程（静态声明→探测→CTS认证→运行时协商）及新引擎接入SOP。核心结论：能力声明必须与可执行认证分离（自我声明不可信）；能力应支持运行时动态增减；网关对缺失能力的polyfill应作为manifest显式第三态。

**接入面**：四阶段能力协商流程（静态声明→探测probe→CTS认证→运行时协商）+ Capability Manifest JSON schema（namespace:capability@version命名、tier四层、三态status、depends_on/conflicts_with/conformance_test_ref/cost_profile字段）+ 新引擎接入SOP（识别→适配→认证→持续演进）

**公共能力**：session CRUD（core）；prompt_async阻塞式单轮执行（core）；message轨迹拉取（core）；abort（core）；SSE标准事件流server.connected/heartbeat/session.status/session.idle/session.error/message.part.updated（core）；question/permission交互式追问（standard）；增量message拉取cursor（standard）；session resume/持久化（standard）

**扩展能力**：dynamic workflow（引擎特有扩展，需声明params_schema如max_nodes）；agent team/多智能体编排（扩展，类比A2A skills+extensions分层）；room多方共享会话（扩展，网关可polyfill托管）；自进化/自我改进（扩展，成本画像通常latency高）；experimental自由字段（借鉴MCP experimental capability，用于灰度试用非标准特性）

**设计启示**：
- 能力'声明'与'认证'必须分离：所有协议层协商(MCP/ACP/A2A)只保证语义握手成功，不保证实现正确，必须配合可执行的一致性测试套件(CTS/Conformance)才能建立信任，这与赛题Rollout+LLM-as-Judge评测本质同构，manifest中应有claimed与supported/conformance_test_ref两种状态区分
- 能力应支持运行时动态增减而非仅进程启动时固定一次性协商，借鉴LSP的client/registerCapability机制，为未来引擎在会话中动态加载/卸载技能、MCP server、workflow插件预留架构空间
- 网关对引擎缺失能力的托管/模拟(polyfill，如网关自建memory/room/workflow)应作为Capability Manifest的显式第三态(status:polyfilled)而非隐藏在实现细节里，让上层元编排层能感知'能力来源'与'成本差异'
- Capability ID应采用namespace:capability@version三段式命名（借鉴WIT package与A2A extension URI），避免'memory'这类通用词在不同引擎间语义碰撞
- 能力可分四层tier（core/standard/extension/experimental），对应K8s Conformance基线、LSP可选能力、A2A extensions、MCP experimental四种业界先例，赛题网关规范定义的HTTP端点集合正好对应core层的conformance基线
- AgentCard/manifest的能力声明与实际请求中是否'启用'该能力应是两次独立判断（借鉴A2A的A2A-Extensions header），使网关能按业务方权限动态收紧引擎实际可用能力集合，而不仅依赖引擎自身声明
- conditions风格的状态字段(type/status/reason/message/observedGeneration，只增不减演进)可直接借鉴用于设计跨引擎统一事件信封与manifest版本兼容策略

**关键事实**：
- [high] MCP initialize请求/响应交换capabilities对象，client侧含roots/sampling/elicitation/experimental，server侧含prompts/resources/tools/logging/completions/experimental，子能力如listChanged/subscribe以布尔子对象声明 (https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- [high] MCP协议版本协商：client发送首选最新版本，server支持则原样返回否则回退自身支持版本；HTTP传输需带MCP-Protocol-Version header；规范明确双方MUST仅使用协商成功的能力 (https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
- [high] LSP在initialize静态声明能力外还支持运行时动态注册/注销：client通过dynamicRegistration=true声明支持，server用client/registerCapability与client/unregisterCapability在会话中按需增减细粒度能力，且规范禁止同一能力既静态声明又对同一selector动态注册 (https://microsoft.github.io/language-server-protocol/specifications/specification-3-16/)
- [medium] A2A协议(2025年6月起Linux Foundation托管，2026年v1.0)在AgentCard中用capabilities.extensions字段声明扩展，扩展以AgentExtension对象数组(URI标识)声明，通过HTTP header A2A-Extensions按请求激活 (https://a2a-protocol.org/latest/specification/ 与 https://github.com/a2aproject/A2A/blob/main/docs/topics/extensions.md)
- [high] WebAssembly Component Model的WIT用package(namespace:name@semver)、interface、world三层结构描述接口契约，组件组合时版本是接口身份的一部分，未带版本与带版本视为不同接口 (https://component-model.bytecodealliance.org/design/wit.html)
- [high] K8s Conformance测试是官方e2e测试中打[Conformance]标签的子集，定义所有合规集群必须支持的核心特性；CNCF Certified Kubernetes用Sonobuoy工具运行同一套测试供任意厂商自证 (https://github.com/cncf/k8s-conformance 与 https://sonobuoy.io/certifying-kubernetes-with-sonobuoy/)
- [medium] Terraform Provider Protocol v5/v6中GetProviderSchema RPC响应新增Capabilities字段(PlanDestroy/GetProviderSchemaOptional/MoveResourceState/GenerateResourceConfig)，其中GetProviderSchemaOptional能力位可驱动Terraform core跳过重复RPC改用全局schema缓存 (https://developer.hashicorp.com/terraform/plugin/framework/internals/rpcs 与 https://github.com/hashicorp/terraform/pull/33486)
- [medium] K8s CRD/Operator的status.conditions约定字段为type/status(True|False|Unknown)/reason(PascalCase机读码)/message/lastTransitionTime/observedGeneration，条件类型只增不减以保持向后兼容 (https://maelvls.dev/kubernetes-conditions/ 与 https://kpt.dev/reference/schema/crd-status-convention/)
- [high] VS Code扩展manifest将contributes(静态声明贡献点)与activationEvents(何时激活)分离为两个独立机制，1.74.0起常见贡献点可省略显式激活事件声明 (https://code.visualstudio.com/api/references/activation-events 与 https://code.visualstudio.com/api/references/extension-manifest)
- [high] ACP(Agent Client Protocol，Zed Industries 2025年8月发布，JSON-RPC 2.0 over stdio)的initialize返回InitializeResponse含protocolVersion、agentCapabilities(loadSession、mcpCapabilities.http/sse、promptCapabilities.audio/embeddedContext/image等细粒度布尔声明)、agentInfo；已有Claude Code、Codex、GitHub Copilot、Hermes等harness实现ACP server模式 (https://agentclientprotocol.com/protocol/schema 与 https://github.com/NousResearch/hermes-agent/issues/569)
- [medium] OpenFeature用Provider模式抽象flag后端，类型不匹配等异常执行时约定退回默认值而非报错中断，体现优雅降级设计取向 (https://openfeature.dev/specification/)

**未解决问题**：
- A2A AgentExtension对象的完整字段（是否含required布尔、params schema等）未一手核实，仅基于搜索摘要，需后续直接抓取a2a-protocol.org或GitHub类型定义文件逐字段核对
- OCI Runtime Spec、K8s CRI/CNI/CSI device plugin、Envoy filter chain、SQL feature packs、ONNX opsets、JDBC DatabaseMetaData.supports*、GraphQL introspection、Bluetooth/USB profile、OpenGL/Vulkan/WebGPU extension机制受工具调用预算限制未逐一一手验证，通用结论与已验证领域一致但具体字段形态待补
- Khronos CTS、Web Platform Tests的具体组织方式（用例仓库结构、认证流程细节）未逐一核实，仅以K8s conformance作为代表性案例引用

## T24 AI 资产模型：skills/plugins/rules/prompts/MCP 在各引擎中的格式与可移植性
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T24-assets-skills-plugins.md

**摘要**：调研了 Claude Code、Codex、Gemini CLI、opencode、pi、Hermes、OpenClaw、dsh 八种引擎的资产模型（skills/plugins/rules/prompts/MCP）。核心发现：agentskills.io 的 SKILL.md 规范（name/description必需frontmatter+progressive disclosure）已是事实标准，被多引擎直接或事实兼容；AGENTS.md 成为跨工具规则文件收敛点(60000+项目)，但Claude Code仍需桥接；MCP是唯一协议级可移植资产；各引擎Plugin manifest格式(plugin.json/gemini-extension.json/dsh.bundle/openclaw compat)互不相同且多数绑定代码运行时，不可机械互转。报告含8引擎资产格式对比表、可移植性分析、统一资产模型设计建议及接入检查清单，已写入文件。

**接入面**：资产装载发生在会话/进程启动阶段（扫描约定目录/解析manifest/注入system prompt），Agent网关的主要接入点是：部署期把编译好的资产文件放到目标引擎约定路径下、通过引擎自身manifest声明MCP server列表、部分引擎支持CLI动态加载(--plugin-dir等)按业务/租户注入资产。这与赛题"不要求热切换、分轮次启动不同引擎"的约束天然契合——资产热更新本质是"改文件+重启会话"。

**公共能力**：Skill(SKILL.md,agentskills.io规范,name/description frontmatter+progressive disclosure)；规则/上下文文件(AGENTS.md收敛标准,项目级自然语言约定)；MCP Server声明(唯一协议级可移植资产,local/remote两类,name+command|url+args+env)；命令/Prompt模板(参数化prompt片段,语义相近但文件格式各异)

**扩展能力**：代码化插件/hooks(Claude Code hooks.json声明式 vs opencode plugins/*.ts命令式 vs dsh Cordis插件重写子系统)；Plugin manifest结构与版本策略(plugin.json/gemini-extension.json/dsh.bundle patch/openclaw compat声明,semver vs commit SHA pin vs profile组合三态并存)；细粒度权限矩阵(opencode十项能力×allow/ask/deny vs Claude Code allowed-tools空格分隔白名单)；Marketplace/分发信任链(Claude Code双市场+SHA pin、ClawHub三类包、Hermes Skills Hub聚合11个registry)

**设计启示**：
- 统一资产模型应以SKILL.md为技能标准形态,编译器对其它引擎只做路径投影+frontmatter字段裁剪(如去掉不支持的allowed-tools)
- 规则资产应以AGENTS.md为规范源,编译期为Claude Code额外生成/软链CLAUDE.md,为Cursor额外投影.cursor/rules/*.mdc
- MCP server定义应作为资产编译器的一等公民,统一schema后投影到各引擎自己的配置容器字段(独立文件/内嵌manifest/总配置子键三种形态)
- 权限schema应以opencode的能力项×allow/ask/deny矩阵为超集设计,向下裁剪为白名单容易,反向升维困难
- 代码化插件/hooks不可机械跨引擎编译,统一资产模型对其应仅登记元数据(能力描述+所需引擎+版本要求),按引擎分别维护实现文件,网关部署时选择性拷贝并标注能力损耗
- 版本字段需同时表达semver/commitSHA/profile名三种形态以兼容各引擎的版本管理策略差异
- 新引擎接入的资产维度检查清单：SKILL.md兼容性与扫描路径、AGENTS.md原生支持与桥接方式、MCP配置字段名与位置、插件是否需代码沙箱及信任声明、权限字段粒度与语义映射

**关键事实**：
- [high] agentskills.io SKILL.md frontmatter必需字段为name(≤64字符,小写字母数字连字符)和description(≤1024字符)；可选license/compatibility/metadata/allowed-tools(实验性) (https://agentskills.io/specification)
- [high] Progressive disclosure三层加载：metadata(~100 tokens常驻)→SKILL.md全文(激活时,建议<5000 tokens)→scripts/references/assets(按需) (https://agentskills.io/specification)
- [high] Claude Code Plugin结构：.claude-plugin/plugin.json仅放manifest,插件根目录下有skills/、commands/、agents/、hooks/hooks.json、.mcp.json、.lsp.json、monitors/monitors.json、bin/、settings.json (https://code.claude.com/docs/en/plugins)
- [high] AGENTS.md是标准Markdown无强制字段，被60000+开源项目采用，支持工具含Codex/Gemini CLI/Cursor/opencode/goose/Amp等，嵌套文件时最近的AGENTS.md优先级最高 (https://agents.md/)
- [high] opencode agent用Markdown+YAML frontmatter定义(description/mode/model/temperature/permission/prompt字段)，permission字段对read/edit/bash/glob/grep/list/webfetch/websearch/lsp/skill/task逐项设allow/ask/deny (https://opencode.ai/docs/agents/)
- [medium] opencode rules解析顺序为项目内向上遍历AGENTS.md/CLAUDE.md→全局~/.config/opencode/AGENTS.md→~/.claude/CLAUDE.md(可关闭) (WebSearch摘要 opencode.ai/docs/rules/)
- [medium] Gemini CLI Extension由gemini-extension.json(name/version/mcpServers/contextFileName)定义，加载自~/.gemini/extensions，命令通过commands/*.toml提供 (WebSearch摘要 github.com/google-gemini/gemini-cli docs/extensions/reference.md)
- [medium] pi用npm/git包(packages)分发Extension(TypeScript)、Skill(指令+工具,按需加载)、Prompt Template(Markdown,/name展开)、Theme (https://github.com/earendil-works/pi, https://pi.dev/)
- [medium] OpenClaw明确区分Skill(纯SKILL.md+脚本,无代码)与Plugin(含代码/凭证/生命周期钩子,package.json需声明openclaw.compat.pluginApi和openclaw.build.openclawVersion)，由ClawHub统一注册分发 (https://github.com/openclaw/clawhub, https://docs.openclaw.ai/tools)
- [medium] DeepSeek Harness(dsh)基于Cordis运行时,一切皆插件(model/tool/skill/session/sandbox/storage/loop/scheduling/UI均可插件化)，分发单元为npm包bundle(manifest字段dsh.bundle,patch式)，用户以dsh --profile <name>启动 (https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish, https://springbrand.ai/deepseek-harness)
- [low] Codex CLI Plugin系统整合此前分散的config.toml MCP条目+散落SKILL.md+手动App配置为单一单元，manifest在.codex-plugin/plugin.json；此断言未一手核实，仅来自WebSearch摘要 (https://developers.openai.com/codex/skills, https://codex.danielvaughan.com/2026/03/30/codex-cli-plugin-system/)
- [high] Dotprompt(.prompt文件)=YAML frontmatter(模型/参数/输入输出schema)+Handlebars模板正文，语言/模型无关，是Firebase Genkit的prompt-as-code格式 (https://github.com/google/dotprompt, https://firebase.google.com/docs/genkit/dotprompt)
- [high] Claude Code社区市场插件经审核后pin到具体commit SHA分发(anthropics/claude-plugins-community的marketplace.json) (https://code.claude.com/docs/en/plugins)

**未解决问题**：
- Hermes/OpenClaw/dsh的Skill与Plugin manifest确切JSON schema未直接一手核实,需查raw.githubusercontent.com或deepwiki.com源码
- Codex官方developers.openai.com/codex/skills与.codex-plugin/plugin.json字段未直接WebFetch核对,存在过时风险,需二次验证
- pi的MCP配置位置与Extension manifest具体字段未获取一手README全文
- dsh是否兼容SKILL.md格式及其MCP集成方式缺乏官方一手确认
- Windows环境下各引擎资产目录(%USERPROFILE%等)的实际路径映射未验证,需在部署自动化脚本中单独核实

## T26 群助手（IM 群聊机器人）业务模式与网关接口形态
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T26-group-assistant-patterns.md

（结构化摘要缺失，请直接阅读文件）

## T28 中国 Agent 生态与"Agent 网关+引擎"相关实践
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T28-chinese-ecosystem.md

**摘要**：调研了中国 Agent 生态中与"Agent 网关+多引擎"架构最相关的实践。腾讯云 ADP 用 Adapter 模式在 OpenCode/Claude Code 间切换，配 Part/Message/Session 三层会话结构与三层权限（企业/空间/应用）及多层 Transcript 可观测方案，是与赛题最贴近的国内案例（细节未开源）。阿里 AgentScope Runtime 是开源验证程度最高的项目，Engine+Sandbox 双核心，session_id/user_id 双键管理会话与沙箱。字节 Coze Studio/Loop/Eino 展示开发平台/AgentOps/编排引擎分层。腾讯 CodeBuddy CLI 命令行参数几乎是 Claude Code 镜像，是引擎适配器字段映射的极佳参照。DeepSeek Harness 用 Cordis 插件框架+seam 能力抽象+turn/step 事件溯源，语义比 opencode 更严格。国内 IM 生态方面 OpenClaw 已有中国区 fork（openclaw-china/MaxClaw）覆盖飞书/钉钉/企业微信/QQ，用轻量策略字段做权限控制；企业微信官方 Webhook 单向限制是群助手网关设计的现实约束。iFlow CLI 有停止维护的二手报道，建议接入前核实。

**接入面**：CLI headless模式(如CodeBuddy的-p/--resume/--agents/--sandbox)、session_id+user_id双键会话模型(AgentScope)、插件化profile/bundle+seam能力抽象(DeepSeek Harness)、Adapter模式多引擎切换(ADP)、事件溯源turn/step模型(DeepSeek Harness)、企业微信/飞书/钉钉Webhook与自建应用回调双链路(IM渠道接入)

**公共能力**：session创建/续接/隔离(session_id+user_id或Part/Message/Session)；权限模式(只读/可执行/需审批的标准角色)；自定义模型端点(OpenAI/Anthropic兼容base_url/api_key)；会话压缩/摘要(compact信号)；Transcript/事件轨迹(message part类型+step-finish)；Sandbox/执行环境隔离(网关只关心是否隔离)

**扩展能力**：Multi-agent/team(粒度与协议差异大: JSON子agent配置 vs parentSessionId父子会话 vs 标准A2A协议)；Dynamic workflow/图编排(Eino式预编译图结构)；ACP协议兼容(Kimi CLI作为ACP Server)；长期记忆子系统(国内资料薄弱，暂不标准化)；插件市场/资产分类(Coze Studio的Prompt/RAG/Plugin/Workflow四类)

**设计启示**：
- 网关层与AI网关(LLM流量治理，如Higress的ai-proxy/ai-token-ratelimit)是两个不同层次，真实业务系统里Agent网关在上、AI网关在下，两者应分层设计而非合一
- 国内引擎的multi-agent实现粒度差异巨大(进程内子agent JSON vs 独立session父子关系 vs 标准A2A协议)，能力协商协议需要把multi-agent拆成'编排粒度'+'互联协议'两个可比较维度，不能用单一布尔值表示
- DeepSeek Harness的turn/step事件溯源模型比opencode的message/part模型更严格(有完备性运行时断言)，接入时需要专门的事件语义映射层，不能假设所有引擎事件粒度一致
- 企业微信等国内IM渠道存在Webhook只发不收的硬约束，双向交互必须走自建应用回调，群助手网关设计不能假设所有IM渠道对称支持收发
- DeepSeek Harness的seam抽象(Service Definition+Provider+Consumer)比简单插件注册表更强，替换一个Provider可联动重定向多个Consumer(如换文件系统Provider同时影响Bash/PTY/LSP)，值得借鉴用于设计底层能力可替换性
- CodeBuddy CLI命令行参数体系几乎是Claude Code的镜像，说明国内厂商已经对Anthropic生态的CLI接入面形成事实标准，可作为我们引擎适配器字段映射的直接参照基线
- iFlow CLI存在停止维护的二手报道，建议在最终候选引擎清单中标注风险，接入前核实其官方仓库最新状态

**关键事实**：
- [medium] 腾讯云ADP通过环境变量CODETOOL_ADAPTER在OpenCode与Claude Code两种harness间切换，编译期模板替换实现零运行时开销 (https://adp.tencent.com/zh/blog/agent-harness-engineering-adp-practice)
- [medium] ADP会话存储为Part/Message/Session三层结构，Part为最小语义单元；支持session级智能压缩(compact) (https://adp.tencent.com/zh/blog/agent-harness-engineering-adp-practice)
- [medium] ADP权限模型分企业级/空间级/应用级三层，AgentType区分general-purpose/explore(只读)/verification(只读+需PASS/FAIL) (https://adp.tencent.com/zh/blog/agent-harness-engineering-adp-practice)
- [medium] ADP可观测性用主会话Transcript+Sidechain Transcript(子agent)+LLM Gateway Transcript三层，字段含agentId/agentType/teamName/parentSessionId/traceId (https://adp.tencent.com/zh/blog/agent-harness-engineering-adp-practice)
- [high] AgentScope Runtime采用Engine(FastAPI服务+A2A协议)+Sandbox(隔离执行环境)双核心架构，SandboxService用session_id+user_id管理会话级沙箱 (https://runtime.agentscope.io/zh/sandbox/sandbox_service.html)
- [high] AgentScope Runtime CLI提供chat/web/run/deploy四类命令，deploy支持ModelStudio/AgentRun/K8s/Knative/Kruise (https://runtime.agentscope.io/zh/cli.html)
- [high] OpenClaw中国区有openclaw-china、MaxClaw等fork，社区昵称'小龙虾'，覆盖飞书/钉钉/企业微信/QQ渠道，用dmPolicy/groupPolicy/allowFrom做权限控制 (https://github.com/BytePioneer-AI/openclaw-china)
- [high] 腾讯云CodeBuddy CLI支持-p/--print非交互模式、--output-format stream-json、--resume恢复session、--agents JSON自定义子agent、--sandbox容器/E2B沙箱 (https://www.codebuddy.ai/docs/zh/cli/cli-reference)
- [high] DeepSeek Harness(dsh)基于Cordis插件框架，能力抽象为seam(Service Definition/Provider/Consumer三元组)；session log是模型上下文唯一权威来源，遵循'Model-visible means already logged'不变式 (https://deepseek-harness.github.io/deepseek-harness/reference/)
- [high] 企业微信群机器人Webhook只支持发消息不支持收消息，双向交互需接入自建应用消息回调(涉及OAuth) (https://developer.work.weixin.qq.com/document/path/99110)
- [medium] 字节跳动开源Coze Studio(Apache2.0)、Coze Loop(AgentOps全生命周期管理)及此前开源的Eino(类LangGraph图编排引擎) (https://zhuanlan.zhihu.com/p/1971193992436757158)
- [low] iFlow CLI(阿里心流团队)据报道已于2026-03-20停止维护、2026-04-17下线，用户迁移至Qoder CLI (https://zhuanlan.zhihu.com/p/1961439434986721730)
- [medium] Kimi CLI原生支持ACP(Agent Client Protocol)，可作为后端被Zed等ACP客户端驱动 (https://txtmix.com/posts/tech/moonshotai-kimi-cli-terminal-agent/)

**未解决问题**：
- ADP的Adapter模式(CODETOOL_ADAPTER)具体接口契约是否与opencode server API同构，未见开源代码无法验证
- 国内引擎的长期记忆标准化程度不明，未找到类似mem0/Zep的记忆层在国内harness中的一手实践资料
- Kimi CLI的ACP支持细节(消息格式、session resume语义)未做源码级验证，仅基于社区文章
- openclaw-china的群会话隔离是否有精确对应到底层引擎session的语义，还是仅消息路由层隔离，需要进一步读源码确认
- Youtu-Agent、Eino、Coze Studio的具体headless CLI/API接入形态未直接抓取官方GitHub README验证

## T29 Agent 团队 / Room / Agent 间直接通信能力的形态与跨引擎实现
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T29-agent-teams-rooms.md

**摘要**：调研了 Claude Code Agent Teams、Hermes delegate_task、OpenClaw 多agent/ACP、opencode subagents、Gemini CLI subagents、Amp Oracle 等引擎的团队/委派能力，以及 A2A/ACP 协议、AutoGen/CAMEL/MetaGPT 等 Room 框架。发现多agent协作能力可分三档：L1委派（多数引擎已支持，子agent单向、结果摘要回传）、L2对等团队（仅Claude Code实验性支持，mailbox+共享任务看板，且split-pane模式不支持Windows Terminal——与赛题Windows评测环境直接冲突）、L3 Room/GroupChat（纯应用框架层，无引擎原生支持）。跨引擎通信有两个易混淆协议：A2A（agent发现与协作）与ACP（Agent Client Protocol，OpenClaw用于接入外部harness的会话协议，与赛题网关规范高度同构）。给出了公共能力/扩展能力映射表、新引擎接入的能力探测清单，以及网关托管polyfill room的具体实现方案。

**接入面**：网关会话生命周期设计可直接参照OpenClaw的ACP binding抽象（route/acp、--bind here、持久化bindings[]配置）；多agent团队能力应定义为标准扩展能力team.v1，字段映射表覆盖各引擎的toolsets/tools+permission.task/tools.agentToAgent.allow等工具隔离参数与max_concurrent_children等并发参数；能力协商阶段需上报implementation:native vs gateway_polyfill。

**公共能力**：单次任务委派(子session执行→摘要回传, L1 delegate)；子agent工具白名单隔离(字段名各异但语义可归一化为allowed_tools)；并发子agent数量限制(可归一化为max_concurrent_agents)；会话-业务绑定的持久化映射(近似ACP binding语义)

**扩展能力**：team.v1 对等团队(mailbox+共享任务看板+plan approval，仅Claude Code原生支持，experimental)；split-pane可视化(依赖tmux/iTerm2，Windows不可用)；room.v1 GroupChat式广播协作(AutoGen/CAMEL/MetaGPT风格，无引擎原生支持，需网关自建)；hierarchical session navigation(opencode PR#7756，委派树可视化下钻)；ACP backend plugin式外部harness接入(OpenClaw特有的网关级扩展点)

**设计启示**：
- 多agent协作能力应按耦合强度分三档(L1委派/L2团队/L3 Room)设计能力矩阵，而非笼统的'是否支持多agent'布尔值，因为绝大多数引擎只有L1，L2目前仅Claude Code(experimental)支持，L3从未由引擎原生提供。
- Windows Terminal不支持Claude Code的split-pane团队模式，这与赛题Windows评测环境直接冲突——若展示Agent Teams能力必须用in-process默认模式，需要在架构设计中明确写出此约束及应对方案。
- A2A与ACP(Agent Client Protocol)是两个完全不同、易混淆的协议，架构文档必须显式区分：A2A面向agent间能力发现与协作，ACP面向网关/客户端接入外部harness的会话协议，后者与本赛题网关规范定位一致，可作为设计参照对象。
- 当引擎缺失L2/L3能力时，网关应托管一个引擎无关的polyfill room：成员表{name,engine,session_id,role}+发布订阅消息总线+共享任务板(依赖阻塞+原子claim)+可配置终止条件，参考Gemini CLI社区方案summon.js+nexus.js的'外部进程编排+IPC总线'范式，并在能力协商中如实标注native/gateway_polyfill。
- 跨agent消息不能被当作用户授权凭证：Claude Code auto模式把其他agent转发的'批准声明'视为不可信输入并逐条审查，这一权限模型应被我们的网关采纳为跨agent/跨室通信的强制安全规则。
- 新引擎接入team能力时需要标准化的探测清单：委派方向(单向/对等)、通信通道形态(文件轮询/WebSocket/无)、工具范围参数名、并发限制参数名、子agent是否可resume、是否有特殊审批消息类型需要网关识别放行。

**关键事实**：
- [high] Claude Code Agent Teams需设置CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1才启用，默认关闭；v2.1.178起TeamCreate/TeamDelete工具已移除，改为Agent工具传name参数自动建队 (code.claude.com/docs/en/agent-teams)
- [high] 每个agent的mailbox是JSON文件，路径~/.claude/teams/{team-name}/inboxes/{agent-name}.json；team名称由session ID派生(session-+前8字符) (code.claude.com/docs/en/agent-teams)
- [high] Split-pane团队模式需要tmux或iTerm2+it2 CLI，明确不支持Windows Terminal/VS Code集成终端/Ghostty；默认模式是in-process（单终端内，任何终端可用） (code.claude.com/docs/en/agent-teams)
- [high] Claude Code Teams限制：一个session只能有一个team；teammate不能嵌套spawn自己的teammate；lead身份固定不可转移；teammate不继承lead会话历史；plan approval自动批准无需用户确认 (code.claude.com/docs/en/agent-teams)
- [high] Hermes delegate_task参数：goal, context, max_iterations(默认50), role(leaf/orchestrator)；批量用tasks数组；并发配置delegation.max_concurrent_children(默认3)；子agent间无直接通信通道 (hermes-agent.nousresearch.com/docs/user-guide/features/delegation)
- [high] OpenClaw bindings支持type=route(普通路由)与type=acp(持久化ACP会话绑定)；ACP指Agent Client Protocol(agentclientprotocol.com)而非IBM ACP，用于接入Claude Code/Cursor/Copilot/Gemini CLI等外部harness (docs.openclaw.ai/gateway/config-agents, docs.openclaw.ai/tools/acp-agents)
- [medium] OpenClaw sessions_spawn异步创建子session返回runId/childSessionKey；权限层用tools.agentToAgent.allow/enabled控制跨agent直接访问，tools.sessions.visibility控制可见性 (docs.openclaw.ai/tools/subagents, docs.openclaw.ai/concepts/multi-agent)
- [medium] opencode Task工具的subagent_type截至检索时硬编码只接受explore/general/mary三种内置类型，程序化调用自定义subagent的feature request(#20059)尚未合并；PR #7756引入subagent-to-subagent delegation含预算/持久化session/层级导航 (github.com/anomalyco/opencode issues #20059 #7296, PR #7756)
- [medium] Gemini CLI官方Subagents为独立上下文+受限工具集+摘要返回模式；社区polyfill方案summon.js(编排器)+nexus.js(WebSocket IPC总线)在Gemini CLI外部补齐团队协作/Task编排能力 (developers.googleblog.com/subagents-have-arrived-in-gemini-cli/, github.com/obra/superpowers/issues/872)
- [high] A2A(Agent2Agent)协议由Linux Foundation治理，核心是Agent Card+Message(含Part)+Task，三种transport(JSON-RPC 2.0/gRPC/HTTP+REST)行为对等；IBM旧ACP已于2025-08-29并入A2A (a2a-protocol.org/latest/specification/, github.com/a2aproject/A2A, Wikipedia Agent2Agent)
- [medium] Agent Client Protocol(agentclientprotocol.com)与A2A是完全不同的两个协议，前者是Zed发起的编辑器/客户端-agent会话协议，OpenClaw用它接入外部coding harness (docs.openclaw.ai/tools/acp-agents (引用agentclientprotocol.com))

**未解决问题**：
- opencode PR #7756(subagent-to-subagent delegation)在2026-09-04检索时的合并/发布状态未确认，需选型前核实
- dsh(DeepSeek Harness)、Pi、Goose的多agent/团队能力本专题未检索到一手资料，需其他专题补充调研
- 是否有候选引擎原生实现A2A/ACP作为服务端协议(而非仅被网关当客户端接入)尚未逐一核实
- Claude Code mailbox轮询周期是否为1秒(仅依据bug描述'every second'推测)未经源码验证

## T30 会话记录格式与跨引擎上下文可移植性（中途切换引擎）
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/T30-context-portability.md

**摘要**：调研了 Claude Code(JSONL)、Codex CLI(rollout JSONL)、pi(树状JSONL)、OpenCode(session/message/part分层存储)、Gemini CLI(checkpoint JSON)五个引擎的会话转录格式，以及 ACP/A2A/OpenAI Responses/Vercel UIMessage 四种消息schema。核心结论：各引擎私有转录格式普遍不承诺跨版本稳定（Claude Code官方明确警告），应通过官方API而非解析文件做跨引擎迁移；工具调用/结果配对可归一化但id需重新生成，thinking/reasoning内容与prompt cache标记本质不可跨供应商移植；Anthropic官方harness文章证明超长任务应靠"结构化handoff文件+git commit"而非单纯压缩，这是我们应主推的切换模式；pi的树状id/parentId结构+显式版本迁移机制是最佳可移植性设计范例。Hermes/dsh/OpenClaw/Goose因搜索配额耗尽未能核实，是本报告最大缺口。

**接入面**：跨引擎会话/上下文迁移的正式接入点应为各引擎官方HTTP API或SDK（对齐赛题网关规范的 POST /session、GET /session/{id}/message），而非直接解析各引擎私有的JSONL/文件存储格式；网关层需维护独立的 turn_id/tool_call_id 生成器与跨引擎id映射表，并将"任务状态外部化到工作区文件系统(进度文件+git)"作为默认的引擎切换机制。

**公共能力**：用户/助手文本轮次(role+text)；工具调用与结果配对(tool_use/tool_result，需重新生成id)；会话元信息(title/directory/cwd)；压缩/摘要机制(以图上压缩节点建模)；基于SSE/事件流的会话内实时更新(ACP session/update 与赛题GET /event同构)

**扩展能力**：pi的树状分支(id/parentId)与branch_summary；Claude Code的/branch同进程权限继承 vs --fork-session不继承；OpenCode的session.share()/summarize()服务端一等API；Gemini CLI的影子git仓库checkpoint机制；thinking/reasoning内容的供应商私有签名(如Claude thinking signature)；Prompt cache标记(cache_control breakpoints，引擎/供应商特有不可移植)

**设计启示**：
- Universal Session Record应以'追加式压缩节点'(保留retainedTail)建模压缩，而非覆盖式重写历史，参考pi的compaction entry设计
- '共享工作区+任务书'(结构化handoff文件+git commit)应作为默认的跨引擎切换模式，而非转录重放；因为赛题的Windows办公任务(Word/Excel/PPT/文件操作)天然可将状态外部化到磁盘产物
- thinking/reasoning内容与prompt cache标记不应作为可移植字段处理：迁移后目标模型不应将旧thinking当作自己的推理，cache命中率归零是切换引擎必然产生的成本
- 权限/授权状态不应放入会话转录正文，而应作为独立的运行时状态，跨引擎切换必须强制重新协商权限，不能信任旧转录里的授权记录
- 引擎私有JSONL/文件格式不应作为对外契约（Claude Code官方明示格式跨版本不稳定），Universal Session Record的数据源应锚定在各引擎的官方HTTP API/SDK输出上，这与赛题网关规范采用HTTP API而非文件格式的设计选择一致

**关键事实**：
- [high] Claude Code会话存储于~/.claude/projects/<project>/<session-id>.jsonl，官方明确声明该entry格式"internal... changes between versions"，建议用/export、-p --output-format json、hooks transcript_path或Agent SDK而非直接解析 (https://code.claude.com/docs/en/sessions)
- [high] Anthropic官方harness博客指出compaction不足以支撑超长任务，需做完全上下文重置：JSON格式feature list(category/description/steps/passes)+claude-progress.txt+git commit作为结构化handoff (https://anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [high] pi会话为JSONL存储于~/.pi/agent/sessions/，条目用id/parentId(8字符hex)显式建树支持原地分支，有v1(线性)→v2(树)→v3(hookMessage改名custom)三次版本演进并自动迁移 (https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)
- [high] pi的compaction entry类型采用追加式而非覆盖式：保留summary/tokensBefore/retainedTail字段，原始行不删除 (https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md)
- [medium] 跨引擎压缩策略对比：Claude Code用~95%阈值+手动/compact；Codex用180k-244k token阈值95%安全边际；OpenCode检测tokens>context_limit-output_limit并有独立40K工具输出剪枝；Amp完全手动无自动压缩 (https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f)
- [medium] OpenCode会话存储为session/message/<sid>/part/<mid>/三层文件树而非单一JSONL，SDK返回{info:Message, parts:Part[]}，Part类型含text/tool/step-start/step-finish (https://opencode.ai/docs/sdk/)
- [medium] OpenCode export写出的session JSON在1.4.3版本下import无法读回，说明官方导出/导入格式本身互操作性不成熟 (https://github.com/anomalyco/opencode/issues/21941)
- [medium] OpenAI Responses API用扁平items数组(message/reasoning/function_call/function_call_output)取代Chat Completions消息列表，function_call_output必须通过call_id回指对应function_call (https://platform.openai.com/docs/guides/migrate-to-responses)
- [high] ACP的session/update用SessionUpdate联合类型(agent_thought_chunk/agent_message_chunk/tool_call/tool_call_update等)承载增量输出，ContentBlock仅强制要求text与resource_link，其余需显式opt-in协商 (https://agentclientprotocol.com/protocol/schema)
- [high] A2A协议Part为TextPart|FilePart|DataPart联合类型，Artifact由多个Part组成，FilePart支持base64内联或URI引用 (https://a2a-protocol.org/v0.3.0/specification/)
- [high] Claude Code resume时若会话超1小时不活跃且>100K tokens会弹窗提供Resume from summary/Resume full session as-is/Don't ask again三种选择，权限模式恢复与否取决于恢复路径（终端/-p/session picker各不同） (https://code.claude.com/docs/en/sessions)
- [medium] Gemini CLI checkpoint(默认关闭)在工具执行前同时保存影子git仓库快照(~/.gemini/history)与完整对话+工具调用JSON(~/.gemini/tmp/<hash>/checkpoints)，普通会话存于~/.gemini/tmp/<hash>/chats/ (https://github.com/google-gemini/gemini-cli/blob/main/docs/checkpointing.md)

**未解决问题**：
- Hermes(是否真为SQLite存储)、DeepSeek Harness(dsh)、OpenClaw、Goose的具体会话/转录格式本次未能核实，需后续专题补充一手资料
- Codex的reasoning items在codex resume时是否原样回传给模型还是仅本地展示，需读官方源码确认
- OpenCode session/message/part的字段级JSON Schema未能获取，需直接读取packages/sdk/js/src/gen/types.gen.ts源码
- Claude Code /compact自动触发阈值(83.5% vs 95%)在官方文档与第三方文章间的确切关系需专门核实最新context-window文档
- ACP与A2A是否各自定义了'会话导出/持久化'的标准存储格式（而非仅传输态协议）尚未确认

## G01 候选引擎的 Windows 10/11 原生兼容性与自动化部署
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/G01-windows-compatibility.md

**摘要**：调研了11个候选Agent引擎在Windows 10/11上的原生兼容性。Codex CLI唯一有完整原生Windows沙箱工程（v0.100.0转正，四层防御）；Cline CLI发布原生预编译二进制；Hermes Agent工程投入完整但标注early beta；Claude Code有原生安装器+PowerShell工具但沙箱需WSL2；OpenCode官方明确推荐WSL而非原生Windows，与赛题硬约束存在冲突需实测验证；多数引擎默认走Git Bash执行shell；DeepSeek Harness以浏览器为界面、预览阶段有破坏性变更风险；Goose的goosed后端提供REST+SSE API架构上贴合网关+引擎分层思路。产出"引擎×Windows可用性"风险矩阵及公共能力/扩展能力映射、接入参数清单。

**接入面**：网关层的进程生命周期管理（启动/停止/健康检查）、shell执行意图抽象（execute_command）、无人值守启动的配置预置（%USERPROFILE%/%LOCALAPPDATA%下的config文件+环境变量注入）应作为跨引擎公共能力统一封装；服务化托管建议由网关自建NSSM/Windows Service包装所有引擎，而非依赖各引擎自带的（不一致的）服务化脚本；沙箱能力应作为可声明的"降级状态"字段（none/app-layer-allowlist/os-native-sandbox），供权限模型做补偿控制。

**公共能力**：进程生命周期管理（启动/停止/健康检查/日志采集）；shell命令执行意图抽象（execute_command，底层可为PowerShell/Git Bash/cmd）；无人值守启动的配置文件预置与环境变量注入；无头/headless单次执行模式

**扩展能力**：Codex CLI原生Windows elevated沙箱（专用账户+ACL+防火墙+本地策略四层防御）；Hermes Windows计划任务服务化（ONLOGON触发器）；DeepSeek Harness浏览器优先交互模式（dsh web，非纯CLI/HTTP）；Goose recipe驱动的无头编排（goosed REST+SSE 103 endpoints）；Claude Code原生PowerShell工具（v2.1.84+，直接spawn pwsh.exe）

**设计启示**：
- OpenCode的server API协议形态与赛题网关规范高度相似，容易被默认选为首选引擎，但其官方文档明确不推荐纯原生Windows部署，这是最需要警惕的选型陷阱，必须做原生Windows实测而非只信文档措辞
- 沙箱能力在候选引擎间高度不均衡（仅Codex CLI有完整内核级隔离），网关层的权限模型必须支持'声明降级状态'而非假设所有引擎都提供同等隔离，用应用层工具调用白名单做补偿
- Git Bash依赖是系统性风险点：pi、Kimi CLI、旧版Claude Code、Hermes均默认走Git Bash执行shell，办公任务（PowerShell操作Office COM对象）需要网关侧显式配置PowerShell工具而非依赖引擎默认行为
- Hermes的自举式安装（把Python/Node/Git都下载进%LOCALAPPDATA%）和UTF-8控制台修复（configure_windows_stdio）是无人值守Windows部署的优秀参考实现，可提炼为网关侧的通用部署检查清单
- 引擎的Windows服务化方式差异很大（Hermes用计划任务，其余多数无原生服务化），建议网关层统一自建NSSM/Windows Service包装层而不依赖各引擎自带方案，以保持跨引擎架构一致性
- DeepSeek Harness以浏览器为主要交互界面而非纯命令行/HTTP API，若评测环境要求无浏览器无头执行，需要单独验证其--profile headless模式是否支持完整session轨迹导出（当前证据仅显示'打印结果退出'）
- 接入新引擎时应建立标准化参数清单（shell_backend、runtime_deps、headless_entry、service_wrap_strategy、sandbox_level、config_home、encoding_fixups）作为'能力识别→适配→认证'流程的输入模板

**关键事实**：
- [high] OpenCode官方文档明确strongly recommend在Windows上使用WSL而非原生Windows，原生Windows虽可运行但文件系统性能/终端支持/工具兼容性均较弱 (https://opencode.ai/docs/windows-wsl/)
- [high] OpenCode提供opencode serve无头服务器，暴露OpenAPI 3.1 spec，端口可通过--port/--hostname指定，支持OPENCODE_SERVER_PASSWORD做HTTP Basic Auth (https://opencode.ai/docs/server/)
- [high] pi coding agent在Windows默认用Git Bash（按自定义路径→Git Bash标准位置→PATH查找），并提供可选PowerShell工具，可通过~/.pi/agent/settings.json的defaultTools/shellPath配置 (https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/windows.md)
- [high] Hermes Agent原生Windows支持标注为early beta，PowerShell一键安装脚本自动配置uv/Python 3.11/Node 26/PortableGit，全部装入%LOCALAPPDATA%\hermes (https://hermes-agent.nousresearch.com/docs/user-guide/windows-native)
- [high] Hermes gateway在Windows通过Windows计划任务（ONLOGON触发器+pythonw.exe无控制台后台运行）实现服务化，hermes gateway install/start/stop/status管理 (https://hermes-agent.nousresearch.com/docs/user-guide/windows-native)
- [medium] DeepSeek Harness (dsh) 无官方桌面应用，Windows上通过npx @deepseek-ai/dsh web启动本地服务器（默认端口3080，Node≥22.19），提供dsh --profile headless单次无头模式 (https://www.orcarouter.ai/blog/deepseek-harness-windows-tui)
- [high] Codex CLI原生Windows elevated沙箱模式在v0.100.0从实验特性转正，通过专用低权限账户(CodexSandboxUsers组)+文件系统ACL+Windows防火墙出站规则+本地策略四层防御实现隔离 (https://github.com/openai/codex/discussions/6065 及 https://developers.openai.com/codex/windows)
- [medium] Claude Code v2.1.84（2026-03-26）引入原生PowerShell工具直接spawn pwsh.exe/powershell.exe，此前默认经Git Bash路由shell命令；OS级沙箱(Seatbelt/bubblewrap)在原生Windows上不可用，需WSL2 (聚合多篇第三方2026年Claude Code Windows指南)
- [medium] Goose的goosed后端以REST+SSE HTTP API（约103个endpoint）暴露完整Agent能力，goose run支持recipe驱动无头执行，GOOSE_MODE=auto可预设自动批准工具调用 (https://github.com/aaif-goose/goose 及 https://goose-docs.ai/docs/tutorials/headless-goose/)
- [medium] Kimi Code CLI在Windows上同样依赖Git Bash（需先装Git for Windows），可通过KIMI_SHELL_PATH指定自定义bash.exe路径 (搜索聚合(dev.to, apidog.com))
- [medium] Cline CLI已发布Windows原生预编译二进制（x64/arm64），通过npm i -g cline安装但运行期不依赖Node/Bun/Zig运行时，--json或管道stdin自动切换无头模式 (https://github.com/cline/cline/blob/main/apps/cli/README.md)
- [medium] Claude Code原生安装器要求Windows 10 1809+/Windows Server 2019+，无需Node.js；npm安装方式v2.1.198起要求Node≥22（仅装期需要） (聚合多篇第三方2026年指南(nxcode.io, inventivehq.com, pq.hosting))

**未解决问题**：
- OpenCode的opencode serve脱离WSL在纯原生Windows 10/11环境下的实际稳定性、性能与工具兼容性缺乏实测数据，需要在网关实现阶段做基准测试
- pi coding-agent是否存在类似opencode/goosed的持久化HTTP server/RPC无头模式，本次抓取的官方windows.md未提及，需要专项核实
- Codex的codex app-server具体协议形态（REST+SSE？字段名？）尚未一手核实
- Claude Code是否存在满足赛题'GET /session/{id}/message完整轨迹'要求的持久session无头HTTP server模式（不仅是claude -p单轮打印模式）
- Gemini CLI、Kimi CLI、Qwen Code、Goose的Windows官方一手文档（GitHub README/官方docs站点原文）尚未逐一直接WebFetch核实，本报告对它们的表述多来自搜索引擎聚合摘要
- Hermes的early beta状态在赛题评测时间窗口内是否会有影响网关API字段的重大变更

## G02 内部部署模型接入：各引擎对自定义 OpenAI/Anthropic 兼容端点的支持
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/G02-internal-model-endpoint-compat.md

**摘要**：调研了 10 个候选引擎接入自定义/内部部署 OpenAI/Anthropic 兼容端点的方式。核心结论：引擎分两类——(1) 硬编码单一 wire 协议（Claude Code 仅 Anthropic Messages；Codex 2026-02 起仅 Responses API），只能靠 env 变量换 base URL，协议不匹配需外挂 LiteLLM/claude-code-router 等转换代理；(2) 协议可配置（opencode、pi、Codex provider 声明、dsh、Kimi CLI），可直连内部网关原生协议无需转换。Goose、Qwen Code 遵循 OpenAI SDK 环境变量惯例，接入成本最低。Gemini CLI 用 GOOGLE_GEMINI_BASE_URL 整体重定向但沙箱模式下有已知 bug（变量不透传）。协议转换代理已知坑：流式 tool_calls 参数拼接损坏、cache_control 语义丢失、thinking/reasoning 字段无法映射、Anthropic 工具 schema 严格性。架构建议：网关统一部署模型代理（LiteLLM 或自研），对外同时暴露 OpenAI chat/completions 与 Anthropic Messages，各引擎用配置模板注入方式接入。

**接入面**：环境变量注入（<VENDOR>_BASE_URL/<VENDOR>_API_KEY）+ 配置文件模板渲染（opencode.json/config.toml/settings.yaml/settings.json/models.json）+ 可选协议转换代理（LiteLLM Proxy/claude-code-router）作为网关与硬编码协议引擎之间的适配层

**公共能力**：base URL 覆盖（env var 或 config 字段）；API key 间接引用（$ENV_VAR 语法，避免明文落盘）；启动前配置文件/环境变量注入（无需引擎代码改动）

**扩展能力**：opencode/pi/dsh/Kimi CLI/Codex 的多 wire 协议可选 provider 抽象（openai-completions/anthropic-messages/responses等）；pi 的运行时 registerProvider() 代码级扩展（可附加自定义 OAuth/SSO 流程）；Claude Code/Codex 的单一硬编码协议约束（需转换代理才能接内部 OpenAI 兼容模型）；Gemini CLI 沙箱模式下 base URL 变量不透传的已知限制

**设计启示**：
- 网关应维护一份'引擎→是否需要协议转换'的分类表：opencode/pi/dsh/Kimi CLI/Codex(可配置)/Goose/Qwen Code/Hermes 可直连内部 OpenAI 兼容网关；Claude Code 必须外挂协议转换代理（且官方不背书）；Gemini CLI 需评估其是否真支持 OpenAI chat/completions 直通还是只能重定向 Gemini 协议
- 统一自建/复用一个模型代理（LiteLLM Proxy 或自研）对外同时暴露 OpenAI chat/completions 与 Anthropic Messages 两种协议，作为所有引擎的统一上游，网关自身无需理解引擎特定协议细节
- 新引擎接入的标准流程应包含'探测该引擎的 wire 协议是否可配置'这一步，可配置则直连，硬编码则需要经过转换代理，并把这一分类写入引擎 profile/manifest
- 转换代理必须对 tool_calls 流式增量做完整缓冲后再转发，不能逐 token 直通，否则 reasoning→tool_calls 混合输出的内部模型会导致工具调用参数损坏，直接影响 Windows 办公任务（Word/Excel/PPT 操作依赖工具调用）的评测得分
- Claude Code 官方明确不支持路由到非 Claude 模型，这是候选引擎选择时的重要negative signal——若内部模型非 Claude 系列，Claude Code 的接入成本和风险显著高于 opencode/pi 等协议可配置引擎
- API key 应统一用间接引用（配置文件中写 $ENV_VAR 而非明文），便于网关按 session/租户动态分发密钥而无需改写落盘配置文件
- Windows 原生部署时需特别注意 Gemini CLI 沙箱模式的 base URL 透传 bug，以及各引擎配置文件路径在 Windows 上的等价形式（如 %USERPROFILE%\.gemini\settings.json）

**关键事实**：
- [high] Claude Code 通过 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN 指向自定义端点，但端点必须原生说 Anthropic Messages 协议；官方明确不支持通过网关路由到非 Claude 模型 (https://code.claude.com/docs/en/llm-gateway)
- [high] Codex 的 [model_providers.<id>] 支持 name/base_url/env_key/wire_api/query_params/http_headers/env_http_headers 字段；自定义 provider 不能占用保留 id openai/ollama/lmstudio (https://learn.chatgpt.com/docs/config-file/config-advanced)
- [medium] Codex 的 wire_api 截至 2026-09 官方文档以 responses 为主要取值；第三方来源称 2026年2月起 Chat Completions 支持已移除 (https://learn.chatgpt.com/docs/config-file/config-advanced 及第三方博客)
- [high] pi 的 pi.registerProvider(id, config) 支持 api 字段取值 openai-completions/anthropic-messages/openai-responses/mistral-conversations/google-generative-ai/bedrock-converse-stream (https://pi.dev/docs/latest/custom-provider)
- [high] pi 也支持免代码的 ~/.pi/agent/models.json，其覆盖优先级高于代码注册的 provider (https://pi.dev/docs/latest/custom-provider)
- [medium] opencode 用 opencode.json 的 provider.<id>.npm（@ai-sdk/openai-compatible 或 @ai-sdk/anthropic）+ options.baseURL/apiKey + models 映射配置自定义 provider (https://deepwiki.com/sst/opencode/3.3-provider-and-model-configuration)
- [medium] Goose 用环境变量 GOOSE_PROVIDER=openai + OPENAI_HOST=<base url> + OPENAI_API_KEY + GOOSE_MODEL 配置任意 OpenAI 兼容端点 (https://www.hpc-ai.com/doc/docs/Model-APIs/Integration/Goose/ 及 https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/providers.md)
- [high] Qwen Code CLI 用 OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL 环境变量或 .qwen/settings.json 的 modelProviders 数组；配置优先级 CLI > env(QWEN_*/OPENAI_*) > .qwen/settings.json > 全局 settings > 内置默认 (https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/)
- [high] Kimi CLI 用 TOML [providers.<id>]（type="kimi", base_url, api_key）配置；区分 KIMI_CODE_BASE_URL（OAuth 面向 kimi.com）与 KIMI_BASE_URL（直接 API Key 面向 moonshot.ai）两套变量 (https://moonshotai.github.io/kimi-cli/en/configuration/providers.html)
- [medium] Hermes Agent 的 Custom endpoint 要求 base URL 以 /v1 结尾（自动补 /chat/completions），api_mode 默认 chat_completions，支持 backup provider 链和独立 auxiliary model 路由 (https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
- [medium] Gemini CLI 通过 GOOGLE_GEMINI_BASE_URL 重定向请求，但沙箱模式下该变量不传入容器（已知 issue，需 --sandbox=false） (https://github.com/google-gemini/gemini-cli/pull/2899)
- [high] claude-code-router/CLIProxyAPI 类协议转换代理已知坑：reasoning→tool_calls 混合流会导致工具调用参数 JSON 在拼接中损坏；cache_control 1小时 TTL 难以在转换中保持；Anthropic 工具 schema 省略 type:object 会被部分 OpenAI 兼容后端拒绝 (https://github.com/musistudio/claude-code-router/issues/1397, https://github.com/router-for-me/CLIProxyAPI/issues/3165, https://github.com/router-for-me/CLIProxyAPI/issues/3398)

**未解决问题**：
- Codex wire_api="chat"（Chat Completions）在赛题实际使用的 Codex 版本中是否仍可用，需要实测确认
- dsh（DeepSeek Harness）缺乏官方一手文档，settings.yaml 字段名可信度中等，需要拿到官方源码/文档后复核
- Gemini CLI 是否有官方文档化的'直接说 OpenAI chat/completions 协议'开关，还是只能通过 GOOGLE_GEMINI_BASE_URL 做同协议整体重定向，需要实测
- Hermes Agent 的 auxiliary model 路由与 backup provider 链的确切配置文件 schema 未逐字核对官方 reference 页

## G03 Office 文件处理、Windows GUI 自动化与网页检索能力的注入方式
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/G03-office-and-windows-task-capabilities.md

**摘要**：调研了 Office 文件处理（docx/xlsx/pptx/pdf）、Windows GUI 自动化/computer use、网页检索、代码执行依赖预装、能力注入方式与 Office/Windows benchmark 经验。核心发现：Anthropic 官方 skills 仓库路径为 skills/<name>/SKILL.md（Proprietary许可），docx skill 用 docx-js 建新文档、unzip+编辑XML改已有文档、LibreOffice headless渲染回读校验；OpenCode 是目前唯一确认原生支持扫描加载 SKILL.md 的第三方引擎（多路径含 .agents/skills 事实标准）；Windows GUI 自动化收敛到 UI Automation 协议，Windows-MCP 是代表实现但需要活动图形会话；各引擎内置网页搜索普遍绑定自家云端后端，在"内部模型"约束下可能失效，需通用 MCP 搜索兜底；MCP 配置字段在 opencode/Claude Code/Gemini CLI 间高度同构，为统一资产层提供现实基础；WindowsAgentArena 是权威的154任务Windows评测基准，用确定性状态检查而非轨迹比对。

**接入面**：Office处理优先做成无状态Skill(脚本+预装库)而非常驻MCP server；Windows GUI自动化与网页检索适合做成MCP server(有状态连接)；统一资产层建议采用 .agents/skills/<name>/SKILL.md 为规范路径，投影到各引擎实际扫描路径；MCP清单统一字段{name, transport, command, args, env, enabled}按引擎配置文件字段名转译写入(opencode.json/.mcp.json/settings.json)；需在部署阶段预置Windows侧python venv(python-docx/openpyxl/python-pptx/pandas)+LibreOffice/pandoc/poppler二进制，作为跨引擎共享的运行时依赖清单。

**公共能力**：Office文档读写(docx/xlsx/pptx/csv/pdf)作为Skill形态的公共能力；Windows GUI自动化基础操作(点击/输入/截图/UI树快照)作为MCP工具接口层公共能力；通用网页检索/抓取(MCP搜索server)作为公共能力，而非依赖各引擎内置搜索；代码执行(bash/python/node)作为引擎自带公共能力；文件递归删除等基础文件操作作为公共能力

**扩展能力**：引擎自带的云端绑定式内置搜索(Gemini google_web_search、Claude WebSearch、OpenCode webfetch后端)属于引擎特有扩展能力，在内部模型约束下不保证可用；Goose官方Computer Controller扩展的跨平台自动化封装方式是Goose特有实现细节；Hermes Tool Gateway的computer_use/x_search等统一路由式工具是Hermes特有扩展机制；企业IM官方CLI(飞书/钉钉/企业微信)是环境特有(需企业身份)的扩展能力，非默认路径

**设计启示**：
- SKILL.md已经是事实标准资产格式(YAML frontmatter+Markdown)，.agents/skills是多引擎共享路径，可作为统一资产层的规范落盘位置并向各引擎私有路径投影
- MCP server配置字段在主流引擎间高度同构(command/args/env)，是构建'统一MCP清单→多引擎转译'适配层的现实基础
- Office处理应默认走脚本库路径(python-docx/openpyxl/python-pptx+LibreOffice headless)而非Office COM/GUI路径，因为评测机Office授权不确定，COM路径风险高不作为默认方案
- 各引擎内置网页搜索工具普遍绑定各自云端服务，在'主模型限定为内部部署模型'的硬约束下极可能失效，必须以通用MCP搜索/抓取server作为统一兜底并做好断网降级预案
- Windows GUI自动化依赖活动图形会话，赛题Rollout环境必须确认是有头交互式VM而非无头容器，否则Windows-MCP等工具完全无法工作
- 建议把'渲染回读校验'(生成Office文件后转PDF转图片回读检查)作为标准化的artifact-verification可观测事件纳入统一trace协议
- 代码执行的依赖(python包/LibreOffice/pandoc)应在部署镜像构建阶段统一预置为跨引擎共享环境，而非运行时按引擎各自安装，避免网络不可控导致的失败

**关键事实**：
- [high] anthropics/skills 仓库 docx skill 实际路径为 skills/docx/SKILL.md，license字段为Proprietary（非开源许可），使用 docx-js(npm,预装)建新文档、unzip+编辑word/document.xml+zip改已有文档、pandoc读取、LibreOffice headless(soffice.py)转PDF+pdftoppm转图做渲染回读校验 (raw.githubusercontent.com/anthropics/skills/main/skills/docx/SKILL.md（一手直接抓取）)
- [high] OpenCode 原生支持Skill发现：项目级 .opencode/skills、.claude/skills、.agents/skills 下的 */SKILL.md，全局同名目录在 ~/.config/opencode、~/.claude、~/.agents 下 (https://opencode.ai/docs/skills/)
- [medium] OpenCode MCP配置字段为 mcp.<name>.{type(local|remote), command, args, env, enabled}，permission字段可对webfetch等工具设allow/ask/deny (https://opencode.ai/docs/config/ (WebFetch摘要))
- [medium] Windows-MCP(CursorTouch) 用 uvx windows-mcp serve 启动，基于Windows UIAutomation库(非纯视觉)，提供Click/Type/Scroll/Screenshot/Snapshot(UI树)/PowerShell/文件操作等工具，要求Python3.13+、UV，且必须有活动图形环境，无法headless运行 (https://github.com/CursorTouch/Windows-MCP (WebFetch摘要))
- [high] WindowsAgentArena是微软/CMU的154任务真实Windows多应用benchmark(含Office编辑)，用确定性Python evaluator检查最终状态返回二值成功标志(而非比对人类轨迹)，基于Azure并行化把全量评测从数天缩短到约20分钟 (https://github.com/microsoft/WindowsAgentArena; https://microsoft.github.io/WindowsAgentArena//static/files/windows_agent_arena.pdf)
- [medium] Goose 内置官方Computer Controller扩展，封装keyboard/mouse/window management/web scraping等跨平台自动化API，作为built-in extension可直接开关启用，macOS上依赖Peekaboo CLI (https://block.github.io/goose/docs/tutorials/computer-controller-mcp/)
- [medium] Gemini CLI内置google_web_search工具默认开启，依赖Google官方Search grounding后端返回带引用摘要，无需额外配置，但绑定Gemini原生API通道，若换成自定义OpenAI/Anthropic兼容端点该功能可能失效(推测未实测) (https://geminicli.com/docs/tools/web-search/)
- [medium] 多个基于python-docx/openpyxl的独立MCP server已存在(Office-Word-MCP-Server, excel-mcp-server等)，可通过uvx/python标准MCP stdio方式启动接入任意支持MCP的引擎 (https://github.com/GongRzhe/Office-Word-MCP-Server; https://github.com/haris-musa/excel-mcp-server)
- [low] 飞书/钉钉/企业微信在2025-2026均已开源官方CLI，把OpenAPI包装为Agent可调用命令行接口(飞书CLI覆盖200+命令/2500+ Raw API含24个Agent Skills；钉钉Workspace CLI名为dws)，但需要企业身份注册与鉴权，在无企业身份的评测沙箱中可行性存疑 (中文技术媒体二手报道(cnblogs.com/itech, ai-bot.cn)，未直接验证官方仓库)
- [high] docx skill明确要求处理外部docx文件时先执行find unpacked -type l -delete删除zip内符号链接条目，因为外部docx被视为不可信内容，需防zip-slip类风险 (raw.githubusercontent.com/anthropics/skills/main/skills/docx/SKILL.md)
- [low] 未发现权威、star数较高的Microsoft Office COM自动化MCP官方项目，该路径依赖真机Office授权且风险较高，不建议作为赛题默认方案 (多次WebSearch综合判断，非单一来源)

**未解决问题**：
- 是否存在权威的Microsoft Office COM自动化MCP项目未被检索到
- 飞书/钉钉/企业微信官方CLI的具体安装、鉴权流程及在赛题沙箱下的可行性需要一手仓库验证
- Hermes computer_use/x_search工具的具体协议形态(是否MCP、参数schema)未获一手源码确认
- Pi与dsh(DeepSeek Harness)在Office/GUI/检索能力上的接入方式本次未检索到公开一手资料
- OpenCode webfetch是否可配置自定义搜索/代理端点而非固定走opencode托管后端未经一手文档确认
- Gemini CLI切换到自定义OpenAI/Anthropic兼容端点后google_web_search是否真的失效未经实测，仅为架构原理推测

## G04 通用网关规范与 opencode server API 契约的逐项对照（评测接口的真实来源）
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/G04-generic-gateway-spec-vs-opencode-contract.md

**摘要**：对比赛题"通用 Agent 网关规范"与 opencode（anomalyco/opencode，dev 分支）真实 server API 源码逐项核对。结论：赛题端点范式（POST /session、GET /session/status、prompt_async、GET message、abort、GET /event SSE）与 opencode 高度同构，但存在关键语义差异：opencode 的 prompt_async 是真异步立即 204（非赛题定义的"阻塞直到结束"），directory 是 query 参数非 body 字段，权限回复端点是 /session/{id}/permissions/{permissionID}（事件名 permission.updated 非 permission.asked），finish 枚举实际 6 值（含 content-filter/unknown），Part 类型实际 12 种。question.asked/replied/rejected 机制真实存在（GET /question, POST /question/{requestID}/reply|reject）。MyAgent 网关规范无公开资料，判定为内部系统。报告含完整字段级契约表、事件命名空间、能力映射表与 5 条接入风险提示。

**接入面**：HTTP+SSE server API（session CRUD、message/prompt_async双通道、abort、event SSE、permission、question）；provider层支持自定义OpenAI/Anthropic兼容baseURL满足内部模型约束；插件系统（JS/TS钩子+自定义工具注册）为引擎特有扩展面

**公共能力**：session CRUD与idle/busy状态查询；同步/异步prompt双通道+SSE事件推送；完整消息轨迹拉取(message/parts)；abort中止；Message/Part归一化模型(text/tool/step-finish/finish)；权限审批事件+回复；结构化多选提问(question)机制；工具调用状态机(pending/running/completed/error)+callID关联；项目级系统提示词文件(AGENTS.md，与Claude Code CLAUDE.md、Codex AGENTS.md同构)

**扩展能力**：进程内插件系统(.opencode/plugins/，JS/TS钩子+自定义工具注册)；具名agent角色预设(build/plan等)+按名启停工具集；session.revert/session.share(版本回退与公开分享)；session.command/session.shell专用端点；上下文自动压缩(compaction part)

**设计启示**：
- 网关的prompt_async若直接透传opencode原生prompt_async会误判完成时机，必须自行订阅SSE等session.status:idle后才让HTTP响应返回204，不能简单转发
- directory参数同时承担隔离边界与文件系统工作目录双重语义，网关必须为每个业务会话(如每个群)分配独立directory，否则sessionID隔离不足以防止跨群文件/shell污染
- 事件命名存在版本漂移(permission.asked→permission.updated, session.idle deprecated→session.status)，网关适配层需做事件别名兼容表并以最新SDK生成类型为准而非旧文档
- 归一化Message/Part模型应按opencode的超集设计(12种part、6种finish)，其余引擎原生事件降级映射进这个超集而非反向阉割
- opencode无原生跨会话长期记忆能力，架构中的统一记忆模型必须在网关层自建，不能假设引擎原生提供
- Permission与Question是两类结构相似但独立的人机协同阻塞点，应归一化为同一上位概念(如interaction.required)并用kind字段区分
- 插件系统、具名agent角色预设等属于引擎特有扩展能力，不应假设其它引擎(Claude Code/Codex等)有等价物，需在能力协商阶段单独声明

**关键事实**：
- [high] opencode server 默认端口 4096，非赛题的 6217 (https://opencode.ai/docs/server/)
- [high] POST /session body 仅 {parentID?, title?}，directory 是 query 参数，与赛题写法(body含directory)不同 (packages/sdk/js/src/gen/types.gen.ts (SessionCreateData))
- [high] prompt_async 立即返回 204，是真异步；真正的阻塞语义在同步 POST /session/{id}/message (packages/sdk/js/src/gen/types.gen.ts (SessionPromptAsyncData/SessionPromptData) + issue #26635)
- [high] GET /session/status 返回 {[sessionID]: SessionStatus}，含 idle/busy/retry 三态（非赛题的二态） (packages/schema/src/session-status-event.ts + types.gen.ts)
- [high] FinishReason 真实枚举为 stop|length|tool-calls|content-filter|error|unknown（6值，非赛题的4值） (packages/llm/src/schema/ids.ts)
- [high] Part 联合类型实际含12种：text/reasoning/file/tool/step-start/step-finish/snapshot/patch/agent/retry/compaction/subtask (packages/sdk/js/src/gen/types.gen.ts)
- [high] 权限回复端点是 POST /session/{id}/permissions/{permissionID}，body {response: once|always|reject}；事件名是 permission.updated/permission.replied（非文档旧称 permission.asked） (packages/sdk/js/src/gen/types.gen.ts + packages/web plugins.mdx对比)
- [high] question.asked/replied/rejected 真实存在，路由为 GET /question, POST /question/{requestID}/reply, POST /question/{requestID}/reject (packages/schema/src/v1/question.ts + packages/sdk/js/src/v2/gen/types.gen.ts + issue #9865 #17920)
- [high] GET /event 首帧固定发 server.connected，随后每10秒发 server.heartbeat（非裸heartbeat） (packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts)
- [high] session.idle 事件已标记 deprecated，权威状态事件是 session.status (packages/schema/src/session-status-event.ts)
- [medium] opencode 仓库已从 sst/opencode 迁移为 anomalyco/opencode (GitHub搜索结果+仓库现状)
- [high] MyAgent 网关规范（端口3008等）无任何公开资料，判定为内部私有系统 (多次WebSearch无结果)

**未解决问题**：
- MyAgent网关规范(端口3008/v1/agents/BridgeEvent等)完全无公开资料，无法确认其与opencode的具体关系，仅能从路径命名推测其内部转发到某个opencode实例
- opencode server的Authorization middleware鉴权细节(是否支持API Key/多租户)未深入核实
- opencode在Windows上原生运行的成熟度(依赖Bun、是否有Windows原生二进制发布)未验证，需部署/环境专题交叉核实
- permission.asked与permission.updated是重命名关系还是两套并行事件未能100%确认，建议接入时以实际抓包为准
- v1 GET /event与实验性v2 GET /api/event两条事件流是否会合并或v1被废弃的路线图未知

## G05 Goose（block/goose）作为候选引擎的深度调研
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/G05-goose-deep-dive.md

**摘要**：Goose（Rust，Apache 2.0）已从 Block 迁移至 Linux Foundation 的 Agentic AI Foundation，权威仓库变为 aaif-goose/goose。架构分 CLI（goose run 无头/goose session 交互）、goosed 守护进程（axum REST+SSE，约103端点）、Desktop 三层，正做 per-session Agent 重构以强化隔离。接入面三条：headless `goose run`（无法真正走人工确认）、goosed 私有 REST+SSE、以及标准化 ACP（goose acp stdio / goose serve HTTP:3284），ACP 是跨引擎统一层的优选候选。会话原生 resume/fork/export，落 SQLite。权限四态 auto/approve/smart_approve/chat，smart_approve 用 LLM 分类器自动判定风险；但部分 provider 下 auto 模式曾被报告不生效。扩展即 MCP（stdio/http/builtin），内置 Developer/Computer Controller/Memory；.goosehints 在 headless 默认不加载是隐蔽坑。Recipe(YAML) 是核心资产格式，配合 Subagents(≤10并行)/Subrecipes 构成较成熟多 Agent 编排。原生支持 OpenAI 兼容端点配置，符合赛题硬约束，但流式错误下有 provider 崩溃报告。可观测支持 OTel/Langfuse/MLflow。Windows 原生安装有 PowerShell 脚本，但 keyring 不稳、默认 Shell 为 cmd 需显式配置。项目处于组织迁移+架构重构活跃期，接入需锁版本。

**接入面**：主推：进程级接入（spawn `goose run --recipe ... --session-id ... --with-builtin developer --output-format stream-json --provider openai --model <internal>`），将 stdout stream-json 事件适配为网关 SSE；次选：`goose serve`（ACP over HTTP:3284）作为长驻服务与标准化协议候选；goosed 私有 REST+SSE 仅作参考，不作为主适配目标（协议私有、正在重构中）。

**公共能力**：业务→session 映射（--session-id/--resume，SQLite sessions.db）；会话连续性（resume/fork/export）；权限限制（GOOSE_MODE auto/approve/smart_approve/chat + 扩展白名单）；自定义 OpenAI 兼容端点（OPENAI_HOST/GOOSE_PROVIDER）；自动上下文压缩（GOOSE_AUTO_COMPACT_THRESHOLD/GOOSE_CONTEXT_LIMIT）；可观测性（OTel/Langfuse/MLflow 集成）

**扩展能力**：Recipe 工作流资产（YAML: instructions/prompt/parameters/extensions/response schema/sub_recipes）；Subagents 并行子 Agent（≤10 并行 worker）；Subrecipes 子工作流+独立模型指定；smart_approve LLM 风险分类审批（PermissionJudge）；Computer Controller 桌面自动化扩展；ACP 协议支持（goose acp stdio / goose serve HTTP:3284）；Memory 内置扩展（本地.goose/memory vs 全局~/.config/goose/memory）

**设计启示**：
- ACP（goose acp/goose serve）比私有 goosed REST 更适合作为跨引擎统一抽象层的候选协议，因为其消息 schema 更标准化，接入优先级应高于直接对接 goosed
- headless 模式下 Goose 无法真正响应 /question、/permission 类交互，网关侧必须在启动参数（GOOSE_MODE、Recipe 固化的扩展白名单）里预先固化权限边界，不能依赖运行时人工确认
- .goosehints/AGENTS.md 在无头模式下默认不加载，是一个极隐蔽的坑，网关拼装命令行时必须显式加 --with-builtin developer 才能让业务侧配置的提示词生效
- GOOSE_MODE=auto 的权限自动放行在某些 provider 组合下曾被报告不生效，网关不能完全信任引擎自身权限模型，应在网关层再包一层硬性权限过滤兜底
- Recipe 的 response.json_schema 能力可直接用于客观评测的结构化输出校验，是除 LLM-as-Judge 外的额外可靠信号源，值得在评测框架里利用
- Subagents/Subrecipes 应归类为 Goose 特有的扩展能力（对应赛题的 agent team/dynamic workflow），配置参数包括是否启用、最大并行数、子任务级 provider/model 覆盖表，不应假设其它引擎有等价能力
- Goose 项目正处于组织迁移（Block→AAIF）和内部架构重构（per-session AgentManager、CLI-via-goosed 统一）双重活跃期，接入代码应锁定具体 commit/tag 并预留适配层随上游演进的维护成本
- Windows 下需显式设置 GOOSE_SHELL 才能获得 POSIX shell 语义（默认是 cmd），这对涉及 shell 脚本/管道的 Windows 办公自动化任务是必须处理的部署细节

**关键事实**：
- [high] Goose 仓库已从 block/goose 迁移至 aaif-goose/goose（Linux Foundation 旗下 Agentic AI Foundation） (https://goose-docs.ai/blog/2026/04/07/goose-moves-to-aaif/)
- [high] goose run 是无头执行入口，支持 -t/-i/--recipe/--params/--no-session/--resume/--output-format text|json|stream-json，headless 模式下不能请求澄清或审批 (https://goose-docs.ai/docs/tutorials/headless-goose/)
- [high] goose acp 以 stdio 运行 ACP server；goose serve 以 HTTP/WebSocket 运行 ACP server，默认监听 127.0.0.1:3284，可用 --dangerously-unauthenticated 跳过鉴权 (raw.githubusercontent.com/block/goose/main/documentation/docs/guides/goose-cli-commands.md)
- [medium] goosed 是基于 axum 的 REST+SSE 守护进程，约 103 个端点，OpenAPI 由 utoipa 生成，正在从单一全局 Agent 重构为 per-session AgentManager (https://deepwiki.com/block/goose/5-server-and-api-layer-(goose-server); https://github.com/block/goose/discussions/4389)
- [high] 权限模式有 auto/approve/smart_approve/chat 四态，smart_approve 用 PermissionJudge（LLM分类器）自动判断工具调用是否安全 (https://goose-docs.ai/docs/guides/managing-tools/goose-permissions/)
- [medium] GOOSE_MODE=auto 在 claude-code provider 下曾被报告不生效，仍反复弹出权限确认 (https://github.com/block/goose/issues/3386)
- [high] .goosehints/AGENTS.md 上下文文件在非交互 headless run 中默认不加载，需显式传 --with-builtin developer (https://github.com/aaif-goose/goose/issues/5104)
- [high] 自定义 OpenAI 兼容端点通过 OPENAI_HOST（默认 https://api.openai.com）+ OPENAI_BASE_PATH + GOOSE_PROVIDER=openai 配置；也可用 GOOSE_PROVIDER__HOST/GOOSE_PROVIDER__API_KEY (https://goose-docs.ai/docs/getting-started/providers/)
- [high] Recipe YAML 含 instructions/prompt（Jinja模板）、parameters（typed输入）、extensions（stdio/builtin/platform/streamable_http/frontend）、response.json_schema（结构化输出约束）、sub_recipes (https://block-goose.mintlify.app/guides/recipes; https://goose-docs.ai/docs/guides/recipes/recipe-reference/)
- [medium] Subagents 支持单 session 内最多约 10 个并行 worker；Subrecipes 各自可指定独立 provider/model，彼此不共享状态 (https://block.github.io/goose/blog/2025/09/26/subagents-vs-subrecipes/)
- [medium] Windows 原生安装提供官方 PowerShell 脚本（download_cli.ps1）及 Git Bash/MSYS2 下的 shell 脚本；Desktop 有 Windows zip 发行包；keyring 在 Windows 上不稳定建议改用环境变量 (https://dev.to/lymah/getting-started-with-goose-on-windows-30bh)
- [medium] Goose 支持 OpenTelemetry 导出（OTEL_EXPORTER_OTLP_ENDPOINT/OTEL_TRACES_EXPORTER）及 Langfuse 集成变量；MLflow 官方文档收录了 Goose tracing 集成 (https://goose-docs.ai/docs/guides/environment-variables/; https://mlflow.org/docs/latest/genai/tracing/integrations/listing/goose/)

**未解决问题**：
- goosed 的 SSE 事件具体字段名/schema（相当于我们网关 message.part.updated 事件）未逐字核对 openapi.json 原文，需要后续抓取 https://raw.githubusercontent.com/aaif-goose/goose/main/ui/desktop/openapi.json
- goose acp/goose serve 的 ACP 协议版本、与 Zed ACP 规范兼容程度、是否支持 permission.asked/question.asked 语义，需要真实 ACP client 联调验证
- session 取消（对应 /session/{id}/abort）在 goosed API 中的具体端点路径未确认
- Windows 下 Computer Controller 扩展对 Word/Excel/PPT/IM 软件自动化的实际成熟度未经实机验证
- smart_approve 的 PermissionJudge 具体实现（本地小模型还是调用主模型、阈值是否可配置）细节未查证

## G06 评测机制（Rollout + LLM-as-Judge）、轨迹记录与鲁棒性工程
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/G06-evaluation-rollout-judge-robustness.md

**摘要**：调研 OSWorld/WindowsAgentArena/tau-bench/AgentBench 等评测框架，确认主流范式为「execution-based 规则检查为主 + LLM-as-Judge 事后归因为辅」。OSWorld 用 getters+metrics 两层架构对文件/浏览器/终端终态做确定性比对（含大量 docx/xlsx/pptx 校验函数），369 任务人类 72.36% vs 最优 agent 12.24%。办公任务验收应覆盖文件存在性/内容/格式三维度，常见失败模式为格式破坏/未保存/路径错误/编码问题/数据幻觉。鲁棒性工程关键发现：Windows TerminateProcess 不级联杀子进程，必须用 Job Object 或 taskkill /T /F 管理进程树（已交叉验证于两篇 MS 官方文档）；SSE 应利用 retry/id/Last-Event-ID 做断线重连。给出本地回归评测框架（10条用例引擎记分卡）与沙箱部署（离线/无管理员权限）对方案的影响建议。赛题实际评测器源码未获取到一手资料，相关结论已标注为推测。

**接入面**：评测/网关层：GET /session/{id}/message 轨迹格式设计（需含user/assistant/tool call/tool result/step-finish且可关联产物文件路径）、GET /event SSE的retry/id/Last-Event-ID断线重连与心跳超时策略、POST /session {directory}的并发用例隔离、进程生命周期管理（Windows Job Object/taskkill /T /F）、启动自检（模型连通性/版本/工具可用性）、本地回归评测子系统（10条用例引擎记分卡）

**公共能力**：execution-based规则检查（文件存在性/内容/格式终态比对）；轨迹记录（user/assistant/tool call/tool result/finish事件）；会话级隔离（每用例独立session/directory）；SSE事件流+心跳+断线重连；进程健康探测与崩溃恢复；启动自检（模型端点/版本/依赖）

**扩展能力**：LLM-as-Judge事后错误归因(fault assignment/type分类，tau-bench特有做法)；产物自检/self-verification（引擎主动重新打开生成文件核对，非所有引擎默认具备）；权限确认流程（/permission接口，用于高风险操作如递归删除文件）；Job Object级进程树托管（Windows特有，非所有引擎/运行时默认实现）

**设计启示**：
- 评测应采用「规则检查为主+LLM-judge为辅」的两段式设计：可编程判定的部分（文件存在/格式/内容diff）用脚本，语义质量部分（润色得体度、数据分析合理性）用LLM-judge，且judge应参照轨迹中的工具调用与真实产物做交叉核对以防止仅凭最终文字描述被数据幻觉欺骗
- Windows平台鲁棒性的最大隐患是子进程未被级联终止，必须用Job Object或taskkill /T /F管理整棵进程树，否则长跑评测会残留winword.exe/excel.exe等僵尸进程导致后续用例文件占用失败
- 网关的SSE /event应实现短窗口事件缓冲+递增id，配合EventSource原生的Last-Event-ID重连机制，避免网络抖动导致评测器误判会话失联
- 本地应自建10条用例的引擎记分卡回归框架，覆盖赛题给定的6类办公任务，输出pass/fail、耗时、失败类型标签，作为新引擎接入达标验收标准
- 受限沙箱（无网络/无管理员权限/脚本化安装）要求引擎与依赖必须支持离线安装与用户态运行，不能依赖运行时联网拉包或系统级安装
- 轨迹记录不应只是纯文本JSON，还应支持关联产物文件路径与可选截图/中间态快照，便于judge直接定位到具体docx/xlsx/pptx做二次校验
- 任务粒度的prompt_async阻塞语义与OSWorld式逐步细粒度回合制不同，说明本赛题评测器更贴近tau-bench/AgentBench的「高层指令→完整完成/失败」评测粒度，harness内部的多轮工具调用循环应对网关网关不可见

**关键事实**：
- [high] OSWorld 采用 execution-based evaluation，两层架构：getters 取环境终态、metrics 做规则化比对，369 个真实桌面/网页任务，人类成功率72.36% vs 当时最优 agent 12.24% (https://raw.githubusercontent.com/xlang-ai/OSWorld/main/README.md ; https://arxiv.org/abs/2404.07972)
- [high] OSWorld metrics 库含大量 docx/xlsx/pptx 相关校验函数：compare_docx_files/compare_docx_tables/compare_docx_images/compare_font_names/contains_page_break/has_page_numbers_in_footers/check_tabstops/evaluate_colored_words_in_tables(CIEDE2000色差阈值3.5)/compare_image_text(EasyOCR)等 (https://raw.githubusercontent.com/xlang-ai/OSWorld/main/desktop_env/evaluators/metrics/docs.py)
- [high] WindowsAgentArena 用 JSON 任务配置（diff_lvl等字段），本地经Docker+QEMU起约30GB的Windows11 VM快照跑任务，Azure云端可用Standard_D8_v3做40路并行约35分钟跑完 (https://github.com/microsoft/WindowsAgentArena)
- [medium] tau-bench 主评分为数据库状态diff/Pass^k指标，LLM仅用于事后failure的fault assignment(user/agent/environment)与fault type分类，不是主评分器；原任务集README提示已不再更新 (https://raw.githubusercontent.com/sierra-research/tau-bench/main/README.md)
- [medium] AgentBench覆盖8类环境(OS/DB/KG/DCG/LTP+ALFWorld/WebShop/Mind2Web)，以环境状态/结果评测而非LLM-judge (https://raw.githubusercontent.com/THUDM/AgentBench/main/README.md)
- [high] Windows TerminateProcess只终止目标进程本身,不会终止其创建的子进程;要保证进程树一起退出必须用Job Object(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE + AssignProcessToJobObject)或等价taskkill /T /F (https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process ; https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [high] Job Object嵌套(nested jobs)自Windows 8/Server 2012起支持；此前版本一进程仅能属一个job且不可嵌套；子进程默认随父进程加入同一job除非设BREAKAWAY标志 (https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [high] SSE(EventSource)原生支持断线自动重连，服务端可下发retry字段控制重连间隔，id字段配合客户端自动回传的Last-Event-ID请求头实现断点续传式事件恢复 (https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- [medium] OSWorld会将截图序列、动作序列、视频录像保存到结果目录,支持manual_examine.py人工复核任务正确性与评测指标 (https://raw.githubusercontent.com/xlang-ai/OSWorld/main/README.md)
- [medium] WindowsAgentArena本地部署QEMU VM默认8GB RAM/8 CPU核，可通过--ram-size/--cpu-cores参数调整 (https://github.com/microsoft/WindowsAgentArena)
- [medium] OSWorld公开评测需与维护者协调,由维护者在其侧运行agent代码并报告结果以保证排行榜标准化 (https://raw.githubusercontent.com/xlang-ai/OSWorld/main/README.md)

**未解决问题**：
- 赛题实际评测器/judge rubric源码未获取到一手资料,客观70%中规则检查与LLM-judge的权重分配方式待赛题方公布后确认
- OSWorld task JSON完整schema(evaluator/postconfig/result字段精确结构)未能直接抓取原始文件核实,来源为deepwiki二手摘要
- WindowsAgentArena/tau-bench/AgentBench的最新版本号与维护活跃度未做二次核实,tau-bench README提示原任务集已不再更新
- 题面/question、/permission可选接口与评测器LLM-judge的交互方式(如递归删除文件用例是否检查agent是否正确请求权限确认)未见一手说明

## G07 跨引擎真取消与真完成语义核验
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/G07-engine-cancel-completion-semantics.md

（结构化摘要缺失，请直接阅读文件）

## G11 自托管推理引擎工具调用兼容性调研
文件：/tmp/claude-0/-home-user-PNP/fd5910d4-8ad2-5125-9fe4-0c02d0553435/scratchpad/research/G11-self-hosted-inference-tool-calling-compat.md

（结构化摘要缺失，请直接阅读文件）
