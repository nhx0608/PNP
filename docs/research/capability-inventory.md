# 能力清单（Capability Inventory）v0

> 汇总自 DIGEST.md 及 T01–T30、G01–G06 共 27 份一手调研报告（`/scratchpad/research/`）。目的：作为网关"能力协商 / Capability Manifest / 节点配置 schema"设计的原材料，不代表最终架构决策。
>
> **命名约定**：`namespace.capability`（偶见三段 `namespace.capability.detail`），namespace 取值 `session/turn/permission/sandbox/tool/asset/context/memory/team/workflow/schedule/evolution/observability/model/protocol/route`，参照 T23 WIT package 与 ACP `_meta` 命名空间思路，避免"memory""mode"等泛词在引擎间语义碰撞（见第 3 节）。
> **归类标准**（参照 T23 K8s Conformance / LSP / A2A 四层 tier）：
> - **core**：≥2/3 候选引擎原生具备且是网关最小闭环（session+turn+基础权限+事件流）必需项，赛题网关规范端点直接对应。
> - **standard**：多数主流引擎（opencode/Claude Code/Codex/Gemini 系/Hermes/OpenClaw 中≥3 家）具备，但非全部，允许能力位声明+降级。
> - **extension**：仅 1–2 家引擎原生具备，作为 `extensions.<engine>.<capability>` 命名空间暴露，网关不承诺归一化语义，只做能力标记+参数透传。
> - **experimental**：官方自身标注实验/预览/研究阶段（env flag 开关、RFD 草案、论文原型），不建议纳入 v1 评测路径，仅记录以防未来选型。
>
> polyfill 列的 **是/否/部分** 指网关能否在引擎不具备该能力时，在网关层模拟出等价语义（而非要求引擎升级）。

## 1. 能力清单（按域分组）

### 1.1 会话生命周期 `session.*`

| 能力 ID | 一句话定义 | 具备的引擎（机制/字段） | 差异点 | 归类 | 典型配置参数 | polyfill |
|---|---|---|---|---|---|---|
| `session.create` | 创建一个新会话并绑定到运行上下文 | 几乎全部：Claude Code(`--session-id`)、opencode(`POST /session{parentID,title}`)、Codex(`thread/start`)、Hermes(`POST /api/sessions`)、OpenClaw(`sessionKey`隐式创建)、dsh(`session/new`)、pi(首次`--session <file>`)、Goose(`--session-id`) | 有的显式创建端点（opencode/Codex/Hermes/dsh-ACP），有的靠首次 prompt 隐式建（Claude Code -p、pi、OpenClaw） | core | `cwd/directory`、`title`、`metadata`、初始 `model/agent` | 否（是所有引擎的基线能力） |
| `session.resume` | 用已知 ID 续接历史会话（同引擎、同宿主） | Claude Code(`--resume/--continue`)、opencode(`session.create{parentID}`隐式/无独立resume-by-id但可直接prompt)、Codex(`thread/resume`)、dsh(ACP `session/resume`)、Hermes(`X-Hermes-Session-Id`)、Qwen Code(`--resume [sessionId]`)、Goose(`-r/--resume`)、ACP(`session/load`需能力位) | Claude Code 不恢复 `--mcp-config/--settings/--add-dir`；ACP `session/load` 是"回放式"而非真续接；Gemini CLI headless 是否支持未确认（关键缺口，见 T08） | core | `session_id`、是否重放全部启动参数 | 部分（引擎不支持时，网关自存 transcript，新会话开场把历史压缩注入 system prompt） |
| `session.fork` | 从现有会话（或某历史节点）复制出一个新会话，原会话不受影响 | Claude Code(`--fork-session`)、opencode(`session.fork()`)、Codex(`thread/fork`)、pi(`/fork`树内分支)、Kilo(`--fork/--cloud-fork`)、ACP(`session/fork`RFD草案)、dsh(`ctx.agents.create seed/parentSession`) | pi 是"树内原地分支"（单文件多分支），其余是"复制式"（新文件/新ID）；Hermes/OpenClaw 无原生 fork | standard | `from_session_id`、`from_entry_id`（pi 特有） | 是（无 fork 引擎：网关复制 transcript 文本，作为新会话首轮系统消息灌入） |
| `session.list` | 枚举引擎当前持有的会话 | opencode(`GET /session`)、dsh(ACP `session/list`)、Hermes(`/api/sessions`)、Goose(`sessions.db`可查)、ACP(`session/list`能力位) | Claude Code 无程序化 list（仅交互式 picker）；OpenClaw 通过 Gateway `sessions.list` | standard | `cursor`、`filter(tenant/group)` | 是（网关自维护 SessionRegistry，天然满足） |
| `session.close` / `session.delete` | 释放运行时资源 vs 彻底删除历史 | opencode(`abort`释放进程)、Codex(`thread/unsubscribe`60s卸载)、dsh(ACP `session/close`)、ACP(`session/close`释放/`session/delete`删历史两级) | 多数引擎只有"进程退出"，无显式区分 close/delete | standard | `mode: close|delete` | 是 |
| `session.reset_policy` | 会话自动过期/重置策略 | OpenClaw(`reset{mode:none\|daily\|idle,atHour,idleMinutes}`)、Hermes(`session_reset.mode:none\|idle\|daily\|both`) | 语义细节不同：OpenClaw 先到先生效，Hermes 重置前先给 agent 一轮"保存记忆"机会 | extension（目前仅群助手型网关引擎原生具备） | `mode`、`idle_minutes`、`daily_at` | 是（网关层通用调度器实现，天然适用所有引擎） |
| `session.compact` | 程序化触发或自动阈值触发的上下文压缩/摘要 | opencode(`POST /session/{id}/summarize`)、pi(`compact`/自动阈值)、OpenClaw(`/compact`+三种自动触发)、Hermes(`/compress`生成续篇会话)、Claude Code/Codex(仅 best-effort 斜杠命令，无稳定 API) | 压缩是"追加式保留 retainedTail"（pi）还是"覆盖式重写"，直接影响可追溯性；Claude/Codex 无程序化触发只能靠阈值自动 | standard | `keepRecentTokens`、`reserveTokens`、`threshold`、`customInstructions` | 部分（网关可在引擎不支持时自己截断+调用 LLM 生成摘要重灌，但无法复用引擎内部 token 计数） |
| `session.revert` | 回退到某历史检查点（覆盖式撤销，非只读浏览） | opencode(`session.timeline/revert`+文件快照)、Gemini CLI(checkpointing，影子 git 仓库) | 两者都绑定"工具执行前自动快照"，语义接近 git revert 而非分支 | extension | `to_entry_id`、`revert_files: bool` | 部分（网关可用 git commit 快照工作目录，但无法回滚引擎内部对话状态） |
| `session.share` | 生成只读/公开分享链接 | opencode(`share: manual\|auto\|disabled`) | 企业版可强制禁用（`disabled`） | extension | `share_mode` | 否（无实际网关业务价值，通常直接禁用） |
| `session.directory_isolation` | 每会话独立工作目录，兼具隔离边界与文件系统语义双重角色 | 几乎全部：opencode(`?directory=`)、Claude Code(`cwd`+`--add-dir`)、Codex(`thread/start.cwd`)、ACP(`session/new.cwd`) | opencode 的 `directory` 是 query 参数非 body 字段（G04 实测发现，文档口径不一致）；Claude Code 用 `CLAUDE_CONFIG_DIR`+`CLAUDE_CODE_PROJECT_DIR_NAME` 做租户级隔离而 cwd 只管工作区 | core | `directory/cwd`、`additionalDirectories[]` | 否（必须引擎原生支持，否则跨群串文件的风险无法在网关层完全兜底） |

