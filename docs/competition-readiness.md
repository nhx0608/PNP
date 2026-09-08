# 赛题符合性总审查与整改方案（2026-09-08，基线 master `adfee9d`）

依据：赛题任务书、调测指南、《Agent 网关接口规范》v1.1、评测数据样例（office_002/011/014/015/018/022/028/035/103/132/139）。方法：先推演评测方在沙箱里会做什么，再对照仓库逐条核对（四路并行审计：HTTP 接口、模型配置、工具/指令/权限、安装/启动/打包），最后给出裁决与工作包。本文只写裁决与方案，实现由后续提交按工作包落地。

## 0. 结论

现状：网关 HTTP 接口与规范逐条对得上（12 个端点、SSE 头与事件、8.4 完成规则、错误格式），OpenCode 在 Windows 真机 + 真二进制 + mock 模型下走通；Pi 驱动代码已合入并对真实 0.85.1 探测过。**但按"裁判解压 zip、照 INSTRUCTION.md 操作"的口径，今天的交付件跑不起来，跑起来也做不了评测任务。** 阻断项：

1. INSTRUCTION.md 第 2 节要求执行的 `npm run foundation:check` 在 zip 内必然失败（`tests/` 不打包）；文中引用的 `engines.lock.json`、`coverage.md`、`release:check` 都不在 zip 里；`pnp.cmd` 既不在 zip 里也不在说明书里；说明书从未告诉裁判要安装 OpenCode、怎么装、Pi 怎么来。
2. 交付包纯源码，`npm ci`、Node 下载、引擎下载三步都要公网或镜像，而镜像说明只在不打包的 QUICKSTART 里；沙箱无公网时必失败。
3. 模型配置有四套互相矛盾的口径（INSTRUCTION 的 `PNP_MODEL_*`、QUICKSTART/SETTINGS.md/local.env.example 的 `PNP_HIS_*`、settings.json 同时声明三个模型、示例里的 `configured-provider/configured-model` 不存在）；appid 一类自定义头没有任何裁判可见的配置方法；`gateway.cmd` 不读 `runtime/local.env`；发给内网端点的模型名固定为 `default`，裁判必须手改 JSON 才能换成真实模型名；内网 http 端点被拒绝启动；自签证书无处配置。
4. 两个引擎都收不到任何行为指令（"不要反问、绝对路径可在工作目录外、输出存到指定位置"），反问没有自动应答（阻塞 45 s 后拒绝）；Pi 在交付路径下收不到任何工具（settings 只产 MCP 绑定，Pi 桥只接 cli/native）；没有任何 Office 文档能力，任务全靠模型在 `bash` 里猜库；Pi 的 Windows `bash` 默认要 Git Bash。
5. Pi 读取 `authorization` 小写而 settings 产出 `Authorization`，交付配置下 Pi 无凭据调用模型（真 bug）。

主观分（架构 20%）的正面资产已经在：分层与契约、进程治理、真机证据分级、单一设置文件。整改重点是把这些能力接到裁判能走的那条路上。

## 1. 评测方会怎么做（推演）

1. 在 Windows 沙箱解压 `solution.zip`，读 `INSTRUCTION.md`，做"环境准备"和"服务启动"两步，很可能由脚本自动执行。网络：内网；npm 公网镜像不一定有；Node 不一定装；Office 大概率装了（office_002 要开 Outlook）；Git Bash、Python 不能假设。
2. 设置内网模型：他们有端点、appid（可能还有 API key），只会照说明书设环境变量或改一个明确指出的文件。
3. 用 `AGENT_ENGINE=opencode`（或 `--engine`）启动，等就绪，然后对每条用例：`POST /session {directory}` → `GET /event` → `POST prompt_async {parts, model:{providerID, modelID}}`（`model` 的取值由评测脚本定，我们不掌握）→ 等 204 / `session.idle` → `GET /session/{id}/message` 取轨迹 → 检查产物文件 → `DELETE`。然后换 `AGENT_ENGINE=pi` 再来一遍，每题取两引擎最高分。
4. 裁判模型看的是轨迹 + 产物：文件是否在要求的绝对路径生成、内容是否符合要求；反问会直接导致该题失分。

