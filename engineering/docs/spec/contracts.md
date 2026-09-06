# 公共接口与行为契约

契约版本：`1.1.0`。类型源为 [`code/src/contracts/index.ts`](../../code/src/contracts/index.ts) 与 [`host.ts`](../../code/src/contracts/host.ts)。本文规定行为，不维护第二份 TypeScript 接口。

## 1. 接口所有权

| 接口 | 调用方 | 实现方 | 行为 |
|---|---|---|---|
| EnginePack.open | Core | A/B | 打开或原生恢复一个独立会话，不执行用户任务 |
| EngineSessionChannel.run | Core | A/B | 完整一轮，返回停止原因、最终文本及停止证据 |
| cancel | Core | A/B | 发送协议取消，ACK 不代表执行终止 |
| terminate / close | Core | A/B 使用公共 Host | 终止自身执行资源并报告证据；close 保留历史 |
| purge | Core | A/B | 只清除该会话归属的原生历史 |
| IntegrationProvider.prepare | Core | C | 按本轮请求解析模型、工具、资产和授权 |
| IntegrationProvider.release | Core | C | 回收本轮临时凭据或临时配置，不删除原生对话历史 |
| ProcessHost.start | Adapter | 公共框架 | 结构化启动、stdio、所有权、退出和有界终止 |
| ResourceScope.register / retire | Host/Adapter | 公共框架 | 在申请资源前登记停止函数；取得 `quiescent=true` 证据后由所有者 retire，关闭后禁止新申请 |
| EventSink.emit | Adapter | 公共框架 | 有序且可等待的事件提交，失败必须传播 |
| DriverServices.interact | Adapter | 公共框架 + C策略 | 审批/反问持久化、回传、取消与过期 |

## 2. 不可变约束

- Adapter 不导入 HTTP、SQLite 或 GatewayCore，不设置最终 idle，不直接生成评测响应。
- Core 不导入具体引擎 SDK，不解析员工助手参数，不读取内部认证秘密。
- IntegrationProvider 不执行 Agent Loop，也不返回伪造的 EngineResult。
- 一个 Channel 只归属一个 Gateway Session；同一 Session 同时只有一轮执行。
- `run()` 返回之前必须完成该通道的终态判定，不能返回请求接受 ACK。
- 事件回调必须返回并等待 `emit()`；不得 fire-and-forget 或吞掉持久化异常。
- `quiescent=true` 仅表示可归属的执行资源停止；不表示外部事务已撤销。
- `terminate`、`close` 与 `ResourceScope` 收尾必须幂等；并发调用共享同一次进行中的核验。只有 `quiescent=true` 可以缓存，超时、异常或 `quiescent=false` 后必须允许再次核验，且不得并发启动第二次收尾。
- `ResourceScope.retire(id, evidence)` 只接受已登记资源且 `evidence.quiescent=true`；未知 id、未证明停止或仍在收尾中的资源必须失败并保留登记。Adapter 在完成自身的 `HostedProcess.terminate()`/核验后负责 retire，避免驻留 Session Scope 持有每轮已结束 Host 的 closure。

## 3. 北向 HTTP

采用通用 6217 规范。`title` 可选、`directory` 必填；Prompt 的 `parts` 和 `model` 必填。`model.providerID/modelID` 是选择标识，不是任意 URL 或明文凭据。

| 方法 | 路径 | 成功语义 |
|---|---|---|
| POST | /session | 200，创建并持久化网关 Session |
| GET | /session/status | 所有可见 Session 的 idle/busy |
| GET | /session/:id | Session 与 message_count |
| DELETE | /session/:id | 完成归属清理后返回 `{ok:true}` |
| POST | /session/:id/prompt_async | 正常完整轮次结束、消息提交后 204 |
| GET | /session/:id/message | 持久化消息快照；最终助手消息排在工具结果后 |
| POST | /session/:id/abort | 确认停止后 `{ok:true}`；不确定则错误 |
| POST | /session/:id/stop | abort 别名 |
| GET | /event | SSE，15 秒心跳 |
| GET | /question、/permission | 尚有活跃等待者的请求 |
| POST | /question/:id/reply | `answers:string[][]` |
| POST | /permission/:id/reply | `reply:once/always/reject` |
| GET | /health/live、/health/ready、/diagnostics | 本地诊断扩展，不替代赛题接口 |

