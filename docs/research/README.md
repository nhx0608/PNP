# 调研成果索引

> 调研执行时间：2026-09-03 至 2026-09-05
> 覆盖 33 个专题、约 120 万字一手资料检索，全部结论以联网抓取的官方文档 / GitHub 源码 / 协议规范 / 论文原文为准。

本目录是 PNP 项目的**架构输入层**。赛题要求见 [`../competition-baseline.md`](../competition-baseline.md)、[`../gateway-api-baseline.md`](../gateway-api-baseline.md)、[`../evaluation-cases.md`](../evaluation-cases.md)；本目录回答的是"业界现在到底是怎么做的、每个候选引擎的真实接入面长什么样、哪些坑会让我们在评测中掉分"。

## 怎么读

| 你想知道 | 先读 |
| --- | --- |
| 全部结论的浓缩版 | [`DIGEST.md`](./DIGEST.md)（各专题摘要 + 关键事实 + 设计启示） |
| 选哪几个引擎、每个引擎怎么接 | [`engine-matrix.md`](./engine-matrix.md)（引擎 × 18 维度对比矩阵 + 选型建议 + 验证清单） |
| 公共能力与扩展能力怎么划分 | [`capability-inventory.md`](./capability-inventory.md)（12 域能力清单 + 能力×引擎支持矩阵 + 统一术语） |
| 架构必须遵守什么 | [`architecture-constraints.md`](./architecture-constraints.md)（14 条硬约束，含证据出处） |
| 某个引擎/协议的细节 | 下方分类索引 |

## 关键结论（对方案影响最大的 12 条）

1. **赛题网关规范源自 opencode server API，但语义有落差。** `prompt_async` 在 opencode 原生是立即返回 204 的真异步端点，赛题要求它阻塞到本轮结束；网关必须自己订阅 SSE 的 `session.status: idle` 再返回。`directory` 在 opencode 是 query 参数而非 body 字段；事件真名是 `permission.updated` 而非文档里的 `permission.asked`；`finish` 枚举实际有 6 个值；Part 类型实际有 12 种。详见 [G04](./G04-generic-gateway-spec-vs-opencode-contract.md)。
2. **没有一个引擎做到"真取消"。** opencode 的 abort 对 HTTP 路径真实生效但有 fd 泄漏、Windows 悬空 tool_use、abort 后 finish 不置位等已确认 bug；Goose 的 goosed REST 历史上根本没有取消端点；Hermes 子任务的 stop 是协作式的；dsh 在 Windows 上 ConPTY 无进程组导致 SIGINT 转发失效。网关必须自建超时兜底 + 进程级强杀 + 状态机去抖。详见 [G07](./G07-engine-cancel-completion-semantics.md)。
3. **自托管推理服务的流式工具调用是结构性风险。** vLLM/SGLang 在 streaming + parallel tool_calls 场景有持续暴露的缺陷：多个 tool_calls 挤在一个 delta 触发断言崩溃、reasoning_content 与 tool_calls 交接丢标记、pipeline-parallel 下 JSON 被截断。后果是文件路径、单元格范围等参数损坏。网关的模型代理层必须按 index 分桶缓冲工具调用增量，仅在 JSON 闭合后才转发。详见 [G11](./G11-self-hosted-inference-tool-calling-compat.md)。
4. **OpenCode 官方建议 Windows 用 WSL**，与赛题"Windows 原生运行"硬约束正面冲突，尽管它协议最贴近。必须原生实测，不能只信文档措辞。详见 [G01](./G01-windows-compatibility.md)。
5. **引擎按模型协议分两类。** 硬编码单一 wire 协议的（Claude Code 仅 Anthropic Messages 且官方不支持路由到非 Claude 模型；Codex 仅 Responses API）需要外挂协议转换；协议可配置的（opencode、pi、Hermes、Goose、Qwen Code、dsh）可直连内部端点。这是"内部部署模型"硬约束下的第一道筛子。详见 [G02](./G02-internal-model-endpoint-compat.md)。
6. **ACP 是引擎适配层唯一值得作为基线的协议。** 约 40 个 harness 实现了它（Gemini CLI、Qwen Code、Kimi CLI、opencode、Goose、dsh、Codex/Claude 适配器等），网关实现一个 ACP Client 即可覆盖多引擎。但它缺业务→session 映射、多租户、认证、遥测归一与扩展能力目录，这些要由网关补。详见 [T12](./T12-acp-agent-client-protocol.md)。
7. **Windows 进程树终止必须用 Job Object 或 `taskkill /T`。** `TerminateProcess` 不杀子进程，残留的 winword.exe / excel.exe 会让下一个用例因"文件被占用"连锁失败。Node 在 Windows 上 SIGTERM 不生效也是长期已知问题。详见 [G06](./G06-evaluation-rollout-judge-robustness.md)。
8. **Office 能力走脚本库路径而非 COM。** python-docx / openpyxl / python-pptx + LibreOffice headless 是可控方案；Office COM 依赖真机授权，评测环境不确定。SKILL.md 已是跨引擎事实标准（opencode、Claude Code、Codex、Hermes、dsh 均可消费）。详见 [G03](./G03-office-and-windows-task-capabilities.md)。
9. **Windows Session 0 隔离会让 GUI 自动化静默失效。** 若评测方以服务/计划任务方式启动网关，`office_028`（即时通讯发消息）这一确定得分点会直接拿不到分。网关必须以交互式桌面会话身份运行。详见 [G03](./G03-office-and-windows-task-capabilities.md) 与 [G01](./G01-windows-compatibility.md)。
10. **Claude Code 的 Agent Teams 在无头/SDK 模式下不可用**，dynamic workflow 需通过 Workflow 工具加权限规则触发。任何"引擎原生扩展能力"都必须可降级，不能让上层依赖只在交互模式存在的能力。详见 [T01](./T01-claude-code-agent-sdk.md)、[T18](./T18-dynamic-workflow-meta-orchestration.md)。
11. **引擎转录文件一律视为不稳定实现细节。** Claude Code JSONL、Codex rollout、opencode 存储、dsh（`SESSION_FORMAT_VERSION=0`）均由官方声明格式会变。会话真相必须由网关从归一化事件流自建。详见 [T30](./T30-context-portability.md)、[T21](./T21-sessions-isolation-sandbox.md)。
12. **"opendesk" 身份无法确认。** 全网唯一命中的 `vitalops/opendesk` 是 computer-use MCP 工具服务器而非 harness，Harness-Bench 论文与 160+ 项 harness 榜单均无此名。建议向主办方澄清，并以 OpenHands 或其他引擎兜底。详见 [T06](./T06-opendesk-and-universal-harness-api.md)。

