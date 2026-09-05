# G03 Office 文件处理、Windows GUI 自动化与网页检索能力的注入方式

## 摘要
Office 文件处理在业界收敛为两条技术路径：(1) 纯脚本/库路径——python-docx/openpyxl/python-pptx 读改 + LibreOffice headless 转换/校验，代表实现是 Anthropic 官方 `anthropics/skills` 仓库的 docx/xlsx/pptx SKILL.md（一手确认路径为 `skills/<name>/SKILL.md`，license 为 Proprietary），OpenCode 已原生支持扫描并加载该格式的 SKILL.md（`.claude/skills`、`.opencode/skills`、`.agents/skills` 等多路径），是目前唯一被公开证实"原生消费 SKILL.md"的第三方引擎；(2) 原生 Office COM/GUI 路径，依赖真机 Office 授权，未发现权威 MCP 实现，风险较高，不建议作为默认方案。Windows GUI 自动化收敛到 UI Automation(UIA) 协议之上，Windows-MCP（`uvx windows-mcp serve`）是目前功能最完整、被引用最多的开源 MCP 实现，但要求活动图形会话，无法在无头容器里跑；Goose 有官方内置 Computer Controller 扩展做跨平台封装。企业 IM（飞书/钉钉/企业微信）自动化在赛题这类无企业身份的评测环境下，应默认走 GUI 自动化而非官方 API/CLI。网页检索方面，各引擎"内置"搜索工具（Gemini google_web_search、Claude WebSearch、OpenCode webfetch）普遍绑定各自云端后端服务，在赛题"主模型限定为内部部署模型"的硬约束下大概率失效或行为不明，必须以通用 MCP 搜索/抓取 server 作为统一兜底。架构启示：MCP server 配置在 OpenCode/Claude Code/Gemini CLI 之间字段高度同构（command/args/env + 差异化的 type/enabled），SKILL.md 目录结构也已有事实标准（`.agents/skills`），二者共同构成"统一资产层一次定义、多引擎投影"的现实基础。

## 关键事实

| 事实 | 来源 | 置信度 | 是否交叉验证 |
|---|---|---|---|

