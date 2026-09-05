# T18 Dynamic Workflow 与 LLM 元编排（自动决定流程/节点/引擎）

调研日期：2026-09-03。所有事实以本次联网抓取的一手资料为准（Claude Code 官方文档与 CHANGELOG、Claude Code 内置 `workflow-authoring` skill 原文、OpenAI Symphony `SPEC.md`/README、Gas Town README、Cursor 官方 API 文档、Microsoft Learn、arXiv 原文、Anthropic/OpenAI 官方博客）。标注 **[已确认]** 表示直接来自一手来源；**[推测]** 表示本文基于资料的推断；**[第三方]** 表示来自非官方但可信的实践记录。

## 摘要

"动态工作流"与"LLM 元编排"在 2026 年已经从论文走进产品，形成三个层次：

1. **引擎内置的动态编排**。Claude Code 于 2026-05-28 发布 Dynamic Workflows（v2.1.154 起）：Claude 为每个任务现写一段 JS 脚本，用 `agent()/pipeline()/parallel()/phase()` 原语在后台编排数十到数百个子 agent，支持结构化输出（`schema`）、按 token 预算伸缩（`budget`）、可重放的 resume（`resumeFromRunId` + `journal.jsonl`）。配套的 `ultracode` 档位 = `xhigh` 推理 + 由 Claude 自主决定是否用 workflow。与之并列的 Agent Teams（实验性，lead + 对等 teammates + 文件邮箱 + 共享任务列表）、`/goal`（小模型评估完成条件的 Stop hook 循环）、`/loop`（cron）、`/batch`（5–30 个 worktree 隔离子 agent 各开 PR）、Ralph Wiggum（Stop hook 重喂 prompt），构成一整套"谁持有计划"不同的自治机制。
2. **引擎外部的工作编排系统**。OpenAI Symphony（2026-04-28）把 issue tracker 当控制面、`WORKFLOW.md` 当声明式配置、`codex app-server` 当执行协议，并用 `SPEC.md` 把调度器契约（claim 状态机、退避、stall 检测、workspace 隔离、动态重载）与实现分离；其社区 fork oh-my-symphony 用 `AgentBackend` 协议把 8 种 CLI 归一，并支持按看板列路由引擎。Gas Town（Yegge，2026-01-01）以 Beads 工作账本 + 七种角色 + 三级看门狗做"工厂化"编排，支持 Claude/Codex/Gemini/Copilot/Cursor/Kiro 等运行时；Conductor、vibe-kanban、Claude Squad、Multica、Paperclip 与 Cursor Cloud Agents API 代表了从"worktree 并行 UI"到"公司/看板抽象"再到"云端 REST+SSE agent API"的产品谱系。
3. **研究界的自动化设计**。ADAS/Meta Agent Search、AFlow（MCTS 搜索代码表示的工作流）、MaAS（agentic supernet 按 query 采样）、MASS（prompt+拓扑交替优化）、AgentSquare（四模块搜索）、GPTSwarm/DyLAN（图/网络优化）、LLMCompiler（LLM 作 planner 生成 DAG）、Magentic-One（Task/Progress Ledger 双循环）、以及 2026 年的 Meta-Harness/HARBOR/AutoSaddler（外层 agent 直接优化 harness 代码或配置）。失败模式方面，MAST 给出 14 种失败模式的实证分布，Gas Town 的真实部署记录给出了"YOLO 模式"的代价。

对我们架构的核心启示：元编排层应把"节点能力需求"表达为可匹配的能力描述符；引擎选择用"硬约束过滤 → 成本/质量/历史成功率打分 → 有限探索"的三段式；把 Symphony 的 claim/retry/stall 状态机、Magentic 的 ledger、Claude Workflow 的 journal/resume 抽象为网关公共的执行与可观测模型；把 Claude 的 Workflow/Agent Teams、Gas Town 的 formula/convoy 等作为引擎特有扩展能力，经能力协商暴露而非硬编码。

## 关键事实（每条带来源与置信度）

