# G04 通用网关规范与 opencode server API 契约的逐项对照（评测接口的真实来源）

## 摘要
本专题以 opencode（GitHub: anomalyco/opencode，原 sst/opencode，dev 分支实测，2026-09）当前源码为一手依据，逐项核对了赛题"通用 Agent 网关规范"的接口契约。结论：赛题规范的端点形态（`POST /session`、`GET /session/status`、`POST /session/{id}/prompt_async`、`GET /session/{id}/message`、`POST /session/{id}/abort`、`GET /event` SSE）**在路径命名和整体范式上高度贴近 opencode 真实 server API**，但存在若干**关键语义落差**：(1) opencode 原生 `prompt_async` 是立即返回 204 的真异步端点，赛题把它重新定义为"HTTP 阻塞直到本轮结束才返回 204"，网关适配层必须自己用 SSE `session.status: idle` 做挂起，不能透传；(2) `directory` 在 opencode 是 query 参数而非赛题所写的 body 字段；(3) 权限回复端点实际嵌套在 `/session/{id}/permissions/{permissionID}`，事件名是 `permission.updated`（非 `permission.asked`，后者是滞后的文档旧称）；(4) `finish` 枚举实际有 6 个值（多 `content-filter`/`unknown`）；(5) `Part` 类型实际有 12 种（多 `snapshot/patch/agent/retry/compaction/subtask`）。"MyAgent 网关规范"（端口 3008 等）未检索到任何公开资料，判定为内部私有系统，从其路径命名（`/v1/config/opencode/session/{id}/message`）可推断其内部确实转发到某个 opencode 实例。报告给出了完整字段级契约、事件命名空间、公共能力/扩展能力映射表以及 5 条关键接入风险提示。

## 关键事实（表格：事实 | 来源 | 置信度 | 是否交叉验证）

| 事实 | 来源 | 置信度 | 交叉验证 |
|---|---|---|---|
| opencode server 默认端口 4096（非赛题的 6217，赛题端口是竞赛方自定的评测端口约定） | opencode.ai/docs/server/ | 高 | 是（与 GitHub 源码 SDK types 一致） |
| `POST /session` body `{parentID?, title?}`，赛题规范写的是 `{title, directory}` —— `directory` 实际是**查询参数** `?directory=`，不是 body 字段；`title` 才是 body 字段 | packages/sdk/js/src/gen/types.gen.ts (`SessionCreateData`) | 高 | 是（opencode.ai/docs/server 摘要与源码一致） |
| `GET /session/status` 返回 `{[sessionID]: SessionStatus}`，`SessionStatus` 是判别联合 `{type:"idle"}` \| `{type:"busy"}` \| `{type:"retry", attempt, message, next, action?}`，比赛题描述的简单 `idle|busy` 多一个 `retry` 状态 | packages/sdk/js/src/gen/types.gen.ts；packages/schema/src/session-status-event.ts | 高 | 是 |
| `POST /session/{id}/message`（同步/阻塞）返回 `200 {info: AssistantMessage, parts: Part[]}`；`POST /session/{id}/prompt_async` 返回 `204 No Content`，语义上"受理但不等待"——真正的"阻塞直到本轮结束"发生在**同步** `/message` 端点，而非 `prompt_async`（`prompt_async` 立刻 204，之后要靠 SSE `/event` 或轮询 `GET /session/{id}/message` 得知完成） | packages/sdk/js/src/gen/types.gen.ts (`SessionPromptData`, `SessionPromptAsyncData`) | 高 | 是（GitHub issue #26635 "prompt_async silently discards requests" 印证该端点存在且异步） |
| `GET /event`（v1，SDK 生成路径 `/event`）与实验性 v2 路径 `/api/event` 并存；SSE 首帧固定发送 `server.connected`，随后每 10 秒发送一次 `server.heartbeat`（不是裸 `heartbeat`） | packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts；packages/opencode/src/server/routes/instance/httpapi/groups/event.ts | 高 | 是（与 GitHub issue #26697 "closes immediately after server.connected" 印证） |
| `Message.finish` 字段的真实枚举值为 `FinishReason = "stop" \| "length" \| "tool-calls" \| "content-filter" \| "error" \| "unknown"`，不是赛题列出的 `stop/tool-calls/length/error` 四项（真实多了 `content-filter` 和 `unknown`） | packages/llm/src/schema/ids.ts | 高 | 是（多个协议适配文件 openai-chat.ts/bedrock-converse.ts 中的 mapFinishReason 实现与 e2e fixture 中 `finish: "stop"` 交叉印证） |
| `Part` 联合类型包含 `text/reasoning/file/tool/step-start/step-finish/snapshot/patch/agent/retry/compaction/subtask` 共 12 种（比赛题列出的 text/tool/step-start/step-finish/reasoning/file 更丰富） | packages/sdk/js/src/gen/types.gen.ts | 高 | 是 |
| `question.asked` / `question.replied` / `question.rejected` 是**真实存在**的事件与工具能力（"Question" 工具让 Agent 在执行中向用户提问/多选，会阻塞该 session 直到回答或拒绝），路由为 `GET /question`、`POST /question/{requestID}/reply`、`POST /question/{requestID}/reject`，与赛题描述的 `/question` 端点存在但细节不同（赛题写成单一 `/question`，真实是三个子路由） | packages/schema/src/v1/question.ts；packages/sdk/js/src/v2/gen/types.gen.ts | 高 | 是（GitHub issue #9865 "expose plan metadata via question.asked event" 与 #17920 "Question tool hangs in ACP mode" 印证功能真实存在） |
| Permission 回复端点是 `POST /session/{id}/permissions/{permissionID}`（**嵌在 session 下**，且路径是复数 `permissions`），body `{response: "once"\|"always"\|"reject"}`，与赛题笼统写的顶层 `/permission` 不同 | packages/sdk/js/src/gen/types.gen.ts (`PostSessionIdPermissionsPermissionIdData`) | 高 | 是 |
| `AssistantMessage` 携带 `cost: number` 与 `tokens: {input, output, reasoning, cache:{read, write}}`，`step-finish` part 同样携带一份独立的 `cost`/`tokens`（每步一份，用于多步 LLM 调用的分段计费/计量） | packages/sdk/js/src/gen/types.gen.ts | 高 | 是 |
| opencode 项目仓库已从 `sst/opencode` 迁移/更名为 `anomalyco/opencode`（Anomaly Innovations，原 SST 团队），当前主开发分支为 `dev` | GitHub 搜索结果 + github.com/anomalyco/opencode | 中 | 否（未找到官方迁移公告原文，仅凭 issue 引用与仓库现状推断） |
| "MyAgent 网关规范"（端口 3008 等）未检索到任何公开资料，判断为竞赛内部/私有业务系统，非开源项目 | 多次 WebSearch 无结果 | 高（关于"无公开资料"这一结论） | 不适用 |

