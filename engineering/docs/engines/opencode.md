# OpenCode 接入规格

所有者 A。入口 `code/src/engines/opencode/pack.ts`，通道 `acp`，公共契约 1.0.0。实现文件：`config.ts`（配置装载与校验）、`executable.ts`（可执行文件解析）、`native-config.ts`（私有配置/环境变量重定向/模型注入）、`assets.ts`（资产投影）。配置：`code/config/engines/opencode.json`。测试：`code/tests/adapters/opencode/`。

本文档逐项标注证据等级：**declared**（仅有文档/静态代码依据）、**probed**（在假引擎/协议层面练习过，未连真实 OpenCode 进程）、**verified**（连真实 OpenCode 引擎观察到过）。写这份文档时没有可用的真实 OpenCode 安装，所以**没有任何一项是 verified**；下方证据表逐条给出真实来源链接或明确写"未验证"。

## 1. 分发形态与安装（declared，逐条标注来源）

| 事实 | 证据等级 | 依据 |
|---|---|---|
| OpenCode（anomalyco/opencode，原 sst/opencode，MIT）是 client/server 分离的 TypeScript/Bun 实现；稳定版 v1.18.27（2026-09-02） | declared，交叉验证 | `docs/research/T03-opencode.md` #1；GitHub Releases / npm registry |
| `@opencode-ai/sdk`、`@opencode-ai/plugin` 的 npm 包名与版本（1.18.27）已确认；**v1 CLI 主包名未在调研中直接确认**，只确认了 v2 beta 的 `@opencode-ai/cli@beta`（装为 `opencode2`） | declared | `docs/research/T03-opencode.md` #1、#13 |
| `opencode acp` 以 stdio JSON-RPC 暴露标准 ACP，供 Zed/JetBrains/Neovim 等接入；不支持 `/undo`、`/redo` 等部分内建命令；已知 issue #18672：`session/update` 通知可能晚于 `session/prompt` 响应到达 | declared，交叉验证 | `docs/research/T03-opencode.md` #10、"4. ACP" 小节；opencode.ai/docs/acp/ |
| **官方文档明确 "strongly recommend" 在 Windows 上使用 WSL，而非纯原生 Windows**；原生 Windows 可运行但文件系统性能、终端支持、工具兼容性均被列为较弱 | declared，一手文档，交叉验证 | `docs/research/G01-windows-compatibility.md` #11、"启示" 小节；opencode.ai/docs/windows-wsl/ |
| OpenCode 依赖 Bun（例如声明式 `plugin` 字段的自动安装用 Bun）；Bun 在 Windows 上的成熟度、以及是否存在官方 Windows 原生 `.exe` 构建物，**调研中未核实** | declared，未验证 | `docs/research/G04-generic-gateway-spec-vs-opencode-contract.md` #153、"未解决问题" |

**因此**：`config/engines/opencode.json#distribution.windowsNativeSupport` 记为 `"official-discouraged"`，不是 `"supported"`。这与赛题"引擎必须能在 Windows 原生运行"的硬约束存在直接冲突，是本 Pack 交付时最大的、需要在真实 Windows 机器上补测的风险项——本次实现只能确保"如果 `opencode acp` 在原生 Windows 上能跑起来，Pack 能正确接上它"，不能证明它确实能跑起来。

包名候选（`config/engines/opencode.json#distribution.packageNameCandidates`）目前是 `["opencode-ai", "@opencode-ai/cli"]`，均为未经调研直接确认的猜测；部署前必须用 `npm view <name>` 或官方文档核实一次并把结果写回配置，而不是盲目相信这两个候选。

## 2. Windows 可执行文件解析（declared + probed，见测试）

npm 全局安装在 Windows 上会生成 `opencode.cmd`：一个调用 `node.exe <真实入口.js> %*` 的批处理垫片。公共 `ProcessHost`（`src/runtime/process-host.ts`，已读取确认）用 `shell:false` 调 `spawn`，并显式校验：

```
if (platform === "win32" && !spec.executable.toLowerCase().endsWith(".exe")) {
  throw new PnpError("VALIDATION_ERROR", "Resolve npm shims to a real executable or node.exe plus a JS entrypoint.", 400);
}
```

即垫片永远不能被公共 Host 直接启动。`executable.ts` 因此实现两种模式：

