# T19 Agent 自进化（skills/prompt/memory/workflow 的自动改进）与安全门禁

## 摘要
Agent 自进化研究经历三代演进：第一代（2023-2024）以 Voyager、ExpeL、AWM 为代表的"经验/技能库"，把执行经验固化为可复用的代码技能或自然语言 workflow；第二代（2025）以 ACE、GEPA、Dynamic Cheatsheet、SICA、Darwin Gödel Machine（DGM）为代表，用 Generator/Reflector/Curator 式的多角色循环或进化算法自动优化 prompt/上下文/agent 自身代码，其中 ACE（arXiv:2510.04618）和 GEPA（arXiv:2507.19457，ICLR 2026 Oral）已证明"上下文/文本级进化"可以不改模型权重就大幅提升效果且更省成本；第三代（2025-2026）是产品化落地，Hermes Agent（`skill_manage` 工具 + 可选人工审批暂存区）与 OpenClaw（`skill_workshop` 提案-审查-评估-应用四段治理流程）已经把"技能自创建"做成生产特性并配套门禁机制，Claude Code Auto Memory 与 Codex CLI Memories 则做了更轻量的"事实型记忆自动抽取"。Anthropic 于 2025-12-18 发布的 Agent Skills 开放规范（agentskills.io）提供了一个跨引擎的最小资产格式（SKILL.md，仅 name+description 必填），是我们网关层"进化资产模型"的最佳落地基础，但规范本身不含权限/签名/版本机制，安全门禁必须由网关层补齐——这一点由 Snyk ToxicSkills 研究（36.82% 技能存在安全缺陷）印证了紧迫性。核心设计启示：把"进化"拆成"资产层"（skills/prompts/memory/workflow 模板，用统一格式+版本+审批门禁管理，引擎无关）与"进化算法层"（Reflector/Curator 式在线优化可做成独立于引擎的公共服务，GEPA/MIPRO 式离线编译走 CI 流水线，DGM/SICA 式代码级自改进因安全风险不建议纳入本次赛题范围）。

## 关键事实

