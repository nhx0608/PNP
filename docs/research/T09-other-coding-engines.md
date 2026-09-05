# T09 其他主流编码引擎接入面速览（Goose、Aider、Cline、Roo/Kilo、Amp、Cursor CLI、Copilot CLI/SDK、Droid、Crush、Auggie）

## 摘要
本专题调研了 Goose、Aider、Cline、Kilo Code（Roo Code 后继/关联品牌）、Amp、Cursor CLI、GitHub Copilot CLI/SDK、Factory Droid、Charm Crush、Auggie 十个非"一线三强"（Claude Code/Codex/Gemini CLI）编码引擎的可编程接入面。核心发现：(1) ACP（Agent Client Protocol，Zed 发起的开放标准）正在成为事实上的收敛点，Goose 2.0 已把全部客户端统一到 ACP 并计划废弃自建 REST+SSE server（goosed），Kilo Code 原生内置 `kilo acp`；但 Amp、Crush 尚未原生支持，只能靠第三方桥接或仍在讨论中。(2) 除 ACP 外，大多数引擎各自定义 headless JSON/NDJSON 输出协议，其中 Amp 的 `--stream-json` 与 Claude Code 协议兼容、Cursor CLI 与 Factory Droid 的事件 schema 也高度相似（system/assistant/tool_call 三段式），说明"Claude-Code 兼容 JSONL"事实上已是第二个隐性收敛点。(3) 权限模型颗粒度差异很大，从 Goose 的四态（auto/approve/smart_approve/chat，含 LLM 分类器）到 Cline 的任意脚本网关（`--hook-command`），建议归一化只取"自动执行 vs 需确认"两档公共基线，细粒度模式作为引擎扩展参数保留。(4) 扩展/资产格式上，Goose Recipe（YAML：指令+extensions+参数）、Cline Workflows/MCP Marketplace/Hooks、Crush 对 `AGENTS.md` 的原生支持，都是我们设计统一 AI 资产模型时值得参考的具体范式。(5) 多数引擎已证实支持自定义 OpenAI/Anthropic 兼容端点或 BYOK（Copilot SDK、Cursor、Amp 均有一手证据），满足赛题"内部部署模型"的硬约束。本报告标注了 6 项需要在正式接入前二次核实的未解决问题，尤其是 Crush 的 ACP 合并状态与 Amp 官方 execute-mode 文档（被登录墙拦截未能直接抓取）。

## 关键事实（表格）

