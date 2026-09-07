# PNP Windows 内网快速启动

这份说明只解决第一次在内网把 PNP 跑起来。完整协议、恢复和发布说明仍以 [`INSTRUCTION.md`](INSTRUCTION.md) 为准。

## 1. 最短路径

在 `engineering/code` 下执行。

### 第一次：准备本地私有配置

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

### 一条命令启动并指定 Engine

赛题的正式切换方式是**启动命令参数**。例如启动 OpenCode：

```powershell
.\pnp.cmd start --engine opencode --port 6217
```

切换到其他已经实现的 Core，只改 `--engine`：

```powershell
.\pnp.cmd start --engine pi --port 6217
.\pnp.cmd start --engine hermes --port 6217
```

`AGENT_ENGINE` 只保留兼容能力；正式调测和评测文档优先使用 `--engine`。如果命令行 `--engine` 与已有 `AGENT_ENGINE` 同时存在但不一致，启动会明确失败，不会静默选择其中一个。

启动器会自动：

1. 使用本机兼容的 Node.js 24.19+；如果没有，则下载并校验固定的 Node.js 24.19.0 Windows x64 ZIP；
2. 根据 `package-lock.json` 执行必要的 `npm ci`；未变化时复用 `node_modules`；
3. 编译 Gateway；
4. 根据当前 Engine 配置下载固定版本依赖；OpenCode 当前锁定为 `opencode-ai@1.18.29`，安装到 `runtime/bootstrap/`，不要求全局 npm 安装；
5. 准备所选 Engine 的可执行文件和默认 `PNP_DATA_DIR`；
6. 启动 `http://localhost:6217`。

只下载/构建、不启动：

```powershell
.\pnp.cmd bootstrap --engine opencode
```

帮助：

```powershell
.\pnp.cmd help
```

## 2. 内网镜像

启动器不会绕过企业网络策略。

如果机器不能访问公共 npm registry，直接使用 npm 标准配置，例如在 `runtime/local.env` 中写：

```text
npm_config_registry=https://<内部 npm 镜像>/
```

如果不能访问 `nodejs.org`，可将官方 `node-v24.19.0-win-x64.zip` 镜像到内网，并配置：

```text
PNP_NODE_DOWNLOAD_URL=https://<内部镜像>/node-v24.19.0-win-x64.zip
```

镜像文件仍必须通过启动器内置 SHA256 校验。若已有 Node 24.19+，无需任何下载；也可以通过 `PNP_NODE_HOME` 指向安装目录。

## 3. 启动后验证

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

`prompt_async` 正常完成返回 HTTP 204；完整轨迹从 `/session/{id}/message` 获取。

## 4. 多 Engine 切换调测

停止当前 Gateway 后，用相同端口和相同测试用例重新启动另一个 Engine：

```powershell
.\pnp.cmd start --engine opencode --port 6217
# 停止后
.\pnp.cmd start --engine pi --port 6217
```

这样评测脚本只需要替换启动参数，不需要修改 Gateway API、Session API 或测试用例。只有已经实现且具备安装/可执行文件配置的 Engine 才会成功；未实现 Engine 必须明确失败，不能自动退回 Mock。

底层正式 Gateway 入口本身也支持相同参数：

```powershell
.\gateway.cmd --engine opencode --port 6217
.\gateway.cmd --engine pi --port 6217
```

`pnp.cmd` 与 `gateway.cmd` 的区别只是：前者会先自动准备依赖和构建，后者假设依赖已经准备完成。

## 5. MCP / 员工助手

C 完成员工助手适配后，只需在同一份 settings 的 `common.mcp.servers`（或特定 `cores.<engine>.mcp.servers`）配置它交付的 MCP Server。`pnp.cmd` 不实现或猜测员工助手 CLI 协议。

统一 MCP 交付契约见 [`docs/spec/mcp-integration-profile.md`](docs/spec/mcp-integration-profile.md)。

## 6. 与正式评测启动的关系

`pnp.cmd` 是开发/内网联调的一键自举入口；**正式北向 Gateway 协议不变**。评测时推荐直接使用带 Engine 参数的启动命令：

```powershell
.\code\gateway.cmd --engine opencode --port 6217
```

如果评测环境希望自动完成依赖准备，则使用：

```powershell
.\code\pnp.cmd start --engine opencode --port 6217
```

两种方式最终启动的是同一个 Gateway 主程序。Session、SSE、Prompt、Permission、Abort 和 Message API 均完全一致。
