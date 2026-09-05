# T30 会话记录格式与跨引擎上下文可移植性（中途切换引擎）

## 摘要
本专题调研了 Claude Code、Codex CLI、pi（pi-mono）、OpenCode、Gemini CLI 五个已核实引擎的会话/转录存储格式，以及 ACP、A2A、OpenAI Responses API、Vercel AI SDK UIMessage 四种消息 schema 的可移植性；Hermes、DeepSeek Harness (dsh)、OpenClaw、Goose 因搜索配额耗尽未能核实（见"未解决问题"）。核心发现：(1) 各引擎转录格式的物理形态可分为"单文件追加式 JSONL"（Claude Code/Codex/pi）与"规范化多文件存储"（OpenCode）两类，但官方普遍不承诺这些格式跨版本稳定（Claude Code 官方明文声明），应通过官方 API（`/export`、`-p --output-format json`、SDK、或赛题网关规范对应的 `/session/{id}/message`）而非直接 parse 私有文件来做跨引擎迁移；(2) 工具调用/结果配对（tool_use_id ↔ call_id）、thinking/reasoning 内容、prompt cache 标记这三类内容的可移植性依次递减，thinking 内容和 cache 标记本质上不可跨供应商复用；(3) Anthropic 官方 harness 文章证明"压缩不足以支撑超长任务"，真正有效的做法是把任务状态外部化为结构化 handoff 文件（JSON feature list + progress log + git commit），这正是我们应主推的"共享工作区+任务书"切换模式；(4) pi 的树状 id/parentId 会话结构 + 显式版本迁移机制，是四个已核实引擎中对"多分支、跨版本可移植性"设计最完整的范例，值得作为 Universal Session Record 的结构参考。


## 关键事实（表格）

