# T06 "opendesk" 是什么 + 通用 Harness API 的先行者

> 调研日期：2026-09-04。所有事实以联网一手来源为准，标注"[已确认]"（一手来源）/"[推测]"；关键断言经第二来源交叉验证者标注"[已交叉验证]"。

## 摘要

1. **"opendesk" 无法确认为一个 Agent 引擎**。全网检索唯一命中的开源项目 vitalops/opendesk 是一个 Computer-Use **MCP 工具服务器**（截图/键鼠/OCR/工作流录制/多机远控，约 86 stars），不是 harness；Harness-Bench 论文、160+ 项的 best-of 榜单、Tencent Cloud 五 harness 对比均无此名。[推测] 赛题中的 opendesk 是 OpenHands/OpenClaw 的误写或主办方内部代号，建议澄清并准备 OpenHands 兜底；若按字面接入，应建模为可挂到任意引擎的 MCP 资产。
2. **通用 Harness API 已分化为两条路线**：(a) 库级适配器——openharness.ai（jeffrschneider/OpenHarness，MIT）用语言包适配 Letta/Goose/Deep Agents/Anthropic SDK，但把 Claude Code CLI 标为 aspirational（"No public API"）；其 Capability Manifest（11 个 domain × `{supported, operations[], limitations[]}` + 501）和统一事件词汇是最可复用的设计。(b) 进程级网关——HarnessRouter（Apache-2.0，2026-08-14 开源）+ **Unified Harness Protocol 2026-08-11**：以 OpenAI Responses 同形的 `/v1/responses` + SSE + `previous_response_id` 驱动 Claude Code/Codex/Pi/DSH/Hermes 等上游 CLI，harness/task/session 三层对象、per-session OS 用户隔离、63 项 conformance 检查分三档。这与赛题"网关+引擎"形态几乎重合，是最重要的参考实现。
3. HKUDS/OpenHarness 与 AgentBoardTT/openharness 并非通用 API，而是 Claude Code 的开源重实现（"通用"只在 LLM provider 层），但它们印证了 `default/accept_edits/plan/bypass` 四态权限、SKILL.md、PreToolUse/PostToolUse hooks 已成事实标准。harness-loom 证明"一份资产源编译多引擎配置"可行；Harness-Bench 给出 Completion/Security/Process/Efficiency 的归一化评测维度并主张按 model×harness 报告能力。
4. **对我们的启示**：采用 UHP 式三层对象 + Responses 同形 API 作为稳定上层；能力协商用 Open Harness 式 manifest；memory/subagent 等差异最大的域放 extensions 不做归一化；"认证"= 跑 conformance（重点测渐进流与真取消）；引擎以上游 CLI 首启安装、版本钉死、子进程运行。

## 关键事实（表格）

