# G01 候选引擎的 Windows 10/11 原生兼容性与自动化部署

## 摘要

对 11 个候选引擎的 Windows 10/11 原生兼容性做了逐一核实。结论：**Codex CLI** 是唯一把原生 Windows 沙箱当作一等工程目标的引擎（v0.100.0 起 elevated 沙箱转正，四层防御：专用低权限账户+ACL+防火墙+本地策略），接入风险最低；**Cline CLI** 和 **Hermes Agent** 次之——前者发布了原生预编译二进制（免 Node 运行时），后者虽标注"early beta"但工程投入完整（自举 Python/Node/Git、UTF-8 修复、Windows 服务化用计划任务）。**Claude Code** 已有原生安装器和原生 PowerShell 工具（v2.1.84+），但沙箱能力在原生 Windows 上缺失（需 WSL2）。最值得警惕的是 **OpenCode**——尽管赛题网关规范"形态与 opencode 的 server API 高度一致"，但其官方文档明确"strongly recommend"使用 WSL 而非纯原生 Windows，这与赛题"引擎必须能在 Windows 原生运行"的硬约束存在直接冲突，选型前必须做原生 Windows 实测而非只看文档措辞。多数引擎（pi、Kimi CLI、旧版 Claude Code、Hermes）默认 shell 走 Git Bash，办公任务（PowerShell 操作 Office COM 对象）需额外配置 PowerShell 工具。DeepSeek Harness (dsh) 无桌面应用、以浏览器为界面（`dsh web` 默认端口 3080），另提供 `--profile headless` 单次无头模式，但文档自陈处于预览阶段、有跨版本破坏性变更风险。Goose 的 `goosed` 后端提供 REST+SSE HTTP API（~103 endpoints），架构上与"网关+引擎"分层思路较契合。多数第三方 Windows 安装细节（Gemini CLI、Qwen Code、Kimi CLI、Goose）来自 2026 年搜索聚合而非直接抓取的官方一手文档，置信度中等，已在文中逐条标注。

## 关键事实（表格：事实 | 来源 | 置信度 | 是否交叉验证）

