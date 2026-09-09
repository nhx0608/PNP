# PNP 可执行工程

评测方的操作手册是同级目录的 `INSTRUCTION.md`（部署、启动、调用序列、完成判定、产物说明）；开发者的上手说明是 `QUICKSTART.md`。本文件面向在仓库里开发的人。仓库内另有规范 `AGENTS.md`、设计 `docs/spec/architecture.md` 与实测记录 `verification/coverage.md`，这些评审材料不进交付包。

## 工具链与依赖

精确版本见 `toolchain.json` 和 `package.json`。公共基线管理员在可联网的目标环境执行一次：

```powershell
npm run dependencies:freeze
```

此命令实际生成锁、安装依赖并校验；失败即阻止完整基线验收，不能编造锁文件。A/B/C 同步同一基线后使用：

```powershell
npm ci
npm run foundation:check
```

## 统一 Settings

中文配置入口：[模型与 MCP 配置上手](config/START-HERE.zh-CN.md)，包含 API key 文件、自动加载、多模型、按引擎覆盖和桌面工具验证。

模型和权限统一配置在：

```text
config/settings.json
```

结构为 `common + cores.<engineId>`：Core 未声明的配置继承 `common`，只声明某一项时只覆盖该项。
模型定义、默认模型、权限默认值和 operation 覆盖都由这个文件解析，然后由 Engine Pack 转成各内核原生配置。
详细格式见 [config/SETTINGS.md](config/SETTINGS.md)。

若配置需要放在仓库外：

```powershell
$env:PNP_SETTINGS='D:\pnp-private\settings.json'
```

真实 endpoint 与凭据不写入 settings；文件只引用环境变量**名字**，取值来自进程环境或 `runtime/local.env`（网关启动时自动加载，只打印变量名）。交付设置点名的变量：

```powershell
$env:PNP_MODEL_ENDPOINT='https://<模型服务主机>/v1'   # 必填，OpenAI 兼容基地址，以 /v1 结尾
$env:PNP_MODEL_ID='<端点认识的模型名>'                # 必填，替换 settings.json 里的模型标识
$env:PNP_MODEL_API_KEY='<凭据>'                       # 可选，作为 Authorization: Bearer 发送
$env:PNP_MODEL_HEADERS='{"appid":"<appid>"}'          # 可选，附加请求头（JSON 对象）
$env:PNP_MODEL_CA_FILE='.\runtime\intranet-ca.pem'    # 可选，私有 CA 的 PEM
```

非回环的 `http://` 端点需要 `PNP_ALLOW_HTTP_ENDPOINTS=1`；证书无法校验时的最后手段是 `PNP_MODEL_TLS_INSECURE=1`。`prompt_async` 传入的任意 `providerID/modelID` 都映射到这一个模型。变量全清单见 [.env.example](.env.example)。

`config/engines/*.json` 仍是 Engine Pack 的安装/协议/可执行文件等适配器元数据，不是业务侧模型和权限配置。

## 公共框架运行

```powershell
npm run build
$env:PNP_MODE='development'
$env:AGENT_ENGINE='mock'
npm start
```

Mock 仅用于开发。正式引擎失败不得回退 Mock。

## 并行开发

A：`drivers/acp`、`engines/opencode`、`engines/hermes`（`hermes` 目前是 `implementationProvided: false` 的扩展点占位）。B：`drivers/pi-rpc`、`engines/pi`。C：`integration/internal`（目前是抛 `INTEGRATION_UNAVAILABLE` 的桩，正式路径是 `integration/configured`）。公共模块变更独立评审，所有实现依赖 `src/contracts`。

## 验证

```powershell
npm run check            # typecheck + 单元 + 契约 + 边界 + strip-only + PowerShell 编码检查
npm run typecheck
npm test
npm run test:contract
npm run check:boundaries
npm run check:strip-only
npm run check:ps-encoding
npm run doctor -- --engine pi
npm run release:check    # 内网验收证据缺失时按设计退出非零
```

HTTP 契约测试需要完整依赖。真实引擎和内网测试不由 Mock 结果代替。最近一次实际结果见 `../verification/results.json`。

## 端到端冒烟（e2e）

`scripts/e2e/` 用真实网关进程、真实引擎和北向 HTTP 协议跑完整一轮。网关的启动方式与 `INSTRUCTION.md` 给评测方的命令逐字一致：真实引擎一路走规范字面形式，即启动脚本 `gateway.cmd`（Windows）/`./gateway`（POSIX）加 `--engine <引擎> --port <端口>`，环境里没有 `AGENT_ENGINE`，也不传 `--host`，因此被验证的正是文档写明的默认绑定；mock 一路保留 `AGENT_ENGINE` 加 `npm start -- --port 6217 --host localhost`。默认端口 6217（本机 6217 被占用时可用 `--gateway-port` 改，仅限本地）；就绪探测同时打 `http://localhost:6217` 与 `http://127.0.0.1:6217`，只答其一算失败。**唯一被 Mock 的是模型服务**：
`mock-model-server.mjs` 在 `127.0.0.1` 上实现 OpenAI Chat Completions（流式与非流式）。

