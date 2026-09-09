# OpenCode 接入规格

所有者 A。入口 `code/src/engines/opencode/pack.ts`，通道 `acp`，公共契约 1.1.0。实现文件：`config.ts`（配置装载与校验）、`executable.ts`（可执行文件解析）、`native-config.ts`（私有配置/环境变量重定向/模型注入）、`assets.ts`（资产投影）。配置：`code/config/engines/opencode.json`。测试：`code/tests/adapters/opencode/`。

## 0. 证据等级的定义

本文档逐项标注证据等级：

- **declared**：只有官方文档、npm 注册表元数据或静态代码依据，没有把二进制跑起来。
- **probed**：**用真实的 opencode 二进制**（1.18.29）对着一个 mock 的 OpenAI 兼容服务端实际观察到过——早期在 Linux 上，此后也在 **Windows 原生**上（`npm run e2e -- --engine opencode`：真实网关进程 + Windows 进程宿主 + 真实 `opencode.exe`）；或者用假 ACP 对端在协议层面练过本仓库这一侧的代码路径。下表逐条写明是哪一种、在哪个平台。
- **verified**：在赛题要求的 Windows 原生目标上、连**真实内网模型端点**、由授权环境出具与 commit/版本匹配的验收证据（`verification/internal/opencode.json`）。

**本文档没有任何一项是 verified**，因为真实内网模型端点尚未接入；这也是 `config/engines/opencode.json#capabilityEvidence` 停在 `"probed"` 的原因。Windows 原生 + 真实二进制 + 模拟模型端点这条路径已有真机证据（2026-09-09 冒烟 21 项 20 通过、0 失败、1 跳过，见 §11）；§8 列出仍只能靠内网真机或专项实验证实的点。

## 1. 分发形态与安装（distribution）

以下事实来自对 npm 注册表中 `opencode-ai@1.18.29` 包内容的直接核对，以及 opencode.ai 官方文档；不是推断。

| 事实 | 证据等级 | 依据 |
|---|---|---|
| `opencode-ai` 的 `package.json` 声明 `"bin": { "opencode": "./bin/opencode.exe" }`，而包里自带的 `bin/opencode.exe` 只是一个 **479 字节的占位符** | declared（直接读包内容） | npm registry，`opencode-ai@1.18.29` |
| `postinstall.mjs` 从**平台专属可选依赖**里解析出真正的可执行文件（Windows x64 是 `opencode-windows-x64@1.18.29`，无 AVX2 时用 `opencode-windows-x64-baseline`），硬链接或复制到 `<opencode-ai 包目录>/bin/opencode.exe`，再用 `--version` 校验 | declared（直接读 postinstall 脚本） | 同上 |
| 真正的 `opencode.exe` 约 **172 MB，是 Bun 编译的独立可执行文件**；**包里没有任何 JS 入口脚本** | declared | 同上 |
| 因此 `npm i -g opencode-ai` 之后，Windows 上的启动目标是 `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`（npm 默认前缀）；平台包自己的 `node_modules\opencode-windows-x64\bin\opencode.exe` 同样是一个真实可执行文件 | declared | 同上 + npm 全局安装布局 |
| `opencode acp` 以 stdio JSON-RPC 暴露标准 ACP，**没有额外参数** | probed（真实二进制，Linux） | opencode.ai/docs/acp/；实跑 1.18.29 完成 initialize + session/new |
| 官方原话："While OpenCode can run directly on Windows, we recommend using WSL for the best experience" —— 原生 Windows **能跑**，只是不被推荐 | declared，一手文档 | opencode.ai 文档；并有一手 Windows x64 可执行文件发布佐证 |

**这推翻了本 Pack 早先的一个核心假设。** 之前的实现默认走 `node-script` 模式（`node.exe <入口.js> acp`），前提是"npm 全局安装的是一个 JS CLI，`opencode.cmd` 是它的批处理垫片"。真实分发里**根本没有 JS 入口**，所以那条默认路径在真机上必然启动失败。现在：

- `config/engines/opencode.json#executable.defaultKind` = `"exe"`；
- `distribution.packageNameCandidates` 只留 `["opencode-ai"]`（不再有 `@opencode-ai/cli` 这个猜测；那是 v2 beta 的包名，装出来的命令叫 `opencode2`，不是本 Pack 的目标）；
- `distribution.windowsNativeSupport` 从 `"official-discouraged"` 改为 `"supported-not-recommended"`，与官方原话一致：能跑，不推荐。

**安装命令**（部署机上执行一次）：

```
npm install -g opencode-ai@1.18.29
```

`config/engines/opencode.json#engineVersion` 与 `code/engines.lock.json` 均锁在 `1.18.29`。锁文件中的 SHA-256 来自直接下载并校验官方 `opencode-windows-x64@1.18.29` npm tarball；协议能力仍需按下文证据等级分别判断，版本锁本身不等于端到端验收。

## 2. 可执行文件解析（executable）

`exe` 是默认模式，也是唯一能启动 stock 安装的模式。解析顺序：**显式配置 `configuredPath` → 环境变量 → 常见安装位置探测**（只做存在性检查，绝不执行候选文件）。

| 目标 | 配置字段 | 环境变量 |
|---|---|---|
| 独立可执行文件（默认） | `executable.exe.configuredPath` | `PNP_OPENCODE_EXE_PATH` |
| node.exe（仅 node-script 模式） | `executable.node.configuredPath` | `PNP_OPENCODE_NODE_PATH` |
| CLI 脚本（仅 node-script 模式） | `executable.script.configuredPath` | `PNP_OPENCODE_SCRIPT_PATH` |
| 模式选择 | `executable.defaultKind`（现为 `exe`） | `PNP_OPENCODE_EXECUTABLE_KIND` |

`executable.exe.wellKnownPaths`（按顺序探测）：

```
${APPDATA}\npm\node_modules\opencode-ai\bin\opencode.exe                     ← npm 默认全局前缀，postinstall 落地的位置
${APPDATA}\npm\node_modules\opencode-windows-x64\bin\opencode.exe            ← 平台包自身
${APPDATA}\npm\node_modules\opencode-windows-x64-baseline\bin\opencode.exe   ← 无 AVX2 的 x64
${ProgramFiles}\nodejs\node_modules\opencode-ai\bin\opencode.exe             ← 机器级 npm 前缀
${LOCALAPPDATA}\Programs\opencode\opencode.exe                               ← 手工安装留的位置
```

模板里的 `${VAR}` 若未设置，**整条候选被跳过**，不会退化成 `\npm\node_modules\...` 这种根相对路径去探测（在 Linux 上跑时这一点尤其重要）。POSIX 侧没有 well-known 列表：npm 在类 Unix 上的全局前缀不固定，用 `PNP_OPENCODE_EXE_PATH` 直接指向二进制即可。

