# T28 中国 Agent 生态与"Agent 网关+引擎"相关实践

## 摘要
中国 Agent 生态里，"Agent 网关 + 多引擎"的架构范式已在头部大厂内部落地：腾讯云 ADP 用 Adapter 模式（`CODETOOL_ADAPTER` 环境变量）在 OpenCode / Claude Code 两个 harness 间切换，并配套 Part/Message/Session 三层会话结构、企业级/空间级/应用级三层权限、多层 Transcript 可观测方案，是与本赛题描述最贴近的国内一手案例（厂商博客，细节未开源，需谨慎复用）。阿里 AgentScope Runtime 用"Engine（FastAPI 服务+A2A协议）+ Sandbox（session_id/user_id 双键隔离执行环境）"双核心架构，CLI (`agentscope chat/web/run/deploy`) 与多种部署后端（ModelStudio/AgentRun/K8s/Knative）打通，是开源可验证程度最高的参考项目。字节 Coze Studio/Coze Loop/Eino 三件套展示了"开发平台+AgentOps+图编排引擎"的分层。腾讯 CodeBuddy CLI 的命令行参数体系几乎是 Claude Code 的镜像（`-p/--print`、`--resume`、`--agents` JSON、`--permission-mode`、`--sandbox`），是我们设计引擎适配器字段映射的极佳参照。DeepSeek Harness (`dsh`) 采用 Cordis 插件框架 + seam（Service/Provider/Consumer）能力抽象 + turn/step 事件溯源模型，比 opencode 的 message/part 模型更严格，接入时需要专门做事件语义映射。国内 IM 生态方面，OpenClaw 已有多个中国区 fork（openclaw-china、MaxClaw，社区昵称"小龙虾"）实现飞书/钉钉/企业微信/QQ 渠道适配，用 `dmPolicy`/`groupPolicy`/`allowFrom` 做轻量权限控制；企业微信官方 Webhook 只能发不能收、双向交互需走自建应用回调，是群助手网关设计必须考虑的现实约束。综合来看，国内生态尚无公开的、与赛题完全同构的"通用 Agent 网关规范"实现，但 ADP、AgentScope Runtime、CodeBuddy 三者的会话/权限/可观测设计可分别为我们的 session 映射、权限分层、事件归一化提供直接可借鉴的字段与模式；iFlow CLI 存在停止维护的二手报道，建议接入前核实。

## 关键事实（表格：事实 | 来源 | 置信度 | 是否交叉验证）

