# G07 跨引擎真取消与真完成语义核验

## 摘要

赛题网关规范最硬的两条契约——`prompt_async` **必须阻塞到本轮完整结束**、`abort` **必须传播到底层 run**——在候选引擎的真实实现中都不是"打开开关即生效"的简单问题。本次调研对 opencode、pi、Hermes（NousResearch/hermes-agent）、dsh（deepseek-ai/deepseek-harness）、Goose（原 block/goose，现 aaif-goose/goose）五个引擎逐一核实了取消（abort/cancel/interrupt）与完成判定（finish/step-finish）的一手证据，结论是：**没有一个引擎在所有维度上做到"真取消"**，且"本轮真正结束"这一判定在异常路径（abort、compaction、并发插话）下普遍存在语义漂移，这直接决定了我们的网关不能把"调了 abort 接口"或"看到某个 finish 字段"当作可信的终态信号，必须在 EngineAdapter 层自建一套超时兜底 + 进程级强杀 + 状态机去抖动的保护层。

关键结论一句话版：opencode 的 abort 对 HTTP 客户端调用路径是真实的（会调用 `AbortController.abort()` 并对 shell 走 `forceKillAfter`），但存在多个已确认的边界 bug（fd 泄漏导致工具态永不收敛、Windows 下 abort 遗留悬空 tool_use、abort 后 finish 字段不置位）；pi 的 `abort` 是"模型流 + 工具"一起中止的强中断，`abort_bash` 是仅中止工具的弱中断，两者都有明确的完成事件区分；Hermes 顶层 `/v1/runs/{id}/stop` 已经是较完整的取消实现（`interrupt()` + `asyncio` 任务取消 + 5 秒超时兜底），但子任务 `delegate_task` 的 `stop` 是"下一个迭代边界"才生效的协作式取消，不是立即杀死；dsh 通过 ACP `session/cancel` 提供"real cancellation"，但 Windows 上 ConPTY 没有进程组，SIGINT 转发这条路径曾经整个失效，社区插件用"写 Ctrl-C 字节到 PTY 输入 + Job Object 杀树"打了补丁；Goose 的官方 `goosed` REST API 历史上**没有**任何取消/中断端点，取消只存在于桌面 UI 和 CLI 的交互层，官方正把整个 goosed 迁移到 ACP（`session/cancel` 是迁移目标而非已完工能力）。

## 关键事实

