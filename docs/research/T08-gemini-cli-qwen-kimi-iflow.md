# T08 Gemini CLI 及其衍生/中文 CLI 引擎（Qwen Code、Kimi CLI、iFlow CLI）

## 摘要
Gemini CLI（`google-gemini/gemini-cli`）是本组四个引擎中架构最完整、文档最一手的：它同时提供 headless（`-p --output-format json|stream-json`，退出码 0/1/42/53）、ACP server（`--experimental-acp`，stdio + JSON-RPC 2.0，被 Zed/IntelliJ 等驱动）两种编程接入面；拥有目前最精细的开源 Policy Engine（allow/deny/ask_user 三态、多维匹配、分层优先级，且明确"headless 下 ask_user 降级为 deny"这一关键约束）；支持 Subagents（进程内工具隔离型委派）与正在 RFC 阶段的 A2A 远程 agent 委派两种多 agent 模型；OTel 遥测集成规范、支持 Windows 管理员策略路径。Qwen Code 是 Gemini CLI 的 fork，架构骨架相近但把模型接入面扩展为 OpenAI/Anthropic/Gemini/Qwen 多协议，且 headless 层面提供了更完整的会话恢复能力（`--continue`/`--resume sessionId`）与五档审批模式（plan/default/auto-edit/auto/yolo），对本赛题"内部部署模型必须走 OpenAI/Anthropic 兼容端点"的硬约束更友好，建议作为优先候选之一。Kimi CLI 正处于向 Kimi Code（`MoonshotAI/kimi-code`）迁移阶段，主打 `kimi acp`/`kimi mcp` 两个子命令，headless JSON 协议细节未获一手确认；已知 ACP 通道下 MCP-over-ACP-transport 会被静默丢弃，YOLO 模式在 Zed/ACP 场景存在已知 bug。iFlow CLI 已由官方宣布于 2026-04-17 停运，截至评测节点应已不可用，不建议作为正式候选引擎。四者共同的公共能力包括 headless prompt 执行、MCP client、分层记忆文件（GEMINI.md 及等价物）；引擎特有扩展能力包括 Policy Engine、Subagents、A2A、ACP 作为传输层的可插拔性——这些应分别归入网关的"公共能力面"与"扩展能力协商面"设计。

## 关键事实

