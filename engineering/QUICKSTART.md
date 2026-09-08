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
.\pnp.cmd selfcheck --engine opencode   # 准备 + 离线端到端自检，打印 PASS/FAIL
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

`runtime\` 已被 Git 忽略。网关自己会在启动时加载 `runtime\local.env`（`pnp.cmd`、`gateway.cmd`、`npm start` 三条路都一样），只打印变量名不打印取值；`PNP_LOCAL_ENV_FILE` 可以指向别的文件。

最少需要两个变量：

```text
PNP_MODEL_ENDPOINT=https://<模型服务主机>/v1
PNP_MODEL_ID=<端点认识的模型名>
```

可选：`PNP_MODEL_API_KEY`（作为 `Authorization: Bearer` 发送）、`PNP_MODEL_HEADERS`（JSON 对象，附加请求头）、`PNP_MODEL_CA_FILE`（私有 CA 的 PEM）、`PNP_ALLOW_HTTP_ENDPOINTS=1`（放开非回环的 `http://` 端点）、`PNP_MODEL_TLS_INSECURE=1`（最后手段）。模型、权限、MCP 工具与指令文件的完整格式见 [`code/config/SETTINGS.md`](code/config/SETTINGS.md)；默认设置文件是 `config/settings.json`，放到仓库外时用 `PNP_SETTINGS` 指向它。

内网镜像：`npm_config_registry` 指向内网 npm，`PNP_NODE_DOWNLOAD_URL` 指向内网上的 `node-v24.19.0-win-x64.zip`（仍按固定 SHA-256 校验），或用 `PNP_NODE_HOME` 指向已装好的 Node 24.19+。

引擎位置也可以显式指定，指定后启动器不再安装：OpenCode 用 `PNP_OPENCODE_EXE_PATH`，Pi 用 `PNP_PI_ENTRY`（`dist/bundle/cli.js`）加可选的 `PNP_PI_NODE`，或用单文件可执行的 `PNP_PI_EXECUTABLE`。

## 3. 验证

```powershell
npm run check                                  # typecheck + 单元 + 契约 + 边界 + strip-only
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

## 4. 打交付包

```powershell
node scripts\package-release.mjs --bundle --zip
```

产出 `dist\release\solution\{INSTRUCTION.md, code\}` 与 `dist\release\solution.zip`：源码之外还包含 `pnp.cmd`、编译好的 `dist\`、生产依赖 `node_modules\`、固定版本的 Node Windows 运行时和两个引擎，因此评测机可以完全离线运行。包内组件的版本与 SHA-256 写在 `code\BUNDLE-MANIFEST.json`。

`--source-only`（也是默认）产出旧的纯源码包。打包结束会自检包内没有环境文件、数据库、日志、私钥或形似凭据的字符串，并打印体积；自检不通过时退出码非零。

## 5. 常见顺序

```text
1. .\pnp.cmd bootstrap --engine opencode
2. 配 runtime\local.env
3. .\pnp.cmd selfcheck --engine opencode
4. .\pnp.cmd start --engine opencode --port 6217
5. 按 INSTRUCTION.md 第 2 节的调用序列联调
6. .\pnp.cmd stop，换 AGENT_ENGINE=pi 重来一遍
7. node scripts\package-release.mjs --bundle --zip
```