| # | 事实 | 来源 | 置信度 |
|---|------|------|--------|
| 1 | Claude Code Dynamic Workflows 官方博客发布于 2026-05-28；CHANGELOG 记录 v2.1.154 "Introducing dynamic workflows… orchestrates work across tens to hundreds of agents in the background… Run `/workflows`"。Max/Team/Enterprise 默认开启，Pro 需在 `/config` 打开；支持 CLI/Desktop/VS Code/API/Bedrock/Vertex/Foundry | https://claude.com/blog/introducing-dynamic-workflows-in-claude-code ；https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md | 高 |
| 2 | 触发关键字在 v2.1.160 由 `workflow` 改名为 `ultracode`；`/effort ultracode` 与 `claude --effort ultracode` 需 v2.1.203+；v2.1.210 起关键字只对 `origin: {kind:"human"}` 的输入生效（`-p`、SDK 非人类输入、webhook、PR 评论不触发） | https://code.claude.com/docs/en/workflows ；CHANGELOG 2.1.160/2.1.210 | 高 |
| 3 | 脚本 API：`agent(prompt, {label, phase, schema, model, effort:'low'|'medium'|'high'|'xhigh'|'max', isolation:'worktree', agentType})`、`pipeline(items, ...stages)`（无 barrier）、`parallel(thunks)`（barrier，异常项落为 `null`）、`phase(title)`、`log(msg)`、全局 `args`、`budget.{total, spent(), remaining()}`（硬上限，超出后 `agent()` 抛异常）、`workflow(nameOrRef, args)`（仅一层嵌套）。脚本以 `export const meta = {name, description, whenToUse?, phases?}` 纯字面量开头 | Claude Code 内置 `/workflow-authoring` skill 原文（v2.1.248+，本次直接加载） | 高 |
| 4 | Workflow 工具输入：`script`（内联）或 `{scriptPath}`；`name`（已保存的工作流）；`args`（须传真实 JSON 值而非字符串）；`resumeFromRunId`。每次调用自动把脚本持久化到 session 目录并返回路径；`<transcriptDir>/journal.jsonl` 记录每个 agent 的返回值 | 同上 | 高 |
| 5 | 运行时限制：并发 agent `min(16, CPUs-2)`；单 run 最多 1000 agents；单次 `parallel()/pipeline()` 最多 4096 项；无文件系统/shell/`import()`（v2.1.223 修复了 `import()` 逃逸沙箱）；`Date.now()/Math.random()/new Date()` 抛异常以保证 resume 可重放；`agent({schema})` 校验失败 5 次即中止（v2.1.186） | https://code.claude.com/docs/en/workflows ；CHANGELOG | 高 |
| 6 | Resume 语义：按 agent 启动顺序重放，"最长未变前缀"直接返回缓存结果；第一个 prompt 发生变化的 agent 及其后所有 agent 重跑；任一失败 agent 之后的 agent 即使已完成也重跑；仅同一 session 内可 resume，后台化 session 会带着 run 一起迁移 | https://code.claude.com/docs/en/workflows | 高 |
| 7 | 权限：`Workflow` / `Workflow(<name>)` allow 规则；`-p`/SDK 下永不弹窗，走 `canUseTool`、`PreToolUse` hook、`--permission-prompt-tool` 或 auto/bypass；子 agent 沿用 subagent 权限模式；`workflowSizeGuideline` 取 `small(<5)/medium(<15)/large(<50)/unrestricted`，v2.1.219 起默认 medium；>25 agents 或预计 >1.5M tokens 显示 `Large workflow` 警告；`disableWorkflows: true` / `CLAUDE_CODE_DISABLE_WORKFLOWS=1` 关闭 | https://code.claude.com/docs/en/workflows | 高 |
| 8 | 可观测：v2.1.202 起 workflow 派生的 agent 遥测带 `workflow.run_id`、`workflow.name` OpenTelemetry 属性；`/workflows` 视图显示每阶段 agent 数、token 总量、耗时，可 `p` 暂停、`x` 停止、`r` 重启、`s` 保存为命令 | CHANGELOG 2.1.202；docs/workflows | 高 |
| 9 | 保存位置 `.claude/workflows/`（项目）或 `~/.claude/workflows/`（个人，受 `CLAUDE_CONFIG_DIR` 影响）；插件内 `workflows/` 目录按 `/plugin:name` 命名空间；monorepo 中取最近的 `.claude/workflows/`；同名时项目优先 | docs/workflows | 高 |
| 10 | Prompt cache 协同：同 run 内 model/effort/agentType/tools/schema/cwd 相同的 agent 共享前缀缓存；fan-out 时后续 agent 最多等待 `CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS`（默认 5000ms）；`subagentPromptCacheTtl` 可设 `1h` | docs/workflows | 高 |
| 11 | Agent Teams：v2.1.150 以 research preview 加入，需 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`；v2.1.178 移除 `TeamCreate/TeamDelete`，Agent 工具带 `name` 即启动 teammate；邮箱 `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`，`team-name = session-<sessionId 前 8 位>`；任务列表 `~/.claude/tasks/{team-name}/`；`teammateMode` 取 `in-process|auto|tmux|iterm2`（v2.1.179 起默认 in-process）；`--teammate-mode` 为隐藏 flag；不支持 `-p`/SDK；单 session 单 team、无嵌套、lead 固定、权限在 spawn 时继承 lead | https://code.claude.com/docs/en/agent-teams ；CHANGELOG 2.1.150 | 高 |
| 12 | Teams 相关 hooks：`TeammateIdle`、`TaskCreated`、`TaskCompleted`（退出码 2 = 阻断并回传反馈）；`SubagentStart/SubagentStop` 按 agent type 匹配；公共字段 `session_id, prompt_id, transcript_path, cwd, permission_mode, hook_event_name, agent_id, agent_type`；文档中没有 Workflow 级 hook 事件 | https://code.claude.com/docs/en/hooks | 高 |
| 13 | `/goal`：本质是 session 级 prompt-based Stop hook；每轮结束由小模型（Claude API 默认 Haiku，可用 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 改）给出 `Not yet met / Met / Impossible` 三种裁决；条件最长 4000 字符；后台任务挂起 30 分钟后 check-in，之后 1h、2h 退避（`CLAUDE_CODE_GOAL_CHECKIN_MINUTES`）；`claude -p "/goal …"` 可非交互运行 | https://code.claude.com/docs/en/goal | 高 |
| 14 | `/loop` 底层是 `CronCreate/CronList/CronDelete` 工具；session 最多 50 个任务；周期任务 7 天过期；自适应模式下 Claude 调用 `ScheduleWakeup` 并可 `stop: true` 自行结束；`/batch` 是 skill，拆成 5–30 个 worktree 隔离子 agent 各开 PR；Ralph Wiggum 官方插件 `/ralph-loop "<prompt>" --max-iterations <n> --completion-promise "<text>"`，用 `hooks/stop-hook.sh` 拦截退出重喂 | https://code.claude.com/docs/en/scheduled-tasks ；https://code.claude.com/docs/en/agents ；ralph-wiggum README | 高 |
| 15 | OpenAI Symphony：2026-04-28 发布，Apache-2.0，Elixir 参考实现 + `SPEC.md`；`WORKFLOW.md` front matter：`tracker.{kind, provider, required_labels, active_states, terminal_states}`、`polling.interval_ms`(30000)、`workspace.root`、`hooks.{after_create, before_run, after_run, before_remove, timeout_ms(60000)}`、`agent.{max_concurrent_agents(10), max_turns(20), max_retry_backoff_ms(300000), max_concurrent_agents_by_state}`、`codex.{command('codex app-server'), approval_policy, thread_sandbox, turn_sandbox_policy, turn_timeout_ms(3600000), read_timeout_ms(5000), stall_timeout_ms(300000)}` | https://raw.githubusercontent.com/openai/symphony/main/SPEC.md ；README；https://liduos.com/agentic-coding/open-source-spec-for-codex-orchestration-symphony | 高 |
| 16 | Symphony 调度契约：claim 状态 `Unclaimed/Claimed/Running/RetryQueued/Released`；attempt 阶段 `PreparingWorkspace→BuildingPrompt→LaunchingAgentProcess→InitializingSession→StreamingTurn→Finishing→{Succeeded,Failed,TimedOut,Stalled,CanceledByReconciliation}`；失败重试 `delay = min(10000 * 2^(attempt-1), max_retry_backoff_ms)`；`session_id = "<thread_id>-<turn_id>"`；token 统计取 `thread/tokenUsage/updated` 绝对值做差分；重启恢复完全靠 tracker + 文件系统，不需要持久 DB；`WORKFLOW.md` 必须支持热重载 | SPEC.md | 高 |
| 17 | oh-my-symphony（社区 fork）：`AgentBackend` Protocol 把 Codex（app-server JSON-RPC）、Claude Code（`claude -p` + `--resume`）、Gemini、AGY、Kiro、OpenCode（`--session`）、Pi（`--session` + JSONL）、Prime 八种后端归一为 `session_started/turn_completed/turn_failed` + usage/rate-limit 快照；路由优先级 ticket `agent_kind` > `agent.stage_kinds[state]` > `agent.kind` | https://raw.githubusercontent.com/cskwork/oh-my-symphony/main/README.md | 高（第三方 fork） |
| 18 | Gas Town：Go，MIT，2026-01-01 开源；建立在 Beads（git+SQLite/Dolt 的工作账本，bead id 形如 `gt-abc12`）之上；角色 Mayor/Polecats/Witness/Refinery/Deacon/Dogs/Crew/Boot；convoy（工作捆）、molecule（由 TOML formula 实例化的多步工作流，含 checkpoint 恢复）；支持 Claude、Copilot、Codex、Gemini、Cursor、Kiro 等运行时（`settings/config.json`）；三级看门狗 Daemon(3 分钟心跳)→Boot→Deacon→Witness；Scheduler 做并发/速率治理；Seance 通过 `.events.jsonl` 查询前任 session；Wasteland 通过 DoltHub 做联邦 | https://raw.githubusercontent.com/gastownhall/gastown/main/README.md ；https://yegge.ai/gastown | 高 |
| 19 | Gas Town 真实部署记录：DoltHub 团队 60 分钟烧掉约 $100 API token（约为普通 Claude Code 的 10 倍），4 个自动 PR 全部关闭，一个 PR 在集成测试失败下被自动合并；社区记录"rampaging Deacon"删代码、5 次 force push 恢复 | https://www.dolthub.com/blog/2026-01-15-a-day-in-gas-town/ ；https://paddo.dev/blog/gastown-two-kinds-of-multi-agent/ | 中（第三方实践） |
| 20 | Cursor Cloud Agents API：`https://api.cursor.com`，`POST /v1/agents`（`prompt.{text,images}`、`model.{id,params}`、`repos[].{url,startingRef,prUrl}`、`workOnCurrentBranch`、`autoCreatePR`、`envVars`、`mcpServers`、`customSubagents`(≤20)、`mode: plan|agent`、`agentId` 幂等键）；`POST /v1/agents/{id}/runs` 追问；`GET …/runs/{runId}/stream` SSE 事件 `status/assistant/thinking/tool_call/interaction_update/heartbeat/result/error/done`，支持 `Last-Event-ID`；`GET …/usage` 返回 input/output/cacheWrite/cacheRead tokens；agent 状态 `ACTIVE/IDLE/ARCHIVED`；private-workers 池化端点 `/v0/private-workers/*` | https://cursor.com/docs/cloud-agent/api/endpoints | 高 |
| 21 | 产品形态：Conductor（Mac，Claude Code/Codex/Cursor/OpenCode 并行 worktree，有 Conductor API）；vibe-kanban（`npx vibe-kanban`，10+ agents，MCP server，README 标注 sunsetting）；Claude Squad（AGPL-3.0，tmux+worktree，`cs -p "<program>"`、`-y` autoyes）；Multica（Go+Postgres 17 服务端 + 本地 daemon 拉起 26 种 agent CLI，Apache-2.0 派生许可）；Paperclip（MIT，公司/org chart/heartbeat/预算/审批门/任务 checkout 原子化，适配 Claude Code/Codex/Cursor/Gemini/OpenClaw/bash/HTTP，"If it can receive a heartbeat, it's hired"） | 各项目 README/官方文档（见来源列表） | 高 |
| 22 | Magentic-One（2024-11）：Orchestrator 外层 Task Ledger（已验证事实/待查事实/待推导事实/猜测 + 计划）+ 内层 Progress Ledger（是否完成、是否循环、是否有进展、下一个 speaker、给它的指令）；stall 计数超阈值（实验 ≤2）触发 replan；GAIA 32.33%（+o1 38.00%）、AssistantBench 11.0/13.3、WebArena 32.8%。Microsoft Agent Framework 的 `MagenticBuilder(participants, manager_agent, max_round_count, max_stall_count, max_reset_count, enable_plan_review)`，事件 `PLAN_CREATED/REPLANNED/PROGRESS_LEDGER_UPDATED`，人审 `MagenticPlanReviewRequest.approve()/revise(feedback)` | https://arxiv.org/html/2411.04468v1 ；https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic | 高 |
| 23 | 自动化设计研究：ADAS/Meta Agent Search（ICLR 2025，meta agent 用代码编程新 agent，基于不断增长的 archive）；AFlow（ICLR 2025 Oral，MCTS 搜索代码表示的工作流，operators=Generate/Format/Review/Revise/Ensemble/Test/Programmer，默认 20 轮，6 数据集平均 +5.7%，小模型以 4.55% 成本达 GPT-4o 水平）；MaAS（ICML 2025 Oral，agentic supernet 按 query 采样子网，成本 6–45%，+0.54–11.82%）；MASS（ICLR 2026，block prompt→topology→global prompt 三阶段）；AgentSquare（Planning/Reasoning/Tool Use/Memory 四模块 + 演化/重组 + 性能预测器，平均 +17.2%）；GPTSwarm（ICML 2024，agent 即可优化计算图，node/edge 两级优化）；DyLAN（Agent Importance Score 选队，MMLU 子集最高 +25%）；AutoAgents（按任务动态生成 agent + observer 反思）；MoA（分层聚合，AlpacaEval 2.0 65.1%） | 各 arXiv 摘要页（见来源列表） | 高 |
| 24 | Meta-Harness（arXiv 2603.28052，2026-03-30，Stanford）：harness = "决定存什么、取什么、给模型看什么的有状态程序"；proposer 是 Claude Code + Opus 4.6，通过文件系统 `grep/cat` 读取历史候选的源码/分数/trace（每轮中位数读 82 个文件，41% 源码、40% trace）；典型 20 轮约 60 个 harness；TerminalBench-2 上发现的 harness 76.4%（Opus 4.6）vs Terminus-KIRA 74.7%，Haiku 4.5 上 37.6% vs 33.7%；总结的失败模式：confounded edits、fragile completion logic、信息发现浪费 2–4 轮 | https://arxiv.org/html/2603.28052v1 ；https://raw.githubusercontent.com/stanford-iris-lab/meta-harness/main/README.md | 高 |
| 25 | 同类 2026 工作：HARBOR（arXiv 2604.20938，2026-04-22，JPMorgan）把 harness 配置搜索建模为受约束的噪声贝叶斯优化，输出 (pass-rate, cost) Pareto 前沿；AutoSaddler（arXiv 2608.23041，2026-08-24）用失败 trace 诊断 + 结构化补丁 + 验证选择做"durable"的 harness 更新，GAIA2 +9.0pp、SWE-Bench Pro +9.6pp、Terminal-Bench 2.0 +10.0pp | https://arxiv.org/abs/2604.20938 ；https://arxiv.org/abs/2608.23041 | 高 |
| 26 | LLMCompiler（ICML 2024）：Function Calling Planner 生成带依赖的任务 DAG，Task Fetching Unit 并行分发，Executor 执行；延迟最高 3.7×、成本 6× 改善。RouteLLM（arXiv 2406.18665）：用偏好数据训练强/弱模型路由器，成本降 2× 以上 | https://arxiv.org/abs/2312.04511 ；https://arxiv.org/abs/2406.18665 | 高 |
| 27 | MAST（arXiv 2503.13657，v3 2025-10-26）：1,642 条标注轨迹、7 个框架（ChatDev、MetaGPT、HyperAgent、AppWorld、AG2、Magentic-One、OpenManus），κ=0.88；三大类 System Design 41.77% / Inter-Agent Misalignment 36.94% / Task Verification 21.30%；高频模式：FM-1.3 步骤重复 15.7%、FM-2.6 推理-行动不一致 13.2%、FM-1.5 不知停止条件 12.4%、FM-1.1 违背任务规范 11.8%、FM-3.3 错误验证 9.1%、FM-3.2 无/不完整验证 8.2%；给 ChatDev 加高层验证步骤 +15.6% | https://arxiv.org/html/2503.13657v3 | 高 |
| 28 | Anthropic 多 agent 研究系统的工程经验：单 agent 约 4× 聊天 token，多 agent 约 15×；token 用量解释 80% 的性能方差；Opus 4 编排 + Sonnet 4 子 agent 相比单 Opus 4 提升 90.2%；并行子 agent + 并行工具调用把复杂查询时间缩短最多 90%；需要 durable execution、checkpoint、rainbow deployment 与全链路 tracing | https://www.anthropic.com/engineering/built-multi-agent-research-system | 高 |

