# PNP — 多引擎智能体网关

PNP 是运行于 Windows 10/11 的自研 Agent Gateway。它以稳定的会话、执行和事件契约连接可下载安装的 Agent Harness，并保留各引擎的原生执行能力。

## 阅读入口

| 文件 | 内容 |
|---|---|
| [审核目录](REVIEW-INDEX.md) | 所有交付文件的用途、职责与查看入口 |
| [需求与范围](docs/spec/requirements.md) | 赛题约束、项目约束、必须项、亮点和 V2 边界 |
| [架构设计](docs/spec/architecture.md) | 模块、运行拓扑、持久化、生命周期和能力模型 |
| [技术栈](docs/spec/technology.md) | 唯一技术选型、依赖规则和运行环境 |
| [公共契约](docs/spec/contracts.md) | A/B/C 必须遵守的接口语义 |
| [内网边界](docs/spec/internal-integration.md) | 模型、员工助手 CLI、工具、权限与内部验证 |
| [DFX 与验收](docs/spec/dfx-and-testing.md) | 故障处理、验证方法和发布门禁 |
| [分工](docs/team/work-packages.md) | A/B 同时开发与 C 独立对接 |
| [协作规范](docs/team/collaboration.md) | 目录所有权、契约变更、分支和合并 |
| [编程约束](AGENTS.md) | 所有编码 Agent 的共同约束 |
| [任务 Prompt](prompts/README.md) | 独立可执行的角色任务入口 |
| [运行说明](INSTRUCTION.md) | 开发、部署、评测调用和退出 |
| [实现覆盖](verification/coverage.md) | 公共实现与 A/B/C 实现边界 |
| [验证证据](verification/results.json) | 实际执行环境和测试结果 |

## 开发模式

公共框架是 A/B/C 的共同代码基线，不属于 A 开工后向 B 交付的前置任务。A 与 B 从同一基线提交建立分支，分别实现 ACP 系列和 Pi RPC 系列。C 通过独立的 `IntegrationProvider` 提供内网模型、工具和授权，不修改 Agent Loop。

仓库中 `mock` 是显式测试引擎。OpenCode、Hermes、Pi 和内部集成各有独立实现入口；入口未实现时明确失败，不切换到 Mock。公共测试通过不代表这些真实接入已完成。

## 基线使用规则

所有开发遵循 `docs/spec/`、`docs/team/`、`AGENTS.md` 和 `code/src/contracts/`。其他方案、研究报告、聊天内容及示例代码不替代这套规格。发现规格与可复现协议事实冲突时，提交 [契约变更单](docs/team/change-request.md)，不得在自己的分支中复制第二套公共类型。

`verification/coverage.md` 描述代码覆盖范围；`verification/results.json` 描述已取得的验证证据；`docs/spec/` 描述必须满足的目标行为。三者不能互相替代。