| 事实 | 来源 | 置信度 | 是否交叉验证 |
|---|---|---|---|
| Gemini CLI headless 模式通过 `-p/--prompt`（非 TTY 环境自动触发）激活，`--output-format` 支持 `json`（单个 JSON 对象，含 `response`/`stats`/`error` 字段）与 `stream-json`（JSONL 流，事件类型 `init/message/tool_use/tool_result/error/result`） | https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md | 高 | [已交叉验证]（多个搜索片段一致提及 stream-json 事件与用途） |
| Gemini CLI headless 退出码：0 成功，1 一般错误/API 失败，42 输入错误，53 超出回合限制 | 同上 | 高 | 否 |
| Gemini CLI 支持 `--experimental-acp` 启动 ACP（Agent Client Protocol）server 模式，通过 stdio + JSON-RPC 2.0 与 Zed/IntelliJ 等编辑器通信；忘记该 flag 会导致 CLI 挂起在交互式终端 | https://geminicli.com/docs/cli/acp-mode/ , https://zed.dev/acp/agent/gemini-cli | 高 | [已交叉验证]（Zed 官方文档 + geminicli.com 文档一致） |
| Gemini CLI Policy Engine：三种互斥决策 `allow/deny/ask_user`；`ask_user` 在 headless/非交互模式下被当作 `deny` 处理 | https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md | 高 | 否（单一权威源，但内容具体到实现细节，可信度高） |
| Policy Engine 规则匹配字段：toolName（含通配符 `*`、`mcp_*`）、argsPattern（正则匹配参数 JSON）、commandPrefix/commandRegex（shell 命令）、mcpName、subagent、工具注解（如 readOnlyHint）、环境（交互/非交互）；优先级 = tier_base + toml_priority/1000，Admin 层级最高 | 同上 | 高 | 否 |
| Policy 配置路径分层：用户层 `~/.gemini/policies/*.toml`；管理员层 Windows 下为 `C:\ProgramData\gemini-cli\policies`（有严格属主校验），可用 `--admin-policy` 追加补充路径 | 同上 | 高 | 否 |
| Gemini CLI Subagents 为预览特性，通过在 `agents/` 目录放置 `.md` 定义文件创建，支持工具隔离（子代理仅能访问指定工具集，避免全局工具注册表污染），从而实现细粒度权限控制 | https://developers.googleblog.com/subagents-have-arrived-in-gemini-cli/ , https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md | 高 | [已交叉验证]（Google 官方博客 + 官方 docs 一致） |
| Gemini CLI 扩展（Extensions）可通过 `policies/*.toml`、`hooks/hooks.json`、`agents/*.md` 三类文件分别贡献策略规则、hooks 和 subagent 定义，随扩展激活生效 | https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md | 高 | 否 |
| Gemini CLI 支持通过 A2A（Agent2Agent）协议调用远程 agent：`RemoteAgentInvocation` 工具类型代理请求给远程 agent，在 `agents.toml` 中以 `kind = "remote"` 声明，用 `a2aUtils.ts` 维护 `contextId`/`taskId` 会话状态；官方 RFC 提议将 A2A 定为未来所有 Gemini CLI 集成的标准协议 | https://github.com/google-gemini/gemini-cli/pull/16013 , https://github.com/google-gemini/gemini-cli/discussions/7822 | 中（PR/discussion 而非最终 stable 文档） | 否 |
| Gemini CLI 会话管理有两套机制：`/chat save <tag>` / `/chat resume <tag>` 手动会话检查点（可分支/跨会话恢复）；以及文件修改前自动创建项目快照的 Checkpointing（用于一键回滚代码改动，与聊天历史检查点是独立系统） | https://geminicli.com/docs/cli/checkpointing/ , https://geminicli.com/docs/cli/session-management/ | 高 | [已交叉验证]（两篇官方文档相互印证并明确区分二者） |
| Gemini CLI OpenTelemetry (OTel) 集成通过 `.gemini/settings.json` 的 `telemetry` 对象配置，支持 OTLP/gRPC 或 OTLP/HTTP（`--telemetry-otlp-protocol`），可用 `npm run telemetry -- --target=local`（otelcol-contrib + Jaeger）或 `--target=gcp` 一键搭建 | https://geminicli.com/docs/cli/telemetry/ | 高 | 否 |
| Qwen Code 最初基于 Gemini CLI v0.8.2 fork，现已显著演进：支持 OpenAI/Anthropic/Gemini/Qwen 多协议 API 及第三方/本地模型（Ollama/vLLM），并原生支持 ACP（可被 Claude Code、Codex 等通过 ACP 委派任务）与 headless 模式 | https://github.com/QwenLM/qwen-code | 高 | [已交叉验证]（GitHub README 与多篇文档一致提及 fork 关系与多协议支持） |
| Qwen Code headless CLI 参数：`-p/--prompt` 触发、`--continue` 恢复最近会话、`--resume [sessionId]` 恢复指定会话、`--output-format text\|json\|stream-json`、`--approval-mode plan\|default\|auto-edit\|auto\|yolo`、`--max-session-turns`、`--max-wall-time`、`--max-tool-calls` 等预算/安全控制参数 | https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/ | 高 | 否 |
| Kimi CLI（MoonshotAI/kimi-cli）已进入迁移期，官方 README 明确"Kimi CLI is evolving into Kimi Code CLI（MoonshotAI/kimi-code）"，旧项目将逐步停用；新项目提供 `kimi acp`（ACP server 子命令）与 `kimi mcp`（MCP 服务器管理子命令），ACP 场景下经 IDE 以 JSON-RPC over stdio 拉起子进程 | https://github.com/MoonshotAI/kimi-cli （README） , https://moonshotai.github.io/kimi-code/en/guides/ide s | 高 | [已交叉验证]（GitHub README 迁移声明 + 官方新文档站一致） |
| iFlow CLI（iflow-ai/iflow-cli）官方已宣布停运：维护于 2026-03-20 结束，服务于 2026-04-17（北京时间）正式关停，官方建议迁移至 Qoder；这意味着截至评测时（2026-09-04）iFlow CLI 已下线，不宜作为长期可靠候选引擎 | https://linux.do/t/topic/1786495 , https://platform.iflow.cn/en/cli/changelog | 中高（社区帖 + 平台变更日志二次确认，未直接抓取官方停运公告原文） | [已交叉验证]（两个独立来源都指向同一时间线） |