| # | 事实 | 来源 | 置信度 | 交叉验证 |
|---|------|------|--------|----------|
| 1 | 腾讯云 ADP（Agent Development Platform）采用"Adapter 模式"，通过环境变量 `CODETOOL_ADAPTER` 在 OpenCode 与 Claude Code 两种底层 harness 之间切换，编译期做模板替换（`adapter.cc.ts` / `adapter.oc.ts`），号称"运行时零开销、依赖隔离" | adp.tencent.com/zh/blog/agent-harness-engineering-adp-practice | 中（厂商博客一手但细节未见源码复核） | 未交叉验证 |
| 2 | ADP 的会话存储采用 Part/Message/Session 三层结构，Part 为最小语义单元（文本/工具调用/工具结果/推理/压缩摘要），并提供 session 级"智能压缩"，compact 接口耗时从秒级降到毫秒级 | 同上 | 中 | 未交叉验证 |
| 3 | ADP 权限模型分三层：企业级/空间级/应用级，叠加角色权限矩阵与资源配额，AgentType 区分 general-purpose（全工具）、explore（只读）、verification（后台只读，必须给 PASS/FAIL） | 同上 | 中 | 未交叉验证 |
| 4 | ADP 可观测性采用多层 Transcript：主会话 Transcript、Sidechain Transcript（子 agent 独立记录）、LLM Gateway Transcript（完整请求/响应），关键字段包括 agentId、agentType、teamName、parentSessionId、traceId | 同上 | 中 | 未交叉验证 |
| 5 | 阿里 AgentScope Runtime 采用"双核架构"：Engine（把智能体部署为 FastAPI 服务，支持 A2A 等多智能体通信协议）+ Sandbox（隔离执行环境，统一接口支持文件系统/浏览器等场景） | runtime.agentscope.io/zh/sandbox/sandbox_service.html；github.com/agentscope-ai/agentscope-runtime | 高（官方文档） | 已交叉验证（GitHub仓库描述与文档一致） |
| 6 | AgentScope Runtime 的 SandboxService 通过 `session_id` + `user_id` 管理不同会话的沙箱环境，支持沙箱复用与生命周期控制；CLI 提供 `agentscope chat/web/run/deploy`，`agentscope run SOURCE` 启动 HTTP API 服务，deploy 支持 ModelStudio/AgentRun/Kubernetes/Knative/Kruise | runtime.agentscope.io/zh/cli.html, /zh/sandbox/sandbox_service.html | 高 | 未交叉验证 |
| 7 | OpenClaw 在中国有多个 fork/插件生态，如 `openclaw-china`（BytePioneer-AI）、MaxClaw，社区昵称"小龙虾"，中文社区站点 clawd.org.cn / openclawchina.com，均以插件包形式接入飞书、钉钉、企业微信、QQ、微信客服等渠道 | github.com/BytePioneer-AI/openclaw-china；clawd.org.cn；zhuanlan.zhihu.com/p/2013706717012186762 | 高（GitHub 仓库+多方社区文章互证） | 已交叉验证（GitHub README 与知乎教程描述一致） |
| 8 | openclaw-china 通过统一 channel 聚合层（`@openclaw-china/channels`）为每个平台动态注册插件，各平台（DingTalk/Feishu/QQBot/WeCom/WeCom App）各自维护会话隔离（群/私聊分流），配置项含 `dmPolicy`（open/pairing/allowlist/disabled）与 `groupPolicy`（open/allowlist/disabled）+ `allowFrom` 白名单实现权限限制 | github.com/BytePioneer-AI/openclaw-china (WebFetch 提取) | 中（WebFetch 摘要，未逐行读源码） | 未交叉验证 |
| 9 | 腾讯云代码助手 CodeBuddy CLI 支持非交互模式 `-p/--print`，`--output-format text\|json\|stream-json`，会话续接 `--continue/-c`、`--resume/-r <id>`，`--no-session-persistence` 仅内存不持久化；支持自定义 system prompt、`--agent`/`--agents` 自定义子 agent、`--permission-mode`，以及 `--sandbox`（容器或 E2B 云沙箱）与 `--sandbox-id` | codebuddy.ai/docs/zh/cli/cli-reference | 高（官方文档） | 未交叉验证 |
| 10 | Kimi CLI（月之暗面）原生支持 ACP（Agent Client Protocol），可作为后端接入支持 ACP 的图形化客户端/IDE 插件（如 Zed），并演进出 Kimi Code（基于 K2.5 模型，支持多模态、集成 VSCode/Cursor/JetBrains/Zed） | txtmix.com/posts/tech/moonshotai-kimi-cli-terminal-agent/；adg.csdn.net/6a5b8ad610ee7a33f28ec7cb.html | 中（社区技术文章，非官方一手规范） | 未交叉验证 |
| 11 | iFlow CLI（阿里心流团队）是对标 Claude Code 的免费终端 Agent，支持 Qwen3-Coder/Kimi K2 等模型、subAgent、任务压缩上下文、开放插件市场；据报道已于 2026-03-20 起停止维护、2026-04-17 正式下线，用户迁移至 Qoder CLI | github.com/iflow-ai/iflow-cli；zhuanlan.zhihu.com/p/1961439434986721730（下线信息） | 中（下线时间来自二手文章，需谨慎，可能与竞赛评测无关但影响可选引擎判断） | 未交叉验证——**风险提示**：若已停止维护，不建议作为竞赛主力候选引擎 |
| 12 | DeepSeek Harness（`dsh`）基于自研的 Cordis 插件框架：插件贡献 service/typed event/可逆 side effect，无特权内核；启动通过 profile（列出 bundles 与 patches），base bundle `dsh-base` 提供模型适配器、工具、持久化 | deepseek-harness.github.io/deepseek-harness/reference/ | 高（项目官方文档） | 未交叉验证 |
| 13 | DeepSeek Harness 的会话日志是模型上下文的唯一权威来源，遵循"Model-visible means already logged"不变式；一个 step = 一次模型请求+工具调用，turn 包含零或多个 step；事件域分三类：持久 session events（`turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*`）、agent events（`agent/*`）、capability events（能力级 seam：Service Definition/Provider/Consumer） | 同上 | 高 | 未交叉验证 |
| 14 | 企业微信群机器人 Webhook 官方仅支持"发消息"，不支持"收消息"，双向交互需接入企业自建应用的消息回调（涉及 OAuth 与应用校验）；支持 text/markdown/markdown_v2/image/news/file/voice/template_card 等 8 种消息类型 | developer.work.weixin.qq.com/document/path/99110 | 高（官方开发者文档） | 未交叉验证 |
| 15 | 字节跳动已开源 Coze Studio（AI Agent 开发平台，Apache 2.0）、Coze Loop（AgentOps 全生命周期管理平台：调试/评测/监控，提供 Go/Python/Node SDK）、Eino（2025年2月开源的 Agent 编排引擎，类 LangGraph 图结构、全局 state、需预编译） | zhuanlan.zhihu.com/p/1971193992436757158；53ai.com/news/OpenSourceLLM/2025072834568 | 中（多篇社区/媒体文章，未直接读官方 GitHub README） | 未交叉验证 |
| 16 | 腾讯优图开源 Youtu-Agent（GitHub: TencentCloudADP/Youtu-Agent），面向开源模型（DeepSeek-V3 系）优化，YAML 配置定义 agent 行为，主打"两步搭建" | cloud.tencent.com/developer/article/2564602；github.com/TencentCloudADP/Youtu-Agent（未直接抓取） | 中 | 未交叉验证 |
| 17 | Higress（阿里开源云原生 AI 网关，基于 Istio/Envoy）提供 `ai-agent`（Agent 编排插件）、`ai-proxy`（统一 LLM 代理）、`ai-cache`、`ai-token-ratelimit` 等插件，商业版支持全链路 tracing 与 prompt trace | developer.aliyun.com/article/1684368；cnblogs.com/alisystemsoftware | 中 | 未交叉验证 |
| 18 | 智谱 AutoGLM 是自主 AI Agent，技术路径 GLM-4 base → GLM-Z1 推理 → GLM-Z1-Rumination → AutoGLM，可跨 App 自主执行 50+ 步操作；GLM Coding Plan 最新含 GLM-5.3 / GLM-5.3-Flash | zhuanlan.zhihu.com/p/1890366621287166337；bigmodel.cn/glm-coding | 中 | 未交叉验证 |

