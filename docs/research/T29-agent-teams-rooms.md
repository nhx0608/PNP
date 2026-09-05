# T29 Agent 团队 / Room / Agent 间直接通信能力的形态与跨引擎实现

## 摘要

多 agent/团队/room 能力在业界呈现三档耦合强度：L1 委派（父子单向、结果摘要回传，如 Hermes `delegate_task`、Gemini CLI/opencode/Amp 的 subagent）是绝大多数引擎已支持的最小公约数；L2 对等团队（mailbox + 共享任务看板，如 Claude Code 实验性 Agent Teams）目前只有 Claude Code 原生支持，且明确要求非 Windows Terminal 环境（split-pane 依赖 tmux/iTerm2，Windows Terminal 不支持，需退化为 in-process 模式）；L3 Room/GroupChat（AutoGen SelectorGroupChat、CAMEL、MetaGPT、ChatDev）几乎都是应用框架层实现，不是任何 harness 的内建能力。跨引擎通信目前没有统一的"团队协议"，可用的是两个易混淆但完全不同的协议：A2A（Agent2Agent，Linux Foundation 治理，IBM 旧 ACP 已并入）用于 agent 间能力发现与任务协作，ACP（Agent Client Protocol，agentclientprotocol.com）则是 OpenClaw 用来把 Claude Code/Cursor/Gemini CLI 等外部 harness 接入网关的会话协议，其 binding 抽象（`route`/`acp`、`--bind here`、持久化 `bindings[]`）与本赛题"通用 Agent 网关规范"的会话生命周期高度同构，可直接参照。建议我们的架构把 L1 委派归一化为公共能力，L2 团队定义为标准化扩展能力 `team.v1`（原生优先，缺失引擎由网关托管 polyfill room 实现，参考 Gemini CLI 社区方案 `summon.js`+`nexus.js` 的"外部进程编排 + IPC 总线"模式），L3 Room 完全放在网关/编排层自建，不依赖任何引擎原生支持。

## 关键事实（表格：事实 | 来源 | 置信度 | 是否交叉验证）

| 事实 | 来源 | 置信度 | 交叉验证 |
|---|---|---|---|
| Claude Code Agent Teams 需设置环境变量 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 才启用，默认关闭，属实验特性 | code.claude.com/docs/en/agent-teams | 高（一手文档） | 已交叉验证（多篇二手文章同时提到该 env var，如 heyuan110.com） |
| Agent Teams 架构组成：Team lead（主 session）、Teammates（独立 Claude Code 实例）、Task list（共享任务列表）、Mailbox（消息系统） | 同上 | 高 | 是（GitHub issue #58762 独立佐证 mailbox+tmux 机制存在） |
| 每个 agent 的 mailbox 是 JSON 文件，路径 `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`；写入失败则发送方收到错误 | 同上 | 高 | 单来源（一手文档已足够可信） |
| Team 名称由 session 派生：`session-` + session ID 前 8 字符；Team config 在 `~/.claude/teams/{team-name}/config.json`，Task list 在 `~/.claude/tasks/{team-name}/` | 同上 | 高 | 单来源 |
| v2.1.178 起不再需要显式 `TeamCreate`/`TeamDelete` 工具（已移除），改为调用 Agent 工具时传 `name` 参数自动建队 | 同上 | 高 | 单来源 |
| Display 模式二选一：`in-process`（默认，单终端内查看/切换）、`split-panes`（需要 tmux 或 iTerm2 + it2 CLI），Windows Terminal/VS Code 终端/Ghostty 不支持 split-pane | 同上 | 高 | 是（builder.io、crystl.dev 博客描述与此一致） |
| 限制：一个 session 只能有一个 team；teammate 不能嵌套 spawn 自己的 teammate（no nested teams）；lead 身份固定不可转移；teammate 无法继承 lead 会话历史（仅拿到 spawn prompt + CLAUDE.md/MCP/skills） | 同上 | 高 | 单来源 |
| Plan approval：teammate 在 plan mode 下完成计划后发送 approval request 给 lead，Claude Code 自动批准（不经用户确认），随后 teammate 才可编辑/执行命令，仍受权限提示约束 | 同上 | 高 | 单来源 |
| Task 三态：pending / in progress / completed，可有依赖关系（dependency），一个任务的依赖未完成前不可被 claim；claim 通过文件锁防止竞态 | 同上 | 高 | 单来源 |
| OpenClaw 的 bindings 支持 `type="route"`（普通路由）与 `type="acp"`（持久化 ACP 会话绑定，后续消息在同一会话/线程直接路由到同一个 ACP session） | docs.openclaw.ai/gateway/config-agents, docs.openclaw.ai/tools/acp-agents | 高 | 是（Multi-agent routing 页面与 config-agents 页面均描述一致模型） |
| OpenClaw `sessions_spawn` 创建后台任务子 session，返回 `runId` 与 `childSessionKey`，不等待子任务完成（异步）；`runtime: "subagent"` 可用于沙箱化 OpenClaw-native 工作 | docs.openclaw.ai/tools/subagents, docs.openclaw.ai/concepts/session-tool | 中高 | 单来源（WebSearch 摘要，未逐字核对原文） |
| OpenClaw 可通过 `tools.sessions.visibility` 收窄可见性，`tools.agentToAgent.allow` 限制哪些 agent 对之间可互访，`tools.agentToAgent.enabled: false` 整体关闭跨 agent 直接访问 | docs.openclaw.ai/concepts/multi-agent | 中高 | 单来源 |


