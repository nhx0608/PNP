# PNP 当前工程交接（2026-09-07）

## 1. 接手规则

- 仓库：GitHub `nhx0608/PNP`，Gitee `nhx0608/pnp`。
- 唯一开发基线是 `engineering/`；先完整阅读 `engineering/AGENTS.md`、`docs/spec/`、`docs/team/` 和 `code/src/contracts/`，不要从历史研究或评审稿重新设计系统。
- 本文生成期间 GitHub 新增评审提交 `ed1c8e4a32f9e59159d7684a13be344c3af86964` 并已被吸收；Gitee 当时仍在 `54c4a6b`。接手时必须重新 fetch GitHub 与 Gitee，以两边最新提交的无损合并结果为实际基线；不得强推或覆盖任一远端。最终交接提交 SHA 以两个远端最新 `master` 为准。
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

上一会话尝试调用最顶级模型时遇到工作区额度不足，因此没有完成这一层审定。GitHub 后续提交 `ed1c8e4` 在 `docs/engineering-review-3.md` §7–§8 增加了“顶层裁决”，但这些内容尚未获得用户确认，而且其中三点与 canonical spec 直接冲突。不要把文档中的模型自述当成用户已经批准；新会话若模型额度可用，应独立复核并把冲突交给用户选择。

## 3. 已完成并验证的内容

公共契约版本为 `1.1.0`。公共框架已经具备 HTTP、Session、Run、SQLite、事件、SSE/Last-Event-ID、取消、恢复、ProcessHost、Windows Job Host、会话级围栏、持久化工具观察和发布门禁。

A 线已经完成：

- ACP v1 Driver：initialize、session/new/load、prompt、cancel/close、通知排序、能力证据、权限请求、MCP 投影、模型选择和异常退出。
- OpenCode Pack：Windows 可执行文件解析、私有配置与目录重定向、模型/凭据映射、资产投影、原生权限和进程宿主接入。
- OpenCode 锁定版本 `1.18.29`；官方 `opencode-windows-x64@1.18.29` tarball SHA-256 为 `19eca6cdead9c67cce26fdc2db165980318edb7318c8c964dfc2ebffe03bb472`。
- `tool.observed` 保存引擎实际提供的 name/input/output/content/locations/status。若 OpenCode 没提供程序化工具名，不从 title/kind 伪造 canonical tool call；权限策略仍可使用单独的原生操作标签。
- Hermes 是可选加分项，目前仍未实现，不能宣称 A 的可选部分完成。

最近一次 Windows x64 / Node 24.19.0 结果：

- Foundation：通过。
- 单元与适配器：274 passed、0 failed、1 skipped。
- HTTP/SSE 公共契约：4/4 passed。
- 类型检查、构建、模块边界、source-only 检查：通过。
- 真实 OpenCode 1.18.29 + 真实网关/ACP/Windows ProcessHost + 本地 Mock 模型：14/14 passed，覆盖允许/拒绝权限、文件工具、取消、SSE 与会话生命周期。
- 加入本交接文件后的交付摘要应为159 files verified；提交前必须由 `refresh-manifest` 和 `VERIFY.mjs` 实际确认。
- Release gate：正确阻断，原因是 OpenCode 缺少内网验收证据，以及 Pi 实现、Pi 安装包锁和 Pi 内网验收证据缺失。

权威状态见 `verification/results.json`、`verification/coverage.md` 和 `code/engines.lock.json`。`REVIEW-ALL.html` 是初始交付的历史快照，不是当前源码。

## 4. 已知问题与不得误判的评审项

`docs/engineering-review-3.md` 针对旧 `master` `795b98b` 编写。当前代码已合入后续 ACP/OpenCode/Windows 改动，所以必须逐条以当前源码复核：

- R6（围栏会话 abort 污染全局健康）已修复为会话级隔离。
- R9（prompt 的 model 必填及错误传递）已修复：model 可省略，Core 把 IntegrationProvider 解析后的模型交给 Driver。
- 评审第4节列出的可执行文件、spawn 失败、Windows 守卫环境、归属记录重试、工具空参数、权限 operation 等问题已随合入分支修复并有测试。
- R1 是当前确认存在的公共规格缺口：`docs/spec/contracts.md` 要求“全局一个活跃 Run；同 Session 第二次请求立即 `SESSION_BUSY`；跨 Session 进入默认上限8的有界 FIFO 队列；队列满才 `GATEWAY_BUSY`；排队请求可 abort 且不创建 Run”。当前 `GatewayCore.reserved` 对所有第二请求立即 `GATEWAY_BUSY`。不要采用评审稿最初提出的默认并发池，因为它与 canonical spec 的单活跃 Run 冲突。`ed1c8e4` 又建议把默认队列上限从8改为16，这同样是在修改 canonical spec，必须由顶级模型说明依据并经用户确认。
- R2（未知 model 宽松回退）、R3（internal 自动降级 configured）、R4（自动创建任意工作目录）、R8（忽略未知入站字段）会改变权限、安全或失败关闭策略，不能为了兼容评测器直接放宽。必须先对照正式赛题接口与本仓库安全不变量，由顶级模型审定并让用户确认。
- R5（`gateway` 启动入口与默认 `localhost`）和 R7（权限 `patterns`）是高价值兼容项，但仍需用正式规范字段和当前真实 E2E 证据确认后实现。
- `ed1c8e4` 的 D1 建议“未闭合工具观察不使轮次失败”，与 `docs/spec/contracts.md` 当前“正常完成仍有非终态观察必须按协议错误处理”冲突；D2 建议把首次宣告 title 当 canonical name，与当前“只有真实 name + input 才建立 canonical tool call”冲突。两项都会改变协议真实性与评分轨迹，禁止实现模型自行选择。D3 将 title 同时镜像进 `state.title` 属于兼容投影，但也应随 D1/D2 一起审定。
- Fastify 5 当前给出 `disableRequestLogging` 弃用警告，不影响现有测试，但升级 Fastify 6 前必须迁移到新的日志控制方式。