## 架构与工作原理

**Gemini CLI** 是 Google 官方开源的终端 AI agent（`google-gemini/gemini-cli`），采用 Node.js/TypeScript 实现，核心逻辑拆分为 `@google/gemini-cli`（CLI/UI 层）与 `@google/gemini-cli-core`（引擎/工具调度层，npm 上独立发布，便于被其它项目复用或 fork，Qwen Code 正是复用了这套 core）。运行形态有三种：
1. **交互式 TUI**（默认，终端全屏界面，含审批弹窗）；
2. **Headless（无头）模式**：非 TTY 环境或显式传 `-p/--prompt` 时自动切入，适合脚本/CI 场景；
3. **ACP server 模式**（`--experimental-acp`）：作为 ACP agent server，通过 stdio + JSON-RPC 2.0 被 Zed、IntelliJ（经由社区/官方 ACP 插件）等编辑器作为子进程拉起，双方在同一协议下交换会话状态、工具调用与权限请求。

三种模式共享同一套底层 core（工具注册表、Policy Engine、上下文管理器 GEMINI.md、MCP 客户端），只是"驱动层"不同——这正好印证了我们"网关稳定、引擎内部多形态输出面"的设计思路：ACP 和 headless-JSON 可以视为同一 core 暴露的两种不同粒度的"遥测/控制协议"。

**Qwen Code**（`QwenLM/qwen-code`）是阿里通义千问团队基于 Gemini CLI v0.8.2 的 fork，之后独立演进，保留了 Gemini CLI 的整体架构骨架（headless/ACP/hooks/policy 等概念基本对齐），但把模型接入面从 Gemini 专属扩展为多协议（OpenAI 兼容、Anthropic 兼容、Gemini 原生、Qwen 专有），因此对我们"内部部署模型必须走 OpenAI/Anthropic 兼容端点"的硬约束天然友好。

**Kimi CLI / Kimi Code CLI**（`MoonshotAI/kimi-cli` → 迁移至 `MoonshotAI/kimi-code`）是月之暗面官方 CLI agent，早期版本主打与 Zed 等编辑器的 ACP 集成（有独立的 `kimi-code-zed-extension` 仓库）；新一代 `kimi-code` 强调"ACP 优先"的设计——`kimi acp` 子命令让其直接作为 ACP server 运行，供任意 ACP 客户端驱动，同时提供 `kimi mcp` 子命令族用于管理 MCP 服务器连接。因为项目正处于 kimi-cli → kimi-code 的迁移期，架构细节（尤其是 headless JSON 协议、agent 定义格式）在两代之间可能不完全一致，需要在真正接入前以当时最新的 `kimi-code` 文档为准。

**iFlow CLI**（`iflow-ai/iflow-cli`，心流开放平台/阿里生态相关项目）架构与 Gemini CLI 系同源（JS/TS、插件化工具系统、MCP 客户端、多模态输入），支持接入 Kimi K2、Qwen3 Coder、DeepSeek v3 等多种模型（通过 OpenAI 协议兼容层）。但**该项目已被官方宣布停运**（维护截止 2026-03-20，服务于 2026-04-17 关停，官方导流至 Qoder），截至本报告撰写时（2026-09-04）应已处于不可用/不再更新状态，因此不建议将其作为比赛的正式候选引擎，仅作为"曾经存在的中文 CLI 生态"背景记录。

## 可编程接入面

