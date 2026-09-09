# PNP 能力包（Capability Pack）模型设计

> 设计文档，供实现方直接据此施工，不需要再回到对话上下文。路径以 `code/` 为根（交付包内为 `solution/code/`）。凡引用现有代码的论断都给出源码路径；凡引用引擎行为的论断都标注证据等级（沿用 `config/engines/*.json#capabilityEvidence` 的三级：**declared** 只有文档或静态代码依据；**probed** 在真实二进制上观察到过；**verified** 在赛题目标环境观察到过）。本文描述**目标设计**；除非明确写"现状"，否则不是对已存在行为的描述。
>
> 本文建立在两份已定稿的输入之上：`docs/ARCHITECTURE.md`（分层与接缝）与配置中心设计（`common`/`cores.<id>` 新增 `skills` 与 `native`、`EnginePack.describe()`/`validateNativeOptions()`、`IntegrationContext.native`、`/config` 路由族、`PUT /config` 只保存、凭据不过 HTTP）。配置中心设计的正文在本文撰写时尚未落盘到仓库，本文按其已决条目建设，不与之冲突；若两者出现措辞差异，以配置中心正文为准，本文第 4.4 节列出全部衔接点。

## 0. 结论

1. **能力域是一个字符串 id，不是一个枚举。** 网关只区分三种**载体**：类型化域（`model`/`permissions`/`mcp`，网关自己要理解语义）、资产域（文件搬运，网关只管完整性与投影结果）、原生域（`native`，不透明 JSON）。域的**集合**由引擎声明，网关不维护清单。
2. **契约升 1.2.0（增量）**：`AssetBinding.kind` 由 `"instruction" | "skill" | "native-extension"` 放开为 `string`，新增 `files`（目录型资产）与 `origin`（来源）；`EnginePack` 增 `describe()` 与 `validateNativeOptions()`；`IntegrationContext` 增 `native`。没有删除或改义。
3. **settings.json 信封封闭、域开放。** `common`/`cores.<id>` 的顶层键固定为 `model`、`permissions`、`instructions`、`mcp`、`skills`、`native`、`packs`、`assets` 八个（前四个现状，`skills`/`native` 是配置中心已决，`packs`/`assets` 本文新增）。开放口是 `assets.<kind>.<id>`（任意域 id）、`native`（不透明）与 `packs.<id>`（包启用）。`settings.ts` 只校验条目**形状**，永不校验域 id 的取值。
4. **能力包 = 目录 + `pack.json`（`manifest: 2`）**：`contributes.<kind>[]` 按域开放，`files` 记录每个文件的 SHA-256，`requires` 只做声明式检查（引擎、版本、环境变量名、文件存在），不再有 `probes[]` 与 `tools[]`；包内 MCP 服务器以 `mcp.<id>` 复用 `settings.json` 的同一 schema 并入有效配置，不另造一套。
5. **投影 = 每引擎一张投影表 `Record<kind, Projector>`；`describe()` 从同一张表派生**，声明与实现共用一个常量，不可能分叉。共享的 `src/assets/projection.ts` 只做必需/可选拆分、报告与错误码，不含任何引擎名。
6. **降级两处都拒绝、一处都不静默**：启动时用 `describe()` 做静态检查，打开通道时用投影表做动态检查；必需资产未支持 → `ENGINE_ASSET_KIND_UNSUPPORTED`（502，消息列出域与资产 id）；可选未支持 → 记入 `assets.projected.skipped` 并以 `engine.extension` 事件透出。`assets.projected` 是现有事件（`src/drivers/acp/channel.ts:658`），Pi 驱动补齐同名通知。
7. **钩子是 `native-extension` 域，信任模型分两级**：准入（批准根 + 摘要 + 显式启用 + 可执行贡献需显式许可）与进程内围栏。Pi 上默认由 `pnp-bridge` **托管加载**用户扩展：用户 `tool_call` 钩子先于网关策略运行、只能收窄不能放宽、看不到也改不了策略裁决；直接 `-e` 加载是显式开关的高信任档。OpenCode 插件目前只有 declared 证据，默认关闭。
8. **任何包变更都不需要重启网关**：所有投影都落在会话私有目录；对新会话在下一次 `open()` 生效；驻留会话被既有指纹围栏以 409 `ENGINE_BINDINGS_CHANGED` 拦住。
9. **提示、北向 API 与页面都不能装包**：文件只能由部署方放进批准根；`PUT /config` 只能改启用位与参数，且被引用的文件必须已经在批准根内并与 `files` 摘要一致。
10. **第三引擎带来一个新域时**，只改 `src/engines/<id>/`、`src/registry/index.ts` 一行、`config/engines/<id>.json`、`engines.lock.json`、`tests/adapters/<id>/`、`docs/engines/<id>.md`；`settings.ts`、契约、Core、网关路由、`src/assets/*`、配置页面零改动。第 11 节逐文件列出并说明为什么不能再短。

## 1. 需求、约束与依据

### 1.1 所有者要求（原文，具约束力）

> "配置不只是模型、权限、skill、mcp，还可能有 hook，或者插件 extension 等等，我可能还有遗漏，这个需要根据我们接入的 agent 的能力提供能力 pack 来接入，但是有的能力都需要支持。"

三条推论，本文全部满足并在对应节给出机制：

| 推论 | 含义 | 落点 |
|---|---|---|
| 可配置的能力域集合不固定 | 现状 `src/config/settings.ts#loadPnpSettings` 的 `exactKeys(common, ["model","permissions","instructions","mcp"])` 是闭合 schema，必须改为由引擎实际能承载的域驱动 | 第 2.4、4.1、4.3 节 |
| 尚未想到的域必须在不改 schema、不改 Core、不改北向 API 的前提下加入 | "我可能还有遗漏" | 第 2.4 节四步法；第 11 节以真实新域（Hermes 的 `memory`）验证 |
| 引擎有的能力都要能用到；引擎没有的能力必须**显式**失败或降级 | "有的能力都需要支持"，反面是不得静默丢弃 | 第 6 节两处检查、错误码与报告 |

同一所有者更早的规则仍然有效："只要我们网关系统感知到了就可以……要保持各个引擎各自本身的能力"。网关**感知**与**投影**，不驱动引擎内部，不把引擎向彼此归一。引擎之间的不对称是产品本身，第 6.2 节的投影表按引擎列出，不求对齐。

### 1.2 绑定约束

- `AGENTS.md`：Core 不按引擎 id 分支；适配器（`src/engines`、`src/drivers`、`src/integration`）不得导入 Fastify、`node:sqlite`、`GatewayCore`、`src/storage`、`src/gateway`、`node:child_process`，且 `src/engines`/`src/drivers` 不得导入 `src/config/`（`scripts/check-boundaries.mjs`）。TypeScript strict、ESM、无 `any`、Node strip-only 语法（无 `enum`、无构造器参数属性；`scripts/strip-only-check.mjs` 对每个源文件做词法剥离后解析）。
- 交付：`solution/{INSTRUCTION.md, code/}` 解压即用，评委机器可能没有 Node、Python 与外网；不在评委机器构建（`gateway.ps1:75` 直接找 `dist/main.js`）。本文**零新增运行时依赖**：语义化版本比较、JSON 校验、摘要都用 `node:` 内建。
- 北向 16 条路由（`docs/spec/contracts.md` 第 3 节）形状不变；`/config` 路由族属配置中心，本文只向其**提供数据**（`describe()` 与带来源的有效资产列表）。
- 评分：70% 任务成功、20% 架构、5% 创新、5% 鲁棒。本设计的架构论点只有一个：**新引擎的新能力不动网关任何一行**。

### 1.3 依据的现状（已核对）

| 事实 | 位置 |
|---|---|
| `AssetBinding.kind` 是闭合联合，`native-extension` 无生产者、无消费者 | `src/contracts/index.ts` `interface AssetBinding`（1.1.0） |
| 资产解析器：realpath 包含性（`ASSET_OUTSIDE_ROOT` 403）、普通文件且 ≤ 1 MiB（`ASSET_INVALID` 400）、SHA-256、给定摘要不符 `ASSET_DIGEST_MISMATCH` 409 | `src/assets/resolver.ts#resolveAsset` |
| OpenCode 只投影 `skill`/`instruction`；必需的未知 kind 在 `launch()` 之前抛 `ENGINE_ASSET_KIND_UNSUPPORTED` 502；可选的记入 `skipped` | `src/engines/opencode/assets.ts` `SUPPORTED_KINDS`、`projectOpenCodeAssets` |
| ACP 驱动打开通道时把投影结果作为 `assets.projected` 原生通知，在首轮以 `DriverEvent.native` 发出；无 `projectAssets` 的定义遇必需资产抛 `ENGINE_ASSET_PROJECTION_UNSUPPORTED` | `src/drivers/acp/channel.ts#openAcpChannel`（`notices`）、`AcpSessionChannel`（`this.parts.notices.splice(0)`） |
| Pi 驱动只消费 `instruction`（`--append-system-prompt`），`skill`/`native-extension` 不投影也不报告 | `src/drivers/pi-rpc/launch.ts#readInstructionText`、`channel.ts#appendSystemPromptOption`；`docs/engines/pi.md` B04 |
| Pi 的 `pnp-bridge.ts` 硬编码注册 `before_provider_request`、`tool_call`、`session_shutdown`，以 `-e` 加载，路径由模块自身 URL 推导 | `src/drivers/pi-rpc/extension/pnp-bridge.ts#activateBridge`、`launch.ts#resolveBridgeExtensionPath` |
| Pi 的私有配置根 `PI_CODING_AGENT_DIR` 指向 `<nativeDataDirectory>/pi-agent`，其中已写 `models.json` 与 `settings.json` | `launch.ts#resolveSessionPaths`、`writePiSettings`（probed：`docs/engines/pi.md`） |
| OpenCode 的私有 `OPENCODE_CONFIG_DIR` 指向 `<nativeDataDirectory>/opencode/config`，按 `.opencode` 结构被搜索 | `src/engines/opencode/native-config.ts#buildRedirectPlan`、`config/engines/opencode.json#redirect.notes`（probed：变量被接受；`agents/commands/plugins` 的扫描"未单独验证"，`docs/engines/opencode.md` §7） |
| settings 两层加法合并，MCP 服务器按 id 部分覆盖 | `src/config/settings.ts#mergedServerObject`、`resolveMcp`；`config/SETTINGS.md` "Inheritance" |
| 指纹围栏：ACP 按 `{tools, assets{id,kind,sha256,required}}`，Pi 按工具与模型分别指纹；不一致 409 `ENGINE_BINDINGS_CHANGED` | `drivers/acp/channel.ts#integrationFingerprint`、`drivers/pi-rpc/channel.ts#run` |
| 旧能力包设计（`pack.json`、`probes[]`、`tools[]`、`pack.projected` 事件）未实现；`assets/packs/` 只有 README 与 `windows-desktop/{instructions,tools}` 两个**空目录** | `docs/spec/contracts.md` §10、`assets/packs/README.md`、`ls -laR assets/packs/windows-desktop` |
| 引擎工厂表是唯一的引擎 id 绑定点 | `src/registry/index.ts` |
| 交付打包保留 `assets/` 目录 | `scripts/package-release.mjs` `KEEP_DIRS` |

引擎侧扩展面（从安装包与仓库证据枚举，逐项证据在第 2.3 节）：

