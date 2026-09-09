# PNP 架构与详细设计

> 本文描述 PNP 网关的架构与实现。所有结构性陈述均以源码为准；路径以 `code/` 为根（交付包内为
> `solution/code/`）。行为细则见同目录 [`spec/contracts.md`](spec/contracts.md)、
> [`spec/architecture.md`](spec/architecture.md)；两个引擎的逐项事实见
> [`engines/opencode.md`](engines/opencode.md)、[`engines/pi.md`](engines/pi.md)。
>
> 文中 `openai-chat` 与 `anthropic-messages` 是模型协议标识符，`acp` 与 `pi-rpc` 是南向协议标识符。

---

## 1. 系统定位与分层

PNP 是一个 **Agent 网关 + 可替换 Harness** 的实现：北向实现赛题的通用网关规范（`localhost:6217`），
南向同时接入两种真实 Agent 引擎，且两者使用**不同的进程协议**。网关拥有会话身份、运行状态、持久化、
事件、交互与进程资源；引擎拥有 Agent Loop、上下文组织、模型决策与原生工具执行。

| 引擎 | 锁定版本 | 南向协议 | 驱动目录 | 权限来源 |
|---|---|---|---|---|
| OpenCode | `opencode-windows-x64@1.18.29` | ACP（stdio JSON-RPC） | `src/drivers/acp/` | 引擎原生 `session/request_permission` |
| Pi | `@earendil-works/pi-coding-agent@0.85.1` | Pi RPC（`--mode rpc` JSONL） | `src/drivers/pi-rpc/` | 网关装入 Pi 进程的扩展钩子 |
| Hermes | — | ACP | `src/drivers/acp/` | 声明的扩展点：`implementationProvided: false`，`open()` 以 `ENGINE_UNAVAILABLE` 拒绝 |

版本与 npm tarball 的 SHA-256 记录在 `engines.lock.json`；打包脚本 `scripts/package-release.mjs --bundle`
重新计算并与之比对。交付包 `solution/{INSTRUCTION.md, code/, docs/, verification/results.json}` 自带
Node 24.19.0 运行时、生产依赖、编译产物与两个引擎，目标机器不需要 Node、Python、Git 或网络。

### 1.1 分层图

```text
+----------------------------------------------------------------------+
| Client   evaluator / business caller      HTTP + SSE  localhost:6217 |
+-----------------------------------+----------------------------------+
                                    |  spec routes + JSON shapes only
+-----------------------------------v----------------------------------+
| L1 Northbound   src/gateway/app.ts, schemas.ts                       |
+----------------------------------------------------------------------+
| L2 Core         src/core/{gateway-core,interactions,journal}.ts      |
|   +------------------+  +------------------+  +------------------+   |
|   | Storage          |  | Integration      |  | ProcessHost      |   |
|   | src/storage      |  | src/integration  |  | src/runtime      |   |
|   | SQLite worker    |  | settings->types  |  | native/windows   |   |
|   +------------------+  +------------------+  +------------------+   |
+----------------------------------------------------------------------+
| L3 Registry     src/registry/index.ts       engineId -> EnginePack   |
+----------------------------------------------------------------------+
| L4 Engine Pack  src/engines/<id>/        "this engine": executable,  |
|                                          private config, assets      |
+----------------------------------------------------------------------+
| L5 Driver       src/drivers/<protocol>/  "this protocol": handshake, |
|                                          prompt, events, finish      |
+----------------------------------------------------------------------+
| L6 Engine proc  opencode.exe acp | node cli.js --mode rpc   (in Job) |
+----------------+-------------------------------+---------------------+
                 |                               |
        +--------v---------+          +----------v----------------+
        | Model endpoint   |          | MCP tool servers (stdio)  |
        | direct, no proxy |          | office / desktop / pdf    |
        +------------------+          +---------------------------+

依赖方向唯一: L1 -> L2 -> L3 -> L4 -> L5 -> L6。
L4 / L5 / Integration 只 import src/contracts; 反向 import 由边界脚本拒绝。
```

图中模块是代码职责，不是部署单元：整个网关是一个进程、一个 SQLite 文件、按需驻留的引擎子进程。

### 1.2 每一层知道什么、不知道什么

| 层 | 路径 | 知道 | 不知道 |
|---|---|---|---|
| 北向路由 | `src/gateway/app.ts`、`schemas.ts` | 规范路径、状态码、SSE 帧、错误 `{code,message}` | 引擎、协议、存储；只调用 `GatewayCore` 方法 |
| Core | `src/core/gateway-core.ts` | Session/Run 状态机、单执行槽 + 有界队列、幂等、终态判定、消息投影、会话围栏 | 任何引擎 SDK；只看到 `EnginePack`/`EngineSessionChannel`/`DriverEvent` |
| 交互 | `src/core/interactions.ts` | question/permission 的持久化、策略裁决、回复端点、超时、`always` 的会话级记忆 | 引擎原生权限载荷的形状（只作 `payload` 透传） |
| 存储 | `src/storage/` | 5 张表、`PRAGMA user_version`、WAL + FULL 同步、单写入者 | 引擎；Schema 无引擎特定列 |
| 集成 | `src/integration/`、`src/config/settings.ts` | `config/settings.json` → `ResolvedModel`、`ToolBinding[]`、`AssetBinding[]`、`PermissionPolicy`、`authorize()` | 引擎原生配置格式；输出只有契约类型 |
| 注册表 | `src/registry/index.ts` | 引擎 id → Pack 工厂；`AGENT_ENGINE` 与 `--engine` 的冲突判定 | 协议 |
| Engine Pack | `src/engines/<id>/` | **这个引擎**怎么找可执行文件、私有配置长什么样、资产放哪 | HTTP、SQLite、Core |
| 驱动 | `src/drivers/<protocol>/` | **这种协议**怎么握手、发 Prompt、收事件、判终态、取消 | 引擎安装布局；由 Pack 通过定义对象告知 |
| 进程宿主 | `src/runtime/process-host.ts`、`native/windows/` | 启动、归属记录、Job Object、终止证据、崩溃后核验 | 协议内容；只搬运帧 |
| 工具 | `src/tools/*-mcp/` | 标准 MCP：`tools/list` + `tools/call` | 哪个引擎在调用它 |

### 1.3 边界由脚本强制

`scripts/check-boundaries.mjs` 遍历 `src/**/*.ts` 的 import 目标：

| 规则 | 被禁止的 import |
|---|---|
| `src/core/`、`src/gateway/` | `engines/`、`drivers/`、`@agentclientprotocol`、`pi-coding-agent` |
| `src/engines/`、`src/drivers/` | `storage/`、`gateway/`、`child_process`、`config/` |
| `src/integration/` | `engines/`、`drivers/`、`gateway/`、`storage/` |
| 全部适配器目录 | `core/gateway-core`、`fastify`、`node:sqlite` |
| `src/contracts/` | 任何非 `./` 的实现 |

`src/core`、`src/gateway`、`src/storage`、`src/runtime`、`src/integration`、`src/config`、
`src/security`、`src/contracts` 与 `src/main.ts` 中没有 `"opencode"`/`"pi"`/`"hermes"` 字面量；
引擎标识只在 `src/registry/index.ts` 绑定。

---

## 2. 北向契约

### 2.1 路由表

监听地址限定 loopback（`localhost`/`127.0.0.1`/`::1`），端口默认 6217。请求体上限 1 MiB；
所有 body 按 JSON 解析而不看 `Content-Type`；错误统一 `{code, message}`。

| 方法 | 路径 | 语义 | 成功响应 | 可能的错误 |
|---|---|---|---|---|
| POST | `/session` | 创建并持久化会话；`directory` 必填，不存在则创建 | 200 `{id,title,created_at,status}` | 400 `VALIDATION_ERROR`（非绝对路径 / 文件系统根 / 位于数据目录内）、403 `WORKSPACE_FORBIDDEN`、503 `SERVICE_UNAVAILABLE` |
| GET | `/session/status` | 所有活动会话的 idle/busy | 200 `{<id>:{type}}` | — |
| GET | `/session/{id}` | 会话与消息数 | 200 `{id,title,created_at,status,message_count}` | 404 `NOT_FOUND` |
| DELETE | `/session/{id}` | 尽力停止 → 清理原生目录与网关记录；不删工作目录 | 200 `{ok:true}` | 404、409 `SESSION_BUSY`/`ENGINE_SESSION_MISMATCH`、503 `EXECUTION_UNCERTAIN` |
| POST | `/session/{id}/prompt_async` | **阻塞整轮**，终态消息提交后返回 | 204 | 400、404、409 `SESSION_BUSY`/`GATEWAY_BUSY`/`SESSION_UNAVAILABLE`/`ENGINE_BINDINGS_CHANGED`/`ENGINE_MODEL_SWITCH_UNSUPPORTED`/`IDEMPOTENCY_CONFLICT`、502 `BAD_GATEWAY`/`ENGINE_*`、503 `EXECUTION_UNCERTAIN`/`HOST_*`、504 `EXECUTION_TIMEOUT` |
| GET | `/session/{id}/message` | 持久化消息快照（事实源） | 200 `Message[]` | 404 |
| GET | `/session/{id}/event?after&limit` | 该会话的事件历史分页（`limit` ≤ 256） | 200 `{events,next_cursor,complete}` | 400、404 |
| POST | `/session/{id}/abort`、`/stop` | 请求停止并等待停止证据；空 body 可接受 | 200 `{ok:true}` | 404、409 `SESSION_UNAVAILABLE`、503 `EXECUTION_UNCERTAIN` |
| GET | `/event` | SSE 全局事件流；15 秒心跳；`Last-Event-ID` 补发 | `text/event-stream` | — |
| GET | `/question`、`/permission` | 仍在等待回复的请求 | 200 数组 | — |
| POST | `/question/{id}/reply` | `{"answers":[["A"]]}`；扁平数组自动提升 | 200 `{ok:true}` | 400、404、409 `INTERACTION_RESOLVED` |
| POST | `/permission/{id}/reply` | `{"reply":"once"|"always"|"reject"}` | 200 `{ok:true}` | 400、404、409 |
| GET | `/health/live` | 进程存活 | 200 `{status:"alive"}` | — |
| GET | `/health/ready` | 存储可用且未在关机排空 | 200 `{status:"ready",engine}` | 503 `{status:"not-ready"}` |
| GET | `/diagnostics` | 运行时诊断（第 9.5 节） | 200 | — |
| GET/POST/PUT | `/config`、`/config/raw`、`/config/validate`、`/config/environment`、`/config/files/instruction/*` | 设置文件的读取、校验、原子替换（第 7.6 节） | 200 | 400 `SETTINGS_INVALID`、403 `CONFIG_READONLY`、409 `CONFIG_CONFLICT` |