| # | 事实 | 来源 | 置信度 | 交叉验证 |
|---|------|------|--------|----------|
| 1 | Goose 项目治理已于 2026 年 4 月从 Block 转移给 Agentic AI Foundation (AAIF)，仓库现为 `aaif-goose/goose`（原 `block/goose` 仍存在但为旧组织） | github.com/block/goose Discussion #7309；aaif.io blog | 高 | 是（Wikipedia + aaif.io 两来源） |
| 2 | Goose 2.0 架构从"desktop 走 goosed（自定义 REST+SSE）、CLI 走进程内调用"统一为全部客户端通过 **ACP (Agent Client Protocol)** 连接，Phase 4 计划移除旧 goosed 与旧 Rust CLI | goose-docs.ai blog 2026-04-08 "goose 2.0 beta" | 高 | 是（同页 + Discussion #4645 "Adopt ACP"） |
| 3 | Goose 提供 `goose-acp-server`，用 ACP 包装 Agent，已被 Zed、JetBrains 系 IDE 采用为 ACP agent | zed.dev/acp/agent/goose；aaif.io blog | 高 | 是 |
| 4 | Kilo Code CLI 原生支持 `kilo acp` 子命令，启动一个 ACP server（ndjson over stdio，也支持 --port/--hostname/mDNS 网络模式），官方文档明确将 Kilo 列为与 Hermes、Devin、Kimi CLI 并列的 ACP agent | kilo.ai CLI reference；kilo.ai docs | 高 | 是（Zed acp/agent/kilo 页 + kilo.ai 文档） |
| 5 | Amp 的 `-x`（execute/headless）模式 + `--stream-json` 输出采用与 **Claude Code 兼容的 JSONL 协议**（type 字段区分 system/assistant/tool_use 等），并用 `amp threads continue [thread]` 做跨进程多轮会话 | littlebearapps.com "AMP --stream-json cheatsheet"；ampcode.com/news/streaming-json | 中高 | 部分（未能直接抓取官方页，来自搜索摘要+第三方 cheatsheet 交叉） |
| 6 | Amp 官方**不**原生支持 ACP；社区/第三方项目（如 SuperagenticAI 的 `acp-amp`）以桥接方式把 Amp 包装成 ACP agent，且该桥接要求付费 Amp 额度（免费额度不可用） | github.com/SuperagenticAI/acp-amp；medium.com Superagentic AI | 高 | 是（npm 包页 + GitHub README 一致描述） |
| 7 | GitHub Copilot SDK（`@github/copilot-sdk`）2026-06-02 正式 GA，是 Copilot CLI 的同一运行时对外暴露的库，通过 JSON-RPC 与 Copilot CLI 通信，支持 OpenTelemetry 追踪与 BYOK（OpenAI、Microsoft Foundry、Anthropic、Ollama、任意 OpenAI 兼容端点） | github.blog changelog 2026-06-02；docs.github.com BYOK | 高 | 是（changelog + docs.github.com BYOK 页两来源一致） |
| 8 | Cline 于 2026-02-13 完成 CLI 全新重写（IDE 侧边栏 → 独立终端 CLI），支持 `--json` 无头输出、`--auto-approve true` 全自动、`--hook-command` 策略钩子网关每次工具调用、`cline schedule create --cron` 定时任务、`--team-name` 多 agent 协作（共享任务看板/agent 间邮箱） | cline.bot/cli；toolsbase.dev cheat sheet | 中高 | 部分（官方页 + 第三方 cheat sheet 描述一致） |
| 9 | Cursor CLI（`cursor-agent -p`）headless print 模式支持 `--output-format text\|json\|stream-json`；stream-json 为 NDJSON，含 system(session_id/model/cwd)、assistant(text delta)、tool_call(started/completed) 等事件类型 | cursor.com/docs/cli/headless；cursor.com/docs/cli/reference/output-format | 高 | 是（两个官方文档页交叉一致） |
| 10 | Factory Droid 的 headless 模式 `droid exec` 支持 `--stream-jsonrpc` 使其可作为 ACP adapter 的后端（第三方 `droid-acp` 项目），支持 session 持久化（`droid.load_session` 恢复会话）及 text/json/stream-json/stream-jsonrpc 多种输出格式 | docs.factory.ai/droid-exec/overview；github.com/yaonyan/droid-acp | 中高 | 部分（官方文档 + 第三方适配器 README） |
| 11 | Charm Crush 使用 **FSL-1.1-MIT**（非 OSI 批准的开源许可，Functional Source License，2 年后转 MIT）而非纯 MIT/Apache，社区正在讨论/开发原生 ACP 支持（issue #990、#2091、discussion #988），截至检索时尚未确认已合并进 main | github.com/charmbracelet/crush licenses；GitHub issues #990/#2091/#988 | 高（许可证部分）；中（ACP 状态部分，issue 讨论中未见"已完成"字样） | 否（ACP 状态仅单一来源，需以官方 CHANGELOG 复核） |
| 12 | Aider 无原生"server/session ID"概念，脚本化依赖 CLI 参数 `--message`（一次性指令，改完退出）或 Python `Coder` 类库；无头 CI 用法为 `--message + --yes-always`（跳过确认）+ `--auto-test --test-cmd` 自愈；会话历史落盘为按工作目录区分的 chat history 文件，非独立 session/thread 对象 | aider.chat/docs/scripting.html；GitHub issue #4923 | 高 | 是（官方文档 + issue 讨论一致） |
| 13 | Auggie CLI（Augment Code）headless 用 `--print --quiet`，支持作为 MCP server 反向暴露 codebase-retrieval 工具给其他 agent（Claude Code/Cursor 等），2026-02 起的 0.16.0 版本加入 MCP 日志流与 token 变量展开 `${augmentToken}` | augmentcode.com/changelog；augmentcode.com/product/cli | 高 | 部分（官方 changelog + 官方产品页） |

