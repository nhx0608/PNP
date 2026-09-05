# T03 OpenCode (sst/opencode / opencode.ai) 客户端-服务端架构

调研日期：2026-09-04

## 摘要

OpenCode（anomalyco/opencode，原 sst/opencode，MIT，约 203.6k star）是 client/server 分离的开源编码 Agent：`opencode serve` 在 127.0.0.1:4096 暴露 OpenAPI 3.1 描述的 REST + SSE 接口（当前 v1.18.27，162 条路径，93 种事件），TUI/Desktop/Web/VS Code 扩展/`@opencode-ai/sdk`/ACP（`opencode acp`）都是它的客户端。会话模型以 `ses_*` 为核心，支持 `parentID` 子会话（task 工具委派）、fork/revert、share、自动 compaction（checkpoint 摘要）、`metadata` 与会话级 `PermissionRuleset`；请求通过 `?directory=` 路由到不同项目实现隔离。权限为 `allow/ask/deny` + glob，支持全局/agent/会话三级覆盖，运行时审批通过 SSE `permission.asked` → `POST /permission/{id}/reply {once|always|reject}` 完成。扩展面丰富：agents(.md)、commands、skills（兼容 .claude/skills）、AGENTS.md、MCP(local/remote+OAuth)、插件 hooks（permission.ask、tool.execute.before/after、chat.*、event）。无内建长期记忆与 OTel。OpenCode 2.0 处于 beta（`opencode2`，新 `/api/*` 契约与新插件 API，V1 插件不兼容），接入应锁定 1.x 并按版本探测能力。推荐网关以长驻 serve + SSE 分拣方式接入，ACP 作为跨引擎通用适配层备选。

## 架构与工作原理

OpenCode（原 sst/opencode，2026 年仓库已迁至 anomalyco/opencode，sst/opencode 会重定向）是一个 **client/server 分离** 的开源编码 Agent。核心思想（官方 docs/server）：

- **Server（引擎核心）**：`opencode serve` 启动一个无头 HTTP 服务器（Hono + Bun），默认 `127.0.0.1:4096`，暴露 OpenAPI 3.1 规范（`GET /doc`），所有会话/消息/权限/配置/文件/LSP/MCP 能力都以 REST + SSE 形式暴露。TUI、Desktop（Tauri）、Web、VS Code 扩展、`@opencode-ai/sdk` 都是这个 server 的客户端。
  - 来源：https://opencode.ai/docs/server/
- **Client 形态**：TUI（Go/Bubble Tea → 后迁 TypeScript/SolidJS TUI）、Desktop app、IDE 扩展（VS Code/Cursor/Windsurf）、`opencode web`、以及 ACP（`opencode acp`，stdio JSON-RPC，供 Zed/JetBrains/Neovim 使用）。
- **事件总线（Bus）**：server 内部所有状态变更（session/message/part/permission/tool/file/lsp/todo）都发布到进程内 Bus，再通过 `GET /event`（单实例）与 `GET /global/event`（跨项目全局）以 SSE 推给客户端。
- **多项目/多目录**：server 是"instance"模型，请求可通过 `directory` query 参数（SDK 的 `directory` 选项）路由到不同项目目录；`POST /instance/dispose` 销毁实例。
- **存储**：会话/消息/part 早期以 JSON 文件持久化在 `~/.local/share/opencode/storage/`（`session/{projectID}/{sessionID}.json`、`message/{sessionID}/msg_*.json`、`part/...`），2.0 版本迁移为 SQLite（见"会话模型"）。

```
 [TUI] [Desktop] [VSCode ext] [Web] [SDK 调用方 / 我们的网关]      [Zed/JetBrains]
       \       |        |        |         |                              |
        +------+--------+--------+---------+   HTTP REST + SSE            | ACP (stdio JSON-RPC)
                        |                                                 |
                 opencode serve  (Hono, :4096, /doc OpenAPI)  <--- opencode acp (同一核心)
                        |
   Session / Message / Part / Permission / Agent / Tool / MCP / LSP / Plugin / Bus
                        |
              Provider 层 (models.dev 目录, 75+ provider, OpenCode Zen)
```

## 关键事实（表格）