## 分类索引

### 一、候选引擎深度调研

| 报告 | 主题 | 对本赛题的价值 |
| --- | --- | --- |
| [T03](./T03-opencode.md) | OpenCode 客户端-服务端架构 | 赛题网关规范的原型，serve API / 93 种事件 / 权限模型全解 |
| [T02](./T02-pi-harness.md) | pi-agent（earendil-works/pi） | RPC 模式协议、session 树、扩展体系；赛题点名引擎 |
| [T04](./T04-hermes-agent.md) | Hermes Agent | 自身即"网关+多渠道"，API server、技能自进化、cron |
| [T05](./T05-deepseek-harness-dsh.md) | DeepSeek Harness (dsh) | "一切皆插件"架构、ACP profile、运行时自修改 |
| [G05](./G05-goose-deep-dive.md) | Goose | Rust 内核、goosed REST、Recipe、Computer Controller |
| [T01](./T01-claude-code-agent-sdk.md) | Claude Code / Agent SDK | stream-json 协议、30+ hooks、权限模型、workflows |
| [T07](./T07-openai-codex.md) | OpenAI Codex | app-server JSON-RPC、Windows 原生沙箱、多 agent v2 |
| [T08](./T08-gemini-cli-qwen-kimi-iflow.md) | Gemini CLI / Qwen Code / Kimi CLI / iFlow | Policy Engine、ACP 模式、多协议 provider |
| [T09](./T09-other-coding-engines.md) | 其他 10 个引擎速览 | Aider / Cline / Kilo / Amp / Cursor / Copilot / Droid / Crush 等接入面 |
| [T11](./T11-openclaw.md) | OpenClaw 网关架构 | 与我们同构的"网关+多引擎"参考实现，session key 语法、acpx |

### 二、赛题专项（Windows 落地）

