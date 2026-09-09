# PNP Agent 网关使用说明

PNP 是一个运行在 Windows 上的 Agent 网关：评测脚本通过 HTTP 接口下发任务，网关把任务交给所选的 Agent 引擎（OpenCode 或 Pi）执行，再把执行轨迹和产物交回。本说明按"从来没装过"的读者写，照顺序做即可；每一步都有一条命令和一个"看到什么算成功"。

目录结构（解压后）：

```text
solution\
  INSTRUCTION.md          本文件
  code\                   全部源码 + 运行所需的一切（Node、依赖、两个引擎、已编译程序）
    pnp.cmd               唯一需要用的命令
    config\settings.json  权限、工具、指令的配置（模型不在这里配，见第 2 步）
    runtime\              运行时产生：local.env（模型配置）、logs\、data\
```

## 第 1 步：解压

把 `solution.zip` 解压到一个**不含空格的短路径**，例如 `D:\pnp`。在资源管理器里进入 `D:\pnp\solution\code`，地址栏输入 `powershell` 回车（或按住 Shift 右键 →「在此处打开 PowerShell 窗口」），后面所有命令都在这个窗口里执行。

```powershell
Set-Location D:\pnp\solution\code
```

本文命令都写成 PowerShell 形式。PowerShell 里执行当前目录下的程序**必须带 `.\`**（`.\pnp.cmd`），设置环境变量用 `$env:名字 = '值'`。如果你用的是 cmd 窗口，把 `.\pnp.cmd` 写成 `pnp.cmd`、把 `$env:X = 'y'` 写成 `set X=y` 即可，其余相同。

要求：Windows 10/11 x64，自带的 Windows PowerShell 5.1；不需要管理员、不需要联网、不需要安装 Node.js/Python/Git。

## 第 2 步：配置模型（一条命令）

```powershell
.\pnp.cmd config
```

它会问四个问题，回车用括号里的默认值：

| 问题 | 填什么 |
|---|---|
| `PNP_MODEL_ENDPOINT` | 模型服务的 OpenAI 兼容**基地址**，不要带 `/chat/completions`（多数服务以 `/v1` 结尾；智谱是 `https://open.bigmodel.cn/api/paas/v4`，这也是默认值） |
| `PNP_MODEL_ID` | 模型名称（默认 `glm-4-flash`） |
| `PNP_MODEL_API_KEY` | API Key；没有就留空 |
| `PNP_MODEL_HEADERS` | 额外请求头，JSON 格式，例如需要 appid 时填 `{"appid":"12345"}`；不需要留空 |

答完它会把配置写进 `code\runtime\local.env`（以后想改，重新跑一遍或直接编辑这个文件）。

脚本化时可以不交互（PowerShell 把 `<` `>` 当保留符号，占位值要用引号包起来）：

```powershell
.\pnp.cmd config --endpoint https://open.bigmodel.cn/api/paas/v4 --model glm-4-flash --api-key '你的密钥'
```

`PNP_MODEL_HEADERS` 这种带引号的 JSON 建议用交互方式回答或直接编辑 `local.env`，命令行里传 JSON 容易被引号层层转义打断。评测系统如果习惯用环境变量，也可以不跑这条命令，直接在启动前设置上面四个变量，效果相同；环境变量优先于文件：

```powershell
$env:PNP_MODEL_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4'
$env:PNP_MODEL_ID       = 'glm-4-flash'
$env:PNP_MODEL_API_KEY  = '你的密钥'
```

内网模型的两个常见情况：地址是 `http://` 而不是 `https://` → 再执行 `$env:PNP_ALLOW_HTTP_ENDPOINTS = '1'`；证书是自签的 → `$env:PNP_MODEL_CA_FILE = 'D:\certs\internal-ca.pem'`，实在来不及配证书可临时 `$env:PNP_MODEL_TLS_INSECURE = '1'`。

## 第 3 步：自检（两条命令，可选但强烈建议）

```powershell
.\pnp.cmd selfcheck --engine opencode
.\pnp.cmd livecheck --engine opencode
```