## 架构与工作原理

这十个引擎大致分三代架构范式：

1. **原生服务化 + 已收敛到 ACP**：Goose 是最典型的代表。2.0 之前是"desktop 走自建 `goosed`（Axum REST+SSE，103 个端点，SQLite `sessions.db` 落盘）、CLI 走进程内直连"的双轨架构；2026 年治理转移到 AAIF 后，官方路线图明确"Phase 1 稳定 ACP server（含 session 持久化/extensions/streaming）→ Phase 2 基于 ACP client 的新 TUI → Phase 3 Tauri 桌面替代 Electron → Phase 4 移除旧 goosed 与旧 Rust CLI"，即整个客户端生态统一收敛到 ACP 一个协议、一个 server 形态。Kilo Code 同样原生内置 `kilo acp` 子命令直接起 ACP server（ndjson over stdio，可选 TCP + mDNS）。
2. **自定义 headless JSON 协议，未原生上 ACP，靠第三方桥接**：Amp、Crush 属于此类。Amp 的 `-x --stream-json` 走的是**与 Claude Code 兼容**的 JSONL type-discriminator 协议，官方尚未内置 ACP server，只有社区维护的 `acp-amp`（Python/Node 双实现）把 Amp 包一层 ACP，且限制"仅付费额度可用"。Crush 许可证为 FSL-1.1-MIT（非 OSI 认证），社区在 issue #990/#2091/discussion #988 中持续讨论/实现 ACP client/agent 双向能力，检索时点尚未见"已合并"的权威确认。
3. **纯 CLI headless + SDK 双轨，无独立协议名**：Aider、Cline、Cursor CLI、Copilot CLI/SDK、Droid、Auggie 均以"CLI 参数 + JSON/NDJSON 输出 + （可选）内嵌 SDK/JSON-RPC 库"为主，没有对外声明遵循某个标准协议，各自定义 event schema。其中 Copilot SDK 最规范化：官方声明其"与 Copilot CLI 同一运行时"，通过 **JSON-RPC** 通信并原生集成 OpenTelemetry；Droid 的 `--stream-jsonrpc` 输出格式则被第三方 `droid-acp` 项目直接拿来做 ACP adapter 的传输层，说明其消息结构已经足够接近 JSON-RPC 风格，可以"翻译"成 ACP，而不需要引擎自身声明支持。

## 可编程接入面