### Gemini CLI
- **Headless CLI**：`gemini -p "<prompt>" --output-format json|stream-json`；`stream-json` 输出 JSONL，事件类型含 `init`（会话元数据）、`message`（用户/助手消息块）、`tool_use`（工具调用请求）、`tool_result`（工具执行结果）、`error`、`result`（最终聚合统计）。退出码 0/1/42/53 分别对应成功/一般错误/输入错误/超回合限制。
- **ACP 模式**：`gemini --experimental-acp`，stdio 上跑 JSON-RPC 2.0，遵循 Agent Client Protocol（Zed 定义的开放协议），可传输会话初始化、prompt、工具调用与批准请求、流式内容更新等消息——概念上与本赛题网关规范的 SSE 事件（`message.part.updated`、`permission.asked` 等）高度同构，只是载体是 JSON-RPC 而非 SSE + REST。
- **MCP**：作为 MCP client 接入外部工具/数据源，配置在 `settings.json` 的 `mcpServers` 字段（stdio/http/sse transport），并可被 Policy Engine 按 `mcpName` 精细授权。
- **A2A（Agent2Agent）**：`RemoteAgentInvocation` 工具类型，`agents.toml` 中声明 `kind = "remote"` 的远程 agent，`contextId`/`taskId` 维持跨轮状态；官方讨论中提出 A2A 未来会成为 Gemini CLI 所有互连场景的标准协议（含本地 subagent 与远程 agent 的统一寻址方式）——这对我们评估"网关是否要支持 A2A 作为跨引擎/跨会话互通协议"具有参考价值。
- **Extensions**：`extensions/` 目录下每个扩展可携带 `policies/*.toml`（策略）、`hooks/hooks.json`（生命周期钩子）、`agents/*.md`（subagent 定义）、MCP server 声明等，形成"声明式资产包"，接近我们设想的"统一 AI 资产/插件模型"。

### Qwen Code
- Headless：`qwen -p "<prompt>" --output-format text|json|stream-json`，另有 `--input-format text|stream-json`（支持流式喂入多轮 prompt）、`--include-partial-messages`（stream-json 下暴露增量 token 事件）。
- **会话恢复**：`--continue`（续接最近一次项目会话）、`--resume [sessionId]`（按 ID 恢复指定会话）——这是与赛题网关"GET/DELETE /session/{id}"语义直接对应的能力，比 Gemini CLI 原生 headless 更贴近我们需要的"可寻址 session"模型。
- **审批模式**：`--approval-mode plan|default|auto-edit|auto|yolo`，与 Claude Code、opencode 等的审批分级模式概念一致，可映射为网关的 permission 策略参数。
- **预算控制**：`--max-session-turns`、`--max-wall-time`（支持 `90`/`30s`/`5m`/`1h` 等时长写法）、`--max-tool-calls`，适合网关层做超时/成本兜底。
- JSON 输出结构示例（数组形式，非单对象）：
```json
[
  { "type": "system", "subtype": "session_start", "session_id": "...", ... },
  { "type": "assistant", "message": { "content": [...] } },
  { "type": "result", "subtype": "success", "result": "...", "usage": {...} }
]
```
- ACP：同样支持作为 ACP server 被外部 agent（Claude、Codex 等）以子代理身份调用。

### Kimi CLI / Kimi Code
- `kimi acp`：以 ACP server 模式启动，IDE 通过 JSON-RPC over stdio 驱动；ACP 场景下声明的 MCP server 会被转发，但官方文档明确指出"ACP transport 的 MCP servers 会被静默丢弃"（即 ACP 通道不支持 MCP over ACP-transport，需改用 stdio/http/sse transport）——这是接入时必须注意的坑。
- `kimi mcp`：MCP 服务器的增删查改与授权管理子命令。
- Headless/独立 HTTP server 模式的官方文档未在检索到的页面中明确给出字段级细节（未确认，需要在实际接入前进一步查阅 `kimi-code` 最新文档或源码）。

### iFlow CLI
- 支持 MCP client、多模态输入（Ctrl+V 粘贴图片）、会话历史保存与回滚，底层通过 OpenAI 协议兼容层接入 Kimi K2、Qwen3 Coder、DeepSeek v3 等模型。因项目即将/已经停运，未进一步深挖其 headless JSON 协议细节字段（性价比低，不建议作为候选）。

## 会话模型

- Gemini CLI 原生 CLI 会话生命周期以进程为界，`/chat save|resume <tag>` 提供跨会话的手动检查点/分支能力，但**未在官方 headless 文档中发现类似 `--resume <sessionId>` 的无头会话恢复参数**（未确认——如需在网关中实现"同一 session id 多轮 prompt_async 调用"，可能需要额外验证 Gemini CLI headless 是否支持通过某种方式持久化并恢复会话状态，或者退化为"每轮都带上前文 history 重新构造 prompt"）。
- Qwen Code 在这方面走得更远：`--continue`/`--resume [sessionId]` 提供了显式的、可寻址的会话恢复机制，输出中也携带 `session_id` 字段，与赛题网关"POST /session → session id → 多次 prompt_async"的模型契合度更高。
- Checkpointing（自动文件快照）与 Chat 检查点是两套独立系统：前者面向"代码变更可回滚"，后者面向"对话状态可分支/恢复"，网关如果要暴露"回滚"能力，需要分别对接。
- Kimi CLI/iFlow CLI 的会话恢复机制未在可信来源中获得字段级细节（未确认）。

