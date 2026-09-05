# 首席架构约束（Chief Architect Brief）— 供综合/评审阶段使用

日期：2026-09-04。本文是主控在精读 T01/T02/T03/T04/T05/T06/T07/T11/T12/T14/T17/T18/T21/T26 报告后确立的"硬约束 + 已验证结论"，综合稿与修订稿必须遵守；与方案冲突时以本文为准，除非评审给出更强证据。

## 0. 命名与定位
- 仓库名 PNP，建议系统名 **PNP Harness Gateway（即插即用多引擎智能体网关）**：上层业务与编排稳定，引擎"即插即用"。
- 一句话：**网关拥有会话、策略、资产、记忆与可观测的"真相"；引擎只是可替换的执行内核。**

## 1. 不可协商的设计决策（每条带证据）
1. **三平面分层**：业务平面（对外 API，面向业务演进，稳定）/ 控制平面（SessionRegistry、Policy、CapabilityRegistry、AssetRegistry、Memory、Observability、Orchestrator/Conductor）/ 引擎平面（Adapter + EngineInstance + Runtime/沙箱）。证据：AgentCore/Managed Agents/UHP 均把 session/identity/memory/observability 放在引擎之外（T06、T15 线索、T26）。
2. **对象模型三层**：`Binding(业务作用域, 由 BusinessKey 标识) → Session(网关会话, 拥有 USR 记录) → Run/Turn(一次执行)`；引擎侧 `Engine → EngineInstance(进程/服务) → EngineSessionRef`。证据：UHP harness/task/session 三层 + HarnessRouter 生产实现（T06）；OpenClaw/Hermes session key 语法（T21、T26）。
3. **ACP v1 是引擎适配层的基线协议**（wire baseline），网关只实现一个 ACP Client 即可零改动接入 ≈40 个 harness（Gemini CLI、Codex adapter、claude-agent-acp、Copilot、Goose、opencode、Kimi、Qwen Code、Hermes `hermes acp`、dsh `--profile acp`、pi 适配器）。**但 ACP 不是全部**：对需要深度能力/扩展能力的引擎，同时保留"原生适配器"（Claude `claude -p --bare` stream-json 或 Agent SDK；opencode `serve` HTTP+SSE；Codex `app-server` JSON-RPC；pi `--mode rpc`；Hermes API server `/api/sessions` + `/v1/runs`）。一个引擎可同时注册 ACP 通道与原生通道，由能力解析决定走哪条。证据：T12、T01、T03、T07、T02、T04、T05。
4. **Capability 体系分四层**：`core.*`（必须：session.create/resume、turn.prompt/stream/cancel、permission.request、tool.mcp.inject、usage）、`std.*`（应有：session.fork/list/close、config.model/effort、mode、compaction、structured_output、skills/instructions 注入、trace 透传）、`ext.<engine>.*`（引擎特有：claude.workflow、claude.hooks、claude.subagents、codex.multi_agent、codex.guardian、pi.session_tree、opencode.share/revert、hermes.skill_evolution、hermes.cron_with_memory、openclaw.rooms/bindings、dsh.self_modify/agent_presets）、`x.*`（实验）。能力 ID 带版本；每个能力有参数 JSON Schema、依赖、polyfill 标志、一致性测试引用、成本画像。证据：Open Harness 11-domain manifest + 501 语义、UHP conformance class（T06）；ACP `agentCapabilities/configOptions/modes`（T12）；Claude `system/init.capabilities[]`（T01）；Hermes `/v1/capabilities`（T04）；opencode `/experimental/capabilities`（T03）；Codex `model/list.multiAgentVersion`、`experimentalFeature/list`（T07）；dsh `--dump-config`（T05）。
5. **能力发现 = 静态 manifest + 运行时探测 + CTS 认证**三步；运行时探测优先，避免硬编码版本（各引擎版本漂移极快：Claude 文档大量 "v2.1.2xx 起"，Hermes 一月 7 版，dsh 日更，OpenClaw 日期版本，ACP v2 重构中）。
6. **Polyfill 原则**："多数引擎能实现"的才归一化为 core/std；少数派能力进 ext；网关对缺失能力提供托管实现（记忆服务、Room/Team、调度、审批中继、fork=复制转录、compaction=摘要重灌、结构化输出=后处理校验），并在能力解析时标注 `native | polyfill | unavailable`。证据：T06 风险"通用 API 变成某一家 API"，UHP 刻意不定义 memory/subagent。
7. **会话真相在网关**：Universal Session Record（USR）由归一化事件流构建（turn/step/tool/artifact/summary），引擎转录文件一律视为不稳定实现细节（Claude JSONL、Codex rollout、opencode 存储、dsh `SESSION_FORMAT_VERSION=0` 均官方声明不稳定）。引擎切换三模式：冷启动+摘要（默认）、转录重放（`session/load` 或 prompt 回灌）、共享工作区+交接文档。
8. **每个 Session 一条 lane 串行**（OpenClaw/Hermes 语义），入站策略 `steer|followup|collect|interrupt` 作为公共参数；同一 EngineSessionRef 绝不并发 resume（Claude/pi 无文件锁）。生命周期 `NEW→ACTIVE→WARM→ARCHIVED→(ACTIVE)`，reset 策略 `none|idle|daily|both`。
9. **权限模型"编译 + 执行"双重**：统一策略（主体 tenant/group/user；客体 tool/file/net/model/budget；效果 allow/deny/ask/audit）编译为引擎原生配置（Claude allow/deny 规则 + `--permission-mode` + http hooks + `--permission-prompt-tool`；opencode `permission` ruleset + `permission.asked` 回复；Codex `approval_policy × sandbox` + `requestApproval`；pi `--tools` + 策略扩展 `tool_call` block；Hermes `approvals.*` + `/approval`；ACP `request_permission` 自动应答）+ 网关适配器运行时二次判定；审批异步回群、带过期与默认 deny；**容器/用户级隔离为基线，不依赖引擎沙箱**（Codex bwrap 在容器内常不可用、dsh 沙箱只限文件、srt 嵌套需降级）。
10. **可观测三通道 + 稳定内部 schema**：内部 `agw.*` 事件/属性稳定，导出时映射到 OTel GenAI semconv（仍 Development，属性名会改）；采集通道 A 引擎原生 OTLP 直通（Claude/Codex/Gemini/OpenClaw/dsh）+ `traceparent` 注入；B 适配器归一化事件流（所有引擎）；C 日志文件/stderr 采集。网关自打序号、自算成本（引擎缺 cost 时按定价表）、自做 session 关联（OpenClaw 故意不导出 session key）。
11. **资产模型 + 资产编译器**：统一资产（skill/instruction/prompt/tool(MCP)/agent 定义/workflow 模板/policy/memory 快照），作用域 org→tenant→group→user，版本化、签名；编译器投影到引擎原生布局（SKILL.md 已是事实标准：Claude/Codex/opencode/pi/Hermes/OpenClaw/dsh 全兼容；AGENTS.md 通用，Claude 用 `CLAUDE.md` `@AGENTS.md` 导入；MCP 配置按引擎格式；hooks 仅 Claude/Codex/Gemini）。证据：T01、T03、T05、T24（待补）、harness-loom（T06）。
12. **编排两层嵌套**：网关级 Workflow DSL（节点 = 能力需求 `requires` + 引擎选择策略 `pinned|prefer|auto` + 能力参数 + IO 契约 + 失败回退 + 审批点）；节点内可调用引擎原生扩展（Claude dynamic workflow 通过 `Workflow` allow 规则在 `-p` 下可用；Codex multi-agent v2；Hermes delegate_task；OpenClaw sessions_spawn）。**Claude Agent Teams 在无头/SDK 模式不可用，不得列入可编排能力**（T01、T18）。Conductor（LLM 元编排）只生成/修改 DSL，不直接执行；决策记录可解释；预算硬上限；完成判定加环境状态检查而非信 agent 自述（MAST 数据，T18）。
13. **自进化 = 资产进化 + 门禁**：进化对象是资产（skills/prompts/workflow 模板/引擎选择策略/记忆），需评估集回归、A/B、审批、回滚；引擎原生进化（Hermes `skill_manage` 自建技能、dsh 运行时自修改）作为 ext 能力接入，其产物必须回流资产库经门禁后才可跨引擎分发。
14. **引擎接入 SOP**：manifest 填写 → 选接入面（ACP 通道优先，原生通道按需）→ 适配器（`install/spawn/session/turn/events/cancel/permission` 七件套）→ CTS（Core/Extended/Full 三档，重点测渐进流与真取消，UHP S-09/C-03）→ 性能与成本画像 → 安全扫描（遥测外发、默认权限）→ 版本钉死 + 协议指纹（schema diff）→ 发布。目标"一天接入"。

