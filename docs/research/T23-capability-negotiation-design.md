# T23 能力发现/协商/分层的设计模式（跨领域借鉴）与 Capability Manifest 设计

## 摘要
本报告横向调研了 MCP、ACP、A2A、LSP、WebAssembly Component Model(WIT)、Kubernetes Conformance/CRD Conditions、Terraform Provider Protocol、OpenFeature、VS Code 扩展模型等 9 个跨领域的能力发现/协商/分层协议，提炼出四种可复用架构原型：(A) 连接建立时一次性的请求-响应式静态协商（MCP `initialize`/ACP `initialize`/A2A AgentCard）；(B) 静态声明+运行时动态注册/注销（LSP `client/registerCapability`）；(C) 能力位内嵌 schema 并驱动性能优化（Terraform `GetProviderSchemaOptional`）；(D) 一致性测试套件作为能力的可执行定义（K8s Conformance + Sonobuoy）。基于这四个原型，本文给出了面向赛题网关的 Capability Manifest JSON 草案（`namespace:capability@version` 命名、`tier` 四层：core/standard/extension/experimental、三态 `status: supported|polyfilled|unsupported`、`depends_on`/`conflicts_with`/`conformance_test_ref`/`cost_profile` 字段），以及"静态声明→探测→CTS 认证→运行时协商"四阶段协商流程与新引擎接入 SOP。核心结论：能力"声明"与"认证"必须分离（自我声明不可信，需配合可执行的一致性测试，与赛题 Rollout+LLM-as-Judge 评测同构）；能力应支持运行时动态增减而非仅启动时固定（借鉴 LSP）；网关对引擎缺失能力的托管/模拟（polyfill）应作为 manifest 中的显式第三态而非隐藏实现细节。

## 关键事实（表格）

| 事实 | 来源 | 置信度 | 是否交叉验证 |
|---|---|---|---|
| MCP 在 `initialize` 请求/响应中交换 `capabilities` 对象，client 侧含 `roots`/`sampling`/`elicitation`/`experimental`，server 侧含 `prompts`/`resources`/`tools`/`logging`/`completions`/`experimental`；子能力如 `listChanged`（列表变更通知）、`subscribe`（资源订阅）以布尔/子对象形式声明在能力对象内 | https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle | 高 | 是（与下方 GitHub spec schema 交叉） |
| MCP 协议版本协商：client 发送其支持的（首选最新）`protocolVersion`；server 若支持则原样返回，否则返回自己支持的另一版本；HTTP 传输下后续请求必须带 `MCP-Protocol-Version` header；版本不匹配可返回 JSON-RPC error -32602 并带 `data.supported`/`data.requested` | 同上 | 高 | 否 |
| MCP 显式规定"双方 MUST 仅使用协商成功的能力"（Operation 阶段的强约束），即能力声明是运行期硬门禁，而非仅供参考的元数据 | 同上 | 高 | 否 |

