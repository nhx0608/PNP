# T11 OpenClaw（openclaw/openclaw）网关架构深度调研

> 调研日期：2026-09-04。所有事实均标注来源；"已确认"=一手来源（官方文档/仓库），"推测"=基于一手资料的合理推断。

## 摘要

OpenClaw（MIT，2026.8.1，日期式版本）是一个单进程 Node.js 的"个人 AI 助手网关"：一个 Gateway 进程同时承担多渠道消息接入、会话路由/存储、内置 agent runtime、Control UI、WebSocket RPC（默认端口 18789，JSON `req/res/event` 帧，协议 v4，operator/node/worker 三角色 + scope 闭集）、可选 OpenAI 兼容 HTTP（`/v1/chat/completions`、`/v1/responses`，同端口复用，默认关闭）以及 cron/heartbeat/webhook 自动化。会话以字符串 key 标识（`agent:<id>:main`、`agent:<id>:<channel>:group:<gid>`、`...:subagent:<uuid>`、`...:acp:<uuid>`），隔离粒度由 `session.dmScope`/`groupScope`/`identityLinks` 与 `bindings` 控制；群聊默认 mention gating；进程内 lanes + `steer/followup/collect/interrupt` 排队；SQLite（database-first）+ 归档 transcript；`daily/idle` reset 与 maintenance 剪枝。多 agent 通过 `agents.entries` + `bindings`（most-specific wins）路由，`sessions_send/spawn` 实现 agent 间通信与子代理。**最关键发现**：OpenClaw 自身已是"网关 + harness 注册表"结构——内置 runtime id `openclaw`（源于 pi，2026.8 已内化为 `@openclaw/agent-core`，"no external agent framework packages remain"，`pi` 仅为别名）、插件 harness（`codex`）、以及 `@openclaw/acpx` 驱动的 ACP 外部 harness（Claude Code、Codex、Gemini CLI、opencode、cursor、copilot、droid、pi 等），通过 `agentRuntime.id` / `agents.entries.<id>.runtime.type:"acp"` 选择。权限分层为 dmPolicy → tool policy（profile/allow/deny/elevated，可到群与发送者级）→ Docker sandbox（不包裹 ACP harness），官方定位"一 Gateway 一信任域"，不适合敌对多租户；2026 年发生 CSWSH RCE（CVE-2026-25253）、pairing 提权（CVE-2026-32922）与 ClawHub 供应链（824+ 恶意 skills）事件。可观测通过 `diagnostics-otel` 插件输出 OTLP（GenAI 语义约定、`harness.run.*` 事件、`traceparent` 透传）。对我们的架构：可直接借鉴其 session key 语法、bindings 优先级、queue 模式、ACP 作为"引擎接入协议"、OTel 归一化；赛题方案 3 的最低改造点是给 acpx 注册一个新 harness id，更深的是在 `src/agents/harness/` 实现插件 harness。

## 关键事实

| 事实 | 来源 | 置信度 | 交叉验证 |
|---|---|---|---|
| Gateway 默认端口 18789，WS + HTTP 同端口复用 | README；gateway/configuration；openai-http-api | 高 | 是（README + 两份 docs） |
| WS 帧 `{type:"req"|"res"|"event"}`，协议 v4，`connect` 带 role/scopes/auth/device，`hello-ok` 返回 features/policy | gateway/protocol | 高 | 是（protocol 页 + `@openclaw/gateway-protocol` 包含 schema） |
| 协议/客户端 npm 包 `@openclaw/gateway-protocol`、`@openclaw/gateway-client`，稳定版 2026.8.1 | gateway/protocol；package.json | 高 | 是 |
| OpenAI 兼容端点默认关闭；`gateway.http.endpoints.chatCompletions.enabled`；头 `x-openclaw-agent-id/-session-key/-model`，`model:"openclaw/<agentId>"`，SSE | docs 站 + raw docs/gateway/openai-http-api.md | 高 | 是 |
| Gateway token = 完整 operator 权限（`operator.admin` 等），非 per-user | openai-http-api | 高 | 否 |
| session key：`agent:<id>:main` / `agent:<id>:<channel>:group:<gid>` / `thread:<rootTs>` / `hook:<hookId>` / `subagent:<uuid>` / `acp:<uuid>` | concepts/session；channels/groups；multi-agent；acp-agents | 高 | 是（4 页） |
| `session.dmScope`: main(默认)/per-peer/per-channel-peer(推荐)/per-account-channel-peer；`groupScope`: per-group(默认)/main | concepts/session | 高 | 是（WebSearch 摘要 + 页面） |
| Reset：`session.reset{mode:none|daily|idle, atHour, idleMinutes}`，`resetByType/resetByChannel`，先到先生效；`/new` `/reset` | concepts/session | 高 | 是 |
| 会话存储：`~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite`（database-first）+ `sessions/` 归档，旧版 `sessions.json` | concepts/session；openclaw-agent-runtime.md | 高 | 是 |
| Queue：`messages.queue.mode` steer(默认)/followup/collect/interrupt，`cap:20`，`drop:summarize|old|new`；lanes main/session/cron/subagent(8)/background(3) | concepts/queue | 高 | 否 |
| 群聊默认 requireMention；`groupPolicy` open/allowlist/disabled；`mentionPatterns`；群级 `tools.deny` + `toolsBySender` | channels/groups | 高 | 否 |
| bindings 优先级：peer > 父 peer > peer 通配 > guild+roles > guild/team > account > channel > 默认 | concepts/multi-agent | 高 | 否 |
| 工具 `sessions_send/sessions_spawn/sessions_history/sessions_list/session_status`；`tools.agentToAgent{enabled,allow}`；`subagents{maxConcurrent:4, runTimeoutSeconds:300, maxSpawnDepth:3}` | concepts/multi-agent | 高 | 是（acp-agents 页复述 sessions_spawn 与 runTimeoutSeconds） |
| ACP 插件 `@openclaw/acpx`；harness id：claude/codex/copilot/cursor/droid/gemini/opencode/fast-agent/…/openclaw/pi；`agents.entries.<id>.runtime{type:"acp", acp{agent,backend,mode,cwd}}`；`acp{enabled,dispatch,allowedAgents,defaultAgent,backend}` | tools/acp-agents | 高 | 是（CHANGELOG 多处 ACPX 条目） |
| OpenClaw sandbox 不包裹 ACP harness；沙箱会话不能 spawn ACP | tools/acp-agents | 高 | 否 |
| 内置 runtime id `openclaw`，`pi` 为 legacy alias；插件 harness 注册 runtime id（如 `codex`）；`agentRuntime.id` 按 model/provider 选择，`auto` 优先插件 harness | docs/agent-runtime-architecture.md | 高 | 是（package.json 无 pi 运行时依赖；`src/agents/pi-embedded*` 404） |
| "no external agent framework packages remain"；仅剩 `@earendil-works/pi-tui@0.84.3` | agent-runtime-architecture.md；package.json | 高 | 是 |
| 早期（2026-01）以嵌入 `@mariozechner/pi-agent-core`/`pi-ai` 的 `createAgentSession()` 运行 | lucumr.pocoo.org；dabit3 gist | 中（二手） | 是（两篇独立分析） |
| 权限：`dmPolicy` pairing(默认)/allowlist/open/disabled；`tools.profile/allow/deny/elevated`；`sandbox{mode off|non-main|all, scope, workspaceAccess}` | gateway/security；multi-agent | 高 | 是 |
| 配置 `~/.openclaw/openclaw.json`（JSON5），严格 schema，未知 key 拒绝启动；hot reload `hybrid`；`${ENV}` 与 SecretRef | gateway/configuration | 高 | 否 |
| 模型引用 `provider/model`，`agents.defaults.model{primary,fallbacks}`，`models.providers.<name>{baseUrl,apiKey}` | gateway/configuration | 高 | 否 |
| OTel：`clawhub:@openclaw/diagnostics-otel`，`diagnostics.otel{endpoint, protocol:"http/protobuf", traces, metrics, logs, captureContent}`；指标 `openclaw.tokens`、`gen_ai.client.token.usage`；事件 `harness.run.*` | gateway/opentelemetry | 高 | 是（CHANGELOG OTel 条目） |
| Plugin API：`definePluginEntry` + `api.registerTool/Hook/Channel/Provider/GatewayMethod/HttpRoute/Memory/ContextEngine`；hooks `before_agent_start/agent_end/before_tool_call/after_tool_call/message_received/message_sending/session_start/session_end` | plugins/building-plugins | 高 | 否 |
| SKILL.md frontmatter `metadata.openclaw.requires.{bins,env,config}`、`primaryEnv`、`install`；`openclaw skills install @owner/slug`、`skills verify` | skills | 高 | 否 |
| 记忆：`USER.md/MEMORY.md/memory/YYYY-MM-DD.md/DREAMS.md`；`memory_search`(hybrid)/`memory_get`；SQLite 内置，后端 builtin/Honcho/LanceDB；compaction 前 memoryFlush | concepts/memory | 高 | 否 |
| 渠道：核心 WhatsApp/Telegram/Slack/Discord/Google Chat/Signal/iMessage；插件 Mattermost/Teams/LINE/Zalo/微信(腾讯官方)/企微/飞书(飞书官方)/钉钉/QQ(社区) | README；docs.json；larksuite/openclaw-lark；openclaw-china | 高/中 | 是 |
| Node 要求 22.22.3+/24.15+/25.9+；MIT | README；package.json | 高 | 是 |
| 2026 安全事件：CVE-2026-25253（CSWSH RCE，8.8，修复于 2026.1.29）、CVE-2026-32922（9.9，pairing 提权）、ClawHavoc 341→824+ 恶意 skills | adversa/armosec/clawtrust | 中（二手） | 是（多家独立安全厂商） |
| 规模：2026-04 报道 355K stars、1,200+ 贡献者；2026.8.1 于 2026-08-31 发布 | medium/wikipedia/tech-insider | 中（二手） | 是（两处） |

