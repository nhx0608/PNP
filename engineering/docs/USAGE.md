# PNP 网关使用指南

PNP 是运行在 Windows 上的 Agent 网关：调用方通过 HTTP 下发任务，网关交给所选引擎
（`opencode` 或 `pi`）执行，再把执行轨迹和产物交回。本文按顺序做即可，每步一条命令、
一个"看到什么算成功"。

所有命令在 PowerShell 中、在 `solution\code` 目录下执行：

```powershell
Set-Location D:\pnp\solution\code
```

```text
solution\
  INSTRUCTION.md           包的顶层说明
  code\
    pnp.cmd                准备 / 自检 / 配置 / 启停
    gateway.cmd            直接启动网关（赛题规定的启动命令）
    config\settings.json   权限、工具、指令
    runtime\               运行时生成：local.env、logs\、data\、gateway.pid
  docs\                    本文所在目录
  verification\results.json
```

## 1. 需要什么

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10/11 x64，自带的 Windows PowerShell 5.1 |
| 权限 | 普通用户，不需要管理员 |
| 解压路径 | 不含空格的短路径，例如 `D:\pnp` |
| 端口 | `6217` 空闲（可用 `--port` 改） |
| 模型服务 | 一个 OpenAI 兼容的 `/chat/completions` 服务，地址和密钥见第 2 节 |

包里已经带齐，目标机上**不需要安装** Node.js、Python、Git，**不需要联网**：

| 包内已含 | 位置 |
|---|---|
| Node.js 24.19.0 运行时 | `code\runtime\bootstrap\node-v24.19.0-win-x64\` |
| 引擎 OpenCode 1.18.29、Pi 0.85.1 | `code\runtime\bootstrap\engines\` |
| 已编译的网关与全部依赖 | `code\dist\`、`code\node_modules\` |
| Office / 桌面 / PDF 三组 MCP 工具 | 由 `config\settings.json` 注册 |

唯一的可选依赖：**PDF 工具**需要本机有 Python 3.9+（`py`、`python` 或 `python3` 在 PATH
上，或用 `$env:PNP_PYTHON` 指向解释器）。没有 Python 时网关照常启动，PDF 工具自报不可用，
其余工具不受影响。

## 2. 配置模型

模型只靠四个环境变量，凭据不写进 `settings.json`。

| 变量 | 必填 | 含义 |
|---|---|---|
| `PNP_MODEL_ENDPOINT` | 是 | OpenAI 兼容**基地址**，不带 `/chat/completions`；多数服务以 `/v1` 结尾 |
| `PNP_MODEL_ID` | 是 | 该服务认识的模型名 |
| `PNP_MODEL_API_KEY` | 否 | 以 `Authorization: Bearer <值>` 发送；服务不校验则留空 |
| `PNP_MODEL_HEADERS` | 否 | 额外请求头，JSON 对象，例如 `{"appid":"12345"}` |

**方式一：配置命令**（写入 `code\runtime\local.env`，网关启动时自动读取）

```powershell
.\pnp.cmd config
```

交互问四个问题，回车用括号里的默认值，密钥不回显。看到 `[pnp] Wrote ...\runtime\local.env`
即成功。非交互写法：

```powershell
.\pnp.cmd config --endpoint https://open.bigmodel.cn/api/paas/v4 --model glm-4-flash --api-key '你的密钥'
```

`--headers` 这种带引号的 JSON 建议交互输入，或直接编辑 `runtime\local.env`。

**方式二：环境变量**（启动前在同一个窗口设置；环境变量优先于文件）

```powershell
$env:PNP_MODEL_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4'
$env:PNP_MODEL_ID       = 'glm-4-flash'
$env:PNP_MODEL_API_KEY  = '你的密钥'
```

内网模型的三种情况：

| 情况 | 做法 |
|---|---|
| 地址是 `http://` 而非 `https://` | `$env:PNP_ALLOW_HTTP_ENDPOINTS = '1'`（`pnp.cmd config` 会自动写入） |
| 证书由私有 CA 签发 | `$env:PNP_MODEL_CA_FILE = 'D:\certs\internal-ca.pem'`（PEM 文件） |
| 需要 appid 一类的请求头 | `PNP_MODEL_HEADERS` 填 `{"appid":"12345"}` |