## 架构与工作原理

多 agent/room 能力在业界大致收敛为三种可编程原语，各引擎按不同组合实现：

1. **父子委派（Delegate/Subagent）**：单向、层级化。父 agent 调用工具（Task/delegate_task/subagent）生成一个子 agent，子 agent 独立上下文、独立工具集，跑完后只把"最终摘要"返回给父 agent，子 agent 之间默认互不感知。代表：Hermes `delegate_task`、Claude Code Subagents（Task 工具）、Amp Oracle/Librarian、Gemini CLI Subagents、opencode `task` 工具。
2. **对等团队（Peer Team / Mailbox）**：多个独立引擎实例组成一个"团队"，通过共享 mailbox/任务列表直接互相发消息，不必都经过某个中心节点转发；有一个 team lead 负责发起与收尾，但通信是 P2P 的。代表：Claude Code Agent Teams。
3. **Room / GroupChat（对话式房间）**：一组 agent 共享同一条对话流（turn-based 广播），由一个 Manager/Selector 决定下一个发言者，所有历史消息对全员可见（或被 SOP/角色过滤）。代表：AutoGen GroupChat/SelectorGroupChat、CAMEL role-play（两agent对话）、MetaGPT（共享消息池+SOP流水线）、ChatDev（角色对话链）。

网关层面还有第四种模式——**跨进程/跨引擎路由绑定**：网关把一个外部会话（IM 群、频道）持久绑定到某个引擎的某个 session，如 OpenClaw 的 ACP bindings、Symphony/Slack "频道即 room"模式——这种绑定不是 agent 内部的多智能体协作原语，而是网关对外暴露的会话-agent映射机制，但它常被业务方案误称为"room"。这类"业务 room"应与"agent 协作 room"在我们的能力模型里严格区分（见"设计"章节）。

## 可编程接入面