## 架构与工作原理

中国大厂在"Agent 网关 + Agent 引擎(harness)"这一架构范式上，与本赛题所描述的设计高度呼应，最典型的例证是**腾讯云 ADP（Agent Development Platform）的 Harness Engineering 实践**（adp.tencent.com/zh/blog/agent-harness-engineering-adp-practice）。其核心思路是把"容器内打包的一体化 Agent"拆成可独立伸缩的服务：Agent Loop、Memory、Sandbox、Tools 分离，Sandbox 仅在真正需要执行时才创建（这与赛题里"引擎在 Windows 环境按需拉起"的诉求一致）。ADP 用 Adapter 模式统一 OpenCode 与 Claude Code 两种底层 harness 的接口，切换靠环境变量 `CODETOOL_ADAPTER`，实现方式是编译期模板替换（`adapter.cc.ts`/`adapter.oc.ts`），强调"运行时零开销、依赖隔离、部署清晰"——这正是"网关稳定、引擎可插拔"的一种具体落地范式，值得作为我们架构设计的参考案例（尽管具体实现细节未开源，只能作为设计灵感而非可复用代码）。

阿里的 **AgentScope Runtime**（runtime.agentscope.io，GitHub: agentscope-ai/agentscope-runtime）走的是"双核心"路线：Engine 负责把智能体部署为标准 FastAPI 服务并支持 A2A 等跨智能体通信协议；Sandbox 提供隔离执行环境（本地 Docker/gVisor/BoxLite，或云端 K8s/函数计算/ACK），二者通过 `session_id` + `user_id` 关联，SandboxService 统一管理会话级沙箱的创建、复用与回收。这与赛题里"引擎进程 + 沙箱隔离 + session 标识"的设计思路一致，是国内厂商中把"session 到执行环境映射"讲得最清楚的开源项目之一。其部署面板支持 ModelStudio（阿里模型即服务）、AgentRun（阿里云原生 Agent 运行时）、Kubernetes、Knative、Kruise 多目标，体现了"同一 Engine 代码可对接多种运行时后端"的可移植设计。

阿里的**Higress AI 网关**（Istio/Envoy 内核，开源）代表了"网关层"在国内的另一种落地形态：它不做 session/harness 映射，而是聚焦在 LLM 流量治理层——`ai-proxy` 统一多模型协议代理、`ai-agent` 做 Agent 编排路由、`ai-token-ratelimit` 做 token 级限流、`ai-cache` 做语义缓存。这提示我们：赛题里的"Agent 网关"（session 生命周期 + 引擎调度）和"AI 网关"（LLM 流量治理）是两个不同层次的概念，真实业务系统里往往两者叠加——Agent 网关在上，AI 网关在下（管 Provider/Model 侧）。