## 架构与工作原理

opencode server 是一个可独立运行的 HTTP+SSE 服务（`opencode serve --port <n>`，默认 4096），底层用 Hono 构建路由（较老实现）/当前主分支已迁移到 Effect 生态的 `HttpApiBuilder`（`packages/opencode/src/server/routes/instance/httpapi/...`），并自动生成 OpenAPI 3.1 规范，可在 `http://localhost:<port>/doc` 查看。核心分层：

- **Instance 层**（`InstanceState`/`InstanceContextMiddleware`）：一个 server 进程可以对应一个"instance"（工作目录/workspace 维度），事件流按 `directory`/`workspaceID` 过滤，这意味着 opencode 原生就支持"同进程多工作目录/多项目"的隔离维度，这与题目要求的"群会话隔离"在概念上是同构的（可以把"群"映射为 opencode 的 workspace/directory 维度，也可以映射为 session 维度）。
- **Session 层**：`Session`（`id, projectID, directory, parentID?, title, version, time, revert?, share?, summary?`）是最小的会话单元，`parentID` 支持父子 session（子任务/subagent），子 session 天然具备独立的消息历史但可以在事件流中通过 `parentID` 关联，`session.status` 事件也在讨论加入 `parentID` 以区分子 agent 会话（GitHub issue #30043 仍是 open 状态，说明这是已知的、尚未完全解决的可观测性缺口）。
- **消息/事件双通道**：opencode 同时暴露"轮询/一次性拉取"（`GET /session/{id}/message`、`GET /session/{id}/message/{messageID}`）与"服务器推送"（`GET /event` 全局 SSE，事件按 `location.directory` 过滤后下发给对应连接）。这是赛题"HTTP 阻塞 + SSE 推送"双通道语义的直接来源——但要注意：opencode 的"阻塞"发生在**同步** `POST /session/{id}/message`，而 `prompt_async` 是**立即返回 204**，"阻塞直到本轮结束"这一具体语义（HTTP 挂起直到完成才返回）在 opencode 原生 API 里没有单独端点提供；赛题把 `prompt_async` 重新定义为"HTTP 阻塞直到本轮完整结束才返回 204"，这是赛题对 opencode 语义的**改造**，不是照搬（详见"对我们架构的启示"一节的踩坑提示）。
- **Bus/事件总线**：内部使用一个全局 `EventV2Bridge`/`GlobalBus`，各子系统（session、message、permission、question、tool、lsp、mcp、installation 等）各自 `define` 事件类型并注册进 `EventManifest`/`inventory`，事件在 SSE 层统一序列化为 `{id, type, properties}` 并通过 `Sse.Event` 包装为 `event: message` 的 SSE 帧（注意：SSE 帧的 `event:` 字段固定是 `"message"`，真正的事件类型在 JSON payload 的 `type` 字段里，客户端需要解析 payload 而不能靠 SSE 的 `event:` 字段路由）。

