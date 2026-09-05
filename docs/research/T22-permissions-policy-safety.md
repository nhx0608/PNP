# T22 权限/策略/安全：跨引擎的统一策略模型

> 调研日期：2026-09-04。本领域变化极快，所有事实均以一手来源（官方文档/GitHub/规范原文）为准；标注"[推测]"者为基于公开资料的推断。

## 摘要

本报告调研 Claude Code、opencode、Codex、Gemini CLI、OpenClaw、Hermes、Goose、pi 及 ACP 协议的权限/审批机制，并参照 AWS AgentCore Policy（Cedar）、Entra Agent ID、SPIFFE、MCP OAuth 与 OWASP ASI 2026。结论：各引擎的权限系统可归纳为三种形态——静态声明式规则（allow/ask/deny + 工具名/参数模式）、运行时回调（hook、canUseTool、ACP request_permission、gateway 事件）与 OS 级沙箱兜底；2026 年新增共性是"LLM 作为审批者"的 review 档位。规则冲突解决策略各异（Claude 首个命中、opencode 最后命中、Gemini 数值优先级），因此网关应持有单一策略源（Cedar/Rego 风格，deny 优先），通过策略编译器生成各引擎原生配置，并在运行时以 hook/ACP 作为统一审批通道。主体（群/用户/租户）与 allow_always 记忆必须由网关按群分片持有，不下沉到引擎；引擎只见当前 session 的有效策略。关键坑包括 Bash 包装器绕过、非交互模式下 ask 静默转 deny、持久白名单跨群泄漏、MCP OAuth 在引擎内混合多用户凭据。

## 关键事实