### 1.2 轮次执行与流控 `turn.*`

| 能力 ID | 一句话定义 | 具备的引擎（机制/字段） | 差异点 | 归类 | 典型配置参数 | polyfill |
|---|---|---|---|---|---|---|
| `turn.prompt_sync` | 阻塞式：发送一次输入，等到该轮结束才返回完整结果 | Claude Code(`-p`默认)、Codex(`exec`默认)、opencode(`POST /session/{id}/message`真阻塞) | 语义看似一致，但"阻塞直到结束"的判定信号不同（stop_reason/finish/idle 状态），网关需以统一 `finish` 事件收口 | core | `timeout_ms` | 否 |
| `turn.prompt_async` | 立即返回（如 202/204），后续通过事件流通知完成 | opencode(`prompt_async`真异步立即204，与文档直觉相反，见 G04) | **易踩坑**：赛题网关规范定义的"阻塞直到结束"若直接透传 opencode 原生 `prompt_async` 会误判完成时机，网关必须自行订阅 SSE 等到 `session.status:idle` 才对外返回 | core | — | 是（网关可用"发起+订阅事件流内部转同步"的方式模拟阻塞语义，对所有异步型引擎适用） |
| `turn.stream` | 增量流式输出（token/文本 delta） | 全部：Claude Code(`stream_event`)、opencode(`message.part.updated`)、Codex(`item.updated`delta)、pi(`message_update`仅delta需客户端自行累计)、Hermes(`assistant.delta`) | pi 0.84+ 事件只含 delta 不含全量，客户端必须自行拼接；OpenClaw 走 WS 帧非 SSE | core | `stream: true`、节流间隔(节流合并见 T26) | 否 |
| `turn.cancel` | 中断/取消进行中的轮次，进程/子进程真正终态化 | Claude Code(SIGINT/`interrupt()`)、opencode(`/abort`)、Codex(`turn/interrupt`)、dsh(仅ACP `session/cancel`，**SDK 通道无cancel**)、ACP(`session/cancel`) | dsh SDK 通道无法取消，只能杀进程；"真取消"（UHP conformance C-03）要求进程真正终止而非仅停止读输出，需网关侧做进程树杀除验证（Windows 见 G06） | core | — | 部分（引擎不支持优雅取消时，网关只能整进程 kill，副作用不可控） |
| `turn.steer` | 运行中动态注入新指令，在下一个工具调用边界生效（不打断当前工具执行） | OpenClaw(`queue.mode:steer`默认)、opencode v2(`delivery:"steer"`)、pi(`steer`/`set_steering_mode`) | 并非所有引擎支持"注入进行中的轮次"，多数只能排队等下一轮 | extension | `steering_mode: all\|one-at-a-time` | 部分（不支持的引擎，网关只能退化为 `followup` 排队） |
| `turn.queue_mode` | 同一会话多条到达消息的排队策略 | OpenClaw(`steer\|followup\|collect\|interrupt`)、Hermes(`busy_input_mode`)、pi(`follow_up/clear_queue`) | 语义命名不统一但可归一为四态；`interrupt` 是 Hermes 默认，`steer` 是 OpenClaw 默认，选型隐含产品哲学差异 | core（网关侧统一实现） | `mode`、`cap`(队列上限)、`debounce_ms`、`drop: summarize\|old\|new` | 是（本身就建议由网关统一实现，不依赖引擎原生，见 T21/T26 设计启示） |
| `turn.structured_output` | 约束模型最终输出为给定 JSON Schema | Claude Code(`--json-schema`/SDK`outputSchema`)、Codex(`--output-schema`，仅gpt-5系列且与`resume`互斥)、opencode(`format: json_schema`)、Goose(Recipe `response.json_schema`) | Codex 的限制最强（模型族限定+与 resume 互斥）；Goose 的 schema 绑定在 Recipe 资产里而非单次调用参数 | standard | `schema`(JSON Schema) | 部分（网关可要求模型在 prompt 里自约束+程序化校验重试，但不如原生强约束可靠） |
| `turn.budget` | 预算/轮次数/耗时上限控制 | Codex(`max_threads/max_depth`)、Qwen Code(`--max-session-turns/--max-wall-time/--max-tool-calls`)、Goose(`--max-turns`默认1000/`--max-tool-repetitions`)、Claude Workflow(`workflowSizeGuideline`) | 维度不同：轮次数 vs 壁钟时间 vs 工具调用次数 vs 并发子agent数，需要网关统一成多维预算对象 | standard | `max_turns`、`max_wall_time_s`、`max_tool_calls`、`max_cost_usd` | 是（网关可用外部计时器+ `turn.cancel` 强制熔断，对所有引擎通用兜底） |

### 1.3 权限、审批与沙箱 `permission.* / sandbox.*`

