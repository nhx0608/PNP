# T20 Agent 记忆系统与跨引擎统一记忆层

## 摘要
业界 Agent 记忆系统可分两大流派：一是独立于具体 harness 的**记忆即服务**（Mem0、Zep/Graphiti、Letta、Cognee、LangMem、Supermemory、Honcho、MemOS），提供 add/search/get_all/update/delete 或等价 API，作用域用 user_id/agent_id/run_id 或 peer/session 建模；二是**引擎原生记忆**，几乎全部收敛为"分层 Markdown 文件（CLAUDE.md/AGENTS.md/GEMINI.md/MEMORY.md）+ 会话开始时全量注入 + 引擎自身工具增量写入"的模式（Claude Code、Codex、Gemini CLI、OpenClaw），少数引擎（Hermes）直接原生绑定第三方记忆服务（Honcho）。Claude 官方 memory tool 是最值得借鉴的协议范式——六个纯客户端命令（view/create/str_replace/insert/delete/rename）全部限定在 `/memories` 前缀、存储与安全校验完全交给调用方，天然适合被网关直接实现为跨引擎复用的统一 handler。Honcho 的 peer/session 双轴模型和 Letta 的 git 版本化 MemFS 分别为"群/租户记忆隔离"和"记忆变更可观测"提供了现成参照。建议架构：记忆作为**网关级公共能力**（统一 read/write/consolidate 接口，读时注入 prompt/system，写时从 message 轨迹异步抽取），引擎原生记忆机制（Auto Memory、Dreaming、sleep-time）作为**可选扩展能力**开关，两者不应在同一轮评测中同时写入以避免冲突；群助手场景建议用"room_id 映射为记忆命名空间前缀 + 引擎工作目录物理隔离"双重手段实现群间隔离。LoCoMo/LongMemEval/MemBench 可作为记忆能力的评测题库，但相对赛题的 Windows 办公任务客观分主战场，记忆层更偏架构完整性/创新加分项。

## 关键事实