```powershell
npm run build
npm run e2e -- --engine mock                  # 对照组：不依赖真实引擎，验证测试本身
npm run e2e -- --engine opencode              # 真实 OpenCode，需要先装引擎
npm run e2e -- --engine pi                    # 真实 Pi，需要先装引擎
npm run e2e -- --engine mock --artifacts D:\tmp\e2e
```

真实引擎腿之前先装引擎：

```powershell
npm install -g opencode-ai@1.18.29 --loglevel=error
npm install -g @earendil-works/pi-coding-agent@0.85.1 --ignore-scripts --loglevel=error
```

编排器用 `npm root -g` 推导可执行文件：OpenCode 为 `<npm root -g>/opencode-ai/bin/opencode.exe`（非
Windows 为平台包里的 `opencode`），通过 `PNP_OPENCODE_EXE_PATH` 传给 Pack；Pi 没有原生二进制，推导的是
`<npm root -g>/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，通过 `PNP_PI_ENTRY` 加 `PNP_PI_NODE`
传下去。相应环境变量已设置时原样透传。

模型侧一路只设交付设置点名的三个变量：`PNP_MODEL_ENDPOINT`（mock 服务的 `/v1`）、`PNP_MODEL_ID`、
`PNP_MODEL_API_KEY`；凭据取值在所有日志与产物中脱敏。

OpenCode Pack 会把有效 permission settings 投影到会话私有 `opencode.json`。PNP 中 `ask` 和 `deny` 都要求
内核先发出 ACP permission request，随后由 Gateway 的统一 policy 决定是否直接拒绝或进入人工审批。
E2E 的 opencode 腿只设 `PNP_CONFIGURED_POLICY_OVERRIDES={"write":"ask"}`，投影经 IntegrationContext 抵达私有
`opencode.json`，以此证明正式路线本身可用。`PNP_OPENCODE_NATIVE_PERMISSIONS=ask` 只是强制 edit/bash 进入审批环路的
历史兼容开关，冒烟不再设置它，它也不是正式配置入口。

三个脚本各自独立可用：

- `mock-model-server.mjs` — 零依赖模型服务，`--port 0 --log <jsonl>`，启动后 stdout 输出 `{"port":N}`；
- `run-e2e.mjs` — 只用全局 `fetch` 的北向协议客户端，`--base/--workspace/--report/--expect-tools`，
  审批回路的两个文件名与轮询预算是 `--write-file-name/--reject-file-name/--permission-timeout-ms`；
- `ci-smoke.mjs` — 编排器，负责临时 `PNP_DATA_DIR`、引擎位置解析、进程收尾与产物收集。

真实引擎腿还通过 Office MCP 读取带中文路径的随机内容、回传不存在文件的真实错误；`--expect-desktop-mcp` 额外验证桌面工具发现。模拟模型只存在于测试目录。模拟测试使用隔离的空环境文件，避免本机的私有模型/MCP 配置干扰验证。

产物（网关日志、模型请求 JSONL、断言报告、`hosts/*.json`、`/diagnostics`、本轮使用的 `settings.json`）默认
写到系统临时目录。仓库根的 CI 工作流（`.github/workflows/ci.yml`）除 `foundation:check` 与构建外，还有一个
`engine-smoke` 六腿矩阵，其中包含 windows-latest × opencode 与 windows-latest × pi，跑的就是这条冒烟（模型服务
是其中唯一被 mock 的部件）。`engineering/.github/workflows/ci.yml` 是不会被执行的陈旧副本，不代表 CI 覆盖面。
本地等价命令的最近一次结果（opencode 20/21、pi 20/21，Windows 真机）记录在 `../verification/results.json`。
凭据在任何日志和产物中都会脱敏。

## 交付打包

```powershell
node scripts\package-release.mjs --bundle --zip
```

产出 `dist/release/solution/{INSTRUCTION.md, code/}` 与 `solution.zip`：除源码外还含 `pnp.cmd`、编译好的
`dist/`、生产依赖、固定版本 Node Windows 运行时与两个引擎，评测机可完全离线运行；各组件版本与 SHA-256 写在
`code/BUNDLE-MANIFEST.json`。`--source-only`（默认）产出旧的纯源码包。打包会自检包内没有环境文件、数据库、
日志、私钥或形似凭据的字符串，并打印体积。