| 引擎 | CLI headless | JSON/NDJSON 事件 | Server/SDK | ACP |
|---|---|---|---|---|
| Goose | `goose run` | 是（`goosed` REST+SSE，将被替换） | `goose-server`(goosed, Axum, WS+HTTP)；无官方多语言 SDK | 原生 `goose-acp-server`，官方主推方向 |
| Aider | `aider --message "..."` 一次性；`--message-file` | 弱（无标准 event schema，主要是终端输出/diff） | Python 内部 `Coder` 类可编程调用，非正式对外 SDK | 无 |
| Cline | `cline "prompt" --json --auto-approve true` | 是，`--json` 输出结构化事件 | 官方定位为"SDK、IDE 扩展或 CLI 助手"三形态之一，有 SDK | 未见原生 ACP 声明 |
| Kilo Code | `kilo run --format json` | 是，raw JSON events | 有 `kilo serve`/`kilo daemon` 常驻服务 | 原生 `kilo acp`（ndjson/stdio，支持 --port/--hostname/mDNS/CORS） |
| Amp | `amp -x <prompt> --stream-json` | 是，Claude-Code 兼容 JSONL（system/assistant/tool_use...） | 官方 Python SDK（ampcode.com/manual/sdk/python）；`amp threads continue` 做跨进程续接 | 无原生，靠第三方 `acp-amp` |
| Cursor CLI | `cursor-agent -p "..." --output-format json\|stream-json\|text` | 是，NDJSON（system 含 session_id/model/cwd，assistant text delta，tool_call started/completed） | 无独立公开 server API，但支持 headless 脚本化 | 有专门文档轨"CLI, Headless and ACP"，具体细节需进一步核实 |
| Copilot CLI/SDK | Copilot CLI 本身headless能力 | 是（SDK 事件流） | `@github/copilot-sdk`（多语言：TS/Python/Java），JSON-RPC 与 Copilot CLI 通信，2026-06-02 GA | 未见官方声明 |
| Factory Droid | `droid exec`（headless one-shot） | 是，`--output-format text\|json\|stream-json\|stream-jsonrpc` | 无官方公开 server SDK，但 stream-jsonrpc 可作为 RPC 传输 | 第三方 `droid-acp` 借 `--stream-jsonrpc` 实现 ACP adapter |
| Charm Crush | 交互式 TUI 为主，headless 支持有限 | 未在检索中确认标准 JSON 输出格式 | `crush.json`/`crushrc` 配置文件驱动 | 社区讨论中（issue #990/#2091），未确认已发布 |
| Auggie (Augment) | `auggie --print --quiet` | 结构化输出（可作 MCP server 反向暴露） | 可反向作为 MCP server 供其他 agent 调用 codebase-retrieval | 未见 |

## 会话模型

- **Goose**：Session 是持久化的一等公民，落盘于 SQLite `sessions.db`，字段含对话历史、token 用量、working directory、关联 recipe、provider 元数据、extension 状态；`goose-server` 可并发跑多个 session，某 session 内启用/禁用 extension 不影响其他 session（天然的"会话隔离"范式，与我们要求的群会话隔离高度契合）。
- **Aider**：没有独立 session 对象概念，靠"每个工作目录一份 chat history 文件"模拟连续性；`--message` 模式是一次性调用即退出，不维护常驻进程，多轮对话靠适配层自己在外部维持 chat history 文件路径映射（如 Hermes-agent 场景中"adapter 为每个 workspace channel 维护独立 Aider chat history"）。
- **Cline CLI**：`--continue`/session 恢复能力存在，同时有 `-z` 后台任务与 `--team-name` 多 agent 分组（共享任务看板、agent 间邮箱、mission log），会话模型比其他 CLI 更接近"任务队列 + 团队协作空间"而非单一线性对话。
- **Kilo CLI**：`--session/-s` 续接指定 ID，`--continue/-c` 续接最近一次，`--fork` 从某会话分叉出新会话，`--cloud-fork` 拉取远端 session 到本地续接——分叉语义比大多数引擎更完整。
- **Amp**：以 **thread**（`T-xxxxxxxx` UUID 形式的 `session_id`）为会话单位，`amp threads continue [thread]` 支持跨进程多轮，`/handoff` 可以把 Oracle 生成的计划带入一个新 thread。
- **Cursor CLI**：`stream-json` 的 system 事件里带 `session_id`，暗示每次调用生成/复用一个会话标识，但文档中会话恢复/续接细节需要进一步查证。
- **Droid**：显式提供 `droid.load_session` 恢复既有会话，配合 `--stream-jsonrpc` 的 request/response id 匹配模型，接近 JSON-RPC 长连接会话。
- **Copilot SDK**：`CopilotSession` 是有状态的多轮对话对象，`SendAndWaitAsync`（阻塞到 idle）与 `SendAsync`（fire-and-forget + 事件流）两种调用方式，与题目要求的"`prompt_async` 阻塞直到本轮结束"语义非常接近，值得直接参考其抽象设计。
- **Crush**："maintains multiple work sessions and contexts per project"，配置文件驱动，具体 session API 细节未在公开文档中确认。

## 权限与安全