**显式路径要真的存在。** `configuredPath` 与 `PNP_OPENCODE_EXE_PATH` 给出的路径在形状校验之后再做一次存在性检查（`stat` 是普通文件），不存在则在 `open()` 内、任何进程启动之前抛 `ENGINE_EXECUTABLE_NOT_FOUND`，消息里指名来源与路径。这是 CI 的 ubuntu/opencode 腿教的：一条指向不存在文件的路径原本要等宿主报一句泛泛的 `HOST_START_FAILED`。

**一个反直觉的分发事实（probed，Linux CI）：`npm i -g opencode-ai` 在所有平台上都把真实二进制落在 `<npm root -g>/opencode-ai/bin/opencode.exe`** —— postinstall 脚本里目标文件名写死为 `bin/opencode.exe`，Linux 上也是这个名字（一个叫 `.exe` 的 ELF）。平台包（`opencode-linux-x64/bin/opencode`）保留原生名字。`scripts/e2e/ci-smoke.mjs` 按 `opencode-ai/bin/opencode.exe` → `opencode-<platform>-<arch>/bin/<原生名>` → `-baseline` 的顺序定位；Windows 上 `%APPDATA%\npm\...\opencode.exe` 的推断与这条一致。

**`node-script` 保留为显式可选**（`PNP_OPENCODE_EXECUTABLE_KIND=node-script` + `PNP_OPENCODE_SCRIPT_PATH`），给"未来出现 JS 入口构建"或"自行重打包"的情况留门。但要说清楚：**真实分发没有脚本入口**，所以 `executable.script.wellKnownPaths` 是空的，在 stock 安装上这个模式必定抛 `ENGINE_SCRIPT_NOT_FOUND` —— 它失败，而不是去猜一个路径。

npm 全局安装同时会写一个 `opencode.cmd` 垫片。两种模式都不会用它：公共 `ProcessHost` 用 `shell:false` 启动，且在 win32 上要求可执行文件以 `.exe` 结尾（`src/runtime/process-host.ts`，本次只读未改）。

### 2.1 平台感知的路径校验（本次修正）

旧实现无条件要求"Windows 绝对路径 + `.exe` 后缀"，结果是 Pack 在 Linux 上完全不可用 —— 而我们需要在 Linux CI 与本地用 `opencode-linux-x64` 做冒烟。现在的规则与公共 `ProcessHost` 完全一致：

| 目标平台 | 绝对路径 | `.exe` 后缀 |
|---|---|---|
| `win32` | `path.win32.isAbsolute` | 必须 |
| 其他 | `path.posix.isAbsolute` | 不要求 |

判定用的是**目标平台**（`ExecutableEnvironment.platform`，生产取 `process.platform`，测试可注入），不是"跑校验的这台机器"，所以在 Linux 上校验一个共享 Windows 宿主的配置，`.exe` 规则照样生效。`node-script` 模式的脚本参数只校验绝对性，不校验后缀（它本来就不是 `.exe`）。违反抛 `ENGINE_EXECUTABLE_INVALID`；三个来源都找不到抛 `ENGINE_EXECUTABLE_NOT_FOUND` / `ENGINE_SCRIPT_NOT_FOUND`。这些错误都发生在 `launch()` 内、`input.host.start()` 之前，因此不会有任何进程被启动（`tests/adapters/opencode/pack.test.ts` 断言了这一点）。

## 3. 配置发现与私有化：`OPENCODE_CONFIG` + `OPENCODE_CONFIG_DIR` + 四个 XDG 根

OpenCode 文档给出的配置发现顺序是：

1. 远程 `.well-known`
2. 全局 `<config home>/opencode/opencode.json`
3. **`OPENCODE_CONFIG` 环境变量指定的自定义路径**
4. 项目根 `opencode.json`
5. `.opencode` 目录（`OPENCODE_CONFIG_DIR` 指定的目录按同样结构参与）
6. **`OPENCODE_CONFIG_CONTENT` 内联**
7. 托管配置

文档正文里没有出现 `XDG_*`，但**引擎自己的目录解析读的就是 XDG**。这一条不是推断，是从真实 1.18.29 二进制里读出来的：

```
data  = (XDG_DATA_HOME  || <home>/.local/share)/opencode      # opencode.db、log/、repos/
config= (XDG_CONFIG_HOME|| <home>/.config)/opencode           # 全局 opencode.json、skills/
cache = (XDG_CACHE_HOME || <home>/.cache)/opencode            # models.json 等
state = (XDG_STATE_HOME || <home>/.local/state)/opencode      # locks/
```

**这段解析里没有任何平台分支**，因此同样适用于 Windows：设了 `XDG_*` 就用 `XDG_*`，没设就落在 `<home>/.config`、
`<home>/.local/share`（**不是** `%APPDATA%`）。所以本 Pack 把这四个变量指到会话私有目录，就是把 OpenCode 自己的
配置、数据、缓存与锁全部私有化，同时**完全不碰用户档案**。

```
config/engines/opencode.json#redirect.variables:
  XDG_CONFIG_HOME -> <nativeDataDirectory>/opencode/xdg-config
  XDG_DATA_HOME   -> <nativeDataDirectory>/opencode/xdg-data
  XDG_CACHE_HOME  -> <nativeDataDirectory>/opencode/xdg-cache
  XDG_STATE_HOME  -> <nativeDataDirectory>/opencode/xdg-state
额外由 pack.ts 注入：
  OPENCODE_CONFIG     -> <nativeDataDirectory>/opencode/opencode.json   （主发现路径，文档 "Custom path"）
  OPENCODE_CONFIG_DIR -> <nativeDataDirectory>/opencode/config          （文档 "Custom directory"）
```

**`HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` 不再重定向，且不得再加回去。** 旧实现把它们指向私有目录，代价是
模型启动的一切东西（Office COM、Outlook）看到的是一个假档案，每用户状态全部失效
（`docs/competition-readiness.md` B8/D4）。子进程从公共 `ProcessHost.baseEnvironment()` 继承运维人员的真实档案；
OpenCode 自己的状态由上面四个 XDG 根 + 两个 `OPENCODE_*` 变量隔离，不再依赖档案变量。

私有配置写在 `<nativeDataDirectory>/opencode/opencode.json`（`OPENCODE_CONFIG` 指向它），并把**逐字节相同**的内容
镜像一份到 `<xdgConfigHome>/opencode/opencode.json`（发现顺序第 2 条的"全局配置"）。两份都在私有树内，**绝不写进
`Session.directory`**。技能则复制到 `OPENCODE_CONFIG_DIR/skills/<id>/` 与 `<xdgConfigHome>/opencode/skills/<id>/`
（见 §6）。

Linux 上对真实 1.18.29 的实测（probed）：私有配置生效；`opencode.db`、`log/`、`models.json` 与 `locks/` 分别落在
私有的 `xdg-data` / `xdg-cache` / `xdg-state` 下，**没有**写到 `HOME`；把 `OPENCODE_CONFIG` 从环境里删掉、只留
`XDG_CONFIG_HOME` 镜像，整轮仍然正常完成 —— 镜像不是"碰运气的兜底"，它就是文档里的全局配置位置。**Windows 上这
四个变量的行为仍未在真机复验**（二进制里没有平台分支，是代码层面的证据，不是运行证据）。

