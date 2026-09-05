# OpenCode 接入规格

所有者 A。入口 `code/src/engines/opencode/pack.ts`，通道 `acp`，公共契约 1.0.0。

## 实现边界

复用 A 的通用 ACP Driver；Pack 只负责安装入口解析、版本信息、原生模型配置、MCP/资产投影、能力声明和引擎差异。使用公共 Host 创建进程，独立原生数据目录，不读取开发机器全局配置。

`opencode acp` 是协议入口，不将原生 HTTP 的立即返回 204 当作本系统 Prompt 完成。解析 ACP StopReason、工具状态及进程退出；数据库、最终 idle 和 HTTP 返回由 Core 统一执行。

每轮支持内部 IntegrationContext。模型或工具配置不能在原会话安全更新时明确拒绝，不暗中创建新会话替换历史。

## 交付证据

Windows 原生安装、非交互启动、版本锁、模型与 ToolBinding、资产注入、多轮恢复、工具/事件关联、取消停止证据和原生高级能力执行。不能用 WSL 测试替代 Windows 原生。

能力按引擎版本和 ACP 通道记录。文档说明不等于 verified，详见 [来源](../spec/sources.md)。
