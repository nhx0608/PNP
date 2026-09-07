# PNP 统一 MCP 接入规范（PNP-MCP/1）

## 1. 目的与边界

本文定义 PNP 提供给 C 的统一 MCP 接入协议。C 可以在 MCP Server 内部调用员工助手 CLI、内网 HTTP 服务或其他内部能力，但交付给 PNP / A / B 的工具边界必须是本规范定义的 MCP Server；A/B 不解析员工助手 CLI 文本，也不为同一内网能力各写一套私有适配。

PNP-MCP/1 是 **MCP 标准之上的互操作 Profile**，不是新的 JSON-RPC 方言：

- wire protocol 使用标准 Model Context Protocol；
- PNP 不新增自定义必选 JSON-RPC method；
- PNP 只规定跨 OpenCode、Pi、Hermes 以及后续 Core 都能稳定消费的 transport、tools、错误、权限和交付约束；
- Core 原生配置如何表达 MCP，由各 Engine Adapter 负责；C 不需要理解 OpenCode/Pi/Hermes 的配置格式。

```text
员工助手 CLI / 内网服务
          │
          │ C 内部适配
          ▼
   PNP-MCP/1 Server
          │
          │ common.mcp.servers
          ▼
   IntegrationContext ToolBinding
          │
     ┌────┼────┐
     ▼    ▼    ▼
 OpenCode Pi Hermes / future Core
```

## 2. 上游协议基线与版本兼容

截至 2026-09-07，MCP 当前规范版本为 `2026-07-28`。新实现以该版本作为规范基线。该版本使用每请求协议元数据，Streamable HTTP 为无会话核心；早期 2025-era 客户端使用 `initialize` / `initialized` 生命周期。

PNP-MCP/1 不在 `settings.json` 中增加协议版本开关。版本协商属于 MCP Client 与 MCP Server 自身职责。

C 必须满足：

1. 对 PNP 当前目标 Core 的实际 MCP Client 版本可互操作，不能因为对方仍使用 2025-era 初始化流程而自行拒绝。
2. 优先使用官方 Tier-1 SDK 的兼容 serving API。SDK 支持同时服务 modern/legacy 时保持兼容模式；除非所有目标 Core 已实测只使用 modern era，否则不得启用 `legacy: reject` 一类配置。
3. 任何版本差异由 MCP SDK / C 的 MCP 边界吸收，不扩散成 PNP Core 分支。
4. 夹具必须记录实际通过的 MCP revision / client version；“支持 MCP”不能只写布尔值。

PNP-MCP/1 的必选功能面仅依赖 Tools，因此不要求 C 为兼容性实现 Roots、Sampling、Prompts、Resources、Tasks 或其他扩展。

## 3. Transport Profile

PNP 只接受标准 transport：`stdio` 与 `streamable-http`。自定义 transport 不属于 PNP-MCP/1。

### 3.1 stdio：本地内网工具的默认方式

员工助手 CLI 包装默认使用 stdio MCP Server。

要求：

- MCP Client 启动并拥有 Server 子进程；Server 不要求用户预先手工启动常驻进程。
- JSON-RPC 使用 UTF-8。
- stdout **只输出 MCP 协议消息**，不得写 banner、调试日志、进度提示或 CLI 原始输出；诊断写 stderr，且先脱敏。
- MCP Server 内部若调用真实 CLI，必须自行解析/适配其 stdout/stderr；原始 CLI 文本不得直接泄漏到 MCP stdout。
- 进程退出码非零表示 Server 进程故障，不得伪装成某个工具的成功结果。
- 取消/关闭 MCP transport 只停止 PNP 所拥有的执行等待和子进程；不能宣称已经撤销外部业务动作。

对应 PNP 配置：

```json
"welink": {
  "transport": "stdio",
  "command": "D:\\pnp-mcp\\welink-mcp.exe",
  "args": ["serve"],
  "env": {
    "WELINK_HOME": "PNP_WELINK_HOME"
  },
  "enabled": true,
  "sideEffect": "external",
  "timeoutMs": 10000
}
```

`command` 必须是可信配置中的绝对路径；真实密钥不进入 JSON，`env` 的 value 是 PNP 进程环境变量名。

### 3.2 Streamable HTTP：远端 MCP 服务

远端 MCP 只使用 Streamable HTTP。要求：

- 使用单一 MCP endpoint；
- 远端地址必须 HTTPS，只有 loopback 开发地址允许 HTTP；
- 认证信息由 `headerEnvironment` 指向环境变量，不写入仓库；
- 遵循协商 revision 对 Streamable HTTP 的 framing、metadata 和 cancellation 规则；
- 连接/请求超时不能自动转换成“工具未执行”的结论。

对应配置示例：

