# PNP 当前工程交接（2026-09-09）

> 本文取代 2026-09-07 的交接。上一版描述的"Pi 未完成、274/4/14 项测试、release gate 因 Pi 缺实现而阻断"已经不是事实；本轮最后一次配置/MCP 验证的完整记录见 [`handoff-settings-mcp-2026-09-09.md`](handoff-settings-mcp-2026-09-09.md)，机器可读汇总见 [`../../verification/results.json`](../../verification/results.json)。

## 1. 接手规则

- 仓库：GitHub `nhx0608/PNP`，Gitee `nhx0608/pnp`。
- 唯一开发基线是 `engineering/`；先完整阅读 `engineering/AGENTS.md`、`docs/spec/`、`docs/team/` 和 `code/src/contracts/`，不要从历史研究或评审稿重新设计系统。
- 接手时必须重新 fetch GitHub 与 Gitee，以两边最新提交的无损合并结果为实际基线；不得强推或覆盖任一远端。最终交接提交 SHA 以两个远端最新 `master` 为准。
- 每次停止前提交全部确定采用的修改，并把同一个 `master` 推送到 GitHub 和 Gitee；随后回读验证本地、`origin/master`、`gitee/master` 三个 SHA 完全一致。
- 不提交真实内网凭据、Token、Cookie、工号、证书或未脱敏日志。真实凭据只能由授权环境通过环境变量或仓库外私有配置提供。
- 不恢复本机 stash `superseded generic ACP draft before Claude integration`；它是已被当前模块化 ACP 实现取代的旧草稿，不属于交付代码。

## 2. 模型与决策流程（用户明确要求）

架构、公共框架、协议、运行/进程树、赛题方向和重大兼容策略必须先由当前可用的最顶级模型以最高推理强度审查。审查应给出：规范证据、当前代码证据、可证伪风险、推荐方案、兼容与安全代价；把结论交给用户确认后再做架构性修改。

具体流程：

1. 最顶级模型审查问题并形成决策建议，不直接扩大实现范围。
2. 用户确认方向后，由很强的模型完成详细设计和测试矩阵。
3. 最顶级模型复核详细设计；无阻断项后，交给适合的中高强度模型实现。
4. 实现后由最顶级模型做差异与赛题符合性复核，再跑真实验证。

`docs/engineering-review-3.md` §7–§8 与 `docs/competition-readiness.md` 的"顶层裁决"是评审稿里的模型自述，不等于用户批准。凡与 `docs/spec/` 冲突的改动都必须经上述流程并由用户确认后再落地。

## 3. 已完成并验证的内容（2026-09-09，Windows x64 / Node 24.19.0）

公共契约版本为 `1.1.0`。公共框架具备 HTTP、Session、Run、SQLite、事件、SSE/Last-Event-ID、取消、恢复、跨会话有界队列（默认 8）、ProcessHost、Windows Job Host、会话级围栏、持久化工具观察和发布门禁。

A 线（ACP / OpenCode）：ACP v1 Driver 与 OpenCode Pack 已实现；`opencode-windows-x64@1.18.29` 以 tarball SHA-256 锁定。B 线（Pi RPC / Pi）：Pi RPC Driver、Pi Pack、进程内 MCP 客户端桥与 `tool_call` 策略钩子已实现；`@earendil-works/pi-coding-agent@0.85.1` 以 tarball SHA-256 锁定。共同基线另交付 Office MCP、Desktop MCP、统一 `settings.json`、指令文件、`pnp.cmd`/`gateway.cmd`/`gateway.ps1` 启动器与离线 bundle 打包。

最近一次结果：

- `npm run typecheck`：通过。
- 单元与适配器测试：469 项，467 通过、0 失败、2 跳过。
- HTTP/SSE 公共契约：9/9 通过。
- 模块边界、strip-only、PowerShell 编码检查：通过。
- 真实引擎端到端冒烟（真实网关进程 + Windows 进程宿主 + 真实引擎 + 模拟模型服务，含 Office/Desktop MCP 往返、审批 once/reject、abort、跨会话队列）：opencode 20/21、pi 20/21，各 0 失败、1 项按设计跳过。
- 真实模型 live-check（本机配置的公网 OpenAI 兼容端点）：opencode 8/8，pi 8/8（见 `handoff-settings-mcp-2026-09-09.md`）。
- `gateway.cmd` 与 `gateway.ps1`：PATH 上无 Node.js 时启动并在 `/health/ready` 报告所选引擎（opencode、pi 分别验证）。
- `npm run release:check`：退出 1，唯一原因是两个必过引擎缺 `verification/internal/<engine>.json` 内网验收证据；Hermes 作为可选引擎报告 `no-evidence`，不阻断。
- `npm run foundation:check`：含 `node VERIFY.mjs` 清单核对，需在本轮 `refresh-manifest` 后重跑。