`prompt_async` 的 `model` 可为 `{providerID,modelID}`、`"provider/model"` 字符串或省略；
`parts[].text` 与 `parts[].content` 均可。`Idempotency-Key` 头只作用于同一会话。

### 2.2 并发与幂等

| 规则 | 实现 |
|---|---|
| 全局同时只有一个活跃 Run | `GatewayCore.admit()` 的单执行槽 |
| 同会话第二个请求 | 立即 409 `SESSION_BUSY`，无论前一个在排队还是执行 |
| 跨会话请求 | 进入有界 FIFO 队列（默认 8，`PNP_RUN_QUEUE_LIMIT`）；满则 409 `GATEWAY_BUSY` + `Retry-After: 5` |
| 排队中的请求 | 不写 Run、不发布 busy；deadline 从取得槽时起算；可被 abort（409 `EXECUTION_CANCELLED`，不产生 Run） |
| 同键同请求 | `completed` 直接返回；`running/cancelling/interrupted` 409 `RUN_ALREADY_EXISTS`；`failed/cancelled` 释放键后重跑 |
| 同键不同请求 | 409 `IDEMPOTENCY_CONFLICT` |

### 2.3 会话状态机

会话对外只有 `idle`/`busy`；内部另有恢复状态 `recovery` 与生命周期 `lifecycle`。

```text
                 POST /session
                      |
                      v
   +----------------------------------------------+
   | status=idle  recovery=ready                  |
   +----------------------------------------------+
                      | prompt_async takes the execution slot
                      v
   +----------------------------------------------+
   | status=busy  Run: running | cancelling       |
   +----------------------------------------------+
        |                              |
        | finishRun quiescent=true     | finishRun quiescent=false
        | -> idle, recovery = ready    | startup found an open Run
        |    | needs-native-resume     | ownership not verified
        v                              v
   (back to idle)          +----------------------------------------------+
                           | status=busy  recovery=blocked  (fenced)      |
                           |  prompt_async -> 409 SESSION_UNAVAILABLE     |
                           |  abort (no active run) -> 409                |
                           +----------------------------------------------+
                                          | stop proven (confirmStopped):
                                          | late channel / ownership check
                                          | / close() before delete
                                          v
                           +----------------------------------------------+
                           | status=idle  recovery=needs-native-resume    |
                           +----------------------------------------------+
                                          | next open(): resume, or a new
                                          v native session + context-lost
                           (back to busy on the next prompt)

DELETE /session/{id}: lifecycle active -> deleting -> rows removed
(busy, or blocked with an unproven stop: 409/503; deletion is the
 legitimate way out of a fence, with evidence)
```

`recovery` 的三个值与进入条件：

| `recovery` | 进入条件 | 下一轮 `open()` 时 |
|---|---|---|
| `ready` | 从未打开通道；通道正常 `close()` | 首次打开或按原生引用复用 |
| `needs-native-resume` | 通道被 `terminate()`（无论静默与否）；围栏解除后；进程重启后所有带原生引用的 idle 会话 | 驱动决定恢复（`session/load` / 同一 `session.jsonl`）或新建并发布 `session.context-lost` |
| `blocked` | 停止不可证明；启动时发现 `running/cancelling` 的 Run；归属核验未完成 | 拒绝执行，直到停止被证明或会话被删除 |

Run 的状态：`running → cancelling → {completed, failed, cancelled, interrupted}`；`interrupted`
只在停止不可证明时出现，且永不释放幂等键。围栏只作用于会话；`/health/ready` 只在存储不可用或
关机排空时为 503。

---

## 3. 一轮执行的生命周期

### 3.1 时序

```text
 Client        HTTP L1     Core L2      Integ        Channel      Engine
 |             |           |            |            |            |
 | POST /session           |            |            |            |
 |------------->           |            |            |            |
 |             | normalizeWorkspace; INSERT sessions |            |
 <-200 {id}----|           |            |            |            |
 | GET /event (SSE)        |            |            |            |
 |------------->           |            |            |            |
 | server.connected        |            |            |            |
 <-------------|           |            |            |            |
 | POST prompt_async       |            |            |            |
 |------------->           |            |            |            |
 |             |           | admit(): key, slot/queue, runnable?  |
 |             |           |-prepare()-->            |            |
 |             |           | model, tools, assets, authorize, permissions
 |             |           <------------|            |            |
 | model.resolved          |            |            |            |
 <-------------|           |            |            |            |
 |             |           | startRun: user msg + Run + busy (1 tx)
 | session.status{busy}    |            |            |            |
 <-------------|           |            |            |            |
 |             |           | open()  (no resident channel)        |
 |             |           |------------------------->            |
 |             |           | Pack: private config; host.start()   |
 |             |           |            |            |-spawn------>
 |             |           |            |            <-handshake--|
 |             |           | channel.native  -> bindNative        |
 |             |           <-------------------------|            |
 |             |           |-run(request, services)-->            |
 |             |           |            |            |-prompt----->
 |             |           |            |            <-text-------|
 |             |           <-emit(text.delta)--------|            |
 | message.part.updated  (checkpoint stored first)   |            |
 <-------------|           |            |            |            |
 |             |           |            |            <-tool call--|
 |             |           <-emit(tool.*)------------|            |
 | message.part.updated  (tool part / role=tool)     |            |
 <-------------|           |            |            |            |
 |             |           | (engine -> MCP server: tools/call)   |
 |             |           |            |            | permission ask
 |             |           |            |            <------------|
 |             |           <-interact(permission)----|            |
 |             |           | authorize()             |            |
 |             |           |------------>            |            |
 | permission.asked   (only when effect = ask)       |            |
 <-------------|           |            |            |            |
 | POST /permission/{id}/reply          |            |            |
 |------------->           |            |            |            |
 | permission.resolved     |            |            |            |
 <-------------|           |            |            |            |
 |             |           |-decision----------------------------->
 |             |           |            |            | stop reason
 |             |           |            |            <------------|
 |             |           | EngineResult{state,finish,quiescent,...}
 |             |           <-------------------------|            |
 |             |           | open calls -> result_unknown observation
 |             |           | finishRun: final msg + Run + Session (1 tx)
 | message.part.updated (text, step-finish)          |            |
 <-------------|           |            |            |            |
 | session.status{idle}    |            |            |            |
 <-------------|           |            |            |            |
 | session.idle            |            |            |            |
 <-------------|           |            |            |            |
 <-204---------|           |            |            |            |
 | GET /session/{id}/message            |            |            |
 |------------->           |            |            |            |
 |             | full trajectory snapshot            |            |
```

### 3.2 步骤与归属

| 步 | 动作 | 位置 | 引擎参与 |
|---|---|---|---|
| 1 | 校验请求体，把 `parts`/`model` 投影为 `PromptRequest` | `app.ts` | 否 |
| 2 | 幂等键检查；取执行槽或排队；再次确认会话可执行 | `gateway-core.ts#admit` | 否 |
| 3 | `integration.prepare()` 解析本轮模型、工具、资产、策略；发布 `model.resolved` | `integration/configured/provider.ts` | 否 |
| 4 | 一个事务写用户消息 + Run + `busy`；发布 `session.status{busy}` | `storage/worker.ts#startRun` | 否 |
| 5 | 无驻留通道时 `engine.open()`；驻留上限 16，满额按 LRU `close()` 空闲通道；原生目录 `data/native/<engine>/<channel>/<session>/`；返回后 `bindNative` | `gateway-core.ts` | Pack + 驱动 |
| 6 | `channel.run()`；每个 `emit()` 都被等待，拒绝即终止本轮 | 驱动 | 是 |
| 7 | `services.interact()` → 策略 → 需要时发布 `*.asked` 并等待回复 | `interactions.ts` | 驱动发起 |
| 8 | 驱动返回 `EngineResult` | 驱动 | 是 |
| 9 | 收尾：未终态工具追加 `result_unknown` 观察；`finishRun` 一个事务写终态消息、Run 终态、Session 状态；提交后才发布 parts、`session.status{idle}`、`session.idle` | `gateway-core.ts` | 否 |
| 10 | HTTP 返回 204 | `app.ts` | 否 |