| 事实 | 来源 | 置信度 | 交叉验证 |
|---|---|---|---|
| Claude 官方 memory tool 是纯客户端工具：`tools:[{"type":"memory_20250818","name":"memory"}]`，六个命令 view/create/str_replace/insert/delete/rename，全部操作限定在 `/memories` 前缀下，服务端只发 tool_use 请求，存储和路径校验完全由调用方实现 | platform.claude.com/docs/.../memory-tool（一手） | 高 | 是（文档正文+SDK代码示例两处一致）|
| Claude 的 context editing 是服务端能力，与 memory tool 客户端能力是两个独立机制，二者可组合使用；官方 cookbook 称二者组合较 baseline 提升 39%，100 轮网页搜索场景下降低 84% token 消耗 | platform.claude.com memory-tool 页 + WebSearch 摘要（Claude Cookbook） | 中 | 否（数字来自二手摘要未直接核对原文表格）|
| Letta 采用 MemFS（git 版本化的记忆文件系统），核心记忆（persona/human）常驻上下文，durable 材料放入 MemFS；`/init` 引导、`/remember` 手动写入、`/sleeptime` 后台巩固、`/doctor` 记忆体检 | docs.letta.com/letta-agent/memory（一手，经 WebFetch） | 中 | 否，术语与 Letta 早期 MemGPT 论文的 core/archival/recall 三级记忆概念存在演进差异，需以此页面为准 |
| Letta Memory Block 数据模型：label + value + character limit，可在多个 agent 间共享，可通过 API 直接增删改查 | letta.com/blog/memory-blocks（WebSearch 摘要） | 中 | 否 |
| Mem0 Platform 的 Graph Memory 已从"外接 Neo4j/Memgraph"演进为内置原生图（无需 `enable_graph`，`relations` 字段恒为空列表），实体自动抽取并用于跨记忆的关联检索打分 | docs.mem0.ai/platform/features/graph-memory（一手，WebFetch） | 高 | 是（该页原文与 mem0.ai/blog/graph-memory-solutions-ai-agents 摘要方向一致）|
| Mem0 标准 API 为 add()/search()/get_all()/update()/delete()，作用域参数为 user_id / agent_id / run_id | docs.mem0.ai（一手） | 高 | 否 |
| Zep 由 Graphiti 驱动，构建 bi-temporal 知识图谱：每条 edge 带有效期区间（生效/失效时间戳），旧事实失效而非被删除，从而支持事实演化查询；底层图存储可选 Neo4j/FalkorDB/Kuzu，Zep Cloud 托管、自建版需自管图数据库 | arxiv 2501.13956 + neo4j.com/blog graphiti 介绍 + getzep.com（WebSearch 摘要综合） | 中 | 是（论文摘要+Neo4j博客+Zep官网三处方向一致）|
| OpenAI Codex CLI 记忆分两层：静态 `AGENTS.md`（会话开始加载，32KiB 上限，超出静默截断）+ 生成层 `~/.codex/memories/`（后台对历史会话做摘要，逐会话读取），均为本地、单机存储，无跨机同步；Memories 功能在 EEA/UK/瑞士地区上线时被屏蔽 | WebSearch 综合多篇二手技术博客（mem0.ai blog、codex.danielvaughan.com 等） | 中 | 否，未直接抓取 OpenAI 官方文档原文，建议以此为"推测/二手"标注 |
| Gemini CLI 通过 `save_memory` 工具把事实写入 Markdown（`write_file`/`replace`），按层级路由：仓库级 `./GEMINI.md`（团队共享指令）、项目私有目录、全局 `~/.gemini/GEMINI.md`（跨项目个人偏好）；`/memory show` 可查看当前拼接后的完整上下文 | geminicli.com/docs/tools/memory + google-gemini/gemini-cli GitHub docs（WebSearch 摘要，来源为官方仓库文档） | 高 | 是（GitHub 官方仓库 docs 路径 + geminicli.com 镜像站描述一致）|
| Hermes Agent（NousResearch）原生集成 Honcho 作为记忆后端：两层上下文注入（base layer = session summary + representation + peer card，按 contextCadence 刷新；dialectic supplement = LLM 推理层，按 dialecticCadence 刷新，1-3 pass），暴露 honcho_profile / honcho_search / honcho_context / honcho_reasoning / honcho_conclude 五个工具；多个 Hermes 实例共享同一用户时，Honcho 以 "peer" 概念隔离各自的观察与结论 | hermes-agent.nousresearch.com/docs/.../honcho + honcho.dev/docs/v3/guides/integrations/hermes（WebSearch 摘要，一手文档站） | 中 | 否，术语细节（如工具名）来自搜索引擎摘要而非直接页面抓取，需要后续二次核实 |
| OpenClaw 的记忆完全落地为纯文本：`USER.md`（稳定偏好）+ `MEMORY.md`（长期事实/决策）+ `memory/YYYY-MM-DD.md`（逐日追加日志）+ `DREAMS.md`（后台巩固摘要供人审阅），辅以 `memory.sqlite`（sqlite-vec 扩展做向量检索）；`memory_search`/`memory_get`/`intent` 三个工具，"Dreaming" 后台进程做阈值化的短期观察→长期记忆晋升，并在上下文 compaction 前做记忆 flush | docs.openclaw.ai/concepts/memory（一手，WebFetch） | 高 | 是（该官方页面与 cenrax.substack.com/coolmanns GitHub 第三方分析方向一致）|
| LoCoMo：50 组人机协同生成的多会话对话，单会话链最长 35 轮 session、平均约 300 turn，配约 200 个 QA 对，覆盖 single-hop/multi-hop/open-domain/temporal 四类推理；LongMemEval：500 道题、6 大类（用户信息/助手回复/偏好/知识更新/时间推理/多会话交互），底层对话可扩展到百万 token 级；MemBench 聚焦信息抽取、多跳推理、知识更新、偏好遵循、时间推理五个维度 | mem0.ai/research + 多篇 arXiv 论文摘要（WebSearch 综合） | 中 | 否，具体数字来自二手摘要，建议真正引用时回查 LoCoMo/LongMemEval 原论文表格 |
| MemOS 提出 MemCube 作为统一记忆调度单元（Metadata Header 管生命周期/权限/存储策略 + Memory Payload 装 plaintext/激活态/参数增量三种异构记忆），三层架构 Interface/Operation/Infrastructure Layer，Interface 层暴露 Provenance API / Update API / LogQuery API；GitHub 仓库自述已支持 DeepSeek Harness 接入，声称 35.24% token 节省 | arxiv.org/abs/2507.03724、2505.22101 + github.com/MemTensor/MemOS（WebSearch 摘要） | 中 | 是（论文摘要与 GitHub README 描述方向一致）|

## 架构与工作原理

从架构形态看，业界记忆系统可以分成三大流派，这对我们设计"网关级统一记忆层 vs 引擎原生记忆扩展能力"至关重要：

