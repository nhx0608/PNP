# G05 Goose（block/goose）作为候选引擎的深度调研

## 摘要

Goose（Rust 编写，Apache 2.0）已于 2026 年从 Block 公司迁移至 Linux Foundation 旗下的 Agentic AI Foundation（AAIF），GitHub 权威地址变为 `aaif-goose/goose`（旧 `block/goose` 保留为历史别名/重定向）。其架构分三层：CLI（`goose run` 无头执行 / `goose session` 交互）、`goosed` 守护进程（axum 实现的 REST+SSE API，服务 Desktop 及远程客户端，约 103 个端点，OpenAPI 由 utoipa 生成）、Desktop GUI；三者共享同一 Rust agent core，且正在做"per-session Agent"重构以强化会话隔离。对我们网关最关键的是三条可编程接入面：headless 的 `goose run`（`-t/-i/--recipe/--params/--output-format json|stream-json`，但无法在无头模式下真正走人工确认/`/question`/`/permission`）、goosed 私有 REST+SSE、以及**标准化的 ACP 支持**（`goose acp` stdio / `goose serve` HTTP:3284），后者是最适合作为跨引擎统一抽象层候选协议的通道。会话原生支持 resume/fork/export，新版本落 SQLite（sessions.db）。权限模型有 auto/approve/smart_approve/chat 四态，smart_approve 用 LLM 分类器 PermissionJudge 自动放行低风险调用，但在部分 provider 下 `GOOSE_MODE=auto` 曾被报告不生效（issue #3386），需实测兜底。扩展体系即 MCP（stdio/http/builtin），内置 Developer/Computer Controller/Memory 扩展，Windows 办公自动化主要靠 Computer Controller，但需注意 `.goosehints`/`AGENTS.md` 在 headless 下默认不加载（需显式 `--with-builtin developer`）这一隐蔽坑。Recipe（YAML：instructions/prompt/parameters/extensions/response schema/sub_recipes）是其"AI 资产"核心格式，配合 Subagents（≤10 并行 worker）与 Subrecipes（各自可指定独立模型）构成较成熟的多 Agent 编排能力，应作为引擎特有扩展能力接入。原生支持 OpenAI 兼容自定义端点（`OPENAI_HOST`/`GOOSE_PROVIDER=openai` 或 `GOOSE_PROVIDER__HOST`），与赛题"内部模型"硬约束契合，但流式错误场景下曾有 provider 崩溃报告（issue #8021），需联调验证。可观测性原生支持 OpenTelemetry（OTLP endpoint/traces exporter）及 Langfuse/MLflow 生态集成。Windows 原生安装有官方 PowerShell 脚本，但 keyring 不稳定建议用环境变量，且默认 Shell 是 cmd，需显式设置 `GOOSE_SHELL` 获取 POSIX 语义。总体结论：Goose 是功能完整、协议多样（尤其 ACP）、Windows 与自定义端点支持较好的候选引擎，但项目正处于组织迁移与内部架构重构的活跃期，接入需锁定版本并预留适配层维护成本。

## 关键事实（表格：事实 | 来源 | 置信度 | 是否交叉验证）