### 3.3 "一轮完成"的精确定义

| 信号 | 产生条件 | 产生位置 |
|---|---|---|
| HTTP 204 | `finishRun` 已提交且 `quiescent=true`；或调用方自己 abort 且停止已证明 | `app.ts` ← `GatewayCore.run` 正常返回 |
| 最后一条 assistant 消息 `info.finish="stop"` | 驱动 `EngineResult.finish` 为 `stop` | `gateway-core.ts`，直接取驱动值 |
| `parts` 含 `{"type":"step-finish"}` | **仅当** `state=completed && finish=stop` | `gateway-core.ts` |
| `session.status{idle}` + `session.idle` | 终态事务提交后，且停止已证明 | `gateway-core.ts` |

引擎只能通过 `EngineResult` 影响这四件事；`finish≠stop` 时 Core 不会补 `step-finish`。
`finalText` 为空串时最终消息使用累计的流式文本；失败或取消时 Core 在文本后追加失败说明。

### 3.4 取消与异常路径

| 触发 | Core 的动作 | 调用方看到 |
|---|---|---|
| `POST /session/{id}/abort` | `channel.cancel("user")`；宽限期（默认 15 s，`PNP_CANCEL_GRACE_MS`）内等 `run()` 落定；否则 `terminate()` | abort 返回 `{ok:true}`；被中止的 `prompt_async` 返回 **204**，轨迹 `finish:"cancelled"`、无 `step-finish`，`session.idle` 照常 |
| 运行 deadline（默认 15 min，`PNP_RUN_TIMEOUT_MS`） | 同上，原因 `deadline` | 504 `EXECUTION_TIMEOUT` |
| 关机排空 | 同上，原因 `shutdown`；排队请求以 503 结束 | 503 `SERVICE_UNAVAILABLE` |
| 停止无法证明 | Run 记 `interrupted`，会话 `blocked` 并从驻留表摘除，发布 `session.error{EXECUTION_UNCERTAIN}` | 503 `EXECUTION_UNCERTAIN`；该会话后续 409；其他会话与 `/health/ready` 不受影响 |
| 驱动 `run()` reject（进程退出、协议损坏） | 通道销毁，会话 `needs-native-resume`；下一轮 `open()` 由驱动恢复或新建 | 本轮按错误码返回；下一轮不被拒绝 |
| 事件非法（重复工具 id、族混用、超 1 MiB） | 拒绝该事件；随后所有事件 `EVENT_CHANNEL_CLOSED` | 502 |
| SSE 客户端断开 | 只销毁该连接；任务继续 | 重连带 `Last-Event-ID` 补发已提交事件 |

---

## 4. 可替换性：引擎接入的接缝

这是本设计的中心。"可替换"由公共契约、单点注册与边界脚本共同保证。

### 4.1 公共契约（`src/contracts/index.ts`，版本 1.1.0）

| 类型 | 方向 | 内容 |
|---|---|---|
| `EnginePack` | Core → Pack | `descriptor{id, channelId, transport, contractVersion, developmentOnly, implementationProvided}`；`open(EngineOpenInput)`；可选 `purge()` |
| `EngineOpenInput` | Core → Pack | 共享 `host`、`session`、`nativeDataDirectory`、`integration`、`resources`、`signal` |
| `EngineSessionChannel` | Core → 驱动 | `native`、`capabilities`、`run()`、`cancel()`、`terminate()`、`close()` |
| `DriverServices` | 驱动 → Core | `events.emit(DriverEvent)`（必须等待）、`interact(InteractionRequest)` |
| `DriverEvent` | 驱动 → Core | `text.delta`、`tool.started/updated/finished`、`tool.observed`、`usage`、`native{namespace,eventName,payload}` |
| `EngineResult` | 驱动 → Core | `state`、`finish`、`quiescent`、`finalText`、`nativeStopReason`、`taskOutcome` |
| `StopEvidence` | 驱动/宿主 → Core | `quiescent` + `method: protocol | process-tree | not-running` |
| `IntegrationContext` | 集成 → Core → 驱动 | `model: ResolvedModel`、`tools: ToolBinding[]`、`assets: AssetBinding[]`、`authorize()`、`permissions` |
| `ProcessHost` / `LaunchSpec` | 适配器 → 宿主 | `start(spec, signal, resources)` → `HostedProcess{write,onFrame,onExit,terminate}` |

契约对引擎只提出四个问题：怎么打开独立会话通道（`open`）、一轮怎么跑完并给出停止原因与停止证据
（`run` → `EngineResult`）、怎么取消（`cancel`，ACK 不是停止）、怎么终止并证明（`terminate`/`close` →
`StopEvidence`）。

### 4.2 接缝一览

| 接缝 | 两侧 | 跨越接缝的东西 | 为什么在这里 |
|---|---|---|---|
| A Core ↔ Pack | `GatewayCore` ↔ `EnginePack`/`EngineSessionChannel` | `open`、`run`、`cancel`、`terminate`、`close`、`purge`；`DriverEvent`、`EngineResult` | 引擎之间变的是协议、启动、配置格式、权限模型；不变的是会话身份、持久化、终态语义、北向响应 |
| B Pack ↔ Driver | `AcpEngineDefinition`（`drivers/acp/channel.ts`）；`openPiSession()`（`drivers/pi-rpc/channel.ts`） | `launch()`、`projectAssets()`、模型策略、超时 | "这个引擎"与"这种协议"分开，第二个 ACP 引擎不复制驱动 |
| C Core ↔ Integration | `IntegrationProvider.prepare()` | `ResolvedModel`、`ToolBinding[]`、`AssetBinding[]`、`PermissionPolicy`、`authorize()` | 换引擎不换配置，换配置不碰引擎；适配器禁止 import `src/config/` |
| D 适配器 ↔ ProcessHost | `input.host.start(LaunchSpec)` | 可执行文件、参数、cwd、env、`sessionId`、`ownerToken` | 归属记录、Job Object、终止证据、崩溃核验对所有引擎一致 |
| E 引擎 ↔ MCP | 标准 MCP（`spec/mcp-integration-profile.md`） | `tools/list`、`tools/call` | 工具作者只写一次；OpenCode 用自带 MCP 客户端，Pi 用扩展内的 MCP 客户端 |

### 4.3 单点注册与选择

`src/registry/index.ts`（38 行）是引擎标识唯一出现的地方：

```text
factories = { mock, opencode, hermes, pi }   # 每项一行动态 import
engineIds(development)    # 非开发模式隐藏 mock
loadEngine(id, dev)
   未知 id                       -> ENGINE_NOT_FOUND
   developmentOnly 且非开发模式   -> MOCK_FORBIDDEN
   implementationProvided=false  -> ENGINE_UNAVAILABLE (503)
selectEngine(--engine, AGENT_ENGINE)
   两者都给且不同                -> ENGINE_CONFIGURATION_CONFLICT
   都不给                        -> ENGINE_NOT_FOUND
   空字符串视为未设置
```

一个网关进程只运行一个引擎；会话固定绑定 `engineId + channelId`，跨引擎不隐式迁移
（`ENGINE_SESSION_MISMATCH`）。切换引擎的方式是停止后以另一取值重启。

### 4.4 情形一：引擎会说 ACP

需要新建或修改：

| 文件 | 内容 | 参照 |
|---|---|---|
| `src/engines/<id>/pack.ts` | 填一个 `AcpEngineDefinition`：`launch()` 返回可执行文件、参数、cwd、env；`projectAssets()` 把指令/技能放到引擎扫描的位置；`model` 策略选 `launch` 或 `session-config` | `src/engines/opencode/pack.ts` |
| `src/engines/<id>/*.ts` | 引擎特有事实：可执行文件在哪、私有配置形状、模型端点与请求头怎么注入、权限块怎么写、全局配置怎么隔离 | OpenCode 的 `config.ts`、`executable.ts`、`native-config.ts`、`assets.ts` |
| `src/registry/index.ts` | 一行工厂 | 现有 4 行 |
| `config/engines/<id>.json` | 版本、分发形态、路径候选、超时、`capabilityEvidence` | `config/engines/opencode.json` |
| `engines.lock.json` | 版本 + tarball SHA-256 | 现有 2 条 |
| `tests/adapters/<id>/` | Pack 单测 + `tests/kit/engine-contract.ts` 公共契约 | `tests/adapters/opencode/` |

协议层零改动：`src/drivers/acp/` 的握手、`session/new`/`session/load`、MCP 投影、权限往返、取消、
终态、能力账本原样复用。Hermes Pack 以这个形状声明（`channelId: "acp"`，`implementationProvided: false`），是该接缝的空实现示例。

