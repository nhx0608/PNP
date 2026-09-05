# 通用 Agent 网关规范核对表

依据用户提供的《Agent 网关接口规范》v1.1（2026-08-21）整理。此表保留对实现有约束的接口与语义，不将项目附加设计写成原文要求。另有 MyAgent v1.0（2026-09-02），赛题任选其一；PNP 采用本表的通用协议。

## 基础

HTTP/1.1、JSON；默认 localhost:6217。原文启动形式 `gateway --engine <id> --port 6217 --host localhost`。题目任务书还要求环境变量切换，因此 PNP 同时支持；冲突拒绝是项目规则。

会话对外状态 `idle` / `busy`。`directory` 必须支持且评测会指定；`title` 可选。原文有一处错误示例写 title required，按创建接口的明确字段要求实现 title 可选。

## API

| 方法/路径 | 请求 | 正常响应 |
|---|---|---|
| POST `/session` | `{title?:string,directory:string}` | `{id,title,created_at,status:'idle'}` |
| GET `/session/{id}` | 无 | `{id,title,created_at,status,message_count}` |
| DELETE `/session/{id}` | 无 | `{ok:true}`，删除会话及消息 |
| GET `/session/status` | 无 | `{[sessionId]:{type:'idle'或'busy'}}` |
| POST `/session/{id}/prompt_async` | 下述 Prompt | 本轮完整结束后 204，无响应体 |
| GET `/session/{id}/message` | 无 | 全部对话及工具轨迹数组 |
| POST `/session/{id}/abort` | 无 | `{ok:true}`；备选路径 `/stop` |
| GET `/event` | Accept:text/event-stream | SSE 全局流 |
| GET `/question` | 无 | 待处理问题数组 |
| POST `/question/{request_id}/reply` | `{answers:string[][]}` | `{ok:true}` |
| GET `/permission` | 无 | 待处理权限数组 |
| POST `/permission/{request_id}/reply` | `{reply:'once'或'always'或'reject',message?:string}` | `{ok:true}` |

Prompt 的 `parts` 为必填数组，目前仅 text 部分，`type` 和 `text` 必填；`model` 必填，其 `providerID` 与 `modelID` 必填；`agent` 可选、原文默认 assistant。

```json
{
  "parts": [{"type": "text", "text": "用户问题或指令"}],
  "model": {"providerID": "configured-provider", "modelID": "configured-model"},
  "agent": "assistant"
}
```

`prompt_async` 的名称不改变其阻塞要求：客户端在后台调用，同时监听 SSE。必须包含所有工具调用和最终回复。

## 消息与完成判定

消息字段说明和 SSE 事件原文允许选手自定义系统规范，但必须能正常返回 Agent 轨迹。PNP 选择兼容参考格式：消息包含 `id/role/content/created_at`，工具关联 `tool_calls[].id/name/arguments` 与 `tool_call_id/tool_name`，assistant 包含 `info` 和 `parts`。

正常最终回复：最后一条消息 role 为 assistant、`info.finish=stop`、parts 含 `step-finish`。`finish=tool-calls` 表示继续执行，单独的 step-finish 不是完整结束。PNP 对异常保留 error/cancelled/interrupted 等扩展值，不伪造正常 stop。

客户端同时可以监听 idle/error、轮询 session/status、读取最终消息进行判断。`session.error` 表示错误，不是任务成功。

## SSE

响应头：Content-Type 为 `text/event-stream; charset=utf-8`，Cache-Control 为 no-cache，Connection 为 keep-alive，X-Accel-Buffering 为 no。每条事件以 data 行承载 JSON 并以空行结束。

事件外形：`{type,properties}`。参考事件：

| type | properties |
|---|---|
| server.connected / server.heartbeat | `{}`，心跳每15秒 |
| session.status | `{sessionID,status:{type}}` |
| session.idle | `{sessionID}` |
| session.error | `{sessionID,error:{message,data?}}` |
| message.part.updated | `{sessionID,messageID,part}` |
| question.asked | `{sessionID,id,questions}` |
| permission.asked | `{sessionID,id,permission,patterns}` |

part 为 text（content）、tool（tool、state.status/title）或 step-finish。PNP 额外提供事件序号和 SSE id，属于项目扩展。

## 交互

原文第5.1—5.4节明确标为可选：可以默认不询问、默认允许。任务书规定出现需要人工交互的流程时，必须有接口供裁判自动提交。PNP 选择完整实现 Broker/API，但组织权限限制不能被自动允许或用户回复覆盖。

问题：`{id,sessionID,questions:[{question,options:[{label,description?}]}],created_at}`。权限：`{id,sessionID,permission,patterns,created_at}`。

## 错误

统一 `{code,message}`。原文列出 400 VALIDATION_ERROR、404 NOT_FOUND、500 INTERNAL_ERROR、502 BAD_GATEWAY、503 SERVICE_UNAVAILABLE。PNP 可增加具体错误码，但必须维持可解释 HTTP 状态和安全信息边界。

## 最小全流程

创建会话 → 订阅 SSE → 发送阻塞 Prompt → 接收 busy/文本/工具/交互 → 最终消息持久化 → idle → HTTP 204 → 拉取消息 → 删除会话。取消和错误采用独立终态，不借用正常完成的含义。