| # | 事实 | 来源 | 置信度 | 交叉验证 |
|---|---|---|---|---|
| 1 | Claude Code 权限规则求值顺序固定为 deny → ask → allow，首个匹配即生效，"规则具体程度"不改变顺序；裸工具名 deny（如 `Bash`）会把工具从模型上下文中移除 | https://code.claude.com/docs/en/permissions | 高（一手） | 是：hooks 文档亦称"Hook decisions don't bypass permission rules" |
| 2 | Claude Code 权限模式共 6 种：`default`(别名 `manual`)、`acceptEdits`、`plan`、`auto`、`dontAsk`、`bypassPermissions`；`permissions.disableBypassPermissionsMode`/`disableAutoMode` = `"disable"` 可在 managed settings 中锁死 | 同上 | 高 | 是：hooks 输入 `permission_mode` 枚举与之一致 |
| 3 | Claude Code PreToolUse hook 输出 `hookSpecificOutput.permissionDecision` ∈ {allow, deny, ask, defer}，可附 `updatedInput` 改写参数；exit code 2 无条件阻断；多个 hook 取最严格（deny > defer > ask > allow） | https://code.claude.com/docs/en/hooks | 高 | 是：搜索结果多篇独立文章与 GitHub issue #41791 [已交叉验证] |
| 4 | Claude Agent SDK 处理顺序：PreToolUse Hook → Deny → Allow → Ask → Permission Mode → `canUseTool` 回调；被前序步骤放行的调用不会到达 `canUseTool` | https://code.claude.com/docs/en/agent-sdk/permissions（经搜索摘要）| 中-高 | 部分（Praesidia 博客与 DeepWiki 一致）|
| 5 | opencode `permission` 配置以工具名为键，值为 `allow`/`ask`/`deny` 或 glob→动作的对象；**最后匹配的规则胜出**；`agent.<name>.permission` 可覆盖；`doom_loop`、`external_directory` 默认 ask，`.env*` 默认 deny | https://opencode.ai/docs/permissions/ | 高 | 否（单一一手来源）|
| 6 | Codex `approval_policy` ∈ {`untrusted`, `on-request`, `never`, `{granular={sandbox_approval,rules,mcp_elicitations,request_permissions,skill_approval}}`}，`on-failure` 已弃用；`sandbox_mode` ∈ {`read-only`, `workspace-write`, `danger-full-access`}；`sandbox_workspace_write.{network_access,writable_roots,exclude_slash_tmp,exclude_tmpdir_env_var}` | https://learn.chatgpt.com/docs/config-file/config-reference | 高 | 部分：值集合与既有知识一致；`granular` 为新形态，仅单源 [值集合已交叉验证] |
| 7 | Codex MCP 配置支持 `mcp_servers.<id>.default_tools_approval_mode`、`tools.<tool>.approval_mode`、`enabled_tools/disabled_tools`、`auth = oauth|chatgpt` | 同上 | 高 | 否 |
| 8 | Gemini CLI Policy Engine：TOML `[[rule]]` 字段 `toolName/decision/priority/argsPattern/commandPrefix/mcpName/modes/allowRedirection`，decision ∈ {allow, deny, ask_user}；五层 tier（Default=1, Extension=2, Workspace=3, User=4, Admin=5），最终优先级 = tier_base + priority/1000；非交互模式下 `ask_user` 视为 deny | https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/policy-engine.md | 高 | 是：geminicli.com 与搜索结果一致 [已交叉验证] |
| 9 | ACP `session/request_permission`：请求含 `sessionId`、`toolCall{toolCallId,title,kind,rawInput}`、`options[{optionId,name,kind}]`，kind ∈ {allow_once, allow_always, reject_once, reject_always}；响应 `{"outcome":"selected","optionId"}` 或 `{"outcome":"cancelled"}`；tool kind ∈ {read, edit, delete, move, search, execute, think, fetch, other} | https://agentclientprotocol.com/protocol/tool-calls | 高 | 是：搜索结果（fast-agent、zed issue）一致 [已交叉验证] |
| 10 | OpenClaw exec approvals：`tools.exec.mode` ∈ {deny, allowlist, ask, auto, full}；host 层 `security`∈{deny,allowlist,full}、`ask`∈{off,on-miss,always}、`askFallback`；allowlist 项含 `pattern/argPattern/source/lastUsedAt`，按 `agents.<agentId>` 分作用域；审批经 gateway 事件 `exec.approval.requested` → `exec.approval.resolve` | https://docs.openclaw.ai/tools/exec-approvals | 高 | 否 |
| 11 | OpenClaw `tools.allow/deny/profile`、`tools.sandbox.tools.allow`，工具组 `group:fs/runtime/web/messaging`；策略在模型调用前执行，被移除的工具不出现在 schema 中；受 global/per-agent/channel/provider/sandbox 多层约束 | https://docs.openclaw.ai/tools | 高 | 否 |
| 12 | Hermes：`approvals.mode` ∈ {smart(默认，辅助 LLM 评估风险), manual, off}；`command_allowlist` 持久白名单；`approvals.deny` fnmatch；`approvals.{cron_mode,single_query_mode,unattended_mode}` ∈ {deny, approve}；消息平台上回复 yes/no 即审批；docker/modal 后端跳过审批检查；用户授权靠 `TELEGRAM_ALLOWED_USERS`/`GATEWAY_ALLOWED_USERS` 等 | https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/security.md | 高 | 是：搜索结果 security 页与 issue #5528 一致 [已交叉验证] |
| 13 | Goose：`GOOSE_MODE` ∈ {auto, approve, smart_approve, chat}；smart_approve 用 LLM `PermissionJudge`；`permission.yaml` 的 `user` 段 `always_allow/never_allow` 优先于 judge | 搜索：goose 官方 docs / DeepWiki | 中 | 部分 |
| 14 | pi（badlogic/pi-mono）核心无内建权限系统，靠扩展（如 `pi-permission-system`，策略文件 `~/.pi/agent/pi-permissions.jsonc`，`defaultPolicy.{tools,bash}` + allow/deny/ask）与官方示例 `permission-gate.ts` | 搜索：github MasuRii/pi-permission-system, pi-mono examples | 中 | 部分 |
| 15 | AWS AgentCore Policy（GA 2026-03-03）：Cedar 默认拒绝、forbid 优先；principal 类型 `AgentCore::OAuthUser`（来自 JWT `sub`，tags 含 claims）与 `AgentCore::IamEntity`；action=工具调用，resource=Gateway；扩展语言 Dogwood 支持 temporal policy（同 session 内先审批/限频/累计阈值），session 由 `x-amzn-bedrock-agentcore-policy-session-id` 头标识 | https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-core-concepts.html | 高 | 是：AWS Security Blog 与搜索摘要一致 [已交叉验证] |
| 16 | OWASP Top 10 for Agentic Applications 2026（2025-12-09 发布）：ASI01 Agent Goal Hijack、ASI02 Tool Misuse and Exploitation、ASI03 Identity and Privilege Abuse、ASI04 Agentic Supply Chain Vulnerabilities、ASI05 Unexpected Code Execution、ASI06 Memory and Context Poisoning、ASI07 Insecure Inter-Agent Communication、ASI08 Cascading Failures、ASI09 Human Agent Trust Exploitation、ASI10 Rogue Agents | https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/ + https://www.promptfoo.dev/docs/red-team/owasp-agentic-ai/ | 高 | 是 [已交叉验证] |
| 17 | MCP 授权规范（2025-06-18 起）：MCP server 是 OAuth 2.0 Resource Server，必须实现 RFC 9728 Protected Resource Metadata，401 + `WWW-Authenticate: resource_metadata=...`；客户端必须带 RFC 8707 `resource` 参数绑定 token | 搜索：modelcontextprotocol.io/specification, descope/logto/auth0 博客 | 高 | 是（多源） |
| 18 | Microsoft Entra Agent ID：agent identity 由 blueprint（模板，持有 client ID 与凭据）派生，agent identity 自身不持有凭据 | https://learn.microsoft.com/en-us/entra/agent-id/agent-blueprint（搜索摘要）| 中-高 | 部分 |
| 19 | SPIFFE：SVID 短期可轮换凭据，规范新增 WIT-SVID（IETF WIMSE Workload Identity Token 子集，Incubating）；2026-08 有 19 个 WIMSE 草案活跃 | 搜索：stacklok/riptides/iden 博客 | 中（二手）| 否 |