1. **【已确认】** opencode `packages/opencode/src/tool/shell.ts` 中 `detached: true` 启动 bash 子进程时，父进程仍持有 stdout 管道写端（fd 27），子进程退出后内核不会向读端（fd 25）投递 EOF，导致 shell 工具的 `status` 永远停在 `running`，Agent 会话被"挂死"而非报错。该问题记为 issue #29294，2026-05-26 提交，**已被维护者关闭为 "not planned"**，无修复 PR。来源：https://github.com/anomalyco/opencode/issues/29294
2. **【已确认】** opencode issue #21489（"Windows: aborted bash tool call can leave a dangling tool_use without tool_result and corrupt the session"）：在 Windows 上中止一个长内联 shell 命令（尤其是内嵌脚本文本的 `python -c` / `powershell.exe -Command`）后，assistant 消息中会残留没有配对 `tool_result` 的 `tool_use` 块，导致后续所有请求被 Anthropic API 以 "tool_use ids were found without tool_result blocks" 拒绝，会话永久损坏。标签 `bug`/`core`/`windows`，2026-04-08 提交，**状态为 Closed，但未见明确的修复 PR 或 commit 链接**，修复状态存疑。来源：https://github.com/anomalyco/opencode/issues/21489
3. **【已确认】** opencode issue #11527（"OpenCode leaves an orphaned process when it itself is killed"）：opencode 派生的子进程会主动"脱离父进程"（deparent，PPID 变为 1），当 opencode 主进程本身被按 PID 杀死时，脱离后的子进程不会跟着退出，尤其影响通过 Bun `spawn` API 编程式驱动 opencode 的场景（这正是我们网关的驱动方式）。2026-01-31 提交，标签 `bug`，**Closed，但内容中未见修复确认**。来源：https://github.com/anomalyco/opencode/issues/11527
4. **【已确认，历史背景】** sst/opencode（opencode 早期上游仓库）issue #2124 是 2025-08-20 提出的功能请求"允许中止正在执行的 bash 命令而不退出整个程序"，当时对比 Cursor 有此能力而 Claude Code 没有。**Closed**，无技术细节、无关联 PR，可视为当前 abort 功能的历史起点而非现状证据。来源：https://github.com/sst/opencode/issues/2124
5. **【已确认，关键】** opencode issue #29894："当 opencode 以服务器模式运行、由外部通过 SDK/HTTP 驱动时，插件内 `ctx.client.session.abort()` 会静默 no-op。" 根本原因是 opencode 内部按 `Instance.state()`（进程内实例状态）存取 `AbortController`，而插件的 `ctx.client` 走的是另一个懒加载的 `Server.Default()` 实例，`cancel()` 解析到的是**不同的** `Instance.state()`，找不到对应 session 的 controller，于是只把 `session.status` 翻成 idle 却从未真正调用 `match.abort.abort()`。**该问题被明确限定为"仅影响插件 `ctx.client` 这条路径"，直接通过原生 HTTP `/session/{id}/abort` 端点调用不受影响**——这对我们的网关（走裸 HTTP）是好消息，但说明 opencode 内部对"谁在调用 abort"高度敏感，不能想当然认为所有"看起来等价"的调用路径行为一致。来源：https://github.com/anomalyco/opencode/issues/29894
6. **【已确认，关键】** opencode issue #33687："被中断的 assistant 消息保留非 error 的 finish 值"。当 LLM 流在 `tool-input-start` 之后、完成之前被中断时，`processor.ts` 的 `halt()` 函数在通用终止错误分支里只记录了 error 对象，**却没有把 `assistantMessage.finish` 置为 `"error"`**（只有 `ContextOverflowError` 这一条特殊路径做对了），导致 `finish` 停留在 `undefined` 或中断前的旧值。下游消费者据此可能误判"仍在进行中"或"已成功完成"。2026-06-24 提交，**Closed as not planned**。来源：https://github.com/anomalyco/opencode/issues/33687
7. **【已确认】** opencode issue #21388（"Allow messages to be sent mid-turn"）明确写出当前默认行为：用户在 turn 进行中发送的新消息，要么"静默排队，在当前 turn 结束后作为新 turn 投递"，要么"在某些 UI 状态下被直接丢弃"，且**用户得不到任何关于消息去向的反馈**；issue #32157（"Configurable mid-run prompt delivery"，仍 **Open**，标签 `2.0`）在此基础上提出 `queue`/`steer`/`break` 三种模式区分，并指出如果把 steer 消息当独立 turn 处理会破坏 compaction 的摘要依赖关系。来源：https://github.com/anomalyco/opencode/issues/21388 、 https://github.com/anomalyco/opencode/issues/32157
8. **【已确认】** pi-mono（badlogic/pi-mono，`packages/coding-agent`）RPC 协议中 `abort` 命令会同时终止模型 API 流和正在进行的工具/bash 执行，并等待 session 回到 idle 才返回 `{"type":"response","command":"abort","success":true}`；而 `abort_bash` 只针对 bash 工具，返回体里 bash 结果会带 `"cancelled": true` 字段与正常完成区分。当在流式输出期间发送新 prompt 且未显式指定 `streamingBehavior`（`"steer"` 排队接入当前 turn 或 `"followUp"` 等待完成后处理）时，**协议直接返回错误**——这是本次调研中唯一一个"显式拒绝而非静默丢弃/排队"的设计。来源：https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md
9. **【已确认】** Hermes Agent（NousResearch/hermes-agent）v0.21.0 "Pantheon"（2026-08-31）为 `delegate_task` 增加 `steer`/`stop`/`list` 控制动作：`stop` 的语义是"在子任务的下一个迭代边界结束它，部分结果仍作为正常完成消息重新进入对话"——即**协作式、非立即杀死**的取消；顶层运行的取消走独立的 REST 端点 `POST /v1/runs/{run_id}/stop`（PR #15842，2026-04-26 合并），其实现调用 `agent.interrupt()` 唤醒运行在 executor 线程里的 `run_conversation()` 循环，再 `cancel()` asyncio 任务，并用 `asyncio.wait_for(shield(task), 5.0)` 兜底超时，PR 中明确写道 **"`task.cancel()` 无法抢占运行 `run_conversation()` 的 `run_in_executor` 线程，所以必须依赖 `agent.interrupt()` 唤醒循环"**——本质上仍是"轮询式/协作式中断"而非真正的抢占式流终止；PR 内容未提及是否会清理已发起的子进程工具调用。来源：https://github.com/NousResearch/hermes-agent/pull/15842 、 https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
10. **【已确认】** deepseek-ai/deepseek-harness（dsh）通过 ACP（Agent Client Protocol）暴露 `session/cancel`，官方文档原文为 **"Real cancellation — `session/cancel` interrupts the live turn through the harness agent"**，强调这是"真取消"而非象征性状态翻转，但一手 README 未给出 AbortController 级别的实现细节或 Windows 特殊处理说明。来源：https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.md 、 https://github.com/openma-ai/deepseek-harness-acp
11. **【已确认，关键，Windows】** 社区技术文章《DeepSeek Harness as a Second-Class Citizen on Windows》指出：dsh 取消命令时原本会向 PTY 前台进程组发送 `SIGINT`，但 **Windows 没有 POSIX 进程组概念，这一步会直接抛异常，被上层误判为传输层失败，进而打断整个会话**；正确做法（遵循 ConPTY 约定）是把 Ctrl-C 作为键盘输入字节写入 PTY，而不是当作信号发送。社区 `dsh-win32` 插件用 `ProcessInspector`（基于 CIM 枚举进程树 + `taskkill` 投递信号）和"从 ConPTY 控制台进程列表而非父子链解析前台进程"（因为 Git Bash/MSYS 的 fork 模拟会打断父子链）来修补这一整套问题；`dsh_desktop`（Tauri 2）额外用 **Windows Job Object 做进程树级联回收（"杀树"）**。来源：https://zenn.dev/sjh9714/articles/e557ea111ab305 、 https://github.com/myYangyunfan/dsh_desktop
12. **【已确认，关键】** Goose（aaif-goose/goose，原 block/goose）的官方 `goosed` REST+SSE API（约 103 个端点）**历史上没有任何取消/中断/停止端点**：issue #7225（"CLI-via-goosed: add missing goosed API endpoints"）列出了当时缺失/待补的端点（`/config/prompts`、`/agent/provider_info`、`/agent/plan_prompt`、`/sessions/*`），**其中不包含也未讨论 cancel/interrupt**，该 issue 已 Closed as not planned；官方文档中"中断任务"仅描述为桌面 UI（点击 Send 或输入 "stop/pause/cancel" 等关键词）与 CLI（`Ctrl+C`）交互行为，未提供可编程/无头模式的取消方式。Goose 官方正在推进 issue #6642（"project: goosed to ACP-over-HTTP"，2026-01-22 提交，Closed，标签 `needs_human`）——四阶段计划用标准 ACP 协议替换自研 SSE API，规范文本中列出 `session/cancel — Cancel in-progress prompt` 为客户端可发送的通知类型，**但该 issue 内容未给出该能力在无头（headless）运行下的落地时间与实现细节**，即"Goose 的真取消"目前更接近路线图而非已交付的稳定契约。来源：https://github.com/aaif-goose/goose/issues/7225 、 https://github.com/aaif-goose/goose/issues/6642 、 https://goose-docs.ai/docs/guides/sessions/in-session-actions/

