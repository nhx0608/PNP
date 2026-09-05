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
