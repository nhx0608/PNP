# 第三轮评审：对照官方《Agent 网关接口规范》v1.1 的符合性

评审对象：`master`（`795b98b`）的网关层与启动路径。评审依据：官方《Agent 网关接口规范》v1.1（本文简称"规范"）与《MyAgent 网关接口文档》1.0（仅作评测脚本行为的旁证，我们不走 myagent 路线）。证据来源：分支 `claude/multi-engine-agent-gateway-gz5gj7`（PR #1）上用真实 `opencode` 1.18.29 二进制在 ubuntu 与 windows-latest 跑通的端到端冒烟，以及本轮对 master 源码的直接核对。**本轮只审查、不改代码**；每条给出建议实现，留给 GPT 或后续按条实现。

评审分工：方案与架构层面的判断由顶层模型完成（本文）；具体实现留给实现模型按条目执行。

---

## 0. 先说结论

规范的接口面（端点、阻塞语义、SSE 格式、消息完成规则、错误格式、反问/权限接口）master 已经基本覆盖，**不需要重做**。真正的风险不在"接口有没有"，而在几处**会让整轮用例归零的运行姿态**：全局单执行槽、对评测方传入的 model 一律 403、默认集成拒绝启动、`directory` 必须预先存在、对被围栏会话的 abort 会拖垮整个网关。这五条是 P0；其余是单用例级的 P1。

---

## 1. 已符合规范、不要动的部分

| 规范条目 | master 现状 | 证据 |
|---|---|---|
| `POST /session` → `{id,title,created_at,status:"idle"}`；`title` 可选、`directory` 必填 | 一致 | `gateway/app.ts:59-62`，冒烟 create-session |
| `GET /session/{id}` 含 `message_count`；`DELETE` → `{ok:true}`；`GET /session/status` → `{id:{type}}` | 一致 | 冒烟 session-lifecycle |
| `POST /session/{id}/prompt_async` 阻塞到本轮结束后 204 | 一致 | 冒烟 case1/case2（真实引擎，Windows） |
| `POST /session/{id}/abort` 与备选 `/stop` → `{ok:true}`；对 idle 会话幂等 | 一致 | `app.ts:82-86`，`gateway-core.ts:422-433` |
| 消息完成规则：最后一条 `role: assistant`、`info.finish: "stop"`、`parts` 含 `step-finish`；`tool-calls` 不算完成 | 一致 | 冒烟 hello-trace / write-file |
| `parts[].type` = `text{content}` / `tool{tool,state{status,title}}` / `step-finish`；tool 消息含 `tool_call_id`、`tool_name` | 一致 | `gateway-core.ts:253-277` |
| SSE：`data: {"type","properties"}`，`server.connected`、每 15 s `server.heartbeat`、`session.status`、`session.idle`、`session.error`、`message.part.updated`、`question.asked`、`permission.asked` | 一致 | `app.ts:109-160`，冒烟 event-sequence |
| `GET /question`、`POST /question/{id}/reply {answers: string[][]}`；`GET /permission`、`POST /permission/{id}/reply {reply: once\|always\|reject}` | 一致；`message` 等附加字段不会被拒绝 | `app.ts:93-108`，冒烟 case2/case2b（真实引擎） |
| 错误格式 `{code,message}`；`VALIDATION_ERROR/NOT_FOUND/SERVICE_UNAVAILABLE/BAD_GATEWAY` | 一致；另有自定义码（409 系列）不违反规范 | `core/errors.ts` |
| `--engine/--port/--host` 与 `AGENT_ENGINE`；冲突报错 | 一致 | `main.ts:26-32` |
| 长阻塞请求不会被服务端超时切断（`requestTimeout` 只管收包，`connectionTimeout: 0`） | 一致 | `app.ts:34-39` |

---

## 2. 整轮级风险（P0）

### R1 全局单执行槽：第二个会话的 prompt 直接 409 `GATEWAY_BUSY`

`gateway-core.ts:154` 用一个进程级 `reserved` 位把执行串行化：任何会话在跑，其他会话的 `prompt_async` 立即 409。规范定义的是**每个会话**的 idle/busy，`GET /session/status` 返回多个会话的各自状态，评测脚本完全可能并发开多个会话跑多个用例（MyAgent 的"每个用例一个 Agent"就是这种形态）。单槽下并发的用例除第一个外全部失败，且失败的是 HTTP 层，连轨迹都不会有。