| # | 事实 | 来源 | 置信度 | 交叉验证 |
|---|------|------|--------|----------|
| 1 | 当前稳定版 **v1.18.27**（2026-09-02 发布），`@opencode-ai/sdk` 与 `@opencode-ai/plugin` npm 版本同为 1.18.27 | GitHub Releases；packages/opencode/package.json；npm registry | 高 | [已交叉验证] |
| 2 | GitHub star **约 203.6k**，fork 26.6k，MIT 许可，仓库 anomalyco/opencode（sst/opencode 重定向） | github.com/anomalyco/opencode；developersdigest 博文报 203,384 | 高 | [已交叉验证] |
| 3 | `opencode serve` 默认 `127.0.0.1:4096`，`GET /doc` 返回 OpenAPI 3.1；basic auth 靠 `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME` | docs/server；openapi.json（162 条路径） | 高 | [已交叉验证] |
| 4 | 权限回复枚举 `once / always / reject`；旧端点 `POST /session/{id}/permissions/{permissionID}` body `{response}`，新端点 `POST /permission/{requestID}/reply` body `{reply, message?}` | openapi.json；docs/permissions | 高 | [已交叉验证] |
| 5 | 权限配置值 `allow/ask/deny`，键含 `read, edit, glob, grep, bash, task, skill, lsp, question, webfetch, websearch, external_directory, doom_loop`，支持 glob 模式，agent 级覆盖 | docs/permissions；docs/agents | 高 | [已交叉验证] |
| 6 | Session 有 `parentID`（子会话）、`share.url`、`cost`、`tokens{input,output,reasoning,cache}`、`time{created,updated,compacting,archived}`、`permission` ruleset、`metadata` | openapi.json Session schema | 高 | 单源（源码级） |
| 7 | 创建 session 可指定 `parentID/title/agent/model/metadata/permission/workspaceID`；prompt body 可指定 `agent/model/tools/system/format/noReply/parts[]` | openapi.json | 高 | 与 docs/sdk 的 `noReply`、`format` 描述一致 [已交叉验证] |
| 8 | SSE 事件流 `GET /event`（实例）与 `GET /global/event`；事件类型 93 个，含 `session.created/updated/idle/status/error/compacted`、`message.part.updated/delta`、`permission.asked/replied`、`tool.execute.*`（插件 hook）等 | openapi.json Event 联合类型；docs/plugins | 高 | [已交叉验证] |
| 9 | 插件 hooks：`event, config, tool, auth, chat.message, chat.params, chat.headers, permission.ask, tool.execute.before/after, shell.env, command.execute.before, tool.definition, experimental.session.compacting, experimental.chat.messages.transform ...`；插件收 `{project, client, $, directory, worktree}` | packages/plugin/src/index.ts；docs/plugins | 高 | [已交叉验证] |
| 10 | `opencode acp` 通过 stdio JSON-RPC 实现 ACP，支持 Zed、JetBrains、Avante.nvim、CodeCompanion.nvim；`/undo` `/redo` 不支持 | docs/acp | 高 | 单源 |
| 11 | 内置 agent：primary `build`、`plan`；subagent `general`、`explore`、`scout`；agent 定义于 `opencode.json` 或 `.opencode/agents/*.md`（frontmatter: description/mode/model/temperature/prompt/permission/steps/color/hidden/disable） | docs/agents；openapi Agent schema | 高 | [已交叉验证] |
| 12 | 压缩（compaction）：自动触发条件 `估算 tokens > 上下文上限 − max(输出 token, buffer)`；配置 `compaction.auto/keep.tokens(15000)/buffer(20000)`；手动 `POST /session/{id}/summarize`（v1）/`POST /api/session/{id}/compact`（v2） | v2 docs/compaction；openapi.json | 高（v2 配置项为 beta） | [已交叉验证] |
| 13 | OpenCode 2.0 处于 **beta**：`npm i -g @opencode-ai/cli@beta` 装为 `opencode2`，新 server API（`/api/*` 路径，`@opencode-ai/client`）、新插件 API（`plugins` 数组，V1 插件不兼容），V1/V2 可并存 | opencode.ai/v2/docs、/v2/docs/migrate-v1 | 高 | [已交叉验证] |
| 14 | 数据目录 `~/.local/share/opencode/`（`auth.json`、`log/`、`<project-slug>/storage/`），配置 `~/.config/opencode/opencode.json(c)`，缓存 `~/.cache/opencode` | docs/troubleshooting | 高 | 与 ccusage 文档一致 [已交叉验证] |
| 15 | MCP 配置 `type: local`（command/environment/timeout）与 `type: remote`（url/headers/oauth）；远程 MCP 自动 OAuth（DCR）；`opencode mcp auth/list/logout/debug` | docs/mcp-servers；openapi `/mcp/{name}/auth*` | 高 | [已交叉验证] |
| 16 | Skills：`.opencode/skills/<name>/SKILL.md`、`~/.config/opencode/skills/`、兼容 `.claude/skills/` 与 `.agents/skills/`；通过原生 `skill` 工具按需加载；`permission.skill` 支持 glob | docs/skills | 高 | 单源 |
| 17 | 企业版：中心化配置、SSO、内部 AI 网关、`"share": "disabled"`、按席位计费；share 自托管在路线图 | docs/enterprise；docs/share | 中 | 单源 |
| 18 | 模型 ID 格式 `provider/model`，目录来自 models.dev；OpenCode Zen 是官方托管的模型网关，模型 ID 前缀 `opencode/` | docs/models、docs/zen | 高 | 单源 |

## 可编程接入面

### 1. `opencode serve` HTTP API（v1，已确认，来自 `packages/sdk/openapi.json`，共 162 条路径）

启动与鉴权：
```bash
opencode serve --port 4096 --hostname 127.0.0.1 [--cors https://gw.example.com] [--mdns]
OPENCODE_SERVER_PASSWORD=xxx OPENCODE_SERVER_USERNAME=opencode opencode serve   # HTTP Basic Auth
curl -u opencode:xxx http://127.0.0.1:4096/doc      # OpenAPI 3.1
```
（来源：https://opencode.ai/docs/server/）

