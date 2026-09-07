# Pi 接入规格

所有者 B。入口 `code/src/engines/pi/pack.ts`，通道 `rpc`，公共契约 1.0.0。驱动实现在 `code/src/drivers/pi-rpc/`：`protocol.ts`（帧解析/编码）、`client.ts`（请求关联）、`launch.ts`（可信配置→LaunchSpec）、`tool-bridge.ts`（原生扩展生成）、`channel.ts`（`EngineSessionChannel` 实现）。

## 实现状态（诚实声明，对应 `verification/coverage.md` 的分层）

- **已有源码**：上述五个文件 + `engines/pi/pack.ts`；`descriptor.implementationProvided = true` 仅表示代码存在。
- **`capabilityEvidence: "declared"`**（`code/config/engines/pi.json`）：字段名和事件流来自 `docs/research/T02-pi-harness.md`（对 `earendil-works/pi` ~0.84.x 源码/文档的二手调研，非本仓库自带的一手协议文件），尚未对照真实安装的 `pi` 二进制核验，`engineVersion` 保持 `null`。
- **已验证（Linux/Windows 均可执行，本次在 Windows 10 沙箱内实际跑过）**：帧关联、乱序/损坏帧隔离、settled 语义状态机、取消语义、原生恢复标识——但验证对象是本仓库自带的 JSONL **fixture 进程**（`code/tests/adapters/pi/fixtures/fake-pi-cli.mjs`），不是真实 `pi` 可执行文件。这条证据链证明的是"驱动代码 + 公共 `LocalProcessHost`/`JsonlDecoder` 按文档协议正确工作"，不是"已完成真实 Pi 版本验收"。
- **未验证**：真实 `pi` 安装、真实模型调用、Windows 上对真实 `pi` 进程的 Job Object 生命周期、至少一项原生扩展在真实环境里的执行证据、`get_state`/`set_model` 等命令在真实版本下的准确返回结构。

## 安装与连接（B01）

不猜测 npm 全局安装后的 shim 路径（`LocalProcessHost` 要求 Windows 上必须是可直接 `CreateProcess` 的 `.exe`，不能是 `.cmd`/`.ps1` shim）。改为要求运维方显式声明其中一种：

| 环境变量 | 含义 |
|---|---|
| `PNP_PI_EXECUTABLE` | 绝对路径，指向一个可直接执行的 `pi`（例如 pkg 打包后的单文件 exe） |
| `PNP_PI_NODE` + `PNP_PI_ENTRY` | 绝对路径的 Node 可执行文件 + `pi-coding-agent` CLI 入口 `.js`；`PNP_PI_NODE` 缺省为当前 `process.execPath` |
| `PNP_PI_EXTRA_ARGS` | 可选，JSON 字符串数组，原样追加到启动参数末尾 |
| `PNP_PI_APPROVE` | 可选，`always` 时传 `--approve`，否则始终 `--no-approve`（非交互模式默认不弹项目信任提示） |

未设置以上任一组合时，`resolvePiLaunchConfig()` 显式抛 `ENGINE_UNAVAILABLE`，不猜路径、不静默回退。启动固定附带 `--mode rpc --session <nativeDataDirectory>/session.jsonl --session-dir <nativeDataDirectory>`（会话独立目录，对应 B03）与 `--provider/--model`（来自本轮 `IntegrationContext.model.selection`）。进程始终经 `input.host.start(spec, signal, input.resources)` 启动；LF 分帧和 UTF-8 分片由公共 `runtime/process-host.ts` 内的 `JsonlDecoder` 完成，`code/src/drivers/pi-rpc/client.ts` 只做 JSON 解析与按 `id` 的请求/响应关联（`code/tests/adapters/pi/client.test.ts` 覆盖乱序、损坏帧隔离、进程退出拒绝挂起请求）。

## 接受与 settled 语义（B02）

`prompt` 命令的 `{"type":"response","success":true}` 只是接受证据，`channel.run()` 不会据此返回。真正的完成信号是 `agent_settled` 事件；`agent_end{willRetry:false}` 之后设 2 秒兜底计时器，只在 `agent_settled` 确实缺失时才用 `agent_end` 的数据结算（并在代码注释中标注这是防止旧/异版本挂起的兜底，不是把 ACK 当完成）。`agent_end{willRetry:true}`（compaction/retry 中）不触发结算。`EngineResult.finish` 按 `stopReason` 映射到 `stop/length/content-filter/cancelled/error/unknown`；只有 `finish==="stop"` 才返回 `state:"completed"`，其余交给 `GatewayCore` 按契约转成失败态，`nativeStopReason` 始终保留真实原因供审计。

## 会话与取消（B03）

`nativeId`/`resumeToken` 固定为该 Session 的 `session.jsonl` 绝对路径：同一 Gateway Session 复用同一原生会话目录即视为恢复，不同 Session 天然隔离（B03 的“独立原生会话目录”）。`cancel()` 只发送 `abort` 命令并标记本轮 `cancelling`；真正的停止证据来自随后到达的 `agent_settled`/`agent_end`，或者在 `GatewayCore` 的取消宽限期用尽后由它直接调用 `terminate()`（走公共 `HostedProcess.terminate()`，不在适配器里自行 kill）。`close()` 与 `terminate()` 目前共享同一路径：pi 每轮已经把内容落到自己的 JSONL 文件，没有需要额外 flush 的步骤。

