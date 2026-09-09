# 模型、Settings 与 MCP 验证交付

## 身份与版本

- 日期：2026-09-09；工作包：共同配置/DFX、A/B 引擎互操作、C07 桌面工具子集。
- 公共基线：`c3403b9015f7107cf169c1fbf25f6a11c8293511`；本轮为未提交工作区修改，不宣称新的 commit 验收。
- 公共契约：1.1.0；未修改公共类型、数据库或依赖版本。
- 依赖锁 SHA-256：`009f2c2a64fad230e671d39b20e4c673c42f2f7f8544cead9fa5391ed8a1dfdd`。
- 环境：Windows 原生，Node 24.19.0；OpenCode 1.18.29 / ACP，Pi 0.85.1 / RPC。
- 测试模型：本地 Chat Completions 模拟服务；另使用本机已有的 `glm-4-flash` 配置完成真实服务验证。未更换模型或凭据。

## 第一性原则与赛题对应

验收从四个事实展开：配置确实加载、请求确实送达指定引擎/模型、工具产生真实结果、结果与终态可追溯且清理不撤销用户产物。进程启动、请求 ACK、204、Doctor 的 `ready_untested` 都不能单独证明业务任务完成。

- R02/R03：两种真实 Harness 通过同一 HTTP API，独立进程/会话；没有以两种模型冒充两种引擎。
- R05/E02/I01：模型 ID、端点、鉴权、环境优先级、MCP 注册/调用/结果回传分别验证；外网模型证据不冒充内网证据。
- R06/R07/F02/F07：保留真实工具成功/失败、审批允许与拒绝、取消、SSE、消息历史和落盘结果。
- F08/I03：会话删除后文件保留；桌面应用不直接作为受管引擎子进程启动，独立核验应用生命周期。
- 灵活性放在共用 settings、IntegrationProvider、Engine Adapter 和标准 MCP 边界；没有增加外层 Agent Loop、自动模型路由或改变 Core 的引擎无关性。

## 修改范围

本轮文件（相对 `engineering/`）：

- `code/src/config/{local-env,settings}.ts`
- `code/src/integration/index.ts`、`code/src/integration/configured/provider.ts`
- `code/src/drivers/pi-rpc/extension/pnp-bridge.ts`
- `code/src/tools/desktop-mcp/{errors,main,server,windows}.ts`、同目录 `README.md`
- `code/config/{settings.json,SETTINGS.md,local.env.example,START-HERE.zh-CN.md}`、`code/config/instructions/competition.md`
- `code/scripts/{doctor.mjs,doctor-config.mjs}`
- `code/scripts/refresh-manifest.mjs`：Git 文件列表改用 NUL 分隔，修复中文文件名被转义后无法生成校验清单的问题。
- `code/scripts/e2e/{ci-smoke,mock-model-server,run-e2e,desktop-smoke}.mjs`
- `code/tests/unit/{local-env,mcp-settings,model-environment,doctor}.test.ts`
- `code/tests/adapters/pi/{bridge-extension,text-payload}.test.ts`
- `code/tests/adapters/desktop-mcp/{harness.ts,server.test.ts}`
- `code/README.md`、本交接文件及 `verification/settings-mcp-2026-09-09.json`
- 自动生成的 `FILE-MANIFEST.json`、`SHA256SUMS.txt`、`REVIEW-INDEX.md`

工作期间还观察到外部并行修改 `gateway*`、`package.json`、PowerShell 编码检查及根 `docs/` 下的评测脚本。本轮不覆盖、不回滚、不将这些文件计入自己的实现贡献；最终基线检查以当时实际工作区为准。

## 实现与调用