由此得到的硬约束：**零人工、可离线、一份口径、不反问、绝对路径、两引擎同能力**。

## 2. 问题清单

### P0 阻断（裁判走不通）

| # | 问题 | 位置 |
|---|---|---|
| A1 | INSTRUCTION.md §2 的 `npm run foundation:check` 依赖 `tests/`，zip 不含；§1/§7 引用不在包内的 `engines.lock.json`、`coverage.md`、`release:check`、`VERIFY.mjs` | `engineering/INSTRUCTION.md:5,11,18,129`；`scripts/package-release.mjs:31-33` |
| A2 | `pnp.cmd` 不在打包白名单，说明书里也没有；裁判只拿到不做任何准备的 `gateway.cmd` | `package-release.mjs:31-32` |
| A3 | 说明书没有引擎安装步骤；OpenCode 靠 `%APPDATA%\npm` 探测，干净沙箱到第一次 prompt 才 503 `ENGINE_EXECUTABLE_NOT_FOUND` | `config/engines/opencode.json:41-47` |
| A4 | Pi 没有安装器、没有锁、没有说明；第二引擎从交付文档出发启动不了 | `scripts/pnp-local.ps1:311`、`config/engines/pi.json` |
| A5 | 纯源码包 + 打包自检禁止 `node_modules`/`dist`；无公网即失败；镜像变量只在不打包的 QUICKSTART | `package-release.mjs:84-86`、`QUICKSTART.md:274-292` |
| A6 | `pnp.cmd` 缺 `--engine` 直接退出 2，只设 `AGENT_ENGINE`（任务书的硬要求）走不通 | `pnp.cmd:56-59` |
| A7 | 模型口径分裂：说明书 `PNP_MODEL_*`，QUICKSTART/SETTINGS.md/local.env.example `PNP_HIS_*`，settings.json 三个模型并存；`gateway.cmd` 不读 `runtime/local.env`；`local.env.example` 的 `PNP_SETTINGS` 相对路径会被代码拒绝 | 见 §3 审计 |
| A8 | 发往内网端点的模型名固定为 settings 里的 `modelID`（`default`），裁判必须改 JSON；appid 头无裁判可见的配置入口；`http://` 内网端点被 `INSECURE_MODEL_ENDPOINT` 拒绝；`caFile` 在契约里但没有任何来源，自签证书无解 | `settings.json`、`settings.ts:159-162`、`contracts/index.ts:192` |
| A9 | Pi 读 `model.headers.authorization`（小写），settings 产出 `Authorization`，交付配置下凭据丢失 | `src/drivers/pi-rpc/launch.ts:144` |

### P1 失分（跑得起来但任务做不成）

| # | 问题 | 位置 |
|---|---|---|
| B1 | 两个引擎都收不到任何指令；`assets` 永远为空，instruction/skill 投影是死代码；Pi 没有 `--append-system-prompt` 接线 | `configured/provider.ts:100`、`native-config.ts:232`、`launch.ts:82-90` |
| B2 | 反问无自动应答：`question` 阻塞 45 s 后按拒绝处理；OpenCode 的 `question` 工具没有关掉 | `interactions.ts:78-99` |
| B3 | Pi 在交付路径下收不到任何工具（settings 只产 `mcp-stdio`/`mcp-http`，Pi 桥只接 `cli`/`native`）；Pi 没有 web 工具 | `tool-bridge.ts:32-40` |
| B4 | 没有 Office 文档能力；docx/xlsx/pptx/csv 全靠模型在 shell 里猜库；沙箱未必有 Python | — |
| B5 | Pi 在 Windows 默认用 Git Bash 跑 `bash`；OpenCode 的 shell 未配置 | pi `docs/windows.md`；opencode `config.shell` |
| B6 | `http://` 内网 MCP 端点被拒绝；MCP `command` 必须绝对路径，settings 无法引用包内路径 | `settings.ts:259-268`、`integration/index.ts:216` |
| B7 | OpenCode `external_directory` 默认 `ask` 未建模（当前靠策略 allow 自动放行，一旦有人按 SETTINGS.md 示例设 ask 就全部阻塞） | `native-config.ts:197`、T03 §151 |
| B8 | OpenCode 子进程的 `HOME/USERPROFILE/APPDATA/LOCALAPPDATA` 被重定向到私有目录，Office COM / Outlook 的每用户状态会看到假档案 | `config/engines/opencode.json:60-68` |
| B9 | 权限策略未覆盖 pi 内建工具；凭据落盘；`agent_end` 兜底伪成功（第三轮评审 §16 A/B/F） | `docs/engineering-review-3.md` §16 |

