# Pi 接入规格

所有者 B。入口 `code/src/engines/pi/pack.ts`，通道 `rpc`，公共契约 1.1.0。驱动实现在 `code/src/drivers/pi-rpc/`：`protocol.ts`（帧解析/编码）、`client.ts`（请求关联）、`launch.ts`（可信配置→LaunchSpec、`models.json`/`settings.json`/指令投影）、`tool-bridge.ts`（会话 sidecar 投影）、`extension/pnp-bridge.ts`（在 pi 进程内运行的 MCP 客户端桥 + `tool_call` 策略钩子）、`channel.ts`（`EngineSessionChannel` 实现）。

## 实现状态（诚实声明，对应 `verification/coverage.md` 的分层）

- **已有源码**：上述六个文件 + `engines/pi/pack.ts`；`descriptor.implementationProvided = true` 仅表示代码存在。
- **`capabilityEvidence: "probed"`**（`code/config/engines/pi.json`，`engineVersion: "0.85.1"`）：本驱动依赖的每一个 pi 侧机制都已对真实安装的 `@earendil-works/pi-coding-agent` 0.85.1 手工核验过（命令与实测输出见下方 B08）：`--mode rpc` 帧格式、`agent_end` 的 stopReason 位置、`models.json` + `PI_CODING_AGENT_DIR` 是唯一可用的端点/凭据注入通道、`apiKey`/`headers` 的 `$VAR` 解析、`-e` 加载 `.ts` 与编译后的 `.js` 扩展、扩展在 pi 进程内用 MCP SDK 连接 stdio MCP 服务器并 `registerTool`、`tool_call` 钩子把内建 `bash` 调用变成 `extension_ui_request{title:"pnp:shell"}` 并按否定答复阻断。**"probed" 不是 "verified"**：这些都是手工命令行复现，没有一条固化成对真实二进制持续跑的 CI 测试。
- **自动化测试覆盖（Linux/Windows 均可执行）**：帧关联、乱序/损坏帧隔离、settled 语义状态机、取消语义、原生恢复标识、握手失败区分——验证对象是本仓库自带的 JSONL **fixture 进程**（`code/tests/adapters/pi/fixtures/fake-pi-cli.mjs`，经真实 `LocalProcessHost` 启动），不是真实 `pi` 可执行文件；MCP 桥则由本仓库自带的**真实 MCP 服务器 fixture**（`fixtures/fake-mcp-server.mjs`，`McpServer` + `StdioServerTransport`）在进程内驱动真实 MCP SDK 客户端，`pi` 对象是测试替身。这条证据链证明的是"驱动代码 + 公共 `LocalProcessHost`/`JsonlDecoder` + 真实 MCP SDK 按协议正确工作"，不是"已完成真实 Pi 版本验收"。
- **仍未验证（不得据此宣称完成）**：真实内网模型端到端调用；Windows 上对真实 `pi` 进程的 Job Object 生命周期（B08 的复现都是手工前台进程，不经过 `LocalProcessHost`）；Windows 上 `defaultTools` 里 `powershell` 工具的真实执行（探测在 Linux 上做的，`buildPiSettings` 的 win32 分支只有单元测试证据）；`mcp-http` 传输对真实远端 MCP 服务器（自动化测试只覆盖 stdio fixture，HTTP 分支只有构造级证据）；`set_model`/`get_available_models` 在真实版本下的返回结构（本驱动已不再发送 `set_model`，见 B04）。

## 安装与连接（B01）

不猜测 npm 全局安装后的 shim 路径（`LocalProcessHost` 要求 Windows 上必须是可直接 `CreateProcess` 的 `.exe`，不能是 `.cmd`/`.ps1` shim）。改为要求运维方显式声明其中一种：

| 环境变量 | 含义 |
|---|---|
| `PNP_PI_EXECUTABLE` | 绝对路径，指向一个可直接执行的 `pi`（例如 pkg 打包后的单文件 exe） |
| `PNP_PI_NODE` + `PNP_PI_ENTRY` | 绝对路径的 Node 可执行文件 + `pi-coding-agent` CLI 入口 `.js`；`PNP_PI_NODE` 缺省为当前 `process.execPath` |
| `PNP_PI_EXTRA_ARGS` | 可选，JSON 字符串数组，原样追加到启动参数末尾 |
| `PNP_PI_APPROVE` | 可选，`always` 时传 `--approve`，否则始终 `--no-approve`（非交互模式默认不弹项目信任提示） |

未设置以上任一组合时，`resolvePiLaunchConfig()` 显式抛 `ENGINE_UNAVAILABLE`（503），不猜路径、不静默回退；`PNP_PI_EXTRA_ARGS`/路径格式一类的运维配置错误抛 `ENGINE_CONFIGURATION_ERROR`，状态码为 **503**（调用方改请求也修不了，与 `MODEL_ENVIRONMENT_MISSING` 同类，第三轮评审 §16 E2）。

