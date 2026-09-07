# PNP Windows 内网快速启动

这份说明只回答四件事：**怎么准备配置、怎么一键安装依赖并启动、启动参数有哪些、模型/权限/MCP 怎么配。** 完整协议仍以 [`INSTRUCTION.md`](INSTRUCTION.md) 为准。

## 1. 最短路径

在仓库的 `engineering/code` 目录下操作。

### 第一次准备私有配置

```powershell
New-Item -ItemType Directory -Force runtime | Out-Null
Copy-Item config/local.env.example runtime/local.env
Copy-Item config/settings.his.example.json runtime/settings.json
notepad runtime/local.env
```

`runtime/` 已被 Git 忽略，真实 API Key 不进入仓库。

在 `runtime/local.env` 中至少配置：

```text
PNP_SETTINGS=runtime/settings.json
PNP_HIS_MODEL_ENDPOINT=https://<内部模型通道>/v1
PNP_HIS_AUTHORIZATION=Bearer <API-KEY>
PNP_MODEL_STRICT=1
```

模型 API Key 只放环境文件，不要写进 `settings.json`。

### 一条命令自动准备并启动

```powershell
.\pnp.cmd start --engine opencode --port 6217
```

第一次执行会尽量自动完成：

1. 检查 Node.js；本机没有兼容版本时下载并校验固定的 Node.js 24.19.0 Windows x64 ZIP；
2. 根据 `package-lock.json` 自动执行 `npm ci`；
3. 自动编译 PNP Gateway；
4. 根据 Engine 元数据自动准备对应 Harness；OpenCode 当前固定安装 `opencode-ai@1.18.29` 到 `runtime/bootstrap/`；
5. 启动同一个赛题 Gateway，监听默认端口 `6217`。

以后再次启动会复用已经准备好的依赖，不会每次重新下载。

只准备依赖、不启动：

```powershell
.\pnp.cmd bootstrap --engine opencode
```

## 2. 启动命令和参数

正式的 Engine 切换方式是**启动参数 `--engine`**。没有默认 Engine，必须显式指定。

```powershell
.\pnp.cmd start --engine <engineId> [--port <port>] [--host <host>]
```

参数：

| 参数 | 必填 | 默认值 | 说明 |
|---|---:|---|---|
| `--engine` | 是 | 无 | 本轮 Gateway 使用的 Agent Core，例如 `opencode`、`pi`、`hermes` |
| `--port` | 否 | `6217` | 本地 Gateway 端口 |
| `--host` | 否 | `localhost` | 只允许 `localhost`、`127.0.0.1`、`::1` |

例子：

```powershell
# OpenCode
.\pnp.cmd start --engine opencode --port 6217

# Pi（实现并准备完成后）
.\pnp.cmd start --engine pi --port 6217

# Hermes（实现并准备完成后）
.\pnp.cmd start --engine hermes --port 6217
```

停止当前 Gateway 后，用另一个 `--engine` 重新启动，就是赛题要求的多 Engine 切换；不是运行时热切换。

如果裁判或开发者已经手工安装好全部依赖，也可以跳过自动准备，直接使用正式入口：

```powershell
.\gateway.cmd --engine opencode --port 6217
```

`pnp.cmd` 和 `gateway.cmd` 最终启动的是同一个 Gateway 主程序；区别只是 `pnp.cmd` 会先自动准备依赖。

帮助：

```powershell
.\pnp.cmd help
```

## 3. 统一 settings：模型、权限、MCP

默认统一配置入口是：

```text
engineering/code/config/settings.json
```

内网推荐使用仓库外或 `runtime/` 下的私有副本，并通过：

```text
PNP_SETTINGS=runtime/settings.json
```

指定。

配置结构只有一个：

```json
{
  "version": 1,
  "common": {
    "model": {},
    "permissions": {},
    "mcp": { "servers": {} }
  },
  "cores": {
    "opencode": {},
    "pi": {},
    "hermes": {}
  }
}
```

规则：先读 `common`，再用 `cores.<engineId>` 覆盖。某个 Core 没有单独配置，就完全继承公共配置。

### 3.1 模型配置

你现在的两个内网模型可以这样配置：

```json
"model": {
  "default": {
    "providerID": "his",
    "modelID": "GLM-V5.1-DX"
  },
  "models": [
    {
      "selection": {
        "providerID": "his",
        "modelID": "GLM-V5.1-DX"
      },
      "endpointEnvironment": "PNP_HIS_MODEL_ENDPOINT",
      "protocol": "openai-chat",
      "headerEnvironment": {
        "Authorization": "PNP_HIS_AUTHORIZATION"
      }
    },
    {
      "selection": {
        "providerID": "his",
        "modelID": "Qwen-V3.6-27B-DX"
      },
      "endpointEnvironment": "PNP_HIS_MODEL_ENDPOINT",
      "protocol": "openai-chat",
      "headerEnvironment": {
        "Authorization": "PNP_HIS_AUTHORIZATION"
      }
    }
  ]
}
```

真正的地址和 Key 在 `runtime/local.env`：