| 事实 | 来源 | 置信度 | 是否交叉验证 |
|---|---|---|---|
| Claude Code 会话以 JSONL 存储于 `~/.claude/projects/<project>/<session-id>.jsonl`，`<project>` 由工作目录路径把非字母数字字符替换为 `-` 得到；每行是一个 JSON 对象（message/tool use/metadata） | code.claude.com/docs/en/sessions | 高（官方文档） | 是（与 Medium/GitHub 第三方逆向文章交叉验证字段结构一致） |
| Claude Code 官方明确声明："entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release"——即 JSONL 不是公开稳定 API，官方建议用 `/export`、`claude -p --output-format json`、hooks 的 `transcript_path`、或 Agent SDK 获取结构化数据 | code.claude.com/docs/en/sessions | 高（官方明示） | 否（唯一来源但是权威声明） |
| Codex CLI 会话以 rollout JSONL 存储于 `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`，每行是 `RolloutLine{ timestamp, type, payload }`，`type=="session_meta"` 记录会话元信息，其余为消息/工具调用/审批/token 用量事件；`codex resume`/`codex fork` 通过重放 transcript 重建上下文 | DeepWiki openai/codex 3.5.2; codex.danielvaughan.com session lifecycle | 中（社区/DeepWiki 解读，非官方文档原文） | 是（两个独立第三方来源描述一致） |
| OpenCode 会话数据存储为独立文件树：`session/`（元数据：title, directory, timestamps）、`message/<session_id>/`（消息元数据）、`part/<message_id>/`（内容：text/tool/token 计数），而非单一 JSONL；SDK 返回结构为 `{ info: Message, parts: Part[] }`，Part 类型包含 text/tool/step-start/step-finish | opencode.ai/docs/sdk/; PyPI opencode-session-extractor 项目描述 | 中 | 是（两来源一致描述 session/message/part 三层结构） |
| OpenCode 支持 `opencode run --format json` 输出 JSONL 事件流（每行含 `type` 字段），以及 `session.share()`/`session.summarize()` API；但存在已知 bug（issue #21941）：`opencode export` 写出的 session JSON 在 1.4.3 版本下 `opencode import` 无法读回，说明其导出/导入格式尚不稳定 | opencode.ai/docs/sdk/; GitHub anomalyco/opencode issue #21941 | 中 | 否 |
| pi (pi-mono / pi-coding-agent) 会话文件为 JSONL，存储于 `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`；条目通过 `id`/`parentId`（8 字符 hex）形成**树状结构**支持原地分支（非重新开文件），有 Version 1（线性，legacy）→ Version 2（树状 id/parentId）→ Version 3（`hookMessage` role 改名为 `custom`）的演进，旧会话加载时自动迁移 | github.com/badlogic/pi-mono session-format.md | 高（项目自带官方文档） | 是（与 DeepWiki badlogic/pi-mono 4.3 节描述一致） |
| pi 会话条目类型包括 `message`（role: user/assistant/toolResult/bashExecution/custom；content 可为 TextContent/ImageContent/ThinkingContent/ToolCall[]）、`compaction`（含 summary, tokensBefore, retainedTail, usage）、`branch_summary`（fromId, summary——切换分支 `/tree` 时对被放弃分支做 LLM 摘要）、`model_change`、`thinking_level_change`、`custom`/`custom_message`、`label`、`session_info` | github.com/badlogic/pi-mono session-format.md | 高 | 否（唯一来源，但为项目官方文档） |
| Anthropic 官方博客《Effective harnesses for long-running agents》指出：单纯 compaction 不足以支撑很长的任务，对超长任务需要做"完全上下文重置"（tear down 会话并从结构化 handoff 文件重建）；handoff 载体包括 JSON 格式的 feature list（category/description/steps/passes 字段，而非 Markdown，因为"model 更不容易误改 JSON 文件"）、`claude-progress.txt` 进度日志、以及 git commit 历史作为可回滚的状态锚点 | anthropic.com/engineering/effective-harnesses-for-long-running-agents | 高（官方一手来源） | 是（与 AddyOsmani 博客等第三方转述交叉验证核心结论一致） |
| Claude Code `/compact` 触发点为约 83.5%~95% 上下文占用（不同来源数字略有出入，83.5%≈167K/200K 与"~95%"并存，可能分别指自动触发早期预警与硬阈值）；`/compact [instructions]` 可带聚焦指令；`/rewind` 支持"Summarize from here / Summarize up to here" 做局部压缩；resume 超过 1 小时不活跃且 >100K tokens 时会弹出对话框提供"Resume from summary / Resume full session as-is / Don't ask again"三种选择 | code.claude.com/docs/en/sessions（resume from summary 段）；第三方博客（触发阈值） | 中（官方页确认三种 resume 选项，阈值数字来自第三方） | 是（多篇第三方文章数字一致收敛在 ~83.5%/95% 附近） |
| 跨引擎压缩策略对比（社区一手实测 gist，作者 badlogic 即 pi-mono 作者）：Claude Code 用百分比阈值(~95%)+手动 `/compact`；Codex CLI 用 token 阈值(180k-244k 视模型，95% 安全边际)，摘要+保留最近~20K tokens 用户消息；OpenCode 检测 `tokens > context_limit - output_limit`，并有独立的"保护最近 40K tokens 工具输出"剪枝机制，区分详细 compaction 摘要与 2 句话 UI 摘要；Amp 完全不自动压缩，要求手动触发"handoff"，用二级模型按需抽取相关信息而非整体摘要 | gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f | 中（社区实测/逆向分析，非各厂商官方文档） | 否（暂未找到官方文档逐一确认每家阈值数字） |
| Agent Client Protocol (ACP) 的 `session/update` 消息用 `SessionUpdate` 联合类型承载增量输出：`agent_thought_chunk`（推理/thinking）、`agent_message_chunk`、`user_message_chunk`、`tool_call`/`tool_call_update`、`plan`、`available_commands_update`、`current_mode_update`；`ContentBlock` 支持 text/image/audio/resource/resource_link，baseline 只强制要求 text 与 resource_link，其余需显式协商 opt-in | agentclientprotocol.com/protocol/schema | 高（协议官方 schema 页） | 否 |
| A2A (Agent2Agent) 协议的 `Part` 是 `TextPart \| FilePart \| DataPart` 的联合类型，各自可带 `metadata`；`FilePart` 可用 base64 内联字节或 URI 引用；`DataPart` 携带带 `mimeType` 的结构化 JSON；`Artifact` 是由多个 `Part` 组成的任务产出物 | a2a-protocol.org/v0.3.0/specification/; github.com/a2aproject/A2A | 高（协议官方规范） | 否 |
| OpenAI Responses API 用扁平化的 `items` 数组取代 Chat Completions 的单一 message 列表：`message`（文本/多模态内容）、`reasoning`（推理过程项，用于推理模型，多轮间可通过 `previous_response_id` 或显式回传 reasoning item 保留）、`function_call`（工具调用）、`function_call_output`（工具结果，必须通过 `call_id` 回指对应的 `function_call`） | platform.openai.com/docs/guides/migrate-to-responses; cookbook.openai.com/examples/responses_api/reasoning_items | 中（官方文档+官方 cookbook） | 是（迁移指南与 reasoning items cookbook 两个官方来源一致） |
| Vercel AI SDK v5 起 `UIMessage.parts` 使用**按工具名派生的类型化 part**（如 `tool-getWeather`），取代早期通用的单一 `tool-invocation` part 类型（issue #6342 反映了旧版"只保留最后一次调用"的丢失问题，新设计意在解决）；`UIMessage` 可通过泛型自定义 metadata/tools/data 形状 | ai-sdk.dev/docs/reference/ai-sdk-core/ui-message; github.com/vercel/ai issue #6342; vercel.com/blog/ai-sdk-5 | 中 | 是（官方 blog 与 issue 讨论互相印证设计动机） |
| Gemini CLI 的 checkpoint 机制（默认关闭，需 `settings.json` 开启）在每次批准会改动文件系统的工具（如 write_file/replace）前，同时保存：(1) 影子 git 仓库快照于 `~/.gemini/history/<project_hash>`；(2) 完整对话历史 + 即将执行的工具调用 的 JSON，存于 `~/.gemini/tmp/<project_hash>/checkpoints`；普通会话记录（非 checkpoint）存于 `~/.gemini/tmp/<project_hash>/chats/`，自动记录无需手动保存 | github.com/google-gemini/gemini-cli docs/checkpointing.md; geminicli.com/docs/cli/session-management | 中 | 是（GitHub 源文档与第三方镜像文档一致） |