```text
// src/engines/<id>/pack.ts (sketch)
export class XPack implements EnginePack {
  readonly descriptor = { id: "x", channelId: "acp", transport: "acp",
    contractVersion: CONTRACT_VERSION, developmentOnly: false,
    implementationProvided: true };
  async open(input: EngineOpenInput) {
    const definition: AcpEngineDefinition = {
      engineId: "x", channelId: "acp", engineVersion: "<locked>",
      model: { kind: "launch", modelID: "<provider/model>" },
      launch: async () => ({ executable, args: ["acp"],
        cwd: input.session.directory,
        env: { /* private config pointer; model endpoint and header
                 variables -> values; credentials live only here */ } }),
      projectAssets: async ({ assets, nativeDataDirectory }) => ({}),
    };
    return openAcpChannel(definition, input);
  }
}
```

### 4.5 情形二：引擎有自己的进程协议

在情形一之上新增 `src/drivers/<protocol>/`，实现 `EngineSessionChannel` 的
`run/cancel/terminate/close` 与 `capabilities`。规模参照 Pi 驱动：

| 文件 | 职责 | 行数 |
|---|---|---|
| `channel.ts` | 事件分派、终态判定、取消、交互路由 | 385 |
| `launch.ts` | 启动参数、私有配置、模型绑定、指令注入 | 370 |
| `protocol.ts` | 帧类型与解析（未知类型降级为 `unknown`） | 180 |
| `client.ts` | 命令与响应的 id 关联 | 84 |
| `tool-bridge.ts` | `ToolBinding[]` → 引擎能接受的形状 | 109 |

驱动必须遵守的规则（`spec/contracts.md` 第 2、4 节）：`run()` 返回前必须完成终态判定；
请求 ACK 不是完成；取消 ACK 不是静默；`quiescent=true` 只能来自协议终态、进程树核验或从未启动。

### 4.6 情形三：引擎缺少网关需要的能力

Pi 没有权限系统、没有 MCP 客户端、没有额外指令文件的配置项。解决方式不是降低网关要求，而是把缺的
部分作为引擎原生扩展装进引擎进程（`src/drivers/pi-rpc/extension/pnp-bridge.ts`，走 Pi 的 `-e`
扩展加载与 `tool_call`/`before_provider_request`/`session_shutdown` 钩子）。网关侧的
`InteractionBroker`、策略、`GET /permission`、回复端点对两个引擎是同一份代码。

### 4.7 接入新引擎时不碰的文件

| 区域 | 文件 |
|---|---|
| 北向 | `src/gateway/app.ts`、`schemas.ts` |
| Core | `src/core/gateway-core.ts`、`interactions.ts`、`journal.ts`、`errors.ts` |
| 存储 | `src/storage/*`（Schema 无引擎列） |
| 集成与配置 | `src/integration/*`、`src/config/*`、`config/settings.json`（按引擎覆盖用 `cores.<id>` 段） |
| 工具 | `src/tools/office-mcp/*`、`desktop-mcp/*`、`pdf-mcp/*` |
| 进程与 Windows | `src/runtime/*`、`native/windows/*` |
| 契约 | `src/contracts/*`（除非契约升版） |
| 端到端 | `scripts/e2e/run-e2e.mjs` 的用例对每个引擎同一份 |

### 4.8 新引擎免费获得的能力

| 能力 | 提供者 | 新引擎的义务 |
|---|---|---|
| 会话创建/查询/删除、消息快照、SSE、幂等、并发控制 | `src/gateway`、`src/core` | 无 |
| 持久化与崩溃后恢复、`needs-native-resume`/`blocked` | `src/storage`、`src/runtime/recovery.ts` | `open()` 收到 `session.native` 时决定恢复或新建 |
| question/permission 端点、策略裁决、超时、`always` 记忆 | `src/core/interactions.ts` | 把原生请求转成 `services.interact()` |
| 模型端点/凭据/请求头/CA/代理解析 | `src/integration`、`src/config/settings.ts` | 把 `ResolvedModel` 投影成原生配置，值只进 env |
| MCP 工具登记与 sideEffect 分类 | `config/settings.json` + `src/integration` | 把 `ToolBinding[]` 投影成引擎能接受的形状；投影不了的如实报告 |
| 进程启动、Job Object、归属记录、终止证据 | `src/runtime/process-host.ts` | 返回 `LaunchSpec`，调用 `input.host.start()` |
| 脱敏、事件与输出上限、检查点合并 | `src/core`、`src/security` | 无 |
| 公共契约测试 | `tests/kit/engine-contract.ts` | 提供夹具 |

`tests/kit/engine-contract.ts` 对每个 Pack 断言同一组事实：一轮后 `status=idle`、最后一条消息
`info.finish="stop"`、最后一个事件 `session.idle`、`native.nativeId` 已绑定、第二轮复用通道、
删除后 404。

---

## 5. 两个引擎对照

差异全部在 `src/engines/` 与 `src/drivers/` 内消化；北向看到的是同一套事件与消息。
不对称是有意保留的：两个引擎各自的权限模型、模型注入方式与完成证据都按原样接入。

### 5.1 对照表

| 维度 | OpenCode / ACP | Pi / RPC |
|---|---|---|
| Pack | `src/engines/opencode/`（`pack.ts` 129 行 + 4 个文件） | `src/engines/pi/pack.ts`（33 行） |
| 启动目标 | Bun 编译的独立 `opencode.exe acp` | `node dist/bundle/cli.js --mode rpc --session <file> --session-dir <dir> --no-approve --provider <p> --model <m> [--append-system-prompt <text>] -e <bridge>` |
| 传输 | ACP v1，`@agentclientprotocol/sdk` 1.4.0，stdio JSON-RPC | Pi RPC，LF 分隔 JSONL，`{"type":"response"}` 按 id 关联 |
| 模型注入 | 私有 `opencode.json`：`provider.<id>.npm`、`options.baseURL`、`apiKey/headers` 用 `{env:VAR}` 引用；`model` 钉死 | 私有 `models.json`（`PI_CODING_AGENT_DIR`）：`api`、`baseUrl`、`apiKey: "$VAR"`、`headers: {"X":"$VAR"}` |
| 协议映射 | `openai-chat → @ai-sdk/openai-compatible`；`anthropic-messages → @ai-sdk/anthropic` | `openai-chat → openai-completions`；`anthropic-messages → anthropic-messages` |
| 模型切换 | `launch` 策略：请求其他模型 → 409 `ENGINE_MODEL_SWITCH_UNSUPPORTED`；`session-config` 策略：经 ACP `session/set_config_option` 切换 | 模型指纹与打开时不同 → 409 `ENGINE_BINDINGS_CHANGED`（凭据变量在进程启动时固定） |
| 权限来源 | 引擎原生 `session/request_permission`；PNP 的 ask/deny 投影为原生 `ask`，`external_directory` 在默认 allow 时显式写 allow | 桥扩展的 `tool_call` 钩子：`read` 类放行，其余 `ctx.ui.confirm("pnp:<op>")` 问网关；无 UI 或异常一律阻断 |
| 权限操作名 | 映射器锁定的调用名 → `name` → `kind` → `title` → `toolCallId` | 内建工具映射：`bash/powershell→shell`、`write/edit→write`、`read/grep/find/ls→read`；桥接工具按服务器 `sideEffect` 归类 |
| 指令投影 | 复制到私有目录，`instructions[]` 写绝对路径 | 读取文本，`--append-system-prompt` 一个参数 |
| 其他资产 kind | `skill` 有投影位置（`OPENCODE_CONFIG_DIR/skills/<id>/` 与 XDG 配置根）；其余 kind 必需时以 `ENGINE_ASSET_KIND_UNSUPPORTED` 拒绝、可选时报告跳过 | 只投影 `instruction`；本交付的 `prepare()` 也只产出 `instruction` 资产 |
| MCP 路径 | `session/new.mcpServers`（引擎自带 MCP 客户端）；`mcp-http` 仅在 `initialize` 声明 `mcpCapabilities.http` 时投影 | sidecar `pnp-tools.json`（只含变量名）→ 桥扩展用 MCP SDK 连接并 `registerTool` |
| 工具事件族 | `tool.observed`（分阶段观察，名字来源 `name`/`announced-title`） | `tool.started/updated/finished` |
| 完成证据 | `session/prompt` 响应的 `stopReason`（`end_turn→stop`、`max_tokens→length`、`refusal→content-filter`、`cancelled→cancelled`、其余 `unknown`） | `agent_settled` 事件落定；`agent_end.messages` 末条的 `stopReason` 经 `mapFinish` |
| 取消 | `session/cancel` 通知（1 s 写超时）+ 等 prompt 响应（2 s 宽限）；超时则 `quiescent=false` | `abort` 命令 + 等 `agent_settled` 或进程退出 |
| 原生恢复 | `session/load`（引擎声明 `loadSession`）；否则新建并发布 `session.context-lost` | `--session` 指向同一 `session.jsonl` |
| 全局配置隔离 | `OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、四个 `XDG_*_HOME` 指向会话私有目录；`share: "disabled"`；`tools.question=false` | `PI_CODING_AGENT_DIR` 指向会话私有目录；`PI_TELEMETRY=0` |
| Windows shell | 无 `bash.exe` 时 `shell` 钉为 Windows PowerShell 5.1 绝对路径 | 私有 `settings.json` 写 `defaultTools`，`powershell` 替代 `bash`（有 Git Bash 时两者都保留） |
| 绑定变化 | 工具/资产指纹变化 → 409 `ENGINE_BINDINGS_CHANGED` | 工具或模型指纹变化 → 409 `ENGINE_BINDINGS_CHANGED` |
| 能力记录 | `AcpCapabilityLedger`：17 条记录，`declared → probed → verified` 只升不降 | `pi.mcp-bridge` 扩展能力，`evidence: probed` |

### 5.2 OpenCode 通道的数据流

```text
IntegrationContext --> engines/opencode/pack.ts
  model, tools,      writeNativeConfig()  -> <native>/opencode/opencode.json
  assets, permissions  projectOpenCodeAssets() -> <native>/opencode/assets/
                       env: XDG_*_HOME, OPENCODE_CONFIG(_DIR),
                            header vars, proxy vars
                         |
                         v
                    AcpEngineDefinition
                         |
                         v