| # | 事实 | 来源 | 置信度 | 交叉验证 |
|---|------|------|--------|----------|
| 1 | 搜索 "opendesk" 在 agent 语境下唯一命中的开源项目是 **vitalops/opendesk**：一个 Computer-Use 框架（截图/鼠标键盘/OCR/工作流录制/定时/远程机控制），以 **MCP server**（`opendesk-mcp`）形式接入 Claude Code / Cursor 等，MIT，约 86 stars（页面显示） | https://github.com/vitalops/opendesk | 高（一手） | 部分：WebSearch 摘要与 README 一致 |
| 2 | 在 Harness-Bench 论文、Tencent Cloud 五 harness 对比文、best-of-Agent-Harnesses（160+ 项目）中均**未出现** "opendesk"；赛题中的 opendesk 更可能是笔误/内部代号（详见"未解决问题"） | https://arxiv.org/html/2605.27922v1 ；https://www.tencentcloud.com/techpedia/147665 ；https://github.com/RyanAlberts/best-of-Agent-Harnesses | 中（证据为"缺席"） | [已交叉验证]（三个独立来源均无） |
| 3 | openharness.ai = jeffrschneider/OpenHarness（MIT），定位 "Universal API for AI Agent Harnesses"，适配 Letta / Goose / LangChain Deep Agents / Anthropic Agent SDK（Claude Code CLI 标为 🎯 aspirational，"No public API"） | https://openharness.ai/ ；https://raw.githubusercontent.com/jeffrschneider/OpenHarness/main/spec/HARNESS_SUPPORT_MATRIX.md | 高 | [已交叉验证]（官网 vs. 仓库 spec；注意官网称 Claude Code 为 4 个 production adapter 之一，仓库矩阵则标为 aspirational，存在不一致） |
| 4 | Open Harness API v0.2.0：`ExecuteRequest{harnessId, message, agent_id?, skills[], model, max_tokens, temperature}`；执行事件 `text/thinking/tool_call_start/tool_call_delta/tool_call_end/tool_result/artifact/progress/error/done`；会话双向消息 client→`message/stdin/cancel`，server→`text/tool_call/stdout/prompt/done`；传输 REST/SSE/WebSocket/Webhook | https://openharness.ai/api-reference.html | 高 | 单一来源 |
| 5 | Open Harness Capability Manifest v0.1.0：`GET /harnesses/{harnessId}/capabilities` 返回按 domain（agents/skills/mcp/execution/sessions/memory/subagents/files/hooks/planning/models）组织的 `{supported, operations[], limitations[]}`；不支持的操作返回 `501 Not Implemented`；协商策略 fail-fast / graceful degradation / feature flags | https://raw.githubusercontent.com/jeffrschneider/OpenHarness/main/spec/CAPABILITY_MANIFEST.md | 高 | [已交叉验证]（README 提及 capability-aware + spec 文件原文） |
| 6 | **HarnessRouter**（Apache-2.0）2026-08-14 开源 Community Edition 并发布 **Unified Harness Protocol (UHP)** 版本 `2026-08-11`；一个 Docker 容器（端口 3000，SQLite + volume），首启动态安装 Claude Code / Codex / Pi / DSH / Hermes 五个 CLI；官网称支持 8 个 harness（另含 OpenCode、Qwen Code、Cline） | https://github.com/HarnessRouter/harnessrouter ；https://harnessrouter.ai/open-source ；https://aijourn.com/harnessrouter-open-sources-... | 高 | [已交叉验证]（README 安装日志 `backends available: claude codex hermes pi dsh` vs 官网 8 个列表；README 正文另一处只写 "Codex, Claude Code, and Hermes"——版本演进导致的不一致） |
| 7 | UHP 的任务面**刻意与 OpenAI Responses API 同形**：`POST /v1/responses {input, model, metadata.harness_id, stream}`，SSE 流，最后事件携带完整 `response` 对象（含 artifacts/files）；续聊用 `previous_response_id`；扩展只放在 `metadata` 与少量附加字段 | https://unifiedharnessprotocol.org/ ；https://raw.githubusercontent.com/HarnessRouter/harnessrouter/main/protocol/README.md | 高 | [已交叉验证]（官网与仓库 protocol/README 一致） |
| 8 | UHP 有 10 个规范章节（Architecture/Lifecycle/Harnesses/Tasks/Streaming/Sessions/Files/Errors/Security/Schema）、OpenAPI 3.1 + JSON Schema 2020-12、63 项一致性检查分 Core(40)/Extended(+8)/Full(+15) 三个 conformance class；`uhp-conformance --base-url --api-key --class full` | https://raw.githubusercontent.com/HarnessRouter/harnessrouter/main/protocol/conformance/README.md | 高 | [已交叉验证]（官网 "63 runnable checks"） |
| 9 | HarnessRouter 隔离模型：容器以 root 启动后降权，**每个 session 一个 OS 用户**，独占该 session 的 workspace；agent 进程环境中不含产品密钥；provider 连接通过 `HR_SECRET_GLOBAL_HARNESS_CONN_*` 与 per-backend `…POLICY_CLAUDE/CODEX/HERMES` 策略绑定 | https://raw.githubusercontent.com/HarnessRouter/harnessrouter/main/README.md | 高 | 单一来源 |
| 10 | HKUDS/OpenHarness（MIT，v0.1.0 2026-04-01，页面显示 15.6k stars）：Python 重实现 Claude Code 风格 harness，13 个子系统（Engine/Tools 43+/Skills/Plugins/Permissions/Memory/Coordinator/Tasks/Hooks/Commands/Prompts/Config/UI），权限 Default(ask)/Auto/Plan；内置个人 agent **Ohmo**，`ohmo gateway start` 接入 Feishu/Slack/Telegram/Discord | https://github.com/HKUDS/OpenHarness | 高 | 部分（WebSearch 摘要与 README 一致） |
| 11 | AgentBoardTT/openharness（MIT，页面显示 12 stars）：Python SDK+CLI，`harness.run(task, provider, model, permission_mode, max_turns)` 异步产出 `TextMessage/ToolUse/Result`；权限 `default/accept_edits/plan/bypass`；JSONL 持久 session；4 个子 agent（general/explore/plan/review） | https://github.com/AgentBoardTT/openharness | 高 | 单一来源 |
| 12 | Harness-Bench（arXiv 2605.27922，2026-05-27）：106 个沙箱任务、5,194 条轨迹、6 个可配置 harness（OpenClaw/ZeroClaw/Hermes/Moltis/NullClaw/NanoBot）+Codex、8 个模型；指标 Completion / Security(门控) / Process(Robustness+Tool Use+Consistency) / Efficiency；结论"能力应按 model-harness 配置报告" | https://arxiv.org/abs/2605.27922 ；https://arxiv.org/html/2605.27922v1 | 高 | [已交叉验证]（abs 与 html 全文） |
| 13 | harness-loom（KingGyuSuh，2026-04-20 公布）：不是引擎，是**配置工厂**——在 `.harness/loom/` 定义一份规则，派生出 Claude/Codex/Gemini 三家 CLI 的原生配置 | https://dev.to/kinggyusuh/open-sourcing-my-personal-ai-agent-harness-for-production-harness-loom-3mob | 中（仅博客，repo 未直接抓取） | 否 |
| 14 | best-of-Agent-Harnesses：160+ 项目、12 类，按 stars（2026-08-30 快照）+ headless-ready(★)/durability(✱) 标记评分；定义"model thinks, harness decides what that thinking is allowed to touch" | https://github.com/RyanAlberts/best-of-Agent-Harnesses | 高 | 单一来源 |