## 架构与工作原理

### 三类权限模型形态（跨引擎归纳）

综合上述引擎，权限系统在实现上分为三种基本形态，任何"统一策略模型"都要同时映射这三种：

1. **静态声明式规则（编译期）**：以配置文件描述"工具 × 参数模式 → 效果"。
   - Claude Code：`permissions.allow/ask/deny` 数组，规则形如 `Bash(git log *)`、`Read(./.env)`、`Edit(src/**)`、`WebFetch(domain:*.example.com)`、`mcp__server__tool`、`Agent(Plan)`、`Cd(~/code/**)`。求值顺序 deny → ask → allow，首个命中生效（来源 #1）。
   - opencode：`permission.<tool>` = 动作或 `{glob: 动作}` 对象，**最后匹配胜出**（与 Claude Code 相反！）（来源 #5）。
   - Gemini CLI：TOML `[[rule]]`，数值优先级 + 五层 tier，最高优先级胜出（来源 #8）。
   - Codex：`approval_policy` + `sandbox_mode` 是粗粒度开关，细粒度依赖 MCP `tools.<tool>.approval_mode` 与 rules 文件（来源 #6/#7）。
   - OpenClaw：`tools.allow/deny/profile` + exec allowlist（含 `argPattern` sha256 绑定）（来源 #10/#11）。
   - Hermes：`command_allowlist` + `approvals.deny`（fnmatch）+ 内建危险模式表（来源 #12）。

2. **运行时回调/hook（执行期）**：宿主在每次工具调用前得到一次否决/改写机会。
   - Claude Code：`PreToolUse` hook（shell 进程，JSON stdin/stdout）与 `PermissionRequest` hook；Agent SDK `canUseTool(toolName, input) → {behavior:"allow", updatedInput} | {behavior:"deny", message}`（来源 #3/#4）。
   - ACP：引擎作为 Agent 向 Client 发 `session/request_permission`，由 Client 决定（来源 #9）。
   - OpenClaw：gateway 广播 `exec.approval.requested`，UI/客户端回 `exec.approval.resolve`（来源 #10）。
   - Hermes：消息平台内以自然语言 yes/no 回复完成审批（来源 #12）。
   - pi：扩展 API 中的 tool-call 拦截（`permission-gate.ts`）（来源 #14）。

3. **OS 级沙箱（兜底）**：与权限规则互补，只约束 Bash 及其子进程。
   - Claude Code sandbox（文件系统 + 网络域名白名单，`WebFetch(domain:)` 规则会同步进沙箱域名表；裸 `WebFetch` 不会）（来源 #1）。
   - Codex：`sandbox_mode` 三档 + `sandbox_workspace_write.network_access` 默认关闭（来源 #6）。
   - Hermes：docker/modal/singularity 后端**跳过**审批检查，即"沙箱替代审批"（来源 #12）。
   - OpenClaw：`tools.sandbox.*`，sandbox 默认 `security=deny`（来源 #10）。

### "LLM 作为审批者"是 2026 年的新共性

Claude Code `auto` 模式（分类器审查动作）、Hermes `approvals.mode: smart`（辅助 LLM 评估风险）、Goose `smart_approve`（`PermissionJudge`）、OpenClaw `tools.exec.mode: auto`（"native auto reviewer"）——四个引擎都在 ask 与 allow 之间加了一个"模型评审"档位。对网关而言，这是一种可归一化的效果值 `review`（介于 ask/allow 之间），但各引擎的 reviewer 不可互换、不可审计一致性，网关应把它视为"引擎特有扩展"，并且在高敏场景（群聊多用户）默认降级为 `ask`。

## 可编程接入面

本节只列与权限/策略相关的接入面（其他接入面见对应引擎专题）。