1. **配置加载**：local.env 完整解析后才写入环境，错误行不留下部分状态；非空进程环境优先。统一配置、旧 profile 与变量解析使用同一份注入环境。模型变量替换产生重复 `providerID/modelID` 时明确拒绝，避免静默选错端点。
2. **模型与 MCP 鉴权**：重复/非法 HTTP header 名被拒绝；模型头合并按大小写无关规则覆盖；换行等非法值不下发。MCP 变量缺失/空白返回变量名诊断，不回显值。每轮检查所选模型的 CA 文件，不仅检查启动时默认模型。
3. **Pi 的真实兼容缺陷**：GLM-4-Flash 接受 Pi 的纯文本 `content` 数组，却返回“没有收到具体任务”或离题工具调用。对同一提示仅将纯文本数组改为字符串后，模型完成真实写入和读回。修复使用 Pi 0.85.1 官方 `before_provider_request` 扩展钩子，只规范化 Chat Completions 用户纯文本；其他 API、图片、缓存元数据和原始对象保持原样。未增加代理、换模型或模拟答案。依据为随锁定 Pi 安装的 `docs/extensions.md` 与实际请求对照。
4. **Doctor**：与网关使用相同的 local.env、引擎选择和模型配置解析；报告本地结构准备状态及启用 MCP 的命令/入口存在性；无实时模型调用、无 MCP handshake。独立 legacy profile 不被默认 settings 强行覆盖，legacy 工具列为未检查。
5. **Desktop MCP**：默认共用配置注册 `desktop` stdio 服务。`desktop_list_apps` 识别 Notepad、经典/新 Outlook；`desktop_open_app` 仅接受固定 appId，经 Windows Shell 提交激活，返回 `activation_requested`。隐藏 PowerShell helper 支持取消、超时和有界退出核验，不提供发邮件、UI 自动化或关闭用户应用。参考 [Microsoft Shell.ShellExecute](https://learn.microsoft.com/en-us/windows/win32/shell/shell-shellexecute)。
6. **端到端证据**：真实引擎测试增加中文/空格路径 CSV 与每次随机标记、缺失文件错误、Desktop 工具发现。模拟模型回显实际工具回包，测试同时检查原生调用、规范历史和回到模型的结果；离线测试禁止读取操作者的私有 local.env。

API key 配置：`code/runtime/local.env` 中的 `PNP_MODEL_API_KEY`；端点和模型 ID 分别为 `PNP_MODEL_ENDPOINT` / `PNP_MODEL_ID`。统一设置在 `code/config/settings.json`，其中只引用变量名。现有私有文件未被改写。详见 [中文配置指南](../../code/config/START-HERE.zh-CN.md)。

## 测试证据

所有命令从 `engineering/code` 执行，使用项目内 Node 24.19.0。真实引擎位置通过 `PNP_OPENCODE_EXE_PATH` 或 `PNP_PI_ENTRY`/`PNP_PI_NODE` 指向已存在的固定版本安装，无新增依赖。下列报告均保存在 Git 忽略的 `code/runtime/logs/`，公开摘要不包含凭据或私有 endpoint。

| 测试 | 命令/入口 | 结果文件 | 结论 |
|---|---|---|---|
| 构建与完整检查 | `npm run build`、`npm run check` | `audit-final-check.log` | 469 项单元/适配器：467 通过、2 跳过；9 项 HTTP 契约全部通过；类型、边界、strip-only 通过 |
| 基线门禁 | `npm run foundation:check` | `audit-foundation.log` | 通过：469 项单元/适配器中 467 通过、2 跳过，9 项契约通过；清单、类型、边界、strip-only、PowerShell 编码均通过 |
| OpenCode + 模拟模型 + 真 MCP | `node scripts/e2e/ci-smoke.mjs --engine opencode --gateway-port 6321 --expect-desktop-mcp` | `audit-final-opencode/e2e-report.json` | 20 通过、1 跳过、0 失败 |
| Pi + 模拟模型 + 真 MCP | 同上，`--engine pi --gateway-port 6322` | `audit-final-pi/e2e-report.json` | 20 通过、1 跳过、0 失败 |
| Mock 对照组 | `node scripts/e2e/ci-smoke.mjs --engine mock --gateway-port 6320` | `audit-final-mock/e2e-report.json` | 16 通过、2 跳过、0 失败；覆盖真实引擎腿跳过的同会话并发冲突 |
| OpenCode + 真实模型 | `node scripts/e2e/live-check.mjs --engine opencode --port 6323` | `audit-live-opencode/` | 8/8，通过实际文件、历史、取消、删除后文件保留 |
| Pi + 真实模型，修复前 | 同上，`--engine pi --port 6324` | `audit-live-pi/` | 6/8，文件和历史用例失败，保留失败证据 |
| Pi + 真实模型，修复后 | 同上，`--engine pi --port 6324` | `audit-live-pi-fixed/` | 8/8，不经调试代理，直接使用正式适配器 |
| Windows Job + stdio MCP + 应用存活 | `node scripts/e2e/desktop-smoke.mjs --open-notepad` | `desktop-smoke/report.json` | 新 Notepad 进程在 MCP 终止后存活；Job 与 Scope 停止均可核验；用户应用保留 |
| 两种引擎本地诊断 | `npm run doctor -- --engine opencode` / `pi` | `audit-doctor-opencode.json` / `audit-doctor-pi.json` | 均退出 0；模型 `ready_untested`，两个 MCP `structurally_ready_unprobed` |
| 发布门禁 | `npm run release:check` | `audit-release-check.json` | 退出 1：两个必过引擎缺正式内网验收证据；Hermes 可选且无证据 |

真实服务检查通过预加载现有 local.env 的父进程执行，使测试报告也能按私有值进行脱敏。任务只涉及生成的临时材料；未发送邮件或消息，未读取 Outlook 业务数据。

## 资源、安全与后续验收

- MCP server 归属真实引擎的受管进程树；每次请求的 PowerShell helper 有界停止。应用激活属于外部效果，不以取消或关闭 MCP 声称撤销。
- 应用存活测试保留激活后的 Notepad，避免关闭共享用户实例。Outlook 新版被发现，经典版本机缺失；Outlook 实际激活、登录与业务操作 `not_run`。
- 内网模型/真实员工助手 MCP、组织权限与专用证书、官方材料的业务评分 `not_run`。本轮通过的公网配置不能替代 R05/I01–I03 正式内网证据。
- 真实 Anthropic Messages 端点、远程 Streamable HTTP MCP 服务 `not_run`；相应配置/投影的自动化测试不等于这些远程服务已经验收。
- 三类能力包的通用 manifest 加载/自动探测/`pack.projected` 完整机制、通用 UI 自动化与网页搜索能力仍不能由本轮 MCP 结果宣称完成。新增工具直接通过已实现的 settings 接入，没有添加不可执行的能力包骨架。
- 公共契约、SQL、GatewayCore、依赖锁均未因本轮修改。配置修复、Pi 文本兼容、Desktop MCP、诊断/测试为独立审查单元；没有提交或推送仓库。
- 对本轮及并行产生的 42 个变更/新增工程文件扫描本机实际凭据值，未发现泄漏。最终文档更新后重新生成校验清单并验证；原始运行日志保持在忽略目录。