来不及配证书时可临时 `$env:PNP_MODEL_TLS_INSECURE = '1'`，仅限内网。

## 3. 启动

赛题规定的启动命令，两种写法任选其一：

```powershell
# 写法 A：参数
.\gateway.cmd --engine opencode --port 6217

# 写法 B：环境变量
$env:AGENT_ENGINE = 'opencode'
.\gateway.cmd
```

| 参数 | 取值 | 默认 |
|---|---|---|
| `--engine` / `AGENT_ENGINE` | `opencode` 或 `pi`；两者同时给且不一致则报错退出 | 无，必须给 |
| `--port` | 1–65535 | `6217` |
| `--host` | `localhost` / `127.0.0.1` / `::1`，只允许回环 | `localhost` |

网关占住这个窗口。**另开一个 PowerShell 窗口**探测就绪：

```powershell
Invoke-RestMethod http://127.0.0.1:6217/health/ready
```

返回 `status : ready` 且 `engine : opencode` 即可调用。引擎首次启动需十几秒到一分钟，
期间该接口返回 503 `{"status":"not-ready"}`，PowerShell 会报"远程服务器返回错误"，属正常。

**停止**：在网关窗口按 `Ctrl+C`。

**切换引擎**：停止后换引擎重启，不支持运行中切换。两个引擎的数据目录相互独立
（`runtime\data\<引擎>\`）。

```powershell
.\gateway.cmd --engine pi --port 6217
```

**另一条等价路径**：`.\pnp.cmd start --engine opencode --port 6217`。它会先补齐缺失的依赖
再启动同一个网关，把进程号写到 `runtime\gateway.pid`、输出写进 `runtime\logs\`，并支持在
另一个窗口用 `.\pnp.cmd stop` 停止。

## 4. 自检

两条命令，都会自己拉起并回收网关，不需要先启动。

```powershell
.\pnp.cmd selfcheck --engine opencode
.\pnp.cmd livecheck --engine opencode
```

| 命令 | 用什么模型 | 检查什么 | 通过时最后一行 |
|---|---|---|---|
| `selfcheck` | 内置模拟模型，不联网 | 建会话、事件流、任务、授权、中止、并发 | `[pnp] SELFCHECK PASS (engine=opencode)` |
| `livecheck` | 第 2 节配置的真实模型 | 就绪、事件流、写文件、读回、中止、删除会话 | `[pnp] LIVECHECK PASS (engine=opencode)` |

把 `opencode` 换成 `pi` 再跑一遍即验证第二个引擎。打印 `FAIL` 时终端会写明哪一项、状态码
和原因；`livecheck` 的证据文件在终端 `artifacts in ...` 这一行给出的目录。

## 5. 怎么调接口

地址 `http://127.0.0.1:6217`，请求体与响应体均为 JSON（UTF-8）。一次任务的顺序：

```text
调用方                             网关
  │  POST /session {directory,title}        │
  │ ───────────────────────────────►│  200 {id:"ses_…",status:"idle"}
  │  GET /event  (SSE，长连接)               │
  │ ───────────────────────────────►│  data: {type,properties,sequence}
  │  POST /session/{id}/prompt_async        │
  │ ───────────────────────────────►│  …执行整轮，含全部工具调用…
  │            (阻塞直到本轮结束)            │  204 No Content
  │  GET /session/{id}/message              │
  │ ───────────────────────────────►│  200 [ …轨迹… ]
  │  检查产物文件                            │
  │  DELETE /session/{id}                   │
  │ ───────────────────────────────►│  200 {ok:true}
```

**步骤 1：建会话**。`directory` 必填、绝对路径，不存在会自动创建。

```powershell
$s = Invoke-RestMethod -Method Post http://127.0.0.1:6217/session `
  -ContentType 'application/json; charset=utf-8' `
  -Body '{"title":"office_014","directory":"D:\\test_data"}'
$s.id
```

响应：`{"id":"ses_…","title":"office_014","created_at":"…","status":"idle"}`

**步骤 2：订阅事件流**（推荐，另开一个窗口，保持不关）。

```powershell
curl.exe -N http://127.0.0.1:6217/event
```

每帧形如 `data: {"type":"session.status","properties":{"sessionID":"ses_…","status":{"type":"busy"}},"sequence":12}`。