| 事实 | 来源 | 置信度 | 交叉验证 |
|---|---|---|---|
| OpenCode 官方文档明确"strongly recommend"在 Windows 上使用 WSL，原生 Windows 虽可运行但被列为次选，文件系统性能/终端支持/工具兼容性均较弱 | opencode.ai/docs/windows-wsl/ | 高（一手文档） | 是（搜索结果与直接抓取一致）[已交叉验证] |
| OpenCode 提供 `opencode serve` 无头服务器，暴露 OpenAPI 3.1 spec（如 `http://localhost:4096/doc`），端口可通过 `--port`/`--hostname` 指定，支持 `OPENCODE_SERVER_PASSWORD` HTTP Basic Auth | opencode.ai/docs/server/, opencode.ai/docs/cli/ | 高 | 否（单一来源） |
| pi coding agent 在 Windows 上默认使用 Git Bash（按自定义路径→Git Bash 标准位置→PATH 查找），并提供可选 PowerShell 工具（pwsh.exe 优先，否则 Windows PowerShell），可通过 `~/.pi/agent/settings.json` 的 `defaultTools`/`shellPath` 配置切换或并存 | github.com/badlogic/pi-mono windows.md（raw 抓取） | 高（一手文档原文） | 否 |
| Hermes Agent 原生 Windows 支持标注为"early beta"，通过 PowerShell 一键安装脚本（`irm .../install.ps1 \| iex`），无需管理员权限，自动配置 uv/Python 3.11/Node 26/PortableGit | hermes-agent.nousresearch.com/docs/user-guide/windows-native | 高 | 是（与 GitHub 搜索片段一致）[已交叉验证] |
| Hermes gateway 在 Windows 上通过 Windows 计划任务（Scheduled Tasks，`ONLOGON` 触发器 + `pythonw.exe` 无控制台后台运行）实现服务化，`hermes gateway install/start/stop/status`；若需系统级 Windows Service 需借助 NSSM | hermes-agent.nousresearch.com/docs/user-guide/windows-native | 高 | 否 |
| DeepSeek Harness (dsh) 无官方桌面应用，Windows 上通过 `npx @deepseek-ai/dsh web`（Node.js ≥22.19，推荐 Node 24 LTS）启动本地服务器（默认端口 3080），并提供 `dsh --profile headless "task"` 单次无头执行模式用于 CI/脚本 | orcarouter.ai/blog/deepseek-harness-windows-tui, deepseekdocs.com | 中（第三方博客转述） | 否 |
| Claude Code 已发布原生 Windows 安装器（无需 WSL），系统要求 Windows 10 1809+ / Windows Server 2019+，原生安装器无需 Node.js；npm 安装方式在 v2.1.198 起要求 Node.js ≥22（仅安装期需要，运行期为原生二进制） | 多篇第三方 2026 指南（nxcode.io, inventivehq.com, pq.hosting 等）+ 搜索聚合 | 中（无 Anthropic 官方一手文档直接抓取，均为第三方转述） | 否 |
| Claude Code v2.1.84（2026-03-26）引入原生 PowerShell 工具，直接 spawn `pwsh.exe`/`powershell.exe`，此前在 Windows 上默认经 Git Bash 路由 shell 命令，存在路径转换问题；OS 级 sandbox（Seatbelt/bubblewrap）在原生 Windows 上不可用，需 WSL2 才能启用沙箱 | 多篇 2026 第三方指南（agentpatterns.ai, claudelab.net 等） | 中 | 否 |
| Codex CLI 的原生 Windows 沙箱（elevated 模式）在 v0.100.0 从实验特性转正，通过专用低权限 Windows 账户（CodexSandboxUsers 组）、文件系统 ACL、Windows 防火墙出站规则、本地策略限制四层防御实现隔离；elevated 模式安装需一次管理员提示 | github.com/openai/codex discussion #6065, developers.openai.com/codex/windows（重定向自 learn.chatgpt.com） | 中高 | 是（两个来源均提及 elevated/unelevated 与"促正式"）[已交叉验证] |
| Gemini CLI 通过 `npm install -g @google/gemini-cli` 安装，要求 Node.js ≥20（部分文档称 Windows 上需 Windows 11 24H2+），支持 `gemini --headless -p "prompt"` 无头脚本模式 | 搜索聚合（geminicli.com, kissapi.ai 等第三方） | 中（无官方一手文档直接抓取） | 否 |
| Goose（Block）桌面应用已支持 Windows；CLI/goosed 后端也可在 Windows 运行，goosed 以 REST+SSE HTTP API（约 103 endpoints）暴露给桌面 App 作为子进程，`goose run` 支持 recipe 驱动的无头执行，`GOOSE_MODE=auto` 可预设自动批准工具调用以实现无人值守 | github.com/aaif-goose/goose, goose-docs.ai/docs/tutorials/headless-goose/, DeepWiki | 中 | 否 |
| Kimi Code CLI（Moonshot）在 Windows 上同样依赖 Git Bash 作为 shell 环境（要求先装 Git for Windows），可通过 `KIMI_SHELL_PATH` 指定自定义 bash.exe 路径；安装脚本为 `irm ... \| iex`（PowerShell one-liner） | 第三方聚合（dev.to, apidog.com） | 中 | 否 |
| Qwen Code（Alibaba/QwenLM）在 Windows 上可通过官方 PowerShell 安装脚本（`irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/.../install-qwen-standalone.ps1 \| iex`）或 `npm i -g @qwen-code/qwen-code` 安装 | github.com/QwenLM/qwen-code, help.aliyun.com | 中 | 否 |
| Cline CLI 已发布 Windows（x64/arm64）原生二进制，通过 `npm i -g cline` 安装但不依赖 Node/Bun/Zig 运行时（optionalDependencies 拉取平台专属预编译二进制），`--json` 或管道 stdin 自动切换到无头模式，适合 cron/CI | github.com/cline/cline apps/cli/README.md（经搜索聚合转述） | 中 | 否 |

## 架构与工作原理

本专题聚焦"能否在 Windows 10/11 上原生跑起来、能否无头启动"，而非各引擎完整架构，故此处仅摘要与 Windows 兼容性相关的运行时形态：