| 事实 | 来源 | 置信度 | 是否交叉验证 |
|---|---|---|---|
| ACE (Agentic Context Engineering) 论文 arXiv:2510.04618，2025年10月发布，分 Generator/Reflector/Curator 三角色，解决 "brevity bias" 和 "context collapse" 两个问题，在 agent 任务上 +10.6%，成本降低约 83.6% | arxiv.org/abs/2510.04618 | 高 | 是（alphaXiv + HuggingFace Papers 摘要一致） |
| GEPA (Genetic-Pareto) 是反思式 prompt 进化算法，arXiv:2507.19457，已被 ICLR 2026 接收为 Oral，通过自然语言反思+多目标进化搜索优化任意文本组件，已集成进 DSPy 的 `dspy.GEPA` API | arxiv.org/abs/2507.19457；dspy.ai/api/optimizers/GEPA/overview | 高 | 是（arXiv + dspy.ai 官方文档一致） |
| Darwin Gödel Machine (DGM) 论文 arXiv:2505.22954（2025-05-29 首发，v3 更新至 2026-03-12，ICLR 2026 论文），通过 agent archive + 经验证的自我代码修改实现开放式自我改进，用 SWE-bench 和 Polyglot benchmark 做经验验证，代码 Apache-2.0 开源于 github.com/jennyzzt/dgm，用 Docker 做隔离但README明确未提供 kill-switch/人工监督机制 | arxiv.org/abs/2505.22954；github.com/jennyzzt/dgm README | 高 | 是（论文摘要 + GitHub README 交叉确认 benchmark 与安全声明） |
| Anthropic 于 2025-12-18 将 Agent Skills 作为开放标准发布在 agentskills.io，规范极简：SKILL.md 仅要求 `name`(≤64字符,小写字母数字连字符) 和 `description`(≤1024字符) 两个必填字段，可选字段含 `license`/`compatibility`/`metadata`/`allowed-tools`（实验性），并采用"渐进式披露"三层加载（元数据~100 tokens常驻→SKILL.md正文<5000 tokens按需激活→scripts/references/assets按需读取） | agentskills.io/specification | 高 | 是（simonwillison.net 博客 2025-12-19 独立报道日期与内容一致） |
| Hermes Agent（Nous Research）用 `skill_manage` 工具（create/patch/edit/delete/write_file/remove_file）让 agent 自主创建、修改、删除技能，技能存于 `~/.hermes/skills/`；当配置 `skills.write_approval: true` 时所有写入先暂存到 `~/.hermes/pending/skills/`，需人工用 `/skills pending`、`/skills diff <id>`、`/skills approve <id>` 审核后才生效，且该门禁对"前台直接调用"和"后台自我改进复盘"写入均生效 | hermes-agent.nousresearch.com/docs/user-guide/features/skills | 高 | 否（仅单一来源，但内容具体、字段名明确，可信度高） |
| OpenClaw 的 `skill_workshop` 工具走"提案(propose-create/propose-update)→inspect→evaluate→apply"四阶段流程，区分"个人技能"（跟随登录身份）、"workspace 技能"（`~/.openclaw/workspace/skills/`，本地自动监听）与"已发布技能"（ClawHub 注册表，`@owner` 命名空间+基于角色的访问控制），未见明确的单键回滚，但支持修订版本共享给团队 | docs.openclaw.ai/tools/creating-skills | 中 | 否 |
| OpenAI Codex CLI 记忆架构分两层：静态的 AGENTS.md（团队规则）+ 生成层 Memories；Memories 生成分两阶段——Phase 1（会话结束时抽取候选记忆并做敏感信息脱敏）、Phase 2（获取全局锁、启动整合子代理、合并写入 diff），OpenAI 官方建议仅把 Memories 当作"有帮助的本地回忆层"而非规则的唯一来源 | mem0.ai/blog/how-memory-works-in-codex-cli | 中 | 否 |
| Claude Code 自 2.1.59（2026年2月）起默认开启 Auto Memory，agent 在工作中自动写 MEMORY.md，限定单项目、上限 200 行/25KB，不跨工具/跨机器同步 | blog.memoryplugin.com/claude-code-memory | 中 | 否（第三方博客，非 Anthropic 官方一手，需谨慎） |
| Snyk 的 "ToxicSkills" 研究扫描 ClawHub 上的 agent skills 供应链，发现 36.82% 的技能至少存在一项安全缺陷，13.4% 含关键级问题（恶意代码/prompt injection/密钥泄露），已确认的恶意技能中 100% 含恶意代码模式、91% 同时使用 prompt injection 手法 | snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub | 中 | 否（单一安全厂商研究，具体数字未经第二来源复核，需标注为该机构自报数据） |
| Agent Workflow Memory (AWM, CMU/MIT, arXiv:2409.07429, ICML 2025 Poster) 从任务轨迹中归纳可复用 workflow（而非单条经验/技能），支持离线（训练集预归纳）和在线（测试时即时归纳）两种模式，在 Mind2Web/WebArena 上相对成功率提升 24.6%/51.1% | arxiv.org/abs/2409.07429；icml.cc/virtual/2025/poster/45496 | 高 | 是（arXiv 摘要 + ICML 官方 poster 页交叉确认） |
| Alita（arXiv:2505.20286）走相反路线——"最小预定义、最大自我进化"，agent 本身只有一个核心问题求解组件，自主生成/精炼/复用 MCP（Model Context Protocol）作为"进化产物"而不是技能文本，其后继 Alita-G（arXiv:2510.23601）把通用 agent 端到端转化为领域专家 | arxiv.org/abs/2505.20286；arxiv.org/html/2510.23601 | 高 | 否 |

## 架构与工作原理

Agent 自进化的研究脉络大致可分三代：

**第一代：技能库/经验库（2023-2024）**
- **Voyager**（arXiv:2305.16291，NVIDIA/Caltech，Minecraft）：三部件架构——自动课程（curriculum，决定探索什么）+ 不断增长的**代码技能库**（skill library，可执行代码，按 embedding 检索复用）+ 迭代 prompting（结合环境反馈/执行报错/自我验证来改进程序）。技能是"时序延展、可解释、可组合"的代码单元，核心贡献是证明**持久化代码技能库无需微调即可实现终身学习**，避免灾难性遗忘。
- **ExpeL**：非参数学习框架，让 agent 通过收集经验自主提升——把跨任务知识抽象为自然语言"insight"，成功轨迹存入向量数据库，属于"经验→自然语言规则"路线，不生成可执行代码。
- **Agent Workflow Memory (AWM)**（arXiv:2409.07429，CMU/MIT，ICML 2025）：与 Voyager/ExpeL 的差异在于归纳的单元是**workflow**（任务子程序的复用模式），既可离线从训练样本预归纳，也可在线从测试查询即时归纳，然后按需注入 prompt。