| anthropics/skills 仓库路径为 `skills/docx/SKILL.md`（非 document-skills/），docx skill 用 docx-js(npm, 预装) 创建新文档、unzip+编辑 word/document.xml 编辑已有文档、pandoc 读取内容，用 `scripts/office/soffice.py --headless --convert-to pdf` 调用 LibreOffice 校验渲染 | https://raw.githubusercontent.com/anthropics/skills/main/skills/docx/SKILL.md（一手抓取） | 高 | 是（WebSearch+直接raw fetch 交叉确认路径） |
| SKILL.md 采用 YAML frontmatter（name/description/license）+ Markdown 正文，`license: Proprietary`（docx skill 非 MIT，是 "source-available"） | 同上 raw fetch | 高 | 否 |
| Office-Word-MCP-Server（GongRzhe）等一批基于 python-docx/openpyxl 的独立 MCP server 存在且可通过 uvx/Python 启动，走标准 MCP stdio | https://github.com/GongRzhe/Office-Word-MCP-Server ; https://github.com/haris-musa/excel-mcp-server | 高 | 否（未逐个源码验证，仅WebSearch摘要） |
| Windows-MCP（CursorTouch）：`uvx windows-mcp serve` 启动，基于 Windows UIAutomation 库（非纯视觉/OCR），提供 Click/Type/Scroll/Screenshot/Snapshot(UI树)/PowerShell/Registry/文件操作等工具；需要图形环境（无法在无头/纯CLI容器运行），要求 Python 3.13+、UV、Windows 语言English | https://github.com/CursorTouch/Windows-MCP （WebFetch摘要） | 中 | 否 |
| OpenCode 官方支持原生 Skill 系统：沿工作目录向上查找并加载 `.opencode/skills/*/SKILL.md`、`.claude/skills/*/SKILL.md`、`.agents/skills/*/SKILL.md`，以及全局 `~/.config/opencode/skills`、`~/.claude/skills`、`~/.agents/skills`；通过内置 skill 工具按需加载全文 | https://opencode.ai/docs/skills/ | 高 | 否 |
| OpenCode MCP 配置字段：`mcp.<name>.type`("local"/"remote")、`command`、`args`、`env`、`enabled`；`permission` 字段可对 `webfetch` 等内置工具设 allow/ask/deny，默认全部 allow | https://opencode.ai/docs/config/ （WebFetch摘要） | 中 | 否 |
| WindowsAgentArena（微软/CMU）：154 个跨应用真实 Windows 任务（含 Office 文档/表格编辑、浏览器、文件资源管理器等），用确定性 Python evaluator 检查最终状态返回二值成功/失败；基于 Azure 并行化把全量评测从数天缩到约 20 分钟，可在 Docker+Azure VM 中部署 | https://github.com/microsoft/WindowsAgentArena ; https://microsoft.github.io/WindowsAgentArena//static/files/windows_agent_arena.pdf | 高 | 是（GitHub README + 论文PDF 摘要交叉） |
| Goose 内置 Computer Controller 扩展：封装跨平台自动化 API（keyboard/mouse/window management/web scraping/文档处理），macOS 上依赖 Peekaboo CLI；作为 built-in extension 在设置里开关即可 | https://block.github.io/goose/docs/tutorials/computer-controller-mcp/ | 中 | 否 |
| Gemini CLI 内置 `google_web_search` 工具，默认开启、依赖 Google Search grounding（后端调用 Google 搜索并返回带引用摘要），无需额外配置 —— 但这依赖 Gemini 官方 API/grounding 通道，若网关按题目要求把 Gemini CLI 接到"内部模型的 OpenAI/Anthropic 兼容端点"，该 grounding 功能大概率随原生模型后端一起失效，需要外置 MCP 搜索工具替代 | https://geminicli.com/docs/tools/web-search/ | 中 | 否（未实测替换端点后行为） |
| 飞书/钉钉/企业微信在 2025-2026 均已开源官方 CLI（飞书 CLI 覆盖 200+ 命令/2500+ Raw API 且含 24 个 Agent Skills；钉钉 Workspace CLI `dws`；企业微信 CLI），把 OpenAPI 包装为可被 Agent 直接调用的命令行接口，是 GUI 自动化之外发消息的替代路径，但前提是目标机器安装并完成企业身份鉴权 | 中文技术媒体聚合报道（cnblogs/知乎/ai-bot.cn），非官方一手仓库 | 低 | 否（未直接访问对应 GitHub 仓库确认） |
| Hermes Agent（NousResearch）通过 "Tool Gateway" 提供 web_search(Firecrawl)、`computer_use`、`x_search`、`vision_analyze` 等工具，走统一网关+订阅路由，而非各引擎各自直连搜索 API | https://github.com/nousresearch/hermes-agent 等（WebSearch摘要，未直接读源码） | 低 | 否 |

## 架构与工作原理

**Office 文件处理的两种技术路径：**

1. **脚本/库路径（无需安装 Office）**：docx 用 `python-docx` 读改或 `docx`(npm, docx-js) 从零生成，pptx 用 `python-pptx`，xlsx 用 `openpyxl`，PDF 渲染/转换/校验用 **LibreOffice headless**（`soffice --headless --convert-to`）。这条路径完全 CLI 化、跨平台（含 Windows），是 Anthropic 官方 skills 仓库（`anthropics/skills`）采用的方式：docx skill 明确写"unzip → 编辑 word/document.xml → zip"来编辑已有文件（因为 docx-js 打不开已有文件，只能新建），并用 `pdftoppm` 把渲染结果转成图片供模型"看一眼"校验排版是否正确——这是一个很值得借鉴的"渲染回读校验"闭环模式。
2. **原生 Office COM / UI 自动化路径**：直接驱动本机安装的 Microsoft Word/Excel/PowerPoint（Windows 专属，通过 `pywin32`/`win32com.client` 或第三方 MCP server），优点是所见即所得、公式/宏等原生特性完整，缺点是必须真机装有 Office、速度慢、并发弱、且比赛机器是否预装 Office 存疑。搜索未发现权威的"Microsoft Office COM 自动化 MCP"官方项目，多为社区个人仓库，需要在竞赛沙箱里自行验证可用性和许可（若沙箱无 Office 授权，只能退回脚本库路径）。