`code/config/engines/pi.json` 现在锁在 `engineVersion: "0.85.1"` 并声明 `distribution: {kind:"npm-node-entry", packageNameCandidates:["@earendil-works/pi-coding-agent"], entry:"dist/bundle/cli.js"}`。这只是**元数据声明**：按该声明把包装进 `runtime/bootstrap/engines/pi/0.85.1` 并导出 `PNP_PI_ENTRY`/`PNP_PI_NODE` 的启动器改动属于另一个工作包，本包不实现、也不宣称已实现。实测依据：本环境里 `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.85.1` 之后，`node <包根>/dist/bundle/cli.js --version` 打印 `0.85.1`。

启动固定附带 `--mode rpc --session <nativeDataDirectory>/session.jsonl --session-dir <nativeDataDirectory>`（会话独立目录，对应 B03）、`--provider/--model`（来自本轮 `IntegrationContext.model.selection`）、`-e <扩展绝对路径>`（B05）以及在本轮有 instruction 资产时的 `--append-system-prompt <正文>`（B04）。`ownerToken` 用 `randomUUID()` 生成：Gateway Session id 对外公开（出现在每个客户端 URL 里），归属记录的持有凭证不能从它推出来（§16 E3）。

进程环境（`LaunchSpec.env`，在 `open()` 时一次性固定）在公共 `baseEnvironment()` 允许名单之外只额外携带：`PI_TELEMETRY=0`、`PI_CODING_AGENT_DIR`（本会话私有配置根）、`PNP_PI_BRIDGE_FILE`（有 MCP 服务器时）、`PNP_PI_MODEL_*`/`PNP_PI_TOOL*`（B04/B05 的生成变量）、`NODE_EXTRA_CA_CERTS`（来自 `ResolvedModel.caFile`）、`NODE_TLS_REJECT_UNAUTHORIZED=0`（**仅当** `ResolvedModel.tlsInsecure` 为真），以及网关自身设置了的 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`（含小写形式）——内网部署要靠同一个代理才能到达模型端点和 HTTP MCP 服务器，而允许名单本身不带这三个变量。

进程始终经 `input.host.start(spec, signal, input.resources)` 启动；LF 分帧和 UTF-8 分片由公共 `runtime/process-host.ts` 内的 `JsonlDecoder` 完成，`code/src/drivers/pi-rpc/client.ts` 只做 JSON 解析与按 `id` 的请求/响应关联（`code/tests/adapters/pi/client.test.ts` 覆盖乱序、损坏帧隔离、进程退出拒绝挂起请求）。

**握手**：`open()` 里发一次 `get_state`。两种失败必须区分（§16 E4）：进程在握手期间已经退出（入口路径错、参数不受支持）→ 抛 `ENGINE_HANDSHAKE_FAILED`（502，带 `code=`/`signal=`；`HostedProcess` 只暴露帧和退出，没有 stderr 流，进程自身的启动输出在 `LocalProcessHost` 自己的脱敏诊断里）；进程还活着而 `get_state` 只是不受支持或失败 → 容忍，`engineVersion` 保持 `"unknown"`。`native.protocolVersion` 从"~0.84.x, unverified"改为 `pi-rpc (@earendil-works/pi-coding-agent 0.85.1, probed)`。**实测注意**：真实 0.85.1 的 `get_state` 回包里根本没有版本字段（只有当前 model 描述、thinkingLevel、sessionId、计数器等），所以 `engineVersion` 在真机上仍然是 `"unknown"`——代码里保留读取逻辑是因为那是版本唯一可能出现的位置，但绝不拿"配置里写的包版本"冒充"实际在跑的版本"。

## 接受与 settled 语义（B02）

`prompt` 命令的 `{"type":"response","success":true}` 只是接受证据，`channel.run()` 不会据此返回。真正的完成信号只有两个：`agent_settled` 事件，或者进程退出（后者以 `ENGINE_UNAVAILABLE` 失败）。**`agent_end` 之后的 2 秒兜底计时器已删除**（§16 F）：它到点就把本轮结算成 `completed`，而 `agent_settled` 只是晚到时，那条晚到的事件会落到**下一轮** run 上（`dispatch` 只看当前 `active`），把下一轮以空文本提前结算成"完成"——这正是仓库红线里的伪造成功。真实 0.85.1 每轮都会发 `agent_settled`（B08 实测）；万一某个版本不发，本轮就一直等到进程退出或 `GatewayCore` 自己的运行期限到期，那是如实的超时，不是编造的成功。`agent_end` 只用来记录 stopReason；`agent_end{willRetry:true}`（compaction/retry 中）同样不触发结算。`EngineResult.finish` 按 `stopReason` 映射到 `stop/length/content-filter/cancelled/error/unknown`；只有 `finish==="stop"` 才返回 `state:"completed"`，其余交给 `GatewayCore` 按契约转成失败态，`nativeStopReason` 始终保留真实原因供审计。

## 会话与取消（B03）

`nativeId`/`resumeToken` 固定为该 Session 的 `session.jsonl` 绝对路径：同一 Gateway Session 复用同一原生会话目录即视为恢复，不同 Session 天然隔离（B03 的“独立原生会话目录”）。`cancel()` 只发送 `abort` 命令并标记本轮 `cancelling`；真正的停止证据来自随后到达的 `agent_settled`/`agent_end`，或者在 `GatewayCore` 的取消宽限期用尽后由它直接调用 `terminate()`（走公共 `HostedProcess.terminate()`，不在适配器里自行 kill）。`close()` 与 `terminate()` 目前共享同一路径：pi 每轮已经把内容落到自己的 JSONL 文件，没有需要额外 flush 的步骤。

## 模型、工具与资产（B04/B05）

### 模型：`models.json` 里没有任何取值

`ResolvedModel` 被投影成一个 pi 自定义 provider，写进本 Session 私有的 `models.json`（`<nativeDataDirectory>/pi-agent/models.json`），`PI_CODING_AGENT_DIR` 指向同一目录（pi 把这个环境变量当整个配置根的**整体替换**，不是叠加层，因此与运维方真实的 `~/.pi/agent` 及其他并发 Session 完全隔离）。

文件里**一个已解析取值都没有**（第三轮评审 §16 B、`docs/spec/contracts.md`"已解析的取值不落盘"）：

- `Authorization: Bearer <值>`（**头名大小写不敏感**）→ 文件写 `apiKey: "$PNP_PI_MODEL_API_KEY"`；
- 其余每个头 `<原头名>` → 文件写 `headers: {"<原头名>": "$PNP_PI_MODEL_HEADER_<n>"}`，`<n>` 按出现顺序从 1 递增；
- 非 Bearer 的 `Authorization`（例如 `Basic`）不拆成 apiKey，按普通头投影，`apiKey` 用非机密占位串 `pnp-unused`（pi 在 provider 完全没有 auth 时会把该 provider 的模型标记为不可用）；
- 真值只进 `LaunchSpec.env` 的同名变量。

`$NAME` 是 pi 文档化的环境插值（上游 `docs/models.md` "Value Resolution"/"Custom Headers"），B08 已在真机上实测通过。同一节也说明了为什么就算没有落盘规则也不能写原文：以 `!` 开头的取值会被当 shell 命令执行，含 `$` 的取值会被插值——原文凭据可能被改写，极端情况下被执行。

**这条修的是一个真 bug**：旧代码只读 `model.headers.authorization`（小写），而交付的 `config/settings.json` 产出的是 `Authorization`，于是交付配置下 pi 拿不到任何凭据、以未鉴权方式调用模型端点（`docs/competition-readiness.md` A9）。回归测试见 `code/tests/adapters/pi/launch.test.ts` 第一条。

协议映射：`openai-chat` → pi 的 `openai-completions`；`anthropic-messages` → pi 的 `anthropic-messages`；`custom`/`test` 没有已知的 pi 传输格式，**不写任何 provider 条目**（声明的已知限制，不是猜一个映射）。`ResolvedModel.caFile` → 进程环境的 `NODE_EXTRA_CA_CERTS`；`ResolvedModel.tlsInsecure`（本包为此在 `contracts/index.ts` 上追加的可选字段）→ `NODE_TLS_REJECT_UNAUTHORIZED=0`，仅在显式为真时设置。

**模型不能中途换**：`LaunchSpec.env` 在 `open()` 时固定，`models.json` 里的 `$NAME` 指向的就是那一份环境，所以 `set_model` 无法让一个"环境里没有它的变量"的 provider 真正工作。因此 `open()` 时对模型绑定算一个 SHA-256 指纹（provider/model 选择、protocol、endpoint、caFile、tlsInsecure，以及**小写归一后排序的头名与头值**），后续任一轮不一致 → 409 `ENGINE_BINDINGS_CHANGED`（与 ACP 驱动同码；此前新造的 `ENGINE_TOOLS_IMMUTABLE` 已删除）。**本驱动因此不再发送 `set_model` 命令**——保留一条永远走不到的换模型代码路径，比诚实地拒绝更糟。会话里只保留摘要，用于比较的规范化字符串（含取值）从不留存、不记录。

### 工具：MCP 客户端桥 + 只有变量名的 sidecar

`ToolBinding` 的两种 MCP 传输现在都受支持，由 pi 进程内的桥扩展（下一节）接管；`cli`/`native` 命令绑定**不再受支持**，被收集为不含 URL、命令、请求头或环境变量值的 `{id, transport, reason}`，在首次 `run()`、发送任何 prompt 之前通过已等待的原生事件 `pi/tools.unsupported-transport` 报告（报告失败会阻止 prompt，不会把缺少的工具静默当成可用）。这与之前正好相反，因为交付的 `settings.json` 只产 `mcp-stdio`/`mcp-http`，旧桥一个也接不了（`docs/competition-readiness.md` B3）。

sidecar `<nativeDataDirectory>/pnp-tools.json`（mode 0600，路径经 `PNP_PI_BRIDGE_FILE` 传给扩展）每项：

```
mcp-stdio → {id, transport:"stdio", command, args, envNames:{"<原变量名>":"PNP_PI_TOOLENV_<n>"}, sideEffect, timeoutMs}
mcp-http  → {id, transport:"http",  url,           headerNames:{"<原头名>":"PNP_PI_TOOLHDR_<n>"}, sideEffect, timeoutMs}
```

`<n>` 在整个会话内全局递增，所以两个服务器不会共用一个变量名、也就读不到对方的取值。**取值只在 `LaunchSpec.env` 里**，扩展在 pi 进程内从 `process.env` 取回。本会话没有任何 MCP 服务器时不写 sidecar、也不设 `PNP_PI_BRIDGE_FILE`。0600 在 Windows 上被 Node 忽略、只剩目录 ACL 保护——这正是文件里不放真值的又一个理由（§16 B）。

`run()` 对**全部**绑定（包括被丢弃的 `cli`/`native`）计算递归规范化、传输感知的 SHA-256 指纹；指纹覆盖 id/transport/sideEffect/timeoutMs/inputSchema，以及命令、参数顺序、环境变量键值，或 HTTP URL、请求头键值。任何工具、超时、传输或凭据轮换都在发 prompt 之前以 409 `ENGINE_BINDINGS_CHANGED` 拒绝。会话状态只保留摘要，不保留计算用的凭据材料。

### 指令资产

本轮 `IntegrationContext.assets` 里 `kind:"instruction"` 的条目在 `open()` 时按顺序读出，用空行拼成一段正文，作为**一个 argv 元素**跟在 `--append-system-prompt` 后面（上游 README：`--append-system-prompt <text>`，"Append text or file contents to the system prompt"，可重复）。用一个拼好的正文而不是每个文件一个 flag，是为了顺序显式，并且避免正文恰好长得像路径时被 pi 当成文件参数再读一次。没有 instruction 资产就完全不加这个 flag，绝不加一个空的。`skill`/`native-extension` 资产本包不投影（不虚报）。

### Windows shell：会话私有 `settings.json`

pi 在 Windows 上默认用 Git Bash 跑 `bash`（上游 `docs/windows.md`："Checked locations (in order): 自定义路径 → `C:\Program Files\Git\bin\bash.exe` → PATH 上的 `bash.exe`"）；沙箱两者都没有时每次 `bash` 都失败，模型等于没有 shell。同一份文档给的解法就是用 `defaultTools` 换上可选的 `powershell` 工具（它走 `pwsh.exe`，没有则走 Windows PowerShell）。

`writePiSettings` 在 `PI_CODING_AGENT_DIR` 里写本会话私有的 `settings.json`：

- **win32**：`defaultTools: ["read","powershell","edit","write","grep","find","ls"]`，仅当探测到可用的 `bash.exe`（`C:\Program Files\Git\bin\bash.exe`、`C:\Program Files\Git\usr\bin\bash.exe`、或 PATH 上的 `bash.exe`）时再追加 `"bash"`，这样装了 Git Bash 的机器两个都留着；
- **其他平台**：写空对象，完全不钉 `defaultTools`，用 pi 自己的默认值。

探测是纯文件系统判断并且可注入（适配器不得在 `ProcessHost` 之外启动任何进程），两种结果都有单元测试。**未验证**：`powershell` 工具在真实 Windows 上的实际执行（本次探测在 Linux 上做）。

## 原生扩展桥（B05）

`code/src/drivers/pi-rpc/extension/pnp-bridge.ts` 是一个**真实模块**，由常规 `tsc` 构建产出 `dist/drivers/pi-rpc/extension/pnp-bridge.js`；驱动用自己的 `import.meta.url` 推导要传给 `-e` 的绝对路径（同目录布局在 `src/` 与 `dist/` 两棵树里一致，后缀取自本模块自身被加载时的后缀），因此在 Node strip-only 直接跑 `src/` 和跑 `dist/` 两种方式下都指得对。这替换了旧的"生成扩展源码文本"方案，连带删掉了旧文件里把 `"node:" + "child_process"` 拆成两段以绕过 `scripts/check-boundaries.mjs` 文本扫描的写法（§16 E1）——扩展现在完全不需要 `child_process`，MCP SDK 的 stdio 传输在 pi 自己的进程树里负责起子进程。

扩展在 pi 进程内做两件事：

1. **MCP 客户端桥**：读 sidecar → 对每个服务器用 MCP SDK 建连（stdio 用 `StdioClientTransport`，环境为"pi 进程环境 + 按 `envNames` 从 `process.env` 解析出的取值"覆盖；http 用 `StreamableHTTPClientTransport`，请求头按 `headerNames` 解析）→ `listTools()` → 对每个远端工具 `pi.registerTool`。`description` 取服务器给的描述，`parameters` 取该工具的 JSON Schema（`inputSchema`），缺失时用 `{type:"object"}`。`execute` 转发到 `client.callTool`，把 `content` 里的 text 部分按顺序拼回返回值（非 text 部分只如实标注类型，不丢也不编）；**`isError` 用抛异常来忠实传递**——上游 `docs/extensions.md` 明确写着"Returning a value never sets the error flag"，只有 `execute` 抛错才会把 tool result 标记为失败，返回一个成功形状的结果就正好是仓库禁止的伪造成功。某个服务器连不上只报告一次（默认 `console.error`；RPC 模式下 stdout 是协议通道，而且实测 0.85.1 在扩展加载期不允许调用 action 类方法，所以拿不到 `ctx.ui.notify`），其余服务器照常工作，扩展照常加载，绝不把整个 pi 启动带崩。
2. **`tool_call` 策略钩子**（§16 A）：pi 自己没有权限系统，旧实现只对网关注入的工具做一次泛化 confirm，`bash`/`write`/`edit` 无条件执行——同一份 `write: ask` 在 OpenCode 下会产生一次权限请求，在 Pi 下会静默执行。现在钩子把工具名映射到网关的操作类：`bash`/`powershell`→`shell`，`write`/`edit`→`write`，`read`/`grep`/`find`/`ls`→`read`，桥接的 MCP 工具→其服务器 `sideEffect`（`read`→`read`、`write`→`write`、`external`→`external`），其余用工具名本身（"未知"意味着"不算 read"，绝不意味着"放行"）。操作类是 `read` 的直接静默放行；其余一律 `ctx.ui.confirm("pnp:<操作类>", JSON.stringify({tool, operation, patterns}))`，`patterns` 取自工具入参的 `path`/`file_path`/`command` 以及"看起来像路径"的字符串字段（最多 16 条、每条截断到 512 字符，保证一帧不会过大）。`ctx.hasUI` 为假（`-p`/`json` 模式）→ 直接阻断并给出原因；confirm 返回 `false` → `{block:true, reason:"denied by PNP policy"}`；confirm 本身抛错也阻断——一个答不了的策略通道绝不能读成批准。

**判定留在网关**：`channel.ts#bridgeInteraction` 看到 `title` 以 `pnp:` 开头时，从标题解析出 `operation`、从 message JSON 解析出 `patterns`/`tool`，走 `services.interact({kind:"permission", operation, payload:{patterns, tool}})`，于是 `allow` 自动放行、`deny` 自动拒绝、`ask` 才产生客户端 `permission` 请求，再用 `extension_ui_response` 把结果回给 pi。其他标题的 confirm 保持原来的泛化行为（`operation: "pi.extension.confirm"`）。