## 架构与工作原理

**会话记录的两种物理形态**可归纳为两大类：

1. **单文件追加式 JSONL（append-only log）**：Claude Code、Codex CLI、pi、（推测）OpenClaw 均采用"一行一事件"的 JSONL，天然具备崩溃恢复、增量读取、易于 `tail -f`/流式解析的优点。区别在于：
   - Claude Code：扁平线性日志，条目通过 `parentUuid` 形成父子链（而非纯数组顺序），支持 `/rewind` 与 `/branch` 这类需要"定位到某历史点"的操作；官方**不承诺**该格式跨版本稳定。
   - Codex：`RolloutLine{ timestamp, type, payload }` 结构，日期分层目录（`YYYY/MM/DD`）便于归档/清理；`session_meta` 单独记录，其余为事件流。
   - pi：条目用 `id`/`parentId`（而非隐式顺序）显式建树，是三者中对"多分支会话"支持最完整的（`branch_summary` 类型专门记录分支切换时的摘要），并且**显式做了 3 次格式版本演进并提供自动迁移**，这是可移植性设计上的一个正面范例。

2. **规范化多文件/KV 存储式**：OpenCode 把 session 元数据、message 元数据、message 内容（part）拆成三层独立存储（`session/`、`message/<sid>/`、`part/<mid>/`），更接近"数据库表"思路而非日志思路，天然支持部分更新（如流式渲染时逐 part 更新）、session 分享（`session.share()`）、以及 `session.summarize()` 这类结构化操作，但导出/导入的稳定性目前有已知 bug（#21941），说明"结构化"不等于"可移植"。

**共同点**：几乎所有引擎的转录里都区分（a）用户消息、（b）assistant 文本/推理内容、（c）工具调用（tool_use/function_call）、（d）工具结果（tool_result/function_call_output），且工具调用与结果之间用某种 id（Claude 的 `tool_use_id`、OpenAI 的 `call_id`、pi 的 `ToolCall.id`）做配对，这是我们设计 Universal Session Record 时最重要的公共不变量。

## 可编程接入面

对"读取/迁移会话"这件事，各引擎提供的**官方编程接口**成熟度差异很大：

