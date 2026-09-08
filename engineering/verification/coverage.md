# 实现范围与验证证据

本文件描述实际代码范围，不改变 `docs/spec/` 的目标要求。`results.json` 记录实际运行结果。存在源代码、单元测试通过、目标平台验证通过是不同状态。

## 公共框架

| 部分 | 源码状态 | 已有验证 | 目标环境门禁 |
|---|---|---|---|
| 公共类型/错误/模型与工具边界 | 已实现 | 类型和单元测试 | 完整项目构建 |
| Session/Run/Message/原生绑定 | 已实现 | SQLite真实文件、多轮、重启与中断测试 | Node24/Windows验证 |
| 事件顺序、文本合并和工具观察终态 | 已实现 | 单测 | 真引擎事件与HTTP/SSE测试 |
| 取消、迟到资源、全局执行槽 | 已实现 | 故障注入与Mock测试 | 真工具停止证据 |
| Question/Permission Broker | 已实现 | 等待、回复、组织deny测试 | HTTP+内网权限验证 |
| 共享ProcessHost注入/ResourceScope | 已实现 | Windows真实子进程、清理及作用域测试 | 真引擎取消证据 |
| Windows Job Object C#/PowerShell | 已实现 | Windows编译、ProcessHost生命周期与进程树测试；B 在 2026-09-05 用 `code/tests/adapters/pi/engine-contract.test.ts`（Pi 的 fixture 进程，`fake-pi-cli.mjs`）独立走通同一条 win32 路径时，发现并修复了 `baseEnvironment()` 允许名单缺少 `PSExecutionPolicyPreference` 的共享缺陷（仅靠会话级该变量放开脚本执行策略的机器上，旧代码会让 PowerShell 宿主以 `UnauthorizedAccess` 启动失败，导致任何引擎的 Windows 真实进程路径都失败并残留孤儿进程）；修复已合入，Pi 侧公共 36 项 unit 测试 + 新增 21 项 Pi 适配器测试合计 57 项全部通过，无回归 | 真引擎取消证据 |
| Fastify/Schema/SSE/API | 已实现 | 完整类型检查、构建、inject与SSE契约测试 | 真客户端联调 |
| 资产/配置/基础脱敏 | 已实现 | 类型和单元测试 | 真模型/日志安全回归 |
| 部署/恢复/发布脚本 | 已提供 | 边界脚本通过、发布门禁阻断 | Windows安装/恢复实测 |

## 角色实现边界

| 模块 | 实现入口 | 责任 |
|---|---|---|
| ACP Driver / OpenCode / Hermes | ACP v1 Driver和OpenCode Pack已实现；Hermes为可选项且尚未实现 | A |
| Pi RPC / Pi工具与扩展 | Pi RPC Driver（protocol/client/launch/tool-bridge/channel）和 Pi EnginePack 已实现，`capabilityEvidence: "declared"`；2026-09-07 补充手工核验：真实安装 `@earendil-works/pi-coding-agent` 0.85.1 并手工跑通 `get_state` 与一次完整 `prompt`→`agent_settled`（模型侧接本地 mock 服务器），据此发现并修复两处真实缺陷——`agent_end.stopReason` 实际不存在于顶层（旧代码读取后恒为 `undefined`，`mapFinish` 默认分支恒返回 `"stop"`，导致每次真实运行、包括真实报错，都会被误报为成功）、以及 `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` 对自定义端点完全不生效（改用 `PI_CODING_AGENT_DIR` + 会话私有 `models.json`）；详见 `docs/engines/pi.md` "B08"。这仍是手工命令行复现，不是自动化 CI 对真实二进制的持续验证；`engineVersion` 仍保持 `null`，真实内网模型/真实原生扩展/Windows 上对真实 pi 进程的 Job Object 生命周期仍未验证 | B |
| 内部模型 / 员工助手CLI / 组织策略 | IntegrationProvider入口与公共数据结构已提供；真实内部协议实现未提供 | C |

这些角色模块不是公共基础框架的隐藏依赖。A/B 分别使用 Mock Integration 和公共契约测试开发，不等待另一条协议线。真实引擎入口的 `implementationProvided=false` 会使正式启动明确失败，不伪装已接入。

## 本包实际结果

当前在 Windows x64 / Node 24.19.0 上执行完整项目检查（`npm run foundation:check`，2026-09-07 含本次 Pi B08 改动后重跑）：单元测试302项（301通过、1跳过、0失败）+ 4项公共契约测试全部通过；类型检查、模块边界和 source-only 打包边界均通过；`refresh-manifest` 已同步更新 `FILE-MANIFEST.json`/`SHA256SUMS.txt`。OpenCode 1.18.29 官方 Windows x64 npm 包已经以精确 SHA-256 锁定。

真实 OpenCode 1.18.29 Windows 二进制已在公共契约 1.1 下通过14/14端到端检查：网关、ACP、ProcessHost、本地 Mock 模型、工具权限允许/拒绝、文件操作、取消、SSE和会话生命周期均已覆盖。Pi、真实内网集成及逐引擎授权验收尚未完成；`release:check` 应继续阻断，不能把本包描述为已经可提交评测的成品。

审核者在目标联网环境完成依赖锁和共同基线准入后，A/B/C 使用同一 SHA 并行工作。该准入是一次共同校验，不是将公共框架重新分配给 A 的长期任务。

## 证据位置

- `logs/unit.tap`：实际测试输出。
- `logs/core-typecheck.txt`：实际类型检查范围与命令。
- `logs/boundaries.txt`：模块边界结果。
- `logs/npm-resolution.txt`：脱敏依赖解析结果。
- `logs/release-gate.json`：发布门禁结果。
- `internal/evidence.example.json`：仅为模板，不是通过记录。

单元测试中的 Mock quiescent 只验证 Core 状态规则，不证明第三方引擎能够停止。Windows helper 的源代码存在不代表测试通过；这是独立发布门禁。
