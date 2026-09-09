# 实现范围与验证证据

本文件描述实际代码范围，不改变 `docs/spec/` 的目标要求。`results.json` 记录实际运行结果。存在源代码、单元测试通过、目标平台验证通过是不同状态。本文最近一次核对：2026-09-09（Windows x64 / Node 24.19.0，工作树基于 `c3403b9`）。

## 公共框架

| 部分 | 源码状态 | 已有验证 | 仍缺的证据 |
|---|---|---|---|
| 公共类型/错误/模型与工具边界 | 已实现 | 类型检查、单元测试、完整项目构建 | — |
| Session/Run/Message/原生绑定 | 已实现 | SQLite 真实文件、多轮、重启与中断测试；真实引擎冒烟中的多会话与会话生命周期 | 内网验收 |
| 事件顺序、文本合并和工具观察终态 | 已实现 | 单测；真实引擎冒烟的 `event-sequence` 与 `hello-trace`/`write-file` 轨迹检查 | 内网验收 |
| 取消、迟到资源、全局执行槽与跨会话有界队列 | 已实现 | 故障注入与 Mock 测试；真实引擎冒烟 `case3/abort` 与 `concurrency/cross-session-queue` | 内网验收 |
| Question/Permission Broker | 已实现 | 等待、回复、组织 deny 测试；真实引擎冒烟 `case2/write-file`（`once`）与 `case2b/permission-rejected`（`reject`） | 内网组织策略 |
| 共享 ProcessHost 注入/ResourceScope | 已实现 | Windows 真实子进程、清理及作用域测试；真实引擎冒烟经 Windows 进程宿主拉起两个真实引擎 | — |
| Windows Job Object C#/PowerShell | 已实现 | Windows 编译、ProcessHost 生命周期与进程树测试；`desktop-smoke` 观察到 MCP 服务器进程树在 Job 与 Scope 下均可核验静默，而被打开的用户应用（Notepad）存活。2026-09-05 B 线用 Pi fixture 走同一条 win32 路径时发现并修复了 `baseEnvironment()` 允许名单缺少 `PSExecutionPolicyPreference` 的共享缺陷（详见 `docs/engines/pi.md`） | F12 级别对真实引擎进程树的专项清理记录未单独出具 |
| Fastify/Schema/SSE/API | 已实现 | 完整类型检查、构建、inject 与 SSE 契约测试（9/9）；真实引擎冒烟走北向 HTTP | 评测方真实客户端联调 |
| 资产/配置/基础脱敏 | 已实现 | 类型和单元测试；冒烟产物中凭据脱敏 | 真实内网模型/日志安全回归 |
| 部署/恢复/发布脚本 | 已提供 | `gateway.cmd`/`gateway.ps1` 在 PATH 无 Node 时启动并就绪（opencode、pi 分别验证）；边界脚本、strip-only、PowerShell 编码检查通过；`release:check` 按预期因缺内网验收证据退出非零 | Windows 安装/恢复实测的正式记录 |

## 角色实现边界

| 模块 | 实现状态 | 责任 |
|---|---|---|
| ACP Driver / OpenCode | ACP v1 Driver 与 OpenCode Pack 已实现；`config/engines/opencode.json` `capabilityEvidence: "probed"`——真实二进制在 Windows 原生 + 模拟模型服务上观察到，未连真实内网模型 | A |
| Hermes | **未实现。** `src/engines/hermes/pack.ts` 只有 `implementationProvided: false` 的描述符，`open()` 抛 `ENGINE_UNAVAILABLE`；`config/engines/hermes.json` `capabilityEvidence: "unverified"`、无版本锁。它是第三个 ACP 引擎的扩展点示例，是可选项，不进入发布矩阵 | A |
| Pi RPC / Pi 工具与扩展 | Pi RPC Driver（protocol/client/launch/tool-bridge/channel/extension）与 Pi EnginePack 已实现；`config/engines/pi.json` `engineVersion: "0.85.1"`、`capabilityEvidence: "probed"`。2026-09-07 手工核验发现并修复了 `agent_end.stopReason` 位置与 `OPENAI_BASE_URL` 不生效两处真实缺陷（`docs/engines/pi.md` B08）；2026-09-09 又修复了 GLM 类端点对纯文本 `content` 数组的兼容问题（`docs/team/handoff-settings-mcp-2026-09-09.md`）。真实 pi 进程已在 Windows 上经网关进程宿主完成冒烟 20/21 与真实模型 live-check 8/8。未验证：真实内网模型；`mcp-http` 对真实远端服务器；`powershell` 工具的真实执行 | B |
| 内部模型 / 员工助手 CLI / 组织策略 | **未交付。** `src/integration/internal/provider.ts` 的 `prepare()` 无条件抛 `INTEGRATION_UNAVAILABLE`，`probeIntegration` 拒绝以它启动。正式启动路径是已实现的 `configured` provider（`config/settings.json` + `PNP_MODEL_*`）；员工助手 CLI 的 PNP-MCP/1 Server、组织授权策略、`verification/internal/{opencode,pi}.json` 均不存在 | C |
| 能力包（`code/assets/packs/*`） | **清单机制未实现。** 目录内只有 README；`src/` 中没有 `pack.json` 解析、探测或 `pack.projected` 事件。当前的工具与指令注入走 `settings.json`：Office MCP（`src/tools/office-mcp`，docx/xlsx/pptx/csv/文件/`app_open`/`web_fetch`）、Desktop MCP（`src/tools/desktop-mcp`，列举/打开固定应用）与 `config/instructions/competition.md`。通用 UI 自动化与网页检索能力未交付 | 共同 |

