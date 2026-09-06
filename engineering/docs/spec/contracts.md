# 公共接口与行为契约

契约版本：`1.1.0`。类型源为 [`code/src/contracts/index.ts`](../../code/src/contracts/index.ts) 与 [`host.ts`](../../code/src/contracts/host.ts)。本文规定行为，不维护第二份 TypeScript 接口。

## 1. 接口所有权

| 接口 | 调用方 | 实现方 | 行为 |
|---|---|---|---|
| EnginePack.open | Core | A/B | 打开或原生恢复一个独立会话，不执行用户任务；带原生引用时按第 5.2 节恢复或新建 |
| EngineSessionChannel.run | Core | A/B | 完整一轮，返回停止原因、最终文本及停止证据 |
| cancel | Core | A/B | 发送协议取消，ACK 不代表执行终止；取消后 `run()` 的收尾方式见第 4.2 节 |
| terminate / close | Core | A/B 使用公共 Host | 终止自身执行资源并报告证据；close 保留历史 |
| purge | Core | A/B | 只清除该会话归属的原生历史 |
| IntegrationProvider.prepare | Core | C | 按本轮请求解析模型、工具、资产和授权；把启用的能力包展开为绑定（第 10 节） |
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
- 收尾重试的所有者是 Core：Core 在中止、删除、关机与诊断触发这四个时机，对尚未证实静默的作用域再次核验；Adapter 不自行轮询重试。
- 收尾跨操作幂等：`terminate` 之后再 `close`，直接复用 `terminate` 的证据，不再触碰原生进程，原生历史照常保留；`close` 之后再 `terminate`，只对该通道仍登记在 ResourceScope 的资源核验。同一通道的静默结论单调：一旦为真，其后任一收尾操作都返回真。
- 调用方超时不终止进行中的核验。核验在后台继续到有界结束，其结论对后续调用可见；后续调用共享该结论，不重新发起。

## 3. 北向 HTTP

采用通用 6217 规范。`title` 可选、`directory` 必填；Prompt 的 `parts` 和 `model` 必填。`model.providerID/modelID` 是选择标识，不是任意 URL 或明文凭据。

| 方法 | 路径 | 成功语义 |
|---|---|---|
| POST | /session | 200，创建并持久化网关 Session |
| GET | /session/status | 所有可见 Session 的 idle/busy |
| GET | /session/:id | Session 与 message_count |
| DELETE | /session/:id | 尽力停止后清理归属记录、原生目录与网关数据，返回 `{ok:true}`；blocked 会话可删除 |
| POST | /session/:id/prompt_async | 正常完整轮次结束、消息提交后 204 |
| GET | /session/:id/message | 持久化消息快照；最终助手消息排在工具结果后 |
| POST | /session/:id/abort | 确认停止后 `{ok:true}`；无活跃 Run 的 idle 会话为空操作；无活跃 Run 的 blocked 会话 409；不改变进程级就绪 |
| POST | /session/:id/stop | abort 别名 |
| GET | /event | SSE，15 秒心跳 |
| GET | /question、/permission | 尚有活跃等待者的请求；返回的标识是网关标识，不被引擎载荷覆盖；权限条目的字段见 7 |
| POST | /question/:id/reply | `answers:string[][]` |
| POST | /permission/:id/reply | `reply:once/always/reject` |
| GET | /health/live、/health/ready、/diagnostics | 本地诊断扩展，不替代赛题接口 |

### 3.1 并发

全局同时只有一个活跃 Run。同一 Session 的第二个 `prompt_async` 立即 409 `SESSION_BUSY`，无论前一个在排队还是在执行。跨 Session 的请求进入有界队列按到达顺序等待执行槽，不立即拒绝；队列满才 409 `GATEWAY_BUSY`（带 `Retry-After`）。队列上限默认 8，由 `PNP_RUN_QUEUE_LIMIT` 配置（范围 1–128）。排队中的请求不写 Run、不发布 busy，`GET /session/status` 与 `GET /session/{id}` 仍为 idle；运行 deadline 从取得执行槽起计；就绪、围栏与删除状态在入队前和取得槽时各判定一次；排队中的请求可被 abort（`prompt_async` 以 409 `EXECUTION_CANCELLED` 结束，abort 本身返回 `{ok:true}`），此时不创建 Run；关机排空以 503 `SERVICE_UNAVAILABLE` 结束仍在排队的请求。