### P2 稳健/规范细节

| # | 问题 |
|---|---|
| C1 | abort 后 `prompt_async` 返回 409 `EXECUTION_CANCELLED`，规范示意 204；`contracts.md` §3.3 记为未决 |
| C2 | `parts[].content` 不被接受（规范请求体用 `text`，但投影用 `content`，客户端易混） |
| C3 | 停止未证实（`interrupted`）时不发 `session.idle`/`session.error`，只看 SSE 的客户端会挂 |
| C4 | `permission reply=always` 降级为 once（契约禁止引擎级 allow_always，但网关可记住本会话同操作） |
| C5 | `pnp.cmd`/`gateway.cmd` 无 `chcp 65001`；`gateway.ps1` 无执行策略保护；Node 版本门槛只在 `pnp-local.ps1` 里检查 |
| C6 | `PNP_MODEL_STRICT=1` 在三处示例里被推荐，评测下等于每次 403 |
| C7 | 公开仓库出现 `his/*`、`PNP_HIS_*`（E 项，仍待用户定）、人名、手机号作者名 |
| C8 | 说明书缺：日志位置、停止方式、`prompt_async` 15 分钟上限、就绪判定、产物说明 |

## 3. 裁决与方案

### D1 一份启动口径：`pnp.cmd` 是裁判入口，`gateway.cmd` 是"已备好依赖"的直达入口

- `pnp.cmd start`（以及 `bootstrap`、新增 `selfcheck`）在没有 `--engine` 时读 `AGENT_ENGINE`；两者都无才失败。`gateway.cmd` 不变。两者都执行 `chcp 65001 >nul`。
- `runtime/local.env` 的加载搬进 `src/main.ts`（存在即加载，`PNP_LOCAL_ENV_FILE` 可改路径，只打印变量名），这样 `gateway.cmd`、`npm start`、`pnp.cmd` 三条路看到的环境一致；`pnp-local.ps1` 仍先加载一次以取镜像变量。
- `PNP_SETTINGS`、`PNP_CONFIGURED_PROFILE`、`PNP_MODEL_CA_FILE` 等路径类变量允许相对路径，以 `code/` 为基准解析（当前"必须绝对"的规则只对不可信来源保留）。

### D2 可离线交付：把运行时装进 zip

- `scripts/package-release.mjs` 增加 `--bundle`（solution.zip 的正式模式）：额外打入 `pnp.cmd`、`dist/`、生产 `node_modules/`（`npm ci --omit=dev` 的结果）、`runtime/bootstrap/node-v24.19.0-win-x64/`（官方 zip 校验后解压）、`runtime/bootstrap/engines/opencode/1.18.29/`、`runtime/bootstrap/engines/pi/0.85.1/`、依赖与构建的 stamp 文件。自检改为只禁止凭据、运行数据（`data/`、`*.db`、日志、私钥）与 `runtime/local.env`；`--source-only` 保留旧行为。
- `pnp-local.ps1` 的查找顺序：Node = `PNP_NODE_HOME` → 包内 `runtime/bootstrap/node-*` → PATH 上 24.19+ → 下载；依赖 = `node_modules` 存在且 stamp 匹配则跳过 `npm ci`；构建 = `dist/main.js` 新于 `src/**` 或 stamp 匹配则跳过；引擎 = `PNP_*_EXE/ENTRY` → 包内 `runtime/bootstrap/engines/<id>/<version>` → `npm install`。全部命中时零网络、零 npm。
- 打包在 Windows 上执行（引擎平台包为 win-x64）；打包脚本在非 Windows 上运行时用 `npm install --os win32 --cpu x64` 拉平台包，Node zip 直接下载。