**1）第三方记忆服务（memory-as-a-service），与具体 harness 解耦，通过 SDK/HTTP API 挂接**：
- **Mem0**：最主流的开源+托管双形态方案。核心抽象是"memory"对象（一条事实/观察），通过 `add(messages, user_id, agent_id?, run_id?)` 写入，LLM 自动做事实抽取与去重合并（ADD/UPDATE/DELETE 决策），`search(query, filters)` 做混合检索。Platform 版本内置 Graph Memory（实体自动抽取，节点/关系原生维护，无需自建 Neo4j）。
- **Zep（Graphiti 内核）**：核心抽象是"episode"（一次会话/事件/观察输入），Graphiti 引擎将其拆解为实体节点、关系边、时间属性，构建 **bi-temporal 知识图谱**——每条边有 valid_at / invalid_at 区间，事实变化时旧事实被标记失效而不是删除，从而可回答"在 t 时刻什么是真的"。自建需要 Neo4j/FalkorDB/Kuzu 之一作为图存储后端；Zep Cloud 托管免运维。
- **Letta（原 MemGPT 血脉）**：把"记忆"当成操作系统式的分层资源管理问题。**Memory Block**（label + value + char limit）是常驻上下文的核心记忆单元，可在多个 agent 间共享、可通过 API 单独 CRUD；**MemFS** 是 git 版本化的第二层存储，容纳不需要常驻上下文但需要长期保留的材料，由后台"sleep-time agent"周期性反思对话历史后以 commit 形式写入（在独立 git worktree 中操作、自动合并，避免与在跑的主 agent 冲突）。这种"git 分支式记忆演进"对我们理解引擎原生记忆的"版本化"很有参考性。
- **Cognee**：主打 **ECL（Extract-Cognify-Load）管线**，把任意输入数据结构化为知识图谱后再做检索，定位是"最完整的图原生记忆框架"，支持 MCP 协议对外暴露、可自托管。
- **LangMem**：LangChain 生态原生的长期记忆库，专为 LangGraph 工作流设计，走向量优先（非图）路线，提供会话内摘要 + 语义记忆抽取两种粒度。
- **Supermemory**：定位"memory API for the AI era"，核心概念是 **Space**（团队/项目级容器，通过 container tag 做精确分组）+ **Memory Graph**（记忆节点为六边形、文档节点为矩形的可视化关系图）。`add_memory` 写入，支持 `action:forget` 主动遗忘过时事实；`search_memory` 默认在返回语义相关记忆的同时附带"稳定+近期的用户画像上下文"。
- **Honcho**：为多 agent/多 peer 场景设计的记忆库，核心抽象是 **peer**（对应一个用户或一个 agent 身份）+ **session**（一次交互聚合），通过 dialectic（辩证式）双层注入——base layer（session summary + representation + peer card）与 dialectic supplement（LLM 实时推理层，支持 1-3 pass、按 cold/warm 场景切换 prompt）。多个 agent 实例接同一 Honcho 后端时，各 peer 的观察/结论天然隔离，不会互相污染——这是"群/租户级记忆隔离"的一个可直接借鉴的现成设计。
- **MemOS**：定位不是又一个记忆库，而是"记忆操作系统"，用 **MemCube**（Metadata Header + Memory Payload）统一调度三种异构记忆载体（明文记忆、模型激活态、参数级记忆增量），并显式声明已支持接入 DeepSeek Harness (dsh)，这与我们赛题里 dsh 引擎的存在形成呼应，值得作为"网关级统一记忆抽象"的直接参考对象。
- **A-Mem**：本次调研未抓到一手页面（搜索结果被 Cognee/MemOS 等挤占），属于"自组织笔记式"记忆代表工作（Zettelkasten 式动态链接记忆卡片），标注为**推测/待补**，不作为强结论使用。