## 详细分析

### 1. opencode：HTTP 路径的 abort 是"真"的，但完成态与子进程清理有结构性漏洞

综合源码级检索结果（`packages/opencode/src/session/prompt.ts`，经网页摘要工具二次提炼、**未逐行人工核验**，故标记为中等置信度）：opencode 在 `start(sessionID)` 时创建 `AbortController` 并存入 `Instance.state()`，`AbortSignal` 会被穿透到 `LLM.stream`、工具执行与子任务（`handleSubtask` 中新建的 `taskAbort`）。对于 shell 工具，中止时走 Effect 的 `Effect.onInterrupt(...)`，并配置 `forceKillAfter: '3 seconds'`——也就是说，SIGTERM 之后 3 秒还没退出会被强杀，这本身是合理设计。但三个已确认的开放/存疑问题叠加在一起，构成了对我们网关的真实风险：

- fd 泄漏（#29294）导致的是"进程已经退出但工具状态永远不收敛"，这与"用户主动 abort"是两回事，但后果相同——都会让 `prompt_async` 的阻塞 HTTP 调用永远不返回，是网关必须设超时熔断的直接证据；
- Windows 下 abort 后 `tool_use` 无 `tool_result`（#21489）与"finish 字段未回写 error"（#33687）两个问题同源：opencode 的中断处理在"该给这条消息盖什么终态戳"这件事上并不严谨，网关如果只信任 `finish=stop` 这一个信号来判定完成、信任 `finish!=undefined` 来判定"不是被打断的"，会被这两个 bug 直接击穿；
- #11527 说明如果网关将来需要"进程级兜底强杀"（例如 abort 后一段时间仍未 idle，直接杀 opencode 进程本身），必须知道 opencode 子进程会主动 deparent，**单纯杀父进程 PID 不能保证子进程一起死**，Windows/POSIX 都需要显式的进程组/Job Object 级联终止而非依赖父子关系。