### 3.2 错误码

错误统一 `{code,message}`。HTTP 状态只能是下表中语义正确的那个；客户端输入与路径问题一律 400/403，只有确认为本进程内部故障才 500。框架自身的错误按其自带状态码透传。内部细节只进入脱敏诊断。

| HTTP | code | 含义 |
|---|---|---|
| 400 | `VALIDATION_ERROR`、`ASSET_INVALID`、`FRAME_TOO_LARGE` | 请求或配置参数无效；`directory` 非绝对路径、指向文件、是文件系统根或位于 `PNP_DATA_DIR` 内。`directory` 不存在时由网关创建（记 `directoryCreated`），不再拒绝 |
| 403 | `WORKSPACE_FORBIDDEN`、`MODEL_NOT_ALLOWED`、`UNSAFE_NATIVE_PATH`、`ASSET_OUTSIDE_ROOT` | 组织拒绝或越界访问 |
| 404 | `NOT_FOUND` | Session、Run、交互或路由不存在 |
| 409 | `SESSION_BUSY`、`SESSION_UNAVAILABLE`、`GATEWAY_BUSY`、`ENGINE_SESSION_MISMATCH`、`CHANNEL_MISMATCH`、`IDEMPOTENCY_CONFLICT`、`RUN_ALREADY_EXISTS`、`INTERACTION_RESOLVED`、`LATE_EVENT`、`ASSET_DIGEST_MISMATCH`、`EXECUTION_CANCELLED` | 状态冲突；`EXECUTION_CANCELLED` 的返回码见 3.3 |
| 413 | `BODY_TOO_LARGE` | 请求体超过 1 MiB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 非 `application/json` 的请求体 |
| 500 | `INTERNAL_ERROR`、`RESOURCE_DUPLICATE`、`INTERACTION_RUN_EXISTS`、`STORAGE_PROTOCOL_ERROR` | 本进程内部故障 |
| 502 | `BAD_GATEWAY`、`ENGINE_PROTOCOL_ERROR`、`HOST_EXITED`、`HOST_BACKPRESSURE`、`EVENT_TOO_LARGE`、`OUTPUT_TOO_LARGE`、`UNMATCHED_TOOL_UPDATE`、`UNMATCHED_TOOL_RESULT`、`DUPLICATE_TOOL` | 引擎协议或调用失败 |
| 503 | `SERVICE_UNAVAILABLE`、`STORAGE_UNAVAILABLE`、`STORAGE_BACKPRESSURE`、`EXECUTION_UNCERTAIN`、`HOST_START_FAILED`、`HOST_FAILURE`、`HOST_CAPACITY`、`RESOURCE_SCOPE_CLOSED`、`ENGINE_UNAVAILABLE`、`INTEGRATION_UNAVAILABLE` | 不可用。`SERVICE_UNAVAILABLE` 只在存储不可用或关机排空时出现；`EXECUTION_UNCERTAIN` 只描述当前请求的会话，不改变 `/health/ready`；`HOST_CAPACITY` 只在淘汰空闲通道也失败时出现 |
| 504 | `DEADLINE_EXCEEDED`、`EXECUTION_TIMEOUT` | 超时 |

### 3.3 待定

用户主动 abort 后，被中止的 `prompt_async` 返回 204 还是 409 `EXECUTION_CANCELLED`，尚未拍板。轨迹在两种返回下都如实记录 `finish=cancelled`，不构成伪造成功。决策人 A；截止条件：共享加固批次 CR-14 合入前，并同步写入 `INSTRUCTION.md`。