| 能力 ID | 一句话定义 | 具备的引擎（机制/字段） | 差异点 | 归类 | 典型配置参数 | polyfill |
|---|---|---|---|---|---|---|
| `permission.mode` | 预设权限档位（少量枚举值，覆盖常见场景） | Claude Code(6档：default/acceptEdits/plan/auto/dontAsk/bypassPermissions)、Qwen Code(5档：plan/default/auto-edit/auto/yolo)、Codex(`approval_policy`：untrusted/on-request/on-failure/never)、Goose(4档：auto/approve/smart_approve/chat) | 档位数量与语义完全不对齐，是最需要网关归一化的一层；"非交互下 ask 静默变 deny"是 Gemini/Claude 的共性坑 | core | `mode` 枚举（网关侧统一为 2–3 档最小公分母：`auto`/`ask`/`readonly`，细分档位放 `engine_options`） | 否（模式本身必须映射到引擎原生参数，但网关可在其上叠加统一 deny 优先兜底） |
| `permission.rule` | 细粒度 allow/deny/ask 规则（工具名 + 参数 glob/正则） | Claude Code(`Tool(pattern)`语法,首个命中生效)、opencode(键含read/edit/bash/task/skill等，**最后匹配生效**，与Claude相反)、Gemini CLI(Policy Engine TOML `[[rule]]`+五层tier，优先级=`tier_base+priority/1000`)、OpenClaw(`sha256:argv`精确参数哈希白名单) | 冲突消解语义相反（首个命中 vs 最后命中 vs 数值优先级）是最大陷阱，网关必须持单一策略源（deny优先）经编译器分别生成 | core | `allow[]/deny[]/ask[]`（glob/正则规则集） | 部分（网关自有策略引擎可覆盖，但仍需按引擎语义编译成其原生格式，无法完全脱离引擎） |
| `permission.request_callback` | 运行时对危险操作发起阻塞式人机审批请求 | Claude Code(`--permission-prompt-tool`/SDK`canUseTool`/hook)、ACP(`session/request_permission`，四态`allow_once/allow_always/reject_once/reject_always`)、opencode(SSE`permission.updated`→`POST /session/{id}/permissions/{id}`)、Hermes(`POST /v1/runs/{id}/approval`)、Codex(`item/*/requestApproval`) | ACP 只定义"单次工具调用"粒度，"always"的持久化作用域由 Agent 自行决定，协议未规定；网关若要"按群/租户记账 allow_always"必须自己持有该状态，不能信任引擎 | core | `timeout_s`(默认多为300–600)、`decision`枚举 | 否（这是需要引擎主动配合的运行时回调，网关只能做转发+超时兜底，无法伪造） |
| `permission.review_llm` | 用 LLM 作为审批者，自动分类风险并放行/拒绝 | Claude Code(`auto`分类器)、Hermes(`approvals.mode:smart`)、Goose(`smart_approve`用`PermissionJudge`)、Codex(`approvals_reviewer:"auto_review"`Guardian) | 各引擎 reviewer 不可互换、不可审计，安全敏感场景应默认降级为普通 `ask` | extension | `review_model`、`risk_threshold` | 否（这是引擎内部分类器能力，网关不应假装拥有等价判断） |
| `sandbox.fs_isolation` | 文件系统读写范围隔离（read-only/workspace-write/full） | dsh(`SandboxMode`三档)、Codex(`sandbox_mode`三档)、Claude Code(内建 Seatbelt/bubblewrap，仅约束Bash) | Codex 唯一把 Windows 原生沙箱当一等目标（elevated模式四层防御）；多数引擎在原生 Windows 上此项能力降级或不可用（见 G01） | core | `mode: read_only\|workspace_write\|full_access` | 部分（网关可用容器/受限用户账户在进程外补，但工具内部文件访问语义仍需引擎配合） |
| `sandbox.os_isolation` | OS 级进程/网络沙箱（容器、微VM、seccomp、Job Object 等） | Codex(Seatbelt/bwrap+seccomp/Windows ACL)、OpenClaw(Docker，但**不包裹ACP外部harness**)、pi(Gondolin微VM/Docker/OpenShell三选一，扩展本身不受沙箱约束) | "工具入沙箱不等于扩展/引擎本身入沙箱"是普遍陷阱（pi、OpenClaw均如此声明） | extension | `sandbox_backend`、`workspace_mount` | 是（网关可用容器/Job Object 在进程外层统一兜底，独立于引擎自身沙箱能力，这也是 G06 强调的 Windows 必做项） |
| `sandbox.network_policy` | 网络域名 allow/deny 策略 | Anthropic `srt`(`allowedDomains/deniedDomains`经宿主代理)、Codex(`workspace-write`默认无网络) | 多数引擎无原生网络策略，需外部代理/防火墙规则兜底 | extension | `allowed_domains[]`、`denied_domains[]` | 是（网关/宿主代理层统一实现，与引擎无关） |

### 1.4 工具与资产注入 `tool.* / asset.*`

| 能力 ID | 一句话定义 | 具备的引擎（机制/字段） | 差异点 | 归类 | 典型配置参数 | polyfill |
|---|---|---|---|---|---|---|
| `tool.mcp_inject` | 客户端向引擎声明可用 MCP server 列表（工具扩展的协议级通道） | 几乎全部：Claude Code(`--mcp-config`)、opencode(`mcp.<name>`)、Codex(`[mcp_servers.<id>]`)、ACP(`session/new.mcpServers[]`，stdio/http两类，**SSE已弃用**)、dsh(仅client) | 字段名高度同构（command/args/env/url/headers），是统一资产层最现实的落点（G03结论） | core | `{name, transport: stdio\|http, command\|url, args, env, enabled}` | 否（是唯一协议级可移植资产，无需 polyfill） |
| `tool.mcp_expose` | 引擎反向把自身暴露为 MCP server，供其他引擎/系统调用 | Hermes(`hermes mcp serve`)、Auggie(反向暴露)、OpenClaw(隐含经 Gateway) | 用于"以引擎为工具"的编排模式，非主流需求 | extension | — | 否 |
| `tool.allowlist` | 工具名白/黑名单裁剪模型可见工具面 | 全部：Claude Code(`--allowedTools/--disallowedTools`)、Hermes(`agent.disabled_toolsets`)、pi(`--tools/--exclude-tools/--no-builtin-tools`) | Claude Code 裸工具名 deny 会把工具**从模型上下文移除**（而非仅拒绝调用），这个副作用差异易踩坑 | core | `allowed_tools[]`、`disallowed_tools[]` | 部分（网关可在自己的工具路由层再拦一道，但"从上下文移除"这类深层效果无法伪造） |
| `tool.custom_register` | 注册自定义工具/函数（进程内回调，无需子进程 MCP） | Claude SDK(`createSdkMcpServer`)、pi(`registerTool`扩展API)、Codex(`dynamicTools`客户端工具回调) | 仅 SDK/进程内嵌路径可用，子进程型接入面（CLI/HTTP）通常只能退化为 MCP | extension | 工具 schema(TypeBox/JSON Schema) | 是（子进程接入面下，网关可统一改用 MCP server 实现同等效果） |
| `tool.hook` | 工具调用前后拦截、改写参数/结果、可阻断 | Claude Code(30+ hook事件,`exit 2`阻断,`updatedInput`改写)、opencode(`tool.execute.before/after`)、pi(`tool_call`事件返回`{block,reason,terminate}`)、dsh(桥接`hooks-claude-code/hooks-codex`) | Claude Code 是唯一有 30+ 精细生命周期事件的引擎；pi 无内建权限，"审批"全靠 hook + 宿主 UI 桥接 | standard | hook 事件名、handler类型(command/http/mcp_tool)、超时 | 部分（网关可在自身工具路由层统一拦截，但拦不到引擎内部未经工具路由的直接文件/shell操作） |
| `asset.skill` | 渐进式披露的技能资产格式（元数据常驻+全文按需+脚本资源按需） | 事实标准：agentskills.io `SKILL.md`（Claude Code/opencode/pi/Hermes/OpenClaw/dsh 均兼容或直接复用，仅 name+description 必填） | 各引擎扫描路径不同（`.claude/skills` / `.opencode/skills` / `.agents/skills` / `~/.hermes/skills`），字段级差异极小 | core | `name`(≤64)、`description`(≤1024)、`allowed-tools`(实验性) | 否（本身就是最可移植资产，只需路径投影） |
| `asset.rules_file` | 项目级自然语言规则/系统提示补充文件 | AGENTS.md 收敛标准(60000+项目，Codex/Gemini/opencode/Goose/Amp原生)；Claude Code(CLAUDE.md，需桥接) | Claude Code 是异类，需为其额外生成/软链 CLAUDE.md；opencode 解析顺序是项目内向上遍历+全局 | core | 文件路径、合并层级(用户<项目<租户) | 部分（网关可为不支持 AGENTS.md 的引擎注入等价 system prompt 片段） |
| `asset.plugin` | 代码化插件（manifest + 生命周期钩子，绑定特定运行时） | Claude Code(`plugin.json`+skills/commands/agents/hooks/`.mcp.json`)、opencode(`.opencode/plugins/*.ts`)、dsh(Cordis bundle patch)、OpenClaw(`package.json`声明`openclaw.compat.pluginApi`) | **不可机械跨引擎编译**，各自绑定代码运行时（JS/TS命令式 vs 声明式JSON vs Cordis重写子系统） | extension | manifest 字段、版本策略(semver/commitSHA/profile) | 否（统一资产模型只能登记元数据，不同引擎分别维护实现文件） |