opencode issue #29894 反而是一个"好消息但有陷阱"的发现：它证明**裸 HTTP `/session/{id}/abort` 端点本身是可信的**（问题只出在 opencode 自己的插件 SDK 客户端路径），但同时也提示我们：opencode 内部对"实例（Instance）"边界极其敏感，如果我们的 EngineAdapter 未来选择以 SDK/内嵌方式而非纯 HTTP 方式驱动 opencode（例如为了性能把 opencode 作为库直接 import），必须重新验证 abort 是否仍然生效，不能想当然复用"HTTP 模式下测试通过"的结论。

### 2. pi：目前调研到的最"诚实"的取消协议设计

pi 是本次调研里少数明确区分"强/弱中断"并给出**显式并发插话拒绝**语义的引擎：`abort` 杀模型流+工具，`abort_bash` 只杀工具（细粒度控制，适合"我只是想打断这条命令，不想丢掉本轮对话进度"的场景）；更重要的是，pi 在"流式期间收到新 prompt 且未声明 `streamingBehavior`"时**直接返回协议错误**，把决策权显式交还给调用方（steer 排队接入 vs followUp 等待），而不是像 opencode 那样"静默排队或丢弃、用户毫无感知"。这对我们网关设计 `busy` 状态下收到第二个 `prompt_async` 请求时该怎么办，是一个可直接借鉴的模式：**宁可显式 409/EARLY_BUSY 报错，也不要静默吞掉或排队却不告知调用方**。

pi 的 session 是树状结构（每条消息/工具调用/模型切换/compaction 都是带 parent 指针的节点，`docs/compaction.md` 证实），支持 `--fork` 与分支摘要（`BranchSummaryEntry`）。但一手文档明确未回答"外部客户端如何判定某个分支/某轮的真正终点"这一问题（compaction.md 页面本身承认只讲"何时触发压缩"，不讲"如何对外暴露完成信号"），这意味着**如果我们要把 pi 接入网关的 `finish=stop` 语义，必须去读 `session-manager.ts` 与 extension 事件类型源码，不能只靠公开文档**——这是一个明确的未解决问题，留待 D 类（源码级）调研补充。

### 3. Hermes：分层清楚，但子任务取消是"协作式"，顶层取消也有"抢占失败"的已知补丁

Hermes 的架构对我们最有参考价值的地方是**取消粒度的分层设计**：顶层 `/v1/runs/{run_id}/stop`（独立 REST 端点，PR #15842）与子任务 `delegate_task(action="stop")`（模型可调用的工具级控制）是两套机制，作用范围不同。但两者都不是真正的"抢占式"杀死：

- 顶层 stop 的实现证据本身就写明了局限——`run_conversation()` 跑在 `run_in_executor` 线程里，asyncio 的 `task.cancel()` 打不进去，只能靠 `agent.interrupt()`（本质是一个协作式标志位，模型循环要在自己检查点主动查询）"唤醒"，并用 5 秒超时防止 handler 挂死。这与 kenhuangus 的技术文章对 Hermes"轮询式中断（poll model，thread-scoped interrupt flags，工具在每次迭代主动检查 `is_interrupted()`）"的描述一致，构成两个独立信息源互相印证；
- 子任务 `delegate_task` 的 `stop` 明确写"在下一个迭代边界结束"，即工具调用中途不会被腰斩，只是不会开始下一轮——这与 opencode 的"steer 不打断正在运行的 tool call"（来自 OpenClaw 项目文档对同类语义的描述）是同一类设计取舍，说明"协作式取消 + 迭代边界生效"在开源 agent 生态里是主流做法，真正的"流式连接级强制掐断"反而是少数派（Claude Code 的 AbortController 树是本次调研中唯一被明确证实做到"push 式、瞬时广播"的实现，来自 kenhuangus 文章对比，但该文章不是 Anthropic 官方一手资料，需要单独找 Claude Code 官方文档核实，本报告不把它算作已确认的第三方引擎证据）。

### 4. dsh：ACP 协议层"真取消"的宣称 vs Windows 平台现实的落差