- `node-script`（默认）：解析 `node.exe` 的绝对路径 + OpenCode CLI 真实 `.js` 入口的绝对路径，启动为 `node.exe <script> acp`。
- `exe`：如果运维方拿到了一个真正的独立 `.exe`（例如未来的 Bun 编译产物），直接启动 `<exe> acp`。

两者的解析顺序完全一致，都是**显式配置 → 环境变量 → 常见安装位置探测（仅做存在性检查，不执行任何文件）**：

| 目标 | 配置字段 | 环境变量 | 说明 |
|---|---|---|---|
| node.exe | `executable.node.configuredPath` | `PNP_OPENCODE_NODE_PATH` | 找不到时按 `executable.node.fallbackToHostRuntime` 回退到 `process.execPath`（网关自身的 node.exe，同样是 Windows 上的 `.exe`） |
| CLI 脚本 | `executable.script.configuredPath` | `PNP_OPENCODE_SCRIPT_PATH` | 无回退；找不到即失败 |
| 独立 exe | `executable.exe.configuredPath` | `PNP_OPENCODE_EXE_PATH` | 仅 `exe` 模式使用 |
| 模式选择 | `executable.defaultKind` | `PNP_OPENCODE_EXECUTABLE_KIND` | 值为 `exe` 或 `node-script` |

解析到的路径必须是 Windows 绝对路径且以 `.exe` 结尾（用 `node:path/win32` 校验，与运行测试的宿主系统无关，见 `tests/adapters/opencode/executable.test.ts`），否则抛 `ENGINE_EXECUTABLE_INVALID`；三个来源都找不到则抛 `ENGINE_EXECUTABLE_NOT_FOUND` / `ENGINE_SCRIPT_NOT_FOUND`。这些错误在 `launch()` 里产生，早于 `input.host.start()`，所以不会启动任何进程（见 `tests/adapters/opencode/pack.test.ts`）。

## 3. 私有配置目录：绝不污染用户全局配置

`docs/research/T03-opencode.md` 只确认了 OpenCode 的 POSIX 风格路径：配置 `~/.config/opencode/opencode.json(c)`，数据 `~/.local/share/opencode/`，缓存 `~/.cache/opencode`。**它在 Windows 上到底是（a）把 `os.homedir()` 字面拼接 `.config`，还是（b）优先读取 `XDG_CONFIG_HOME`，还是（c）走 Windows 风格的 `%APPDATA%`/`%LOCALAPPDATA%`，调研中没有确认**，这是需要在真实引擎上补测的开放问题。

已读取确认的是共享 `ProcessHost.baseEnvironment()`（`src/runtime/process-host.ts`）**默认会把网关真实的 `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` 传给子进程**（避免引擎缺失系统身份变量）；如果 Pack 不显式覆盖，OpenCode 很可能直接写到运维人员本机的真实全局配置目录。因此本 Pack **必须**在 `LaunchSpec.env` 里覆盖这些变量：

```
config/engines/opencode.json#redirect.variables:
  XDG_CONFIG_HOME -> <nativeDataDirectory>/opencode/xdg-config
  XDG_DATA_HOME   -> <nativeDataDirectory>/opencode/xdg-data
  XDG_CACHE_HOME  -> <nativeDataDirectory>/opencode/xdg-cache
  HOME            -> <nativeDataDirectory>/opencode/home
  USERPROFILE     -> <nativeDataDirectory>/opencode/home
  APPDATA         -> <nativeDataDirectory>/opencode/appdata
  LOCALAPPDATA    -> <nativeDataDirectory>/opencode/localappdata
```

因为不确定 OpenCode 到底信哪一种路径约定，`native-config.ts` 把生成的 `opencode.json` **同时**镜像写到两个最可能的候选根（按置信度排序）：

1. `<home>/.config/opencode/opencode.json`（假设 OpenCode 字面拼接 `os.homedir()+'.config'`，与多数年轻的、从类 Unix 环境移植过来的 Bun/Node CLI 的常见做法一致，置信度较高）；
2. `<xdgConfigHome>/opencode/opencode.json`（假设 OpenCode 使用某个尊重 `XDG_CONFIG_HOME` 的跨平台配置库）。

两份文件内容完全一致，绝不写到 `Session.directory`（用户工作目录）。这是一个已标注为"declared，未验证"的工程妥协：真正确认哪一个（或都不是）需要一次真实 Windows + 真实 OpenCode 的冒烟测试，见 §7 未解决问题。资产投影中的 `skills/` 目录用同一套候选根镜像，理由相同（§5）。