**工具名规则**：桥接名是 `<serverId>.<toolName>`，把 `A-Za-z0-9_-` 之外的**每一个**字符（包括那个连接用的 `.`）替换成 `_`，去掉开头的 `_`，截断到 64 字符，重名时加 `_2`/`_3` 后缀。实测 0.85.1 的 `pi.registerTool` **自己不做任何校验**（`office.docx_extract`、`a.b`、甚至 `bad name` 都照收），所以这条规则的约束来自再往外一层：注册后的工具名会成为模型请求里的 function/tool 名，本网关面向的两种 wire format 都把它限制在 `[A-Za-z0-9_-]{1,64}`。


## 事件与交互（B06）

`tool_execution_start/update/end` 按 `toolCallId` 收敛为 `tool.started/updated/finished`；`message_update.assistantMessageEvent.text_delta` 映射为 `text.delta`；其余事件（`queue_update`/`compaction_*`/`auto_retry_*`/`session_compact_failed`/`extension_error`/`bash_execution_update`，以及任何未在 `protocol.ts` 里枚举的未来事件类型）统一降级为 `DriverEvent.native`（`namespace:"pi"`）而不是丢弃或报错，保证协议向前兼容且不伪造缺失的语义。

`extension_ui_request` 分两条路（上游 `docs/rpc.md` "Extension UI Protocol"；RPC 模式下 `ctx.hasUI` 为 `true`，dialog 类方法会阻塞等 `extension_ui_response`，带 `timeout` 时 agent 侧会自行超时兜底）：