## 2. 与业界方案的差异化（必须在文档中写清）
- vs **OpenClaw**：OpenClaw 是"个人助手网关"，单进程、全 operator 权限 token、多租户需多实例；我们是多租户业务网关，策略/资产/记忆/可观测在控制平面，引擎可插拔且可按节点编排；OpenClaw 可作为一个被接入的引擎（WS RPC / OpenAI 兼容 API），其 acpx ACP 注册表思想被我们吸收。
- vs **UHP/HarnessRouter**：同为进程级多 harness 网关，但 UHP 只做 task/session/files + conformance；我们增加 Capability 分层协商、扩展能力暴露、polyfill、策略编译、统一事件 schema、资产编译器、两层编排与 Conductor、自进化门禁。
- vs **openharness.ai（库级）**：库级适配对 CLI 型引擎无效（Claude Code 被标 aspirational）；我们走进程/服务级。
- vs **ACP**：ACP 是编辑器↔单 agent 协议，缺业务→session 映射、多租户、认证、遥测归一、扩展能力目录；我们把它作为 wire baseline 并补齐这些。
- vs **AgentCore/Managed Agents**：云托管闭源；我们的抽象与之同构（runtime/session/memory/identity/gateway/observability）但开放、多引擎。

## 3. 赛题对接（2026-09-04 依据仓库 docs/ 三份基线文档修订，优先级最高）
- **北向 API = 通用 Agent 网关规范**（端口 6217）：`POST /session {title, directory}`、`GET/DELETE /session/{id}`、`GET /session/status`（idle|busy）、`POST /session/{id}/prompt_async`（HTTP 阻塞直到本轮完整结束，204）、`GET /session/{id}/message`（完整轨迹，opencode 风格 Message/Part：text/tool/step-finish，`info.finish=stop` 为最终完成）、`POST /session/{id}/abort`（必须传播到底层 run）、`GET /event` SSE（server.connected/heartbeat 15s/session.status/session.idle/session.error/message.part.updated/question.asked/permission.asked）、可选 `/question`、`/permission`（默认策略：不询问 / 默认允许，但必须能把引擎原生询问归一后自动继续）；错误 `{code,message}`。该规范形态与 opencode server API 高度一致——**内部统一模型必须与外部 HTTP 解耦**（GatewaySession/GatewayRun/GatewayMessage/GatewayEvent/EngineSessionRef/WorkspaceContext/ModelProfile），新引擎不改 Route 与 Session Core。
- **引擎选择在启动时**：`gateway --engine <id> --port 6217 --host localhost` 与 `AGENT_ENGINE`；不要求热切换。但架构上保留"每 session 可绑定不同引擎"的能力（EngineBinding），热切换/按节点切换作为 v2 扩展能力，不影响 MVP。
- **Windows 10/11 原生**是硬约束：引擎必须能在 Windows 无人值守安装与启动；shell 工具差异（PowerShell/cmd/Git Bash）、路径、进程树终止、沙箱不可用等要在适配器与部署脚本中处理；容器隔离在评测环境不可用，隔离退化为"每 session 独立 directory + 进程 + 权限策略"。
- **内部部署模型**是硬约束：网关提供统一模型代理层（推荐 LiteLLM 或自研轻量代理），把内部模型暴露为 OpenAI chat/completions、Anthropic Messages、Responses 三种 wire，按引擎注入（pi models.json / opencode provider / Hermes provider / Goose OPENAI_HOST / dsh provider 插件 / Claude ANTHROPIC_BASE_URL / Codex model_providers）；启动自检做模型连通与工具调用能力探测。
- **客观分 70% 取决于引擎完成 Windows 办公任务的效果**（docx/xlsx/pptx/csv、文件删除、IM 发消息、网页检索；每用例取各引擎最高分）。因此"统一资产层"在 MVP 中的首要用途是**能力注入**：Office skills（anthropics/skills 的 docx/xlsx/pptx/pdf）、Office/Windows MCP（Windows-MCP、Office MCP）、网页检索 MCP、AGENTS.md 任务规范（产物自检清单：文件已保存/路径正确/格式未破坏）；投影到每个引擎的原生布局。**不得针对用例硬编码**。
- **可选不实现**（跨引擎 session 同步、持久化、多 agent、复杂编排）→ 归入 v2/展望，但抽象要预留（USR、Capability ext、Workflow DSL），文档要说明"同一套抽象既服务 MVP 也承载愿景"。
- **提交物**：`solution/INSTRUCTION.md`（环境准备、依赖、启动、引擎切换、调用顺序、完成判定、交付件）+ `solution/code/`。
- **引擎选型原则**：Windows 原生可跑 × 内部模型兼容 × 办公任务效果 × 部署稳定 × 接入成本。候选 OpenCode、Pi、Hermes、Goose、dsh（+ Claude Code/Codex 视内部模型协议而定）。至少 2 必接 + 2 备选，最终以 G01/G02/G03/G05 报告与本地实测为准。
- "opendesk"身份未确认（唯一命中 vitalops/opendesk 是 computer-use MCP server）；文档如实说明。
- 评分中架构 20% + 创新 5% + 鲁棒 5%：架构文档要清晰呈现分层、能力协商、接入 SOP、可观测、鲁棒性工程；创新点集中在 Capability 分层协商 + polyfill、资产编译器、两层编排/Conductor（展望）、引擎记分卡驱动的用例级路由（每用例取最高分 → 网关可用历史记分卡为不同任务类型推荐引擎，这是与评分规则直接呼应的创新点）。