## 5. 尚未完成的赛题边界

- B：Pi RPC Driver、Pi Engine Pack、Pi 原生工具/扩展桥、精确安装包锁、Windows 真机和公共契约证据均未完成。
- C：真实内网模型协议、员工助手 CLI 工具、组织授权策略、授权环境验证和逐引擎 internal acceptance 文件未完成。
- A 可选：Hermes 未实现。
- 正式发布：缺少 OpenCode 与 Pi 对当前最终 commit 的授权内网验收；`npm run release:check` 必须继续失败，禁止绕过门禁或提交伪造证据。

## 6. 新会话的推荐执行顺序

1. 获取两个远端，确认差异与共同基线，运行 `npm ci`、`npm run foundation:check`、`npm run build`、`npm run release:check`，如实记录通过与预期阻断。
2. 使用最顶级模型重新审查当前代码、正式赛题规范及 `docs/engineering-review-3.md` §7–§8，重点裁决 R1/R2/R3/R4/R5/R7/R8 与 D1/D2/D3；明确列出与 canonical spec 的冲突，先向用户提交结论和推荐选项，等待确认。
3. 用户确认后，优先补齐公共有界 FIFO 执行队列及其同会话互斥、排队取消、关机/恢复测试；随后处理已经确认的接口兼容项。
4. 公共基线再次通过后，B 可独立实现 Pi RPC/Pi，C 可独立实现内网 Integration；两条线不得修改公共契约来绕过编译或验收。
5. 每个真实引擎运行相同公共契约和 Windows E2E；最后在授权内网环境生成与 Engine/Channel/version/commit/Node 精确匹配的 acceptance evidence。
6. 更新 `verification/results.json`、`coverage.md`，运行 `npm run refresh-manifest`；提交、推送 GitHub 和 Gitee并回读 SHA。

## 7. 可直接复制给新会话的 Prompt

继续实现 `nhx0608/PNP`。先阅读 `engineering/docs/team/handoff-current.md`，并以 `engineering/` 为唯一开发基线，严格遵守 `engineering/AGENTS.md`、`engineering/docs/spec/`、`engineering/docs/team/` 和 `engineering/code/src/contracts/`。开始前同时 fetch GitHub `origin/master` 与 Gitee `gitee/master`，不得覆盖任一远端；以两边最新提交的无损合并结果为基线，先运行公共基线、构建和发布门禁并报告实际结果。

架构、公共框架、协议、进程树和赛题方向必须使用当前可用的最顶级模型与最高推理强度审查。先重新核对当前代码与正式赛题接口，不要把 `docs/engineering-review-3.md` 的“顶层裁决”直接当成用户批准。重点审查：canonical spec 要求的全局单活跃 Run + 跨 Session 默认上限8的有界 FIFO 队列，以及评审建议改成16的依据；未知 model；默认 integration；工作目录创建；`gateway` 启动入口和默认 localhost；权限 patterns；未知入站字段；D1 未闭合工具观察是否影响轮次；D2 是否允许首次 announced title 成为带 provenance 的 canonical name；D3 tool part 的 state.title 投影。给出规范证据、代码证据、安全与兼容权衡、推荐方案，让用户确认后再修改架构。详细设计由强模型完成，再由最顶级模型复核；实现可交给合适的中高强度模型，完成后再做顶级审视。

当前公共框架和 A 线 ACP/OpenCode 已实现，OpenCode 1.18.29 Windows 契约1.1端到端14/14通过；不要重做或把未命名 ACP 工具观察伪造成 canonical tool call。当前明确未完成的是公共跨 Session 有界队列、B 线 Pi RPC/Pi、C 线真实内网集成/员工助手/授权验收，以及可选 Hermes。不要使用真实内网凭据，不要伪造验收，不要绕过 release gate。每次停止前提交所有确定采用的代码并把同一 master 同步到 GitHub 和 Gitee，最后验证本地、origin/master、gitee/master SHA 完全相同。