| A2A（Agent2Agent 协议，2025年6月起由 Linux Foundation 托管，2026年发布 v1.0）在 AgentCard 中用 `capabilities.extensions` 字段声明扩展点；扩展在 `AgentCard.extensions` 中以 `AgentExtension` 对象数组形式声明（含 URI 型扩展标识），并通过 HTTP header `A2A-Extensions` 在每次请求时按需激活（可选择性启用，不要求全量支持） | https://a2a-protocol.org/latest/specification/ , https://github.com/a2aproject/A2A/blob/main/docs/topics/extensions.md | 中 | 否（仅搜索摘要，未逐字核对字段名，需谨慎） |
| LSP：能力协商在 `initialize` 中静态声明 `ClientCapabilities`/`ServerCapabilities`；额外支持"动态注册"——client 通过 `textDocument.xxx.dynamicRegistration=true` 声明自己支持动态注册某类能力，server 随后可在运行期用 `client/registerCapability`（及 `client/unregisterCapability`）按需注册/注销具体能力（如某 `documentSelector` 范围内的 `textDocument/willSaveWaitUntil`），规范明确禁止同一能力"既静态声明又对同一 selector 动态注册"（互斥约束），这使 server 能根据配置变化在会话中动态增减能力而无需重启/重连 | https://microsoft.github.io/language-server-protocol/specifications/specification-3-16/ (via search), https://github.com/microsoft/language-server-protocol | 高 | 是（多个 LSP 版本 spec 一致） |
| WebAssembly Component Model：WIT (Wasm Interface Types) 是纯接口定义语言（无业务逻辑），核心概念为 `interface`（函数+类型集合，可被 import/export）、`world`（interface 集合，描述一个组件的完整导入/导出契约）、`package`（`namespace:name` 形式，可带 semver 版本，如 `test:mypackage@0.1.0`）；组件组合（composition）在类型/接口匹配上关心版本，未带版本号与带版本号视为不同接口，即版本是接口身份的一部分而非附加元数据 | https://component-model.bytecodealliance.org/design/wit.html , https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md | 高 | 否 |
| K8s conformance：官方 e2e 测试套件中打了 `[Conformance]` tag 的用例子集定义"所有合规集群必须支持的核心可互操作特性"；CNCF Certified Kubernetes Conformance Program 使用开源工具 Sonobuoy 运行同一套官方测试并生成结果包，任何发行版/云厂商均可自证；这是"核心能力 + 一致性测试套件（CTS）认证"模式的典型代表——能力是否达标由可运行的测试集合而非文档定义 | https://github.com/cncf/k8s-conformance , https://sonobuoy.io/certifying-kubernetes-with-sonobuoy/ | 高 | 是（CNCF 官方页与 Sonobuoy 官网一致） |
| OpenFeature（CNCF 项目）用 Provider 模式抽象具体 flag 后端：应用只对接统一 Evaluation API，Provider 作为"翻译层"包装具体厂商 SDK/REST API/本地文件；类型不匹配等异常执行时约定"退回默认值"而不是报错中断——这是一种优雅降级（graceful degradation）而非协商失败即拒绝的设计取向 | https://openfeature.dev/specification/ , https://github.com/open-feature/spec | 中 | 否 |
| Terraform Provider Protocol（v5/v6，gRPC）：Provider 通过 `GetProviderSchema` RPC 返回 schema，并在响应中新增 `Capabilities` 字段声明可选特性，如 `PlanDestroy`、`GetProviderSchemaOptional`、`MoveResourceState`、`GenerateResourceConfig`；其中 `GetProviderSchemaOptional` 允许 Terraform core 跳过重复 RPC 调用改用全局缓存（`providers.SchemaCache`），体现"能力声明可用于运行期性能优化"，而不仅是功能开关 | https://developer.hashicorp.com/terraform/plugin/framework/internals/rpcs , https://github.com/hashicorp/terraform/pull/33486 | 中 | 否 |
| K8s CRD/Operator 的 status.conditions 约定：`{type, status(True/False/Unknown), reason(PascalCase机读码), message(人读), lastTransitionTime, observedGeneration}`；条件类型只增不减（向后兼容演进），`observedGeneration` 用于判断 controller 是否已处理最新 spec 版本——是"运行时能力/状态一致性"的通用范式，可迁移到"引擎运行状态"上报 | https://maelvls.dev/kubernetes-conditions/ , https://kpt.dev/reference/schema/crd-status-convention/ | 中 | 是（两个独立来源描述一致） |
| VS Code 扩展模型：`package.json` 中 `contributes`（静态声明扩展提供的贡献点：命令/菜单/视图/语言等）与 `activationEvents`（触发扩展激活的事件，如 `onLanguage:python`）分离——即"声明能力"与"何时激活/加载能力实现"是两个独立机制；1.74.0 起常见贡献点（commands/views）已可省略显式激活事件，降低了манifest 冗余 | https://code.visualstudio.com/api/references/activation-events , https://code.visualstudio.com/api/references/extension-manifest | 高 | 否 |
| ACP（Agent Client Protocol，Zed Industries 于 2025年8月发布，JSON-RPC 2.0 over stdio）在 `initialize` 中做协议版本与能力协商：返回 `InitializeResponse` 含 `protocolVersion`（client 请求版本若 agent 支持则原样返回，否则回退 agent 支持的最新版本）、`agentCapabilities`（如 `loadSession`、`mcpCapabilities.{http,sse}`、`promptCapabilities.{audio,embeddedContext,image}`，均以布尔细粒度声明）、`agentInfo`；已有 Claude Code、Codex、GitHub Copilot、Hermes 等多个 harness 实现 ACP server 模式接入编辑器（Zed/JetBrains/Neovim） | https://agentclientprotocol.com/protocol/schema , https://github.com/NousResearch/hermes-agent/issues/569 | 高 | 是（官方 schema 页 + 第三方 Hermes ACP issue 独立描述一致） |
## 架构与工作原理