- `method:"confirm"` 且 `title` 以 `pnp:` 开头 → 这是本仓库自己的策略钩子（B05）。从标题取 `operation`、从 message JSON 取 `patterns`/`tool`，发 `services.interact({kind:"permission", operation, payload:{patterns, tool}})`，把决定 `allow` 与否写回 `extension_ui_response{confirmed}`。message 解析失败不影响授权：真正决定的是标题里的操作类，`patterns` 退化为空数组。
- 其他 `confirm` → 保持泛化行为（`operation: "pi.extension.confirm"`，payload 带原 `title`/`message`）；`select`/`input`/`editor` → `kind:"question"`。

本轮没有已提交的 prompt 时，任何 `extension_ui_request` 一律以 `{confirmed:false, cancelled:true}` 回复：没有可归属的 run 就没有可用的授权上下文，失败关闭而不是放行。

## 发现并修复的公共基线缺陷（不属于 Pi 专属范围，透明记录）

验证 `engine-contract.test.ts` 时，在真实 Windows 10 环境下发现 `code/src/runtime/process-host.ts` 的
`baseEnvironment()` 允许名单缺少 `PSExecutionPolicyPreference`：当 `LocalProcessHost` 在 win32 上启动
`native/windows/job-host.ps1` 时会用这份被过滤过的环境变量启动 PowerShell 宿主，如果目标机器的“允许执行脚本”
只靠会话级 `PSExecutionPolicyPreference`（而不是机器/用户级注册表策略）生效——本沙箱环境正是如此——被过滤后的
PowerShell 会直接以 `UnauthorizedAccess` 拒绝执行 `job-host.ps1`，导致 `LocalProcessHost.start()` 在
**任何引擎**（不止 Pi）的 Windows 真实进程路径上都会失败并残留孤儿进程（PowerShell 宿主 + 已启动的子进程都不会被
清理）。这不是 B 自己目录里的问题，无法从 `src/engines/**`/`src/drivers/**` 内部绕过，已作为一次独立、最小化的
共享基线改动直接修复（`code/src/runtime/process-host.ts` 的允许名单新增一个环境变量名，改动前后均已跑通公共
36 个 unit 测试，无回归）。**这条改动影响 A（ACP/OpenCode/Hermes）和 C（内网）在 Windows 上的真实进程验收，
建立真实分支/PR 协作后应由 A 与 C 各自复核一遍**，不要把它当作 Pi 专属实现细节忽略掉。