- **Claude Code**：官方明确不建议直接解析 JSONL，而是提供三条正式通道——`/export`（人类可读文本）、`claude -p --output-format json|stream-json`（结构化单次运行结果）、hooks 收到的 `transcript_path`（可在 `SessionEnd` hook 里归档/转换）、以及 Agent SDK（TypeScript/Python）逐消息回调。这意味着"跨引擎迁移 Claude Code 会话"在架构上应该走 Agent SDK 或 `-p --output-format json`，而不是逆向 JSONL 字段。
- **Codex CLI**：`codex resume`/`codex fork` 官方支持基于 rollout 重放；第三方已经在做 rollout 解析工具（如 codex-session-toolkit），说明官方虽未强调"格式稳定"，但生态已把它当作事实标准在用。
- **OpenCode**：提供 TS/JS SDK（`@opencode-ai/sdk` 一类），`session.summarize()`/`session.share()`/`session.unshare()` 是**服务端 API 层面**的一等操作，比"直接读文件"更适合作为网关侧的正式对接点——这与我们赛题里"网关通过 HTTP 端口对接引擎"的设计高度契合（也解释了为什么赛题把网关规范定成"opencode server API 形态"）。
- **pi**：官方文档就是"会话文件格式"本身（session-format.md），说明 pi 把 JSONL 树当作一等公民、鼓励外部工具直接解析，是四者中**对第三方解析最友好**的。
- **Gemini CLI**：checkpoint/session 的 JSON 格式没有官方 schema 文档，只有"存在这个功能"层面的文档，可编程接入面明显弱于前几者。

## 会话模型

对齐到我们赛题的"网关侧 session"概念（`POST /session {title, directory}`），可以看到几类引擎会话模型的共性与差异：

- 会话都以**工作目录（cwd/directory）**为强关联维度（Claude Code 用目录路径 slug 建子目录；Codex/pi/Gemini 均以 project path 的 hash 或 slug 建子目录）——这与网关规范里 `POST /session {title, directory}` 直接对应，是接入任意引擎时最稳的锚点。
- **分支（branch/fork）**是几乎所有引擎都支持的操作，但语义不完全一致：Claude Code 的 `/branch` 是"复制 transcript 并切换写入目标进程"（同进程内的权限授予会保留，但 `--fork-session` 到新进程则不保留）；Codex 的 `fork` 类似；pi 的树状结构支持"原地"生成新分支而不复制整个文件。这提示我们在 Universal Session Record 里，"分支"应建模为图/树上的新指针，而非简单的"复制整份记录"。
- **压缩后的会话在磁盘上是"重写历史"还是"追加一条 compaction 记录"**：pi 采用后者（`compaction` entry 类型，保留 `retainedTail` 而不删除原始行），Claude Code 的 `/compact` 语义上是替换历史（但落盘细节未公开）。追加式保留了更完整的审计轨迹，是我们做统一转录时应优先采用的策略（无损优先）。

## 权限与安全

- 会话恢复与权限模式（permission mode）强耦合：Claude Code 明确文档化了"resume 时权限模式是否恢复"取决于恢复路径（终端 `--resume` 恢复原模式；session picker/`/resume` 恢复到新会话默认模式；非交互 `-p --resume` 走新运行默认模式，除非满足 4 个条件保留 plan 模式）。这说明**权限状态不是会话记录的一部分而是运行时状态**，跨引擎迁移时必须由网关显式重新声明/协商权限，不能假设"转录里带着权限"。
- Claude Code 的"Allow for this session"授权在 `/branch`（同进程）下继承，但 `--fork-session`（新进程）下不继承，需重新审批——同理，跨引擎切换（相当于换了"进程"甚至换了"能力模型"）应该默认要求重新走一次权限确认，而不是信任旧转录里的授权记录。
- ACP 的 `tool_call`/`tool_call_update` 内建了权限相关的状态流转位（pending/in-progress/…），可作为我们网关统一权限事件模型的参考基线；A2A 的 Artifact/Part 模型本身不含权限语义，权限是 A2A 之外的传输层（如 mTLS/OAuth）的事。

## 扩展机制与资产
不适用直接展开（该子专题主要由 T-其他专题覆盖），仅记录与本专题相关的一点：pi 的 `custom`/`custom_message` entry 类型是官方预留的"扩展状态"通道（`custom` 不进 LLM 上下文，`custom_message` 进 LLM 上下文），这是一个值得借鉴的设计——Universal Session Record 也应该有"引擎私有/未识别字段"的透传通道，而不是强行归一化丢弃。

## 记忆
不适用直接展开（记忆专题见其他 T 编号），仅指出：Claude Code 的"auto memory"与 session 一样按 `CLAUDE_CODE_PROJECT_DIR_NAME` 目录隔离存放（`<project_dir>/memory/`），说明记忆和会话转录在物理存储上常常是同级目录关系，迁移会话时如果不带记忆目录，语境会不完整。

