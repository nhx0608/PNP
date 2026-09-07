# 内网对接契约与验证责任

## 1. 边界

内网对接作为 IntegrationProvider 实现，与 Agent 系统运行控制解耦。它不参与 Session 状态转换、消息排序、模型迭代、引擎选择或最终完成判定。

```text
公共 Core → IntegrationProvider.prepare
             ├─ 模型选择 → 实际服务、协议、鉴权、CA
             ├─ 工具目录 → 统一 MCP → 员工助手 CLI / 内网服务
             ├─ 资产描述 → 获批指令与技能
             └─ 授权函数 → 组织策略判断

Engine Adapter → 根据统一绑定生成各自原生配置
Harness → 内网模型 / MCP 工具
```

C 对工具侧的跨团队交付边界是 [`PNP-MCP/1`](mcp-integration-profile.md)。C 可以在 MCP Server 内部适配真实 CLI/HTTP，但 A/B 与 Core 只消费标准 MCP，不解析员工助手 CLI 文本、不依赖内网私有命令格式。

## 2. 模型接口

输入是 `ModelSelection`、Session 和 AbortSignal。输出是已授权端点、协议、认证头及证书文件引用。不能接受 Prompt 中的任意 URL 作为模型端点。

C 必须确认：

- 模型协议的真实形态与路径，是否支持 chat completions、Messages 或其他协议。
- API key、appid、签名、额外 Header、组织上下文、有效期和刷新方法。
- 内部 CA、代理、网络访问限制。禁止关闭 TLS 校验。
- 流式与非流式工具调用、工具参数分片、多调用并行、工具结果回传、停止原因及错误格式。
- 图片输入、上下文限制、模型标识映射。没有视觉能力不得标为支持视觉。

每轮 `prepare` 可以刷新凭据，`release` 清除临时资源。Session 和 Run 只保存模型选择标识与非敏感配置摘要，不保存解析后的密钥。

默认 Harness 直连模型。兼容模块只解决经过复现的具体问题，不建设通用模型路由平台。参数已经丢失或无法可靠解析时必须失败，不能凭空补 JSON 后继续执行危险工具。

## 3. 员工助手 CLI 与统一 MCP

员工助手 CLI 是否原生支持 MCP、是否需要登录、是否会弹确认、是否有幂等能力，都由真实 CLI 文档和测试确定，不能假定。但无论真实 CLI 长什么样，C 对 PNP 的最终工具交付必须收敛到 [`PNP-MCP/1`](mcp-integration-profile.md)。

职责固定如下：

```text
真实员工助手 CLI / 内网服务
          │
          │ C 负责包装、鉴权、错误与副作用语义
          ▼
   PNP-MCP/1 Server
          │
          │ PNP common.mcp.servers
          ▼
   IntegrationContext ToolBinding
          │
      A/B Engine Adapter
```

C 必须提供：

- 标准 `stdio` 或 `streamable-http` MCP Server；员工助手本地 CLI 默认用 `stdio`。
- `tools/list` 与 `tools/call`，稳定 tool name、description、合法 JSON Schema `inputSchema`。
- 对中文文本、中文文件名和 Windows 路径的 UTF-8/JSON 往返。
- 标准 MCP tool error 与 protocol error 的区分。
- 对 read/write/external 副作用、幂等性、超时、取消和未知提交状态的真实语义。
- 不含真实凭据的启动配置、工具目录、兼容版本说明、Mock/夹具与内网验收证据。

C 可以在 MCP Server 内部使用固定 executable/args 调用真实 CLI，并自行解析 stdin/stdout/stderr；stdout 的 MCP transport 只能出现协议消息，内部 CLI 日志进入脱敏 stderr。A/B 不各自解析一套内部 CLI 文本，也不要求 C 提供 OpenCode/Pi/Hermes 原生配置。

PNP 的 MCP 配置格式见 [`../../code/config/SETTINGS.md`](../../code/config/SETTINGS.md)。`settings.json` 只表达 server id、transport、command/url、环境变量引用、enabled、sideEffect、timeout；如何把 CLI 变成符合 PNP-MCP/1 的 Server 属于 C。