几乎所有端点接受 `?directory=<abs path>`（以及 `?workspace=`）query 参数，用来把请求路由到某个项目目录的 instance —— 这是网关做"业务→工作目录"隔离的关键钩子（openapi.json 中 session/*、permission/* 等均声明该参数）。

核心端点分组（openapi operationId 括注）：

| 分组 | 端点 |
|---|---|
| 健康/全局 | `GET /global/health`、`GET /global/event`（SSE）、`GET/PATCH /global/config`、`POST /global/dispose`、`POST /instance/dispose` |
| 会话 | `GET/POST /session`、`GET /session/status`、`GET/PATCH/DELETE /session/{id}`、`GET /session/{id}/children`、`POST /session/{id}/fork`、`/abort`、`/init`、`/share`、`DELETE /share`、`/summarize`、`/revert`、`/unrevert`、`GET /session/{id}/diff`、`GET /session/{id}/todo` |
| 消息 | `GET /session/{id}/message`、`POST /session/{id}/message`（session.prompt，同步等待回复）、`POST /session/{id}/prompt_async`、`POST /session/{id}/command`（执行 slash command）、`POST /session/{id}/shell`、`GET/DELETE /session/{id}/message/{mid}`、`PATCH/DELETE .../part/{pid}` |
| 权限/提问 | `GET /permission`、`POST /permission/{requestID}/reply`、`POST /session/{id}/permissions/{permissionID}`（旧）、`GET /question`、`POST /question/{id}/reply|reject` |
| 事件 | `GET /event`（SSE，`text/event-stream`，schema `Event`） |
| Agent/Skill/Command/Tool | `GET /agent`、`GET /skill`、`GET /command`、`GET /experimental/tool/ids`、`GET /experimental/tool?provider&model`、`GET /experimental/capabilities` → `{backgroundSubagents: bool}` |
| 配置/提供商 | `GET/PATCH /config`、`GET /config/providers`、`GET /provider`、`GET /provider/auth`、`POST /provider/{id}/oauth/authorize|callback`、`PUT/DELETE /auth/{providerID}` |
| 文件/搜索/VCS | `GET /file?path`、`/file/content?path`、`/file/status`、`GET /find?pattern`、`/find/file?query`、`/find/symbol?query`、`GET /vcs`、`/vcs/status`、`/vcs/diff`、`POST /vcs/apply` |
| MCP/LSP | `GET/POST /mcp`、`POST /mcp/{name}/auth`、`/connect`、`/disconnect`、`GET /lsp`、`GET /formatter` |
| PTY | `GET/POST /pty`、`GET/PUT/DELETE /pty/{id}`、`POST /pty/{id}/connect-token`、`GET /pty/{id}/connect` |
| 实验：worktree/workspace/control-plane | `GET/POST/DELETE /experimental/worktree`、`/experimental/workspace*`、`POST /experimental/control-plane/move-session {sessionID, destination:{directory}, moveChanges}`、`POST /experimental/session/{id}/background` |
| 同步 | `POST /sync/start|replay|steal|history` |
| TUI 遥控 | `POST /tui/append-prompt`、`/submit-prompt`、`/show-toast`、`/select-session`、`GET /tui/control/next` 等 |
| **v2 API（同一 server 内并存）** | `/api/session*`、`/api/session/{id}/prompt`（body `{prompt:{text,files,agents}, delivery: "steer"|"queue", resume}`）、`/api/session/{id}/compact`、`/wait`、`/interrupt`、`/context`、`/history`、`/event`（每会话 SSE）、`/api/permission/request`、`/api/permission/saved`、`/api/session/{id}/permission/{rid}/reply`、`/api/integration*`、`/api/credential*`、`/api/fs/*`、`/api/model`、`/api/provider`、`/api/event` |

关键请求体（openapi.json 原文字段）：

```jsonc
// POST /session?directory=/srv/groups/g123
{ "parentID": "ses_...", "title": "群 g123", "agent": "build",
  "model": { "providerID": "anthropic", "id": "claude-sonnet-4-5", "variant": "high" },
  "metadata": { "groupId": "g123" },          // 任意对象，网关可存业务键
  "permission": [ { "permission": "bash", "pattern": "rm *", "action": "deny" } ],   // PermissionRuleset
  "workspaceID": "wrk_..." }

// POST /session/{id}/message   (同步；prompt_async 为异步)
{ "messageID": "msg_...", "agent": "build",
  "model": { "providerID": "anthropic", "modelID": "claude-sonnet-4-5" },
  "system": "附加系统提示", "tools": { "bash": false, "webfetch": true },
  "noReply": false, "format": { "type": "json_schema", ... },   // OutputFormat: text | json_schema
  "parts": [ { "type": "text", "text": "..." }, { "type": "file", ... },
             { "type": "agent", "name": "explore" },
             { "type": "subtask", "prompt": "...", "description": "...", "agent": "general" } ] }

// POST /permission/{requestID}/reply
{ "reply": "once" | "always" | "reject", "message": "可选说明" }
```

### 2. `@opencode-ai/sdk`（TypeScript，版本 1.18.27）
```ts
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk"
const { client } = await createOpencode({ hostname: "127.0.0.1", port: 4096, config: { model: "anthropic/claude-sonnet-4-5" } }) // 起 server + client
const client2 = createOpencodeClient({ baseUrl: "http://localhost:4096", directory: "/srv/proj" })
const s = await client2.session.create({ body: { title: "x" } })
await client2.session.prompt({ path: { id: s.data.id }, body: { parts: [{ type: "text", text: "hi" }] } })
for await (const ev of (await client2.event.subscribe()).stream) { /* ev.type, ev.properties */ }
```
方法命名与 operationId 一致：`session.*`、`event.subscribe`、`permission.list/reply`、`app.agents/log`、`config.get/providers`、`provider.*`、`file.*`、`find.*`、`project.*`、`path.get`、`tui.*`、`auth.set`、`global.health`。SDK 由 openapi.json 生成（@hey-api/openapi-ts），因此 SDK 与 REST 一一对应（来源：https://opencode.ai/docs/sdk/ ；openapi.json）。

### 3. CLI（非交互）
```bash
opencode run "prompt" --session ses_xxx | --continue | --fork --agent plan --model provider/model --format json --file a.ts --dir /path --auto --attach http://127.0.0.1:4096 --title "..."
opencode session list --format json ; opencode export <id> ; opencode import <file|share-url>
opencode web ; opencode acp ; opencode agent create ; opencode mcp list|auth|logout|debug ; opencode models ; opencode stats ; opencode github
```
（来源：https://opencode.ai/docs/cli/ ）`--attach` 允许 CLI 复用已运行的 server，`--format json` 输出事件 JSON 流，是"子进程接入"的备选方式。

### 4. ACP（Agent Client Protocol）
`opencode acp` 以 stdio JSON-RPC 暴露标准 ACP（Zed 主导的编辑器↔Agent 协议）。支持内置工具、自定义工具与 slash command、MCP、AGENTS.md、agents 与权限系统；不支持 `/undo` `/redo` 等部分内建命令。Zed 可从 ACP Registry 安装；JetBrains 用 `acp.json` 指定 `command` + `["acp"]`（来源：https://opencode.ai/docs/acp/ ）。已知 issue #18672：`session/update` 通知晚于 `session/prompt` 响应到达（时序问题）。

## 会话模型

- **标识**：`ses_*`（session）、`msg_*`（message）、`prt_*`（part）、`per_*`（permission request）、`wrk_*`（workspace）。Session 字段：`id, slug, projectID, workspaceID, directory, path, parentID, title, agent, model{providerID,id,variant}, version, metadata, share{url}, cost, tokens{input,output,reasoning,cache{read,write}}, summary{additions,deletions,files,diffs}, time{created,updated,compacting,archived}, permission` （openapi.json，已确认）。
- **创建/继续**：`POST /session` 创建；继续只需对同一 `sessionID` 再 `POST /session/{id}/message`。session 绑定 `directory`/`projectID`，不同目录天然隔离。CLI 用 `--session`/`--continue`。
- **子会话**：`parentID` 指向父会话；`task` 工具（subagent 调用）为每次委派创建子 session，`GET /session/{id}/children` 列出。`@agent` 提及或 `parts[{type:"subtask"}]` 显式触发。`GET /experimental/capabilities` 返回 `backgroundSubagents` 表示是否支持后台子代理（`POST /experimental/session/{id}/background`）。
- **fork / revert**：`POST /session/{id}/fork {messageID}` 从某条消息分叉；`/revert` `/unrevert` 撤销/恢复消息（含文件快照回滚，`session.diff` 事件）。
- **分享**：`share` 配置 `manual`(默认)/`auto`/`disabled`；`POST /session/{id}/share` → `share.url`（`opncd.ai/s/<id>`）；`DELETE` 取消并删数据。企业可禁用/自托管（路线图）（来源：docs/share）。
- **压缩（compaction）**：自动触发（估算 token 超过 `context − max(output, buffer)`，或 provider 报上下文溢出后一次性恢复）；生成"结构化摘要 + 最近上下文尾巴"的 checkpoint，后续请求从最新 checkpoint 开始拼装，历史消息不删除。配置（v2 文档）：
  ```jsonc
  { "compaction": { "auto": true, "keep": { "tokens": 15000 }, "buffer": 20000 } }
  ```
  手动：v1 `POST /session/{id}/summarize {providerID, modelID}`、v2 `POST /api/session/{id}/compact`；事件 `session.compacted`、`session.next.compaction.started/delta/ended`；插件 hook `experimental.session.compacting` 可注入压缩提示（来源：https://opencode.ai/v2/docs/compaction/ ；prompt.ts 中 `compaction.isOverflow/create/prune`）。
- **存储位置与格式**：`~/.local/share/opencode/`；项目数据在 `<project-slug>/storage/`（非 git 项目 `global/storage/`），早期格式 `session/{projectID}/{sessionID}.json`、`message/{sessionID}/msg_*.json`、`part/...`、`session_diff/`（docs/troubleshooting；ccusage 文档）。**推测**：1.18.x 源码 `package.json` 的 `imports["#db"]` 指向 `storage/db.bun.ts`/`db.node.ts`，第三方文章称"stores conversations in SQLite"，说明当前已有 SQLite 层并保留 JSON 迁移代码（storage.ts 含 Migration）；具体 schema 未核实。此外仍保留 `opencode export/import` JSON 导出。
- **跨目录迁移**：`POST /experimental/control-plane/move-session {sessionID, destination:{directory}, moveChanges}`（实验性）。
- **v2 差异**：`/api/session/{id}/prompt` 支持 `delivery: "steer" | "queue"`（在运行中插话 vs 排队）与 `resume`；`/wait` 阻塞到空闲；`/interrupt`；`/context` 查看上下文；`/history`；每会话 SSE `/api/session/{id}/event`。

## 权限与安全

- **配置模型**：`permission` 顶层可为字符串（全局）或对象；键为工具/能力名，值为 `allow|ask|deny` 或 `{glob: action}` 映射；**最后匹配的规则生效**；`*`/`?` 通配，`~`/`$HOME` 展开。键：`read, edit, glob, grep, bash, task, skill, lsp, question, webfetch, websearch, external_directory, doom_loop`（另 docs 提到 `write/list` 归入 edit/read）。默认大多 `allow`，`doom_loop` 与 `external_directory` 默认 `ask`，`.env` 读取默认 `deny`。
  ```json
  { "permission": { "*": "ask", "bash": { "*": "ask", "git *": "allow", "rm *": "deny" },
      "edit": { "*": "deny", "packages/web/src/**": "allow" },
      "external_directory": { "~/projects/personal/**": "allow" },
      "task": { "*": "deny", "explore": "allow" }, "skill": { "internal-*": "deny" } } }
  ```
- **按 agent 覆盖**：`agent.<name>.permission` 与全局合并、agent 优先；`plan` agent 默认 edit/bash 为 `ask`。
- **按 session 覆盖（网关最关心）**：`POST /session` body 的 `permission: PermissionRuleset = [{permission, pattern, action}]` 可在创建会话时注入规则集（openapi.json 已确认，docs 未着重写明——**属源码级确认**）。
- **运行时审批（HTTP/SSE）**：工具触发 `ask` 时 server 发 SSE 事件 `permission.asked`，payload 为 `PermissionRequest{id:"per_*", sessionID, permission, patterns[], metadata, always[], tool{messageID, callID}}`；网关调用 `POST /permission/{requestID}/reply {reply:"once"|"always"|"reject", message?}`（或旧的 `POST /session/{id}/permissions/{permissionID} {response}`），随后 `permission.replied` 事件。`always` 会把 `always[]` 中的模式加入本会话允许集；v2 有 `GET /api/permission/saved` 与 `DELETE /api/permission/saved/{id}` 管理已保存规则。`GET /permission` 列出待处理请求（用于网关重启后恢复）。
- **`question` 通道**：模型向用户提问走独立的 `question.asked` 事件 + `POST /question/{id}/reply|reject`，与权限分离。
- **插件级拦截**：hook `permission.ask(input: Permission, output:{status:"ask"|"deny"|"allow"})` 可在到达用户前改判；`tool.execute.before` 可抛错阻止工具。
- **服务安全**：server 默认仅绑 127.0.0.1；Basic Auth 由环境变量开启；`--cors` 白名单；openapi 未声明 securitySchemes（鉴权在中间件层）。数据不出本机，除 `/share`（可 `"share":"disabled"`）。已知 issue #26907/#31874：子会话（subagent）权限提示在 Desktop 中有"卡住/过期"问题——网关需处理子会话的 `permission.asked`（`sessionID` 为子会话 ID）。
- **`--auto` 模式**：自动批准所有非 `deny` 请求；适合网关后台无人值守场景，但应配合严格的 `deny` 规则。

## 扩展机制与资产

| 资产类型 | 位置/格式 | 说明 | 来源 |
|---|---|---|---|
| 配置 | `~/.config/opencode/opencode.json(c)`、`<project>/opencode.json(c)`、`<project>/.opencode/opencode.json(c)`，`$schema: https://opencode.ai/config.json` | 键：`model, small_model, provider, mcp, agent, permission, tools, instructions, plugin, share, compaction, keybinds, tui, formatter, lsp, command, skill...`；`GET/PATCH /config` 运行时读改 | docs/config、migrate-v1 |
| Agent | `opencode.json#agent.<name>` 或 `.opencode/agents/<name>.md` / `~/.config/opencode/agents/` | frontmatter `description(必填), mode(primary/subagent/all), model, temperature, top_p, prompt, permission, steps, color, hidden, disable`；`GET /agent` 列出 | docs/agents |
| Command | `.opencode/commands/<name>.md`（frontmatter `description, agent, model, subtask`），正文支持 `$ARGUMENTS`、`!cmd` shell 注入、`@file` | `GET /command`；`POST /session/{id}/command {command, arguments}`；`subtask: true` 让命令在子会话执行 | docs/commands；prompt.ts `cmd.subtask` |
| Skill | `.opencode/skills/<name>/SKILL.md`、`~/.config/opencode/skills/`、兼容 `.claude/skills/`、`.agents/skills/` | frontmatter `name(^[a-z0-9]+(-[a-z0-9]+)*$), description, license, compatibility, metadata`；模型经原生 `skill` 工具按需加载；`permission.skill` glob；`GET /skill` | docs/skills |
| Rules | `AGENTS.md`（项目根，向上遍历）、`~/.config/opencode/AGENTS.md`、回退 `CLAUDE.md`/`~/.claude/CLAUDE.md`；`instructions: ["packages/*/AGENTS.md", "https://raw.githubusercontent.com/..."]` | `/init` 或 `POST /session/{id}/init` 自动生成 AGENTS.md | docs/rules |
| MCP | `mcp.<name>`: `{type:"local", command:[...], environment, enabled, timeout}` 或 `{type:"remote", url, headers, oauth, enabled}` | 工具名以 server 名前缀；`tools: {"my-mcp*": false}` + agent 级 `tools` 启用；远程 MCP 自动 OAuth DCR；`GET/POST /mcp`、`/mcp/{name}/auth*`、`/connect`、`/disconnect`；事件 `mcp.tools.changed` | docs/mcp-servers；openapi |
| Plugin | `.opencode/plugins/*.ts`、`~/.config/opencode/plugins/`、或 `"plugin": ["npm-pkg"]`（v2 改为 `"plugins": [{package, options}]`） | 见下 | docs/plugins；migrate-v1 |
| Provider | `provider.<id>: {npm, name, options:{baseURL, apiKey, headers}, models:{<id>:{name, limit, cost, ...}}}`，目录源 models.dev | `PUT /auth/{providerID}` 写凭据；`opencode auth login`；模型 ID `provider/model`；`opencode/<model>` 走 OpenCode Zen | docs/providers、docs/zen |