- **Goose 的四态模型最值得借鉴**：`auto`（无审批直接执行）、`approve`（每个动作都问）、`smart_approve`（用一个专门的 LLM 分类器 PermissionJudge 只对"risky actions"询问，兼顾速度与护栏）、`chat`（只回文本不动手，用于头脑风暴）。通过 `goose config set-mode <mode>` 或环境变量 `GOOSE_MODE=auto` 配置；已知有 issue 反映"cached session 不会热应用新 mode 变更""claude-code provider 下 auto 模式仍反复询问权限"等边界问题，接入时要注意 mode 切换的生效时机与不同底层 provider 的权限钩子是否被正确路由。
- **Cline**：`--auto-approve true` 全自动 + `--hook-command ./policy.sh` 策略钩子——脚本对每次工具调用返回允许/拒绝，可实现"读安全自动过、写需审批、触碰生产环境直接 block"的分级策略，这是我们统一权限模型可以直接映射的形态（脚本化 gate ≈ 我们网关侧 `/permission` 端点）。
- **Cursor CLI / Kilo / Droid**：均以 headless 模式下的"自动批准 vs 交互确认"二态为主，细粒度分级信息在检索中未充分确认，需要进一步查证官方权限文档（存在推测成分，标记为待验证）。
- **Amp**：ACP 桥接功能被限定为仅付费额度可用，暗示其内部权限/计费模型与 session 强绑定，接入时需注意"免费层不可控"的商业限制不是技术限制。
- **Copilot SDK**：认证支持 GitHub OAuth、GitHub Apps、环境 token、BYOK 四种模式，工具调用层面的审批模型细节未在本次检索中深入，需要针对具体版本文档二次确认。

## 扩展机制与资产

- **Goose**：**Extensions**（等价 MCP/插件容器，可在 recipe 中声明启用哪些）+ **Recipes**（YAML 文件，捕获"指令 + 启用哪些 extensions + 用户需要提供的参数"，是把一次多步工作流打包成可复用资产的标准格式，还支持 **Sub-Recipes** 做任务分解）——这套 Recipe 概念本质上就是"预置 workflow + 能力声明"的资产格式，值得作为我们统一"AI 资产/插件模型"设计的重要参照对象。
- **Cline**：MCP Marketplace（一键装 MCP server，stdio/SSE 均支持）+ Workflows（可编排顺序执行或"断项目自动并行"）+ Hooks（策略/审批脚本）+ `cline schedule create --cron` 定时任务——覆盖"扩展、工作流、权限钩子、调度"四类资产，是这批引擎里资产体系最全的一个。
- **Kilo Code**：`kilo mcp add/list/auth` 管理 MCP server（含 OAuth），Modes（Architect/Ask/Debug/Orchestrator/自定义）是"预置角色 Prompt + 工具集"的组合体，可以视为一种轻量 sub-agent 声明方式。
- **Amp**：MCP 自定义工具 + Skills（sidbharath.com 提及）+ Oracle（背后是 GPT-5 驱动的强推理子代理，被官方文档讨论是否可作为主 agent/独立 oracle/普通 subagent 存在，说明其"多种运行角色可切换"的设计思路）。
- **Crush**：Agent Skills（复用 Anthropic 生态的 Skills 概念）+ MCP + repo 级 `AGENTS.md` 初始化文件——是这批里唯一明确"复用 AGENTS.md 标准"的引擎，对我们统一资产格式（如果打算采用 AGENTS.md/SKILL.md 通用规范）有参考价值。
- **Auggie**：MCP 双向能力最突出——既能作为 MCP client 接第三方 server，也能反向把自己的 codebase-retrieval 暴露成 MCP server 给 Claude Code/Cursor 等其他引擎调用，这是"引擎互操作"的一个具体范式（我们网关如果要做"能力互借"，可以参考这种反向 MCP 暴露模式）。

## 记忆

