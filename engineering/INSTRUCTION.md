# PNP Agent 网关：部署、执行与交付说明

本文件是评测方的操作手册，自足、可脚本化。四个部分依次是：环境准备、执行方式、执行完成判定、生成结果交付件说明。

解压后的目录结构：

```text
solution\
  INSTRUCTION.md          本文件
  code\                   全部源码与运行所需内容
    pnp.cmd               启动器（准备依赖 + 启动 / 自检 / 停止）
    gateway.cmd           直连入口（依赖已就绪时使用）
    config\settings.json  模型、权限、工具（MCP）的唯一配置文件
    config\instructions\competition.md   交给引擎的行为指令
    dist\                 已编译的网关程序
    node_modules\         已安装的运行期依赖
    runtime\bootstrap\    包内自带的 Node 运行时与两个引擎
    BUNDLE-MANIFEST.json  包内各组件的版本与校验值
```

## 1. 环境准备

### 1.1 系统要求

- Windows 10/11 x64；自带的 Windows PowerShell 5.1 即可，无需安装 PowerShell 7。
- 不需要管理员权限、不需要 WSL、Docker、数据库或 Python。
- **不需要联网**：Node.js、依赖、两个 Agent 引擎都已打入本包。
- 建议解压到不含空格的短路径，例如 `D:\pnp`；后文以 `D:\pnp\solution\code` 为工作目录。

### 1.2 包内已含内容

| 组件 | 版本 | 位置 |
|---|---|---|
| Node.js 运行时（Windows x64） | 24.19.0 | `code\runtime\bootstrap\node-v24.19.0-win-x64\` |
| 运行期依赖 | 见 `package-lock.json` | `code\node_modules\` |
| 已编译网关 | 本包源码 | `code\dist\` |
| Agent 引擎 OpenCode | 1.18.29 | `code\runtime\bootstrap\engines\opencode\1.18.29\` |
| Agent 引擎 Pi | 0.85.1 | `code\runtime\bootstrap\engines\pi\0.85.1\` |
| Office 文档工具服务（MCP） | 随包 | `code\dist\tools\office-mcp\main.js` |

启动器优先使用上述包内组件，全部命中时不访问网络。各组件的 SHA-256 见 `code\BUNDLE-MANIFEST.json`。

### 1.3 配置模型服务（唯一必做的准备工作）

网关本身不携带任何模型地址或凭据，只认下列环境变量：

| 变量 | 必填 | 含义 |
|---|---|---|
| `PNP_MODEL_ENDPOINT` | 是 | OpenAI 兼容服务的**基地址**，以 `/v1` 结尾（不要写 `/chat/completions`） |
| `PNP_MODEL_ID` | 是 | 该服务认识的模型名称，例如 `Qwen2.5-72B-Instruct` |
| `PNP_MODEL_API_KEY` | 否 | 有值时以 `Authorization: Bearer <值>` 发送 |
| `PNP_MODEL_HEADERS` | 否 | 额外请求头，JSON 对象，例如 appid：`{"appid":"12345"}` |
| `PNP_MODEL_CA_FILE` | 否 | 私有 CA 的 PEM 文件路径（自签名证书时使用） |

三种设置方式，任选其一：

```bat
:: 方式一：cmd 窗口                      :: 方式二：PowerShell 窗口
set PNP_MODEL_ENDPOINT=https://主机/v1   ::   $env:PNP_MODEL_ENDPOINT = 'https://主机/v1'
set PNP_MODEL_ID=模型名称                ::   $env:PNP_MODEL_ID       = '模型名称'
set PNP_MODEL_API_KEY=凭据               ::   $env:PNP_MODEL_API_KEY  = '凭据'
```

方式三：把它们写进 `code\runtime\local.env`（每行 `名称=值`，`#` 开头为注释）。网关启动时自动加载该文件，日志只打印变量**名字**，不打印取值；进程里已存在的同名变量优先。模板见 `code\config\local.env.example`，用 `PNP_LOCAL_ENV_FILE` 可指向别的文件。

两个特殊开关：

- 模型服务是内网 `http://`（非回环地址）时，设置 `PNP_ALLOW_HTTP_ENDPOINTS=1`，否则启动会以 `INSECURE_MODEL_ENDPOINT` 失败。
- 证书无法通过校验且来不及配置 CA 时，可设 `PNP_MODEL_TLS_INSECURE=1`（关闭引擎进程的 TLS 校验，最后手段，优先用 `PNP_MODEL_CA_FILE`）。