## 架构与工作原理

**定位**（已确认，https://docs.openclaw.ai/gateway/protocol）：OpenClaw 是一个"个人 AI 助手/网关"型系统，核心是单进程 Node.js 的 **Gateway**（控制平面），它同时承担：多渠道消息接入（channels）、会话路由与存储（sessions）、内嵌 agent runtime（Agent loop + tools）、Control UI（浏览器端）、WebSocket RPC 服务、以及 cron/heartbeat 等后台任务。CLI（`openclaw ...`）、Control UI、macOS/iOS/Android 节点、以及第三方客户端都通过同一 WebSocket 协议与 Gateway 通信。

**WebSocket 协议（已确认，一手来源 gateway/protocol）**：
- 帧格式：`{type:"req", id, method, params, traceparent?}` / `{type:"res", id, ok, payload|error}` / `{type:"event", event, payload, seq?, stateVersion?}`；错误体 `{code, message, details?, retryable?, retryAfterMs?}`；`traceparent` 接受 W3C trace context（≤128 字符），用于跨 RPC 的可观测串联。
- 握手：Gateway 先发 `connect.challenge` 事件（`{nonce, ts}`），客户端发 `connect` 请求：`params:{minProtocol:4, maxProtocol:4, client:{id,version,platform,mode}, role:"operator"|"node"|"worker", scopes:[...], caps:[...], auth:{token}, device:{id,publicKey,signature,signedAt,nonce}}`；服务端返回 `hello-ok`：`{protocol, server:{version,connId}, features:{methods,events}, auth:{role,scopes,deviceToken?}, policy:{maxPayload(默认26MB), maxBufferedBytes(默认50MB), tickIntervalMs, attachments}}`。
- 角色与 scope：`operator`（CLI/UI 控制面）、`node`（能力宿主，如 camera/screen）、`worker`（云执行，闭合协议）；operator scope 闭集：`operator.read/write/admin/approvals/questions/pairing/talk/talk.secrets`；鉴权失败返回 `{code:"FORBIDDEN", details:{code:"MISSING_SCOPE", missingScope, requiredScopes}}`。
- 核心方法族：`health/status/diagnostics.stability/gateway.identity.get`；`sessions.list/subscribe/create/describe/send/patch/dispatch/reclaim/move`；`chat.send(sessionKey, queueMode, fastMode)/chat.abort/chat.history/chat.message.get`；`config.get/set/patch/schema`；`agents.list/create/update/workspace.*`；`node.list/describe/invoke/pair.*`；`plugins.list/install/setEnabled`；`device.pair.*`；`models.list/usage.status/approval.history/cron.list/skills.status/terminal.open`；`talk.*/tts.speak`。
- 事件族：`chat`、`session.message/session.operation/session.tool`、`sessions.changed`、`presence`、`tick`、`node.pair.requested/resolved`、`config.changed`、`skills.changed`；事件按 scope 门控（chat/agent 事件需 `operator.read`）。
- 协议以 npm 包发布：`@openclaw/gateway-protocol`（schema/validators/types，附 `protocol.schema.json`）与 `@openclaw/gateway-client`（Node + 浏览器参考客户端）；文档标注稳定版 **2026.8.1**。
- 传输限制：认证前帧 64KiB；附件 `maxImageBytes` 6MB / `maxBytes` 20MB。

