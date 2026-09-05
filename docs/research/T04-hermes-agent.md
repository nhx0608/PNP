# T04 Hermes Agent (NousResearch/hermes-agent) 自进化助手引擎

> 调研日期：2026-09-04。以下内容以官方文档 / GitHub 一手资料为准，标注"[推测]"者为基于源码结构的推断。

## 摘要

Hermes Agent（Nous Research，MIT，Python）是"长期伴随 + 跨平台 + 自我改进"取向的通用助手 harness，而非 IDE 编程助手。最新版 v0.21.0（tag `v2026.8.31`，2026-08-31），2026 年 8 月一个月内发布 7 个版本，演进极快。架构上它本身就是"网关 + 引擎"合体：`hermes gateway` 守护进程同时承载 30+ 消息平台适配器（Telegram/Discord/Slack/WhatsApp/Signal/飞书/钉钉/企微/微信/QQ/Matrix/Teams 等）、OpenAI 兼容 API server（:8642）、每 60s tick 的 cron 调度器与 outbound webhooks；`AIAgent`(run_agent.py) 按 session 缓存并以 turn lease 串行化；命令在 `local/docker/ssh/singularity/modal/daytona/vercel_sandbox` 7 种后端执行。

会话以 SQLite `~/.hermes/state.db`（WAL，`sessions/messages/messages_fts(FTS5)/gateway_routing`）持久化，key 形如 `agent:main:<platform>:group:<chat_id>:<user_id>`，群聊默认按用户隔离（`group_sessions_per_user`），默认不自动重置（`session_reset.mode: none`）。API 侧最有价值的接入面是 `/api/sessions/*`（显式建/续/流式）配合 `X-Hermes-Session-Key`（自定义记忆作用域）以及 `/v1/runs`（`Idempotency-Key`、`/events` SSE、`/approval`、`/steer`），`GET /v1/capabilities` 可直接用于能力协商。另有 ACP（`hermes acp`，进程内会话，IDE 用）、`hermes mcp serve`、CLI 一次性 `-z/-Q/-q/--resume/-p`。

记忆为 `MEMORY.md`(2,200 chars)+`USER.md`(1,375 chars) 冻结快照注入 + FTS5 `session_search`，向量/用户建模交由 8 个外部 provider（Honcho 等）附加。技能遵循 agentskills.io（SKILL.md），agent 通过 `skill_manage` 自动创建/自修补——这是 Hermes 最独特的"自进化"扩展能力；hub 安装有安全扫描。多 agent 有 `delegate_task`（leaf/orchestrator、实时 steer/stop、`max_spawn_depth`）、带记忆的 cron、A2A v1.0、Bot Mode/`hermes peer`。安全为 `approvals.mode: smart|manual|off` + 硬 blocklist + 分层 allowlist/DM pairing + 文件写保护。可观测依赖 SSE 事件名、HMAC-SHA256 签名的 outbound webhooks (`X-Hermes-Signature-256`) 与 26 个 plugin hooks，未见原生 OTel。接入我们的网关时需处理"双网关叠层"、profile 级记忆非按业务分片、无人值守审批默认 deny 等坑。

## 关键事实（表格）

| 事实 | 来源 | 置信度 | 交叉验证 |
|---|---|---|---|
| 最新版本 v0.21.0 "Pantheon Release"（tag `v2026.8.31`，2026-08-31），自 v0.20.0 起约 5,800 commits / 2,475 PR / 760+ 贡献者 | GitHub Releases + WebSearch 摘要 | 高 | [已交叉验证] |
| 版本双号制：语义版本 v0.20.x/v0.21.0 与日期 tag `v2026.8.x` 并存 | GitHub Releases | 高 | 是 |
| 内置 OpenAI 兼容 API server：`/v1/chat/completions`、`/v1/responses`、Runs API、Jobs API、`/api/sessions/*`；默认端口 `8642`，Bearer 鉴权 `API_SERVER_KEY` | docs api-server.md + WebSearch(官方 docs 站) | 高 | [已交叉验证] |
| 会话持久化：SQLite `~/.hermes/state.db`（WAL），表 `sessions`/`messages`/`messages_fts`(FTS5)/`gateway_routing` | docs sessions.md | 高 | 与 memory.md 中 FTS5 session_search 描述一致 [已交叉验证] |
| 网关 session key 形如 `agent:main:<platform>:dm:<chat_id>`、群聊 `agent:main:<platform>:group:<chat_id>:<user_id>`（默认按用户隔离，`group_sessions_per_user`） | docs sessions.md + Discord docs 搜索摘要 | 高 | [已交叉验证] |
| 会话默认不自动重置（`session_reset.mode: none`），可选 `idle`/`daily`/`both`；重置前给 agent 一轮保存记忆/技能 | docs sessions.md + FAQ 搜索摘要 | 高 | [已交叉验证] |
| 记忆 = `~/.hermes/memories/MEMORY.md`(2,200 chars) + `USER.md`(1,375 chars)，会话开始时冻结快照注入；外部 provider 8 个（Honcho、Mem0、OpenViking、Hindsight、Holographic、RetainDB、ByteRover、Supermemory）为附加而非替代 | docs memory.md / memory-providers | 高 | [已交叉验证] Honcho 官方 docs 同述 |
| 技能遵循 agentskills.io 标准，`~/.hermes/skills/<category>/<name>/SKILL.md`；`skill_manage` 动作 `create/patch/edit/delete/write_file/remove_file`；hub 源含 `official/skills-sh/well-known/url/github/clawhub/lobehub/browse-sh`；安装时安全扫描，`dangerous` 判定不可 `--force` | docs skills.md | 高 | 与 README "agentskills.io" 一致 [已交叉验证] |
| 终端执行后端 7 种：`local/docker/ssh/singularity/modal/daytona/vercel_sandbox` | README + configuration docs | 高 | [已交叉验证] |
| Runs API 支持 `Idempotency-Key`、`/v1/runs/{id}/events` SSE（含 `subagent.start/complete`）、`/approval` 审批闸门、`/stop`；默认并发上限 10 (`max_concurrent_runs`) | docs api-server.md | 高 | 单来源 |
| `X-Hermes-Session-Key`（≤256 chars）可让 API 客户端指定长期记忆作用域，与 `X-Hermes-Session-Id` 解耦 | docs api-server.md | 高 | 单来源 |
| v0.20.0 (2026-08-03) 引入 Outbound webhooks（签名生命周期事件）、A2A v1.0 协议、语音；v0.20.3 迁移 MCP 2.x SDK；v0.21.0 引入 Bot Mode、`hermes peer`、cron 记忆、子代理实时 steering | GitHub Releases | 高 | 与 WebSearch 摘要一致 [已交叉验证] |
| 配置 `~/.hermes/config.yaml`（非密钥）+ `~/.hermes/.env`（密钥），优先级 CLI > config.yaml > .env > 默认 | docs configuration | 高 | 单来源 |
| 提供 `hermes claw migrate` 从 OpenClaw 迁移（SOUL.md、memories、skills、密钥、消息平台配置） | README | 高 | 单来源 |