## 4. 凭据处理

`ResolvedModel.headers` 里的每一个 header（含 `Authorization`）都被映射成独立的环境变量（前缀 `PNP_OPENCODE_HEADER_`，见 `headerEnvironmentPrefix`），只出现在子进程的 `LaunchSpec.env` 里；生成的 `opencode.json` 里对应字段永远是 `$变量名` 字符串，从不写入明文值——`docs/research/G02-internal-model-endpoint-compat.md` #46 确认 OpenCode 的配置支持 `"apiKey": "$VAR"` 形式的环境变量间接引用（例子 `"apiKey": "$CUSTOM_OPENAI_KEY"`，中等置信度、经 deepwiki + 教程站交叉验证，非官方一手文档）；`headers` 字段沿用相同约定。`provider.<id>.options.apiKey` 复用 `Authorization` 头对应的环境变量（如果存在），否则写一个无害占位符 `"unused"`（非凭据字面量），真正生效的凭据始终以 `headers` 映射为准。`ResolvedModel.caFile` 存在时设置标准的 `NODE_EXTRA_CA_CERTS`（Node.js 官方文档行为，`node-script` 模式下始终跑在 node.exe 上；`exe` 模式下 Bun 也文档化了同一变量的兼容行为）。

## 5. 模型注入策略：`launch`，不是 `session-config`

ACP 的 `session/prompt` 请求没有模型字段；驱动的 `AcpModelPolicy` 提供两种形态：

- `session-config`：依赖引擎通过 `NewSessionResponse.configOptions`（`category: "model"`）广播一个可由 `session/set_config_option` 修改的选择器——这是 ACP v1 协议本身的通用能力（`docs/research/T12-acp-agent-client-protocol.md` #57：`config_option_update` + `SessionConfigOption`，`category ∈ mode|model|model_config|thought_level`），但**是否每个 ACP Agent 都会用到它，取决于该 Agent 的实现**。
- `launch`：模型在进程启动时钉死，任何轮次请求的模型必须与钉死值匹配，否则驱动在发送 Prompt 前拒绝（`ENGINE_MODEL_SWITCH_UNSUPPORTED`）。

调研范围内**没有找到 `opencode acp` 是否广播 model 分类 config option 的直接证据**——唯一确认的 opencode-acp 专属问题是 issue #18672（通知时序），与 config option 无关。默认选 `launch`：本 Pack 在生成的私有 `opencode.json` 里把顶层 `model` 字段钉成 `providerID/modelID`（OpenCode 原生的 `provider/model` 语法，`docs/research/T03-opencode.md` 会话字段表已确认），并把 `AcpEngineDefinition.model` 设为 `{kind:"launch", modelID}`。这样失败模式是"确定性地拒绝不支持的模型切换"，而不是"假设一个未证实的运行时能力，结果在第一次真实 Prompt 时才发现它不存在"。

`config/engines/opencode.json#model.policy` 可以在有真实引擎验证 `configOptions` 确实包含 model 分类之后切到 `"session-config"`；`pack.ts` 已经按这个配置字段分支，不需要改代码。

## 6. 工具与资产投影

工具（MCP stdio server）由 ACP 驱动统一映射（`mcpServersFor`，见 `src/drivers/acp/channel.ts`），Pack 不重复处理。

`definition.projectAssets` 只处理两种资产：

- **`instruction`**：复制到 `<nativeDataDirectory>/opencode/assets/instructions/<assetId>/<文件名>`（唯一规范位置），其绝对路径写入生成的 `opencode.json` 的顶层 `instructions` 数组（`docs/research/T03-opencode.md` 已确认该字段支持任意路径/glob/URL 列表）——这是我们自己生成的配置文件里的字段，不依赖猜测 OpenCode 的扫描路径。
- **`skill`**：镜像复制到 §3 两个候选配置根下的 `opencode/skills/<assetId>/<文件名>`，对应 OpenCode 文档确认的全局技能路径 `~/.config/opencode/skills/<name>/SKILL.md`（`docs/research/T03-opencode.md` #16）。项目级路径（`.opencode/skills`、`.claude/skills`，相对 `cwd`）**刻意不使用**：那是用户工作目录，写入即违反 contracts.md 第 8 节。

