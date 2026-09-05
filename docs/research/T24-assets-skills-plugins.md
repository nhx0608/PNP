# T24 AI 资产模型：skills/plugins/rules/prompts/MCP 在各引擎中的格式与可移植性

## 摘要
各主流 Agent 引擎的 AI 资产可归纳为三层：上下文/规则文件（AGENTS.md 已成为跨工具收敛标准，60,000+ 项目采用；Claude Code 仍以 CLAUDE.md 为原生格式,需桥接）、Skill（agentskills.io 定义的 SKILL.md + frontmatter + progressive disclosure 已是事实标准，Claude Code/Codex/Hermes/OpenClaw 均直接或事实兼容）、Plugin/Extension（代码化、含 MCP/hooks/agents 等运行时能力，各引擎 manifest 格式各异：Claude Code `.claude-plugin/plugin.json`+目录约定、Gemini CLI `gemini-extension.json`、Codex `.codex-plugin/plugin.json`、OpenClaw `package.json`+`openclaw.compat.*`、dsh 的 npm 包+`dsh.bundle` patch）。MCP 是唯一具备协议级可移植性的资产类型，是资产编译器的"一等公民"；Skill 与规则文件次之，可通过路径投影+字段裁剪跨引擎编译；代码化 Plugin/hooks 因绑定宿主运行时几乎不可移植，需按引擎单独维护并在统一资产模型中仅登记元数据。建议统一资产模型采用"类型(rule/skill/mcp/plugin)+版本(支持semver/commitSHA/profile三态)+作用域(org/tenant/group/user)+依赖+来源市场"的 schema，资产编译器对 rule/skill/mcp 做自动投影，对 plugin 类资产做"选择性接入+能力損耗标注"。

## 关键事实（表格：事实 | 来源 | 置信度 | 是否交叉验证）

| 事实 | 来源 | 置信度 | 交叉验证 |
|---|---|---|---|
| Claude Code Skill 目录结构为 `skill-name/SKILL.md`(必需)+可选 `scripts/`、`references/`、`assets/`，遵循 agentskills.io 规范 | https://agentskills.io/specification | 高 | 是（与 code.claude.com/docs/en/plugins 中 SKILL.md 用法一致）|
| SKILL.md frontmatter 必需字段 `name`(≤64字符,小写字母数字连字符)、`description`(≤1024字符)；可选 `license`、`compatibility`、`metadata`、`allowed-tools`(实验性) | https://agentskills.io/specification | 高 | 否 |
| Progressive disclosure 三层：metadata(~100 tokens 常驻)→ SKILL.md 全文(激活时加载,建议<5000 tokens/<500行)→ scripts/references/assets(按需加载) | https://agentskills.io/specification | 高 | 否 |
| Claude Code Plugin 结构：`.claude-plugin/plugin.json`(仅放manifest) + 插件根目录下的 `skills/`、`commands/`、`agents/`、`hooks/hooks.json`、`.mcp.json`、`.lsp.json`、`monitors/monitors.json`、`bin/`、`settings.json` | https://code.claude.com/docs/en/plugins | 高 | 是（与 agentskills.io 关于 SKILL.md 位置说明一致）|
| plugin.json 字段：name(命名空间前缀,如 `/my-first-plugin:hello`)、description、version(可选,决定更新策略)、author(可选) | https://code.claude.com/docs/en/plugins | 高 | 否 |
| Claude Code 官方维护两个 marketplace：`claude-plugins-official`(策展)和 `claude-community`(社区提交,经审核后 pin 到 commit SHA，存于 anthropics/claude-plugins-community 仓库的 marketplace.json) | https://code.claude.com/docs/en/plugins | 高 | 否 |
| AGENTS.md 是标准 Markdown、无强制字段的"面向 agent 的 README"，已被 60,000+ 开源项目采用，支持工具含 Codex、Gemini CLI、Cursor、opencode、goose、Amp、RooCode、Windsurf 等；嵌套文件时"最近的 AGENTS.md 优先级最高" | https://agents.md/ | 高 | 是（与 opencode/gemini-cli 官方文档对 AGENTS.md 的引用互相印证，见后文）|
| opencode Agent 用 Markdown+YAML frontmatter 定义，字段含 description(必需)、mode(primary/subagent/all)、model、temperature、permission(read/edit/bash/glob/grep/list/webfetch/websearch/lsp/skill/task，各自 allow/ask/deny)、prompt；存放于 `~/.config/opencode/agents/` 或项目 `.opencode/agents/`，文件名即 agent id | https://opencode.ai/docs/agents/ | 高 | 否 |
| opencode MCP 配置在 `opencode.json`(schema `https://opencode.ai/config.json`)的 `mcp` 键下，区分 `type:"local"`(command数组+环境变量) 与 `type:"remote"`(url)，可用 `enabled` 开关 | 搜索结果 open-code.ai/en/docs/mcp-servers, /docs/config | 中 | 否（未直接抓取原文，来自WebSearch摘要）|