## 可编程接入面

### Session 端点（`packages/sdk/js/src/gen/types.gen.ts`，2026-09 dev 分支实测）

```
GET    /session                       # 列出 sessions（query: directory?）
POST   /session                       # body: {parentID?, title?}  query: directory?  → 200 Session
GET    /session/status                # query: directory? → 200 {[sessionID]: SessionStatus}
GET    /session/{id}                  # → Session
PATCH  /session/{id}                  # 更新 title 等
DELETE /session/{id}                  # 删除 session 及全部数据
GET    /session/{id}/children         # 子 session 列表
GET    /session/{id}/todo             # 任务清单
POST   /session/{id}/init             # 初始化（AGENTS.md 分析等）
POST   /session/{id}/fork             # 复制会话
POST   /session/{id}/abort            # → 200 boolean（是否成功中止）
POST   /session/{id}/unshare, /share  # 分享控制
GET    /session/{id}/diff             # 代码 diff 汇总
POST   /session/{id}/summarize        # 手动摘要/压缩上下文
GET    /session/{id}/message          # query: limit? → 200 Array<{info: Message, parts: Part[]}>
GET    /session/{id}/message/{messageID}  # → 200 {info: Message, parts: Part[]}
POST   /session/{id}/message          # 同步/阻塞：body见下 → 200 {info: AssistantMessage, parts: Part[]}
POST   /session/{id}/prompt_async     # 同 body，异步：→ 204 No Content（立即返回，不等待完成）
POST   /session/{id}/command          # 执行内置 slash-command
POST   /session/{id}/shell            # 执行 shell
POST   /session/{id}/revert, /unrevert# 撤销/恢复文件改动
POST   /session/{id}/permissions/{permissionID}  # body: {response: "once"|"always"|"reject"} → 200 boolean
```

`POST /session/{id}/message` 和 `/prompt_async` 的公共 body：
```ts
{
  messageID?: string
  model?: { providerID: string; modelID: string }
  agent?: string                 // 选择内置/自定义 agent（如 "plan"/"build"）
  noReply?: boolean
  system?: string                // 覆盖/追加 system prompt
  tools?: { [key: string]: boolean }  // 按名启用/禁用工具
  parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>
}
```

### 全局/其他端点（部分列举，供接入面参考）
`GET /event`（v1 SSE，本文重点）、实验性 `GET /api/event`（v2）、`GET /question`、`POST /question/{requestID}/reply`、`POST /question/{requestID}/reject`、`GET /file/status`、`GET /mcp/status`、`GET /lsp/status`、`GET /formatter/status`，以及面向 TUI 的 `POST /tui/append-prompt`、`/tui/open-sessions`、`/tui/submit-prompt`、`/tui/clear-prompt`（这些是 TUI 专用内部端点，不建议网关层依赖）。

### CLI / 启动参数
`opencode serve --port 4096 --hostname 0.0.0.0`（headless server 模式）；`opencode` 本体也可通过 `--print-logs`、`--model provider/model`、环境变量注入自定义 OpenAI/Anthropic 兼容端点（`ANTHROPIC_BASE_URL`、`OPENAI_BASE_URL`/自定义 provider 配置写入 `opencode.json` 的 `provider` 字段，这一点与本赛题"主模型限定为内部部署模型、要求自定义端点"的硬约束高度契合，opencode 的 provider 抽象层原生支持自定义 baseURL + apiKey 的 OpenAI 兼容/Anthropic 兼容 provider）。