**插件 API（`@opencode-ai/plugin` 1.18.27，源码确认）**：
```ts
import type { Plugin } from "@opencode-ai/plugin"
export const MyPlugin: Plugin = async ({ project, client, $, directory, worktree }) => ({
  event: async ({ event }) => { /* 所有 Bus 事件 */ },
  config: async (cfg) => {},
  tool: { mytool: tool({ description, args: { q: tool.schema.string() }, async execute(args, ctx) {} }) },
  auth: { provider: "...", loader, methods },                      // 自定义 provider 认证
  "chat.message": async (input, output) => {},                      // 用户消息入站
  "chat.params": async (input, output) => {},                       // 改 temperature/topP 等
  "chat.headers": async (input, output) => {},
  "permission.ask": async (perm, output) => { output.status = "deny" },
  "tool.execute.before": async ({ tool, sessionID, callID }, output) => {},
  "tool.execute.after": async ({ tool, sessionID, callID }, output) => {},
  "tool.definition": async ({ toolID }, output) => {},              // 改工具描述/参数
  "shell.env": async (input, output) => {},
  "command.execute.before": async (...) => {},
  "experimental.chat.messages.transform": ..., "experimental.chat.system.transform": ...,
  "experimental.session.compacting": ..., "experimental.compaction.autocontinue": ..., "experimental.text.complete": ...,
  dispose: async () => {},
})
```
插件持有完整 SDK `client`，可反向调用 server（如 `client.session.prompt({ noReply: true })` 注入上下文）。这意味着**网关侧很多归一化逻辑（埋点上报、权限策略、注入业务上下文）可以做成一个 OpenCode 插件**，而非只能在 HTTP 边界做。