检索到的公开资料里，这十个引擎均未见类似"长期语义记忆库"的独立子系统描述；记忆能力普遍退化为：
- Session/thread 持久化本身（Goose 的 SQLite sessions.db、Amp 的 thread continue、Droid 的 load_session）——即“会话级记忆”，靠恢复完整历史实现连续性，而非摘要式长期记忆；
- 项目级约定文件（Crush 的 `AGENTS.md`）——是"团队/项目记忆"，非模型自动学习的记忆；
- Cline 的 Rules/自定义包（bundle tools+hooks+slash commands+rules）接近"打包好的操作记忆"，但仍是静态配置而非动态学习记忆。
本专题未发现哪个引擎有独立于 session 历史之外的"检索式长期记忆"官方一手证据，如需确认需针对每个引擎单独深挖（列入未解决问题）。

## 多 Agent 与协作

- **Cline** `--team-name`：创建一组 agent，共享任务看板（Kanban）、agent 间邮箱（mailbox）、mission log，是这批里最接近"原生多 agent 协作空间"的设计，且是 CLI 一等公民（cline.bot/cli 首页即以此为卖点，标题"Coding Agents in Your Terminal and on a Kanban Board"）。
- **Amp**：Sub-agents 执行并行任务、结果汇报回主线程；Oracle 作为强推理子代理，可通过 `/handoff` 把上下文带入新 thread，形成"主线程 + 专家子代理"的分层结构。
- **Kilo Code**：Orchestrator Mode 本质上是"由一个模式协调调用其他模式/子任务"的编排入口，但与 Cline 的显式多进程协作团队相比更轻量（单进程内切换模式）。
- **Goose**：并发多 session（每个 session 独立 extension 状态）本身支持"多个 agent 实例并行跑不同任务"，但更接近"隔离的多实例"而非"互相协作通信的多 agent"。
- Aider、Cursor CLI、Droid、Auggie、Crush：公开资料中未见原生多 agent/team 编排能力的一手证据（Cursor 有 Background Agent，但那是云端后台任务而非本地 multi-agent 协作，需要单独核实）。

## 可观测性

- **Copilot SDK**：官方明确内置 **OpenTelemetry** 追踪支持，是本专题十个引擎中唯一在一手资料里明确点名 OTel 的，对标准化可观测协议这条线索最有价值。
- **Amp / Cursor CLI**：靠结构化 stream-json 输出本身承担可观测职责——事件里带 `session_id`/`usage`(input_tokens/output_tokens)/`stop_reason`/`duration`，可以直接被外部采集器解析、归一化为统一 trace。
- **Cline**：`--json` 输出 + CI 场景下的"exit codes you can branch on"，是面向流水线可观测/可编排设计的。
- **Goose**：`goosed` 曾以 REST+SSE 暴露 103 个端点（细粒度但耦合具体实现），2.0 迁移到 ACP 之后的可观测面貌（是否保留独立 telemetry 端点）在检索范围内未获得权威确认，列为待验证。
- 其余引擎（Aider、Kilo、Droid、Crush、Auggie）未见独立 telemetry/OTel 集成的一手资料，多依赖终端输出/日志文件，需要落地时逐个验证。

## 对我们架构的启示

### 公共能力 vs 扩展能力映射表