```json
"knowledge": {
  "transport": "streamable-http",
  "urlEnvironment": "PNP_KNOWLEDGE_MCP_URL",
  "headerEnvironment": {
    "Authorization": "PNP_KNOWLEDGE_MCP_AUTHORIZATION"
  },
  "enabled": true,
  "sideEffect": "read",
  "timeoutMs": 10000
}
```

## 4. 必选 MCP 功能面

C 交付的 Server 必须提供标准 Tools 能力，并支持：

- `tools/list`
- `tools/call`

不要求 PNP 依赖其他 MCP primitive。C 可以额外实现 Prompts/Resources 等，但它们不能成为比赛核心工具可用性的前置条件。

`tools/list` 要求：

- 工具集合在底层能力未变化时保持确定性顺序；
- 每个工具名称在该 Server 内唯一；
- 对当前调用身份不可用的工具可以不返回，但不能返回一个必然越权执行的工具；
- schema 无效的工具不能以“尽量调用”方式继续。

## 5. 工具定义 Profile

### 5.1 名称

为避免不同 Core 的名称归一化产生碰撞，PNP-MCP/1 对上游 MCP 名称规则采用更窄的跨 Core 子集：

```text
^[A-Za-z0-9_-]{1,128}$
```

C 不使用空格、点、斜杠、中文或其他会被某些 Core 改写的字符作为 tool name。显示名称可以放 `title` / `description`。

Server id 同样应稳定、短小、只使用字母数字、`_`、`-`。最终暴露给模型的名称可以被 Engine Adapter 加 server 前缀，但审计证据中必须保留原始 server id 与 MCP tool name。

### 5.2 描述与输入 Schema

每个工具必须包含：

- `name`
- 清晰、面向模型的 `description`
- 合法 JSON Schema `inputSchema`

PNP 要求 `inputSchema` 根节点为 object。无参数工具使用显式空 object schema；不要用自然语言要求模型“自己拼字符串”。

参数规则：

- 参数名和含义稳定；
- 必填字段进入 `required`；
- 枚举、路径、对象结构在 Schema 中表达；
- 不把 API key、token、cookie、密码等运行凭据设计成普通 tool 参数；
- 中文文本、中文文件名和 Windows 路径必须按 UTF-8/JSON 正常往返，不做不可逆转义或本地编码猜测。

有稳定结构化输出时可以声明 `outputSchema`；声明后实际 `structuredContent` 必须符合该 Schema。

### 5.3 Tool annotations

C 应按真实行为填写 MCP 标准 annotations：

- `readOnlyHint`
- `destructiveHint`
- `idempotentHint`
- `openWorldHint`

这些字段只是标准 MCP hint，**不是 PNP 授权依据**。PNP 的授权仍以可信配置中的 `sideEffect` 与组织策略为准。

当前 `settings.json` 的 `sideEffect` 位于 MCP Server 级，取值 `read | write | external`。如果同一个 Server 同时包含多个风险级别工具：

- 配置必须使用其中最强风险级别；或
- C 将工具拆成多个 MCP Server，使不同风险级别可分别授权。

不得通过省略 annotations 或 `sideEffect` 降低权限等级；省略 `sideEffect` 时 PNP 默认按 `external` 处理。

## 6. tools/call 结果与错误语义

C 必须保留 MCP 标准的“协议错误”和“工具执行错误”区分。

### 6.1 成功

成功调用返回正常 `CallToolResult`：

- `isError=false`（按协商 revision 的合法表示）；
- `content` 给出对模型可理解的脱敏结果；
- 有机器可读结果时使用 `structuredContent`；
- 有 `outputSchema` 时 `structuredContent` 必须匹配。

### 6.2 工具执行失败

底层 CLI/服务已接收合法调用，但业务执行失败（权限拒绝、对象不存在、业务校验失败、真实 CLI 非零退出等），使用标准 tool error：

- `CallToolResult.isError=true`；
- 返回稳定、非敏感的错误说明；
- 不把账号、token、内部地址、原始响应头或完整 stderr 直接返回模型。

### 6.3 协议错误

未知 tool、非法 JSON-RPC、协议字段不合法等属于 MCP protocol error，不伪造成 `isError=true` 的业务成功响应。

### 6.4 外部副作用与未知提交状态

发送消息、创建记录、修改远端数据等外部副作用必须区分：

```text
明确成功      -> success，可返回非敏感 receipt / object id
明确失败      -> tool error
提交状态未知  -> tool error，明确标记 unknown/uncertain，不得伪造失败或成功
```

C 的 MCP Server **不得因为超时、连接断开或客户端取消而自动重试非幂等操作**。只有真实下游提供幂等语义并且 C 已验证时，才允许基于相同幂等键重试。

如果下游返回业务回执，C 应在 tool result 中保留非敏感 receipt，便于验收与人工核查。

## 7. 并发、超时与取消