## 架构与工作原理

**定位**：Hermes Agent 是 Nous Research 开源（MIT）的 Python 通用助手型 agent harness，口号 "The agent that grows with you"。设计重心不是 IDE 编程助手，而是"长期伴随、跨平台、自我改进"的个人/团队助手：一个 agent 进程通过 gateway 挂到多个即时通讯平台，任务在可选的远程沙箱中执行，经验沉淀为 skills 与 memory。

**核心循环**（README，https://github.com/NousResearch/hermes-agent）：
`对话 → 工具调用 → 结果处理 → 记忆持久化`，外加两条学习旁路：
1. **Agent-curated memory with periodic nudges**：系统周期性提示 agent 把值得记住的事写入 MEMORY.md / USER.md；
2. **Autonomous skill creation after complex tasks**（5+ 次工具调用后触发建议）以及 **skills self-improve during use**（发现技能过时/错误时 `skill_manage patch`）。
跨会话回忆依赖 **FTS5 session search + LLM summarization**。

**分层结构**（综合 README、configuration、api-server 文档整理；目录名依据官方文档 File Layout）：

```
┌──────────────────────────── Gateway (hermes gateway) ────────────────────────────┐
│ 平台适配器: Telegram | Discord | Slack | WhatsApp | Signal | Email | Feishu | DingTalk │
│            LINE | QQ | Weixin | Matrix(社区) | CLI | Desktop App                    │
│ API Server (OpenAI 兼容 :8642) | Cron scheduler | Outbound webhooks | A2A          │
│ 路由: session_key → gateway_routing → session_id ; 每 session 一把 turn lease 锁    │
└─────────────────────────────────────────┬────────────────────────────────────────┘
                                          ▼
┌────────────────────────────── Agent Core (AIAgent) ──────────────────────────────┐
│ system prompt 组装: SOUL.md + MEMORY.md/USER.md 快照 + skills 元数据 + 平台提示      │
│ 工具循环 (max_turns 默认无限) | compression (threshold 0.5, tail 0.2)               │
│ toolsets: terminal/file/web/browser/memory/skills/session_search/delegate/cron/mcp │
│ auxiliary models: vision / title / compression / delegation                        │
└─────────────────────────────────────────┬────────────────────────────────────────┘
                                          ▼
┌───────────────────────────── Execution backends ─────────────────────────────────┐
│ terminal.backend: local | docker | ssh | singularity | modal | daytona | vercel_sandbox │
└──────────────────────────────────────────────────────────────────────────────────┘
持久层: ~/.hermes/state.db (SQLite WAL: sessions/messages/messages_fts/gateway_routing)
        ~/.hermes/memories/*.md  ~/.hermes/skills/  ~/.hermes/cron/  ~/.hermes/logs/
```

**平台覆盖**（README 列出 Telegram/Discord/Slack/WhatsApp/Signal/Email/CLI；v0.20.0 发布说明明确"Voice on all platforms: WhatsApp, Feishu, DingTalk, LINE, QQ, Weixin"，说明飞书/钉钉/LINE/QQ/微信适配器已存在，https://github.com/NousResearch/hermes-agent/releases）。Matrix 等由社区插件提供 [推测，未在一手文档确认]。