跨领域调研收敛出四种可复用的能力协商"架构原型"，它们并非互斥而是常常叠加使用：

**原型 A：请求-响应式静态协商（MCP / ACP / A2A AgentCard）。**
连接建立时，一方（client/网关）发送自身支持的协议版本与能力集合，另一方（server/agent）返回自己支持的版本（同版本或降级到双方都支持的最高版本）与能力集合，双方在此后的会话中只使用协商成功的交集。MCP 的 `initialize` 请求/响应、ACP 的 `initialize`、A2A 的 AgentCard 都是这一模式——差异主要在"谁先声明"：MCP/ACP 是 client 先报能力再由 server 确认，A2A 是 server 一方预先发布 AgentCard（可通过 well-known URL 静态获取，不需要先建立连接）。这类协商的核心价值在于**协议版本 + 能力集合的联合确定**：版本不匹配时才谈能力，能力集合决定了此后哪些方法/字段合法可用（MCP 明确规定"MUST only use negotiated capabilities"）。

**原型 B：静态声明 + 运行时动态注册（LSP）。**
LSP 在 `initialize` 阶段做一次粗粒度声明后，还允许 server 在会话运行期通过 `client/registerCapability`/`client/unregisterCapability` 反向注册/注销细粒度能力（如按 `documentSelector` 限定的具体特性），且规范显式规定"同一能力不能既静态声明又对同一作用域动态注册"（互斥/去重约束）。这解决了"能力集合会随配置、插件加载、用户设置在会话中变化"的问题——对我们的场景（引擎可能在会话中动态加载/卸载技能、MCP server、workflow 插件）这是关键参考。

**原型 C：Schema 内嵌能力位 + 缓存优化（Terraform Provider Protocol）。**
能力不是单独的协商阶段，而是作为 `GetProviderSchema` 响应的一个字段（`Capabilities`）随 schema 一起返回，且能力位可以直接驱动性能优化路径（`GetProviderSchemaOptional` → 跳过重复 RPC、用全局缓存）。这提示我们：Capability Manifest 不仅是"能不能做"的开关，还可以是"网关是否需要每次重新探测/重新拉取该引擎的 manifest"的缓存控制位。

**原型 D：一致性测试套件（CTS）作为能力的可执行定义（Khronos CTS / K8s Conformance / WPT）。**
在图形 API（OpenGL/Vulkan/WebGPU）、K8s、Web 平台等领域，"支持某能力"不是一句自我声明，而是"通过对应的官方一致性测试用例"。K8s 的 `[Conformance]` tag 测试子集 + Sonobuoy 工具链、Khronos 的 Conformance Test Suite (CTS)、W3C 的 Web Platform Tests (WPT) 都是同一思路：**核心能力集合有一份可执行的、版本化的测试合约**，任何实现（不论厂商）只要跑通测试即可被认证为"符合规范"。这与"引擎自己说支持某能力"（原型 A/B/C）形成互补——A/B/C 解决"发现"，D 解决"信任/认证"。