## 权限与安全

- Gemini CLI 的 Policy Engine 是本调研中发现的**最精细的开源权限模型**之一：三态决策（allow/deny/ask_user）、多维匹配（工具名通配符、参数正则、shell 命令前缀/正则、MCP server 名、subagent 归属、工具注解如 `readOnlyHint`、交互/非交互环境），以及分层优先级（`tier_base + toml_priority/1000`，Admin > User > Default）。**关键约束**：`ask_user` 在无头/非交互模式下自动降级为 `deny`——这意味着若网关跑在纯 headless 场景下（本赛题的批量评测环境很可能是这种），Gemini CLI 侧任何配置为"需要用户确认"的工具都会被直接拒绝执行，网关若想支持"批准/拒绝"这类交互（对应赛题的 `POST /permission`），必须要么把 Gemini CLI 切到 ACP 模式（ACP 协议本身有 `session/request_permission` 之类的审批消息），要么在 Policy Engine 层面把相关规则显式设为 `allow` 并靠网关自己的权限层做二次把关。
- Policy 配置文件支持 Windows 路径（`C:\ProgramData\gemini-cli\policies`），说明 Gemini CLI 官方本身就考虑了 Windows 部署，这对本赛题"评测环境为 Windows"的硬约束是利好信号。
- Qwen Code 的 `--approval-mode` 分档（plan/default/auto-edit/auto/yolo）比 Gemini CLI 的三态 Policy Engine更粗粒度但更易于网关快速映射（可以直接把网关的"权限级别"参数一一对应到这五档）。
- Kimi CLI 在 ACP 场景下审批体验存在已知问题：官方 issue 提到"YOLO 模式在 ACP/Zed 场景不受支持，API 报错时静默失败"（GitHub Issue #1542），说明其 ACP 权限透传尚不成熟，接入时需做好错误兜底测试。

## 扩展机制与资产

- Gemini CLI Extensions 是最系统化的资产模型：一个扩展目录可以同时携带 `policies/*.toml`（策略规则）、`hooks/hooks.json`（生命周期钩子，用于拦截/改写 CLI 行为）、`agents/*.md`（subagent 定义）、MCP server 声明、以及（historically）自定义 slash command。这套"目录约定 + 声明式清单"的设计非常接近我们想要的"统一 AI 资产/插件模型"的雏形，可以作为设计参照。
- Qwen Code 沿用 Gemini CLI 的扩展体系，并额外支持"Aliyun Model Studio CLI"路线的扩展（图片/视频生成、知识检索、应用编排、模型部署），但这些是阿里云生态专属能力，不具通用性。
- Kimi Code 的资产/插件市场概念是"skills、MCP servers、data sources"三类，可以从"marketplace 或任意 GitHub 仓库"安装，且明确要求"安装前展示 trust level"——这是一个值得借鉴的安全 UX 细节：资产接入前先展示信任等级。
- GEMINI.md（以及 Qwen Code 对应的类似文件）构成"分层项目上下文"（全局 → 项目 → 子目录），是我们"记忆"章节要讨论的核心机制。

## 记忆

- Gemini CLI 的记忆/上下文注入机制核心是 **GEMINI.md 分层上下文文件**：按目录层级（用户全局 `~/.gemini/GEMINI.md` → 项目根 → 子目录）合并加载，作为系统提示的一部分注入模型上下文，类似 Claude Code 的 CLAUDE.md、opencode 的 AGENTS.md。这是一种"静态文件型记忆"，不同于 Hermes/自进化类引擎可能具备的"运行时可写记忆库"。
- Qwen Code 大概率延续同一机制（未逐字确认文件名是否仍为 GEMINI.md 或改名，需在实际接入前核实——**未确认**）。
- Kimi CLI / iFlow CLI 的对应记忆文件命名与合并规则未在本次检索中取得一手确认（未确认）。
- 对我们架构的意义：这类"Markdown 上下文文件"可以统一归入网关的"AI 资产模型"中的『记忆/项目说明』资产类型，接入新引擎时只需要做"文件名 + 加载层级"的映射配置（如 `GEMINI.md` vs `CLAUDE.md` vs `AGENTS.md`），无需改变网关对上层业务暴露的记忆接口。

