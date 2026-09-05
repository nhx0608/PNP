# 编码与交接 Prompt

从仓库根目录执行对应文件中的任务。所有任务引用同一份 `AGENTS.md`、`docs/spec/` 和 `code/src/contracts/`，不需要聊天记录。不得推送未经用户批准的提交。

| 使用者 | 文件 | 目标 |
|---|---|---|
| 公共基线审核者 | [00-baseline-check.md](00-baseline-check.md) | 校验共享框架、真实依赖锁与共同 SHA |
| A | [01-A-acp.md](01-A-acp.md) | ACP、OpenCode、Hermes，可与 B 同时启动 |
| B | [02-B-pi.md](02-B-pi.md) | Pi RPC 与原生工具/扩展，可与 A 同时启动 |
| C | [03-C-internal.md](03-C-internal.md) | 模型、CLI、权限及脱敏夹具 |
| 集成人员 | [04-integration.md](04-integration.md) | 合并三条工作流，不重写公共模型 |
| 内网验收人员 | [05-internal-acceptance.md](05-internal-acceptance.md) | 同一代码 SHA 的真实环境验证 |
| PR 评审者 | [06-review.md](06-review.md) | 证据驱动的代码审查 |
| 任意角色 | [07-resume.md](07-resume.md) | 无聊天上下文恢复指定工作包 |
| 任意角色 | [08-handoff.md](08-handoff.md) | 生成可复现交付记录 |

A/B/C 的前提是同一公共基线及依赖锁，不是彼此的功能完成。内部服务不可达时使用明确标记的 Fake/脱敏夹具测试结构与故障路径，不伪造真实集成结果。