字节的 **Coze Studio + Coze Loop + Eino** 组合则展示了"开发平台 + AgentOps + 编排引擎"三层分工：Eino 是类 LangGraph 的图编排运行时（需要预编译），Coze Studio 是给最终用户/开发者的可视化 Agent 构建平台，Coze Loop 是覆盖调试/评测/监控的全生命周期管理面（有 Go/Python/Node SDK）。这套组合里"编排引擎"和"运维/评测层"是分离的，对应我们架构中"引擎能力"与"可观测性/评测层"应该解耦的设计原则。

腾讯优图的 **Youtu-Agent**（TencentCloudADP/Youtu-Agent）走的是轻量 YAML 配置驱动路线，强调对开源模型（DeepSeek 系）的深度适配而非依赖闭源 API，这对赛题"主模型限定为内部部署模型、需自定义 OpenAI/Anthropic 兼容端点"的约束有参考价值——即国内多个框架已经把"自定义模型端点"作为默认设计前提，而非事后加的扩展点。

## 可编程接入面

几个国内/华人生态引擎的 CLI/SDK 接入面细节（对我们判断"网关如何驱动引擎"最有价值）：

**CodeBuddy CLI**（腾讯云代码助手，codebuddy.ai/docs/zh/cli/cli-reference）提供了和 Claude Code、opencode 高度相似的 headless 接入面：
- 非交互执行：`-p/--print`（单轮问答后退出），`--output-format text|json|stream-json`（stream-json 即可用于流式事件消费）
- 会话管理：`--continue/-c` 续接最近会话，`--resume/-r <id>` 恢复指定 session，`--no-session-persistence` 关闭落盘（纯内存对话）
- Agent 定制：`--agent <name>` 指定主 agent 类型（cli/multitask/自定义），`--agents '<json>'` 以 JSON 定义带 description/prompt 的子 agent 集合
- 权限：`-y/--dangerously-skip-permissions` 跳过大多数权限确认，`--permission-mode default|auto|dontAsk|...`，还有独立的 `--subagent-permission-mode`
- Sandbox（Beta）：`--sandbox` 容器/E2B 云沙箱，`--sandbox-id` 连接已有沙箱实例
- 系统提示词定制：`--system-prompt`（整体替换）、`--append-system-prompt`（追加）、`--system-prompt-file`（仅 print 模式）
这套参数体系几乎是 Claude Code CLI 的镜像（腾讯云 IDE 团队与 Anthropic 生态高度对齐），对我们设计"引擎适配器如何映射通用网关字段"是极好的参照——尤其是 `--resume`/session id 与网关 `POST /session/{id}/prompt_async` 语义可以直接对应。

**DeepSeek Harness (`dsh`)** 的接入面不是简单的 CLI flag，而是**插件化 profile/bundle 架构**：应用通过 `dsh` 启动一个具名 profile（存于 Harness home，列出所加载的 bundles 与 patches）。Base bundle `dsh-base` 提供模型适配器、工具、持久化；额外 bundle 可挂载 Web App、headless runner、SDK Server。这意味着 DeepSeek Harness 本身就带有"headless runner"这种可挂载形态，天然适合作为网关背后的一个引擎实例来启动（`dsh --profile headless-server --port 6217` 之类）。其能力扩展单元叫 **seam**（Service Definition + Provider + Consumer 三元组），替换一个 Provider（如文件系统）会连带重定向 Bash/PTY/LSP 等消费者——这是一种比"插件注册表"更强的能力抽象，值得我们在"公共能力 vs 扩展能力"章节借鉴其分层思想。

**Kimi CLI（月之暗面）** 的显著特征是原生支持 **ACP（Agent Client Protocol）**，即可以作为 ACP Server 被 Zed、IDE 插件等 ACP Client 驱动，这代表国内厂商已经在跟随 Zed 主导的 ACP 协议生态；虽然赛题的"通用 Agent 网关规范"走的是 opencode server API 路线（HTTP+SSE），而非 ACP（JSON-RPC over stdio），但如果未来要"多协议网关"，ACP 是需要纳入视野的第二种主流协议。Kimi CLI 还支持 Shell Mode 与 MCP，与 Ctrl-K 切换到 agent 模式的"双模态"设计。

**iFlow CLI（阿里心流团队）**曾是对标 Claude Code 的免费终端 Agent，支持 subAgent、任务上下文压缩、开放插件市场；但据二手报道其已于 2026-03-20 起停止维护、2026-04-17 正式下线，用户被引导迁移至 Qoder CLI。**风险提示**：该信息来自社区文章而非官方一手公告，建议在最终方案中不要把 iFlow CLI 作为主力候选引擎，或接入前先核实其当前可用性与是否仍可获取二进制/安装包。

## 会话模型