| 事实 | 来源 | 置信度 | 交叉验证 |
|---|---|---|---|
| Goose 是 Block 开源的 AI Agent，核心用 Rust 编写，Apache 2.0 协议，仓库 github.com/block/goose | github.com/block/goose | 高 | 是（多来源一致提及） |
| Goose 提供三种主要形态：CLI（goose run / goose session）、goosed 后台服务（goose-server crate，基于 axum，REST+SSE/WebSocket API，供 Desktop 使用）、Desktop（Electron/Tauri GUI） | deepwiki.com/block/goose/5-server-and-api-layer | 高 | 是（多篇 DeepWiki 页 + 讨论 issue 一致） |
| goosed 暴露约 103 个 REST 端点，管理 Agent/Session/Config 生命周期，支持 TLS、secret-key 鉴权、远程隧道 | deepwiki.com/block/goose (Server & API Layer) | 中 | 否（单一来源，数字未在第二来源验证） |
| Goose 正在从"单一全局 AgentRef"重构为"每 session 一个 Agent"的 AgentManager 架构，为每个 session 提供独立 ExtensionManager/ToolMonitor/channel，避免锁竞争 | github.com/block/goose Discussion #4389 | 中 | 否（进行中的重构，可能随版本变化） |
| `goose run` 是无头（headless）执行入口：接受 `-t/--text`、`-i/--instructions`（含 `-` 读 stdin）、`--recipe`、`--params`、`--no-session`、`--resume`、`-r`、`--output-format text\|json\|stream-json`，headless 模式下不能请求澄清/审批，只能按最佳判断执行 | goose-docs.ai/docs/tutorials/headless-goose/ ；raw CLI 文档 | 高 | 是（两个独立文档源交叉确认字段名） |
| `goose session` 支持 `list/remove/export/diagnostics` 子命令、`--session-id`、`--resume`、`--fork`、`--edit`（以 YAML 打开会话编辑）；会话数据落 SQLite（sessions.db），通过 sqlx 连接池访问，此前是旧版按文件路径存储（`--path` 为 legacy 方式） | raw goose-cli-commands.md；deepwiki Session Management | 高 | 是（CLI 参数与 DeepWiki 架构描述互相印证） |
| Goose 支持 Agent Client Protocol：`goose acp`（stdio 上跑 ACP server，可加 `--enable-scheduler`）与 `goose serve`（ACP over HTTP/WebSocket，默认监听 127.0.0.1:3284，可加 `--host`、`--port`、`--dangerously-unauthenticated` 跳过鉴权） | raw goose-cli-commands.md | 高 | 部分（HTTP 端口 3284 及 flag 名称来自单一抓取，逻辑上与 ACP 生态一致） |
| Recipe（YAML）字段包括：instructions（系统提示，Jinja 模板）、prompt（默认开场消息，模板）、parameters（typed 输入，可作模板变量）、extensions（stdio/builtin/platform/streamable_http/frontend 等 MCP 扩展声明）、response（可选 JSON Schema 约束最终结构化输出）、可含 sub_recipe（子 Recipe，相当于独立子 Agent） | block-goose.mintlify.app/guides/recipes；goose-docs.ai recipe-reference | 高 | 是（两个文档源字段描述一致） |
| Windows 支持原生安装：官方提供 PowerShell 安装脚本（`download_cli.ps1`），也支持 Git Bash/MSYS2 下的 shell 安装脚本；Goose Desktop 已支持 Windows（zip 包，含可执行文件） | dev.to 教程 + github Discussion "Goose for Windows" | 中高 | 部分（安装脚本 URL 来自搜索摘要，未逐字核对 raw 内容） |
| Windows 上 keyring（系统凭据存储）不稳定，官方建议改用环境变量存储 API Key/Provider 配置 | 搜索摘要（来源同上） | 中 | 否 |
| Goose 是 Apache 2.0 许可、社区/生态围绕它出现多个 "fork/镜像" 组织（如观察到的 aaif-goose/goose 在 GitHub 上作为活跃 fork 出现在多个 DeepWiki/Issue 链接中），提醒需以官方 block/goose 仓库为准，其余可能是社区镜像或过时分支 | 观察自搜索结果（github.com/aaif-goose/goose 大量出现） | 低（推测） | 否，需人工核实 aaif-goose 与 block 的关系 |

## 架构与工作原理

Goose（block/goose）核心用 **Rust** 编写，围绕一个共享的 agent core crate（goose lib）构建三种上层形态：