**Gateway 与 Agent 的解耦程度**：gateway 进程同时承载消息平台适配、API server、cron、webhooks；agent 实例按 session 缓存（`agent.agent_cache.max_size: 128`，`idle_ttl_secs: 3600`），每个 gateway turn 需获取 session lease（`gateway_turn_lease_timeout: 5`），并有 `session_stall_timeout: 300` 看门狗（configuration 文档）。这意味着 Hermes 自身就是一个"小型 Agent 网关 + 引擎"合体——对我们的架构而言，需要决定是**绕过 Hermes gateway 直接以 API server 方式驱动 agent core**，还是**把 Hermes gateway 当作第二层网关**。

## 可编程接入面

### 1) CLI（本地/无头）
一手来源：README 与 configuration/sessions 文档。
```bash
hermes                          # 交互 TUI
hermes chat --model anthropic/claude-opus-4      # 覆盖模型（CLI 参数优先级最高）
hermes --continue | -c          # 续接最近 CLI 会话（-c 按 tty/tmux pane 感知）
hermes --resume <id|name> | -r  # 按 session id 或 title 恢复；--resume latest
hermes --in <dir>               # 固定工作目录
hermes gateway [restart]        # 启动/重启网关
hermes sessions export out.jsonl --format {jsonl|md|qmd|html|trace} [--redact] [--upload]
hermes config get|set|unset|check|migrate
hermes skills browse|search|inspect|install|check|update|uninstall|tap add
hermes memory setup [honcho]
hermes claw migrate [--dry-run|--preset user-data|--overwrite]
hermes doctor | hermes update
```
文档在 CLI 部分还提到 `hermes chat -q "..."` 形态的单次提问（WebSearch 摘要提及，本次未在一手页面逐字确认，[推测] 存在非交互 `-q/--query` 参数）。CLI 支持的斜杠命令与消息平台共享：`/new /reset /model /personality /retry /undo /compress /usage /insights /skills /<skill> /stop /status /sethome`，v0.20.0 又加了 `!` shell 模式、`/init /diff /context /focus`。

### 2) OpenAI 兼容 HTTP API Server（推荐的网关接入面）
来源：https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md（[已交叉验证] 官方 docs 站同页）。

启用：
```bash
# ~/.hermes/.env
API_SERVER_ENABLED=true
API_SERVER_KEY=<token>          # Bearer
API_SERVER_PORT=8642            # 默认
API_SERVER_HOST=127.0.0.1
API_SERVER_CORS_ORIGINS=http://localhost:3000
```
或 `config.yaml`:
```yaml
gateway:
  api_server:
    enabled: true
    port: 8642
    key: your-secret-key
    max_concurrent_runs: 10     # 0 = 不限；超限返回 429
    direct_model_requests: false
```
随 `hermes gateway` 一起启动。端点族：

| 端点 | 用途 | 状态语义 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat 格式，**无状态**（整段 `messages` 由客户端带） | SSE 增量为 `chat.completion.chunk`，另有 `event: hermes.tool.progress` 工具进度事件 |
| `POST /v1/responses` | OpenAI Responses 格式，**服务端保存状态**：`store: true`，续接用 `previous_response_id` 或 `conversation: "<name>"` | 输出含 `function_call` / `function_call_output` / `message` 结构化项；最多保存 100 条响应（LRU） |
| `POST /v1/runs` → `GET /v1/runs/{id}` / `GET /v1/runs/{id}/events` / `POST .../stop` / `POST .../approval` | 长任务异步 Run；`Idempotency-Key` 头（1-255 ASCII），重放返回 202 + `Idempotency-Replayed: true`；events SSE 含 token、tool 调用、生命周期、`subagent.start/complete`；事件缓冲 5 分钟过期 | **审批闸门通过 `/approval` 解决** |
| `GET/POST /api/sessions`, `GET /api/sessions/{id}`, `POST /api/sessions/{id}/chat`, `POST /api/sessions/{id}/chat/stream` | 显式 session 管理（分页 `limit/offset`）；stream 事件：`assistant.delta`、`tool.started`、`tool.completed`、`run.completed` | **这是做"业务→session 映射"的最直接接口** |
| 请求头 `X-Hermes-Session-Id` / `X-Hermes-Session-Key`(≤256) | 前者绑定 transcript，后者独立指定长期记忆作用域，如 `agent:main:webui:dm:user-42` | 允许"同一群多个 transcript 共享一个记忆域" |
| `/api/jobs` CRUD + `/pause /resume /run` | 定时任务 Jobs API | |
| `GET /v1/models`、`GET /api/model/options?refresh=1` | 模型清单 | |
| `GET /v1/capabilities` | 返回 `{"platform":"hermes-agent","auth":{"type":"bearer","required":true},"features":{"chat_completions":true,"responses_api":true,"run_submission":true,...}}` | **可直接用于我们的"能力识别"步骤** |
| `GET /v1/skills`、`GET /v1/toolsets` | 枚举技能与工具集 | 能力协商用 |
| `GET /health`、`GET /health/detailed` | 存活/就绪（后者需鉴权，含 DB/模型/磁盘/网关状态） | |

每请求可覆写模型：`"model"`, `"provider"`, `"model_options": {"reasoning_effort":"high","service_tier":"priority"}`；`direct_model_requests` 未开时，`/v1/chat/completions`、`/v1/responses` 上只带 `model` 不带 `provider` 会被忽略。多 profile 时每个 profile 用自己的 `~/.hermes/profiles/<profile>/.env` 中的 `API_SERVER_KEY` 鉴权。限制：不支持文件上传（`file/input_file/file_id` → 400 `unsupported_content_type`），仅内联图片 `image_url`；前端 system prompt 与 agent 核心 prompt **叠加**而非替换。