**第二代：基于反思/进化算法的上下文与代码自我修改（2025）**
- **Reflexion**（未被本次一手抓取但为经典基线）：agent 失败后生成自我反思文本存入短期记忆，下一轮重试时注入。ACE、Dynamic Cheatsheet 等后续工作都可以看作 Reflexion 思路的结构化/规模化延伸。
- **Dynamic Cheatsheet (DC)**（arXiv:2504.07952，EACL 2026）：给黑盒 LM 加一个持久化演化记忆，Generator+Curator 双模块在推理时动态更新一份"cheatsheet"（策略、代码片段、通用解题经验），不需要真值标签或人工反馈；Claude 3.5 Sonnet 在 AIME 上准确率翻倍、GPT-4o 在 Game of 24 成功率从 10%→99% 均来自跨题目复用同一份 cheatsheet 中的策略。
- **ACE (Agentic Context Engineering)**（arXiv:2510.04618，2025-10）：**三角色分工**——Generator 产出推理轨迹；Reflector 从成功/失败中提炼具体 insight；Curator 把 insight 整合进结构化的上下文更新（论文称为增量式"delta"更新而非整体重写，以规避 context collapse）。可分别用于**离线优化**（如固化 system prompt）和**在线适配**（如动态更新 agent memory/playbook）。在 AppWorld 榜单上 ReAct+ACE 用更小的开源模型 DeepSeek-V3.1 追平/超过生产级 IBM CUGA（GPT-4.1）。ACE 本质上是"引擎无关"的**上下文进化中间层**——不改模型权重，只改注入给下一次推理的文本资产，天然适合作为网关层的能力，而非某个具体 harness 独有能力。
- **GEPA**（arXiv:2507.19457，ICLR 2026 Oral）：把"反思式文本进化"与"多目标遗传算法（Pareto 前沿）"结合，用自然语言反馈迭代变异 prompt/程序文本组件，声称样本效率远高于 RL（GRPO 等只需几十次 rollout 对比 RL 的数千次）。已作为 `dspy.GEPA` 集成进 DSPy 框架，可用于优化任意 DSPy Module 的 prompt/demo。DSPy 生态中还有 **MIPRO**（另一个 instruction+few-shot 联合优化器，贝叶斯优化路线）——二者都是"提示词自动编译"范式，属于**训练/部署前**的离线优化，与 ACE/AWM 这种**运行时在线**进化形成互补。
- **SICA (Self-Improving Coding Agent)**（arXiv:2504.15228，Bristol）：agent 直接编辑**自己的代码库**（而非仅仅是 prompt/memory），用 meta-agent 从"表现最好的历史版本存档（archive）"中挑选并实施改进，在 SWE-bench Verified 子集上从 17%→53%。是"代码级自进化"的代表，比 DGM 更早但思路相近（archive + 经验验证）。
- **Darwin Gödel Machine (DGM)**（arXiv:2505.22954，UBC/Vector/Sakana AI）：不要求形式化证明正确性（区别于经典 Gödel Machine），而是**经验主义地**在 SWE-bench/Polyglot 基准上验证每次自我代码修改是否真的提升表现，类比生物演化的"变异-试验-选择"，维护一个开放式演化的 agent 群体档案（archive），支持"父代 agent 派生多个子代"的树状探索。安全性上依赖 Docker 沙箱隔离执行，官方 README 明确警告代码可能因模型能力/对齐不足产生破坏性行为，**未提供内建的人工审批/kill-switch**，需要使用者自行加约束。
- **EvoAgent**（arXiv:2406.14228，ACL NAACL 2025）：不进化 skill/prompt，而是进化"**agent 群体结构**"——把已有单 agent 框架当作"初始个体"，用变异/交叉/选择等遗传算子生成多样化设定的 agent 群体，自动把单 agent 扩展为 multi-agent 系统。
- **Alita**（arXiv:2505.20286）：反其道而行——"最小预定义 + 最大自我进化"，agent 本体极简（一个核心求解组件），进化对象是**动态生成的 MCP（Model Context Protocol）server/工具**而非文本技能，通过开源代码自动构造任务相关 MCP 并复用；后继 Alita-G（arXiv:2510.23601）能把通用 agent 端到端"生成"为领域专家 agent。