### D3 模型配置：一份 settings、四个环境变量、任意 providerID/modelID

- 交付的 `config/settings.json` 只保留一个模型：`competition`。模型条目新增可选字段（环境变量**名**）：`modelIDEnvironment`（端点侧真实模型名，加载时替换 `selection.modelID`）、`apiKeyEnvironment`（值以 `Authorization: Bearer <值>` 发送）、`headersEnvironment`（值为 JSON 对象，任意附加头，如 appid）、`caFileEnvironment`（PEM 路径 → 引擎进程 `NODE_EXTRA_CA_CERTS`）。`headerEnvironment`（名→变量名）保留兼容。`common.model.default` 可只写 `providerID`，该 provider 唯一条目即默认。
- 裁判只需设：`PNP_MODEL_ENDPOINT`（必）、`PNP_MODEL_ID`（必，端点侧模型名）、`PNP_MODEL_API_KEY`（选）、`PNP_MODEL_HEADERS`（选，JSON）、`PNP_MODEL_CA_FILE`（选）。`prompt_async` 的 `model` 任意取值都映射到该模型（现有替换机制），说明书明说这一点；`PNP_MODEL_STRICT` 从所有示例删除。
- 端点规则：`https` 或回环 `http` 默认允许；`PNP_ALLOW_HTTP_MODEL_ENDPOINT=1` 显式放开内网 `http`；`PNP_MODEL_TLS_INSECURE=1` 给引擎进程设 `NODE_TLS_REJECT_UNAUTHORIZED=0`（说明书标注为最后手段）。同样规则用于 MCP 远端 URL。
- `his/*` 条目移出交付 `settings.json`；`settings.his.example.json`、`local.env.example` 改为通用示例（`PNP_MODEL_*`），HIS 标识是否保留在示例文件里仍待用户定（E 项）。
- Pi：`models.json` 只写 `$PNP_PI_*` 变量名（pi 的 Value Resolution），真值只进 `LaunchSpec.env`；`headers` 全量投影；头名大小写不敏感；`caFile` 同样投影。

### D4 指令与工具：设置文件是两引擎共同的真相源