| 引擎 | 编译期注入（网关生成引擎原生配置） | 运行时拦截点（网关作为审批者） | 关键参数/字段 |
|---|---|---|---|
| Claude Code | `settings.json`（user/project/local/managed 四层；managed 位于系统目录且不可被覆盖；`allowManagedPermissionRulesOnly` 可让 managed 成为唯一规则源）；CLI `--allowedTools/--disallowedTools`、`--permission-mode`、`--add-dir`；SDK `managedSettings` 选项 | `PreToolUse` hook（`hookSpecificOutput.permissionDecision`）、`PermissionRequest` hook（`decision`）、SDK `canUseTool` | `permissions.{allow,ask,deny,defaultMode,additionalDirectories,disableBypassPermissionsMode,disableAutoMode,blockReadsOutsideWorkingDirectories}`；hook 输入 `session_id/tool_name/tool_input/tool_use_id/permission_mode/cwd/agent_id` |
| opencode | `opencode.json` 的 `permission` 与 `agent.<name>.permission` | 无官方 hook；[推测] 通过插件系统（`tool.execute.before`）可拦截，需在 T-opencode 专题核实 | `permission.{bash,edit,read,glob,grep,task,skill,lsp,question,webfetch,websearch,external_directory,doom_loop,"*"}` |
| Codex | `~/.codex/config.toml` / 项目 `.codex/config.toml`；CLI `--sandbox <mode>`、`--ask-for-approval <policy>`（[推测] 以及 `--full-auto`、`--dangerously-bypass-approvals-and-sandbox`，本次未能从一手页核实，见未解决问题） | `approval_policy.granular.request_permissions` / `mcp_elicitations` 暗示 app-server 协议存在审批请求事件；[推测] Codex app-server JSON-RPC 有 `ExecCommandApproval` 类请求 | `approval_policy`、`sandbox_mode`、`sandbox_workspace_write.*`、`mcp_servers.<id>.{default_tools_approval_mode,tools.<t>.approval_mode,enabled_tools,disabled_tools,auth}` |
| Gemini CLI | `~/.gemini/policies/*.toml`（User tier）、`--admin-policy` 或系统目录（Admin tier）、extension 自带 policy | 非交互下 `ask_user`→deny；[推测] 通过 ACP 模式可把 ask 转为 `request_permission` | `[[rule]] toolName/decision/priority/argsPattern/commandPrefix/mcpName/modes/allowRedirection/interactive` |
| OpenClaw | `openclaw.json`：`tools.{allow,deny,profile,exec.mode,sandbox.tools.allow}`、`agents.<id>.*`、channel 级策略；CLI `openclaw exec-policy show/preset`、`openclaw approvals get/grants list` | gateway 事件 `exec.approval.requested`/`exec.approval.resolve`（WebSocket 控制面） | allowlist 项 `{pattern, argPattern:"sha256:argv:...", source:"allow-always", lastUsedAt}`、`security/ask/askFallback` |
| Hermes | `~/.hermes/config.yaml`：`approvals.{mode,deny,cron_mode,single_query_mode,unattended_mode}`、`command_allowlist`；`.env`：`*_ALLOWED_USERS`、`GATEWAY_ALLOW_ALL_USERS` | 消息平台内 yes/no 回复；`hermes chat -q`/webhook 走 `unattended_mode` | 见左 |
| Goose | `~/.config/goose/config.yaml` `GOOSE_MODE`；`permission.yaml` `user.{always_allow,never_allow}` | 交互式 Allow/Deny 按钮；[推测] ACP 模式下映射到 `request_permission` | 见左 |
| pi | 扩展包（`pi-permissions.jsonc`）| 扩展 tool-call 拦截 | `defaultPolicy.{tools,bash}`、`tools.<name>`、bash 通配 |
| ACP（协议层，Zed/Gemini/Goose/opencode 等支持） | `session/new` 时的 mode（Session Modes）| `session/request_permission` | `toolCall.kind`、`options[].kind`、`outcome` |

## 会话模型

权限与会话的绑定关系是网关映射"群→session"时最容易踩坑的部分：

- **Claude Code**：`allow_always` 类决策（"Yes, and don't ask again"）按"仓库 + 命令前缀"持久化到 `settings.local.json`；hook 输入含 `session_id` 与 `agent_id`（子代理），可用于按 session 隔离审批状态。工作目录（`cwd` + `additionalDirectories`）是文件权限的作用域锚点，`/cd` 会切换项目配置。
- **ACP**：`allow_always` 由 Agent 侧持久化（如 Gemini CLI 写入 agent home），`allow_once` 只在当前 session 内存有效——网关若代表多个群作为 Client，必须自己维护"按群的 allow_always 表"，而不能依赖引擎的全局持久化，否则 A 群批准的命令会在 B 群生效。
- **OpenClaw**：allowlist 以 `agents.<agentId>` 分作用域，天然与"每群一个 agent"对齐；`lastUsedAt` 支持过期清理。
- **AgentCore Policy**：temporal policy 依赖 `x-amzn-bedrock-agentcore-policy-session-id`，即"策略 session"与"对话 session"可以一一对应，这是把"先审批后执行"、"每 session 限频"、"累计花费上限"编码进策略语言的样板。
- **Hermes**：`/yolo` 仅当前 session；`command_allowlist` 全局持久——同样存在跨群泄漏风险。