## 多 Agent 与协作
不适用直接展开（见其他 T 编号 room/agent team 专题）。仅记录：pi 的 `model_change`/`thinking_level_change` entry 类型说明单一会话内允许"运行时切换底层模型/推理强度"，这类"引擎内切换"和我们要设计的"引擎间切换"是两个层次的问题，但机制上都要求转录格式能标记"从此处起，执行环境变了"。

## 可观测性
不适用直接展开（见 T-可观测性专题）。仅指出：ACP 的 `session/update` 事件流（agent_thought_chunk/agent_message_chunk/tool_call…）与赛题网关规范里的 `GET /event` SSE（`message.part.updated`/`question.asked`/`permission.asked`）在语义上高度同构，说明"以 SSE/事件流承载会话内实时更新"已经是业界收敛的做法，我们做统一可观测协议时可以直接把 ACP 的 update 类型作为归一化事件枚举的参考起点。


## 对我们架构的启示

### 公共能力 vs 扩展能力映射表

| 能力 | 是否公共（可归一化） | 涉及引擎/协议 | 归一化到 Universal Session Record 的字段建议 | 接入参数/配置 |
|---|---|---|---|---|
| 用户/助手文本轮次 | 公共 | 所有引擎、Anthropic Messages、OpenAI Responses items、Vercel UIMessage | `turn{role, parts:[{type:"text", text}]}` | 无 |
| 工具调用+结果配对 | 公共（但 id 语义各异） | Claude tool_use/tool_result、OpenAI function_call/function_call_output(call_id)、pi ToolCall.id、A2A Part | `tool_call{id, name, args}` / `tool_result{tool_call_id, output}`；统一用 `(turn_id, tool_call_id)` 复合键做跨引擎重映射，因为原始 id 格式不兼容（如 Claude `toolu_xxx` vs OpenAI `call_xxx`） | 迁移时需要**重新生成** id 并建立映射表，不能假设原 id 在目标引擎可用 |
| 推理/思维链内容 | 半公共 | Claude thinking blocks（含 signature，需配对使用）、OpenAI reasoning items（可选通过 previous_response_id 保留）、pi ThinkingContent、ACP agent_thought_chunk | `turn.parts[{type:"thinking", text, opaque_signature?}]` | **有损**：thinking/reasoning 内容天然绑定发起模型的内部状态（如 Claude 的 signature 字段用于验证完整性），跨供应商/跨引擎迁移时**必须丢弃或仅作只读展示**，不能回填给新引擎的模型当作它自己的推理 |
| 压缩/摘要 | 公共（机制上） | Claude /compact、Codex compact、OpenCode summarize、pi compaction entry | `summary_node{covers:[turn_ids], text, tokens_before}` | 归一化为"图上的一个压缩节点"，替代/覆盖一段原始 turn 区间，但保留原始区间可回溯（追加式而非破坏式） |
| 分支/多路径会话 | 半公共 | Claude /branch、Codex fork、pi id/parentId 树 | `turn{id, parent_id}`（树结构） | OpenCode 目前是相对扁平的 message 列表，不是所有引擎都原生支持树；归一化层需要能把"树"降级为"线性主干+旁支摘要"以兼容不支持分支的引擎 |
| Prompt Cache / 缓存标记 | 引擎/供应商特有，不可移植 | Anthropic cache_control breakpoints、OpenAI 自动 prefix caching | 不放入 Universal Session Record 正文，只作为运行时优化提示，迁移引擎后必须重新计算 | 目标引擎的 cache 命中率会归零，需在成本估算里体现"切换引擎=预热成本" |
| Session 元信息(title/directory/cwd) | 公共 | 所有引擎 + 赛题网关 `POST /session{title,directory}` | `session{id, title, directory, created_at, engine, engine_session_id}` | 直接对应赛题网关规范，是最稳的锚点 |
| 权限模式/授权记录 | 不建议归一化进转录 | Claude permission mode、A2A/ACP 权限事件 | 单独存"权限决策日志"而非会话正文 | 切换引擎时**必须重新协商权限**，绝不能信任旧转录里的授权状态 |
| 工具集/MCP 挂载 | 引擎扩展能力 | 各引擎工具生态不同 | `session.capabilities_snapshot{tools:[...]}` 仅作记录，不做映射保证 | 切换引擎前需要做"工具能力差集"检查，提示用户/编排层哪些工具在新引擎不可用 |