**建议**（二选一，优先前者）：
- 把"槽"改成**有界并发池 + 每会话互斥**：同一会话串行（busy 即拒绝或排队），不同会话并发，池大小由 `PNP_MAX_CONCURRENT_RUNS` 控制（默认 4）。资源上每个会话本来就是独立的原生进程与目录，共享的只是 SQLite（WAL 下多写者可接受）。
- 至少把 409 改成**排队等待**：`prompt_async` 本身就是阻塞接口，客户端等着是协议允许的；在槽释放前挂起请求，受 `PNP_RUN_TIMEOUT_MS` 约束。这样并发用例只是慢，不是失败。

### R2 评测方传入的 `model` 不在配置档里 → 403 `MODEL_NOT_ALLOWED`

规范 4.1 把 `model.providerID/modelID` 定为**必填**，评测脚本一定会传；传什么值我们不掌握（MyAgent 示例里是内源 provider 的 id）。`integration/configured/provider.ts:23` 对不在档的选择直接 403，等于每个用例在第一个 prompt 就失败。

**建议**：默认**宽松映射**——不在档的 `model` 记日志（含原始 providerID/modelID）后落到配置档的默认模型；提供 `PNP_MODEL_STRICT=1` 才恢复 403。同时在 `INSTRUCTION.md` 明示：评测方传入的模型标识会映射到部署时配置的模型。C 线的内网集成同理，映射表要能配置而不是硬编码。

### R3 默认集成 `internal` 在启动阶段拒绝启动

`integration/index.ts:92-96`：非 mock 引擎默认走 `internal`，而 `InternalIntegration` 直接抛 `INTEGRATION_UNAVAILABLE` 拒绝启动。这把"C 线代码是否交付"做成了网关能否启动的门禁：评测方按文档启动，只要内网集成没到位或没配置，网关根本起不来。

**建议**：集成是**配置**不是代码交付。默认读取交付包里的一份 `configured` 档（模型端点、头、策略），内网模型就是这份档里的一个 `openai-chat`/`custom` 端点；`internal` 只在确有额外协议要求（appid 签名、员工助手 CLI 工具）时作为 provider 变体存在，且未配置时**降级到 configured 档**而不是拒绝启动。启动阶段仍应校验凭据变量存在，但校验失败要报清楚是哪个变量。

### R4 `directory` 必须已存在，否则 400

`security/workspace.ts:5-21`：非绝对路径、不存在、不是目录都 400。规范说"评测需要指定目录，选手需要支持该参数"，没有承诺目录预先存在；示例 `D:/workspace` 是正斜杠（`path.isAbsolute` 在 win32 下接受，这点没问题）。目录不存在时整个用例在 `POST /session` 就失败。

**建议**：存在则用、不存在则 `mkdir -p` 创建（父目录不可写才 400）；仍拒绝相对路径与指向文件的路径。创建动作要记进会话记录，删除会话时**不**删除该目录（规范 3.3 只说删会话与消息）。

### R5 启动命令与默认监听地址

规范 2.1 的字面命令是 `gateway --engine opencode --port 6217`，默认 `--host localhost`。master 没有 `gateway` 可执行入口（`package.json` 无 `bin`），`INSTRUCTION.md` 给的是 `npm start -- --port 6217 --host localhost`；`main.ts:30` 未指定 host 时默认 `127.0.0.1`，与规范默认 `localhost` 不同。

**建议**：
- 交付包根目录提供 `gateway.cmd` / `gateway.ps1`（内部执行 `node dist/main.js "$@"`），`package.json` 加 `"bin": {"gateway": "dist/main.js"}`；`INSTRUCTION.md` 同时给出规范字面形式与 npm 形式，两者等价。
- 默认 host 改为 `localhost`。Fastify 5 对 `localhost` 会同时绑定 `127.0.0.1` 与 `::1`（PR #1 的冒烟在 Windows 上已验证两地址同时就绪），评测客户端无论解析到哪一族都能连上；默认 `127.0.0.1` 则在 `localhost` 先解析到 `::1` 的 Windows 上依赖客户端的地址回退。

### R6 对被围栏会话的 abort 会把整个网关置为不健康

`gateway-core.ts:425-428`：会话无活动运行但 `recovery === "blocked"` 时，abort 把 `this.healthy = false` 并 503。这是进程级不确定性开关的残留：评测脚本对一个失败用例的会话补一次 abort（MyAgent 流程里常见），之后所有会话全部 503。