drivers/acp/channel.ts  openAcpChannel()
  host.start(LaunchSpec)      --> opencode.exe acp   (ProcessHost, Job)
  initialize                  --> AcpCapabilityLedger
  mcpServersFor(tools)        --> session/new | session/load
                                  {cwd, mcpServers}
  run():  session/prompt      --> session/update*
                                  -> SessionUpdateMapper -> DriverEvent
          session/request_permission -> services.interact()
          prompt response.stopReason  -> EngineResult
  cancel(): session/cancel    (ACK is not evidence)
  terminate()/close(): session/close (if available)
                       -> hosted.terminate() -> StopEvidence
```

### 5.3 Pi 通道的数据流

```text
IntegrationContext --> engines/pi/pack.ts
                   --> drivers/pi-rpc/channel.ts openPiSession()
  writeToolBridge()      -> <native>/pnp-tools.json        (var names)
  writePiModelsConfig()  -> <native>/pi-agent/models.json  ($VAR refs)
  writePiSettings()      -> <native>/pi-agent/settings.json
  buildLaunchSpec()      env = system allow-list + proxy + generated
                               PNP_PI_* variables -> values
        |
        v
  host.start(LaunchSpec) --> node cli.js --mode rpc ... -e pnp-bridge.js
                                       |
          +----------------------------------------------------+
          | inside the Pi process: extension/pnp-bridge.ts     |
          | 1. read PNP_PI_BRIDGE_FILE; MCP client per server  |
          |    tools/list -> registerTool(<server>_<tool>)     |
          | 2. on("tool_call"): read -> allow; otherwise       |
          |    ctx.ui.confirm("pnp:<op>", {tool, patterns})    |
          | 3. on("before_provider_request"): text-array fix   |
          | 4. on("session_shutdown"): close MCP clients       |
          +----------------------------------------------------+
                                       |
  get_state (handshake) <--------------+
  run():  prompt --> message_update / tool_execution_* -> DriverEvent
          extension_ui_request{title:"pnp:<op>"} -> services.interact()
            -> extension_ui_response{confirmed}
          agent_end -> stopReason;  agent_settled -> EngineResult
  cancel(): abort command   (acceptance is not a stop)
  terminate()/close(): process.terminate() -> StopEvidence
```

### 5.4 引擎原生行为是被感知的，不是被驱动的

网关只归一化北向必须看到的部分：文本增量、工具调用与结果、停止原因、权限/反问请求形状、停止证据。
其余按引擎原样保留：

| 机制 | 实现 |
|---|---|
| 原生事件透传 | 两个驱动未处理的帧都作为 `DriverEvent.native{namespace, eventName, payload}` 上报，Core 发布为 `engine.extension{namespace, nativeType, payload}`；命名空间 `acp` / `pi` |
| 能力带证据等级 | `Capability.evidence: declared | probed | verified`；ACP 账本 `observe()` 只升不降 |
| 工具名来源如实记录 | `tool.observed.nameSource`：`name`（引擎程序化字段）或 `announced-title`（宣告时的 title）；身份只解析一次，后续 title 变化不改名 |
| 传输能力按声明投影 | ACP 只在引擎声明 `mcpCapabilities.http` 时投影 `mcp-http`；否则发布 `tools.unsupported-transport` 并说明原因。Pi 桥丢弃 `cli`/`native` 绑定并同样报告 |
| 补能力不删能力 | Pi 桥加了权限门与 MCP 客户端，Pi 内建工具全部保留 |
| 指令走各自原生路径 | OpenCode `instructions[]`，Pi `--append-system-prompt`；不压成同一种格式 |

---

## 6. 工具层：MCP 协议边界

### 6.1 一条配置到达两个引擎

```text
config/settings.json   common.mcp.servers.<id>
  { transport, command | url, args, env | headerEnvironment (names),
    sideEffect, timeoutMs }
        |  src/config/settings.ts: parse + merge
        |  src/integration: variable names -> values
        v
  ToolBinding (mcp-stdio | mcp-http)    on every IntegrationContext.tools
        |
        +--------------------------+--------------------------------+
        |                                                           |
        v                                                           v
  drivers/acp/channel.ts                       drivers/pi-rpc/tool-bridge.ts
  mcpServersFor()                              projectPiTools()
  -> session/new.mcpServers                    -> pnp-tools.json (names)
        |                                         + LaunchSpec.env (values)
        v                                                           v
  OpenCode's own MCP client                    pnp-bridge.ts in Pi process
  spawns server processes                      (MCP client) spawns them
        |                                                           |
        +--------------------------+--------------------------------+
                                   v
        +--------------------+--------------------+--------------------+
        | office (Node)      | desktop (Node)     | pdf (Python)       |
        | 18 tools           | 2 tools            | 3 tools + info     |
        | sideEffect: write  | sideEffect: extern.| sideEffect: read   |
        +--------------------+--------------------+--------------------+
  server processes are children of the engine, hence inside its Job.
