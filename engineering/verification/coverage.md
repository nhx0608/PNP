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
| 共享ProcessHost注入/ResourceScope | 已实现 | Linux真实子进程、清理及作用域测试 | Windows进程测试 |
| Windows Job Object C#/PowerShell | 源码已提供 | 未在Windows编译或执行 | Windows编译、父退出、进程树、权限限制测试 |
| Fastify/Schema/SSE/API | 源码与测试已提供 | 未安装npm依赖，未执行HTTP测试 | 完整构建、inject与真实SSE |
| 资产/配置/基础脱敏 | 已实现 | 类型和单元测试 | 真模型/日志安全回归 |
| 部署/恢复/发布脚本 | 已提供 | 边界脚本通过、发布门禁阻断 | Windows安装/恢复实测 |

## 角色实现边界

| 模块 | 实现入口 | 责任 |
|---|---|---|
| ACP Driver / OpenCode / Hermes | 独立目录、类型边界、注册项已提供；真实协议实现未提供 | A |
| Pi RPC / Pi工具与扩展 | 独立目录、类型边界、注册项已提供；真实协议实现未提供 | B |
| 内部模型 / 员工助手CLI / 组织策略 | IntegrationProvider入口与公共数据结构已提供；真实内部协议实现未提供 | C |

这些角色模块不是公共基础框架的隐藏依赖。A/B 分别使用 Mock Integration 和公共契约测试开发，不等待另一条协议线。真实引擎入口的 `implementationProvided=false` 会使正式启动明确失败，不伪装已接入。

## 本包实际结果

公共单元测试36项通过、0失败、0跳过；运行于 Linux / Node 22.16.0。选定公共源码图通过 TypeScript 5.8.3 检查，非完整npm项目类型检查。模块边界检查通过。

HTTP、Windows、Node24目标、真实Harness和内网集成未执行。运行环境无法解析 npm registry，真实依赖锁未生成。没有附伪造的 `package-lock.json`。`foundation:check` 和 `release:check` 正确阻断，不能把本包描述为已经可提交评测的成品。

审核者在目标联网环境完成依赖锁和共同基线准入后，A/B/C 使用同一 SHA 并行工作。该准入是一次共同校验，不是将公共框架重新分配给 A 的长期任务。

## 证据位置

- `logs/unit.tap`：实际测试输出。
- `logs/core-typecheck.txt`：实际类型检查范围与命令。
- `logs/boundaries.txt`：模块边界结果。
- `logs/npm-resolution.txt`：脱敏依赖解析结果。
- `logs/release-gate.json`：发布门禁结果。
- `internal/evidence.example.json`：仅为模板，不是通过记录。

单元测试中的 Mock quiescent 只验证 Core 状态规则，不证明第三方引擎能够停止。Windows helper 的源代码存在不代表测试通过；这是独立发布门禁。