由于赛题机器是 Windows 10/11 且 Office 不一定预装/取得授权，**脚本库路径（python-docx/openpyxl/python-pptx + LibreOffice headless 转换校验）是更稳的默认选择**，COM/GUI 路径作为"若探测到本机装有 Office 才启用"的增强分支。

**Windows GUI 自动化 / computer use** 的技术栈可分三层：
- 底层协议：Windows UI Automation (UIA)（`pywinauto`/`uiautomation` Python 库封装）+ 传统 `pyautogui` 式坐标点击/键鼠模拟作为兜底。
- MCP 封装层：Windows-MCP（`uvx windows-mcp serve`，UIA 优先、附带 Screenshot 与"Snapshot"(UI 树 JSON) 两种状态捕获模式，不依赖视觉模型即可让任意 LLM 操作 Windows）、pywinauto-mcp、UIA-X 等，均以 MCP stdio server 形式暴露给引擎。
- Agent 内置扩展：Goose 有官方 Computer Controller 扩展（把平台自动化 API 统一抽象为一套工具，macOS 走 Peekaboo，Windows 走对应的平台 API）；Hermes 通过其"Tool Gateway"暴露 `computer_use` 工具；Claude/Codex/Gemini 官方 CLI 目前没有公开的原生"Windows 桌面 computer-use"内置工具（Claude 的 Computer Use 主要面向沙箱容器里的 Linux/GUI 截图协议，不是 Windows 原生桌面），因此在这几家引擎上大概率要靠外挂 MCP（如 Windows-MCP）补齐。

企业 IM 发消息（企业微信/钉钉/飞书）有两条路径：GUI 自动化（用 UIA 定位桌面客户端的输入框/联系人搜索框，键入内容+回车，通用性最强、不需要任何企业授权，但脆弱、依赖控件层级不变）；官方 API/CLI（三家平台 2025-2026 均推出了把 OpenAPI 包装成 Agent 可调用命令的官方 CLI，功能更强大稳定，但要求应用注册、企业内部权限、token/callback 管理，在"评测沙箱"这种一次性环境里配置门槛高，一般不具备可行性）。**结论**：赛题给定的评测环境大概率没有企业身份，所以"Windows 即时通讯软件发消息"这一测例应默认按 GUI 自动化（UIA 控件树定位 + 键鼠模拟）实现，而不是寄望于官方 API。

## 可编程接入面

- **Anthropic skills**：纯文件系统契约——一个目录 + `SKILL.md`(YAML frontmatter: name/description/license) + 可选 `scripts/`、`references/`，无需任何 SDK；任何引擎只要实现"扫描技能目录 → 把 description 注入 system prompt 供模型按需 `Read` 全文"即可复用，这正是 opencode 已经做的（"native skill tool"）。
- **OpenCode Skill 发现路径**（可直接复用为我们统一资产层的落盘规范）：项目级 `. opencode/skills/*/SKILL.md`、`.claude/skills/*/SKILL.md`、`.agents/skills/*/SKILL.md`；全局 `~/.config/opencode/skills`、`~/.claude/skills`、`~/.agents/skills`。可见 `.claude/skills` 和 `.agents/skills` 已经是事实上的跨引擎共享路径——我们的"统一资产层"可以直接选用 `.agents/skills/*/SKILL.md` 作为规范存放位置，并为不同引擎生成/软链到各自私有路径（`.claude/skills`、`.opencode/skills` 等），实现"一次定义、多引擎投影"。
- **MCP 配置**：OpenCode 用 `opencode.json` 里的 `mcp.<name>` 对象，字段 `type`("local"|"remote")/`command`/`args`/`env`/`enabled`，与 Claude Code 的 `.mcp.json`（`mcpServers.<name>.command/args/env`）、Gemini CLI 的 `settings.json` mcpServers 字段高度同构，说明 **MCP server 配置本身就是一层天然的跨引擎公共能力**：网关侧只需维护一份"MCP server 清单"（Office 处理、Windows GUI 自动化、网页检索等），针对每个引擎做字段名的等价投影（多数引擎字段几乎一致，只有 opencode 多了 `type: local/remote` 这一区分）。
- **网页检索**：Gemini CLI `google_web_search`（内置、依赖 Google 官方 grounding，绑定 Gemini 后端，换成自定义 OpenAI/Anthropic 兼容端点后大概率失效）；OpenCode `webfetch`（内置抓取工具，走 opencode 后端托管的 fetch 服务，配合 `permission.webfetch` 控制）；Claude Code 的 WebSearch/WebFetch 为官方工具，同样绑定 Anthropic 后端服务，不一定能在自定义端点/内网环境下使用；因此**在"主模型限定为内部部署模型"这一硬约束下，各引擎自带的官方联网搜索工具很可能都不可用**（它们依赖各厂商自己的搜索基础设施而非模型本身），必须统一退化到通用 MCP 搜索/抓取 server（如 Tavily/Exa/Brave Search MCP，或自建 fetch+搜索代理），这是网关层要重点适配、抹平各引擎差异的地方。