1. **CLI**（`goose` 二进制）：交互式会话（`goose session`）与无头执行（`goose run`）；社区/官方文档显示 CLI 内部正在从"直接调用 self.agent"重构为"经由 goosed 走 HTTP/SSE"，与 Desktop UI 共用同一后端架构（[github.com/block/goose Issue #7225](https://github.com/block/goose/issues/7225)）。
2. **goosed 守护进程**（`goose-server` crate）：用 **axum** 构建的 REST + SSE/WebSocket API 服务，管理 Agent/Session/Config 的生命周期，是 Desktop 应用及其它远程客户端的主后端；据 DeepWiki 描述暴露约 103 个端点，支持 TLS 终止、secret-key 鉴权与远程隧道（[deepwiki.com/block/goose 5-server-and-api-layer](https://deepwiki.com/block/goose/5-server-and-api-layer-(goose-server))）。OpenAPI 规范由 Rust 侧的 `utoipa` 生成 `openapi.json`（位于 `ui/desktop/openapi.json`），再用 `@hey-api/openapi-ts` 生成 TypeScript SDK 供 Desktop 使用。
3. **Desktop**：基于该 openapi 生成的 TS SDK 消费 goosed API 的 GUI 客户端，已支持 Windows（zip 包 + 可执行文件）。

**架构演进中的关键点**：官方正在做"per-session Agent"重构（Discussion #4389）——把此前"单一全局 AgentRef"替换为 `AgentManager`，为每个 `session_id` 创建独立的 `ExtensionManager`/`ToolMonitor`/channel，从而避免多会话之间的锁竞争与消息交织。这与我们网关要求的"会话隔离"高度契合，但说明**截至目前该重构可能仍在推进中**，不同版本行为可能不同，接入时需锁定具体 tag 做兼容性测试。

**组织归属变更（重要，影响长期可持续性判断）**：Goose 已经从 Block 公司迁移至 **Agentic AI Foundation (AAIF)**（隶属 Linux Foundation），GitHub 组织由 `block/goose` 迁移为 `aaif-goose/goose`（[goose-docs.ai/blog/2026/04/07/goose-moves-to-aaif](https://goose-docs.ai/blog/2026/04/07/goose-moves-to-aaif/)，仓库内有 PR #8359 专门修正所有 `block.github.io/goose` 到新地址的引用）。文档站点也出现两个并存版本：`block-goose.mintlify.app`（旧）与 `goose-docs.ai`（新）。**这意味着做技术选型报告和代码引用时应统一使用 `github.com/aaif-goose/goose` 作为权威源**，`block/goose` 会自动重定向或成为历史别名。

**Windows 原生支持**：官方文档提供专门的 Windows 安装路径——PowerShell 脚本安装（`Invoke-WebRequest ... download_cli.ps1 ...`），或在 Git Bash / MSYS2 下用与 macOS/Linux 相同的 shell 脚本（`curl -fsSL .../download_cli.sh | bash`）；Desktop 应用有独立的 Windows zip 发行包（[dev.to Windows 安装教程](https://dev.to/lymah/getting-started-with-goose-on-windows-30bh)）。**已知坑**：Windows 上系统 keyring（凭据管理器）集成不稳定，官方建议改用环境变量存放 API Key/Provider 配置，这对我们网关"以环境变量方式启动引擎"的约束（`AGENT_ENGINE=...` 等）恰好一致，属于友好特性而非负担。另外 Developer 扩展默认 Shell 在 Windows 上是 `cmd`，如需 POSIX 语义（管道、bash 脚本）要显式设置 `GOOSE_SHELL`（例如指向 `pwsh` 或 Git Bash 的 `bash.exe`），否则很多 *nix 风格 shell 命令在 headless 任务里会执行失败——这是 Windows 评测环境下必须显式处理的坑。

## 可编程接入面

Goose 面向自动化/网关接入提供三条主要路径，重要性从高到低：

### 1) `goose run`（无头 CLI，最贴近我们网关需要的"一次性 prompt-in / message-out"模型）

```
goose run -t "总结这份 Excel 表格" --no-session --output-format json
goose run -i instructions.txt --recipe office-recipe.yaml --params key=value -r --session-id sess-123
```

- 输入：`-t/--text`（直接文本）、`-i/--instructions <FILE>`（文件路径，`-` 表示 stdin）、`--system`（附加系统提示）、`--recipe`（加载 YAML Recipe）、`--params KEY=VALUE`（可重复，传给 Recipe 模板变量）、`--sub-recipe`（挂载子 Recipe，可重复）。
- 会话相关：`-s/--interactive`（输入完成后转交互模式）、`-n/--name`、`-r/--resume`（续跑上一次 run）、`--no-session`（不落盘会话）、`--session-id`。
- 扩展：`--with-extension <CMD>`（stdio MCP，可重复）、`--with-streamable-http-extension <URL>`（远程 MCP）、`--with-builtin <name>`（内置扩展，如 developer/computercontroller/memory）。
- 控制：`--max-tool-repetitions`、`--max-turns`（默认 1000）、`--explain`/`--render-recipe`（只展示不执行）、`-q/--quiet`、`--output-format text|json|stream-json`、`--provider`/`--model` 覆盖。
- **关键限制（已交叉验证，两个独立文档源一致）**：headless 模式下 Goose **不能**请求澄清/审批/额外输入，遇到不确定情况只能凭已知上下文"尽力而为"（[goose-docs.ai/docs/tutorials/headless-goose](https://goose-docs.ai/docs/tutorials/headless-goose/)）。这直接对应我们网关规范里 `/question`、`/permission` 端点是"可选"的设计——如果底层引擎跑在 headless CLI 模式，这两个端点在 Goose 侧基本无法真正落地，只能靠预置 `GOOSE_MODE=auto` 或 Recipe 里固化好扩展白名单来规避交互阻塞。

### 2) goosed HTTP/SSE API（更贴近我们网关"session 常驻 + SSE 事件"的模型）

- 后台常驻进程，通过 axum 暴露 REST + SSE，官方 OpenAPI 规范可用 `utoipa` 生成的 `openapi.json`（`ui/desktop/openapi.json`）获取全量端点定义；已确认存在按 session 发消息、SSE 流式回复的模式：`POST /sessions/{id}/messages`（发送消息，流式响应）（[deepwiki + 搜索摘要交叉]）。
- 鉴权：支持 secret-key 认证与 TLS 终止；也存在远程隧道能力，说明其设计目标包含"作为可被外部编排系统接入的后端服务"，与我们网关的定位一致。
- **重要局限**：goosed 的 REST+SSE 协议是 Goose **自有格式**，不是我们网关规范也不是 ACP，字段名（如 message.part 结构）与我们的 `/session/{id}/message` 轨迹格式、`/event` SSE 事件名（`server.connected`/`session.idle`/`message.part.updated` 等）不直接兼容，需要写一层适配器把 goosed 的事件流翻译成我们规范定义的事件。

### 3) Agent Client Protocol（ACP）支持——这是 Goose 最值得关注的接入面

- `goose acp`：以 **stdio** 方式运行 ACP server，可加 `--enable-scheduler` 打开定时 Recipe 执行。
- `goose serve`：以 **HTTP/WebSocket** 方式运行 ACP server，默认监听 `127.0.0.1:3284`，可用 `--host`/`--port` 调整；提供 `--dangerously-unauthenticated` 跳过鉴权（默认应带鉴权，说明生产环境有权限校验机制）；同样可加 `--enable-scheduler`。
- ACP（由 Zed 编辑器发起、Google/其他厂商跟进的开放协议）定位与我们的"通用 Agent 网关规范"类似——都试图把 IDE/客户端与底层 Agent 引擎解耦。Goose 同时支持 headless CLI、私有 goosed REST API 和标准化的 ACP 三条通道，说明它已经具备"被上层编排系统即插即用接入"的设计取向，是接入我们网关时**优先考虑走 ACP 或 `goose run` 子进程，而非直接对接私有 goosed REST**的理由——ACP 的消息 schema 更稳定、跨引擎可比性更好。

### 4) SDK

搜索未发现独立发布的官方 "goose-sdk" npm/pip 包被广泛使用的证据；主要复用方式是消费 goosed 自动生成的 TypeScript SDK（`@hey-api/openapi-ts` 生成，供 Desktop UI 内部使用），未见到面向第三方的稳定语义化 SDK 版本承诺。**结论：SDK 层不成熟，接入建议以进程级（spawn `goose run`/`goose acp`）为主，HTTP API 为辅**。

## 会话模型

- 会话（session）是 Goose 的一等公民：保存对话历史、token 用量、工作目录、关联的 Recipe、Provider 元数据、扩展状态。
- **存储演进**：新架构下会话数据落 **SQLite**（`sessions.db`），经 `sqlx` 连接池访问，通过分层 API 暴露；CLI 里仍保留 `--path` 作为"legacy 文件路径存储"方式的兼容参数，说明 Goose 经历过"按文件路径存 session" → "SQLite 数据库存 session"的存储格式迁移（[deepwiki Session Management](https://deepwiki.com/block/goose/4.3-session-management)，与 raw CLI 文档中 `--path` 标注为 legacy 相互印证，已交叉验证）。
- **会话管理 CLI**：`goose session list/remove/export/diagnostics`；`export` 支持导出为 `markdown/json/yaml`；`--fork` 可复制一份历史另起会话；`--edit` 可把会话历史整体以 YAML 打开编辑（对我们"轨迹归一化/审计"场景是个有趣特性，但目前只在交互 CLI 层面，非 API）。
- **Resume**：`goose run -r/--resume` 与 `goose session --resume --session-id <id>` 均支持"继续上一次会话"，符合我们网关"同一群/同一业务 session 保持连续性"的需求，可以把业务 session_id 映射为 Goose 的 `--session-id`。
- **取消/超时**：`--max-turns`（默认 1000 轮上限）、`--max-tool-repetitions`（防止重复调用同一工具陷入死循环）是显式的执行上限保护；未见到独立的"per-request timeout"参数文档化，取消更依赖上层杀进程或调用 goosed 的 abort 类端点（未在本次调研中确认其具体路径，需要进一步查 openapi.json）。

## 权限与安全

Goose 有清晰的四态权限模型（[goose-docs.ai/docs/guides/managing-tools/goose-permissions](https://goose-docs.ai/docs/guides/managing-tools/goose-permissions/)，[deepwiki 6.1/6.2 Permission System](https://deepwiki.com/block/goose/6.1-permission-system-architecture)，已交叉验证）：

- **auto**：完全自动，文件修改/扩展调用/编辑/新建/删除文件均自由执行，不询问。
- **approve**：人工审批，每次工具调用弹出 Allow/Deny。
- **smart_approve**：Goose 使用一个专门的 LLM 分类器 **PermissionJudge** 判断该工具调用是否"安全可自动执行"，安全则自动放行，风险则转人工审批——是四种模式里对我们"权限限制"需求最有价值的一种，等价于内建了一层轻量风险评估。
- **chat**：纯聊天模式，阻断所有工具调用（适合"只读咨询"类业务场景）。

**配置方式**：`goose config set-mode auto|smart-approve|approve|chat` 或环境变量 `GOOSE_MODE=auto|approve|smart|chat`。

**已知问题（值得记录为坑）**：官方 issue（#3386）报告在使用 `claude-code` 作为 provider 时，即使设置 `GOOSE_MODE=auto`，Goose 仍反复弹出权限确认，说明**权限模式的生效程度依赖具体 provider/扩展实现**，不能假设 `GOOSE_MODE=auto` 在所有 provider 组合下都 100% 生效，对接内部模型 provider 时要单独验证。

**扩展白名单**：权限不仅作用于工具调用粒度，也体现在"允许加载哪些扩展"层面——`--with-extension`/`--with-builtin`/`--with-streamable-http-extension` 都是显式声明式的，未列出的扩展默认不可用，天然形成白名单机制，便于网关层按业务权限动态拼装 Goose 启动参数来限制其能力面。

## 扩展机制与资产

Goose 的扩展体系即 **MCP (Model Context Protocol)**，支持多种连接方式（[deepwiki 5.2 Built-in Extensions](https://deepwiki.com/block/goose/5.2-built-in-extensions)）：

- `stdio`：本地子进程 MCP server。
- `streamable_http` / `sse`：远程 HTTP/SSE MCP server。
- `builtin`：直接编译进 `goose-mcp` crate、随 goose 二进制分发的内置扩展，配置里 `type: builtin`（不走子进程），启动更快、无需额外部署。
- `platform`：平台级扩展。
- `frontend`：由前端（如 Desktop UI）注入的工具。

**代表性内置扩展**：
- **Developer**：文件读写、shell 命令执行、代码编辑等基础能力；同时是加载 `.goosehints`/`AGENTS.md` 等"提示词上下文文件"的唯一路径（`load_hint_files` 函数仅在 Developer 扩展内被调用）。**关键坑**：`.goosehints`、`AGENTS.md` 等上下文文件在**非交互式 headless run 中默认不会被加载**，除非显式传 `--with-builtin developer`（[github.com/aaif-goose/goose Issue #5104](https://github.com/aaif-goose/goose/issues/5104)）。这意味着如果网关期望 Goose 像其它引擎一样自动读取项目级"记忆文件"，必须在拼装 `goose run` 命令行时固定带上该参数，否则业务侧配置的提示词会被静默忽略。
- **Computer Controller**：把平台相关的桌面自动化 API（鼠标/键盘/屏幕/应用控制）抽象为统一工具集，是 Windows 办公任务（Word/Excel/PPT/IM 软件操作）场景下最相关的内置扩展，需要重点评估其在 Windows 下的成熟度与稳定性。
- **Memory**：独立的 MCP server，用于跨会话存取"用户偏好/记忆"，区分**本地存储**（`.goose/memory`，随项目/工作目录）与**全局存储**（`~/.config/goose/memory`，跨项目）。

**Recipe（YAML）**——Goose 特有的"资产"格式，是我们网关"统一 AI 资产模型"里需要重点归一化的对象：

```yaml
version: "1.0.0"
title: "office-report-recipe"
description: "..."
instructions: "你是一个 {{ role }} ..."      # 系统提示，Jinja2 模板
prompt: "请处理 {{ input_file }}"            # 默认开场消息，同样模板化
parameters:
  - key: role
    input_type: string
    requirement: required
  - key: input_file
    input_type: string
    requirement: required
extensions:
  - type: builtin
    name: developer
  - type: stdio
    name: custom-tool
    cmd: "node"
    args: ["server.js"]
response:
  json_schema: {...}     # 可选，约束最终结构化输出
sub_recipes:
  - name: sub-task
    path: ./sub.yaml
```

- `instructions`/`prompt` 均是 Jinja 模板，`parameters` 是"typed 函数参数"，让 Recipe 变成"可复用、可参数化调用的函数"，非常契合我们网关"AI 资产"里 workflow/prompt 模板的抽象。
- `response.json_schema` 可强制约束最终输出为结构化 JSON，对我们做客观评测（LLM-as-Judge 之外，还能直接做 schema 校验）很有价值。
- `sub_recipes` 让一个 Recipe 可以组合调用另一个 Recipe（本质是另一个独立配置的子 Agent），是 Goose 里最接近"dynamic workflow / agent team"的公共形态。

## 记忆

Goose 的记忆能力分两层：
1. **无状态提示注入**：`.goosehints`（项目级/全局级文本文件，随每次交互注入上下文），依赖 Developer 扩展加载，headless 场景下需显式声明扩展才生效（见上文坑点）。
2. **有状态记忆**：内置 **Memory** MCP 扩展，提供工具让 Agent 主动存取"用户偏好/长期记忆"，区分本地/全局两级作用域（`.goose/memory` vs `~/.config/goose/memory`），本质是一个专门的记忆读写工具集，而非自动语义检索型记忆（未见证据表明其内置向量检索，更像是结构化 key-value / 文本片段存取）。

对我们"统一记忆模型"的启示：Goose 的记忆是"工具化"的（Agent 主动调用 memory 工具读写），而非框架自动管理的隐式上下文压缩，与部分引擎（如某些带自动 RAG/摘要压缩的引擎）路线不同，接入时需要分类为"扩展能力"而非"公共能力"。另外提到的 `GOOSE_AUTO_COMPACT_THRESHOLD` 环境变量表明 Goose 也具备"会话自动压缩"机制（超过阈值自动摘要/压缩历史），这个可以归为公共能力（多数长会话引擎都有类似机制）。

## 多 Agent 与协作

Goose 提供两种互补的多 Agent 机制（[block.github.io/goose blog: subagents-vs-subrecipes](https://block.github.io/goose/blog/2025/09/26/subagents-vs-subrecipes/)，[goose-docs.ai blog: goose-as-conductor](https://goose-docs.ai/blog/2026/05/05/goose-as-conductor/)）：

- **Subagents**：从一个 session 内动态"孵化"的独立 Agent 进程，用于并行执行子任务；官方文档明确给出并发上限——**最多同时运行 10 个并行 worker**（已交叉验证：两篇官方/社区博客均描述该并行子任务机制，数字来自其中一篇，需注意版本可能调整该上限）。
- **Subrecipes**：以 Recipe 形式声明的子任务，可各自指定独立的 LLM Provider/Model，支持条件逻辑与"智能参数传递"，用于构建带依赖关系、有执行顺序控制的复杂多步工作流。
- **编排（Orchestration）**：官方将其定位为"subagents 之上的一层"——由一个主 session 决定"任务如何拆解、谁来做、什么时候做"，博客称之为 "Goose as Conductor"。
- **隔离性**：官方明确 Subagents/Subrecipes 之间**不共享状态**，彼此任务自包含，避免冲突——这与我们网关"会话之间上下文隔离"的原则是一致的设计哲学，也说明 Goose 的多 Agent 模式默认是"无共享内存的任务并行"，不是"多 Agent 共享黑板"式协作。

**对我们架构的映射**：Subagents/Subrecipes/Orchestration 应归类为 Goose **引擎特有的扩展能力**（对应赛题里提到的 "dynamic workflow / agent team" 类别），网关侧可以把"是否启用子任务并行"、"最大并行数（≤10）"、"每个子任务的 provider/model 覆盖"作为该能力的可配置参数，向上层暴露为一种"opt-in 高级编排能力"，而不是所有引擎都具备的公共能力。

## 可观测性

- **OpenTelemetry 原生支持**：可配置导出到任意 OTel 兼容平台，涉及环境变量包括 `OTEL_EXPORTER_OTLP_ENDPOINT`（collector 端点）、`OTEL_TRACES_EXPORTER`（`otlp`/`console`/`none`）等，支持"只导出 traces、关闭 metrics/logs"等细粒度配置。
- **Langfuse 集成**：存在 `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` 这类环境变量，说明官方对主流 LLM 可观测性平台有原生适配。
- **MLflow 集成**：MLflow 官方文档收录了 Goose 的 tracing 集成（[mlflow.org/docs/latest/genai/tracing/integrations/listing/goose](https://mlflow.org/docs/latest/genai/tracing/integrations/listing/goose/)），说明 Goose 在 GenAI tracing 生态里有一定认可度。
- `GOOSE_TELEMETRY_ENABLED`：控制是否上报匿名使用数据（区别于 OTel 导出，这是"上报给 Block/AAIF 自己"的遥测开关，网关部署时应确认默认值并按需关闭以满足数据合规）。
- **已知问题**：`Streaming/SSE fails silently in GUI`（issue #6169）——SSE 流式输出在某些情况下会静默失败而非报错，这是我们网关侧对接 goosed SSE 或 CLI `stream-json` 输出时要重点做健壮性测试（超时检测、心跳检测）的地方。另有 `OpenAI provider crashes on mid-stream error events from local inference servers`（issue #8021）——**这是内部部署自定义 OpenAI 兼容端点接入时的直接风险点**：如果内部模型网关在流式响应中返回非标准错误事件，Goose 的 OpenAI provider 可能直接崩溃，需要提前联调验证或考虑捕获/重启机制。

## 对我们架构的启示（公共能力 vs 扩展能力映射表、接入参数、风险与坑）

**推荐接入方式**：进程级接入为主。以 `goose run --recipe <biz-recipe.yaml> --session-id <mapped-id> --with-builtin developer --output-format stream-json --provider openai --model <internal-model>` 的方式由网关按业务 session 拉起/复用子进程，通过 stdout 的 `stream-json` 逐行事件流适配到我们网关规范的 `/session/{id}/message` 轨迹与 `/event` SSE；同时评估 `goose serve`（ACP over HTTP，默认端口 3284）作为长驻服务模式的备选，因为 ACP 的消息 schema 比私有 goosed REST 更标准、更适合作为跨引擎抽象层的"最大公约数"接口。

| 我们网关的公共能力 | Goose 对应实现 | 归一化难度 |
|---|---|---|
| 业务→session 映射 | `--session-id`/`--resume`；SQLite sessions.db 持久化 | 低（原生支持） |
| 会话连续性 | `goose run -r`、`goose session --resume` | 低 |
| 会话隔离 | per-session Agent（AgentManager 重构中）、独立 ExtensionManager | 中（依赖版本，重构未必已完全落地） |
| 权限限制 | GOOSE_MODE=auto/approve/smart_approve/chat + 扩展白名单（`--with-extension`/`--with-builtin`） | 低-中（smart_approve 在特定 provider 下可能失效，需实测） |
| 统一事件/日志协议 | OTel 导出 + 自有 stream-json/goosed SSE | 中（需要写适配层转换事件名/字段） |
| 自定义模型端点 | `OPENAI_HOST`/`OPENAI_BASE_PATH` + `GOOSE_PROVIDER=openai`，或 `GOOSE_PROVIDER__HOST`/`GOOSE_PROVIDER__API_KEY` | 低（原生支持 OpenAI 兼容端点，与赛题硬约束高度契合） |
| 自动压缩/长上下文管理 | `GOOSE_AUTO_COMPACT_THRESHOLD`、`GOOSE_CONTEXT_LIMIT` | 低 |

| Goose 特有扩展能力 | 说明 | 建议的接入参数 |
|---|---|---|
| Recipe（工作流资产） | YAML：instructions/prompt/parameters/extensions/response schema/sub_recipes | `--recipe path`, `--params k=v`，需要网关维护 Recipe 仓库并做参数校验 |
| Subagents（并行子 Agent） | 单 session 内孵化最多约 10 个并行 worker | 是否允许启用、最大并发数、超时策略 |
| Subrecipes（子工作流+独立模型） | 每个子任务可指定独立 provider/model | 子任务级 provider/model 覆盖表 |
| smart_approve（LLM 风险分类审批） | PermissionJudge 自动判断工具调用风险 | 是否启用、判定失败时的兜底策略（在部分 provider 下可能不生效，需要网关自己再包一层硬性权限过滤兜底，不能完全信任） |
| Computer Controller（桌面自动化） | Windows 办公任务的核心工具面 | 需重点做 Windows 兼容性/稳定性验证，这是评测用例（Word/Excel/PPT/IM）最直接相关的扩展 |
| ACP (goose acp / goose serve) | 标准化 Agent-客户端协议，stdio 或 HTTP/WebSocket:3284 | 是否走 ACP 作为统一抽象层的候选协议之一 |

**风险与坑（汇总）**：
1. **组织迁移**：仓库已从 `block/goose` 迁移到 `aaif-goose/goose`（AAIF/Linux Foundation），文档/链接存在新旧并存，接入代码与文档引用需统一到新地址，并关注治理结构变化是否影响后续更新节奏。
2. **headless 模式无法交互**：无法在无头模式下走 `/question`、`/permission` 真正意义上的"人工确认"，必须提前用 `GOOSE_MODE`/Recipe 固化好权限与工具边界。
3. **`.goosehints`/`AGENTS.md` 在 headless 下默认不加载**，必须显式带 `--with-builtin developer`，否则业务侧配置的提示词上下文被静默忽略——非常隐蔽的坑。
4. **`GOOSE_MODE=auto` 在部分 provider（如 claude-code provider）下可能不生效**，权限模型不能 100% 信任，需要网关侧做二次校验/沙箱兜底。
5. **Windows 下 Shell 差异**：默认 Developer 扩展用 `cmd`，需要显式设置 `GOOSE_SHELL` 才能获得 POSIX 语义；keyring 在 Windows 上不稳定，配置应统一走环境变量。
6. **自定义 OpenAI 兼容端点在流式错误场景下可能导致 provider 崩溃**（issue #8021），需要提前用内部模型网关联调验证流式错误处理的兼容性。
7. **架构处于活跃重构期**（per-session AgentManager、CLI-via-goosed 统一化均为进行中的工作），意味着接入时最好锁定具体版本/commit，并预留跟随上游变化调整适配层的维护成本。
8. **SDK 生态不成熟**：没有稳定的第三方语义化 SDK，建议以子进程 CLI 或 ACP 协议为主要接入手段，而非依赖生成的 TS SDK（该 SDK 面向 Desktop 内部使用）。

## 未解决问题

- goosed 的 SSE 事件具体字段名/schema（等价于我们网关 `message.part.updated` 这类事件名）未能拿到 openapi.json 原文逐字确认，需要后续直接抓取 `https://raw.githubusercontent.com/aaif-goose/goose/main/ui/desktop/openapi.json` 做字段级比对。
- `goose acp`/`goose serve` 的 ACP 协议版本、与 Zed ACP 规范的兼容程度、是否支持我们网关要求的 `permission.asked`/`question.asked` 等事件语义，需要进一步用真实 ACP client 联调验证。
- Session 取消（对应我们的 `/session/{id}/abort`）在 goosed API 中的具体端点路径未确认。
- Windows 下 Computer Controller 扩展对 Word/Excel/PPT/IM 软件自动化的实际成熟度（是否需要额外 COM/UIAutomation 依赖）未在本次调研中验证，需要实机测试。
- `smart_approve` 的 PermissionJudge 具体实现（是否本地小模型、是否可配置阈值）细节未查证。

## 来源列表

- https://github.com/block/goose （原仓库，现指向/关联 aaif-goose）
- https://github.com/aaif-goose/goose （现权威仓库）
- https://goose-docs.ai/docs/tutorials/headless-goose/
- https://goose-docs.ai/docs/guides/environment-variables/
- https://goose-docs.ai/docs/guides/recipes/recipe-reference/
- https://goose-docs.ai/docs/guides/managing-tools/goose-permissions/
- https://goose-docs.ai/blog/2026/04/07/goose-moves-to-aaif/
- https://goose-docs.ai/blog/2026/05/05/goose-as-conductor/
- https://block-goose.mintlify.app/guides/recipes
- https://deepwiki.com/block/goose/5-server-and-api-layer-(goose-server)
- https://deepwiki.com/block/goose/4.3-session-management
- https://deepwiki.com/block/goose/6.1-permission-system-architecture
- https://deepwiki.com/block/goose/6.2-permission-modes-and-tool-approval
- https://deepwiki.com/block/goose/5.2-built-in-extensions
- https://github.com/block/goose/discussions/4389
- https://github.com/block/goose/issues/7225
- https://github.com/aaif-goose/goose/issues/5104
- https://github.com/block/goose/issues/3386
- https://github.com/aaif-goose/goose/issues/8021
- https://github.com/aaif-goose/goose/issues/6169
- https://block.github.io/goose/blog/2025/09/26/subagents-vs-subrecipes/
- https://dev.to/lymah/getting-started-with-goose-on-windows-30bh
- https://mlflow.org/docs/latest/genai/tracing/integrations/listing/goose/
- raw.githubusercontent.com/block/goose/main/documentation/docs/guides/goose-cli-commands.md