- **Pi 0.85.1**（`runtime/bootstrap/engines/pi/0.85.1/node_modules/@earendil-works/pi-coding-agent/docs/`）：extensions（`-e` 可重复；`~/.pi/agent/extensions/`、`settings.json#extensions[]`；jiti 加载 `.ts`/`.js`；事件 `project_trust`、`session_start`、`before_agent_start`、`tool_call`（可阻断、`event.input` 可变、"No re-validation is performed after your mutation"）、`tool_result`（可改结果，按加载顺序链式）、`before_provider_headers`/`before_provider_request`（按加载顺序）、`session_shutdown` 等；`ctx` 暴露 `ui`、`sessionManager`、`modelRegistry`、`compact`、`fork`、`getContextUsage` 等）；skills（Agent Skills 标准；`~/.pi/agent/skills/`、`settings.json#skills[]`、`--skill`）；prompt templates（`prompts/*.md`、`--prompt-template`）；settings（`compaction`、`retry`、`defaultTools`、`packages`、`extensions`、`skills`、`prompts`、`themes` …；项目层对全局层做嵌套合并）；packages（npm/git 分发扩展+技能+模板+主题）；themes、keybindings（TUI 专属，对 RPC 无意义）。`PI_CODING_AGENT_DIR` 整体替换 `~/.pi/agent`（`environment-variables.md`；probed）。
- **OpenCode 1.18.29**（`config/engines/opencode.json`、`docs/engines/opencode.md`、`docs/research/T03-opencode.md`）：`opencode.json` 键 `model, provider, mcp, agent, permission, tools, instructions, plugin, compaction, formatter, lsp, command, skill …`；agents（`.opencode/agents/<name>.md`，frontmatter `description/mode/model/permission/prompt`）；commands（`.opencode/commands/<name>.md`，`$ARGUMENTS`）；skills（`.opencode/skills/<name>/SKILL.md`、`~/.config/opencode/skills/`）；plugins（`.opencode/plugins/*.ts` 或 `"plugin": ["npm-pkg"]`，hooks 含 `permission.ask`、`tool.execute.before/after`、`chat.*`、`event`）；modes（1.x 已并入 agent 概念，ACP 侧有 `current_mode_update`/`session/set_mode`）。`OPENCODE_CONFIG_DIR` "searched for agents, commands, modes and plugins like a `.opencode` directory" 是仓库记录（`config/engines/opencode.json#redirect.notes`），其中 skills 与 instructions 的投影已 probed（Linux），agents/commands/plugins 扫描未验证。

## 2. 能力模型

### 2.1 什么是能力域

一个**能力域**（capability domain）是引擎可被配置的一类东西，用一个小写短横线字符串标识（`kind`），例如 `instruction`、`skill`、`native-extension`。域有三个属性，都由**引擎**声明、由网关**转述**：

- **载体**（第 2.2 节）：网关以什么方式搬运它。
- **投影落点**：这个引擎把它放到哪里、怎么让引擎看见。
- **证据等级**：declared / probed / verified。

网关不定义"域的全集"。它只定义：一个域**贡献**长什么样（`AssetBinding`）、引擎怎么声明能承载哪些域（`describe()`）、承载不了时怎么说（第 6 节）。这就是"开放"的准确含义：**信封封闭，内容开放**——`AssetBinding` 的字段集固定，`kind` 的取值不固定。

### 2.2 三种载体，以及类型化与不透明的边界

| 载体 | 域 | 网关理解什么 | 网关不理解什么 | 契约类型 | 谁校验取值 | 开放性 |
|---|---|---|---|---|---|---|
| **类型化** | `model`、`permissions`、`mcp` | 语义：端点/凭据变量名的解析、`allow/ask/deny` 裁决、`sideEffect`、传输 | 引擎的原生配置格式 | `ResolvedModel`、`PermissionPolicy`、`ToolBinding` | `settings.ts` 完整校验 | 封闭。理由：Core 与 `InteractionBroker` 要**据此做决定**（裁决、凭据解析、围栏）；一个网关不理解的"权限"是无法执行的权限 |
| **资产** | `instruction`、`skill`、`native-extension`、`command`、`agent`、`prompt-template`、`mode`、`hook` 以及**任何未来的域** | 完整性（根内、大小、SHA-256）、必需/可选、来源、目录结构、投影结果 | 文件内容的含义；引擎怎么用它 | `AssetBinding`（`kind: string`） | `settings.ts` 只校验信封形状；`describe()`/投影表校验**这个引擎**认不认这个域；`parameterSchema` 校验 `parameters` | **开放**。域 id 不在任何网关侧清单里 |
| **原生** | `native` | 只知道它是一个 JSON 对象 | 全部 | `IntegrationContext.native: Json` | `EnginePack.validateNativeOptions()`（含保留键拒绝，第 6.2 节） | 开放，但只对**一个**引擎有意义 |

边界的判据只有一条：**网关是否需要根据它的取值做出决定。** 需要 → 类型化；不需要 → 资产或原生。`instructions` 曾经是类型化的特例（有序列表、整体替换），本文保留其顶层键与语义（第 4.1 节），但它在契约上已经是 `kind:"instruction"` 的资产。

`hook` 与 `native-extension` 的关系：在 Pi 与 OpenCode 上，"钩子"都是**代码**（Pi 扩展模块注册 `pi.on(...)`；OpenCode 插件导出钩子函数），因此它们是 `native-extension` 的贡献，其 `parameters.events` 声明注册了哪些事件。`hook` 作为独立域 id 保留给**声明式**钩子（一段 JSON 说"在事件 X 运行命令 Y"，如 Claude Code 的 `hooks.json`），当前两个引擎对它的答复都是 `support:"none"`——这本身就是第 2.4 节机制的一次演示：一个域可以先存在于清单与包里，再由某个引擎宣布支持。

### 2.3 今日的域清单

`载体` 列以外的每格都注明证据等级；`—` 表示引擎没有对应机制，`describe()` 对该域返回 `support:"none"`。

| 域（`kind`） | 载体 | OpenCode 1.18.29 | Pi 0.85.1 |
|---|---|---|---|
| `model` | 类型化 | 私有 `opencode.json#provider/model`，`{env:VAR}` 引用（probed，`native-config.ts`） | 私有 `models.json` + `PI_CODING_AGENT_DIR`，`$VAR` 引用（probed，`launch.ts`） |
| `permissions` | 类型化 | 原生 `permission` 块 → ACP `session/request_permission`（probed） | 无原生权限系统；`pnp-bridge` 的 `tool_call` 钩子 + `ctx.ui.confirm("pnp:<op>")`（probed）。`support:"bridged"` |
| `mcp` | 类型化 | `session/new.mcpServers`；`mcp-http` 仅当 `initialize` 声明 `mcpCapabilities.http`（probed） | 无 MCP 客户端；桥内 MCP SDK 客户端 `registerTool`（probed）。`support:"bridged"`；`cli`/`native` 传输丢弃并报告 |
| `instruction` | 资产（文件） | `opencode.json#instructions[]` 绝对路径（probed） | `--append-system-prompt <合并正文>`（probed） |
| `skill` | 资产（目录，`SKILL.md` 为入口） | `OPENCODE_CONFIG_DIR/skills/<id>/` 与 `<xdgConfigHome>/opencode/skills/<id>/`（declared；Linux 上目录解析已从二进制读实） | 私有 `settings.json#skills[]` 指向 `<agentConfigDir>/pnp/skill/<id>/`（declared，`settings.md` "Resources"）；备选 `--skill <path>`（declared，`usage.md`） |
| `native-extension` | 资产（文件或目录，可执行） | `OPENCODE_CONFIG_DIR/plugins/<id>.ts`（declared，扫描未验证）。默认**不许可** | 托管：桥读 `pnp-extensions.json` 动态导入（本文新设计，未验证）；直接：`-e <path>`（probed，可重复） |
| `command` | 资产（文件） | `OPENCODE_CONFIG_DIR/commands/<name>.md`（declared，扫描未验证） | 投影为 prompt template（`settings.json#prompts[]`，declared）；RPC `prompt` 会展开 `/name`（`rpc.md`，declared） |
| `prompt-template` | 资产（文件） | 同 `command`（OpenCode 无独立模板概念，`describe()` 报 `alias:"command"`） | `settings.json#prompts[]`（declared） |
| `agent` | 资产（文件） | `OPENCODE_CONFIG_DIR/agents/<name>.md`（declared）；`PromptRequest.agent` 已在契约中但 ACP 驱动尚未使用 | — |
| `mode` | 资产（文件） | 1.x 已并入 `agent`（`describe()` 报 `alias:"agent"`；`session/set_mode` 是运行期切换，不是配置） | — |
| `hook` | 资产（声明式） | — | — |
| `native` | 原生 | `opencode.json` 其余键（`compaction`、`formatter`、`lsp`、`tools` …），保留键拒绝 | `settings.json` 其余键（`compaction`、`retry`、`enabledModels` …），保留键拒绝 |

不对称一目了然：`permissions` 与 `mcp` 在 Pi 上是桥接而非原生；`agent`/`mode` 只在 OpenCode 有；`command` 在两边的原生名字不同。网关把这些**如实转述**（`describe()`），不把 Pi 的 prompt template 改名叫 agent，也不给 Pi 造一个 agent。

### 2.4 开放机制：一个新域怎么加进来

设未来出现域 `foo`。四步，且**只有第三步碰代码，而且只碰一个引擎目录**：

1. 有人在 `pack.json#contributes.foo[]` 或 `settings.json#…assets.foo.<id>` 写下贡献。`settings.ts` 与 `src/assets/packs.ts` 校验的是条目形状（`path`、`required`、`enabled`、`parameters`、`engines`），`foo` 这个键名不在任何白名单里，直接通过。
2. `IntegrationProvider.prepare()` 把它解析成 `AssetBinding{kind:"foo", …}`，走同一个解析器（根内、大小、摘要）。Core 把 `IntegrationContext.assets` 原样交给 `EnginePack.open()`，Core 不读 `kind`。
3. 想承载它的引擎在自己的投影表里加一行：`foo: projectFoo`。`describe()` 从该表派生，于是这个引擎的声明里出现 `{kind:"foo", support:"native", evidence:"declared"}`。
4. 其他引擎什么都不做：它们的表里没有 `foo`，`describe()` 里没有 `foo`，于是必需的 `foo` 在启动时被拒（第 6.3 节），可选的 `foo` 被记入 `skipped`。

不需要改的东西：`src/config/settings.ts`（无域清单）、`src/contracts/index.ts`（`kind: string`）、`src/core/*`、`src/gateway/*`（北向不认识资产）、`src/assets/*`（通用）、配置页面（从 `describe()` 渲染，第 7.3 节）。第 11 节用 Hermes 的 `memory` 域把这四步走一遍。

### 2.5 网关**不**做的事

- 不把域之间做映射（不把 `agent` 翻译成 Pi 的什么东西）。
- 不在网关侧执行任何域的语义（声明式 `hook` 的执行者是引擎，网关没有"钩子运行器"）。
- 不为引擎没有的能力造替代品——**除了**已经存在的两个桥接（Pi 的权限门与 MCP 客户端），它们是引擎缺口对网关**必需语义**（授权、工具）的补齐，`describe()` 如实标 `bridged`。

## 3. 契约变更（1.2.0，增量）

`src/contracts/index.ts`。所有新增字段可选，现有 Pack 不改也能编译；`CONTRACT_VERSION` 升为 `"1.2.0"`，各 `descriptor.contractVersion` 随之（它是 `typeof CONTRACT_VERSION`，自动跟随）。