必填变量缺失时，网关在监听端口**之前**以 `MODEL_ENVIRONMENT_MISSING` 退出，并列出缺哪个变量名。

### 1.4 验证部署

```bat
cd /d D:\pnp\solution\code
pnp.cmd selfcheck --engine opencode
```

该命令准备依赖后，用**内置的本地模拟模型服务**跑一遍完整链路（建会话、发提示词、工具调用、权限回环、中止、并发），最后打印 `[pnp] SELFCHECK PASS` 或 `FAIL`，退出码 0 表示通过。它不使用上面配置的真实模型，也不联网，可先于模型配置执行。把 `--engine opencode` 换成 `--engine pi` 可同样验证第二个引擎。

### 1.5 只有从源码运行时才需要的镜像变量

本包已自带全部依赖，正常无需下列变量；仅当在**未打包的源码**上运行时才需要：`npm_config_registry`（内网 npm 镜像）、`PNP_NODE_DOWNLOAD_URL`（内网镜像上的 `node-v24.19.0-win-x64.zip`，仍按固定 SHA-256 校验）、`PNP_NODE_HOME`（本机已装的 Node.js 24.19+ 目录，用它代替下载）。

## 2. 执行方式

### 2.1 启动命令

引擎用环境变量 `AGENT_ENGINE` 选择，取值 `opencode` 或 `pi`：

```bat
cd /d D:\pnp\solution\code
set AGENT_ENGINE=opencode
pnp.cmd start
```

等价写法（两者同时给出且不一致时启动失败，不会二选一）：

```bat
pnp.cmd start --engine opencode --port 6217 --host localhost
```

参数：`--port` 默认 `6217`；`--host` 默认 `localhost`（同时监听 `127.0.0.1` 与 `::1`，只允许回环地址）。

依赖已就绪时也可直接用 `gateway.cmd --engine opencode --port 6217`，它跳过准备步骤，启动的是同一个网关。

### 2.2 就绪判定

反复请求 `GET /health/ready`，返回 **200**（`{"status":"ready","engine":"opencode"}`）即可开始调用；启动中返回 503。首次启动引擎需要十几秒到一分钟。

### 2.3 调用序列

以 `$base = http://127.0.0.1:6217` 为例，全部请求体与响应体均为 JSON（UTF-8）。

1. **建会话**（`directory` 必填，绝对路径；不存在时自动创建）

   `POST /session`

   ```json
   {"title": "office_014", "directory": "D:\\test_data"}
   ```

   → `200`：`{"id":"ses_5f6c…","title":"office_014","created_at":"2026-09-08T06:54:07.343Z","status":"idle"}`

2. **订阅事件流**（可选但推荐）：`GET /event`，`text/event-stream`，每帧 `data: {"type":…,"properties":{…}}`。

3. **发送任务**（阻塞直到本轮执行结束）

   `POST /session/{id}/prompt_async`

   ```json
   {
     "parts": [{"type": "text", "text": "请基于 D:\\test_data\\task.csv 做违约风险分析，保存为 D:\\test_data\\task_违约风险分析.md"}],
     "model": {"providerID": "any", "modelID": "any"},
     "agent": "assistant"
   }
   ```

   → `204 No Content`（无响应体）表示本轮**已经全部执行完毕**并已落库。

   `model` 里的 `providerID`/`modelID` 取任意值都可以：网关把它映射到上面配置的那一个模型，不会因为名字对不上而拒绝。省略 `model` 字段同样使用该模型。`parts[]` 的文本字段写 `text` 或 `content` 都接受。

   该请求**同步阻塞整轮执行**（含全部工具调用），默认上限 15 分钟，可用 `PNP_RUN_TIMEOUT_MS`（毫秒）调整。建议在后台线程调用，同时在主线程读事件流。

4. **取轨迹**：`GET /session/{id}/message` → 消息数组，见第 3 节。

5. **查状态**：`GET /session/{id}` → `{"id":…,"status":"idle"|"busy","message_count":N}`；`GET /session/status` → `{"ses_…":{"type":"idle"}}`。