## 会话模型

**session key 规则**（已确认，https://docs.openclaw.ai/concepts/session 与 https://docs.openclaw.ai/channels/groups）[已交叉验证：两页均给出 `agent:<agentId>:...` 前缀与 main/group 形态]：
- 主会话：`agent:<agentId>:main`（默认所有 DM 汇入）。
- 群/房间：`agent:<agentId>:<channel>:group:<id>`（channels/groups 页），concepts/session 页给出简化形态 `agent:<id>:group:<groupId>`；线程：`agent:<id>:thread:<rootTs>`；webhook：`agent:<id>:hook:<hookId>`；cron：每次运行新会话；子代理：`agent:<requestingAgentId>:subagent:<uuid>`；ACP 外部 harness：`agent:<agentId>:acp:<uuid>`；`incognito-` 前缀保留给纯内存临时会话。
- DM 隔离 `session.dmScope`：`main`（默认，所有 DM 共享主会话）| `per-peer`（按发送者跨渠道隔离）| `per-channel-peer`（按渠道+发送者，官方"推荐"）| `per-account-channel-peer`（按账号+渠道+发送者）。官方安全提示："If multiple people can message your agent, enable DM isolation."
- 群隔离 `session.groupScope`：`per-group`（默认，每个群独立会话）| `main`（并入主会话）。可在 `bindings[].session.groupScope` 对单个群覆盖。
- 跨渠道身份合并：`session.identityLinks` 把多个渠道身份映射到一个 canonical peer id，从而共享会话。

**群聊 mention gating**（已确认，channels/groups）：群消息默认需要 @mention（`channels.<ch>.groups["*"].requireMention: true`，可对具体群设 `false`）；未被提及的消息只"存入上下文，不触发回复"。正则补充：`messages.groupChat.mentionPatterns: ["\\bopenclaw\\b"]`，并可按渠道 `mentionPatterns:{mode:"allow", denyIn:[...]}`。群策略 `groupPolicy`：`open`（绕过 allowlist，但仍 mention gating）| `allowlist` | `disabled`。群主可用 `/activation mention|always` 切换（受 `commands.ownerAllowFrom` 限制）。群级工具限制：`channels.telegram.groups["-100..."].tools.deny:["exec"]`，并支持 `toolsBySender:{"id:123":{alsoAllow:["exec"]}}`；解析顺序 sender → group → defaults。

**并发与排队（queue/lanes）**（已确认，https://docs.openclaw.ai/concepts/queue）：进程内队列串行化各渠道的自动回复。Lanes：`main`（并发由 `agents.defaults.maxConcurrent` 控制，默认 `min(16, max(8, CPU并行度))`）、`session:<key>`（每会话同一时刻只允许一个 agent run）、`cron`、`cron-nested`、`subagent`（默认并发 8）、`nested`、`background`（3 并发）。队列模式 `messages.queue.mode`：`steer`（默认，把新消息注入运行中的 turn）| `followup`（排队到下一轮）| `collect`（合并多条为一次 followup）| `interrupt`（中止当前 run 执行最新消息）；参数 `cap:20`、`drop:"summarize"|"old"|"new"`、`byChannel:{discord:"collect"}`、`debounceMsByChannel:{discord:1000}`；会话级 `/queue collect debounce:0.5s cap:25`。优先级：会话 `/queue` 覆盖 > `byChannel` > `mode` > steer。

**存储格式与 reset/expiry**（已确认，concepts/session）：2026.8 起为"database-first"——运行态存 `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`（含 `sessionStartedAt`/`lastInteractionAt`/`updatedAt`），归档 transcript 放 `~/.openclaw/agents/<agentId>/sessions/`，旧版为 `sessions/sessions.json` + JSONL transcript。Reset：`session.reset:{mode:"none"|"daily"|"idle", atHour, idleMinutes}`，可按类型 `resetByType:{group:{mode:"idle",idleMinutes:120}, thread:{...}}` 和按渠道 `resetByChannel:{discord:{...}}`；daily 与 idle 同时配置时"先到先生效"；聊天内 `/new` `/reset` 手动重置，`/new <model>` 顺带换模型。维护：`session.maintenance:{mode:"enforce", pruneAfter:"30d", archiveDashboardAfter:"7d", maxEntries:500, preserveRecent:"7d"}`。

**Compaction**（已确认，docs 站有 `/concepts/compaction` 与 `/concepts/context-engine` 页；细节未逐页抓取）：上下文接近窗口时自动摘要压缩，`/compact` 手动触发；memory flush 在 compaction 前把要点写入记忆文件（详见"记忆"节）。`/status` 显示上下文占用、模型与开关，`/context list` 显示系统提示内容。

## 多 Agent 与协作

**多 agent 配置与路由**（已确认，https://docs.openclaw.ai/concepts/multi-agent）：`agents.entries.<id>`（旧写法 `agents.list[]`）每个 agent 有独立 `workspace`（`~/.openclaw/workspace-<id>`，含 `SOUL.md`/`AGENTS.md` 等人格与指令文件）、`agentDir`（`~/.openclaw/agents/<id>/agent`，含 auth、模型注册、SQLite 会话库）、`model`、`tools.allow/deny`、`sandbox`、`default:true`。`agents.defaults` 为公共基线。

**bindings 路由**（已确认）：`bindings[]{agentId, match:{channel, accountId, peer:{kind:"direct"|"group"|"channel", id}, guildId, teamId, roles}}`，"most-specific wins"，优先级：精确 peer > 父 peer（群）> peer 通配 > guild+roles > guild/team > account > channel > 默认 agent；同级按配置顺序；多字段为 AND。

**agent 间通信**（已确认）：工具 `sessions_list`、`sessions_history`（跨会话有界、脱敏回读，去掉 thinking 与 tool XML）、`sessions_send`（向其他 agent/会话发消息）、`sessions_spawn`（生成子代理或 ACP 会话）、`session_status`。跨 agent 访问由 `tools.agentToAgent:{enabled:true, allow:["a","b"]}` 门控；官方建议"硬边界用独立 Gateway"。子代理：`agents.defaults.subagents:{maxConcurrent:4, runTimeoutSeconds:300, maxSpawnDepth:3}`，运行在 `subagent` lane，会话键 `agent:<parent>:subagent:<uuid>`，`/subagents ...` 管理。