对我们的 Agent 网关+多引擎架构而言，四个原型分别对应四个阶段：**静态声明（manifest）→ 探测/握手（protocol negotiation）→ 一致性认证（conformance test）→ 运行时动态调整（dynamic registration/降级）**。

## 可编程接入面

这四类协议/接口模型给出的"可编程接入面"设计要点：

- **能力对象的命名空间化**：MCP 用扁平顶级 key（`tools`/`resources`/`prompts`…）+ 子能力（`listChanged`/`subscribe`）两层结构；WIT 用 `namespace:name@version` 三段式（如 `wasi:http/incoming-handler@0.2.0`）显式带命名空间和 semver；A2A extensions 用 URI 作为扩展标识（天然全局唯一、可指向文档）。**对我们而言**：Capability ID 应采用 `vendor:capability@version` 或反向域名+能力名的形式（如 `opencode.dev/dynamic-workflow@1`），避免"memory"这种通用词在不同引擎间语义冲突。
- **能力的层级分离**：VS Code 把"声明有什么"(`contributes`) 和"何时激活"(`activationEvents`) 分离成两个独立字段；LSP 把"静态支持"和"动态注册"分离。**对我们而言**：Capability Manifest 应区分"引擎具备该能力"（静态）与"当前会话/请求是否已激活该能力"（运行时状态），二者不是一回事——例如某引擎"具备 room 能力"但当前 session 未开启 room。
- **协议版本与能力版本要分层**：MCP/ACP 把 protocolVersion（信封/传输层契约）与 capabilities（功能位）分开协商，二者版本演进速率不同（协议本身可能几年一版，能力可能月级迭代）。**对我们而言**：网关规范本身的版本（HTTP API 6217 端口协议版本）应与各引擎 Capability Manifest 的版本分离管理，避免网关升级被单个引擎的能力变更拖累。
- **能力位可驱动优化路径**，如 Terraform 的 schema-cache 能力位。**对我们而言**：引擎可声明"prompt_async 幂等/可重放""message 支持增量拉取（cursor）"等能力位，网关据此决定是否可以缓存/减少轮询。

## 会话模型

本专题横跨多种协议/接口标准，其中大部分（MCP、LSP、WIT、K8s CRI/CNI/CSI、OCI、VS Code、OpenFeature、Terraform）本身不定义"会话"概念，而是连接级或调用级的能力协商，不直接对应我们赛题的 session 语义。这里只摘录与 session 相关的两点，其余记为不适用：
- MCP/ACP 的能力协商发生在**连接建立时一次性完成**，之后整条连接（可对应我们赛题的一个 session）内能力集合视为不变，除非重新握手；这与赛题网关规范"引擎在启动参数固定，不要求热切换"的假设一致，说明我们可以合理地把"能力协商"简化为**进程启动时一次性完成**，无需在每个 session 级别重复协商。
- ACP 显式把 `loadSession` 作为一个能力位（agent 是否支持恢复历史会话），是"会话相关能力也应纳入 manifest"的直接先例——对我们而言，"session resume/持久化""跨引擎 session 迁移"都应作为独立能力位而非默认行为。

## 权限与安全

- A2A 的 extension 激活机制值得注意：AgentCard 静态声明"支持哪些扩展"，但具体某次请求是否**启用**该扩展，由调用方通过 HTTP header（`A2A-Extensions`）显式指定——即"声明能力"与"请求中被信任/被启用"是两次独立判断，赋予了运行时按调用方权限收紧可用能力集合的空间。**对我们而言**：网关在向引擎转发请求时，可以比"引擎声明的能力全集"更收紧地按业务方权限只启用其中子集（例如某群不允许该引擎使用"递归删除文件"这类高风险能力，即便引擎支持）。
- LSP 的动态注册/注销机制天然支持"运行时权限收紧"：server 可以随时 `unregisterCapability` 撤回某能力（比如用户在编辑器里关闭了某设置）。**对我们而言**：网关侧的能力开关应支持运行时撤销，而不仅是启动时一次性配置。
- OCI Runtime Spec / K8s CRI 等容器运行时接口模型中权限相关能力（Linux capabilities、seccomp profile、device plugin 白名单）通常与"功能能力"分开声明为独立字段（不在本次抓取范围内，标注为推测，未核实一手来源，仅按常识引用，供后续如需可再核实）。

