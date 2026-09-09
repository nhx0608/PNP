# Hermes 接入规格（未实现的扩展点示例）

> **实现状态（2026-09-09）：未实现。** `code/src/engines/hermes/pack.ts` 只有一个 `implementationProvided: false` 的描述符，`open()` 无条件抛 `ENGINE_UNAVAILABLE`（503），注册表在启动时据此拒绝选择它；`config/engines/hermes.json` 的 `engineVersion` 为 `null`、`capabilityEvidence` 为 `"unverified"`；`engines.lock.json` 没有它的条目。Hermes 是赛题两引擎要求之外的可选第三引擎（`docs/spec/requirements.md` R02），在 `release-profile.json` 里列为 optional，`release:check` 报告 `no-evidence` 且不阻断发布。本文其余部分是**给未来实现者的目标规格**——说明第三个 ACP 引擎如何复用同一 ACP Driver 接入，不描述任何已存在的行为或证据。

所有者 A。入口 `code/src/engines/hermes/pack.ts`，通道 `acp`，公共契约 1.1.0。

复用与 OpenCode 相同的 ACP Driver，不复制网关、Session 或事件基础设施。Pack 封装 Hermes 安装运行、配置布局、内网模型映射、原生会话恢复和资产投影。

ACP 通道能力与 CLI/HTTP 不得混同。对实际版本列出可用工具面、原生 Memory/Skills/委派等能力的配置、控制、观察及验证证据。通道不支持的操作明确返回不可用，不假装完整支持。

使用私有 Engine 数据目录、批准的依赖源及明确的环境变量。模型与工具不依赖开发者全局账号。取消与关闭必须有受控资源停止证据，原生历史是否可恢复由锁定版本验证。

验收与 OpenCode/Pi 运行同一公共契约套件，同时提供 Windows 安装、内部模型、员工助手工具、权限、恢复和取消的实际证据。高级功能至少一项完成配置—执行—观察闭环。