- **OpenCode**：TypeScript/Bun 实现，核心是一个可独立运行的 HTTP 服务器进程（`opencode serve`），TUI/Web/Desktop 都是该服务器的客户端。官方文档态度是"能跑但不建议"原生 Windows，推荐 WSL 承载服务器进程，Windows 侧只跑瘦客户端（Desktop app 或浏览器）连接 WSL 内的服务器。这与本赛题"引擎必须能在 Windows 原生运行"的硬约束存在直接冲突，需要重点评估。
- **pi (earendil-works/pi coding-agent)**：Node.js/TS 实现，核心 Agent Loop 与 TUI 一体，shell 执行是可插拔工具（bash 工具 or powershell 工具），无强制 Linux 依赖，Windows 原生运行路径清晰，只是默认 shell 走 Git Bash。
- **Hermes Agent (NousResearch)**：Python 实现，采用"引导式安装器"模式——自带 uv 管理 Python 环境、可选下载 PortableGit/Node，把整个运行时都装进 `%LOCALAPPDATA%\hermes`，做到不依赖用户预装环境（除 winget 可用性外）。Gateway 组件走 Windows 计划任务实现"开机不登录也能跑"的服务化，是本轮所有引擎中 Windows 服务化方案最完整的一个。
- **DeepSeek Harness (dsh)**："everything is a plugin"架构（基于 Cordis），前端是浏览器 Web UI，`dsh web` 起本地 HTTP 服务器（默认 3080），交互都通过浏览器完成而非原生终端 TUI，这种"浏览器即桌面应用"模式天然对 Windows 终端编码/PTY 问题免疫，但也意味着无浏览器的纯服务器场景需要额外依赖 headless profile。
- **Claude Code**：早期通过 Git Bash 转译层跑在 Windows 上（路径转换问题多），2026 年起有原生安装器 + 原生 PowerShell 工具（v2.1.84 起），沙箱机制（Seatbelt/bubblewrap）仍绑定 macOS/Linux 内核特性，原生 Windows 无沙箧、需退回 WSL2。
- **Codex CLI**：Rust 实现，是本轮唯一在原生 Windows 上做到"操作系统级隔离沙箱"（而非退化到无沙箱或依赖 WSL）的引擎，通过独立低权限账户 + ACL + 防火墙规则的四层防御，已从实验特性转正（v0.100.0）。
- **Gemini CLI**：Node.js/TS 实现，`npm` 全平台安装，Windows 原生运行无特殊转译层报告，`--headless -p` 提供脚本模式。
- **Goose (Block)**：Rust 后端 `goosed` + 各类前端（Desktop/CLI/Web），`goosed` 以 REST+SSE 暴露完整 Agent 能力，是"网关+引擎"分层最贴近本赛题目标架构的开源实现之一；CLI/goosed 均可在 Windows 编译运行，依赖 Python（部分安装路径）。
- **Kimi CLI / Qwen Code / Cline CLI**：均为 Node 生态 CLI，Kimi 沿用 Git Bash 模式（与 pi、旧版 Claude Code 同源思路），Qwen Code 提供独立 PowerShell 安装脚本，Cline CLI 发布了平台原生预编译二进制（不依赖 Node runtime 执行期）。

## 可编程接入面

与本赛题网关规范（POST /session、GET status、prompt_async、SSE /event 等）直接相关的可编程接口：

- **OpenCode**：`opencode serve` 暴露 OpenAPI 3.1 描述的 REST API + SDK（TS/Python/.NET 均有社区绑定，如 `lionfire/opencode-dotnet`），赛题网关规范本身即"与 opencode 的 server API 高度一致"，故 OpenCode 可能是最省适配成本的引擎之一——但前提是它必须能以纯原生 Windows 进程形式跑起来（见下文"启示"）。
- **pi**：主要是 CLI + Node SDK（agent loop 库可编程调用），未见到独立无头 HTTP server 模式的一手证据（本次抓取的 windows.md 未提及），需要后续在 T-协议专题中补充确认其 `pi --mode rpc` 或类似模式是否存在。
- **Hermes**：`hermes gateway run` 提供网关 API，可通过 NSSM 包装为 Windows Service；同时有 CLI/TUI 双模式。
- **DeepSeek Harness**：`dsh web`（浏览器服务器，默认 3080）+ `dsh --profile headless "prompt"`（CI 单次执行）+ Python SDK，尚未确认是否有类似 opencode 的持久 session REST API（需要在协议专题中进一步核实 `--profile acp/sdk` 的具体形态）。
- **Claude Code**：`claude -p "prompt"`（print/headless 模式，单轮，stdout 输出，`--allowedTools` 免交互批准）是主要无头接入面；未在本次检索中确认是否存在类似 opencode 的持久 session HTTP server（如有需在协议专题核实 `claude mcp serve` 等）。
- **Codex CLI**：`codex exec`（单次无头执行）与 `codex app-server`（据条目名推测为持久服务模式，本次未深入抓取其协议细节，留待协议专题）。
- **Gemini CLI**：`gemini --headless -p "prompt"` 单次脚本模式。
- **Goose**：`goosed` REST+SSE HTTP API（~103 endpoints，含 session/recipe 管理），是本轮唯一明确证实"完整无头 HTTP API 服务器 + SSE"的引擎之一，形态上与赛题网关规范目标接近。