权威状态见 `verification/results.json`、`verification/coverage.md` 和 `code/engines.lock.json`。`REVIEW-ALL.html` 是初始交付的历史快照，不是当前源码。

## 4. 历史评审项的处置

`docs/engineering-review*.md`、`docs/architecture-review.md`、`docs/competition-readiness.md` 都是针对更早提交的评审稿，不描述当前代码。上一版交接列出的 R1（跨会话有界 FIFO 队列）、R2（未知 model 回退到配置模型）、R3（默认 `configured` 集成）、R4（自动创建工作目录）、R5（`gateway` 启动入口与默认 `localhost`）、R7（权限 `patterns`）与 D2/D3（`announced-title` 来源标记与 `state.title` 投影）已随后续提交落地并有冒烟/测试证据（`docs/competition-readiness.md` §7 记录了合入提交）。任何评审稿与当前 `docs/spec/contracts.md` 或源码不一致之处，以 spec 与源码为准，不要按评审稿回退。

Fastify 5 当前给出 `disableRequestLogging` 弃用警告，不影响现有测试，但升级 Fastify 6 前必须迁移到新的日志控制方式。

## 5. 尚未完成的赛题边界

- C 线：`src/integration/internal` 仍是抛 `INTEGRATION_UNAVAILABLE` 的桩；真实内网模型协议、员工助手 CLI → PNP-MCP/1 Server、组织授权策略、内网自检与逐引擎 `verification/internal/{opencode,pi}.json` 均未交付。正式启动路径是 `configured` provider。
- 能力包：`docs/spec/contracts.md` 第 10 节的清单/探测/`pack.projected` 机制未实现；`code/assets/packs/` 只有 README。当前注入走 `settings.json`。通用 UI 自动化与网页检索能力未交付。
- A 可选：Hermes 未实现，仅为 `implementationProvided: false` 的扩展点示例。
- 仍未验证：真实内网模型端到端；`mcp-http` 对真实远端 MCP 服务器；Pi `powershell` 工具在真实 Windows 上的执行；Outlook 登录与业务操作；官方材料上的评分。
- 正式发布：缺少 OpenCode 与 Pi 对当前最终 commit 的授权内网验收；`npm run release:check` 必须继续失败，禁止绕过门禁或提交伪造证据。

## 6. 新会话的推荐执行顺序

1. 获取两个远端，确认差异与共同基线，运行 `npm ci`、`npm run check`、`npm run build`、`npm run foundation:check`、`npm run release:check`，如实记录通过与预期阻断。
2. 在 Windows 真机重跑 `npm run e2e -- --engine opencode --expect-desktop-mcp` 与 `--engine pi --expect-desktop-mcp`，确认 20/21 无回归；有真实模型配置时再跑 `pnp.cmd livecheck`。
3. 需要改公共契约或架构时，按第 2 节流程先审后改。
4. C 线在授权内网环境实现 `InternalIntegration` 与 PNP-MCP/1 Server，产出与 Engine/Channel/version/commit/Node 精确匹配的 `verification/internal/<engine>.json`；两条必过引擎都通过后 `release:check` 才会放行。
5. 更新 `verification/results.json`、`coverage.md`，运行 `npm run refresh-manifest`；提交、推送 GitHub 和 Gitee 并回读 SHA。

## 7. 可直接复制给新会话的 Prompt

继续实现 `nhx0608/PNP`。先阅读 `engineering/docs/team/handoff-current.md` 与 `engineering/verification/results.json`，并以 `engineering/` 为唯一开发基线，严格遵守 `engineering/AGENTS.md`、`engineering/docs/spec/`、`engineering/docs/team/` 和 `engineering/code/src/contracts/`。开始前同时 fetch GitHub `origin/master` 与 Gitee `gitee/master`，不得覆盖任一远端；以两边最新提交的无损合并结果为基线，先运行 `npm run check`、构建、`foundation:check` 和 `release:check` 并报告实际结果。

当前状态：公共框架、A 线 ACP/OpenCode 1.18.29、B 线 Pi RPC/Pi 0.85.1 已实现并锁定，两者在 Windows 真机上的真实引擎冒烟各 20/21 通过；Hermes 只是未实现的扩展点示例；C 线内网集成（`InternalIntegration`、员工助手 CLI 的 PNP-MCP/1 Server、组织策略、内网验收证据）与能力包清单机制未实现。不要把本机冒烟或公网模型结果写成内网验收；不要使用真实内网凭据；不要伪造验收；不要绕过 release gate。架构、公共契约、进程树和赛题方向的改动必须先由最顶级模型审查并经用户确认。每次停止前提交所有确定采用的代码并把同一 master 同步到 GitHub 和 Gitee，最后验证本地、origin/master、gitee/master SHA 完全相同。