### 3) 其他协议面
- **A2A v1.0**（Agent-to-Agent 协议，v0.20.0 引入，用于发现与多 agent 编排）与 **`hermes peer`**（v0.21.0，跨 profile / gateway 的 agent 间 DM）—— GitHub Releases。
- **MCP**：作为 MCP client 接入外部 MCP server（`mcp_servers` 配置，v0.20.3 迁移到 MCP 2.x SDK，支持 stateless 协议；v0.20.6 内置 50+ MCP catalog）。是否将自身暴露为 MCP server 未在一手资料确认 [未确认]。
- **Outbound webhooks**（v0.20.0）：签名的生命周期事件（session 活动、turn 完成、tool 事件）推送给外部 URL —— 对网关做被动观测非常有用。
- **ACP (Agent Client Protocol)**：本次一手资料中**未见** Hermes 支持 ACP；它的编辑器/前端接入面是 OpenAI 兼容 API 而不是 ACP。
- **Python SDK**：官方文档主推 HTTP API；`hermes-agent` 本体是 Python 包，可 in-process 调用 `AIAgent` 类 [推测，基于 DeepWiki 结构，未逐字验证]。

### 4) ACP（Agent Client Protocol）—— 已确认存在 [已交叉验证]
来源：https://hermes-agent.nousresearch.com/docs/user-guide/features/acp 与 https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration。
- 安装：`uv pip install -e '.[acp]'`（依赖 `agent-client-protocol`），启动 `hermes acp` / `hermes-acp` / `python -m acp_adapter`（stdout 专用于 ACP JSON-RPC，日志到 stderr）；辅助 `--check`、`--setup`、`--version`。
- 支持 `initialize`、`session/new`、`session/load`、`session/prompt`、`list/load/resume/fork`、cancel、permission request；工具输出渲染为 ACP Diff/ToolCall 内容块。
- **限制**：ACP 会话由 adapter 的**内存 session manager** 管理、作用域仅限当前 ACP 进程；使用精简的 `hermes-acp` toolset（排除消息投递与 cronjob 管理）；审批仅 allow once / allow session / allow always / deny。
- 结论：ACP 适合 IDE 场景，**不适合**作为群助手网关的长期会话接入面（进程内会话、缺少消息/定时能力）。

### 5) `hermes mcp serve`
CLI 参考页列出 `hermes mcp <catalog|install|serve|add|remove|list|test|configure|login>`，其中 `hermes mcp serve` 描述为 "expose conversations to other agents"（https://hermes-agent.nousresearch.com/docs/reference/cli-commands）。即 Hermes 既是 MCP client 也可作为 MCP server 暴露。[已确认存在，细节未展开]

### 6) 无头 CLI（补充确认）
CLI 参考页（一手）：`-q/--query "..."` 播种首轮；`--oneshot` 回答后退出；`-Q/--quiet` 程序化模式（抑制 banner/spinner/工具预览）；`-z` "purest one-shot entry point: single prompt in, final response text out"；`-m/--model`、`--provider`、`-t/--toolsets <csv>`、`-s/--skills`、`-p/--profile <name>`（多 profile = 多个隔离 Hermes 实例，`hermes profile create|list|show|rename|use|remove|archive|restore`）。退出码：0 成功、1 后端/agent 错误、2 用法错误、75 端口冲突。
`approvals.single_query_mode: deny`（默认）意味着 `-q` 单轮会话中危险命令默认被拒绝而非等待审批。

### 7) Python in-process
programmatic-integration 页明确写 "import `run_agent.AIAgent` directly" 可免子进程嵌入，但未给签名示例；API server 实现位于 `gateway/platforms/api_server.py`（即 API server 被实现为一个"平台适配器"）。

## 会话模型

来源：https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md（一手）；FAQ；Discord 文档搜索摘要。

**持久化**：`~/.hermes/state.db`（SQLite，WAL）。表：`sessions`（id、source、user_id、model、title、时间戳、token 计数；title 非空唯一）、`messages`（role/content/tool_calls）、`messages_fts`（FTS5）、`gateway_routing`（session key → 当前活跃 session id）。`database.journal_mode/synchronous/wal_autocheckpoint` 可调。

**Session key（业务→session 映射的核心）**：
```
agent:main:telegram:dm:<chat_id>                       # DM：每聊天一个
agent:main:whatsapp:dm:<canonical_id>                  # 别名归并
agent:main:<platform>:group:<chat_id>:<user_id>        # 群聊默认按用户拆分
agent:main:<platform>:group:<chat_id>:<thread_id>      # 话题/线程（共享或按用户）
agent:main:<platform>:channel:<chat_id>:<user_id>
```
`agent:main` 前缀对应 profile/agent 名（多 profile 时不同）。`group_sessions_per_user: true|false` 控制群是"每人一会话"还是"整群共享"。FAQ 指出平台差异：Slack 默认按 thread 键（同一 thread 多人共享一会话）、Discord 亦有按频道键的模式 [已交叉验证 sessions.md + FAQ]。API 客户端可用 `X-Hermes-Session-Key` 自定义该 key（≤256 chars），因此**外部网关可以直接把自己的业务 id 编码进 key**，例如 `agent:main:webui:dm:user-42`。