- Server 必须能处理 PNP Target Core 实际产生的调用模式。
- 如果真实 CLI 不支持并发，C 在 MCP Server 内串行化同一 CLI/账号的调用；不要要求 A/B 猜测 CLI 锁规则。
- `timeoutMs` 是 PNP 对 MCP 启动/调用等待的上限配置，不证明外部事务未发生。
- 收到取消后停止可停止的本地等待/子进程，并返回/结束符合当前 MCP revision 的取消语义。
- 已提交到外部系统的动作是否可撤销，只能依据真实外部 API/CLI 能力；不能因为 transport 被取消就报告“已撤销”。

## 8. 身份、认证与权限边界

MCP 只统一工具调用协议，不替代真实系统权限。

C 负责：

- stdio Server 所需凭据通过环境/系统登录态取得；
- Streamable HTTP 认证按真实服务要求实现；
- 在员工助手 CLI / 内网服务的真实边界执行账号、资源和操作权限校验；
- 对组织拒绝返回真实失败，不允许模型通过换参数绕过；
- 日志、错误和夹具脱敏。

PNP 负责：

- 根据可信 `sideEffect` 与组织策略给出 allow/ask/deny；
- 将策略投影为各 Core 能够触发的审批机制；
- `deny` 不可被用户审批覆盖。

MCP annotations 不能覆盖上述组织策略，也不能作为授权凭据。

## 9. C 的交付接口

C 对每个内网 MCP Server 至少交付以下非敏感信息：

| 项目 | 必须内容 |
|---|---|
| server id | PNP 配置中的稳定 id |
| transport | `stdio` 或 `streamable-http` |
| 启动/地址 | stdio 的绝对 executable + args，或 HTTP endpoint 的环境变量名 |
| 环境变量 | 变量**名称**及用途，不提交值 |
| MCP 兼容性 | 实测 protocol revision、SDK/Server 版本、目标 Core client 版本 |
| tool catalog | name、description、inputSchema、可选 outputSchema/annotations |
| sideEffect | `read` / `write` / `external`；混合能力取最强或拆 Server |
| timeout | 建议 startup/catalog/call 上限及依据 |
| 幂等性 | 每个有副作用工具是否可重试、依据是什么 |
| 错误表 | permission denied、validation、timeout、unknown submission 等稳定语义 |
| 脱敏证据 | `tools/list` 与代表性 `tools/call` 往返、版本、退出/错误证据 |

C 不需要交付 OpenCode/Pi/Hermes 原生配置文件；A/B 也不需要知道员工助手 CLI 的原始命令格式。

## 10. PNP-MCP/1 验收用例

C02 完成至少需要以下用例全部通过：

| 用例 | 验收 |
|---|---|
| M01 启动 | stdio 由 Client 启动；stdout 无非协议文本；HTTP endpoint 可达 |
| M02 目录 | `tools/list` 成功，名称稳定、Schema 合法、顺序稳定 |
| M03 查询 | 只读工具调用成功，文本与结构化结果不矛盾 |
| M04 UTF-8 | 中文文本、中文路径/文件名完整往返 |
| M05 非法参数 | Schema/业务校验失败，不猜测修复危险参数 |
| M06 权限拒绝 | 真实服务拒绝被保留为失败，不能被默认 allow 覆盖 |
| M07 外部提交成功 | 返回可核查非敏感 receipt/结果，不重复执行 |
| M08 外部提交未知 | 超时/断连后返回 unknown/uncertain，不自动重放 |
| M09 取消 | transport 等待停止；不伪造外部业务撤销 |
| M10 凭据 | 配置、stdout、tool result、stderr 脱敏后均无真实 secret |
| M11 版本兼容 | 使用当前目标 Core 的真实 MCP Client 完成 list + call |
| M12 跨 Core | 同一 MCP Server 配置由至少两个必过 Core 成功投影并调用，不改变 C 的 wire contract |

外网 Mock 可以覆盖 M01–M10 的协议/错误路径，但 M11–M12 和真实员工助手调用必须在内网验收。

## 11. 与 PNP 其他契约的关系

- 配置格式：[`../../code/config/SETTINGS.md`](../../code/config/SETTINGS.md)
- 内网总体责任：[`internal-integration.md`](internal-integration.md)
- 公共 ToolBinding / IntegrationContext：[`contracts.md`](contracts.md)
- 分工与 C02：[`../team/work-packages.md`](../team/work-packages.md)

冲突时优先级：公共 TypeScript contract > 本文 PNP-MCP/1 行为规范 > 配置示例 > C 的内部实现说明。

## 12. 上游参考

- MCP Transports（current）：https://modelcontextprotocol.io/specification/draft/basic/transports
- MCP Tools（current）：https://modelcontextprotocol.io/specification/draft/server/tools
- MCP 2026-07-28 release：https://blog.modelcontextprotocol.io/posts/2026-07-28/
- MCP TypeScript SDK v2 protocol compatibility：https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions

C 可以使用其他语言的官方 SDK；本文不要求 TypeScript，只要求 wire 行为和验收结果符合 PNP-MCP/1。