```

`src/engines/**` 与 `src/drivers/**` 中没有针对任何服务器 id 的代码分支；
增删一个服务器只改 `config/settings.json`。

### 6.2 三个服务器

| 服务器 | 语言 / 入口 | 工具 | `sideEffect` |
|---|---|---|---|
| `office` | Node，`dist/tools/office-mcp/main.js`，`@modelcontextprotocol/sdk` | `docx_extract`、`docx_replace_paragraphs`、`docx_create`、`xlsx_read`、`xlsx_write`、`pptx_extract`、`pptx_replace_text`、`pptx_reorder_slides`、`pptx_delete_slides`、`pptx_create`、`csv_read`、`data_aggregate`、`fs_find`、`fs_delete`、`doc_verify`、`app_open`、`web_fetch`、`server_info` | `write` |
| `desktop` | Node，`dist/tools/desktop-mcp/main.js` | `desktop_list_apps`、`desktop_open_app`（固定允许列表：Notepad、经典 Outlook、新 Outlook；经 Windows Shell 激活） | `external` |
| `pdf` | **Python**，`dist/tools/pdf-mcp/launch.js` → `src/tools/pdf-mcp/main.py`；`pypdf 6.13.3` 随包 vendored，无其他依赖 | `pdf_extract`、`pdf_extract_tables`、`pdf_info`、`server_info` | `read` |

每个工具在 MCP 层同时发布标准 annotations 与 `_meta.sideEffect`；策略只以设置文件里的服务器级
`sideEffect` 为准，annotations 只是提示。stdout 只承载 JSON-RPC 帧，诊断一律走 stderr。

### 6.3 为什么 Python 服务器是可能的

工具边界是一个**进程协议**边界：设置文件声明 `command + args`，网关（经引擎）spawn 它，之后只有
MCP 帧往来。因此服务器可以用任何语言写，且不需要引擎侧任何代码。`pdf` 服务器的 Node 启动器只做两件事：

| 步骤 | 行为 |
|---|---|
| 解释器解析（`python.ts`） | 顺序：`PNP_PYTHON` → 包内自带 → PATH；每个候选实际执行一次探测，要求 CPython ≥ 3.9 |
| 找到解释器 | `spawn(python, [main.py], {stdio:"inherit"})`：Python 进程直接继承网关的管道，Node 不解析、不转发任何帧 |
| 找不到解释器 | 启动器自己以 MCP 服务器身份应答，只发布一个 `server_info` 工具，报告 `available:false`、找过的候选与需要设置的变量；引擎看到的是一个健康但目录为空的服务器，`office` 与 `desktop` 不受影响 |

Python 侧 `mcp_stdio.py` 直接按规范实现 stdio 传输（`initialize`、`tools/list`、`tools/call`），
协商版本集合 `2025-11-25 … 2024-10-07`，不依赖任何 SDK。

### 6.4 `sideEffect` 到策略的路径

| 位置 | `sideEffect` 的用法 |
|---|---|
| `settings.json` | `read | write | external`；缺省按 `external`（最强） |
| `ToolBinding.sideEffect` | 每轮随上下文传给驱动 |
| OpenCode | 原生权限键是 `edit`/`bash`/`external_directory` 等操作类；MCP 工具调用不经引擎权限提问 |
| Pi 桥 | 桥接工具按服务器 `sideEffect` 映射为 `read`/`write`/`external` 操作；`read` 直接放行，其余向网关 `interact()` |

两个引擎对同一策略的提问点不同，这是保留原生权限模型的结果；网关只保证提问一旦发生，
形状（`{id, sessionID, permission, patterns, ...}`）、端点与裁决来源一致。

---

## 7. 配置

### 7.1 两层结构

`config/settings.json` = `{version: 1, common, cores.<engineId>}`。`common` 是基线，
`cores.<id>` 是加法覆盖；`common` 与每个 `cores.<id>` 只接受同样的八个键。

| 键 | 合并规则 | 到达引擎的路径 |
|---|---|---|
| `model.models[]` | 同 `providerID/modelID` 的条目按引擎替换 | `ResolvedModel` → OpenCode 私有 `opencode.json` / Pi 私有 `models.json` |
| `model.default` | 引擎值覆盖；可只写 `providerID`（该 provider 恰有一个模型时） | `prepare()` 把省略或未配置的选择解析到默认模型，发布 `model.resolved` |
| `permissions.default` | 引擎值覆盖 | `IntegrationContext.permissions` + `authorize()` |
| `permissions.operations` | 按操作名合并，引擎条目优先；`PNP_CONFIGURED_POLICY_OVERRIDES` 最后覆盖 | OpenCode 投影为原生 `permission` 块；Pi 桥在钩子里问网关 |
| `instructions[]` | 引擎列表**整体替换**（`[]` 表示无指令） | 每个文件成为 `kind=instruction` 的必需资产（带 SHA-256）；OpenCode `instructions[]`，Pi `--append-system-prompt` |
| `mcp.servers` | 按服务器 id 部分覆盖（`enabled:false` 可只对一个引擎关闭） | `ToolBinding[]`（第 6 节） |
| `skills`、`assets.<kind>`、`packs` | 按 id 部分覆盖；路径必须在批准的资产根内 | 解析、合并、校验路径；本交付没有为这些域连接原生投影器：`required` 条目在启动时以 `ENGINE_ASSET_KIND_UNSUPPORTED`/`PACK_LOADER_UNAVAILABLE` 拒绝，可选条目记入 `configuration.capabilities.skipped` |
| `native` | 浅合并 | 非空时启动以 `NATIVE_OPTIONS_UNSUPPORTED` 拒绝 |

### 7.2 模型定义

| 字段 | 含义 |
|---|---|
| `selection` | `{providerID, modelID}`，设置文件内的身份 |
| `protocol` | `openai-chat` 或 `anthropic-messages` |
| `endpoint` / `endpointEnvironment` | 二选一：字面 URL，或持有 URL 的变量名 |
| `modelIDEnvironment` | 端点期望的模型名的变量；加载时替换 `selection.modelID`，全程一个标识 |
| `headerEnvironment` | 请求头名 → 变量名；每个都必需 |
| `headersEnvironment` | 一个持有 JSON 对象的变量（附加头，如 appid） |
| `apiKeyEnvironment` | 裸凭据变量；没有其他 `Authorization` 时发 `Authorization: Bearer <value>` |
| `caFileEnvironment` | PEM 路径变量；相对路径按包根解析；启动时检查存在 |

传输规则对字面值与变量值一视同仁：`https` 任意；`http` 仅 loopback，除非 `PNP_ALLOW_HTTP_ENDPOINTS=1`；
URL 中不得含凭据。`PNP_MODEL_TLS_INSECURE=1` 作为 `ResolvedModel.tlsInsecure` 传给 Pack。

交付的设置文件只声明一个模型，其每个部分都是变量名，所以部署只设变量、不改文件：

| 变量 | 必需 | 含义 |
|---|---|---|
| `PNP_MODEL_ENDPOINT` | 是 | 模型服务基地址 |
| `PNP_MODEL_ID` | 是 | 端点期望的模型名 |
| `PNP_MODEL_API_KEY` | 否 | `Authorization: Bearer` |
| `PNP_MODEL_HEADERS` | 否 | 附加请求头 JSON |
| `PNP_MODEL_CA_FILE` | 否 | 私有 CA 的 PEM |

### 7.3 凭据的路径：名字在文件里，值只在进程环境里

```text
runtime/local.env  or process environment                     (values)
   | src/config/local-env.ts at startup; existing vars win; names only
   v
config/settings.json                                          (names)
   | parser requires the name shape ^[A-Za-z_][A-Za-z0-9_]*$
   | src/integration/index.ts resolves names -> values at load;
   | a missing one refuses the start, message carries the NAME
   v
IntegrationContext.model.headers / tools[].env / tools[].headers
   |                                     (values, re-resolved per turn)
   +--> OpenCode Pack: one PNP_OPENCODE_HEADER_* var per header
   |      opencode.json writes {env:VAR}; value goes to LaunchSpec.env
   |      Authorization: Bearer <t>  -> options.apiKey = {env:..._API_KEY}
   |
   +--> Pi driver: PNP_PI_MODEL_HEADER_<n> per header; models.json "$VAR"
   |      tool env / headers: PNP_PI_TOOLENV_<n> / PNP_PI_TOOLHDR_<n>;
   |      the sidecar file holds names only
   v
engine child environment = baseEnvironment() allow-list + proxy vars
                           + generated vars above
(the gateway's own environment is never inherited wholesale;
 no file on disk holds a resolved value)
```

`Redactor` 以本轮所有解析后的头值与工具 env 值为已知秘密，对消息、事件、诊断统一脱敏（第 8.6 节）。

### 7.4 启动顺序

```text
main.ts
  1. loadLocalEnvironment()      runtime/local.env -> env (names printed)
  2. selectEngine(--engine, AGENT_ENGINE); loadEngine()
  3. bind address (loopback only), port
  4. loadIntegration()           settings.json -> models/policy/tools/
                                 instructions
  5. probeIntegration()          default model vars, endpoint rule,
                                 CA file, instruction files
  6. ConfigService               settings.json SHA-256 (running.inSync)
  7. durations (PNP_*_MS), queue and resident limits
  8. acquireProcessLifetimeLock() Windows: helper guard handles;
                                 otherwise a lock file
  9. StateStore(pnp.db); LocalProcessHost; GatewayCore; buildApp
 10. core.initialize()           open Runs -> interrupted; fence blocked
 11. app.listen()                /health/ready = true
 12. recoverOwnedState() async   ownership records, 20 s bound,
                                 verdicts are per session
```

启动阶段错误不经 HTTP：进程以非零退出码结束并输出 `{code,message}`（`INSTANCE_LOCKED`、
`STORAGE_UNAVAILABLE`、`ENGINE_*`、`MODEL_ENVIRONMENT_MISSING` 等，消息中只有变量名）。

### 7.5 运行时参数

| 变量 | 默认 | 范围 | 作用 |
|---|---|---|---|
| `AGENT_ENGINE` / `--engine` | — | `opencode | pi | hermes` | 引擎选择 |
| `PNP_PORT` / `--port` | 6217 | 1–65535 | 监听端口 |
| `PNP_DATA_DIR` | `data` | — | 数据目录（SQLite、原生目录、归属记录、缓存） |
| `PNP_RUN_TIMEOUT_MS` | 900000 | 1 s–24 h | 一轮执行预算 |
| `PNP_OPEN_TIMEOUT_MS` | 60000 | 1 s–10 min | 通道打开与 `prepare()` 上限 |
| `PNP_CANCEL_GRACE_MS` | 15000 | 100 ms–5 min | 取消后等待 `run()` 落定 |
| `PNP_INTERACTION_TIMEOUT_MS` | 45000 | 1 s–10 min | 等待 question/permission 回复 |
| `PNP_MAX_RESIDENT_SESSIONS` | 16 | 1–64 | 驻留通道上限 |
| `PNP_RUN_QUEUE_LIMIT` | 8 | 1–128 | 跨会话队列长度 |
| `PNP_QUESTION_POLICY` | `auto` | `auto | ask` | 反问自答或等待回复 |
| `PNP_MODEL_STRICT` | 未设 | `1` | 未配置的模型选择 403 而非替换为默认 |
| `PNP_CONFIGURED_POLICY_OVERRIDES` | 未设 | JSON | 部署侧操作策略覆盖 |
| `PNP_SETTINGS` | `config/settings.json` | 路径 | 设置文件位置 |
| `PNP_CONFIG_READONLY` | 未设 | `1` | `/config` 写路由 403 |

### 7.6 配置 API

| 路由 | 应答 |
|---|---|
| `GET /config?engine=<id>` | 有效设置，每个值标注来源层（`common`/`core`/`environment`/`default`）、能力就绪报告、变更影响表 |
| `GET /config/raw` | 存储的文档，ETag = SHA-256 |
| `POST /config/validate` | 用加载时同一解析器校验候选文档，不写盘 |
| `GET /config/environment` | 文档引用的变量名及是否已设；从不返回值 |
| `GET /config/files?kind=instruction`、`GET /config/files/instruction/*` | 指令文件列表与文本 |
| `PUT /config` | 校验 → 备份到 `runtime/config-history/` → 临时文件重命名替换；`baseSha256` 不匹配 409 `CONFIG_CONFLICT` |
| `PUT /config/files/instruction/*` | 同样的原子替换，`ifMatch` 守卫 |

HTTP 边界双向拒绝形如凭据的字段值（`CONFIG_HTTP_UNSAFE_FIELD`）；`runtime/local.env` 不经任何路由。
写入改变的是文件而不是运行中的进程：模型目录、策略、MCP、指令列表在进程生命周期内固定；
指令文件的文本每轮由 `prepare()` 重新读取，ACP 会话以资产指纹在下一轮以 `ENGINE_BINDINGS_CHANGED` 拒绝，
Pi 会话保持启动时注入的文本。

---

## 8. 隔离、安全与生命周期

### 8.1 每个会话拥有什么

```text
<PNP_DATA_DIR>/
  pnp.db, pnp.db-wal             SQLite (WAL, synchronous=FULL, v2)
  gateway.lock / ownership.json  instance ownership
  cache/helper-<sha256>.dll      compiled Windows helper
  hosts/<hostId>.json            ownership record (written before spawn)
  hosts/done/  hosts/quarantine/ proven-stopped / undecidable records
  native/<engineId>/<channelId>/<sessionId>/
    opencode/opencode.json, xdg-*/, config/skills/,
    opencode/assets/instructions/                     (OpenCode)
    session.jsonl, pnp-tools.json,
    pi-agent/{models.json, settings.json}             (Pi)

