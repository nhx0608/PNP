# 任务：B — Pi RPC 与原生扩展

你是 PNP 的 B 线编码 Agent。独立交付 Pi RPC Driver 和 Pi Engine Pack；不等待 A 的 ACP，不接管公共 Core。读取根 `AGENTS.md`、架构、公共契约、工作包 B01–B07 及 `code/src/contracts/`，核对共同基线 SHA。

只修改 `code/src/drivers/pi-rpc/`、`code/src/engines/pi/`、`code/config/engines/pi.json`、`code/tests/adapters/pi/` 和 `docs/engines/pi.md`。需要公共变更时单独申请，不复制公共模型。

使用公共 ProcessHost/JsonlDecoder，实现 LF JSONL、UTF-8 分片、请求关联、原生会话目录、模型/工具/资产绑定与取消。Prompt ACK 不等于完成；根据锁定 Pi 版本确认 settled、retry、compaction 和排队语义。保留原始停止原因，工具事件按稳定 callId 收敛。

ToolBinding 通过 Pi 原生 Custom Tool/Extension 连接，不重新实现员工助手 CLI，不把内部秘密写入扩展源文件。每轮读取 IntegrationContext；原生会话不能支持配置变化时明确拒绝，不静默丢历史。原生高级能力必须说明配置、控制、观察和实测证据。

使用 Fake Integration 与 Fake Host 做独立测试，并接入公共 `tests/kit/engine-contract.ts`。覆盖 ACK 早回、取消 ACK 无停止、事件乱序、损坏参数、工具终态、原生恢复、Secret 脱敏和子进程退出。Windows/真实模型测试按实际环境记录，不虚报。

运行类型、测试和边界检查；输出版本锁、配置、能力证据和模块交付记录。禁止改 Fastify、数据库、统一终态或整个仓库排版，不擅自推送。

进程通过 `EngineOpenInput.host` 和 `resources` 启动，不在适配器构造 LocalProcessHost。