## 会话模型
不适用：本专题聚焦具体能力（Office/GUI/检索），不涉及各引擎的 session 生命周期设计，session 模型已在其他专题（引擎架构对比）中调研。

## 权限与安全
- Office 编辑技能中已内建风险意识：docx skill 明确要求处理外部 docx 时先 `find unpacked -type l -delete`（删除 zip 内可能夹带的符号链接条目），因为"docx from external parties is untrusted"——这是一个值得写进我们网关"资产层安全基线"的具体规则（防 zip-slip/符号链接逃逸）。
- Windows GUI 自动化天然是"高权限"操作（键鼠模拟可以操作任意窗口，包括非任务目标的窗口），网关层必须对这类工具单独设更严格的 permission gate（例如 opencode 的 `permission.<tool>: ask/deny` 机制可以直接复用），并限定其只能操作白名单进程/窗口标题。
- 网页检索类 MCP（Tavily/Exa/Brave/fetch）需要 API Key，在内网/受限网络评测环境下必须走出口代理或离线镜像；若评测机完全断外网，则只能退化为"本地缓存的资讯快照"或直接判定该类用例不可达，需要在架构里显式声明"网络可达性探测 + 降级策略"。

## 扩展机制与资产
- **公共资产格式**：SKILL.md（技能）+ MCP server 清单（工具）+ AGENTS.md/CLAUDE.md（项目级系统指令）三者组合，已经是 OpenCode、Claude Code 等多个引擎事实上收敛到的"最大公约数"资产格式。我们的"统一资产层"应以此为核心 schema：
  - `assets/skills/<name>/SKILL.md`（+ scripts/references）→ 投影到各引擎的 skills 目录（软链或构建期复制）。
  - `assets/mcp/<name>.json`（统一字段：command/args/env/enabled/transport(stdio|http)）→ 按各引擎配置文件字段名转译后写入其配置（opencode.json/.mcp.json/settings.json）。
  - `assets/instructions/AGENTS.md` → 各引擎项目级系统提示词入口（Claude Code 认 CLAUDE.md，OpenCode/Codex 等社区已趋同支持 AGENTS.md 或可通过软链桥接）。
- Office/GUI/检索这三类能力在这个映射下都表现为"MCP server 或 Skill 脚本"两种形态之一：Office 处理优先做成 **Skill（脚本+库）** 而不是常驻 MCP server（无状态、按需调用、易于所有引擎复用，且不需要额外进程/端口）；Windows GUI 自动化、网页检索更适合做成 **MCP server**（有状态/长连接更合理，如保持一个 UIA session 或 HTTP 客户端连接池）。

