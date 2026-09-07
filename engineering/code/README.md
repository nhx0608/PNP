# PNP 可执行工程

规范：[AGENTS.md](../AGENTS.md)。设计：[architecture.md](../docs/spec/architecture.md)。实际验证：[coverage.md](../verification/coverage.md)。

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

真实 endpoint/API Key 不写入 settings；文件只引用环境变量名。例如 HIS OpenAI-compatible 模型：

```powershell
$env:PNP_HIS_MODEL_ENDPOINT='https://<approved-channel-domain>/v1'
$env:PNP_HIS_AUTHORIZATION='Bearer <API-KEY>'
```

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

A：`drivers/acp`、`engines/opencode`、`engines/hermes`。B：`drivers/pi-rpc`、`engines/pi`。C：`integration/internal`。公共模块变更独立评审，所有实现依赖 `src/contracts`。

## 验证

```powershell
npm run typecheck
npm test
npm run test:contract
npm run check:boundaries
npm run doctor -- --engine pi
npm run release:check
```

HTTP 契约测试需要完整依赖。真实引擎和内网测试不由 Mock 结果代替。

## 端到端冒烟（e2e）

`scripts/e2e/` 用真实网关进程、真实引擎和北向 HTTP 协议跑完整一轮。网关的启动方式与 `INSTRUCTION.md` 给评测方的命令逐字一致：真实引擎一路走规范字面形式，即启动脚本 `gateway.cmd`（Windows）/`./gateway`（POSIX）加 `--engine <引擎> --port <端口>`，环境里没有 `AGENT_ENGINE`，也不传 `--host`，因此被验证的正是文档写明的默认绑定；mock 一路保留 `AGENT_ENGINE` 加 `npm start -- --port 6217 --host localhost`。默认端口 6217（本机 6217 被占用时可用 `--gateway-port` 改，仅限本地）；就绪探测同时打 `http://localhost:6217` 与 `http://127.0.0.1:6217`，只答其一算失败。**唯一被 Mock 的是模型服务**：
`mock-model-server.mjs` 在 `127.0.0.1` 上实现 OpenAI Chat Completions（流式与非流式）。

```powershell
npm run build
npm run e2e -- --engine mock                  # 对照组：不依赖真实引擎，验证测试本身
npm run e2e -- --engine opencode              # 真实 OpenCode，需要先装引擎
npm run e2e -- --engine mock --artifacts D:\tmp\e2e
```

`--engine opencode` 前先安装引擎，并让编排器解析出真实可执行文件：

```powershell
npm install -g opencode-ai@1.18.29 --loglevel=error
```

编排器用 `npm root -g` 推导 `<npm root -g>/opencode-ai/bin/opencode.exe`（非 Windows 为
`opencode`），并通过 `PNP_OPENCODE_EXE_PATH` 传给 Pack；若该环境变量已设置则原样透传。

OpenCode Pack 会把有效 permission settings 投影到会话私有 `opencode.json`。PNP 中 `ask` 和 `deny` 都要求
内核先发出 ACP permission request，随后由 Gateway 的统一 policy 决定是否直接拒绝或进入人工审批。
E2E 的 opencode 腿只设 `PNP_CONFIGURED_POLICY_OVERRIDES={"write":"ask"}`，投影经 IntegrationContext 抵达私有
`opencode.json`，以此证明正式路线本身可用。`PNP_OPENCODE_NATIVE_PERMISSIONS=ask` 只是强制 edit/bash 进入审批环路的
历史兼容开关，冒烟不再设置它，它也不是正式配置入口。

三个脚本各自独立可用：

- `mock-model-server.mjs` — 零依赖模型服务，`--port 0 --log <jsonl>`，启动后 stdout 输出 `{"port":N}`；
- `run-e2e.mjs` — 只用全局 `fetch` 的北向协议客户端，`--base/--workspace/--report/--expect-tools`，
  审批回路的两个文件名与轮询预算是 `--write-file-name/--reject-file-name/--permission-timeout-ms`；
- `ci-smoke.mjs` — 编排器，负责临时 `PNP_DATA_DIR`、配置档、进程收尾与产物收集。

产物（网关日志、模型请求 JSONL、断言报告、`hosts/*.json`、`/diagnostics`）默认写到系统临时目录，
CI 中由 `engine-smoke` 作业以 `always()` 上传。Authorization 头的值在任何日志和产物中都会脱敏。