补充（第三轮评审 §16 D 的裁决）：`LocalProcessHost.helper()` 启动宿主时本来就带 `-ExecutionPolicy Bypass`，
而这个开关设置的正是进程作用域策略（PowerShell 内部就是用 `PSExecutionPolicyPreference` 承载它），它压过
LocalMachine/CurrentUser 注册表作用域。因此上面那段"此前任何引擎的 Windows 真实进程都会失败"的因果陈述**尚未
经由 `LocalProcessHost.start` 本身复现**，只是在某一沙箱上观察到的现象，机制未确认；把该变量放进允许名单不承载
任何机密、无害，予以保留，但这里的措辞按"观察到、机制未确认"理解，不要当成已确认的公共缺陷结论。

## 真实 Pi 二进制手工核验记录（B08，新增）

之前所有 `--mode rpc` 字段假设都标注为"声明证据"，因为只对照了 `docs/research/T02-pi-harness.md`（二手调研），没有真实二进制核验。本次在这台开发环境里补上了这一步：

**安装**：`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`，得到真实版本 `0.85.1`（`pi --version`）。Windows 上的全局安装只落一个 `pi.cmd` shim；真实入口是 `%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js`（`node cli.js ...` 直接可跑），印证了 `docs/engines/pi.md`（B01）此前"不猜 shim 路径，要求显式声明 `PNP_PI_NODE`/`PNP_PI_ENTRY`"的判断是对的。