## 会话模型

- `Session` 核心字段：`id, projectID, directory, parentID?, title, version, time{created,updated,compacting?}, revert?{messageID,partID?,snapshot?,diff?}, share?{url}, summary?{additions,deletions,files,diffs?}`。
- 会话与"目录/项目"强绑定（`directory` 是必填字段，`projectID` 由目录推导），这意味着 opencode 原生把"session 隔离"实现为"目录级隔离 + sessionID 级隔离"两层——网关如果要用同一个 opencode 实例服务多个群/多个业务线，需要用不同的 `directory`（工作目录）区分，或者每个群一个独立 session（同目录内 sessionID 隔离历史，但工具执行的文件系统作用域仍共享同一 `directory`）。**这是一个关键坑**：若网关把"群"映射为纯粹的 sessionID 隔离而不区分 `directory`，同一 opencode 实例下多个群的 shell/文件工具调用会共享同一个工作目录，产生跨群文件污染风险。
- `parentID` 支持父子会话（子任务/subagent 场景），子会话有独立的消息流，但要靠 `parentID` 回溯归属；`session.status` 事件目前**不携带** `parentID`（GitHub issue #30043 仍 open），网关如果要归一化"多 agent 编排事件"，需要自己从 `GET /session/{id}` 或 `GET /session/{id}/children` 补拉父子关系，不能只靠 SSE 事件流。
- 会话状态机：`SessionStatus = {type:"idle"} | {type:"busy"} | {type:"retry", attempt, message, next, action?}`。`retry` 状态用于 provider 限流/重试场景（`action` 里带 `reason/provider/title/message/label/link`，可直接渲染成给终端用户看的重试提示条），这是赛题简化的 `idle|busy` 二态模型之外的第三态，网关若要精确反映真实进度，应该把 `retry` 映射为一种"busy 的子状态"并向上透出重试次数，而不是直接丢弃。
- 会话删除是硬删除（`DELETE /session/{id}` 删除该 session 的全部消息数据），无原生"归档"语义，网关如果需要审计留痕，必须在网关自己的存储层做消息镜像，不能依赖 opencode 的删除接口做软删除。

## 权限与安全

- 权限模型以工具调用为中心：`Permission {id, type, pattern?, sessionID, messageID, callID?, title, metadata, time{created}}`，当某个工具调用命中需要审批的规则时，服务端发布 `permission.updated` 事件（旧文档口径为 `permission.asked`，两者语义相同，是命名上的新旧差异——**这是一个需要交叉确认的分歧点**：SDK types.gen.ts 里是 `permission.updated`/`permission.replied`，而 plugins.mdx 文档仍写 `permission.asked`/`permission.replied`，判断为文档滞后于最新的 SDK 生成代码，接入时应以运行时实际吐出的事件名为准，不要死记文档）。
- 客户端通过 `POST /session/{id}/permissions/{permissionID}` 回复，body `{response: "once"|"always"|"reject"}`：`once` 仅放行这一次，`always` 记忆规则后续同类调用自动放行，`reject` 拒绝。回复后端会发 `permission.replied {sessionID, permissionID, response}` 事件。
- 权限粒度基于 `pattern`（可以是单个 glob 或数组），说明底层权限系统是"工具名 + 参数模式匹配"的规则引擎，而不是简单的"允许/禁止某个工具"，这对我们网关设计"权限限制"能力时是一个重要参考：细粒度权限应该允许"按参数模式"而不仅是"按工具名"授权。
- Question 机制（`question.asked/replied/rejected`，路由 `GET /question`、`POST /question/{requestID}/reply`、`POST /question/{requestID}/reject`）本质上是"面向用户的结构化多选提问"，与 Permission（面向工具调用的审批）是两条独立但结构相似的"人机协同阻塞点"，两者都会在完成前让 session 保持 busy/挂起状态，网关做统一可观测协议时应该把这两类事件都视为"需要人工介入才能继续"的信号，归一化成同一个上位概念（如 `interaction.required`），并分别透出 `kind: "permission"|"question"` 区分。
- 认证：opencode server 默认不强制鉴权（本地回环场景），但路由组里挂了 `Authorization` middleware（`middleware/authorization`），说明可以配置鉴权（具体机制文档未细查，超出本次调研预算，留待 open question）。