**重置策略**：
```yaml
session_reset:
  mode: none | idle | daily | both   # 默认 none
  idle_minutes: N
  daily_at: "HH:MM"
```
重置前 agent 得到一轮机会把重要信息写入 memory/skills；用户可 `/new` `/reset` 手动开启新会话。**压缩**（`compression.threshold: 0.5`, `target_ratio: 0.2`）触发时生成编号续接会话（"my project #2"），用 `parent_session_id` 保留谱系；`hermes sessions export --lineage logical` 可把整条压缩链导出为一份文档。

**并发**：每 session 一把 turn lease（`agent.gateway_turn_lease_timeout: 5` 秒），"Hermes tracks running agents by session key"——同频道 Alice 与 Bob 各自的运行互不干扰；`session_stall_timeout: 300` 看门狗；API server 全局 `max_concurrent_runs: 10`。会话身份（routing key/chat/origin）在建行时**原子写入**；重启后按"最近真实活动"恢复路由，且不越过 `/new` 边界。

**清理**：`sessions.auto_prune: true`、`retention_days: 90`、只删除已结束会话；启动时把 cron/CLI/subagent 来源的孤儿会话标记 `end_reason: startup_orphan_reap`；消息平台与 pinned 会话免疫。

**导出**：`hermes sessions export --format jsonl|md|qmd|html|trace [--redact] [--upload]`（trace 可上传 HF Agent Trace Viewer）——可作为评测/审计数据源。

## 权限与安全

来源：https://hermes-agent.nousresearch.com/docs/user-guide/security（一手）[与 WebSearch 摘要交叉验证]。

1. **危险命令审批**：`approvals.mode: smart|manual|off`（默认 smart，LLM 辅助风险评估）；`approvals.timeout: 300`；无人值守场景分别有 `approvals.cron_mode`、`approvals.single_query_mode`、`approvals.unattended_mode`（webhook/API 会话），**默认均为 `deny`**。CLI 四选项：一次/本会话/永久 allowlist/拒绝；消息网关中把命令发到聊天等待 yes/no（搜索摘要称默认 60s 超时，与 security 页 300s 不一致，[待核]）。API Runs 通过 `POST /v1/runs/{id}/approval` 解决审批——这是网关侧实现"权限限制"的挂点。
2. **YOLO**：`hermes --yolo`、`/yolo`、`HERMES_YOLO_MODE=1`；不覆盖**硬编码 blocklist**（fork bomb、`rm -rf /`、块设备写）。
3. **用户自定义拒绝**：`approvals.deny: ["git push --force*", "*curl*|*sh*"]`（fnmatch，YOLO 下依然生效）。
4. **文件写保护**：`~/.ssh/ ~/.aws/ ~/.kube/ /etc/sudoers`、`auth.json/.env/mcp-tokens/`、任意 `.env*` 永久禁写；`HERMES_WRITE_SAFE_ROOT` 限定 `write_file/patch` 目录前缀。
5. **网关准入**：分层——平台 allow-all 标志 → DM pairing 批准名单 → `TELEGRAM_ALLOWED_USERS`/`DISCORD_ALLOWED_USERS`/`FEISHU_ALLOWED_USERS`/... → `GATEWAY_ALLOWED_USERS`；`GATEWAY_ALLOW_ALL_USERS=true` 全放开。DM pairing：陌生人得 8 位码，`hermes pairing approve <platform> <code>`，TTL 1h；`unauthorized_dm_behavior: pair|ignore`。
6. **沙箱**：docker 容器 drop 全部 capabilities 仅加 `DAC_OVERRIDE/CHOWN/FOWNER`、`no-new-privileges`、PID 256、tmpfs；docker/modal 后端**跳过**危险命令检查（容器即边界）。
7. **注入防护**：AGENTS.md/.cursorrules 等上下文文件注入扫描；SSRF 阻断内网/元数据地址（`security.allow_private_urls`）；Tirith 预执行扫描（`security.tirith_enabled`）；MCP 子进程环境变量白名单；日志与错误信息脱敏 (`ghp_`, `sk-`, bearer)。
8. **技能供应链**：hub 安装扫描（数据外泄/注入/破坏命令/供应链信号），`dangerous` 不可 `--force`；v0.20.4 加入 NVIDIA SkillEvaluator Tier 1 扫描；`skills.guard_agent_created` 扫描 agent 自建技能。
9. **工具面裁剪**：`agent.disabled_toolsets`、`-t/--toolsets`、每平台 toolset 配置、`GET /v1/toolsets` 可枚举。

## 扩展机制与资产