**第三代：产品化落地（2025-2026）**
- **Hermes Agent**（Nous Research）把"技能自创建/自改进"做成生产特性：`skill_manage` 工具 + 前台直接写 / 后台复盘写两条路径 + 可选的人工审批暂存区（见关键事实表）；明确把"memory"（常驻小事实）和"skill"（按需加载的长程序）分层，呼应 Anthropic Agent Skills 规范的"渐进式披露"思想。
- **OpenClaw**：`skill_workshop` 走"提案→审查→评估→应用"四段式治理流程，个人/workspace/已发布三种作用域分权，是目前调研到的**治理流程最完整**的开源实现之一。
- **Claude Code Auto Memory / Codex Memories**：两家都采用"单项目/单会话作用域 + 自动抽取生成 + 有限容量"的轻量记忆层，属于"隐式进化"（不需要用户显式审批具体改动，但作用域和容量都做了硬限制以控制风险）。

## 可编程接入面

自进化能力目前**没有统一协议**，各实现的可编程面差异很大，可归纳为三类接口形态：

1. **工具调用型（tool-call as mutation API）**：Hermes 的 `skill_manage`（action=create/patch/edit/delete/write_file/remove_file，参数 name/content/old_string/new_string/file_path）、OpenClaw 的 `skill_workshop`（CLI 子命令 `propose-create`/`propose-update`/`inspect`/`evaluate`/`apply`）。这类接口本质上是"资产 CRUD + 审核状态机"，**可以被网关层直接代理/审计**，是我们架构最容易归一化的一类。
2. **算法库/优化器型（offline compiler API）**：DSPy 的 `dspy.GEPA(metric=..., auto="light|medium|heavy")`，输入是 program + 训练集 + reward/feedback 函数，输出是优化后的 prompt/demo，属于**部署前**批处理，不在 agent 运行时协议内，网关层可以把它当作"资产生产流水线"的一个 CI 步骤对接，而不必进网关的 session 协议。
3. **隐式后台进程型**：Claude Code Auto Memory、Codex Memories 的两阶段抽取-合并、DGM/SICA 的 archive 演化循环——这些是引擎内部自驱动的循环，**没有暴露标准 API**，网关只能通过读取产物文件（MEMORY.md、AGENTS.md、skills 目录）或监听文件系统变化来间接感知，无法直接控制其触发时机。

## 会话模型

自进化产物（skill/memory/workflow 模板）与会话生命周期的关系因引擎而异：
- Hermes/OpenClaw：技能/记忆是**跨会话持久化资产**，存在文件系统（`~/.hermes/skills/`、`~/.openclaw/workspace/skills/`），会话只是资产的读写者，不是资产的容器。
- Claude Code Auto Memory / Codex Memories：作用域**绑定到项目目录**而非单次会话，同项目的新会话能读到旧会话写的记忆，跨项目/跨机器不同步。
- DGM/SICA：进化对象是"agent 自身代码"，其"会话"概念是"一次 benchmark 评测 rollout"，与我们赛题定义的用户会话完全不是一回事——**这类学术自进化系统的"会话"粒度是训练/评测循环，不能直接套进业务 session 模型**，需要架构上区分"用户对话 session"与"进化训练 episode"。

## 权限与安全

见"评估与门禁"一节整合展开，此处摘要引擎侧机制：
- Hermes：`skills.write_approval: true` 配置项 → 写入暂存 → `/skills approve` 人工放行，覆盖前台/后台两种写入路径。
- OpenClaw：`propose-*` → `inspect` → `evaluate` → `apply` 四段式，`evaluate` 阶段隐含安全/依赖检查。
- DGM/SICA：**无内建权限门禁**，仅靠 Docker 隔离执行环境；一切好坏由"下一轮 benchmark 分数是否提升"决定是否保留该次代码修改（即用**客观指标做自动门禁**，没有人工环节）。
- Anthropic Agent Skills 规范本身**不定义权限模型**，只有实验性字段 `allowed-tools`（空格分隔的预授权工具列表），实际的权限/审批策略完全下放给各"agent 实现"（宿主应用），这正符合我们网关层应统一收口权限的设计诉求。

## 扩展机制与资产