## 架构与工作原理

### 1. "opendesk" 候选辨析

对 `opendesk agent harness`、`"opendesk" AI agent github`、`opendesk 智能体 开源`、`"OpenDesk" 钉钉/飞书/群助手` 等 5 组中英文检索的结果：

- **候选 A：vitalops/opendesk（已确认存在）**。README 自述 "Control 1 or more machines using computer use tools that integrates with your agents"。它是 **工具层**（给 agent 装"手和眼"），不是 agent loop/harness：安装 `pip install 'opendesk[core,mcp]'`，`opendesk install` 注册到 Claude Code，其他 MCP 客户端配置 `{"mcpServers":{"opendesk":{"command":"opendesk-mcp"}}}`。工具集：`screenshot / ui / mouse / keyboard / app / clipboard / ocr / learn / schedule`。远程控制通过 `opendesk pair`（6 位配对码）+ `opendesk serve`，X25519 握手 + ChaCha20-Poly1305 帧加密，工具参数 `peer=<name>` 指向远端机。另有 JS SDK `@vitalops/opendesk-sdk` 与 Python SDK（Anthropic/OpenAI/LangChain 兼容）。约 86 stars，体量很小。
- **候选 B：openDesk（德国 ZenDiS 主权办公套件）** —— 与 agent 无关，排除（[推测]，未额外抓取）。
- **候选 C：赛题笔误/口误**。赛题列举 "pi, opencode, hermes, opendesk, dsh"，其中 pi/opencode/hermes/dsh 恰是 HarnessRouter 与 Tencent Cloud 对比文的标准五件套，第五个通常是 **Claude Code / Codex / OpenHands / OpenClaw**。三份独立的 harness 综述/榜单（Harness-Bench、best-of 榜单 160+ 项、Tencent Cloud 对比）都没有 "opendesk"，因此 [推测] 它很可能是 **OpenHands** 或 **OpenClaw/opencode** 的误写，或是主办方内部业务系统的引擎代号。
- **结论**：若按字面接入，vitalops/opendesk 应被建模为**一个 MCP 工具提供者**（可挂到任意引擎的 MCP 配置中），而非一个可切换的 Agent 引擎；在方案中建议以"待主办方澄清"方式处理，并同时准备 OpenHands 适配器作为兜底。

### 2. 两代"通用 Harness API"的架构分歧

调研发现存在两种截然不同的"统一抽象"思路：

**(a) 库级适配器（in-process SDK）— Open Harness (openharness.ai)、AgentBoardTT、HKUDS**
- openharness.ai 的适配器是语言包：`@openharness/adapter-anthropic-agent`（TS）、`openharness-letta` / `openharness-goose` / `openharness-deepagent`（Python）。适配对象是**有 SDK/服务端 API 的框架**（Letta 有 REST、Goose 有 Rust/MCP、Deep Agents 是 LangGraph 库）。它把 Claude Code CLI 标为 🎯 "No public API"，说明**纯 CLI 型 harness 不适合库级适配**。
- 它同时定义了 REST 面（`https://api.openharness.org/v1`，Bearer token，"MAPI v0.94" Markdown API 文档格式），资源包括 harnesses / agents / skills / sessions / executions / tools / mcp / memory / files / conformance / diagnostics。
- AgentBoardTT/openharness 与 HKUDS/OpenHarness 不是"通用 API"，而是**自己就是一个 harness**（Claude Code 的开源重实现），"通用"体现在 LLM provider 层（Anthropic/OpenAI/Gemini/Ollama 一键切换），而不是 harness 层。

