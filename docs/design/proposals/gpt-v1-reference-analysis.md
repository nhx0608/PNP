# 参考方案 X：GPT 版《PnP 多 Agent 引擎可替换架构设计与详细实现方案》

> 来源：团队成员用 GPT 产出，2026-09-05 由用户提供作为参考。
> 状态：**参考输入，不是结论**。下方"主控对照分析"是我方基于 33 份一手调研对它的评估，综合稿必须处理其中每一条。

---

## 一、原文要点（浓缩，保留其结构与命名）

**定位**：PnP Agent Fabric — Plug Any Engine, Play Every Agent。向上提供稳定统一的 Agent Gateway 接口，向下通过 ACP / Native SDK / JSONL-RPC / HTTP 四类 Driver 连接不同 Harness。

**六个目标**：Gateway 与 Harness 解耦；新增引擎不改 Gateway Core；支持异构接入方式；公共能力统一而原生能力不降级；模型与 Harness 解耦；执行行为可观测可比较可验证。

**设计原则**
- Gateway Stable, Engine Replaceable：换引擎不改 HTTP API / Session ID / SSE / Workspace 语义 / Message 模型 / Error Model。
- Standard First, Native When Needed：南向优先级 ACP → Native SDK → JSONL/RPC → HTTP。
- Common Contract + Native Extensions，能力分三层：
  - L1 基础公共能力（所有 Engine Pack 必须支持）：`engine.lifecycle`、`session.create`、`session.delete`、`prompt.execute`、`prompt.cancel`、`message.query`、`event.subscribe`、`workspace.bind`、`model.bind`
  - L2 标准扩展：mcp、tools、skills、hooks、memory、subagents、computer-use、browser、structured-output、session-resume、session-fork
  - L3 Harness 原生扩展：`opencode.*`、`pi.*`、`hermes.*`、`goose.*`、`dsh.*`
- Capability Negotiation：Engine Pack 声明能力，Gateway 据此决定直接使用 / Adapter 转换 / 不可用 / Native Extension 暴露。

**七层架构**：① Northbound Gateway Protocol ② Canonical Gateway Core（Session Registry / Run State Machine / Message Store / Event Bus / Workspace Manager / Permission Policy / Cancellation Controller / Model Profile）③ Engine Fabric（Engine Registry / Pack Loader / Capability Negotiation / Supervisor / Lifecycle Manager / Health & Recovery / Session Mapping）④ Southbound Drivers（ACP / Native SDK / JSONL-RPC / HTTP）⑤ Engine Packs ⑥ Capability & Asset Federation ⑦ Observability & Conformance。

**技术栈**：TypeScript + Node.js LTS + Fastify + TypeBox + Pino + Vitest + child_process + YAML 配置；各 Harness 跑在独立 Engine Host 进程里，Gateway 不依赖 Harness 内部语言。

**核心数据模型**：`GatewaySession`（id / directory / engineId / nativeSessionId / engineHostId / status / activeRunId）、`GatewayRun`（created→running→cancelling→completed/failed/cancelled，北向只暴露 idle/busy）、`CanonicalMessage`、`EngineEventEnvelope`（canonicalType + nativeType + canonicalPayload + nativePayload + sequence）。

**EngineDriver 统一接口**：`start / stop / health / getCapabilities / createSession / prompt / cancel / deleteSession / subscribe`。

**Engine Pack 声明式接入**：`engine-packs/{id}/` 含 engine.yaml、launcher、event-mapper、model-renderer、asset-adapter、health-check、native-extension。ACP 引擎接入时 Gateway Core 与 Generic ACP Driver 改动为 0。

**完成语义**（固定十步）：Engine Prompt 完成 → Tool Call 全部结束 → Final Assistant Message 写入 → `info.finish = stop` → `step-finish` 写入 → Run completed → Session idle → `session.status idle` → `session.idle` → `prompt_async` HTTP 返回。