## 扩展机制与资产

- **插件系统**：JS/TS 插件放在 `.opencode/plugins/`（项目级）或 `~/.config/opencode/plugins/`（全局），或以 npm 包形式在 `opencode.json` 中声明（启动时用 Bun 自动安装）。插件函数签名 `async ({project, client, $, directory, worktree}) => ({...hooks})`，可订阅的钩子类别覆盖：`command.executed`、`file.edited`/`file.watcher.updated`、`tool.execute.before/after`、`session.created/idle/updated`、`message.updated/removed`、`permission.asked/replied`、`shell.env`、`tui.prompt.append`/`tui.toast.show` 等，并可通过 `tool(...)` 助手注册自定义工具（`args` 用 zod 风格 schema、`execute(args, context)`）。
- 这套"进程内插件 + 事件钩子 + 自定义工具"的扩展机制是 opencode 特有的**扩展能力**，不属于跨引擎可归一化的公共能力——它要求引擎进程本身支持加载脚本/npm 包，Claude Code、Codex 等引擎未必有等价机制（Claude Code 有 hooks.json + MCP，Codex 目前主要靠 MCP）。网关层若要统一暴露"自定义工具/插件"能力，应该把它作为"引擎扩展能力"字段单独声明，而不是假设所有引擎都有。
- **资产/配置**：项目级 `opencode.json`（含 provider、agent、MCP server 声明等）、`.opencode/package.json`（插件依赖）、`AGENTS.md`（项目上下文/系统提示词文件，`session/{id}/init` 会分析它）。这与 Claude Code 的 `CLAUDE.md`、Codex 的 `AGENTS.md`（Codex 实际也采用 AGENTS.md 标准）在概念上是同构的"仓库级系统提示词文件"，是可以在网关层统一抽象为"AI 资产：project instructions file"的公共能力，只是文件名不同（`AGENTS.md` 已经成为多引擎事实标准，Codex、opencode 均用此名，Claude Code 用 `CLAUDE.md` 但支持 `@AGENTS.md` 之类的 import）。

## 记忆

opencode 本身没有独立的"长期记忆/向量库"子系统（未在本次调研中发现相关端点或 schema），其"记忆"更多体现为：
1. **会话内**：`AGENTS.md` 提供的项目级持久上下文（不是运行时学习，而是静态文件）；
2. **会话摘要/压缩**：`session.summarize`、`session.time.compacting` 字段，以及 `message.compaction` part（`type:"compaction", auto: boolean`）——说明 opencode 有"上下文自动压缩"机制，但这是"上下文管理"而非"跨会话记忆"；
3. **Share/Revert**：`session.share`/`session.revert` 提供的是协作与版本控制语义，也不是记忆系统。
结论：opencode 无原生跨会话记忆能力，若我们的架构需要"统一记忆模型"，这部分需要在网关层自建（例如把每次 session 的摘要写入网关自己的记忆库，下次创建新 session 时作为 system prompt 或首条消息注入），不能指望所有引擎都原生提供记忆 API。

## 多 Agent 与协作

- **子任务/子会话**：`SubtaskPartInput`（消息输入 part 类型之一）+ `Session.parentID` 构成"父 session 派发子 session 执行子任务"的机制，这是 opencode 版本的"Task 工具/subagent"能力（对应 Claude Code 的 Task tool、其它引擎的 "sub-agent"/"agent team" 概念）。
- **AgentPart**（`type:"agent", name, source?`）：消息 part 里可以携带"这段内容是由哪个具名 agent（如 build/plan 等内置或自定义 agent 角色）产生"的标注，说明 opencode 的"agent"是一种可切换的角色/模式配置（模型、工具集、系统提示词的一组预设），而不是独立进程；这与题目提到的"agent team"、"自进化"等引擎特有能力不同——opencode 的多 agent 更接近"单进程内的角色切换 + 子会话派生"，没有发现独立的"多 agent 实时协作/群聊室（room）"式原语。
- 子会话有独立的消息历史、可以在事件流中被单独订阅，但目前无法从 `session.status` 事件直接得知其父子关系（issue #30043 待修），网关做子任务可观测归一化时需要主动查 `GET /session/{id}/children` 或 `GET /session/{id}` 的 `parentID` 字段来重建父子拓扑。
- 结论：opencode 的"多 agent"应归为**部分公共能力**（子任务/子会话模式，多数现代引擎都有等价物：Claude Code 的 Task tool、Codex 的类似机制），而"具名 agent 角色预设"（`agent` 参数选 build/plan 等）则是**引擎特有的扩展能力**，需要在能力协商阶段声明该引擎支持哪些 agent 角色名。