## 4. 3 人 4-6 周的边界（供可行性评审参照）
- **MVP（评测必需）**：通用规范全部端点 + Session Core（idle/busy 状态机、lane 串行、abort 传播、超时）+ 轨迹归一化（Message/Part + step-finish）+ SSE 总线 + 启动器（--engine/AGENT_ENGINE、自检）+ 模型代理层 + 至少 2 个引擎适配器（首选 opencode 原生 serve API 与 通用 ACP 适配器接入 pi/Hermes/dsh/Goose 之一；或 pi RPC 原生）+ 资产注入（Office skills/MCP、AGENTS.md）+ 本地回归评测（10 用例）+ INSTRUCTION.md + Windows 一键部署脚本。
- **v2（架构分）**：第 3/4 个引擎（Goose、dsh/Hermes 原生）、Capability manifest/探测/CTS Core、统一事件 schema + OTLP 导出、策略编译（allow/deny/ask）、资产编译器、引擎记分卡与按任务类型推荐引擎、USR 与引擎切换（冷启动+摘要）。
- **展望（创新分）**：Conductor 元编排与 Workflow DSL、polyfill Room/Team、统一记忆层、自进化门禁、云托管引擎（Managed Agents）。

## 5. 实现复杂度预算（2026-09-05 追加，与第 1 节同级的硬约束）