**ACP agents：把外部 harness 作为后端**（已确认，https://docs.openclaw.ai/tools/acp-agents）——这是本题最重要的"多引擎"事实：
- 官方插件 `@openclaw/acpx`（`openclaw plugins install @openclaw/acpx` + `plugins.entries.acpx.enabled=true`；若设置了 `plugins.allow` 需包含 `acpx`）通过 **Agent Client Protocol (ACP)** 驱动外部 coding harness。支持的 harness ID：`claude`（Claude Code ACP adapter）、`codex`、`copilot`、`cursor`（`cursor-agent acp`）、`droid`、`gemini`（Gemini CLI）、`opencode`、`fast-agent`、`iflow`/`kilocode`/`kimi`/`kiro`/`mux`/`qoder`/`qwen`/`trae`、`openclaw`（通过 `openclaw acp` 把 Gateway 自身暴露为 ACP server 的桥接）、`pi`（pi-acp）。
- 全局配置：`acp:{enabled, dispatch:{enabled}, allowedAgents:[...], defaultAgent, backend:"acpx"}`。
- agent 级：`agents.entries.<id>.runtime:{type:"acp", acp:{agent:"codex", backend:"acpx", mode:"persistent"|"oneshot", cwd}}`。
- 渠道级持久绑定：`bindings[]{type:"acp", agentId, match:{channel, accountId, peer}, acp:{label, cwd, mode, backend}}`；覆盖优先级 `bindings[].acp.*` > `agents.entries.*.runtime.acp.*` > 全局 acp 默认。
- 触发方式：工具 `sessions_spawn({runtime:"acp", agentId, mode:"run"|"session", thread, cwd, label, resumeSessionId, streamTo:"parent", model, thinking})`；聊天命令 `/acp spawn codex --mode persistent --thread auto|--bind here --cwd ... --label ...`，以及 `/acp cancel|steer|close|status|set-mode|set|cwd|permissions|timeout|model|reset-options|sessions|doctor|install`。
- 运行时选项映射（能力协商的雏形）：`/acp model` → `model`；`/acp set thinking` → `thinking|effort|reasoning_effort|thought_level`；`/acp permissions` → `permissionProfile|approval_policy|permission_mode`；`/acp timeout` → `timeoutSeconds|timeout|timeout_seconds`——按后端"广告"的控制项动态映射。
- 边界与限制：**OpenClaw 的 sandbox 策略不包裹 ACP harness 执行**（harness 以自身 CLI 权限 + `cwd` 运行）；被沙箱化的请求者会话不能 spawn ACP；`runtime:"acp"` 不支持 `sandbox:"require"`；OpenClaw 把内部上下文标记转成纯文本 prompt 再发给 harness；harness 的结构化输入请求（含 secret）以临时 Gateway question 形式呈现。
- 明确区分：**原生 Codex 路径**（`/codex` 命令，嵌入式 `openai/gpt-*` runtime）与 **ACP 外部 harness 路径**（`/acp`）。

**内置 agent runtime 与 harness 注册表（对赛题方案 3 最关键）**（已确认，https://raw.githubusercontent.com/openclaw/openclaw/main/docs/agent-runtime-architecture.md，2026.8.1 主干）：
- 代码布局：`packages/agent-core/`（`@openclaw/agent-core`：agent loop、**harness types**、messages、compaction、prompt templates、skills、session storage contracts）；`src/agents/embedded-agent-runner/`（内置 attempt loop `run.ts`、模型选择/provider 归一化、`extra-params.*`、compaction、transcript/session 接线）；`src/agents/sessions/`（`session-manager.ts` 持久化、资源发现、in-session extensions）；`src/agents/runtime/`（把 `@openclaw/agent-core` 接到 plugin-sdk LLM runtime 的 facade）；`src/agents/agent-tools*.ts`（工具定义、tool policy、before/after tool-call 适配）；`src/agents/agent-hooks/`（compaction safeguard、context pruning）；**`src/agents/harness/`：Harness registry, selection policy, and lifecycle for the built-in and plugin-registered harnesses**；`src/llm/` 为模型/provider 传输层。
- Runtime 选择规则（原文）："The built-in runtime id is `openclaw`. The legacy alias `pi` normalizes to `openclaw`; `codex-app-server` normalizes to `codex`." "Plugin harnesses register additional runtime ids (for example `codex`)." 运行时策略是按 model/provider 作用域的 **`agentRuntime.id`** 配置（model 条目优先于 provider 条目），未设或 `default` 解析为 `auto`；`auto` 选择"支持当前 provider 路由的已注册插件 harness，否则回落到内置 OpenClaw runtime"；仅 provider/model 前缀永远不会隐式选中 harness（OpenAI 官方 Responses 路由的 `codex` 隐式选择为唯一例外）。
- 因此 OpenClaw 当前"支持的引擎"分三层：(1) **内置 `openclaw` runtime**（源自 pi 的嵌入式 loop，已内化）；(2) **插件 harness**（同进程、注册 runtime id，如 `codex` = Codex app-server 协议，见 docs `/plugins/codex-supervision`、`/specs/claw-supervisor`）；(3) **ACP 外部 harness**（`@openclaw/acpx` 插件驱动的 Claude Code / Gemini CLI / opencode / cursor / copilot / droid / pi-acp 等子进程，`runtime.type:"acp"`）。

## 可编程接入面

汇总（均已确认）：

