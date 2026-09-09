# PNP 开发者快速上手

**评测方的操作手册是 [`INSTRUCTION.md`](INSTRUCTION.md)**（环境准备、启动、调用序列、完成判定、产物说明）。交付包里只有那一份说明书，改动启动方式或变量时先改它。

本文只讲仓库里的开发用法：怎么在本机跑起来、怎么配私有环境、怎么打交付包。全部命令在 `engineering/code` 目录下执行。

## 1. 本机启动

```powershell
.\pnp.cmd start --engine opencode --port 6217
```

第一次执行会按需依次完成：找 Node（`PNP_NODE_HOME` → 包内 `runtime\bootstrap\node-*` → PATH 上的 24.19+ → 下载并校验官方 ZIP）、`npm ci`、`npm run build`、准备引擎（`PNP_*` 变量 → `runtime\bootstrap\engines\<id>\<version>` → `npm install`）。每一步都有 stamp 文件，命中就跳过，所以第二次启动通常不再下载或编译任何东西。

```powershell
.\pnp.cmd bootstrap --engine opencode   # 只准备依赖，不启动
.\pnp.cmd selfcheck --engine opencode   # 准备 + 离线端到端自检（模拟模型），打印 PASS/FAIL
.\pnp.cmd livecheck --engine opencode   # 准备 + 真实模型端到端自检，打印 PASS/FAIL（见第 3 节）
.\pnp.cmd config                        # 交互写入 runtime\local.env 里的模型变量
.\pnp.cmd stop                          # 结束 runtime\gateway.pid 记录的那个进程
.\pnp.cmd help
```

引擎既可以用 `--engine`，也可以用 `AGENT_ENGINE`；两个都给且不一致时直接失败。依赖都就绪时可以跳过准备步骤，直接 `.\gateway.cmd --engine opencode --port 6217`，启动的是同一个网关。

`start` 会把网关输出写到 `runtime\logs\gateway-<engine>.log`（错误流写 `.err.log`），同时回显到控制台。

## 2. 私有配置

```powershell
New-Item -ItemType Directory -Force runtime | Out-Null
Copy-Item config\local.env.example runtime\local.env
notepad runtime\local.env
```

`runtime\` 已被 Git 忽略。网关自己会在启动时加载 `runtime\local.env`（`pnp.cmd`、`gateway.cmd`、`npm start` 三条路都一样），只打印变量名不打印取值；`PNP_LOCAL_ENV_FILE` 可以指向别的文件。不想手工编辑就用 `.\pnp.cmd config`（见第 3 节），它只改四个模型变量、密钥输入不回显、文件里其他行保持不动。

最少需要两个变量：

```text
PNP_MODEL_ENDPOINT=https://<模型服务主机>/v1
PNP_MODEL_ID=<端点认识的模型名>
```

可选：`PNP_MODEL_API_KEY`（作为 `Authorization: Bearer` 发送）、`PNP_MODEL_HEADERS`（JSON 对象，附加请求头）、`PNP_MODEL_CA_FILE`（私有 CA 的 PEM）、`PNP_ALLOW_HTTP_ENDPOINTS=1`（放开非回环的 `http://` 端点）、`PNP_MODEL_TLS_INSECURE=1`（最后手段）。模型、权限、MCP 工具与指令文件的完整格式见 [`code/config/SETTINGS.md`](code/config/SETTINGS.md)；默认设置文件是 `config/settings.json`，放到仓库外时用 `PNP_SETTINGS` 指向它。

内网镜像：`npm_config_registry` 指向内网 npm，`PNP_NODE_DOWNLOAD_URL` 指向内网上的 `node-v24.19.0-win-x64.zip`（仍按固定 SHA-256 校验），或用 `PNP_NODE_HOME` 指向已装好的 Node 24.19+。

引擎位置也可以显式指定，指定后启动器不再安装：OpenCode 用 `PNP_OPENCODE_EXE_PATH`，Pi 用 `PNP_PI_ENTRY`（`dist/bundle/cli.js`）加可选的 `PNP_PI_NODE`，或用单文件可执行的 `PNP_PI_EXECUTABLE`。

## 3. 用免费/本地模型做本机联调

`selfcheck` 用的是内置模拟模型，证明不了"这套东西接上真模型也能跑"。想在本机验证整条链路，随便找一个 OpenAI 兼容的免费或本地服务配上即可；评测方的内网模型将来也是同样三个变量，只是地址和名字不同。

配置写进 `runtime\local.env`（`runtime\` 已被 Git 忽略，网关启动时自己加载它，只打印变量名不打印取值）。交互式写入：

```powershell
.\pnp.cmd config
```

它按提示依次问 `PNP_MODEL_ENDPOINT`、`PNP_MODEL_ID`、`PNP_MODEL_API_KEY`（可留空）、`PNP_MODEL_HEADERS`（可留空的 JSON），密钥输入不回显，写完只打印文件路径和变量名；文件里的其他行原样保留。不想交互就一次给全：

```powershell
.\pnp.cmd config --endpoint <基地址> --model <模型名> --api-key <密钥>
```

### 3.1 智谱 GLM 免费额度（推荐，团队默认的联调模型）

```text
PNP_MODEL_ENDPOINT=https://open.bigmodel.cn/api/paas/v4
PNP_MODEL_ID=glm-4-flash
PNP_MODEL_API_KEY=<在智谱开放平台申请的 Key>
```

注意基地址结尾是 `/api/paas/v4` 而不是 `/v1`。免费额度、模型名与地址**以服务商当前文档为准**。

### 3.2 Ollama（本地，完全离线，不需要密钥）

```text
PNP_MODEL_ENDPOINT=http://127.0.0.1:11434/v1
PNP_MODEL_ID=qwen2.5:7b
```

先 `ollama pull qwen2.5:7b` 把模型拉下来并保持 `ollama serve` 在跑。回环地址上的 `http://` 本来就允许，不需要 `PNP_ALLOW_HTTP_ENDPOINTS`；这个变量只有在非回环的内网 `http://` 端点上才需要。**模型必须支持工具调用（function calling）**，否则引擎无法写文件，联调会卡在"只回文字不产出文件"。