团队明确要求："时间紧张，也要考虑实现的复杂性，不能设计得太复杂；越完善全面越好，但整体实现方式要轻量。"这条不是风格偏好，而是可证伪的工程约束：

**尺子：一个抽象只有在 MVP 内就存在至少两个真实实现时才成立，否则它是负债。**
用这把尺子量任何"Provider / Driver / Adapter / Manager / Federation"类抽象；量不过的，写成一个函数或直接内联。

预算（超出即视为过度设计，需在文档中说明为何值得）：
- **MVP 核心代码 ≤ 5000 行 TypeScript**（不含 engine-packs 与测试）。
- **Gateway Core 模块数 ≤ 6**（session / run / message / event / workspace / policy）。Engine 侧 ≤ 3（registry / host / driver）。
- **MVP 只实现 2 个 Driver**：Generic ACP Driver（一套代码覆盖多引擎）+ 1 个原生 Driver（HTTP 或 stdio，由第一周实测结果决定）。其余 Driver 在接口留位置，v2 再写。
- **存储只用 JSONL 文件 + 内存**。赛题明确"会话可以只存在内存"；轨迹落盘是为了给评委看，不是为了做数据库。不引入 SQLite/Postgres/Redis/Temporal/K8s。
- **可观测 MVP 只做 JSONL 轨迹 + 一个零依赖静态 HTML 查看器**。OTel 导出留接口，v2 接。
- **错误码 ≤ 8 个**，其余细节进 `error.detail`。
- **Capability Pack MVP 只做 2 个**（office、windows），覆盖 10 个用例中的 8 个。
- **每个"设计中存在但 MVP 不实现"的能力，必须在文档里显式标注 `[v2]` 或 `[展望]`，且系统在它缺席时功能完整。**