**Claude Code Agent Teams**
- 启用：环境变量 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`（settings.json 或 shell env），非交互模式(`-p`)下完全禁用（teammate 会退化为普通 subagent）。[来源: code.claude.com/docs/en/agent-teams]
- 建队方式：无显式 API，Claude 在对话中调用内部 `Agent` 工具并传 `name` 参数即自动建队；旧版 `TeamCreate`/`TeamDelete` 工具已于 v2.1.178 移除。
- 展示模式：`teammateMode` 配置项（`in-process`（默认）/ `auto` / `tmux` / `iterm2`），CLI flag `--teammate-mode`（实验性，不出现在 `--help`）。
- Mailbox 消息：文件路径 `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`，条目为 JSON，写入失败会返回错误给发送方；plain message 或结构化 protocol message（plan approval、shutdown request）都走同一通道。
- Hooks：`TeammateIdle`（teammate 即将 idle 时触发，exit code 2 可挽留）、`TaskCreated`、`TaskCompleted`（均支持 exit code 2 阻止并反馈）。

**Hermes `delegate_task`**（一手来源: hermes-agent.nousresearch.com/docs/user-guide/features/delegation）
- 单任务字段：`goal`、`context`、`max_iterations`（默认 50）、`role`（`leaf`默认 或 `orchestrator`）。
- 批量字段：`tasks`：`[{goal, context}, ...]` 数组，一次调用返回一个 background handle，全部完成后汇总一条结果。
- 并发配置：`delegation.max_concurrent_children`（配置项）或环境变量 `DELEGATION_MAX_CONCURRENT_CHILDREN`，默认 3，下限 1，无硬上限。
- 工具限制：`toolsets` 参数为每个子 agent 显式声明可用工具集，运行时强制隔离。
- 返回结构：`status`、`subagent_ids`、超时相关字段 `timeout_seconds`/`timed_out_after_seconds`/`timeout_phase`、`live_transcripts`（实时转录路径，便于外部观测）。
- 明确不支持：无 per-task model 参数；子 agent 之间**没有直接通信通道**，只能通过父 agent 编排（`role="orchestrator"` 模式）。

**OpenClaw 多 agent / ACP / subagents**（来源: docs.openclaw.ai/concepts/multi-agent, /tools/acp-agents, /tools/subagents, /concepts/session-tool, /gateway/config-agents）
- Agent 注册：`agents.entries` 配置节；channel 账号在 `channels.<channel>.accounts`；两者通过 `bindings` 关联。
- Binding 类型：`route`（普通消息路由）与 `acp`（持久化 ACP 会话绑定：命中该绑定的后续消息直接路由到同一个 ACP session，输出回传到同一 channel/thread/topic）。
- ACP = **Agent Client Protocol**（agentclientprotocol.com，Zed 发起的编辑器-agent 通信协议，非 IBM 的 Agent Communication Protocol）。OpenClaw 通过 ACP backend plugin 把 Claude Code、Cursor、Copilot、Droid、OpenCode、Gemini CLI 等"外部 coding harness"作为可路由的 agent 接入，每个 harness 自带认证、模型目录与原生工具，OpenClaw 只负责路由、session 状态与投递策略——这与我们赛题的"网关+引擎"架构高度同构，可直接参考其 binding 抽象。
- 绑定粒度：`--bind here`（把当前会话直接钉死到 ACP session，不建子线程）、`--thread auto|here`（绑定到独立消息线程/话题）、持久化 `bindings[]` 配置项（channel 标识 + agent 归属 + 独立 `cwd`）。
- Session 工具：`sessions_spawn` 异步创建后台子 session，立即返回 `runId`、`childSessionKey`，不阻塞等待子任务完成；`runtime: "subagent"` 用于沙箱化的 OpenClaw 原生子任务。
- 权限隔离：`tools.sessions.visibility` 收窄可见性；`tools.agentToAgent.allow` 白名单限制哪些 agent 对可以互相访问；`tools.agentToAgent.enabled: false` 整体关闭跨 agent 直接访问。

**opencode subagents/Task 工具**（来源: opencode.ai/docs/agents/, GitHub anomalyco/opencode issues #7296 #20059、PR #7756）
- Task 工具的 `subagent_type` 参数（截至检索时）硬编码只接受 `explore`、`general`、`mary` 三个内置类型；自定义 subagent 需在 `opencode.json` 中配置，可通过 TUI `@mention` 手动调用，但**编程式**通过 Task 工具调用自定义 subagent 在写报告时仍是未合并的 feature request（Issue #20059），需关注该功能在评测窗口前是否落地。
- 用 `permission.task`（glob 模式）控制某 agent 可调用哪些 subagent；`hidden: true` 可将 subagent 从 `@` 自动补全隐藏，仅允许被程序化调用。
- 2026 年有 PR #7756 引入"subagent-to-subagent delegation"，带调用预算(budget)、持久化 session、层级化 session 导航（TUI 中可点击的委派框），说明 opencode 正在从"父子委派"向"多级委派树"演进，但该特性目前分层仍是委派树而非对等 mailbox。

**Gemini CLI Subagents**（来源: developers.googleblog.com/subagents-have-arrived-in-gemini-cli/, github.com/google-gemini/gemini-cli/docs/core/subagents.md）
- 官方 subagent：独立上下文窗口、自定义 system instruction、限定工具集，主 session 保持精简；官方文档未描述子 agent 间直接通信或共享 mailbox，模型仍是"主 session 派发→子 agent 完成→摘要返回"。
- 社区 polyfill 案例：`summon.js`（Node.js 零依赖编排器）+ `nexus.js`（WebSocket IPC 总线）为 Gemini CLI 补上官方缺失的 Task 编排能力，让"Parent Agent"能在独立 Git worktree 里 spawn Implementer/Code Reviewer/Architectural Auditor 等子 agent 角色——这是一个**网关侧/外部 polyfill room** 的真实先例，值得我们在"设计"章节直接借鉴其思路（外部进程管理 + IPC 总线模拟引擎未内置的团队协作）。

**Amp（Sourcegraph）Oracle/Librarian**（来源: Medium/substack 二手文章，未抓取一手文档，标记为中等置信度）
- Amp 默认自动派生 subagent，"Oracle"（用 GPT-5 做独立深度分析，不消耗主线程 token，可由主 agent 自主调用或用户显式要求"ask the Oracle"）、"Librarian"（高效代码库检索）是两个预置角色化 subagent，本质上是"父子委派"模式加了两个具名内置角色，不构成对等 room。

## 会话模型

- Claude Code Agent Teams：team 名称由**当前 lead session ID 派生**（`session-` + 前 8 位），因此团队与 lead session 生命周期绑定；team config 目录在 session 结束时自动清理，但 task list 目录**本地持久化保留**（不上传），受 `cleanupPeriodDays` 统一的清理周期控制，故 resume 后任务仍在但 in-process teammate 不会自动恢复（已知限制，需手动重新 spawn）。
- Hermes：子 agent 是"fire and forget"的一次性对象，无持久 session 概念，`subagent_ids` 只用于追踪当次委派。
- OpenClaw：ACP binding 提供了严格意义上的持久 session 映射（业务 conversation ↔ ACP session 的稳定绑定），这与我们赛题网关规范里"POST /session {title, directory}"的会话生命周期概念是同构的，可以作为参考实现。
- opencode：PR #7756 引入"persistent sessions"和"hierarchical session navigation"，即子 agent 也可以有可恢复、可在 TUI 里逐层下钻查看的 session 树，比 Hermes 更接近 Claude Code Teams 的持久化程度，但仍是委派树（有父子方向）而非对等团队。

## 权限与安全

- Claude Code Teams：teammate 继承 lead 的权限模式（含 `--dangerously-skip-permissions`），spawn 后可单独调整某个 teammate 的模式，但**spawn 时不能指定 per-teammate 初始模式**。teammate 的权限提示统一冒泡到 lead session 由人批准；**唯一例外是 plan approval**——teammate 计划完成后自动获批，不经用户确认。跨 agent 消息（`SendMessage`）会被标记为"来自另一个 Claude session"而非用户本人，接收方不能把它当作用户授权来绕过权限检查；auto 模式下有专门的分类器把"转发的批准声明"当作不可信输入处理，并对每条跨 agent 消息（含 plan approval、shutdown 等结构化协议消息）做审查，被拦截的消息不会送达。
- Hermes：通过 `toolsets` 参数做**白名单式**工具隔离，是三家中隔离粒度最明确的（每个子 agent 精确声明能拿到哪些工具，而不是继承父 agent 全部工具）。
- OpenClaw：`tools.agentToAgent.allow`/`enabled`是显式的跨 agent 访问控制开关，`tools.sessions.visibility` 控制会话可见性——这是三者中唯一把"跨 agent 直接访问"做成可配置策略项、且默认可以整体关闭的设计，适合作为网关"权限限制"需求的对照对象。

## 扩展机制与资产

- Claude Code：teammate 角色可复用**Subagent 定义**（project/user/plugin/CLI 四种 scope），定义中的 `tools`、`model`、body（作为 system prompt 附加或替换）、`mcpServers` 字段按 display 模式部分生效，但 `skills` 字段对 teammate**不生效**（teammate 只从项目/用户设置加载 skills，不从 subagent 定义继承）——这是一个容易踩坑的细节，接入时要注意"资产复用"存在字段级别的不完全继承。
- OpenClaw：agent/channel/binding 三层配置本质上是"路由资产"而非 prompt 资产，ACP backend plugin 是把外部 harness 接入的标准扩展点。

## 记忆

- 检索到的一手文档均未描述 team/room 场景下的跨 agent"共享长期记忆"机制；Claude Code Teams 的"记忆"只体现在共享 task list（工作记忆/看板，非语义记忆）和 mailbox（消息历史，非结构化记忆）。跨 agent 语义记忆共享（如 LatentMem 论文提到的"Customizing Latent Memory for Multi-Agent Systems", arxiv 2602.03036）仍是学术前沿，未见业界引擎已落地为标准 API。**推测**：短期内多 agent 记忆共享仍会走"共享文件/工作区"这类弱形式，而非专用记忆协议。

## 多 Agent 与协作

综合以上，可将"多 agent 协作能力"按**耦合强度**分三档，供我们的能力协商模型参考：

| 档位 | 特征 | 代表引擎 | 归一化难度 |
|---|---|---|---|
| L1 委派(Delegate) | 单向父子、子间不通信、结果摘要回传 | Hermes delegate_task、Gemini CLI subagents、Amp Oracle、opencode task(现状) | 低，可映射为网关"调用带 role 的子 session + 等待完成"的公共原语 |
| L2 团队(Team/Mailbox) | 对等 P2P 消息、共享任务看板、有 lead 但非中心转发 | Claude Code Agent Teams | 中，需要网关模拟"团队"概念(团队=同一批 session 的集合 + 一个消息总线)，若引擎不支持则需网关托管 polyfill |
| L3 房间(Room/GroupChat) | 广播式共享对话流，一个 Selector/Manager 决定发言顺序，历史对全员可见 | AutoGen GroupChat、CAMEL role-play、MetaGPT 共享消息池、ChatDev 角色对话 | 高，通常是应用层框架而非引擎内建能力，几乎总需要在网关/编排层之上单独实现，不属于"引擎原生扩展能力" |

**跨引擎通信的现实路径**：
1. **A2A (Agent2Agent)**：Linux Foundation 治理的开放协议，核心是 Agent Card（能力发现元数据）+ Message（含多个 Part：text/file/data）+ Task 管理，三种 transport（JSON-RPC 2.0 / gRPC / HTTP+JSON）行为对等[已交叉验证：a2a-protocol.org 官方规范 + Wikipedia Agent2Agent 词条口径一致]。IBM 的 ACP（Agent Communication Protocol）已于 2025-08-29 并入 A2A（Linux Foundation announcement）[来源: WebSearch 摘要引用]。
2. **ACP (Agent Client Protocol, agentclientprotocol.com)**：与 A2A 无关的另一个协议，定位是"编辑器/客户端 ↔ 编码 agent"的本地进程通信标准（Zed 发起），OpenClaw 用它接入 Claude Code/Cursor/Copilot/Gemini CLI 等外部 harness——**这与本赛题"通用 Agent 网关规范"的定位几乎一致**：网关侧只需实现/适配 ACP 或类 ACP 的会话协议，就能把多种 harness 接进来。**注意区分 A2A 与 ACP 是两个完全不同的协议**，命名冲突容易在设计文档里造成混淆，需要在我们的架构文档里显式澄清。
3. **共享文件/工作区**：Claude Code Teams 的 mailbox 本质就是共享文件系统上的 JSON 文件轮询/事件通知；Gemini CLI 的 polyfill（`summon.js`+`nexus.js`）用 Git worktree（隔离工作区）+ WebSocket IPC 总线（跨进程消息）组合，是"引擎不支持团队协作时，网关/外部进程如何补齐"的可复用范式。
4. **消息总线**：多数"团队"实现最终都退化为一个简单的发布订阅/轮询总线（文件、WebSocket、或消息队列），协议本身并不复杂，复杂点在"如何把总线事件映射回引擎原生的 session 状态与权限模型"。


## 可观测性

- Claude Code Teams：可观测面主要是**文件系统事件**（mailbox JSON 文件的读写、`config.json` 里的 `members` 数组含 `session ID`、`tmux pane ID` 等运行时状态）和 **Hooks**（`TeammateIdle`/`TaskCreated`/`TaskCompleted`），这三类 hook 的 payload 里 `team_name` 字段目前是"session 派生名 + 已标记 deprecated"，说明 Anthropic 自己也在收敛这个字段，我们做归一化埋点时不宜依赖它的语义稳定性，应以 session/agent ID 为主键。
- Hermes：`delegate_task` 返回结果里带 `live_transcripts` 路径，属于"实时转录可观测"的一等公民设计，比 Claude Code 的纯 hook 方式更适合做统一 event 流的数据源（可直接 tail 该路径转成我们的 message.part.updated 事件）。
- 两者都没有提供标准化的 OTel/结构化日志协议，均为引擎自定义的文件/hook 机制，**这印证了赛题要求的"统一可观测协议"必须由网关层自行定义并做"各引擎适配器→归一化事件"的转换**，不能指望任一引擎原生输出即可直接使用。

## 对我们架构的启示（公共能力 vs 扩展能力映射表、接入参数、风险与坑）

### 公共能力 vs 扩展能力映射

| 能力 | 是否可归一化为网关公共能力 | 归一化建议 | 涉及引擎 |
|---|---|---|---|
| 单次任务委派（子 session 执行→返回摘要） | 是（L1，几乎所有引擎都有） | 映射为网关内部的"临时子 session + 阻塞等待 + 摘要抽取"，对上层业务网关规范可完全隐藏，不需要暴露专门 API | Hermes/Gemini CLI/opencode/Amp |
| 工具白名单隔离子 agent | 是，但字段名不同 | 归一化为网关的"engine capability: task.toolset_scoping"能力开关，配置参数统一为 `allowed_tools: []`，适配层各自翻译成 `toolsets`(Hermes)/`tools`+`permission.task`(opencode)/`tools.agentToAgent.allow`(OpenClaw) | Hermes、opencode、OpenClaw |
| 对等团队(mailbox+共享任务看板) | 否，属于引擎特有扩展能力 | 定义为扩展能力 `team.v1`：仅 Claude Code 原生支持；其余引擎需网关侧 polyfill（见下） | Claude Code |
| Room/GroupChat 广播对话 | 否，任何引擎都不原生支持 | 属于**应用框架层**能力，不应假设任何 harness 会提供；应作为网关可选编排组件（类似 AutoGen SelectorGroupChat）独立实现，通过多次调用各引擎的单 session API 拼出来 | 无（需网关自建） |
| ACP 式持久会话绑定 | 是，且与赛题网关规范高度同构 | 直接对标：赛题 `POST /session {title, directory}` + `GET/DELETE /session/{id}` 与 OpenClaw 的 `bindings[]`(`type=acp`) 语义一致，可作为我们网关会话生命周期设计的现成参照 | OpenClaw（业务侧），几乎所有底层引擎的 server 模式 |

### 接入参数清单（新引擎接入"多 agent/team"能力时网关需要探测/配置的项）

1. **能力探测**：引擎是否暴露"子 agent 生成"API（CLI flag/HTTP 端点/工具调用）？是委派树(L1)还是对等团队(L2)？
2. **通信通道形态**：文件轮询（mailbox）、进程内回调、HTTP 长轮询、WebSocket、还是完全不支持跨 agent 通信只能靠父子返回值？—— 决定网关是否需要托管一个"轮询适配器"。
3. **工具/权限范围参数名**：如 `toolsets`（Hermes）、`tools`+`permission.task`（opencode）、`tools.agentToAgent.allow`（OpenClaw）——网关需要一张"字段映射表"作为适配层配置。
4. **并发/资源限制参数**：如 `delegation.max_concurrent_children`（Hermes）——网关应统一暴露 `max_concurrent_agents` 并按引擎翻译。
5. **会话持久化边界**：子 agent/teammate 是否可被 resume？（Claude Code teammate 明确不可 resume，是已知限制）—— 网关的"会话连续性"承诺不能超出底层引擎实际能力，需要在能力协商阶段如实上报。
6. **审批与权限升级路径**：是否有"plan approval"这类特殊消息类型需要网关识别并做特殊放行（不能一律走普通 permission.asked 流程）。

### 网关托管的 polyfill room 实现方案（当引擎不支持 L2/L3 能力时）

参考 Gemini CLI 的 `summon.js`+`nexus.js` 社区方案与 Claude Code mailbox 的文件实现，建议网关层实现一个**引擎无关的 polyfill room**：

- **成员(members)**：网关为每个"房间"维护一个成员表，每个成员是一个独立的底层引擎 session（可以是不同引擎混合，如 opencode + Hermes 同房间），成员表结构 `{name, engine, session_id, role}`。
- **消息总线**：网关自建一个简单的发布订阅总线（进程内 channel 或轻量消息队列），每条消息 `{from, to|broadcast, content, type: text|plan_approval|shutdown_request, ts}`；对每个成员的引擎，网关负责把总线消息"翻译"成该引擎能接受的输入形式——原生支持 prompt_async 的引擎直接把消息拼进下一轮 prompt；不支持异步打断的引擎则排队等 idle 后投递。
- **共享任务板(task board)**：网关维护任务 `{id, status: pending|in_progress|completed, depends_on: [], assignee}`，与 Claude Code 的设计对齐（依赖阻塞、文件锁式 claim 改为网关侧的原子事务）。
- **终止条件**：借鉴 AutoGen 的 `TextMentionTermination` 思路，网关可配置房间终止条件（如所有任务 completed、出现特定关键词、达到最大轮数），以事件形式通过我们统一的 SSE 通道（`session.idle`/自定义 `room.finished` 事件）通知上层业务网关。
- **权限**：polyfill room 中的跨成员消息，网关应像 Claude Code auto 模式那样，把"其他成员发来的批准声明"标记为不可信输入，绝不能让房间内某个 agent 的消息直接触发另一个 agent 的高权限操作，需经网关权限层复核。
- 这样即使评测环境中的某个引擎（如 opencode/dsh）没有原生团队能力，网关也能对上层业务提供统一的"Team/Room"扩展能力接口，只是标注为"polyfill 实现"（能力协商阶段如实声明 `implementation: gateway_polyfill` vs `native`）。

### 风险与坑

- **协议命名冲突**：A2A 与 ACP（Agent Client Protocol）是完全不同的两个协议，容易混淆；IBM 的旧 ACP（Agent Communication Protocol）已并入 A2A（2025-08-29），但 Zed 的 ACP（agentclientprotocol.com）仍独立存在且正是 OpenClaw 用来接入 Claude Code/Gemini CLI 等引擎的协议——写方案文档时必须明确区分。
- **"Team"字段生命周期不稳定**：Claude Code 的 `team_name` 字段已被标记 deprecated 且计算方式几经变化（v2.1.178 前后不同），不要把上层网关的业务标识硬编码依赖某引擎的内部命名规则。
- **平台限制**：Split-pane 团队模式在 **Windows Terminal 不支持**（官方文档明确列出），这与赛题"评测环境为 Windows 10/11"直接冲突——如果选择接入 Claude Code 并想演示 Agent Teams，必须使用 in-process 模式（默认模式，无需 tmux/iTerm2），不能依赖 split-pane。这是一条对我们**直接可用**的强约束结论。
- **委派树 ≠ 对等团队**：多数引擎（Hermes/opencode/Gemini CLI/Amp）目前只有 L1 委派能力，子 agent 间不能直接通信；若赛题或后续演进要求"agent team"作为可选扩展能力展示，真正原生支持的目前只有 Claude Code（experimental）——其余引擎要展示同等效果，必须用网关 polyfill，且要在能力矩阵里如实标注"native/polyfill"区别，避免评测方误判。
- **opencode 自定义 subagent 的可编程调用**尚有能力缺口（Issue #20059 未合并），如果我们选择 opencode 作为落地引擎之一，需要用 polyfill 或自行 fork 打补丁的方式补齐"程序化委派自定义子 agent"能力，而不能假设官方 Task 工具已支持。

## 未解决问题

1. OpenCode PR #7756（subagent-to-subagent delegation with budgets, persistent sessions, hierarchical session navigation）截至检索时（2026-09-04）的合并状态未确认，需要在正式选型前查证是否已进入稳定版本。
2. Hermes、opencode、Gemini CLI 官方文档均未说明"子 agent 之间"是否存在任何官方计划要开放直接通信通道，仅能基于当前文档判断为"不支持"，未来版本可能变化，建议接入时做能力探测而非硬编码假设。
3. dsh（DeepSeek Harness）、Pi、Goose 的多 agent/团队能力本专题未检索到一手资料（超出 T29 范围，需其他专题或后续补充调研）。
4. A2A/ACP 是否已有任何一款候选引擎（OpenCode、Pi、Hermes、Goose、Claude Code）原生实现作为**服务端**协议（而非仅作为客户端被 OpenClaw 这类网关接入）尚未确认，需要针对具体引擎逐一核实其"是否暴露 A2A Agent Card / ACP server"。
5. Claude Code Teams 的 mailbox 文件轮询频率、时延、以及 v2.1.207 前"单条格式错误消息导致整个 mailbox 每秒报错阻塞投递"这一已修复 bug 的具体轮询间隔（"every second"）是否代表官方轮询周期为 1s，需要进一步查证源码或 changelog 确认，本报告仅按文档字面记录。

## 来源列表

- https://code.claude.com/docs/en/agent-teams （一手，Claude Code 官方文档，Agent Teams 架构/API/限制的主要来源）
- https://github.com/anthropics/claude-code/issues/58762 （GitHub issue，佐证 mailbox+tmux 路由 bug 的真实存在）
- https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation （一手，Hermes delegate_task 官方文档）
- https://docs.openclaw.ai/gateway/config-agents （一手，OpenClaw agents/bindings 配置文档）
- https://docs.openclaw.ai/tools/acp-agents （一手，OpenClaw ACP backend plugin 文档）
- https://docs.openclaw.ai/concepts/multi-agent （一手，OpenClaw 多 agent 路由与权限文档）
- https://docs.openclaw.ai/tools/subagents （一手，OpenClaw subagents/sessions_spawn 文档）
- https://docs.openclaw.ai/concepts/session-tool （一手，OpenClaw session 工具文档）
- https://opencode.ai/docs/agents/ （一手，opencode agents 官方文档）
- https://github.com/anomalyco/opencode/issues/20059 （GitHub issue，opencode 自定义 subagent 委派能力缺口）
- https://github.com/anomalyco/opencode/issues/7296 （GitHub issue，opencode 委派调用限额 feature request）
- https://github.com/anomalyco/opencode/pull/7756 （GitHub PR，opencode subagent-to-subagent delegation 实现）
- https://developers.googleblog.com/subagents-have-arrived-in-gemini-cli/ （一手，Google 官方博客，Gemini CLI Subagents 发布）
- https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md （一手，Gemini CLI subagents 文档）
- https://github.com/obra/superpowers/issues/872 （GitHub issue，summon.js/nexus.js polyfill 方案描述）
- https://a2a-protocol.org/latest/specification/ （一手，A2A 协议规范）
- https://github.com/a2aproject/A2A （一手，A2A 协议 GitHub 仓库）
- https://en.wikipedia.org/wiki/Agent2Agent （交叉验证来源，A2A/ACP 合并历史）
- https://agentclientprotocol.com/ （一手，Agent Client Protocol 官网，被 OpenClaw ACP 文档引用）
- 二手/中等置信度来源（未逐字核对原文，仅用于背景与交叉验证）：
  - Amp（Sourcegraph）Oracle/Librarian：Medium 文章 "How to use subagents in AI coding with Amp"、"Hunting for My Next Agent"
  - AutoGen/CAMEL/MetaGPT/ChatDev：futureagi.com "What is AutoGen? Microsoft's Multi-Agent Framework in 2026"、IBM "What is ChatDev"、IBM "What is MetaGPT"、arxiv 2308.00352 (MetaGPT paper)
  - Codex 2026 多 agent：openai.com "Introducing the Codex app"、themenonlab.blog "oh-my-codex"