腾讯云 ADP 的会话存储采用**三层结构 Part → Message → Session**：Part 是最小语义单元，覆盖文本、工具调用、工具结果、推理内容、压缩摘要等多种类型；Message 与 Session 逐级聚合。这与赛题里"通用 Agent 网关规范"要求的 `GET /session/{id}/message` 返回"完整轨迹：user/assistant/tool call/tool result/step-finish"在结构上高度一致，说明国内大厂已经在这套"Part 化消息模型"上收敛，是我们设计归一化事件模型时可以直接借鉴的分层（Part 类型可作为我们统一事件 schema 的枚举基础）。ADP 还专门做了 **session 级智能压缩**（compact），号称接口响应从秒级降到毫秒级，提示我们"长会话上下文压缩"应作为网关或引擎适配层的一个可选公共能力去暴露（例如网关层可以统一发一个 "compact" 控制信号，具体压缩算法留给引擎自己实现）。

AgentScope Runtime 的会话模型更偏向传统 Web 后端范式：`session_id` + `user_id` 双键，`RedisSession` 作为可插拔的持久化后端，`load_session_state()`/`save_session_state()` 是引擎与存储之间的标准接口。这种"session_id/user_id 双键 + 可插拔存储后端"的模式，可以直接映射到赛题里"群助手"场景的"业务→session 映射"需求：group_id 映射到 session_id，member_id 映射到 user_id，从而同时满足"同群会话连续性"与"群与群之间上下文隔离"。

DeepSeek Harness 的会话模型走的是**事件溯源（event-sourcing）**路线：session log 是模型上下文的唯一权威来源，遵守"Model-visible means already logged"不变式（任何进入模型上下文的输入都必须能从事件日志重建，并有运行时断言强制执行）。一个 **step** = 一次模型请求 + 其触发的工具调用；一个 **turn** 包含零或多个 step，在"认领输入"时打开，在"无剩余工作"时关闭。持久事件命名空间包括 `turn/*`、`step/*`、`user/message`、`assistant/*`、`tool/*`。这套模型比 opencode 的 message/part 模型更严格（多了"turn/step"两层状态机和强制的日志完备性断言），对我们设计"跨引擎统一事件协议"时是一个更严谨的参照系——如果我们要兼容 DeepSeek Harness 作为候选引擎之一，需要把它的 turn/step 事件映射到网关规范的 `step-finish` 语义上。

## 权限与安全

ADP 的权限模型是"三级分层 + 角色矩阵 + 资源配额"的组合：企业级 → 空间级 → 应用级，逐层收窄权限边界；同时用 **AgentType** 对工具调用能力做粗粒度隔离——`general-purpose`（`tools: ['*']`，全量工具）、`explore`（只读，明确禁止 Edit/Write）、`verification`（后台运行、只读、且必须显式返回 PASS/FAIL 结论）。这种"预置几种标准 AgentType 而非让业务自己拼权限矩阵"的做法，对我们设计"群助手权限限制"很有参考价值：网关层可以预定义几类标准角色（如"只读咨询""可执行操作""需要人工审批"），再把角色映射到引擎的 permission-mode 或 allowed-tools 参数，而不必让每个业务方自己去拼具体的工具白名单。

企业微信群机器人的权限模型则揭示了国内 IM 场景的一个常见硬约束：**Webhook 只能发消息、不能收消息**，双向交互（用户发消息触发机器人）必须走企业自建应用的消息回调机制，涉及 OAuth 和应用身份校验（developer.work.weixin.qq.com/document/path/99110, /101463）。这意味着"群助手网关"在企业微信场景下实际上要维护两条链路：一条是 Webhook 出站（简单，无需鉴权到具体用户），一条是自建应用回调入站（复杂，涉及企业身份体系、应用可见范围、成员授权）。这对我们设计"业务网关 IM 适配层"是重要的现实约束——不能假设所有 IM 渠道都对称支持收发。

openclaw-china 的权限实现示例（`dmPolicy: open|pairing|allowlist|disabled`，`groupPolicy: open|allowlist|disabled`，配合 `allowFrom` 白名单）展示了一种轻量但实用的策略描述语法，值得作为我们网关"权限限制"配置面的最小可行设计参考——即用简单的策略枚举 + 白名单，而非复杂的 RBAC，就能覆盖群助手场景的常见诉求（谁能私聊、哪些群可以拉群助手、群内谁能触发）。

CodeBuddy CLI 的 `--permission-mode`（default/auto/dontAsk 等）与独立的 `--subagent-permission-mode`，说明"主 agent 权限"与"子 agent 权限"需要能分别配置——这与赛题里提到的"agent team"扩展能力相关：如果引擎支持多 agent 编排，网关在做能力配置时要能透传"子 agent 权限策略"这个维度，而不能只有一个全局权限开关。