**Engine Conformance Kit**：E01–E20 二十项测试（可执行 / 启动 / 健康 / 能力协商 / 模型配置 / Session 创建 / Workspace 绑定 / Prompt / 流式 / 工具调用 / 最终消息 / 会话连续性 / 会话隔离 / 取消 / 错误映射 / 消息快照 / 关闭 / 进程清理 / Windows 原生执行 / 重复启动稳定性），输出兼容性报告。

**其他**：统一 Model Profile 按引擎渲染成原生配置；Workspace 规范化 Windows 路径；Permission/Question 统一为 PendingInteractionRegistry；Error Model 15 个错误码；敏感数据只走环境变量；明确禁止 `if task_id == "office_103"` 式硬编码。

---

## 二、主控对照分析（基于 `docs/research/` 33 份一手调研）

### 2.1 应当采纳的（这份方案做对的地方）

| 采纳项 | 理由 |
| --- | --- |
| **Engine Pack 声明式接入 + Gateway Core 零改动** | 与我方"接入第 3/4 个引擎的成本是架构核心指标"完全一致，且 `engine-packs/{id}/` 的目录约定比抽象接口更容易被 3 人团队执行。**直接采纳**。 |
| **Canonical Event 与 Raw Native Event 双写** | 与 T14 结论一致（内部 schema 稳定、导出层映射、raw 永远保留）；AG-UI 的 `RAW` 事件也是同样做法。**直接采纳**，并补上 T14 要求的"网关自打 sequence"（多数引擎不提供序号）。 |
| **北向只暴露 idle/busy，内部跑完整 Run 状态机** | 与赛题规范一致，且把 `cancelling` 这类中间态挡在北向之外是对的。**采纳**，但需补 G07 的取消兜底。 |
| **固定的十步完成语义** | 这是全文最有价值的一段：把"什么叫本轮结束"写成不可协商的顺序，正面回应了赛题最硬的契约。**采纳**，并补上 G04 的关键实现细节（见下）。 |
| **Engine Conformance Kit E01–E20** | 与 T23"声明与认证分离"、T06 UHP conformance class 一致，E18 进程清理与 E19 Windows 原生执行尤其切题。**采纳**，但要把 G07/G11 的失败模式补进用例。 |
| **统一 Model Profile 按引擎渲染** | 与 G02 结论一致（每引擎一份配置模板，网关只维护"代理地址 + 模板映射表"）。**采纳**。 |
| **禁止针对评测用例硬编码** | 与赛题 `evaluation-cases.md` §6 一致。**采纳并写进 CI 门禁**（grep 检查）。 |
| **敏感信息只走环境变量、Engine Host 只拿本引擎所需变量** | 与 T22 结论一致。**采纳**。 |

### 2.2 必须修正的事实性问题（调研已证伪或证据不足）