### 3.4 启动阶段错误

启动阶段的错误不经 HTTP 返回。进程以非零退出码结束，`{code,message}` 只出现在进程输出与 `npm run recover` 的摘要里。评测方在监听端口之前看到的只有这两个来源。

| code | 触发 | 处置 |
|---|---|---|
| `INSTANCE_LOCKED` | 数据目录此刻有另一个活着的拥有者 | 拒绝启动 |
| `STORAGE_UNAVAILABLE` | 存储打不开，或 `PRAGMA user_version` 比可执行文件新 | 拒绝启动 |
| `ENGINE_NOT_FOUND`、`ENGINE_CONFIGURATION_CONFLICT`、`ENGINE_UNAVAILABLE`、`MOCK_FORBIDDEN`、`INTEGRATION_NOT_FOUND`、`INTEGRATION_CONFIG_INVALID`、`MODEL_AUTH_MISSING`、`UNSUPPORTED_BIND_ADDRESS`、`VALIDATION_ERROR` | 启动配置无效：引擎未知或冲突、无实现、集成配置无法加载、模型凭据环境变量缺失、监听地址或端口非法 | 拒绝启动；输出中带出错字段名与环境变量名（变量名不是秘密，值不输出） |
| `INSTANCE_GUARD_FAILED` | Windows 独占守卫未能建立：源文件缺失、编译失败、超时 | 不拒绝启动；回退到锁文件加进程列表判活，诊断标记 `degraded` |
| `RECOVERY_EVIDENCE_INVALID` | 归属记录损坏、字段残缺或无法判定 | 不拒绝启动；只作用于对应会话，记录移入隔离目录并计数，出现在诊断与恢复摘要 |