错误统一 `{code,message}`。400 参数、403 组织拒绝、404 不存在、409 状态冲突、500 内部错误、502 引擎协议/调用失败、503 不可用、504 超时。内部细节只进入脱敏诊断。

## 4. 运行和停止原因

`EngineResult.state` 与 `finish` 必须一致。正常完成为 completed/stop；工具调用阶段不是最终结果；长度限制、内容过滤、取消和错误保留各自停止原因。`taskOutcome` 未经工具或环境验证必须为 unknown。

正常轨迹：user → assistant/tool 若干轮 → final assistant。`step-finish` 不单独证明完成。错误/中断轨迹不能补造 `finish=stop`。

Driver 可使用 `tool.observed` 保留引擎的部分工具事实：`content`、`locations`、原生类型和状态都按实际收到的值持久化。它不是工具结果的替代品：只有同一 call 的真实 `name` 与 `input` 才建立 canonical tool call，且只有该 canonical call 的真实 `output` 才建立 role=tool 消息；字段缺失与显式 `null` 必须区分。`completed`/`failed` 是终态，即使没有 output 也记录 `result_unknown` 事实；终态后的元数据不得重新打开调用。正常完成时仍有非终态观察必须按协议错误处理。

取消后允许有效收尾事件。运行终态提交后，迟到事件只能被隔离诊断，不能修改已提交轨迹或影响下一轮。调用方断线不等于中止任务；显式 abort 或执行 deadline 才触发取消。

## 5. 启动失败与迟到资源

`EngineOpenInput.resources` 必须向所有 Host 传递。进程申请前登记停止函数，创建前写归属记录。一个未返回的 open Promise 不是“没有启动任何进程”的证据。Core 会处理迟到结果并保留不确定性阻断，Adapter 仍有义务让 open 遵守 AbortSignal。

## 6. 模型和工具

每次 run 都使用新的 IntegrationContext。Adapter 不能把首轮认证或工具列表永久缓存。原生通道不支持模型切换、工具热更新或必需资产时，必须在发送 Prompt 前拒绝，不静默换模型或新建丢历史的 Session。

ToolBinding 的 executable、args、env 来自可信配置。用户输入只能作为结构化工具参数，不得拼接成 shell 命令字符串。CLI 参数是否幂等和是否有外部副作用由 C 声明；未知提交结果不重试。

## 7. 交互规则

组织授权返回 allow、deny、ask。deny 不进入可由用户覆盖的等待状态；ask 才发布可回复请求。question 回答为数组形式，权限 allow/deny 不当作 question 答案。重复答复、跨类型答复、已过期请求明确失败。

`always` 不得自动升级为跨租户、跨会话或长期组织授权。系统可把它限制为当前操作许可；所有范围扩张必须由 C 的策略层明确允许。取消与 Run 终止清理等待者，不能留下阻塞 Promise。

## 8. 资产与原生扩展

资产有 id、kind、绝对路径、哈希和 required 标识。Adapter 执行自身的原生投影；不重写用户工作目录，不把所有引擎强行转换成同一种 Skill/Hook 格式。

能力记录区分 declared、probed、verified。一次声明只证明配置存在，不能据此标记取消、恢复、MCP 或高级能力已验证。证据关联通道、版本和内网配置。

## 9. 幂等和一致性

可选 `Idempotency-Key` 仅作用于同一 Session。同键同请求的已完成 Run 返回已有完成结果；不同请求冲突；未完成或失败 Run 不自动重放。没有幂等键的重复文本可能是用户有意重复操作，不能用文本相同自行去重。

任何 DB 失败都禁止发布成功终态。SQLite 提交与 SSE 传输不是分布式事务，客户端需要用消息快照查询已提交事实；不因 SSE 发送失败重执行任务。

## Host 注入与所有权

`EngineOpenInput.host` 是公共框架注入的唯一 ProcessHost；适配器调用 `input.host.start(spec, signal, input.resources)`。禁止自行创建 Host、选择另一份宿主记录目录或直接 spawn。所有归属记录进入同一个 `PNP_DATA_DIR/hosts`，恢复核验不会遗漏适配器私有目录中的进程。

ProcessHost.start 的 AbortSignal 只控制启动获取阶段。握手完成后，运行取消走 Channel.cancel 和 Scope 收尾，不由启动信号绕过协议取消直接强杀。
