# T26 群助手（IM 群聊机器人）业务模式与网关接口形态

调研日期：2026-09-03。所有事实均以联网抓取的一手资料（官方文档 / GitHub 源码与文档 / 平台开放文档）为准；无法抓取到原文的字段以"推测/中置信度"标注。

## 摘要

群助手是"Agent 网关 + Agent 引擎"架构最典型的业务形态：IM 平台（Slack / Teams / 飞书 / 钉钉 / 企微 / Discord / Telegram）把 `@mention`、线程回复、卡片交互等事件推给网关；网关负责 **业务实体（tenant / group / thread / user）→ 引擎 session 的映射**、mention 门控、权限与配额、并发排队，再把引擎的流式输出适配成各平台的"流式消息"原语（Slack `chat.startStream`、Teams `streamInfo`、飞书 CardKit、钉钉 AI Card、企微 `stream.id`）。

2025–2026 年业界收敛出几条清晰规律：

1. **线程 = 任务 = session**（Claude Tag、Codex、Cursor、Devin、Copilot、OpenClaw、Hermes 均如此）；顶层群消息触发新线程，线程内回复无需再次 @。
2. **群会话默认共享、可选按人隔离**：OpenClaw 默认 `per-group`，Hermes 默认 `group_sessions_per_user: true`（群里每人一份 transcript，线程内共享），飞书 OpenClaw 适配层提供 `group | group_sender | group_topic | group_topic_sender` 四档。
3. **身份两种模式**：per-user（Claude Code in Slack、Codex、Cursor、Devin——Slack 用户通过 email/OAuth 绑定到引擎账号，用个人配额与仓库权限）与 **org 共享服务身份**（Claude Tag：按 channel scope 配 Access bundle，凭据由 Agent Proxy 在网络边界注入，沙箱内无密钥）。
4. **会话生命周期**：线程持久、沙箱临时（Claude Tag：几分钟空闲释放，回复时重建）；channel 顶层 session 约 1 小时空闲/1 天寿命/配置变更即换新；OpenClaw `session.reset {mode: daily|idle}`；Hermes `session_reset {mode: idle|daily|both|none}`。
5. **并发处理**：同 session 串行（OpenClaw lane `session:<key>` 并发 1，Hermes 每 session 锁），新消息进入 `steer | followup | collect | interrupt` 队列模式；Slack/Teams 流式各有 1 req/s、单 chat 单 stream 等硬限制。
6. **可编程面**：引擎侧已出现标准化 API——OpenClaw Gateway WS 协议（`chat.send {sessionKey, queueMode}` + `chat.message {runId, deltaText}`）、Hermes API Server（`/v1/runs` + `X-Hermes-Session-Key` + `tool.started/completed` SSE + `/approval`）、Devin v3 sessions API（`status: new|claimed|running|exit|error|suspended|resuming`）。这些为我们推断"真实业务系统的网关接口"提供了直接模板。

## 关键事实（每条带来源与置信度）