Agent Skills 规范（agentskills.io，Anthropic 主导，2025-12-18 开放）是目前**唯一具备跨厂商共识**的"进化资产格式"：
- 资产 = 目录，必含 `SKILL.md`（YAML frontmatter + Markdown 正文），可选 `scripts/`、`references/`、`assets/`。
- 必填字段仅 `name`（≤64字符，`[a-z0-9-]`，不能连字符开头/结尾/连续，且**必须等于父目录名**）与 `description`（≤1024字符）。
- 可选字段：`license`、`compatibility`（环境要求，如"需要 git/docker/jq 和网络访问"）、`metadata`（任意 string-string 映射，供各实现自定义扩展）、`allowed-tools`（实验性，预授权工具列表）。
- 采用"渐进式披露"三层加载：元数据~100 tokens 常驻 → SKILL.md 正文（建议<5000 tokens，<500行）激活时加载 → scripts/references/assets 按需读取，这个分层直接对应了 Hermes 讲的"memory（常驻）vs skill（按需）"区分。
- 提供官方校验工具 `skills-ref validate ./my-skill`（github.com/agentskills/agentskills）。
- 规范未定义版本号强制字段（仅可放进 `metadata.version` 这种自定义键），也未定义签名/来源认证机制——**这是安全门禁必须在网关层补上的缺口**。

各引擎在此规范基础上叠加了自己的扩展字段（如 Hermes 的 `metadata.hermes.tags/category`、`platforms` OS 限制），这正符合规范"未识别的 frontmatter 键应被忽略"的设计初衷，也印证了"公共格式 + 引擎私有扩展字段"是可行的分层方式。

## 记忆

三种记忆颗粒度共存，需要在架构上分层管理，不能混为一谈：
1. **事实型记忆**（小、常驻、结构化差）：Claude Code MEMORY.md（≤200行/25KB，单项目）、Codex AGENTS.md（静态团队规则，人工维护）+ Memories（生成层，自动抽取+两阶段合并）。
2. **策略/经验型记忆**（中等规模、演化式更新）：Dynamic Cheatsheet 的 cheatsheet、ACE 的 playbook（Generator/Reflector/Curator 循环维护，防 context collapse 的"增量式"更新而非整篇重写）。
3. **程序/工作流型记忆**（大、结构化、可执行）：Voyager 的代码技能库、AWM 的 workflow、Hermes/OpenClaw 的 SKILL.md 目录——本质上与"扩展机制"一节的资产格式重合，说明**"记忆"和"技能"在工程实现上经常是同一套存储/加载机制，只是内容颗粒度和触发方式不同**。

## 多 Agent 与协作

- EvoAgent：用进化算子把单 agent 扩展为 multi-agent 群体，属于"结构进化"而非"资产进化"，与本专题的"技能/prompt/memory"进化不完全同一范畴，但同属"自进化"大类，且其进化产物（agent 角色配置）同样可以用"资产 + 版本 + 门禁"的模式管理。
- ACE/GEPA 的 Generator/Reflector/Curator，Dynamic Cheatsheet 的 Generator/Curator，本质上是**用多角色分工来做"自我进化流水线"**——这提示我们在网关层设计"进化服务"时，可以把 Reflector/Curator 实现为与具体引擎解耦的公共服务（比如接一个独立的"进化 agent"，读取任意引擎产生的轨迹，输出资产更新提案），而不必要求每个引擎都自带这套角色分工。

## 可观测性

调研中未发现任何引擎为"自进化事件"定义标准化的可观测协议（如 OTel span、结构化事件类型）。Hermes/OpenClaw 的审批流程（pending/diff/approve）客观上提供了**可追溯的变更记录**，但格式是各自私有的（CLI 输出/文件 diff），不是标准化事件流。这是网关层需要**自行定义**的部分：建议将"技能/记忆变更"作为网关统一可观测协议中的一等事件类型（如 `asset.proposed` / `asset.approved` / `asset.rejected` / `asset.rolledback`），无论底层引擎原生是否支持审批门禁，都由网关层拦截、记录、必要时二次审批。

## 对我们架构的启示

### 公共能力 vs 扩展能力映射表