| opencode Rules 解析顺序：项目内向上遍历的 `AGENTS.md`/`CLAUDE.md` → 全局 `~/.config/opencode/AGENTS.md` → `~/.claude/CLAUDE.md`(可关闭)；并支持在 opencode.json 中自定义指令文件列表（含 `.cursor/rules/*.md` 与远程 URL） | https://opencode.ai/docs/rules/（WebSearch摘要） | 中 | 否 |
| Gemini CLI Extension = 目录+`gemini-extension.json`(name/version/mcpServers/contextFileName)，加载自 `~/.gemini/extensions`；命令通过 `commands/` 下 TOML 文件提供；若无 contextFileName 则默认加载扩展目录下的 GEMINI.md | https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md（WebSearch摘要） | 高 | 否 |
| pi(pi.dev, earendil-works) 用 npm/git 包("packages")分发 Extensions(TypeScript)、Skills(能力包=指令+工具,按需加载保持prompt cache热)、Prompt Templates(Markdown,`/name`展开)、Themes；`pi install npm:@foo/pi-tools` | https://github.com/earendil-works/pi, https://pi.dev/ | 中 | 否 |
| Hermes Agent 的 Skills Hub 截至2026-08-26索引90,700个技能，来自11个registry，通过 `/skills` 或CLI安装；号称与 Claude Code、Cursor、Codex 等"开放标准"兼容(即复用 SKILL.md 格式)；其上下文分三层：stable(身份SOUL.md+工具指南+skills索引)/context(读取cwd下AGENTS.md/CLAUDE.md/.cursorrules,并做prompt-injection扫描)/volatile(记忆快照+用户画像) | https://hermesatlas.com/ecosystem/, https://arize.com/blog/how-hermes-implements-open-source-agent-harness-architecture/ | 中 | 否（数字来自二手站点，未抓取一手repo）|
| OpenClaw 区分 Skill(纯 SKILL.md+脚本，无代码，加载进prompt) 与 Plugin(含代码/凭证/生命周期钩子/manifest，可扩展 tools/channels/model providers/hooks 等运行时能力)；Plugin 的 package.json 需含 `openclaw.compat.pluginApi`、`openclaw.build.openclawVersion`；ClawHub 是官方注册中心，支持 code plugin/bundle plugin/整机 "Claw" 包 | https://github.com/openclaw/clawhub, https://docs.openclaw.ai/tools, https://docs.openclaw.ai/clawhub | 中 | 否 |
| DeepSeek Harness(dsh) 架构基于 Cordis 运行时，"一切皆插件"：models/tools/skills/sessions/sandboxes/storage/loops/scheduling/UI 均可作为插件替换组合；分发单元为 npm 包 "bundle"(manifest 字段 `dsh.bundle`,是配置层补丁，向 plugin 表插入/覆盖行)，用户以 `dsh --profile <name>` 启动某个 profile | https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish, https://springbrand.ai/deepseek-harness | 中 | 否 |
| Codex CLI 的 Plugin 系统把此前分散的 `config.toml` MCP 条目+散落SKILL.md+手动App配置整合为单一可发现单元，manifest 在 `.codex-plugin/plugin.json`；Skill 定义在文档中被强调为"不是函数调用/传统插件钩子，而是注入上下文/流程/参考资料的结构化文档"；AGENTS.md 提供仓库约定；hooks 事件含 PreToolUse/PostToolUse/SessionStart/SubagentStart/SubagentStop/UserPromptSubmit/Stop/PermissionRequest/PreCompact/PostCompact(部分来自第三方框架 Oh My codeX 而非官方内置) | https://developers.openai.com/codex/skills, https://codex.danielvaughan.com/2026/03/30/codex-cli-plugin-system/ | 中 | 否（Codex官方文档`developers.openai.com/codex`未直接WebFetch核对，来自WebSearch摘要，需二次确认）|
| Dotprompt(google/dotprompt, Firebase Genkit)：`.prompt` 文件=YAML frontmatter(模型/参数/输入输出schema)+Handlebars模板正文，语言/模型无关，被设计为"prompt即代码"可版本控制 | https://github.com/google/dotprompt, https://firebase.google.com/docs/genkit/dotprompt | 高 | 否 |
| AGENTS.md 与 Cursor `.cursor/rules/*.mdc`(YAML frontmatter+glob+alwaysApply) 尚未完全收敛：Claude Code 原生只读 CLAUDE.md(可用 `@AGENTS.md` 导入或 symlink 桥接)，Cursor 读 AGENTS.md 和自己的 .mdc 规则但不读 CLAUDE.md；AGENTS.md 由 Agentic AI Foundation(Linux Foundation旗下)托管，作为跨工具基线 | 搜索结果(techsy.io, thepromptshelf.dev 等,二手来源) | 低-中 | 否 |