| 原文主张 | 调研证据 | 修正 |
| --- | --- | --- |
| "ACP 优先，一个 Generic ACP Driver 服务多个 Harness，接入 ACP 引擎改动为 0" | **G07**：Goose 的 `goosed` REST 历史上**没有任何取消端点**，ACP 是迁移目标而非已完工能力；dsh 在 Windows 上 ConPTY 无进程组，SIGINT 转发这条路径曾整体失效；Hermes 的 `hermes acp` 工具面被裁剪（排除消息投递与 cron）。**T12**：各引擎对 `loadSession`、`session/list`、`configOptions`、`terminal` 等可选能力实现参差，社区适配器常缺 fs/terminal 委托与 MCP 透传。 | ACP 仍作基线，但**能力必须按"引擎 × 通道"声明而非按引擎声明**（同一引擎不同接入面能力差异极大）。"改动为 0"只对**已通过 CTS 的通道**成立，manifest 里必须能表达"此通道不支持 cancel"。 |
| Engine Pack 的 `capabilities:` 静态声明即可用 | **T23**：能力声明与实际实现不一致是所有协商协议的通病，MCP/ACP/A2A 都只做协议层协商、不保证语义正确。 | 能力三态 `supported / polyfilled / unsupported`，且**未跑通 CTS 的只能标 `claimed`**；运行时探测优先于静态声明。 |
| 完成语义只写了顺序，未处理"引擎不给终态"的情况 | **G07**：opencode 有 abort 后 `finish` 字段不置位、fd 泄漏导致工具态永不收敛、Windows 下悬空 tool_use 等已确认 bug；**G04**：opencode `finish` 实际有 6 个值（多 `content-filter`/`unknown`），Part 有 12 种。 | 完成判定必须**双重确认**（HTTP 终态 ⊕ SSE `session.status: idle`）+ **总超时兜底**，且 `finish` 枚举按 6 值定义。 |
| `prompt_async` 直接对应引擎的 prompt | **G04**：opencode 原生 `prompt_async` **立即返回 204**，赛题要求阻塞到本轮结束。透传等于评测器立刻去拉 message、误判完成。这是**全赛题最大的单点失败风险**。 | 阻塞语义**必须由网关自己实现**：调用引擎后订阅内部事件总线，等到 Run 终态才返回 204。方案原文未提及此落差，必须补。 |
| 未提模型侧的工具调用风险 | **G11**：vLLM/SGLang 等自托管推理在 streaming + parallel tool_calls 下会截断/错位参数（vLLM #39584、#50512、#27641、#46262），后果是文件路径、单元格范围等参数损坏。 | Model Profile 之外必须有 **ModelProxy**：按 `index` 分桶缓冲工具调用增量，仅在参数 JSON 闭合后才转发；reasoning 与 tool_calls 交界做显式状态机识别。这是公共能力，不能留给各 Harness 自己解决。 |
| Process Cleanup 只写了"Terminate Child Process" | **G06 [已交叉验证]**：Win32 的 `TerminateProcess` **不会**杀死子进程；残留的 WINWORD.EXE/EXCEL.EXE 会让下一个用例因"文件被占用"连锁失败。**G01**：opencode 子进程会主动 deparent。 | 必须用 **Job Object**（`CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）或 `taskkill /PID <pid> /T /F`，并写进 CTS E18。 |
| Windows 章节只提路径规范化与 PowerShell 工具 | **G01**：opencode 官方 **strongly recommend WSL**，与"Windows 原生运行"硬约束正面冲突；**G03**：Windows **Session 0 隔离**会让以服务/计划任务方式启动的进程完全无法操作桌面 UI，直接导致 `office_028`（IM 发消息）拿不到分。 | 引擎选型必须先做原生 Windows 冒烟实测；网关必须以**交互式桌面会话**身份运行，这一条要写进 `INSTRUCTION.md`。 |
| Capability & Asset Federation 定位为"能力注入"的通用机制 | **G03 + 方案 E 的 P4**：10 个评测用例考的 Office / 文件 / GUI / 检索能力**没有一个引擎原生具备**，全部要靠网关注入。这不是锦上添花的federation，而是 **70% 客观分的主杠杆**。 | 提升优先级：Capability Pack 是 MVP 必做项而非 v2；但实现方式要退到最简（见 2.3）。 |
| 引擎清单列了 5 个但无选型依据 | **engine-matrix.md**：候选引擎在 Windows 可运行性、内部模型协议兼容性上差异巨大（Claude Code 硬编码 Anthropic Messages 且官方不支持路由非 Claude 模型；Codex 仅 Responses API）。 | 补上带实证的选型顺序与 9 条验证清单，并区分"主力引擎"与"ACP 白嫖位"。 |

### 2.3 必须简化的过度设计（对 3 人 4-6 周而言）

用一把尺子衡量：**一个抽象只有在 MVP 内就存在至少两个真实实现时才成立，否则它是负债。**

| 原文组件 | 问题 | 简化建议 |
| --- | --- | --- |
| Engine Fabric 拆成 Registry / Loader / Capability Negotiation / Supervisor / Lifecycle Manager / Health & Recovery / Session Mapping **七个组件** | 七个组件对应的真实逻辑加起来不到 600 行；拆成七个模块只会增加导航成本与接口摩擦 | 合并为 **EngineRegistry**（读 engine-packs、选引擎、能力探测）+ **EngineHost**（进程生命周期、健康、清理）**两个模块**。Session Mapping 是 SessionRegistry 里的两个字段，不需要独立组件。 |
| 四种 Driver（ACP / Native SDK / JSONL-RPC / HTTP）全部在 MVP 实现 | 四个 Driver 意味着四套事件解析、四套取消语义、四套错误映射，是 MVP 最大的时间黑洞 | MVP 只做 **两个 Driver**：Generic ACP Driver（覆盖多引擎）+ 一个原生 Driver（HTTP 或 stdio，取决于主力引擎实测结果）。其余 Driver 在接口上留位置，v2 再写。 |
| `CapabilityProvider` 接口 + 每引擎一个 asset-adapter | 抽象层次过高。真实需求只是"把 skills 目录、MCP 配置、AGENTS.md 放到各引擎认识的位置" | 退化成一个 **AssetProjector 函数**：输入统一资产目录 + 目标引擎 id，输出往目标位置写文件/生成配置。SKILL.md 与 AGENTS.md 已是跨引擎事实标准（T24），大部分情况是复制或软链。 |
| L2 标准扩展列了 11 项（含 computer-use、browser、session-fork 等） | 其中多数在 MVP 既不会被调用也无法被验证，列出来就要维护 | L2 收缩到**赛题真正用得到的**：mcp、skills、structured-output、session-resume。其余降级到 L3 命名空间，用到时再提升。 |
| Observability 含 Trace / Metrics / 多引擎比较 / Conformance 四套输出 | Metrics 与 OTel 全家桶在 MVP 无人看 | MVP 只做 **JSONL 轨迹落盘 + 一个零依赖静态 HTML 查看器**。OTel 导出留接口，v2 接。 |
| Run 状态机 6 态 + Session 2 态 + Host 5 态 + Error 15 码 | 状态与错误码的数量本身不是问题，但要保证每一个都有代码路径触发 | 保留状态机（它们确实各有触发路径），错误码**砍到 8 个**：`VALIDATION_ERROR`、`SESSION_NOT_FOUND`、`SESSION_BUSY`、`ENGINE_UNAVAILABLE`、`ENGINE_PROTOCOL_ERROR`、`EXECUTION_TIMEOUT`、`EXECUTION_CANCELLED`、`INTERNAL_ERROR`。其余合并进 `error.detail`。 |
| `engines.lock` + `capability-packs/` 四个子包 + `scripts/` 四个脚本 | 目录结构本身合理，但四个 capability pack 在 MVP 内做不完 | MVP 只做 **office** 与 **windows** 两个 capability pack（对应 10 个用例中的 8 个）；data-analysis 靠 office pack 里的 Python 环境覆盖，web 用一个通用检索 MCP。 |

### 2.4 缺失但必须补的（调研中最具决定性的四条）

1. **阻塞语义的实现细节**（G04）：`prompt_async` 的 HTTP 挂起必须由网关订阅事件总线实现，且要处理"引擎永不给终态"的超时兜底。原文只在时序图里画了返回 204，没说这个 204 从哪来。
2. **取消的三层兜底**（G07）：原生 abort → 总超时 soft stop → 进程树级联强杀（Job Object / `taskkill /T`）。原文假设 `EngineDriver.cancel()` 一定生效。
3. **模型代理层的工具调用缓冲**（G11）：这是模型侧的正确性地基，不做的话办公任务会因参数损坏而随机失败。
4. **引擎选型的实证前置**（G01/G02）：第一周必须完成原生 Windows 冒烟 + 内部模型端点往返测试，再决定主力引擎。原文的引擎清单是假设而非结论。

### 2.5 一句话结论

这份方案的**骨架可以直接用**（七层收缩成五层、Engine Pack 声明式接入、双事件模型、固定完成语义、Conformance Kit），但它是在**没有一手实测证据**的前提下写的，因此对 ACP 的普适性过于乐观、对 Windows 与自托管模型的现实风险完全没有覆盖，同时在 Fabric 与 Capability 两处做了 3 人团队负担不起的分层。综合稿的任务是：**保留它的骨架与命名，注入调研发现的四条决定性风险应对，并把组件数量砍掉约一半。**