| # | 事实 | 来源 | 置信度 |
|---|---|---|---|
| 1 | Claude Tag（Team/Enterprise 公测）中，channel 顶层 `@Claude` 由"channel 自己的 session"接收；需要工具/调查的任务在消息下开线程，"that thread binds to its own session from then on"；两条线程 = 两个 session + 两个沙箱，互不共享状态 | https://claude.com/docs/claude-tag/concepts/how-it-works | 高 |
| 2 | Claude Tag 线程内任何人回复即可 steer 正在运行的 session，无需再 @；编辑消息只作为"note"送达，删除消息不通知 | 同上 | 高 |
| 3 | Claude Tag 沙箱在一轮结束"几分钟后"释放，下次回复重建；channel 顶层 session 在"约 1 小时无顶层活动 / 约 1 天寿命 / 配置变更"时替换；channel 自上次发言累计约 100 条消息后停止阅读，直到再次被 @ | 同上；https://claude.com/docs/claude-tag/users/when-claude-responds | 高（数值文档自称"approximate"） |
| 4 | Claude Tag 在 channel 内以 **组织服务账号** 行动（Claude app / Claude GitHub App / 每个工具的 service account），访问权按 scope（org / workspace / channel）挂 Access bundle；凭据不进沙箱，由 Agent Proxy 在出站时注入，默认 deny 未列出的主机 | https://claude.com/docs/claude-tag/concepts/agent-identity ；https://claude.com/docs/claude-tag/concepts/security-and-data | 高 |
| 5 | Claude Tag 计费：channel 工作从组织 usage balance 扣，支持 org 级 / 默认 / 每 channel spend limit，超限"declined rather than silently truncated"；DM 走个人 seat | https://claude.com/docs/claude-tag/overview ；https://claude.com/docs/claude-tag/admins/restrict-access | 高 |
| 6 | Claude Code in Slack（旧版，Pro/Max 仍用）：每个 session 跑在提问者自己的 Claude 账号下，占用其个人配额与已连接仓库；线程取全部消息、channel 取近期消息作上下文；仅 channel 可用、DM 不可用；文档明确警告 Claude 可能遵循上下文中其他人的指令 | https://code.claude.com/docs/en/slack | 高 |
| 7 | Slack 官方 Agents & AI Apps：`chat.startStream / chat.appendStream / chat.stopStream`，`chunks` 支持 `markdown_text`、`task_update{status: in_progress|completed|error}`，`task_display_mode: timeline|plan`；`markdown_text` 上限 12,000 字符；在 channel 中流式必须带 `recipient_user_id`/`recipient_team_id`；Block Kit 仅可在 `stopStream` 时附加；`agents.sessions.setStatus` 取代 `assistant.threads.setStatus` | https://docs.slack.dev/ai/developing-agents/ ；https://docs.slack.dev/reference/methods/chat.startStream | 高 |
| 8 | Codex in Slack：`@Codex` 后 Codex 读取线程历史创建 cloud chat，以 👀 反应并回链接；自动选择用户有权访问的 environment（歧义时取最近使用），在该 env repo map 第一个仓库默认分支运行；企业管理员可关闭"Allow Codex Slack app to post answers on task completion" | https://learn.chatgpt.com/docs/third-party/slack | 高 |
| 9 | Cursor in Slack：`@Cursor` 启动 Cloud Agent，读整条线程；线程内 `@Cursor [prompt]` 为 follow-up，`@Cursor agent [prompt]` 强制新 agent；内联参数 `repo= branch= model= autopr= env= worker= pool= channel=`，优先级"inline > settings 默认，env 优先于 repo"；用 `users:read` 把 Slack 用户匹配到 Cursor 账号；反应 ⏳/✅/❌ 表示状态 | https://cursor.com/docs/integrations/slack | 高 |
| 10 | Devin in Slack：session 与线程双向同步，`unsync`/`!unsync` 停止；bang 命令 `!new !channel !ask !deep !fast !lite !ultra !fusion !swe !normal !windows !mac !outpost` 可堆叠且随处生效；身份匹配依据 Slack email == Devin 账号 email；控制词 `mute/unmute/sleep/archive/EXIT` | https://docs.devin.ai/integrations/slack | 高 |
| 11 | Devin v3 API：`POST /v3/organizations/{org_id}/sessions`，字段含 `prompt, title, max_acu_limit, secret_ids, knowledge_ids, tags, playbook_id, devin_mode, attachment_urls, structured_output_schema, repos, resumable, create_as_user_id, bypass_approval`；status 枚举 `new, claimed, running, exit, error, suspended, resuming` | https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions | 高 |
| 12 | GitHub Copilot cloud agent in Slack（2026-08 公测）：`@GitHub` 在 DM/channel/thread 启动 session，"entire thread becomes the decision-making context"；只有对仓库有 write 权限的人能触发，但"any conversation participant can provide input"；guest/outside collaborator 不能启动或 steer；后续通过"Slack Code" code channel 专属 steer | https://docs.github.com/en/copilot/how-tos/copilot-integrations/integrate-cloud-agent-with-slack ；https://github.blog/changelog/2026-08-21-the-new-github-copilot-experience-in-slack/ | 高 |
| 13 | OpenClaw 群会话 key：`agent:<agentId>:<channel>:group:<groupId>`（Telegram topic 追加 `:topic:<threadId>`；Discord 频道 `channel:<id>`；Slack `channel:<id>:thread:<threadTs>`；Enterprise Grid `team:<teamId>:channel:<channelId>`）；`session.groupScope: per-group|main`，`session.dmScope: main|per-peer|per-channel-peer|per-account-channel-peer` | https://docs.openclaw.ai/channels/groups ；https://docs.openclaw.ai/concepts/session ；https://docs.openclaw.ai/channels/slack ；https://docs.openclaw.ai/channels/discord | 高 |
| 14 | OpenClaw 群访问三级评估：`groupPolicy: open|disabled|allowlist` → `groupAllowFrom`/`groups.<id>` → mention gating（`requireMention` 默认 true，`mentionPatterns`，`/activation mention|always`）；每群工具策略 `groups.<id>.tools.deny / toolsBySender`，"Deny always wins"；`contextVisibility: all|allowlist|allowlist_quote` 控制历史注入 | https://docs.openclaw.ai/channels/groups | 高 |
| 15 | OpenClaw 队列：lane `session:<key>` 保证每 session 只有一个活动 run；`messages.queue.mode: steer|followup|collect|interrupt`（默认 steer），`cap: 20`，`drop: summarize|old|new`，debounce 500ms，`byChannel` 覆盖；`agents.defaults.maxConcurrent` 默认 `min(16, max(8, CPU))`；`/queue` 每 session 覆盖 | https://docs.openclaw.ai/concepts/queue | 高 |
| 16 | OpenClaw 会话重置：`session.reset {mode: none|daily|idle, atHour, idleMinutes}`，`resetByType {direct|group|thread}`，`resetByChannel`；idle 以"最后真实用户交互"计，heartbeat/cron 不续命；`session.identityLinks` 把同一人多渠道映射到一个 peer；`session.maintenance {pruneAfter, maxEntries}` | https://docs.openclaw.ai/concepts/session | 高 |
| 17 | OpenClaw Gateway WS 协议 v4：`connect {role, scopes:[operator.read|write|admin|approvals], auth.token, device}`；`chat.send {sessionKey, text, queueMode, idempotencyKey}`；事件 `chat.message {sessionKey, runId, deltaText, message, state: running|success|error}`；请求可带 W3C `traceparent` | https://docs.openclaw.ai/gateway/protocol | 高 |
| 18 | Hermes 会话 key 单一来源 `build_session_key()`：`ns:platform:chat_type_slot:[slack_scope_id]:[chat_id]:[thread_id]:[user_id]`；`group_sessions_per_user` 默认 True（群内按人隔离），`thread_sessions_per_user` 默认 False（线程共享）；Discord auto-thread 用"prospective thread id"保证首条消息与后续线程连续 | https://raw.githubusercontent.com/NousResearch/hermes-agent/main/gateway/session.py ；https://hermes-agent.nousresearch.com/docs/user-guide/sessions | 高 |
| 19 | Hermes Telegram：`require_mention`（默认 false），`mention_patterns`，`group_allow_from / group_allowed_chats / allow_admin_from / guest_mode`，`observe_unmentioned_group_messages: true` 把未 @ 的群消息以 `[nickname|user_id]` 标签追加进共享 transcript 但不触发 agent；`exclusive_bot_mentions`（多 bot 共群）；群/话题 `channel_prompts`、`group_topics[].skill` 自动加载技能；状态气泡 `send_or_update_status()` 原地编辑，key `(chat_id, status_key)` | https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/messaging/telegram.md | 高 |
| 20 | Hermes 网关：`session_reset {mode: none|idle|daily|both, idle_minutes, at_hour}` + `gateway.json reset_by_platform`；`display.busy_input_mode: interrupt|queue|steer`；默认拒绝非 allowlist 用户，DM pairing code 1 小时过期；两级权限 admin/user（`allow_admin_from`、`user_allowed_commands`、`group_user_allowed_commands`）；delivery ledger at-least-once 重投（3 次/24h）；静默 token `[SILENT] / NO_REPLY` | https://hermes-agent.nousresearch.com/docs/user-guide/messaging/ | 高 |
| 21 | Hermes API Server（:8642）：`/v1/chat/completions`、`/v1/responses`（`previous_response_id`/`conversation`）、`/v1/runs`（`Idempotency-Key`，`GET /v1/runs/{id}/events` SSE：`tool.started/completed, subagent.start/complete, assistant.delta, run.completed`，`POST /v1/runs/{id}/approval`、`/stop`）；头 `X-Hermes-Session-Id`（transcript）与 `X-Hermes-Session-Key`（长期记忆 scope，≤256 字符）；`max_concurrent_runs` 默认 10 超限 429 | https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server | 高 |
| 22 | Teams 流式：REST `type: typing`，`entities[{type: streaminfo, streamId, streamType: informative|streaming|final, streamSequence}]`；流式内容必须包含之前已流出的前缀；限流 1 req/s，流总时长 2 分钟，informative ≤1000 字符；**仅 1:1 聊天支持流式，每 chat 同时仅 1 个流**；群聊/频道中 bot 默认仅收 @ 消息（RSC 可收全部） | https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux ；https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations | 高 |
| 23 | 飞书 `im.message.receive_v1`：`header{event_id, event_type, tenant_key, app_id}`，`event.sender.sender_id{open_id,user_id,union_id}`，`event.message{message_id, root_id, parent_id, chat_id, thread_id(omt_*), chat_type: p2p|group, message_type, content, mentions[{key,id,name}]}`；群内是否需 @ 取决于权限"接收群聊中@机器人消息"vs"获取群组中所有消息"；事件可走 Webhook 或长连接（WebSocket） | https://open.feishu.cn/document/server-docs/im-v1/message/events/receive | 高 |
| 24 | 飞书 CardKit 流式：`POST /open-apis/cardkit/v1/cards`（schema 2.0，`config.streaming_mode: true`，`streaming_config{print_frequency_ms, print_step, print_strategy: fast|delay}`）→ `POST /open-apis/im/v1/messages`（`msg_type: interactive`, `content: {"type":"card","data":{"card_id":...}}`）→ `PUT /open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content {content, sequence}` 全量文本、`sequence` 递增 → `PATCH .../settings` 关闭流式；限频 **10 次/秒/卡片**，卡片有效期 14 天，客户端 ≥7.20 | https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview | 高 |
| 25 | 钉钉 Stream 模式：`POST https://api.dingtalk.com/v1.0/gateway/connections/open {clientId, clientSecret, subscriptions[{type: EVENT|CALLBACK, topic}], ua, localIp}` → `{endpoint, ticket}` → WSS；帧 `{specVersion, type: CALLBACK|EVENT|SYSTEM, headers{topic, messageId, contentType}, data}`；机器人消息 topic `/v1.0/im/bot/messages/get`，data 含 `conversationType(1 单聊/2 群聊), conversationId, senderStaffId, senderNick, text.content, msgId, sessionWebhook, sessionWebhookExpiredTime, robotCode, isInAtList`；ACK `{code: 200, headers{messageId}}`；**群聊仅限 @机器人消息** | https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol ；https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/overview/ | 高 |
| 26 | 钉钉卡片：`CreateAndDeliver {cardTemplateId, outTrackId(UUID), callbackType: "STREAM", cardData, openSpaceId: "dtv1.card//IM_GROUP.{conversationId}" 或 "dtv1.card//IM_ROBOT.{staffId}", imGroupOpenDeliverModel.robotCode}`；卡片回调 topic `/v1.0/card/instances/callback`；AI 卡片流式更新接口文档为 `/document/orgapp/api-streamingupdate` | https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/go/card-callback/ ；https://raw.githubusercontent.com/open-dingtalk/dingtalk-card-examples/main/README.md | 高（接口存在）；流式字段 `outTrackId/guid/key/content/isFull/isFinalize/isError` 为 **中**（官方页 JS 渲染未抓到，依据训练知识） |
| 27 | 企微智能机器人长连接：`wss://openws.work.weixin.qq.com`，`aibot_subscribe {bot_id, secret}`；回调 `aibot_msg_callback {msgid, aibotid, chatid, chattype: single|group, from.userid, msgtype, text}`；回复 `aibot_respond_msg {msgtype: stream, stream{id, finish, content, feedback.id}}`——同一 `stream.id` 反复推送即刷新，`finish=true` 结束，10 分钟内完成；主动 `aibot_send_msg` 限 30 条/分钟、1000 条/小时；每 bot 仅 1 条有效长连接；心跳 30s | https://developer.work.weixin.qq.com/document/path/101463 ；https://developer.work.weixin.qq.com/document/path/101031 | 高 |
| 28 | Discord：全局 50 req/s，按 route bucket（`X-RateLimit-Bucket/Scope/Reset-After`，429 `retry_after/global`），10,000 无效请求/10 分钟触发 Cloudflare 封禁；OpenClaw Discord 单条 2000 字符 `textChunkLimit`，`historyLimit` 默认 20，`replyToMode: off|first|all|batched`；Hermes Discord `auto_thread` 默认 true（每次 @ 自动开线程）、`history_backfill_limit` 50 | https://docs.discord.com/developers/topics/rate-limits ；https://docs.openclaw.ai/channels/discord ；https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord | 高 |
| 29 | Vercel Chat SDK（跨 Slack/Teams/Discord/Google Chat/Telegram/GitHub/Linear）：统一 `thread.post(AsyncIterable|StreamChunk)`，Slack 映射到 `chatStream`，Teams DM 用 `stream.emit()` 而群聊缓冲，Discord/Google Chat 用 post+edit 节流（`streamingUpdateIntervalMs`），GitHub 累积后一次性评论；`thread.subscribe()`、`onNewMention`、状态适配器（Redis/内存）提供订阅、分布式锁、缓存；`thread.signal` 传递取消 | https://chat-sdk.dev/docs/streaming ；https://chat-sdk.dev/docs | 高 |
| 30 | Claude Tag 记忆按"地点"归属：公开 channel 写入 workspace 共享记忆，私有 channel 写自己的 store 且只读 workspace 记忆；DM 记忆单独；任何 channel 成员可增删改；Owner 可在 admin 页查看/编辑 memory files；channel 公开↔私有切换时记忆不迁移 | https://claude.com/docs/claude-tag/users/memory | 高 |

