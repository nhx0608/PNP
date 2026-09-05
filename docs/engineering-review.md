# PNP 工程交付评审与开发规划（第一性原理版）

> 评审日期：2026-09-05
> 评审对象：`engineering/`（提交 `63b0a80 fix: harden shared gateway foundation`）——
> `docs/spec/*`、`docs/team/*`、`prompts/*`、`code/src/**`、`code/scripts/**`、`native/windows/**`、`verification/*`。
> 评审依据：赛题任务书与调测指南原文、通用网关协议（[gateway-api-baseline.md](./gateway-api-baseline.md)）、
> 10 条已知评测用例（[evaluation-cases.md](./evaluation-cases.md)）、33 份调研（[research/](./research/README.md)）、
> 上一轮方案评审（[architecture-review.md](./architecture-review.md)）。
> 方法：先在沙箱实际 `npm install`、`tsc --noEmit`、跑通 46 项单测与 2 项契约测试；再由 4 路独立审查
> （核心语义与存储、Windows 进程治理、文档与分工、ACP 可行性）用可执行脚本复现关键假设；最后按赛题倒推合并结论。
> 文中标注"已复现"的条目都是运行代码得到的结果，不是阅读推断。

---

## 0. 一页结论

**骨架可用，不需要推翻。** 状态机、事件顺序、轨迹格式（`user → assistant(tool_calls) → tool → assistant(finish=stop)+step-finish`）、
`prompt_async` 真阻塞到终态、"不伪造成功"、Job Object 调用序列、迟到资源闭环——这些最难写对的地方都写对了，且有测试。

**但有三处第一性层面的方向性错误，加一处极可能在评测机首轮就触发的 Windows 单点：**

| # | 问题 | 后果 | 性质 |
|---|---|---|---|
| ① | **安全姿态反了**：任何一次"无法证明停止"都升级为进程级熔断（`reserved`/`healthy` 单向锁死），且 `abort`、存储抖动、上一轮残留都能触发 | 一个用例的不确定 → 本轮其余用例全部 503；跨轮传染 | 设计决策错误，不是 bug |
| ② | **端到端被共享代码封死**：`main.ts` 把真实引擎硬绑到未实现的 `InternalIntegration`，`ConfiguredIntegration` 无法选中，默认授权 deny | A/B 在 C 交付前无法跑通任何真实引擎；`/question`、`/permission` 永远无事可答 | 分工假设与代码不一致 |
| ③ | **70% 分数的杠杆没人做**：Office/GUI/检索三类能力覆盖 10 条用例中 9 条，`work-packages.md`/`ownership.json` 无所有者，代码无内容 | 引擎接通了也解不了题 | 分工空洞 |
| ④ | **Windows 启动单路径**：Job helper 用 `powershell -File job-host.ps1` 且无 `-ExecutionPolicy Bypass`，无 `taskkill` 兜底 | 解压后带 MOTW 的评测机上 helper 起不来 → 所有引擎、所有用例 0 分 | 实现缺陷 |

其余问题按"整轮致命 / 单用例 / 质量"三级列于第 3 节，共 13 条整轮致命、18 条单用例、11 条质量项。
**整轮致命的 13 条里，前 9 条估计合计改动量不超过 300 行**，但决定"一轮能不能跑完"，应作为所有引擎工作的前置，
本周内以一个共享变更批次完成（第 7 节）。

分工与模型分配结论见第 5、6 节：A（用户本人）驱动共享加固 + ACP/OpenCode；B 做 Pi + Office 能力包；
C 做内网模型/员工助手 CLI/权限 + 桌面与检索工具绑定；Hermes 降为可选。顶层规划与架构决策用 Fable，
状态机与进程治理类用 Opus，其余全部 Sonnet，格式化与样板用 Haiku。

---

## 1. 从赛题倒推的第一性原理

评分模型决定优先级，不是架构美感决定优先级：

- **70% 客观分按用例计，取各引擎最高分**。评测方按引擎分轮次，每轮跑完全部用例；每个用例一个 Session，
  `prompt_async` 阻塞到终态后 `GET /message` 取轨迹评分。**任何进程级 503 都把"一个用例失败"变成"本轮剩余用例全部失败"。**
- **评测方零人工**。不会跑 `npm run recover`，不会删锁文件，不会调 Node 版本，不会改执行策略。任何需要人工的恢复路径等于没有。
- **10 条已知用例的能力面**：文件系统 8 条、Office 三件套 6 条、数据分析 3 条、GUI 1 条（且是完整二级类别）、检索 1–2 条。
  引擎本身不带这些能力，全靠网关注入。**引擎接通只是入场券，能力注入才是分数。**
- **20% 架构分**看契约与可替换性，当前设计已经达标；**5% 鲁棒分**看故障处理，"全局熔断"在这里恰恰是反例。

由此得到五条硬规则，第 2–3 节所有判断都从它们推出：

1. **不确定只能隔离到 Session，永远不能污染进程。** SQLite 已经用 `recovery=blocked` 做了会话级围栏，进程级熔断是冗余且有害的。
2. **降级优于拒绝。** 容量满了淘汰空闲通道，事件太大截断，Job 建不了退化为普通进程树，都不能 503。
3. **评测面上的错误码只能是 400/404/409/5xx 中语义正确的那个**，客户端输入问题绝不能 500。
4. **默认 allow 并全量记录**，组织 deny 由 C 的策略层给出；默认 deny 让反问/授权接口形同虚设。
5. **能力注入是一等交付物**，有所有者、有目录、有验收；不是"由能力覆盖验证决定"的待定项。

---

## 2. 架构设计评审（`docs/spec/*`）

### 2.1 做对的部分（不需要改）