- `selfcheck` 不用模型，用内置的模拟模型把全部接口跑一遍（建会话、事件流、任务、工具授权、中止、并发），最后打印 `[pnp] SELFCHECK PASS`。
- `livecheck` 用第 2 步配置的真实模型跑 8 项检查：就绪、事件流、建会话、让模型写一个文件（验 204、完成规则、busy/idle 事件、文件真实生成）、同一会话第二轮读回它（验历史）、中途中止一个长任务（验 `cancelled`）、反问/授权列表、删除会话，最后打印 `[pnp] LIVECHECK PASS`；证据文件在终端最后一行给出的目录里。

把两条命令里的 `opencode` 换成 `pi` 再各跑一次，就验证了第二个引擎。任何一条打印 `FAIL` 时，终端里会写明是哪一项、状态码和原因，日志在 `code\runtime\logs\`。

## 第 4 步：启动、切换引擎、停止

赛题规定的启动方式是 `gateway --engine <引擎> --port 6217`，本包里它就是 `gateway.cmd`：

```powershell
.\gateway.cmd --engine opencode --port 6217
```

赛题要求的环境变量切换同样支持，二选一即可：

```powershell
$env:AGENT_ENGINE = 'opencode'
.\gateway.cmd
```

参数：`--engine` 取 `opencode` 或 `pi`（不给时读 `AGENT_ENGINE`，两者都不给以 `ENGINE_NOT_FOUND` 退出，同时给且不一致以 `ENGINE_CONFIGURATION_CONFLICT` 退出）；`--port` 默认 `6217`；`--host` 默认 `localhost`（同时监听 `127.0.0.1` 与 `::1`，只允许回环地址）。

`gateway.cmd` 直接启动网关本身，不做任何准备工作——交付包里 Node、依赖、两个引擎都已就位，所以可以直接用。**如果你是从源码仓库运行**（没有 `dist\` 目录），先执行一次 `.\pnp.cmd bootstrap --engine opencode` 把依赖装好，之后 `gateway.cmd` 就能用了。

`.\pnp.cmd start --engine opencode --port 6217` 是等价的另一条路：它先补齐缺失的依赖再启动同一个网关，并额外把进程号写到 `runtime\gateway.pid`、把输出同时写进 `runtime\logs\`，所以想用 `.\pnp.cmd stop` 停止时用它。

网关会占住这个窗口。**另开一个 PowerShell 窗口**探测就绪：

```powershell
Invoke-RestMethod http://127.0.0.1:6217/health/ready
```

返回 `status : ready` 与 `engine : opencode` 就可以开始调用（首次启动引擎需要十几秒到一分钟；启动中该接口返回 503，PowerShell 会报「远程服务器返回错误」，属正常）。

切换引擎 = 停止后换引擎重启（不支持运行中切换）：

```powershell
# 在网关窗口按 Ctrl+C 停止，或在另一个窗口执行 .\pnp.cmd stop
$env:AGENT_ENGINE = 'pi'
.\gateway.cmd
```

两个引擎的数据目录默认相互独立（见 4.3），互不影响。

停止：在网关窗口按 Ctrl+C；用 `.\pnp.cmd start` 启动的还可以在另一个窗口执行 `.\pnp.cmd stop`（只结束 `runtime\gateway.pid` 记录的那一个进程，不碰任务打开的 Office 等程序）。

## 第 5 步：评测脚本怎么调用

地址 `http://127.0.0.1:6217`，请求体和响应体都是 JSON（UTF-8）。一次任务的完整顺序：

1. **建会话**：`POST /session`，`directory` 必填、绝对路径、不存在会自动创建。

   ```json
   {"title": "office_014", "directory": "D:\\test_data"}
   ```
   → `200 {"id":"ses_…","title":"office_014","created_at":"…","status":"idle"}`

2. **订阅事件流**（推荐）：`GET /event`，`text/event-stream`，每帧 `data: {"type":…,"properties":{…}}`。

3. **发任务**：`POST /session/{id}/prompt_async`

   ```json
   {
     "parts": [{"type": "text", "text": "请基于 D:\\test_data\\task.csv 做违约风险分析，保存为 D:\\test_data\\task_违约风险分析.md"}],
     "model": {"providerID": "any", "modelID": "any"},
     "agent": "assistant"
   }
   ```
   → `204 No Content` 表示本轮**全部执行完毕**（含所有工具调用）。这个请求会一直阻塞到结束，默认上限 15 分钟（`PNP_RUN_TIMEOUT_MS` 可调），请在后台线程调用。`model` 填任何值都可以，网关一律映射到第 2 步配置的模型；`parts[].text` 也可写成 `content`。