**核验方式**：用 `node.exe cli.js --mode rpc --no-session --session-dir <tmp>` 直接起真实 pi 进程，手工写 RPC 帧到 stdin、读 stdout，不经过网关。先发 `get_state`，确认 `response` 帧结构与 `protocol.ts` 一致。再接一个本地零依赖 OpenAI Chat Completions 模拟服务器（复用 A 已有的 `code/scripts/e2e/mock-model-server.mjs`）跑一次完整 `prompt`→`agent_settled`，拿到真实的事件序列。

**发现并已修复的两个真实缺陷**：

1. **`agent_end` 的 stopReason 字段位置错了，导致每次真实运行都被误报为成功。** 真实事件是 `{"type":"agent_end","willRetry":false,"messages":[...,{"role":"assistant","stopReason":"stop"|"error"|...}]}`——从来没有顶层 `stopReason` 字段。旧代码读 `event.stopReason`（永远是 `undefined`），`mapFinish(undefined)` 的默认分支又恰好返回 `"stop"`，于是**包括真实上游报错在内的每一次运行都会被上报为 `finish:"stop"`（成功）**。这正是仓库规则明确禁止的"伪造成功"类问题，只是当时没有真实二进制可测出来。已修复为从 `messages` 数组最后一条的 `stopReason` 取值（`protocol.ts`/`channel.ts`），并补了回归测试（`channel.test.ts`、`protocol.test.ts`）。
2. **`OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` 对内网自定义 endpoint 完全不生效。** 实测：给真实 pi 进程设置 `OPENAI_BASE_URL=http://127.0.0.1:<mock port>/v1` 并选 `--provider openai`，pi 直接打到了真实 `api.openai.com`（返回真实 401），mock 服务器完全没收到请求。查阅 `packages/coding-agent/docs/providers.md`/`models.md` 一手文档确认：pi 只在 Azure OpenAI 这一个特例上支持 `*_BASE_URL` 环境变量覆盖；通用的自定义 provider/端点必须写进 `~/.pi/agent/models.json`，并且这个目录可以用 `PI_CODING_AGENT_DIR` 整体重定向（不是叠加层，指哪个目录就完全用哪个目录，验证细节见 `packages/coding-agent/docs/environment-variables.md`）。改用这个机制后，同一个 mock 服务器真实收到了请求并流式返回了文本（`message_update`/`text_delta` 一路到 `agent_settled`）。旧的环境变量方案已删除，改为 `launch.ts#writePiModelsConfig` + `PI_CODING_AGENT_DIR`（见上文"模型"小节）。

**复现命令**（不含真实凭据，供后续复核）：

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
node "$env:APPDATA\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js" `
  --mode rpc --no-session --session-dir <tmp> --provider <providerId> --model <modelId>
# stdin: {"id":"1","type":"get_state"}
# 若要跑通真实 prompt，先起 code/scripts/e2e/mock-model-server.mjs，
# 再在 PI_CODING_AGENT_DIR 指向的目录写 models.json 声明该 provider（见 launch.ts#writePiModelsConfig）。
```