| 接入面 | 形态 | 关键参数/字段 | 来源 |
|---|---|---|---|
| WebSocket RPC | `ws://127.0.0.1:18789`，JSON 帧 `req/res/event`，protocol v4 | `connect{role,scopes,auth.token,device}`；`chat.send{sessionKey,queueMode,fastMode}`；`sessions.*`；`agents.*`；`config.*`；`plugins.*`；事件 `chat/session.*/sessions.changed/presence/tick` | gateway/protocol |
| 客户端 SDK | npm `@openclaw/gateway-client`（Node+browser），`@openclaw/gateway-protocol`（schema/types，`protocol.schema.json`） | 类型 `HelloOkSchema`、`SessionsListResult`、`AuditActivityEventV1` | gateway/protocol |
| OpenAI 兼容 HTTP | 同端口复用；默认关闭，`gateway.http.endpoints.chatCompletions.enabled:true`、`responses.enabled:true` | `POST /v1/chat/completions`、`GET /v1/models`、`/v1/models/{id}`、`POST /v1/embeddings`、`POST /v1/responses`；`Authorization: Bearer <gateway token>`；`model:"openclaw/<agentId>"`（或 `agent:<agentId>`）；头 `x-openclaw-agent-id`、`x-openclaw-session-key`、`x-openclaw-model`（需 `operator.admin`）、`x-openclaw-scopes`；`user` 字段派生稳定 session key；`stream:true` → SSE，`data: [DONE]` 结尾；限制 20MB body、≤8 `image_url` | gateway/openai-http-api [已交叉验证：docs 站与 raw docs/gateway/openai-http-api.md] |
| Admin HTTP RPC | 插件 `admin-http-rpc`，`POST /api/v1/admin/rpc`，body `{id,method,params}`，响应 `{id,ok,payload|error}`，1MB | 方法子集：`commands.list/health/status/logs.tail/config.*/agents/approvals/cron/...` | gateway/admin-http-rpc |
| Webhooks/自动化 | docs `/automation/webhook`、`/automation/cron-jobs`、`/gateway/heartbeat`；会话键 `agent:<id>:hook:<hookId>` | `hooks.*`（未逐页抓取，推测字段 `hooks.enabled/token`） | docs.json 索引 |
| CLI | `openclaw gateway`、`openclaw agent`（与 HTTP 走同一 codepath）、`openclaw sessions --json`、`openclaw status`、`openclaw config set <path> <value>`、`openclaw plugins install <pkg>`、`openclaw skills install @owner/slug`、`openclaw security audit [--fix|--deep]`、`openclaw doctor --fix`、`openclaw acp`（把 Gateway 会话暴露为 ACP server） | — | 多页 |
| ACP（作为 server） | `openclaw acp` 让 IDE/客户端经 stdio/WebSocket 以 ACP 驱动 Gateway | — | tools/acp-agents |
| Plugin SDK | `openclaw/plugin-sdk/*` barrels（`plugin-entry`、`runtime-store`…） | `definePluginEntry`/`defineChannelPluginEntry`，`api.register*` | plugins/building-plugins |

**安全边界提示**（官方原文）：OpenAI 兼容端点应视为"full operator access"——持有 gateway token 等同 owner/operator 凭证，非 per-user 窄权限；因此若作为业务网关下游，**必须在我们自己的网关层做租户/用户鉴权**，OpenClaw 端只放在 loopback/tailnet/私网。

**部署**：单进程 Node（要求 Node 22.22.3+/24.15+/25.9+，package.json `engines` [已交叉验证 README + package.json]）；官方安装脚本 `curl -fsSL https://openclaw.ai/install.sh | bash` 或 `npm i -g openclaw@latest`；docs 提供 Docker/Podman/Nix/Fly/Railway/Render/GCP/Azure/Hetzner/DigitalOcean/Raspberry Pi 等部署页；`gateway.bind` 默认 loopback，远程接入建议 Tailscale/trusted-proxy。

## 权限与安全

**分层模型**（已确认，https://docs.openclaw.ai/gateway/security）：官方明确"One trust boundary per gateway"，**不适合互不信任的多租户**，敌对用户需独立 Gateway 实例。
1. **DM policy**（第一道）：`dmPolicy: "pairing"`（默认，陌生人收到过期配对码，需 owner 批准）| `allowlist` | `open` | `disabled`。
2. **Tool policy**（第二道）：`tools.profile:"minimal"|"messaging"|"coding"|"full"`、`tools.allow/deny`、`tools.elevated:{enabled}`；可在 agent 级 `agents.entries.<id>.tools`、群级 `channels.<ch>.groups.<id>.tools`、发送者级 `toolsBySender` 逐层收紧（"both must permit"）。exec 审批：`tools.exec.*` + operator scope `operator.approvals`、RPC `approval.history`、docs `/refactor/operator-approvals`（推测字段名，未逐页抓取）。
3. **Sandbox**（第三道，可选）：`agents.defaults.sandbox:{mode:"off"|"non-main"|"all", scope:"session"|"agent"|"shared", workspaceAccess:"none"|"ro"|"rw", docker:{setupCommand,...}}`，Docker 容器执行工具；per-agent 覆盖。**注意 ACP 外部 harness 不受 sandbox 包裹**。
4. **Gateway 鉴权**：`gateway.auth.mode:"token"|"password"|"trusted-proxy"|"none"`；token 来自 `gateway.auth.token` 或 `OPENCLAW_GATEWAY_TOKEN`；设备配对 `device.pair.*` + 公钥签名；operator scope 闭集；`plugins.allow` 插件白名单；`openclaw security audit --fix` 修复文件权限（600/700）。
5. **Secrets**：配置支持 `${ENV}` 替换与结构化 SecretRef `{source:"env"|"file"|"exec"|"store", provider, id}`。

**已知安全事件（2026）**（来源为第三方安全博客，属二手，置信度中）：
- CVE-2026-25253（CVSS 8.8）：Cross-Site WebSocket Hijacking → 一键 RCE，2026-01-30 于 2026.1.29 修复（depthfirst / Mav Levin）。https://adversa.ai/blog/openclaw-security-101-vulnerabilities-hardening-2026/
- CVE-2026-32922（CVSS 9.9，2026-03-29 披露）：单次 API 调用把 pairing token 提升为完整管理员+RCE。https://www.armosec.io/blog/cve-2026-32922-openclaw-privilege-escalation-cloud-security/
- ClawHub 供应链攻击 "ClawHavoc"：Koi Security 扫描 2,857 个 skills 发现 341 个恶意（335 个同一团伙，投放 AMOS 信息窃取器）；至 2026-02-16 在 10,700+ skills 中确认 824+ 恶意。https://clawtrust.ai/blog/openclaw-security-341-malicious-skills-and-what-we-do-about-it
- 部分博客称 2026 年累计 100+ CVE（"138 CVEs"，https://www.betterclaw.io/blog/openclaw-security-2026），未经一手核实。
- 官方响应可见于 CHANGELOG：2026.8.x 加入插件自动审批、SecretRefs、ClawHub skill provenance 保留、`openclaw skills verify`（trust envelope）等。

## 扩展机制与资产

