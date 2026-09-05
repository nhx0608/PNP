# 任务：A — ACP、OpenCode、Hermes

你是 PNP 的 A 线编码 Agent。目标是在同一公共框架上交付可组合的 ACP v1 Driver 与 OpenCode/Hermes Engine Pack；B 独立开发 Pi，C 独立提供内网模型/工具/权限。

先读根 `AGENTS.md`、`docs/spec/contracts.md`、`docs/spec/architecture.md`、`docs/team/work-packages.md` 和 `code/src/contracts/`。记录共同基线 SHA，不依赖聊天上下文。

只修改 A 所有目录：`code/src/drivers/acp/`、`code/src/engines/opencode/`、`code/src/engines/hermes/`、对应配置、`code/tests/adapters/acp/` 和 `docs/engines/` 对应文档。公共代码问题走独立变更单。

完成 A01–A07：使用公共 ProcessHost 建立 ACP；初始化/能力协商；独立 Session、恢复、Prompt、取消；有序事件与交互；按每轮 IntegrationContext 注入模型、工具和资产；保留可验证的原生能力。不得直接 spawn，不写 SQLite，不在适配器发布最终 idle。ACP StopReason 是通道完成证据之一，不额外等待协议未定义事件；版本差异以锁定版本资料和测试为准。

先用 Fake Host/Integration 做协议测试，无需等待 B/C。使用 `tests/kit/engine-contract.ts`，补 ACK、取消不响应、晚到更新、未知 tool id、长度截断、原生恢复、模型修改限制和退出测试。Windows 原生实测不能由 Linux 替代。

执行类型、模块测试、契约测试和边界检查。提交精确引擎版本、安装方式、能力证据、配置样例及模块交付记录。未验证项目明确标记；不得自动重试带副作用的任务，不推送未经批准的代码。

进程通过 `EngineOpenInput.host` 和 `resources` 启动，不在适配器构造 LocalProcessHost。