dsh 官方文档用"Real cancellation"这个措辞直接回应了本专题的核心质疑，这是候选引擎里**唯一在文档中明确做出这种强承诺**的。但一手证据链条到"跨平台是否真的做到"这一步就出现了断层：`deepseek-harness-acp` 仓库本身的 README 承认没有说明 AbortController/Windows 细节，需要去 `src/bridge/`、`src/harness.ts` 或上游 `@deepseek-ai/deepseek-harness` 包源码验证；而独立的中文技术文章（zenn.dev）证实了 **Windows 上 SIGINT 转发链路曾经是完全断裂的**（因为 Windows 没有进程组，`SIGINT` 发送直接抛异常，被上层误判为"传输层失败"从而打断整条会话，而不是优雅取消），修复靠的是社区插件而非官方内置——这与我们赛题"评测环境是 Windows 10/11"的约束高度相关：**如果直接使用 dsh 官方 Windows 支持，"取消"这个动作本身有可能触发比"什么都不做"更糟糕的结果（整个会话传输层被打断）**，必须复现验证或引入等价的 dsh-win32 式补丁（Ctrl-C 字节注入 PTY + CIM 进程树枚举 + taskkill 信号投递 + Job Object 杀树）。

### 5. Goose：取消能力目前基本等同于"没有可编程契约"

这是本轮调研里对我们决策影响最大的负面结论：Goose 官方 REST API（`goosed`，103 个端点）**从未包含取消/中断端点**，issue #7225 列出的"待补端点清单"里根本不存在 cancel/stop/interrupt 这一类；官方"中断任务"文档描述的完全是终端交互层行为（桌面点 Send、CLI 按 Ctrl+C），不是无头模式下可编程调用的契约。虽然 Goose 官方已经启动"迁移到 ACP-over-HTTP"的四阶段计划（issue #6642），规范草案里写了 `session/cancel` 这个通知类型，但该 issue 只是路线图 issue，**没有实现完成的证据、没有时间线**。这意味着，如果我们把 Goose 作为候选引擎之一接入，**"网关 abort 端点是否能真正传播到 Goose 底层 run"这件事目前在事实层面近似无解**——除非我们自己实现"杀 goosed 进程 + 用 Windows Job Object 兜底"这种进程级强杀作为唯一可靠的取消手段，而不能依赖 Goose 提供任何 HTTP 级"优雅取消"承诺。

### 6. "流式中插话"的跨引擎默认行为对照表（均为一手资料摘录）

| 引擎 | 默认行为 | 是否需要显式声明 | 一手来源 |
|---|---|---|---|
| opencode | 静默排队为下一 turn，或在某些 UI 状态下直接丢弃，用户无反馈（issue #21388 承认为现状问题） | 否，且这正是被抱怨的点 | #21388 |
| pi | 若未指定 `streamingBehavior` 直接报协议错误；显式声明后 `steer`（接入当前 turn）或 `followUp`（排队等待） | 是，强制显式 | rpc.md |
| Hermes（delegate_task 子任务） | `steer` 在下一迭代边界注入而不打断已运行的工具调用；`stop` 同理在边界生效 | 否，两者都是可调用的独立动作 | delegation docs |
| Hermes（顶层 /v1/runs） | 文档未描述"插话"语义，只有独立的 `POST /v1/runs/{id}/stop` 取消整个 run，没有"排队追加"这一层 | 未说明 | api-server docs、PR #15842 |
| Goose（Desktop） | 点击 Send 立即打断当前任务；按 Enter 或输入 stop/pause 类关键词则排队 | 否 | in-session-actions 文档 |
| Goose（CLI） | 无排队能力，只能 `Ctrl+C` 中断后手动重新输入 | 否 | in-session-actions 文档 |

这张表直接说明：**"assistant 仍在流式输出时用户发消息"没有任何跨引擎统一默认值**，网关如果想要一致体验，只有两个可行方案——要么在网关层面统一实现"busy 时新 prompt 一律显式拒绝（409/BUSY），调用方决定是否先 abort 再重试"（本次评测契约里 session 只有 idle/busy 两态，这也是与赛题基线最贴合的做法），要么为每个引擎单独适配其原生排队/steer 参数并在 EngineAdapter 内部吸收差异，向上层网关只暴露"排队成功/失败"两种结果。鉴于赛题不要求热切换、且"prompt_async 阻塞到本轮结束"，**"网关层强制拒绝"是复杂度更低、风险更小的选择**。

### 7. "本轮真正结束"判定的脆弱性