```ts
export const CONTRACT_VERSION = "1.2.0";

/** Open on purpose (design/capability-packs.md section 2). The list below is documentation, not a constraint. */
export type AssetKind = string;
export const WELL_KNOWN_ASSET_KINDS: readonly string[] = [
  "instruction", "skill", "native-extension", "command", "agent", "prompt-template", "mode", "hook",
];

/** One companion file of a directory-shaped asset, relative to dirname(AssetBinding.path). */
export interface AssetFile { relative: string; path: string; sha256: string }
export interface AssetOrigin {
  source: "settings" | "pack";
  layer: "common" | "core";
  pack?: string;
  packVersion?: string;
}
export interface AssetBinding {
  id: string;
  kind: AssetKind;
  /** Entry file, absolute: the SKILL.md, the instruction file, the extension module. */
  path: string;
  /** Digest of `path`. Directory-shaped assets also carry `files`; fingerprints use `bundleDigest ?? sha256`. */
  sha256: string;
  required: boolean;
  parameters?: Json;
  /** 1.2.0: companion files of a directory-shaped asset; absent for a single file. */
  files?: readonly AssetFile[];
  /** 1.2.0: sha256 over the sorted `relative\0sha256` lines of `files` plus the entry; absent for a single file. */
  bundleDigest?: string;
  /** 1.2.0: where the binding came from; provenance for /config and for the projection report. */
  origin?: AssetOrigin;
}

export interface CapabilityDomain {
  kind: string;
  /** native: the engine has the mechanism; bridged: the gateway supplies it inside the engine process; none: not carried. */
  support: "native" | "bridged" | "none";
  evidence: "declared" | "probed" | "verified";
  /** Where a contribution lands, for people: "opencode.json#instructions[]", "--append-system-prompt". */
  projection?: string;
  /** Shape the projector accepts. */
  layout?: "file" | "directory";
  /** When a change takes effect: `session` = next open(); `process` = gateway restart. */
  scope: "session" | "process";
  /** JSON Schema for AssetBinding.parameters of this kind; absent means parameters are ignored. */
  parameterSchema?: Json;
  /** This engine carries the kind under another of its kinds (OpenCode: prompt-template -> command). */
  alias?: string;
  /** Contributions of this kind need an explicit deployment permit (native-extension on both engines). */
  permit?: string;
}
export interface EngineDescription {
  engineId: string;
  engineVersion: string;
  domains: readonly CapabilityDomain[];
  /** JSON Schema for the engine's `native` object, when the Pack can state one. */
  nativeOptionsSchema?: Json;
  /** Keys of `native` this Pack refuses because a typed or asset domain owns them. */
  reservedNativeKeys: readonly string[];
}
export type NativeOptionsValidation =
  | { ok: true }
  | { ok: false; problems: readonly { path: string; message: string }[] };

export interface IntegrationContext {
  model: ResolvedModel;
  tools: readonly ToolBinding[];
  assets: readonly AssetBinding[];
  authorize(request: InteractionRequest): Promise<AuthorizationDecision>;
  permissions?: PermissionPolicy;
  /** 1.2.0 (configuration centre): the effective `native` object for this engine, already validated. */
  native?: Json;
}

export interface EnginePack {
  readonly descriptor: EngineDescriptor;
  /** 1.2.0: pure, no process, no network; may read config/engines/<id>.json. */
  describe?(): EngineDescription | Promise<EngineDescription>;
  /** 1.2.0 (configuration centre): shape check of `native`, reserved keys included. */
  validateNativeOptions?(options: Json): NativeOptionsValidation;
  open(input: EngineOpenInput): Promise<EngineSessionChannel>;
  purge?(input: { session: Session; nativeDataDirectory: string }): Promise<void>;
}
```

兼容性说明：

- `kind` 放宽是类型放宽，所有现有生产者（`ConfiguredIntegration.instructionAssets` 产生 `"instruction"`）与消费者（`opencode/assets.ts` 的 `else` 分支）都已按开放集写法工作。`tests/adapters/opencode/assets.test.ts` 已用 `"native-extension"` 测必需未支持路径，继续有效。
- `describe()` 可选：`MockPack`、`HermesPack` 不实现也能加载；注册表对没有 `describe()` 的 Pack 跳过启动静态检查，只剩打开通道时的动态检查（第 6.5 节）。
- `PromptRequest.agent` 不动；它属于运行期选择，不属于配置域。

## 4. 配置面：`settings.json`

### 4.1 键集（信封）

`common` 与 `cores.<engineId>` 的顶层键固定为八个；未知键仍以 `SETTINGS_INVALID` 拒绝（拼错 `permisions` 必须失败，这条现状不能丢）。

| 键 | 现状/来源 | 形状 | 合并规则 |
|---|---|---|---|
| `model` | 现状 | 不变 | 同 `providerID/modelID` 替换；`default` 按引擎覆盖 |
| `permissions` | 现状 | 不变 | `default` 按引擎覆盖；`operations` 按名合并 |
| `instructions` | 现状 | 有序路径列表 | Core 列表**整体替换** common（含 `[]`）。等价于 `assets.instruction` 但有序；`assets.instruction` 被拒并提示用 `instructions` |
| `mcp` | 现状 | `servers.<id>` | 按 id 部分覆盖。包贡献的服务器（第 5.2 节）在 common 之前并入，优先级最低 |
| `skills` | 配置中心已决 | `<id>: AssetEntry` | 按 id 部分覆盖；`enabled:false` 移除。等价于 `assets.skill`；`assets.skill` 被拒并提示用 `skills` |
| `native` | 配置中心已决 | 任意 JSON 对象 | Core 对 common 做**浅合并**（顶层键覆盖）；深合并由引擎决定是否在 `validateNativeOptions` 之后自行执行。`settings.ts` 只检查"是对象" |
| `packs` | 本文新增 | `<packId>: PackEntry` | 按 id 部分覆盖；`enabled:false` 移除 |
| `assets` | 本文新增 | `<kind>: { <id>: AssetEntry }` | 域内按 id 部分覆盖；`enabled:false` 移除；域键集合是两层的并集 |

`skills` 与 `instructions` 之所以保留顶层键：`instructions` 是唯一有**顺序与整体替换**语义的域，映射形状表达不了；`skills` 是配置中心已决的可读性提升。两者都不是第二套机制：解析后与 `assets.<kind>` 走同一条路径进入 `AssetBinding[]`。

### 4.2 `packs.<id>`

```json
"packs": {
  "office-report": { "enabled": true },
  "windows-desktop": {
    "enabled": true,
    "required": false,
    "contributions": {
      "native-extension": { "artifact-audit": { "enabled": false } }
    }
  }
}
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 关闭即整包不展开 |
| `required` | boolean | `false` | 为真时：包目录缺失、清单无效、`requires` 不满足或任一必需贡献在**选定引擎**上不受支持 → 启动拒绝（第 6.3 节） |
| `root` | string | 按批准根顺序查找第一个含 `<id>/pack.json` 的根 | 显式指定批准根（必须是批准根之一的**名字**，不是路径：`"delivery"` 或 `PNP_PACK_ROOTS` 的序号 `"extra:0"`）；不允许任意路径，避免设置文件本身成为越界入口 |
| `contributions.<kind>.<assetId>` | `{enabled?, required?, parameters?}` | — | 对单条贡献的部分覆盖；`parameters` 与清单值浅合并 |
| `permitNativeExtensions` | boolean | `false` | 允许本包的 `native-extension` 贡献参与投影。不设即使包内声明了也按"未许可"跳过并报告（第 8.3 节）。此键只在 `cores.<id>.packs` 与 `common.packs` 都可写，取 Core 值优先 |

### 4.3 `assets.<kind>.<id>`

内联贡献，不经过包。适合部署方自己的一两个文件。

```json
"assets": {
  "command": {
    "weekly-report": { "path": "commands/weekly-report.md" }
  },
  "native-extension": {
    "audit-log": {
      "path": "extensions/pi/audit-log.js",
      "engines": ["pi"],
      "required": false,
      "parameters": { "events": ["tool_result"], "hosting": "hosted" }
    }
  },
  "memory": {
    "team-glossary": { "path": "memory/glossary.md", "engines": ["hermes"] }
  }
}
```

`AssetEntry` 的形状（`settings.ts` 校验的全部内容）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `path` | string | 相对设置文件目录，或绝对路径。**必须落在批准根内**（第 4.6 节），否则 `ASSET_OUTSIDE_ROOT` 403 在加载时抛出——这比 `instructions` 现状严格，因为开放域包含可执行文件 |
| `layout` | `"file"` / `"directory"` | 缺省 `file`。`directory` 时 `path` 指向目录，入口文件由 `entry` 指定（缺省 `SKILL.md`）；目录内全部普通文件成为 `files[]` |
| `entry` | string | 仅 `layout:"directory"` |
| `required` | boolean | 缺省 `false`（与 `instructions` 现状的 `required:true` 不同：内联开放域缺省可选，避免一条尝试性配置把整个部署拒之门外；要硬性依赖就写 `true`） |
| `enabled` | boolean | 缺省 `true` |
| `engines` | string[] | 缺省任意引擎。列出时，选定引擎不在其中 → 该条在 `prepare()` 前被过滤，报告为 `skipped{reason:"not-targeted"}`，**不算未支持**，也不触发 required 失败 |
| `parameters` | JSON | 原样进入 `AssetBinding.parameters`；含义由引擎的 `parameterSchema` 决定 |

`memory` 这一域在本文撰写时没有任何引擎承载。上面的例子是合法配置：它会被解析、被指纹、在 OpenCode/Pi 上被过滤为 `not-targeted`（因为写了 `engines`）；若去掉 `engines`，则在两个引擎上都以 `skipped{reason:"unsupported-kind"}` 报告。这就是"域开放、失败显式"的具体样子。

### 4.4 与配置中心已决事项的衔接

| 配置中心已决 | 本文如何建设其上 |
|---|---|
| `skills` 映射，按 id 部分覆盖 | 采用；解析为 `kind:"skill"` 的 `AssetBinding`，`layout` 缺省 `directory`、`entry` 缺省 `SKILL.md`。与 `packs` 贡献的同 id 技能冲突时 settings 条目覆盖包条目（settings 是部署方的最终意志） |
| `native` 不透明对象，`settings.ts` 只查"是对象" | 采用；`IntegrationContext.native` 携带；引擎 `validateNativeOptions` 在 `prepare()` 之前（启动探测）与 `PUT /config` 校验时各调一次；保留键规则见第 6.2 节 |
| `EnginePack.describe()` / `validateNativeOptions()` | 采用并给出字段（第 3 节）；`describe().domains` 从投影表派生（第 6.1 节） |
| settings.json 单一事实源；凭据不过 HTTP，页面只编辑变量名 | 包与资产条目里没有凭据字段；包贡献的 MCP 服务器沿用 `env`/`headerEnvironment` 的变量名规则 |
| `/config` 路由族读有效配置**带来源** | `EffectiveSettings.assets` 每条带 `origin{source, layer, pack, packVersion}`；`GET /config/schema` 返回 `describe()`；`POST /config/validate` 对资产条目跑解析器（根内、摘要）并对每条给出 `will-project / will-skip(reason)` 的静态预判 |
| `PUT /config` 只保存，围栏作用于驻留会话 | 包/资产变更不需要重启：`prepare()` 每轮重新展开（第 9 节）；驻留会话下一轮被 `ENGINE_BINDINGS_CHANGED` 拦住，与工具/模型变更一致 |

### 4.5 合并规则汇总（`config/SETTINGS.md` "Inheritance" 的增补）

```text
common.packs        + cores.<id>.packs         (same pack id partially overridden; enabled:false removes)
common.assets.<k>   + cores.<id>.assets.<k>    (same asset id partially overridden; enabled:false removes;
                                                 the set of <k> keys is the union of both layers)