**(b) 网关级协议（out-of-process HTTP）— HarnessRouter / UHP**
- 把 harness 当作**子进程 CLI**在容器内以独立 OS 用户运行，对外暴露一个 Responses-兼容的 HTTP API。这正是赛题"Agent 网关 + Agent 引擎"的形态：网关维护 harness 配置对象（`base` = 运行时 + model + instructions + limits）、task（一次运行）、session（跨 task 的对话）、files/artifacts。
- 首启日志展示了它的引擎接入方式：`installing Claude Code (Anthropic's terms apply)… installing Codex (Apache-2.0)… installing Pi (MIT) and its MCP adapter (MIT)… installing DeepSeek Harness (MIT, developer preview — version-pinned)… installing Hermes…`，即**引擎以上游 CLI 原样安装、版本钉死**，而不是重写。
- UHP 明确声明："UHP is not a model API… Model APIs give you a *turn*… UHP gives you a *task*… The unit of exchange is a job, not a completion."

### 3. 基准与榜单对 "harness" 的定义

- Harness-Bench：harness = "the system layer that manages context, tools, state, constraints, permissions, tracing, and recovery"。评测在保留各 harness 原生执行行为的前提下统一任务/预算/协议，与我们"网关稳定、引擎原生"的思想一致。
- HKUDS：harness = "Tools + Knowledge + Observation + Action + Permissions"，模型提供智能，harness 提供"hands, eyes, memory, safety boundaries"。
- best-of 榜单："the model thinks, the harness decides what that thinking is allowed to touch"，并断言"swapping the agent harness changed pass@1 more than many model upgrades"。

## 可编程接入面

### UHP / HarnessRouter（HTTP，OpenAI Responses 同形）[已确认]
```bash
# 发现可运行的 harness
curl -s https://your-uhp-server/v1/harnesses -H "Authorization: Bearer $KEY"
# 提交一个任务并跟随 SSE 流
curl -s -N https://your-uhp-server/v1/responses \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{ "input": "Summarise README.md in three bullets.",
        "model": "claude-sonnet-4.6",
        "metadata": { "harness_id": "chrn_…" },
        "stream": true }'
```
- 续聊：下一次请求带 `previous_response_id`。取消：Sessions 章节定义 cancel（一致性检查 C-03 要求"真正停下来并进入终态"）。
- 幂等：Errors 章节定义 idempotency；错误信封形如 `{"error":{"type":"invalid_request_error","code":"invalid_input","message":"no provider configured for backend 'codex'…"}}`。
- Harness CRUD（Full class）：创建 harness 需 `base`（claude/codex/hermes/pi/dsh）、model、instructions、limits；Full 级检查还包含 "skill-folder round trip、MCP and disabled-tool persistence、session sharing"，说明 harness 对象上可挂 **SKILL.md 目录、MCP 服务器配置、禁用工具列表**。
- 部署：`docker run -d -p 127.0.0.1:3000:3000 -v harnessrouter:/data harnessrouter/harnessrouter`；环境变量 `HR_AUTH_USER/HR_AUTH_PASSWORD`；provider 连接 `HR_SECRET_GLOBAL_HARNESS_CONN_<NAME>='{"name","provider","api_key","base_url"}'`，per-backend 策略 `…POLICY_CLAUDE / …POLICY_CODEX / …POLICY_HERMES`。
- 版本协商与能力发现在 Lifecycle 章节（"Version negotiation, capability discovery"），三档 conformance class（core/extended/full）本身就是一种粗粒度能力声明。

### Open Harness (openharness.ai) [已确认]
- REST 基址 `https://api.openharness.org/v1`，Bearer；执行请求 `ExecuteRequest{harnessId, message(1-100000 chars), agent_id?, skills[]?, model?, max_tokens(1-200000)?, temperature(0-1)?}`。
- 流事件：`text | thinking | tool_call_start | tool_call_delta | tool_call_end | tool_result | artifact | progress | error | done`。
- 交互式会话 WebSocket：client→`message | stdin | cancel`；server→`text | tool_call | stdout | prompt | done`（`prompt` 即引擎向用户提问/请求批准的回传通道）。
- 计划事件：`task.added | task.updated | task.removed | plan.reordered`；一致性事件：`test.started | test.passed | test.failed | progress | done`。
- 工具注册 `RegisterToolRequest{name, description, input_schema, handler}`；MCP 连接 `ConnectMcpServerRequest{name, transport}`。
- Webhook 回调 30s 超时，指数退避 1min→5min→30min→2hr；agent bundle ≤50MB，skill ≤10MB 且根目录名须匹配。

### AgentBoardTT/openharness（Python SDK）[已确认]
```python
async for msg in harness.run("Refactor database module",
        provider="openai", model="gpt-4.1",
        permission_mode="accept_edits", max_turns=50):
    match msg:
        case harness.TextMessage(text=t, is_partial=False): ...
        case harness.ToolUse(...): ...
        case harness.Result(...): ...
```

### HKUDS/OpenHarness（CLI）[已确认]
`oh setup`（provider 配置）、`oh`（交互）、`oh -p "…"`（单次 prompt 输出到 stdout，可作为 headless 接入面）、`oh --dry-run -p`、`ohmo init`、`ohmo gateway start`（把 agent 挂到 Feishu/Slack/Telegram/Discord）。