**建议**：不确定只隔离到会话（PR #1 §一已实现同样的语义）：对被围栏且无活动运行的会话，abort 返回 409 `SESSION_UNAVAILABLE`（或 200 `{ok:true}`，因为确实没有东西可停），绝不触碰全局健康位。

---

## 3. 单用例级（P1）

### R7 权限载荷缺 `patterns`
规范 5.3/6.1.4 的权限对象是 `{id, sessionID, permission, patterns[], created_at}`。master 的 `interactions.ts:100-105` 给出 `id/sessionID/created_at/permission` 加驱动载荷，但没有 `patterns`。评测脚本回复只需要 `id`，所以不致命；但按规范补上更稳：由驱动载荷的 `locations[].path` / `title` 推出 `patterns`，`permission` 保持工具名（如 `write`）或映射成规范示例的 `file.write` 风格，二者取其一并写进文档。

### R8 入站请求体 `additionalProperties: false`
`gateway/schemas.ts` 对 `POST /session` 与 `prompt_async` 拒绝任何未知字段。评测脚本若多带一个字段（例如 MyAgent 风格的 `trace_id`），就是 400。对评测方入站体应**忽略未知字段**，只校验必填项的类型。

### R9 `prompt_async` 的 `model` 在 master 上必填
规范也说必填，所以不违规；但缺省时落到默认模型更稳（PR #1 已改为可选并在 Core 里把提供方解析后的模型交给驱动——这一条同时修了 launch 绑定引擎把空选择当成切换的 409）。

### R10 `question` 载荷形状取决于 Pi 驱动
规范 5.1 的形状是 `questions[{question, options[{label, description}]}]`。ACP/OpenCode 没有反问概念，这条只对 Pi（B 线）成立；B 线交付时按此形状投影，`GET /question` 与 `question.asked` 用同一份载荷。

### R11 错误码 409 系列
`SESSION_UNAVAILABLE / EXECUTION_CANCELLED / GATEWAY_BUSY / IDEMPOTENCY_CONFLICT` 等 409 不在规范的常见码表里。格式合规，评测脚本按 HTTP 状态处理即可；R1 落地后 `GATEWAY_BUSY` 应不再出现在评测路径上。

---

## 4. 真机/真引擎运行得出的九条事实（master 的检查清单）

以下每条都是在 PR #1 上由真实 OpenCode 二进制（Linux 与 windows-latest）跑出来的，不是推断；master 若沿用同一层代码，逐条核对：

1. **模型空选择被驱动当成切换**：Core 把调用方的原始 `model` 交给驱动，launch 绑定模型的引擎回 409 `ENGINE_MODEL_SWITCH_UNSUPPORTED`。应交提供方解析后的模型（`69ef486`）。
2. **显式配置的可执行文件路径不存在**：原先等宿主报泛泛的 `HOST_START_FAILED`；应在 `open()` 内 `ENGINE_EXECUTABLE_NOT_FOUND` 指名来源（`fc747e5`）。
3. **`spawn()` 没创建出进程被当成活进程**：pid 为空、只有 `error` 事件、没有 `exit`，宿主等 48 s 后判"停止未证实"并围住会话。pid 为空应立即判已停止并写归属记录（`fc747e5`）。
4. **进程生命周期守卫的辅助进程只拿到 7 个环境变量**：Windows PowerShell 静默 30 s，守卫从未真正生效，一直是文件锁兜底。应使用与进程宿主同一份系统环境白名单（`fb937d1`）；修后 Windows 网关就绪从 29 s 降到 2 s。
5. **归属记录 rename 在 Windows 上短暂 EPERM**：ready 帧里的引擎 pid 更新被吞掉。应短暂重试并把失败写进诊断（`fb937d1`）。
6. **`tool.started` 带空参数**：OpenCode 先发 `rawInput: {}` 的 pending，再发带参数的 in_progress。应在参数绑定后才起调用，名字首次出现即锁定（`d5c7a96`）。
7. **权限请求的 operation 是文件路径**：OpenCode 的 `session/request_permission` 无 `name`、`title` 为路径，策略 `write: ask` 永远匹配不上并被默认 allow 放行。应用驱动锁定的工具名（`dd7f7b8`）。
8. **`--host localhost` 双栈**：Fastify 5 同时绑定两族，评测客户端两种拨号都通（`e093608` 冒烟证据）。
9. **评测方权限闭环**：`GET /permission` → `POST /permission/{id}/reply` 回 `once`/`reject`，文件写入与否、会话回 idle、重复回复 404，真实引擎上成立（`dd7f7b8`）。