结论：**审批记忆（allow_always）的作用域必须由网关持有并按主体（群/租户）分片**，只把 `allow_once` 语义透传给引擎；引擎侧的持久化白名单应被清空或指向网关生成的每群独立 home 目录。

## 权限与安全

### 各引擎权限模型细节（补充说明）

**Claude Code 规则语法要点（来源 #1）**
- Bash 规则对 shell 操作符敏感：`&&`、`||`、`;`、`|`、`|&`、`&`、换行会被拆成子命令，每个子命令必须独立匹配；内建剥离 `timeout/time/nice/nohup/stdbuf/command/builtin/noglob/xargs` 等包装器；`Bash(devbox run *)` 这类环境运行器**不**剥离，会放行任意内层命令（坑）。
- `Bash(command:rm *)` 形式被忽略并告警；`Bash(git:*)` 与 `Bash(git *)` 等价。
- 文件规则只认 `Read(path)` 与 `Edit(path)`；`Write(...)`、`Glob(...)` 路径规则会被接受但永不生效（v2.1.210+ 会告警）。路径前缀语义：`//` 绝对、`~/` 家目录、`/` 相对 settings 来源、`path` 相对 cwd。allow 规则要求 symlink 路径与目标都匹配，deny 规则任一匹配即拒绝。
- 输出重定向 `>`、`>>`、`2>` 目标按文件写入检查。
- MCP：`mcp__server`、`mcp__server__*`、`mcp__server__tool`；deny/ask 可用 `mcp__*` 全局 glob，allow 的 glob 必须锚定到具体 server。带括号的 `mcp__x(...)` 参数规则在 settings 中被跳过，只能用 `--disallowedTools`。
- `dontAsk` 模式是"无人值守"首选：未预授权即拒绝，不会挂起等待。
- Hook 与规则关系：deny/ask 规则不受 hook `allow` 影响；exit 2 的 hook 优先于 allow 规则。因此"allow 全部 Bash + hook 黑名单"是官方建议的细粒度方案。

**Codex（来源 #6/#7）**：`approval_policy` 的 `granular` 对象把审批拆为 `sandbox_approval`（沙箱逃逸审批）、`rules`（规则文件命中）、`mcp_elicitations`（MCP elicitation）、`request_permissions`、`skill_approval` 五个独立开关——这是目前粒度最细的"审批种类"枚举，对网关设计"审批类型"字段很有参考价值。`sandbox_mode=workspace-write` 时默认无网络（`network_access=false`），`.git`/`.codex` 受保护（[推测]，本次未核实）。

**OpenClaw（来源 #10/#11）**：三层叠加——gateway 级 `tools.exec.mode`、host 级 `security/ask/askFallback`、agent 级 allowlist。`argPattern: "sha256:argv:..."` 把整条 argv 哈希后绑定，是各引擎里唯一"精确到参数"的白名单形态。`systemRunPlan` 在审批时冻结执行计划，防止 TOCTOU。`askFallback` 明确了"无 UI 时的兜底效果"，对应我们网关的"审批超时策略"。

**Hermes（来源 #12）**：用户身份鉴权在网关层（`*_ALLOWED_USERS`，优先级：per-platform allow-all → DM pairing → 平台白名单 → 全局白名单 → 默认拒绝）；命令审批在 agent 层。两者分离与本赛题"网关管主体、引擎管客体"的分工一致。注意 docker/modal 后端会**跳过审批**，即隔离环境即视为可信——网关若用容器化引擎，仍应保留"外部副作用"（网络、消息发送）的审批。

### 策略引擎选型