<Session.directory>              caller-supplied workspace: engine cwd
                                 gateway creates it if missing,
                                 never deletes or writes into it
```

工作目录规则（`src/security/workspace.ts`）：

| 检查 | 结果 |
|---|---|
| 非绝对路径 / 文件系统根 / 位于 `PNP_DATA_DIR` 内 | 400 `VALIDATION_ERROR` |
| 位于 `SystemRoot`、`ProgramFiles`、`ProgramFiles(x86)` 下 | 403 `WORKSPACE_FORBIDDEN` |
| 不存在 | 创建并在会话记录 `directoryCreated: true` |
| 链接指回边界内 | 按 realpath 再检查一次 |

删除会话只删网关记录、原生目录（拒绝符号链接）与归属记录；`EnginePack.purge()` 只清引擎自有历史。

### 8.2 权限策略

```text
driver: services.interact({kind, operation, payload})
   |
   v
IntegrationContext.authorize(operation)
   -> {effect: allow | deny | ask, reasonCode}
      (permissions.operations[op] ?? permissions.default;
       deployment overrides already merged)
   |
   v
InteractionBroker.request()
   effect=allow (permission) -> allow now, source=policy,
                                publish permission.resolved
   effect=deny               -> deny now,  source=policy
                                (a user reply cannot override)
   effect=ask, remembered    -> allow, source=remembered
   effect=ask                -> persist + publish permission.asked; wait
       POST /permission/{id}/reply once|always|reject -> source=user
       question + policy auto  -> first option, source=auto
       45 s timeout            -> deny, source=timeout
       run ended / cancelled   -> deny, source=cancelled
```

| 规则 | 实现 |
|---|---|
| `always` 的范围 | 只在网关内记为"本会话 + 本操作"，不下发引擎原生 allow-always，删除会话即遗忘 |
| 组织 `deny` | 不进入可回复状态；`always` 不能覆盖 |
| 回复的一致性 | 重复回复、跨类型回复、已过期 → 409 `INTERACTION_RESOLVED` / 404 |
| `patterns` | 永远存在：ACP 取 `locations[].path` → `rawInput` 的路径键 → 路径形状的 title；Pi 桥从工具参数提取；引擎没指明则为空数组 |
| 引擎侧的 `allow` | ACP 只选 `allow_once`/`reject_once`，永不选 `*_always` |

### 8.3 进程宿主与 Windows Job Object

```text
Gateway (node.exe)
  | spawn powershell.exe -EncodedCommand (Add-Type JobHost.cs, cached)
  | stdin/stdout JSONL control: launch / write / terminate
  |                             prepared / ready / stdout / exit
  v
Supervisor helper (powershell.exe, owns the Job handle)
  | CreateJobObject("Local\PNP-<hostId>") + KILL_ON_JOB_CLOSE
  | CreateProcess(CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT
  |               | CREATE_NO_WINDOW)
  | AssignProcessToJobObject -> ResumeThread
  |   (in the Job before its first instruction)
  v
Engine root process  (opencode.exe | node.exe cli.js)
  +-- MCP server children (office / desktop / pdf -> python)
  +-- shells and anything else the engine starts

stop paths:
  terminate      -> stdin EOF -> grace (3 s) -> TerminateJobObject
  gateway exits  -> helper watches parentPid -> TerminateJobObject
  helper exits   -> Job handle closed -> KILL_ON_JOB_CLOSE kills the tree