## 架构与工作原理

各引擎围绕"资产"(assets)的组织方式高度收敛于三层模型：**(a) 上下文/规则文件**（项目级自然语言约定，AGENTS.md/CLAUDE.md/.cursorrules/GEMINI.md/SOUL.md 等，随会话启动即注入 system prompt 或首轮 context）；**(b) 技能(Skills)**（SKILL.md + 可选 scripts/references/assets，"渐进式披露"——名称与描述常驻、正文按需加载、脚本资源按需拉取，模型自主决定何时激活）；**(c) 插件/扩展(Plugins/Extensions)**（可携带代码、MCP server 声明、hooks、subagent 定义、命令、权限设置等"运行时能力"，通常有独立 manifest 文件和版本化分发渠道/市场）。

agentskills.io 的 SKILL.md 规范本身是"引擎无关"的最小公分母：只规定 frontmatter(name/description必需)与目录约定，不规定如何加载、谁来解释 allowed-tools。这使其成为除 Claude Code 外，Codex、Hermes、OpenClaw 等纷纷"复用"的事实标准（各家在此基础上叠加自己的插件/权限层）。Claude Code 的 Plugin 是"容器"，Skill 是其中一种可被容纳的资产类型（也可独立于插件以 `~/.claude/skills/` 或项目 `.claude/skills/` 存在）；plugin.json 只声明 name/description/version/author 等元数据，真正的能力靠插件根目录下的 `skills/`、`commands/`(旧式扁平 Markdown 命令)、`agents/`(subagent 定义)、`hooks/hooks.json`、`.mcp.json`、`.lsp.json`、`monitors/monitors.json`、`bin/`(注入 PATH 的可执行文件)、`settings.json`(可指定默认激活的 agent)等目录/文件按约定位置放置——这是一种"目录即协议"的隐式 schema，而非单一 JSON 描述全部行为。

opencode 走的是相似路线但命名不同：agents(YAML frontmatter 定义的 primary/subagent)、命令、plugins(直接是 JS/TS 文件，钩入事件——比 Claude Code 的 hooks.json 更"代码化"、更接近可编程 runtime 扩展)、skills(与 agentskills.io 同构的 SKILL.md)，配置汇总于单一 `opencode.json`（含 `mcp` 键、`instructions` 自定义规则文件列表等），呈现"一个总配置文件+若干目录扫描"的混合模式。

Gemini CLI 的 Extension 更接近"包"：一个 `gemini-extension.json` 描述 name/version/mcpServers/contextFileName，配合 `commands/*.toml` 提供斜杠命令，`GEMINI.md` 提供上下文——概念上对齐 Claude Code Plugin，但 manifest 单文件承担更多（尤其 mcpServers 直接内嵌于 manifest，而非独立 `.mcp.json`）。

pi 和 dsh 则代表"包管理器化"的极端：pi 用 npm/git 包分发 Extension+Skill+Prompt Template+Theme 的组合（`pi install npm:@foo/pi-tools`），dsh 用 Cordis 插件运行时把几乎所有子系统（模型、工具、技能、会话、沙箱、存储、循环、调度、UI）都建模为插件，分发单元是携带补丁式 manifest(`dsh.bundle`)的 npm 包，用户通过 `--profile` 选择一组插件组合启动——这种设计对我们"资产编译器"的意义是：某些引擎的"资产"边界已经模糊到与"引擎自身的模块化架构"合一，不再是外挂式的可迁移文件。