| 引擎 | 模型 | 适合我们的点 | 局限 |
|---|---|---|---|
| Cedar（AWS，开源） | PARC：principal/action/resource/context；默认拒绝、forbid 优先；schema 校验 + 自动推理分析（永远允许/永远拒绝检测） | AgentCore Policy 已证明"MCP tool call → Cedar 请求"的自动映射可行：JWT `sub`/claims → principal+tags，tool name → action，tool input → context（来源 #15）。Dogwood 扩展提供 temporal 条件（先审批/限频/累计），恰好覆盖"预算"与"审批流"两类客体 | Rust 核心，其他语言需 FFI/WASM；无 ask 效果（需在网关把"未命中 permit 但命中 review 标签"映射为 ask） |
| OPA/Rego | 通用策略即数据，JSON 输入任意结构 | 决策可返回任意结构（如 `{effect:"ask", reason, approvers}`），天然支持 allow/deny/ask/audit 四效果 | 不可形式化验证；Rego 学习成本；性能取决于策略 |
| Casbin | RBAC/ABAC/ACL 模型文件 + policy CSV，多语言 | 主体=群/用户/租户 的 RBAC with domains（多租户）开箱即用 | 表达力弱于 Cedar/Rego，条件表达式有限；效果只有 allow/deny |
| AWS AgentCore Identity/Policy | 托管：Identity 负责 OAuth 凭据保管与代理用户授权（inbound/outbound auth），Policy 负责 Gateway 前 Cedar 授权 | "网关 + 策略引擎 + 工具网关"三件套即本题架构的云端参考实现 | 绑定 AWS；只覆盖 MCP 工具，不覆盖本地 Bash/文件 |
| Microsoft Entra Agent ID | blueprint → agent identity；identity 无自有凭据，借用 blueprint 凭据（来源 #18） | 为"每群一个 agent identity、共享一个 blueprint"提供 IdP 侧模型；Datadog 指出 blueprint 是爆炸半径集中点 | 企业 Entra 绑定 |
| SPIFFE/SPIRE | SVID 短期凭据 + 运行时证明；WIT-SVID 对齐 IETF WIMSE（来源 #19） | 引擎进程/容器的工作负载身份，替代长期 API key；用于引擎 ↔ 网关 ↔ MCP 之间的 mTLS/JWT | 需 SPIRE 基础设施；与"用户委托"是两层问题 |

### 安全基线

- **OWASP ASI 2026 十项 → 网关控制点映射**（来源 #16）：ASI01 目标劫持 → 系统提示与用户输入分离、工具输出标记为不可信；ASI02 工具滥用 → 参数级策略（argPattern/argsPattern）与限频；ASI03 身份与特权滥用 → 每群独立主体、最小权限、禁止引擎持有长期凭据（SPIFFE/Entra）；ASI04 供应链 → 插件/skill/MCP server 白名单与签名（Claude Code 有 project MCP server 信任提示）；ASI05 意外代码执行 → sandbox_mode/Claude sandbox/容器；ASI06 记忆投毒 → 记忆写入审批与按群隔离；ASI07 不安全代理间通信 → 子代理/agent team 继承受限策略（Claude hook 输入含 `agent_id`）；ASI08 级联失败 → 预算与熔断（Dogwood 累计阈值）；ASI09 人机信任利用 → 审批消息必须展示原始命令/参数而非模型摘要；ASI10 失控代理 → 全量审计事件 + kill switch。
- **MCP OAuth（来源 #17）**：MCP server = Resource Server，RFC 9728 元数据发现 + RFC 8707 resource 绑定；网关应作为 OAuth client 集中持有 token（对齐 AgentCore Identity 的 outbound auth），引擎只拿到短期、按群/用户下发的 token。Codex `mcp_servers.<id>.auth = oauth` 与 Claude Code MCP OAuth 都在引擎内完成授权码流程——多群共享引擎时这会把用户凭据混在一起，网关应改为注入 `bearer_token_env_var`/`http_headers`。
- **Prompt injection 与工具输出信任边界**：Claude Code 明确"权限由 Claude Code 而非模型执行，CLAUDE.md 只影响意图不构成边界"；OpenClaw/Claude 都在模型看到工具 schema 之前删除被 deny 的工具（减少诱导面）。网关侧应把所有工具返回（网页、文件、其他 agent 消息）打上来源标签并禁止其中的"审批语句"生效——Hermes 的"回复 yes 即审批"在群聊中尤其危险：必须校验审批者身份且审批消息不能来自 agent 自己发出的内容。
- **群聊多用户身份**：Hermes 的分层用户白名单和 OpenClaw 的 per-agent/channel 策略是仅有的"消息平台原生"模型；Claude Code/Codex/Gemini 完全没有用户概念，主体只能由网关映射。因此"主体"（群/用户/租户）**不应下沉到引擎**，引擎只见"这个 session 的有效策略"。

## 扩展机制与资产

与策略相关的资产格式：Claude Code `settings.json`（JSON，可随 plugin 分发，managed 层可由 MDM/系统目录下发）；Gemini `*.toml` policy（extension 可自带 Extension tier 策略）；opencode `opencode.json`；OpenClaw `openclaw.json` + sqlite 中的 `exec_approvals_config`；Hermes `config.yaml`；Codex `config.toml` + rules 文件。这些都是**引擎特有的编译目标**，网关的策略资产应是单一来源（如 Cedar/Rego/自定义 JSON），通过"策略编译器"生成上述格式。其他扩展机制（插件、skill、MCP）不属本题，见对应专题；但需记住：**plugin/extension 自身可携带策略**（Gemini Extension tier、Claude plugin settings），网关必须把它们纳入"引擎实际生效策略"的审计。