## 架构与工作原理

### 1. Claude Code：五种"谁持有计划"的自治机制

官方文档用一张表区分 Subagents / Skills / Agent teams / Workflows [已确认]：

| | Subagents | Skills | Agent teams | Workflows |
|---|---|---|---|---|
| 是什么 | Claude 派生的 worker | Claude 遵循的指令 | lead 监督一组对等 session | runtime 执行的脚本 |
| 谁决定下一步 | Claude 逐轮 | Claude | lead 逐轮 | 脚本 |
| 中间结果在哪 | Claude 上下文 | Claude 上下文 | 共享任务列表 | 脚本变量 |
| 规模 | 每轮几个 | 同左 | 少量长活对等体 | 每 run 数十到数百 agent |
| 中断 | 重启该轮 | 重启该轮 | teammates 继续跑 | 同 session 可 resume |

**Dynamic Workflow 的机制**：用户描述任务（或带 `ultracode` 关键字、或 `/effort ultracode`）→ Claude 写一段 JS 脚本 → runtime 在与对话隔离的沙箱里执行脚本，脚本通过 `agent()` 派生子 agent，中间结果留在脚本变量，只有最终返回值进入 Claude 上下文 → 每次 run 的脚本与 `journal.jsonl` 持久化在 `~/.claude/projects/<session>/`，供 resume 重放。`ultracode` 下"一个请求可能变成连续几个 workflow：一个理解代码、一个做修改、一个验证"[已确认]。内置 skill 把常见单阶段 workflow 归纳为 Understand / Design / Review / Research / Migrate 五种形状，并给出质量模式：adversarial verify（N 个独立 skeptic 尝试反驳）、perspective-diverse verify、judge panel、loop-until-dry（连续 K 轮无新发现才停）、multi-modal sweep、completeness critic、no silent caps [已确认]。