**2）引擎原生记忆（内建在 harness 内部，随会话自动读写，通常是 Markdown 文件 + 可选向量索引）**：
- **Claude Code**：CLAUDE.md（人写的项目/用户指令）+ Auto Memory（Claude 自己写的便签，源于用户纠正/偏好），二者在会话开始时一起加载；作用域从广到窄为 Managed policy（组织级）> 用户级 > 项目级 > 本地（CLAUDE.local.md），窄作用域覆盖宽作用域；`/memory` 命令可浏览/编辑所有层级文件。
- **Claude API 的 memory tool**：与 Claude Code 的自动记忆是两套不同机制——memory tool 是纯客户端工具，服务端仅发出 view/create/str_replace/insert/delete/rename 六种 tool_use 请求，实际存储、路径校验、容量控制全部由调用方（即我们的网关或引擎适配层）实现，这使其天然适合被"网关级统一记忆服务"直接实现为 handler。
- **Codex CLI**：AGENTS.md（静态指令，32KiB 截断上限）+ `~/.codex/memories/`（后台生成的会话摘要，逐会话读取），纯本地单机存储，无云同步（官方未公开存储格式细节，标注推测）。
- **Gemini CLI**：`save_memory` 工具将事实追加进 Markdown，按"仓库共享 GEMINI.md / 项目私有 / 全局 ~/.gemini/GEMINI.md"三层路由；`/memory show` 查看拼接后的最终上下文——这是我们能直接照抄的"分层 Markdown 记忆 + 命令行自省"模式。
- **Hermes Agent**：官方深度绑定 Honcho（见上），属于"引擎原生但外包给专用记忆服务"的中间形态，对我们很有参考价值——说明"网关统一记忆层"完全可以从某个引擎的原生集成中直接抽取复用。
- **OpenClaw**：全 Markdown + SQLite(vec 扩展) 方案，四类文件（USER.md/MEMORY.md/memory/日期.md/DREAMS.md）+ `memory_search`/`memory_get`/`intent` 三工具 + "Dreaming"后台巩固进程，是目前调研到的"纯文件系统记忆"里设计最完整的参考实现，且明确支持接入 Cognee / Mem0 作为可插拔的图/向量增强插件。
- **opencode / pi / dsh**：三者的记忆能力均以 AGENTS.md 家族文件为主，opencode 配置落在 `~/.config/opencode/opencode.json`，会话状态存本地 session store；dsh 原生加载 `~/.dsh/AGENTS.md` + 项目级 AGENTS.md 链（`dsh-agent-instructions`）；pi 通过 `pi-plugin`/`MemoryCore` 这类第三方插件对接外部记忆服务（如 dsh、mem0），本身不内置复杂记忆模型。以上信息均来自二手技术博客/生态仓库 README（如 zilliztech/memsearch、fatwang2/pi-dsh），未能抓到 opencode/pi/dsh 各自的一手官方文档页，**标注为中低置信度、建议在后续任务中用官方仓库源码交叉确认**。

## 可编程接入面

- Claude memory tool：`tools:[{"type":"memory_20250818","name":"memory"}]`，无需额外 input schema；Anthropic 官方 Python/TS/Java/C# SDK 提供 `BetaAbstractMemoryTool` 基类与 `BetaLocalFilesystemMemoryTool` 现成实现；Go/Ruby 需手写 tool-use loop。
- Mem0：REST/SDK 双形态，`client.add()/search()/get_all()/update()/delete()`，作用域通过 `user_id`/`agent_id`/`run_id` 三元组传入——这组三元组的命名和粒度与我们赛题"业务→session 映射（用户/群/租户/agent/会话）"高度对应，可直接映射。
- Zep：Graphiti 暴露 episode 摄入接口（`add_episode`）与图查询接口；自建需连接 Neo4j/FalkorDB/Kuzu 的连接串；Zep Cloud 走托管 REST API。
- Letta：Memory Block 有独立 REST 端点可直接 CRUD；MemFS 走 git 协议（可用标准 git 客户端操作，也可通过 Letta 的 API 间接读写）。
- Honcho：五个工具函数形态的 API（`honcho_profile`/`honcho_search`/`honcho_context`/`honcho_reasoning`/`honcho_conclude`），既可作为 agent 可调用的 tool，也可作为宿主应用直接调用的 SDK 方法。
- OpenClaw：`memory_search`/`memory_get`/`intent` 是暴露给 LLM 的 agent tool，而不是外部 HTTP API；底层存储是本地文件系统+sqlite，宿主应用如需以网关身份接管，需直接读写这些文件/DB 而非走网络协议。

## 会话模型