### vitalops/opendesk（MCP server）[已确认]
`opendesk install`（注册到 Claude Code）；`{"mcpServers":{"opendesk":{"command":"opendesk-mcp"}}}`；远程：`opendesk pair` / `opendesk pair-with <host> <code> --name mini` / `opendesk serve`；工具参数 `peer=mini`。

## 会话模型

| 项目 | 会话单位 | 续接方式 | 隔离 | 备注 |
|---|---|---|---|---|
| UHP/HarnessRouter | `harness`(配置) → `task`(一次运行) → `session`(跨 task 对话) | `previous_response_id` | 每 session 一个 OS 用户 + 独立 workspace | Extended 级含 session 列表/检视；Full 级含 session sharing（只读分享链接，R-01…R-08 要求分享链接**不能**继续任务/取消/上传） |
| Open Harness | `sessions` domain：`create/resume/fork/history/named/delete` | resume | 由底层 harness 决定 | 支持矩阵显示 fork 几乎无人原生支持（仅 Letta ⚠️），Claude Code 的 create/resume/history 均为 ⚠️ |
| AgentBoardTT | JSONL 持久化 session | 文件级 | 进程级 | 与 Claude Code 的 `~/.claude/projects/*.jsonl` 同构 |
| HKUDS | `/resume` 恢复既往会话 | 命令 | 进程级 | 对应 Claude Code `--resume` |
| vitalops/opendesk | 不适用（工具层无会话，仅 peer 配对状态） | — | — | — |

**对群助手场景的映射**：UHP 的三层（harness/task/session）与赛题"群 → session"天然对应——一个群绑定一个 UHP session（或一个 harness 实例 + session），每条群消息是一个 task，用 `previous_response_id` 保持连续性；不同群的 session 由不同 OS 用户/workspace 隔离。

## 权限与安全

- **UHP/HarnessRouter**：安全由三层构成——(1) 进程隔离：root 启动仅用于 `setuid` 到 per-session 用户，产品自身以非特权用户运行，不需 `--privileged`/`--cap-add`；(2) 密钥隔离：agent 进程环境不含产品 secret，provider key 在 turn 时解析注入，"The agent's sandbox never receives" 数据库连接串；(3) 协议层：Security 章节 + conformance 中的 path-traversal probes、download headers 检查、session sharing 的拒绝矩阵。**注意**：UHP 的能力声明中未见"工具级审批/permission prompt"抽象（官网与 protocol/README 未提及），[推测] 其模型是"服务器端预配置 + 无人值守运行"，交互式审批需通过 `prompt`/`stdin` 类机制或由 harness 自身的 permission mode 处理。
- **Open Harness**：`hooks` domain（`pre-tool/post-tool/stop/custom/events`）提供拦截点；WebSocket 会话 `prompt` 事件可承载审批；但没有独立的 `permissions` domain——权限被视作各 harness 私有配置。
- **AgentBoardTT**：`permission_mode ∈ {default, accept_edits, plan, bypass}`；**HKUDS**：Default(ask)/Auto(allow)/Plan(read-only) + path rules + command denial。两者完全照搬 Claude Code 的 `--permission-mode` 语义，说明**该四态枚举已成事实标准**，可作为网关的公共权限抽象。
- **vitalops/opendesk**：OS 级权限（macOS Screen Recording/Accessibility），远程链路 X25519 + ChaCha20-Poly1305，仅接受已配对 peer。

## 扩展机制与资产

- **Open Harness 把"资产"拆成三个一等域**：`agents`（create/update/delete/clone/export/import，bundle ≤50MB）、`skills`（register/install/discover/version/rollback/validate，≤10MB，根目录名须匹配）、`mcp`（connect/disconnect/tools/resources/prompts）；另有 `tools`（register/unregister/list/invoke）。官网还提到 **Open Agent Format (OAF)**——"an open standard for packaging AI agents"（官网搜索摘要提及，仓库 README 未见，[推测] 处于早期/文档不同步）。
- **UHP**：harness 对象承载 instructions、skill 目录（SKILL.md 往返被列入 Full 一致性检查）、MCP 配置、disabled tools；即"资产 = harness 配置的一部分"，随 harness CRUD 持久化。
- **HKUDS/OpenHarness**：Plugins = commands + hooks + agents + MCP servers 四类；Skills 为按需加载的 Markdown；Prompts 子系统注入 `CLAUDE.md`——完全沿用 Claude Code 的资产格式（`.claude/` 目录约定），故 Claude Code 生态的 skills/hooks 可近乎零成本复用。
- **harness-loom**：反向思路——不统一运行时，而是**统一资产源**：`.harness/loom/` 一份 canonical rules（producer/reviewer pairs、task shapes、review rules、skills、hooks、security compliance），编译成 Claude / Codex / Gemini 各自的原生配置文件。这是"统一 AI 资产模型"在无协议层情况下的最小可行实现。
- **vitalops/opendesk**：本身即一个 MCP 资产；`learn`（录制工作流）产出可回放的 workflow，`schedule` 支持 `every 30m` / `every day at 09:00` / cron。

