# 资料依据与适用范围

## 赛题资料

事实依据为用户提供的《多agent引擎可替换架构实现-任务书》《调测指南》及两份接口规范。项目要求与赛题最低要求分别列于 [需求](requirements.md)。接口规范核对表见 [资料目录](../reference/README.md)。公开交接副本中的人员标识替换为测试占位符；测试材料不随代码分发。

## 一手技术依据

| 编号 | 资料 | 使用范围 |
|---|---|---|
| S01 | [Node.js 24 SQLite](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html) | DatabaseSync、同步行为、RC 标记；采用 Worker |
| S02 | [ACP v1 Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) | prompt 响应、StopReason、取消期间的更新 |
| S03 | [ACP 初始化](https://agentclientprotocol.com/protocol/v1/initialization) | 版本与能力协商 |
| S04 | [Pi RPC](https://pi.dev/docs/latest/rpc) | JSONL、ACK、运行/工具事件、完成证据 |
| S05 | [OpenCode ACP](https://opencode.ai/docs/acp/) | ACP 入口与能力 |
| S06 | [OpenCode Server](https://opencode.ai/docs/server/) | 原生异步接口与赛题阻塞语义的区别 |
| S07 | [Hermes ACP](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp/) | 通道能力与限制 |
| S08 | [Fastify 测试](https://fastify.dev/docs/latest/Guides/Testing/) | inject 与 Node 测试工具 |
| S09 | [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) | 所有者进程树、停止证据 |
| S10 | [Windows 任务身份](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks) | 交互式用户与桌面 |
| S11 | [Node 子进程](https://nodejs.org/api/child_process.html) | 参数数组、stdio、退出 |

核对日期为 2026-09-05。在线 latest 文档不是版本锁，Engine Pack 的证据必须包含精确版本、通道、模型指纹和测试环境。声明、探测和实测不得混同。

内部模型协议、API key/appid 的具体鉴权位置、员工助手 CLI 命令、权限规则由 C 根据内网资料确认，公共方案不预设其具体形式。