## 多 Agent 与协作

- **Subagents**（Gemini CLI / 大概率 Qwen Code 同源）：预览特性，通过 `agents/*.md` 定义，核心价值是"工具隔离"（每个 subagent 只能访问被授权的工具子集，避免全局工具注册表污染、降低误操作面）与"细粒度权限"（Policy Engine 可按 `subagent` 字段单独授权）。这是一种**单进程内、树状委派**的多 agent 模型，委派对象仍在同一 core 内运行。
- **A2A 远程委派**：Gemini CLI 通过 `RemoteAgentInvocation` + `agents.toml` 中 `kind="remote"` 支持把任务代理给**进程外/网络外**的远程 agent（如部署在 Google Agent Engine 上的服务），用 `contextId`/`taskId` 维持跨调用状态，认证走 Google ADC 或 A2A 安全规范定义的其它方式。这是"树状委派"之外的第二种协作模型——**跨进程/跨网络的 agent-to-agent 调用**，概念上接近赛题里"room"/"agent team"这类扩展能力，可以视为 Gemini CLI 生态对多 agent 协作给出的答案。
- 官方讨论中提出要把 A2A 定为 Gemini CLI 所有集成的统一标准协议（RFC 阶段，非最终态），意味着这块能力还在快速演进中，接入时应做好协议版本适配的准备。
- Kimi CLI / iFlow CLI 在检索范围内未发现明确的多 agent/团队协作原生机制（未确认，可能存在但未被搜索命中）。

## 可观测性

- Gemini CLI 的 OTel 集成是本次调研中**最标准化**的可观测方案：通过 `.gemini/settings.json` 的 `telemetry` 对象（工作区 > 用户 两级配置优先级，CLI flag 可临时覆盖），支持 OTLP/gRPC 或 OTLP/HTTP（`--telemetry-otlp-protocol`），可对接任意 OTel 后端（Jaeger、Prometheus、Datadog、Google Cloud）。官方提供一键脚本：`npm run telemetry -- --target=local`（本地起 otelcol-contrib + Jaeger UI）或 `--target=gcp`（转发到 Google Cloud）。这与我们"统一可观测协议（归一化各引擎日志/埋点/事件）"的目标高度契合——**Gemini CLI 系是候选引擎中唯一明确采用 OTel 标准（而非自定义日志格式）做遥测的**，网关侧可以直接订阅其 OTLP 输出并转换/合并进统一观测管道，而不必解析私有日志格式。
- headless 的 `stream-json` 事件流（`init/message/tool_use/tool_result/error/result`）本身也可以作为"应用层可观测事件"的来源，与 OTel 的"基础设施层可观测（span/trace/metric）"形成互补——网关做统一事件归一化时，二者都值得纳入。
- Qwen Code / Kimi CLI / iFlow CLI 的 OTel/遥测细节未在本次检索中获得一手资料确认（未确认，Qwen Code 大概率继承 Gemini CLI 的 telemetry 配置骨架，但字段是否完全一致需要实测核实）。

## 对我们架构的启示

### 公共能力 vs 扩展能力映射表