- `settings.json` 新增 `common.instructions: [路径]`（相对设置文件目录），`cores.<id>.instructions` 覆盖；交付 `config/instructions/competition.md`（无人值守、不反问、绝对路径、产物落盘、Windows/PowerShell、优先用提供的 office 工具、结束时列出产物绝对路径）。`ConfiguredIntegration.prepare` 产出 `assets:[{kind:"instruction"}]`（经现有 resolver 计算摘要）；OpenCode 走已有的 `instructions` 投影；Pi 走 `--append-system-prompt <正文>`。
- MCP `command`/`args`/`url` 支持 `${PNP_CODE_ROOT}`、`${PNP_NODE}` 两个占位符（加载时解析为绝对路径），使交付的 settings 能引用包内工具；`${ENV:NAME}` 不支持（凭据仍走 `env`/`headerEnvironment` 变量名）。
- 交付一个 **Office MCP 服务器**（`src/tools/office-mcp/`，stdio，Node 实现，依赖已锁定：`@modelcontextprotocol/sdk`、`jszip`、`fast-xml-parser`、`exceljs`、`docx`、`pptxgenjs`、`csv-parse`），在 `settings.json` 默认启用，工具集：`docx_extract`（段落/表格 → JSON，含段落索引）、`docx_replace_paragraphs`（按索引/匹配替换正文，保留首个 run 的格式）、`docx_create`（结构化内容 → docx）、`xlsx_read`（按 sheet → 行）、`xlsx_write`（多 sheet）、`pptx_extract`（每页文本框）、`pptx_replace_text`/`pptx_reorder_slides`、`pptx_create`（大纲 → pptx）、`csv_read`（含基本统计）、`fs_find`/`fs_delete`（按名称包含、递归、返回实际删除清单）、`app_open`（`Start-Process`）、`web_fetch`（GET → 文本，走代理环境变量）。每个工具返回结构化结果，写类工具 `sideEffect: "write"`，`fs_delete` 与 `app_open` 为 `external`。
- Pi 的扩展改为**MCP 客户端桥**（构建产物 `dist/pi-extension/`，不再生成源码文本）：从 sidecar 读取本会话的 MCP 服务器清单（变量名，不含值），在 pi 进程内用 MCP SDK 连接 stdio/http 服务器，为每个远端工具 `registerTool`；同一扩展注册 `tool_call` 钩子做策略桥接（§16 A）。这样 `mcp.servers` 对两引擎等价。
- Windows shell：Pi 在会话私有 `PI_CODING_AGENT_DIR/settings.json` 写 `defaultTools`（win32：`read, powershell, edit, write, grep, find, ls`，仅当发现 `bash.exe` 时加 `bash`）；OpenCode 在 win32 且无 Git Bash 时写 `shell` 为 `powershell.exe` 绝对路径，指令文件同时告诉模型当前 shell 是 PowerShell。
- 反问：`PNP_QUESTION_POLICY=auto`（默认）时，Broker 记录 `question.asked`，立即以第一个选项（无选项则空串）应答并发布 `question.resolved{source:"auto"}`；`=ask` 恢复等待。OpenCode 的 `question` 工具在 `opencode.json` 里关闭（`tools.question=false`）。
- 权限：策略默认 allow 不变；OpenCode 生成配置在有效默认为 allow 时显式写 `external_directory: "allow"`；`reply=always` 在网关记住"本会话 + 本操作"后续自动 allow（不再进入引擎的 allow_always）。
- OpenCode 环境：改用 `OPENCODE_CONFIG_DIR` + `XDG_*` 做私有化，不再改写 `HOME/USERPROFILE/APPDATA/LOCALAPPDATA`；`redirect.variables` 相应收窄。

### D5 接口细节

- abort 后 `prompt_async` 返回 **204**，轨迹 `finish: cancelled`；`contracts.md` §3.3 结案。
- `parts[]` 同时接受 `text` 与 `content`。
- 任何已发布 busy 的 run 结束时都发 `session.status idle` 或 `session.error`；`interrupted` 发 `session.error{code:"EXECUTION_UNCERTAIN"}`。
- 其余非规范状态码保留并在说明书列出。

### D6 Pi 锁定与 CI 证据

- `config/engines/pi.json`：`engineVersion: "0.85.1"`，`distribution: {kind: "npm-node-entry", packageNameCandidates: ["@earendil-works/pi-coding-agent"], entry: "dist/bundle/cli.js"}`；`engines.lock.json` 加 pi 条目（tarball SHA-256）。启动器按 OpenCode 同法安装到 `runtime/bootstrap/engines/pi/0.85.1`，导出 `PNP_PI_ENTRY`/`PNP_PI_NODE`，`node cli.js --version` 核对。
- CI `engine-smoke` 矩阵加 `pi`（ubuntu + windows）：全局安装 `@earendil-works/pi-coding-agent@0.85.1`，`ci-smoke.mjs --engine pi` 用同一个 mock 模型服务器跑同一组端到端检查；windows 腿加 `pnp.cmd bootstrap --engine pi`。
- `pnp.cmd selfcheck --engine <id>`：起 mock 模型 + 网关 + 一条 prompt（写文件到临时目录）并打印 PASS/FAIL；说明书让裁判先跑它验证部署。

### D7 说明书重写（`engineering/INSTRUCTION.md` = `solution/INSTRUCTION.md`）