```text
PNP_HIS_MODEL_ENDPOINT=https://<内部模型通道>/v1
PNP_HIS_AUTHORIZATION=Bearer <API-KEY>
PNP_MODEL_STRICT=1
```

如果只想让 OpenCode 默认使用 Qwen，而其他 Core 仍用公共默认模型：

```json
"cores": {
  "opencode": {
    "model": {
      "default": {
        "providerID": "his",
        "modelID": "Qwen-V3.6-27B-DX"
      }
    }
  }
}
```

### 3.2 权限配置

权限值只有：

- `allow`：直接执行；
- `ask`：进入 PNP 权限确认接口；
- `deny`：直接拒绝，人工回复也不能覆盖。

例如公共默认允许读操作，但写文件和执行命令需要确认：

```json
"permissions": {
  "default": "allow",
  "operations": {
    "read": "allow",
    "write": "ask",
    "edit": "ask",
    "bash": "ask"
  }
}
```

如果某个 Core 的 operation 名称不同，可以在 Core 下单独覆盖：

```json
"cores": {
  "opencode": {
    "permissions": {
      "operations": {
        "bash": "ask"
      }
    }
  }
}
```

### 3.3 MCP 配置

C 完成员工助手 CLI -> MCP 的适配后，只需要把 C 交付的 MCP Server 填进统一 settings。

本地 stdio MCP 示例：

```json
"mcp": {
  "servers": {
    "welink": {
      "transport": "stdio",
      "command": "D:\\pnp-mcp\\welink-mcp.exe",
      "args": ["serve"],
      "env": {},
      "enabled": true,
      "sideEffect": "external",
      "timeoutMs": 10000
    }
  }
}
```

远程 Streamable HTTP MCP 示例：

```json
"mcp": {
  "servers": {
    "knowledge": {
      "transport": "streamable-http",
      "urlEnvironment": "PNP_KNOWLEDGE_MCP_URL",
      "headerEnvironment": {
        "Authorization": "PNP_KNOWLEDGE_MCP_AUTHORIZATION"
      },
      "enabled": true,
      "timeoutMs": 10000
    }
  }
}
```

真实 URL、Token 仍放 `runtime/local.env`，不写进 JSON。

完整 settings 格式见 [`code/config/SETTINGS.md`](code/config/SETTINGS.md)，C 的 MCP 交付规范见 [`docs/spec/mcp-integration-profile.md`](docs/spec/mcp-integration-profile.md)。

## 4. 内网无法访问公网怎么办

自动启动器不会绕过企业网络策略。

如果 npm 要走内网镜像，在 `runtime/local.env` 中配置：

```text
npm_config_registry=https://<内部 npm 镜像>/
```

如果不能访问 `nodejs.org`，把官方 `node-v24.19.0-win-x64.zip` 镜像到内网后配置：

```text
PNP_NODE_DOWNLOAD_URL=https://<内部镜像>/node-v24.19.0-win-x64.zip
```

启动器仍会校验固定 SHA256。也可以提前安装 Node 24.19+，或者通过 `PNP_NODE_HOME` 指向本机安装目录。

如果某个 Harness 不能由 PNP 自动安装，启动器会明确告诉你需要配置的 executable 环境变量。赛题 FAQ 允许裁判手工安装 Harness 依赖；安装后仍通过同一个 Gateway API 评测。

## 5. 启动成功后怎么验证

```powershell
$base = 'http://127.0.0.1:6217'
Invoke-RestMethod "$base/health/live"
Invoke-RestMethod "$base/health/ready"
```

创建 Session：

```powershell
$session = Invoke-RestMethod -Method Post -Uri "$base/session" -ContentType 'application/json' -Body (@{
  directory = 'D:\test_data'
  title = 'PNP local smoke'
} | ConvertTo-Json)
```

发一个最小模型请求：

```powershell
$body = @{
  parts = @(@{ type = 'text'; text = '请只回复 PNP_MODEL_OK' })
  model = @{ providerID = 'his'; modelID = 'GLM-V5.1-DX' }
} | ConvertTo-Json -Depth 10

Invoke-WebRequest -Method Post -Uri "$base/session/$($session.id)/prompt_async" -ContentType 'application/json' -Body $body
Invoke-RestMethod "$base/session/$($session.id)/message" | ConvertTo-Json -Depth 20
```

`prompt_async` 正常完成返回 HTTP 204。

评测文件由沙箱预置，因此评测时只需要让 `POST /session` 的 `directory` 指向裁判给出的工作目录，不要把评测数据打进代码包。

## 6. 第一次内网联调建议顺序

```text
1. pnp.cmd bootstrap --engine opencode
2. 配 runtime/local.env + runtime/settings.json
3. pnp.cmd start --engine opencode --port 6217
4. health/live + health/ready
5. 普通模型对话
6. 文件 Tool Calling
7. ask / reject 权限闭环
8. 接 C 提供的 MCP Server
9. 切换另一个 Engine，用同一组 Gateway API 重测
```

FAQ 已确认评测只依据网关接口执行，Harness 可以由作品自动准备，也允许裁判手工安装。因此 PNP 的原则是：**优先自动准备，手工安装可兜底，但最终始终使用同一套本地 Gateway API。**