另有两条 CI 层教训：固定毫秒睡眠断言在慢 runner 上失败后，夹具没关 SQLite worker 导致测试文件进程永不退出、作业挂到六小时上限不出日志。应等待证据而非猜时间，`finally` 里关存储，测试运行器加每测试超时与 `--test-force-exit`，作业加分钟级上限（`6772ed6`）。

---

## 5. 建议的验证方式

不要靠人读规范对代码，用**规范逐字段核对器**：PR #1 的 `scripts/e2e/`（按 `npm start -- --port 6217 --host localhost` 启动、双地址探测、真实引擎、权限闭环、四条 CI 腿）已经是可用的符合性测试床，建议 master 直接采用，并补两类断言：

- **规范字段级**：对规范第 3–7 章的每个响应与事件做键名/类型断言（含 `patterns`、`created_at`、`status.type`、`part.type` 枚举），缺一项即红；
- **评测姿态级**：并发开两个会话同时 prompt（R1）、传一个不在档的 `model`（R2）、`directory` 指向不存在的目录（R4）、多带一个未知字段（R8）、对失败用例的会话补 abort（R6）。这五条就是本文的 P0，测试床上一次跑完。

---

## 6. 优先级与分配

| 优先级 | 条目 | 建议实现 |
|---|---|---|
| P0 | R1 并发/排队、R2 模型宽松映射、R3 集成配置化、R4 目录创建、R5 启动入口与默认 host、R6 围栏会话 abort | 实现模型按条目做，每条带一个测试床用例 |
| P1 | R7 `patterns`、R8 入站体宽松、R9 model 可选、R10 question 形状（B 线）、R11 文档化 409 | 同上 |
| 已在 PR #1 | §4 的九条 | 可按提交挑选合入 |

以上判断均可用第 5 节的测试床一次性证伪；证伪不了的条目不必改。

---

## 7. 顶层裁决：GPT 提出需要架构级审定的五项策略

裁决原则只有一条：**评测姿态下，"拒绝"的代价是整轮归零；"宽松"必须限定在部署边界之内并且可审计。** 凡是宽松只发生在"调用方给的名字/字段"层面、不扩大任何端点或权限面的，采纳；凡是会把未批准端点、未批准凭据或未批准路径放进来的，不采纳。

| 条目 | 裁决 | 边界与记录 |
|---|---|---|
| **R1 单执行槽** | **按 `docs/spec/contracts.md` §3.1 已写明的规范落地**：全局一个活跃 Run；同会话第二个 `prompt_async` 409 `SESSION_BUSY`；跨会话请求进入有界 FIFO 队列等待，不立即拒绝；队列满才 409 `GATEWAY_BUSY`（带 `Retry-After`）。排队中不建 Run、不发 busy；deadline 从取得槽起算；排队中可 abort 且不产生 Run。 | 队列上限保持规范默认 8，`PNP_RUN_QUEUE_LIMIT` 可配（1–128）。并发执行池不做——同桌面干扰是规范选择单槽的理由，评测证明需要并发前不推翻。 |
| **R2 model 宽松映射** | **采纳**：不在配置档的 `model` 落到配置档默认模型。 | Run 记录写 `model.requested` 与 `model.resolution: "substituted"`，日志 warn；`PNP_MODEL_STRICT=1` 恢复 403。安全论证：配置档才是端点允许清单，调用方给的只是名字；替换到已批准端点不扩大任何访问面。 |
| **R3 默认集成** | **采纳：集成是配置，不是代码交付**。默认读取交付包内的 `configured` 档；内网模型是档里的一个端点（`openai-chat` 或以 `protocol` 字段选择的 appid 变体）；`internal` 不再是独立的、可以"未实现"的 provider。 | 只有档缺失/无效或凭据环境变量缺失才拒绝启动，并指名是哪一项。凭据仍只走环境变量，不落盘、不进仓库。C 线交付的是档与协议变体，不是启动门禁。 |
| **R4 自动创建 directory** | **采纳，有边界**：不存在则 `mkdir -p`（父目录可写）。 | 仍拒绝相对路径、指向文件的路径、位于 `PNP_DATA_DIR` 内或系统目录下的路径；会话记录 `directoryCreated: true`；删除会话永不删除该目录。 |
| **R5 启动入口与默认 host** | **采纳**：`gateway.cmd`/`gateway.ps1` + `package.json#bin`；默认 host `localhost`。 | 允许的绑定地址集合不变（仍只有回环）。 |
| **R6 围栏会话 abort** | 合并后 master 已是会话级（`gateway-core.ts:658-669`），**关闭**。 | — |
| **R8 未知字段** | **采纳，限定范围**：评测方入站体（`POST /session`、`prompt_async`、两个 `reply`）忽略未知字段，必填字段类型仍校验。 | 管理/诊断端点保持严格。 |