desktop apps opened via Windows Shell activation are not members of
this tree; ending a session does not undo them.
```

| 阶段 | 行为 |
|---|---|
| 启动前 | 归属记录 `hosts/<hostId>.json` 先落盘；helper 报 `prepared{windowsSessionId}` 后网关写入记录，再发 `proceed`，helper 才创建 Job 与进程 |
| 环境 | 子进程只继承 `baseEnvironment()` 的系统键白名单（`SystemRoot`、`PATH`、`USERPROFILE`、`APPDATA` 等）+ 适配器给出的变量；网关自身环境不整体继承 |
| 可执行文件 | 必须是绝对路径；win32 必须以 `.exe` 结尾（npm `.cmd` 垫片被拒绝） |
| 帧 | 出站单帧 ≤ 4 MiB；未订阅时缓冲 ≤ 256 KiB（`HOST_BACKPRESSURE`） |
| 终止证据 | 三阶段：EOF + 宽限 → 杀 helper（关闭 Job 句柄）→ `taskkill /PID /T`（只按进程 id，从不按映像名）；每阶段核验后回写 `quiescent` |
| 降级 | helper 无法启动或在创建引擎前失败 → 直接 `spawn`，记录 `mode: "degraded"`；不拒绝本轮 |
| 诊断 | stderr 尾部 16 KiB 脱敏后随 `HOST_*` 错误消息给出；命令行与环境从不记录 |

### 8.4 归属核验与实例独占

启动时监听端口之后异步核验 `hosts/*.json`，每条记录从便宜到贵取证，命中即停：

| 序 | 证据 | 结论 |
|---|---|---|
| 1 | 记录的 `quiescent` 已为真 | 静默 |
| 2 | 记录创建时间早于本次开机 | 静默 |
| 3 | `helperPid` 为 0（从未 spawn） | 静默 |
| 4 | helper 进程不在进程列表 | 静默（Job 句柄随之关闭） |
| 5 | 进程 id 存活但映像名不符 | 静默（id 被复用） |
| 6 | helper 确实存活 | 启动一次 helper `inspect`，按 Job 名查活跃进程数；Windows 会话号不一致则不判静默 |

| 结论 | 处置 |
|---|---|
| 静默 | 解除会话围栏（置 `needs-native-resume`），记录移入 `hosts/done/` |
| 确实存活 | 会话保持 `blocked`；诊断列出文件名与原因 |
| 无法判定 / 无主记录 | 记录移入 `hosts/quarantine/` 并计数；不参与就绪门禁 |

实例独占：Windows 上 helper 的 `guard` 操作以无共享方式打开 `recovery.lock` 与 `gateway.lock`
并把句柄复制进网关进程，句柄随进程退出释放（`INSTANCE_LOCKED` 表示另一个活着的拥有者）；
guard 不可用时回退到记录 pid 与启动时间的锁文件，并输出降级原因。

### 8.5 存储

| 项 | 实现 |
|---|---|
| 引擎 | `node:sqlite` `DatabaseSync`，运行在 Worker 线程；HTTP 事件循环不被同步 API 阻塞 |
| 表 | `sessions`、`runs`（`UNIQUE(session_id, idempotency_key)`；部分唯一索引保证一个会话一个活跃 Run）、`messages`、`events`（全局自增 `sequence`，按会话索引）、`interactions` |
| 事务 | `startRun`：用户消息 + Run + busy；`finishRun`：终态消息替换流式投影并排在工具结果之后 + Run 终态 + Session 状态 |
| 迟到事件 | Run 终态后 `appendMessage` → 409 `LATE_EVENT` |
| 故障 | 单操作 15 s 超时；连续 3 次无应答替换 Worker；替换 3 次后报 `STORAGE_UNAVAILABLE`；未完成写入拒绝而不重放；`/health/ready` 随 `store.available` 恢复 |
| 崩溃恢复 | 启动时 `running/cancelling` 的 Run → `interrupted` + `GATEWAY_INTERRUPTED`，未闭合工具补 `gateway-recovery` 观察，追加一条 `finish: interrupted` 的说明消息，会话 `blocked`；pending 交互 → `expired` |

### 8.6 脱敏与上限

| 位置 | 规则 |
|---|---|
| `Redactor.text` | 已知秘密（本轮头值、工具 env/头值，≥ 4 字符）→ `[REDACTED]`；`Bearer …`、URL userinfo、`api_key=…` 形式 |
| `Redactor.streamText` | 流式文本末尾若是某个秘密的前缀则暂扣，等下一片段 |
| `Redactor.json` | 键名按分段判断（`token`、`secret`、`password`、`cookie`、`apikey`…）整值替换；`inputTokens` 等计数键不误伤 |
| HTTP 日志 | `authorization`、`cookie` 头脱敏；请求日志关闭 |
| 内部错误 | 对外一律 `INTERNAL_ERROR`；stderr 一行描述，环境变量值（≥ 12 字符）被遮盖 |
| 进程宿主 | 名字形如 key/token/secret/password 的 env 值在诊断中遮盖 |

| 上限 | 值 |
|---|---|
| 请求体 | 1 MiB（413 `BODY_TOO_LARGE`） |
| 单个事件 | 1 MiB（`EVENT_TOO_LARGE`） |
| 一轮累计文本 | 8 MiB（`OUTPUT_TOO_LARGE`） |
| 文本检查点 | 100 ms 门限，且增量 ≥ max(256 B, 已存的 1/4) |
| SSE 每连接缓冲 | 8 MiB；超限先丢 `message.part.updated`，控制事件从不丢 |
| SSE 补发 | 每页 256，单次重连最多 4096，不足时发 `server.gap` |
| 存储队列 | 1024 个待处理操作（`STORAGE_BACKPRESSURE`） |

---

## 9. 可观测性

### 9.1 事件词汇

所有事件经 `EventJournal.publish()` 先写 `events` 表（获得全局 `sequence`）再推给 SSE 订阅者；
`GET /event` 的 `id:` 行即 `sequence`。

| 类型 | 载荷 | 产生者 |
|---|---|---|
| `model.resolved` | `{sessionID, runID, requested, selected, resolution: exact | default | substituted}` | Core，执行前 |
| `session.status` | `{sessionID, runID, status:{type: busy | idle}}` | Core |
| `message.part.updated` | `{sessionID, runID, messageID, part}`；`part.type` 为 `text` / `tool` / `step-finish` | Core，落库后 |
| `run.usage` | `{sessionID, runID, messageID, inputTokens?, outputTokens?, source}` | Core ← 驱动 `usage` |
| `engine.extension` | `{sessionID, runID, messageID, namespace, nativeType, payload}` | Core ← 驱动 `native` |
| `permission.asked` | 驱动载荷 + `{sessionID, runID, id, permission, patterns}` | InteractionBroker |
| `permission.resolved` | `{sessionID, runID, id, decision, source, reasonCode}` | InteractionBroker |
| `question.asked` / `question.resolved` | 同上形状，无 `permission`/`patterns` | InteractionBroker |
| `session.error` | `{sessionID, runID, error:{code, message}}` | Core，失败或停止未证明 |
| `session.idle` | `{sessionID, runID}` | Core，终态提交且停止已证明 |
| `server.connected` / `server.heartbeat` | `{}`；无 `sequence` | SSE 连接 |
| `server.gap` | `{from, to | null, reason: replay-limit | pending-overflow | replay-failed}`；无 `sequence` | SSE 补发 |

`engine.extension` 的 `nativeType` 在 ACP 侧包括 `assets.projected`、`tools.unsupported-transport`、
`session.restored`、`session.context-lost`、`permission.resolved`、`model.applied`、`turn.settled`、
`updates.unattributed` 及未映射的 `session/update` 种类；Pi 侧为未映射的 RPC 事件类型与
`tools.unsupported-transport`。

### 9.2 轨迹（消息投影）

| 消息 | 形状 |
|---|---|
| 用户 | `{role:"user", content}` |
| 流式 assistant | `{role:"assistant", id: finalId, content, parts:[{type:"text", content, text}]}`；每个检查点覆盖同一 id |
| 工具调用（Pi 族） | `{role:"assistant", tool_calls:[{id,name,arguments}], info:{finish:"tool-calls"}, parts:[{type:"tool", tool, callID, input, state:{status, title, nameSource:"name"}}]}`；结果另起 `{role:"tool", tool_call_id, tool_name, content}` |
| 工具观察（ACP 族） | 一个调用一个 part，逐次重建：`{type:"tool", callID, source:"engine", phase, tool?, title?, input?, output?, content?, locations?, state:{status, title, nameSource, terminalStatus?, nativeStatus?, nativeType?}}`；`name` 与 `input` 都观察到才建立 `tool_calls`，终态且有 `output` 才建立 `role=tool` 消息 |
| 网关观察 | 引擎未闭合的调用追加 `{type:"tool", callID, state:{status:"error", terminalStatus:"result_unknown" | "cancelled", source:"gateway-observation", quiescent}}` |
| 最终 assistant | `{role:"assistant", id: finalId, content, info:{finish, nativeFinish}, parts:[{type:"text",...}, {type:"step-finish"}?]}` |

`finish` 的取值：`stop`、`length`、`error`、`content-filter`、`unknown`、`cancelled`、`interrupted`；
`nativeFinish` 保留引擎原始停止原因（如 `end_turn`、`agent_settled`）。

### 9.3 SSE 断线续传

| 机制 | 行为 |
|---|---|
| `retry: 3000` | 连接建立即发 |
| `Last-Event-ID: n` | 先补发 `n` 之后的已提交事件（每页 256，最多 4096），期间到达的实时事件暂存并按序号去重 |
| 缺口 | 补发触顶、暂存溢出或查询失败时发 `server.gap{from,to,reason}`；客户端可用 `GET /session/{id}/event?after=` 或再次重连补齐 |
| 慢客户端 | 缓冲超 8 MiB：先丢内容事件，控制事件积压超限才销毁该连接；其他连接不受影响 |

### 9.4 每会话事件历史

`GET /session/{id}/event?after=<sequence>&limit=<1..256>` 直接查 `events` 表（`events_by_session`
索引），返回 `{events, next_cursor, complete}`。序号全局稀疏：同一会话的序号递增但不连续。

### 9.5 `/diagnostics`

| 字段 | 含义 |
|---|---|
| `sessions`、`runs`、`interrupted`、`blocked` | 持久化计数；读失败时为 `null` 并附 `storageError` |
| `ready` | 与 `/health/ready` 相同的判定 |
| `storage` | 最近 32 条存储诊断（类别、代码、结果 `known-failed`/`unknown`） |
| `degraded`、`fencedSessions[{id, reason, at}]` | 是否有围栏会话及原因（`RUN_STOP_UNVERIFIED`、`EVICTION_STOP_UNVERIFIED`、`STARTUP_STOP_UNVERIFIED`、`RECOVERY_STOP_UNVERIFIED`、`TERMINAL_PERSISTENCE_UNVERIFIED`、`INTEGRATION_RELEASE_UNVERIFIED`） |
| `recovery` | 归属核验摘要：`interrupted`、`confirmedSessions`、`blockedSessions`、`invalidRecords`、`unverifiedRecords`、`quarantinedRecords`、`archivedRecords`、`issues[{file, reason, sessionId, detail}]` |
| `activeRuns`、`residentChannels`、`queued{count, sessions}` | 执行槽、驻留通道、队列 |
| `engine`、`channel` | 本进程的引擎与通道 id |

### 9.6 启动与运行日志

进程 stdout/stderr 只有 JSON 行：`local-env.loaded{file, names}`（只有名字）、
`model.substituted{requested, selected}`、`configuration.capabilities.skipped`、
`internal-error{code, message}`（已遮盖）、`shutdown.unverified`、`storage.close.failed`。
引擎子进程的 stderr 由进程宿主捕获、脱敏后只在 `HOST_*` 错误消息中出现。

---

## 10. 文件索引

| 路径 | 作用 |
|---|---|
| `src/contracts/index.ts`、`host.ts` | 公共契约 1.1.0 |
| `src/registry/index.ts` | 引擎 id → Pack；`selectEngine` |
| `src/main.ts` | 启动顺序 |
| `src/gateway/app.ts`、`schemas.ts` | 北向路由、SSE、请求 Schema |
| `src/core/gateway-core.ts` | Session/Run 状态机、执行槽与队列、事件投影、终态判定、围栏 |
| `src/core/interactions.ts`、`journal.ts`、`errors.ts` | 交互裁决、事件日志、错误类型 |
| `src/storage/{store,worker,protocol}.ts` | SQLite Worker、Schema、事务 |
| `src/integration/index.ts`、`configured/provider.ts` | 设置 → 契约类型；每轮 `prepare()` |
| `src/config/settings.ts`、`service.ts`、`routes.ts`、`local-env.ts`、`capability-readiness.ts` | 设置解析与合并、配置 API、本地环境文件、能力就绪 |
| `src/engines/opencode/`、`pi/`、`hermes/`、`mock/` | 引擎 Pack（`mock` 仅开发模式） |
| `src/drivers/acp/`、`pi-rpc/`（含 `extension/pnp-bridge.ts`） | 协议驱动 |
| `src/runtime/process-host.ts`、`recovery.ts`、`instance-lock.ts`、`resource-scope.ts` | 进程宿主、归属核验、实例独占、资源作用域 |
| `native/windows/JobHost.cs`、`job-host.ps1` | Windows Job Object helper（guard / inspect / launch） |
| `src/security/workspace.ts`、`redaction.ts` | 工作目录规则、脱敏 |
| `src/tools/office-mcp/`、`desktop-mcp/`、`pdf-mcp/` | 引擎无关的 MCP 工具服务器（两个 Node、一个 Python） |
| `config/settings.json`、`config/engines/*.json`、`config/instructions/competition.md`、`engines.lock.json` | 统一配置、引擎事实、指令文件、版本锁 |
| `scripts/check-boundaries.mjs` | 分层边界检查 |
| `scripts/package-release.mjs` | 交付包构建（`--bundle`：含 Node 运行时、依赖、编译产物、两个引擎） |
| `tests/kit/engine-contract.ts` | 每个 Pack 必须通过的公共契约断言 |