OpenClaw 明确做了 Skill(纯声明式指令，无代码，SKILL.md)与 Plugin(含代码/凭证/生命周期，需要 `openclaw.compat.pluginApi` 兼容声明)的二分，并配 ClawHub 作为统一注册中心（同时支持 code plugin、bundle plugin、以及打包整个 agent 人设的 "Claw" 包）——这与 Claude Code marketplace 的定位接近，但把"技能"和"插件"从生态治理角度显式区隔，值得我们的统一资产模型借鉴（即"纯声明式/可迁移资产" vs "引擎绑定/需要认证的运行时扩展"两类）。

## 可编程接入面
各引擎的资产装载均发生在**会话/进程启动阶段**（扫描约定目录、解析 manifest、注入 system prompt 片段），而非通过网关运行时 API 直接推送——这意味着 Agent 网关若要"统一管理资产"，主要接入点是：(1) 部署期把编译好的资产文件放置到目标引擎的约定路径下（如 `.claude/skills/`、`~/.config/opencode/skills/`、`~/.gemini/extensions/`），(2) 通过引擎自身 CLI/manifest 声明 MCP server 列表（因为 MCP 是运行时可被所有主流引擎当作"外部工具"挂载的通用协议，具备最强的可移植性），(3) 部分引擎支持命令行动态加载（如 Claude Code `--plugin-dir`/`--plugin-url`、opencode 项目级 `.opencode/` 目录热扫描）可用于网关按业务/租户动态注入资产而不用改镜像。SKILL.md 内容本身在提示词层面注入，故"资产热更新"本质是"改文件+重启/reload会话"，赛题约束的"不要求热切换、分轮次启动不同引擎"与此天然契合。

## 会话模型
不适用本专题主体（会话模型细节由其他专题——网关API/session映射——覆盖）；仅需注明：SKILL.md/Skill 的加载与激活是**会话内**行为（模型按需决定加载哪个技能），而 Plugin/Extension 的加载是**会话/进程启动前**行为，这一"启动期 vs 运行期"的资产生命周期差异是网关设计"何时注入资产"的关键分界点。

## 权限与安全
- SKILL.md 的 `allowed-tools` 字段（实验性）用空格分隔的工具白名单（如 `Bash(git:*) Bash(jq:*) Read`），是 skill 级细粒度权限声明，但各引擎对该字段的执行力不同（agentskills.io 明确"实验性，各实现支持程度不同"）。
- Claude Code Plugin 的 hooks（PreToolUse/PostToolUse 等）可用于在工具调用前后做审计/拦截，是插件资产携带"安全策略代码"的主要位置。
- opencode agent 的 `permission` 字段对 read/edit/bash/glob/grep/list/webfetch/websearch/lsp/skill/task 等能力逐项设 allow/ask/deny，支持 glob 模式，比 Claude Code 的 allowed-tools 更结构化、更贴近网关期望的"权限矩阵"形态，值得统一资产模型的权限 schema 直接参考。
- OpenClaw Plugin 需要在 package.json 声明 `openclaw.compat.pluginApi` 版本兼容性——这是"引擎能力协商/版本握手"的一个具体先例：插件安装时校验声明的 API 版本与宿主引擎版本是否兼容，可作为我们"能力识别→适配→认证"标准流程中"适配"阶段的参考实现。
- Claude Code 社区市场插件经过审核后被 pin 到具体 commit SHA 分发（`anthropics/claude-plugins-community` 的 `marketplace.json`），这是一种"资产签名/供应链锁定"的雏形，但并非密码学签名，只是 commit 哈希锁版本。

## 扩展机制与资产
（见"架构与工作原理"一节的详细展开，此处补充资产类型汇总表）