## 架构与工作原理

### 三层模型

```
IM 平台事件层                网关层（业务侧稳定）                   引擎层（harness）
─────────────────            ─────────────────────────────         ─────────────────────
Slack Events/Socket Mode     1. 事件归一化（InboundMessage）        Claude Code (cloud sandbox)
Teams Bot Framework          2. 触发判定：mention gating /          Codex cloud / Cursor Cloud Agent
飞书 长连接/Webhook              allowlist / guest / bot-message      Devin session / Copilot cloud agent
钉钉 Stream WSS              3. 路由：tenant/group/thread/user      OpenClaw agent (sessionKey)
企微 aibot 长连接                → sessionKey → binding(engine)       Hermes AIAgent (session_id)
Discord Gateway              4. 队列/并发：per-session lane          pi / opencode / dsh ...
                             5. 引擎调用 + 事件流归一化
                             6. 出站适配：native streaming /
                                edit-in-place / chunking / cards
                             7. 权限/配额/审计/记忆
```

### 各产品行为对比

| 产品 | 触发 | 线程↔session | 群多人 | 身份 | 输出方式 | 会话过期 |
|---|---|---|---|---|---|---|
| Claude Tag | `@Claude` 保证；channel 顶层可自动回复（`Respond automatically` 每 channel 开关）；线程内无需 @ | 顶层 → channel session；任务 → 线程绑定独立 session + 沙箱 | 线程内任何人可 steer；guest/受限角色消息体被隐藏 | 组织服务账号 + per-channel Access bundle；DM 走个人账号 | 线程内 checklist 原地编辑；文件/托管页面/PR | 沙箱几分钟释放、线程持久；channel session ~1h 空闲/~1d；`!restart` |
| Claude Code in Slack | `@Claude`（Code only / Code+Chat 路由） | 每次 mention 新建 claude.ai/code session，线程收状态 | 各自账号 | per-user（Slack↔Claude 账号 OAuth） | 状态更新 + View Session/Create PR 按钮 | 由 web session 管理 |
| Codex in Slack | `@Codex` | 线程历史 → cloud chat（链接） | — | per-user + GitHub 连接；env 自动选择 | 👀 + 链接 + 可选线程内答案 | — |
| Cursor in Slack | `@Cursor` / `@Cursor agent` | 线程 ↔ agent；follow-up 同线程 | "Team follow-ups" 控制谁可 follow-up | `users:read` 匹配 Cursor 账号 | ⏳/✅/❌ 反应 + PR 链接 | — |
| Devin in Slack | `@Devin` / `!new` / `/ask-devin` | 线程 ↔ session 双向同步 | 线程内回复直达 session | email 匹配 | 线程回复 / 专用 code channel / DM 通知 | `sleep/archive/EXIT`；再 @ 自动 unarchive |
| Copilot in Slack | `@GitHub` | 线程 → cloud agent session；"Slack Code" channel 专属 steer | 任何参与者可提供输入，仅 write 权限者可触发 | Slack↔GitHub 账号绑定 | 计划摘要 + PR 链接 | 每 session ≤59 分钟执行 |
| OpenClaw | `requireMention`（默认）/ `/activation always` | `agent:<a>:<ch>:group:<g>[:topic:<t>]`；Slack thread 独立 key | 默认共享 per-group；`unmentionedInbound: room_event` 静默观察 | allowlist（`groupAllowFrom`、Discord `users/roles`、accessGroups） | `streaming.mode: progress|partial|block|off`（Slack 原生 task card / Discord 编辑 / 飞书 CardKit） | `session.reset` daily/idle；`/new` |
| Hermes | `require_mention`；Discord `auto_thread` | 群 per-user；线程共享；Discord 首条 @ 即建线程 | `observe_unmentioned_group_messages` 观察不触发 | allowlist + pairing；admin/user 两级 | 状态气泡原地编辑；Slack 原生 stream；Telegram draft | `session_reset` idle/daily；`/new`；后台进程阻止重置 |