6. **中止**：`POST /session/{id}/abort`（等价路径 `.../stop`）→ `{"ok":true}`；被中止的那次 `prompt_async` 返回 `204`，轨迹记 `finish:"cancelled"` 且无 `step-finish`。

7. **反问与授权**（默认不会用到，见 2.6）：
   - `GET /question` → `[{"id":"qst_…","sessionID":"ses_…","questions":[{"question":"…","options":[{"label":"方案 A"}]}],"created_at":"…"}]`；`POST /question/{id}/reply` 请求体 `{"answers": [["方案 A"]]}` → `{"ok":true}`。
   - `GET /permission` → `[{"id":"prm_…","sessionID":"ses_…","permission":"write","patterns":["D:\\test_data\\out.md"],"created_at":"…"}]`；`POST /permission/{id}/reply` 请求体 `{"reply":"once"}`（可选 `always`、`reject`）→ `{"ok":true}`。

8. **清理**：`DELETE /session/{id}` → `{"ok":true}`。

### 2.4 切换引擎

不支持运行中热切换。停止当前网关 → 改 `AGENT_ENGINE`（或 `--engine`）→ 重新启动：

```bat
pnp.cmd stop
set AGENT_ENGINE=pi
pnp.cmd start
```

两个引擎的数据目录默认相互独立（见 4.3），互不影响。

### 2.5 停止

`pnp.cmd stop` 结束 `code\runtime\gateway.pid` 里记录的那一个进程并删除该文件；在网关自己的控制台按 `Ctrl+C` 同样是正常停止。两种方式都不会按进程名批量结束进程，也不会关闭任务打开的 Office 应用。

### 2.6 反问与授权的默认行为

- 默认 `PNP_QUESTION_POLICY=auto`：引擎反问时网关立即用第一个选项自动作答并继续执行，不阻塞。需要人工/脚本作答时设为 `ask`，再用 2.3 第 7 条的接口回复。
- 权限默认全部放行，`GET /permission` 通常为空数组。需要评测方逐项审批时设置 `PNP_CONFIGURED_POLICY_OVERRIDES={"write":"ask"}`（取值 `allow`/`ask`/`deny`），网关就会在写文件前发出授权请求并等待回复。

## 3. 执行完成判定

### 3.1 正常完成

同时满足以下三条即为本轮成功结束：

1. `POST /session/{id}/prompt_async` 返回 **204**；
2. 事件流出现 `session.status`（`{"status":{"type":"idle"}}`）与 `session.idle`；失败时出现 `session.error`；
3. `GET /session/{id}/message` 的最后一条消息 `role` 为 `assistant`、`info.finish` 为 `"stop"`，且 `parts` 中含 `{"type":"step-finish"}`。

只有 `step-finish` 而 `info.finish` 不是 `stop` 不算完成。消息形状：

```json
[
  {"id":"msg_…","role":"user","content":"请基于 …","created_at":"…"},
  {"id":"msg_…","role":"assistant","content":"","created_at":"…",
   "tool_calls":[{"id":"call_…","name":"office.docx_extract","arguments":{"path":"D:\\test_data\\x.docx"}}],
   "info":{"role":"assistant","finish":"tool-calls"},
   "parts":[{"type":"tool","tool":"office.docx_extract","callID":"call_…","state":{"status":"completed","title":"office.docx_extract"}}]},
  {"id":"msg_…","role":"tool","tool_call_id":"call_…","tool_name":"office.docx_extract","content":"{…}","created_at":"…"},
  {"id":"msg_…","role":"assistant","content":"已生成 D:\\test_data\\task_违约风险分析.md",
   "created_at":"…","info":{"role":"assistant","finish":"stop"},
   "parts":[{"type":"text","content":"已生成 …","text":"已生成 …"},{"type":"step-finish"}]}
]
```

工具调用记录在 `"role":"tool"` 的消息与 `{"type":"tool","tool":"write","state":{"status":"completed","title":"…"}}` 的 part 中。`info.finish` 的其他取值：`tool-calls`（中间步骤）、`cancelled`（被中止）、`error`、`length`、`interrupted`（停止未证实）。失败的轮次不会伪装成功。

### 3.2 事件类型

`server.connected`、`server.heartbeat`（每 15 秒）、`session.status`、`session.idle`、`session.error`、`message.part.updated`、`question.asked`、`permission.asked`、`model.resolved`。

### 3.3 错误格式与状态码