各记忆系统的"会话"粒度并不统一，这正是网关层需要做归一化映射的关键点：
- Mem0：`run_id` 大致对应一次任务/会话，`user_id`/`agent_id` 是更长期的身份轴；一条 memory 记录本身不强绑定某次会话，而是可跨 run 复用的"事实"。
- Zep/Graphiti：以 `session` 聚合多条 episode，session 结束不等于记忆失效——bi-temporal 图允许跨 session 持续演化同一实体的事实链。
- Letta：核心记忆（Memory Block）与"agent"绑定而非与"会话"绑定，一个 agent 可以有多个对话线程共享同一组 Block；MemFS 的更新以 sleep-time agent 的一次巡检为提交粒度，独立于对话轮次。
- Honcho：显式区分 session（一次交互聚合，产出 summary）与 peer（跨 session 的持久身份），这与我们赛题"群会话之间上下文隔离 + 群内会话连续性"的双层需求几乎完全对应——peer≈租户/群身份，session≈单次会话上下文。
- OpenClaw：日期文件（`memory/YYYY-MM-DD.md`）是天然的"日会话"聚合单位，`/new`/`/reset` 触发时自动加载今天+昨天的笔记，长期记忆（MEMORY.md）不随会话边界重置。
- Claude Code / Gemini CLI / Codex：都以"进程/会话启动"为记忆加载时点（一次性把 CLAUDE.md/GEMINI.md/AGENTS.md 全量注入 system prompt），会话内的写入通过工具调用（Auto Memory、save_memory）持续发生，但读取是会话开始时的一次性快照，不是逐轮动态检索——这与 Mem0/Zep/Honcho 的"按需检索注入"模式形成鲜明对比，是我们做统一记忆层时必须兼容的两种模式（**静态注入 vs 动态检索注入**）。

## 权限与安全