**Plugins**（已确认，https://docs.openclaw.ai/plugins/building-plugins）：
- 清单 `openclaw.plugin.json`：`id, name, description, contracts(tools | agentToolResultMiddleware | trustedToolPolicies ...), activation{onStartup}, configSchema, toolMetadata{optional, profiles}`；清单使发现无需预加载代码。
- 入口：`definePluginEntry`（`openclaw/plugin-sdk/plugin-entry`）/ `defineChannelPluginEntry`；注册 API：`api.registerTool`、`api.registerHook`、`api.registerChannel`、`api.registerProvider`（model/media/search/speech）、`api.registerService`、`api.registerGatewayMethod`（自定义 RPC）、`api.registerCommand`、`api.registerHttpRoute`、`api.registerCli`、`api.registerMemory`/`api.registerContextEngine`。
- Hooks：`before_agent_start`、`agent_end`、`before_tool_call`、`after_tool_call`、`message_received`、`message_sending`、`session_start`、`session_end`。
- 资源清单：`package.json` 中 `"openclaw":{"extensions":[...],"skills":["skills/*.md"],"prompts":[...],"themes":[...]}`，未声明时回落到 `extensions/ skills/ prompts/ themes/` 目录发现。
- 官方扩展目录 `extensions/`（如 `acpx`、`diagnostics-otel`、`admin-http-rpc`、`memory-core`、`memory-lancedb`、各渠道插件）；配置 `plugins.entries.<id>.{enabled,config}`、`plugins.allow`；安装 `openclaw plugins install <npm 包 | clawhub:@scope/name>`。

**Skills**（已确认，https://docs.openclaw.ai/skills）：`SKILL.md` = YAML frontmatter（`name, description, metadata.openclaw.{requires.bins/env/config, always, primaryEnv, install{brew|node|go|uv|download}}`）+ markdown 正文；兼容 Anthropic/agentskills 格式（推测：字段兼容，官方页未在本次抓取中明示）。优先级：`<workspace>/skills` > `<workspace>/.agents/skills` > `~/.agents/skills` > `<state-dir>/skills` > bundled > extra dirs/plugin skills；`skills.entries.<name>.{enabled, apiKey, env}`；`skills.load.watch` 热更新；会话启动时快照，符合条件的 skills 以紧凑 XML 块注入 system prompt（每个约 24 token）。ClawHub：`openclaw skills install @owner/<slug>`、`openclaw skills verify`、`openclaw skills update --all`。

**Channels（渠道插件）**（已确认）：README 列核心渠道 WhatsApp、Telegram、Slack、Discord、Google Chat、Signal、iMessage；docs 站另有 Mattermost、MS Teams、LINE、Zalo、Matrix（迁移）、BlueBubbles、WeChat（`@tencent-weixin/openclaw-weixin` 外部插件，腾讯出品）、WeCom（企业微信）、飞书/Lark（`larksuite/openclaw-lark`，飞书官方，要求 ≥2026.2.26）、钉钉/QQ（社区 `BytePioneer-AI/openclaw-china` 等）。渠道插件 SDK：docs `/plugins/sdk-channel-message`、`sdk-channel-outbound`、`sdk-channel-turn`。

**Cron / Heartbeat**：docs `/automation/cron-jobs`、`/gateway/heartbeat`、`/automation/cron-vs-heartbeat`；cron 每次运行新会话并走独立 `cron` lane；RPC `cron.list`；heartbeat 周期性唤醒 agent 检查 `HEARTBEAT.md`（推测：基于 lane 与 RPC 名称，未逐页抓取）。

## 记忆

（已确认，https://docs.openclaw.ai/concepts/memory）
- **文件即记忆**：workspace 下 `USER.md`（用户画像/偏好）、`MEMORY.md`（长期非画像事实与决策）、`memory/YYYY-MM-DD.md`（每日笔记）、`DREAMS.md`（后台"dreaming"整合摘要）；另有 `SOUL.md`/`AGENTS.md`（人格与指令）。
- **工具**：`memory_search`（hybrid：向量相似 + 关键词 BM25）、`memory_get`（按文件/行范围读取）、`intent`（事件条件触发的 standing intents）。
- **索引**：内置 SQLite 引擎（无外部依赖）；embedding provider：OpenAI（默认）、Gemini、Voyage、Mistral、Bedrock、本地（GGUF/Ollama/LM Studio）；`memory.search.provider` 指定。
- **Compaction 前 flush**：`agents.defaults.compaction.memoryFlush.enabled`（默认 true），压缩前把关键上下文写入文件。
- **可插拔后端**：builtin（SQLite）、Honcho、LanceDB（`memory-lancedb`，自动 recall）；`plugins.entries.memory-core.config.dreaming.enabled` 控制后台整合；插件可 `api.registerMemory` / `api.registerContextEngine` 替换整个上下文引擎（docs `/concepts/context-engine`、`/concepts/memory-qmd`、`/concepts/memory-provenance`）。

## 可观测性

（已确认，https://docs.openclaw.ai/gateway/opentelemetry；CHANGELOG 交叉验证 [已交叉验证]）
- 插件化：`openclaw plugins install clawhub:@openclaw/diagnostics-otel`；配置 `diagnostics.otel:{enabled, endpoint:"http://otel-collector:4318", protocol:"http/protobuf"(仅此一种，grpc 已退役), serviceName:"openclaw", traces, metrics, logs(默认关), logsExporter:"otlp"|"stdout"|"both", sampleRate, flushIntervalMs(≥1000), captureContent(默认 false), headers, metricNamePrefix}`。
- Metrics：`openclaw.tokens`、`openclaw.cost.usd`、`gen_ai.client.token.usage`、`gen_ai.client.operation.duration`、`openclaw.model_call.duration_ms`、`openclaw.skill.used`、`openclaw.session.recovery.completed`、队列深度、会话状态、failover 等。
- Spans：`openclaw.run`、`openclaw.model.call`、`openclaw.model.usage`、`openclaw.tool.execution`、`openclaw.exec`；覆盖模型调用、**harness lifecycle**、工具执行、webhook、上下文组装。CHANGELOG 记载 OTel 支持 GenAI 语义字段中的 tool inputs/results、`/v1/chat/completions` 与 `/v1/responses` 触发的 run 也进入 Langfuse/OTel/Prometheus。
- 进程内诊断事件：`model.usage`、`webhook.received/error/processed`、`message.queued/processed/delivery.*`、`session.state/long_running/stalled/stuck`、`queue.lane.enqueue/dequeue`、`harness.run.started/completed/error`、`exec.process.completed`。
- WS 协议自带 `traceparent`（W3C）透传；RPC `diagnostics.stability`、`logs.tail`、`usage.status`、`approval.history`；`logging.file` 结构化日志；`openclaw doctor`。

## OpenClaw 与 pi 的关系（问题 11）