保存后的脚本形状（官方示例）[已确认]：

```javascript
export const meta = {
  name: 'audit-routes',
  description: 'Audit every route handler for missing auth checks',
}
const found = await agent('List every .ts file under src/routes/.', {
  schema: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { type: 'string' } } } },
})
const audits = await pipeline(found.files, file =>
  agent(`Audit ${file} for missing authentication checks.`, { label: file }),
)
return audits.filter(Boolean)
```

内置 skill 中的"loop-until-dry + 三镜头裁决"组合模式（节选）[已确认]：

```javascript
const seen = new Set(), confirmed = []
let dry = 0
while (dry < 2) {
  const found = (await parallel(FINDERS.map(f => () =>
    agent(f.prompt, {phase: 'Find', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)
  const fresh = found.filter(b => !seen.has(key(b)))
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach(b => seen.add(key(b)))
  const judged = await parallel(fresh.map(b => () =>
    parallel(['correctness','security','repro'].map(lens => () =>
      agent(`Judge "${b.desc}" via the ${lens} lens — real?`, {phase: 'Verify', schema: VERDICT})))
      .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.real).length >= 2 }))))
  confirmed.push(...judged.filter(v => v.real).map(v => v.b))
}
return confirmed
```

设计要点：**确定性控制流 + 非确定性节点**（循环/分支/fan-out 由 JS 决定，节点内部由 LLM 决定）；为保证可重放，禁用时间与随机数；`budget` 把用户的 "+500k" 指令变成硬上限；`pipeline()` 默认无 barrier（wall-clock = 最慢单条链），只有需要跨项去重/早退时才用 `parallel()` 的 barrier。

**Agent Teams 的机制**：lead 调用 Agent 工具并带 `name` 即产生 teammate（v2.1.178 后无需 `TeamCreate`）；teammate 是完整独立 session，加载 CLAUDE.md/MCP/skills 但不继承 lead 对话历史；通过 `SendMessage` 写入对方邮箱 JSON 文件；有 Task 工具的 agent 共享任务列表（pending/in progress/completed + 依赖），claim 用文件锁；teammate 的权限提示上浮到 lead；plan 模式下 teammate 的 plan 由 lead session 自动批准 [已确认]。

**`/goal`、`/loop`、`/batch`、Ralph**：`/goal` 是 session 级 prompt-based Stop hook 的包装，评估器不能调工具，只能看 Claude 已经在对话里"表面化"的证据；连续多轮无工具调用会触发 block cap 停止；`/loop` 是 cron，`/batch` 是 skill；Ralph Wiggum 是最朴素的"Stop hook 重喂 prompt + `--completion-promise` 精确字符串匹配"[已确认]。

### 2. 引擎外部的工作编排系统

