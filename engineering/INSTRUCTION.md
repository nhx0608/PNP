# PNP 部署、调用与验收说明

## 1. 环境与目录

目标：Windows 10/11 x64、Node.js 24.19.0。无需数据库服务、Redis、容器或 WSL。每个引擎依赖的精确版本和来源见 `code/engines.lock.json`。

GUI 执行器必须位于授权的交互式用户桌面。Session ID 只是一项环境检查，不能替代真实截图、控件或应用操作验证。

`PNP_DATA_DIR` 保存 SQLite、实例锁、原生会话和宿主记录，启动时不得清空。会话 `directory` 是用户工作目录；删除会话不删除任务产物。秘密使用私有配置，不写入公共仓库。

本包交付公共框架与角色开发任务。真实引擎/内网实现及实测覆盖见 [coverage.md](verification/coverage.md)。未通过发布门禁的工程不得作为可评测成品提交。

## 2. 安装与构建

```powershell
Set-Location code
npm ci
npm run foundation:check
npm run build
```

需要公共基线的真实 `package-lock.json`。首次生成流程为 `npm run dependencies:freeze`；所有开发者使用同一份锁，不各自升级版本。

## 3. 启动与切换

规范字面形式，在交付包的 `code/` 目录下执行：

```powershell
$env:PNP_DATA_DIR='D:\pnp-data'
$env:PNP_MODEL_ENDPOINT='https://<模型服务主机>/v1'
$env:PNP_MODEL_AUTHORIZATION='Bearer <凭据>'
.\gateway.cmd --engine opencode --port 6217
```

等价形式（三选一，效果相同）：

```powershell
.\gateway.ps1 --engine opencode --port 6217      # PowerShell
./gateway --engine opencode --port 6217           # POSIX shell
$env:AGENT_ENGINE='opencode'; npm start -- --port 6217 --host localhost
```

`gateway.cmd`/`gateway.ps1`/`gateway` 都在 `code/` 下，内部执行 `node dist/main.js`，因此先按第 2 节 `npm run build`。引擎既可用 `--engine` 指定，也可用环境变量 `AGENT_ENGINE`；两者都给出时必须一致，冲突以 `ENGINE_CONFIGURATION_CONFLICT` 启动失败，都不给出以 `ENGINE_NOT_FOUND` 失败。`--port` 默认 6217；`--host` 默认 `localhost`，会同时绑定 `127.0.0.1` 与 `::1`，允许的绑定地址仍只有回环（`127.0.0.1`/`localhost`/`::1`）。修改环境变量后重启。正式运行不设置 `PNP_MODE=development`。

集成是交付包内的**配置**，不是启动门禁：非 mock 引擎默认按 `PNP_INTEGRATION=configured` 读取随包交付的 `code/config/competition-profile.json`。该档只写环境变量的**名字**（`PNP_MODEL_ENDPOINT`、`PNP_MODEL_AUTHORIZATION`），端点地址与凭据只存在于启动进程的环境变量里，不落盘、不入仓库。档里点名的变量缺失时在监听端口之前以 `MODEL_ENVIRONMENT_MISSING` 失败，并列出缺少哪几个变量名（不打印取值）。需要自带模型/工具/策略档时用 `PNP_CONFIGURED_PROFILE` 指向绝对路径；只需在交付档之上改某个操作的策略时用 `PNP_CONFIGURED_POLICY_OVERRIDES`（JSON，例如 `{"write":"ask"}`）。

C 交付内部模型、工具和权限配置。`config/internal.example.json` 是结构示例，不表示内网 API 已验证；`PNP_INTEGRATION=internal` 目前只能显式选择，且显式选择时在启动阶段以 `INTEGRATION_UNAVAILABLE` 失败。

### 3.1 环境变量