**步骤 3：发任务**。这个请求会**一直阻塞到整轮执行完毕**，默认上限 15 分钟
（`PNP_RUN_TIMEOUT_MS`，毫秒）。调用方必须自己把超时设到 15 分钟以上，并在后台线程调用。

```powershell
$body = @'
{"parts":[{"type":"text","text":"请基于 D:\\test_data\\task.csv 做违约风险分析，保存为 D:\\test_data\\task_违约风险分析.md"}],
 "model":{"providerID":"any","modelID":"any"},"agent":"assistant"}
'@
Invoke-RestMethod -Method Post "http://127.0.0.1:6217/session/$($s.id)/prompt_async" `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 1000
```

curl 写法：`curl.exe -X POST --max-time 1000 -H "Content-Type: application/json" --data-binary "@prompt.json" http://127.0.0.1:6217/session/<id>/prompt_async`

响应：`204 No Content`。`model` 填任何值都可，网关一律映射到第 2 节配置的模型；
`parts[].text` 也可写成 `content`。

**步骤 4：取轨迹**。

```powershell
Invoke-RestMethod "http://127.0.0.1:6217/session/$($s.id)/message" | ConvertTo-Json -Depth 8
```

响应是消息数组（节选）：

```json
[
  {"id":"msg_…","role":"user","content":"请基于 …","created_at":"…"},
  {"id":"msg_…","role":"assistant","content":"",
   "tool_calls":[{"id":"call_…","name":"office_csv_read","arguments":{"path":"D:\\test_data\\task.csv"}}],
   "info":{"role":"assistant","finish":"tool-calls"},
   "parts":[{"type":"tool","tool":"office_csv_read","callID":"call_…","state":{"status":"completed"}}]},
  {"id":"msg_…","role":"tool","tool_call_id":"call_…","tool_name":"office_csv_read","content":"{…}"},
  {"id":"msg_…","role":"assistant","content":"已生成 D:\\test_data\\task_违约风险分析.md",
   "info":{"role":"assistant","finish":"stop"},
   "parts":[{"type":"text","text":"已生成 …"},{"type":"step-finish"}]}
]
```

**步骤 5：检查产物**。

```powershell
Test-Path 'D:\test_data\task_违约风险分析.md'
```

**步骤 6：删除会话**。只删网关侧记录和引擎会话数据，不删 `directory` 与产物。

```powershell
Invoke-RestMethod -Method Delete "http://127.0.0.1:6217/session/$($s.id)"
```

响应：`{"ok":true}`

其余接口：

| 接口 | 用途 | 响应 |
|---|---|---|
| `GET /session/{id}` | 单会话状态 | `{"id","title","status":"idle"\|"busy","message_count":N}` |
| `GET /session/status` | 全部会话状态 | `{"ses_…":{"type":"idle"}}` |
| `GET /session/{id}/event` | 单会话事件历史（`?after=&limit=`） | `{"events":[…],"next_cursor":N,"complete":true}` |
| `POST /session/{id}/abort`（或 `/stop`） | 中止当前轮 | `{"ok":true}`；被中止的 `prompt_async` 返回 204，轨迹记 `finish:"cancelled"` |
| `GET /question`、`POST /question/{id}/reply` | 引擎反问 | 请求体 `{"answers":[["方案 A"]]}` |
| `GET /permission`、`POST /permission/{id}/reply` | 工具授权 | 请求体 `{"reply":"once"}`，取值 `once`/`always`/`reject` |
| `GET /health/live`、`GET /health/ready` | 存活 / 就绪 | `{"status":"alive"}` / `{"status":"ready","engine":"…"}` |
| `GET /diagnostics` | 脱敏诊断信息 | JSON |

默认反问由网关自动用第一个选项作答（`PNP_QUESTION_POLICY=auto`），权限默认全部放行，
所以 `/question`、`/permission` 通常为空。需要逐项审批时：启动前
`$env:PNP_CONFIGURED_POLICY_OVERRIDES = '{"write":"ask"}'`、`$env:PNP_QUESTION_POLICY = 'ask'`。

## 6. 怎么判断做完了

一轮**成功结束**同时满足三条：