### 平台推送与流式原语对照

| 平台 | 入站 | 是否需 @ | 出站流式原语 | 关键限制 |
|---|---|---|---|---|
| Slack | Events API（`app_mention`, `message.channels/groups/im/mpim`）Socket Mode 或 HTTP | 默认需 `app_mention`；订阅 `message.*` 可收全部 | `chat.startStream/appendStream/stopStream`（`chunks: markdown_text / task_update`） | channel 内需 `recipient_user_id`；`markdown_text` ≤12k；Block Kit 仅 stop 时；Tier 2 限速 |
| Teams | Bot Framework activity（`conversation.id` 形如 `19:...@thread.skype;messageid=...`，`conversationType: personal|groupChat|channel`） | 群/频道默认仅 @；RSC 可收全部 | `type: typing` + `streaminfo{streamId, streamType, streamSequence}` | **仅 1:1 支持流式**；1 req/s；2 分钟；单 chat 单流 |
| 飞书 | `im.message.receive_v1`（Webhook / 长连接） | 取决于权限（@ 消息 vs 全部消息） | CardKit `streaming_mode` + `PUT .../elements/{id}/content {content, sequence}` | 10 次/秒/卡片；14 天；全量文本 |
| 钉钉 | Stream WSS `/v1.0/im/bot/messages/get` | 群聊仅 @ | AI Card `CreateAndDeliver(callbackType: STREAM)` + 流式更新接口 | `sessionWebhook` 有过期时间 |
| 企微 | `aibot_msg_callback`（WSS / 回调 URL） | 群聊 @（可配） | `aibot_respond_msg {msgtype: stream, stream{id, finish, content}}` | 10 分钟内完成；主动消息 30/min |
| Discord | Gateway + Interactions | 通常 mention gating | 发消息后 edit（节流） | 2000 字符；50 req/s；route bucket |
| Telegram | Bot API（隐私模式影响群消息可见性） | `require_mention` 可配；forum topic 隔离 | DM `sendMessageDraft`；群 `editMessageText` | 隐私模式需在 BotFather 关闭 |

## 可编程接入面

### IM 侧（网关入站/出站要调用的 API）

Slack AI app 关键调用（来自 docs.slack.dev）：

```
POST chat.startStream   { channel, thread_ts, recipient_user_id, recipient_team_id,
                          markdown_text | chunks:[{type:"markdown_text",text}|{type:"task_update",id,title,status}],
                          task_display_mode: "timeline"|"plan" }        → { ts, channel }
POST chat.appendStream  { channel, message_ts, thread_ts, chunks }
POST chat.stopStream    { channel, message_ts, thread_ts, chunks, blocks }  // 仅此处允许 Block Kit
POST agents.sessions.setStatus { channel_id, thread_ts, status: "processing"|"active"|"suspended" }
事件: app_mention, message.*, assistant_thread_started{context.channel_id,team_id}, app_context_changed, agent_session_stopped
Scopes: chat:write, assistant:write, app_mentions:read, channels:history, groups:history, users:read
```

Teams REST 流式（learn.microsoft.com）：

```json
POST /v3/conversations/{conversationId}/activities
{ "type": "typing", "text": "A brown fox",
  "entities": [{ "type": "streaminfo", "streamId": "a-0000l",
                 "streamType": "streaming", "streamSequence": 3 }] }
最终: { "type": "message", "text": "...", "entities": [{ "type":"streaminfo","streamId":"a-0000l","streamType":"final" }] }
错误: 403 ContentStreamNotAllowed（用户点 Stop / 超 2 分钟 / 内容未含前缀）、202 ContentStreamSequenceOrderPreConditionFailed、429
```

飞书 CardKit（open.feishu.cn）：

```
POST  /open-apis/cardkit/v1/cards                       { type:"card_json", data:"{schema:2.0, config:{streaming_mode:true, streaming_config:{...}}, body:{elements:[{tag:markdown, element_id:"markdown_1"}]}}" } → card_id
POST  /open-apis/im/v1/messages?receive_id_type=chat_id { receive_id, msg_type:"interactive", content:"{\"type\":\"card\",\"data\":{\"card_id\":\"...\"}}" }
PUT   /open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content { content:"<全量文本>", sequence:N }
PATCH /open-apis/cardkit/v1/cards/{card_id}/settings    { settings:"{\"config\":{\"streaming_mode\":false}}", uuid, sequence }
```

钉钉 Stream（developerpedia）：

```json
POST https://api.dingtalk.com/v1.0/gateway/connections/open
{ "clientId":"...", "clientSecret":"...", "ua":"dingtalk-sdk-java/1.0.2", "localIp":"10.34.22.11",
  "subscriptions":[{"type":"EVENT","topic":"*"},{"type":"CALLBACK","topic":"/v1.0/im/bot/messages/get"},
                   {"type":"CALLBACK","topic":"/v1.0/card/instances/callback"}] }
→ { "endpoint":"wss://wss-open-connection.dingtalk.com:443/connect", "ticket":"..." }
帧: { "specVersion":"1.0","type":"CALLBACK","headers":{"topic":"/v1.0/im/bot/messages/get","messageId":"...","contentType":"application/json"},
      "data":"{\"conversationType\":\"2\",\"conversationId\":\"cid...\",\"senderStaffId\":\"...\",\"senderNick\":\"...\",\"text\":{\"content\":\"...\"},\"msgId\":\"...\",\"sessionWebhook\":\"https://...\",\"sessionWebhookExpiredTime\":1690367502152,\"robotCode\":\"...\",\"isInAtList\":true}" }
ACK: { "code":200, "headers":{"messageId":"...","contentType":"application/json"}, "message":"OK", "data":"{\"response\":null}" }
```

企微（developer.work.weixin.qq.com）：

```json
→ {"cmd":"aibot_subscribe","headers":{"req_id":"..."},"body":{"bot_id":"BOTID","secret":"SECRET"}}
← {"cmd":"aibot_msg_callback","body":{"msgid":"..","aibotid":"..","chatid":"..","chattype":"group","from":{"userid":".."},"msgtype":"text","text":{"content":"@RobotA hello"}}}
→ {"cmd":"aibot_respond_msg","body":{"msgtype":"stream","stream":{"id":"STREAMID","finish":false,"content":"正在查询...","feedback":{"id":"FB"}}}}
```