- 分层与边界：Gateway（HTTP/SSE）→ Core（Session/Run/事件/交互/取消）→ Driver（ACP、Pi RPC）→ EnginePack → IntegrationProvider。
  Core 不按引擎名分支，适配器不碰 Fastify/SQLite/child_process，`AGENTS.md` 的 10 条语义约束表述精确。
- `EngineSessionChannel` 按 Session 隔离，`open/run/cancel/terminate/close` 五个动作职责清楚；`close()` 保留原生历史、`terminate()` 只收资源，这是后面 LRU 淘汰能安全落地的前提。
- 每轮新 `IntegrationContext`，凭据不被适配器缓存；`ProcessHost.start(spec, signal, resources)` 先登记再 spawn。
- ACK 与完成分离、取消 ACK 与停止证据分离、`StopEvidence.quiescent` 显式化——这三条是调研 G07 的直接落地。
- `node:sqlite` 单驱动、不做 better-sqlite3 双路径：比上一轮评审建议更激进地避开了 Windows 原生编译风险，是合理的替代决策。

### 2.2 需要改的设计决策

**D1. "不确定 → 进程级熔断"必须改为"不确定 → 会话级隔离 + 诊断可见"。**
`architecture.md` §9 与 `contracts.md` §5 把"无法证明停止"当成全局不可信状态。按第 1 节规则 1，正确语义是：
该 Session 进入 `blocked`（已有），其 channel/scope 从常驻表摘除，`/diagnostics` 记录 `degraded` 与原因；
`healthy` 只表达"存储不可用"，`reserved` 无条件释放。评测方不会因为一个用例的取消不干净而原谅后面九个用例的 503。

**D2. 并发模型自相矛盾。** `dfx-and-testing.md` §29 说默认并发 Run 数为 1，`INSTRUCTION.md` §4 又写"并行调用 prompt_async"。
决定：**跨 Session 并发 2（可配），单 Session 串行**（DB 的 `one_live_run` 索引已保证），第二个同会话请求 409，跨会话请求排队而非拒绝。

**D3. 能力注入没有设计位置。** `requirements.md` §7 只说"是否需要 Python/Office/视觉模型由能力覆盖验证决定"。
需要在 `contracts.md` 加一个 **Capability Pack** 概念：一组可投影到任意引擎的资产（`SKILL.md`/提示片段、MCP stdio 工具、
预置 Python 环境路径、危险命令清单），由 `IntegrationContext.assets`/`tools` 携带，由各 Pack 用引擎原生机制投影
（ACP 用 `session/new.mcpServers` + 私有配置目录，Pi 用 Extension）。它是资产层的内容，不改 Core 接口。

**D4. 发布门禁比赛题严。** `release-profile.json` 要求 opencode/pi/hermes 三个全过，赛题只要求 ≥2。
Hermes Windows 仍是早期 beta（调研 T04），ACP 会话为进程内内存态。决定：`engines` 改为 `["opencode","pi"]` 必过，
`optionalEngines: ["hermes"]` 有证据则加分、无证据不阻断发布。

**D5. 进程治理是单路径设计。** `architecture.md` §9 写了"stdin EOF、进程退出、协议无响应均有有界清理路径"，
实现只有 `TerminateJobObject` 一档；COM/DCOM 拉起的 Office 进程明确不在 Job 内且没有替代回收方案。
需要三档：stdin EOF 优雅期 → Job 终止 → `taskkill /T /F` + `tasklist` 复核；Office 残留按"本轮开始后创建的进程"精确回收，
不按进程名全杀（仍符合 `AGENTS.md` 第 7/8 条）。

**D6. 工具链钉死到补丁版。** `toolchain.json` 24.19.0 精确相等，`package.json` 却是 `>=24.19.0 <25`。改为范围匹配，
并在 `INSTRUCTION.md`/`install.ps1` 写明 `winget install OpenJS.NodeJS.LTS` 类自愈步骤。

**D7. 错误码 45 个、HTTP 状态 8 类。** code 字段数量不用收敛，但 HTTP 映射必须正确：Fastify 自身的 400/415 不能被压成 500，
`directory` 不存在是 400，用户主动 abort 后的 `prompt_async` 建议 204（轨迹如实记 `finish=cancelled`，不构成伪造成功）。

---

## 3. 详细设计与实现评审（`code/`）

分级口径：**R**=整轮致命（从故障点起本轮后续用例全灭或下一轮起不来）；**S**=单用例失败或显著失分；**Q**=质量与可维护性。
每条给出位置、复现状态、修法要点；修法细节以四份专项报告为准（本文末尾"附录"列了它们的关键代码片段位置）。

### 3.1 整轮致命（R）