- Claude memory tool 明确把路径穿越防护责任交给调用方：文档专门给出 `/memories/../../secrets.env` 攻击示例，要求校验规范化路径、拒绝 `../`、`..\`、URL 编码穿越序列；这对我们网关实现"记忆读写 handler"时是硬性安全要求。
- Claude 官方还建议：定期清理长期未访问的记忆文件（"memory expiration"）、对写入内容做敏感信息过滤、限制单文件/总大小。
- Honcho 的 peer 隔离机制（"each peer seeing only its own observations and conclusions"）是目前调研到的**唯一在文档层面明确声明"跨身份记忆隔离"设计原则**的产品，可作为我们"群/租户记忆隔离"的直接参照对象。
- Codex Memories 因隐私法规在 EEA/UK/瑞士被屏蔽——提示我们网关层的统一记忆服务需要考虑数据驻留/合规开关（对国内内部部署场景次要，但架构上应预留）。
- 多数方案（Mem0/Zep/Letta/Supermemory）都通过显式 ID 参数（user_id/agent_id/peer/space）做逻辑隔离，隔离强度依赖调用方是否正确传参——没有一个方案在协议层面强制"群 A 的 agent 绝对读不到群 B 的记忆"，隔离的最终执行者应该是网关层而非记忆服务本身。

## 扩展机制与资产

- Mem0/Zep/Cognee/Supermemory 都提供 MCP Server 形态，可作为标准 MCP tool 被任意支持 MCP 的 harness（Claude Code、Gemini CLI、opencode 等）直接挂载，这是"记忆能力"跨引擎复用最现实的路径之一——比自建统一记忆协议更轻量。
- OpenClaw 的插件化最典型：Cognee 插件负责从其 Markdown 记忆构建知识图谱，Mem0 插件负责从对话中抽取事实存入 Mem0 自己的向量库，二者都在每次 agent 运行前把相关上下文注入 prompt——即"引擎原生 Markdown 记忆"与"第三方记忆服务"可以在同一引擎内共存，互为补充而非替代。
- Letta 的 MemFS 用 git 做版本化存储介质，意味着"记忆资产"天然可用标准 git 工具（diff/log/branch/merge）审计和管理，这对我们做"记忆变更可观测/可回滚"提供了一个现成范式。

## 记忆

（记忆分类、作用域、隐私与隔离、基准测评的完整论述见上文"架构与工作原理""权限与安全"两节，此处补充分类学总结）

**记忆分类映射**（对照认知科学的工作/情景/语义/程序记忆四分法）：
- **工作记忆**（当前任务上下文）：对应各引擎的 system prompt / 当前对话窗口，以及 Claude context editing、compaction 这类"服务端裁剪"机制。
- **情景记忆**（具体事件/交互历史）：Zep/Graphiti 的 episode、Honcho 的 session summary、OpenClaw 的日期笔记（`memory/YYYY-MM-DD.md`）、Mem0 的按 run_id 归档的对话片段。
- **语义记忆**（抽象事实/偏好/知识）：Mem0/Supermemory 抽取出的"fact"、OpenClaw 的 MEMORY.md/USER.md、Claude Code 的 CLAUDE.md、Letta 的 Memory Block、Zep/Graphiti 的知识图谱节点与边。
- **程序记忆**（如何做事的技能/流程）：Letta 的"agent-owned skills"（`/init` 时通过 subagent 回顾历史会话生成）、OpenClaw 的 skills 目录、MemOS 所称的"跨任务技能复用"（cross-task skill reuse）——这一层在多数记忆服务中仍不成熟，是可以差异化创新的空间。

**作用域轴**（用户/群/租户/agent/会话）与各产品对应关系：
| 作用域 | Mem0 | Zep/Honcho | Letta | OpenClaw | Claude Code 系 |
|---|---|---|---|---|---|
| 用户 | user_id | peer | human 变量/Memory Block | USER.md | 用户级 CLAUDE.md/GEMINI.md |
| 群/会话 | run_id | session | 对话线程（共享 agent 记忆） | memory/日期.md | 会话内 Auto Memory |
| 租户/组织 | 需自建于 user_id 命名空间之上 | 需自建 | 需自建 | 需自建 | Managed policy 层 CLAUDE.md |
| Agent 自身 | agent_id | peer（agent 也可作为 peer） | agent 绑定的 core memory | 全局 MEMORY.md（未做 agent 级细分） | 无原生 agent 级 |

**基准**：LoCoMo（50 对话、最长 35 session、约 300 turn/约 200 QA，覆盖 single/multi-hop、open-domain、temporal）、LongMemEval（500 题、6 大类、可扩展到百万 token 级对话）、MemBench（信息抽取/多跳推理/知识更新/偏好遵循/时间推理五维度）——三者组合可以作为我们评测"统一记忆层"效果的现成题库来源，但赛题本身的 Windows 办公任务评测未必需要长程记忆能力，记忆层更多是"锦上添花"的架构完整性加分项，不建议作为客观分主战场投入过多。

## 多 Agent 与协作

- Honcho 明确定位"打破 User/Assistant 二元范式，支持复杂多 agent 系统"，peer 概念天然支持"多个 agent 实例共享同一记忆后端但各自视角隔离"，是多 agent 记忆隔离的最佳参照。
- Letta 的 Memory Block 可在多个 agent 间共享（如团队共用一个"项目背景"Block），这是"团队/room 级共享记忆"的现成模式，可映射到我们赛题里"agent team"这一扩展能力的记忆维度。
- MemOS 提出的 MemCube 强调"跨任务技能复用"，理论上支持多 agent 协作时的技能/记忆迁移，但目前仍偏研究阶段（论文+预览仓库），生产成熟度有限。

## 可观测性

- Claude memory tool 的每次操作都是标准 tool_use/tool_result 消息对，天然可被现有的"消息级可观测"（我们赛题定义的 GET /session/{id}/message 轨迹）完整记录，无需额外埋点协议——这是它相较于"引擎内部黑盒读写 Markdown 文件"的显著优势。
- OpenClaw、Codex、Gemini CLI 的原生记忆写入大多发生在文件系统层面（write_file/replace 调用），如果这些调用本身作为 tool call 出现在轨迹里，也能被现有协议捕获；但"后台 Dreaming/sleep-time 巩固"这类异步进程的写入，通常发生在对话轮次之外，**不会自然出现在单轮的 message 轨迹里**，这是我们做统一可观测归一化时需要特别设计事件类型（如 `memory.consolidated`）来弥补的缺口。
- Letta 的 MemFS 用 git commit 记录每次记忆变更，天然自带"变更日志"，可以作为我们统一可观测协议里"记忆变更事件"的信息源直接消费（`git log` 结构化解析）。

## 对我们架构的启示

**公共能力 vs 扩展能力映射表**：

| 能力 | 是否可归一化为网关公共能力 | 归一化方式 | 引擎特有扩展点 |
|---|---|---|---|
| 会话级 Markdown 记忆文件（CLAUDE.md/AGENTS.md/GEMINI.md/MEMORY.md） | 是 | 网关维护统一的"记忆文件路径解析器"：按 用户/群/租户/agent 四层作用域生成对应的文件，在拉起引擎 session 前挂载到引擎期望的路径（如项目根 `AGENTS.md`、`~/.gemini/GEMINI.md`） | 各引擎的文件名、层级优先级规则不同，需要适配层做"归一化记忆内容 → 引擎特定文件名/位置"的物理映射 |
| 客户端记忆工具（Claude memory tool 模式：view/create/str_replace/insert/delete/rename） | 是（强烈推荐） | 网关直接实现一个通用 memory tool handler，对所有支持"client-side memory 工具"的引擎复用同一套存储后端（文件/DB） | 各引擎的 tool schema 细节不同，需要薄适配层做协议转换 |
| 动态检索注入（Mem0/Zep/Honcho 式：按需 search 后拼进 system prompt） | 是，作为网关级"记忆服务"能力，独立于引擎实现 | 网关在下发 `prompt_async` 前，先调用统一记忆服务做检索，把结果拼入 system prompt 或首条 user 消息注入 | 是否需要"实时检索"取决于引擎是否支持在 prompt 阶段接受额外上下文（几乎都支持，因为只是文本拼接） |
| 后台巩固/sleep-time/dreaming（异步从对话历史提炼长期记忆） | 部分可归一化 | 网关可以自己实现一个"引擎无关"的巩固任务（消费 message 轨迹，调用 LLM 做摘要写回记忆库），不依赖引擎原生的 sleep-time 机制 | 若引擎自带该机制（Letta sleep-time、OpenClaw Dreaming），可作为扩展能力开关，避免与网关侧巩固重复消耗 token |
| 知识图谱/时序记忆（Zep/Graphiti、Mem0 Graph、Cognee） | 可选，作为网关级"高级记忆插件" | 以独立微服务形式接入（Zep self-host 或 Cloud API），网关通过统一 memory 服务接口调用，不绑定具体引擎 | 图谱构建质量、时序推理能力因产品而异，属于"差异化创新"而非"必须归一化的公共能力" |
| Memory Block 式共享记忆（Letta） | 可选，映射为"group/room 级记忆" | 若网关支持 agent team/room 扩展能力，可用"共享记忆文件或共享 KV 空间"模拟 Memory Block 语义 | 依赖引擎是否原生支持多 agent 共享同一记忆对象；多数引擎（opencode/pi/dsh）目前无此原生机制 |

**群助手场景的群记忆隔离设计建议**：
1. 采用类似 Honcho 的 peer/session 双轴模型：**群（room）= peer 命名空间**，**具体一次对话 = session**，网关在创建引擎 session 时把 `room_id` 映射为记忆存储的顶层目录/命名空间前缀（如 `/memories/room_{room_id}/...` 或 Mem0 的 `user_id=room_{room_id}`）。
2. 记忆文件路径与引擎 session 目录一一对应，杜绝跨群读取：网关在启动引擎（`POST /session {directory}`）时，把 `directory` 指向该群专属的工作目录，工作目录下嵌入该群的 CLAUDE.md/AGENTS.md/MEMORY.md，从物理隔离上保证"群会话之间上下文隔离"。
3. 全局/租户级记忆（如企业知识库、群助手权限规则）作为只读上层目录挂载，符合 Claude Code 的 Managed policy > 用户 > 项目 优先级模型，可直接复用其"更具体覆盖更宽泛"的合并规则。
4. 采用 Claude memory tool 的路径穿越防护范式（规范化路径校验、拒绝 `../`）作为网关侧记忆 handler 的强制安全基线，无论对接哪个引擎。

**接口草案（网关级统一记忆服务，供各引擎适配层调用）**：
```
POST /memory/write   { scope: {user_id?, room_id?, tenant_id?, agent_id?, session_id?}, 
                        type: "episodic"|"semantic"|"working"|"procedural",
                        content: string, tags?: string[], ttl?: seconds }
