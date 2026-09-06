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

```powershell
$env:AGENT_ENGINE='opencode'
$env:PNP_DATA_DIR='D:\pnp-data'
npm start -- --port 6217 --host localhost
```

修改环境变量后重启。也支持 `--engine`；与 `AGENT_ENGINE` 冲突时启动失败。正式运行不设置 `PNP_MODE=development`。

C 交付内部模型、工具和权限配置。`config/internal.example.json` 是结构示例，不表示内网 API 已验证。

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

异常退出不自动重放。Gateway 启动时会在取得进程生命周期独占锁后自动核验全部宿主记录；只有停止证据完整的 Session 才解除阻断。停止证据不足时保持 not-ready，可退出后执行 `npm run recover` 重试同一核验流程。禁止手动删锁后立即运行新任务。

## 6. 诊断与关闭

`npm run diagnostics` 输出脱敏状态统计。用户内容、原始数据库和内网材料不上传公共仓库。

Ctrl+C 触发取消、通道关闭、SSE 与数据库关闭。Job Object 只监管所属工具链；不得按 Office 进程名无差别清理，破坏用户或任务要求保留的应用。

## 7. 发布

```powershell
npm run release:check
```

门禁要求 Windows 实测、真实依赖/引擎锁、同一代码 SHA 的内网证据、真实引擎实现。赛题至少两种 Harness；项目发布支持清单列出的全部引擎都须通过。Mock 不计入。

最终 `solution.zip` 包含 `INSTRUCTION.md` 与完整 `code/`，不包含密钥、用户数据或 node_modules。