## 可观测性

- **事件命名空间**已知类别（截至 dev 分支实测）：`server.connected`、`server.heartbeat`、`server.instance.disposed`、`installation.updated`、`installation.update-available`、`lsp.client.diagnostics`、`lsp.updated`、`session.created`、`session.updated`、`session.deleted`、`session.status`（含 idle/busy/retry）、`session.idle`（**deprecated**，仅为兼容保留，新代码应订阅 `session.status`）、`session.diff`、`session.error`、`message.updated`、`message.removed`、`message.part.updated`（带 `delta?` 增量文本）、`message.part.removed`、`permission.updated`、`permission.replied`、`question.asked`、`question.replied`、`question.rejected`、`file.watcher.updated`、`command.executed`、`tool.execute.before/after`（插件钩子专用，未必是 SSE 事件）、`shell.env`。
- **多步 LLM 调用的边界**由 `step-start`/`step-finish` part 显式标注：一次 assistant 回复内部可能有多个"step"（例如：LLM 输出文本→调用工具→再次调用 LLM 继续），`step-finish.reason` 取值即 `FinishReason`（`stop/length/tool-calls/content-filter/error/unknown`），`step-finish` 还携带该 step 独立的 `cost` 与 `tokens{input,output,reasoning,cache:{read,write}}`，是做"分步计量/成本核算"的关键锚点。`AssistantMessage.finish` 是**整条消息**（可能包含多个 step）的最终归纳结果，`finish` 字段与其类型定义中的 `finish?: string` 在 SDK 类型层是宽松 string（未强类型枚举），但运行时取值集合与 `FinishReason` 一致。
- **Tool 调用关联**：`ToolPart {id, sessionID, messageID, type:"tool", callID, tool, state}`，`state` 是判别联合 `pending|running|completed|error`，各态携带 `input`（running 起才有）、`output`（仅 completed）、`time{start,end?}`，`callID` 是跨状态更新同一次工具调用的关联键（多次 `message.part.updated` 事件会用相同 `id`/`callID` 更新同一个 tool part 的状态机，客户端应以 `id` 做 upsert，而不是每次都当新 part 追加）。
- 无原生 OpenTelemetry/OTel 导出的直接证据（本次调研未发现 opencode 自带 OTel exporter），可观测性主要靠自有事件总线 + SSE，网关如果要接入企业级 APM/OTel，需要自己订阅 SSE 后转换成 OTel span/event。

## 对我们架构的启示（公共能力 vs 扩展能力映射表、接入参数、风险与坑）

### 公共能力（可跨引擎归一化，映射到"通用 Agent 网关规范"）

| 通用网关概念 | opencode 原生对应 | 备注 |
|---|---|---|
| `POST /session {title, directory}` | `POST /session {parentID?, title?}` + query `directory?` | **赛题把 opencode 的 query 参数 `directory` 挪进了 body**，接入 opencode 时网关适配层要做参数搬运，不能透传 |
| `GET/DELETE /session/{id}` | 完全一致 | 直接透传 |
| `GET /session/status`（idle\|busy） | `GET /session/status` 返回 map，值域含第三态 `retry` | 网关状态机需要能容纳/降级 `retry`→`busy` |
| `POST /session/{id}/prompt_async`（阻塞直到本轮结束，204） | opencode 原生 `prompt_async` 是**立即** 204，真正的"阻塞版"是同步 `POST /session/{id}/message` | **关键落差**，见下方"风险与坑" |
| `GET /session/{id}/message`（完整轨迹） | 完全一致（`Array<{info, parts}>`），支持 `limit` 分页 | 直接可用 |
| `POST /session/{id}/abort` | 完全一致，返回 `boolean` | 直接透传 |
| `GET /event` SSE：`server.connected/heartbeat` | `server.connected` + `server.heartbeat`（10s 间隔） | 事件名几乎一致，只是心跳事件名是 `server.heartbeat` 不是裸 `heartbeat` |
| `session.status`/`session.idle` | 一致，但 `session.idle` 已标记 deprecated，权威事件是 `session.status` | 网关应订阅 `session.status`，把 `session.idle` 当兼容旁路 |
| `message.part.updated` | 一致，且带增量 `delta?` 字段用于流式文本 | 可直接用于打字机效果 |
| `permission.asked` | 真实事件名是 `permission.updated`（文档口径滞后） | 适配层要做事件名重命名 |
| `question.asked` | 完全一致（`question.asked/replied/rejected`） | 直接可用，但注意路由是三个独立端点 |
| Message/Part 归一化模型（text/tool/step-finish/finish=stop） | 基本一致，opencode 实际有 12 种 part、6 种 finish 枚举 | 我们的归一化模型应按"opencode 超集"设计，其余引擎的原生事件降级映射进这个超集，而不是反过来阉割 |