4. **取轨迹**：`GET /session/{id}/message` → 消息数组（见第 6 步）。

5. **查状态**：`GET /session/{id}` → `{"id":…,"status":"idle"|"busy","message_count":N}`；`GET /session/status` → `{"ses_…":{"type":"idle"}}`。

6. **中止**：`POST /session/{id}/abort`（或 `/stop`）→ `{"ok":true}`；被中止的那次 `prompt_async` 返回 `204`，轨迹记 `finish:"cancelled"`。

7. **反问与授权**（默认用不到）：`GET /question`、`POST /question/{id}/reply {"answers":[["方案 A"]]}`；`GET /permission`、`POST /permission/{id}/reply {"reply":"once"}`（`once`/`always`/`reject`）。默认引擎的反问由网关自动用第一个选项作答（`PNP_QUESTION_POLICY=auto`），权限默认全部放行，所以这两个列表通常为空；需要评测方逐项审批时见附录 B。

8. **清理**：`DELETE /session/{id}` → `{"ok":true}`。只删网关侧记录和引擎会话数据，不删 `directory` 和任务产物。

## 第 6 步：怎么判断完成、去哪拿结果

**一轮成功结束**同时满足三条：

1. `prompt_async` 返回 204；
2. 事件流出现 `session.status`（`{"status":{"type":"idle"}}`）与 `session.idle`（失败时是 `session.error`）；
3. 轨迹最后一条 `role` 为 `assistant`、`info.finish` 为 `"stop"`、`parts` 含 `{"type":"step-finish"}`。`info.finish` 为 `tool-calls` 表示还在中间步骤；`cancelled`/`error`/`length`/`interrupted` 是真实的非成功终态，不会伪装成功。

轨迹长这样：

```json
[
  {"id":"msg_…","role":"user","content":"请基于 …","created_at":"…"},
  {"id":"msg_…","role":"assistant","content":"","created_at":"…",
   "tool_calls":[{"id":"call_…","name":"office_csv_read","arguments":{"path":"D:\\test_data\\task.csv"}}],
   "info":{"role":"assistant","finish":"tool-calls"},
   "parts":[{"type":"tool","tool":"office_csv_read","callID":"call_…","state":{"status":"completed","title":"office_csv_read"}}]},
  {"id":"msg_…","role":"tool","tool_call_id":"call_…","tool_name":"office_csv_read","content":"{…}","created_at":"…"},
  {"id":"msg_…","role":"assistant","content":"已生成 D:\\test_data\\task_违约风险分析.md",
   "created_at":"…","info":{"role":"assistant","finish":"stop"},
   "parts":[{"type":"text","content":"已生成 …","text":"已生成 …"},{"type":"step-finish"}]}
]
```

**产物**：写在任务里点名的绝对路径上；任务没说位置时写在会话的 `directory`，最终回复里会列出每个产物的绝对路径。

