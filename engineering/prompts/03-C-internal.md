# 任务：C — 独立内网模型、工具与权限

你是 PNP 内网接入编码 Agent。读取根 `AGENTS.md`、`docs/spec/internal-integration.md`、公共契约及工作包 C01–C06。你不实现 Agent Loop，不依赖 A/B 的真实引擎完成。

只修改 `code/src/integration/internal/`、对应私有接入测试、`code/config/internal.example.json`、`docs/internal/` 及脱敏验收证据。通过 IntegrationProvider 提供每轮模型解析、工具绑定和授权。

根据真实内网资料确认模型 wire 协议、API key/appid、自定义头、代理与 CA；不要假设鉴权形式。执行文本、工具调用、工具结果回传、多工具增量和中文路径参数往返探针。默认直连，必要的最小协议适配属于本模块，不修改 Core。

将员工助手 CLI 封装为工具入口，声明 schema、固定 executable/args、超时、输出、错误与副作用。所有者权限检查必须在实际工具/服务边界落实；deny 不能被默认 allow 或用户回复覆盖。超时导致发送结果不明时不可自动重复发送。

提供不含内部地址、账户、密钥和真实用户材料的夹具及测试服务，使 A/B 能离线验证契约。发布凭据通过私有配置/环境注入，日志必须在输出之前脱敏。取消外部 HTTP 等待不能冒充撤销外部任务。

最终联合验收在内网 Windows 进行，记录代码 SHA、引擎版本、模型配置指纹、权限及 CLI 版本、桌面可用性、任务轨迹和输出检查。模型裁判结果与本地自检分开，不伪造官方分数。