| 能力 | 归类 | 说明 / 归一化建议 |
|---|---|---|
| headless prompt 执行（`-p` + JSON/stream-JSON 输出） | 公共能力 | 可直接映射为网关 `POST /session/{id}/prompt_async` + `GET /session/{id}/message`；`stream-json` 的 `tool_use/tool_result` 事件对应网关轨迹里的 tool call/tool result，`result`(finish) 对应 `finish=stop` |
| 会话可寻址恢复（`--resume sessionId`，Qwen Code 有，Gemini CLI headless 层面未确认） | 公共能力（引擎实现程度不同） | 网关的 session 映射层应做兼容层：对不支持无头恢复的引擎（如目前的 Gemini CLI headless），退化为"网关自持完整历史，每轮重新拼接 prompt"或改走 ACP 模式维持进程常驻 |
| MCP client 支持 | 公共能力 | 三家（Gemini CLI/Qwen Code/Kimi CLI/iFlow CLI）均支持，是最容易归一化的扩展点；但 transport 支持面不完全一致（Kimi CLI 的 ACP 通道不支持 MCP over ACP-transport），接入时需按 transport 逐一验证 |
| 权限确认（headless 下 `ask_user`→`deny`，ACP 下走协议原生审批消息） | 公共能力，但实现方式因传输而异 | 网关若要支持真实的"运行中批准"（对应赛题 `/permission` 接口），headless CLI 模式基本不可行（自动拒绝），必须优先考虑 ACP 模式或引擎自带的 server/daemon 模式（若有），否则只能退化为"预先在 Policy Engine 层放行"的静态策略 |
| Policy Engine（细粒度工具级授权：allow/deny/ask_user + 多维匹配 + 分层优先级） | 引擎特有扩展能力（Gemini CLI 系最完整） | 网关的"权限限制"需求可以直接借鉴其匹配维度（工具名/参数正则/命令前缀/MCP名/subagent/环境）作为归一化"权限策略 DSL"的设计参考；接入 Gemini CLI/Qwen Code 时可把网关侧的群/业务权限策略编译为等价的 `.toml` policy 文件放入对应 tier 目录 |
| Subagents（进程内工具隔离型委派） | 引擎特有扩展能力 | 归入赛题所说"agent team"类可选高级能力；接入参数：是否存在 `agents/` 目录、agent 定义 `.md` 的字段（名称/描述/可用工具/系统提示） |
| A2A 远程 agent 委派 | 引擎特有扩展能力（仍在 RFC/早期阶段） | 可作为跨引擎/跨会话协同的候选标准协议，但目前不成熟，短期不建议作为架构强依赖；可标记为"未来可插拔的协作协议后端" |
| ACP（Agent Client Protocol） | 引擎特有扩展能力，但呈现"事实标准化"趋势（Gemini CLI/Qwen Code/Kimi CLI/OpenCode 均支持） | 值得作为网关到引擎的**备选传输协议**：当引擎的 headless JSON 协议无法满足"会话常驻 + 实时审批"需求时，网关可改用 ACP client 身份连接引擎的 ACP server（stdio + JSON-RPC），把 ACP 消息映射到网关自己的 SSE 事件与 REST 接口上 |
| OTel 可观测集成 | 引擎特有扩展能力（Gemini CLI 系目前最规范） | 建议网关的统一可观测层优先支持"消费 OTLP"作为归一化输入源之一，天然兼容 Gemini CLI/Qwen Code；对不支持 OTel 的引擎（如目前证据不足的 Kimi/iFlow），仍以 headless stream-json/自定义日志兜底 |
| GEMINI.md 分层记忆文件 | 公共能力（各引擎均有等价物，命名不同） | 归一化为网关"记忆资产"类型，接入新引擎时只需配置"文件名 + 加载层级规则"的映射表（GEMINI.md/CLAUDE.md/AGENTS.md/...） |

### 接入参数（新引擎接入清单示例，以 Gemini CLI / Qwen Code 为例）

- 可执行文件路径 + 启动子命令（`gemini` vs `qwen`）
- 认证方式（Gemini：Google 登录/API Key/Vertex AI；Qwen Code：OpenAI/Anthropic/Gemini/Qwen 兼容端点 API Key 或 base_url，天然贴合"内部部署模型自定义端点"约束——**优先建议：Windows 环境下优先接入 Qwen Code 而非原生 Gemini CLI**，因为 Qwen Code 对自定义 OpenAI/Anthropic 兼容端点的支持是一等公民，而 Gemini CLI 原生更偏向 Google 自家认证体系）
- 驱动模式选择：headless（`-p --output-format stream-json`）或 ACP（`--experimental-acp` / `qwen --experimental-acp` 等价参数，需核实 Qwen Code 是否用同名 flag——**未确认**，需实测）
- 会话恢复能力探测：是否支持 `--resume <id>`（Qwen Code 有，Gemini CLI 无头层面未确认）
- 权限模式映射：网关权限级别 → 引擎的 approval-mode（Qwen Code：plan/default/auto-edit/auto/yolo）或 Policy Engine 规则文件（Gemini CLI）
- 工作目录/项目上下文：对应网关 `POST /session {directory}` 参数，映射为引擎的 cwd + GEMINI.md 加载起点
- 超时/预算参数映射：`--max-wall-time`、`--max-tool-calls`、`--max-session-turns` 可直接对应网关侧的"轮次/时长/工具调用预算"限制，实现"鲁棒性"要求的兜底