**代码执行能力与依赖预装策略（Windows 沙箱）：** 各引擎（OpenCode/Claude Code/Codex/Gemini CLI/Goose）都自带 bash/shell 或专用 exec 工具直接调用宿主机的 python/node，本身不是问题；真正的坑在于 **Windows 评测沙箱里 Python 包（python-docx/openpyxl/python-pptx/pandas 等）与 LibreOffice/pandoc/poppler 等外部二进制是否预装**。由于赛题评测环境是"受控 Windows 环境执行并记录轨迹"的 Rollout，二进制依赖不太可能允许引擎运行时联网 `pip install`（网络受限 + 耗时不确定），因此依赖管理应放在**部署/镜像构建阶段**而非运行时：建议网关的"引擎启动脚本"在拉起任意引擎之前，统一执行一次环境自检 + 预置虚拟环境（如固定路径的 venv，预装 python-docx/openpyxl/python-pptx/pandas/lxml，PATH 中放入便携版 LibreOffice、pandoc、poppler 的 Windows 二进制），所有引擎共享同一份预装依赖而不是各自重复安装，这也是"网关统一资产层"应该覆盖的范畴之一（不仅是 Skill/MCP 清单，还包括"运行时依赖清单"）。

## 记忆
不适用：本专题不涉及各引擎长期记忆机制，记忆模型在专门的记忆专题中调研。

## 多 Agent 与协作
不适用：Office/GUI/检索能力本身是单 agent 工具层面的能力，不涉及 multi-agent 编排；相关内容见其他专题（dynamic workflow/agent team）。

## 可观测性
- Anthropic docx skill 的"生成 → LibreOffice 渲染 PDF → pdftoppm 转图 → 模型回读校验"模式，本质上是一种任务级自检机制，可以映射为我们统一可观测协议里的一种标准 "artifact-verification" 事件（工具执行后自动附带渲染快照，供 LLM-as-Judge 或人工复核），建议网关层为 Office 类工具调用统一记录"产出文件 + 校验快照"两个 artifact，而不仅是工具调用的文本 diff。
- Windows GUI 自动化的可观测性天然依赖"截图/UI树快照"这一形态（Windows-MCP 的 Screenshot/Snapshot 工具），与我们要求的统一 message trace（tool call/tool result）里应把每次 GUI 操作的前后截图作为 tool_result 附件持久化，这对 Rollout+LLM-as-Judge 评测方式尤其重要（评委需要看到操作前后的桌面状态）。

## 对我们架构的启示

**公共能力 vs 扩展能力映射表（本专题范围内）：**

| 能力 | 归一化为公共能力？ | 接入参数/形态 | 备注 |
|---|---|---|---|
| docx/xlsx/pptx 读写 | 是 | Skill（脚本+库），无需 MCP 端口 | 优先脚本库路径（python-docx/openpyxl/python-pptx + LibreOffice headless），Office COM 作为可选增强分支 |
| CSV/Excel 数据分析 | 是 | Skill + 代码执行(Python) | 依赖引擎自带代码执行工具(bash/python)，非 MCP |
| PDF 渲染校验 | 是 | Skill 内嵌脚本调用 LibreOffice+pdftoppm | 需要 Windows 侧预装 LibreOffice 便携版 |
| Windows GUI 自动化(通用) | 是（工具接口层） | MCP server（如 Windows-MCP，`uvx windows-mcp serve`） | 各引擎能力差异在于是否原生支持"图片+UI树混合观测"，需要引擎支持多模态/长上下文 |
| 企业 IM 发消息 | 是（复用 GUI 自动化 MCP） | 同上，附带"窗口标题白名单"配置 | 官方 CLI/API 路径列为引擎特有/环境特有扩展能力，不作为默认 |
| 网页检索/资讯 | 是（工具接口层），但各引擎"内置搜索"不算 | 通用 MCP（Tavily/Exa/Brave/fetch），而非引擎自带 WebSearch | 各厂商内置搜索绑定自家后端，在自定义模型端点约束下大概率失效 |
| 代码执行(Python/Node) | 是 | 引擎自带 bash/exec 工具 + 预装 venv/node_modules | 见下方"代码执行"小节 |

**接入参数示例（供网关适配层参考）：**
- MCP 清单统一字段：`{name, transport: stdio|http, command, args[], env{}, enabled}`，网关按引擎目标配置文件的字段名做一层轻量转译（opencode 多一个 `type: local/remote`，Claude Code `.mcp.json` 无 `enabled`/`type` 字段，直接以 key 存在与否表示启用）。
- Skill 清单统一路径：`.agents/skills/<name>/SKILL.md`，通过软链/复制投影到 `.opencode/skills`、`.claude/skills` 等各引擎实际扫描路径。