GET  /memory/read    { scope: {...}, query?: string, top_k?: int, as_of?: timestamp }
                      -> [{ id, content, type, created_at, valid_until?, source_session_id }]
DELETE /memory/{id}  # 支持显式遗忘（对齐 Supermemory 的 action:forget）
POST /memory/consolidate  { scope: {...}, session_id }  # 触发一次巩固（对齐 sleep-time/Dreaming）
```
网关在 `prompt_async` 调用前，先 `GET /memory/read` 拿到相关记忆拼入 system prompt / 首条消息；引擎产生的 message 轨迹结束（`finish=stop`）后，网关异步调用 `POST /memory/consolidate` 或直接解析轨迹做增量 `POST /memory/write`。这样"读：注入到 prompt/system；写：从事件流抽取"的读写路径与具体引擎完全解耦，引擎只需要能够接受额外的 system 文本/文件挂载即可接入，不要求引擎原生支持任何记忆协议——即"记忆是网关能力，原生记忆机制是可选扩展/加速通道"。

**风险与坑**：
- 部分引擎的原生记忆写入（Auto Memory、Dreaming、Codex `~/.codex/memories/`）发生在网关不可见的引擎内部进程里，如果同时启用网关统一记忆服务，可能出现"同一份事实被两套机制重复抽取、重复写入、甚至相互覆盖"的问题；建议在赛题的"不要求热切换、按轮次分别启动引擎"约束下，明确每轮评测只启用一种记忆写入路径（要么网关统一记忆，要么引擎原生记忆），避免双写冲突。
- Windows 环境下 OpenClaw 式的 sqlite-vec 向量扩展、Letta MemFS 依赖的 git worktree 操作，都需要额外验证 Windows 原生兼容性（sqlite-vec 有预编译二进制、git 需要提前安装并配置好用户身份），属于部署侧的隐藏依赖，需要在自动化部署脚本里显式检查。
- Codex Memories 的地域屏蔽策略提示：若网关层要做"统一记忆服务"，也应该预留租户级"关闭记忆持久化"开关，以应对内部部署环境可能的合规要求（虽然赛题场景下模型是内部部署，无跨境问题，但架构设计应体现这种可配置性作为"架构合理性"加分点）。
- 记忆检索延迟：动态检索注入（Mem0/Zep 模式）会在每轮 `prompt_async` 前增加一次网络往返，赛题的 HTTP 阻塞语义（`prompt_async` 阻塞直到本轮结束）意味着这个延迟会直接计入任务耗时，需要控制检索延迟（如设置超时降级为"跳过记忆注入"）避免拖累鲁棒性评分。

## 未解决问题
1. opencode、pi、dsh 三个候选引擎各自的记忆机制细节（是否有原生 memory 工具、AGENTS.md 是否支持自动生成层、配置文件具体 schema）未能抓到官方一手文档，仅有二手技术博客/生态仓库描述，需要后续直接查阅这三个引擎的官方 GitHub 仓库源码/docs 目录做交叉确认。
2. A-Mem（Zettelkasten 式自组织记忆）本次未能获取一手资料，其数据模型与 API 形态待补充。
3. Claude Code 的 Auto Memory 与 Claude API 的 memory tool 是否共享同一份底层存储/协议、二者能否互操作，官方文档未明确说明，需要进一步查证。
4. Honcho 的 honcho_* 工具集的精确参数 schema（如 `honcho_search` 的 query 格式、`honcho_conclude` 的 conclusion 数据结构）未抓到 API Reference 原文，仅有功能性描述。
5. LoCoMo/LongMemEval/MemBench 的具体评测指标（如召回率、F1、pass@k 定义）与最新 SOTA 分数未直接核对原论文表格，仅采用二手摘要中的数据集规模描述。

## 来源列表
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool （一手，WebFetch 全文）
- https://docs.mem0.ai/platform/features/graph-memory （一手，WebFetch）
- https://docs.letta.com/letta-agent/memory （一手，WebFetch）
- https://docs.openclaw.ai/concepts/memory （一手，WebFetch）
- https://mem0.ai/blog/state-of-ai-agent-memory-2026
- https://mem0.ai/blog/graph-memory-solutions-ai-agents
- https://mem0.ai/research
- https://www.letta.com/blog/sleep-time-compute/
- https://www.letta.com/blog/memory-blocks/
- https://www.letta.com/blog/context-repositories/
- https://arxiv.org/abs/2501.13956 (Zep 论文)
- https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/
- https://www.getzep.com/ai-agents/temporal-knowledge-graph/
- https://mem0.ai/blog/how-memory-works-in-codex-cli
- https://docs.basicmemory.com/integrations/codex
- https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/memory.md
- https://geminicli.com/docs/tools/memory/
- https://geminicli.com/docs/cli/gemini-md/
- https://hermes-agent.nousresearch.com/docs/user-guide/features/honcho
- https://honcho.dev/docs/v3/guides/integrations/hermes
- https://docs.honcho.to/
- https://github.com/coolmanns/openclaw-memory-architecture
- https://lumadock.com/tutorials/openclaw-advanced-memory-management
- https://arxiv.org/abs/2507.03724 (MemOS 论文)
- https://arxiv.org/abs/2505.22101 (MemOS 短版论文)
- https://github.com/MemTensor/MemOS
- https://supermemory.ai/docs/concepts/how-it-works
- https://supermemory.ai/docs/search/overview
- https://supermemory.ai/docs/concepts/graph-memory
- https://code.claude.com/docs/en/memory
- https://github.com/zilliztech/memsearch
- https://github.com/fatwang2/pi-dsh