### 风险与坑

1. **iFlow CLI 已官方停运**（2026-04-17 关停），不应作为比赛的正式候选引擎接入，避免因维护中断导致赛前不可用。
2. **Kimi CLI 正处于向 Kimi Code 迁移期**，两代产品的 CLI flag、协议细节可能不完全兼容，接入前必须以当时最新的 `kimi-code` 官方文档/源码为准，不能照搬旧版 `kimi-cli` 的资料。
3. **Gemini CLI headless 模式下审批被强制降级为 deny**，如果比赛的 Windows 办公任务（如"递归删除文件""发送即时通讯消息"）需要真实的运行时审批交互（对应赛题 `/permission` 接口），单纯用 headless CLI 包一层可能无法真正跑通"批准/拒绝"语义，需要验证是否要切到 ACP 模式或该引擎是否存在独立的 daemon/server 模式（本次检索未发现 Gemini CLI 有类似 opencode `server` 的常驻 HTTP 服务模式——**未确认，需要专门核实**，如果没有，则网关适配层需要自己维护"允许列表"策略而不能依赖运行时用户交互）。
4. **Windows 兼容性**：Gemini CLI 官方 Policy Engine 文档明确列出了 Windows 专属管理员策略路径（`C:\ProgramData\gemini-cli\policies`），说明官方对 Windows 部署有一定考虑，但 headless/ACP 模式在 Windows 原生环境下的稳定性（子进程管理、路径处理、编码问题等）仍需实测验证，检索未找到官方针对 Windows 的专项踩坑记录（未确认）。
5. **ACP 协议本身仍在演进**（Zed 定义、多个引擎陆续接入），版本兼容性、消息集合可能随各引擎更新而变化，网关如果把 ACP 作为统一传输层之一，需要做好协议版本探测与降级处理。

## 未解决问题

1. Gemini CLI 的官方 headless CLI 是否原生支持 `--resume <sessionId>` 一类的无头会话恢复（本次未在一手文档中确认，只确认了交互式 `/chat resume <tag>`）？
2. Gemini CLI / Qwen Code 是否存在类似 opencode 的常驻 HTTP server 模式（而非仅 CLI 单次调用 + ACP stdio）？这直接决定能否以"长驻进程 + REST/SSE"的方式对接赛题网关规范，还是必须由网关自己维护进程池并通过 stdio/ACP 桥接。
3. Qwen Code 的 ACP 支持是否使用与 Gemini CLI 完全相同的 `--experimental-acp` flag，还是有独立命名？
4. Kimi Code 的 headless/无 IDE 场景下的编程接入面（JSON 输出协议、退出码、错误处理）具体字段是什么？本次检索只确认了 ACP 与 MCP 管理子命令，未获得 headless JSON schema 一手资料。
5. Qwen Code、Kimi Code 是否支持 OpenTelemetry 或类似的标准化可观测协议？
6. iFlow CLI 停运后，其残留代码/文档是否仍可作为参考架构学习（例如其多模型路由设计），还是应完全排除在候选之外？

## 来源列表

- https://github.com/google-gemini/gemini-cli
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
- https://geminicli.com/docs/cli/headless/
- https://geminicli.com/docs/cli/acp-mode/
- https://zed.dev/acp/agent/gemini-cli
- https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/policy-engine.md
- https://geminicli.com/docs/reference/policy-engine/
- https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md
- https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md
- https://developers.googleblog.com/subagents-have-arrived-in-gemini-cli/
- https://geminicli.com/docs/cli/checkpointing/
- https://geminicli.com/docs/cli/session-management/
- https://geminicli.com/docs/cli/telemetry/
- https://github.com/google-gemini/gemini-cli/pull/16013
- https://github.com/google-gemini/gemini-cli/discussions/7822
- https://geminicli.com/docs/core/remote-agents/
- https://github.com/QwenLM/qwen-code
- https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
- https://github.com/MoonshotAI/kimi-cli
- https://github.com/MoonshotAI/kimi-code
- https://moonshotai.github.io/kimi-code/en/guides/ides
- https://github.com/MoonshotAI/kimi-cli/issues/1542
- https://github.com/iflow-ai/iflow-cli
- https://platform.iflow.cn/en/cli/changelog
- https://linux.do/t/topic/1786495