| 能力 | 归类 | 说明 | 接入参数示例 |
|---|---|---|---|
| 静态资产格式（SKILL.md，agentskills.io 规范） | **公共能力**，应作为网关"资产模型"的基础格式 | 只要求 name+description，几乎所有引擎都能兼容或简单适配 | 无需引擎特定参数，网关统一存取；引擎侧只需能"发现并加载"某目录下的 SKILL.md |
| 资产的"渐进式披露"三层加载 | **公共能力** | 元数据常驻、正文按需、子文件懒加载，是通用的 token 效率设计 | — |
| 事实型记忆（AGENTS.md / MEMORY.md 类） | **公共能力**（接口层面），**实现是引擎扩展** | 网关应统一暴露"读/写项目级记忆文件"接口，但生成算法（何时抽取、如何合并）由各引擎自己实现 | 引擎需声明记忆文件路径约定和容量上限 |
| 技能自创建/自改进的 CRUD 工具（`skill_manage`/`skill_workshop`） | **引擎扩展能力**（接口形态不统一） | 需要网关做适配层，把不同引擎的技能变更工具调用统一映射成网关的 `asset.*` 事件 | 需引擎暴露：create/update/delete 操作名、审批状态查询接口 |
| 审批门禁（pending→diff→approve） | **应上收为网关公共能力**，即使引擎原生支持也应由网关兜底 | Hermes/OpenClaw 已有类似设计但各自私有，网关层应做统一封装，不完全信任引擎自带审批（防止被绕过） | 网关配置 `evolution.approval_mode: auto\|staged\|manual` |
| 上下文/Prompt 的在线进化（ACE playbook、Dynamic Cheatsheet） | **可做成引擎无关的独立服务**，挂在网关侧 | 因为其输入输出都是文本（轨迹→insight→context delta），不依赖具体引擎内部实现，理论上可以对任意引擎的执行轨迹做后处理 | 网关侧配置：轨迹来源（`GET /session/{id}/message`）、Reflector/Curator 模型、目标注入点（system prompt / memory 文件） |
| 离线 prompt 编译（GEPA/MIPRO/DSPy） | **训练前流水线，非运行时能力**，不进入网关运行时协议 | 属于 CI/CD 范畴：定期用历史 rollout 数据跑一次优化，产出新版本 prompt/skill，再走资产发布流程 | — |
| 代码级自我修改（DGM/SICA 修改自身代码库） | **纯引擎扩展能力，风险极高，不建议作为赛题目标** | 赛题的 Windows 办公任务评测环境对"引擎自己改自己代码"没有直接需求，且缺乏门禁的代码自改在生产环境是重大安全隐患 | 若引擎具备此能力，网关应默认禁用，仅在隔离评测环境下按需开启 |
| Multi-agent 结构进化（EvoAgent） | **引擎扩展能力** | 与 T? "agent team/room"专题重叠，进化对象是"团队配置资产"而非单一 skill，可复用同一套资产治理框架 | — |

### 接入参数与协商流程建议

新引擎接入"自进化"能力时，建议标准化以下"能力识别→适配→认证"清单（呼应目标里的通用流程）：
1. **能力探测**：引擎是否暴露技能/记忆的读写接口？格式是否兼容/可映射到 SKILL.md？（若引擎原生技能格式不是 agentskills.io 规范，网关适配层需要写一个双向转换器）
2. **写入路径识别**：区分"前台交互式写入"（用户/agent 在对话中直接改）与"后台批处理写入"（复盘/训练流水线），两者都要能被网关拦截审批。
3. **门禁模式协商**：网关向引擎（或本地适配层）声明 `approval_mode`；若引擎原生不支持暂存审批（如很多轻量引擎技能写入即生效），适配层需要在文件系统层面模拟"影子目录 + 网关审批后才 mv 到生效目录"。
4. **回滚能力**：要求适配层至少实现"资产版本快照 + 一键回滚"，即使引擎本身没有版本控制（用网关自己的 db_op / git 记录来兜底，而不依赖引擎）。
5. **认证/来源标记**：由于 agentskills.io 规范未定义签名机制，网关层应在资产落盘前打上来源标签（`created_by: agent|human`，`origin_session_id`），便于审计和"技能投毒"溯源。

### 风险与坑