| 能力 | 是否可归一化为"公共能力" | 归一化方式 | 属于哪些引擎的独有扩展 |
|---|---|---|---|
| 无头/一次性执行（-p/-x/exec/run） | 是 | 统一映射为网关 `prompt_async` | 几乎所有引擎都有 |
| NDJSON/JSONL 事件流 | 是（但 schema 需适配层归一化） | 统一转换成赛题要求的 message 轨迹（user/assistant/tool call/tool result/step-finish） | Amp（Claude-Code 兼容 schema，转换成本最低）、Cursor CLI、Kilo、Droid |
| 会话续接（resume/continue/session id） | 是 | 映射为网关 session→引擎 session/thread id 的持久化表 | Kilo（fork/cloud-fork 是扩展语义，需单独适配） |
| 权限分级审批 | 部分可归一化（allow/deny 二态是公共基线） | 细粒度模式（Goose 四态、Cline 脚本网关）作为"引擎扩展能力"暴露给上层，公共层只取"自动/需询问"两档 | Goose smart_approve（LLM 分类器）、Cline hook-command 是各自独有扩展 |
| MCP 扩展 | 是 | 直接复用 MCP 协议做统一插件总线 | 所有引擎基本都支持，是天然的公共能力锚点 |
| Recipe/Workflow 资产 | 部分可归一化 | 统一资产格式建议参考 Goose Recipe（YAML: instructions+extensions+params）与 Cline Workflows 的交集设计 | Goose Recipes、Cline Workflows/Schedule 各有专属字段 |
| 多 Agent/Team | 否（差异极大，不建议在 v1 归一化） | 作为"引擎特有扩展能力"单独声明并透传配置参数 | Cline Team、Amp Oracle+Subagents、Kilo Orchestrator Mode 语义完全不同 |
| ACP 协议本身 | 是（作为可选传输适配层） | 对已支持 ACP 的引擎（Goose、Kilo，以及桥接后的 Amp/Droid），可以直接在网关与引擎之间插一层"ACP-to-赛题协议"转换器，复用同一套适配代码 | Goose、Kilo 原生；Amp、Droid 需第三方/桥接层 |

### 接入参数（示例，需按引擎逐一确认真实取值）

- 通用：`entry_point`（可执行文件路径）、`workdir`、`model`/`provider`（自定义 OpenAI/Anthropic 兼容 endpoint + api key，Cursor/Amp/Copilot SDK/Kilo 均已证实支持 BYOK 或自定义 base URL）、`headless_flag`（`-p`/`-x`/`run`/`exec` 等）、`output_format`（`json`/`stream-json`/`stream-jsonrpc`）、`session_flag`（`--session`/`--continue`/`threads continue`）、`approval_mode`（`auto`/`approve`/`hook-command`/policy script 路径）。
- Windows 特有：多数引擎为 Node.js（Cline、Auggie、Kilo 部分依赖 npm 生态）或跨平台二进制（Goose、Crush 为 Go/Rust 编译产物，天然对 Windows 支持较好）；Aider 依赖 Python 环境，需确认 Windows 原生（非 WSL）下 PTY/终端转义相关限制（issue #4923 提到"headless 模式无 PTY/tmux/转义码解析依赖"，反而是 Windows 友好的信号）。

### 风险与坑

1. **ACP 收敛程度参差不齐，不能假设"支持 ACP"等于"开箱即用"**：Amp、Crush 名义上有 ACP 相关项目，但分别是"第三方桥接+付费限制"和"社区讨论中未确认合并"，接入前必须以官方 CHANGELOG/release 为准做二次确认，不能只信 GitHub issue 标题。
2. **会话语义差异大**：Aider 没有真正的 session 对象（靠外部适配层模拟隔离），如果直接套用赛题"POST /session {title, directory}"的期望，需要在适配层里自建 session registry，而不能假设引擎天然提供 session id。
3. **权限模型颗粒度不一致**：从 Goose 的四态到 Cline 的任意脚本网关，粒度跨度很大，归一化时建议只承诺"最小公共分母"（自动执行 vs 需要人工确认两档），把更细粒度的策略作为引擎扩展参数暴露，而不是试图在网关层强行统一语义。
4. **计费/额度限制可能伪装成技术限制**：Amp 的 ACP 桥接"仅付费额度可用"提示，在评测环境里如果用免费/内部模型代理，可能触发不可预期的功能降级，需要提前在沙箱里验证。
5. **本次检索对 Crush、Cursor CLI 的部分细节（ACP 官方支持状态、权限分级）尚未做到官方一手确认**，仅基于第三方/社区/单一文档页信息，标记为"推测，需要在正式接入前用最新官方文档二次核实"。

## 未解决问题