## 记忆

不适用（本题不研究记忆机制）。仅一条与安全相关的结论：ASI06 记忆投毒要求记忆写入（如 Gemini `save_memory` 工具、Claude `CLAUDE.md`/auto-memory）纳入策略客体；Gemini 官方策略示例中就把 `save_memory` 与 `write_file` 同列为 deny 对象（来源 #8 搜索结果）。

## 多 Agent 与协作

不适用于本题主体，但有两点约束：(1) 子代理/agent team 必须继承父 session 的策略而非放宽——Claude Code hook 输入的 `agent_id/agent_type` 与 `Agent(Plan)` 规则、OpenClaw per-agent allowlist 是实现点；Claude Code issue #27203 表明默认模式下后台子代理曾不触发 `canUseTool`，需要网关用 hook 层兜底。(2) ASI07：代理间消息也是"工具输出"，同样不可信。

## 可观测性

本题只关注审计维度：Claude Code hook 事件 `PermissionRequest`/`PermissionDenied`/`PostToolUse` 提供完整的审批与执行审计流（含 `tool_use_id`）；OpenClaw `exec.approval.requested/resolve` 事件与 `approvals grants list`；AgentCore Policy 支持 Cedar 自动推理审计与 policy session 事件记录；Hermes 记录审批历史并据此建议白名单。网关统一审计事件建议至少包含：`subject{tenant,group,user}`、`session_id`、`engine`、`tool`、`normalized_action`、`raw_input_hash`、`effect{allow|deny|ask|review}`、`decided_by{rule_id|hook|human:<user>|llm_reviewer}`、`latency_ms`。


## 对我们架构的启示（公共能力 vs 扩展能力映射表、接入参数、风险与坑）

### 公共能力 vs 扩展能力映射表

| 网关统一策略概念 | 公共能力（所有引擎可映射） | 引擎特有扩展（仅透传，不纳入统一语义） |
|---|---|---|
| 效果值 `effect` | `allow` / `deny` / `ask` 三值在 Claude Code、opencode、Gemini、ACP、OpenClaw、Hermes 中都有直接对应（来源 #1/#5/#8/#9/#10/#12） | `review`（LLM 评审）：Claude `auto`、Hermes `smart`、Goose `smart_approve`、OpenClaw `exec.mode: auto`；`defer`（Claude hook） |
| 客体 `tool + argPattern` | 工具名 + glob/前缀匹配：Claude `Bash(git *)`、opencode glob、Gemini `commandPrefix/argsPattern`、Hermes fnmatch | OpenClaw `sha256:argv` 精确哈希；Codex `granular` 五类审批种类；Gemini `allowRedirection` |
| 规则冲突解决 | 网关内部统一为"deny 优先、其次 ask、再 allow"（Cedar forbid 优先同构，来源 #15） | 各引擎编译目标不同：Claude 首个命中、opencode 最后命中、Gemini 数值优先级——由策略编译器分别生成 |
| 运行时审批通道 | 抽象为 `PermissionRequest{session, tool, kind, rawInput, options[]}`，ACP `session/request_permission` 是最完整的协议原型（来源 #9） | Claude `PreToolUse` hook 的 `updatedInput` 改写、OpenClaw gateway WebSocket 事件、Hermes 群内 yes/no |
| 审批记忆作用域 | `allow_once` 透传引擎；`allow_always` 由网关按群/租户分片持有 | 引擎全局白名单（Hermes `command_allowlist`、Claude `settings.local.json`）应清空或指向每群独立 home |
| 沙箱兜底 | 文件系统根 + 网络开关（Claude sandbox、Codex `sandbox_mode`、OpenClaw `tools.sandbox`） | Hermes 容器后端跳过审批（网关仍要保留外部副作用审批） |
| 主体（用户/群/租户） | **不下沉到引擎**；只有 Hermes/OpenClaw 有消息平台原生用户概念 | Hermes `*_ALLOWED_USERS`、OpenClaw channel 级策略作为二道防线 |

### 接入参数（策略编译器输出清单）

- Claude Code：生成 managed `settings.json`（`permissions.{allow,ask,deny,defaultMode:"dontAsk",additionalDirectories}`、`allowManagedPermissionRulesOnly:true`、`disableBypassPermissionsMode:"disable"`），并注册 `PreToolUse` hook 指向网关审批端点；SDK 场景用 `canUseTool` + `managedSettings`。
- Codex：`config.toml` 的 `approval_policy`（无人值守取 `never` + `sandbox_mode=workspace-write`，`network_access=false`）与 `mcp_servers.<id>.tools.<t>.approval_mode`。
- Gemini CLI：以 Admin tier（`--admin-policy`）下发 TOML，非交互下 `ask_user` 自动降为 deny，需网关预先把 ask 类规则转为 ACP 审批。
- opencode：`permission` 对象（注意最后匹配胜出，编译器需反转规则顺序）。
- OpenClaw：`tools.exec.mode=allowlist` + `askFallback=deny`，allowlist 写入 `agents.<群id>`。
- Hermes：`approvals.mode=manual`、`unattended_mode=deny`、`cron_mode=deny`，白名单按群独立 config。
- 统一审计事件字段见"可观测性"一节。