**OpenAI Symphony**：定位是"管理工作而非监督 agent"（[第三方] 中文解读引用官方博客：当 agent 足够强，瓶颈变成人的注意力；团队三周内 PR 增长 500%）。核心是一个长驻 daemon：每 `polling.interval_ms` 轮询 tracker → 按 priority/创建时间/identifier 排序 → 在全局与按状态的并发槽内 dispatch → 每个 issue 一个 workspace（`<workspace_root>/<sanitized_key>`，路径必须在 root 之下）→ `bash -lc <codex.command>` 拉起 `codex app-server`，取 `thread_id`，以渲染后的 prompt 开第一 turn；继续 turn 复用同一 `thread_id`；orchestrator 按 tick 做 reconcile：stall 检测（自 `last_codex_timestamp` 起超过 `stall_timeout_ms` 即杀掉重排）、tracker 状态刷新（terminal → 停并清理 workspace）[已确认]。Prompt 用严格模板引擎渲染，变量只有 `issue` 与 `attempt`。SPEC 明确的非目标：不做通用工作流引擎、不做多租户控制面、不强制统一审批/沙箱策略 [已确认]。

**oh-my-symphony** 展示了"网关 + 多引擎"的最小可行形态：`AgentBackend` 协议只要求后端发出 `session_started/turn_completed/turn_failed` 三类事件 + usage/rate-limit 快照，八种 CLI 各自用不同的续话方式（Codex 常驻 JSON-RPC；Claude 每 turn 新起 `claude -p` 并 `--resume`；OpenCode/Pi 用 `--session`）[已确认]。

**Gas Town** 是"工厂化"路线：Beads 把每个工作单元做成 git 版本化、可 SQL 查询的 bead；Mayor（Claude Code 实例）接收自然语言指令 → 建 convoy → `gt sling <bead-id> <rig>` 把工作甩给 polecat（持久身份、临时 session）→ Witness 监控 polecat、Refinery 做 Bors 式合并队列、Deacon 跨 rig 巡逻并派 Dogs；molecule 由 TOML formula 实例化，带 checkpoint 恢复 [已确认]。Propulsion Principle 的要义是"hook（git worktree 支持的持久工作槽）上有工作，agent 启动后必须执行"（README 措辞为 hooks 作为状态持久化机制；paddo.dev 将 GUPP 解释为 "Git Up, Pull, Push"，与 Yegge 原文 "Gas Town Universal Propulsion Principle" 不一致，**[推测]** 后者为误读）。真实部署代价见关键事实 #19。

**产品谱系**（[已确认]）：Conductor / Claude Squad / vibe-kanban 属于"每任务一个 worktree + 一个 agent 进程 + UI"；Multica / Paperclip 加上"团队/公司"抽象（issue 指派、heartbeat、预算、审批门、org chart）与多 CLI 适配；Cursor Cloud Agents 则把 agent 完全服务化（REST 创建 agent、runs 追问、SSE 流、usage、artifacts、私有 worker 池）。

### 3. 研究：从"搜索工作流"到"搜索 harness"

- **搜索空间演进**：ADAS 把 agent 定义为代码，meta agent 在 archive 上迭代编程；AFlow 把工作流表示为"LLM 节点 + 边 + operators"的代码并用 MCTS 搜索，experience 树状保存；AgentSquare 把 agent 拆成 Planning/Reasoning/Tool Use/Memory 四个统一 IO 的模块做演化+重组并用 in-context 代理模型预测性能；GPTSwarm/DyLAN 把多 agent 看作可优化的图/网络（节点 prompt、边连通、agent 重要性打分）；MASS 发现 prompt 与拓扑同等重要，先局部 prompt 再拓扑再全局 prompt。
- **从"一个最优系统"到"按 query 采样"**：MaAS 的 agentic supernet 用 controller 为每个 query 采样子网，实现成本感知的动态资源分配（6–45% 成本）。这正是"按节点选引擎/选能力"的理论原型。
- **运行时编排器**：Magentic-One 的双 ledger 与 stall→replan 循环已被 Microsoft Agent Framework 产品化，并加上人审的 `MagenticPlanReviewRequest`（plan 首次与 stall 触发的 replan 都可人审）。LLMCompiler 表明"LLM 作 planner 产出 DAG，执行器并行跑"能带来 3.7× 延迟改善。
- **2026 年的 harness 层优化**：Meta-Harness 让 coding agent 直接改 harness 代码，关键洞见是"不要压缩反馈——proposer 必须能读到完整执行 trace 才能把失败归因到具体 harness 决策"；HARBOR 在生产中把 harness 的旗标空间当作贝叶斯优化问题并输出 pass-rate/cost Pareto 前沿；AutoSaddler 强调补丁必须"durable"（跨场景泛化）而非修单点。三者共同说明：**harness 会持续自演化，上层架构必须把 harness 当作可替换、可评测、带版本的黑盒**。

### 4. "元编排 Agent"的关键设计问题

**(a) 如何表达节点的能力需求**。综合 AgentSquare 的模块化 IO、Symphony 的 issue 归一化模型、Claude `agent()` 的 opts、Cursor API 的请求体，节点需求可表达为：

```json
{
  "node_id": "review-security",
  "task_class": "code_review",
  "inputs": {"repo": "...", "ref": "...", "files": ["..."]},
  "output_schema": {"type":"object","required":["findings"]},
  "requires": {
    "capabilities": ["fs.read", "shell.exec", "structured_output"],
    "isolation": "worktree",
    "session": {"mode": "fresh" | "continue", "key": "group:123"},
    "permission_profile": "read-only"
  },
  "prefers": {"quality_tier": "high", "max_cost_usd": 2.0, "max_latency_s": 600},
  "fallback": ["engine:claude-code", "engine:codex", "engine:opencode"],
  "human_gate": {"before": false, "after": "if findings.severity>=high"}
}
```

**(b) 引擎选择**。三段式：① 硬过滤（能力清单包含 `requires`、权限/沙箱可满足、session 模式可满足）；② 打分（MaAS/RouteLLM 式的成本-质量预测 + 该 `task_class` 上的历史成功率与验证通过率）；③ 有限探索（对分数接近的引擎按小比例探索，Anthropic 经验表明 token 用量本身是最强的性能预测因子，因此打分里要显式包含 effort/预算维度）。

**(c) 失败回退**。借鉴 Symphony：claim 状态机 + 指数退避 + stall 超时 + tracker 驱动的重启恢复；借鉴 Claude Workflow：`null` 结果显式过滤、失败后缀重跑、schema 校验 5 次即止；借鉴 Magentic：连续无进展计数超阈值即 replan 而非继续轮询。回退阶梯：同引擎重试 → 同引擎更高 effort/模型 → 备选引擎 → 降级为人工。