## 记忆

OpenCode **没有内建的跨会话长期记忆**（无 memory 工具/文件）。可用的"记忆"层次：
1. 会话内：完整消息历史 + compaction checkpoint（结构化摘要：objective/requirements/decisions/completed/active/blockers/next/relevant files）。
2. 项目级静态记忆：`AGENTS.md`（`/init` 生成、可手工维护）、skills、`instructions` 远程 URL。
3. 会话元数据：`session.metadata`（任意 JSON，`POST /session` / `PATCH /session/{id}` 可写）；社区插件 opencode-session-metadata 亦利用此。
4. 通过插件实现：`event`/`session.idle` hook 抽取摘要写外部存储，再在 `chat.message` 或 `experimental.chat.system.transform` 中注入。
（依据：docs 全站无 memory 章节；plugin hooks 列表；推测项已标注。）

## 多 Agent 与协作

- **Primary/Subagent 两级**：primary（`build`/`plan`/自定义）由用户直接对话；subagent（`general`/`explore`/`scout`/自定义 `mode: subagent`）由 primary 通过 `task` 工具委派或用户 `@name` 提及。每次委派创建带 `parentID` 的子 session，拥有独立上下文与权限集；`permission.task` glob 控制可委派哪些 subagent。
- **显式 subtask**：prompt `parts` 中 `{type:"subtask", prompt, description, agent, model?, command?}`；命令 frontmatter `subtask: true`。
- **后台子代理**：实验能力 `backgroundSubagents`（`/experimental/capabilities`）+ `POST /experimental/session/{id}/background`，允许并行运行子会话。
- **Desktop 多 tab 并行会话**、`session.status`（`idle|busy|retry`）与 `GET /session/status` 汇总所有会话状态。
- **worktree/workspace（实验）**：`/experimental/worktree`（为会话创建 git worktree 隔离）、`/experimental/workspace`（远程/容器 workspace adapter，`workspace.ready/failed/status` 事件），是 OpenCode 走向"多会话并行 + 环境隔离"的方向。
- **无** Claude Code 式的 agent team/room 或跨引擎协作原语；协作形态为树状（父子会话）。