opencode 的 `finish` 枚举目前一手证据能确认的取值至少包括 `stop`（自然文本结束）、`tool-calls`（还要继续工具循环）、`length`（截断）、`error`（终止错误）——本次调研通过公开 issue 交叉验证到 4-5 个值，未能拿到官方"6 值完整枚举"的权威源码级列表（原始调研线索提到 6 值，但一手抓取只坐实其中一部分，需要标注为**未完全确认**，见"未解决问题"）；更关键的是 #33687 证明**中断路径存在遗漏把 `finish` 置为 `error`/等价终态的 bug**，即"finish 字段本身有时不可信"。

pi 的树状结构下，compaction 会在"工具结果 append 之后、下一个 assistant 响应开始之前"检查是否需要压缩（compaction.md 原文），但如果"工具批次刚好终结了整个 run 且没有排队消息需要响应"，会跳过 between-turn 检查——这说明 pi 内部有一条隐式规则区分"这批工具调用之后到底还继不继续"，但一手文档没有把这条规则暴露为客户端可观察的事件，我们如果要在 pi 上准确判定"本轮真正结束"，**必须依赖 pi 的 `agent_end`/`agent_settled` 事件对（RPC 文档证实存在这两个事件，但未证实其在 compaction 场景下的精确触发顺序），而不能靠猜测某个 step-finish 类字段**。

综合来看，**没有一个引擎的"最终完成"信号是绝对可信的单一字段**；稳妥做法是网关层用"事件流到达约定的终态事件（如 `agent_end`+session 转回 idle，或 SSE 的 `session.idle`）+ HTTP 阻塞调用返回"的**双重确认**，而不是只解析消息体里某个 finish/step-finish 字段。

### 8. Windows 子进程真杀 与 COM 自动化进程残留

赛题用例大量涉及 Word/Excel/PPT 操作，如果引擎是通过命令行调用 COM 自动化（PowerShell + `New-Object -ComObject Word.Application` 或类似 Office 自动化桥）来完成任务，取消一个引擎子进程时，**普通的单进程 kill（甚至 `taskkill /PID` 不带 `/T`）不会杀死其派生的 WINWORD.EXE/EXCEL.EXE 进程**，这些 Office 进程通常也不会随父进程退出而自动关闭（尤其在自动化场景下 COM 对象未被正确 `Quit()`/`Release`，或父进程是被强杀而非正常退出时）。本次调研确认的两条独立证据都指向同一结论：

- Microsoft 官方文档：`taskkill /T /F` 会终止指定进程及其**由它启动的**子进程树，但这依赖 Windows 记录的父子关系，**deparent（如 opencode #11527 描述的子进程主动脱离）会让 `/T` 失效**；
- Windows Job Object：进程被关联到 Job 后，其后续用 `CreateProcess` 创建的子进程默认也会被自动关联进同一个 Job，调用 `TerminateJobObject` 可以保证**整个 Job 内所有进程被内核级联终止，不依赖父子链是否完整**，这正是 dsh 社区插件（`dsh_desktop`）与本次未直接核实但业界公认的沙箱级子进程管理最佳实践。

结论：**网关/EngineAdapter 在 Windows 上启动每个引擎子进程时，必须显式创建并关联 Job Object（`CreateJobObject` + `AssignProcessToJobObject`，并设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），才能保证 abort/超时兜底/进程退出时，引擎派生的所有子进程（包括其再派生的 Office COM 自动化进程）被无条件回收**；单纯依赖 `taskkill /T /F` 或者信任引擎自身的清理逻辑，在遇到 deparent、fd 泄漏、协作式取消不生效等已知问题时都可能留下常驻的 WINWORD.EXE/EXCEL.EXE/POWERPNT.EXE 僵尸进程，污染评测沙箱环境甚至导致下一个用例因为文件被占用而失败。

## 对我们架构的启示

