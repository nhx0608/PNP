# 任务：C — 独立内网模型、工具与权限

你是 PNP 内网接入编码 Agent。读取根 `AGENTS.md`、`docs/spec/internal-integration.md`、`docs/spec/mcp-integration-profile.md`、`code/config/SETTINGS.md`、公共契约及工作包 C01–C06。你不实现 Agent Loop，不依赖 A/B 的真实引擎完成。

只修改 `code/src/integration/internal/`、对应私有接入测试、`code/config/internal.example.json`、`docs/internal/` 及脱敏验收证据。通过 IntegrationProvider 提供每轮模型解析、工具绑定和授权。

根据真实内网资料确认模型 wire 协议、API key/appid、自定义头、代理与 CA；不要假设鉴权形式。执行文本、工具调用、工具结果回传、多工具增量和中文路径参数往返探针。默认直连，必要的最小协议适配属于本模块，不修改 Core。

员工助手/内网工具的对外工具边界必须符合 `PNP-MCP/1`。你可以在 MCP Server 内部包装真实 CLI/HTTP，但不要让 A/B 解析 CLI 文本，也不要输出 OpenCode/Pi/Hermes 私有配置。员工助手本地 CLI 默认交付标准 stdio MCP Server；实现 `tools/list`/`tools/call`、稳定 tool name、合法 JSON Schema、标准 MCP tool/protocol error、UTF-8 中文路径、副作用/幂等/取消/unknown submission 语义。使用官方 SDK 的兼容 serving 能力；对当前目标 Core 的实际 MCP client version/protocol revision 做 list+call 实测，不因 2025-era 初始化客户端而自行拒绝。

MCP stdout 只能输出协议消息；内部 CLI 日志写脱敏 stderr。真实凭据只从环境/系统登录态取得。MCP annotations 只是 hint，PNP 授权仍以可信 `sideEffect` 与组织策略为准；deny 不能被默认 allow、annotation 或用户回复覆盖。超时、断连、取消导致外部提交状态未知时不可自动重试非幂等操作，也不可宣称外部动作已撤销。

提供不含内部地址、账户、密钥和真实用户材料的模型与 MCP 夹具，使 A/B 能离线验证目录、调用、错误、UTF-8、权限、取消和 unknown submission。C02 以 `PNP-MCP/1` M01–M12 为验收基线；发布配置只提供 server id、transport、绝对 executable/args 或 endpoint 环境变量名、所需环境变量名称、sideEffect、timeout、SDK/Server/protocol revision、tool catalog 与幂等说明。

最终联合验收在内网 Windows 进行，记录代码 SHA、引擎版本、模型配置指纹、MCP Server/SDK/protocol revision、员工助手 CLI 版本、权限、桌面可用性、任务轨迹和输出检查。同一 MCP Server 至少由两个必过 Core 成功投影并调用。模型裁判结果与本地自检分开，不伪造官方分数。