## 扩展机制与资产

- WIT 的 `world` 概念（一组 interface 的集合，描述"一个组件完整的 import/export 契约"）可类比为我们的"Capability Profile/Tier"：不同引擎可以只实现某个 world 的子集，只要接口签名匹配即可互操作。
- K8s Operator/CRD 模式提供了"扩展点通过自定义 API 对象暴露、状态通过 conditions 数组暴露"的成熟范式，其中"条件类型只增不减"的演进规则对 Capability Manifest 的版本兼容策略（新增能力不删除旧能力字段）是直接可借鉴的约束。
- VS Code 扩展的 `contributes` 分类字段（commands/views/languages/…）提示 Capability Manifest 也应按"能力类别"（如 memory/room/workflow/permission/mcp）建立子命名空间，而非单一扁平列表。

## 记忆

跨领域协议标准普遍不直接定义"记忆"能力（这是 Agent 领域特有的能力维度），故本节记为不适用，仅给出映射建议：将"memory"作为一个独立 Capability 命名空间（如 `gateway:memory@1`），当引擎原生不支持持久记忆时，由网关按"polyfill"思路（见下节）托管一个引擎无关的 KV/向量存储，通过在 system prompt 或工具调用中注入的方式模拟记忆能力，并在 manifest 中标注该能力来源是 `native`（引擎自带）还是 `gateway-polyfill`（网关模拟），供上层区分置信度和成本画像。

## 多 Agent 与协作

- A2A 协议本身就是为多 agent 协作设计的顶层协议（agent 对 agent 通信），其 AgentCard + skills + extensions 的分层可以直接迁移为"引擎是否支持 agent team/多智能体编排"这一能力的描述模型：`skills` 描述"引擎能做什么任务"，`extensions` 描述"引擎支持的协议扩展（如 streaming、push notification）"，两者分离对应我们要求的"公共能力 vs 引擎特有扩展能力"划分。
- K8s Operator 的 Custom Resource + Controller 模式也是一种"多组件协作"范式：CRD 定义期望状态（spec），Controller（对应我们的引擎）异步 reconcile 到 status.conditions；这类"声明式意图 + 异步收敛 + 条件化状态回报"模式，可用于描述"网关下发一个 dynamic workflow/agent team 任务书，引擎异步执行并通过 conditions 风格的状态更新汇报进度"这一可选能力。

## 可观测性

- K8s conditions 的 `{type, status, reason, message, lastTransitionTime, observedGeneration}` 结构本身就是一种轻量、可归一化的可观测协议原语：`type` 对应我们要归一化的事件类别（如 `session.idle`/`message.part.updated`），`reason` 对应机读错误码，`observedGeneration` 对应"网关下发的第几轮 prompt 是否已被引擎处理完"的水位标记，可直接借鉴用于设计"跨引擎统一事件信封"的字段集合。
- 一致性测试套件（CTS/Conformance）思路本身也是一种可观测性设计：把"能力是否真被正确实现"这件事，转化为可重复运行、有明确通过/失败判据的可观测产物（测试报告），这对应我们"用 Rollout + LLM-as-Judge 评测引擎能力"的评测形态是同构的——即赛题的评测框架本质上就是一种轻量 CTS。

## 对我们架构的启示