单个工具的凭据环境变量缺失不是启动错误：该工具以不可用记入诊断，其余工具与模型照常。启动顺序、拒绝启动的判据与归属核验的证据分级见[架构第 10 节](architecture.md#10-启动恢复与删除)。

## 4. 运行和停止原因

`EngineResult.state` 与 `finish` 必须一致。正常完成为 completed/stop；工具调用阶段不是最终结果；长度限制、内容过滤、取消和错误保留各自停止原因。`taskOutcome` 未经工具或环境验证必须为 unknown。

正常轨迹：user → assistant/tool 若干轮 → final assistant。`step-finish` 不单独证明完成。错误/中断轨迹不能补造 `finish=stop`。

Driver 可使用 `tool.observed` 保留引擎的部分工具事实：`content`、`locations`、原生类型和状态都按实际收到的值持久化。它不是工具结果的替代品：只有同一 call 的 `name` 与 `input` 都被观察到才建立 canonical tool call，且只有该 canonical call 的真实 `output` 才建立 role=tool 消息；字段缺失与显式 `null` 必须区分。`completed`/`failed` 是终态，即使没有 output 也记录 `result_unknown` 事实；终态后的元数据不得重新打开调用。

canonical 名称的来源有两种，Driver 用 `nameSource` 如实标注（契约 1.1.0 新增的可选字段，不改版本号）：`"name"` 是引擎的程序化 `name`；`"announced-title"` 是宣告该 call 时（phase `created`）的 title —— 有的引擎（OpenCode）只给这一个标签，用它是观察，不是发明。身份只解析一次：之后的 title 变更照常作为 `title` 记录，但**永不改名**；既没有 `name` 也没有宣告 title 的 call 不成为 canonical call。权限侧的 operation 取名用同一条规则，策略与轨迹不会对同一次调用给出两个名字。观察 part 同时镜像规范的工具 part 形状：`tool` 在名称确定后即写入，`title` 与 `nameSource` 同时出现在 `state` 里，原有字段一个不删。

**未闭合的工具观察不改判轮次。** 轮次终态由引擎的 stopReason 决定：引擎正常结束却留下非终态观察时，Core 为每个这样的 call 追加 gateway-observation（`state.status: "error"`、`terminalStatus: "result_unknown"`、`source: "gateway-observation"`），最终 assistant 消息仍按引擎的完成记 `finish: "stop"` 与 `step-finish`，Driver 也不得因此把轮次报成 failed。既不伪造 role=tool 结果，也不把引擎给出的正确答复替换成网关自己造的错误。

`finalText` 不覆盖已流式提交的文本：`finalText` 为空串时，最终消息使用累计的流式文本；本轮以失败或取消结束时，最终消息不得只留下引擎的乐观文案，Core 追加失败或取消的观察态说明。

取消后允许有效收尾事件。运行终态提交后，迟到事件只能被隔离诊断，不能修改已提交轨迹或影响下一轮。事件链中一条事件非法只拒绝该事件；通道已死才拒绝后续全部事件，两者错误码不同。调用方断线不等于中止任务；显式 abort 或执行 deadline 才触发取消。

### 4.1 停止证据

`EngineResult.quiescent` 是布尔值。

| 值 | 含义 | Core 的处理 |
|---|---|---|
| `true` | 驱动已核验本轮执行资源停止 | 直接进入终态提交；通道保留 |
| `false` | 本轮已有终态文本与停止原因，但驱动不能证明资源已停止 | 保留轨迹与最终文本；调用 `terminate()` 取进程级证据；仅当证据仍为假才把 Run 记为 interrupted 并阻断该会话 |

驱动不得为规避终止而在未核验时返回 `true`。`StopEvidence.quiescent` 同义：为真只能来自协议终态、进程树核验或从未启动三种方法之一，`method` 如实标注。

### 4.2 取消语义

Core 调用 `cancel()` 后，Driver 必须在宽限期内让进行中的 `run()` 以 resolve 结束：`state=cancelled`、`finish=cancelled`、如实的 `quiescent`。此时通道保留，可继续下一轮。宽限期默认 15 秒，可配。

`run()` 只在通道已不可继续使用时才 reject：原生进程退出、协议损坏、握手失败。reject 意味着 Core 将终止该通道，其原生上下文视为丢失，会话恢复状态按第 5.2 节处理。晚于宽限期落定与 reject 等价。

取消后引擎晚到的正常停止原因由 Core 改写为 cancelled，Driver 无需处理该竞态。取消路径下不追加 `step-finish`，不伪造成功。

## 5. 启动失败、迟到资源与恢复状态

### 5.1 启动失败与迟到资源

`EngineOpenInput.resources` 必须向所有 Host 传递。进程申请前登记停止函数，创建前写归属记录。一个未返回的 open Promise 不是“没有启动任何进程”的证据。Core 会处理迟到结果并保留不确定性阻断，Adapter 仍有义务让 open 遵守 AbortSignal。

启动期取消时，Core 等待 open 有界落定后再计算证据；迟到通道被终止并自证静默即解除围栏。不确定只隔离到该会话，不改变进程级就绪。

### 5.2 通道终止后的恢复状态

| 事件 | `Session.recovery` |
|---|---|
| 从未打开过通道；通道正常 `close()` | `ready` |
| 通道被 `terminate()`，无论 `quiescent` 真假 | `needs-native-resume`；证据为假时先 `blocked`，围栏解除后置 `needs-native-resume`，不回 `ready` |
| 停止不可证明；启动时发现未终态 Run；归属核验未完成 | `blocked` |

下一轮 `EnginePack.open` 收到带 `native` 引用的会话时：

1. `capabilities.sessionResume` 经实测为 verified 且原生状态可加载：恢复，并发布原生事件报告已恢复。
2. 否则新建原生会话；新的 `NativeSessionRef` 替换绑定，旧标识放入原生事件 `context.lost` 的载荷以保留谱系；Core 在轨迹追加一条 `gateway-observation` 来源的观察态消息，说明原生上下文已丢失。

不得因为不可恢复而拒绝执行。不得把历史重新拼成提示冒充恢复。恢复与新建都不修改用户工作目录。

## 6. 模型和工具

每次 run 都使用新的 IntegrationContext。Adapter 不能把首轮认证或工具列表永久缓存。原生通道不支持模型切换、工具热更新或必需资产时，必须在发送 Prompt 前拒绝，不静默换模型或新建丢历史的 Session。

ToolBinding 的 executable、args、env 来自可信配置。工具凭据与模型请求头一样按轮解析，不在启动时常驻。用户输入只能作为结构化工具参数，不得拼接成 shell 命令字符串。CLI 参数是否幂等和是否有外部副作用由 C 声明；未知提交结果不重试。

## 7. 交互规则

组织授权返回 allow、deny、ask。deny 不进入可由用户覆盖的等待状态；ask 才发布可回复请求。question 回答为数组形式，权限 allow/deny 不当作 question 答案。重复答复、跨类型答复、已过期请求明确失败。

`GET /permission` 的条目与 `permission.asked` 事件是同一个权限对象：`{id, sessionID, permission, patterns, created_at}` 加驱动载荷（`title`、`name`、`kind`、`locations`、`rawInput`、`content`、`options` 等），网关标识排在最后，不被引擎载荷覆盖。`permission` 是策略可写的工具名（取名规则同第 4 节，与轨迹一致）。`patterns` 是本次请求涉及的路径数组，永远存在：驱动按 `locations[].path` → `rawInput` 的 `filepath`/`filePath`/`path` → 引擎把 title 当作路径使用时的 title 依次取值，保序去重；引擎没有指明任何路径时为空数组。`patterns` 只转述引擎请求里已有的事实，网关不推断、不补写目标，也不因缺少 `patterns` 拒绝或改写请求。question 的载荷形状不受本段约束。

`InteractionResponse.source` 标明决定来源：`policy` 为组织策略直接裁决，`user` 为回复接口提交，`timeout` 为等待过期，`cancelled` 为 Run 取消或终止清理等待者。`reasonCode` 携带非敏感原因码。Adapter 据此区分组织拒绝与无人应答，把两者映射为各自引擎的原生拒绝原因；组织拒绝依然不可被用户回复覆盖。

`always` 不得自动升级为跨租户、跨会话或长期组织授权。系统可把它限制为当前操作许可；所有范围扩张必须由 C 的策略层明确允许。取消与 Run 终止清理等待者，不能留下阻塞 Promise。

## 8. 资产与原生扩展

资产有 id、kind、绝对路径、哈希和 required 标识。Adapter 执行自身的原生投影；不重写用户工作目录，不把所有引擎强行转换成同一种 Skill/Hook 格式。资产的来源与组织方式见第 10 节。

能力记录区分 declared、probed、verified。一次声明只证明配置存在，不能据此标记取消、恢复、MCP 或高级能力已验证。证据关联通道、版本和内网配置。

## 9. 幂等和一致性

可选 `Idempotency-Key` 仅作用于同一 Session。同键同请求：已完成的 Run 返回已有完成结果；进行中的 Run 409；已失败、已取消或已中断的 Run 不占用该键，调用方以同键重发视为显式重试而非网关重放，前提是会话可执行。同键不同请求冲突。没有幂等键的重复文本可能是用户有意重复操作，不能用文本相同自行去重。

任何 DB 失败都禁止发布成功终态。SQLite 提交与 SSE 传输不是分布式事务，客户端需要用消息快照查询已提交事实；不因 SSE 发送失败重执行任务。

## 10. 能力包

能力包是一组可投影到任意引擎的资产与工具声明，是客观分的落点。它属于资产层内容，不改 Core 接口，不按引擎名分支。

### 10.1 目录与清单

目录固定为 `code/assets/packs/<id>/`。骨架与清单字段示例见 [`code/assets/packs/README.md`](../../code/assets/packs/README.md)。

| 内容 | 位置 | 说明 |
|---|---|---|
| 清单 | `pack.json` | id、version、owner、assets、tools、probes |
| 技能文档 | `SKILL.md`、`skills/*.md` | 方法、工具用法、产物自检步骤；投影为 `kind=skill` |
| 指令片段 | `instructions/*.md` | 注入引擎系统指令；投影为 `kind=instruction` |
| MCP 工具声明 | 清单 `tools[]` 与 `tools/` 入口 | 展开为 `ToolBinding`，transport 取 `mcp-stdio/cli/native` |
| 运行时探测规则 | 清单 `probes[]` | 打开通道时执行；判定运行时与依赖是否存在 |

一期固定三个包，启用哪些由配置决定，不由提示决定。

| id | 覆盖 | 所有者 |
|---|---|---|
| `office` | docx、xlsx、pptx、csv 的读写、转换与产物自检 | B |
| `windows-desktop` | Windows 桌面应用交互：打开应用、UI 自动化、即时通讯客户端 | C |
| `web-search` | 网页检索与来源引用 | C |

### 10.2 解析

- 集成配置的 `packs` 列表决定启用集合。IntegrationProvider 在每轮 `prepare` 把启用的包展开为 `AssetBinding[]` 与 `ToolBinding[]`，每轮重新解析，不缓存上一轮结果。
- 资产路径经公共资产解析器校验：根目录内、普通文件、单文件不超过 1 MiB、SHA-256 与清单一致。
- 清单里的工具入口以命名运行时引用，由集成配置解析为绝对可执行路径；不从 PATH 猜测，不接受相对命令。
- 清单声明的 `sideEffect` 进入 `ToolBinding.sideEffect`，组织策略据此给出 allow/ask/deny。递归删除、外发消息类工具必须声明 `write` 或 `external`。

### 10.3 投影

- 各引擎 Pack 负责投影：把资产复制到该会话的私有原生目录 `nativeDataDirectory` 并按引擎的扫描路径挂载。ACP 系走 `session/new` 的 MCP 服务器数组加私有配置目录；Pi 走原生扩展。不写用户工作目录，不改全局配置。
- 探测在通道打开时执行一次，结果记入原生事件与能力记录（evidence=probed），同一会话内后续轮次复用。
- 投影结果以原生事件记录：命名空间 `pack`，事件名 `projected`、`skipped`、`failed`，载荷含 pack id、asset id、sha256 与目标路径。
- 必需资产或必需探测失败必须在发送 Prompt 之前失败；可选资产失败记录能力不可用，本轮继续。

### 10.4 禁止

- 能力包不得含任务标识判断、固定答案或测试材料。技能文档只描述方法与自检步骤。
- 不得含凭据、内部地址、工号；工具凭据只经 `env` 变量名引用。
- 包内脚本不得读写用户工作目录之外的用户数据，不得修改引擎全局配置。

## Host 注入与所有权

`EngineOpenInput.host` 是公共框架注入的唯一 ProcessHost；适配器调用 `input.host.start(spec, signal, input.resources)`。禁止自行创建 Host、选择另一份宿主记录目录或直接 spawn。所有归属记录进入同一个 `PNP_DATA_DIR/hosts`，恢复核验不会遗漏适配器私有目录中的进程。

`LaunchSpec.sessionId` 必须是网关会话标识（`Session.id`）。填原生会话标识或引擎作用域标识会使归属记录与网关会话对不上账，该会话崩溃后永远无法解除阻断。`LaunchSpec.ownerToken` 必须非空；空令牌会让归属记录在下次启动时不可核验，被移入隔离目录。

ProcessHost.start 的 AbortSignal 只控制启动获取阶段。握手完成后，运行取消走 Channel.cancel 和 Scope 收尾，不由启动信号绕过协议取消直接强杀。终止失败后通道保持不可写；写入守卫与收尾重试解耦，重试不重新打开写入。