- **历史**（已确认，README 致谢 + 社区分析）：README 明确致谢 Mario Zechner 与 [pi](https://github.com/earendil-works/pi)；2026 年初的第三方源码分析（Armin Ronacher《Pi: The Minimal Agent Within OpenClaw》https://lucumr.pocoo.org/2026/1/31/pi/、dabit3 gist）指出 OpenClaw 当时以嵌入方式直接 import `@mariozechner/pi-agent-core`/`pi-ai`/`pi-coding-agent`，通过 `createAgentSession()` 实例化 pi 的 `AgentSession`，在 `src/agents/` 下包一层自己的 runtime wrapper（"pi-embedded runner"）。
- **现状（2026.8.1 主干）**（已确认，[已交叉验证：docs/agent-runtime-architecture.md 原文 + 主干 package.json 依赖表 + raw 探测 `src/agents/pi-embedded*` 均 404]）：官方文档原文 "OpenClaw owns the built-in agent runtime … **no external agent framework packages remain**"；agent loop 已内化为 `packages/agent-core`（`@openclaw/agent-core`）与 `src/agents/embedded-agent-runner/`；`package.json` 依赖中仅剩 `@earendil-works/pi-tui@0.84.3`（终端组件库），文档称"Internalizing it would be a separate vendoring effort"。运行时 id 层面保留 `pi` 作为 `openclaw` 的 legacy alias。
- **边界结论**：pi 是 OpenClaw 内置 runtime 的**血统来源**（agent loop、session JSONL、provider 抽象的设计），但截至 2026-09 已**不是运行时依赖**；pi 本身另可作为 ACP 外部 harness（`pi-acp`，harness id `pi`）被 acpx 驱动。对我们而言：OpenClaw ≈ "网关 + 自有 harness + harness 注册表"，pi ≈ 独立的最小 harness——两者是并列可接入引擎，而非上下游。

## 社区规模、许可证、版本（问题 10）

- 版本：主干 `package.json` `version: 2026.8.1`（已确认）；docs 协议页标注稳定版 2026.8.1；第三方报道称 2026.8.1 于 2026-08-31 发布并被称作 "OpenClaw 2.0"，合并 16,000+ PR（https://tech-insider.org/openclaw-2-0-release-credential-security-2026/，二手）。版本号采用 `YYYY.M.patch` 日期式。
- 许可证：MIT（README badge + package.json `license: MIT`）[已交叉验证]。
- 规模（二手，置信度中）：2026-03 突破 250K stars，2026-04 报道 355K stars、1,200+ 贡献者（https://medium.com/data-science-collective/...；维基百科 https://en.wikipedia.org/wiki/OpenClaw）；GitHub API 本会话无权访问，未能一手核实当前 star 数。CHANGELOG 中 PR 编号已超过 #131000。
- 生态：ClawHub（skills 注册表，10,700+ skills @2026-02）、官方组织下多仓库（acpx、gateway-protocol、diagnostics-otel、渠道插件）、腾讯（微信）与飞书官方插件。

## 对我们架构的启示

### 1. 公共能力 vs OpenClaw 扩展能力映射

| 能力 | OpenClaw 实现 | 归类 | 接入参数（我们网关→OpenClaw） |
|---|---|---|---|
| 会话创建/续接 | `sessionKey` 字符串（`agent:<id>:<scope>...`）；`chat.send{sessionKey}` / HTTP `x-openclaw-session-key` / `user` | **公共** | `agentId`, `sessionKey`（由我们的 业务→session 映射生成）|
| 会话隔离粒度 | `session.dmScope`、`groupScope`、`identityLinks`、`bindings[].session` | 公共（策略参数化） | `dmScope`, `groupScope` |
| 排队/并发 | `messages.queue.mode: steer|followup|collect|interrupt` + `cap/drop/debounce`、lanes | 公共（steer 是 OpenClaw 特色，多数引擎只有 queue/interrupt） | `queueMode` |
| 群 mention gating | `requireMention`、`mentionPatterns`、`/activation` | 公共（网关层应自己做，OpenClaw 版仅在其渠道内有效） | — |
| 权限 | `dmPolicy`、`tools.profile/allow/deny/elevated`、群/发送者级工具策略、sandbox mode/scope | 公共（工具 allow/deny + 审批）+ 扩展（sandbox scope、toolsBySender） | `tools.allow/deny`, `sandbox.mode` |
| 记忆 | 文件 + SQLite hybrid 检索、`memory_search`、compaction flush、context engine 插件 | 公共（markdown 记忆文件可归一化）+ 扩展（dreaming、Honcho/LanceDB 后端） | `memory.search.provider` |
| 多 agent | `agents.entries`、`bindings`、`sessions_send/spawn`、`agentToAgent.allow`、subagent lane | 扩展（agent team 类） | `subagents.maxConcurrent/maxSpawnDepth` |
| 外部 harness 编排 | ACP：`runtime.type:"acp"`，`sessions_spawn({runtime:"acp", agentId})`，`/acp *` | **扩展且与我们同构**（OpenClaw 自身就是"网关+多引擎"） | `acp.allowedAgents`, `acp.defaultAgent`, `cwd`, `mode` |
| 可观测 | OTel（http/protobuf）、GenAI 语义约定、`traceparent` 透传、诊断事件 | 公共（OTel 是最佳归一化载体） | `diagnostics.otel.endpoint` |
| 技能/插件 | SKILL.md（agentskills 兼容）、plugin manifest + hooks | 公共（SKILL.md 可跨引擎复用）+ 扩展（plugin API 专有） | skills 目录挂载 |
| 自动化 | cron/heartbeat/webhook | 扩展 | — |
| 设备/节点能力 | `node` 角色（camera/screen/location/voice） | 扩展（独有） | — |

### 2. 接入方式建议
- **推荐接入面**：把 OpenClaw 作为一个"引擎"接入时，优先用 **WS RPC**（`@openclaw/gateway-client`，`chat.send` + 订阅 `chat`/`session.*`/`sessions.changed` 事件，能拿到流式增量与工具事件），其次 **OpenAI 兼容 HTTP**（最省事，`model:"openclaw/<agentId>"` + `x-openclaw-session-key`，SSE 流式，但只有文本级事件、缺工具/审批事件）。业务→session 映射直接复用 OpenClaw 的 session key 语法：群助手 = `agent:<biz-agent>:<channel>:group:<groupId>`，并把我们的 tenant/群 id 编码进 key，避免依赖 OpenClaw 自带渠道。
- **鉴权**：OpenClaw token = 全 operator 权限，必须由我们网关持有、对外不透出；多租户隔离需**多 Gateway 实例**（官方立场），或每租户独立 `agents.entries` + `bindings` + `tools` 策略（软隔离）。
- **赛题方案 3（在 OpenClaw 上再加一个引擎）的改造点**：
  1. 最轻：作为 **ACP harness** 接入——若目标引擎（如 dsh、hermes）能提供 ACP server（或用适配器封装 stdio JSON-RPC），只需在 acpx 的 harness 注册表加一条 id + 启动命令，配置 `acp.allowedAgents` 与 `agents.entries.<x>.runtime.acp.agent`；无需改核心。代价：不受 OpenClaw sandbox 包裹、上下文以纯文本 prompt 传递、事件粒度取决于 ACP。
  2. 较深：实现 **插件 harness**——参照 `codex` 插件，在 `src/agents/harness/` 注册表注册新 runtime id，实现 `@openclaw/agent-core` 的 harness 接口（attempt loop、tool-call 适配、transcript 写入 session store），通过 `agentRuntime.id` 按 model/provider 选择。收益：同进程、共享 session store/compaction/memory/OTel；代价：接口未在 plugin-sdk 公开文档中稳定（推测，需读源码）。
  3. 最深：写 **channel plugin**（把我们的业务系统当作一个渠道接入 OpenClaw）——这是"方案 3"里让赛题网关接口对接 OpenClaw 的另一种路径。

### 3. 风险与坑
- 版本迭代极快（日期式版本、月度大版本，PR 编号 13 万+），文档 URL 频繁重排（本次 `concepts/sessions`、`concepts/groups`、`concepts/agent-runtime-architecture` 均 404，需改用 `concepts/session`、`channels/groups`、`/agent-runtime-architecture`）；接入代码应锁版本并以 `@openclaw/gateway-protocol` 的 `protocol.schema.json` 做契约测试。
- 安全历史沉重（CSWSH RCE、pairing 提权、ClawHub 供应链），且 skills 无沙箱；生产接入必须 `plugins.allow` 白名单、禁用 ClawHub 自动安装、loopback + 反代鉴权。
- 内置 runtime 从 pi 依赖迁为自有 `@openclaw/agent-core`，"pi 兼容"已只是别名；不要假设 pi 的 session 文件/扩展在 OpenClaw 中可直接复用。
- 配置 schema 严格：未知 key 会让 Gateway **拒绝启动**；hot reload 为 `hybrid`。
- ACP 路径与 sandbox 互斥；沙箱会话无法 spawn ACP。
- 群会话 key 在两处文档形态不一致（`agent:<id>:group:<gid>` vs `agent:<id>:<channel>:group:<gid>`），接入时以 `sessions.list` 实测为准。

## 未解决问题
1. `src/agents/harness/` 的插件 harness 注册接口是否已在 `openclaw/plugin-sdk` 公开、签名如何（本次未读源码）。
2. exec approvals 的精确配置字段（`tools.exec.security/ask/approvals`）与审批 RPC 流程未逐页核实。
3. 当前 star/fork 数（GitHub API 在本会话不可访问；二手数据为 2026-04 的 355K）。
4. `hooks.*` webhook 配置字段与 heartbeat 的精确语义（仅从 docs 索引与 lane 名推断）。
5. 2026.8.1 "database-first" 迁移后 transcript 是否仍为 JSONL 及其 schema（docs `/reference/database-schemas` 未抓取）。
6. 飞书/钉钉/企业微信插件与核心 `bindings` 的 peer id 格式。

## 来源列表
- https://docs.openclaw.ai/gateway/protocol （WS 协议、方法/事件、scope、包名）
- https://docs.openclaw.ai/concepts/session （session key、dmScope/groupScope、reset、存储、maintenance）
- https://docs.openclaw.ai/channels/groups （mention gating、groupPolicy、群工具策略、群 key）
- https://docs.openclaw.ai/concepts/queue （lanes、queue modes）
- https://docs.openclaw.ai/concepts/multi-agent （agents/bindings/agentToAgent/subagents）
- https://docs.openclaw.ai/tools/acp-agents （ACP harness、acpx、配置与命令）
- https://raw.githubusercontent.com/openclaw/openclaw/main/docs/agent-runtime-architecture.md （runtime 布局、harness 注册表、pi 边界）
- https://raw.githubusercontent.com/openclaw/openclaw/main/docs/openclaw-agent-runtime.md
- https://raw.githubusercontent.com/openclaw/openclaw/main/docs/gateway/openai-http-api.md 与 https://docs.openclaw.ai/gateway/openai-http-api
- https://docs.openclaw.ai/gateway/admin-http-rpc
- https://docs.openclaw.ai/gateway/configuration
- https://docs.openclaw.ai/gateway/security
- https://docs.openclaw.ai/gateway/opentelemetry
- https://docs.openclaw.ai/plugins/building-plugins
- https://docs.openclaw.ai/skills
- https://docs.openclaw.ai/concepts/memory
- https://raw.githubusercontent.com/openclaw/openclaw/main/README.md
- https://raw.githubusercontent.com/openclaw/openclaw/main/package.json （version 2026.8.1、MIT、engines、依赖）
- https://raw.githubusercontent.com/openclaw/openclaw/main/CHANGELOG.md
- https://raw.githubusercontent.com/openclaw/openclaw/main/docs/docs.json （文档索引）
- https://lucumr.pocoo.org/2026/1/31/pi/ ；https://gist.github.com/dabit3/e97dbfe71298b1df4d36542aceb5f158 （早期 pi 嵌入方式，二手）
- https://github.com/larksuite/openclaw-lark ；https://github.com/BytePioneer-AI/openclaw-china ；https://docs.openclaw.ai/channels/wechat （中国渠道插件）
- https://adversa.ai/blog/openclaw-security-101-vulnerabilities-hardening-2026/ ；https://www.armosec.io/blog/cve-2026-32922-openclaw-privilege-escalation-cloud-security/ ；https://clawtrust.ai/blog/openclaw-security-341-malicious-skills-and-what-we-do-about-it ；https://www.betterclaw.io/blog/openclaw-security-2026 （安全事件，二手）
- https://en.wikipedia.org/wiki/OpenClaw ；https://tech-insider.org/openclaw-2-0-release-credential-security-2026/ ；https://medium.com/data-science-collective/355k-github-stars-in-5-months-17-defense-rate-the-complete-honest-guide-to-openclaw-28d2f59598e1 （规模/版本，二手）