### 引擎侧（网关向下调用的 API，直接可作为我们 Engine Adapter 的参考）

**OpenClaw Gateway WS**（docs.openclaw.ai/gateway/protocol）：

```json
{"type":"req","id":"1","method":"connect","params":{"minProtocol":4,"maxProtocol":4,
  "client":{"id":"gateway","version":"1.0","platform":"linux","mode":"operator"},
  "role":"operator","scopes":["operator.read","operator.write","operator.approvals"],"auth":{"token":"..."}}}
{"type":"req","id":"2","method":"chat.send","params":{"sessionKey":"agent:main:slack:channel:C123:thread:1712.3","text":"...","queueMode":"steer","idempotencyKey":"slack:C123:1712.3:1712.9"},"traceparent":"00-..."}
← {"type":"event","event":"chat.message","payload":{"sessionKey":"...","runId":"r1","deltaText":"...","state":"running"}}
{"type":"req","method":"chat.abort","params":{"sessionKey":"..."}}
```

**Hermes API Server**（hermes-agent.nousresearch.com）：

```bash
curl http://127.0.0.1:8642/v1/runs -H "Authorization: Bearer $API_SERVER_KEY" \
  -H "Idempotency-Key: feishu:oc_xxx:om_xxx" -H "X-Hermes-Session-Key: tenant:acme:feishu:group:oc_xxx" \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"..."}]}'
GET  /v1/runs/{run_id}/events   # SSE: tool.started, tool.completed, subagent.start/complete, assistant.delta, run.completed
POST /v1/runs/{run_id}/approval # 人工审批
POST /v1/runs/{run_id}/stop     # {"status":"stopping"}
GET  /v1/capabilities           # 机器可读能力描述（含 run_approval）
POST /api/sessions/{id}/fork    # 分叉
```

**Devin v3**：`POST /v3/organizations/{org_id}/sessions {prompt, devin_mode, attachment_urls, repos, max_acu_limit, resumable, create_as_user_id, bypass_approval, structured_output_schema}` → `{session_id, url, status, acus_consumed, pull_requests}`；`POST /v1/sessions/{id}/message`；附件通过 `POST /v1/attachments` 得 URL 后在 prompt 中以 `ATTACHMENT:"{file_url}"` 引用。

**跨平台抽象参考**：Vercel Chat SDK 已把"线程订阅 + 统一 post/stream + 分布式锁 + 平台能力降级"做成库（`new Chat({adapters, state: createRedisState()})`、`bot.onNewMention`、`thread.subscribe()`、`thread.post(stream)`），可作为我们网关 IM 适配层的设计参照。

## 会话模型

### sessionKey 设计（三种成熟方案）

1. **OpenClaw**：`agent:<agentId>:<channel>:<kind>:<id>[:topic|thread:<tid>]`，kind ∈ `group|channel|direct|slash`；`dmScope`/`groupScope` 全局 + route bindings 覆盖；`identityLinks` 合并跨渠道同一人。
2. **Hermes**：`ns:platform:chat_type_slot:[slack_scope_id]:[chat_id]:[thread_id]:[user_id]`，`group_sessions_per_user`（默认 True）决定是否在群 key 尾追加 user_id；`thread_sessions_per_user`（默认 False）线程共享；`gateway_routing` 表把 key 映射到当前活动 `session_id`（`YYYYMMDD_HHMMSS_<hex8>`），重置只换映射不丢历史（`parent_session_id` 链）。
3. **Claude Tag**：不暴露 key，但语义是 `{org}/{workspace}/{channel}` scope + `{thread}` session + `channel` 顶层 session；线程是"durable"，沙箱是"ephemeral"。

推荐我们采用 **两层键**：`route_key`（稳定，业务实体决定）→ `engine_session_id`（易变，重置/切引擎时换新），并在存储中保留 `parent_session_id` 链，这与 Hermes `gateway_routing` 表、OpenClaw `sessionId` 轮换、Claude Tag `!restart` archive 语义完全一致。

### 线程作为任务

- Slack 系产品统一：顶层 mention → 开线程 → 线程绑定 session；线程内回复默认送达（Claude Tag/Devin/Hermes `thread_require_mention: false`/OpenClaw `implicitMentions.threadParticipation`）。
- 飞书用 `thread_id (omt_*)` 或 `root_id (om_*)` 表示话题/回复链；钉钉群聊无原生线程（需以 `msgId` 引用或卡片承载）；企微无线程；Teams 频道有 reply chain（`conversation.id` 带 `;messageid=`），群聊没有。→ 网关必须提供 **"虚拟线程"** 抽象：无线程平台可退化为"同群 + 引用消息/卡片 ID"或按用户隔离。

### 共享 vs 隔离

| 策略 | 谁用 | 适用 |
|---|---|---|
| 每群一个共享 session | OpenClaw 默认、Claude Tag channel session、Hermes 线程 | 群协作、共同任务 |
| 每群每人一个 session | Hermes 群默认、飞书 OpenClaw `group_sender` | 群内各自问答、避免上下文污染 |
| 每话题一个 | Telegram forum topic、飞书 `group_topic`、Slack thread | 任务级隔离 |
| 观察不触发 | Hermes `observe_unmentioned_group_messages`、OpenClaw `unmentionedInbound: room_event`、Claude Tag 顶层阅读 | 群记忆/上下文积累 |

### 重置与过期

- OpenClaw：`daily(atHour 4)` / `idle(idleMinutes)`，二者取先到；`resetByType.group/thread` 细分；idle 只认真实用户交互。
- Hermes：`idle/daily/both/none`，后台进程存活时不重置（`bg_process_max_age_hours` 24h）；重置前保存记忆；被 issue #12857 指出重置后 `parent_session_id` 未存导致上下文丢失（说明"重置保留摘要"是常见需求，见 issue #5810）。
- Claude Tag：沙箱分钟级释放但 transcript 保留；channel session ~1h/~1d/配置变更。

### 并发（同群多人同时提问）

- 单 session 串行是共识：OpenClaw `session:<key>` lane 并发 1；Hermes `threading.Lock` + 每 session "running-agent slot"；Claude Tag 线程内多条回复被折叠进正在运行的 session（steer）。
- 到达中的消息处理策略：`steer`（下一次工具调用边界注入）、`followup`（排队下一轮）、`collect`（安静窗口合并，Discord 推荐）、`interrupt`（中止重跑，Hermes 默认）。
- 跨 session 并行受全局上限：OpenClaw `agents.defaults.maxConcurrent`、Hermes API `max_concurrent_runs: 10`（429）。
- 平台侧约束：Teams 单 chat 单流；Slack 流式 Tier 2；飞书 10 次/秒/卡片 → 网关要做 **每 (session, 出站消息) 的节流合并**（Chat SDK `streamingUpdateIntervalMs: 500`，Teams 建议缓冲 1.5–2s）。

## 权限与安全