| 报告 | 主题 |
| --- | --- |
| [G01](./G01-windows-compatibility.md) | 11 个引擎的 Windows 10/11 原生兼容性与无人值守部署 |
| [G02](./G02-internal-model-endpoint-compat.md) | 各引擎对自定义 OpenAI/Anthropic 兼容端点的支持与协议转换坑 |
| [G03](./G03-office-and-windows-task-capabilities.md) | Office 文件处理、Windows GUI 自动化、网页检索的能力注入 |
| [G04](./G04-generic-gateway-spec-vs-opencode-contract.md) | 赛题网关规范与 opencode 真实契约的逐项对照 |
| [G06](./G06-evaluation-rollout-judge-robustness.md) | Rollout + LLM-as-Judge 评测机制、轨迹格式、鲁棒性工程清单 |
| [G07](./G07-engine-cancel-completion-semantics.md) | 跨引擎"真取消"与"真完成"语义核验 |
| [G11](./G11-self-hosted-inference-tool-calling-compat.md) | vLLM/SGLang 等自托管推理的工具调用兼容性缺陷 |

### 三、协议与互操作

| 报告 | 主题 |
| --- | --- |
| [T12](./T12-acp-agent-client-protocol.md) | ACP 完整规范、约 40 个实现、缺口分析 |
| [T13](./T13-a2a-mcp-agui-protocols.md) | A2A 1.0 / MCP 2025-11 / AG-UI 的三种能力协商范式 |
| [T23](./T23-capability-negotiation-design.md) | 跨领域能力协商设计（LSP/WIT/K8s/Khronos）与 Capability Manifest 草案 |
| [T06](./T06-opendesk-and-universal-harness-api.md) | opendesk 身份考证 + UHP / HarnessRouter / Open Harness 先行者分析 |

### 四、核心子系统

| 报告 | 主题 |
| --- | --- |
| [T21](./T21-sessions-isolation-sandbox.md) | 会话模型、并发隔离、沙箱运行时、SessionRegistry 设计 |
| [T22](./T22-permissions-policy-safety.md) | 跨引擎统一权限策略模型与编译目标 |
| [T14](./T14-observability-genai-otel.md) | OTel GenAI 语义约定与各引擎埋点能力矩阵 |
| [T24](./T24-assets-skills-plugins.md) | AI 资产模型：SKILL.md / AGENTS.md / MCP 的可移植性 |
| [T20](./T20-memory-systems.md) | 记忆系统与跨引擎统一记忆层 |
| [T30](./T30-context-portability.md) | 会话记录格式与中途切换引擎的上下文可移植性 |

### 五、编排、协作与演进

| 报告 | 主题 |
| --- | --- |
| [T17](./T17-multiagent-frameworks-orchestration.md) | 多 Agent 编排框架原语与"异构 agent 作为节点"抽象 |
| [T18](./T18-dynamic-workflow-meta-orchestration.md) | Dynamic Workflow 与 LLM 元编排（含 ADAS/AFlow 等研究） |
| [T29](./T29-agent-teams-rooms.md) | Agent 团队 / Room / agent 间直接通信的三档耦合强度 |
| [T19](./T19-self-evolution.md) | Agent 自进化三代技术脉络与安全门禁 |

### 六、业务形态与生态

| 报告 | 主题 |
| --- | --- |
| [T26](./T26-group-assistant-patterns.md) | 群助手业务模式：Claude Tag / Codex / Devin / 飞书钉钉企微的会话映射 |
| [T28](./T28-chinese-ecosystem.md) | 中国 Agent 生态与"网关+引擎"实践 |

## 方法与可信度约定

- 每条事实标注来源 URL 与置信度（高/中/低）；关键断言标注"[已交叉验证]"表示有第二个独立来源。
- 明确区分"已确认"（一手来源直接陈述）与"推测"（多来源归纳）。
- 记录版本号与抓取日期。本领域版本漂移极快（Hermes 一个月 7 个版本、dsh 日更、ACP v2 重构中、OpenClaw 日期式版本），**任何超过一个月的结论都应重新核实**。
- 报告中提到的"未解决问题"是有意保留的，代表需要实测而非继续查文档才能回答的问题。

## 与实现的关系

调研只回答"业界怎么做、坑在哪"，不替代实测。[`engine-matrix.md`](./engine-matrix.md) 末尾的 9 条验证清单是从调研直接推导出的实测项，接入任何引擎前应先跑一遍。