错误响应统一为 `{"code":"…","message":"…"}`：

| 状态码 | `code` | 含义 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 请求体不合法（如 `directory` 不是绝对路径） |
| 403 | `WORKSPACE_FORBIDDEN` | 目录不可用（无权创建，或位于 Windows 系统目录下） |
| 404 | `NOT_FOUND` | 会话或路由不存在 |
| 409 | `SESSION_BUSY` | 同一会话已有执行中或排队中的请求 |
| 409 | `GATEWAY_BUSY` | 全局执行队列已满，响应带 `Retry-After: 5`，稍后重试 |
| 409 | `SESSION_UNAVAILABLE` | 该会话的上一轮停止未证实，被围栏阻断；`DELETE` 该会话即可解除 |
| 500 | `INTERNAL_ERROR` | 未归类的内部错误 |
| 502 | `BAD_GATEWAY` | 引擎返回了不可解析的结果 |
| 503 | `EXECUTION_UNCERTAIN` 等 | 停止未证实、引擎不可用、模型环境缺失 |
| 504 | `EXECUTION_TIMEOUT` | 本轮超过 `PNP_RUN_TIMEOUT_MS` |

409/503/504 不属于接口规范的基础错误集，是本网关为"不伪造成功"而保留的真实状态，评测脚本按上表处理即可。

## 4. 生成结果交付件说明

### 4.1 任务产物

任务产物就是提示词里点名的那些文件，写在提示词给出的**绝对路径**上（例如 `D:\test_data\task_违约风险分析.md`），不会被复制或移动到别处。提示词未指定位置时写入会话的 `directory`，并在最终回复里列出每个产物的绝对路径。会话 `directory` 之外的绝对路径同样允许访问。

### 4.2 执行轨迹

`GET /session/{id}/message` 返回本会话完整轨迹（用户消息、模型文本、工具调用与结果、终态），即评分所需的 rollout 记录。建议在 `DELETE` 之前取走并保存。

### 4.3 日志与数据目录

| 内容 | 路径 |
|---|---|
| 网关标准输出日志 | `code\runtime\logs\gateway-<引擎>.log` |
| 网关错误输出日志 | `code\runtime\logs\gateway-<引擎>.err.log` |
| 运行中的进程号 | `code\runtime\gateway.pid` |
| 会话数据库与原生会话数据 | `code\runtime\data\<引擎>\`（可用 `PNP_DATA_DIR` 改到别处） |

日志与数据目录里不会出现模型凭据：凭据只存在于进程环境变量中，日志只记录变量名。

### 4.4 `DELETE /session/{id}` 删除什么

只删除本系统自己的东西：网关侧的会话记录、该会话的原生引擎会话数据、临时授权记忆。**不会**删除会话 `directory`、不会删除任务产物文件、不会关闭任何应用程序。

## 5. 扩展工具与指令（可选）

- **内置 Office 工具**：`code\dist\tools\office-mcp\main.js` 提供 docx / xlsx / pptx / csv 的读取、生成与修改，以及文件查找删除、启动本机应用等能力，默认已在 `settings.json` 中启用，两个引擎共用。
- **增加内网 MCP 工具**：在 `code\config\settings.json` 的 `common.mcp.servers` 里新增一项即可。`${PNP_CODE_ROOT}`、`${PNP_NODE}` 分别解析为 `code\` 目录与当前 Node 可执行文件；凭据写变量名（`env` / `headerEnvironment`），不写取值。远端 MCP 若是内网 `http://`，同样需要 `PNP_ALLOW_HTTP_ENDPOINTS=1`。

  ```json
  "servers": {
    "office": {"transport": "stdio", "command": "${PNP_NODE}",
               "args": ["${PNP_CODE_ROOT}/dist/tools/office-mcp/main.js"], "enabled": true},
    "intranet": {"transport": "streamable-http", "urlEnvironment": "PNP_INTRANET_MCP_URL",
                 "headerEnvironment": {"Authorization": "PNP_INTRANET_MCP_TOKEN"}, "enabled": true}
  }
  ```

- **调整行为指令**：`code\config\instructions\competition.md` 是交给两个引擎的系统指令（无人值守、不反问、绝对路径、产物落盘、Windows/PowerShell 环境、优先使用 Office 工具）。按需增删条目，改完重启网关生效。