## 可观测性

- **日志**：`~/.local/share/opencode/log/<timestamp>.log`，保留最近 10 个；`--log-level DEBUG|INFO|WARN|ERROR`、`--print-logs`；`POST /log {service, level, message, extra}` 允许客户端写入同一日志。
- **事件总线 → SSE**：`GET /event`（当前 instance）、`GET /global/event`（全局，含 `directory` 字段）、v2 `GET /api/session/{id}/event`。事件 JSON 形如 `{type, properties}`。93 种类型（openapi Event 联合），按类别：
  - 会话：`session.created/updated/deleted/status/idle/error/compacted/diff`
  - 消息：`message.updated/removed`、`message.part.updated/removed/delta`
  - 细粒度流式（v2 "next"）：`session.next.step.started/ended/failed`、`text.started/delta/ended`、`reasoning.*`、`tool.input.started/delta/ended`、`tool.called/progress/success/failed`、`compaction.*`、`retried`、`prompted`、`agent.switched`、`model.switched`
  - 权限/提问：`permission.asked/replied`、`permission.v2.*`、`question.asked/replied/rejected`
  - 工具/文件/环境：`file.edited`、`file.watcher.updated`、`todo.updated`、`lsp.updated`、`mcp.tools.changed`、`command.executed`、`pty.*`、`vcs.branch.updated`、`worktree.*`、`workspace.*`
  - 系统：`server.connected`、`server.instance.disposed`、`installation.updated`、`models-dev.refreshed`、`plugin.added`