## 记忆

- **Open Harness `memory` domain**：`blocks`（命名记忆块）、`search`、`archive`、`cross-session`、`read-only`；`MemoryState{agent_id, blocks[], archive_size}`，`MemoryBlock{label, value, read_only, updated_at}`，`MemorySearchResult{source, label?, content, relevance_score}`。这套抽象明显源自 **Letta** 的 core memory blocks + archival memory；支持矩阵显示只有 Letta 全部 ✅，Claude Code 仅 `blocks` ⚠️（"Session-scoped only via CLAUDE.md"），Goose/Deep Agent 基本 ❌。
- **HKUDS**：`MEMORY.md` 跨会话持久记忆 + auto-memory；**AgentBoardTT**：auto-memory + context compaction。
- **UHP**：规范章节中**没有 memory**——记忆被视作 harness 内部事务，网关只保证 session 连续性。
- **启示**：记忆是各引擎差异最大的域之一（block 式 vs 文件式 vs 无），Open Harness 的 `blocks` 抽象虽通用但绝大多数 CLI 型 harness 无法原生实现，只能由网关侧模拟（把 block 渲染进 instructions/CLAUDE.md）。

## 多 Agent 与协作

- **Open Harness `subagents` domain**：`spawn/delegate/terminate/result/custom`；仅 LangChain Deep Agent 全 ✅，Claude Code 全 ⚠️，Goose/Letta ❌。
- **AgentBoardTT**：4 个内置子 agent（general/explore/plan/review），后三者只读。**HKUDS**：Coordinator 子系统——subagent spawning + team registry + delegation（v0.1.6 加入 team agents）。
- **UHP**：无多 agent 抽象；HarnessRouter 产品层有"agent column 对表格每行跑一个 harness"、Videos kit 等编排，但属于产品而非协议。
- **harness-loom**：producer/reviewer pairs 是配置层面的双 agent 模式。
- **vitalops/opendesk**：多机而非多 agent（一个 agent 控制多台 peer）。
- **启示**：subagent/team 属于典型的**引擎特有扩展能力**——Claude Code 的 Task/agent team、HKUDS 的 team registry、Deep Agents 的 delegation 语义各异；网关只应做"能力标记 + 透传参数"，不要试图归一化其执行语义。

## 可观测性

- **UHP Streaming 章节**沿用 OpenAI Responses 的事件词汇（response.created / output_item / delta 系列等，[推测] 具体事件名需读 streaming.md），并以一致性检查 S-09 强制"流必须渐进（progressive）"——测量事件到达时间的分布，缓冲到最后一次性 flush 的服务器会被判 FAIL。HarnessRouter 控制台展示"every command the agent runs, every file it touches"，所有 transcript 存于 SQLite volume；README 强调 "no telemetry"（不回传）。
- **Open Harness**：统一事件流（`tool_call_start/delta/end`、`tool_result`、`artifact`、`progress`）+ `hooks.events` 操作 + `DiagnosticsResponse{version, uptime_seconds, memory_usage_mb, active sessions/executions}` + `ConformanceStatus{status, certified_version, pass_rate, golden_rule_compliant}`。
- **HKUDS**：token 计数、成本跟踪、流式结果；PreToolUse/PostToolUse hooks 可作为埋点注入点。**AgentBoardTT**：`eval/` 模块 + Harness-Bench 评分。
- **Harness-Bench** 提供了可借鉴的**归一化指标体系**：Completion / Security(binary gate) / Process(Robustness, Tool Use, Consistency) / Efficiency(tokens, turns)，并按 model×harness 配置报告。
- 未见任何项目原生输出 **OpenTelemetry**（[推测]，基于已抓取页面均无 OTel 字样）。

## 对我们架构的启示

### 1. 已被验证可行的抽象（可直接采用）