按任务书四要素组织，面向自动执行：
1. 环境准备：系统要求（Win10/11 x64、Windows PowerShell 5.1、无需管理员）；包内已含 Node/依赖/两引擎，零网络；如需联网/镜像的变量表；解压路径建议（短路径、无空格）。
2. 模型配置：五个环境变量与含义、示例、`selfcheck` 验证；任意 `providerID/modelID` 都映射到该模型。
3. 启动：`set AGENT_ENGINE=opencode` + `pnp.cmd start`（或 `--engine`）；就绪判定 `GET /health/ready` 200；切换引擎 = 停止后换变量重启；停止方式（Ctrl+C / `pnp.cmd stop` 或 `taskkill` PID 文件）；日志文件位置。
4. 调用流程与完成判定：端点列表、请求示例、`prompt_async` 阻塞与 15 分钟上限、8.4 规则、错误码表（含 409/504 等非规范码）。
5. 产物说明：文件写在请求指定的绝对路径；轨迹 `GET /session/{id}/message`；数据目录布局。
6. 工具与扩展：内置 Office 工具、如何增加 MCP 服务器（内网 WeLink 等，`${PNP_CODE_ROOT}` 示例）、如何改指令文件、权限策略。
不再引用包外文件；`QUICKSTART.md` 的内容并入或指向它。

## 4. 工作包

| WP | 内容 | 文件边界 | 验收 |
|---|---|---|---|
| WP1 核心/配置/接口 | D1 的 env 加载与相对路径；D3 的 settings 字段与解析、`ResolvedModel` 扩展（`apiKey` 归入 headers、`caFile`）、`ConfiguredIntegration` 产出 instruction 资产与全量头；D4 的 `${PNP_CODE_ROOT}`/`${PNP_NODE}`、http 放开开关、`PNP_QUESTION_POLICY`、`always` 记忆；D5 三项；交付 `settings.json`、`config/instructions/competition.md`、`SETTINGS.md` | `src/config/**`、`src/integration/**`、`src/core/**`、`src/gateway/**`、`src/main.ts`、`src/contracts/index.ts`、`config/settings*.json`、`config/instructions/`、`config/SETTINGS.md`、`config/local.env.example`、`tests/unit/**`、`tests/contract/**` | 单元/契约测试；`check:boundaries` |
| WP2 OpenCode Pack | `instructions`、`external_directory` 与 `tools.question`、`shell`、`caFile`/TLS 变量、环境重定向收窄 | `src/engines/opencode/**`、`config/engines/opencode.json`、`tests/adapters/opencode/**` | 适配器测试；真实 OpenCode 冒烟不回归 |
| WP3 Pi 驱动 | §16 A/B/E/F 全部；头名大小写；`models.json` 变量名化 + `headers`；`defaultTools`；`--append-system-prompt`；MCP 客户端桥扩展（构建产物）；握手失败区分；`ownerToken` | `src/drivers/pi-rpc/**`、`src/engines/pi/**`、`tests/adapters/pi/**`、`config/engines/pi.json` | 适配器测试含假 MCP 服务器；fixture 走真实 LocalProcessHost |
| WP4 Office MCP | D4 工具集与测试（用真实 docx/xlsx/pptx 夹具往返） | `src/tools/office-mcp/**`、`tests/tools/**` | 每个工具有往返测试；stdio 服务器可被 MCP SDK 客户端列出并调用 |
| WP5 启动器/打包/CI/文档 | D1 `pnp.cmd` 与 `chcp`；D2 bundle 与查找顺序；D6 Pi 安装与 CI；`selfcheck`；D7 说明书；`.env.example`、`QUICKSTART.md` 同步 | `pnp.cmd`、`gateway.cmd/.ps1`、`scripts/**`、`engines.lock.json`、`.github/workflows/ci.yml`、`engineering/INSTRUCTION.md`、`engineering/QUICKSTART.md`、`code/.env.example`、`code/README.md` | `pnp.cmd bootstrap/start/selfcheck` 在 CI windows 腿通过；打包产物自检通过 |

顺序：WP1–WP4 并行（文件不交叉；WP3/WP4 共享的依赖已先于本文提交进 `package.json`），WP5 与前四个并行开工、最后合入并做说明书终稿；合入后跑完整 `npm run check`、真实引擎冒烟（opencode + pi）、`package-release --bundle` 自检，再刷新清单。实现一律由 Opus 承担；本文作者只做合入前审查。