**风险与坑：**
1. **Office 授权不确定**：评测机是否预装/取得 Microsoft Office 许可未知，COM 自动化路径不可作为主方案，务必以 python-docx/openpyxl/python-pptx + LibreOffice headless 为默认兜底，并在部署脚本里显式预装 LibreOffice Portable（Windows 版）+ pandoc + poppler(pdftoppm)。
2. **Windows-MCP 等 GUI 自动化 server 要求图形环境**，若评测 Rollout 容器/VM 没有活动桌面会话（例如以服务方式无 GUI 会话运行），UIA 调用会失败——部署时必须确认是"有头"Windows VM 且以交互式用户会话启动 Agent 进程。
3. **各引擎"内置"网页搜索/联网工具普遍绑定各自云端 API**（Gemini google_web_search、Claude WebSearch、OpenCode webfetch 走托管后端），题目要求"主模型限定为内部部署模型"时，这些内置能力的可用性存疑，必须默认准备通用 MCP 搜索工具作为统一替代，并做好断网/内网降级预案。
4. **递归删除文件类任务**是所有引擎都能通过原生 bash/PowerShell 工具完成的最基础能力，风险点在于 Windows 路径分隔符、权限(UAC)、以及"误删安全护栏"——需要网关权限层对危险命令(`rm -rf`/`Remove-Item -Recurse`)加审批门（可复用 opencode 的 permission ask/deny 机制思路）。
5. **SKILL.md 的 license 字段是 Proprietary（非 MIT）**：直接照抄 anthropics/skills 里的 docx/xlsx/pptx skill 内容用于比赛/商用需注意许可条款，建议只借鉴其"方法论"（脚本路径选择表、渲染回读校验）自行重写实现，而非整包套用。

## 未解决问题
- 未能一手核实是否存在官方/权威的 "Microsoft Office COM 自动化 MCP"（搜索未发现有代表性、star 数较高的项目，可能需要自建）。
- 飞书/钉钉/企业微信官方 CLI 的具体安装方式、鉴权流程、在赛题沙箱环境下是否可行，仅有中文媒体二手报道，未直接读取对应 GitHub 仓库 README 确认字段与命令细节。
- Hermes 的 `computer_use`/`x_search` 工具的具体协议形态（是否 MCP、参数 schema）未获得一手源码确认，仅有 WebSearch 摘要级信息。
- Pi、dsh（DeepSeek Harness）在 Office/GUI/检索能力上的具体接入方式本次未检索到公开一手资料（可能是内部/新兴项目，公开文档稀少），需要在其他专题或后续调研中专门核实。
- OpenCode 的 `webfetch` 具体是否可配置为使用自定义搜索/代理端点（而非固定走 opencode 托管后端）未经一手文档确认。
- 未实测 Gemini CLI 切换到自定义 OpenAI/Anthropic 兼容端点后 `google_web_search` 是否真的失效——仅为基于架构原理的合理推测。

## 来源列表
- https://github.com/anthropics/skills （WebFetch 摘要）
- https://raw.githubusercontent.com/anthropics/skills/main/skills/docx/SKILL.md （直接抓取，一手）
- https://github.com/GongRzhe/Office-Word-MCP-Server
- https://github.com/haris-musa/excel-mcp-server （WebSearch 提及）
- https://github.com/CursorTouch/Windows-MCP （WebFetch 摘要）
- https://github.com/sandraschi/pywinauto-mcp
- https://opencode.ai/docs/skills/ （WebSearch 摘要）
- https://opencode.ai/docs/config/ （WebFetch 摘要）
- https://github.com/microsoft/WindowsAgentArena
- https://microsoft.github.io/WindowsAgentArena//static/files/windows_agent_arena.pdf
- https://block.github.io/goose/docs/tutorials/computer-controller-mcp/
- https://geminicli.com/docs/tools/web-search/
- https://github.com/nousresearch/hermes-agent
- 飞书/钉钉/企业微信 CLI 相关中文技术媒体报道（cnblogs.com/itech、zhuanlan.zhihu.com、ai-bot.cn）——二手信息，未直接验证官方仓库