- **用量/成本**：Session 对象内置 `cost` 与 `tokens{input,output,reasoning,cache}`；`opencode stats`；第三方 ccusage 读取本地存储。
- **无内建 OTel/trace 导出**；社区插件（如 `opencode-helicone-session`）通过 `chat.headers` 注入观测 header。归一化需由网关订阅 SSE 完成。

## 对我们架构的启示

### 接入方式选型：serve API（首选） vs ACP vs 子进程

| 方式 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **`opencode serve` HTTP+SSE（+SDK）** | 覆盖最全（会话/子会话/权限/事件/配置/MCP/文件）；一个 server 可用 `?directory=` 服务多个项目；OpenAPI 可生成任意语言客户端；有 Basic Auth + CORS；`GET /permission` 支持断线恢复 | v1 API 与 v2 `/api/*` 并存且 v2 契约仍在变；SSE 全局流需按 `sessionID` 分拣；实验端点可能变动 | **首选**。网关以长驻 server + 事件订阅方式接入 |
| **ACP（`opencode acp` stdio JSON-RPC）** | 跨引擎标准协议（Zed、Gemini CLI、Claude Code adapter 等都支持），权限请求/工具调用/流式有统一 schema | 每个进程一个客户端连接；无会话列表/分享/配置管理；`/undo` 等不支持；存在通知时序 issue | 适合作为**第二层通用适配器**（所有支持 ACP 的引擎共用一个 adapter），但 OpenCode 特有能力走不了 |
| **子进程 `opencode run --format json --session`** | 最简单、零状态 | 无运行时权限交互（只能 `--auto`）、无事件细粒度、每次冷启动 | 仅作降级/批处理 |

### 公共能力 vs OpenCode 扩展能力映射

| 网关抽象能力 | OpenCode 实现/字段 | 归类 | 接入参数 |
|---|---|---|---|
| 创建会话 / 业务→session 映射 | `POST /session {title, metadata, agent, model, permission}` + `?directory=`；网关表 `groupId → {sessionID, directory}` | 公共 | `directory`、`metadata`（存业务键） |
| 继续会话 | `POST /session/{id}/message` / `prompt_async` | 公共 | `sessionID`、`parts` |
| 上下文隔离 | 目录级 instance + 独立 session；`workspace`/worktree（实验） | 公共（隔离粒度为引擎特有） | `directory`、`workspaceID` |
| 流式输出 | SSE `message.part.delta`/`session.next.text.delta`、`session.idle` 收尾 | 公共 | 事件过滤 `properties.sessionID` |
| 权限请求/审批 | `permission.asked` → `POST /permission/{id}/reply {once|always|reject}`；静态 `permission` 规则 | 公共（回复枚举需归一：once/always/reject ↔ 其他引擎 allow_once/allow_always/deny） | 规则集 JSON、`--auto` |
| 用户提问（AskUser） | `question.asked` → `/question/{id}/reply` | 公共 | |
| 中断/取消 | `POST /session/{id}/abort`（v2 `/interrupt`） | 公共 | |
| 用量/成本 | Session `cost`、`tokens` | 公共 | |
| 结构化输出 | `format: {type:"json_schema"}` | 公共（部分引擎有） | JSON Schema |
| 系统提示注入 | `system` 字段、`AGENTS.md`、`instructions` | 公共 | |
| 工具开关 | `tools: {name: bool}`（按消息）/ 配置 `tools` | 公共 | |
| 模型切换 | `model{providerID,modelID,variant}` 每条消息可换；v2 `/api/session/{id}/model` | 公共 | provider/model 目录来自 `GET /config/providers` |
| MCP 挂载 | `mcp` 配置 + `POST /mcp` 动态添加 + OAuth | 公共 | local/remote 配置 |
| Skills / Commands | `SKILL.md`（兼容 `.claude/skills`）、`.opencode/commands` | 公共（格式接近 Claude Code，可共享资产） | |
| 子代理/委派 | `task` 工具、`parentID`、`subtask` part、`permission.task` | **扩展**（树状子会话；无 team/room） | agent 名、glob |
| 后台子代理 | `backgroundSubagents` capability | **扩展/实验** | |
| Fork / Revert / 文件快照回滚 | `/fork`、`/revert`、`/unrevert`、`session.diff` | **扩展** | messageID |
| Share 链接 | `/share`、`share` 配置 | **扩展**（多数引擎无） | 企业应 `disabled` |
| Steer/Queue 插话 | v2 `delivery: steer|queue` | **扩展**（beta） | |
| 跨目录迁移会话 | `/experimental/control-plane/move-session` | **扩展/实验** | |
| PTY / LSP / VCS / 文件浏览 | `/pty`、`/lsp`、`/vcs`、`/file` | **扩展**（IDE 向） | |
| 插件 hooks | `permission.ask`、`tool.execute.*`、`chat.*`、`event` | **扩展**（可用于实现归一化 side-car） | 插件包名 |
| 长期记忆 | 无内建；靠 `metadata`+插件 | 缺失 → 由网关统一记忆层补齐 | |
| 能力协商 | `GET /global/health`（版本）、`GET /experimental/capabilities`、`GET /agent`、`GET /skill`、`GET /command`、`GET /experimental/tool/ids`、`GET /config/providers`、`GET /doc`（OpenAPI diff） | 可作为"能力识别"探针 | |