### 引擎特有扩展能力（不应假设其它引擎都有）

- 进程内插件系统（JS/TS 钩子 + 自定义工具注册，`.opencode/plugins/`）；
- 具名 agent 角色预设（`agent: "build"|"plan"|...`）与按名启停工具集（`tools: {[name]: boolean}`）；
- `session.revert`/`session.share`（版本回退、公开分享链接）；
- `session.command`/`session.shell`（内置 slash-command 与直接 shell 执行的专用端点，而不是把它们伪装成普通工具调用）；
- Question 工具（结构化多选提问，阻塞等待用户选择）——这是**可以归一化**但目前只有 opencode 明确原生支持的能力，Claude Code/Codex 是否有等价物需要在对应专题里核实，若无则应作为"扩展能力"声明，网关侧对不支持的引擎做降级（例如把 question 自动转成一条文本追问，走普通对话轮次）。

### 接入 opencode 引擎所需参数（供"能力识别→适配→认证"流程参考）

1. 启动：`opencode serve --port <n> --hostname 0.0.0.0`（Windows 下需确认 Bun/Node 运行时可用性与原生编译产物是否支持 Windows，本专题未验证，属于风险点，建议由部署/Windows 专题交叉核实）；
2. Provider 配置：在 `opencode.json` 声明自定义 `provider`（baseURL + apiKey，兼容 OpenAI/Anthropic 协议），满足赛题"内部模型端点"约束；
3. 会话创建时补齐 `directory`（工作目录，建议网关为每个"群/业务会话"分配独立目录以做真正的文件系统隔离，而不仅是 sessionID 隔离）；
4. 事件适配：SSE 消费端做事件名重映射表（`permission.asked→permission.updated`、`session.idle`兼容旁路等）；
5. 权限策略：网关可以预注册 `always`/`reject` 规则模拟"群权限限制"，或拦截 `permission.updated` 事件后按群配置自动回复，无需暴露给终端用户。

### 风险与坑（给评测适配层的提醒）

1. **"prompt_async 阻塞语义"的落差是最大风险**：赛题规范要求 `prompt_async` 本身 HTTP 挂起直到本轮结束才返回 204，而 opencode 原生 `prompt_async` 立即返回。若直接把 opencode 的 `prompt_async` 端点透传给评测框架，评测程序会在极短时间内收到 204 后就去拉 `message`，但此时本轮可能尚未开始/未完成，导致误判"已完成"。**适配方案**：网关层需要自己实现"挂起"——调用 opencode 的 `prompt_async`（或同步 `message`）后，本地订阅该 session 的 SSE，直到收到 `session.status:{type:"idle"}` 才让网关自己的 HTTP 响应返回 204，而不是简单透传 opencode 原始响应。
2. **事件名版本漂移**：`permission.asked` vs `permission.updated`、`session.idle`(deprecated) vs `session.status`，都提示 opencode 的事件命名在快速演进，网关适配层必须对"多个别名事件"做兼容监听，并以最新 SDK 生成的 `types.gen.ts`（而非旧文档）为准，建议在 CI 里定期用 opencode 官方 SDK 包生成的类型做契约测试。
3. **directory 语义两用**：`directory` 既是"隔离边界"又是"文件系统工作目录"，网关如果偷懒复用同一目录服务多个群，工具执行（写文件、shell）会互相污染，必须为每个业务会话分配独立工作目录。
4. **finish 枚举比赛题多两个值**（`content-filter`、`unknown`），网关归一化层的 `finish` 字段类型定义要覆盖这两个值，否则遇到内容审核拦截或未知错误时会归一化失败/丢字段。
5. **Windows 可运行性未在本专题验证**：opencode 底层依赖 Bun（用于插件安装等），赛题环境是 Windows 10/11，Bun 在 Windows 上的支持成熟度、以及 opencode 官方是否发布 Windows 原生二进制，需要单独专题核实（不在本专题范围内，见"未解决问题"）。