完整清单与默认值见 `code/.env.example`；以下几项此前未写入本说明：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PNP_INTEGRATION` | 未设置（非 mock 引擎回退 `configured`；mock 引擎回退 `mock`） | 模型/工具/权限的集成方式：`configured`（读取下方配置档，默认）、`internal`（内网，C 交付，显式选择且尚无实现时启动失败）、`mock`（仅限 mock 引擎）。与所选引擎不匹配会在启动阶段失败，见 3.2 |
| `PNP_CONFIGURED_PROFILE` | 交付包内的 `code/config/competition-profile.json` | 模型/工具/策略档的**绝对路径**；不设置即使用交付档。结构见 `config/configured.example.json`，端点可用 `endpoint`（字面 URL）或 `endpointEnvironment`（存放 URL 的环境变量名）二选一 |
| `PNP_MODEL_ENDPOINT` | 无（交付档点名此变量） | 模型服务地址，交付档以变量名引用。必须是 https；http 只允许回环地址 |
| `PNP_MODEL_AUTHORIZATION` | 无（交付档点名此变量） | 模型服务的 `Authorization` 请求头取值。只从环境变量读取，不写入配置档、日志或数据库 |
| `PNP_CONFIGURED_POLICY_OVERRIDES` | 无 | 部署侧策略覆盖（JSON 对象，如 `{"write":"ask"}`），在配置档的 `policy.operations` 之上生效，取值同为 `allow`/`deny`/`ask`。用于不改交付档就把某个操作改成需要审批；非法 JSON 或非法取值在启动阶段失败 |
| `PNP_MODEL_STRICT` | 未设置（宽松映射） | 置为 `1` 时，`prompt_async` 传入的 `model` 不在配置档内即返回 403 `MODEL_NOT_ALLOWED`；不设置时映射到配置档的默认模型，见下方说明 |
| `PNP_MAX_RESIDENT_SESSIONS` | `16`（范围 1–64） | 常驻原生通道上限；到达上限按最久未用淘汰非活跃会话的通道，不再直接拒绝第 17 个会话。评测一轮同时保有的会话数持续高于默认值时才需要调大 |
| `PNP_RUN_TIMEOUT_MS` | `900000`（15 分钟，范围 1000–86400000） | 单次 Prompt 执行的总时限。任务涉及大文档转换、多步网页检索等确需更久时再调大 |
| `PNP_OPEN_TIMEOUT_MS` | `60000`（范围 1000–600000） | 原生进程/引擎握手时限。评测机首次运行叠加杀软扫描或冷编译较慢时调大 |
| `PNP_CANCEL_GRACE_MS` | `15000`（范围 100–300000） | 取消后到判定"停止未证实"前的宽限期。引擎需要更长时间才能安全落盘（例如 Office 另存为）时调大；调小可在用例之间更快回收资源 |
| `PNP_INTERACTION_TIMEOUT_MS` | `45000`（范围 1000–600000） | 反问/授权等待回复的时限，超时按 `reason:"TIMEOUT"` 处理为拒绝 |

规范把 `model.providerID/modelID` 定为必填，取值由评测脚本决定，本网关不掌握。因此不在配置档内的选择**不返回 403**，而是落到配置档的第一个模型（默认模型）；调用方省略 `model` 时同样使用该默认模型。每轮在模型解析成功后立即发布事件 `model.resolved`，载荷为 `{sessionID, runID, requested, selected, resolution}`，`resolution` 取值 `exact`（档内命中）、`default`（未传 `model`）、`substituted`（传入的标识不在档内）；替换时另有一行 `console.warn` 的 JSON 日志。两者都只含模型标识，不含端点、请求头或凭据。配置档才是端点允许清单，替换只发生在"名字"这一层，不扩大任何访问面。需要严格拒绝时设置 `PNP_MODEL_STRICT=1`。

以上数值型变量留空（`VAR=`）等同于不设置，按默认值处理，不会被解析成 `0` 而拒绝启动。

### 3.2 启动阶段错误码

以下错误在监听端口之前发生，进程以非零退出码结束，不会进入"运行中但未就绪"状态；错误对象的 `code` 字段与下表对应：

| `code` | 触发条件 |
|---|---|
| `UNSUPPORTED_BIND_ADDRESS` | `PNP_HOST`/`--host` 不是回环地址（`127.0.0.1`/`localhost`/`::1`） |
| `VALIDATION_ERROR` | 端口、`PNP_MAX_RESIDENT_SESSIONS` 或四个超时变量之一超出取值范围 |
| `ENGINE_NOT_FOUND` / `ENGINE_CONFIGURATION_CONFLICT` | `AGENT_ENGINE`/`--engine` 未设置、未知，或二者冲突 |
| `MOCK_FORBIDDEN` | 非开发模式下选择了仅限开发的引擎或集成方式 |
| `ENGINE_UNAVAILABLE` | 所选 Engine Pack 尚无实现 |
| `INTEGRATION_NOT_FOUND` / `INTEGRATION_CONFIG_INVALID` | `PNP_INTEGRATION` 取值非法，或 `configured` 模式下配置档缺失/路径非绝对/JSON 不合法/字段不合规（含 `PNP_CONFIGURED_POLICY_OVERRIDES` 不是合法 JSON 或取值非法） |
| `INTEGRATION_UNAVAILABLE` | 显式选择 `PNP_INTEGRATION=internal`，而内网集成尚无实现 |
| `MODEL_ENVIRONMENT_MISSING` | 配置档点名的环境变量（端点或凭据）未设置；错误信息列出缺少的变量名，不含取值 |
| `INSECURE_MODEL_ENDPOINT` / `UNSAFE_MODEL_ENDPOINT` / `MODEL_ENDPOINT_INVALID` | 解析出的端点不是 https（http 仅限回环）、URL 内含凭据，或不是合法 URL |
| `INSTANCE_LOCKED` | `PNP_DATA_DIR` 已被另一个存活的网关进程占用 |
| `INSTANCE_GUARD_FAILED` | Windows 独占句柄获取失败，且回退到文件锁也未成功 |

## 4. 调用流程

1. 检查 `/health/live` 与 `/health/ready`。后者表示公共核心可接受任务，不替代模型和工具可用性实测。
2. `POST /session` 提供绝对 `directory` 和可选 `title`。
3. 建立 `GET /event` SSE。
4. 并行调用 `POST /session/{id}/prompt_async`；请求等待本轮执行结束。反问和授权通过 SSE 及回复接口提交。
5. 正常完成返回 HTTP 204，使用 `GET /session/{id}/message` 取得最终轨迹。
6. 中止使用 `POST /session/{id}/abort`，未确认停止不得复用执行资源。
7. 结果采集后 `DELETE /session/{id}`，仅清理网关/原生会话资料。

```json
{
  "parts": [{"type": "text", "text": "请执行指定任务"}],
  "model": {"providerID": "configured-provider", "modelID": "configured-model"}
}
```

## 5. 完成、错误和恢复

正常最终回复使用 `info.finish=stop` 与 `step-finish`，且数据库已提交。工具 ACK、模型单个 step、取消 ACK 均非完整执行结束。截断、拒绝、错误、取消和中断保留对应状态，不伪装成功。

可使用 `Idempotency-Key` 请求级防重，但不能保证外部消息系统 exactly-once。

异常退出不自动重放。**围栏是会话级的，不是网关级的**：网关取得进程生命周期独占锁、打开存储、开始监听端口之后，才异步核验上一轮遗留的宿主归属记录（有总时限，超时不阻塞健康检查）；核验结果只收窄到它点名的会话，`GET /health/ready` 只反映存储是否可用，不受任何单个会话的停止证据影响，其余会话与后续新建会话不受影响。

核验的处置方式：能自证已停止的会话解除阻断并归档其记录；找不到对应会话的孤儿记录被隔离且计数，不再点名任何会话；停止证据不足或核验本身失败的会话保持 `recovery=blocked`，该会话的 `prompt`/执行请求返回 409 `SESSION_UNAVAILABLE`，但删除该会话（`DELETE /session/{id}`）仍然允许，且本身就是解除围栏的合法方式。执行 `npm run recover` 可在网关停止运行时重跑同一核验流程；它会打印每条问题记录的文件名、原因（不可读、格式不合法、无对应会话、未证实、核验失败）与所属会话，而不只是计数，仍处于阻断状态的会话据此可以逐条排查而非只知道"还有几个"。禁止手动删锁后立即运行新任务；`PNP_DATA_DIR` 下的归属记录会随核验结果被移动或删除，不要手工清空整个数据目录。

## 6. 诊断与关闭

`npm run diagnostics` 输出脱敏状态统计。用户内容、原始数据库和内网材料不上传公共仓库。

Ctrl+C 触发取消、通道关闭、SSE 与数据库关闭。Job Object 只监管所属工具链；不得按 Office 进程名无差别清理，破坏用户或任务要求保留的应用。

## 7. 发布

```powershell
npm run release:check
```

门禁要求 Windows 实测、真实依赖/引擎锁、同一代码 SHA 的内网证据、真实引擎实现。赛题只要求两种以上 Harness；`config/release-profile.json` 的 `requiredEngines`（当前 opencode、pi）必须全部通过，`optionalEngines`（当前 hermes，早期 Windows beta）不计入门禁——有完整证据按 bonus 记录通过与否，没有证据只报告"未提交"，均不阻断发布。Mock 不计入任何一类。

```powershell
npm run package:release
```

按 `solution/{INSTRUCTION.md, code/}` 结构打包，默认输出到 `code/dist/release/`（已被 `.gitignore` 排除）。只拷贝 `src/`、`native/`、`config/`、`scripts/`、`assets/`、`package.json`、`package-lock.json`、`tsconfig.json`、`toolchain.json`、`.env.example`、`code/README.md`；`tests/` 默认不打包，需要时加 `--include-tests`。`engineering/` 顶层的评审材料、规范、提示词与验证证据不进包；`engineering/INSTRUCTION.md` 被复制为 `solution/INSTRUCTION.md`。打包后自动自检包内不含凭据模式字符串、运行数据（数据库/日志/证书私钥）或依赖目录（`node_modules`），自检不通过时退出码非零，需要人工复核后再提交。