**Skills（核心资产，agentskills.io 兼容）**：`~/.hermes/skills/<category>/<name>/SKILL.md` + `references/ templates/ scripts/ examples/ assets/`。frontmatter 字段：`name, description, version, platforms, metadata.hermes.{tags, category, requires_toolsets, fallback_for_toolsets, config[]}, required_environment_variables[{name,prompt,help}]`。三级渐进披露：`skills_list()`（~3k tokens 元数据）→ `skill_view(name)` → `skill_view(name, path)`。agent 自管理工具 `skill_manage`：`create/patch/edit/delete/write_file/remove_file`，受 `skills.write_approval` 门控。**自进化触发**：复杂任务（5+ 工具调用）后创建技能；使用中发现过时/不完整/错误则 patch。评估：本次未见内置技能效果评估/回归机制，安全靠安装扫描与 `.bundled_manifest` 哈希基线（修改过的 bundled 技能不再自动更新，`hermes skills reset <name> [--restore]`）。Hub 源：`official / skills-sh / well-known / url / github / clawhub / lobehub / browse-sh`，`hermes skills tap add <owner/repo>`。

**Plugins**：`~/.hermes/plugins/<name>/{plugin.yaml, __init__.py, schemas.py, tools.py}`；manifest `name/version/description`（可选 `capabilities/requires_env/manifest_version`）；`register(ctx)` 中 `ctx.register_tool(name, toolset, schema, handler)`、`ctx.register_hook("post_tool_call", cb)`、`ctx.register_command`、`ctx.register_cli_command`。**26 个生命周期 hook**（`pre_tool_call/post_tool_call/pre_llm_call/post_llm_call/on_session_start/on_session_end/subagent_start/subagent_stop/...`）。四类插件：通用（多选）、memory provider（单选）、context engine（单选）、model provider（多注册）。默认 opt-in：`plugins.enabled` 列表；`hermes plugins install owner/repo --enable`。

**MCP**：作为 client 接 `mcp_servers`；v0.20.3 MCP 2.x SDK；v0.20.6 50+ catalog；`hermes mcp serve` 反向暴露。

**其他资产**：`SOUL.md`（人格/身份）、`~/.hermes/memories/*.md`、工作区上下文文件链 `.hermes.md → AGENTS.md → CLAUDE.md → .cursorrules`（也注入子代理）、`~/.hermes/cron/jobs.json`、profiles（`~/.hermes/profiles/<p>/`）。`hermes claw migrate` 证明与 OpenClaw 资产模型（SOUL.md、memories、skills、AGENTS.md）高度可互换。

## 记忆

来源：memory.md、memory-providers、honcho 文档（一手）。
- **内置**：`MEMORY.md`（2,200 chars≈800 tok）+ `USER.md`（1,375 chars≈500 tok），`memory` 工具动作 `add/replace(old_text)/remove`，无 read 动作；会话开始时**冻结快照**注入 system prompt（带 `[67% — 1,474/2,200 chars]` 用量标记），中途写入立即落盘但下次会话才可见（保护 prefix cache）。配置 `memory.memory_enabled / user_profile_enabled / memory_char_limit / user_char_limit / write_approval / provider`。
- **跨会话回忆**：`session_search` 工具（FTS5，四种调用形态：query 检索 / `session_id+around_message_id+window` 滚动 / 整段读取 / 浏览近期），不耗 LLM。
- **向量检索**：内置无向量库；语义检索交给外部 provider（8 个：Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory），均"附加而非替代"，`hermes memory setup`。
- **Honcho**：`memory.provider: honcho` + `HONCHO_API_KEY`；配置 `contextCadence(1)/dialecticCadence(2)/dialecticDepth(1)/recallMode(hybrid|context|tools)/sessionStrategy(per-directory|per-repo|per-session|global)`；新增 5 个工具 `honcho_profile/honcho_search/honcho_context/honcho_reasoning/honcho_conclude`；peer 身份用 `userPeerAliases`（网关运行时 id→peer 映射）与 `pinUserPeer`。这对群助手很关键：可以把"平台用户 id → 记忆主体"映射独立于会话。
- **记忆作用域解耦**：API 层 `X-Hermes-Session-Key` 与 `X-Hermes-Session-Id` 分离，允许"多 transcript 共享一个记忆域"。[推测] 但 MEMORY.md/USER.md 本身是 profile 级单文件，非按 key 分片——真正的 per-群/per-用户记忆隔离需依赖 Honcho 等 provider 或多 profile。

## 多 Agent 与协作

