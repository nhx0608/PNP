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

`--engine opencode` 这条腿还会把评测方的审批回路真的跑一遍：编排器给网关设 `PNP_OPENCODE_NATIVE_PERMISSIONS=ask`
（引擎侧才会发 ACP 权限请求），集成档写成 `policy: { default: "allow", operations: { write: "ask" } }`（网关侧只对 `write`
停下来问）。客户端于是不等 `prompt_async` 返回，而是轮询 `GET /permission`、`POST /permission/{id}/reply` 回
`once`（`case2`）与 `reject`（`case2b`），再等 `prompt_async` 落 204。Mock 引擎不发权限请求，这两例照旧跳过。

三个脚本各自独立可用：

- `mock-model-server.mjs` — 零依赖模型服务，`--port 0 --log <jsonl>`，启动后 stdout 输出 `{"port":N}`；
- `run-e2e.mjs` — 只用全局 `fetch` 的北向协议客户端，`--base/--workspace/--report/--expect-tools`，
  审批回路的两个文件名与轮询预算是 `--write-file-name/--reject-file-name/--permission-timeout-ms`；
- `ci-smoke.mjs` — 编排器，负责临时 `PNP_DATA_DIR`、配置档、进程收尾与产物收集。

产物（网关日志、模型请求 JSONL、断言报告、`hosts/*.json`、`/diagnostics`）默认写到系统临时目录，
CI 中由 `engine-smoke` 作业以 `always()` 上传。Authorization 头的值在任何日志和产物中都会脱敏。