### 1.5 上下文与记忆 `context.* / memory.*`

| 能力 ID | 一句话定义 | 具备的引擎（机制/字段） | 差异点 | 归类 | 典型配置参数 | polyfill |
|---|---|---|---|---|---|---|
| `context.system_prompt` | 系统提示定制/追加 | 全部：Claude Code(`--system-prompt/--append-system-prompt`)、opencode(`system`字段)、ACP(无直接字段，走cwd文件注入) | — | core | `system_prompt`、`append_mode: replace\|append` | 否 |
| `memory.native_file` | 引擎内置的文件型静态/情景记忆（人写或引擎自写的 Markdown） | Claude Code(CLAUDE.md人写 + Auto Memory `MEMORY.md`自写)、Gemini CLI(`GEMINI.md`分层)、OpenClaw(`USER.md/MEMORY.md/memory/YYYY-MM-DD.md`)、Hermes(`MEMORY.md`2200字符+`USER.md`1375字符冻结快照) | 静态注入（会话开始全量加载）vs 动态检索注入（按需search）是两种根本不同的读取模式；OpenClaw 群聊场景**不自动加载** MEMORY.md 需显式检索 | standard | 文件路径、字符/token上限、作用域(用户<项目<租户) | 是（网关统一记忆服务可完全替代，见下） |
| `memory.auto_extract` | 会话结束后台自动抽取事实型记忆并合并 | Claude Code(Auto Memory，首200行/25KB载入)、Codex(Memories，两阶段：会话结束抽取脱敏→全局锁定合并写diff，EEA/UK/瑞士被屏蔽) | 触发时机与合并策略不透明，属于"引擎黑盒"，网关不易审计 | extension | 开关(`autoMemoryEnabled`/`memories.use_memories`) | 部分（网关可用独立的 ACE式 Reflector/Curator 服务替代，读取轨迹做后处理，效果可审计） |
| `memory.external_provider` | 引擎绑定外部专业记忆服务（向量/知识图谱/双层注入） | Hermes+Honcho(base layer+dialectic双层注入)、OpenClaw(可替换context engine：builtin/Honcho/LanceDB)、Letta(MemFS git版本化+sleep-time巩固) | 深度集成度不同：Hermes 是官方一等公民，多数引擎（opencode/pi/dsh）仅有社区插件或完全无 | extension | provider类型、`recallMode`、`sessionStrategy` | 部分（网关可作为独立记忆层直接接管，但失去引擎内已深度集成的双层注入等专有优化） |
| `memory.tool_protocol` | 客户端实现的记忆工具协议（纯 tool_use/tool_result，服务端不存储） | Claude 官方 memory tool(beta,六命令：view/create/str_replace/insert/delete/rename，全部限定`/memories`前缀) | 因为是纯 tool_use 消息，天然被 message 轨迹协议完整记录，可观测性优于黑盒文件读写 | standard | 前缀路径、路径穿越防护规则 | 是（网关可对所有引擎统一实现该六命令 handler，作为**统一记忆层的推荐落点**） |

### 1.6 多 Agent 协作 `team.* / a2a.*`