## 扩展机制与资产

DeepSeek Harness 的 **Cordis 插件框架**是国内公开资料中对"引擎扩展机制"描述最系统的一例：插件向共享上下文贡献 service、typed event、可逆 side effect；没有特权内核，扩展与其它插件平级挂载，卸载时自动逆转注册。其能力抽象单元 **seam**（Service Definition 接口 + Provider 实现 + Consumer 消费者三元组）允许"替换一个 Provider 联动重定向多个消费者"（例如换掉文件系统 Provider，会同时影响 Bash/PTY/LSP 的执行后端）。这是一种比"插件目录+manifest"更强的能力耦合设计，对我们"扩展机制与资产"章节的启示是：把"文件系统""执行环境""模型适配器"都定义为 seam 级别的可替换能力，而不是简单的工具列表，能让底层能力替换（比如把本地文件系统换成远程沙箱）对上层引擎逻辑透明。

字节 Eino 采用"图结构 + 全局 state + 预编译"的编排范式，与阿里 AgentScope 的"Engine + Sandbox"双核心、DeepSeek Harness 的"插件化 bundle/profile"、腾讯 ADP 的"Adapter 模式切换底层 harness"，共同勾勒出国内头部厂商在"扩展机制"上的四种典型路线：图编排 DSL（Eino）、沙箱能力包（AgentScope）、事件驱动插件（DeepSeek Harness）、适配器模式（ADP）。我们的网关设计应尽量兼容这几种范式，而不是绑死其中一种——具体做法是：网关层只关心"能力声明 + 能力调用"这两个动作的协议，不关心引擎内部用哪种范式实现该能力。

Coze Studio 提供 Prompt / RAG / Plugin / Workflow 四类核心开发资产，这是国内"低代码 Agent 构建平台"的典型资产模型，可以作为我们"统一 AI 资产/插件/记忆模型"章节里"资产分类"的参考基线之一（Prompt 资产、检索资产、插件/工具资产、工作流资产）。

## 记忆

本次调研未找到国内厂商就"引擎级长期记忆机制"给出足够细节的一手资料（多数文章聚焦编排与部署，未深入记忆存储格式）。ADP 提到"session 级智能压缩"属于短期上下文管理范畴，AgentScope Runtime 的 `load_session_state()`/`save_session_state()` 提供的是会话级状态持久化接口，而非跨 session 的长期记忆抽象。DeepSeek Harness 的 session log 事件溯源模型理论上可以支撑"从历史事件重建记忆"，但官方参考文档未明确给出独立的记忆子系统描述。**结论**：记忆维度国内公开资料较薄弱，建议在我们的架构设计中把"记忆"作为一个独立于 session 存储的可选扩展能力对待，暂不依赖国内某个引擎的记忆实现作为标准范式。

## 多 Agent 与协作

ADP 的 Transcript 关键字段里包含 `agentId`、`agentType`、`teamName`、`parentSessionId`，直接证明其已支持"team"概念下的多 agent 协作，并用 `parentSessionId` 维护父子会话关系（子会话很可能对应 sub-agent 或并行 verification agent）。CodeBuddy CLI 的 `--agents '<json>'` 允许以 JSON 定义一组带 description/prompt 的自定义子 agent，并可对子 agent 单独设置 `--subagent-permission-mode`。AgentScope Runtime 强调 Engine 层支持 A2A（Agent-to-Agent）等跨智能体通信协议，用于多智能体互联。iFlow CLI 曾提供"subAgent"功能把 CLI 从通用助手升级为"专家团队"模式。这些例子共同表明：国内引擎普遍把"多 agent/team"作为一种扩展能力（而非公共必需能力）来实现，且各自的粒度不同——有的是"子 agent 配置 JSON"（CodeBuddy），有的是"team 概念内建在 transcript 里"（ADP），有的是"标准协议 A2A"（AgentScope）。这提示我们的能力协商协议需要把"multi-agent"拆成至少两个子维度描述：(a) 编排粒度（单进程内子 agent vs 独立会话间协作）(b) 互联协议（内部私有 vs 标准 A2A/MCP）。

## 可观测性

腾讯 ADP 的多层 Transcript 方案是本次调研中最具体的国内可观测性实践：主会话 Transcript + Sidechain Transcript（子 agent 独立记录）+ LLM Gateway Transcript（完整请求/响应，包含 traceId），关键追踪维度包括 agentId/agentType/teamName/parentSessionId、完整 Tool Use/Tool Result、以及 Usage 统计（token、tool use count、duration）。这与赛题网关规范里 `GET /session/{id}/message` 要求的"完整轨迹"和 `GET /event` SSE 的事件流高度契合，可以直接作为我们"统一可观测协议"设计的字段参照——即我们的归一化事件应至少包含 sessionId/parentSessionId（多 agent 场景）、agentType、traceId、tool call/result 全量、以及 usage（token/tool次数/耗时）这几类字段。

