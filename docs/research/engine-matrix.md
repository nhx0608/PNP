# 引擎对比矩阵（Engine Matrix）

> 汇总自 T01–T09、T11、G01、G02、G03、G04、G05 共 15 份调研报告。"?"表示本轮调研未获一手/可信资料，需后续专项核实。列名按赛题要求排列，单元格尽量给出字段名/命令/端点等具体值。OpenHands 未在 15 份材料中被专门调研（T06 仅确认"opendesk"非 OpenHands），全表标"?"，留待后续专题。

## 1. 主矩阵

### 1.1 Windows / 内部模型 / Office-GUI-检索

| 引擎 | Windows 原生可用性 | 内部模型接入（自定义端点协议） | Office/GUI/检索能力注入方式 |
|---|---|---|---|
| Claude Code/Agent SDK | 原生安装器+winget+npm(装期需 Node≥22)；v2.1.84+原生 PowerShell 工具；沙箱(Seatbelt/bubblewrap)原生 Windows **不可用**，需 WSL2 | 硬编码 Anthropic Messages；`ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN`；官方明确"不支持路由到非 Claude 模型"，需 LiteLLM/CCR 转换代理 | 无原生；靠 MCP(Windows-MCP 等)+SKILL.md(anthropics/skills docx/xlsx/pptx)；WebSearch/WebFetch 绑定 Anthropic 后端，换端点后大概率失效 |
| pi-agent | npm 包，官方 windows.md 文档；默认 Git Bash，可选 PowerShell 工具(`~/.pi/agent/settings.json` shellPath) | 极佳：`pi.registerProvider(api: openai-completions\|anthropic-messages\|openai-responses\|...)` 或免代码 `~/.pi/agent/models.json` | 无内置；靠社区扩展/MCP；无官方 WebSearch 证据 |
| opencode | 官方"strongly recommend WSL"，原生可跑但性能/终端/工具兼容性打折——与硬约束冲突，需实测 | 极佳：`opencode.json` `provider.<id>.npm` 选 `@ai-sdk/openai-compatible`/`@ai-sdk/anthropic`+`options.baseURL/apiKey` | 原生 SKILL.md(兼容 `.claude/skills`)；内置 `webfetch`(绑定托管后端，自定义端点下未验证)；GUI 需外接 MCP |
| Hermes Agent | "early beta"；PowerShell 一键脚本自举 Python/Node/Git；Windows 计划任务服务化 | 佳：Custom endpoint（base URL 以 `/v1` 结尾）+`api_mode:chat_completions`，直连 OpenAI 兼容内部网关最简单 | Tool Gateway 提供 `web_search`(Firecrawl)/`computer_use`/`vision_analyze`（协议细节未获一手） |
| dsh | Node≥22.19/24；Python SDK 含 runtime wheel(Windows x64)；无官方 Windows 专项文档 | 较佳：插件化 provider（`llm-pi-ai` 适配器等），`settings.yaml` 声明 baseURL/协议 | ? 未见一手资料，需自行接 MCP |
| Codex CLI | **唯一**把原生 Windows 沙箱当一等目标：elevated 模式 v0.100.0 转正，四层防御(专用账户+ACL+防火墙+本地策略) | 硬编码 `wire_api="responses"`（Chat Completions 已移除）；`[model_providers.<id>]base_url/env_key`，内部网关需说 Responses 协议或代理转换 | 无原生；MCP client+`dynamicTools`；官方 skills 页 404 未核实 |
| Gemini CLI | npm 安装；官方给出 Windows 管理员策略路径(`C:\ProgramData\gemini-cli\policies`) | `GOOGLE_GEMINI_BASE_URL` 整体重定向但协议仍是 Gemini 原生；沙箱模式下变量不透传(已知 bug) | 内置 `google_web_search`（绑定 Google grounding，换端点后大概率失效）；无原生 Office/GUI |
| Qwen Code | 官方 PowerShell 安装脚本+npm | 优：原生 OpenAI SDK 惯例 `OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL`+多协议(OpenAI/Anthropic/Gemini/Qwen)+`settings.json.modelProviders[]` | 继承 Gemini CLI Extensions 体系，内置搜索是否受端点影响未验证 |
| Kimi CLI | PowerShell one-liner；默认 Git Bash，`KIMI_SHELL_PATH` 可自定义 | TOML `[providers.<id>]{type:"kimi",base_url,api_key}`；`KIMI_BASE_URL`(直连) vs `KIMI_CODE_BASE_URL`(OAuth) 不可混用 | ? 未见一手资料 |
| iFlow CLI | ? （**官方已 2026-04-17 停运**，不建议作为候选） | 历史上经 OpenAI 兼容层接 Kimi K2/Qwen3/DeepSeek v3 | ? 已停运，不再深挖 |
| Goose | 官方 PowerShell 安装脚本(download_cli.ps1)+Git Bash/MSYS2；keyring 不稳定建议用环境变量；默认 Shell=cmd，需显式 `GOOSE_SHELL` | 优：原生 `OPENAI_HOST`+`GOOSE_PROVIDER=openai`+`OPENAI_API_KEY`，零配置文件改动；流式错误场景曾致 provider 崩溃(issue #8021) | 内置 **Computer Controller** 扩展（跨平台桌面自动化 API 封装） |
| Cline | 原生预编译二进制(win x64/arm64)，`npm i -g cline` 仅装期需 Node | ? 未见一手资料 | ? 未见 |
| Kilo Code | ? Node 生态 npm 包，未详细验证 | ? 未详 | ? 未见 |
| Amp | ? 未详 | ? 未详（Sourcegraph 商业产品，登录墙未抓取官方文档） | ? 未见 |
| Copilot CLI/SDK | ? 未详（GitHub 官方产品大概率支持） | 优：**BYOK 确认**(OpenAI/Microsoft Foundry/Anthropic/Ollama/任意 OpenAI 兼容端点) | ? 未见 |
| Droid (Factory) | ? 未详 | ? 未详 | ? 未见 |
| OpenHands | ? 本次未调研 | ? | ? |
| OpenClaw（网关型） | Node 22.22.3+/24.15+ 跨平台单进程；无官方 Windows 专项验证 | `models.providers.<name>{baseUrl,apiKey}` 多 provider 注册；自身 OpenAI 兼容 HTTP(`/v1/chat/completions`)即可当兼容层 | 无原生；靠 skills(SKILL.md)+MCP+**ACP 外部 harness**驱动其它引擎的能力 |

### 1.2 可编程接入面 / 流式事件格式 / 会话

| 引擎 | 可编程接入面 | 流式事件格式 | 会话（创建/恢复/fork/导出） |
|---|---|---|---|
| Claude Code | `claude -p --input/output-format stream-json`(NDJSON 子进程)；Agent SDK(TS/Python 进程内)；ACP 适配器 `claude-agent-acp`；Managed Agents REST | `system/init`→`assistant/user/stream_event`→`result`；含 `session_id/usage/total_cost_usd/permission_denials/capabilities[]` | `--resume/--continue/--fork-session/--session-id`；JSONL `~/.claude/projects/<proj>/<id>.jsonl`（官方声明不稳定，勿解析）；导出仅 `/export` 人读文本 |
| pi-agent | SDK(`createAgentSession`，TS 进程内)；`--mode rpc`(严格 LF JSONL，36 种 type)；`--mode json`/`-p`(单发流式) | `message_update`(仅 delta，0.84+)/`tool_execution_start\|update\|end`/`agent_start\|end`/`turn_start\|end` | JSONL 树(`id/parentId`)，`/fork`/`/clone`/`/tree` 原地分支；v4 lane-based `Session/SessionRepo`(实验) |
| opencode | `opencode serve` HTTP+SSE(OpenAPI3.1,162 路径)；`@opencode-ai/sdk`；CLI(`opencode run`)；ACP(`opencode acp`) | SSE `GET /event`，93 种事件；`message.part.updated`(带 delta)/`session.status{idle\|busy\|retry}`/`tool.*` | `POST /session{parentID,title}`+query`directory`；`/fork`/`/revert`/`/unrevert`；子会话 `parentID`；`opencode export/import` |
| Hermes | OpenAI 兼容 HTTP(:8642,`/v1/chat/completions`,`/v1/responses`,`/v1/runs`,`/api/sessions/*`)；CLI(`-z/-Q/-q`)；ACP(`hermes acp`,内存 session,受限 toolset)；`hermes mcp serve` | SSE `hermes.tool.progress`/`assistant.delta`/`tool.started`/`tool.completed`/`run.completed` | SQLite `state.db`；session key `agent:main:<platform>:group:<gid>:<uid>`；`X-Hermes-Session-Key` 解耦记忆域；`hermes sessions export --format jsonl\|md\|trace` |
| dsh | headless(`dsh --profile headless`)；SDK JSON-RPC stdio(`--profile sdk`,TS/Python)；ACP v1(`--profile acp`) | `SessionEvent`(`turn/*,step/*,assistant/chunk,tool/call,tool/result`)；SDK `session.event` 通知全量不过滤 | append-only 日志，`SESSION_FORMAT_VERSION=0` 无兼容承诺；`ctx.agents.create` 支持 fork；ACP `session/resume`；SDK 靠同 `dsh_home`+`session_id` 续写 |
| Codex CLI | `codex exec --json`(JSONL 子进程)；`@openai/codex-sdk`(封装 exec)；`codex app-server`(长驻 JSON-RPC2.0,stdio/ws/unix socket) | `thread.started`/`turn.started`/`item.started\|updated\|completed`/`turn.completed{usage}` | rollout JSONL `~/.codex/sessions/YYYY/MM/DD/`；`thread/start\|resume\|fork`；`thread/revert` 截断历史 |
| Gemini CLI | headless(`-p --output-format json\|stream-json`,退出码 0/1/42/53)；ACP(`--experimental-acp`,stdio JSON-RPC2.0) | `init/message/tool_use/tool_result/error/result` | `/chat save\|resume <tag>` 交互式检查点；headless `--resume<id>` **未确认存在**（关键缺口） |
| Qwen Code | headless(`-p --output-format text\|json\|stream-json`，`--input-format` 支持流式喂入) | JSON 数组(`system/session_start`,`assistant`,`result`含 `session_id`) | **`--continue`/`--resume [sessionId]`**——比 Gemini CLI 更完整的显式会话恢复 |
| Kimi CLI | `kimi acp`(ACP server)；`kimi mcp`(MCP 管理)；headless JSON 协议**未确认** | ? （ACP 标准 update） | ? 字段级未确认 |
| iFlow CLI | ? 已停运，不深挖 | ? | ? |
| Goose | `goose run`(headless,`-t/-i/--recipe/--output-format json\|stream-json`)；`goosed`(REST+SSE,~103 端点)；**ACP**(`goose acp`stdio,`goose serve`HTTP:3284) | stream-json；goosed 私有 SSE(字段未逐一确认) | SQLite `sessions.db`；`-r/--resume`/`--fork`；`goose session export --format md\|json\|yaml` |
| Cline | CLI headless(`--json`) | `--json` 结构化事件 | `--continue` 恢复；字段未详 |
| Kilo Code | headless(`kilo run --format json`)；**ACP 原生**(`kilo acp`,ndjson/stdio,`--port/--hostname`/mDNS)；`kilo serve`/`kilo daemon` | raw JSON events | `--session/-s`/`--continue/-c`/`--fork`/`--cloud-fork`——分叉语义比多数引擎完整 |
| Amp | `-x --stream-json`(**与 Claude Code 兼容 JSONL**)；官方 Python SDK；第三方 ACP 桥接(`acp-amp`,仅付费额度) | Claude-Code 兼容 type 字段(system/assistant/tool_use) | thread(`T-xxxxxxxx` UUID)，`amp threads continue [thread]` |
| Copilot CLI/SDK | `@github/copilot-sdk`(JSON-RPC,与 CLI 同运行时,2026-06-02 GA,TS/Python/Java) | SDK 事件流(schema 未逐字确认) | `CopilotSession` 有状态多轮；`SendAndWaitAsync`(阻塞至 idle)/`SendAsync`(fire-and-forget+事件流) |
| Droid | `droid exec`(`--output-format text\|json\|stream-json\|stream-jsonrpc`)；第三方 `droid-acp` 借 stream-jsonrpc | stream-jsonrpc(JSON-RPC 风格) | `droid.load_session` 恢复既有会话 |
| OpenHands | ? | ? | ? |
| OpenClaw | WS RPC(`:18789`,协议 v4,`req/res/event` 帧)；OpenAI 兼容 HTTP(默认关闭)；Admin HTTP RPC；`openclaw acp`(作 ACP server)；`@openclaw/acpx`(作 ACP client 驱动 claude/codex/gemini/opencode/cursor/copilot/droid/pi 等) | WS `event` 帧(`chat/session.message/session.tool/sessions.changed`)；SSE(OpenAI 兼容端点) | sessionKey 字符串(`agent:<id>:main`/`...:group:<gid>`/`...:subagent:<uuid>`/`...:acp:<uuid>`)；2026.8 起 SQLite database-first+归档 transcript |

### 1.3 取消/超时 / 权限/审批交互 / 沙箱

| 引擎 | 取消/超时 | 权限/审批交互 | 沙箱 |
|---|---|---|---|
| Claude Code | SIGINT/SDK `interrupt()`；`capabilities:interrupt_receipt_v1`；`--max-turns`/`maxBudgetUsd`；后台 Bash 5s 杀，子代理等待上限 10 分钟 | 6 模式(default/acceptEdits/plan/auto/dontAsk/bypassPermissions)+`allow/deny/ask` 规则+30 余 hooks 事件+`--permission-prompt-tool` | 内建 Seatbelt(mac)/bubblewrap(Linux+WSL2)，仅约束 Bash；外层 `@anthropic-ai/sandbox-runtime` 包裹整进程 |
| pi-agent | RPC `abort/abort_bash/abort_retry`；无内建超时（网关自控） | 无内建；扩展 `tool_call` 钩子返回 `{block,reason,terminate?}`；RPC `extension_ui_request/response` 桥接 confirm/select | 无内建("runs with permissions of user")；官方给 Gondolin 微 VM/Docker/OpenShell 三种沙箱方案 |
| opencode | `POST /session/{id}/abort`；v2 `/interrupt`；同步 `/message` 长阻塞需放宽超时 | SSE `permission.updated`(旧文档口径 `permission.asked`)→`POST /session/{id}/permissions/{id}{response:once\|always\|reject}` | 无内建；server 默认仅绑 `127.0.0.1`+Basic Auth |
| Hermes | `POST /v1/runs/{id}/stop`；`approvals.timeout:300` | `approvals.mode:smart\|manual\|off`(默认 smart)；`POST /v1/runs/{id}/approval`；无人值守默认 **deny** | `terminal.backend` 7 种(local/docker/ssh/singularity/modal/daytona/vercel_sandbox)；docker 容器 drop 全部权限 |
| dsh | ACP `session/cancel`；**SDK 无 cancel**（只能杀进程） | `sandbox/mode`×`approval/policy(ask\|never)`；ACP `session/request_permission`；**SDK 通道审批不可达** | bwrap/Landlock(Linux)/Seatbelt(mac)/Windows ACL restricted token；只限文件效果不限网络 |
| Codex CLI | `turn/interrupt`；`-32001` 背压；`thread_unload_delay_secs` | server→client 请求 `item/commandExecution/requestApproval`；决策 `accept/acceptForSession/decline/cancel` | `sandbox_mode`×`approval_policy` 正交；macOS Seatbelt/Linux bwrap+seccomp/**Windows 原生 ACL 沙箱**(elevated 模式转正) |
| Gemini CLI | 未见 headless 专门取消参数（未确认） | Policy Engine 三态(`allow/deny/ask_user`)，**headless 下 `ask_user` 强制降级为 `deny`** | 未见原生沙箱机制描述 |
| Qwen Code | `--max-session-turns`/`--max-wall-time`/`--max-tool-calls` 预算控制 | `--approval-mode plan\|default\|auto-edit\|auto\|yolo` 五档 | 未见独立沙箱一手资料 |
| Kimi CLI | ? 未确认 | ACP 场景 YOLO 模式已知 bug(issue#1542,静默失败) | ? 未见 |
| iFlow CLI | ? 已停运 | ? | ? |
| Goose | `--max-turns`(默认 1000)/`--max-tool-repetitions`；abort 端点路径未确认 | 四态(auto/approve/**smart_approve**[LLM 分类器 PermissionJudge]/chat)；`GOOSE_MODE=auto` 在部分 provider 下曾失效(issue#3386) | 未见独立沙箱机制，靠权限模式+扩展白名单(`--with-extension`等) |
| Cline | ? 未详 | `--auto-approve true` 全自动+`--hook-command ./policy.sh` 策略脚本网关 | ? 未见 |
| Kilo Code | ? 未详 | ? 未充分确认（细粒度分级） | ? 未见 |
| Amp | ? 未详 | ? 未充分确认 | ? 未见 |
| Copilot CLI/SDK | ? 未详 | ? 未详 | ? 未见 |
| Droid | ? 未详 | ? 未详 | ? 未见 |
| OpenHands | ? | ? | ? |
| OpenClaw | `chat.abort`；subagent `runTimeoutSeconds` 默认 300 | `dmPolicy`(pairing/allowlist/open/disabled)→`tools.profile/allow/deny/elevated`→sandbox(docker) 三层 | Docker 容器执行工具(`mode:off\|non-main\|all`)；**ACP 外部 harness 不受沙箱包裹** |

### 1.4 扩展机制 / 记忆 / 多 agent

| 引擎 | 扩展机制（插件/hooks/skills/MCP） | 记忆 | 多 agent/team/room |
|---|---|---|---|
| Claude Code | skills(SKILL.md)/commands/subagents(.md+YAML)/plugins/MCP(client+进程内 server)/hooks(30+事件,exit 2 阻断)/workflows(JS: `agent()/parallel()/pipeline()`) | 自动记忆 `MEMORY.md` 索引+主题文件 `~/.claude/projects/<proj>/memory/`；CLAUDE.md 人写 | Subagents(并发默认 20)/**Agent Teams**(仅交互式，`-p`/SDK 下退化为普通子代理)/Dynamic Workflows(`-p`/SDK 可用) |
| pi-agent | TS extensions(进程内钩子+工具注册)/skills(agentskills.io SKILL.md)/prompt templates/packages(npm/git 分发) | 无内置；社区 `pi-memory` 包/Mem0/Honcho | 无内核子代理/team；官方 subagent 示例(子进程)/RPC worker 模式(社区 Kimball) |
| opencode | 插件(`.opencode/plugins/*.ts`,进程内钩子+`client` 反向调用)/agent(.md)/command(.md)/skill(SKILL.md)/MCP(local/remote+OAuth) | 无内置长期记忆；`session.metadata` 任意 JSON+AGENTS.md 静态记忆 | `task` 工具+`parentID` 子会话(树状)；`backgroundSubagents`(实验)；无 team/room |
| Hermes | plugins(26 个生命周期 hook)/skills(agentskills.io,`skill_manage` **自进化**)/MCP client+`hermes mcp serve` 反向暴露 | `MEMORY.md`(2200 字符)+`USER.md`(1375 字符) 冻结快照+FTS5 `session_search`；8 个外部 provider(Honcho 等) | `delegate_task`(leaf/orchestrator,实时 steer/stop)；Bot Mode/A2A v1.0/`hermes peer`(主打桌面端) |
| dsh | Cordis 插件(任意层，含 loop 本身)/`hooks-claude-code`\|`hooks-codex` 桥接/MCP client only/skills(`.dsh/skills`) | 无内置；MCP memory server overlay(Memorix/knowledge-graph/Engram) | `ctx.subagents` 多 provider(spawn-in-process/acp/codex/**claude-code**/dsh-sdk)；`workflow`/`ralph` 动态编排脚本；Agent Teams(实验私有) |
| Codex CLI | `hooks.json`(12 类事件)/SKILL.md/Plugins(marketplace)/MCP client+`codex mcp-server`/`dynamicTools`(客户端工具回调) | Memories(默认关闭,`~/.codex/memories`)+AGENTS.md+`thread/inject_items` | `multi_agent_v2`(`spawn_agent` 族工具,父子 thread,路径寻址)；`max_threads` 默认 6 |
| Gemini CLI | Extensions 目录(`policies/*.toml`+`hooks/hooks.json`+`agents/*.md`)/Subagents(预览,工具隔离)/MCP client | GEMINI.md 分层上下文文件(全局→项目→子目录) | Subagents(单进程树状委派)/**A2A** 远程委派(RFC 阶段,`RemoteAgentInvocation`) |
| Qwen Code | 沿用 Gemini CLI Extensions(policies/hooks/agents) | 大概率沿用 GEMINI.md（未逐字确认文件名） | 未确认（大概率沿用 Subagents） |
| Kimi CLI | skills/MCP servers/data sources 三类市场资产，装前展示 trust level | ? 未确认文件命名 | ? 未见原生机制 |
| iFlow CLI | ? 已停运 | ? | ? |
| Goose | MCP(stdio/streamable_http/**builtin**/platform/frontend)；内置 Developer/**Computer Controller**/Memory 扩展 | `.goosehints`(headless 下默认不加载,需 `--with-builtin developer`)+Memory MCP 扩展(本地/全局两级) | **Subagents**(≤10 并行 worker)+**Subrecipes**(各自独立 provider/model)，"Goose as Conductor" 编排 |
| Cline | MCP Marketplace/Workflows/Hooks/`cline schedule create --cron` | 无独立机制；Rules/自定义 bundle(tools+hooks+commands+rules) | `--team-name`(共享任务看板/agent 间邮箱/mission log)，CLI 一等公民 |
| Kilo Code | MCP(`kilo mcp add/list/auth` 含 OAuth)/Modes(Architect/Ask/Debug/**Orchestrator**=角色+工具集组合) | ? 未见 | Orchestrator Mode(单进程内模式切换编排) |
| Amp | MCP 自定义工具+Skills+**Oracle**(GPT-5 强推理子代理,`/handoff` 切换) | ? 未见独立机制 | Sub-agents 并行任务+Oracle 专家子代理分层 |
| Copilot CLI/SDK | ? MCP 大概率支持，未确认 | ? 未见 | ? 未见 |
| Droid | ? 未详 | ? 未见 | ? 未见 |
| OpenHands | ? | ? | ? |
| OpenClaw | Plugin API(`definePluginEntry`,`registerTool/Hook/Channel/Provider/GatewayMethod/HttpRoute`)/SKILL.md/Channels 渠道插件 | 文件即记忆(`USER.md/MEMORY.md/memory/YYYY-MM-DD.md`)+SQLite hybrid 检索(`memory_search`) | `agents.entries`+`bindings` 路由(most-specific wins)/`sessions_send\|spawn`/**ACP 外部 harness 编排**(claude/codex/copilot/cursor/droid/gemini/opencode/pi 作子进程后端) |

### 1.5 workflow / 定时后台 / 可观测

| 引擎 | workflow/dynamic workflow | 定时/后台任务 | 可观测（OTel/日志/事件） |
|---|---|---|---|
| Claude Code | **Dynamic Workflows**(JS 脚本 `agent()/parallel()/pipeline()`，`ultracode`=xhigh effort) | Routines(云端 cron)；本地无原生 cron，需网关自建 | stream-json 逐消息+OTel(`CLAUDE_CODE_ENABLE_TELEMETRY=1`,`claude_code.*` 指标/事件) |
| pi-agent | 无原生；靠扩展自实现 | 无原生 cron | `pi-telemetry`(厂商中立契约，无内建 exporter，需自写 adapter) |
| opencode | 无原生；`subtask` part+`command.subtask:true` | 无原生；实验 `worktree`/`workspace` | 日志文件+SSE 事件；无内建 OTel |
| Hermes | 无显式 workflow 工具；`execute_code` RPC(Python 脚本压缩多步调用) | `cronjob` 工具(create/list/pause/resume)+`/api/jobs`；60s tick 调度器；`continuity` 跨 job 上下文 | outbound webhooks(HMAC-SHA256 签名)+SSE 事件；无原生 OTel |
| dsh | `workflow`/`ralph` 工具(worker thread,fan-out 子代理) | `ctx.jobs` 后台任务；webhook 触发新 session | `SessionTelemetryRecord`→OTel Logs(**默认发 DeepSeek 端点**,需显式 DISABLED)；第三方 OTel traces 插件 |
| Codex CLI | Symphony(2026-04 开源编排规范,Elixir 参考实现,非核心产品) | 未见原生 cron；Codex Cloud 协议未获一手 | `[otel]exporter=otlp-http\|grpc`(默认关闭)；`LOG_FORMAT=json` |
| Gemini CLI | 无原生；A2A 可视为跨进程编排雏形 | 未见原生 cron | 本组**唯一原生 OTel 标准**(`.gemini/settings.json` telemetry 对象,OTLP gRPC/HTTP) |
| Qwen Code | 未见 | 未见 | 大概率继承 OTel 骨架（字段未确认一致） |
| Kimi CLI | 未见 | 未见 | ? 未见 |
| iFlow CLI | ? 已停运 | ? | ? |
| Goose | **Recipe**(YAML: instructions/prompt/parameters/extensions/response schema/sub_recipes) | `--enable-scheduler`(ACP 模式) | 原生 OTel(`OTEL_EXPORTER_OTLP_ENDPOINT`)+Langfuse+MLflow 集成 |
| Cline | Workflows(顺序或并行执行) | `cline schedule create --cron` | `--json` 输出+CI exit codes |
| Kilo Code | 未见独立 workflow 资产 | ? 未见 | ? 未见 |
| Amp | 未见独立 workflow 资产 | ? 未见 | stream-json 含 `usage(input/output_tokens)/stop_reason/duration` |
| Copilot CLI/SDK | ? 未见 | ? 未见 | **官方明确内置 OpenTelemetry**（本组唯一 SDK 级一手确认） |
| Droid | ? 未见 | ? 未见 | ? 未见 |
| OpenHands | ? | ? | ? |
| OpenClaw | 无原生 dynamic workflow | cron(独立 lane)+heartbeat 周期唤醒 | 插件化 OTel(`diagnostics-otel`,GenAI 语义约定,`harness.run.*` 事件,`traceparent` 透传) |

### 1.6 模型/provider 注入方式 / 配置资产格式 / 许可证-活跃度

| 引擎 | 模型/provider 注入方式 | 配置文件/资产格式 | 许可证/活跃度 |
|---|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL/AUTH_TOKEN`；Bedrock/Vertex/Foundry；SDK `model/fallbackModel` | `CLAUDE.md`/`.claude/settings.json`/`.mcp.json`/`plugin.json` | 商业闭源 CLI（条款限制第三方复用登录额度），极活跃，周更 |
| pi-agent | `pi.registerProvider()` 代码级/`models.json` 声明级 | `~/.pi/agent/settings.json`/`models.json`/`extensions/`/`skills/`/`prompts/` | MIT，101k+ stars，v0.84.4，极活跃（几乎周更） |
| opencode | `opencode.json` `provider.<id>{npm,options{baseURL,apiKey}}` | `opencode.json`/`.opencode/{agents,commands,skills,plugins}`/`AGENTS.md` | MIT，约 203.6k stars，v1.18.27 稳定+v2 beta 并行，极活跃 |
| Hermes | 每请求覆写 `model/provider`；`direct_model_requests` 开关 | `~/.hermes/config.yaml`+`.env`；`SOUL.md`；`profiles/` 多租户 | MIT，2026-08 一个月 7 个版本，演进极快 |
| dsh | `settings.yaml` providers 声明；ACP `session/set_config_option{model}` | `profiles/`+`cordis.patch.yml` 分层叠加；`--dump-config` 可见 | MIT，developer preview，**日更且明确"会有破坏性变更"**，211k stars 但不稳定 |
| Codex CLI | `[model_providers.<id>]base_url/env_key/wire_api` | `config.toml`(150+ 键)/`AGENTS.md`/`hooks.json` | Apache-2.0(核心)，npm latest 0.153.2，活跃 |
| Gemini CLI | `GOOGLE_GEMINI_BASE_URL`/`settings.json baseUrl+apiKey` | `~/.gemini/GEMINI.md`/`settings.json`/`extensions/` | Apache-2.0，Google 官方维护，活跃 |
| Qwen Code | `OPENAI_BASE_URL` 等环境变量或 `settings.json.modelProviders` | `.qwen/.env`/`settings.json` | Apache-2.0（继承 Gemini CLI），阿里维护，活跃 |
| Kimi CLI | TOML `[providers.<id>]` | TOML config | 正处于 kimi-cli→kimi-code 迁移期，协议不稳定 |
| iFlow CLI | 历史：OpenAI 兼容层 | ? | **已停运（2026-04-17）**，不建议接入 |
| Goose | `OPENAI_HOST`/`GOOSE_PROVIDER__HOST`/`GOOSE_PROVIDER=openai` | Recipe YAML/`.goosehints`/`AGENTS.md` | Apache-2.0，2026 迁移至 AAIF(Linux Foundation)，活跃但架构重构中 |
| Cline | ? 未详 | ? 未详 | 2026-02-13 完成 CLI 全新重写，活跃 |
| Kilo Code | ? 未详 | ? 未详 | 与 Roo Code 关联品牌，活跃度中等 |
| Amp | ? 未详（官方文档登录墙未抓取） | ? 未详 | 商业产品(Sourcegraph)，活跃 |
| Copilot CLI/SDK | BYOK 四种认证(GitHub OAuth/Apps/env token/BYOK) | ? 未详 | GitHub 官方产品，2026-06 GA，活跃 |
| Droid | ? 未详 | ? 未详 | Factory AI 商业产品，活跃度未知 |
| OpenHands | ? | ? | ? |
| OpenClaw | `models.providers.<name>{baseUrl,apiKey}`；`agentRuntime.id` 按 model/provider 选择 | `~/.openclaw/openclaw.json`(JSON5,严格 schema) | MIT，2026.8.1(日期版)，二手报道 355k stars/1200+ 贡献者；**安全事件多**(CVE-2026-25253/32922)，极活跃但安全历史沉重 |

---

## 2. 接入面类型分类

| 类型 | 代表引擎 | 适配器要点 | 代价 |
|---|---|---|---|
| **ACP 原生** | Gemini CLI、Qwen Code(推测同 flag)、opencode(`opencode acp`)、Goose(`goose acp`/`goose serve`)、Kilo(`kilo acp`)、dsh(`--profile acp`)、Kimi CLI(`kimi acp`)、OpenClaw(`openclaw acp` 作 server；`@openclaw/acpx` 作 client 驱动其它引擎)、Claude Code(第三方 `claude-agent-acp`，非官方但事实标准) | 标准 `session/new\|load\|resume\|prompt\|cancel`+`session/update`+`session/request_permission`；一套适配器代码可服务多引擎，天然支持能力协商(`initialize.capabilities`) | 引擎特有能力（hooks 粒度、workflow、记忆、team、fork/revert）落在 ACP 协议之外，须旁路或放弃；权限模型被压缩为 ACP 标准三态，粒度弱于原生 policy engine；各引擎 ACP 成熟度参差（Amp/Crush 需第三方桥接，Kimi CLI 有已知 bug） |
| **自有 JSON-RPC / stream-json 子进程** | Claude Code(`-p stream-json`)、Codex(`exec --json`/`app-server`)、pi(`--mode rpc/json`)、dsh(`--profile sdk`)、Amp(`--stream-json`，与 Claude Code 兼容)、Cursor CLI、Droid(`--stream-jsonrpc`) | 语言无关，一进程一 session 天然隔离；可用首帧(`system/init`/`initialize`)做能力协商；子进程可被 cgroup/容器限额 | 私有字段命名逐引擎不同，需各写 parser；审批/取消/心跳等控制面常未公开文档化（Claude Code control_request、dsh SDK 无 cancel）；进程池管理成本（启动开销、僵尸进程回收、Windows 下子进程信号语义差异） |
| **HTTP 服务** | opencode(`serve`)、Hermes(`:8642`)、Goose(`goosed`,~103 端点)、OpenClaw(`:18789` WS+HTTP)、dsh(`web:3080`，非稳定 API) | 长驻 server 支持多 session/多目录；SSE 可用于统一事件消费；便于水平扩展与健康检查 | 每引擎私有 REST 契约需逐个适配，且契约漂移快（opencode v1/v2 并行、字段改名 `permission.asked→permission.updated`）；鉴权/多租户默认弱（多数仅绑 `127.0.0.1`+可选 Basic Auth），需网关自建租户隔离；`prompt_async` 类端点语义可能与预期不同（opencode 立即 204，需网关自己拉 SSE 模拟阻塞） |
| **SDK 进程内** | Claude Agent SDK(TS/Python)、pi SDK(`createAgentSession`)、Codex SDK(实为封装 exec 子进程)、Copilot SDK(JSON-RPC 连接 CLI 进程) | 类型化消息、进程内回调(`canUseTool`/hooks)、零 IPC 自定义工具注入(`createSdkMcpServer`)；`sessionStore` 等外部存储接口可对接网关自有存储 | 绑定特定语言运行时(Node/Python)，且 SDK 版本与引擎版本强耦合（Claude TS SDK 0.3.191↔CC 2.1.191）；多租户隔离需网关自己在同进程内做，弱于子进程方案；许可条款可能限制复用官方订阅登录（须走 API key） |
| **仅 CLI 文本** | iFlow(已停运)、多数引擎的纯文本降级模式(Cline/Kilo/Droid 的 `text` 格式) | 集成成本最低，适合无状态批处理/CI 兜底 | 无结构化事件、无法做实时审批、无法可靠取消，仅适合"一次性任务、结果对错不敏感执行细节"的场景，不建议作为主接入面 |

---

## 3. 每引擎独特扩展能力清单

- **Claude Code**：Dynamic Workflows — JS 脚本编排(`agent()/parallel()/pipeline()`)；参数 `--effort ultracode`、`workflowSizeGuideline`；触发方式 `/<workflow-name>` 或 `origin=human` 消息中出现 `ultracode` 关键词。Hooks 生命周期拦截（30+ 事件，5 种 handler，exit 2 阻断）；参数 `.claude/settings.json.hooks`；触发方式 PreToolUse/PostToolUse 等事件自动触发。
- **pi-agent**：Extensions 进程内钩子（`tool_call` 可 `block`+改写 `event.input`）；参数 `-e <path|npm:|git:>`；触发方式工具调用前拦截。RPC worker 模式（社区）：主会话持久 worker + `task_start/status/send/wait/close`。
- **opencode**：Steer/Queue 插话（v2 `delivery:"steer"|"queue"`）；参数 `POST /api/session/{id}/prompt{delivery}`；触发方式运行中追加消息。Share 链接（`POST /session/{id}/share`）；参数 `share:"manual"|"auto"|"disabled"`。
- **Hermes**：自进化技能（`skill_manage` 自动 create/patch）；参数 `skills.write_approval`；触发方式复杂任务(5+ 工具调用)后建议或使用中发现过时/错误。Cron with memory（`continuity`/`context_from` 跨 job 传递输出）；参数 `cronjob` 工具 create。
- **dsh**：运行时自修改（`tool-cordis` 七个工具动态挂载/卸载 Cordis 包，仅内存）；参数 `extensions/` 模块；触发方式模型主动调用。把 Claude Code/Codex 原生作为子代理后端；参数 `ctx.subagents` provider=`claude-code`/`codex`。
- **Codex CLI**：Guardian 自动审批（`approvals_reviewer="auto_review"`，模型评估风险自动放行/拒绝）；参数 `thread/approveGuardianDeniedAction`。原生 Windows elevated 沙箱（专用低权限账户+ACL+防火墙+本地策略）；参数 `sandbox_mode="danger-full-access"`+elevated 权限提示一次性管理员授权。
- **Gemini CLI**：Policy Engine（多维匹配：工具名通配/参数正则/命令前缀/MCP 名/subagent/环境，分层优先级 `tier_base+toml_priority/1000`）；参数 `~/.gemini/policies/*.toml`；触发方式每次工具调用匹配规则链。A2A 远程委派（`RemoteAgentInvocation`，`agents.toml kind="remote"`）；触发方式模型选择远程 agent 工具。
- **Qwen Code**：五档审批模式（`plan/default/auto-edit/auto/yolo`）；参数 `--approval-mode`；比 Gemini CLI Policy Engine 更易被网关快速映射为等级参数。
- **Goose**：Recipe + Subrecipes（YAML 声明式工作流，`response.json_schema` 约束结构化输出）；参数 `--recipe path --params k=v`；触发方式 `goose run --recipe`。smart_approve（LLM 分类器 PermissionJudge 自动放行低风险工具调用）；参数 `GOOSE_MODE=smart`。
- **Cline**：`--team-name` 多 agent 协作空间（共享 Kanban 任务看板+agent 间邮箱+mission log）；参数 `cline --team-name <name>`；触发方式启动时声明团队。`--hook-command` 策略脚本网关（每次工具调用外部脚本裁决）。
- **Kilo Code**：Modes（Architect/Ask/Debug/Orchestrator 预置角色 Prompt+工具集组合，接近轻量 subagent 声明）；参数 `--mode <name>`；`--fork`/`--cloud-fork` 会话分叉与云端拉取续跑。
- **Amp**：Oracle（GPT-5 驱动强推理子代理，可作主 agent/独立 oracle/普通 subagent 多角色切换）；参数 `/handoff` 把 Oracle 计划带入新 thread。
- **Copilot SDK**：`SendAndWaitAsync`(阻塞至 idle)/`SendAsync`(fire-and-forget+事件流) 双调用模式，与赛题 `prompt_async` 语义高度接近，可直接参考其抽象设计。
- **Droid**：`--stream-jsonrpc` 输出格式天然贴近 JSON-RPC，被第三方 `droid-acp` 直接拿来做 ACP 适配传输层，无需引擎自身声明支持即可"翻译"成 ACP。
- **OpenClaw**：ACP 外部 harness 编排（`@openclaw/acpx`，同一 Gateway 用统一 session key 语法驱动 claude/codex/gemini/opencode/cursor/copilot/droid/pi 等异构引擎）；参数 `agents.entries.<id>.runtime.acp{agent,backend,mode,cwd}`；触发方式 `sessions_spawn({runtime:"acp",...})` 或 `/acp spawn <agent>`。队列模式 `steer|followup|collect|interrupt`（同一 session 消息如何与运行中的 turn 交互）；参数 `messages.queue.mode`。

---

## 4. 选型建议（面向 3 人团队）

**综合排序维度**：Windows 可运行性 × 内部模型兼容 × 办公任务能力 × 网关接入难度 × 部署稳定性。

### 必接（2 个）

1. **opencode**（网关接入难度最低，内部模型兼容最好）
   理由：赛题"通用 Agent 网关规范"在端点命名（`POST /session`、`GET /session/status`、`prompt_async`、`GET /event`）上高度贴近 opencode 真实 server API（G04 逐项核对），适配代码复用率最高；`provider.<id>.npm` 原生支持 `@ai-sdk/openai-compatible`/`@ai-sdk/anthropic`，内部模型端点零转换直连；SKILL.md/MCP/AGENTS.md 资产生态成熟，Office 技能可直接复用 anthropics/skills 格式。**唯一重大风险**：官方"strongly recommend WSL"，与"Windows 原生运行"硬约束正面冲突，必须作为第一项验证任务。

2. **Codex CLI**（Windows 原生可运行性最高，部署最稳）
   理由：唯一把原生 Windows 沙箱当一等工程目标的引擎（elevated 模式四层防御，v0.100.0 转正），`app-server` 长驻 JSON-RPC + 显式 `thread/turn/item` 三层模型天然契合"群→session"映射与审批回传（`item/*/requestApproval`）；OpenAI 官方维护，版本节奏可控，`generate-json-schema` 可做契约回归测试。风险：`wire_api` 仅认 Responses 协议，内部模型网关若不支持该协议需自建/复用代理转换（G02 已给出坑清单），需提前联调验证。

### 备选（2 个）

3. **Qwen Code**（内部模型兼容与 Windows 兼容性均衡，Gemini CLI 生态备份）
   理由：Gemini CLI 内核 fork，原生多协议 provider(OpenAI/Anthropic/Gemini/Qwen)，`--continue`/`--resume [sessionId]` 会话恢复比 Gemini CLI 更完整，五档 `--approval-mode` 易于映射网关权限等级，官方 PowerShell 安装脚本；若 opencode 原生 Windows 验证失败，可作为"网关规范二次映射"的替代主力。

4. **Goose**（办公任务能力最强，治理与观测最成熟的备选）
   理由：内置 **Computer Controller** 扩展直接覆盖 Windows 桌面/Office 自动化场景；原生 OTel+Langfuse+MLflow，可观测性在候选中最规范；Apache-2.0+迁移至 AAIF(Linux Foundation)，长期治理风险低于 dsh/Hermes 这类单一厂商强绑定或"开发者预览"项目；提供标准 ACP(`goose acp`/`goose serve`)可与 opencode/Qwen 走同一套 ACP 适配器。风险：架构处于 per-session Agent 重构活跃期，`.goosehints` headless 默认不加载、`GOOSE_MODE=auto` 部分 provider 失效等坑需要显式规避。

**明确不建议作为主力的候选及理由**：Claude Code（硬编码 Anthropic Messages，官方明确不支持路由非 Claude 模型，与"内部模型"硬约束直接冲突，仅可作参考/对比对象）；dsh（developer preview，日更且明确"会有破坏性变更"，遥测默认外发 DeepSeek，SDK 通道无 cancel/审批）；Hermes（自身即"网关+多渠道 harness"，存在双网关叠层风险，Windows 仅 early beta）；iFlow（已官方停运）；OpenClaw 不作为"被接入的引擎"，而是可参考的网关架构范式（ACP 外部 harness 编排、session key 语法、OTel 归一化）。

### 验证清单（接入前必须过一遍）

1. **原生 Windows 冒烟测试**：不借助 WSL，在纯 Windows 10/11 上跑通 `opencode serve`/`codex app-server`/`qwen -p`/`goose run` 的启动、健康检查、一次完整 prompt→response 循环。
2. **内部模型端点往返测试**：注入内部 OpenAI/Anthropic 兼容端点，验证流式 `tool_calls` 增量在长工具调用序列下不损坏（G02 已知坑：reasoning→tool_calls 混合流拼接损坏）。
3. **会话恢复/分叉测试**：验证 `session_id`/`--resume`/`--fork` 在网关重启后仍可续接，且并发写同一 session 不产生交错（Claude Code/opencode 均有此已知风险）。
4. **权限/审批往返测试**：模拟一次 `deny` 和一次 `allow_once`，验证事件名（如 opencode `permission.updated` 而非文档旧称 `permission.asked`）与回复端点字段（`response`/`reply` 命名不一致）均以运行时实测为准。
5. **Office 技能与 GUI 自动化测试**：跑通 docx/xlsx/pptx 读写渲染回读闭环（LibreOffice headless + pdftoppm 校验）；Windows-MCP 在有头图形会话下的 Click/Snapshot 是否可用（无头容器会直接失败）。
6. **取消/超时测试**：验证 `abort`/`interrupt` 端点在长任务运行中途调用后进程/子进程是否真正终态化，而非"假取消"（参考 UHP conformance C-03 "真正停下来并进入终态"标准）。
7. **可观测事件映射测试**：把引擎原生事件流映射到网关统一 schema（`session.*`→lifecycle、`tool.*`→tool、`permission.*`→approval），检查字段丢失（如 opencode `finish` 实际 6 值而非文档 4 值）。
8. **部署稳定性/资源压测**：24 小时以上多 session 并发软运行，观察进程池泄漏、内存增长、versions drift（dsh/opencode v2 尤其需要）。
9. **许可与合规检查**：确认所选引擎许可证（MIT/Apache-2.0/商业条款）允许比赛场景下的分发与自动化部署方式（Claude Code 官方条款明确禁止第三方复用订阅登录额度）。