对于消息发送、创建外部记录等操作：幂等键只有在实际服务支持时才提供 exactly-once 类保证。发送结果未知时禁止自动重试；超时/断连/取消不能推导为“未执行”。操作回执与可观察结果必须保留。删除文件要限定授权范围，但网关不按测试任务 ID 写删除脚本。

如果一个 MCP Server 暴露多个不同风险等级的工具，`settings.json` 的 server-level `sideEffect` 必须取最强等级，或由 C 拆为多个 MCP Server；不得依赖 MCP annotations 降低组织授权等级。

## 4. 权限

C 的组织策略返回 allow/deny/ask，并提供非敏感 reasonCode。默认自动许可只能在组织策略允许的边界内生效。

审批接口不能越权批准模型、目录、工具或数据访问。一个引擎若无法拦截某类原生工具，需要声明限制并使用操作系统/CLI 自身的授权约束；不能宣称网关仅凭一次握手即可限制所有原生执行。

A/B 负责将策略编译到实际 Harness 的许可配置，并把运行时审批请求转成公共 InteractionRequest。C 负责策略真实性和内部服务复核，不需要理解 ACP/Pi 的事件格式。

MCP 标准的 `readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint` 只能作为行为提示；PNP 授权依据仍是可信配置中的 `sideEffect` 与组织策略，`deny` 不能被 MCP annotation 或用户回复覆盖。

## 5. 桌面身份与生命周期

需要 GUI 的最终评测必须运行于可访问用户桌面的身份。检查实际 GUI 执行器的会话、桌面可访问性、登录状态与权限，而不只检查启动脚本是否位于 Session 0。

用户应用、员工助手、浏览器与 Harness 工作进程需区分归属。不能用“所有 Office 进程为零”作为统一验收目标；例如打开应用的任务应保留目标窗口。C 说明 CLI 是否通过现有应用进程执行动作，A/B 说明其原生 Shell 是否会把目标应用纳入 Job。最终按实际任务结果验证。

MCP transport 生命周期只覆盖 PNP 所拥有的连接/Server 进程。关闭 stdio Server、关闭 HTTP 请求或取消 tool call 不表示外部业务动作被撤销。

## 6. A/B 所需的可公开夹具

C 提供不含真实内网信息的：

| 夹具 | 内容 |
|---|---|
| 模型正常响应 | 文本、单工具、多工具、分片、结果回传、正常停止 |
| 模型异常响应 | 鉴权失败、配额、超时、流中断、损坏工具参数 |
| MCP 目录 | `tools/list`、稳定名称、合法 inputSchema、可选 outputSchema/annotations |
| MCP 工具正常响应 | 查询、中文路径、文件操作和模拟外部提交的标准 `tools/call` 结果 |
| MCP 工具异常响应 | 参数错误、权限拒绝、底层 CLI 非零退出、超时、取消、提交状态未知 |
| MCP 兼容性 | target Core client 与 Server 的 protocol revision / SDK 版本及 list+call 证据 |
| 授权响应 | allow、deny、ask，以及过期或失效上下文 |

夹具中的内部域名、账号、工号、令牌和文件内容使用专用测试占位值。完整真实日志和业务材料只能保存在内网。

## 7. 内网最终验证

C 维护环境与测试证据；A/B 对自身适配器失败负责。每个参赛引擎必须使用同一套 Gateway API、批准模型资源和匹配的能力配置完成测试。

证据包含 Git commit、操作系统、Node 版本、Harness 版本、通道、模型 Profile ID、MCP Server/SDK/protocol revision、员工助手 CLI 版本、工具目录摘要、权限、资产摘要、用例标识、运行结果、停止状态和脱敏产物引用。不得保存真实凭据。

验收覆盖：安装/启动、模型工具往返、PNP-MCP/1 M01–M12、目录与权限、多轮会话、SSE/消息快照、取消、崩溃恢复、未知提交不重放、官方已提供任务材料的真实执行。外网 Mock 的通过不能替代真实 Harness + 内网 MCP 的联合验收。