## 会话模型

本专题未深入抓取各引擎 session 数据结构一手细节（留给专门的会话模型/协议专题），仅记录与 Windows 部署相关的会话持久化落盘位置：
- Hermes：会话/日志/技能数据落在 `%LOCALAPPDATA%\hermes\`（配置与运行时代码分离，重装不丢会话）。
- DeepSeek Harness：会话日志以压缩格式（zstd）存储，依赖较新 Node 版本读取。
- Goose：`goosed` 使用 SQLite 做会话持久化（第三方转述，未一手核实字段）。

## 权限与安全

- **Codex CLI**：原生 Windows elevated 沙箱是四家中隔离粒度最细的方案（专用账户+ACL+防火墙+本地策略），[已交叉验证]（GitHub Discussion + 官方重定向落地页两个来源均提及"promoted from experimental"）。
- **Claude Code**：Windows 原生无沙箱能力，沙箱（Seatbelt/bubblewrap）仅在 macOS/Linux/WSL2 可用；原生 Windows 下的"安全"依赖 `--allowedTools`/permission mode 等应用层白名单，而非内核级隔离。
- **Hermes**：未见强调进程级沙箱，Windows 原生模式主打"无需管理员即可安装"，安全模型更偏向用户账户权限而非专用沙箱账户；Gateway 服务化默认走用户级计划任务（LIMITED 权限），若要绑定机器启动而非用户登录则需管理员权限装 Windows Service。
- **Goose**：未见到独立沙箱机制的一手证据，权限控制主要靠 `GOOSE_MODE`（auto/approve 等）在应用层控制工具调用是否需要人工确认。
- **OpenCode**：`OPENCODE_SERVER_PASSWORD` 仅解决 server 访问认证（HTTP Basic Auth），不等同于执行沙箱。

## 扩展机制与资产

不适用（本专题聚焦 Windows 兼容性与部署，扩展机制/插件资产格式细节留给专门的"扩展机制"专题，此处不重复展开）。

## 记忆

不适用（同上，留给记忆专题；本次仅捎带记录 dsh 会话日志的压缩存储格式与 Goose 的 SQLite 持久化，已计入"会话模型"一节）。

## 多 Agent 与协作

不适用（本专题不涉及；Goose recipe/subagent、Hermes skills/subagents 等提及的"subagents"字样仅作为侧面证据出现在安装文档中，未展开验证，留给多 Agent 专题）。

## 可观测性

不适用（本专题未抓取日志/事件协议一手资料；留给可观测性专题。仅记录一个部署侧相关信号：Hermes 的 Gateway 有 `hermes gateway status` 合并展示计划任务/Startup 目录/运行进程三方视图，可作为"进程健康自检"的设计参考）。

## 对我们架构的启示（公共能力 vs 扩展能力映射表、接入参数、风险与坑）

### 1. "引擎 × Windows 可用性"矩阵（按接入风险排序，风险从低到高）

| 引擎 | 官方原生 Windows | 安装方式 | 无头/服务模式 | 默认 shell | 沙箱（原生 Windows） | 接入风险 |
|---|---|---|---|---|---|---|
| Codex CLI | 是，且有专门的原生 Windows 沙箱工程投入 | 未详查（据搜索为 npm/独立安装器） | `codex exec`、`codex app-server`（推测持久服务） | PowerShell 原生 | 有（elevated 四层防御，v0.100.0 转正） | **低**——唯一把 Windows 当一等公民做沙箱工程的引擎 |
| Cline CLI | 是，发布原生预编译二进制（win x64/arm64） | `npm i -g cline`（仅装期需 Node，运行期原生二进制） | `--json`/管道 stdin 自动无头 | 未明确（未见 Git Bash 依赖报道） | 未见沙箱证据 | **低-中**——二进制分发降低运行时依赖，但一手协议细节不足 |
| Hermes Agent | 是，"early beta"标注但工程投入完整（自举 Python/Node/Git，UTF-8 修复，PID 检测适配 Windows API） | PowerShell 一键脚本，全自包含（不依赖用户预装 Node/Python/Git） | `hermes gateway run` + Windows 计划任务服务化 | Git Bash（PortableGit 自动下发） | 无独立沙箱，权限靠账户级 | **中**——beta 标签+"未在 Linux/macOS/WSL2 规模上路测"是主要不确定性 |
| Gemini CLI | 是（未见 WSL 建议） | `npm install -g @google/gemini-cli` | `gemini --headless -p` | 未明确 | 未见沙箱证据 | **中**——官方一手 Windows 专项文档在本次检索中未直接抓到，需补充验证 |
| Qwen Code | 是 | PowerShell 脚本 or `npm i -g` | 未明确无头模式细节 | 未明确 | 未见沙箱证据 | **中** |
| Kimi CLI | 是 | PowerShell one-liner | 未明确 | Git Bash（同 pi 模式） | 未见 | **中** |
| Claude Code | 是（2026 起原生安装器+原生 PowerShell 工具） | 原生安装器（推荐，自动更新）/ winget（不自动更新）/ npm（≥Node 22，仅装期） | `claude -p`（单轮 print 模式） | 原生 PowerShell 工具（v2.1.84+），此前 Git Bash | **无**（沙箱需 WSL2，原生 Windows 无内核级隔离） | **中**——功能强但"无 Windows 原生沙箱"与赛题的沙箱/权限维度有缺口 |
| pi (earendil-works) | 是 | npm 包 | 未见独立 HTTP server 模式一手证据 | Git Bash 默认，可选 PowerShell 工具 | 未见 | **中**——官方 Windows 文档质量高，但无头服务模式待确认 |
| Goose | 是（Desktop 已支持 Windows，CLI/goosed 理论跨平台） | pipx/Python 环境 | `goosed`（REST+SSE，~103 endpoints）+ `goose run` recipe | 未明确（依赖 developer/shell 扩展） | 未见沙箱，`GOOSE_MODE` 仅应用层权限 | **中-高**——Windows 安装报告有 keyring 报错等已知坑，需 Python 环境 |
| DeepSeek Harness (dsh) | 无官方桌面应用，但 CLI/Web 可原生跑 | `npx @deepseek-ai/dsh web`（Node ≥22.19） | `dsh web`（浏览器 UI）+ `dsh --profile headless` | 未明确 | 未提及 | **中-高**——"预览阶段，版本间可能有破坏性变更"，且强依赖浏览器交互，纯服务器场景需二次验证 headless 完整度 |
| OpenCode | 官方**不建议**原生 Windows，强推荐 WSL | WSL 内 `curl \| bash`；原生 Windows 亦可运行但文件系统/终端能力打折 | `opencode serve`（OpenAPI 3.1，与赛题网关规范高度相似） | WSL 内 bash（原生 Windows 模式的 shell 行为文档未详述） | 不适用（依赖 WSL） | **高**——协议形态最贴合赛题，但官方明确不推荐纯原生 Windows 部署，与硬约束"引擎必须能在 Windows 原生运行"直接冲突，需要实测验证 `opencode serve` 脱离 WSL 单独运行的稳定性 |

注：Hermes、Codex、Claude Code 的信息来自较强的一手/半一手来源；Goose、dsh、Kimi、Qwen、Gemini CLI、Cline 的 Windows 细节多来自第三方转述搜索聚合，标注为中等置信度，建议在后续专题中用官方仓库 README/CHANGELOG 做二次核实。

### 2. 公共能力 vs 引擎特有扩展能力（Windows 维度）

**可归一化的公共能力**（网关层应统一抽象、不关心底层引擎差异）：
- 进程生命周期管理：启动/停止/健康检查/日志采集——所有引擎都可以用"子进程 + stdout/stderr 管道 + 端口探活"的统一方式管理，即便个别引擎（Hermes）原生支持计划任务服务化，网关也应当自己接管进程守护，不依赖引擎自带的服务化机制，以保持跨引擎一致性。
- shell 工具的"意图"（运行脚本、读写 Office 文件）：可归一化为网关侧统一的"execute_command"能力描述，底层由各引擎自行决定用 PowerShell/Git Bash/cmd 实现。
- 认证跳过/无人值守启动：所有引擎首次运行都有"配置文件预置 + 环境变量注入"两种跳过交互向导的路径，可统一为网关侧部署脚本模板（预写 config 文件到 `%USERPROFILE%\.<engine>\` 或 `%LOCALAPPDATA%\<engine>\`，预设 API key 环境变量）。

**引擎特有扩展能力**（需要能力协商机制单独声明，不能假设所有引擎都有）：
- 原生 Windows 沙箱隔离（仅 Codex 有完整实现）——网关的权限模型需要能声明"本引擎轮次不提供内核级隔离，风险自担"这一降级状态，而不是假设所有引擎都支持。
- 服务化托管方式（Hermes 的计划任务 vs 其他引擎需网关自建 Windows Service/NSSM 包装）——建议统一在网关侧用 NSSM 或类似工具包装所有引擎为 Windows Service，而不依赖各引擎自带（不一致）的服务化脚本。
- 浏览器优先的交互模式（dsh 的"browser is the desktop app"）——若评测环境要求纯命令行/无浏览器无头执行，dsh 的 headless profile 是唯一可用入口，需要单独验证其完整度（是否支持完整 session/多轮/工具调用轨迹导出，而不仅仅是"打印结果退出"）。

### 3. 接入参数清单（Windows 部署侧，供"能力识别→适配→认证"标准流程参考）

对每个新引擎接入时，网关适配层至少需要探测/配置以下参数：
1. `shell_backend`：git-bash | powershell | cmd | native-binary（决定办公任务里 Python 脚本/PowerShell 脚本如何执行、路径分隔符如何处理）
2. `runtime_deps`：Node 版本下限、Python 版本下限、是否需要预装 Git for Windows
3. `headless_entry`：无头执行的 CLI 子命令或 HTTP server 启动命令 + 默认端口
4. `service_wrap_strategy`：网关自建 NSSM/Scheduled Task 包装，还是复用引擎自带服务化命令
5. `sandbox_level`：none | app-layer-allowlist | os-native-sandbox（决定网关的权限网关层是否需要额外补偿控制，比如对无沙箱引擎强制走受限用户账户运行）
6. `config_home`：配置文件落盘路径（`%USERPROFILE%\.<engine>` 或 `%LOCALAPPDATA%\<engine>`），用于无人值守部署时预置认证信息
7. `encoding_fixups`：是否需要显式设置 `PYTHONIOENCODING`/`chcp 65001` 等（Hermes 的 `configure_windows_stdio()` 是很好的参考实现）

### 4. 主要风险与坑

- **OpenCode 与硬约束的直接冲突**：赛题网关规范"形态与 opencode 的 server API 高度一致"，容易让人默认选 OpenCode 作为首选引擎，但官方文档明确不推荐纯原生 Windows 部署（性能/终端/工具兼容性打折），这是本次调研中最值得警惕的一条——需要单独做实测验证（不能只信文档措辞），或考虑退而求其次用 OpenCode 的协议形态做网关规范参考、但选择更 Windows 原生的引擎做实际接入。
- **Git Bash 依赖的系统性风险**：pi、Kimi CLI、旧版 Claude Code、Hermes 均默认走 Git Bash 执行 shell 命令，意味着评测机器上必须预装或引擎自带 Git for Windows；对办公任务（如需要调用 PowerShell 操作 Word/Excel COM 对象、或需要原生 Windows 路径）需要额外配置 PowerShell 工具或做路径转换，否则容易出现路径/编码类 bug。
- **沙箱能力的显著不均衡**：Codex 一家独强，其余引擎在原生 Windows 上普遍没有内核级隔离，这对赛题"鲁棒性"评分项（5%）和"架构合理性"评分项（20%，若评委关注权限模型完整性）都有影响，网关层需要用应用层白名单（工具调用审批、文件路径白名单）做补偿。
- **信息新鲜度与来源质量参差**：本次可检索到的多数 Windows 安装指南是 2026 年的第三方博客聚合内容（很多域名疑似 AI 生成的教程站点），而非引擎官方仓库一手 README/CHANGELOG，Gemini CLI、Goose、Qwen Code、Kimi CLI、Cline CLI 的具体版本号/端口号等细节建议在正式选型前用 `gh repo view` 或直接抓取对应 GitHub 仓库的 README/CHANGELOG 做官方二次核实。
- **DeepSeek Harness 的"预览阶段"标签**：文档自陈"breaking-change risk between releases"，若选它作为两个接入引擎之一，需要锁定具体版本号并做好升级评估流程。

## 未解决问题

1. OpenCode 的 `opencode serve` 在**完全脱离 WSL**、纯原生 Windows 10/11 环境下的实际稳定性、性能与工具兼容性如何？（官方文档给出的是政策性建议，非实测数据，需要在网关实现阶段做真实基准测试）
2. pi coding-agent 是否存在类似 opencode/goosed 的持久化 HTTP server / RPC 无头模式（`pi --mode rpc` 之类）？本次抓取的 windows.md 未提及，需要在"可编程接入面"专题中针对 pi 的其余文档/README 做专项核实。
3. Codex 的 `codex app-server` 具体协议形态（是否类似 opencode 的 REST+SSE，字段名是什么）尚未一手核实，需要协议专题跟进。
4. Claude Code 是否存在持久 session 的无头 HTTP server 模式（不仅仅是单轮 `-p` print 模式），例如是否可通过 `claude mcp serve` 或类似机制满足赛题网关规范里"GET /session/{id}/message 完整轨迹"的要求？
5. Gemini CLI、Kimi CLI、Qwen Code、Goose 在 Windows 上的官方一手文档（GitHub README/官方 docs 站点原文）尚未逐一直接抓取核实，本报告对它们的表述多来自搜索引擎聚合摘要，置信度中等，建议后续补充 WebFetch 官方仓库源码/README。
6. Hermes 的 "early beta" 状态在赛题评测的时间窗口内是否会有重大变更（例如网关 API 字段变化），需要跟踪其 CHANGELOG。

## 来源列表

- https://opencode.ai/docs/server/
- https://opencode.ai/docs/windows-wsl/
- https://opencode.ai/docs/cli/
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/windows.md （raw.githubusercontent.com 抓取）
- https://github.com/earendil-works/pi
- https://hermes-agent.nousresearch.com/docs/user-guide/windows-native
- https://github.com/AtlasOmnia/hermes-agent-community/blob/main/guides/windows-install.md（搜索片段）
- https://github.com/deepseek-ai/deepseek-harness
- https://www.orcarouter.ai/blog/deepseek-harness-windows-tui
- https://deepseekdocs.com/en/
- https://github.com/aaif-goose/goose
- https://goose-docs.ai/docs/tutorials/headless-goose/
- https://deepwiki.com/block/goose/2-installation-and-setup
- https://github.com/openai/codex/discussions/6065
- https://developers.openai.com/codex/windows （重定向至 https://learn.chatgpt.com/docs/windows/windows-sandbox）
- https://www.npmjs.com/package/@google/gemini-cli
- https://github.com/google-gemini/gemini-cli
- https://geminicli.com/docs/get-started/installation/
- https://github.com/MoonshotAI/kimi-cli
- https://github.com/MoonshotAI/kimi-code
- https://github.com/QwenLM/qwen-code
- https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/
- https://github.com/cline/cline/blob/main/apps/cli/README.md
- https://cline.bot/cli
- 多篇第三方 2026 年 Claude Code Windows 安装指南（nxcode.io, inventivehq.com, pq.hosting, thepromptshelf.dev, agentpatterns.ai, claudelab.net 等，经搜索引擎聚合，未逐一直接 WebFetch 核实原文）