### 3.3 SiliconFlow（在线，需要密钥）

```text
PNP_MODEL_ENDPOINT=https://api.siliconflow.cn/v1
PNP_MODEL_ID=Qwen/Qwen2.5-7B-Instruct
PNP_MODEL_API_KEY=<在 SiliconFlow 控制台申请的 Key>
```

同样**以服务商当前文档为准**：模型名、可用额度和地址都可能变。

### 3.4 联调顺序

```powershell
.\pnp.cmd selfcheck --engine opencode    # 1. 不需要任何模型：模拟模型服务跑完整链路
.\pnp.cmd livecheck --engine opencode    # 2. 真实模型：健康、事件流、写文件、追问、中止、清理
.\pnp.cmd start     --engine opencode    # 3. 起网关，自己按 INSTRUCTION.md 第 2 节手动调
```

第 2 步的每项检查打印 `[PASS]`/`[FAIL]`/`[SKIP]`，最后是计数和 `[pnp] LIVECHECK PASS|FAIL`；证据（`events.jsonl`、`messages-<n>.json`、网关日志、`summary.json`）写在结尾打印的产物目录里，失败打印的是 HTTP 状态码与响应体。缺 `PNP_MODEL_ENDPOINT` 或 `PNP_MODEL_ID` 时它拒绝执行并提示先跑 `.\pnp.cmd config`。`--directory D:\test_data` 可以指定工作目录，检查项与产物文件的完整说明见 `INSTRUCTION.md` 的 1.4b。

第 3 步手动调用用 `INSTRUCTION.md` 2.3 里现成的 curl / PowerShell 例子。想顺带把反问与授权那两条回路也走一遍，就在 `runtime\local.env` 里临时加上：

```text
PNP_QUESTION_POLICY=ask
PNP_CONFIGURED_POLICY_OVERRIDES={"write":"ask"}
```

前者让引擎的反问停下来等 `POST /question/{id}/reply`（默认 `auto` 是自动用第一个选项作答），后者让写文件前先发出授权请求、等 `POST /permission/{id}/reply`（默认全部放行，`GET /permission` 一直是空数组）。测完记得去掉，评测跑的是默认姿态。

## 4. 验证

```powershell
npm run check                                  # typecheck + 单元 + 契约 + 边界 + strip-only + PowerShell 编码检查
npm run e2e -- --engine mock                   # 对照组：不依赖真实引擎
npm run e2e -- --engine opencode               # 真实 OpenCode
npm run e2e -- --engine pi                     # 真实 Pi
```

端到端冒烟用真实网关进程、真实引擎和北向 HTTP，唯一被 Mock 的是模型服务。真实引擎腿需要先装引擎：

```powershell
npm install -g opencode-ai@1.18.29 --loglevel=error
npm install -g @earendil-works/pi-coding-agent@0.85.1 --ignore-scripts --loglevel=error
```

编排器用 `npm root -g` 推导可执行文件（OpenCode 为 `bin/opencode.exe`，Pi 为 `dist/bundle/cli.js`）；相应的 `PNP_*` 变量已设置时原样透传。产物（网关日志、模型请求 JSONL、断言报告、`/diagnostics`）默认写到系统临时目录，凭据在所有产物中都会脱敏。`--gateway-port` 只在本机 6217 被占用时使用。

## 5. 打交付包

```powershell
node scripts\package-release.mjs --bundle --zip
```

产出 `dist\release\solution\{INSTRUCTION.md, code\}` 与 `dist\release\solution.zip`：源码之外还包含 `pnp.cmd`、编译好的 `dist\`、生产依赖 `node_modules\`、固定版本的 Node Windows 运行时和两个引擎，因此评测机可以完全离线运行。包内组件的版本与 SHA-256 写在 `code\BUNDLE-MANIFEST.json`。

`--source-only`（也是默认）产出旧的纯源码包。打包结束会自检包内没有环境文件、数据库、日志、私钥或形似凭据的字符串，并打印体积；自检不通过时退出码非零。

## 6. 常见顺序

```text
1. .\pnp.cmd bootstrap --engine opencode
2. .\pnp.cmd config                        # 写 runtime\local.env（也可以自己编辑）
3. .\pnp.cmd selfcheck --engine opencode   # 模拟模型
4. .\pnp.cmd livecheck --engine opencode   # 真实模型
5. .\pnp.cmd start --engine opencode --port 6217
6. 按 INSTRUCTION.md 第 2 节的调用序列联调
7. .\pnp.cmd stop，然后 $env:AGENT_ENGINE = 'pi' 重来一遍
8. node scripts\package-release.mjs --bundle --zip
```