`OPENCODE_CONFIG` 与 `OPENCODE_CONFIG_DIR` 在 `pack.ts` 里是**最后两个、无条件的**赋值：万一某个 header 被映射成
同名环境变量，也不能把引擎指回运维人员的真实全局配置。

## 4. 凭据处理与替换语法

**替换语法是 `{env:VARIABLE_NAME}`，不是 `$VAR`。** 这一条是实测的：真实 1.18.29 进程里，设成 `{env:OC_KEY}` 的 header 到达 mock 服务端时是真实值，而设成 `$OC_KEY` 的 header 原样是字符串 `$OC_KEY`。变量未设置时替换成空串。

`ResolvedModel.headers` 的每一个 header 都被映射成独立环境变量（前缀 `PNP_OPENCODE_HEADER_`），值只出现在子进程的 `LaunchSpec.env` 里；生成的 `opencode.json` 里对应位置永远是 `{env:变量名}`，从不写明文。

**`Authorization: Bearer <token>` 是特例，原因是实测出来的**：`@ai-sdk/openai-compatible` provider 自己会用 `options.apiKey` 拼出 `Authorization: Bearer <apiKey>`。把整条 header 值喂给 `apiKey`，真实运行时 mock 服务端收到的是 `Authorization: Bearer Bearer <token>`。所以现在：

- `Authorization` 以 `Bearer `（大小写不敏感）开头时：**剥掉前缀**，把裸 token 放进支撑 `options.apiKey` 的环境变量（`PNP_OPENCODE_HEADER_API_KEY`），并且**不再**在 `options.headers` 里发一份 `Authorization` —— provider 自己会写，重复一份只会打架；
- `Authorization` 用其他 scheme（如 `Basic`）时：`apiKey` 保持无害占位符 `"unused"`，该 header 走普通 `options.headers` 的 `{env:}` 路线。**这条路线没有端到端实测，标记为未验证**；
- 其余所有 header（appid 之类的自定义头）照旧走 `options.headers` 的 `{env:}`。

`ResolvedModel.caFile` 存在时设置标准的 `NODE_EXTRA_CA_CERTS`（`exe` 模式下是 Bun 的 TLS 栈，Bun 文档化了同一变量；`node-script` 模式下跑在 node.exe 上，是原生行为）。

### 4.0 子进程环境里还有什么

除了上面的 header 变量、§3 的重定向与两个 `OPENCODE_*` 指针，`pack.ts` 只往子进程环境里放三类东西，全部有明确来源：

| 变量 | 何时设置 | 来源与理由 |
|---|---|---|
| `NODE_EXTRA_CA_CERTS` | `ResolvedModel.caFile` 存在 | 自签/内网 CA 的标准扩展点 |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | **仅** `ResolvedModel.tlsInsecure === true` | 内网端点连 `caFile` 都验不过时的最后手段。只由解析后的模型（一次明确的部署决策，经 `IntegrationContext` 到达本 Pack）打开，**绝不**从网关自己的环境继承，也没有默认值 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 及三个小写别名 | 网关进程里该变量非空 | 公共 `ProcessHost.baseEnvironment()` 的白名单只带操作系统级键，不含代理变量，子进程否则会在网关有代理的情况下完全没有代理配置。值是部署配置不是凭据，原样透传；未设置或空串的变量**不导出**（有些客户端把空串读成"配了个通向虚空的代理"） |

大小写两套都带，是因为 POSIX 上这些变量大小写敏感，各家客户端读哪一套并不一致。

### 4.1 提供方字段

自定义 OpenAI 兼容提供方的必填字段：`provider.<id>.npm`（`@ai-sdk/openai-compatible`）、`provider.<id>.name`（显示名，本 Pack 写 `PNP <providerId>`）、`options.baseURL`、`models.<id>.name`（显示名，本 Pack 写 `modelId`）。可选：`options.apiKey`、`options.headers`、模型的 `limit`。两个 `name` 字段在真实 1.18.29 上被接受（probed）。

`share` 固定为 `"disabled"`（合法取值）：竞赛会话的 prompt 不应该通过 opencode 的 share 链接离开这台机器。

### 4.2 `nativePermissions`

新增的可选引擎配置项 `nativePermissions`，取值 `"engine-default"`（默认）或 `"ask"`：

- `"engine-default"`：除了下面那条 `external_directory` 之外不写任何 `permission` 条目，引擎不会发 ACP `session/request_permission`。
- `"ask"`：追加 `"edit": "ask"` 与 `"bash": "ask"`，权限请求才会真正在 ACP 上触发，由网关策略层决定 allow/ask/deny。

**`external_directory` 是一个必须显式写出来的例外。** "OpenCode 默认允许一切操作"是官方 config 文档的原话，但它不成立：
`external_directory` 与 `doom_loop` 默认 `ask`，读 `.env` 默认 `deny`（`docs/research/T03-opencode.md` 第 151 行；真实
1.18.29 的配置 schema 里 `external_directory`、`doom_loop`、`question` 都是有名字的权限键）。评测任务每一条都要读写会话目录
之外的绝对路径，而无人值守时没人回答提问。因此**只要有效策略的默认是 `allow` 且没有任何 operation 指名
`external_directory`，生成的配置就显式写入 `"external_directory": "allow"`**；策略指名了它（或默认不是 `allow`）时按策略投影，
不会被悄悄改写 —— 要求提问的运维方不会因为这条规则失去提问。这也是唯一一个"显式 allow 不会因为与默认值相同而被省略"的键。

`tools` 块同理是无人值守的硬要求：生成的配置永远写 `"tools": { "question": false }`。形状由 config 文档的 "Tools" 一节给出
（"You can manage the tools an LLM can use through the `tools` option"，示例 `{"write": false, "bash": false}`，即 工具名 →
布尔 的映射），名字由 1.18.29 自带的配置 schema（`tools` 为 `additionalProperties: boolean`；`question` 是权限键之一）与
`question.asked` + `POST /question/{id}/reply` 通道佐证。反问会阻塞整轮直到交互超时、然后按拒绝收尾，所以这个工具不该存在。

默认保持 `"engine-default"`：打开引擎侧提问是一个部署决策，不是网关替运维方做的默认。

**环境变量覆盖 `PNP_OPENCODE_NATIVE_PERMISSIONS`**（`engine-default` | `ask`）：在加载引擎配置时生效，优先于文件里的
`nativePermissions`。未设置或为空串＝用文件里的值；设成别的任何值直接以 `ENGINE_CONFIG_INVALID` 让加载失败，**不**回退到
`"engine-default"` —— 要求提问的部署不能因为一个拼错的值就变成"什么都允许"。这样打开引擎侧提问不需要改一份进了版本库的文件
（`scripts/e2e/ci-smoke.mjs` 的 opencode 腿就是这么给网关进程设的）。覆盖逻辑在 `applyOpenCodeEnvironmentOverrides`
（`src/engines/opencode/config.ts`，纯函数，`tests/adapters/opencode/config.test.ts` 直接测）。