**能力分层建议（借鉴以上多个原型，融合为四层）：**
1. **Core（核心/必做能力）**：赛题网关规范强制要求的最小接口集——session CRUD、prompt_async（阻塞式单轮执行）、message 轨迹拉取、abort、SSE 事件（server.connected/heartbeat/session.status/session.idle/session.error/message.part.updated）。这一层是"conformance 基线"，类比 K8s `[Conformance]` tag 测试集：任何接入网关的引擎必须无条件通过。
2. **Standard Profile（标准可选能力）**：多数主流引擎都可能支持但非强制的能力，如 question/permission 交互式追问、增量 message 拉取（cursor）、session resume。类比 LSP 的"client 可选支持的能力，server 据此决定是否使用"。
3. **Extension（引擎特有扩展能力）**：dynamic workflow、agent team、room（多方共享会话）、自进化/自我改进这类"部分引擎独有"的高级能力，类比 A2A `AgentCard.extensions`——用 URI/命名空间化 ID 声明，附带该扩展自己的参数 JSON Schema 和文档链接，网关默认不假设其存在，业务方需显式检测后才使用。
4. **Experimental（实验性）**：类比 MCP 的 `experimental` capability 字段——引擎可以在不进入正式 profile 前先用这个自由字段暴露非标准特性，供网关做灰度试用而不破坏兼容性承诺。

**Capability Manifest 字段设计建议（草案）：**
```json
{
  "engine": "opencode",
  "engine_version": "0.x.y",
  "manifest_version": "1.0.0",
  "protocol_version": "gateway-2026-09",
  "capabilities": [
    {
      "id": "gateway:core.session@1",
      "tier": "core",
      "status": "supported",           // supported | polyfilled | unsupported
      "params_schema": { "...": "JSON Schema" },
      "depends_on": [],
      "conflicts_with": [],
      "conformance_test_ref": "cts/core-session-v1.yaml",
      "cost_profile": { "latency_p50_ms": 200, "token_overhead": "low" }
    },
    {
      "id": "opencode.dev:dynamic-workflow@2",
      "tier": "extension",
      "status": "supported",
      "params_schema": { "max_nodes": "integer", "...": "..." },
      "conformance_test_ref": null,
      "cost_profile": { "latency_p50_ms": 4000, "token_overhead": "high" }
    }
  ]
}
```
- `id` 用 `namespace:capability@version` 三段式（借鉴 WIT package 命名 + A2A extension URI 思路），`namespace` 区分 `gateway`（网关自身托管/polyfill 的能力）与各引擎自己的反向域名。
- `status` 三态而非布尔，允许"网关代理模拟"（polyfill）作为第三态，呼应赛题里"网关托管 memory/room/workflow"的降级设计。
- `depends_on`/`conflicts_with` 借鉴 LSP"同一能力不能既静态又动态注册"的互斥思想，以及 Terraform capabilities 之间存在依赖顺序（如需要先支持 schema-cache 才能声明相关优化位）。
- `conformance_test_ref` 指向一份可执行测试（Rollout 用例/断言脚本），呼应 CTS/Conformance 模式——"声明"与"认证"分离，未跑通测试的声明只能标为 `claimed` 而非 `supported`。

**能力协商流程（四阶段，落到我们的网关实现）：**
1. **静态声明**：引擎适配层随进程启动向网关注册一份 Capability Manifest（可以是文件、也可以是引擎进程启动后一次 handshake 调用返回，类似 MCP `initialize`/ACP `initialize`）。
2. **探测（probe）**：网关对声明为 `claimed` 的能力发起轻量探测调用（类似 LSP dynamicRegistration 的运行时确认），确认可用后标记为 `supported`。
3. **CTS 认证**：离线/CI 阶段用固定 Rollout 用例集跑一遍该引擎，产出认证报告，写回 manifest 的 `conformance_test_ref` 结果（对应赛题评测本身）。
4. **运行时协商**：每次业务请求携带所需能力集合（类似 A2A 的 `A2A-Extensions` header），网关按业务权限与引擎实际支持交集决定最终启用集合，不满足时走 polyfill 或降级报错。