对应地，以下能力赛题明确"可选不实现"，MVP 一律不写实现（只在数据结构上留字段）：跨引擎 session 同步、持久化数据库、多 Agent Team/Room、自进化、热切换引擎。

## 6. 交付目标（2026-09-05 明确）

最终产出是仓库中的 **`docs/architecture.md`**（团队已有的三份基线文档 `competition-baseline.md` / `gateway-api-baseline.md` / `evaluation-cases.md` 是它的输入）。团队已有一份 GPT 撰写的参考方案（见 `design/reference-gpt-pnp-agent-fabric.md`，含主控的逐条对照分析）：**保留它的骨架与命名**（五层分层、Engine Pack 声明式接入、Canonical + Raw 双事件、固定完成语义、Conformance Kit E01–E20），**注入调研发现的四条决定性风险应对**（prompt_async 阻塞语义自实现、取消三层兜底、模型代理的工具调用缓冲、引擎选型的实证前置），**并把组件数量砍掉约一半**。

## 7. 赛题原文核对修正（2026-09-05，以任务书与调测指南原文为准，优先级高于本文其余各节）

团队提供了赛题任务书与调测指南原文，核对后发现此前的基线整理有六处偏差，已回写仓库 `docs/`。以下是对架构有决定性影响的部分：

1. **引擎切换必须通过环境变量**。任务书"重要提示"逐字要求"必须通过环境变量实现引擎切换"，`AGENT_ENGINE=opencode|pi|hermes`。命令行 `--engine` 只是通用网关规范附带的等价形式，可以提供但不能作为唯一入口，且两者并存时必须写明优先级（评测方按环境变量启动，若被命令行默认值覆盖会直接跑错引擎）。

2. **反问与权限接口必须真实实现，只有策略可以简化**。任务书原文："执行过程需要人工交互的，需要实现接口供裁判模型自动提交交互，否则将导致作品无法完成自动评测。"此前基线写成"允许简化为默认不询问/默认允许"是**错误**的——可简化的是默认策略，`/question` 与 `/permission` 的事件推送、查询、回复三条链路必须可用，因为裁判模型要靠它们把交互提交回来。这一条把这两个端点从"可选"提升为 **[MVP] 必做**。

3. **每个引擎内置一个默认 agent 是被任务书明确认可的形态**。原文："可以不实现多agent机制，可以每个引擎内置一个默认agent，会话基于该agent创建。"这为 Engine Pack 的最简实现背书：Session 直接建在默认 agent 上，不需要 agent 管理层。

4. **主模型可能是 appid 鉴权**。原文："限定使用内部部署模型资源，提供测试环境的 appid，赛题组协助申请资源。"模型接入层不能假定标准 `Authorization: Bearer`，要能容纳自定义鉴权头/appid 参数。ModelProxy 的配置模型需要预留这一维度。

5. **Windows GUI 自动化是一个完整任务类别，不是边缘用例**。任务书正文的示例用例 `office_002`（"打开 Outlook 客户端"，二级分类"软件交互"）与已知用例 `office_028`（**WeLink** 发消息给指定工号）共同说明：隐藏用例中很可能还有多条桌面客户端操作任务。因此 GUI 能力注入的优先级应与 Office 文件处理**同级**，并且网关必须以**交互式桌面会话**身份运行（Session 0 隔离会让服务方式启动的进程完全无法操作 UI）。

6. **MyAgent 就是任务书背景点名的内部 AI 应用员工助手**，是赛题所说"真实业务系统"的原型，这解释了第二套规范路径里为何保留 `/opencode/` 命名。

7. **评测环境路径与产物名是硬约束**。工作目录 `D:\test_data`，部分用例写到 `D:\test_data_备份`；多条用例在 query 里指定了确切的输出文件名（如 `openclaw.pptx`、`华为2025手机-sheet.xlsx`、`task_违约风险分析.md`）。Workspace 管理必须正确处理 Windows 绝对路径与反斜杠，本地回归框架应按这些文件名做存在性与结构校验。

8. **两条高危用例**：`office_103`（递归删除，作用域错误不可逆）与 `office_028`（外部消息，重试必须幂等）。权限策略即使配成默认允许，也要在轨迹中留下完整记录；重试逻辑对有外部副作用的操作必须幂等。