注意这只打开**引擎侧**提问。请求真正停在网关等人回答，还要求集成档的授权策略对该操作给出 `"ask"`：策略 `allow` 会在
`InteractionBroker` 里直接放行、根本不发布 pending 请求，`deny` 直接拒。驱动把请求登记为哪个 operation 见 §4.3。

### 4.3 权限请求的 operation 取名

`GET /permission` 返回的 `permission` 字段就是交互请求的 `operation`，也是策略 `policy.operations.<name>` 匹配的键。
OpenCode 的 `session/request_permission` 对一次编辑**不带 `name`**、`kind: "edit"`、`title` 是目标文件的绝对路径，因此不能
拿 `title` 当 operation —— 那样每个文件都是一个新 operation，任何配置好的策略都匹配不上。

驱动（`src/drivers/acp/channel.ts` 的 `permissionOperation`）按这个顺序取第一个非空值：

1. `SessionUpdateMapper.nameOf(toolCallId)` —— 该 call 宣告时解析出的身份：优先 ACP 的程序化 `name`，没有 `name` 时用宣告
   时的 `title`（OpenCode 的 `write` 就是这么来的）。两者都没有时这一档为空，继续往下取；
2. 请求自带的 `toolCall.name`；
3. `toolCall.kind`（ACP 的封闭小词表，至少能写进策略）；
4. `toolCall.title`；
5. `toolCall.toolCallId`（兜底，唯一，匹配不上任何策略，但不会谎报成别的操作）。

载荷本身不变，仍然把 `title`/`name`/`kind`/`locations`/`rawInput`/`content`/`options` 原样交给审批方。

**轨迹侧用的是同一条取名规则。** 契约 1.1 的 `tool.observed` 把这次调用的 canonical 名称定为 `name ?? 宣告时的 title`，并用 `nameSource`（`"name"` | `"announced-title"`）标注出处，因此 OpenCode 的 `write` 在轨迹里就是 `write`：assistant 消息带 `tool_calls: [write]` 与 `info.finish: "tool-calls"`，随后是 `tool_name: "write"` 的 role=tool 消息。宣告之后引擎把 `title` 改写成目标文件路径（§4.2 的时序），那条改写只作为 `title` 记录，**不改名**。策略与轨迹因此永远不会对同一次调用给出两个名字；只有既无 `name` 又无宣告 title 的 call 才停留在非 canonical 的观察上。

`"ask"` 路线在真实 1.18.29 二进制（Linux）上实跑过一次 `write` 工具，观察到的时序与载荷（probed）：

1. `tool_call`（`status: pending`，`rawInput: {}`）→ `tool_call_update`（`in_progress`，`rawInput: {filePath, content}`，`locations`）；
2. **然后**才来 `session/request_permission`：`toolCall.title` 是目标文件路径，`kind: "edit"`，`rawInput: {filepath, diff}`，`content: [{type:"diff", path, oldText, newText}]`，选项 `allow_once / allow_always / reject_once`。驱动把 `content` 一并放进交互载荷，审批方看得到 diff；驱动从不选 `allow_always`。
3. 选 `allow_once` 后，引擎向客户端发 `fs/write_text_file`（尽管客户端在 `initialize` 里声明了 `writeTextFile: false`）。驱动未实现该方法，SDK 以 method-not-found 拒绝，引擎随即**自行落盘**并报 `tool_call_update: completed`（"Wrote file successfully."），文件内容正确。引擎会在 stderr 打一段 Bun 栈，属噪声。

4. **`reject_once` 也实跑过了**（probed，Linux 1.18.29，见 §11 的 `case2b`）：选 `reject_once` 后引擎把该 call 记为
   `status: failed`，内容是 `"The user rejected permission to use this specific tool call."`，目标文件**没有**被创建，
   本轮随后正常结束（最终 assistant 消息 `finish: "stop"`），会话回到 `idle`。契约 1.1 逐字段保留这条失败观察；
   canonical tool call 需要该 call 的名称（`name` 或宣告时的 title）与 `input` 都被观察到，role=tool 结果还额外需要终态
   `rawOutput`，缺项时保留 `tool.observed`/`result_unknown`，不补造失败结果。

`bash: "ask"` 的实际行为未观察；Windows 上 `edit: "ask"` 的允许一次与拒绝一次两条路线已通过真实二进制端到端检查。

## 5. 模型注入策略：`launch`

ACP 的 `session/prompt` 请求没有模型字段；驱动的 `AcpModelPolicy` 有两种形态：`session-config`（靠 `NewSessionResponse.configOptions` 里 `category: "model"` 的选择器，配合 `session/set_config_option`）与 `launch`（启动时钉死，任何不匹配的模型在发 Prompt 前被拒，`ENGINE_MODEL_SWITCH_UNSUPPORTED`）。

**这里更正一条旧结论。** 早先写的是"没有证据表明 `opencode acp` 广播 model 分类的 config option"。实测：真实 1.18.29 的 `session/new` 返回了 `{ id: "model", category: "model", type: "select", currentValue: "<provider>/<model>", options: [...] }`，`currentValue` 正是私有配置里钉的那个模型。**两条路都存在**，`config/engines/opencode.json#model.policyEvidence` 因此从 `declared` 改为 `probed`。

**`launch` 仍是出厂默认**，理由不是"另一条不存在"，而是它**失败得更干净**：模型写在私有 `opencode.json` 顶层的 `model` 字段（`provider/model` 语法 —— 这就是 ACP 模式下选模型的方式，ACP 协议本身不带模型字段），请求任何别的模型会被明确拒绝，而不是被"引擎当时恰好留着的那个模型"悄悄回答掉。要按会话切模型时，把 `model.policy` 改成 `"session-config"` 即可，`pack.ts` 已按该字段分支，不需要改代码。

## 6. 工具与资产投影

工具由 ACP 驱动统一映射（`mcpServersFor`，见 `src/drivers/acp/channel.ts`），Pack 不重复处理：`mcp-stdio` 绑定投影为 ACP 的 stdio MCP server；`mcp-http` 绑定（设置文件里的 `streamable-http`）只有在引擎 `initialize` 声明了 `agentCapabilities.mcpCapabilities.http` 时才投影为 `{ type: "http", name, url, headers }`，否则走原有的丢弃并上报路径，`tools.unsupported-transport` 的 `reason` 直接点名缺的是哪一项能力，不改投别的 transport。OpenCode 1.18.29 声明了该能力，实跑摘录见 §7。

`definition.projectAssets` 只处理两种资产：