Higress AI 网关的商业版能力（prompt trace、全链路 tracing、REST 接口性能监控）提示：可观测性其实分两层——Agent 引擎侧的 Transcript（会话/工具调用维度）和网关/LLM 代理侧的流量 Trace（请求/响应/延迟维度）。我们的架构应该把两者都纳入统一可观测协议，但允许分别接入（引擎侧 Transcript 走网关规范的 `/message` 与 SSE，网关/LLM 代理侧 Trace 可以独立走 OTel 或类似标准）。

## 对我们架构的启示（公共能力 vs 扩展能力映射表、接入参数、风险与坑）

### 公共能力 vs 扩展能力映射表（基于国内案例归纳）

| 能力 | 是否应作为"公共能力"（网关统一暴露） | 国内证据 | 归一化建议 |
|------|----------------------------------|----------|-----------|
| session 创建/续接/隔离 | 是 | ADP Part/Message/Session；AgentScope session_id+user_id；CodeBuddy --continue/--resume | 直接对应赛题 `POST /session`、`--resume` 语义，网关维护 业务ID→session_id 映射表 |
| 权限模式（只读/可执行/需审批） | 是（但具体白名单细节留给引擎） | ADP AgentType；CodeBuddy --permission-mode | 网关定义 2-3 档标准权限角色，翻译为各引擎自己的参数 |
| 自定义模型端点（OpenAI/Anthropic 兼容） | 是（硬约束） | Youtu-Agent 优先适配开源模型；DeepSeek Harness 模型适配器 seam | 网关传 base_url/api_key/model 给引擎启动参数或环境变量 |
| 会话压缩/摘要 | 是（可选公共能力，接口统一，算法各异） | ADP session 级 compact | 网关可发 "compact" 信号，引擎各自实现 |
| Transcript/事件轨迹 | 是 | ADP 三层 Transcript；DeepSeek Harness turn/step 事件 | 归一化为 message part 类型枚举 + step-finish 标记 |
| Sandbox/执行环境隔离 | 是（网关层只关心"是否隔离"，不关心具体实现） | AgentScope Sandbox；CodeBuddy --sandbox/--sandbox-id | 网关传 directory/workdir，引擎自行决定容器化与否 |
| Multi-agent / team | 否，扩展能力 | ADP teamName/parentSessionId；CodeBuddy --agents JSON；AgentScope A2A | 需要单独的能力协商字段：粒度(单进程子agent/独立会话)+协议(私有/A2A/MCP) |
| Dynamic workflow / 图编排 | 否，扩展能力 | Eino 图结构+全局state+预编译 | 仅部分引擎支持，需要能力探测 |
| ACP 兼容（作为 ACP Server 被驱动） | 否，扩展能力（协议层面） | Kimi CLI 原生 ACP | 若网关未来要兼容 ACP 客户端，需要单独的协议适配层，不影响 opencode-style 规范主线 |
| 长期记忆子系统 | 否，扩展能力（国内资料薄弱） | 无明确证据 | 暂不作为公共能力标准化，留待引擎自行声明 |
| 插件/资产分类（Prompt/RAG/Plugin/Workflow） | 部分是（作为资产模型基线） | Coze Studio 四类资产 | 可作为我们"AI 资产模型"的分类基线，但不强制引擎全部支持 |

### 接入参数示例（可直接用于我们"能力识别→适配→认证"流程设计）

- **CodeBuddy 风格适配器**：`codebuddy -p "<prompt>" --output-format stream-json --resume <session_id> --permission-mode dontAsk --settings '{"apiBase":"...","apiKey":"..."}'` → 网关把 `prompt_async` 请求转换成上述命令行调用，用 stream-json 输出解析为归一化事件。
- **DeepSeek Harness (dsh) 风格适配器**：`dsh --profile headless-server --port 6217`（若其 headless runner bundle 支持类似 opencode 的 server 模式），网关需要额外做一层"turn/step 事件 → step-finish"的翻译；认证信息通过 profile 内 patch 或环境变量注入模型适配器 seam。
- **AgentScope Runtime 风格适配器**：`agentscope run <source> --session-id <id> --user-id <biz_user_id>`，网关把群/用户 ID 映射为 session_id/user_id 双键，天然契合"群会话连续性+隔离"的诉求。

### 风险与坑