1. **身份模型二选一并可共存**：
   - per-user 委托：Slack 用户 ↔ 引擎账号（OAuth / email 匹配 / `users:read`），用其个人仓库权限与配额（Claude Code in Slack、Codex、Cursor、Devin、Copilot）。优点是审计到人、权限天然最小；缺点是每人要 onboarding，且"谁触发谁付费"。
   - org 服务身份：Claude Tag 按 scope 挂 Access bundle，"What it can do never changes based on who asked"；凭据存 credential store，Agent Proxy 出站注入，默认 deny，非 HTTP 协议不可穿越。适合群共享工作，审计落在服务账号。
2. **触发权限**：Copilot 要求仓库 write 权限才能触发，但任何人可提供输入；Claude Tag Enterprise 可按角色限制（受限成员的 @ 得到私密提示，线程回复"message body is withheld"）；guest 与 Slack Connect 频道默认关闭。
3. **群级工具策略**：OpenClaw `groups."*".tools.deny: ["exec"]` + `toolsBySender."id:123".alsoAllow`，最具体优先、deny 恒胜；`sandbox.mode: "non-main"` 让群 session 进沙箱而 DM 在宿主。Hermes admin/user 两级命令白名单。
4. **Prompt injection**：Claude Code in Slack 文档明确"Claude may follow directions from other messages in the context"；OpenClaw 把群名/成员标签渲染为"fenced untrusted metadata"；Hermes 对观察消息加 per-turn safety prompt。网关应把历史/群元数据标记为 untrusted。
5. **危险操作审批**：Hermes `/approve|/deny`、`clarify` 600s 超时、API `POST /v1/runs/{id}/approval`；OpenClaw scope `operator.approvals`；Devin `bypass_approval`。审批请求应是网关统一事件。
6. **网络出口**：Claude Tag 三层 allow（connection allowed websites / bundle Domains / environment network level），私网与云 metadata 永远阻断。

## 扩展机制与资产

- **按 scope 配置的资产**：Claude Tag 的 Access bundle（credentials、Domains、Repositories、Plugins、Instructions 五个 tab）+ 每 channel 默认模型 + channel instructions（成员可编辑，可 Block）；线程启动时锁定 skills/plugins/instructions，connections 每请求生效。
- **OpenClaw**：`channels.<ch>.channels.<id>.systemPrompt / tools / toolsBySender`、`bindings[]{agentId, match{channel, guildId, roles}}` 按角色路由到不同 agent、`dynamicAgentCreation`（每用户独立 workspace/agent dir）。
- **Hermes**：`channel_overrides.<id>{model, provider, system_prompt}`、`channel_prompts`、`group_topics[].skill` 自动加载技能、`/personality`、`~/.hermes/status_phrases` 定制状态语。
- **Cursor**：routing rules（关键字→仓库）、channel default repo、`env=` 命名环境；**Devin**：playbook_id、knowledge_ids、secret_ids、snapshot；**Codex**：environment repo map。

→ 网关的"业务绑定"对象应包含：`engine`, `model`, `system_prompt/instructions`, `tools_policy`, `skills/plugins`, `credentials_bundle`, `repos`, `mention_policy`, `queue_mode`, `reset_policy`, `spend_limit`。

## 记忆

- Claude Tag：记忆属于 channel；公开 channel → workspace 共享；私有 channel → 自有 store（只读 workspace）；DM 单独；三种来源（用户明示、自动记录、回读历史 session）；管理员可查看/编辑 memory files；记忆是"curated note, not a transcript"。
- OpenClaw：Discord guild 频道**不自动加载** `MEMORY.md`，需 `memory_search/memory_get` 按需检索；`memory.search.rememberAcrossConversations` 跨私聊检索但不合并 transcript。
- Hermes：全平台共享一个 session store（SQLite `~/.hermes/state.db`，`messages_fts` 全文索引，`session_search` 工具）；`X-Hermes-Session-Key` 作为长期记忆 scope；重置前自动保存记忆。
- 群记忆的本质是 **scope 化的 KV/笔记**，而非 transcript；网关应定义 `memory_scope = tenant/group[/user]` 并在调用引擎时注入（作为 system prompt 片段或引擎原生记忆 key）。

## 多 Agent 与协作

- 多 bot 共群：Hermes `exclusive_bot_mentions`（`@a @b` 只路由到被点名的 bot）、OpenClaw `ignoreOtherMentions` / `agents.list[].groupChat.mentionPatterns`、Slack `allowBots`、飞书 `im:message.group_at_msg.include_bot:readonly` + `allowBots: true`。
- 任务分叉与交接：Claude Tag `!fork <prompt>` / `!fork #channel` 在新线程延续并互相链接；Claude Tag "hand-off to work already in progress"（顶层新信息转交正在运行的线程）；Hermes `/handoff <platform>`、`/bg`（隔离后台 session）、`POST /api/sessions/{id}/fork`。
- 子 agent 与线程绑定：OpenClaw `session.threadBindings {enabled, idleHours, spawnSessions, defaultSpawnContext: "fork"}` 把 Discord 线程绑定到 subagent；Hermes Runs API 暴露 `subagent.start/complete` 事件。
- 按角色路由不同 agent：OpenClaw `bindings[].match.roles`。

## 可观测性

- **Claude Tag**：admin Audit 页三 tab（Scheduled work / Memory / Network events——Agent Proxy 出站调用按小时 JSON 导出，不含 git/MCP）；usage 页按 channel 计费明细 + CSV；Compliance API 记录渠道管理员改动；每个 PR 链接回 Slack 线程；用户可见的 checklist 原地更新即是"任务级可观测"。
- **Slack 原生**：`task_update` chunks / plan mode 让工具进度成为一等 UI；`agents.sessions.setStatus`。
- **OpenClaw**：WS 请求携带 `traceparent`、`runId`、`sessionKey`；`diagnostics.lanes`；`/status` 显示上下文用量。
- **Hermes**：`display.tool_progress: off|new|all|verbose|log`（log 轮转到 `~/.hermes/logs/tool_calls.log` 并脱敏）；SSE `hermes.tool.progress`；delivery ledger；circuit breaker 自动暂停适配器并通知 home channel；`/health/detailed`。
- **平台限流可观测**：Discord `X-RateLimit-*` 头、Teams 429、飞书 10/s——网关需按 route 记录 429。

## 对我们架构的启示

### 推断的"真实业务系统"网关接口草案（HTTP + SSE；WebSocket 为可选等价）

**入站（业务 → 网关）** `POST /v1/assistant/messages`（幂等键 = 平台消息 ID）