- **`instruction`**：复制到 `<nativeDataDirectory>/opencode/assets/instructions/<assetId>/<文件名>`（唯一规范位置），**绝对**路径按资产到达顺序、去重后写入生成的 `opencode.json` 顶层 `instructions` 数组。用 `path.resolve` 而不是 `join`：`instructions` 里的相对路径会被 OpenCode 按配置文件所在目录解析，那不是资产被复制到的地方。每个资产有自己的 `<assetId>` 目录，所以两个同名的指令文件（都叫 `GUIDE.md`）不会互相覆盖。写进配置的路径就是本 Pack 复制出来的那份文件，不是只存在于网关宿主上的路径。
- **`skill`**：复制到 `RedirectPlan.skillRoots` 的每一个根下的 `<assetId>/<文件名>`，即私有 `OPENCODE_CONFIG_DIR/skills/<assetId>/`（文档化的 `.opencode` 结构）与 `<xdgConfigHome>/opencode/skills/<assetId>/`（文档化的全局技能路径 `~/.config/opencode/skills/<name>/SKILL.md`，而 §3 已经确认全局 config home 就是 `XDG_CONFIG_HOME || <home>/.config`）。`OPENCODE_CONFIG` 只指定**配置文件**，没有说明技能从哪里扫描，这正是 config-directory 这条路线在 `HOME` 不再重定向之后变得重要的原因。项目级路径（`.opencode/skills`，相对 `cwd`）刻意不用：那是用户工作目录，写入即违反 contracts.md 第 8 节。

必需（`required: true`）但既非 `skill` 也非 `instruction` 的资产会在 `projectAssets` 里抛 `ENGINE_ASSET_KIND_UNSUPPORTED`；`openAcpChannel` 在 `launch()` 与任何 Prompt 之前就 await 到这个失败。可选的同类资产被跳过并在返回值的 `skipped` 里如实报告，不假装已投影。

`AssetBinding` 一次只描述一个文件；技能包里 `SKILL.md` 之外、没有各自 AssetBinding 的附属文件，本 Pack 不会去猜着一并复制 —— 这是当前公共资产模型的已知边界。

## 7. 能力证据表

| 能力 | 等级 | 依据 | 备注 |
|---|---|---|---|
| `opencode acp` 存在，stdio JSON-RPC，无额外参数 | probed（真实二进制，Linux/Windows） | opencode.ai/docs/acp/ + 实跑 1.18.29 | Windows 端到端冒烟 20/21（2026-09-09，§11） |
| ACP 协议版本 1 握手 | probed（真实二进制，Linux） | 实跑 initialize 成功 | 驱动固定校验 `protocolVersion === 1..PROTOCOL_VERSION` |
| `initialize` 返回 `agentCapabilities.loadSession: true`、`sessionCapabilities: { close, fork, list, resume }` | probed（真实二进制，Linux/Windows） | 实跑 initialize 返回值及Windows端到端握手 | |
| `initialize` 返回 `agentCapabilities.mcpCapabilities: { http: true, sse: true }` | probed（真实二进制，Linux） | 实跑 1.18.29 initialize 返回值，原文摘录见表下 | 驱动据此投影 `mcp-http` 绑定（§6）；`sse` 已声明但网关没有对应的绑定形状，不使用 |
| npm 包 `opencode-ai` 的 bin 是占位符，postinstall 从平台包解析出真实 exe，无 JS 入口 | declared（直接读包内容与 postinstall 脚本） | npm registry `opencode-ai@1.18.29` | 未在 Windows 上真正 `npm i -g` 过 |
| Windows 原生运行可行性 | probed（真实二进制，Windows） | 官方文档、Windows x64 1.18.29、Windows 端到端冒烟 20/21（§11） | 真实内网模型仍未验证 |
| `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe` 是安装后的实际落点 | declared（npm 全局布局 + postinstall 目标） | 同上 | 未在 Windows 上核对过实际落点 |
| `OPENCODE_CONFIG` 指定的私有配置会被读取并生效 | probed（真实二进制，Linux） | 实跑：该路径的配置被采用 | |
| `{env:VAR}` 会被展开；`$VAR` **不会** | probed（真实二进制，Linux） | 实跑：`{env:}` 到达服务端是真实值，`$VAR` 是字面量 | 这条推翻了旧文档里的 `$VAR` 结论 |
| `provider.<id>.name` 与 `models.<id>.name` 被接受 | probed（真实二进制，Linux） | 实跑 | |
| `@ai-sdk/openai-compatible` 自行拼 `Authorization: Bearer <apiKey>`，因此 apiKey 必须是裸 token | probed（真实二进制，Linux） | 实跑：喂完整 header 值得到 `Bearer Bearer <token>` | 非 Bearer scheme 的 header 路线**未验证** |
| provider 包在运行时无需联网下载 | probed（真实二进制，Linux），**不确定** | 实跑未观察到网络拉取，1.2 s 完成 | 表述为"看起来是内置的，仅 Linux 观察"，不是定论 |
| `session/new` 返回 model 分类的 config option（`currentValue` 反映私有配置的 `model`） | probed（真实二进制，Linux） | 实跑返回值 | 出厂仍选 `launch`，见 §5 |
| 文本轮次的 update 类型：`available_commands_update` → `agent_message_chunk`，prompt 响应 `stopReason: "end_turn"` 带 usage | probed（真实二进制，Linux） | 实跑 | 供驱动侧参考，本 Pack 无需改动 |
| 全局技能路径 `~/.config/opencode/skills/` | declared | opencode 文档 + 二进制里的 `config = (XDG_CONFIG_HOME \|\| <home>/.config)/opencode` | Windows 上的实际落点未验证 |
| `instructions` 数组里的**绝对路径**会被读取，内容进入模型消息 | probed（真实二进制，Linux） | 私有配置写入一份带标记文本的绝对路径，mock 端点收到的 messages 里出现该标记 | Windows 未复跑 |
| `tools` 是 工具名 → 布尔 的映射（`additionalProperties: boolean`） | declared（1.18.29 自带配置 schema + config 文档 "Tools"） | schema 的 `Config.tools`；文档示例 `{"write": false, "bash": false}` | |
| `"tools": {"question": false}` 被真实引擎接受，整轮正常完成 | probed（真实二进制，Linux） | 实跑：initialize/session/new/prompt 全通过 | **但同一次实跑里，带不带这个键，模型拿到的工具表都是 `bash, edit, glob, grep, read, skill, task, todowrite, webfetch, write`，没有 `question`** —— ACP 路线上可能根本不注册它，此项是防御，不是"观察到的移除" |
| `question` 是引擎侧的工具/权限名 | declared | 1.18.29 配置 schema 的权限键含 `question`；同一二进制的 TUI 里有 `{name:"question"}` 渲染器；`question.asked` + `POST /question/{id}/reply` 通道 | |
| `external_directory` 是权限键，默认 `ask` | declared | 1.18.29 配置 schema 的 `PermissionConfig` 含该键；`docs/research/T03-opencode.md` 第 151 行给出默认值 | 默认值本身来自文档，未用真机反证 |
| `shell` 配置项存在，且"compatible shells are also used for agent tool calls" | declared | config 文档 "Shell" 一节；1.18.29 schema 里 `shell` 的描述是 "Default shell to use for terminal and bash tool" | win32 分支未在 Windows 上实跑；两个分支由注入式探针在单测里覆盖 |
| `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` / `XDG_STATE_HOME` 决定引擎自己的四个目录 | probed（真实二进制，Linux）+ declared（二进制内的解析代码无平台分支） | 实跑：`opencode.db`、`log/`、`models.json`、`locks/` 全部落在私有根下 | Windows 未复跑 |
| 只留 `XDG_CONFIG_HOME` 镜像、删掉 `OPENCODE_CONFIG` 也能加载到同一份配置 | probed（真实二进制，Linux） | 实跑：模型与 instructions 均生效 | 证明镜像就是文档里的"全局配置" |
| `OPENCODE_CONFIG_DIR` 被接受（与 `OPENCODE_CONFIG` 并存不冲突） | probed（真实二进制，Linux） | 实跑：设置后整轮正常 | 目录内 `agents/commands/plugins` 的实际扫描未单独验证 |
| 权限：默认全允许；`"permission": {"edit":"ask","bash":"ask"}` 才触发 `session/request_permission` | probed（真实二进制，Linux/Windows） | `edit: ask` 下 `write` 触发提问，载荷含 diff | `bash: ask` 未观察 |
| 完整审批回路：`GET /permission` → `POST /permission/{id}/reply` → 引擎继续/放弃 | probed（真实二进制，Linux/Windows） | `scripts/e2e` 的 `case2`（`once`）与 `case2b`（`reject`） | 请求的 `permission` 字段为 `write`（§4.3） |
| 网关 → 进程宿主 → ACP 驱动 → 真实引擎 → 模型服务（mock）整条链路，含 Office/Desktop MCP 往返 | probed（真实二进制，Linux/Windows） | `npm run e2e -- --engine opencode --expect-desktop-mcp`，见 §11 | Windows 端到端冒烟 20/21（2026-09-09） |
| 可执行文件解析顺序、平台感知校验与错误码 | probed（本仓库代码，假文件系统） | `tests/adapters/opencode/executable.test.ts`（14 例） | 纯逻辑测试，不涉及真实二进制 |
| 私有配置不落盘凭据、不写用户目录 | probed（本仓库代码，真实临时目录） | `native-config.test.ts`（17 例）、`assets.test.ts`（4 例） | 断言序列化文本不含明文密钥、不含 `$VAR` |
| Pack → 驱动接缝（launch 请求、私有配置、握手） | probed（假 ACP 对端） | `pack.test.ts`（3 例） | 假引擎，不是真实 OpenCode 进程 |

