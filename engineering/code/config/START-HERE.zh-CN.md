# 模型与 MCP 配置上手

统一入口是 `engineering/code/config/settings.json`。现已默认启用 Office MCP 和 Desktop MCP，OpenCode、Pi 共用相同配置。

## API key 写在哪里

在 `engineering/code/runtime/local.env` 中填写：

```dotenv
PNP_MODEL_ENDPOINT=https://你的模型服务/接口基路径
PNP_MODEL_ID=服务端认识的模型名称
PNP_MODEL_API_KEY=你的API密钥
```

模型基地址由服务商决定；多数以 `/v1` 结尾，智谱是 `/api/paas/v4`。不要把 `/chat/completions` 填到基地址末尾。无鉴权的本地服务可以不填 API key。

已有 `local.env` 时直接编辑需要修改的行，不要用示例覆盖。也可在 `engineering/code` 运行 `pnp.cmd config`，交互输入密钥时不回显。本机已有配置，本轮验证没有改动其中的值。

`settings.json` 通过 `apiKeyEnvironment: "PNP_MODEL_API_KEY"` 引用变量名字，私有值保存在被 Git 和发布打包排除的 `runtime/local.env`。网关启动时自动加载，无论使用 `pnp.cmd`、`gateway.cmd` 还是 `npm start`。非空进程环境变量优先；配置文件有错误时不会留下部分加载的变量。

可选项：

```dotenv
PNP_MODEL_HEADERS={"appid":"你的appid"}
PNP_MODEL_CA_FILE=./runtime/intranet-ca.pem
```

修改 settings 或 local.env 后重启网关。路径迁移时只需设置 `PNP_SETTINGS` 指向另一份 settings 文件；`PNP_LOCAL_ENV_FILE` 可指定私有变量文件。相对路径以 `engineering/code` 为基准，指令文件路径以 settings 所在目录为基准。

## 引擎与多模型

`common` 定义共用模型、权限、MCP 和指令，`cores.opencode` / `cores.pi` 只覆盖需要区别的字段。例如只在 Pi 中关闭 Desktop MCP：

```json
"pi": {
  "mcp": { "servers": { "desktop": { "enabled": false } } }
}
```

完整多模型示例见 [SETTINGS.md](SETTINGS.md#minimal-multi-model-configuration)，示例的对象放在 `common.model` 中。每个模型使用独立的标识和凭据变量。请求使用配置解析后的 `providerID/modelID` 选择模型；未配置的标识默认映射到部署默认模型，并记录替换事实。需要严格选择时在 local.env 设置 `PNP_MODEL_STRICT=1`，未知标识会被拒绝。

换模型绑定请创建新会话；换引擎请停止后以另一个 `--engine` 启动。网关不会自动选模型、双跑引擎或执行外层多 Agent 调度。

## 添加 MCP 工具

新增工具服务只需向 `common.mcp.servers` 添加一个条目，不需要修改 Gateway/Core。支持本地 `stdio` 和远程 `streamable-http`。例如 Node MCP：

```json
"my-tool": {
  "transport": "stdio",
  "command": "${PNP_NODE}",
  "args": ["D:/my-tools/server.mjs"],
  "env": { "SERVICE_TOKEN": "PNP_MY_TOOL_TOKEN" },
  "enabled": true,
  "sideEffect": "external",
  "timeoutMs": 15000
}
```

在 local.env 填 `PNP_MY_TOOL_TOKEN=实际值`。`env` 的值是变量名，不是密钥。命令用绝对路径；包内脚本可以使用 `${PNP_CODE_ROOT}`，Node 使用 `${PNP_NODE}`。这两个路径占位符由运行时解析，复制项目后仍可使用。

Desktop MCP 提供 `desktop_list_apps` 和 `desktop_open_app`，支持 `notepad`、`outlook-classic`、`outlook-new`。先发现再打开；返回 `activation_requested` 只证明激活请求已提交，不代表界面就绪、登录成功或邮件发送。它没有收发邮件和通用 UI 自动化能力。详见 [Desktop MCP](../src/tools/desktop-mcp/README.md)。

## 验证与启动

在 `engineering/code` 下使用项目要求的 Node 24.19 或同主版本更新运行时：

```powershell
npm run build
npm run doctor -- --engine opencode
npm run doctor -- --engine pi
.\pnp.cmd selfcheck --engine opencode
.\pnp.cmd selfcheck --engine pi
.\pnp.cmd start --engine opencode
```

`pnp.cmd` 会查找项目自带或本机已配置的运行时和引擎。Doctor 只检查本地配置与 Windows helper，`ready_untested` 不代表模型调用成功；selfcheck 使用真实引擎和本地模拟模型，实际测试 MCP 读文件与错误回传。显式执行 `pnp.cmd livecheck --engine pi` 才会调用你的真实模型服务并写测试文件。

验证 Desktop MCP 在两个引擎中的发现调用，可直接运行 `node scripts/e2e/ci-smoke.mjs --engine pi --expect-desktop-mcp`（需预先配置引擎位置）。独立的 `node scripts/e2e/desktop-smoke.mjs --open-notepad` 会打开空白记事本并验证 MCP 进程停止后应用仍存活；它不会关闭现有或激活后的用户窗口。