| 抽象 | 验证者 | 采用建议 |
|---|---|---|
| **harness(配置) / task(一次运行) / session(跨 task 对话)** 三层对象模型 | UHP 2026-08-11 + HarnessRouter 生产实现 | 网关核心对象模型即用此三层；群助手 = 群 ↔ session 绑定表 |
| **Responses 同形的任务 API + SSE 流 + `previous_response_id` 续聊** | UHP（明确为兼容决策，现有 SDK/解析器零改动） | 赛题要求实现"真实业务系统的网关接口"，若允许自定义可直接对齐 Responses 形态；否则在内部层采用，外层做薄映射 |
| **按 domain 的 Capability Manifest**（`{supported, operations[], limitations[]}` + 501 语义） | Open Harness spec v0.1.0；UHP 的 conformance class 是粗粒度版本 | 能力协商第一步：每个引擎适配器实现 `GET /engines/{id}/capabilities`，域至少含 execution/sessions/files/hooks/mcp/skills/memory/subagents/models/permissions |
| **四态权限枚举** `default / accept_edits(auto-edit) / plan / bypass` | Claude Code 原生；AgentBoardTT、HKUDS 原样照搬 | 作为公共能力 `permission.mode`；引擎缺某态时由 manifest 标 limitation |
| **引擎以上游 CLI 原样安装、版本钉死、子进程运行、per-session OS 用户隔离** | HarnessRouter（首启安装日志、root→setuid 设计） | 接入新引擎 = 写一个"安装脚本 + 进程适配器 + 事件解析器"，不 fork 引擎源码 |
| **统一事件词汇** `text/thinking/tool_call_start|delta|end/tool_result/artifact/progress/error/done` | Open Harness v0.2.0（与 Claude Code stream-json、ACP `session/update` 事件在语义上一一对应） | 可观测协议的公共事件集；引擎私有事件放 `extensions.<engine>.*` |
| **一致性测试套件即"接入验收"** | UHP 63 checks（S-09 渐进流、C-03 真取消、R-* 分享拒绝矩阵） | 我们的"能力识别→适配→认证"流程中的"认证"= 跑一套 conformance，按 class 授予接入等级 |

### 2. 公共能力 vs 扩展能力映射（基于本专题证据）

| 能力 | 归类 | 依据 | 接入参数示例 |
|---|---|---|---|
| 单轮任务执行（sync/stream/cancel） | 公共 | 五个项目全部支持 | `input, model, stream, timeout` |
| session create/resume/history | 公共（resume 需标注） | Open Harness 矩阵：所有 harness ✅/⚠️ | `session_id` / `previous_response_id` / `--resume <id>` |
| session fork / named / share | 扩展 | 矩阵中几乎全 ❌；UHP 中 share 为 Full 级可选 | `fork_from`, `share.readonly=true` |
| 权限模式四态 | 公共 | Claude Code 系事实标准 | `permission_mode` |
| 工具级审批回传（prompt/stdin） | 半公共 | Open Harness WS 有 `prompt`；UHP 未见 | `approval_channel=ws|webhook` |
| MCP 挂载 | 公共 | 所有引擎 + opendesk 皆 MCP | `mcp_servers[]{name, transport, command/url}` |
| Skills（Markdown 目录） | 公共（格式差异） | HKUDS/AgentBoardTT/UHP 均 SKILL.md；harness-loom 证明可编译 | `skills_dir`, 编译器按引擎输出 |
| Hooks pre/post-tool/stop | 扩展 | 仅 Claude Code 系 ✅ | `hooks{PreToolUse,PostToolUse,Stop}` |
| Memory blocks/archival/search | 扩展 | 仅 Letta 原生；CLI 型只能模拟 | `memory.blocks[]` → 渲染进 instructions |
| Subagents / team / delegation | 扩展 | 语义各异 | 透传 `engine_options.<engine>` |
| 多模型/运行时切模 | 扩展 | Claude Code ❌，Goose/Deep Agent/Letta ✅ | `model_switch_allowed` |
| Files in / artifacts out | 公共 | UHP Files 章节、Open Harness `files/artifact` | `attachments[]`, `artifacts[]` |
| Computer-use（opendesk） | 扩展（工具层） | opendesk 是 MCP server | `mcp_servers += {"opendesk": {"command": "opendesk-mcp"}}`，远端 `peer=` |

### 3. 新引擎接入的标准流程（综合 UHP + Open Harness）
1. **能力识别**：跑引擎 CLI 的 `--help`/文档，填 Capability Manifest（11 个 domain 逐 op 标 ✅/⚠️/❌ + limitations），并记录接入面类型（CLI stream-json / ACP stdio / HTTP / SDK）。
2. **适配**：实现 `EngineAdapter` 五个方法 `install()/spawn(session)/send(task)/events()/cancel()`，把引擎私有事件映射到公共事件词汇，私有能力挂 `extensions`。
3. **认证**：运行 conformance（Core：发现/鉴权/错误信封/流式/会话/取消；Extended：文件/artifact/路径穿越；Full：资产往返/MCP 持久化），发布报告，按通过的 class 决定业务可路由等级。