---

## 8. 对 `224cfa9`（契约 1.1 `tool.observed`）的设计审查

**认可**：驱动不再制造"失败的引擎结果"；`content`/`locations` 等部分事实以 patch 语义保存；恢复时给未闭合观察标 `result_unknown`；两种事件家族不混用；`ResourceScope.retire` 只在证据充分时移除。这些都对。

**两处设计决定需要改**：

**D1 未闭合的工具观察让整轮失败。** `drivers/acp/channel.ts:366-367` 在 `unresolved > 0` 时 `finish(..., "tool_result_missing", false)` → `state: "failed"`；Core 对 `completed` 且仍有非终态观察也抛 `ENGINE_PROTOCOL_ERROR`。真实引擎上只有 `write` 验证过会发终态更新；任何一个工具缺一条终态更新，用例即使给出了正确的最终答复也被判 failed，评测方拿到的是错误文本而不是引擎的答复。裁决：**轮次终态由引擎的 stopReason 决定**；未闭合的观察由 Core 追加 gateway-observation（`result_unknown`）——这正是 finally 块已有的语义——不改判轮次，也不由驱动伪造结果。"不伪造"与"不误判"可以同时成立。

**D2 canonical 身份拒绝使用宣告标题。** OpenCode 的 ACP 更新没有 `name`，`tool_call` 宣告时 `title: "write"`（真机探测记录在 `docs/engines/opencode.md` §4.2）。在 `224cfa9` 的规则下，OpenCode 的轨迹**永远**没有 `tool_calls`、`info.finish: "tool-calls"` 和 `role: "tool"` 消息，只剩 parts 里的观察，冒烟断言也随之削弱为"不断言"。这与规范的参考消息形状分道扬镳，裁判模型读轨迹时看不到工具名。裁决：**canonical 名称 = `name` ?? 宣告时（phase `created`）的 title**，记录出处 `nameSource: "name" | "announced-title"`，之后的 title 变更永不改名。理由：引擎"以 write 这个标签宣告了这次调用"是真实观察，不是发明；驱动在权限侧已用同一规则（`policyName`），轨迹侧没有理由更严。随之恢复冒烟里被削弱的三条断言（`tool_calls` 含 `write`、`role: "tool"` 消息存在、`finish: "tool-calls"`）——它们此前在真实引擎上是通过的。

**D3（小）**：观察 part 把 `title` 放在顶层；规范的 tool part 形状是 `tool` + `state.status` + `state.title`。镜像一份，不删原字段。

验证要求：D1、D2 各配一条真实引擎冒烟断言与单元测试；仍以第 5 节的测试床为准。

---

## 9. 下一步

用户确认第 7、8 节后：实现模型按 R1–R5、R8、D1–D3 落地，**每条一个独立提交并附一个测试床用例**（第 5 节的五条评测姿态断言随之补齐）；顶层模型只复审设计一致性与测试床结果，不逐行复审实现。

---

## 10. 确认记录

- 2026-09-06：用户确认第 7、8 节的裁决，并指示"GPT 尚未实现或仍有问题的，由顶层模型确认方案后交实现模型落地，直接在 master 修改"。据此，第 7、8 节不再是待批准的建议，而是已确认的决定。
- 其中与 `engineering/docs/spec/contracts.md` 现有文字冲突的三处，随实现一并修订规范文本，使规范与代码同步：（a）§3.1 队列——按规范落地，默认 8 不变，仅补 `PNP_RUN_QUEUE_LIMIT`；（b）"正常完成仍有非终态观察必须按协议错误处理"改为"由 Core 追加 `result_unknown` 观察，轮次终态由引擎 stopReason 决定"（D1）；（c）"只有真实 name + input 才建立 canonical tool call"改为"name 或宣告时 title（记录 `nameSource`）+ input"（D2）。
- 实现分工：三个实现模型并行，分别负责 D1–D3、R2/R3/R5、R1/R4/R8；R7（权限 `patterns`）在三者合入后单独补做。顶层模型只复审设计一致性与测试床结果。
- `engineering/docs/team/handoff-current.md` §2、§4 写于本确认之前，其"尚未获得用户确认"的表述以本节为准。