| 能力 ID | 一句话定义 | 具备的引擎（机制/字段） | 差异点 | 归类 | 典型配置参数 | polyfill |
|---|---|---|---|---|---|---|
| `team.subagent_delegate` | 单向任务委派：子会话独立执行，结果摘要回传父会话（L1，业界最常见） | 几乎全部：Claude Code(Task工具/subagents)、opencode(`task`工具,`parentID`子会话)、Hermes(`delegate_task` goal/context/max_iterations/role)、Codex(`spawn_agent`族)、Gemini CLI(Subagents，工具隔离)、Goose(Subagents≤10并行) | 委派方向、并发上限、是否可 resume、工具隔离字段名均不同，需要标准化探测清单（见 T29） | core | `allowed_tools`(归一名)、`max_concurrent_agents`、`max_spawn_depth`、`max_iterations` | 是（网关可用"新建子会话+轮询完成+摘要回填"通用模式，对无原生委派的引擎也可实现） |
| `team.peer_mailbox` | 对等团队协作：多 agent 共享任务看板 + 相互邮箱通信（L2） | **仅 Claude Code 实验性**(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`，mailbox为JSON文件`~/.claude/teams/{team}/inboxes/{agent}.json`)、Cline(`--team-name`共享看板+agent间邮箱+mission log) | Claude Code Agent Teams **仅交互式 session 可用，`-p`/SDK 下退化为普通子代理**；split-pane 模式不支持 Windows Terminal，与赛题 Windows 评测环境直接冲突 | experimental | `team_mode`、`teammate_model` | 是（网关可托管一个引擎无关的 polyfill：成员表+发布订阅消息总线+共享任务板，见 T29 设计启示） |
| `team.room_broadcast` | 群组式多方广播协作，多个 agent 与人类共处一个会话空间（L3） | 无引擎原生提供；纯应用框架层（AutoGen/CAMEL/MetaGPT GroupChat 风格） | — | experimental（无原生实现，纯网关能力） | `room_id`、成员表、终止条件 | 是（这是设计上就该由网关托管的能力，"native"永远是 ✗，polyfill 永远是"是"） |
| `team.a2a_remote` | 跨进程/跨组织的 agent 间发现与任务委派协议 | Gemini CLI(`RemoteAgentInvocation`,RFC阶段)、MAF/ADK/AgentScope(A2A客户端)、AgentScope Runtime(A2A暴露) | 与 ACP 是完全不同的两个协议，极易混淆（见第3节）；候选引擎中大多数仅是"被网关当客户端接入"，鲜有原生 A2A server | extension | AgentCard URL、`contextId` | 部分（网关可代理充当 A2A client，但跨组织身份/信任模型需另建） |
| `team.concurrency_limit` | 子代理/并行任务的并发数量上限 | Claude Code Workflow(16并发/1000agent/run)、Goose(≤10并行worker)、Hermes(`delegation.max_concurrent_children`默认3)、OpenClaw(`subagents.maxConcurrent`默认4) | 数值差异大（3–1000），需按引擎实际能力设置节点配置默认值上限，防止超出引擎侧限制报错 | standard | `max_concurrent` | 否（是引擎侧硬限制，网关只能遵守+提前校验） |

### 1.7 动态编排与自动化 `workflow.* / schedule.*`

| 能力 ID | 一句话定义 | 具备的引擎（机制/字段） | 差异点 | 归类 | 典型配置参数 | polyfill |
|---|---|---|---|---|---|---|
| `workflow.dynamic_script` | 模型自己编写编排脚本（`agent()/parallel()/pipeline()`等原语），运行时动态决定流程 | **仅 Claude Code**（Workflow工具，`-p`/SDK可用，`ultracode`=xhigh effort，16并发/1000agent/run上限）、dsh(`workflow`/`ralph`worker thread) | Claude Code 是目前唯一把"动态工作流"做成一等 CLI/SDK 能力（非仅交互式）的引擎；`ultracode` 关键字触发**只认人类输入**，网关/SDK 侧必须走 Workflow 工具而非关键字 | extension | `Workflow(<name>)`权限规则、`workflowSizeGuideline`、`resumeFromRunId`、`isolation:worktree` | 是（网关可用独立的"LLM 元编排层"实现同等效果，见 T18，不依赖任何单一引擎，反而更通用） |
| `workflow.recipe_asset` | 声明式工作流资产（YAML：指令+参数+扩展+响应schema+子工作流） | Goose(Recipe：`instructions/prompt(Jinja)/parameters/extensions/response.json_schema/sub_recipes`) | 与 `workflow.dynamic_script` 的关键区别：Recipe 是**声明式预写**资产而非运行时模型现编脚本，更适合可复用的固定流程 | extension | Recipe 文件路径、`params` | 是（网关可用自己的工作流引擎解释同构 YAML，投影到任意引擎的多轮prompt序列） |
| `workflow.goal_loop` | 目标驱动的自治循环，带完成条件评估，直到达成目标或超预算才停止 | Claude Code(`/goal`，`CLAUDE_CODE_GOAL_CHECKIN_MINUTES`) | 完成判定不能信任 agent 自述（MAST研究：推理-行动不一致+错误验证合计>20%），`/goal` 评估器也只看 transcript | extension | `goal_condition`、`checkin_interval` | 是（更推荐由网关实现：独立小模型+环境状态检查，天然跨引擎，见 T18 风险提示） |
| `schedule.cron` | 定时触发会话/任务 | Hermes(`cronjob`工具,60s tick调度器,支持`continuity`带记忆的cron)、Cline(`cline schedule create --cron`)、Claude Code(仅云端 Routines，本地无原生) | Hermes 的 cron 可携带记忆上下文（`context_from`），是差异化亮点 | extension | cron表达式、`deliver`目标、`continuity` | 是（建议默认由网关自建统一调度器，不依赖各引擎自身 cron 实现，一致性更好） |
| `schedule.webhook_trigger` | 外部事件（webhook）触发新会话/追加消息 | Hermes(outbound webhooks,HMAC签名)、dsh(`ctx.jobs`webhook触发新session) | — | extension | webhook URL、签名密钥、事件过滤 | 是（网关本身即是入站事件的统一入口，天然具备） |

### 1.8 自进化 `evolution.*`

| 能力 ID | 一句话定义 | 具备的引擎（机制/字段） | 差异点 | 归类 | 典型配置参数 | polyfill |
|---|---|---|---|---|---|---|
| `evolution.skill_autogen` | Agent 在运行中自主创建/修补自己的技能资产 | Hermes(`skill_manage`：create/patch/edit/delete，可配`skills.write_approval`门禁到暂存区)、OpenClaw(`skill_workshop`四段治理：propose→inspect→evaluate→apply) | 安全风险已验证真实存在：Snyk ToxicSkills 研究显示 ClawHub 上 36.82% 技能有安全缺陷，91% 恶意技能用 prompt injection | extension | `write_approval: bool`、治理流程开关 | 否（这是引擎特有的运行时自改能力，网关只能选择"是否允许"，不能替代实现；但应统一收口审批门禁，不完全信任引擎自带审批） |
| `evolution.memory_consolidate` | 后台巩固记忆（离线整理/去重/摘要，非单轮内产物） | OpenClaw(Dreaming后台进程,阈值化巩固)、Letta(sleep-time agent,独立git worktree巩固) | 不在单轮 message 轨迹内发生，需要新增 `memory.consolidated` 类事件类型才能被观测到 | extension | 巩固触发阈值、执行窗口 | 部分（网关可用独立后台任务读取历史做同等巩固，但难以复现引擎专有的巩固算法） |
| `evolution.workflow_learn` | 从历史执行轨迹归纳可复用的 workflow（研究阶段技术，AWM式） | 无候选引擎原生实现，仅学术原型(AWM/ACE/GEPA) | — | experimental | — | 是（若要落地，只能是网关外挂的独立离线 pipeline，与任何具体引擎无关） |

### 1.9 可观测 `observability.*`

| 能力 ID | 一句话定义 | 具备的引擎（机制/字段） | 差异点 | 归类 | 典型配置参数 | polyfill |
|---|---|---|---|---|---|---|
| `observability.event_stream` | 引擎原生的生命周期/工具/用量事件流（非OTLP，走引擎自身协议） | 全部：Claude Code(stream-json)、opencode(SSE 93种事件)、Codex(`item.*`/`turn.*`)、pi(`--rpc` JSONL 36种type)、Hermes(SSE+webhook)、dsh(`SessionEvent`) | 事件粒度差异大：dsh 的 turn/step 事件溯源模型比 opencode 的 message/part 更严格（有完备性运行时断言），不能假设所有引擎事件粒度一致 | core | 事件类型清单、`session_id`字段名、`usage`字段名 | 否（是每个引擎必须提供的基础能力，网关只做归一化映射不做生成） |
| `observability.otel_native` | 原生支持导出 OTLP（logs/metrics/traces 三信号） | Claude Code(`claude_code.*`指标+events+beta traces)、Codex(`[otel]`logs+traces,**无cost信号**)、Gemini CLI(三信号齐全,**logPrompts默认true**需注意隐私)、OpenClaw(插件`diagnostics-otel`)、dsh(内置但**默认发厂商端点**需显式关闭) | opencode/pi/Hermes **无原生 OTel**，需社区插件或网关自建适配器 | standard | exporter端点、采样率、内容脱敏级别(L0–L3) | 是（网关适配器解析事件流生成 `gen_ai.*` span是标准做法，OTLP 直通作为辅助补充，见T14设计启示） |
| `observability.trace_propagation` | 支持接收/透传 W3C `traceparent`，让引擎内部 span 挂到同一条网关 trace 上 | Claude Code(`-p`/SDK读取入站TRACEPARENT，需`CLAUDE_CODE_PROPAGATE_TRACEPARENT=1`才向自定义代理透传)、ACP(`_meta.traceparent/tracestate/baggage`保留字段)、OpenClaw(WS帧携带traceparent) | 多数引擎（Codex/Gemini/dsh/Hermes）不读入站trace，只能用 `OTEL_RESOURCE_ATTRIBUTES`间接关联 | extension | trace_id注入方式 | 部分（不支持的引擎，网关用 resource attribute + Collector 端 span link 做弱关联） |
| `observability.cost_usage` | token 用量与成本统计 | 全部有 token 计数；成本(`cost`)字段：Claude Code(`total_cost_usd`)、pi(`usage.cost`)、opencode(`Session.cost`)；Codex/Gemini **无原生cost字段** | 分类命名不统一（cacheRead/cacheCreation vs cached/reasoning vs thought/cache/tool），需归一到 `gen_ai.usage.*` | core | token分类字段映射表 | 是（缺失成本的引擎，网关按价目表补算并标注 `cost.source=gateway`） |

### 1.10 模型接入 `model.*`

| 能力 ID | 一句话定义 | 具备的引擎（机制/字段） | 差异点 | 归类 | 典型配置参数 | polyfill |
|---|---|---|---|---|---|---|
| `model.custom_endpoint` | 支持指向自定义 OpenAI/Anthropic 兼容端点（满足"内部部署模型"硬约束） | 协议可配置型（易接）：opencode/pi/dsh/Kimi CLI/Codex(`[model_providers.<id>]`)/Goose(`OPENAI_HOST`)/Qwen Code(`OPENAI_BASE_URL`)；硬编码单一协议型（难接）：**Claude Code**(仅Anthropic Messages,官方明确不支持路由到非Claude模型)、**Codex**(2026-02起仅Responses协议) | 这是选型阶段的关键分野：硬编码协议引擎需要外挂 LiteLLM/claude-code-router 类转换代理，且转换代理有已知坑（流式tool_calls拼接损坏、cache_control语义丢失） | core | `base_url`、`api_key`(建议`$ENV_VAR`间接引用)、`wire_protocol` | 部分（硬编码协议引擎必须经转换代理，网关无法直接 polyfill 协议本身） |
| `model.runtime_switch` | 单次调用/单条消息级别切换模型或 provider | opencode(`message`级`model`字段)、Hermes(每请求覆写`model/provider`)、ACP(`session/set_config_option`) | Claude Code SDK 支持 `model/fallbackModel` 但主要是启动时/会话级而非逐消息 | standard | `model_id`、`provider_id` | 部分（网关可在会话边界重启新引擎会话切换模型，但同会话内热切换依赖引擎原生支持） |
| `model.fallback_chain` | 多模型故障转移链 | OpenClaw(`model{primary,fallbacks}`)、Hermes(`backup provider`链+独立`auxiliary model`路由)、Claude Code(SDK`fallbackModel`) | — | standard | `primary`、`fallbacks[]`、触发条件(超时/限流/拒绝) | 是（网关可在自己的模型代理层统一实现故障转移，与引擎是否原生支持无关，也更可控） |

### 1.11 协议与能力协商 `protocol.*`

| 能力 ID | 一句话定义 | 具备的引擎（机制/字段） | 差异点 | 归类 | 典型配置参数 | polyfill |
|---|---|---|---|---|---|---|
| `protocol.acp_server` | 引擎原生实现 ACP Agent 端（可被标准 ACP Client 驱动） | 原生：Gemini CLI(`--experimental-acp`)、opencode(`opencode acp`)、Goose(`goose acp`/`goose serve`)、Kilo(`kilo acp`)、dsh(`--profile acp`)、Kimi CLI(`kimi acp`)、Copilot(`copilot --acp`)；适配器：Claude(`claude-agent-acp`)、Codex(`codex-acp`)、pi(社区`svkozak/pi-acp`) | ACP 已是≈40个harness共同实现的事实标准协议（T12核心结论），"一个ACP Client可零改动接入所有原生ACP引擎"；但各引擎对可选能力位（`loadSession`/`list`/`terminal`）支持参差 | core（作为引擎适配层基线协议） | `protocolVersion`、`agentCapabilities`声明 | 否（协议实现本身不可polyfill，但可为非ACP引擎写"引擎→ACP Agent"适配器，把差异封装在适配器内） |
| `protocol.capability_negotiation` | 启动/连接时的能力清单握手协商 | MCP(`initialize`双向capabilities)、ACP(`initialize`→`agentCapabilities._meta`)、Hermes(`GET /v1/capabilities`返回`features{}`)、dsh(`--dump-config`+`initialize`) | 静态一次性协商（MCP/ACP/Hermes）vs LSP式运行时动态注册/注销是两种不同范式；对"网关↔本地长连接引擎"场景，一次性握手已足够 | core | 能力位清单schema | 是（这正是网关自身要实现的能力，只是形式各异，需统一 Capability Manifest 格式，见T23建议） |

### 1.12 群/身份路由（群助手场景特有）`route.*`

| 能力 ID | 一句话定义 | 具备的引擎（机制/字段） | 差异点 | 归类 | 典型配置参数 | polyfill |
|---|---|---|---|---|---|---|
| `route.business_key_mapping` | 业务实体（群/用户/话题）到引擎会话的稳定映射 | OpenClaw(`sessionKey`字符串语法`agent:<id>:<channel>:group:<gid>`)、Hermes(`gateway_routing`表,`X-Hermes-Session-Key`与`X-Hermes-Session-Id`**两个ID分离**) | Hermes"两个ID分离"（transcript句柄 vs 长期记忆scope）的设计值得作为统一会话协议字段范式；Claude Tag 不暴露key但语义等价 | core（网关侧必须实现，不依赖引擎） | `route_key`（稳定）→`engine_session_id`（易变） | 是（这本质就是网关职责，所有引擎都需要网关在其上包一层） |
| `route.scope_policy` | 群会话共享粒度：整群共享 / 群内按人隔离 / 按话题隔离 | OpenClaw(`groupScope:per-group\|main`，**默认整群共享**)、Hermes(`group_sessions_per_user`默认True，**默认群内按人隔离**) | 二者语义**相反**——同样是"群聊"，默认策略完全不同，网关必须显式配置而非假设某一方默认值通用 | core（网关侧统一实现） | `session_scope: group\|group_sender\|group_topic\|group_topic_sender` | 是 |
| `route.mention_gating` | 群聊中是否需要 @ 才触发响应 | OpenClaw(`requireMention`+`groupPolicy`)、Hermes(`observe_unmentioned_group_messages`) | "观察不触发"（把未被@的消息计入上下文但不回复）是常见但易漏的第三态，不只是二元开关 | standard | `mention_policy: mention\|always\|observe` | 是 |

---

## 2. 能力 × 引擎支持矩阵

符号：**✓** 原生具备　**~** 部分/需特定模式或版本　**P** 网关可 polyfill（引擎不具备时的补救）　**✗** 不具备且难以polyfill

引擎列选取 9 个代表性候选（按 T01–T09/T11/G05 覆盖度最高）：CC=Claude Code，OC=opencode，Cx=Codex CLI，Gm=Gemini CLI/Qwen Code系，Hm=Hermes，dsh=DeepSeek Harness，OCw=OpenClaw，pi=pi-agent，Gs=Goose。

| 能力 | CC | OC | Cx | Gm | Hm | dsh | OCw | pi | Gs |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `session.create` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `session.resume` | ✓ | ~ | ✓ | ~ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `session.fork` | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✓ |
| `session.list` | ✗ | ✓ | ~ | ✗ | ✓ | ✓ | ✓ | ~ | ~ |
| `session.reset_policy` | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ |
| `session.compact` | ~ | ✓ | ~ | ~ | ✓ | ✓ | ✓ | ✓ | ✗ |
| `session.directory_isolation` | ✓ | ✓ | ✓ | ~ | ~ | ✓ | ✓ | ✓ | ~ |
| `turn.prompt_async` | ✗ | ✓ | ✗ | ✗ | ~ | ✗ | ✓ | ✗ | ✗ |
| `turn.cancel` | ✓ | ✓ | ✓ | ~ | ✓ | ~ | ✓ | ✓ | ~ |
| `turn.steer` | ✗ | ~ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ |
| `turn.queue_mode` | P | P | P | P | ✓ | P | ✓ | ~ | P |
| `turn.structured_output` | ✓ | ✓ | ~ | ~ | ~ | ✗ | ✗ | ✗ | ~ |
| `permission.mode` | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | ✓ | ✗ | ✓ |
| `permission.rule` | ✓ | ✓ | ~ | ✓ | ~ | ✓ | ✓ | ~ | ✗ |
| `permission.request_callback` | ✓ | ✓ | ✓ | ~ | ✓ | ~ | ✓ | ~ | ~ |
| `permission.review_llm` | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ |
| `sandbox.os_isolation` | ~ | ✗ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ |
| `tool.mcp_inject` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ | ✓ |
| `tool.hook` | ✓ | ✓ | ✓ | ~ | ✓ | ✓ | ✓ | ✓ | ✗ |
| `asset.skill` | ✓ | ✓ | ~ | ✗ | ✓ | ~ | ✓ | ✓ | ✗ |
| `asset.rules_file` | ~ | ✓ | ✓ | ✓ | ~ | ✓ | ~ | ✓ | ✓ |
| `memory.native_file` | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ~ |
| `memory.auto_extract` | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `memory.external_provider` | ✗ | ✗ | ✗ | ✗ | ✓ | ~ | ✓ | ~ | ✗ |
| `team.subagent_delegate` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ~ | ✓ |
| `team.peer_mailbox` | ~(实验/仅交互) | ✗ | ✗ | ✗ | ✗ | ~(实验) | ✗ | ✗ | ✗ |
| `team.a2a_remote` | ✗ | ✗ | ✗ | ~(RFC) | ✓ | ✗ | ✗ | ✗ | ✗ |
| `workflow.dynamic_script` | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ |
| `workflow.recipe_asset` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| `schedule.cron` | ✗(云端Routines) | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ~ |
| `evolution.skill_autogen` | ✗ | ✗ | ✗ | ✗ | ✓ | ~ | ✓ | ✗ | ✗ |
| `observability.otel_native` | ✓ | ✗ | ✓ | ✓ | ✗ | ✓(默认外发) | ✓(插件) | ✗ | ✓ |
| `observability.cost_usage` | ✓ | ✓ | ✗ | ✗ | ~ | ~ | ✓ | ✓ | ~ |
| `model.custom_endpoint` | ~(仅Anthropic协议) | ✓ | ~(仅Responses协议) | ~(整体重定向) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `protocol.acp_server` | ~(第三方适配器) | ✓ | ~(第三方适配器) | ✓ | ~(受限toolset) | ✓ | ✓(server+client双向) | ~(社区适配器) | ✓ |
| `route.business_key_mapping` | ✗(需网关自建) | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ |

> 说明：`team.peer_mailbox`/`team.room_broadcast`/`workflow.goal_loop`/`schedule.webhook_trigger` 等 experimental 能力因原生支持面过窄（≤1家）未列入矩阵，其网关侧结论统一是"能力位 native=✗，polyfill=是"，已在第1节各表标注，此处不再重复占用矩阵行。

---

## 3. 易混淆/语义冲突点与统一术语建议

| 冲突点 | 各引擎/协议的真实含义差异 | 统一术语建议 |
|---|---|---|
| **session vs thread vs conversation vs run** | Claude Code/opencode/dsh 用 "session"；Codex/Cursor 用 "thread"（Codex `thread`一次只处理一个`turn`）；A2A 用 "task"（`contextId`才近似session）；Symphony 用 `thread_id-turn_id` 复合键；Cursor 区分 "agent"（持久元数据）与 "run"（一次执行）两级。**"session" 本身在 opencode 里还可能指向存储层的 `session/message/<sid>/part/<mid>/` 三层文件树而非一次对话**。 | 网关统一使用三层模型（借鉴 T06 UHP 与 T18 结论）：**`route_key`**（业务侧稳定标识，如群ID）→ **`engine_session`**（引擎侧会话句柄，等价于对方的session/thread/context_id，易变）→ **`turn`**（会话内一次请求-响应，等价于run/turn/task）。文档中一律用 `session` 指代网关自己的会话对象，遇到引擎原生"thread"一律在字段名上写 `engine_session_ref` 避免混叠。 |
| **mode 的三种完全不同含义** | (a) **审批/权限模式**：Claude Code `default/plan/bypassPermissions`；(b) **Agent 行为模式（plan/act/ask）**：ACP `session/set_mode`、opencode `agent: build/plan`；(c) **模型/推理强度**：`reasoning_effort`/`thinking_level`/`effort`。三者常被简称为"mode"混用。 | 拆成三个独立命名空间：`permission.mode`（权限档位）、`agent.behavior_mode`（plan/act/ask等行为预设）、`model.reasoning_level`（推理强度）。任何"设置 mode"的 API 都必须带命名空间前缀，禁止裸 `mode` 字段。 |
| **subagent vs team vs room vs delegate 的耦合强度** | 绝大多数引擎的"多agent"其实只是 **L1 单向委派**（子会话执行→摘要回传，无回程通信）；仅 Claude Code Agent Teams 是 **L2 对等团队**（mailbox+共享看板，且仅交互式）；**L3 Room/GroupChat 无任何引擎原生提供**，全部是应用框架层（AutoGen/CAMEL）或网关托管。三者常被笼统称为"支持multi-agent"造成误判。 | 不用单一布尔值"是否支持多agent"，而按耦合强度分三档能力位：`team.subagent_delegate`(L1)/`team.peer_mailbox`(L2)/`team.room_broadcast`(L3)，并在能力协商时标注 `implementation: native \| gateway_polyfill`（借鉴T29结论）。 |
| **skill vs plugin vs extension vs tool 的资产层级** | "skill"在 agentskills.io 语境下特指**渐进式披露的纯文本+脚本资产**（无需代码沙箱即可分发）；"plugin"在 Claude Code/opencode/dsh 语境下特指**代码化、绑定运行时的可执行单元**；"extension"在 pi/Gemini CLI 语境下可能同时包含二者（pi 的 Extension 是TS代码，Gemini CLI 的 Extension 是`gemini-extension.json`+MCP声明，更接近轻量plugin）；MCP 语境下的"tool"专指单个函数调用，与前三者不在同一抽象层。 | 四层清晰分离：`asset.skill`(纯文本+脚本，可移植)、`asset.plugin`(代码化，绑定运行时，仅登记元数据不跨引擎编译)、`tool.mcp_inject`(协议级函数调用，最强可移植)、`tool.custom_register`(进程内代码回调，不可跨引擎)。禁止用"extension"作为正式能力ID前缀（保留给具体引擎的原生叫法）。 |
| **memory vs context vs compaction 的边界** | "记忆"在 Claude Code 语境指跨会话持久文件（Auto Memory）；在 Mem0/Zep/Honcho 语境指向量/图谱检索服务；在 pi 语境**根本不存在**（官方"intentionally absent"，只有会话内 compaction 摘要）；"compaction"本身有的引擎是"覆盖式重写历史"（多数）有的是"追加式保留 retainedTail"（pi），语义不可互换。 | 按 T20 四类记忆模型统一：`memory.working`(≈`session.compact`，会话内)、`memory.episodic`(≈`memory.native_file`情景日志)、`memory.semantic`(≈事实型`memory.auto_extract`/CLAUDE.md)、`memory.procedural`(≈`evolution.skill_autogen`产出的技能，多数引擎不成熟)。压缩统一按"是否保留原始行"分为 `compaction.overwrite` 与 `compaction.append` 两种实现方式标注，不假设默认语义。 |
| **permission vs approval vs review 的责任主体** | "permission"通常指静态规则求值结果（allow/deny/ask）；"approval"通常指运行时向人类发起的阻塞请求；"review"特指**LLM作为审批者**（Claude auto分类器/Goose smart_approve/Hermes smart模式），三者常被同一份文档混用同一词。ACP 干脆把三者合并进 `request_permission` 一个方法。 | 明确分层：`permission.rule`(静态规则)→ 命中`ask`时触发 `permission.request_callback`(人工审批,阻塞)→ 引擎可选用 `permission.review_llm`(LLM预审，结果仍需落回 allow/deny)。网关记账时只信任 `request_callback` 的最终结果，`review_llm` 视为引擎内部优化，不单独审计。 |
| **fork vs branch vs clone vs checkpoint vs revert** | pi 的 `/fork` 是"在树上开新分支的同时复制到新文件"，`/clone` 是"复制当前活动分支"，`/tree`是"原地切换分支"（三者细微不同）；Claude Code `--fork-session` 是"新session id，原会话不变"，交互内 `/branch` 是"同进程权限继承"；opencode `session.revert` 是"覆盖式回退到某历史点"（类git revert，非分支）；Gemini CLI checkpoint 是"工具执行前自动存的影子git快照"，与对话历史快照是两个独立机制。 | 拆成三个正交能力：`session.fork`(生成新会话ID，原会话不受影响，"copy-on-branch")、`session.revert`(覆盖当前会话到某历史点，"time-travel"，会丢弃之后的历史)、`workflow.checkpoint`(执行环境/文件系统的快照，与对话历史快照分开管理)。文档中禁止用"branch"这个词（因pi/Claude Code对它定义相反），一律用"fork"表达"生成新分支且原分支不变"。 |

---

## 4. 需在"节点配置"层暴露给编排者的能力参数

以下能力的参数具备"业务/编排层可感知、可能因任务而异"的特征（而非纯引擎内部实现细节），建议在网关的**节点配置 schema**（即每个"引擎+能力配置"节点的可编辑字段）中开放：

1. **`permission.mode` + `permission.rule`**：编排者按任务风险等级选择权限档位是最基本的节点级决策——"只读探索节点"用 `readonly`，"文件写入节点"用 `ask`，"批处理节点"才可能用 `auto`/`bypass`；`allow[]/deny[]` 工具规则集也应作为节点参数暴露（而非写死在引擎适配器里），因为不同办公任务（Word编辑 vs IM发消息 vs 递归删除文件）对危险操作的容忍度完全不同。
2. **`turn.budget`**（`max_turns`/`max_wall_time_s`/`max_tool_calls`/`max_cost_usd`）：不同复杂度的任务节点需要不同预算上限，是编排层做"先小切片试跑"策略的直接抓手，也是防止单节点失控吃满评测时长的硬闸门。
3. **`session.directory_isolation`**（`directory`/`cwd`/`additionalDirectories`）：每个节点对应哪个工作目录、是否允许访问额外目录，直接决定任务间文件隔离边界，必须逐节点显式配置，不能用引擎默认值。
4. **`session.reset_policy`/`turn.queue_mode`**：群助手场景下，编排者需要按业务实体（群/话题）配置重置策略与排队策略（steer/followup/collect/interrupt），这是产品行为选择而非技术细节。
5. **`model.custom_endpoint` + `model.runtime_switch` + `model.fallback_chain`**：模型/端点选择、故障转移链是编排层的核心决策点（尤其在"主模型限定为内部部署模型"的硬约束下），需要按节点甚至按任务类型可覆盖默认路由。
6. **`team.subagent_delegate` 的 `max_concurrent_agents`/`max_spawn_depth`/`allowed_tools`**：子代理委派节点必须让编排者控制委派深度与工具面，防止递归委派失控或子代理越权。
7. **`asset.skill`/`tool.mcp_inject` 的清单**：每个节点应可声明加载哪些技能、挂载哪些 MCP server（而非全局固定），实现"节点=引擎+能力配置"的组合式编排（T17设计启示）。
8. **`turn.structured_output` 的 `schema`**：需要客观校验的节点（如"必须输出JSON格式的分析结果"）应能逐节点声明输出 schema，用于编排层做程序化校验而非仅依赖LLM-as-Judge。
9. **`observability.cost_usage` 的预算类参数与 `sandbox.*` 的隔离级别**：编排者需要在节点粒度设定"这个任务允许多贵""这个任务需要多强隔离"（如递归删除文件类高风险节点应强制 `sandbox.os_isolation` 优先于普通对话节点）。
10. **`workflow.goal_loop`/`schedule.cron` 的触发条件与超时**：若编排层采用目标驱动或定时驱动的节点，完成判定条件、超时阈值、check-in 间隔必须暴露为可编辑参数，因为这些强依赖具体业务语义，无法有引擎通用默认值。

> 与之相对，**不建议**暴露到节点配置层的：`protocol.acp_server`/`protocol.capability_negotiation` 等纯协议握手细节（应完全由适配器内部处理）、`asset.plugin` 的具体代码实现（应作为部署期资产而非运行期参数）、`evolution.*` 系列（自进化能力风险高，建议默认关闭且不作为常规编排旋钮，仅作为独立的运维/治理开关）。