### 接入流程建议（能力识别 → 适配 → 认证）
1. **识别**：启动 `opencode serve`，`GET /global/health` 取版本；拉 `GET /doc` 与网关内置的 OpenAPI 指纹比对（新增/删除端点告警）；`GET /experimental/capabilities`、`/agent`、`/experimental/tool/ids`、`/config/providers` 生成能力清单。
2. **适配**：网关 `EngineAdapter` 实现 `createSession(dir, meta, rules)`、`send(sessionId, parts, opts)`、`subscribe(sessionId)`（SSE 分拣）、`replyPermission(reqId, decision)`、`abort`；把 93 种事件映射到统一事件模型（`session.*`→lifecycle、`message.part.delta`→token、`tool.execute.*`/`session.next.tool.*`→tool、`permission.*`→approval、`session.error`→error）。
3. **认证**：server 侧 `OPENCODE_SERVER_PASSWORD`；provider 凭据 `PUT /auth/{providerID}` 或企业内部网关 `provider.options.baseURL`；MCP OAuth 走 `/mcp/{name}/auth`。
4. **权限策略下发**：群助手场景把业务权限编译成 `PermissionRuleset` 随 `POST /session` 注入，并对未覆盖情形以 `permission.asked` 事件转到人审通道。

### 风险与坑
- **v1/v2 双轨**：v2 beta 明言 server/plugin API 契约会变、V1 插件不兼容 v2；适配器要按 `health.version` 分支或锁定 1.18.x。
- **SSE 是全局流**：`/event` 推送该 instance 下所有会话事件，网关必须按 `sessionID` 分拣；子会话事件的 `sessionID` 是子 ID，需用 `parentID` 回溯到业务会话。
- **权限提示在子会话**中曾出现卡住的 bug（#26907、#31874）；建议设置超时 + 默认 `reject`。
- **同步 `POST /message` 长阻塞**，服务端/代理需放宽超时或改用 `prompt_async` + `session.idle`。
- **存储格式非稳定 API**：JSON 文件/SQLite 结构随版本迁移，不要直接读库；用 `export`/REST。
- **单 server 多目录**：`directory` 必须是绝对路径；非 git 目录数据落 `global/storage`，项目切换时 instance 生命周期由 server 管理（`/instance/dispose`）。
- **实验端点**（worktree、workspace、control-plane、background）无稳定承诺。
- **默认权限偏宽**（多数 `allow`），无人值守务必显式配置 `deny` 列表与 `external_directory`。

## 未解决问题
1. 1.18.x 的实际持久化格式（SQLite 表结构 vs JSON 文件）未从一手源码完整核实；`db.bun.ts` 路径 404，需查 `packages/opencode/src/storage/` 现行文件。
2. v2 `/api/*` 契约何时冻结、正式 2.0 发布日期（截至 2026-09-04 仍为 beta，稳定线 1.18.27）。
3. `permission.always[]` 保存范围（会话级 vs 项目级）在 v1 与 v2 是否不同（v2 有 `/api/permission/saved`）。
4. `GET /global/event` 在多目录场景下事件 payload 的 `directory` 字段与 instance 生命周期细节。
5. ACP 模式下权限/子会话事件的完整映射与 issue #18672 是否已修复。
6. 企业版中心化配置的具体分发机制（远程 config URL？）与 SSO 集成方式。

## 来源列表
- https://opencode.ai/docs/server/ （server 端点、flags、Basic Auth）
- https://opencode.ai/docs/sdk/ （SDK）
- https://opencode.ai/docs/permissions/
- https://opencode.ai/docs/plugins/
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/acp/
- https://opencode.ai/docs/mcp-servers/
- https://opencode.ai/docs/skills/
- https://opencode.ai/docs/rules/
- https://opencode.ai/docs/share/
- https://opencode.ai/docs/cli/
- https://opencode.ai/docs/troubleshooting/
- https://opencode.ai/docs/enterprise/
- https://opencode.ai/v2/docs/ 、https://opencode.ai/v2/docs/migrate-v1 、https://opencode.ai/v2/docs/compaction/
- https://github.com/anomalyco/opencode （star/fork/README）
- https://github.com/anomalyco/opencode/releases （v1.18.27, 2026-09-02）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/sdk/openapi.json （162 路径、schema、93 事件）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/package.json （version 1.18.27）
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/storage/storage.ts
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/plugin/src/index.ts （hooks）
- https://registry.npmjs.org/@opencode-ai/sdk/latest 、https://registry.npmjs.org/@opencode-ai/plugin/latest
- https://deepwiki.com/anomalyco/opencode
- https://ccusage.com/guide/opencode/ （存储路径）
- https://www.developersdigest.tech/blog/opencode-developer-guide-2026 （star 数交叉）
- https://github.com/anomalyco/opencode/issues/18672 、/issues/26907 、/issues/31874 、/issues/22110
- https://opencode.ai/docs/zen/ 、https://opencode.ai/docs/models/ 、https://opencode.ai/docs/providers/