## 模型、工具与资产（B04/B05）

- **模型**：每轮比较 `IntegrationContext.model.selection` 与已打开进程当前使用的 provider/model；不同则发 `set_model` 命令（pi 文档承认这是公共能力，运行期可切换）。Bearer header 到 provider 凭据的映射是**声明但未核验**的最佳努力（`launch.ts#buildModelEnv`）：`anthropic-messages` → `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`；`openai-chat` → `OPENAI_API_KEY`/`OPENAI_BASE_URL`；`custom`/`test` 协议目前没有已知的 RPC 侧注入点，需要运维方另外维护 `~/.pi/agent/models.json`。
- **工具**：pi 的 RPC 协议里没有"运行期新增自定义工具"的命令，因此工具绑定只能在 `open()` 时通过 `-e <生成的扩展文件>` 一次性注入（B05）。`run()` 会对本轮 `IntegrationContext.tools` 做指纹比较（id/command/args/env key 集合/sideEffect/inputSchema），不同就直接拒绝执行（`ENGINE_TOOLS_IMMUTABLE`），不会静默套用旧工具或丢历史重开 Session——这正是契约要求的"不支持的修改明确拒绝"。
- **资产**：目前没有额外的资产投影逻辑；`AssetBinding` 的 `instruction`/`skill` 类型可通过运维方在 `PNP_PI_EXTRA_ARGS` 里附加 `--append-system-prompt`/`--skill` 等已文档化的 CLI 参数达成，未来若需要网关直接管理资产文件，需要在 `tool-bridge.ts` 旁新增等价的生成逻辑（尚未实现，不在本次交付范围内虚报）。

## 原生扩展桥（B05）

`code/src/drivers/pi-rpc/tool-bridge.ts` 为每个 `ToolBinding` 生成一个 pi 扩展文件（`registerTool`），执行时用 `child_process.execFile`（**在 pi 自身进程内**，不是本适配器进程发起）以显式 argv 数组调用 `ToolBinding.command/args`，不拼接 shell 字符串。`sideEffect !== "read"` 的工具在有 UI 桥时先 `ctx.ui.confirm(...)`（映射为 RPC `extension_ui_request`，`channel.ts#bridgeInteraction` 转发给公共 `services.interact()` 走组织授权，再用 `extension_ui_response` 回复 pi）；没有 UI 桥（`-p`/`json` 模式，RPC 模式下通常有 UI 桥）时直接拒绝执行，不静默放行。凭据不写进生成的扩展源码文本，而是单独落一个 0600 的 `pnp-tools.json` sidecar，扩展在 pi 进程内读取——复用了 `runtime/process-host.ts` 里对 ownership 记录同样的“最小权限落盘”模式。

需要在真实环境里补的证据：至少一个真实 `ToolBinding`（读/写各一次）在真实 `pi` 进程下跑通并留存 `tool_execution_start/end` + `extension_ui_request` 往返的事件日志。

## 事件与交互（B06）

`tool_execution_start/update/end` 按 `toolCallId` 收敛为 `tool.started/updated/finished`；`message_update.assistantMessageEvent.text_delta` 映射为 `text.delta`；`extension_ui_request` 桥接权限/追问；其余事件（`queue_update`/`compaction_*`/`auto_retry_*`/`session_compact_failed`/`extension_error`/`bash_execution_update`，以及任何未在 `protocol.ts` 里枚举的未来事件类型）统一降级为 `DriverEvent.native`（`namespace:"pi"`）而不是丢弃或报错，保证协议向前兼容且不伪造缺失的语义。

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
建立真实分支/PR 协作后应单独找靖诗/黔总过一遍**，不要把它当作 Pi 专属实现细节忽略掉。

## 验收（B07）

已执行（本仓库、Windows 10、Node v22.22.0）：

- `code/tests/adapters/pi/protocol.test.ts`：帧解析、未知事件降级、损坏帧报错。
- `code/tests/adapters/pi/client.test.ts`：请求关联、乱序响应、损坏帧隔离不中断通道、进程退出拒绝所有挂起请求。
- `code/tests/adapters/pi/channel.test.ts`：ACK 早回不等于完成、取消 ACK 不等于停止证据（需真正 `agent_settled`/进程退出才结算）、工具终态收敛、原生恢复（同目录复用 `nativeId`）、Secret 不进入任何日志/异常文本、子进程异常退出转为可诊断错误而不是伪造成功。
- `code/tests/adapters/pi/engine-contract.test.ts`：接入公共 `tests/kit/engine-contract.ts`，通过真实 `LocalProcessHost`（Windows 走真实 PowerShell Job Object helper）+ `fake-pi-cli.mjs` fixture 跑通 open→run→再次 run→delete 全流程。

未执行（诚实标记，不得据此认定“已完成”）：真实 `pi` 二进制安装与联网模型调用、内网集成、真实原生扩展的端到端执行证据、`get_state`/`set_model`/`extension_ui_response` 等命令在具体锁定版本下的真实响应结构核验。`npm run test:contract`、`npm run check:boundaries`、`npm run typecheck`、`npm run release:check` 需要联网安装依赖（`fastify`/`typebox`/`@agentclientprotocol/sdk`）；本次开发环境无 npm registry 访问，未执行，与 `verification/coverage.md` 记录的公共基线限制一致。