1. **iFlow CLI 可能已停止维护**（二手信息，2026-03-20 停止维护、2026-04-17 下线），若考虑接入需先核实官方仓库最新状态，避免选择一个已死的引擎作为竞赛候选。
2. **企业微信群机器人 Webhook 单向限制**：只能发不能收，双向交互必须走自建应用回调（涉及 OAuth）。设计群助手网关时，不能假设所有 IM 渠道都对称支持"网关主动收发"，需要为不同渠道设计不同的接入形态（Webhook 出站 vs 应用回调入站）。
3. **国内厂商很多"harness 内部实现细节"（如 ADP 的 Adapter 模式、Cordis 插件）来自厂商博客/文档，并非全部开源**，无法直接复用代码，只能作为架构设计灵感，实际实现仍需基于赛题指定的开源引擎（opencode、Claude Code 等）。
4. **DeepSeek Harness 与 opencode 的事件模型不完全同构**（turn/step vs message/part），接入 DeepSeek Harness 作为候选引擎时，其"事件溯源+断言完备性"的设计比 opencode 更严格，适配层需要专门做映射，不能假设所有引擎的事件粒度一致。
5. **"Multi-agent"在国内各引擎中实现粒度差异很大**（进程内子 agent JSON 配置 vs 独立 session 父子关系 vs 标准 A2A 协议），网关做能力协商时必须把 multi-agent 拆成细粒度的可比较维度，不能用一个布尔值笼统表示"是否支持多 agent"。

## 未解决问题

1. ADP 的 Adapter 模式（`CODETOOL_ADAPTER` 切换 OpenCode/Claude Code）具体的接口契约（是否就是 opencode server API 的超集？）未见开源代码，无法直接验证其与赛题"通用 Agent 网关规范"的吻合程度。
2. 国内引擎的"长期记忆"标准化程度不明，未找到类似 mem0、Zep 这类专门记忆层在国内 harness 中的对应实践的一手资料。
3. Kimi CLI 的 ACP 支持细节（具体消息格式、是否支持 session resume）未做深入源码级验证，仅基于社区文章。
4. openclaw-china 的"群会话隔离"实现是否有类似赛题要求的"session 映射到底层引擎 session"的精确语义（还是仅仅是消息路由层面的隔离）未完全确认，需要进一步读源码。
5. Youtu-Agent、Eino、Coze Studio 的具体 CLI/API headless 接入形态未直接抓取源码验证，仅基于二手技术文章总结，如需在方案中引用其具体命令行/API 需要进一步核实官方 GitHub README。

## 来源列表

- https://adp.tencent.com/zh/blog/agent-harness-engineering-adp-practice （腾讯云 ADP Harness Engineering 实践博客）
- https://runtime.agentscope.io/zh/cli.html （AgentScope Runtime CLI 官方文档）
- https://runtime.agentscope.io/zh/sandbox/sandbox_service.html （AgentScope Runtime Sandbox Service 文档）
- https://github.com/agentscope-ai/agentscope-runtime （AgentScope Runtime 仓库）
- https://github.com/BytePioneer-AI/openclaw-china （OpenClaw 中国渠道插件仓库）
- https://clawd.org.cn/ （OpenClaw 中文社区）
- https://zhuanlan.zhihu.com/p/2013706717012186762 （OpenClaw 接入微信/钉钉/飞书/QQ 教程）
- https://www.codebuddy.ai/docs/zh/cli/cli-reference （腾讯云 CodeBuddy CLI 官方参考文档）
- https://deepseek-harness.github.io/deepseek-harness/reference/ （DeepSeek Harness 官方架构参考）
- https://developer.work.weixin.qq.com/document/path/99110 （企业微信开发者中心：消息推送配置说明）
- https://developer.work.weixin.qq.com/document/path/101463 （企业微信开发者中心：智能机器人长连接）
- https://developer.aliyun.com/article/1684368 （Higress 架构学习指南，阿里云开发者社区）
- https://txtmix.com/posts/tech/moonshotai-kimi-cli-terminal-agent/ （Kimi CLI ACP+Shell Mode+MCP 分析）
- https://zhuanlan.zhihu.com/p/1961439434986721730 （iFlow CLI 相关文章，含下线信息，二手来源）
- https://cloud.tencent.com/developer/article/2564602 （腾讯优图 Youtu-Agent 开源介绍）
- https://zhuanlan.zhihu.com/p/1971193992436757158 （字节 Coze Studio/Coze Loop 解析）
- https://zhuanlan.zhihu.com/p/1890366621287166337 （智谱 AutoGLM 介绍）
- https://www.bigmodel.cn/glm-coding （智谱 GLM Coding Plan 官方页面）