- **prompt/skill 投毒是真实且规模化的供应链风险**（Snyk ToxicSkills 报告 36.82% skills 存在安全缺陷，91% 恶意 skill 同时使用 prompt injection），若我们的网关允许"引擎自动生成的 skill 直接进入下一次任务的可用工具集"，必须在门禁中做静态扫描（检测隐藏指令/敏感命令模式）+ 人工抽检，而不能只做格式校验。
- **"记忆"和"技能"两套系统容易被不同引擎用不同的边界定义**（Hermes 明确区分、Claude Code/Codex 只有"记忆"没有独立"技能自创建"），网关做归一化时不能假设二者是同一种资产，需要保留"颗粒度/触发方式"这一维度的元数据。
- **DGM/SICA 类"代码级自改进"在 Windows 沙箱评测场景下几乎不适用**：赛题环境要求 Windows 原生运行 + 受控 Rollout 记录轨迹，代码级自我修改会引入不可控的执行面（相当于引擎在评测过程中重写自己），与"客观评分需要跨引擎可比"的评分设计冲突，建议在方案里明确排除或强隔离此类能力。
- **离线 prompt 编译（GEPA 等）需要训练集/reward 函数**，赛题给定的评测用例数量有限，若要复用 GEPA/MIPRO，需要先用历史 Rollout 轨迹构造离线数据集，短期内 ROI 有限，更适合作为"未来演进方向"而非本次参赛的必答项。
- **进化产物的回归测试**：目前没有一个引擎给出了标准化的"技能变更 A/B 测试"机制，都是定性人工审核（diff review）。若要做严谨的门禁，网关应该自建"影子评测"流程——新技能先在一个隔离 session 里跑一遍既有回归用例，通过后才允许合入公共技能库，这一层完全可以做成引擎无关的网关能力。

## 未解决问题

1. Anthropic Agent Skills 规范是否已有官方的技能签名/来源认证扩展提案？调研到规范本身未定义，但生态（agentskills/agentskills 仓库）可能在快速迭代，需要持续跟踪。
2. Hermes/OpenClaw 的审批门禁在"多用户/多群会话"场景下是否有基于 session/tenant 的隔离（即 A 群 agent 自创建的技能会不会被 B 群误用）？两个官方文档都未提及跨会话资产隔离策略，这对我们"群助手多租户隔离"的硬需求是关键缺口，需要网关层自行设计（如资产 namespace 与 session/directory 绑定）。
3. Darwin Gödel Machine 一类学术系统是否有工业化的"安全沙箱+人工卡点"参考实现可直接复用？目前看到的只是研究代码，缺少生产级门禁范例。
4. ACE 论文中的 Generator/Reflector/Curator 三角色循环是否有开源参考实现（而不仅是论文描述）？本次调研受限于 WebFetch 只取到 arXiv 摘要页，未能拿到 pdf/html 全文中的算法伪代码细节，需要后续对 arxiv.org/pdf/2510.04618 或 alphaxiv 详细页做二次抓取确认字段级细节（如"delta"更新的具体数据结构）。

## 来源列表
- https://arxiv.org/abs/2510.04618 （ACE: Agentic Context Engineering）
- https://arxiv.org/abs/2505.22954 （Darwin Gödel Machine）
- https://github.com/jennyzzt/dgm （DGM README，Apache-2.0，safety 声明）
- https://arxiv.org/abs/2507.19457 （GEPA）
- https://dspy.ai/api/optimizers/GEPA/overview/ （DSPy GEPA 集成）
- https://arxiv.org/abs/2507.21046 （A Survey of Self-Evolving Agents）
- https://arxiv.org/abs/2508.07407 （A Comprehensive Survey of Self-Evolving AI Agents）
- https://agentskills.io/specification （Anthropic Agent Skills 规范原文）
- https://simonwillison.net/2025/Dec/19/agent-skills/ （Agent Skills 开放标准发布报道，2025-12-19）
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills （Hermes skill_manage 工具与审批门禁）
- https://docs.openclaw.ai/tools/creating-skills （OpenClaw skill_workshop 提案审查流程）
- https://arxiv.org/abs/2305.16291 （Voyager）
- https://arxiv.org/abs/2409.07429 （Agent Workflow Memory，ICML 2025）
- https://icml.cc/virtual/2025/poster/45496 （AWM ICML poster 页）
- https://arxiv.org/abs/2504.07952 （Dynamic Cheatsheet，EACL 2026）
- https://arxiv.org/abs/2504.15228 （SICA: A Self-Improving Coding Agent）
- https://arxiv.org/abs/2406.14228 （EvoAgent）
- https://arxiv.org/abs/2505.20286 （Alita）
- https://arxiv.org/html/2510.23601 （Alita-G）
- https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub （ToxicSkills 供应链安全研究）
- https://mem0.ai/blog/how-memory-works-in-codex-cli （Codex CLI Memories 两阶段架构）
- https://blog.memoryplugin.com/claude-code-memory/ （Claude Code Auto Memory，第三方来源，需谨慎）