### 第二批探测（本工作包新增，Linux，`node v22`，pi 0.85.1）

安装：`npm install -g @earendil-works/pi-coding-agent@0.85.1 --ignore-scripts`；入口 `$(npm root -g)/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，`node <entry> --version` → `0.85.1`。以下每条都是实际跑出来的结果。

1. **`get_state` 回包里没有版本字段。** `node <entry> --mode rpc --no-session --session-dir <tmp>`，stdin 发 `{"id":"1","type":"get_state"}`，回包 `data` 里是当前 model 描述（id/name/api/provider/baseUrl/contextWindow/...）、`thinkingLevel`、`isStreaming`、`isCompacting`、`steeringMode`、`followUpMode`、`sessionId`、`autoCompactionEnabled`、`messageCount`、`pendingMessageCount`——**没有任何版本字段**。所以 `native.engineVersion` 在真机上仍是 `"unknown"`；`readEngineVersion()` 保留读取逻辑，但不拿配置里的包版本冒充实际在跑的版本。

2. **`models.json` 的 `$VAR` 解析与自定义头（B04 的核心依据）。** 在 `PI_CODING_AGENT_DIR` 指向的临时目录里写：

   ```json
   { "providers": { "pnp-probe": { "api": "openai-completions",
       "apiKey": "$PNP_PI_MODEL_API_KEY",
       "baseUrl": "http://127.0.0.1:<port>/v1",
       "headers": { "appid": "$PNP_PI_MODEL_HEADER_1", "X-Extra": "$PNP_PI_MODEL_HEADER_2" },
       "models": [ { "id": "probe-model" } ] } } }
   ```

   再用 `PNP_PI_MODEL_API_KEY` / `PNP_PI_MODEL_HEADER_1` / `PNP_PI_MODEL_HEADER_2` 三个环境变量起进程：
   `node <entry> --provider pnp-probe --model probe-model --print --no-tools "say hi"`。
   本地 HTTP 端点实际收到 `POST /v1/chat/completions`，请求头为
   `authorization: Bearer <PNP_PI_MODEL_API_KEY 的值>`、`appid: <HEADER_1 的值>`、`x-extra: <HEADER_2 的值>`。
   **文件里一个取值都没有，取值全部来自进程环境**——这正是本包 `models.json` 的形状。

3. **`--append-system-prompt`**：`node <entry> --help` 输出 `--append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)`，与 B04 把多份 instruction 拼成一个 argv 元素的用法一致。`--provider <name>` 同样存在并且会校验（`--provider foo` → `Error: Unknown provider "foo"`）。

4. **扩展加载（`.ts` 与 `.js` 两种）+ MCP 桥注册。** 用 `-e <path>` 加载本仓库的 `src/drivers/pi-rpc/extension/pnp-bridge.ts`，并设 `PNP_PI_BRIDGE_FILE` 指向一份 sidecar（一个 stdio MCP 服务器，命令是 `node <本仓库 tests/adapters/pi/fixtures/fake-mcp-server.mjs>`），另加一个只打印 `pi.getAllTools()` 的探针扩展。实测工具列表：
   `["read","bash","powershell","edit","write","grep","find","ls","office_read_file","office_write_file","office_always_fails"]`。
   把 `-e` 换成 `tsc` 产出的 `dist/drivers/pi-rpc/extension/pnp-bridge.js`，结果完全相同。这同时证明了：pi 的 jiti 加载器吃 `.ts` 与 `.js`；MCP SDK 客户端能在 pi 进程内起 stdio MCP 服务器；`<serverId>.<toolName>` 的净化规则产出的名字被 pi 接受。
   另外实测：`pi.registerTool` **对名字不做任何校验**（`office.docx_extract`、`a.b`、`bad name` 全部 `REGISTERED_OK`），而扩展加载期调用 action 类方法（例如 `pi.getActiveTools()`）会报 `Extension runtime not initialized. Action methods cannot be called during extension loading.`——所以连接失败只能走 `console.error`，拿不到 `ctx.ui.notify`。

5. **`tool_call` 钩子 → `extension_ui_request` → 阻断（B05/§16 A 的核心依据）。** `--mode rpc` 起真实 pi，模型侧接一个把第一轮回成 `tool_calls`（`bash`，`{"command":"echo hi"}`）的本地 SSE mock。观察到的事件序列：

   ```
   {"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"echo hi"}}
   {"type":"extension_ui_request","id":"<uuid>","method":"confirm","title":"pnp:shell",
    "message":"{\"tool\":\"bash\",\"operation\":\"shell\",\"patterns\":[\"echo hi\"]}"}
   -> stdin: {"type":"extension_ui_response","id":"<uuid>","confirmed":false}
   {"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash",
    "result":{"content":[{"type":"text","text":"denied by PNP policy"}]},"isError":true}
   ... {"type":"agent_end",...} {"type":"agent_settled"}
   ```

   即：pi 的内建 `bash` 确实被钩子拦下来了、标题里的 `pnp:shell` 正是 `channel.ts` 解析的那个形状、否定答复真的把调用阻断成 `isError:true`，而且 `agent_settled` 照常到达（B02 删除兜底计时器的依据）。`extension_ui_response` 的关联字段就是 `id`（与请求的 `id` 相同），与 `client.ts`/`channel.ts#respondUi` 现有实现一致。

**这两批核验证明了什么、没证明什么**：证明了 `--mode rpc` 的帧结构、`models.json`+`PI_CODING_AGENT_DIR`+`$VAR` 机制、扩展加载与 MCP 桥、`tool_call` 策略钩子的完整往返，在真实 0.85.1 二进制上确实按预期工作。**没有**证明：内网真实模型端到端可用（mock 服务器不是真实模型）、`mcp-http` 对真实远端服务器、Windows 上对真实 pi 进程的 Job Object 生命周期（两批复现都是手工前台进程，不经过 `LocalProcessHost`）、`powershell` 工具在真实 Windows 上的执行。这些仍然是"未验证"，见上文。全部核验都是手工命令行操作，未固化为仓库里自动跑真实二进制的 CI 测试（自动化测试仍然只用 fixture 进程 + fixture MCP 服务器，因为 CI 环境不保证有 `npm install -g` 权限/网络）。

## 验收（B07）

本工作包在 Linux、Node v22（项目目标为 24，本环境无 24；差异只影响运行时版本门槛，不影响被测语义）上执行：
`npm run typecheck`、`npm test`（386 项，382 通过 / 0 失败 / 4 跳过——跳过的是 win32 专属用例）、`npm run test:contract`（6 项全过）、`npm run check:boundaries`（PASS）、`npm run check:strip-only`（PASS）、`npm run build`。

- `code/tests/adapters/pi/protocol.test.ts`：帧解析、未知事件降级、损坏帧报错。
- `code/tests/adapters/pi/client.test.ts`：请求关联、乱序响应、损坏帧隔离不中断通道、进程退出拒绝所有挂起请求。
- `code/tests/adapters/pi/channel.test.ts`（22 项）：ACK 早回不等于完成、取消 ACK 不等于停止证据、工具终态收敛、原生恢复、凭据不进事件/异常文本/`native`、进程异常退出转为可诊断错误；**新增**：`agent_end` 之后等满 2.5 秒仍不结算（删掉兜底计时器的回归）、握手期间进程退出 → `ENGINE_HANDSHAKE_FAILED`(502) 且带 `code=`/`signal=`、活着的进程上 `get_state` 失败被容忍、`get_state` 带版本时填 `native.engineVersion`、`pnp:` 标题解析成按操作类的 `permission` 请求而其他标题保持泛化、工具集与模型绑定变化都以 409 `ENGINE_BINDINGS_CHANGED` 拒绝。
- `code/tests/adapters/pi/launch.test.ts`（10 项，重写）：大写 `Authorization` 的回归、`models.json` 只含 `$` 变量名而取值只在 env、非 Bearer 的 `Authorization` 不被拆成 apiKey、协议映射与不可映射协议不写文件、模型指纹对每个字段敏感且对头名大小写/顺序不敏感、win32 `defaultTools` 两种结果、会话私有 `settings.json` 落在 `PI_CODING_AGENT_DIR`、instruction 资产拼成一个 `--append-system-prompt` 参数（无资产则完全不加）、`LaunchSpec.env` 的 CA/TLS/代理变量、扩展路径在 `src`/`dist` 两棵树里的解析。
- `code/tests/adapters/pi/tool-bridge.test.ts`（4 项，重写）：两种 MCP 传输都被投影、`cli`/`native` 被丢弃并给出理由、sidecar 只含变量名且不含任何取值、变量名跨服务器唯一。
- `code/tests/adapters/pi/bridge-extension.test.ts`（9 项，新增）：用**真实 MCP 服务器 fixture**（`McpServer` + `StdioServerTransport`）在进程内驱动扩展——注册名与描述/schema、成功 `callTool` 的 text 拼接、`sideEffect` 环境变量确实到达服务器进程、`isError` 变成抛错、连不上的服务器只报告一次且不影响加载、没有 sidecar 也照样装钩子、钩子对 read/write/`hasUI:false`/confirm 抛错的四种决定、patterns 提取、工具名净化。
- `code/tests/adapters/pi/engine-contract.test.ts`：接入公共 `tests/kit/engine-contract.ts`，通过真实 `LocalProcessHost` + `fake-pi-cli.mjs` fixture 跑通 open→run→再次 run→delete 全流程（本次改动后仍然通过）。

未执行（诚实标记，不得据此认定"已完成"）：Windows 上的任何一项（本次全部在 Linux 上跑，`buildPiSettings` 的 win32 分支只有单元测试证据，`engine-contract` 的真实 PowerShell Job Object 路径本次没有被执行）、真实内网模型调用、真实远端 `mcp-http` 服务器、对真实 `pi` 二进制的自动化 CI 测试、`npm run release:check` 与清单刷新（本工作包按分工不执行）。