```json
{
  "trace": { "trace_id": "4bf9…", "traceparent": "00-4bf9…-01", "request_id": "req_01H…" },
  "tenant": { "tenant_id": "acme", "platform": "feishu", "workspace_id": "cli_xxx", "app_id": "cli_xxx" },
  "conversation": {
    "type": "group",                       // group | dm | channel
    "group_id": "oc_5ce6d572455d3611",
    "thread_id": "omt_d4be107c616",        // 可空；无线程平台可空
    "root_message_id": "om_5ce6d5…",
    "title": "平台工程群", "member_count": 38
  },
  "user": { "user_id": "ou_84aad35d", "display_name": "Tom", "roles": ["member"],
            "identity": { "email": "tom@acme.com", "linked_engine_accounts": {"github": "tom"} } },
  "message": {
    "message_id": "om_5ce6d572…", "type": "text",
    "text": "@Assistant 查一下昨天的发布为什么慢",
    "mentions": [{ "key": "@_user_1", "id": "ou_bot", "is_bot": true }],
    "was_mentioned": true, "reply_to": null, "created_at": 1756867200000
  },
  "attachments": [{ "id": "file_x", "name": "trace.log", "mime": "text/plain", "size": 20480,
                    "url": "https://…/signed", "expires_at": 1756870800 }],
  "context": { "history_limit": 20,
               "history": [{ "user_id": "ou_1", "text": "…", "ts": 1756867100000, "trusted": false }] },
  "options": { "engine": "auto", "queue_mode": "steer", "stream": true,
               "reply_mode": "thread", "idempotency_key": "feishu:oc_5ce6…:om_5ce6…" }
}
```

**出站（网关 → 业务）** 响应 `text/event-stream`，事件类型（与 OpenClaw `chat.message`、Hermes Runs events、Slack chunks 对齐）：

```
event: session.started    data: {"session_id":"s_01H…","route_key":"acme:feishu:group:oc_5ce6…:thread:omt_d4be…","engine":"hermes","engine_session_id":"20260903_112233_a1b2c3d4","resumed":true}
event: status             data: {"phase":"thinking","text":"正在读取线程…"}                     // → Slack informative / Teams informative / 企微 stream 首帧
event: assistant.delta    data: {"text":"根据"}                                                  // 累积后节流 → 飞书 PUT content / Teams streaming
event: tool.started       data: {"tool_call_id":"t1","name":"exec","summary":"git log --since=…"}
event: tool.completed     data: {"tool_call_id":"t1","status":"ok","summary":"37 commits"}
event: task.update        data: {"task_id":"k1","title":"对比部署前后 p99","status":"completed"}  // → Slack task_update / Claude Tag checklist
event: approval.required  data: {"approval_id":"ap_1","action":"exec: kubectl rollout undo","risk":"high","expires_at":1756867800}
event: clarify.required   data: {"question":"哪个环境？","options":["prod","staging"],"timeout_s":600}
event: assistant.message  data: {"message_id":"m_9","text":"…","final":true,"format":"markdown"}
event: artifact           data: {"type":"pull_request","url":"https://github.com/…/pull/42"}
event: usage              data: {"input_tokens":12000,"output_tokens":800,"cost_units":0.034}
event: error              data: {"code":"ENGINE_RATE_LIMITED","message":"…","retryable":true}
event: done               data: {"stop_reason":"end_turn","session_id":"s_01H…"}
```

**管理面**

```
POST  /v1/approvals/{approval_id}            {"decision":"approve|deny","by":"ou_…"}
POST  /v1/sessions/{route_key}/reset         {"reason":"user_command","carry_summary":true}   // ≈ !restart / /new
POST  /v1/sessions/{route_key}/abort                                                       // ≈ chat.abort / runs/{id}/stop
GET   /v1/sessions?tenant=acme&group_id=oc_…                                              // ≈ sessions.list
PUT   /v1/bindings/{scope}                    {"scope":"tenant:acme:feishu:group:oc_…","engine":"opencode","model":"…",
                                               "instructions":"…","tools_policy":{"deny":["exec"],"by_sender":{"ou_admin":{"allow":["exec"]}}},
                                               "mention_policy":"mention|always|observe","session_scope":"group|group_sender|group_topic|group_topic_sender",
                                               "queue_mode":"steer","reset_policy":{"mode":"idle","idle_minutes":240},
                                               "spend_limit":{"period":"month","units":500},"credentials_bundle":"bundle_eng"}
GET   /v1/engines                             → [{"id":"hermes","capabilities":{...}}]          // ≈ Hermes /v1/capabilities
GET   /v1/engines/{id}/capabilities
GET   /v1/audit/events?tenant=acme&since=…    → tool 调用、审批、出站网络、spend
```

传输选择：入站 HTTP+SSE 最贴近 Hermes Runs / Devin；若业务系统需要双向（steer、abort、审批）且长连，则用 WebSocket 并沿用 OpenClaw `{type: req|res|event, id, method, params}` 帧；gRPC 仅在内部引擎适配层有必要（双向流 + 强类型）。

### 公共能力 vs 扩展能力映射表

| 能力 | 归类 | 各引擎/平台表现 | 网关侧参数 |
|---|---|---|---|
| 会话创建/恢复/重置/列举 | 公共 | OpenClaw `sessions.create/list`、Hermes `/api/sessions`、Devin `resumable`、Claude Tag `!restart` | `route_key`, `reset_policy` |
| 文本流式增量 | 公共 | `deltaText` / `assistant.delta` / `response.output_text.delta` | `stream: true`, 节流间隔 |
| 工具事件（start/complete） | 公共 | Hermes `tool.started/completed`、Slack `task_update`、Claude Tag checklist | `tool_progress: off|new|all` |
| 人工审批 / 澄清 | 公共 | Hermes approval、OpenClaw `operator.approvals`、Devin `bypass_approval` | `approval_timeout_s` (默认 600) |
| 中止 | 公共 | `chat.abort` / `runs/{id}/stop` / Teams Stop 按钮 | — |
| 历史上下文注入 | 公共 | OpenClaw `historyLimit`、Hermes `history_backfill_limit` 50、Slack 20/50 | `history_limit`, `context_visibility` |
| mention 门控 / 观察模式 | 公共（网关实现） | `requireMention`/`require_mention`/Claude Tag Respond automatically | `mention_policy` |
| 群会话粒度 | 公共（网关实现） | OpenClaw groupScope、Hermes per_user、飞书四档 | `session_scope` |
| 队列模式 | 公共 | OpenClaw `queue.mode`、Hermes `busy_input_mode` | `queue_mode`, `cap`, `debounce_ms` |
| 每 scope 指令/模型/工具策略 | 公共 | 全部支持 | `instructions`, `model`, `tools_policy` |
| 幂等/trace | 公共 | OpenClaw `idempotencyKey`/`traceparent`、Hermes `Idempotency-Key` | `idempotency_key`, `traceparent` |
| 用量/成本 | 公共 | Devin `acus_consumed`、Claude Tag per-channel spend | `spend_limit` |
| 附件 | 公共 | Devin `/v1/attachments`+`ATTACHMENT:`、Hermes 媒体 turn-scoped | 签名 URL + 过期 |
| 沙箱 per 线程 + 凭据代理注入 | 扩展（Claude Tag / Copilot / Cursor 云） | Agent Proxy、59 min 上限 | `environment`, `credentials_bundle` |
| Slack 原生 task card / plan mode | 扩展（平台） | `task_display_mode` | `native_task_cards` |
| 卡片流式（飞书 CardKit / 钉钉 AI Card / 企微 stream） | 扩展（平台） | 各自协议 | `streaming.mode: partial|block|progress|off` |
| Devin modes / Cursor inline options / Codex env 选择 | 扩展（引擎） | `!fast`、`repo= branch= autopr=`、env repo map | 透传 `engine_options` |
| 线程 fork / hand-off / handoff 跨平台 | 扩展（引擎） | Claude Tag `!fork`、Hermes `/handoff`、`/bg` | `fork_from` |
| 子 agent 线程绑定 / 角色路由 | 扩展（OpenClaw） | `threadBindings`、`bindings[].match.roles` | `agent_id` 选择 |
| 多用户动态 agent 实例 | 扩展（OpenClaw feishu `dynamicAgentCreation`、Hermes profiles） | 每用户独立 workspace | `workspace_template` |
| 身份链接（跨渠道同一人） | 扩展 | OpenClaw `identityLinks` | `identity.links` |
| 定时 routine / channel watch | 扩展（Claude Tag、Hermes `/api/jobs`） | — | `routines[]` |
| 群记忆 scope | 半公共 | Claude Tag channel/workspace、Hermes `X-Hermes-Session-Key` | `memory_scope` |