1. **EngineAdapter 必须自带"取消不可信"假设，做三层兜底**：① 调用引擎原生 abort/cancel/stop 接口（相信但不完全依赖）；② 设置一个总超时（例如 SSE `session.idle`/HTTP 返回都未在 N 秒内出现），超时后进入"强制层"；③ 强制层不是杀引擎子进程，而是**杀整个 Job Object**（Windows）或进程组（POSIX），因为 opencode（#11527 deparent）、dsh（Windows SIGINT 转发失效）、Goose（压根没有取消端点）都证明"信任引擎自己清理干净"是不成立的假设。这一条应作为 EngineAdapter 接口契约里的强制实现项，而不是可选优化。
2. **网关层必须做"完成态双重确认"而非单信号判定**：不能只用响应体里某个 `finish`/`step-finish` 字段来判定"这轮真的结束了"（opencode #33687 证明该字段在异常路径下可能不置位或语义漂移；pi 的 compaction 场景下"哪个 step-finish 是本轮终点"依赖内部隐式规则）。推荐规则：**HTTP 阻塞调用返回 + SSE 侧观察到会话状态转回 idle（或等价的 `agent_end`/`agent_settled`）两者同时满足，才认定"本轮真正结束"**；单独出现任一信号都应视为"未决"，并给一个短暂的宽限期去等另一个信号，超时则记为"结束但状态存疑"，写入可观测日志供事后审计（而不是让评测流程卡死）。
3. **"busy 时新消息如何处理"不要跟随任何单一引擎的默认行为，而由网关统一裁决为显式拒绝**：六个候选引擎（含子分类）里没有两个行为完全一致（表格见上），且多个引擎的默认行为（静默排队/丢弃）本身被其社区认定为缺陷（opencode #21388）。网关应该在 `busy` 状态下对新的 `prompt_async` 请求直接返回 409/`SESSION_BUSY` 错误，把"是否要 abort 当前轮再发"的决策权交给调用方（评测框架），这既符合赛题"session 只有 idle/busy 两态"的基线设计，也规避了逐引擎适配 steer/followUp/queue 语义的复杂度和不确定性。
4. **接入新引擎的标准流程必须包含一份"取消/完成语义核验清单"，作为验收 gate**，而不能只测"正常路径跑通"。清单至少应包含：(a) 发起一个长时间工具调用后立即 abort，验证子进程真的被杀死（用 `Get-Process`/`tasklist` 在 Windows 上核实，而不是只看 HTTP 状态码）；(b) 验证 abort 后残留的 tool_use/tool_result 是否配对，是否会导致下一轮请求被上游 LLM API 拒绝（这是 opencode 反复出现的一类 bug 的根因）；(c) 在流式输出中发第二个 prompt，验证网关的"busy 拒绝"策略是否被正确执行而不是被引擎自己的排队逻辑绕过；(d) Windows 专项：杀掉引擎子进程后检查是否有残留的 WINWORD.EXE/EXCEL.EXE/POWERPNT.EXE。这份清单应该沉淀为自动化回归测试，而不是人工一次性验证，因为本次调研证明这些问题在引擎版本演进中会反复出现、修复、又在别的路径上复现（如 opencode 的多个相似 issue：#21326/#8312/#755(fork)/#21489/#33687 本质上是同一类"中断路径遗漏终态处理"问题的不同变种）。
5. **不要把任何引擎文档里"Real cancellation"这类营销式措辞当作已验证的工程事实**：dsh 官方文档明确写"Real cancellation"，但一手证据显示其 Windows 路径历史上曾经彻底失效（SIGINT 转发到无进程组的 Windows 直接抛异常并打断整个会话），修复来自社区插件而非确认过的官方内置能力。这提示我们在选择"至少接入 2 种 Harness"时，**必须亲自在目标评测环境（Windows 10/11 沙箱）里实测取消路径，而不能仅凭官方文档的措辞或 GitHub Star 数做选型决策**。
6. **子任务/子 Agent 级别的"stop"与顶层 run 级别的"abort"应该在我们的统一模型里显式区分为两种不同强度的操作**（借鉴 Hermes 的 `delegate_task(stop)` vs `/v1/runs/{id}/stop` 分层，以及 pi 的 `abort` vs `abort_bash` 分层）：`GatewayRun.abort()`（面向评测契约，语义等价"立即终止本轮，尽力清理"）与内部可选的 `EngineAdapter.softStop()`（协作式，等到下一个安全边界），后者只作为前者失败超时后的第一层重试手段，绝不能替代进程级强杀作为最终保障。

## 未解决问题

