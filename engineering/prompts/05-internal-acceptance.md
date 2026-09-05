# 任务：Windows 内网联合验收

读取 `INSTRUCTION.md`、DFX 与测试规范、内网契约、release-profile 和精确版本锁。仅在获授权的测试环境执行；实际外部消息、删除与账户操作使用指定测试对象。

从干净 Windows 用户环境安装并启动，使用同一个代码 SHA，分别通过 AGENT_ENGINE 运行正式支持清单中的引擎。验证 CLI/环境变量冲突、持久化、会话恢复、工具注入、完整 Prompt 阻塞、SSE 和消息快照、审批反问、取消不响应、进程停止与异常恢复。

GUI 检查针对实际执行器的桌面；进程清理只针对有归属证据的资源。用户已打开的 Office 应用不得被批量终止。

验证内部模型工具往返、鉴权拒绝、CA、员工助手 CLI 错误/超时、副作用不重复。对已提供样例执行真实任务，检查文件产物和环境状态；不使用 task_id 分支或预制答案。裁判模型评分需记录来源和方法，不当作官方评分。

按 release-check 所需结构输出脱敏 JSON：gitCommit、engineId/channel/version、platform、Node、各检查 true/false/not_run 及证据路径。失败即阻断发布，不把未知改成通过。执行 `npm run release:check` 并附真实输出。