`mcpCapabilities` 那一行的原文摘录（2026-09-07，Linux x64，`/tmp/ocl/package/bin/opencode`（`opencode-ai@1.18.29` 的平台包），`opencode acp` 后发一条 `initialize`，全过程不涉及任何凭据）：

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": true },
    "promptCapabilities": { "embeddedContext": true, "image": true },
    "sessionCapabilities": { "close": {}, "fork": {}, "list": {}, "resume": {} }
  },
  "authMethods": [
    { "description": "Run `opencode auth login` in the terminal", "name": "Login with opencode", "id": "opencode-login" }
  ],
  "agentInfo": { "name": "OpenCode", "version": "1.18.29" }
}
```

`config/engines/opencode.json#capabilityEvidence` 因此从 `"unverified"` 改为 `"probed"`：有真实二进制的观察结果（Linux 与 Windows 原生均有），但**没有一条连的是真实内网模型端点**，所以不是 `"verified"`。

## 8. 仍然只能靠真机证实的点

1. **真实内网模型端点**：Windows 原生把 `opencode.exe` 拉起来跑 ACP 这条路径已经有真机证据（§11，模拟模型服务），但对内网端点——鉴权头、appid、私有 CA、代理、真实的流式工具调用格式——没有任何观察。这是 `verified` 唯一还欠的东西，只能由 C 线在授权环境出具。
2. **`npm i -g opencode-ai` 在 Windows 上的实际落点**：`%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe` 是按 npm 布局 + postinstall 目标推出来的，需要在真机上 `dir` 一次核对；`wellKnownPaths` 的顺序也该按核对结果复查。
3. **AVX2 与 baseline 包的选择**：`opencode-windows-x64-baseline` 只在 CPU 无 AVX2 时被 postinstall 选中，本 Pack 只是把它列进探测顺序，没有真机对照。
4. **Windows 上的技能扫描落点**：`OPENCODE_CONFIG` 只管配置文件；技能依赖 `OPENCODE_CONFIG_DIR/skills/` 与 `<xdgConfigHome>/opencode/skills/` 两处，Linux 上的目录解析已从二进制读实，Windows 真机上到底认哪一份未验证。
5. **四个 `XDG_*` 在 Windows 上是否照样生效**：二进制里的解析代码没有平台分支（§3），这是代码证据不是运行证据。若真机上不认，OpenCode 的数据/缓存/锁会落到运维人员的真实档案里 —— 那是脏，不是坏（配置隔离仍由 `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` 保证），但**修法绝不是把 `USERPROFILE`/`APPDATA` 重定向回去**。
6. **win32 的 `shell` 回退**：`bash.exe` 三处探测（Git 两个安装位置 + `PATH`）与写入 Windows PowerShell 绝对路径这两条分支，都只在注入式探针的单测里跑过，没有在真 Windows 上让引擎用这个 shell 执行过一次 `bash` 工具调用。
7. **关掉 `question` 是否真的改变了什么**：Linux 的 ACP 实跑里，带不带 `tools.question=false`，模型拿到的工具表都没有 `question`（§7）。这个键是防御性的：配置被接受、无副作用，但"它挡下了一次反问"没有观察到过。
8. **非 Bearer scheme 的 `Authorization`**：走 `options.headers` 的路线没有端到端跑过。
9. **`nativePermissions: "ask"` 的剩余边界**：Linux/Windows 上均已观察到 `edit: ask` 触发 `session/request_permission`，且 `allow_once` 与 `reject_once` 两条分支都实跑过（§4.2、§11）；`bash: ask` 尚未观察。`external_directory: "allow"` 写进去之后被接受（整轮正常完成），但"不写就会被拦下"没有做反证实验。
10. **provider 包是否真的完全内置**：Linux 上没观察到网络拉取，但没有做隔离网络的对照实验；Windows 上完全未知。
11. **`NODE_EXTRA_CA_CERTS` 与 `NODE_TLS_REJECT_UNAUTHORIZED` 对 Bun 编译产物是否生效**：文档层面成立，未实测。代理变量的透传同理 —— 变量确实进了子进程环境（单测断言），但没有对着真实代理跑过。

## 9. 配置样例

`config/engines/opencode.json` 相关片段（凭据从不出现在此文件里）：