- **delegate_task**（一手：delegation 文档）：参数 `goal, context, max_iterations(50), role: leaf|orchestrator, tasks[]`（批量，默认并发 3）；**不接受 `toolsets`**，继承父级工具；子代理**零上下文**（仅工作区上下文文件注入，不含 SOUL.md）；子代理禁用 `delegate_task(leaf)/clarify/memory/send_message/cronjob`；配置 `delegation.{max_iterations, max_concurrent_children, max_spawn_depth(1), orchestrator_enabled, worktree_isolation, model, provider, base_url, api_key, request_overrides, child_timeout_seconds, surface_child_process_notifications}`。v0.21.0 **实时 steering**：`{"action":"list"}`、`{"action":"steer","subagent_id","message"}`、`{"action":"stop",...}`，并支持子代理输出 JSON-schema 校验。完成结果先落 `state.db` 再发布（durable）；实时日志 `~/.hermes/cache/delegation/live/<delegation_id>/task-<n>.log`。API Runs 事件流里以 `subagent.start/subagent.complete` 出现。
- **Cron**（一手：cron 文档）：`cronjob` 工具 `create/list/update/pause/resume/run/remove`，参数 `prompt, schedule, skill(s), name, deliver, workdir, reasoning_effort, no_agent, script, continuity, context_from, enabled_toolsets, repeat`；schedule 支持 `"in 30m"`、`"every 2h"`、`"weekdays at 9am"`、5 字段 cron；存储 `~/.hermes/cron/jobs.json`，输出 `~/.hermes/cron/output/{job_id}/{ts}.md`；`deliver: origin|local|telegram:123456|discord:#channel|all`；`continuity=True` 注入上次输出、`context_from` 串联上游 job（v0.20.5/0.21.0 "cron with memory"）；调度器在 **gateway 守护进程每 60s tick**，`.tick.lock` 防重叠；`approvals.cron_mode: deny` 默认。HTTP 侧对应 `/api/jobs`。
- **心跳/Heartbeat**：一手文档未见独立 "heartbeat" 特性；等价功能由 cron 周期任务 + `session_stall_timeout` 看门狗 + `reconnect_attention_after: 7200` 实现 [推测]。
- **Bot Mode / A2A / peer**（GitHub Releases）：v0.20.0 A2A v1.0 协议（发现与编排）；v0.20.3 内置 Bot Mode 插件与 "teammate protocol"；v0.21.0 Bot Mode 成为桌面端"具名 agent 社会"（群聊、@提及），`hermes peer` 跨 profile/gateway 的 agent 间 DM。这些是 Hermes 独有的 **agent team / room** 类扩展能力。
- **execute_code RPC**：agent 可写 Python 脚本通过 RPC 调工具，把多步流水线压成"零上下文成本"的一次调用（README）。

## 可观测性

- 日志：`~/.hermes/logs/`（`errors.log`、`gateway.log`，密钥脱敏；FAQ 建议 `tail ~/.hermes/logs/gateway.log`）。CLI `hermes logs [agent|errors|gateway|gui|desktop] -n -f --level --session --since --component`——按 session 与组件过滤，说明日志带结构化字段 [推测格式为 JSON lines，未确认]。`logging` 配置节含 level 与 redaction。
- **事件流（可归一化的主通道）**：
  1. API 流式事件：Chat Completions 的 `event: hermes.tool.progress`；Responses 的 `function_call/function_call_output` 项；Runs 的 `GET /v1/runs/{id}/events` SSE（token、tool 调用、生命周期、`subagent.start/complete`）；Sessions stream 的 `assistant.delta / tool.started / tool.completed / run.completed`。
  2. **Outbound webhooks**（v0.20.0；hooks 文档 + PR #69406）：配置 `name, url, events[], secret_env, timeout`；事件即 plugin hook 集合（`pre_tool_call, post_tool_call, pre_llm_call, post_llm_call, on_session_start, on_session_end, subagent_start, subagent_stop ...`）；HMAC-SHA256 签名头 `X-Hermes-Signature-256`（GitHub 风格），去重头 `X-Hermes-Delivery`。[已交叉验证 hooks 页 + PR 标题]
  3. Plugin hooks（进程内 26 个），可写一个 OTel 导出插件。
- 用量：`/usage`、`/insights`、API `usage` 字段、v0.21.0 MCP 面板的 cost/usage overlay。会话导出 `--format trace --upload` 对接 HF Agent Trace Viewer。
- **OpenTelemetry**：一手资料未见原生 OTel 导出 [未确认]。
- 健康：`GET /health`、`GET /health/detailed`（DB/模型/磁盘/网关状态）、`hermes doctor`、`hermes cron doctor/incidents`。

## 对我们架构的启示

### 接入方式选型
| 方式 | 适用 | 问题 |
|---|---|---|
| **API server `/api/sessions/*` + `X-Hermes-Session-Key`**（首选） | 群助手网关：我们生成 `agent:<profile>:<biz>:group:<group_id>[:<user_id>]` 作为 key，一群一 session、显式建/查/续；SSE 事件可归一化 | 须启动 `hermes gateway`（会连带启动 cron/其他平台），需 Bearer key；不支持文件上传 |
| `/v1/responses` + `conversation` 名 | 轻量多轮 | 仅 100 条 LRU 存储，不可靠 |
| `/v1/runs` + `/approval` + `/steer` + `/events` | 长任务、需要审批闸门与中途纠偏 | 事件缓冲 5 分钟 |
| CLI `hermes -z/-Q -q --resume <id> -p <profile>` | 批处理/评测 | 每次拉起进程；`single_query_mode: deny` |
| ACP `hermes acp` | IDE | 进程内会话，不持久，工具面裁剪 |
| Python `run_agent.AIAgent` | 深度嵌入 | 无稳定 API 契约 |
| 让 Hermes 自己接 Telegram/飞书 | 最省事 | 绕过我们的网关，失去统一权限/观测 |