**(d) 人机审批**。三处标准锚点：计划审批（Magentic `PlanReviewRequest`、Claude Workflow 启动前的阶段列表确认）、工具级审批（Codex `approval_policy`、Claude `PreToolUse`/`canUseTool`）、结果门（Paperclip 审批门、`/goal` 的第三方评估器、`TaskCompleted` hook 退出码 2）。Symphony 的原则值得照抄："run 不得无限期等待审批"，需要人输入的 turn 应立即失败并进入重试/升级。

**(e) 可解释性**。每个决策落一条"决策记录"：输入需求、候选引擎与分数、选中理由、预算、后续结果；执行侧用 Magentic ledger（facts/guesses/plan + 五问）和 Claude `journal.jsonl` 的思路持久化每个节点的输入输出；遥测用 `workflow.run_id/workflow.name` 一类属性把整个 run 串起来。

**(f) 已知失败模式**（MAST + 实践）：步骤重复与不知停止条件（合计 ~28%）→ 需要外部计数器与 dry-run 阈值；推理-行动不一致（13.2%）→ 需要 False-success 检测（用环境状态而非 agent 自述判定完成）；验证缺失/错误（17.3%）→ 独立验证 agent，且验证失败要标 `unverified` 而非 `refuted`（Claude `/deep-research` 2.1.x 修复过这个错误）；文件冲突→ worktree 隔离或按文件分区；成本失控 → `budget` 硬上限 + Large workflow 警告 + Paperclip 式月度预算；跨 agent 的"审批转述"→ 必须视为不可信输入（Claude auto 模式对 `SendMessage` 的处理）。

## 可编程接入面