```json
{
  "executable": {
    "defaultKind": "exe",
    "exe": {
      "configuredPath": null,
      "environmentVariable": "PNP_OPENCODE_EXE_PATH",
      "wellKnownPaths": ["${APPDATA}\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe"]
    }
  },
  "nativePermissions": "engine-default",
  "model": { "policy": "launch" },
  "headerEnvironmentPrefix": "PNP_OPENCODE_HEADER_"
}
```

部署时按需覆盖：设 `PNP_OPENCODE_EXE_PATH`，或直接改 `configuredPath` 指向已确认的安装位置（不要把某台机器的用户名/路径提交进仓库）。生成的私有 `opencode.json`（运行时写在 `nativeDataDirectory` 下，不进版本库）形状如下：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "acme-internal/acme-large-v3",
  "share": "disabled",
  "provider": {
    "acme-internal": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "PNP acme-internal",
      "options": {
        "baseURL": "https://model.internal.example.invalid/v1",
        "apiKey": "{env:PNP_OPENCODE_HEADER_API_KEY}",
        "headers": { "X-App-Id": "{env:PNP_OPENCODE_HEADER_X_APP_ID}" }
      },
      "models": { "acme-large-v3": { "name": "acme-large-v3" } }
    }
  },
  "permission": { "external_directory": "allow" },
  "tools": { "question": false },
  "instructions": ["<nativeDataDirectory>/opencode/assets/instructions/inst-competition/COMPETITION.md"]
}
```

`permission` 与 `tools` 见 §4.2：前者随有效策略变化（默认 allow 时至少有 `external_directory: "allow"`；
`nativePermissions` 设为 `"ask"` 时再加 `"edit": "ask"` 与 `"bash": "ask"`），后者恒定。`instructions` 只在集成档
真的带了 instruction 资产时出现。win32 且找不到 `bash.exe` 时还会多一行
`"shell": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"`（`%SystemRoot%` 展开自子进程环境，
未设置时退回 `C:\Windows`）；其它情况不写这个字段，由 OpenCode 自己发现。

不改文件也可以，用环境变量覆盖（见 §4.2）：

```powershell
$env:PNP_OPENCODE_NATIVE_PERMISSIONS = "ask"    # engine-default | ask；空或未设＝用文件里的值
```

配到 `.env.example` 里同名注释块。合法值只有这两个，别的值让网关以 `ENGINE_CONFIG_INVALID` 拒绝启动，而不是悄悄退回
"什么都允许"。要让请求真的停在 `GET /permission` 上等人回答，集成档还要把对应 operation 设成 `"ask"`，例如：

```json
{ "policy": { "default": "allow", "operations": { "write": "ask" } } }
```

## 10. 测试

`tests/adapters/opencode/` 共 70 例，已由 `scripts/test.mjs unit` 覆盖（该脚本的 `unit` 组包含 `tests/unit` 与 `tests/adapters`）：

```
node scripts/test.mjs unit          # 全量；含本 Pack 的 70 例
node --experimental-strip-types --test tests/adapters/opencode/config.test.ts               # 15 例
node --experimental-strip-types --test tests/adapters/opencode/executable.test.ts           # 14 例
node --experimental-strip-types --test tests/adapters/opencode/native-config.test.ts        # 23 例
node --experimental-strip-types --test tests/adapters/opencode/assets.test.ts               #  4 例
node --experimental-strip-types --test tests/adapters/opencode/pack.test.ts                 #  8 例
node --experimental-strip-types --test tests/adapters/opencode/settings-permissions.test.ts #  6 例
```

覆盖的关键点：exe 默认解析与每条 well-known 路径（含 `${APPDATA}` 展开、未设置变量则跳过）、非 Windows 平台接受 POSIX 绝对路径而 Windows 目标仍强制 `.exe`、`{env:}` 令牌且不出现 `$VAR` 值、provider/model 的 `name` 字段、`OPENCODE_CONFIG` 指向私有文件且两份副本逐字节一致、`nativePermissions` 两种取值与 `PNP_OPENCODE_NATIVE_PERMISSIONS` 覆盖（未设置/空串/两个合法值/非法值必须失败）、配置文件不含明文凭据。本次新增：

- **指令**：一个 instruction 资产经 `open()` 走完投影→生成配置后，`instructions[0]` 是绝对路径、位于私有树内、**能读出资产原文**；三个资产（其中两个同名文件）各自成条、顺序不变、目标互不覆盖。
- **`tools`**：三种策略组合下生成的配置都带 `{"question": false}`。
- **`external_directory`**：默认 allow 且无人指名时写 `allow`；策略指名 `ask`/`deny` 时按策略投影为 `ask`；策略指名 `allow` 时保留 `allow`（这是唯一不因"与默认相同"而被省略的键）；默认为 `ask` 时由 `"*": "ask"` 承担，不额外插入。
- **`shell`**：注入式探针覆盖 win32 无 `bash.exe`（写 PowerShell 绝对路径，含 `SystemRoot` 缺失的兜底）、Git 两个安装位置或 `PATH` 上有 `bash.exe`（不写）、以及非 win32（不写）。
- **子进程环境**：`caFile` → `NODE_EXTRA_CA_CERTS`；`tlsInsecure === true` 才有 `NODE_TLS_REJECT_UNAUTHORIZED=0`（`false` 与缺省都没有）；代理变量按网关环境透传、空值不导出、网关没有时子进程也没有。
- **重定向清单**：交付的 `config/engines/opencode.json` 里 `redirect.variables` 的键恰好是四个 `XDG_*`，且 `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` 不在其中；`buildRedirectPlan` 不会凭空造出这四个档案变量；`open()` 之后子进程 `LaunchSpec.env` 里也没有它们。

驱动侧的 operation 取名（§4.3）在 `tests/adapters/acp/permission.test.ts` 与 `tests/adapters/acp/updates.test.ts`（`nameOf`）里：只有 `title=路径` + `kind=edit` 的请求，在同一 `toolCallId` 被 `tool_call` 以 `name: "write"` 宣告过之后必须记成 `write`；没宣告过时 `kind` 优先于自由文本 `title`。

编写测试时注意：`scripts/test.mjs` 走 Node 官方 `--experimental-strip-types`，它是纯词法剥离器，比 `tsc` 笨得多。不要用 `declare` 之类会被类型擦除器误读的标识符做方法名（`private declare(...)` 会被读成 TS 的 `declare` 修饰符，剥离后是非法 JS）。`scripts/strip-only-check.mjs` 会对 `src/**` 逐文件复现这个变换并只做解析，专门守住这一类问题。

## 11. 端到端冒烟：真实二进制走完整条网关链路

`scripts/e2e/`（`npm run e2e -- --engine opencode`）把整条链路真的跑一遍：网关进程（`dist/main.js`）→ 进程宿主 → ACP 驱动 → **真实 `opencode` 二进制** → 模型服务。只有模型服务是 mock（`scripts/e2e/mock-model-server.mjs`，OpenAI Chat Completions 形态，绑定 127.0.0.1，按最新一条用户消息选剧本，无工具的请求——包括 OpenCode 的标题生成旁路调用——永远只回纯文本）。北向客户端只用 `fetch` 打通用网关协议。

