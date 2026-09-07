# PNP Windows 内网快速启动

这份说明只解决第一次在内网把 PNP 跑起来。完整协议、恢复和发布说明仍以 [`INSTRUCTION.md`](INSTRUCTION.md) 为准。

## 1. 先明确评测启动契约

赛题最终以本地 Gateway API 进行评测。Harness 可以由作品自动准备，也可以由裁判/操作者事先手工安装；两种方式最终都必须启动同一个本地网关，并在**启动命令中通过 `--engine` 指定本轮 Engine**。

推荐保留两条入口：

```powershell
# A. 依赖已经安装/准备完成：最接近正式评测的启动方式
.\code\gateway.cmd --engine opencode --port 6217

# B. 内网联调/易用入口：先自动准备可自动安装的依赖，再启动同一个 Gateway
.\code\pnp.cmd start --engine opencode --port 6217
```

`pnp.cmd` 不选择默认 Engine，`--engine` 必须显式提供。底层 `gateway.cmd` 仍兼容 `AGENT_ENGINE`，用于兼容调测材料，但 PNP 的正式启动说明和比赛切换口径统一使用命令行 `--engine`。

## 2. 第一次准备本地私有配置

在 `engineering/code` 下执行：

```powershell
New-Item -ItemType Directory -Force runtime | Out-Null
Copy-Item config/local.env.example runtime/local.env
notepad runtime/local.env
```

至少把以下两项换成真实值：

```text
PNP_HIS_MODEL_ENDPOINT=https://<内部模型通道>/v1
PNP_HIS_AUTHORIZATION=Bearer <API-KEY>
```

`runtime/` 已被 Git 忽略，真实 API Key 不进入仓库。示例默认使用 `config/settings.his.example.json`，其中默认模型为 `GLM-V5.1-DX`，并同时注册 `Qwen-V3.6-27B-DX`。

## 3. 一条命令自动准备并启动

启动 OpenCode：

```powershell
.\pnp.cmd start --engine opencode --port 6217
```

以后切换到另一个**已经实现**的 Engine，只改启动参数：

```powershell
.\pnp.cmd start --engine pi --port 6217
.\pnp.cmd start --engine hermes --port 6217
```

启动器会尽量自动：

1. 使用本机兼容的 Node.js 24.19+；如果没有，则下载并校验固定的 Node.js 24.19.0 Windows x64 ZIP；
2. 根据 `package-lock.json` 执行必要的 `npm ci`；未变化时复用 `node_modules`；
3. 编译 Gateway；
4. 对声明了可自动安装元数据的 Engine 下载固定版本依赖；OpenCode 当前锁定为 `opencode-ai@1.18.29`，安装到 `runtime/bootstrap/`，不要求全局 npm 安装；
5. 如果某个 Engine 不能自动安装，则明确提示需要的可执行文件环境变量，允许裁判/操作者先手工安装再使用 `gateway.cmd --engine ...`；
6. 启动 `http://localhost:6217`。

OpenCode 官方支持 Windows 上通过 npm 安装，因此这一条可以自动化；比赛 FAQ 也允许裁判手工安装 Harness 环境依赖。自动安装只是易用性增强，不是 Gateway 协议的一部分。

只下载/构建、不启动：

```powershell
.\pnp.cmd bootstrap --engine opencode
```

帮助：

```powershell
.\pnp.cmd help
```

## 4. 内网镜像

启动器不会绕过企业网络策略。

如果机器不能访问公共 npm registry，在 `runtime/local.env` 中配置标准 npm 镜像：

```text
npm_config_registry=https://<内部 npm 镜像>/
```

如果不能访问 `nodejs.org`，可将官方 `node-v24.19.0-win-x64.zip` 镜像到内网，并配置：

```text
PNP_NODE_DOWNLOAD_URL=https://<内部镜像>/node-v24.19.0-win-x64.zip
```

镜像文件仍必须通过启动器内置 SHA256 校验。若已有 Node 24.19+，无需任何下载；也可以通过 `PNP_NODE_HOME` 指向安装目录。

## 5. 启动后验证

```powershell
$base = 'http://127.0.0.1:6217'
Invoke-RestMethod "$base/health/live"
Invoke-RestMethod "$base/health/ready"
```

创建会话：

```powershell
$session = Invoke-RestMethod -Method Post -Uri "$base/session" -ContentType 'application/json' -Body (@{
  directory = 'D:\test_data'
  title = 'PNP local smoke'
} | ConvertTo-Json)
```

发送最小模型请求：

```powershell
$body = @{
  parts = @(@{ type = 'text'; text = '请只回复 PNP_MODEL_OK' })
  model = @{ providerID = 'his'; modelID = 'GLM-V5.1-DX' }
} | ConvertTo-Json -Depth 10

Invoke-WebRequest -Method Post -Uri "$base/session/$($session.id)/prompt_async" -ContentType 'application/json' -Body $body
Invoke-RestMethod "$base/session/$($session.id)/message" | ConvertTo-Json -Depth 20
```

`prompt_async` 正常完成返回 HTTP 204；完整轨迹从 `/session/{id}/message` 获取。评测数据里的文件会由评测环境预置到指定目录，PNP 只需要尊重 `POST /session` 的 `directory` 参数，不应把评测文件打进代码包。

## 6. 多 Engine 切换调测

停止当前 Gateway 后，用相同端口和相同用例重新启动另一个 Engine：

```powershell
.\pnp.cmd start --engine opencode --port 6217
# 停止后
.\pnp.cmd start --engine pi --port 6217
```

或者依赖已由裁判手工安装时直接：

```powershell
.\gateway.cmd --engine opencode --port 6217
# 停止后
.\gateway.cmd --engine pi --port 6217
```

评测脚本只替换启动参数，不修改 Gateway API、Session API 或测试用例。只有已经实现的 Engine 才会成功；未实现 Engine 必须明确失败，不能自动退回 Mock。

## 7. MCP / 员工助手

C 完成员工助手适配后，只需在同一份 settings 的 `common.mcp.servers`（或特定 `cores.<engine>.mcp.servers`）配置其交付的 MCP Server。`pnp.cmd` 不实现或猜测员工助手 CLI 协议。

统一 MCP 交付契约见 [`docs/spec/mcp-integration-profile.md`](docs/spec/mcp-integration-profile.md)。

## 8. 正式提交原则

FAQ 明确允许安装包，但安装后仍必须在本地提供赛题网关接口，同时需要提交源码审查。因此最终 `solution.zip` 仍保持：

```text
solution/
├── INSTRUCTION.md
└── code/
```

`pnp.cmd` 是可选的一键易用入口；`gateway.cmd --engine <id>` 是最直接的正式网关启动入口。两种方式最终启动同一个 Gateway 主程序，Session、SSE、Prompt、Permission、Abort 和 Message API 完全一致。