| 引擎 | 上下文/规则文件 | Skill | 插件/扩展 manifest | MCP 配置位置 | Prompt/命令模板 |
|---|---|---|---|---|---|
| Claude Code | CLAUDE.md（可 `@AGENTS.md` 导入） | `SKILL.md`（agentskills.io规范）,置于 `.claude/skills/` 或插件 `skills/` | `.claude-plugin/plugin.json` | 插件根 `.mcp.json`；也可在 settings.json 声明 | `commands/`(扁平.md,`$ARGUMENTS`占位符) |
| opencode | AGENTS.md/CLAUDE.md（向上遍历+全局兜底，可自定义指令文件列表） | 同构 SKILL.md，多路径优先级扫描 | agents 为 Markdown+YAML frontmatter；plugins 为 JS/TS 文件 | `opencode.json` 的 `mcp` 键(local/remote两类) | 未见独立 prompt 模板格式，命令即 agent/skill |
| Gemini CLI | GEMINI.md 或 extension 自定义 `contextFileName` | 未见原生 SKILL.md 支持(以 extension+commands 为主) | `gemini-extension.json`(name/version/mcpServers/contextFileName) | 内嵌于 `gemini-extension.json` 的 `mcpServers` | `commands/*.toml` |
| pi | 未见独立命名规则文件(依赖 Extension/Skill) | Skill=指令+工具的能力包，按需加载 | npm/git 包("packages")+ pi 自身 Extension(TypeScript) | 未明确抓取，推测随 Extension/MCP 工具注册 | Prompt Templates(Markdown, `/name` 展开) |
| Hermes | 读取 cwd 下 AGENTS.md/CLAUDE.md/.cursorrules（context tier） | 复用/兼容 SKILL.md，经 Skills Hub 安装(`/skills`) | 未细化(依赖 Skills Hub 分发) | 未抓取一手资料 | 未抓取一手资料 |
| OpenClaw | 未明确(推测类似 AGENTS.md 生态) | `SKILL.md`+脚本，经 ClawHub 分发 | code plugin 的 `package.json`(`openclaw.compat.*`) | 未抓取一手资料(推测 plugin 可声明 MCP) | 未抓取一手资料 |
| dsh | 未明确 | 作为 Cordis 插件之一等价存在 | npm 包 + manifest 字段 `dsh.bundle`(patch式)；用户以 `--profile` 组合 | 未抓取一手资料(社区列表提及"MCP servers"为可插入能力之一) | 未抓取一手资料 |
| Codex CLI | AGENTS.md | Skill=结构化指令文档，非函数调用 | `.codex-plugin/plugin.json`，整合 skills+MCP+App 集成 | 原先散落于 `config.toml` 的 MCP 条目，现被插件系统整合 | 未细化 |

## 记忆
本专题一手资料未直接覆盖各引擎的"记忆(memory)"资产格式（属于 T-记忆 专题范围）。仅记录与资产模型相关的旁证：Hermes 的 volatile context tier 显式包含"记忆快照(memory snapshots)、用户画像、外部记忆提供方(external memory-provider)区块"，说明 Hermes 把记忆当作运行时注入的上下文层，而非像 Skill 那样是可版本化分发的静态资产；这提示我们的统一资产模型应把"记忆"与"技能/规则/插件"分开建模（记忆是动态状态，其余多为静态可移植制品）。

## 多 Agent 与协作
不适用本专题主体（多 agent/team 编排属于其他专题）；仅记录：Claude Code 的 subagent 定义（`agents/` 目录）本身是一种可被 Plugin 携带的资产类型，`settings.json` 的 `agent` 字段可以让插件"接管"主线程人格/工具限制/模型选择，这是"资产驱动的 agent team 配置"的一个具体机制，可与 T-agent-team 专题联动。

## 可观测性
不适用本专题主体；仅提示：Claude Code 的 `/reload-plugins` 会重新加载 plugins/skills/agents/hooks/MCP servers/LSP servers，并在调试日志中记录"哪些 hook 匹配、退出码、输出"，这是资产变更后的一种可观测反馈，可作为网关侧"资产投影是否生效"的验证钩子参考。

## 对我们架构的启示（公共能力 vs 扩展能力映射表、接入参数、风险与坑）