### 公共能力 vs Hermes 扩展能力
| 能力 | 归属 | Hermes 映射 / 接入参数 |
|---|---|---|
| 创建/续接/重置会话 | 公共 | `POST /api/sessions`、`X-Hermes-Session-Id/Key`、`/new`；`session_reset.*` |
| 会话隔离粒度 | 公共（参数化） | `group_sessions_per_user`，或由网关直接编码 key |
| 同步/流式对话 | 公共 | `/api/sessions/{id}/chat[/stream]`、`/v1/chat/completions` |
| 模型/推理强度选择 | 公共 | `model, provider, model_options.reasoning_effort` |
| 工具面裁剪 | 公共 | `agent.disabled_toolsets`, `-t`, `GET /v1/toolsets` |
| 审批/危险命令 | 公共（语义各引擎不同） | `approvals.mode/timeout/unattended_mode/deny[]`，`POST /v1/runs/{id}/approval` |
| 执行沙箱 | 公共（参数化） | `terminal.backend` 及 docker_* 字段 |
| 事件/观测 | 公共 | SSE 事件名、webhooks `events[]` + `X-Hermes-Signature-256` |
| 记忆（用户画像/事实） | 公共抽象，实现独有 | `memory.*`, `MEMORY.md/USER.md`, provider=honcho（`sessionStrategy`, `userPeerAliases`） |
| 技能/资产 | 公共（agentskills.io 标准） | `~/.hermes/skills`, `hermes skills install`, `GET /v1/skills` |
| **自进化技能**（自动创建/自我修补） | **Hermes 扩展** | `skills.write_approval`, `skills.guard_agent_created` |
| **子代理/orchestrator/steering** | 扩展（部分引擎有） | `delegation.*`、`delegate_task` 动作 |
| **Cron with memory / Jobs API** | 扩展 | `/api/jobs`, `continuity`, `context_from`, `deliver` |
| **Bot Mode / A2A / hermes peer / room** | 扩展 | 桌面端与 gateway 特性，API 暴露程度未知 |
| **多平台原生投递** (`send_message`) | 扩展 | 我们的网关若自管投递需禁用相关 toolset |
| **execute_code RPC 批处理** | 扩展 | 默认启用 |
| 能力发现 | 公共 | `GET /v1/capabilities` 返回 `features{}` —— 可直接喂给我们的"能力识别→适配→认证"流程 |

### 风险与坑
1. **双网关叠层**：Hermes gateway 自带路由、准入、cron；我们的网关必须成为唯一入口——关闭其他平台适配器、`approvals.unattended_mode` 明确策略、禁用 `send_message/cronjob` toolset 或接受 Hermes 自行投递。
2. **记忆隔离并非天然按业务分片**：MEMORY.md/USER.md 是 profile 全局；多租户群助手要么每租户一个 profile（`-p`，独立 `~/.hermes/profiles/<p>/`，各自 gateway 与端口），要么依赖 Honcho `userPeerAliases`。
3. **版本演进极快**（8 月一个月 7 个版本，v0.21.0 5,800 commits），端点/字段可能变动；应以 `GET /v1/capabilities` 与 `/health/detailed` 做运行时协商，并锁定版本 tag。
4. 无人值守默认 `deny` 审批：网关需实现审批中继（把 Runs 的 approval 事件转到群里 → `POST /approval`），否则危险命令静默失败。
5. 文件上传不支持：附件需先落到共享文件系统/对象存储再以路径传入。
6. `direct_model_requests` 默认关闭时，仅传 `model` 会被忽略，必须同时传 `provider`。
7. 并发上限 `max_concurrent_runs: 10` 与 `agent_cache.max_size: 128` 需按群数量调优。

## 未解决问题
1. `/api/sessions/*` 与 `gateway_routing` 的精确关系：通过 API 创建的 session 是否能被同 key 的消息平台会话复用？（文档暗示 `X-Hermes-Session-Key` 可实现，未实测）
2. Outbound webhook payload 的完整 schema、重试策略；是否包含 token 用量。
3. 是否有原生 OpenTelemetry 导出；`hermes logs` 的底层日志格式（JSONL?）。
4. Bot Mode / A2A / `hermes peer` 是否有 HTTP/协议级接口可被外部网关调用，还是仅桌面端体验。
5. 审批超时默认值（security 页 300s vs 搜索摘要 60s）需在源码确认。
6. 群聊"整群共享会话"下多用户并发写同一 session 的锁语义（`gateway_turn_lease_timeout` 后的行为：排队还是丢弃）。
7. 技能自进化的质量评估机制（是否有回归/评分），目前只见安全扫描。

## 来源列表
1. https://github.com/NousResearch/hermes-agent （README, raw）
2. https://github.com/NousResearch/hermes-agent/releases （v0.19.1–v0.21.0 发布说明）
3. https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md
4. https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md
5. https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md
6. https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md
7. https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/delegation.md
8. https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/plugins.md
9. https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/index.md
10. https://hermes-agent.nousresearch.com/docs/user-guide/configuration
11. https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
12. https://hermes-agent.nousresearch.com/docs/user-guide/security
13. https://hermes-agent.nousresearch.com/docs/user-guide/features/honcho
14. https://hermes-agent.nousresearch.com/docs/user-guide/features/acp
15. https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
16. https://hermes-agent.nousresearch.com/docs/reference/cli-commands
17. https://hermes-agent.nousresearch.com/docs/reference/faq
18. https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks （经搜索摘要，含 outbound webhooks）
19. https://github.com/NousResearch/hermes-agent/pull/69406 （outbound webhooks PR，经搜索摘要）
20. https://github.com/NousResearch/hermes-agent/issues/569 （ACP feature issue，经搜索摘要）
21. https://deepwiki.com/NousResearch/hermes-agent
22. https://honcho.dev/docs/v3/guides/integrations/hermes （经搜索摘要）
