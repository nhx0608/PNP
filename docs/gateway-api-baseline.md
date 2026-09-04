# Agent 网关接口基线

> 更新时间：2026-09-04  
> 本文整理赛题目前提供的两套网关协议，用于后续实现和测试。这里只记录评测相关契约，不绑定具体 Harness 内部协议。

## 1. 两套规范概览

赛题允许实现以下任意一种规范：

| 维度 | 通用 Agent 网关规范 | MyAgent 网关规范 |
| --- | --- | --- |
| 默认端口 | `6217` | `3008` |
| 顶层对象 | Session | Agent（评测用例可映射到底层 Session） |
| 引擎切换 | `gateway --engine <name>` | 需最终支持多引擎启动 |
| 消息接口 | `/session/{id}/prompt_async` | `/v1/agents/{id}/chat` |
| SSE | `/event` | `/v1/events` |
| 消息轨迹 | `/session/{id}/message` | `/v1/config/opencode/session/{id}/message` |
| Abort | `/session/{id}/abort` | `/v1/agents/{id}/chat/pause` |
| 协议倾向 | 引擎无关 | 历史上以 OpenCode 作为首个引擎，路径中保留 OpenCode 命名 |

当前团队选择从零实现多引擎架构，因此更适合把**通用网关协议作为北向基线**，内部再建立引擎无关的统一模型。

## 2. 通用网关规范核心契约

### 2.1 启动

```text
gateway --engine opencode --port 6217 --host localhost
```

必须支持：

- `--engine`：指定当前 Harness；
- `--port`：默认 `6217`；
- `--host`：默认 `localhost`。

比赛会在不同轮次使用不同引擎启动，不要求同一进程运行期间动态热切换。

### 2.2 创建 Session

```http
POST /session
```

请求示例：

```json
{
  "title": "会话标题",
  "directory": "D:/workspace"
}
```

其中 `directory` 是评测必须支持的关键参数，用于指定任务工作目录。

响应至少包含：

```json
{
  "id": "ses_abc123",
  "title": "会话标题",
  "created_at": "2026-08-21T10:00:00Z",
  "status": "idle"
}
```

### 2.3 Session 查询 / 删除 / 状态

```http
GET /session/{session_id}
DELETE /session/{session_id}
GET /session/status
```

Session 状态只有：

- `idle`
- `busy`

### 2.4 发送 Prompt

```http
POST /session/{session_id}/prompt_async
```

请求：

```json
{
  "parts": [
    {
      "type": "text",
      "text": "用户的问题或指令"
    }
  ],
  "model": {
    "providerID": "provider_xxx",
    "modelID": "gpt-4"
  },
  "agent": "assistant"
}
```

关键语义：

- 接口虽然名字含 `async`，但 HTTP 调用本身会**阻塞直到这一轮 Agent 执行完整结束**；
- “结束”包含 LLM 调用、所有工具调用和最终回复；
- 客户端同时监听 SSE 获取中间事件；
- 正常完成返回 `204 No Content`。

### 2.5 获取消息轨迹

```http
GET /session/{session_id}/message
```

评测方主要关心完整 Agent 轨迹，消息规范允许参赛系统自行定义，只要能正常返回：

- user 消息；
- assistant 消息；
- tool call；
- tool result；
- 最终完成状态。

赛题参考语义包括：

```json
{
  "role": "assistant",
  "info": {
    "finish": "stop"
  },
  "parts": [
    {"type": "text"},
    {"type": "tool"},
    {"type": "step-finish"}
  ]
}
```

重要规则：

- `step-finish` 只表示一次 LLM step 结束；
- `finish=tool-calls` 时 Agent 仍需继续执行；
- `finish=stop` 且包含最终 step-finish 才可认为最终回复完成。

### 2.6 Abort

```http
POST /session/{session_id}/abort
```

备选路径：

```http
POST /session/{session_id}/stop
```

网关需要把 Abort 继续传播到底层当前 Harness / Run，而不是只停止 HTTP 等待。

### 2.7 SSE

```http
GET /event
Accept: text/event-stream
```

参考事件：

- `server.connected`
- `server.heartbeat`
- `session.status`
- `session.idle`
- `session.error`
- `message.part.updated`
- `question.asked`
- `permission.asked`

SSE 心跳参考周期为 15 秒。

### 2.8 Question / Permission

以下接口允许可选实现：

```http
GET  /question
POST /question/{request_id}/reply
GET  /permission
POST /permission/{request_id}/reply
```

赛题允许：

- 默认不询问用户；
- 默认允许权限。

但如果具体 Harness 会产生此类交互，网关应能够把原生事件归一后继续完成评测流程。

## 3. MyAgent 规范核心契约

MyAgent 规范的评测主流程围绕 Agent ID：

```http
POST   /v1/agents
POST   /v1/agents/{agent_id}/chat
GET    /v1/events
GET    /v1/config/opencode/session/{session_id}/message
POST   /v1/agents/{agent_id}/chat/pause
DELETE /v1/agents/{agent_id}
```

其中：

- 每个评测用例对应一个 Agent；
- 底层实际可以只创建/复用默认 Agent，再为任务创建 Session；
- `chat` 接口同样会阻塞到本轮完整结束；
- SSE 使用 `BridgeEvent` 信封，包含 `agent_id`、`trace_id`、可选 `child_session_id` 和原始 payload；
- 消息轨迹路径保留了 `/opencode/` 命名，这是 MyAgent 以 OpenCode 为首个引擎形成的历史协议痕迹；
- Question / Permission 接口可选。

## 4. 推荐内部统一模型

不论最终对外采用哪套 HTTP 规范，内部建议维护统一对象：

```text
GatewaySession
GatewayRun
GatewayMessage
GatewayEvent
EngineSessionRef
WorkspaceContext
ModelProfile
```

建议核心映射：

```text
External Session / Agent ID
          ↓
GatewaySession
          ↓
engineId + engineSessionId
```

这样外部 HTTP 协议不会直接污染引擎适配层，新接入 Harness 也无需感知评测路径。

## 5. 推荐状态机

```text
Session Created
    ↓
  idle
    ↓ prompt
  busy
    ↓
LLM / Tool Loop
    ↓
Final Assistant Message
    ↓
  idle
```

异常和中止路径也必须最终恢复可识别状态：

```text
busy
  ├── engine error → session.error → idle
  └── abort        → cancel native run → idle
```

## 6. 错误模型

通用规范要求错误统一返回：

```json
{
  "code": "ERROR_CODE",
  "message": "错误描述信息"
}
```

参考状态：

- `400 VALIDATION_ERROR`
- `404 NOT_FOUND`
- `500 INTERNAL_ERROR`
- `502 BAD_GATEWAY`
- `503 SERVICE_UNAVAILABLE`

内部实现建议保留更细的引擎错误类型，再映射到北向规范。

## 7. 当前实现关注点

后续实现需要重点保证：

1. `directory` 能正确映射到底层 Harness 工作目录；
2. HTTP Prompt 阻塞与 SSE 流式事件可以同时工作；
3. Session 状态与底层 Harness 生命周期一致；
4. Abort 能真正终止底层 Agent Run；
5. 不同 Harness 的原生消息/事件可以转换成统一轨迹；
6. 新引擎接入不要求修改 HTTP Route 和 Session Core；
7. 启动时可以通过 `--engine` 和/或 `AGENT_ENGINE` 选择 Harness。