**公共能力（可被统一资产模型直接建模、几乎所有引擎都有对应物）**：
1. **Skill**（agentskills.io SKILL.md 已是事实标准，Claude Code/Codex/Hermes/OpenClaw 均直接或事实上兼容其 frontmatter+progressive disclosure 语义）——统一资产模型应以 SKILL.md 为"标准形态"，编译器对其它引擎只需做路径投影+frontmatter字段裁剪（如去掉不支持的 `allowed-tools`）。
2. **规则/上下文文件**（AGENTS.md 已成为跨工具收敛点，60,000+ 项目采用，Codex/Gemini CLI/opencode/Cursor/goose 等原生或经桥接支持；Claude Code 仅原生识别 CLAUDE.md，需 `@AGENTS.md` 导入或 symlink）——统一资产模型的"规则"资产应以 AGENTS.md 为规范源，编译期为 Claude Code 额外生成/软链 CLAUDE.md，为 Cursor 额外投影 `.cursor/rules/*.mdc`。
3. **MCP Server 声明**——是当前唯一具备"协议级"（非文件约定级）可移植性的资产类型：所有目标引擎都以 MCP client 身份消费外部工具，只是配置容器不同（Claude Code `.mcp.json`、opencode `opencode.json.mcp`、Gemini CLI `gemini-extension.json.mcpServers`）。资产编译器应把 MCP server 定义作为"一等公民"，统一 schema（name/command|url/args/env/type local|remote），编译期投影到各引擎自己的容器字段。
4. **命令/Prompt 模板**（Claude Code `commands/*.md`+`$ARGUMENTS`、Gemini CLI `commands/*.toml`、pi Prompt Templates `/name`）——语义相近（"斜杠命令=参数化 prompt 片段"），但文件格式（Markdown vs TOML）不同，编译器需做格式转换，且部分引擎的插值语法不同（`$ARGUMENTS` vs 各家自定义占位符），存在轻微语义损耗风险。

**扩展能力（引擎特有，无法简单归一化，需要"逃生舱"或标注为不可移植）**：
1. **代码化插件/hooks**（Claude Code `hooks.json`(声明式JSON+shell命令)、opencode `plugins/*.ts`(命令式JS/TS，直接钩事件)、dsh 的 Cordis 插件(几乎重写引擎子系统)、OpenClaw code plugin(需 `openclaw.compat.pluginApi` 版本声明)）——这类资产直接依赖宿主运行时/语言/SDK，不可能做通用编译，只能"选择性接入"：统一资产模型对其只登记元数据（能力描述、所需引擎、版本要求），实际实现文件按引擎分别维护，网关部署时按目标引擎选择性拷贝。
2. **Plugin manifest 结构本身**（`.claude-plugin/plugin.json` vs `.codex-plugin/plugin.json` vs `gemini-extension.json` vs dsh `dsh.bundle` patch）——字段语义相近(name/version/author/描述)但结构、目录约定、版本管理策略(pin到commit SHA vs semver vs profile组合)都不同，无法字段级机械映射，编译器需要"每引擎一个 profile 生成器"而非通用模板引擎。
3. **权限模型细粒度**（opencode 的 read/edit/bash/glob/grep/webfetch/websearch/lsp/skill/task 十项 allow/ask/deny 矩阵 vs Claude Code 的 `allowed-tools` 空格分隔白名单(实验性)）——统一资产模型的权限 schema 应以 opencode 的"能力项×allow/ask/deny"矩阵为超集设计（信息量更大，向下兼容裁剪为白名单更容易，反向升维困难），编译到 Claude Code 时把 allow 项拼成 `allowed-tools` 字符串，deny/ask 项则退化为不表达（记录为"能力损耗"）。
4. **Marketplace/分发与信任链**（Claude Code 官方双市场+commit SHA pin、ClawHub 的三类包(code/bundle/整机Claw)、Hermes Skills Hub 11个registry聚合90,700个技能）——分发生态互不兼容，不建议在比赛范围内实现跨引擎市场同步，只需在统一资产模型里给每个资产打上"来源市场+来源版本号"的溯源字段，供审计使用。

**接入参数建议**（新引擎接入"能力识别→适配→认证"流程的资产维度检查清单）：
- 是否支持 agentskills.io 兼容的 SKILL.md？扫描路径是什么？是否支持 progressive disclosure（即是否会在未激活时只读 frontmatter）？
- 是否原生读取 AGENTS.md？是否需要软链/环境变量桥接（如 opencode 的"读取 `~/.claude/CLAUDE.md` 除非禁用"体现的向后兼容策略）？
- MCP 配置字段名与位置（独立文件 vs 内嵌 manifest vs 单一总配置文件的子键）？是否区分 local(command+args+env)/remote(url)？
- 插件/扩展是否需要代码沙箱（JS/TS 直接执行 vs 纯声明式 JSON/YAML）？涉及的信任边界（是否需要签名/版本兼容声明如 OpenClaw 的 `pluginApi`）？
- 权限字段的粒度与语义（工具级白名单 vs 能力项矩阵），网关下发权限限制时如何精确映射到该引擎的字段。