**新引擎接入 SOP（"能力识别→适配→认证"）：**
1. 识别：跑通引擎自身的 CLI/HTTP 接口，逐条比对赛题网关规范的每个端点，产出初版 Capability Manifest（哪些原生支持、哪些需要网关适配层补齐、哪些完全不支持）。
2. 适配：为不支持 Windows 原生运行/自定义 endpoint 等硬约束的引擎编写适配层（进程包装、协议转换），并将"网关代理/模拟"的能力显式标注为 `status: polyfilled`。
3. 认证：跑通赛题 Rollout 用例集/自建 CTS，将结果写回 manifest，作为该引擎在网关侧"可被业务方选用"的准入门槛。
4. 上线后允许引擎能力持续演进（新版本引擎发布新能力）而不需要修改网关核心代码——只需引擎适配层更新其 Capability Manifest 并通过增量认证，这是"能力持续演进不破坏上层架构"的关键机制，类比 K8s conditions "只增不减"的演进纪律，以及 LSP 动态注册允许运行期增减能力而不重启连接。

**风险与坑：**
- 能力声明与实际实现不一致（"声明支持但跑不通"）是所有协商协议共同面临的问题，MCP/ACP/A2A 均只做协议层协商，不保证语义正确——**必须配合 CTS/Conformance 认证**，否则 manifest 会沦为摆设，这也是本赛题客观评分"每个用例取所有引擎最高分"的设计初衷所在（用可执行评测代替自我声明）。
- 版本命名空间混乱：多个引擎可能用相同的能力名（如都叫 "memory"）但语义/参数完全不同，必须强制 `namespace:name@version` 前缀，避免网关侧简单字符串匹配导致误判。
- polyfill 能力与原生能力性能/语义差异大（例如网关模拟的 room 远不如引擎原生 room 高效），Capability Manifest 的 `cost_profile` 字段应作为元编排层选择引擎/能力时的重要输入，避免"能力名相同但体验天差地别"被掩盖。

## 未解决问题
- 本次未能一手核实 A2A `AgentExtension` 对象的完整字段列表（如是否含 `required: boolean`、`params` schema 字段），仅基于搜索摘要，需要后续直接抓取 a2a-protocol.org 或 GitHub 的 types 定义文件做逐字段核对。
- 未覆盖 OCI Runtime Spec、K8s CRI/CNI/CSI、Envoy filter chain、SQL feature packs、ONNX opsets、JDBC `DatabaseMetaData.supports*`、GraphQL introspection、Bluetooth/USB profile、OpenGL/Vulkan/WebGPU extension 机制的一手资料（题目列出的部分领域受限于工具调用预算未逐一验证），这些领域的通用结论（"核心+扩展+版本化命名空间"）与已验证领域高度一致，但具体字段/接口形态需要时可再补充调研。
- Khronos CTS、Web Platform Tests 的具体组织方式（用例仓库结构、认证流程细节）未逐一核实，仅引用 K8s conformance 的对应细节作为代表性案例。

## 来源列表
- https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- https://microsoft.github.io/language-server-protocol/specifications/specification-3-16/（通过搜索摘要获取，未逐字抓取全文）
- https://github.com/microsoft/language-server-protocol
- https://a2a-protocol.org/latest/specification/（通过搜索摘要获取）
- https://github.com/a2aproject/A2A/blob/main/docs/topics/extensions.md（通过搜索摘要获取）
- https://component-model.bytecodealliance.org/design/wit.html
- https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md
- https://github.com/cncf/k8s-conformance
- https://sonobuoy.io/certifying-kubernetes-with-sonobuoy/
- https://openfeature.dev/specification/
- https://github.com/open-feature/spec
- https://developer.hashicorp.com/terraform/plugin/framework/internals/rpcs
- https://github.com/hashicorp/terraform/pull/33486
- https://code.visualstudio.com/api/references/activation-events
- https://code.visualstudio.com/api/references/extension-manifest
- https://maelvls.dev/kubernetes-conditions/
- https://kpt.dev/reference/schema/crd-status-convention/
- https://agentclientprotocol.com/protocol/schema
- https://github.com/NousResearch/hermes-agent/issues/569