这些角色模块不是公共基础框架的隐藏依赖。真实引擎入口的 `implementationProvided=false` 会使正式启动明确失败，不伪装已接入。

## 本包实际结果（2026-09-09）

Windows x64 / Node 24.19.0：

- `npm run typecheck`：通过。
- 单元与适配器测试（`tests/unit` + `tests/adapters`）：469 项，467 通过、0 失败、2 跳过。
- HTTP/SSE 公共契约（`tests/contract`）：9/9 通过。
- `check:boundaries`、`check:strip-only`、`check:ps-encoding`：通过。
- 真实引擎端到端冒烟（`npm run e2e`，真实网关进程 + Windows 进程宿主 + 真实引擎 + 模拟模型服务，交付 `settings.json` 原样）：OpenCode 1.18.29 与 Pi 0.85.1 各 21 项中 20 通过、0 失败、1 跳过（`concurrency/same-session-busy`，由 mock 对照组覆盖）。检查项含就绪、事件流、缺 `directory` 400、无 `model` 的 204、文本轨迹、写文件、审批拒绝、Office MCP `csv_read`（中文与空格路径）、缺失文件真实错误、Desktop MCP 工具发现、abort、反问/授权列表、会话删除、第二会话、跨会话队列、事件序列。
- 真实模型 live-check（本机配置的公网 OpenAI 兼容端点，记录于 `docs/team/handoff-settings-mcp-2026-09-09.md`）：opencode 8/8，pi 8/8（修复文本载荷兼容后）。这是公网模型证据，不能替代内网验收。
- `gateway.cmd` 与 `gateway.ps1`：PATH 上无 Node.js 时启动并在 `/health/ready` 报告所选引擎（opencode、pi 分别验证）。
- `npm run release:check`：退出 1。唯一阻断原因是两个必过引擎缺 `verification/internal/<engine>.json` 内网验收证据；Hermes 作为可选引擎报告 `no-evidence`，不阻断。
- `npm run foundation:check`：含 `node VERIFY.mjs` 对 `FILE-MANIFEST.json` 的核对，需在本轮 `refresh-manifest` 之后重跑，结果以 `results.json` 为准。

未执行（`not_run`）：内网模型与员工助手联合验收、Outlook 登录与业务操作、官方材料上的评分、Hermes。

## 证据位置

- `results.json`：本次核对的机器可读汇总。
- `settings-mcp-2026-09-09.json` 与 `docs/team/handoff-settings-mcp-2026-09-09.md`：2026-09-09 配置/MCP 验证轮的完整记录；原始日志在 Git 忽略的 `code/runtime/logs/`。
- `logs/`：2026-09-05 初始交付时的快照（当时 36 项单测、无引擎锁、release gate 报告全部缺失），仅作历史对照，不反映当前状态。
- `internal/evidence.example.json`：仅为模板，不是通过记录。

单元测试中的 Mock quiescent 只验证 Core 状态规则，不证明第三方引擎能够停止。Windows helper 的源代码存在不代表测试通过；这是独立发布门禁。