**风险与坑**：
- "同名不同义"陷阱：几乎所有引擎都用"Skill"一词，但 Claude Code 的 skill 可被 `disable-model-invocation: true` 变成纯手动命令，OpenClaw 明确 Skill 与 Plugin 二分，pi 的 Skill 含"工具"而非纯指令——资产编译器不能假设"skill"语义在各引擎间完全对等，必须做能力探测（是否允许携带工具/脚本执行）。
- 目录扫描优先级差异会导致同名文件被"意外覆盖"：如 opencode 的 rules 解析顺序（项目内向上遍历→全局→Claude Code 遗留文件），若网关同时管理多个引擎共享同一工作目录，需显式控制文件优先级，避免跨引擎资产互相"渗透"。
- 版本管理策略不一致：Claude Code 插件"若不设 version 字段则退化到下一优先级来源"，社区市场经审核后 pin commit SHA；dsh 用 profile 组合而非语义化版本；这意味着统一资产模型的"版本"字段需要能同时表达 semver、commit SHA、profile 名三种形态，编译器需按引擎目标格式转换或降级。
- MCP 虽是通用协议，但"type: local vs remote"、认证方式（env var vs OAuth）在各引擎实现程度不同，实际接入验证时应逐引擎做最小化联通测试，不能只凭 schema 相似就假设互通。

## 未解决问题
- Hermes Agent、OpenClaw、DeepSeek Harness 的官方一手文档（非二手博客/GitHub搜索摘要）未直接抓取核实，其 Skill/Plugin manifest 的**确切字段名与 JSON schema**仍需后续以 raw.githubusercontent.com 或 deepwiki.com 方式深入源码验证（本次工具调用预算内未覆盖）。
- Codex CLI 官方文档 `developers.openai.com/codex/skills` 与 `.codex-plugin/plugin.json` 的确切字段未直接 WebFetch 核对，仅来自 WebSearch 摘要（含第三方博客 codex.danielvaughan.com），存在过时或不准确风险，需二次验证。
- pi 的 MCP 配置位置、Extension manifest 的具体 JSON 字段未抓取到一手 README 全文，需要进一步查阅 `github.com/earendil-works/pi/tree/main/packages/coding-agent`。
- dsh 的 Skill 资产格式（是否兼容 SKILL.md）与 MCP 集成方式的一手确认（仅二手 awesome 列表提及"MCP servers"作为可插件化能力之一，未见 dsh 官方 skill 文件格式规范）。
- Windows 环境下各引擎资产目录（如 `~/.config/opencode/`、`~/.gemini/`、`~/.claude/`）的实际路径映射（`%USERPROFILE%` 等）未在本专题验证，需在部署自动化脚本中单独核实。

## 来源列表
- https://agentskills.io/specification
- https://agents.md/
- https://code.claude.com/docs/en/plugins
- https://opencode.ai/docs/agents/
- https://opencode.ai/docs/rules/ （经 WebSearch 摘要引用，未逐字WebFetch）
- https://open-code.ai/en/docs/mcp-servers, https://open-code.ai/en/docs/config （经 WebSearch 摘要引用）
- https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md （经 WebSearch 摘要引用）
- https://github.com/earendil-works/pi, https://pi.dev/, https://github.com/MinhDuyDEV/pi-harness
- https://hermesatlas.com/ecosystem/, https://arize.com/blog/how-hermes-implements-open-source-agent-harness-architecture/, https://www.agent37.com/blog/hermes-skills-hub
- https://github.com/openclaw/clawhub, https://docs.openclaw.ai/tools, https://docs.openclaw.ai/clawhub
- https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish, https://springbrand.ai/deepseek-harness, https://github.com/Dominic789654/awesome-deepseek-harness
- https://developers.openai.com/codex/skills, https://codex.danielvaughan.com/2026/03/30/codex-cli-plugin-system/, https://github.com/openai/codex/discussions/16329
- https://github.com/google/dotprompt, https://firebase.google.com/docs/genkit/dotprompt
- techsy.io/en/blog/cursor-rules-vs-claude-md, thepromptshelf.dev/blog/cursorrules-vs-claude-md （Cursor rules vs AGENTS.md 收敛趋势，二手来源）