| 系统 | 接入方式 | 关键参数/协议片段 |
|---|---|---|
| Claude Code Workflow | Workflow 工具（SDK/`-p` 可用）；`claude --effort ultracode`；`/workflows`、`/deep-research`、`/<saved-name>` | 工具输入 `{script | scriptPath | name, args, resumeFromRunId}`；`agent()` opts；`Workflow(<name>)` 权限规则；`workflowSizeGuideline`；`CLAUDE_CODE_DISABLE_WORKFLOWS`、`CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS` |
| Claude Agent Teams | 仅交互式 session（`-p`/SDK 不可用） | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`、`teammateMode`、`--teammate-mode`、`CLAUDE_CODE_SUBAGENT_MODEL`；hooks `TeammateIdle/TaskCreated/TaskCompleted` |
| Claude `/goal` `/loop` | `claude -p "/goal <cond>" --output-format stream-json --verbose` | `CLAUDE_CODE_GOAL_CHECKIN_MINUTES`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`CronCreate/CronList/CronDelete`、`CLAUDE_CODE_DISABLE_CRON` |
| OpenAI Symphony | 仓库内 `WORKFLOW.md` + daemon；可选 HTTP `GET /api/v1/state`、`GET /api/v1/<issue_identifier>`、`POST /api/v1/refresh` | `codex.command = "codex app-server"`；`approval_policy/thread_sandbox/turn_sandbox_policy`；hooks `after_create/before_run/after_run/before_remove` |
| Gas Town | `gt` CLI（`gt install`、`gt rig add`、`gt mayor attach`、`gt convoy create`、`gt sling`、`gt feed`、`gt escalate`、`gt seance`）；`bd` CLI | `settings/config.json` 配置 agent provider；TOML formula |
| Cursor Cloud Agents | REST + SSE | 见关键事实 #20 |
| Multica / Paperclip / vibe-kanban | 自托管服务 + 本地 daemon/适配器；Paperclip 有 HTTP/webhook 适配器 | `npx vibe-kanban`、`npx paperclipai onboard --yes`、Docker Compose/Helm |
| Magentic（MS Agent Framework） | Python/.NET SDK | `MagenticBuilder(max_round_count=10, max_stall_count=3, max_reset_count=2, enable_plan_review=True)`；`MagenticPlanReviewRequest.approve()/revise()` |

## 会话模型

- **Claude Workflow**：run 隶属于发起它的 session；每个 `agent()` 是一次性子 agent（own context），`isolation:'worktree'` 给独立 git 工作树；resume 只在同一 session（或后台化/`--resume` 后的同 session 目录）有效。Agent Teams 的 teammate 是完整 session，但 `/resume` 不恢复 in-process teammates。
- **Symphony**：以 issue 为会话锚点，一个 worker 生命周期内复用 `thread_id`，`session_id = thread_id-turn_id`；进程重启后 thread 不恢复，靠 tracker 重新 dispatch。
- **oh-my-symphony**：各 CLI 的续话原语不同（`--resume`、`--session`、常驻 JSON-RPC），网关必须把"会话键 → 引擎会话句柄"的映射自己存下来。
- **Gas Town**：polecat 身份持久、session 临时，工作状态在 bead/hook（git）里；Seance 可读前任 session 的 `.events.jsonl`。
- **Cursor**：agent（持久元数据）与 run（一次执行）两级，追问 = 新 run，取消是终态。

对网关的含义：业务会话键（如群 id）→ 网关会话 → 引擎会话句柄（thread_id / `--resume` id / `--session`）的三级映射，需要网关持久化并处理"引擎句柄失效 → 从网关侧记忆重建"的路径 [推测]。

## 权限与安全

- Claude：Workflow 启动本身受权限评估（allow 规则 / auto 分类器 / bypass / `PreToolUse` / `canUseTool`）；子 agent 受 session 权限规则与 sandboxing；teammate 权限在 spawn 时继承 lead，不能按 teammate 设定；agent 间消息被标记为"来自另一个 Claude session"，不能替用户批准；auto 模式的分类器会审查每条跨 agent 消息；脚本沙箱禁 `import()`、禁 fs/shell；保存脚本时检查 symlink（v2.1.216+）；`scriptPath` 读取前先过权限检查（v2.1.251）[已确认]。
- Symphony：workspace 路径必须在 root 之下、identifier 清洗；不把 tracker token 传给子进程，adapter 声明需要移除的秘密 env；hook 脚本被视为完全受信配置但必须有超时；审批姿态由实现自定并文档化 [已确认]。
- Gas Town：默认接近 YOLO；真实记录显示会在测试失败时合并、会误删 [第三方]。
- Magentic-One 论文记录了 agent 反复登录导致账号被封、擅自接受 cookie/条款、试图在社交媒体招募人类等风险，建议最小权限与最大监督 [已确认]。

## 扩展机制与资产

- Claude：工作流脚本是一等资产（`.claude/workflows/*.js`、`~/.claude/workflows/`、插件 `workflows/` 目录 + manifest `workflows` 字段），`meta.name/description/whenToUse/phases` 用于列表与审批对话框；`agentType` 复用 subagent 定义（project/user/plugin/CLI 作用域）；teammate 也可引用 subagent 定义（`tools`、`model`、body 生效，`skills` 不生效，`mcpServers` 仅 split-pane 生效）[已确认]。
- Symphony：`WORKFLOW.md` 是仓库内资产，prompt 模板 + 配置合一，版本化、可 review、热重载；tracker adapter 是扩展点（REQUIRED 的 `fetch_issues_by_states/fetch_issues_by_ids`，可选 provider-native agent tools）[已确认]。
- Gas Town：TOML formula → molecule；Wasteland 的 stamps（多维度质量/可靠性/创造力证明）[已确认]。
- 研究侧：AFlow 的 operators、AgentSquare 的四模块、Meta-Harness 的 harness 目录（源码+分数+trace）都是可枚举、可版本化的"编排资产"。

## 记忆

- Claude Workflow 本身无跨 run 记忆，只有 run 内的 `journal.jsonl`（用于 resume）和脚本变量；子 agent 自带 CLAUDE.md/项目记忆。Agent Teams 的任务列表目录持久化（受 `cleanupPeriodDays` 清理），team config 会话结束即删 [已确认]。
- Symphony：无持久 DB，所有状态在 tracker + 文件系统 [已确认]。
- Gas Town/Beads：git 版本化账本即长期记忆，Seance 查询前任 session [已确认]。
- Magentic：Task Ledger 是显式的任务内短期记忆（事实/猜测/计划），replan 时更新 [已确认]。
- Meta-Harness/AutoSaddler：把历史候选的 trace 与分数当作 proposer 的"记忆"，是自进化的记忆载体 [已确认]。

## 多 Agent 与协作

三种协作拓扑在本专题中都有代表：**脚本驱动的 fan-out/verify/synthesize**（Claude Workflow、LLMCompiler DAG）、**lead-worker + 共享账本/邮箱**（Agent Teams、Magentic 的 orchestrator-participants、Gas Town 的 Mayor-polecats、Paperclip 的 org chart）、**看板/issue 驱动的无中心 claim**（Symphony、Multica、vibe-kanban）。Anthropic 的经验是编排者必须给子 agent 明确目标、输出格式、工具指引与边界，并按复杂度分配 agent 数量（简单 1 agent/3–10 次工具调用，复杂 10+ 子 agent）[已确认]。Claude 文档强调 teammates 不做 worktree 隔离，需按文件分区 [已确认]。

## 可观测性

- Claude：`/workflows` 视图（阶段/agent/token/耗时/状态过滤）；OTel 属性 `workflow.run_id`、`workflow.name`（v2.1.202）；`journal.jsonl` 与 `agent-<id>.jsonl`；hooks（`SubagentStart/Stop`、`TaskCreated/Completed`、`TeammateIdle`、`Stop` 的 `last_assistant_message`）；`/goal` 的裁决与理由入 transcript；`/usage` 的 Loops 分解（v2.1.243）[已确认]。
- Symphony：结构化日志必须带 `issue_id/issue_identifier/session_id`，`key=value` 格式；运行快照含 `running/retrying/codex_totals/rate_limits`；token 以 `thread/tokenUsage/updated` 差分累计 [已确认]。
- Gas Town：`gt feed` 实时看板、Problems 视图、`.events.jsonl` [已确认]。
- Cursor：SSE 事件流 + `Last-Event-ID` 断点续传 + per-run usage [已确认]。
- Magentic：`PLAN_CREATED/REPLANNED/PROGRESS_LEDGER_UPDATED` 事件携带完整 ledger [已确认]。

## 对我们架构的启示（公共能力 vs 扩展能力映射表、接入参数、风险与坑）

### 公共能力 vs 引擎扩展能力

| 能力 | 归类 | 依据与归一化方式 |
|---|---|---|
| 一次性任务执行（prompt → 结果，可带 output schema） | 公共 | 所有引擎都有（`claude -p --json-schema`、Codex `turn/start`、Cursor `POST /v1/agents`）；网关统一 `run(task, schema)` |
| 会话续接（resume/continue） | 公共（句柄形态为引擎特有） | `--resume`、`--session`、`thread_id`、Cursor `runs`；网关保存 `engine_session_ref` 并做映射 |
| 事件流（started/tool_call/turn_completed/failed/usage） | 公共 | oh-my-symphony 三事件 + usage 快照；Cursor SSE 事件；Symphony `thread/tokenUsage/updated`；归一为 T18 事件模型 |
| 工具级审批与沙箱策略 | 公共（参数值引擎特有） | Codex `approval_policy/thread_sandbox/turn_sandbox_policy`；Claude 权限模式与 allow 规则；网关暴露 `permission_profile` 并按引擎翻译 |
| worktree/workspace 隔离 | 公共 | Claude `isolation:'worktree'`、Symphony workspace、Conductor/Squad/`/batch`；网关统一 `isolation` 参数 |
| 停止/超时/stall/重试 | 公共（网关实现） | 照抄 Symphony 的 claim 状态机与退避公式；不依赖引擎 |
| 完成条件评估（goal） | 公共（网关实现更稳） | `/goal` 仅 Claude 有；网关可用独立小模型 + 环境状态检查实现跨引擎的 goal 循环 |
| 动态工作流脚本（`agent/pipeline/parallel`） | 扩展（Claude Code） | 参数：`Workflow` 权限、`workflowSizeGuideline`、`budget`、`resumeFromRunId`、`isolation`、`agentType`、`effort` |
| Agent Teams（邮箱、共享任务列表、TeammateIdle hook） | 扩展（Claude Code，且仅交互式） | 参数：`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`、`teammateMode`；SDK/`-p` 不可用，网关不应依赖 |
| `/loop`、cron、ScheduleWakeup | 扩展（Claude Code） | 网关自有调度器更通用 |
| Issue/看板驱动 dispatch | 扩展（Symphony/Multica/vibe-kanban 层） | 网关可实现 tracker adapter 契约 |
| 角色化工厂（Mayor/Polecat/Refinery、convoy、formula） | 扩展（Gas Town） | 通过 `gt` CLI 接入；不建议作为公共抽象 |
| 云端 agent 服务化（REST+SSE+usage+artifacts） | 扩展（Cursor） | 可作为"远程引擎"接入模板 |
| harness 自进化（Meta-Harness/AutoSaddler） | 扩展（研究/离线） | 网关只需支持"harness 版本化 + A/B 评测 + 回滚" |

### 接入参数清单（新引擎接入时需采集）

1. 启动方式与协议：CLI 一次性（`-p`）/ 常驻 RPC（app-server）/ HTTP；输出格式（stream-json / JSONL / SSE）。
2. 会话句柄：如何取得与续接（`--resume <id>`、`--session`、`thread_id`、`agent_id+run`）；句柄有效期；进程重启后是否可恢复。
3. 权限/沙箱旋钮：审批策略枚举、沙箱模式、可否由宿主回调审批（`--permission-prompt-tool`/`canUseTool`/`requestApproval`）。
4. 结构化输出：是否支持 schema 约束与失败重试上限。
5. 并发与速率：引擎自身并发上限（Claude Workflow 16）、速率限制事件字段。
6. 用量与成本：token 字段（input/output/cache read/write）、是否为绝对累计值。
7. 可观测：事件类型、trace 属性（如 `workflow.run_id`）、hook 点。
8. 扩展能力清单：dynamic workflow、team、worktree、cron、goal、MCP、plugin，以及各自的开关与版本要求。
9. 版本与特性开关：如 Claude 的 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`、`disableWorkflows`、组织级 managed settings。

### 风险与坑

- **关键字触发只认人类输入**：从网关（SDK/`-p`）想启动 Claude 动态工作流，必须走 Workflow 工具 + 权限规则，`ultracode` 关键字不生效（v2.1.210+）。
- **Agent Teams 不可编程**：`-p`/SDK 下 teammate 退化为普通 subagent；不要在网关设计里依赖它。
- **Resume 的失败放大**：中间一个 agent 失败会重跑其后所有 agent；脚本要把 `null` 显式过滤并把可重试逻辑放进脚本。
- **成本**：多 agent ≈ 15× 聊天 token；Gas Town 实测 $100/小时；网关必须有 `budget` 硬上限与"先小切片试跑"的默认策略。
- **完成判定不能信 agent 自述**：MAST 的推理-行动不一致与错误验证合计 >20%；`/goal` 评估器也只看 transcript；网关应加环境状态检查（测试/CI/文件存在性）。
- **审批不可转述**：跨 agent 消息里的"已批准"要当不可信输入。
- **harness 层改动高风险**：Meta-Harness 记录 prompt/completion 逻辑改动引发连续六次回归；引擎版本升级要有回归评测。
- **产品生命周期**：vibe-kanban 已 sunsetting；Claude Agent Teams 仍是实验特性且 API 在 2.1.150→2.1.178 间已重构一次；接入层需要版本探测。

## 未解决问题

1. Claude Agent SDK 的 Workflow 工具在 SDK 侧的消息类型（run 进度事件）本次未能从 TypeScript 参考页完整抓取（页面截断）；已知输入字段来自内置 skill 原文。
2. OpenAI Symphony 官方博客被 Cloudflare 拦截，"PR +500%""三周"等数字来自中文转述，需二次核对。
3. Gas Town 的 GUPP 原文定义与 v1.0 时间线（Medium 403）未能直接核对；paddo.dev 的 "Git Up, Pull, Push" 解释疑似误读。
4. HARBOR/AutoSaddler 是否有开源实现、能否作为网关的离线 harness 评测器，未验证。
5. 研究侧的引擎路由（RouteLLM 之后的 agent-level router、bandit 路由）在真实多 harness 场景的公开评测仍缺乏；我们的"历史成功率"打分需要自建评测集。
6. Claude Workflow 的 `budget` 与组织级 `availableModels` 替换规则在 Bedrock/Vertex 上的行为差异未测试。

## 来源列表

- https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
- https://code.claude.com/docs/en/workflows
- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/agents
- https://code.claude.com/docs/en/goal
- https://code.claude.com/docs/en/scheduled-tasks
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/changelog 与 https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
- https://code.claude.com/docs/en/whats-new/2026-w34
- Claude Code 内置 `/workflow-authoring` skill（v2.1.248+，本次直接加载）
- https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/ralph-wiggum/README.md
- https://www.infoq.com/news/2026/06/dynamic-workflows-claude-code/
- https://raw.githubusercontent.com/openai/symphony/main/SPEC.md
- https://raw.githubusercontent.com/openai/symphony/main/README.md
- https://liduos.com/agentic-coding/open-source-spec-for-codex-orchestration-symphony
- https://raw.githubusercontent.com/cskwork/oh-my-symphony/main/README.md
- https://yegge.ai/gastown
- https://raw.githubusercontent.com/gastownhall/gastown/main/README.md
- https://www.dolthub.com/blog/2026-01-15-a-day-in-gas-town/
- https://paddo.dev/blog/gastown-two-kinds-of-multi-agent/
- https://cursor.com/docs/cloud-agent/api/endpoints
- https://www.conductor.build/docs/
- https://raw.githubusercontent.com/BloopAI/vibe-kanban/main/README.md
- https://raw.githubusercontent.com/multica-ai/multica/main/README.md
- https://raw.githubusercontent.com/smtg-ai/claude-squad/main/README.md
- https://raw.githubusercontent.com/paperclipai/paperclip/master/README.md
- https://arxiv.org/abs/2411.04468 与 https://arxiv.org/html/2411.04468v1 （Magentic-One）
- https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic
- https://arxiv.org/abs/2408.08435 （ADAS）
- https://arxiv.org/abs/2410.10762 与 https://raw.githubusercontent.com/FoundationAgents/AFlow/main/README.md （AFlow）
- https://arxiv.org/abs/2502.04180 （MaAS）
- https://arxiv.org/abs/2502.02533 （MASS）
- https://arxiv.org/abs/2410.06153 （AgentSquare）
- https://arxiv.org/abs/2402.16823 （GPTSwarm）
- https://arxiv.org/abs/2310.02170 （DyLAN）
- https://arxiv.org/abs/2309.17288 （AutoAgents，摘要来自搜索结果）
- https://arxiv.org/abs/2406.04692 （Mixture-of-Agents，摘要来自搜索结果）
- https://arxiv.org/abs/2312.04511 （LLMCompiler，摘要来自搜索结果）
- https://arxiv.org/abs/2406.18665 （RouteLLM，摘要来自搜索结果）
- https://arxiv.org/abs/2603.28052 与 https://arxiv.org/html/2603.28052v1 与 https://raw.githubusercontent.com/stanford-iris-lab/meta-harness/main/README.md （Meta-Harness）
- https://arxiv.org/abs/2604.20938 （HARBOR，摘要来自搜索结果）
- https://arxiv.org/abs/2608.23041 （AutoSaddler）
- https://arxiv.org/abs/2503.13657 与 https://arxiv.org/html/2503.13657v3 （MAST）
- https://www.anthropic.com/engineering/built-multi-agent-research-system