1. opencode 官方文档/源码中"6 值 finish 枚举"的完整权威列表未能从公开 issue 交叉验证齐全（本次只坐实 `stop`/`tool-calls`/`length`/`error`，`unknown` 存疑，第 6 个值未找到），需要直接抓取 opencode 的 TypeScript 类型定义源文件（如 `packages/opencode/src/session/message-v2.ts` 或类似路径）做逐行核验。
2. pi 的 `agent_end`/`agent_settled` 两个事件在"compaction 恰好发生在工具批次结束时"这一边界场景下的精确触发顺序和先后关系，一手文档（rpc.md、compaction.md）均未覆盖，需要读 `session-manager.ts` 或搭建最小复现环境实测。
3. dsh 官方 `session/cancel` 是否已经内置了 zenn.dev 文章描述的 Windows 修复（Ctrl-C 字节注入 PTY + Job Object 杀树），还是仍然依赖社区 `dsh-win32` 插件——README 与 ACP 仓库均未明确说明该修复是否已合并进官方主线，需要直接查 `deepseek-ai/deepseek-harness` 的 changelog/release notes 或 Windows 平台专项 issue。
4. Hermes 顶层 `/v1/runs/{id}/stop` 是否会清理已经由该 run 发起、仍在运行的工具子进程（例如一个正在跑的 shell 命令），PR #15842 的可见内容未提及，需要读 `agent.interrupt()` 的具体实现或工具执行框架的中断钩子代码。
5. Goose 的 ACP-over-HTTP 迁移（issue #6642）目前的真实进度、`session/cancel` 是否已在任何发布版本中可用，需要查最新 Release Notes 或直接对一个自建的 goosed/ACP 实例做行为探测（本次调研环境未能实际起一个 Goose 实例做黑盒测试）。
6. Windows Job Object 方案在"引擎本身以非管理员权限运行、且需要跨用户会话联动 Office COM 自动化"这类受限沙箱环境下是否有额外的权限/兼容性限制（例如评测沙箱本身是否允许创建 Job Object），未在本次调研中核实，需要在实际评测环境或等价 Windows 10/11 沙箱中做权限探测实验。

## 来源列表

- opencode issue #29294（shell 工具 fd 泄漏导致 status 不收敛）: https://github.com/anomalyco/opencode/issues/29294
- opencode issue #21489（Windows abort 后悬空 tool_use）: https://github.com/anomalyco/opencode/issues/21489
- opencode issue #11527（opencode 被杀后子进程 deparent 残留）: https://github.com/anomalyco/opencode/issues/11527
- sst/opencode issue #2124（历史功能请求：中止 bash 命令）: https://github.com/sst/opencode/issues/2124
- opencode issue #21326（中断的 tool call 永久破坏 session）: https://github.com/anomalyco/opencode/issues/21326
- opencode issue #8312（工具执行中止导致 session 损坏）: https://github.com/anomalyco/opencode/issues/8312
- opencode issue #29894（server+SDK 模式下 session.abort 静默 no-op）: https://github.com/anomalyco/opencode/issues/29894
- opencode issue #33687（中断消息未回写 finish=error）: https://github.com/anomalyco/opencode/issues/33687
- opencode issue #21388（流式中插话默认行为：静默排队/丢弃）: https://github.com/anomalyco/opencode/issues/21388
- opencode issue #32157（compaction-aware steer 语义提案）: https://github.com/anomalyco/opencode/issues/32157
- opencode 源码 prompt.ts（AbortController/forceKillAfter，经网页摘要提炼）: https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts
- pi-mono RPC 协议文档（abort/abort_bash/streamingBehavior）: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md
- pi-mono compaction 文档（树状 session、分支摘要）: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md
- Hermes Agent 委派功能文档（steer/stop/list）: https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- Hermes Agent API Server 文档: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- Hermes Agent PR #15842（POST /v1/runs/{id}/stop 实现）: https://github.com/NousResearch/hermes-agent/pull/15842
- deepseek-harness core/session README（"Real cancellation"）: https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.md
- deepseek-harness-acp（第三方 ACP 服务端实现）: https://github.com/openma-ai/deepseek-harness-acp
- 《DeepSeek Harness as a Second-Class Citizen on Windows》技术文章: https://zenn.dev/sjh9714/articles/e557ea111ab305
- dsh_desktop（Tauri 2，Job Object 杀树）: https://github.com/myYangyunfan/dsh_desktop
- goose issue #7225（goosed 缺失端点清单，不含 cancel）: https://github.com/aaif-goose/goose/issues/7225
- goose issue #6642（goosed 迁移到 ACP-over-HTTP，含 session/cancel 规划）: https://github.com/aaif-goose/goose/issues/6642
- goose 官方文档 In-Session Actions（交互式中断，非编程接口）: https://goose-docs.ai/docs/guides/sessions/in-session-actions/
- Chapter 2: Cancellation & Abort Propagation（Claude Code vs Hermes 对比文章）: https://kenhuangus.substack.com/p/chapter-2-cancellation-and-abort
- OpenClaw 文档：Steering Queue（同类协作式取消/插话设计参考）: https://docs.openclaw.ai/concepts/queue-steering
- Microsoft Learn: taskkill 命令参考: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill
- Microsoft Learn: Job Objects（Win32 进程管理）: https://learn.microsoft.com/nl-nl/windows/win32/procthread/job-objects
- 仓库内部基线文档（本团队既有资料）: /home/user/PNP/docs/gateway-api-baseline.md