### 风险与坑

1. **规则顺序语义相反**：Claude 首个命中 vs opencode 最后命中，编译器若直接复制规则列表会导致 deny 被覆盖。
2. **Bash 包装器绕过**：Claude `Bash(devbox run *)` 等环境运行器不剥离内层命令；OpenClaw 靠 argv 哈希才能真正锁参数。
3. **非交互模式下 ask 静默变 deny**（Gemini、Claude `dontAsk`），若网关未转为审批请求会表现为"任务莫名失败"。
4. **allow_always 跨群泄漏**：ACP/Hermes/Claude 的持久化白名单是全局的，必须由网关接管。
5. **文件规则失效**：Claude `Write(...)`/`Glob(...)` 路径规则被静默接受但不生效，只认 `Read/Edit`。
6. **MCP OAuth 在引擎内完成**会把多用户凭据混合（来源 #17），应改为网关持 token、经 header 注入。
7. **子代理绕过 canUseTool**（Claude issue #27203），需 hook 层兜底。
8. **审批消息来源伪造**：Hermes"回复 yes 即审批"必须校验审批者身份，且忽略来自工具输出/agent 自身内容中的审批语句（ASI09）。
9. **plugin/extension 自带策略**（Gemini Extension tier、Claude plugin settings）会改变实际生效策略，需纳入审计。

## 未解决问题

1. Codex `--full-auto`、`--dangerously-bypass-approvals-and-sandbox` 等 CLI 标志及 app-server JSON-RPC 审批请求（`ExecCommandApproval` 类）的确切形态未从一手页核实；`.git`/`.codex` 受保护亦为推测。
2. opencode 是否存在官方运行时拦截点（插件 `tool.execute.before` 是否可返回 deny）待 T-opencode 专题核实。
3. Goose 与 Gemini 在 ACP 模式下 `ask` 是否严格映射为 `session/request_permission`，以及 `allow_always` 持久化位置，需实测。
4. Claude Code `auto` 模式分类器的判定标准与可审计性不公开，无法与其他引擎的 LLM reviewer 做一致性比较。
5. Cedar 无 `ask` 效果，"review 标签→ask"的映射方案需原型验证；Dogwood temporal policy 是否开源/可离线使用未知。
6. SPIFFE WIT-SVID 与 IETF WIMSE 仍在 Incubating/草案阶段，作为引擎工作负载身份的落地时点不确定。
7. 各引擎 hook/审批通道的超时默认值与超时后效果（对应 OpenClaw `askFallback`）尚未逐一核实。

## 来源列表

1. Claude Code Permissions — https://code.claude.com/docs/en/permissions
2. Claude Code Hooks — https://code.claude.com/docs/en/hooks
3. Claude Agent SDK Permissions — https://code.claude.com/docs/en/agent-sdk/permissions
4. opencode Permissions — https://opencode.ai/docs/permissions/
5. Codex Config Reference — https://learn.chatgpt.com/docs/config-file/config-reference
6. Gemini CLI Policy Engine — https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/reference/policy-engine.md
7. ACP Tool Calls / request_permission — https://agentclientprotocol.com/protocol/tool-calls
8. OpenClaw Exec Approvals — https://docs.openclaw.ai/tools/exec-approvals
9. OpenClaw Tools — https://docs.openclaw.ai/tools
10. Hermes Agent Security — https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/security.md
11. Goose 官方文档 / DeepWiki（GOOSE_MODE、PermissionJudge）
12. pi-permission-system（GitHub MasuRii）与 pi-mono `permission-gate.ts` 示例
13. AWS AgentCore Policy Core Concepts — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-core-concepts.html
14. OWASP Top 10 for Agentic Applications 2026 — https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/ ；promptfoo 映射 — https://www.promptfoo.dev/docs/red-team/owasp-agentic-ai/
15. MCP Authorization Specification (2025-06-18) — https://modelcontextprotocol.io/specification
16. Microsoft Entra Agent ID Blueprint — https://learn.microsoft.com/en-us/entra/agent-id/agent-blueprint
17. SPIFFE / WIMSE 相关博客（stacklok、riptides、iden）
18. Claude Code GitHub issues #41791、#27203