1. Crush 官方是否已经/何时正式合并 ACP 支持（client 端还是 agent 端，或两者）？需要直接看 charmbracelet/crush 的 CHANGELOG.md 与最新 release notes。
2. Cursor CLI 的官方权限/审批模型（是否有类似 Goose 的分级模式）及其 `--output-format stream-json` 完整 event schema 字段清单，需要直接抓取 cursor.com/docs/cli/reference/output-format 页面原文（本次因页面结构限制只拿到摘要）。
3. Goose 2.0 的 ACP-over-HTTP/WS transport（RFD 提及但未公开细节）最终端口号、URL 路径规范是什么，需要跟踪 aaif-goose/goose Issue #6642 后续更新。
4. Amp 官方 CLI 文档中 execute-mode 页面被登录墙拦截，未能拿到官方一手 `-x`/`--stream-json` 完整参数表，仅通过第三方 cheatsheet 交叉验证，建议后续用已登录会话或 Google 缓存重新抓取 ampcode.com/manual/cli/execute-mode。
5. 这批引擎中是否有任何一个具备独立于 session 历史之外的"长期语义记忆/检索式记忆"能力，本次检索未发现一手证据，需要针对 Goose/Cline/Amp 逐个查其最新 blog/release notes。
6. Factory Droid、Auggie 的细粒度权限审批（是否有类似 allow-list/deny-list 配置文件）在本次检索中未深入，需要补充查证 docs.factory.ai 与 docs.augmentcode.com 的权限专题页。

## 来源列表

- https://github.com/block/goose/discussions/7309 （Goose 与 ACP 讨论）
- https://aaif.io/blog/where-new-mcp-ideas-go-to-become-real-goose-as-a-proving-ground/ （AAIF 治理转移与 goosed/ACP 架构说明）
- https://goose-docs.ai/blog/2026/04/08/goose-acp-and-new-tui/ （Goose 2.0 架构与 ACP 迁移路线图）
- https://zed.dev/acp/agent/goose （Goose 作为 ACP agent）
- https://deepwiki.com/block/goose （Goose 架构总览，辅助理解）
- https://block-goose.mintlify.app/guides/recipes ；https://goose-docs.ai/docs/guides/recipes/ （Goose Recipes）
- https://deepwiki.com/block/goose/4.3-session-management （Goose Session 管理）
- https://goose-docs.ai/docs/guides/goose-permissions/ （Goose 四态权限模式）
- https://github.com/block/goose/issues/4097 ；https://github.com/aaif-goose/goose/issues/7603 ；https://github.com/block/goose/issues/3386 （Goose 权限模式相关 issue）
- https://aider.chat/docs/scripting.html （Aider Scripting 官方文档）
- https://github.com/Aider-AI/aider/issues/4923 （Aider headless/CI 用法讨论）
- https://cline.bot/cli （Cline CLI 官方页）
- https://toolsbase.dev/en/reference/cline-commands （Cline CLI 命令速查，第三方）
- https://kilo.ai/docs/code-with-ai/platforms/cli-reference （Kilo CLI 官方参考）
- https://zed.dev/acp/agent/kilo （Kilo 作为 ACP agent）
- https://littlebearapps.com/help/untether/amp-stream-json-cheatsheet/ （Amp --stream-json 事件格式，第三方 cheatsheet）
- https://github.com/SuperagenticAI/acp-amp （Amp 的第三方 ACP 桥接）
- https://cursor.com/docs/cli/headless ；https://cursor.com/docs/cli/reference/output-format （Cursor CLI headless 与输出格式官方文档）
- https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/ （Copilot SDK GA）
- https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/byok （Copilot SDK BYOK）
- https://docs.factory.ai/droid-exec/overview （Factory Droid Exec 官方文档）
- https://github.com/yaonyan/droid-acp （Droid 的第三方 ACP adapter）
- https://github.com/charmbracelet/crush （Crush 仓库，许可证与 issue 列表）
- https://www.augmentcode.com/changelog/auggie-cli-0-16-0-release-notes ；https://www.augmentcode.com/product/cli （Auggie CLI 官方文档）
