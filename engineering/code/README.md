# PNP 可执行工程

规范：[AGENTS.md](../AGENTS.md)。设计：[architecture.md](../docs/spec/architecture.md)。实际验证：[coverage.md](../verification/coverage.md)。

## 工具链与依赖

精确版本见 `toolchain.json` 和 `package.json`。公共基线管理员在可联网的目标环境执行一次：

```powershell
npm run dependencies:freeze
```

此命令实际生成锁、安装依赖并校验；失败即阻止完整基线验收，不能编造锁文件。A/B/C 同步同一基线后使用：

```powershell
npm ci
npm run foundation:check
```

## 公共框架运行

```powershell
npm run build
$env:PNP_MODE='development'
$env:AGENT_ENGINE='mock'
npm start
```

Mock 仅用于开发。正式引擎失败不得回退 Mock。

## 并行开发

A：`drivers/acp`、`engines/opencode`、`engines/hermes`。B：`drivers/pi-rpc`、`engines/pi`。C：`integration/internal`。公共模块变更独立评审，所有实现依赖 `src/contracts`。

## 验证

```powershell
npm run typecheck
npm test
npm run test:contract
npm run check:boundaries
npm run doctor -- --engine pi
npm run release:check
```

HTTP 契约测试需要完整依赖。真实引擎和内网测试不由 Mock 结果代替。