### 4. 风险与坑
- **"通用 API"很容易变成"某一家的 API"**：Open Harness 的 memory 抽象照抄 Letta、subagents 照抄 Deep Agents、hooks 照抄 Claude Code，导致每个 domain 只有一家全 ✅（覆盖率 24%–59%）。归一化层要以"多数引擎能实现"为准入，少数派能力进 extensions。
- **库级适配对 CLI 型引擎无效**：Open Harness 至今把 Claude Code CLI 标为 aspirational（"No public API"）。赛题里 pi/opencode/hermes/dsh 全是 CLI/进程型，应选 **HarnessRouter 式的进程网关**路线，而非 SDK 路线。
- **流式"假流"与"假取消"是最常见的适配缺陷**（UHP S-09、C-03 专门针对），验收必须测时间分布与终态。
- **文档与实现不同步**：openharness.ai 官网称 Claude Code 为 production adapter，仓库矩阵却标 🎯；HarnessRouter README 内部出现 3 个 vs 5 个 vs 官网 8 个引擎三种说法。对外宣称的"支持列表"要以 conformance 报告为准。
- **许可与分发**：HarnessRouter 因 Claude Code 私有条款、hermes-agent 无 license 而**不能把 CLI 打进镜像**，只能首启下载。我们的部署脚本同样需要首启安装 + 版本钉死（DSH "developer preview — version-pinned"）。
- **记忆/多 agent 不要过早归一化**：UHP 干脆不定义 memory 与 subagent，反而保持了稳定；建议我们的 v1 协议同样把它们放在 `extensions`。
- **opendesk 身份不明**：若按字面实现只会得到一个 MCP 工具，不满足"接入一种引擎"的赛题口径；需向主办方澄清或以 OpenHands/OpenClaw 替代。

### 5. 与 ACP（Agent Client Protocol）的关系 [推测，基于本专题材料]
- 本专题抓取的 UHP、Open Harness、HKUDS、AgentBoardTT 页面均未提及 ACP。两者层次不同：ACP 是 **编辑器↔单个 agent 进程** 的 JSON-RPC/stdio 协议（session/new、session/prompt、session/update、permission 请求），解决"一个客户端驱动一个 agent"；UHP 是 **产品↔多 harness 网关** 的 HTTP 协议，解决"多租户、多引擎、文件/工件、取消、一致性"。
- 二者可以叠加：网关对下用 ACP（若引擎支持，如 opencode/pi 系）或 CLI stream-json 驱动引擎，对上暴露 UHP/Responses 形态。ACP 的 permission request 恰好补上 UHP 未定义的工具级审批回传通道；Open Harness 的 `prompt`/`stdin` 事件即等价物。

## 未解决问题
1. 赛题 "opendesk" 的真实指代（vitalops/opendesk 工具、OpenHands/OpenClaw 误写、或内部代号）——需主办方澄清。
2. UHP `streaming.md`/`lifecycle.md` 的具体事件名、`GET /v1/harnesses` 返回体中 capability 字段的精确结构、以及是否定义工具级审批——本次未抓取原文（受调用次数限制），需后续读 `protocol/versions/2026-08-11/*.md` 与 `schema/uhp-2026-08-11.openapi.yaml`。
3. HarnessRouter 对 OpenCode / Qwen Code / Cline 的支持是否已进入 CE（官网 8 个 vs 容器日志 5 个）。
4. Open Harness 的 OAF（Open Agent Format）是否有正式 spec；`api.openharness.org` 是否真实可用还是文档占位。
5. 各项目 star 数为页面快照，GitHub API 在本环境返回空，未能二次核验。
6. HKUDS/OpenHarness 的 `ohmo gateway` 如何做群/频道→session 映射与隔离（与赛题群助手场景最接近，值得单独调研）。

## 来源列表
- https://openharness.ai/
- https://openharness.ai/api-reference.html
- https://github.com/jeffrschneider/OpenHarness
- https://raw.githubusercontent.com/jeffrschneider/OpenHarness/main/spec/CAPABILITY_MANIFEST.md
- https://raw.githubusercontent.com/jeffrschneider/OpenHarness/main/spec/HARNESS_SUPPORT_MATRIX.md
- https://github.com/AgentBoardTT/openharness
- https://github.com/HKUDS/OpenHarness
- https://github.com/RyanAlberts/best-of-Agent-Harnesses
- https://github.com/vitalops/opendesk
- https://github.com/HarnessRouter/harnessrouter （README raw + protocol/README.md + protocol/conformance/README.md）
- https://harnessrouter.ai/open-source
- https://unifiedharnessprotocol.org/
- https://aijourn.com/harnessrouter-open-sources-the-worlds-first-unified-interface-for-agent-harnesses-and-the-unified-harness-protocol/
- https://dev.to/kinggyusuh/open-sourcing-my-personal-ai-agent-harness-for-production-harness-loom-3mob
- https://arxiv.org/abs/2605.27922 ；https://arxiv.org/html/2605.27922v1
- https://www.tencentcloud.com/techpedia/147665