common.skills       + cores.<id>.skills        (configuration centre; same rule as assets.<k>)
common.native       + cores.<id>.native        (shallow: Core's top-level keys win; the Pack validates the result)
pack-contributed mcp.<id>  < common.mcp.servers  < cores.<id>.mcp.servers   (lowest to highest)
```

### 4.6 批准根与占位符

批准根（asset roots）是 `resolveAsset` 的 `root` 参数可取的全部值：

| 名字 | 位置 | 来源 |
|---|---|---|
| `delivery` | `<CODE_ROOT>/assets/packs/` | 固定 |
| `config` | 设置文件所在目录 | 固定；`instructions` 现状的根 |
| `extra:<n>` | `PNP_PACK_ROOTS` 以 `;` 分隔的第 n 个**绝对**路径 | 可选环境变量；相对路径拒绝启动 `SETTINGS_INVALID` |

`instructions` 保持现状（根 = 设置文件目录，不做包含性检查以外的限制）；`assets.*`、`skills`、`packs` 的每个文件都必须 realpath 落在上述某个根内。`${PNP_CODE_ROOT}`、`${PNP_NODE}` 占位符规则不变；新增 `${PNP_PACK_ROOT}`，**只在 `pack.json` 内合法**，展开为该包目录的绝对路径（用于包贡献的 MCP 服务器 `args`）。

### 4.7 完整示例（`cores.pi` 段）

```json
"pi": {
  "packs": {
    "office-report": { "enabled": true, "permitNativeExtensions": true }
  },
  "assets": {
    "prompt-template": { "standup": { "path": "prompts/standup.md" } }
  },
  "native": { "compaction": { "reserveTokens": 8192 } }
}
```

## 5. 能力包

### 5.1 文件系统形态

```text
code/assets/packs/<id>/
├── pack.json                 清单（manifest 2）
├── skills/<name>/SKILL.md    目录型技能（Agent Skills 标准），可带 scripts/ references/
├── instructions/*.md         指令片段
├── commands/*.md             斜杠命令 / 提示模板
├── agents/*.md               OpenCode agent 定义
├── extensions/<engine>/*.js  可执行的引擎原生扩展，按引擎分目录
└── mcp/                      包自带 MCP 服务器的入口脚本（可选）
```

目录名即包 id，`[a-z0-9-]`，与 `pack.json#id` 一致（不一致 → `PACK_MANIFEST_INVALID`）。子目录名只是惯例，真正的位置由清单里的 `path` 决定。

### 5.2 `pack.json`（manifest 2）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `manifest` | `2` | 是 | 清单版本；`1`（旧 README 形状）直接拒绝并提示迁移 |
| `id` | string | 是 | 与目录名一致 |
| `version` | string | 是 | `major.minor.patch`；进入 `origin.packVersion` 与投影报告 |
| `description` | string | 否 | 一句话；不含任务标识 |
| `requires` | object | 否 | 见 5.4 |
| `contributes` | `Record<kind, Contribution[]>` | 是 | **域键开放**；至少一个域 |
| `mcp` | `Record<id, McpServerSettings>` | 否 | 与 `settings.json#mcp.servers.<id>` **同一 schema、同一解析函数**（`settings.ts#parseMcpServer`）；`command`/`args` 可用 `${PNP_PACK_ROOT}`；并入有效配置的优先级最低（第 4.5 节） |
| `files` | `Record<relativePath, "sha256:<hex>">` | 是 | 包内**每个**被引用文件的摘要；未列出的文件不得被任何贡献引用（`PACK_MANIFEST_INVALID`）；列出但不存在或摘要不符 → 解析器 `ASSET_DIGEST_MISMATCH` 409 |

`Contribution` 的形状（与第 4.3 节 `AssetEntry` 相同，多一个 `id`）：

| 字段 | 说明 |
|---|---|
| `id` | 包内唯一；生成的 `AssetBinding.id` 为 `<packId>.<id>`，避免与 settings 内联条目和其他包冲突 |
| `path` | 包内相对路径；`layout:"directory"` 时为目录 |
| `layout`、`entry`、`required`、`engines`、`parameters` | 同 4.3 |

### 5.3 完整性

- `files` 由 `scripts/pack-tool.mjs digest <dir>` 生成，`verify <dir>` 校验；`npm run check` 与 `release:check` 对 `assets/packs/*` 各跑一次 `verify`，并跑 `lint`（第 10 节的禁止项：`task_id`、固定答案、凭据形状、包外路径引用）。
- 运行时每轮 `prepare()` 都经 `resolveAsset` 重算摘要并与 `files` 比对；篡改在**发送 Prompt 前**以 409 失败，与现状一致。
- 每文件 ≤ 1 MiB（解析器现状）；每包 ≤ 512 个文件、≤ 16 MiB（`packs.ts` 加载时检查，`PACK_MANIFEST_INVALID`）。技能里的大参考资料应拆分或外置。

### 5.4 `requires`（声明式，不 spawn）

旧设计的 `probes[]` 要执行进程；`src/integration/` 是适配器目录，AGENTS.md 禁止其使用 `child_process`，且评委机器可能没有 Python。改为四类声明式检查，全部在加载时完成：

```json
"requires": {
  "engines": { "pi": ">=0.85.1", "opencode": ">=1.18.0" },
  "env": ["PNP_MODEL_ENDPOINT"],
  "files": ["${PNP_CODE_ROOT}/dist/tools/office-mcp/main.js"],
  "domains": ["skill", "instruction"]
}
```

| 键 | 检查 | 不满足时 |
|---|---|---|
| `engines` | 选定引擎在表中且版本满足 `>=`/精确（自写 15 行比较器，零依赖）；不在表中 = 不针对该引擎 | `required:true` 的包 → 启动拒绝 `PACK_REQUIRES_UNMET`（400，消息含包 id 与不满足的键）；否则整包按 `skipped{reason:"requires-unmet"}` 报告 |
| `env` | 变量名**已设置**（不读值、不输出值） | 同上 |
| `files` | 存在且可读 | 同上 |
| `domains` | 选定引擎 `describe()` 对这些域 `support ≠ "none"` | 同上；这是包作者表达"我依赖这些域"的方式，比逐条 `required` 更粗 |

需要真正探测运行时（"python 装了没"）的场景，本交付没有；若将来需要，探测应由包自带的 MCP 服务器在 `tools/list` 阶段自报，而不是网关 spawn。

### 5.5 示例一：多域包 `office-report`

一个包同时贡献技能、指令、Pi 钩子扩展，并自带一个 MCP 服务器声明（引用交付内已有的 office MCP 入口以示形状）。

```json
{
  "manifest": 2,
  "id": "office-report",
  "version": "1.0.0",
  "description": "Office 报告类任务的技能、风格指令与产物核验钩子",
  "requires": {
    "engines": { "pi": ">=0.85.1", "opencode": ">=1.18.0" },
    "domains": ["skill", "instruction"]
  },
  "contributes": {
    "skill": [
      { "id": "office-report", "path": "skills/office-report", "layout": "directory", "required": true }
    ],
    "instruction": [
      { "id": "style", "path": "instructions/style.md", "required": false }
    ],
    "native-extension": [
      {
        "id": "artifact-audit",
        "path": "extensions/pi/artifact-audit.js",
        "engines": ["pi"],
        "required": false,
        "parameters": { "events": ["tool_result"], "hosting": "hosted" }
      }
    ]
  },
  "mcp": {
    "office-report-check": {
      "transport": "stdio",
      "command": "${PNP_NODE}",
      "args": ["${PNP_PACK_ROOT}/mcp/check.js"],
      "sideEffect": "read",
      "timeoutMs": 30000
    }
  },
  "files": {
    "skills/office-report/SKILL.md": "sha256:4d1f…",
    "skills/office-report/references/layout-checklist.md": "sha256:9a02…",
    "instructions/style.md": "sha256:b7c3…",
    "extensions/pi/artifact-audit.js": "sha256:e5e5…",
    "mcp/check.js": "sha256:12aa…"
  }
}
```

投影结果（同一包，两个引擎）：

| 贡献 | OpenCode | Pi |
|---|---|---|
| `skill:office-report`（目录） | 复制整棵树到 `OPENCODE_CONFIG_DIR/skills/office-report.office-report/` 与 xdg 镜像 → `projected` | 复制到 `<agentConfigDir>/pnp/skill/office-report.office-report/`，写入私有 `settings.json#skills[]` → `projected` |
| `instruction:style` | `instructions[]` 追加绝对路径 → `projected` | 并入 `--append-system-prompt` 正文 → `projected` |
| `native-extension:artifact-audit` | `engines:["pi"]` → 过滤，`skipped{reason:"not-targeted"}` | `permitNativeExtensions` 为真 → 写入 `pnp-extensions.json`，桥托管加载 → `projected`；为假 → `skipped{reason:"not-permitted"}` |
| `mcp:office-report-check` | 并入 `mcp.servers`，经 `session/new.mcpServers` | 并入 `mcp.servers`，经桥 `registerTool` |

`artifact-audit.js` 的职责是产品评审 §8.1 里的"产物核验"：在 `tool_result` 事件里，对 `office_*_write` 类工具的成功结果追加一行 `[pnp-audit] <path> exists, <bytes> bytes`（文件不存在时追加 `[pnp-audit] MISSING`，**不**改 `isError`——它是观察，不是裁决）。它只需要 `pi.on("tool_result")` 与 `node:fs`，是托管加载能力集的子集（第 8.4 节）。

### 5.6 示例二：`windows-desktop` 骨架重写

现状：`assets/packs/windows-desktop/` 只有 `instructions/`、`tools/` 两个空目录，没有 `pack.json`。按本文 schema：

```text
assets/packs/windows-desktop/
├── pack.json
├── skills/windows-desktop/SKILL.md
└── instructions/desktop.md
```

```json
{
  "manifest": 2,
  "id": "windows-desktop",
  "version": "0.1.0",
  "description": "Windows 桌面应用交互：列举与打开固定应用，激活不等于任务完成",
  "requires": {
    "domains": ["skill"],
    "files": ["${PNP_CODE_ROOT}/dist/tools/desktop-mcp/main.js"]
  },
  "contributes": {
    "skill": [
      { "id": "windows-desktop", "path": "skills/windows-desktop", "layout": "directory", "required": true }
    ],
    "instruction": [
      { "id": "desktop", "path": "instructions/desktop.md", "required": false }
    ]
  },
  "files": {
    "skills/windows-desktop/SKILL.md": "sha256:…",
    "instructions/desktop.md": "sha256:…"
  }
}
```

Desktop MCP 服务器**留在** `config/settings.json#common.mcp.servers.desktop`（现状，已在两个引擎上 20/21 通过），包只用 `requires.files` 声明依赖它。把服务器搬进包的 `mcp` 段也合法，但会让"改一条 settings 就接入一个 MCP"这条已被证明的路径多一个入口；一期不搬。`tools/` 空目录删除（旧设计的 `tools[]` 已取消）。

### 5.7 与 `docs/spec/contracts.md` §10 旧设计的关系

结论：**取代**，保留其骨架与四条禁止，逐项处置如下。实现落地后应把 §10 与 `assets/packs/README.md` 改写为指向本文（属文档工作，不在实施包内计入代码）。

| 旧设计条目 | 处置 | 理由 |
|---|---|---|
| 目录 `assets/packs/<id>/`，目录名即 id | 采纳 | — |
| `pack.json` 含 `id/version/owner/description` | 采纳；`owner` 删除（团队分工字段，不是运行时事实）；加 `manifest: 2` | 清单只描述包 |
| `assets[]` 扁平数组，`kind` 三选一 | **修订**为 `contributes.<kind>[]`，域键开放 | 这是所有者要求的核心 |
| `tools[]`（`runtime`、`entry`、命名运行时映射） | **取代**为 `mcp.<id>` 复用 settings 的 MCP schema | 产品评审明确"避免另造和当前 settings 完全平行的插件系统"；命名运行时解析在评委机器上无从保证 |
| `probes[]`（spawn 探测） | **取代**为声明式 `requires` | 适配器不得 spawn；无 Python 环境 |
| 启用集合来自集成配置的 `packs` 列表 | 采纳；形状为映射并支持逐贡献覆盖 | 与 `mcp.servers` 一致 |
| 每轮 `prepare` 重新解析 | 采纳 | 使 `PUT /config` 只保存即可生效 |
| 投影事件命名空间 `pack`，`projected/skipped/failed` 三个事件 | **取代**为现有 `assets.projected` 一个事件、载荷含 `pack` 来源与三个数组 | 现有事件已实现并测过（ACP）；一次打开一份报告比每包一个事件更容易核对；E03 验收措辞随之改为"`engine.extension{nativeType:"assets.projected"}` 的 `projected[]` 中出现 `pack:"<id>"`" |
| 必需资产/探测失败在发送 Prompt 前失败 | 采纳并前移：必需未支持在**启动时**即拒（第 6.5 节） | 更早 |
| §10.4 四条禁止 | 采纳，改由 `pack-tool.mjs lint` 静态检查 | — |
| 一期三个包 `office`/`windows-desktop`/`web-search` | 不作承诺；`windows-desktop` 骨架按本文重写作为第一个真实包；`office` 的等价能力已由 settings 的 office MCP 提供 | 与 `work-packages.md` §1.1 的实际状态一致 |

## 6. 投影与降级

### 6.1 投影表模式（声明与实现共用一个常量）

每个引擎目录有一张表，`describe()` 从表派生，`projectAssets()` 按表分发。表不存在的域，两处**同时**不存在。

```ts
// src/assets/projection.ts（公共，无引擎名）
export interface ProjectionTarget { nativeDataDirectory: string; session: Session }
export interface ProjectorOutcome { targets: readonly string[]; note?: string }
export type Projector = (asset: AssetBinding, target: ProjectionTarget) => Promise<ProjectorOutcome>;
export interface ProjectorEntry {
  project: Projector;
  domain: Omit<CapabilityDomain, "kind">;      // support/evidence/projection/layout/scope/parameterSchema/alias/permit
}
export type ProjectorTable = Readonly<Record<string, ProjectorEntry>>;

export interface ProjectedAsset { id: string; kind: string; targets: readonly string[]; sha256: string; pack?: string; packVersion?: string }
export interface SkippedAsset { id: string; kind: string; reason: "unsupported-kind" | "not-targeted" | "not-permitted" | "requires-unmet" | "disabled"; detail?: string; pack?: string }
export interface FailedAsset { id: string; kind: string; code: string; message: string; pack?: string }
export interface ProjectionReport { projected: ProjectedAsset[]; skipped: SkippedAsset[]; failed: FailedAsset[] }

export function domainsOf(table: ProjectorTable): CapabilityDomain[];
export function assertRequiredProjectable(engineId: string, domains: readonly CapabilityDomain[], assets: readonly AssetBinding[]): void; // ENGINE_ASSET_KIND_UNSUPPORTED
export async function projectAssets(engineId: string, table: ProjectorTable, assets: readonly AssetBinding[], target: ProjectionTarget): Promise<ProjectionReport>;
export async function placeFile(asset: AssetBinding, target: string): Promise<void>;   // ENGINE_ASSET_PROJECTION_FAILED
export async function placeTree(asset: AssetBinding, targetDir: string): Promise<string[]>; // entry + files[], relative layout preserved
export function reportToJson(report: ProjectionReport): Json;
```

`projectAssets` 的固定流程：① 必需资产中 `kind ∉ table` → 抛 `ENGINE_ASSET_KIND_UNSUPPORTED`，**在写任何文件之前**（现状 `opencode/assets.ts` 的顺序）；② 逐条：`kind ∉ table` → `skipped{unsupported-kind}`；`permit` 域且未许可 → `skipped{not-permitted}`；投影器抛错 → 必需则原样抛（`ENGINE_ASSET_PROJECTION_FAILED` 502），可选则 `failed[]` 并继续；③ 返回报告。`src/engines/opencode/assets.ts` 现有的 `projectOpenCodeAssets` 改为"建表 + 调 `projectAssets`"，行为与测试不变。

### 6.2 逐引擎逐域投影落点

**OpenCode**（`src/engines/opencode/assets.ts` 的表；`native-config.ts` 负责把表的产物写进私有 `opencode.json`）

| 域 | 落点 | `layout` | 证据 | 备注 |
|---|---|---|---|---|
| `instruction` | `<ndd>/opencode/assets/instructions/<dir>/<file>`，绝对路径入 `instructions[]` | file | probed | 现状 |
| `skill` | `RedirectPlan.skillRoots[*]/<dir>/…`（整棵树） | directory | declared（Linux 目录解析已读实；Windows 落点未验证） | 现状只复制单文件，改为 `placeTree` |
| `command` | `OPENCODE_CONFIG_DIR/commands/<name>.md` | file | declared | 目录扫描未验证 |
| `agent` | `OPENCODE_CONFIG_DIR/agents/<name>.md` | file | declared | 同上 |
| `prompt-template` | `alias:"command"`，同上 | file | declared | OpenCode 无独立模板 |
| `mode` | `alias:"agent"` | file | declared | 1.x 概念合并 |
| `native-extension` | `OPENCODE_CONFIG_DIR/plugins/<id>.ts`；`permit:"permitNativeExtensions"` | file | declared | 默认不许可；`permission.ask` 钩子可改判，见第 8.6 节 |
| `hook` | 无 | — | — | `support:"none"` |
| `native` | 私有 `opencode.json` 顶层浅合并；保留键 `provider, model, small_model, permission, instructions, mcp, plugin, agent, command, skill, tools` → `validateNativeOptions` 拒绝 | — | — | 保留键是被类型化/资产域拥有的键；`tools` 是引擎按工具名启停的开关，会绕过 `sideEffect` 策略，因此保留 |

**Pi**（新增 `src/drivers/pi-rpc/assets.ts` 的表；`launch.ts` 消费其产物）

| 域 | 落点 | `layout` | 证据 | 备注 |
|---|---|---|---|---|
| `instruction` | 合并正文 → `--append-system-prompt` | file | probed | 现状；投影器返回 `targets:["argv:--append-system-prompt"]` |
| `skill` | `<agentConfigDir>/pnp/skill/<dir>/…` 整棵树；私有 `settings.json#skills[]` 追加 `"pnp/skill/<dir>"`（相对 `PI_CODING_AGENT_DIR`，`settings.md` "Resources"） | directory | declared | 放在**非**自动发现目录（不是 `<agentConfigDir>/skills/`）并显式列出，避免同一技能被发现两次（`skills.md`："Name collisions … keep the first"） |
| `command` / `prompt-template` | `<agentConfigDir>/pnp/prompt/<name>.md`；`settings.json#prompts[]` | file | declared | 文件名即 `/name` |
| `agent`、`mode`、`hook` | 无 | — | — | `support:"none"` |
| `native-extension` | `hosting:"hosted"`（缺省）：写入 sidecar `<ndd>/pnp-extensions.json`，桥托管加载；`hosting:"direct"`：追加 `-e <path>`（仅当 `PNP_PI_DIRECT_EXTENSIONS=1`）。`permit:"permitNativeExtensions"` | file | 托管：未验证；直接：probed（`-e` 加载 `.ts`/`.js`） | 第 8.4–8.5 节 |
| `native` | 私有 `settings.json` 顶层浅合并（在 `buildPiSettings` 之后、驱动自己的键之下）；保留键 `packages, extensions, skills, prompts, themes, defaultProvider, defaultModel, defaultTools, enabledModels, defaultProjectTrust` | — | — | `packages/extensions` 若可原生设置，就绕过了 `native-extension` 的准入门；`defaultTools` 由驱动在 win32 上拥有 |

两张表的 `evidence` 值来自 `config/engines/<id>.json#domains.<kind>.evidence`（第 7.1 节），不硬编码在表里。

### 6.3 必需/可选与错误码

| 情形 | 时机 | 码 / 状态 | 消息形状（不含值，含 id） |
|---|---|---|---|
| 必需资产的域不在选定引擎 `describe()` 中 | 启动（`main.ts`，监听端口前） | `ENGINE_ASSET_KIND_UNSUPPORTED` / 拒绝启动，非零退出 | `Engine "pi" cannot carry required asset kind(s): agent (office-report.reviewer), hook (settings:audit). Remove them, mark them optional, or scope them with "engines".` |
| 同上，但 Pack 无 `describe()` | 打开通道（`projectAssets` 第 ① 步，`launch()` 之前） | `ENGINE_ASSET_KIND_UNSUPPORTED` / 502 | `OpenCode Pack has no native projection for required asset kind(s): agent (office-report.reviewer).`（现状消息加上 id） |
| 可选资产的域不受支持 | 打开通道 | 无错误；`skipped{reason:"unsupported-kind"}` | 报告进事件 |
| 资产 `engines` 不含选定引擎 | `prepare()` 前过滤 | 无错误；Pack 看不到该条 | **不进运行事件**；只出现在 `GET /config/effective` 的静态预判 `will-skip: not-targeted`（见 6.4） |
| `native-extension` 未许可 | 打开通道 | 必需 → `ENGINE_ASSET_NOT_PERMITTED` / 502；可选 → `skipped{reason:"not-permitted"}` | `Required native extension office-report.artifact-audit needs packs.office-report.permitNativeExtensions=true.` |
| 复制/写入失败 | 打开通道 | 必需 → `ENGINE_ASSET_PROJECTION_FAILED` / 502；可选 → `failed[]` | 现状消息 |
| 包目录缺失 / 清单无效 / `files` 未列出被引用文件 | 加载 settings | `PACK_NOT_FOUND` 400 / `PACK_MANIFEST_INVALID` 400 → 拒绝启动 | `Pack "office-report" was not found under any approved root (delivery, config, extra:0).` |
| `requires` 不满足 | 加载 settings | `required:true` → `PACK_REQUIRES_UNMET` 400 拒绝启动；否则整包 `skipped{reason:"requires-unmet", detail}` | `Pack "office-report" requires env PNP_MODEL_ENDPOINT (unset).` |
| 文件越界 / 超限 / 摘要不符 | `prepare()`（解析器） | `ASSET_OUTSIDE_ROOT` 403 / `ASSET_INVALID` 400 / `ASSET_DIGEST_MISMATCH` 409 | 现状 |
| `native` 含保留键或形状不符 | 启动探测与 `POST /config/validate` | `NATIVE_OPTIONS_INVALID` 400 | `cores.pi.native.extensions is reserved: native extensions are configured through assets.native-extension or packs.` |
| `parameters` 不符合 `parameterSchema` | 启动探测与 `POST /config/validate` | `ASSET_PARAMETERS_INVALID` 400 | 命名资产 id 与字段路径 |

原则：**引擎有的能力必须可达，引擎没有的能力必须有名有姓地失败。** 表中没有任何一行是"静默丢弃"。

### 6.4 报告与事件

`assets.projected` 是现有通知名（`src/drivers/acp/channel.ts:658`），载荷改为 `ProjectionReport` 的 JSON 形式：

```json
{
  "projected": [
    { "id": "instruction:competition", "kind": "instruction", "sha256": "…", "targets": ["D:\\…\\instructions\\instruction_competition-1a2b3c4d\\competition.md"] },
    { "id": "office-report.office-report", "kind": "skill", "sha256": "…", "pack": "office-report", "packVersion": "1.0.0", "targets": ["D:\\…\\skills\\office-report.office-report"] }
  ],
  "skipped": [
    { "id": "office-report.artifact-audit", "kind": "native-extension", "reason": "not-targeted", "pack": "office-report" }
  ],
  "failed": []
}
```

- ACP：不变的机制（`notices` → 首轮 `native_()`），只是载荷形状升级；`assets.skipped` 通知保留给"定义没有 `projectAssets`"的旧路径。
- Pi：`openPiSession` 生成同名通知，`PiSessionChannel` 在首轮 `run()` 里与 `tools.unsupported-transport` 同一位置发出（`unsupportedNoticeSent` 的模式）。
- `not-targeted`（`engines` 不含选定引擎）的过滤发生在 `prepare()`，Pack 与驱动都看不到这些条目，它们**不进运行事件**：Core 不读资产，驱动只报告自己实际处理过的资产，运行事件只记录**这个引擎实际做了什么**。这些条目由 `GET /config/effective` 的静态预判（`will-skip: not-targeted`）展示。`skipped.reason` 枚举里保留 `not-targeted` 值，供静态预判与运行报告共用同一类型。
- 北向：`engine.extension{namespace:"acp"|"pi", nativeType:"assets.projected", payload}`，现有投影路径（`gateway-core.ts` 的 `journal.publish("engine.extension", …)`），北向路由无改动。

### 6.5 两处检查为什么都要

- 启动静态检查（`describe()`）：让部署方在监听端口之前就知道"这套 settings 在这个引擎上跑不了"，与 `MODEL_ENVIRONMENT_MISSING`、指令文件缺失的现状一致（contracts.md §3.4 "启动阶段错误"）。它只能回答"域是否被声明"，回答不了"这次复制会不会失败"。
- 打开通道动态检查（投影表）：是权威判定，覆盖没有 `describe()` 的 Pack、投影器运行期错误、许可开关。
- 两者一致性由构造保证：`describe().domains = domainsOf(table)`，测试 `tests/kit/engine-contract.ts` 增加断言"`describe()` 的每个 `support≠none` 的域在表里有投影器，表里的每个键在 `describe()` 里"。

### 6.6 指纹与围栏

现有围栏不改：ACP 的 `integrationFingerprint` 已含 `assets{id,kind,sha256,required}`，改为取 `bundleDigest ?? sha256` 即覆盖目录型资产；Pi 驱动目前只对工具与模型指纹，**新增** `fingerprintPiAssets(assets)` 并在 `run()` 里与另两项并列比较（同样 409 `ENGINE_BINDINGS_CHANGED`）。`native` 对象也进入指纹（两个驱动都把它写进启动期文件）。

## 7. 声明：`describe()` 与 `config/engines/<id>.json`

### 7.1 决定：代码为准，JSON 记证据；两者都要

| 内容 | 住在哪 | 为什么 |
|---|---|---|
| 引擎能投影哪些域、每域的 `layout`/`projection`/`alias`/`permit`/`parameterSchema` | **代码**：投影表 | 只有代码知道自己能投影什么；表与 `describe()` 是同一个对象，类型检查器保证声明不比实现多也不少。放在 JSON 里的声明无法被编译器与投影器对账，会像 `capabilityEvidence` 一样变成"写着 probed 但代码不做"的风险 |
| 每域的 `evidence` 与备注 | **JSON**：`config/engines/<id>.json#domains.<kind>` | 证据是关于**探测过程**的事实（在哪台机器、哪次实跑），不是关于代码的事实；仓库已经用这个文件记 `capabilityEvidence`，`docs/engines/<id>.md` 记探测命令。JSON 里出现表中没有的域 → `ENGINE_CONFIG_INVALID`（现有码）；表中有而 JSON 没写 → 缺省 `declared` |
| `reservedNativeKeys`、`nativeOptionsSchema` | 代码 | 与投影器同源 |

`describe()` 的约束：纯函数级——不启动进程、不联网、不读取会话目录；允许读 `config/engines/<id>.json`（OpenCode 现状 `loadOpenCodeEngineConfig()` 已经这么做）。注册表新增：

```ts
// src/registry/index.ts
export async function describeEngine(id: string, development: boolean): Promise<EngineDescription | undefined>;
export function listEngineIds(): readonly string[];
```

`describeEngine` 走与 `loadEngine` 相同的工厂（不新增引擎 id 的绑定点），对没有 `describe()` 的 Pack 返回 `undefined`。配置中心的 `GET /config/schema` 用它枚举所有已注册引擎的域清单（不要求引擎已安装——`describe()` 不碰二进制），并用 `capabilityEvidence`/`implementationProvided` 标注可用性。

### 7.2 `config/engines/pi.json` 的增补（示意）

```json
"domains": {
  "instruction":      { "evidence": "probed",   "notes": "--append-system-prompt, docs/engines/pi.md B04" },
  "skill":            { "evidence": "declared", "notes": "settings.json#skills[] relative to PI_CODING_AGENT_DIR; not yet exercised on a real binary" },
  "command":          { "evidence": "declared", "notes": "settings.json#prompts[]; RPC prompt expands /name (rpc.md)" },
  "native-extension": { "evidence": "declared", "notes": "hosted loading through pnp-bridge is unverified; direct -e loading is probed (B08 item 4)" }
}
```

### 7.3 配置页面如何渲染"当前引擎能配什么"

配置中心的 `GET /config/schema?engine=pi` 返回 `describeEngine("pi")` 原样加上有效配置的静态预判，页面按域渲染一行：

| 列 | 取自 |
|---|---|
| 域名与说明 | `CapabilityDomain.kind`、`projection` |
| 支持方式 | `support`（`native` / `bridged` / `none`，三种图标，不合并） |
| 证据 | `evidence`，与 `/diagnostics` 用同一套三级词 |
| 生效范围 | `scope`（`session`：新会话；`process`：需重启） |
| 可编辑参数 | `parameterSchema` 驱动的表单；无 schema 则只读展示 `parameters` |
| 已配置贡献 | `GET /config/effective` 的 `assets[]` 过滤到该域，每条带 `origin`（继承自 common / 本引擎覆盖 / 来自包 `<id>@<version>`）与静态预判 `will-project` / `will-skip: not-targeted` / `will-skip: unsupported-kind` / `will-skip: not-permitted` |
| 实际结果 | 会话页/Trace 里的 `assets.projected` 事件；**静态预判与运行结果分栏显示，不混** |

`support:"none"` 的域仍然渲染（灰显），因为它回答的是"这个引擎为什么没有它"——所有者要求的透明，正是不对称要被看见。

## 8. 钩子与信任模型

### 8.1 事实

- Pi 的 `tool_call`：`event.input` 可变；"No re-validation is performed after your mutation"；"Later `tool_call` handlers see mutations made by earlier handlers"；返回 `{block:true}` 阻断；"`tool_call` errors block the tool (fail-safe)"（`extensions.md` "Tool Events"、"Error Handling"）。多个处理器的**阻断合成规则**（后一个返回 `undefined` 能否撤销前一个的阻断）文档未明说——**未验证**。
- 处理器按**扩展加载顺序**运行（`tool_result`、`before_provider_request` 明文；`tool_call` 由"Later handlers see mutations"推出）。加载顺序由 pi 决定（自动发现目录、`settings.json`、`-e` 的相对次序），文档未给出跨来源的总顺序——**未验证**。
- 扩展"run with your full system permissions and can execute arbitrary code"（`extensions.md`、`packages.md` 安全提示）；pi 进程的环境里有模型凭据的**值**（`LaunchSpec.env`，由 `launch.ts` 放入）。任何扩展都能 `process.env` 读到它，也能 `before_provider_headers` 看到它。
- `pnp-bridge` 的策略门：`read` 直接放行，其余 `ctx.ui.confirm("pnp:<op>", …)` 问网关；网关裁决在 `services.interact()`（`channel.ts#bridgeInteraction`）。裁决记录在网关，不在 pi。
- OpenCode 插件 `permission.ask` 钩子可把 `output.status` 改为 `allow`，在到达 ACP `session/request_permission` 之前改判（`T03-opencode.md` 行 162）；`tool.execute.before` 可抛错阻止。

### 8.2 威胁清单

| # | 威胁 | 后果 |
|---|---|---|
| T1 | 用户钩子在策略门**之后**改写 `event.input`（如把已批准的 `echo hi` 改成 `rm -rf`） | 执行的不是被批准的内容 |
| T2 | 用户钩子在策略门之后返回撤销阻断的值（若 pi 允许） | 绕过 deny/ask |
| T3 | 用户钩子自己执行副作用（`pi.exec`、`node:child_process`、`fetch`） | 完全绕过工具层的策略门 |
| T4 | 用户钩子读取 `process.env` 中的模型凭据并外传 | 凭据泄露 |
| T5 | 提示注入让模型"安装"一个扩展（写文件到自动发现目录） | 下一会话起生效的持久化后门 |
| T6 | `native` 设置 `packages`/`extensions` 指向任意路径 | 绕过准入 |
| T7 | OpenCode 插件 `permission.ask` 改判为 `allow` | 网关的 ask/deny 不再到达 |
| T8 | 包文件在部署后被篡改 | 运行非审核过的代码 |

### 8.3 两级信任

**第一级：准入（决定"谁能把代码放进引擎进程"）。** 这是真正的安全边界，因为进程内没有沙箱（`security.md` "No Built-in Sandbox"），一旦进入进程就与网关自己的桥同权。

1. 来源只能是批准根（第 4.6 节）；`assets.native-extension.<id>.path` 与包贡献都受 realpath 包含性检查（T5：模型写进 `Session.directory` 的文件不在任何批准根内；写进 `<agentConfigDir>/extensions/` 也不行，因为该目录不是自动发现目录的话就不加载——见下条）。
2. Pi 的私有 `settings.json` 由驱动生成，`extensions`/`packages`/`skills`/`prompts` 键为保留键（T6），`native` 不能设；驱动**不**把任何东西放进 `<agentConfigDir>/extensions/`（pi 的自动发现目录），托管扩展放在 `pnp/` 子树，pi 不会自动加载它们。项目级 `.pi/extensions`（在 `Session.directory` 里）因 `--no-approve` 默认不受信而不加载（`settings.md` "Project Trust"：非交互模式下 `defaultProjectTrust: "ask"` 忽略项目资源）。
3. 每个 `native-extension` 贡献都需要显式许可：`packs.<id>.permitNativeExtensions: true` 或 `assets.native-extension.<id>.permitted: true`。许可写在 settings.json（部署方意志），`PUT /config` 可以改它，但改的是布尔位，文件必须已经在批准根内且摘要一致——页面无法上传代码。
4. 摘要在每轮 `prepare()` 复核（T8）。
5. 提示、模型输出、北向 API 都没有写批准根的路径。

**第二级：进程内围栏（决定"进入进程的代码能否破坏网关自己的门"）。** 它防的是**顺序与接口层面**的破坏（T1、T2），对**恶意**代码（T3、T4）只能记录不能阻止——这一点必须写在文档里，不能让"托管"两个字读成沙箱。

### 8.4 Pi：托管加载（缺省档）

`pnp-bridge` 不再只是自己注册钩子，它成为用户扩展的**宿主**：

1. `launch.ts` 把本会话许可的 `native-extension` 资产写成 sidecar `<ndd>/pnp-extensions.json`：`[{ id, entry: <绝对路径>, sha256, events: [...] }]`，路径通过 `PNP_PI_EXTENSIONS_FILE` 传入（与 `PNP_PI_BRIDGE_FILE` 同法，只含路径与名字，不含值）。
2. `activateBridge` 在连接 MCP 服务器之后、注册自己的钩子**之前**，逐条 `await import(pathToFileURL(entry))`，取 `default` 导出，用一个**代理 API** 调用它：

```ts
// extension/pnp-bridge.ts（新增部分的形状）
interface HostedExtension { id: string; entry: string; sha256: string; events: readonly string[] }
const HOSTED_PASSTHROUGH_EVENTS = new Set(["session_start", "session_shutdown", "agent_start", "agent_end", "turn_start", "turn_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_result", "before_agent_start", "context", "message_start", "message_update", "message_end"]);
const HOSTED_GUARDED_EVENTS = new Set(["tool_call"]);
const HOSTED_REFUSED_EVENTS = new Set(["before_provider_headers", "before_provider_request", "after_provider_response", "project_trust", "model_select", "user_bash", "input"]);
const HOSTED_REFUSED_METHODS = ["registerProvider", "unregisterProvider", "setModel", "exec", "registerFlag", "setActiveTools"];

export function createHostedApi(pi: PiExtensionApi, extension: HostedExtension, chain: HostedToolCallChain, report: (m: string) => void): PiExtensionApi;
export async function loadHostedExtensions(pi: PiExtensionApi, file: string | undefined, chain: HostedToolCallChain, report: (m: string) => void): Promise<{ loaded: string[]; failed: { id: string; reason: string }[] }>;
```

   - 透传事件：直接 `pi.on(event, handler)`，但 handler 被包一层 try/catch 并加上扩展 id 前缀的错误报告；异常不传播（pi 自己也是"Extension errors are logged, agent continues"）。
   - **受围栏事件 `tool_call`**：不直接注册到 pi。桥自己只注册**一个** `tool_call` 处理器，内部顺序固定：先按 sidecar 顺序运行全部用户处理器（可改 `event.input`，可返回 `{block:true}`），再运行网关策略门（`createToolCallHook`）**看最终的 `event.input`**。合成规则：任一用户处理器阻断 → 阻断，理由带扩展 id，且**仍然**记录策略门的裁决用于审计（`ctx.ui.notify` 不可用时 stderr）；用户处理器都放行 → 策略门决定。用户处理器**收不到**策略门的返回值，也没有 API 可以撤销它。这样 T1、T2 在结构上不可能：策略门永远最后运行、永远看最终输入、永远不可覆盖，与 pi 的处理器合成规则无关。
   - 拒绝事件：`before_provider_headers`/`before_provider_request` 直接看到凭据与请求，`project_trust` 能替网关决定信任，`user_bash`/`input` 是 TUI 面；托管档一律拒绝注册（报告一次，继续加载）。需要它们的扩展走直接档。
   - 拒绝方法：`registerProvider`（改模型路由，绕过 `models.json` 指纹）、`setModel`、`exec`（直接起进程）、`registerFlag`、`setActiveTools`（关掉 `read` 以外的内建再自己注册同名工具会绕过操作类映射）。`registerTool` **允许**，但注册的工具名进入 `bridged` 映射表时 `sideEffect` 取 `"external"`（最强），使策略门按 `external` 问网关——扩展自带的工具不可能比 MCP 工具更宽松。`registerCommand`、`sendMessage`、`appendEntry`、`setSessionName` 允许。
3. 一个扩展导入失败或工厂抛错：报告一次、跳过它、其他扩展与策略门照常（与 MCP 服务器连不上的处理一致）；驱动侧在首轮以 `assets.projected.failed[]` 记录（桥通过 stderr 报告，驱动无法读回结果——**改为**桥把加载结果写回 `<ndd>/pnp-extensions.result.json`，驱动在握手后读一次并入报告；文件只含 id 与原因）。必需的托管扩展加载失败 → 驱动在首轮 `run()` 前抛 `ENGINE_ASSET_PROJECTION_FAILED`。
4. 顺序保证的代价：桥的 `tool_call` 必须是 pi 里**唯一**的 `tool_call` 处理器。直接档（8.5）会破坏这一点，所以直接档是显式开关。

托管档只支持 `.js`/`.mjs`（ESM，`default` 导出为工厂）。`.ts` 在托管档**不支持**：桥自己经 jiti 加载，但桥内的动态 `import()` 走 Node 原生加载器，pi 进程未必带 `--experimental-strip-types`（未验证）。交付内的扩展一律 `.js`。

### 8.5 Pi：直接加载档（`hosting:"direct"`）

`-e <path>` 追加到 argv（probed）。前提：`PNP_PI_DIRECT_EXTENSIONS=1` **且** 该贡献已许可。`describe()` 对 `native-extension` 的 `parameterSchema` 列出 `hosting` 枚举与这条前提。直接档的扩展与桥同权、顺序由 pi 决定；文档明说：直接档等于"我信任它到和网关自己的桥一样"，只用于需要 `registerProvider`/`before_provider_request` 一类能力的扩展。驱动把 `-e` 的顺序固定为：用户扩展在前、`pnp-bridge` 最后——若 pi 按 `-e` 出现顺序加载（未验证），策略门仍看到最终输入；若不是，这一档本来就不承诺围栏。

### 8.6 OpenCode 插件

投影落点 `OPENCODE_CONFIG_DIR/plugins/<id>.ts`，declared。`permission.ask` 可改判为 `allow`（T7）是引擎自己的设计，网关无法在插件之前插一道门——OpenCode 没有"宿主"机制可用。因此：`support:"native"`、`evidence:"declared"`、`permit` 必需，且 `describe()` 的 `projection` 文本明写"a plugin's permission.ask hook runs before the ACP permission request and can pre-empt the gateway's policy"。默认姿态下 OpenCode 的 `native-extension` 不许可；许可它是部署方对该插件源码的背书。这就是"不对称是产品"的一个实例：同一域在两个引擎上的信任模型不同，网关如实转述而不是拉平。

### 8.7 明确不保护的

- T3：托管扩展仍可 `import("node:child_process")` 自己起进程。桥不做模块级沙箱；`lint` 只做静态字符串检查（`child_process`、`process.env` 出现即在 `verify` 报告里标 `warning`，不阻止）。
- T4：进程环境里的凭据对任何进程内代码可见，这是 `launch.ts` 的设计（值只在 env）；无法对扩展隐藏。
- 桥被 monkey-patch：进程内同权代码可以改任何东西。

准入是唯一真正的边界；进程内围栏解决的是**好意代码的次序问题**，这是它对 T1/T2 有效、对 T3/T4 无效的原因。

### 8.8 默认姿态（竞赛交付）

- `packs`：只启用 `windows-desktop`（无可执行贡献）；`office-report` 作为文档示例不随交付启用。
- `permitNativeExtensions`：两引擎均 `false`。
- `PNP_PI_DIRECT_EXTENSIONS`：未设。
- `PNP_PACK_ROOTS`：未设（只有 `delivery` 与 `config` 两个根）。
- `release:check`：对 `assets/packs/*` 跑 `verify` + `lint`；任何包含 `native-extension` 贡献且在交付 settings 中被许可的配置 → 门禁失败（交付不带可执行贡献）。

## 9. 生命周期

| 操作 | 怎么做 | 生效时点 | 驻留会话 | 需重启网关 |
|---|---|---|---|---|
| 安装包 | 把目录放进批准根；`pack-tool digest` 生成 `files`；settings 加 `packs.<id>` | 下一次 `prepare()`（每轮重新展开） | 下一轮 409 `ENGINE_BINDINGS_CHANGED`，新会话即可 | 否 |
| 启用/禁用包或单条贡献 | `packs.<id>.enabled` / `contributions.<kind>.<id>.enabled`（`PUT /config` 可改） | 同上 | 同上 | 否 |
| 升级包 | 替换目录内容并重跑 `digest`；`version` 升 | 同上；报告与 Trace 显示新 `packVersion` | 同上 | 否 |
| 移除包 | 先 `enabled:false`，再删目录 | 同上 | 同上 | 否；若先删目录再改 settings，中间状态下启动会因 `PACK_NOT_FOUND` 拒绝 |
| 许可可执行贡献 | `permitNativeExtensions:true` | 同上 | 同上 | 否 |
| 增加批准根 | `PNP_PACK_ROOTS` | 进程环境 | — | **是**（`scope:"process"`） |
| 开直接加载档 | `PNP_PI_DIRECT_EXTENSIONS=1` | 进程环境 | — | **是** |
| 改 `native` | `PUT /config` | 下一次 `open()`（写进启动期文件） | 同上（`native` 进指纹） | 否 |
| 包贡献的 MCP 服务器引用新的环境变量 | settings + `runtime/local.env` | 变量值在 `loadIntegration` 时解析（现状） | — | **是**（与现状 MCP 一致；配置中心若引入运行期重载，此行随之变化） |

与配置中心的衔接：`PUT /config` 只写 settings.json；"应用"就是下一次 `prepare()`。运行中的 Run 使用其接受时的绑定（`IntegrationContext` 每轮新建；驻留通道的指纹是打开时的），符合"运行中的任务固定使用接受时配置版本"。回滚 = 再存一版；不撤销已投影到已删除会话目录的文件（它们随 `DELETE /session` 走 `purge()`）。

`purge()`：OpenCode 现状删除整个 `nativeDataDirectory`（Core 负责），Pi 的 `purge()` 显式删 `toolsFile` 与 `agentConfigDir`；新增 `pnp-extensions.json`、`pnp-extensions.result.json` 与 `pnp/` 子树都在 `nativeDataDirectory` 内，`PiPack.purge()` 补两行 `rm`。

## 10. 安全

| 项 | 规则 |
|---|---|
| 来源 | 只从批准根加载（`delivery`、`config`、`PNP_PACK_ROOTS`）。settings 的 `packs.<id>.root` 只能引用根的**名字** |
| 完整性 | `files` 的 SHA-256 在每轮 `prepare()` 复核（现有解析器）；每文件 ≤ 1 MiB、每包 ≤ 512 文件 / 16 MiB |
| 可执行贡献 | 需显式许可；OpenCode 默认不许可；Pi 默认托管档；交付不带任何已许可的可执行贡献 |
| 凭据 | 包与资产条目**没有**凭据字段；包贡献的 MCP 服务器沿用变量名规则；`lint` 对 `pack.json` 与 `.md`/`.js` 做形状检查（`sk-`、`Bearer `、`appid=` 等模式 → 失败） |
| 禁止内容（沿用 §10.4） | 任务标识判断、固定答案、测试材料；内部地址、工号；包内脚本读写用户目录外的用户数据、修改引擎全局配置；spawn 引擎、访问网关存储 |
| 提示面 | 提示、模型输出、`Session.directory` 里的任何文件都不是批准根；引擎自己的项目级发现（`.pi/`、`.opencode/`）在会话目录里发生，那是引擎行为，网关不写也不读它们 |
| 页面面 | `PUT /config` 只改布尔位与 `parameters`；`POST /config/validate` 只跑解析器与 `describe()`，不执行任何包内代码 |
| 事件面 | 报告只含 id、kind、目标路径、摘要、包 id 与版本；路径经现有 `redactor.json`（`gateway-core.ts`）脱敏 |
| 默认 | 第 8.8 节 |

## 11. 接入第三引擎、且它有一个新域时，要碰哪些文件

以 Hermes（ACP，`docs/research/T04-hermes-agent.md`）为例：它有 `MEMORY.md`/`USER.md` 冻结快照记忆（行 23、211），两个现有引擎都没有对应机制。定义新域 `memory`（文件型；投影落点是 Hermes 私有 `HERMES_HOME/memories/MEMORY.md`——落点本身要靠探测，这里只说明形状）。

| 文件 | 改动 | 是否因"新域"而增加 |
|---|---|---|
| `src/engines/hermes/pack.ts` | 实现 `open()`（填 `AcpEngineDefinition`，与 OpenCode 同形）、`describe()`（= `domainsOf(TABLE)` + 读 JSON 证据）、`validateNativeOptions()`（保留键） | 否——这是任何第三引擎都要写的（`ARCHITECTURE.md` §5.1 已列） |
| `src/engines/hermes/assets.ts` | 投影表：`instruction`、`skill`、**`memory: projectMemory`** | **是，这一行**（约 15 行：`placeFile` 到私有 memories 目录，返回 target） |
| `src/engines/hermes/*.ts` | 可执行文件解析、私有配置、模型注入、HOME 重定向——引擎特有事实 | 否 |
| `src/registry/index.ts` | 一行工厂 | 否 |
| `config/engines/hermes.json` | 版本、分发、`domains.memory.evidence` | 否（证据行是新域的，但文件本来要写） |
| `engines.lock.json` | 版本 + tarball 摘要 | 否 |
| `tests/adapters/hermes/` | Pack 单测 + `engineContract`；`assets.test.ts` 加一条 `memory` 投影断言 | 部分 |
| `docs/engines/hermes.md` | 证据表 | 否 |
| 任何包的 `pack.json` | `contributes.memory[]` | 配置，不是代码 |
| `config/settings.json` | `cores.hermes.assets.memory.<id>` 或 `packs.<id>` | 配置，不是代码 |

**一行都不改**：`src/config/settings.ts`（无域清单）、`src/contracts/index.ts`（`kind: string`）、`src/assets/{resolver,projection,packs}.ts`（通用）、`src/integration/*`（不认识域）、`src/core/*`、`src/gateway/*`、`scripts/check-boundaries.mjs`、配置页面（从 `describe()` 渲染出 `memory` 一行，`support:"native"`、`evidence` 取 JSON）。

为什么不能再短：`assets.ts` 里那一行是"这个引擎怎么放这个文件"，除了引擎作者没人知道；JSON 里那一行是"我在哪里试过"，除了试的人没人能写。这两行**就是**新域的全部成本。反过来，若设计要求在 `settings.ts` 加 `memory` 键、在契约加 `"memory"` 字面量、在页面加一个表单，那就是第 1.1 节第二条推论被违反的样子——本文第一稿曾把 `skills`/`assets` 都做成顶层类型化键，正是在这一节的核对里退回到"信封封闭、域开放"的。

## 12. 未验证项（诚实清单）

| 项 | 状态 | 影响 | 验证方式 |
|---|---|---|---|
| 配置中心设计正文 | 未在仓库中找到（`validateNativeOptions` 零命中），按简报建设 | 字段名可能有出入 | 两文对读，以配置中心为准 |
| Pi：`PI_CODING_AGENT_DIR/settings.json#skills[]`、`prompts[]` 在 `--mode rpc` 下生效 | declared（`settings.md`） | `skill`/`command` 投影 | `scripts/e2e` 加一步：技能描述出现在 system prompt（用 `before_agent_start` 探针或 mock 模型收到的 messages） |
| Pi：桥内动态 `import()` 用户 `.js` 扩展 | 未验证 | 托管档 | `tests/adapters/pi/bridge-extension.test.ts` 进程内夹具 + 真机 `-e` 实跑 |
| Pi：多个 `tool_call` 处理器的阻断合成规则 | 未验证 | 只影响直接档（托管档不依赖它） | 真机两个探针扩展 |
| Pi：`-e` 多次出现的加载顺序 | 未验证 | 直接档 | 同上 |
| OpenCode：`OPENCODE_CONFIG_DIR/{commands,agents,plugins}` 扫描 | declared（`docs/engines/opencode.md` §7 明写未验证） | `command`/`agent`/`native-extension` | 真机：投影一个 command，`available_commands_update` 里出现 |
| OpenCode：ACP 会话是否展开 `/command` 文本 | 未验证 | `command` 域对北向的可用性 | 真机 |
| OpenCode：Windows 上 skill 目录落点 | `docs/engines/opencode.md` §8 第 4 条 | `skill` | 真机 |
| Hermes `memory` 落点 | 举例，未探测 | 第 11 节只论证成本形状 | — |
| `assets/packs/windows-desktop/` 内容 | 现为两个空目录（简报称含 `pack.json`/`SKILL.md`/`instructions/desktop.md`，磁盘上没有） | 第 5.6 节按空骨架重写 | — |

## 13. 实施包

每包可独立构建、独立提交；顺序是依赖顺序。规模：S ≤ 半天，M ≤ 2 天，L ≤ 4 天。全部零新增依赖。

### P1 契约 1.2.0 与公共投影助手（S，风险低）

- 文件：`src/contracts/index.ts`（第 3 节全部类型；`CONTRACT_VERSION = "1.2.0"`）；新建 `src/assets/projection.ts`（第 6.1 节签名：`ProjectorTable`、`domainsOf`、`assertRequiredProjectable`、`projectAssets`、`placeFile`、`placeTree`、`reportToJson`）。
- `src/assets/resolver.ts`：新增 `resolveAssetTree(root, input: {…, layout:"directory", entry}): Promise<AssetBinding>`（逐文件 `resolveAsset`，产出 `files[]` 与 `bundleDigest`），不改 `resolveAsset`。
- 测试：`tests/unit/contracts.test.ts` 加版本断言；新建 `tests/unit/projection.test.ts`：必需未支持在写文件前抛且目录为空；可选未支持进 `skipped`；投影器抛错时必需抛/可选进 `failed`；`domainsOf` 与表键一致；`placeTree` 保留相对结构；`resolveAssetTree` 对越界文件抛 `ASSET_OUTSIDE_ROOT`、对超限抛 `ASSET_INVALID`。
- 验收：`npm run typecheck`、`check:boundaries`、`check:strip-only` 通过；现有 469 项不变。

### P2 settings：`packs`、`assets`、批准根（M，风险中——与配置中心的 `skills`/`native` 同文件并行）

- 文件：`src/config/settings.ts`：`exactKeys` 扩为八键；`parseAssetEntry`、`parseAssetsSection`（域键不校验）、`parsePacksSection`；`resolveAssetRoots(settingsDirectory, env)`；`EffectiveSettings` 增 `packs: PackSelection[]`、`assets: Record<string, Record<string, AssetEntry>>`、`assetRoots: AssetRoot[]`；`expandPlaceholders` 增 `${PNP_PACK_ROOT}`（仅在 `packs.ts` 传入 `packRoot` 时接受）。`config/SETTINGS.md` 增第 4.5 节文字。
- 签名：
  ```ts
  export interface AssetEntry { id: string; kind: string; path: string; layout: "file" | "directory"; entry?: string; required: boolean; enabled: boolean; engines?: readonly string[]; parameters?: Json; permitted?: boolean }
  export interface PackSelection { id: string; enabled: boolean; required: boolean; root?: string; permitNativeExtensions: boolean; contributions: Record<string, Record<string, Partial<Pick<AssetEntry, "enabled" | "required" | "parameters">>>> }
  export interface AssetRoot { name: string; path: string }
  ```
- 测试：`tests/unit/settings.test.ts` 增：八键之外仍 `SETTINGS_INVALID`；`assets.skill` 与 `assets.instruction` 被拒并提示；域键任意；同 id 跨层部分覆盖；`enabled:false` 移除；`packs.<id>.root` 非根名拒绝；`PNP_PACK_ROOTS` 相对路径拒绝。
- 风险处置：与配置中心的 P 包在同一文件修改时先合并其 `skills`/`native` 解析，本包只加两键；冲突面是 `exactKeys` 一行。

### P3 包加载器（M，风险低）

- 文件：新建 `src/assets/packs.ts`：`loadPackManifest(root: AssetRoot, id): Promise<LoadedPack>`（`PACK_NOT_FOUND`/`PACK_MANIFEST_INVALID`；`files` 完整性、大小上限、`manifest:2`）；`checkRequires(pack, {engineId, engineVersion, env, describe?}): RequiresOutcome`（含 15 行版本比较器）；`expandPack(pack, selection, engineId, roots): Promise<{ assets: AssetBinding[]; mcpServers: Record<string, unknown>; skipped: SkippedAsset[] }>`（贡献 id 前缀 `<packId>.`；`engines` 过滤；`contributions` 覆盖；`mcp` 段经 `parseMcpServer` 并展开 `${PNP_PACK_ROOT}`）。
- 新建 `scripts/pack-tool.mjs`：`digest <dir>`、`verify <dir>`、`lint <dir>`（§10.4 禁止项 + 凭据形状 + `child_process`/`process.env` 警告）；`package.json` 增 `pack:verify`，`check` 与 `release-check.mjs` 各调一次。
- 测试：新建 `tests/unit/packs.test.ts`：夹具包（技能目录 + 指令 + `.js` 扩展 + `mcp`）；缺 `files` 条目拒绝；摘要不符 409；`engines` 过滤为 `not-targeted`；`requires.env` 未设时可选包整体 `requires-unmet`、必需包抛 `PACK_REQUIRES_UNMET`；`${PNP_PACK_ROOT}` 只在包内展开；`mcp` 段与 settings 同 id 时 settings 覆盖。
- 内容：按第 5.6 节写 `assets/packs/windows-desktop/{pack.json, skills/windows-desktop/SKILL.md, instructions/desktop.md}`，删除空的 `tools/`；`SKILL.md` 只描述方法与自检（列举/打开固定应用、激活不等于完成）；`refresh-manifest` 由集成方在提交前运行（本包不运行）。

### P4 集成层展开与启动静态检查（M，风险中）

- 文件：`src/integration/index.ts`：`loadIntegration` 内在 `mcpToolBindings` 之前把启用包的 `mcp` 段并入（最低优先级）；把 `settings.assets`、`settings.skills`（配置中心）与包展开结果合成 `AssetEntry[]` 交给 `ConfiguredIntegration`。`src/integration/configured/provider.ts`：`assets()` 每轮经 `resolveAsset`/`resolveAssetTree` 重算（根 = 条目所属 `AssetRoot`），产出带 `origin` 的 `AssetBinding[]`；`probe()` 覆盖全部条目；新增 duck-typed `declaredAssets(): Promise<AssetBinding[]>` 供启动检查。`src/main.ts`：在 `probeIntegration` 之后、监听之前：`const description = await engine.describe?.(); if (description) assertRequiredProjectable(engineId, description.domains, await provider.declaredAssets())`；同处调用 `engine.validateNativeOptions?.(settings.native)`，失败 `NATIVE_OPTIONS_INVALID` 拒绝启动。`src/registry/index.ts`：`describeEngine`、`listEngineIds`。
- 测试：`tests/unit/config-assets.test.ts` 增：包资产带 `origin{source:"pack"}`；settings 同 id 覆盖包；`engines` 过滤；启动检查对必需未支持域拒绝并列出 id；`describeEngine("hermes")` 返回 `undefined`。`tests/contract/gateway.test.ts` 不变（北向无改动）。
- 风险处置：`main.ts` 的启动顺序已有注释约定（local.env → 选引擎 → 集成探测 → 实例锁 → 存储 → Core → 监听）；静态检查插在集成探测之后，不改其余顺序。

### P5 OpenCode Pack：投影表、`describe()`、`native`（M，风险低）

- 文件：`src/engines/opencode/assets.ts`：`OPENCODE_PROJECTORS: ProjectorTable`（`instruction`、`skill`（`placeTree`）、`command`、`agent`、`prompt-template`（alias）、`mode`（alias）、`native-extension`（permit））；`projectOpenCodeAssets` 改为调 `projectAssets`。`src/engines/opencode/pack.ts`：`describe()`、`validateNativeOptions()`（保留键第 6.2 节）；`native-config.ts`：`buildNativeConfigPayload` 接受 `native` 并浅合并（保留键已被拒绝，此处再断言一次）。`config/engines/opencode.json`：`domains` 段；`config.ts` 解析并校验其键 ⊆ 表键。
- 测试：`tests/adapters/opencode/assets.test.ts` 增：目录型技能整树复制到两个根；`command`/`agent` 落点；未许可的 `native-extension` 为 `skipped{not-permitted}`；`describe()` 与表一致；`native` 保留键拒绝；`native-config.test.ts` 增：`native.compaction` 出现在生成的配置里且 `provider`/`model` 不被覆盖。

### P6 Pi：投影表、`describe()`、`native`、资产指纹（M，风险中）

- 文件：新建 `src/drivers/pi-rpc/assets.ts`：`PI_PROJECTORS: ProjectorTable`（`instruction`（现状逻辑，target 记 `argv:--append-system-prompt`）、`skill`、`command`/`prompt-template`（`settings.json#prompts[]`）、`native-extension`（sidecar 或 `-e`））；`fingerprintPiAssets`。`launch.ts`：`resolveSessionPaths` 增 `extensionsFile`、`extensionsResultFile`、`pnpRoot`；`buildPiSettings` 接受 `{skills, prompts, native}` 并在保留键之外浅合并；`buildLaunchSpec` 接受 `directExtensions: string[]` 并保证 `pnp-bridge` 是最后一个 `-e`；`PNP_PI_EXTENSIONS_FILE` 常量。`channel.ts`：`openPiSession` 调 `projectAssets` 生成通知，首轮与 `tools.unsupported-transport` 同处发出；握手后读 `extensionsResultFile` 并入报告；`run()` 增资产指纹比较。`src/engines/pi/pack.ts`：`describe()`、`validateNativeOptions()`、`purge()` 补删。`config/engines/pi.json`：`domains` 段（第 7.2 节）。
- 测试：新建 `tests/adapters/pi/assets.test.ts`：技能落在 `pnp/skill/` 且 `settings.json#skills[]` 列出、不落在 `skills/`；prompts 同理；必需未支持在 `host.start` 之前抛；`native` 保留键；指纹变化 409。`launch.test.ts` 增：`-e` 顺序断言、`PNP_PI_DIRECT_EXTENSIONS` 未设时 `hosting:"direct"` 变为 `skipped{not-permitted}`。`engine-contract.test.ts` 不变。

### P7 Pi 桥：托管加载（L，风险高——唯一未验证的运行期机制）

- 文件：`src/drivers/pi-rpc/extension/pnp-bridge.ts`：第 8.4 节的 `HostedExtension`、`createHostedApi`、`loadHostedExtensions`、`HostedToolCallChain`（用户处理器数组 + 策略门 + 合成规则）、结果文件写出；`activateBridge` 改为：连 MCP → 加载托管扩展 → 注册唯一 `tool_call` → `before_provider_request` → `session_shutdown`（托管扩展的 `session_shutdown` 处理器在桥关闭客户端之前运行）。
- 测试：`tests/adapters/pi/bridge-extension.test.ts` 增（进程内夹具，不需真 pi）：夹具扩展 A（`tool_call` 改 `input.command`）、B（`tool_call` 返回 `block`）、C（工厂抛错）、D（注册 `before_provider_headers` 被拒）、E（`registerTool` 后其工具按 `external` 问网关）；断言：策略门看到 A 改后的输入；B 阻断时策略门仍被记录；C 不影响 A/B 与策略门；D 报告一次；`exec` 调用抛 `not permitted`；结果文件内容。
- 真机验证（不在自动化门禁内，记入 `docs/engines/pi.md` B08）：`-e pnp-bridge.js` + sidecar 指向夹具 `.js`，观察 `extension_ui_request{title:"pnp:shell"}` 仍出现且 `message.patterns` 是改写后的命令。
- 风险处置：若桥内动态 `import()` 在真机失败，托管档降级为"仅报告失败"，`describe()` 的 `native-extension.evidence` 保持 `declared`，直接档不受影响；不阻塞 P1–P6。

### P8 端到端与文档（S，风险低）

- `scripts/e2e/run-e2e.mjs`：增一步 `pack/projected`：启用 `windows-desktop`，在 `/event` 中等 `engine.extension{nativeType:"assets.projected"}`，断言 `projected[]` 含 `pack:"windows-desktop"` 的 `skill` 与 `instruction`（两引擎同一份断言）；`ci-smoke.mjs` 无改动。
- 文档：`docs/spec/contracts.md` §8、§10 改写为指向本文；`assets/packs/README.md` 重写为第 5 节摘要；`config/SETTINGS.md` 增 `packs`/`assets`；`docs/spec/dfx-and-testing.md` E03 措辞按第 5.7 节；`docs/ARCHITECTURE.md` §5.1 表格增 `assets.ts` 投影表一行与"新域成本"一段（第 11 节）；`docs/engines/{opencode,pi}.md` 证据表增 `domains` 行。

依赖图：P1 → P2 → P3 → P4 → {P5, P6} → P7 → P8。P5 与 P6 可并行；P7 只依赖 P6；P8 依赖全部。P1–P4 完成即可让 `settings.json` 接受任意域并在启动时给出显式失败，这是所有者三条推论中前两条的最小可演示集；P5/P6 使两引擎各自的域可达（第三条）；P7 是钩子信任模型的实现。