必需（`required: true`）但既非 `skill` 也非 `instruction` 的资产（例如 `native-extension`）会在 `projectAssets` 里直接抛 `ENGINE_ASSET_KIND_UNSUPPORTED`——`openAcpChannel` 在调用 `launch()`、发送任何 Prompt 之前就会 await 到这个失败，见 `src/drivers/acp/channel.ts` 中 `projectAssets` 先于 `launch` 执行的顺序，以及 `tests/adapters/opencode/pack.test.ts` 的端到端断言。可选的同类资产会被跳过并在返回值的 `skipped` 列表中如实报告，不假装已投影。

AssetBinding 一次只描述一个文件；如果真实的技能包在 `SKILL.md` 之外还有同目录下的脚本/资源文件，而那些文件没有各自的 AssetBinding，本 Pack 不会去猜测把它们一并复制——这是当前公共资产模型（`code/src/contracts/index.ts` 的 `AssetBinding`）的已知边界，不是本 Pack 的缺陷。

## 7. 能力证据表

| 能力 | 声明/探测/已验证 | 依据 | 备注 |
|---|---|---|---|
| `opencode acp` 存在且是 stdio JSON-RPC ACP | declared | `docs/research/T03-opencode.md` #10；opencode.ai/docs/acp/ | 未连真实进程 |
| ACP 协议版本 1（`PROTOCOL_VERSION`） | declared | `docs/research/T12-acp-agent-client-protocol.md` #2 | 驱动固定校验 `protocolVersion === 1..PROTOCOL_VERSION`，未见过 opencode 真实握手返回值 |
| Windows 原生运行可行性 | declared，官方不推荐 | `docs/research/G01-windows-compatibility.md` #11 | **未在真实 Windows 上冒烟测试**；本 Pack 唯一能保证的是"协议/进程接入正确"，不能保证"OpenCode 在原生 Windows 上稳定运行" |
| npm 全局安装产生 `.cmd` 垫片，需解析成 node.exe + 脚本 | declared，基于 npm 平台惯例 + 已读取的公共 `ProcessHost` 校验代码 | `src/runtime/process-host.ts`（本次任务只读，未修改） | 未见过真实 opencode 安装产物 |
| 模型走 `provider.<id>{npm,options{baseURL,apiKey,headers}}` | declared | `docs/research/G02-internal-model-endpoint-compat.md` #16；T03 #177 | 中等置信度：deepwiki + 教程站交叉验证，非直接官方文档源码 |
| `apiKey`/config 值支持 `$VAR` 环境变量间接引用 | declared | `docs/research/G02-internal-model-endpoint-compat.md` #46 | 同上，中等置信度 |
| 全局技能路径 `~/.config/opencode/skills/` | declared | `docs/research/T03-opencode.md` #16 | 未验证 Windows 上的实际落点 |
| `instructions` 配置数组接受任意文件路径 | declared | `docs/research/T03-opencode.md` #170 | 未验证 |
| ACP `config_option`（模型分类）在 `opencode acp` 下是否可用 | **未验证，声明为不可用**（model.policy 选 launch 的依据） | `docs/research/T12-acp-agent-client-protocol.md` #57（协议通用能力）；无 opencode-acp 专属证据 | 见 §5 |
| Session/取消/权限/流式等 ACP 通用行为 | probed | `tests/adapters/opencode/pack.test.ts` 用假 ACP 对端验证了 initialize → session/new 握手路径能被本 Pack 的 launch 请求正确驱动到 | 假引擎，不是真实 OpenCode 进程；不构成 verified |
| 可执行文件解析三级顺序与错误码 | probed | `tests/adapters/opencode/executable.test.ts`（9 个用例，全部通过） | 纯逻辑测试，不涉及真实二进制 |
| 私有配置不落盘凭据、不写用户目录 | probed | `tests/adapters/opencode/native-config.test.ts`、`assets.test.ts`（全部通过，断言序列化文本不含明文密钥） | 同上 |

**没有任何一项标记为 verified**：本次交付没有可用的真实 OpenCode 安装，也没有 Windows 环境。`capabilityEvidence` 字段在 `config/engines/opencode.json` 中如实写为 `"unverified"`。

## 8. 配置样例

`config/engines/opencode.json` 的相关片段（凭据从不出现在此文件里）：