**日志与数据**：网关日志 `code\runtime\logs\gateway-<引擎>.log`（错误另有 `.err.log`），进程号 `code\runtime\gateway.pid`，会话数据库与引擎会话数据 `code\runtime\data\<引擎>\`。日志里只有变量名，没有凭据。

**错误格式**统一为 `{"code":"…","message":"…"}`：

| 状态码 | code | 含义 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 请求体不合法（如 `directory` 不是绝对路径） |
| 403 | `WORKSPACE_FORBIDDEN` | 目录不可用（无权创建或位于系统目录） |
| 404 | `NOT_FOUND` | 会话或路由不存在 |
| 409 | `SESSION_BUSY` / `GATEWAY_BUSY` / `SESSION_UNAVAILABLE` | 同会话已有任务在跑 / 全局队列满（带 `Retry-After: 5`）/ 该会话上一轮停止未证实，`DELETE` 它即可解除 |
| 500 | `INTERNAL_ERROR` | 内部错误，日志里有一行脱敏说明 |
| 502 | `BAD_GATEWAY` | 引擎返回了不可解析的结果 |
| 503 | `EXECUTION_UNCERTAIN` 等 | 停止未证实、引擎不可用、模型配置缺失 |
| 504 | `EXECUTION_TIMEOUT` | 本轮超过 `PNP_RUN_TIMEOUT_MS` |

## 附录 A：常见问题

- **启动就退出，提示 `MODEL_ENVIRONMENT_MISSING`**：第 2 步没做或 `local.env` 不在 `code\runtime\`；信息里会列出缺哪个变量名。
- **提示 `INSECURE_MODEL_ENDPOINT`**：模型地址是 `http://`，执行 `$env:PNP_ALLOW_HTTP_ENDPOINTS = '1'` 后重启。
- **`.\pnp.cmd livecheck` 失败但 `selfcheck` 通过**：网关没问题，是模型或网络：检查 Key 是否正确、地址是不是基地址（多带了 `/chat/completions` 就会失败）、模型是否支持工具调用。
- **提示 `INSTANCE_LOCKED`**：上一个网关还在跑，先 `.\pnp.cmd stop`。
- **端口被占用**：换一个端口重启，例如 `.\gateway.cmd --engine opencode --port 6218`。用 `pnp.cmd` 也可以，但它必须知道引擎：`.\pnp.cmd start --engine opencode --port 6218`（只写 `--port` 会以「No engine selected」退出）。
- **想看引擎到底做了什么**：`GET /session/{id}/message`，或 `code\runtime\logs\`。

## 附录 B：更多配置（都可选）

配置文件是 `code\config\settings.json`，改完重启网关生效；格式说明在 `code\config\SETTINGS.md`。

- **权限**：`common.permissions`，`default` 为 `allow`/`ask`/`deny`，`operations` 按操作覆盖，例如 `{"write":"ask","shell":"deny"}`。不改文件也行：启动前 `$env:PNP_CONFIGURED_POLICY_OVERRIDES = '{"write":"ask"}'`，之后写文件前会发出 `permission.asked`，用第 5 步第 7 条的接口回复。
- **反问**：`$env:PNP_QUESTION_POLICY = 'ask'` 让反问真的等待回复（默认 `auto` 自动作答）。
- **工具**：`common.mcp.servers`。随包的 Office 工具（docx/xlsx/pptx/csv 读写、文件查找删除、打开本机应用、网页抓取）已启用，两个引擎共用。接内网 MCP 服务时照样加一项，凭据只写环境变量名：

  ```json
  "intranet": {"transport": "streamable-http", "urlEnvironment": "PNP_INTRANET_MCP_URL",
               "headerEnvironment": {"Authorization": "PNP_INTRANET_MCP_TOKEN"}, "enabled": true}
  ```
  `${PNP_CODE_ROOT}` 与 `${PNP_NODE}` 可用来引用包内路径和 Node。内网 `http://` 的 MCP 同样需要 `PNP_ALLOW_HTTP_ENDPOINTS=1`。
- **给引擎的行为指令**：`code\config\instructions\competition.md`（无人值守、不反问、绝对路径、产物落盘、Windows/PowerShell 环境、优先用 Office 工具），可按需增删。
- **按引擎单独配置**：`settings.json` 的 `cores.opencode` / `cores.pi`。
- **数据目录与超时**：`PNP_DATA_DIR`（默认 `code\runtime\data\<引擎>`）、`PNP_RUN_TIMEOUT_MS`（默认 900000）。

## 附录 C：从源码而不是交付包运行

交付包里已含 Node 24.19.0、依赖和两个引擎，零联网。直接用源码仓库（`engineering\code`）时，第一次 `.\pnp.cmd` 会自动下载 Node、执行 `npm ci`、编译并安装引擎，需要联网；内网可用镜像：`npm_config_registry=<内网 npm 镜像>`、`PNP_NODE_DOWNLOAD_URL=<镜像上的 node-v24.19.0-win-x64.zip>`（仍按固定 SHA-256 校验）、`PNP_NODE_HOME=<本机已装的 Node 24.19+ 目录>`。这些变量也可以写进 `code\runtime\local.env`。制作交付包：`node scripts/package-release.mjs --bundle --zip`。