### 三种"中途切换引擎"的实现模式（按信息保真度排序）

1. **共享工作区 + 任务书（最推荐，信息损失最小）**：不迁移对话历史本身，而是把"当前任务状态"外部化到文件系统（类似 Anthropic harness 文章里的 `claude-progress.txt` + JSON feature list + git commit）。新引擎的新 session 以"读取任务书 + git log + 工作区现状"作为唯一上下文来源冷启动。优点：不依赖任何引擎私有转录格式，天然可移植；代价：对话中的"言外之意"（未落盘的讨论）会丢失。**这是我们架构应作为默认策略主推的模式**，因为赛题的 Windows 办公任务本身就是"文件系统可观察"的任务类型（Word/Excel/PPT/文件删除），任务状态天然可外部化到磁盘产物。

2. **冷启动 + LLM 摘要（次推荐）**：网关在切换前，用当前引擎自身的 compact/summarize 能力（或调用一个独立的摘要模型）把历史转录压缩成一段结构化文本（对齐 Claude /compact 摘要要素：已完成事项、进行中工作、涉及文件、下一步、用户约束），作为新引擎 session 的初始 system/user 消息注入。优点：保留了"对话语境"；代价：摘要有损且"多次摘要质量会退化"（Claude Code 官方文档已警示这一点），且摘要提示词本身需要网关层维护、与目标引擎无关但仍是额外一层不确定性。

3. **转录重放（不推荐，仅工程可行性最高但语义最脆）**：把源引擎 JSONL/存储直接转换成目标引擎能接受的历史消息数组，逐条重放。问题：(a) 各引擎的 message/tool_use id 体系不兼容，必须重新生成并建立映射；(b) thinking/reasoning 内容不可跨供应商复用（真实性签名机制的存在恰恰说明厂商刻意让它不可移植）；(c) 目标引擎可能没有相应的工具（如迁移时源引擎调用过的 tool_name 在新引擎不存在），重放会产生"孤儿"工具调用记录；(d) 官方明确声明格式不保证跨版本稳定（Claude Code 文档原话），意味着重放适配器要跟随每个引擎版本持续维护，长期工程成本高。**建议仅在同引擎跨版本或者短期演示场景使用，不作为架构默认路径**。

### 丢失信息清单（跨引擎切换时必然或大概率丢失的内容）

- **推理/thinking 内容的可验证性**：即使原样搬运文本，脱离原厂商的 signature/内部状态校验，目标模型不会将其当作"自己刚才想的"，最多当只读参考。
- **Prompt cache 命中率**：切换引擎=切换供应商前缀树，缓存清零，首轮成本骤增。
- **工具调用的运行时语义（如 pending/approved 状态机、Diff/Patch 的具体格式）**：不同引擎的工具协议(bash/edit/patch) 参数形状不同，仅规范化"调用了什么工具、结果是什么"，具体的调用协议细节会丢失或需要昂贵的逐工具适配。
- **精确的 token 计数与用量统计**：不同厂商 tokenizer 不同，历史 usage 数字在新引擎下不再有意义，只能重新计量。
- **分支树的完整拓扑**：若目标引擎只支持线性会话（如多数 OpenCode 用法），源引擎（pi）里的多分支历史只能塌缩为主干+摘要，旁支细节丢失。
- **权限/审批的会话内状态**：如前所述，属于刻意不迁移的部分。

### 风险与坑

- **不要把"引擎私有 JSONL 格式"当作对外 API**：Claude Code 官方明确警告字段会随版本变化；即使 pi/OpenCode 文档相对稳定，也应通过其官方 SDK/HTTP API（而非直接 parse 文件）来读取，这也正是赛题网关规范"用 HTTP API 而不是文件格式做跨引擎接口"的合理性所在——我们应完全遵循这一原则，Universal Session Record 的"源"应该是**引擎的 `/session/{id}/message` API 返回值**（网关规范已定义），而不是磁盘上的私有文件。
- **compaction 多次叠加会退化**：若网关在多次引擎切换之间反复摘要，应避免"摘要的摘要的摘要"，最好每次切换都从"当前最新一次任务书/进度文件"重新起草，而不是链式压缩历史摘要。
- **id 空间冲突**：Universal Session Record 需要自己的全局 `turn_id`/`tool_call_id` 生成器，不能直接借用某个引擎的 id 格式作为通用主键。
- **OpenCode 自身的导入/导出都有已知 bug**（issue #21941），提醒我们：即使是"号称支持 session share/export"的引擎，其序列化互操作性也可能不成熟，任何跨引擎转换适配器都需要自己的回归测试集，不能假设引擎官方导出格式已经稳定可用。