```json
{
  "executable": {
    "node": { "configuredPath": null, "environmentVariable": "PNP_OPENCODE_NODE_PATH", "wellKnownPaths": ["${ProgramFiles}\\nodejs\\node.exe"] },
    "script": { "configuredPath": null, "environmentVariable": "PNP_OPENCODE_SCRIPT_PATH", "wellKnownPaths": ["${APPDATA}\\npm\\node_modules\\opencode-ai\\bin\\opencode"] }
  },
  "model": { "policy": "launch" },
  "headerEnvironmentPrefix": "PNP_OPENCODE_HEADER_"
}
```

部署时按需覆盖：设置 `PNP_OPENCODE_NODE_PATH`/`PNP_OPENCODE_SCRIPT_PATH` 环境变量，或直接改 `configuredPath` 字段指向已确认的真实安装位置（不要把某台机器的用户名/路径提交进仓库）。生成的私有 `opencode.json`（运行时写在 `nativeDataDirectory` 下，不进版本库）大致形状：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "acme-internal/acme-large-v3",
  "share": "disabled",
  "provider": {
    "acme-internal": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://model.internal.example.invalid/v1",
        "apiKey": "$PNP_OPENCODE_HEADER_AUTHORIZATION",
        "headers": { "Authorization": "$PNP_OPENCODE_HEADER_AUTHORIZATION" }
      },
      "models": { "acme-large-v3": {} }
    }
  }
}
```

## 9. 测试

`tests/adapters/opencode/`（config/executable/native-config/assets 四个文件共 29 个用例可在这个 worktree 里直接跑通；`pack.test.ts` 另 3 个用例需要 ACP 驱动，见 §10）：

```
node --experimental-strip-types --test tests/adapters/opencode/config.test.ts
node --experimental-strip-types --test tests/adapters/opencode/executable.test.ts
node --experimental-strip-types --test tests/adapters/opencode/native-config.test.ts
node --experimental-strip-types --test tests/adapters/opencode/assets.test.ts
```

`scripts/test.mjs` 目前只跑 `tests/unit` 与 `tests/contract`，还没有把 `tests/adapters/**` 挂进去；需要拥有 `scripts/**`（公共文件）的同事把 `tests/adapters/opencode/*.test.ts`（以及 `tests/adapters/acp/**`，按 `docs/team/ownership.json`）加进测试脚本的遍历范围。

## 10. 已知的跨分支序列问题（非本 Pack 缺陷，供集成方处理）

编写本 Pack 时，这个 worktree 的公共基线还落在 ACP 驱动合入之前（`src/drivers/acp/` 下只有 `AGENTS.md`，没有 `channel.ts` 等实现文件；已在另一分支 `worktree-agent-a059eae30a0f2810e` / `claude/multi-engine-agent-gateway-gz5gj7` 上确认存在，提交 `c09f4bc..fe665b8`）。本 Pack 已按 `AcpEngineDefinition`/`openAcpChannel` 的公开接缝完成实现，并在一份隔离的临时目录（合入了对方分支的驱动代码，未提交到仓库）里验证过 `npx tsc --noEmit` 干净、`tests/adapters/opencode/*.test.ts` 全部 32 用例通过。分支合并后应重跑一遍确认。

验证过程中发现一个与本 Pack 无关、位于 `src/drivers/acp/capabilities.ts` 的问题，供驱动所有者参考（本次任务未修改该文件）：其私有方法命名为 `declare`（`private declare(id, available, shape) {...}`），在 Node 官方 `--experimental-strip-types`（`scripts/test.mjs` 用的正是这个模式）下会被解析成 TypeScript 的 `declare` 环境修饰符而不是方法名，导致 `SyntaxError: Unexpected identifier 'declare'`。已在 Node 22.22.2、24.9.0 以及 `package.json` 锁定的 24.19.0 上复现，与 Node 版本无关；最小复现：`class A { private declare(x: string) {} }` 用 `node --experimental-strip-types` 直接跑会报同样的错，去掉 `private`/`public` 等修饰符则不会。一旦这个文件被合入任何会跑 `node --experimental-strip-types --test` 的路径（包括 `tests/adapters/opencode/pack.test.ts`、未来的 `tests/adapters/acp/**`），都会连带失败，且与调用方代码无关。建议把该私有方法改名（例如 `recordCapability`）。