opencode 腿额外把**评测方的审批回路**真的驱动一遍：编排器只设 `PNP_CONFIGURED_POLICY_OVERRIDES={"write":"ask"}`（网关侧只对 `write` 停下来问），
Pack 把这份有效策略投影到会话私有 `opencode.json`，引擎据此发出 `session/request_permission`；早期版本靠 `PNP_OPENCODE_NATIVE_PERMISSIONS=ask` 强制引擎侧提问，冒烟已不再设置它。北向客户端于是走的
是评测方的动作序列：`prompt_async` **不等**返回（它只在整轮结束时才答）→ 每 250 ms 轮询 `GET /permission` →
`POST /permission/{id}/reply` → 再等 `prompt_async` 落 204。

Linux 上对 1.18.29 的实跑结果（probed；当时为契约 1.0，网关**不**在 development 模式，`PNP_INTEGRATION=configured`）：14/14 通过，含

- 不带 `model` 的 `prompt_async` 返回 204，并在 provider 的默认模型上完成（这条曾经是 409 `ENGINE_MODEL_SWITCH_UNSUPPORTED`，根因在 Core 把调用方的空选择原样交给驱动，已修）；
- 文本轮次：最终 assistant 消息 `finish: "stop"`，以 `step-finish` part 结尾，正文含标记，证明请求真的到达了模型服务；
- 工具轮次（`case2`，批准）：`GET /permission` 在第 2 次轮询（约 260 ms）就给出一条待批请求，`permission` 字段是 **`write`**
  （不是文件路径 —— 这正是 §4.3 那条修复的证据），`sessionID` 是本会话，载荷带 `content: [{type:"diff", path: <目标文件>, newText:"hello-from-e2e"}]`、
  `locations`、`rawInput: {filepath, diff}`、`options: [allow_once, allow_always, reject_once]`；`{"reply":"once"}` 得到 200 `{ok:true}`，
  **对同一个 id 再回一次得到 404 `NOT_FOUND`**（一次审批不会被重复消费）；随后 `prompt_async` 落 204，assistant 消息
  `finish: "tool-calls"` 带 `write`，随后 `role: "tool"` 消息，最后 `finish: "stop"`，工作区里出现 `e2e-output.txt` 且内容正确；
- 工具轮次（`case2b`，拒绝）：对另一个文件名重复上述回路并回 `{"reply":"reject"}`，`prompt_async` 同样落 204，
  工具结果如实记为 `status: failed` / "The user rejected permission to use this specific tool call."，
  **目标文件不存在**（ENOENT），会话回到 `idle`；跑完之后 `GET /permission` 为空，没有悬挂的待批请求；
- SSE 事件序列里出现 `permission.asked` 与 `permission.resolved`（`src/core/interactions.ts` 发布），opencode 腿把这两个类型也列进 `event-sequence` 的必需集合；
- 中断：对一个在模型侧挂住的轮次 `POST /session/{id}/abort` → 200，`prompt_async` 以 409 `EXECUTION_CANCELLED` 收尾，最终消息 `finish: "cancelled"`、原生 `stopReason: "cancelled"`，会话回到 `idle`，第一次尝试即命中；
- 会话删除后 404；第二个会话在同一进程内正常；SSE 事件序列合法；`hosts/*.json` 归属记录存在；工件里没有凭据（mock 的 Authorization 值被脱敏为 `[redacted]`）。

上面这段是契约 1.0 时期的 Linux 记录，其中 abort 收 409 的行为已按 D5 改为 204 + `finish: "cancelled"`。契约 1.1 把 ACP 工具更新改为逐字段 `tool.observed` 后，D1–D3 落地时又在 Linux 上重跑过一次（14/14，模型端点仍是 mock）：`case2` 的 assistant 消息带 `tool_calls: ["write"]` 与 `info.finish: "tool-calls"`，`role: "tool"` 消息的 `tool_name` 是 `write`，三条观察 part 的 `state.nameSource` 全部是 `announced-title`，`state.title` 依次是 `write`、`write`、被引擎改写后的目标文件路径，最终 assistant 消息 `finish: "stop"`。这两次 Linux 结果只证明进程、协议、权限与模型链路曾经跑通；当前证据是下面的 Windows 记录。

**当前证据（2026-09-09，Windows x64 / Node 24.19.0，契约 1.1，交付 `settings.json` 原样，含 Office/Desktop MCP 与指令文件）**：`npm run e2e -- --engine opencode --expect-desktop-mcp` 21 项中 20 通过、0 失败、1 跳过（`concurrency/same-session-busy`，由 mock 对照组覆盖）。检查项：`health-ready`、`event-stream-open`、`create-session`、`create-session-missing-directory`、`case1/prompt-without-model`、`case1/hello-trace`、`case2/write-file`（`once`）、`case2b/permission-rejected`（`reject`）、`mcp/csv-read`（Office MCP，中文与空格路径）、`mcp/missing-file`（真实工具错误回到模型）、`mcp/desktop-discovery`（Desktop MCP）、`case3/abort`（204 + `cancelled`）、`question-and-permission`、`session-lifecycle`、`second-session/*`、`concurrency/create-sessions`、`concurrency/cross-session-queue`、`event-sequence`。真实 `opencode.exe` 由 `PNP_OPENCODE_EXE_PATH` 指向已校验 SHA-256 的 `opencode-windows-x64@1.18.29`，由网关的 Windows 进程宿主拉起。另据 `docs/team/handoff-settings-mcp-2026-09-09.md`，同一构建对本机配置的公网 OpenAI 兼容模型跑 `live-check` 8/8（真实写文件、同会话历史、取消、删除会话后文件保留）。**Windows 原生 + 真实二进制 + mock 模型端点**已经观察到；真实内网模型端点仍须由 C 线在授权环境验收。

**CI 边界，如实说明**：生效的工作流是仓库根目录的 `.github/workflows/ci.yml`（125 行），它有两个作业：`shared-contract`（windows-latest + ubuntu-latest 上 `npm ci`、`foundation:check`、`build`），以及 `engine-smoke` —— 一个六腿矩阵，其中包含 **windows-latest × opencode** 与 **windows-latest × pi**，用 `npm i -g opencode-ai@1.18.29` 装出真实 `opencode.exe` 后运行 `scripts/e2e/ci-smoke.mjs`，并上传产物。所以真实引擎冒烟**在 CI 里是有的**，模型服务是其中唯一被 mock 的部件。

注意 `engineering/.github/workflows/ci.yml` 是一份 22 行的**陈旧副本**：GitHub 只读取仓库根的 `.github/workflows/`，这份不会被执行，且其 `working-directory: code` 对当前目录结构也是错的。它只应被当作历史遗留，不要据它判断 CI 覆盖面。

本地等价命令是 `npm run e2e`，结果记录在 `verification/results.json`，原始产物在 Git 忽略的 `code/runtime/logs/`。