| ID | 位置 | 问题 | 状态 | 修法要点 |
|---|---|---|---|---|
| **R1** | `core/gateway-core.ts:360,399` | `quiescent=false` 时 `healthy=false` 且 `reserved=true`，进程内无任何路径改回；换一个全新 Session 也 503/409 | 已复现（不同 session 照样 503） | finally 里 `reserved=false` 无条件；`!quiescent` 只把该 sessionId 加入 `quarantined` 并摘除其 channel/scope；`healthy` 只在 `STORAGE_*` 时置位 |
| **R2** | `core/gateway-core.ts:416-434` | 对"DB busy/blocked 但进程内无 activeRun"的会话 `abort` → 全局 `healthy=false`；`abort` 成功也因历史 `!healthy` 抛 503；`deleteSession` 先 `abort` 于是永远删不掉 | 已复现 | `abort` 只报告该会话状态（409 `SESSION_UNAVAILABLE`），不动 `healthy`；`deleteSession` 尽力停止后仍允许删除网关侧记录 |
| **R3** | `core/gateway-core.ts:92,206` | 常驻通道上限 8、无淘汰；正常完成的 run 不关 channel；"一个用例一个 session"跑到第 9 个必 503 | 已复现（case 9/10 → `HOST_CAPACITY`） | 满额时按 `lastUsedAt` 淘汰非 active 的最旧通道，`disposeSessionResources(victim,"close")`；上限提到 16 并可配 |
| **R4** | `runtime/instance-lock.ts:9-12`、`main.ts:33-51`、`gateway-core.ts:97-101,456` | (a) `close()` 在 `!healthy` 时抛错 → `unlock()` 不执行，正常 Ctrl+C 也留锁；(b) `taskkill /F` 不发信号必留锁；(c) 锁不判 PID 存活，下次启动 `INSTANCE_LOCKED`；(d) `initialize()` 发现上一轮 interrupted/blocked 即开局 `readiness=false` | 已复现（round 2 全 503，跑 recover 后 round 3 恢复） | `unlock()` 移出 `clean` 判断 + `process.on("exit")` 兜底；锁 EEXIST 时读 PID 判活（win32 比对 `startedAt`），死则接管；`initialize()` 只标 `degraded` 不阻断 readiness；加 `SIGBREAK` |
| **R5** | `gateway/app.ts:96-97` | `reply.raw.write()` 返回 false 即断开 SSE；实测 64 KiB 单帧就触发，而事件上限 1 MiB、`text.delta` 还是全量累计文本 | 已复现（120 KB 工具输出即断流） | 忽略 `write()` 返回值，只在 `writableLength > 8 MiB` 才断；`text.delta` 改发增量；补 `retry: 3000` 与 `Last-Event-ID` 补发（`events.sequence` 已有） |
| **R6** | `main.ts:41`、`integration/{internal,mock,configured}/provider.ts` | 非 mock 引擎硬绑 `InternalIntegration`（无条件 503）；`ConfiguredIntegration` 无法选中；默认策略 deny → `question.asked`/`permission.asked` 永不发布 | 已复现（deny 下 `GET /question` 恒空） | `PNP_INTEGRATION=internal\|configured\|mock` 选择 provider；`configured` 从 `config/internal.json` 读模型/工具/策略；默认 `{effect:"allow", reasonCode:"COMPETITION_DEFAULT_ALLOW"}` 并落库 |
| **R7** | `runtime/process-host.ts:166-168`、`native/windows/job-host.ps1` | `powershell -File x.ps1` 受执行策略约束；PS 5.1 默认 Restricted；解压后 MOTW 标记下 RemoteSigned 也拒绝；全仓无 `-ExecutionPolicy Bypass` | 静态确认（沙箱无 Windows） | 把 6 行引导逻辑编成 UTF-16LE base64 走 `-EncodedCommand`（不受执行策略与 MOTW 影响）；`.ps1` 仅留调试用 |
| **R8** | `runtime/process-host.ts:85,104-108` | win32 只有 Job helper 一条路；`CreateJobObject`/`Add-Type`/Assign 任一失败即抛；`terminate()` 两次 10 s 超时后直接 `quiescent:false`；全仓无 `taskkill`/`tasklist` | 静态确认 | 增加 `mode: "job"\|"degraded"`：helper 起不来则普通 spawn；`terminate()` 放弃前 `taskkill /PID /T /F` 再 `tasklist /FI "PID eq"` 复核；`reconcile()` 同样先用 `tasklist` |
| **R9** | `native/windows/JobHost.cs:121`、`process-host.ts:113-121` | `bInheritHandles=true` 且无 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`，引擎树继承 helper 的 std 句柄；helper 退出后只要引擎树有进程活着 Node 的 `close` 就不触发；`exited` 只在 `close` 里 resolve → terminate 必超时 → 引爆 R1 | 静态确认（Win32 语义） | C# 侧 `CreateProcess` 前对自身三个 std 句柄 `SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0)`；Node 侧退出判定改用 `exit`，`close` 只做流清理 |
| **R10** | `scripts/{doctor,foundation-check,release-check}.mjs` | Node 版本 `===` 精确比较；24.20.x 全部判失败；`INSTRUCTION.md` 无自愈步骤 | 已复现（22.x 直接抛错） | 范围比较（同 major 且 ≥ minor.patch）；`release-check` 的证据溯源比对可保留精确相等 |
| **R11** | `scripts/recover.mjs:8,11,22` | `recovery.lock` 残留则永远 EEXIST；`gateway.lock` 缺失则 ENOENT 退出、blocked 永远清不掉；任一 host 记录核验不过整体 throw，而 `data/hosts/*.json` 从不删除、线性累积且每条 win32 都要起一次 PowerShell | 静态确认 | 陈旧锁按 PID 判活接管；允许 `gateway.lock` 缺失；逐条处理，quiescent 的记录 `unlink`，不过的只 fence 对应 session；`terminate()` 证实 quiescent 时直接删记录 |
| **R12** | `storage/store.ts:28,36-39`、`worker.ts:14,291`、`gateway-core.ts:58` | 单次 SQLite 操作 >15 s（杀软扫描、OneDrive）→ `worker.terminate()` 且不重建 → 永久 `STORAGE_UNAVAILABLE`；任何原生 sqlite 错误包成 `STORAGE_ERROR` → `observeFailure` 见 `STORAGE_` 前缀即 `healthy=false`（一次 UNIQUE 冲突就够） | 静态确认；打开失败错误被吞已复现 | 超时只失败本次调用；连续 N 次或 worker `exit` 才重建；约束冲突映射为非 `STORAGE_` 前缀；`worker.on("error")` 记录原始错误；启动校验 `PNP_DATA_DIR` 可写且非 UNC |
| **R13** | `gateway-core.ts:236,240` | 单事件 >1 MiB 或累计文本 >8 MiB 直接 throw → run 失败 → terminate → 5 s 内没停干净就是 R1；一个"读 2 MB 日志"的工具调用即可触发 | 静态确认 | 截断而非失败：payload 超限写 `{truncated:true, bytes, preview}`；累计超限停止追加，最终消息标 `truncated`，`finish` 用 `length` |

### 3.2 单用例失败或显著失分（S）

| ID | 位置 | 问题 | 修法要点 |
|---|---|---|---|
| S1 | `gateway/app.ts:17-23`、`core/errors.ts` | Fastify 自身错误压成 500：`Content-Type: application/json` 空 body 的 abort → 500（很多 HTTP 库对无 body POST 就这么发） | 错误处理器透传 `error.statusCode`；abort/stop/reply 路由允许空 body |
| S2 | `security/workspace.ts:9` | `directory` 不存在 → `realpath` ENOENT → 500；不接受相对路径 | `path.resolve` + 容错 `mkdir` + ENOENT → 400 |
| S3 | `gateway-core.ts:402-408` | 用户 abort 后 `prompt_async` 返回 409 `EXECUTION_CANCELLED` | 用户主动 abort 返回 204（轨迹已如实 `finish=cancelled`）；deadline/引擎错误保持 504/502 |
| S4 | `core/interactions.ts:65,82-83` | 反问超时与策略拒绝都回 `{decision:"deny"}` 无原因；question 的策略事件误用 `permission.resolved` 名 | 扩展 `reason:"TIMEOUT"`；事件名跟 `${kind}.resolved`；`interactionTimeoutMs` 120 s → 45 s |
| S5 | `gateway-core.ts:243-248` | 每个检查点写全量累计文本（DB `synchronous=FULL` 每次 fsync + SSE 全量帧），O(n²)；2 MB 回答 ≈ 500 MB 写入 | DB 只在终态写全量；SSE 发 delta；`synchronous=NORMAL`（WAL 下安全） |
| S6 | `gateway-core.ts:88-92`、`main.ts:42` | `runTimeoutMs=900s / openTimeoutMs=30s / cancelGraceMs=5s / interactionTimeoutMs=120s / maxResidentSessions=8` 全部硬编码；`cancelGraceMs=5s` 是 R1 的主要触发器 | 全部走 `PNP_*_MS` 环境变量，默认 `cancelGrace=15s`、`open=60s`、`resident=16` |
| S7 | `storage/store.ts:28` | `worker.on("error", () => this.fail())` 丢弃错误对象，`SQLITE_CANTOPEN`/权限/路径信息全无 | 记录并透传原始 message |
| S8 | `gateway-core.ts:375-378` | 最后一段 <4 KiB/100 ms 的文本与最终消息只落库不发 SSE | `finishRun` 后补发一条含完整 text + `step-finish` 的 `message.part.updated` |
| S9 | `JobHost.cs:133-141` | terminate 只有硬杀，无 stdin EOF 优雅期；引擎正在 `SaveAs` 时被杀 → 半写文件 + `~$xxx.docx` 锁残留 → 相邻用例打不开 | 两阶段：`stdin.Dispose()` → `WaitForSingleObject(graceMs)` → 才 `TerminateJobObject`；控制帧带 `graceMs` |
| S10 | 全仓无 Office 清理逻辑 | COM/DCOM 拉起的 WINWORD/EXCEL/POWERPNT 不在 Job 内 | run 结束时 WMI 查 `CreationDate > t0` 的 Office 进程，先 COM `Quit()`，仍存活再 `taskkill /PID`；只杀本轮之后创建的 |
| S11 | `JobHost.cs:144` | 父守护 Task `catch {}` 后直接 `TerminateJobObject`；`GetProcessById`/`WaitForExit` 抛异常（完整性级别不同）→ 引擎启动即被静默杀 | catch 里退化为 500 ms 轮询判活，只有父进程确认消失才杀 |
| S12 | `process-host.ts:12` | 环境变量白名单缺 `SystemDrive/ProgramFiles*/ProgramData/ALLUSERSPROFILE/USERNAME/HOMEDRIVE/HOMEPATH/PROCESSOR_ARCHITECTURE/NUMBER_OF_PROCESSORS/OS/PUBLIC/PSModulePath` | 补齐（都不含凭据） |
| S13 | `process-host.ts:91-93,170-196` | 退出核验只能再起一次 PowerShell + `Add-Type`（1–2 s），helper 不可用时恒判失败 | 先 `tasklist` 判 helper 是否已消失（消失即 Job 已关、KILL_ON_JOB_CLOSE 已生效） |
| S14 | `process-host.ts:110,143-145`、`JobHost.cs:85-89` | 启动期 abort 在 `launch` 帧之前写 `terminate`，helper 把它当配置行解析崩溃，随后 EPIPE 逃逸成 `INTERNAL_ERROR` | `launch` 前检查 `signal.aborted`；`controlWrite` 失败包成 `HOST_START_FAILED`；C# 侧校验 `jobName` |
| S15 | `gateway-core.ts:222-225,349-354`、`resource-scope.ts:17`、`process-host.ts:71` | open 超时后 `openSettled=false` 直接判 `quiescent=false`；`stopping`/`stopPromise` 用 `??=` 记忆化失败结论，永不重试 | 等 `opening` settle（有界）再算；只缓存 `quiescent===true` 的结果 |
| S16 | `process-host.ts:135,139` | helper 与引擎 stderr 全量丢弃；引擎因缺依赖退出只剩 `HOST_EXITED` | 16 KiB 环形缓冲，经 `Redactor` 脱敏后挂到 `HOST_EXITED`/`session.error` |
| S17 | `main.ts`（无）、`scripts/doctor.mjs:15-19` | Session 0 只在人工 doctor 里检查；网关被注册为服务/计划任务时 GUI 用例静默全灭 | `main.ts` 启动时 win32 做同样检查，Session 0 直接拒绝启动 |
| S18 | `gateway/schemas.ts`、`gateway-core.ts:248`、`app.ts` | `parts` 用 `{type:"text", content}` 而 opencode 参考格式是 `text`；`PromptSchema.model` 必填且不接受 `"provider/model"` 字符串；`GET /session/status` 只返回全量 map | 两个字段都写（`content`+`text`）；`model` 可选、缺省用配置默认；同时支持单会话/全局状态形态 |

### 3.3 质量与可维护性（Q）

| ID | 位置 | 问题 |
|---|---|---|
| Q1 | `runtime/jsonl.ts:17,20` | 每次 push 全量 `Buffer.byteLength`，接近 4 MiB 上限时 O(n²) |
| Q2 | `runtime/jsonl.ts:23-28` | `end()` 生产路径从未调用，截断帧静默丢弃（F10 未真正生效） |
| Q3 | `JobHost.cs:152` | 退出时输出泵只等 2 s，尾部输出可能丢；exit 帧应带 `drained` 标记 |
| Q4 | `scripts/recover.mjs:13-15` | owner 判活只比 PID 不比 `startedAt`，Windows PID 复用会永久拒绝恢复 |
| Q5 | `scripts/{doctor,foundation-check}.mjs` | 依赖当前工作目录；从别处执行误报 |
| Q6 | `scripts/doctor.mjs` | 缺最该做的 `job-helper-smoke`（真起一个 `node -e "process.exit(0)"` 验证 ready/exit/quiescent）和模型往返探针（硬编码 `not_run`） |
| Q7 | `tests/unit/runtime.test.ts` | 唯一 win32 用例 `skip`；helper 帧解析与 `reportExit` 一次性语义无非 Windows 覆盖 |
| Q8 | `registry/index.ts:19` | `environment ?? cli` 环境变量优先于命令行；残留 `AGENT_ENGINE` + `--engine` 直接启动失败。建议 CLI 优先、冲突告警 |
| Q9 | `gateway/app.ts` | 心跳与 `server.connected` 无 `id:` 行、无 `retry:` 行 |
| Q10 | `verification/results.json`、`logs/release-gate.json` | 仍报告"缺 package-lock.json"，与 `63b0a80` 之后状态不符，证据滞后 |
| Q11 | 全仓 | 无 `solution/{INSTRUCTION.md, code/}` 打包脚本；`engineering/` 顶层十余项需人工剔除 |

### 3.4 已确认做对的地方（不要动）

1. `prompt_async` 真阻塞：`await core.run()` 后才 204，Fastify `requestTimeout` 不打断长响应（已实测 4 s 响应正常）。
2. 轨迹顺序与 upsert：`finishRun` 先 DELETE 再 INSERT 使最终 assistant 消息稳定排在所有 tool 结果之后；同 tool 的 started/finished 是真 upsert。
3. 不伪造成功：`state/finish` 一致性检查、`step-finish` 只在 `completed && stop`、未完成工具收尾为 `gateway-observation` 观察态。
4. 迟到资源闭环：`prepare`/`open` 超时后仍 `void promise.then(release|terminate)`；`ResourceScope` closed 后拒绝新申请。
5. 事件串行可等待：`eventTail` 链保证顺序、可 await、异常传播。
6. 交互并发安全：`settle` 在首个 await 前置 `replying`，配合 DB `resolveInteraction.changed` 双保险。
7. Job Object：`CREATE_SUSPENDED → Assign → ResumeThread`、`KILL_ON_JOB_CLOSE`、P/Invoke 结构体布局（EXT=144、ACCOUNT=48、SI=104、PI=24、SA=24）、
   管道父端清继承位、MSVCRT 命令行转义、Unicode 环境块——逐字节核对正确。
8. JSONL 分帧：LF 切分、UTF-8 跨块、CRLF、最大帧、U+2028/2029 全部正确且有逐字节单测；Pi RPC 与 ACP 共用安全。
9. 脱敏：`Redactor.streamText` 截掉可能被切半的秘密前缀；ProcessHost 环境白名单、`shell:false`、先写归属再 spawn。

---

## 4. 分工评审（`docs/team/*`、`prompts/*`）

### 4.1 Prompt 自足性：达标

`01-A-acp.md`/`02-B-pi.md`/`03-C-internal.md` 引用的路径全部真实存在，验收标准对应到 `contracts.md` 的具体条款，
A01–A07/B01–B07/C01–C06 都有交付表。无聊天上下文可执行。

### 4.2 三个真实缺口

**W1. A 的负载是 B 的两倍。** A 拥有 ACP Driver + OpenCode + Hermes 三块目录，并要跑通两套完整内网验收；B 只有 Pi 一套。
Hermes 又是 Windows 早期 beta。这不是"同时启动、工作量相当"。

**W2. 能力注入没有工作包。** `work-packages.md`/`ownership.json` 中 `SKILL.md`、`python-docx`、`openpyxl`、`python-pptx`、
`GUI`、`检索` 零命中；`assets/resolver.ts` 只是路径防护 + SHA-256。A06/B05 的"至少一种资产"是通用占位，不指向 Office/GUI/检索。

**W3. 共享代码的修复没有所有者。** 第 3.1 节 13 条 R 级全部落在 `shared` 目录（`core/gateway/runtime/storage/main.ts/scripts`），
按 `collaboration.md` 必须走变更单双方审查。但没有人被指定为"共享加固"的执行者，而它是所有引擎工作的前置。

### 4.3 ACP 线（A）可行性要点（供 A 直接使用）

来自 SDK 1.4.0 `types.gen.d.ts` 的核对结论：

- **不需要改公共契约**：`HostedProcess.write/onFrame` 已是逐帧 JSON 文本，直接手搓对象级 `Stream {readable, writable}` 交给
  `ClientSideConnection`，跳过 `ndJsonStream`；`proc.onExit` 时 `controller.error()` 让挂起的 `initialize/newSession/prompt` 尽快 reject。
- **StopReason 映射**：`end_turn→stop`、`max_tokens→length`、`max_turn_requests→unknown`、`refusal→content-filter`、`cancelled→cancelled`；
  `signal.aborted` 时以本地状态为准强制改写为 `cancelled`（opencode #33687 证实中断路径 `finish` 常漂移）。
- **未闭合 tool_call 兜底**：Core 在 `completed` 且仍有未 `finished` 的 tool 时抛 `ENGINE_PROTOCOL_ERROR`（`gateway-core.ts:334`），
  且未登记 callId 的 update 直接 502。Driver 自维护 `open: Set<toolCallId>`；`prompt` resolve 后把残留全部 `tool.finished{failed:true, errorCode:"ENGINE_TOOL_UNRESOLVED"}`。
  这不是伪造成功，是把引擎遗漏的终态显式标为失败。
- **ACP `Usage` 是会话累计值**，Driver 要做上次快照差值，否则多轮 token 重复计入。
- **模型注入**：ACP `PromptRequest` 无 `model` 字段，只能 `session/set_config_option`（category=model）；引擎不支持时按契约 §6 在发 Prompt 前
  显式 `UNSUPPORTED_MODIFICATION`，不得静默换模型。OpenCode 的模型端点/headers 写成**私有临时 `opencode.json`**，用 `OPENCODE_CONFIG`/`XDG_CONFIG_HOME`
  指向 `nativeDataDirectory`，绝不碰用户全局配置。
- **工具注入**：`ToolBinding(mcp-stdio)` 直接映射到 `session/new.mcpServers: McpServerStdio[]`；stdio 型无 headers，鉴权只能走 `env`；
  HTTP 型工具网关用 `McpServerHttp{url, headers}`（需 `mcpCapabilities.http`）。
- **`session/load` 大概率不可用**：Hermes ACP 会话是进程内内存态；opencode 未证实声明 `loadSession`。A02 的"原生恢复"按实测标 `declared/probed/verified`。
- **权限收窄**：`request_permission` 的 `allow_always` 禁止默认选中，`allow→allow_once`、`deny→reject_once`，扩大授权范围只能由 C 策略层决定。
- **一条需要变更单的公共限制**：`JsonlDecoder` 4 MB 帧上限可能与 ACP 大 `rawOutput` 冲突，属于 runtime 限制，不能在 A 目录私改。
- **Windows 分发形态**：`opencode.exe acp` 还是 `node.exe + JS 入口`，必须先探明（`LocalProcessHost` 拒绝 `.cmd` shim）；Hermes 自举到 `%LOCALAPPDATA%\hermes`。
- **Goose 作为备选**：协议层零改动复用，但取消语义与 `.goosehints` 资产加载必须重新走 A03 验证，不能因"同是 ACP"跳过。

---

## 5. 分工重排与开发规划

### 5.1 角色与所有权（在 `ownership.json` 基础上的增量）

| 角色 | 保留 | 新增 | 移除/降级 |
|---|---|---|---|
| **A（用户本人，合并负责人）** | `drivers/acp`、`engines/opencode`、`tests/adapters/acp`、`docs/engines/opencode.md` | **共享加固批次 CR-01～CR-13 的执行与合入**（第 7 节）；`code/assets/packs/` 目录骨架与投影约定 | `engines/hermes` 降为 P1 可选；Hermes 内网验收不进发布门禁 |
| **B** | `drivers/pi-rpc`、`engines/pi`、`tests/adapters/pi`、`docs/engines/pi.md` | **Office 能力包**（`code/assets/packs/office/`：SKILL.md + python-docx/openpyxl/python-pptx 脚本 + 产物自检清单 + 预置 Python 环境说明）；CR 批次的第二审查人 | — |
| **C** | `integration/internal`、`config/internal.example.json`、`docs/internal`、`verification/internal` | **C07 桌面/GUI 工具绑定**（WeLink 发送、Outlook 打开等软件交互，Windows UI Automation 或 MCP）；**C08 检索工具绑定**（内网可达的搜索/浏览入口）；**C03 改为默认 allow + 危险操作 `risk:high` 审计**（递归删除、外发消息不自动重试） | — |
| **共享** | `contracts/core/gateway/storage/runtime/security/assets/registry/main.ts/scripts/docs/spec` | `code/assets/packs/**` 由 A 建骨架，各包内容归各自所有者 | — |

理由：Office 能力包与引擎无关（纯资产），B 的负载最轻；GUI 与检索都依赖内网桌面身份和网络出口，C 已负责 `internal-integration.md` §5 桌面章节；
共享加固是所有人的前置，由合并负责人 A 驱动、B 复审最短路径。

### 5.2 里程碑（按"先能跑完一轮，再解题，再扩引擎"的顺序）

| 里程碑 | 内容 | 退出条件 | 建议时窗 |
|---|---|---|---|
| **M0 共享加固** | CR-01～CR-09（R1–R9）+ S1/S2/S3/S6；刷新 `verification/*`；`doctor` 加 helper 冒烟 | mock 引擎连续跑 20 个 session 不出现 503；`taskkill /F` 网关后重启无需人工；Windows 上 `job-helper-smoke` 通过 | 第 1–3 天 |
| **M1 首个真实引擎端到端** | A01–A04（OpenCode，FakeHost 先行，Windows 冒烟后接 `PNP_INTEGRATION=configured` + C 的脱敏夹具端点）；B01–B04（Pi 同步进行）；`assets/packs` 骨架 | Windows 上 `AGENT_ENGINE=opencode` 完成 `office_035` 类"生成 PPT"用例全流程并 `GET /message` 轨迹合规 | 第 4–8 天 |
| **M2 解题能力** | Office 包（B）、GUI/检索绑定（C07/C08）、内网模型 appid（C01）、员工助手 CLI（C02）、策略（C03）；两引擎各跑 10 条已知用例 | 每条用例至少一个引擎通过本地自检；`office_103` 无误删；`office_028` 幂等 | 第 9–14 天 |
| **M3 收口** | Hermes（可选）、R10–R13、S 级剩余、`solution.zip` 打包脚本、INSTRUCTION 复核、内网联合验收证据 | `release:check` 在 `["opencode","pi"]` 下 `releasable:true`；干净机器按 INSTRUCTION 零人工装启 | 第 15–18 天 |

时窗按截止日期等比压缩，但顺序不变：**M0 不完成不进 M1**，一个跑不完整轮的网关接再多引擎也是零分。

### 5.3 本周必须拍板的决策（团队三人）

1. Hermes 降为可选（D4）。
2. 跨 Session 并发 2、单 Session 串行（D2）。
3. 默认授权 allow + 全量记录，危险操作由 C 给 `ask`/`deny`（第 1 节规则 4）。
4. 用户 abort 后 `prompt_async` 返回 204（S3），并在 INSTRUCTION 声明。
5. `code/assets/packs/` 作为能力包目录，`ownership.json` 补 A/B/C 各自子目录。
6. 共享加固批次由 A 执行、B 复审，不等 GPT 的下一次交付。

---

## 6. 模型分配（按难度与重要度，额度有限）

原则：**Fable 只做规划与架构决策，不执行代码；Opus 只用于"错一处就整轮失败"的有状态逻辑；其余 Sonnet；样板 Haiku。**
每个任务一次 agent 运行，输入是本文对应条目 + 相关文件 + 验收测试，输出必须附实际测试结果。

| 层级 | 模型 | 适用任务 | 具体条目 | 预计运行次数 |
|---|---|---|---|---|
| **T0 规划** | Fable | 架构决策与最终 go/no-go；不写代码 | D1–D7 定稿；能力包契约（D3）一段文字；M2 后的整体复盘一次 | 2–3 |
| **T1 精细正确性** | Opus | 状态机、并发、进程生命周期、协议边界 | CR-01/02（会话级隔离重构，`gateway-core.ts` 一次改完）；CR-04（锁接管 + initialize）；CR-07/08/09（`-EncodedCommand`、降级模式 + taskkill、句柄继承 + exit 判定，`process-host.ts`+`JobHost.cs` 一次改完）；CR-12（存储 worker 韧性）；S9/S10/S11（优雅期、Office 精确回收、父守护）；A01–A03（ACP 连接、会话/取消竞态、11 种 sessionUpdate 映射与未闭合 tool 兜底）；B01–B03（Pi settled 语义、取消）；C01 模型 wire 协议探针（流式并行 tool_calls 截断问题） | 12–14 |
| **T2 常规实现** | Sonnet | 有明确规格、可用测试验证的改动 | CR-03（LRU）；CR-05（SSE）；CR-06（`PNP_INTEGRATION` + 默认 allow）；CR-10（Node 范围）；CR-11（recover）；CR-13（截断）；S1–S8、S12–S18；Q1–Q11；A04/A05 Pack 与配置；B04–B07；C02 CLI 包装、C03 策略、C04 夹具、C05 自检；Office 能力包全部脚本；C07/C08 工具绑定；`docs/engines/*`、INSTRUCTION 修订；打包脚本；契约测试补充 | 40–50 |
| **T3 样板** | Haiku | 无判断的生成 | JSON 配置样例、证据表格、handoff 记录格式化、测试夹具数据、README 索引 | 按需 |

用法约束：

- Opus 任务的验收由 `tests/kit/engine-contract.ts` 与新增单测给出，不靠另一个模型"读一遍"。
- Sonnet 遇到需要改共享契约或 Core 语义的情况必须停下来出变更单，不得就地改。
- 同一任务失败两次再升一级模型；不要一开始就上 Opus。
- Fable 的调用留给：本文更新、M0/M2 两次复盘、以及任何"要不要改设计"的问题。

---

## 7. 共享变更单清单（M0 批次，A 执行、B 复审）

| CR | 对应 | 文件 | 改动要点 | 验收 | 模型 |
|---|---|---|---|---|---|
| CR-01 | R1 | `core/gateway-core.ts` | `reserved` 无条件释放；`quarantined: Set<sessionId>`；`healthy` 仅存储语义；隔离会话摘除 channel/scope | mock `stuck:true` 后新 session 仍 204 | Opus |
| CR-02 | R2 | `core/gateway-core.ts` | `abort` 不动 `healthy`；`deleteSession` 尽力停止后允许删除 | 对 blocked 会话 abort → 409；delete → 200 | Opus（与 CR-01 同次） |
| CR-03 | R3 | `core/gateway-core.ts` | `lastUsedAt` + LRU `close` 淘汰；上限 16 可配 | 20 个 session 顺序跑完无 503 | Sonnet |
| CR-04 | R4 | `runtime/instance-lock.ts`、`main.ts`、`gateway-core.ts` | 陈旧锁 PID 判活接管；`unlock` 无条件；`initialize` 只标 degraded；`SIGBREAK`/`exit` 兜底 | kill -9 后重启即 ready | Opus |
| CR-05 | R5+S5+S8 | `gateway/app.ts`、`gateway-core.ts` | 忽略 `write()` 返回值；`text.delta` 发增量；`retry:`；`Last-Event-ID` 补发；终态补发完整文本事件 | 1 MiB 事件不断流；断线重连不丢事件 | Sonnet |
| CR-06 | R6 | `main.ts`、`integration/configured`、`config/` | `PNP_INTEGRATION` 三选一；`configured` 读 `config/internal.json`；默认 allow 并落库 `${kind}.resolved` | `AGENT_ENGINE=opencode PNP_INTEGRATION=configured` 启动成功且 `question.asked` 可见 | Sonnet |
| CR-07 | R7 | `runtime/process-host.ts` | helper 改 `-EncodedCommand` | Windows Restricted 策略 + MOTW 下 helper 起得来 | Opus（与 CR-08/09 同次） |
| CR-08 | R8+S13 | `runtime/process-host.ts` | `mode: job\|degraded`；`taskkill /T /F` + `tasklist` 复核；`reconcile` 快速路径 | 禁 Job 的沙箱仍能启动并终止引擎 | Opus |
| CR-09 | R9+S9+S11+S14 | `native/windows/JobHost.cs`、`process-host.ts` | std 句柄清继承位；`exit` 判定；两阶段 terminate 带 `graceMs`；父守护轮询；启动期 abort 顺序 | terminate 在引擎子进程存活时 <3 s 返回 quiescent | Opus |
| CR-10 | R10+D6 | `scripts/*.mjs`、`INSTRUCTION.md`、`install.ps1` | Node 范围比较；自愈安装步骤 | 24.20.x 下 `foundation:check` 通过 | Sonnet |
| CR-11 | R11+Q4 | `scripts/recover.mjs`、`process-host.ts` | 陈旧锁接管；允许无 `gateway.lock`；逐条处理并删 quiescent 记录 | 残留 100 条记录时 recover <10 s | Sonnet |
| CR-12 | R12+S7 | `storage/store.ts`、`worker.ts`、`gateway-core.ts` | 超时只失败本次；worker 重建；约束冲突非 `STORAGE_` 前缀；原始错误透传；`PNP_DATA_DIR` 校验 | 注入 20 s 慢查询后下一请求正常 | Opus |
| CR-13 | R13 | `gateway-core.ts` | 事件/文本超限截断，`finish=length` | 2 MB 工具输出用例完成且轨迹含 `truncated` | Sonnet |
| CR-14 | S1+S2+S3+S4+S6+S18 | `gateway/app.ts`、`schemas.ts`、`security/workspace.ts`、`interactions.ts`、`main.ts` | 错误映射；目录 400；abort→204；`reason:"TIMEOUT"`；配置环境变量；`content`+`text` 双写；`model` 可选 | 契约测试补齐并通过 | Sonnet |
| CR-15 | S12+S16+S17+Q6 | `process-host.ts`、`main.ts`、`scripts/doctor.mjs` | 环境白名单补齐；stderr 环形缓冲；启动 Session 0 检查；`job-helper-smoke` | doctor 在 Windows 输出 helper 冒烟结果 | Sonnet |
| CR-16 | D2+D4 | `config/release-profile.json`、`docs/spec/*`、`INSTRUCTION.md` | 并发 2；`optionalEngines`；文档口径统一 | `release:check` 逻辑与文档一致 | Sonnet |
| CR-17 | D3+W2 | `docs/spec/contracts.md`、`ownership.json`、`work-packages.md`、`code/assets/packs/README.md` | Capability Pack 定义与目录；新增 A08/B08/C07/C08 工作包 | 三方确认 | Fable 定稿 + Haiku 格式化 |
| CR-18 | Q10+Q11 | `verification/*`、`scripts/package-solution.mjs` | 刷新证据；生成 `solution/{INSTRUCTION.md, code/}` | 干净目录解压后按 INSTRUCTION 启动 | Sonnet |

CR-01/02、CR-07/08/09 各合并为一次 Opus 运行，其余每条一次 Sonnet 运行；总计约 5 次 Opus、11 次 Sonnet。

---

## 8. A 线执行顺序（用户本人）

1. **第 1 天**：CR-01/02（Opus 一次）、CR-03/05/06（Sonnet 三次）。本机 Linux 即可验证：mock 引擎 20 session 连跑、stuck 后不 503、SSE 大帧不断流。
2. **第 2 天**：CR-07/08/09（Opus 一次）、CR-04/10/11（Sonnet 三次）。需要一台 Windows 10/11 验证 helper 冒烟与 kill 后重启；没有 Windows 前先合入 Linux 可验的部分。
3. **第 3 天**：CR-12/13/14/15（Sonnet 四次 + CR-12 Opus 一次）；B 复审；刷新 `verification/*`；M0 退出。
4. **第 4–5 天**：A01–A03（Opus 一次做 Driver 状态机与映射，Sonnet 一次补 FakeHost 与全部单测：ACK、取消不响应、晚到更新、未知 tool id、长度截断、原生恢复失败、模型修改限制、进程退出）。全程 Linux。
5. **第 6–7 天**：A04 OpenCode Pack（Sonnet）：探明 Windows 分发形态、私有 `opencode.json`、`mcpServers` 投影、`XDG_*` 重定向；
   `PNP_INTEGRATION=configured` 指向 C 的脱敏夹具端点或任何已授权的 OpenAI 兼容端点做 Windows 冒烟。
6. **第 8 天**：`code/assets/packs/` 骨架 + 投影约定（Sonnet），让 B 的 Office 包与 C 的工具绑定有落点；用 `office_035` 类任务跑第一条端到端；M1 退出。
7. **第 9–14 天**：与 B/C 联调 10 条用例；A07 证据；CR-17 定稿；Hermes（A05）只在 M2 提前完成时启动。
8. **第 15 天起**：M3 收口、打包、内网验收。

每一步的交付用 `docs/team/handoff-template.md`，未验证项明确标 `not_run`；不为通过测试削弱取消、权限或持久化语义。

---

## 9. 附录：四份专项审查的出处

本文第 3 节的复现脚本、代码片段与逐行论证来自本次评审的四路独立审查（核心语义与存储；Windows 进程治理；文档与分工；ACP 可行性）。
它们的结论已全部并入上表；若实施时需要某条的修法原文，按 ID 在本节所对应的审查方向中查找即可。评审过程未修改 `engineering/` 任何文件。