| # | 条件 | 在哪看 |
|---|---|---|
| 1 | `prompt_async` 返回 `204` | 步骤 3 的响应 |
| 2 | 事件流出现 `session.status`（`status.type = "idle"`）和 `session.idle` | 步骤 2 的窗口；失败时是 `session.error` |
| 3 | 轨迹最后一条 `role = "assistant"`、`info.finish = "stop"`、`parts` 含 `{"type":"step-finish"}` | 步骤 4 |

`info.finish` 的其他取值：`tool-calls` 是中间步骤；`cancelled` / `error` / `length` /
`interrupted` 是真实的非成功终态，不会伪装成功。

**产物位置**：任务里点名的绝对路径；任务没说位置时写在会话的 `directory`，最终回复里会列出
每个产物的绝对路径。

**日志与数据**：

| 内容 | 路径 |
|---|---|
| 网关日志（`pnp.cmd start` 启动时） | `code\runtime\logs\gateway-<引擎>.log`、`.err.log` |
| 进程号（`pnp.cmd start` 启动时） | `code\runtime\gateway.pid` |
| 会话数据库与引擎会话数据 | `code\runtime\data\<引擎>\` |

日志里只有变量名，没有凭据。

## 7. 出错怎么办

**启动阶段**（网关退出，终端打印错误码）：

| 错误码 | 含义 | 先试什么 |
|---|---|---|
| `ENGINE_NOT_FOUND` | 没给引擎，或引擎名不是 `opencode`/`pi` | 加 `--engine opencode` 或设 `AGENT_ENGINE` |
| `ENGINE_CONFIGURATION_CONFLICT` | `--engine` 与 `AGENT_ENGINE` 不一致 | 清掉其中一个 |
| `MODEL_ENVIRONMENT_MISSING` | 第 2 节没做，或 `local.env` 不在 `code\runtime\` | 重跑 `.\pnp.cmd config`；信息里列出缺哪个变量 |
| `INSECURE_MODEL_ENDPOINT` | 模型地址是 `http://` | `$env:PNP_ALLOW_HTTP_ENDPOINTS = '1'` 后重启 |
| `MODEL_CA_FILE_MISSING` | `PNP_MODEL_CA_FILE` 指向的文件不存在 | 修正路径 |
| `INSTANCE_LOCKED` | 同一数据目录已有网关在跑 | `Ctrl+C` 关掉上一个，或 `.\pnp.cmd stop` |
| 端口被占用 | 6217 已被别的程序占用 | `.\gateway.cmd --engine opencode --port 6218` |

**调用阶段**（HTTP 响应体统一为 `{"code":"…","message":"…"}`）：

| 状态码 | code | 含义 | 先试什么 |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | 请求体不合法（如 `directory` 不是绝对路径、`parts` 为空） | 对照第 5 节改请求体 |
| 403 | `WORKSPACE_FORBIDDEN` | 目录不可用（无权创建或位于系统目录） | 换一个普通目录 |
| 404 | `NOT_FOUND` | 会话或路由不存在 | 检查 `id` 和路径 |
| 409 | `SESSION_BUSY` | 同会话已有任务在跑 | 等 204 返回，或先 `/abort` |
| 409 | `GATEWAY_BUSY` | 全局队列满（带 `Retry-After: 5`） | 5 秒后重试 |
| 409 | `SESSION_UNAVAILABLE` | 该会话上一轮停止未证实 | `DELETE` 该会话，重建 |
| 500 | `INTERNAL_ERROR` | 内部错误 | 看 `runtime\logs\` 里的脱敏说明 |
| 502 | `BAD_GATEWAY` / `ENGINE_PROTOCOL_ERROR` | 引擎返回了不可解析的结果 | 查引擎日志；重跑该轮 |
| 503 | `ENGINE_UNAVAILABLE` | 引擎进程不可用 | 重启网关 |
| 503 | `EXECUTION_UNCERTAIN` | 停止未证实 | `DELETE` 该会话 |
| 503 | `MODEL_ENVIRONMENT_MISSING` | 模型变量缺失 | 见启动阶段同名条目 |
| 504 | `EXECUTION_TIMEOUT` | 本轮超过 `PNP_RUN_TIMEOUT_MS` | 调大该变量，或拆小任务 |

`livecheck` 失败但 `selfcheck` 通过：网关没问题，是模型或网络。检查密钥、地址是否为基地址
（多带 `/chat/completions` 就会失败）、模型是否支持工具调用。