## 5. 需要用户拍板

1. E 项：`his/*`、`PNP_HIS_*` 是否可留在公开仓库的示例文件里（交付 `settings.json` 无论如何移除）。
2. 内网模型端点是 `http` 还是 `https`、是否自签证书、是否需要 appid 以外的头——决定说明书示例。
3. abort 返回 204（本文裁决）是否认可。
4. 交付包体积（约 300 MB，含 Node、两引擎、依赖）是否可接受；不可接受则退回"镜像变量 + 说明书"路径。
5. WeLink（office_028）只能由 C 的 PNP-MCP/1 服务器提供；本轮只留接入示例，不实现。
6. 沙箱是否有 Git Bash / Python 不可知，本方案按"都没有"设计。

## 6. 审计来源

四份审计报告（HTTP 接口、模型配置、工具/指令/权限、安装/启动/打包，2026-09-08）与上游一手文档：pi `docs/models.md`（Value Resolution、Custom Headers）、`docs/extensions.md`（`tool_call` 阻断、RPC 模式 `hasUI=true`）、`docs/rpc.md`（`extension_ui_request` 超时）、`docs/windows.md`（Git Bash 默认、`powershell` 工具与 `defaultTools`）、README（`--tools`、`--append-system-prompt <text>`）；OpenCode `config.mdx`（`OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR`、`instructions`、`shell`）；仓库内 `docs/research/T02`/`T03`。

## 7. 落地记录（2026-09-08）

五个工作包全部合入 master：WP2 `54a2e02`、WP1 `e4403da`、WP4 `28d5371`、WP3 `935fd20`、WP5 `f8e779c`，集成修正 `a822db1` 及其后一提交。合入后的树：`npm run typecheck`、单元测试 447 项（442 通过、5 项 Windows 专属跳过）、契约测试 9 项、边界与 strip-only 检查、`npm run build` 全部通过。

**真实引擎冒烟（本机 Linux，mock 模型服务，交付配置 `settings.json` 原样，含 Office MCP 与指令文件）：** OpenCode 1.18.29 17/18 通过（1 项按设计跳过）；Pi 0.85.1 17/18 通过（同一跳过项）——Pi 首次在真实二进制上走通"内建 `write` 工具 → `tool_call` 钩子 → 网关 `permission.asked{permission:"write", patterns:[目标]}` → `once`/`reject` 回复 → 文件写入/拒绝 → 204"，以及 abort → `finish:"cancelled"`。集成时补的三处：Pi 策略桥的授权载荷增加 `title`/`locations`（与 ACP 驱动同形）；核心对 started/finished 事件族的工具 part 记录 `nameSource:"name"`；冒烟脚本接受 pi 的 `path` 键与规范的 `patterns` 字段。

**落地与方案的差异：** D3 中 `PNP_ALLOW_HTTP_MODEL_ENDPOINT` 实际命名为 `PNP_ALLOW_HTTP_ENDPOINTS`（模型端点与 MCP URL 共用一个开关）；Pi 不再发送 `set_model`，模型绑定变化一律 409 `ENGINE_BINDINGS_CHANGED`（评测下所有选择都映射到同一配置模型，不会触发）；Pi 的 `native.engineVersion` 在真实 0.85.1 上仍为 `unknown`（`get_state` 不带版本）；`gateway.ps1` 不再出现在裁判文档里；bundle 剔除 `opencode-windows-x64-baseline`（无 AVX2 的机器需按 `BUNDLE-MANIFEST.json` 里的命令补装）；bundle 实测 463 MiB（zip 151 MiB）。

**仍未验证（需 Windows 真机）：** `pnp.cmd start/stop/selfcheck` 的 PowerShell 侧只做了结构审查；两引擎在真实 Windows 上对 `D:\test_data` 类中文绝对路径的端到端产物；Office 工具的 `app_open`；真实内网模型与 appid 头；WeLink 等内网 MCP（C 线）。CI 的 windows × pi 腿与 `pnp.cmd bootstrap --engine pi` 在本次推送后首次运行。