## 未解决问题

1. Hermes、DeepSeek Harness (dsh)、OpenClaw、Goose 的会话/转录具体字段格式本次调研**未能核实**（受限于本次会话的 WebSearch 配额耗尽），需要后续专题或人工补充一手资料（尤其 Hermes 是否真的用 SQLite、dsh 的存储形态）——这是本报告最大的缺口，建议下一轮调研优先覆盖。
2. Codex Responses items 中 `reasoning` 项在会话恢复/`codex resume` 时是否原样回传给模型、还是仅本地展示，需要看 Codex 源码或官方文档确认（cookbook 只讲了 API 层面的 reasoning items 用法，未直接讲 codex CLI 的 resume 行为）。
3. OpenCode 的 session/message/part 具体 JSON Schema（字段级）未能拿到官方权威 schema 文件（只从 SDK 类型文件引用得知存在但未展开），需要直接读 `packages/sdk/js/src/gen/types.gen.ts` 源码。
4. Claude Code `/compact` 的自动触发阈值（83.5% vs 95%）在官方文档与第三方文章之间的确切关系尚未完全厘清，可能是两个不同版本/不同场景的数字，需要以最新官方 context-window 文档为准做一次专门核实。
5. ACP 与 A2A 在"会话持久化/转录"层面（而非"实时协议"层面）是否各自定义了标准存储格式，本次未深入（本专题聚焦引擎自身转录，两协议更偏"传输态"而非"存储态"），值得单独确认它们是否有官方的"会话导出" schema。

## 来源列表

- https://code.claude.com/docs/en/sessions （Claude Code 官方：会话存储、resume、branch、export，含"格式不稳定"官方声明）
- https://anthropic.com/engineering/effective-harnesses-for-long-running-agents （Anthropic 官方工程博客：compaction 不足论、结构化 handoff、initializer/coding agent 模式）
- https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f （社区一手实测：Claude Code/Codex CLI/OpenCode/Amp 压缩策略对比，作者为 pi-mono 项目作者）
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md （pi 官方会话文件格式文档：entry 类型、树状 id/parentId、compaction/branch_summary 结构、版本演进）
- https://deepwiki.com/badlogic/pi-mono/4.3-session-management-and-history-tree （DeepWiki 对 pi 会话管理/历史树的解读，交叉验证）
- https://opencode.ai/docs/sdk/ （OpenCode 官方 SDK 文档：session/message/part 结构、summarize/share API）
- https://github.com/anomalyco/opencode/issues/21941 （OpenCode export/import 不兼容的已知 issue）
- https://deepwiki.com/openai/codex/3.5.2-rollout-persistence-and-replay （Codex rollout 持久化与重放机制解读）
- https://codex.danielvaughan.com/2026/06/05/codex-cli-session-lifecycle-archive-resume-fork-compact-management/ （Codex CLI 会话生命周期第三方详解）
- https://github.com/google-gemini/gemini-cli/blob/main/docs/checkpointing.md （Gemini CLI 官方 checkpoint 文档）
- https://geminicli.com/docs/cli/session-management/ （Gemini CLI session 存储路径镜像文档）
- https://agentclientprotocol.com/protocol/schema （ACP 官方协议 schema：session/update, ContentBlock）
- https://a2a-protocol.org/v0.3.0/specification/ （A2A 官方协议规范：Part/TextPart/FilePart/DataPart/Artifact）
- https://github.com/a2aproject/A2A/blob/main/docs/specification.md （A2A GitHub 规范原文，交叉验证）
- https://platform.openai.com/docs/guides/migrate-to-responses （OpenAI 官方：Chat Completions → Responses API 迁移，items 结构）
- https://cookbook.openai.com/examples/responses_api/reasoning_items （OpenAI 官方 cookbook：reasoning items 用法）
- https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message （Vercel AI SDK 官方 UIMessage 参考）
- https://github.com/vercel/ai/issues/6342 （Vercel AI SDK tool-invocation part 类型演进讨论）
- https://vercel.com/blog/ai-sdk-5 （Vercel 官方 AI SDK 5 发布博客，UIMessage 泛型设计动机）