### 新引擎接入参数清单（能力识别 → 适配 → 认证）

1. 识别：是否有机器可读 capabilities（Hermes `/v1/capabilities`、Devin OpenAPI）；session 原语（create/resume/reset/fork）；流式事件种类；审批/澄清；附件方式；并发上限与 429 行为；幂等键；trace 透传。
2. 适配：`route_key → engine_session_id` 映射表；事件归一化器（引擎事件 → 上述 SSE 事件）；出站节流合并器（按平台限流）；静默 token 识别（`NO_REPLY`/`[SILENT]`）；重置时摘要携带。
3. 认证：per-user（OAuth/email 映射，配额记到人）或 org 服务身份（bundle + 出站代理）；工具策略按 scope 下发；审计落点。

### 风险与坑

- Teams **仅 1:1 支持流式**，群聊必须缓冲后一次发（Chat SDK 亦如此处理）；Slack channel 流式必须带 `recipient_user_id`；飞书流式是 **全量文本 + sequence**，不是增量，且 10/s；企微 stream 10 分钟内必须 finish；钉钉群聊只收 @ 且 `sessionWebhook` 会过期。
- Slack 编辑消息不产生通知（Claude Tag 文档强调"thread can look frozen"）；用户编辑消息不应触发新任务（Claude Tag 只发 note）。
- 群共享 session 的隐私：OpenClaw 明确"Alice's private messages would be visible to Bob"；Hermes 因此默认群内按人隔离；受限用户消息体需 withhold（Claude Tag）。
- 自动重置丢上下文（Hermes issue #12857/#5810）：重置应保留 `parent_session_id` 与摘要。
- 多 bot 共群互相触发：需 `exclusive_bot_mentions`/`ignoreOtherMentions`/`allowBots: none`。
- 平台限流与引擎限流叠加：按 route 记录 429 并做每 session 出站节流。
- 长任务与执行上限：Copilot 59 分钟、Teams 流 2 分钟、Claude Tag 沙箱空闲释放——长任务需"推分支/发草稿"作为持久化。

## 未解决问题

1. 钉钉 AI 卡片流式更新接口（`/document/orgapp/api-streamingupdate`）的精确字段（`outTrackId, guid, key, content, isFull, isFinalize, isError`）与 `flowStatus` 枚举未能从官方页（JS 渲染）抓到，需用浏览器或 SDK 源码核实。
2. 钉钉 AI 助理（AiPaaS）在群聊中的会话上下文是否与机器人 Stream 模式共用 `conversationId` 语义，官方概述页未抓到正文。
3. 飞书 Aily 开放 API（会话/技能调用）与群机器人的 session 关系仅见概述，未拿到字段。
4. Claude Tag 的"channel session 约 1 小时/1 天/100 条"为文档自述近似值，且产品处于 Public Beta，可能变化。
5. Codex/Cursor/Copilot 在 Slack 中的并发与速率限制均未在文档中说明。
6. OpenClaw `chat.send` 在群 session 下如何携带 sender 标签（多用户共享 session 的 `[name|id]` 前缀是否由网关注入）需读源码确认。
7. Hermes `thread_sessions_per_user` 在 Slack 适配器中文档称"无此键"，与 `session.py` 中的通用逻辑是否一致需核实版本。

## 来源列表

- https://code.claude.com/docs/en/slack
- https://claude.com/docs/claude-tag/overview
- https://claude.com/docs/claude-tag/concepts/how-it-works
- https://claude.com/docs/claude-tag/concepts/agent-identity
- https://claude.com/docs/claude-tag/concepts/security-and-data
- https://claude.com/docs/claude-tag/users/memory
- https://claude.com/docs/claude-tag/users/when-claude-responds
- https://claude.com/docs/claude-tag/users/commands
- https://claude.com/docs/claude-tag/admins/restrict-access
- https://claude.com/docs/claude-tag/admins/audit
- https://learn.chatgpt.com/docs/third-party/slack （由 https://developers.openai.com/codex/integrations/slack 重定向）
- https://cursor.com/docs/integrations/slack
- https://docs.devin.ai/integrations/slack
- https://docs.devin.ai/api-reference/v1/overview
- https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions
- https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent
- https://docs.github.com/en/copilot/how-tos/copilot-integrations/integrate-cloud-agent-with-slack
- https://github.blog/changelog/2026-08-21-the-new-github-copilot-experience-in-slack/
- https://docs.slack.dev/ai/developing-agents/
- https://docs.slack.dev/reference/methods/chat.startStream
- https://slack.dev/slack-thinking-steps-ai-agents/
- https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux
- https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations
- https://open.feishu.cn/document/server-docs/im-v1/message/events/receive
- https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
- https://open-dingtalk.github.io/developerpedia/docs/learn/stream/protocol
- https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/overview/
- https://open-dingtalk.github.io/developerpedia/docs/explore/tutorials/stream/bot/go/card-callback/
- https://raw.githubusercontent.com/open-dingtalk/dingtalk-card-examples/main/README.md
- https://developer.work.weixin.qq.com/document/path/101463
- https://developer.work.weixin.qq.com/document/path/101031
- https://docs.discord.com/developers/topics/rate-limits
- https://docs.openclaw.ai/channels/groups
- https://docs.openclaw.ai/concepts/session
- https://docs.openclaw.ai/concepts/queue
- https://docs.openclaw.ai/channels/discord
- https://docs.openclaw.ai/channels/slack
- https://docs.openclaw.ai/channels/feishu
- https://docs.openclaw.ai/gateway/protocol
- https://hermes-agent.nousresearch.com/docs/user-guide/messaging/
- https://hermes-agent.nousresearch.com/docs/user-guide/sessions
- https://hermes-agent.nousresearch.com/docs/user-guide/messaging/discord
- https://hermes-agent.nousresearch.com/docs/user-guide/messaging/slack
- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/messaging/telegram.md
- https://raw.githubusercontent.com/NousResearch/hermes-agent/main/gateway/session.py
- https://github.com/agentscope-ai/QwenPaw/issues/1117
- https://chat-sdk.dev/docs
- https://chat-sdk.dev/docs/streaming