## 未解决问题

1. "MyAgent 网关规范"（端口 3008、`/v1/agents`、`BridgeEvent`、`/v1/config/opencode/session/{id}/message`、`/chat/pause` 等）完全未检索到公开资料，无法判断它是否是本赛题参考的"真实业务系统"本身、还是某内部代码库的一部分；只能推断它可能是一层封装在 opencode 之上的私有网关（从 `/v1/config/opencode/session/{id}/message` 路径推测其内部确实转发到了某个 opencode 实例的 `/session/{id}/message`），但无法验证。建议：若参赛方能拿到赛题方提供的参考业务系统源码（选项 2 提到的"赛题参考的真实业务系统内源代码"），应直接阅读该代码而非依赖公开检索。
2. opencode server 的鉴权机制（`Authorization` middleware）细节未深入，包括是否支持 API Key/Bearer token、多租户隔离方式。
3. opencode 在 Windows 上原生运行的成熟度（Bun 依赖、二进制发布形式）未核实，需要交给部署/环境专题。
4. `permission.asked` 与 `permission.updated` 的关系是"重命名"还是"两套并行事件"未能通过源码 100% 确认（只看到 SDK types 用 `permission.updated`、旧文档用 `permission.asked`），存在被误判的风险，建议接入时以实际抓包结果为准。
5. v1 `/event` 与实验性 v2 `/api/event` 两条事件流的关系（是否会在某个版本合并/v1 废弃）未明确，接入时应优先用 v1（更稳定，且与赛题描述的路径 `GET /event` 一致）。

## 来源列表

- https://opencode.ai/docs/server/ （opencode 官方文档：server 端点总览、默认端口 4096）
- https://github.com/anomalyco/opencode （主仓库，原 sst/opencode）
- https://github.com/anomalyco/opencode/issues/26635 （prompt_async 异步语义的社区确认）
- https://github.com/anomalyco/opencode/issues/26697 （SSE /event 在 server.connected 后异常关闭，印证事件顺序）
- https://github.com/anomalyco/opencode/issues/27966 （SyncEvent 在 1.14.42+ 版本的 SSE 投递问题，印证事件总线实现）
- https://github.com/anomalyco/opencode/issues/30043 （session.status 缺少 parentID 的已知缺口）
- https://github.com/anomalyco/opencode/issues/9865 （question.asked 事件用于插件暴露 plan 元数据）
- https://github.com/anomalyco/opencode/issues/17920 （Question 工具在 ACP 模式下的问题，印证功能真实存在）
- https://github.com/anomalyco/opencode/issues/11424 （/session/:id/message 与 /prompt_async 都会触发 message.part.updated SSE）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/sdk/js/src/gen/types.gen.ts （v1 SDK 生成类型：Session/Message/Part/事件/端点的权威来源，本文大部分字段级细节的直接出处）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/sdk/js/src/v2/gen/types.gen.ts （v2 SDK 生成类型：question/permission 路由确认）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/schema/src/session-status-event.ts （SessionStatus 判别联合定义、session.idle 标记 deprecated）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/schema/src/v1/question.ts （Question 请求/回复/事件 schema 原文）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/llm/src/schema/ids.ts （FinishReason 枚举权威定义）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/llm/src/protocols/openai-chat.ts （finish_reason 映射逻辑，"stop + 有工具调用 → tool-calls" 的判定规则）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt.ts （多步 LLM 循环、`result === "stop"` 跳出、`handle.message.finish = "stop"` 的赋值逻辑）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts （/event 路由实现：server.connected 首帧、10 秒心跳、按 directory 过滤）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/server/routes/instance/httpapi/groups/event.ts （/event 路由声明）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/protocol/src/groups/event.ts （v2 实验性 /api/event 路由与 EventSchema 定义）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/plugins.mdx （插件系统：钩子列表、自定义工具注册、配置文件位置）
- https://deepwiki.com/afuhflynn/opencode/4.1-api-server-and-openapi-spec （社区 DeepWiki 索引，用于交叉核实 SSE 事件表格，注：该镜像仓库 afuhflynn/opencode 疑为 fork，内容与官方一致但非权威源，仅作为辅助交叉验证）
