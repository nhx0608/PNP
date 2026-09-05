# Pi 接入规格

所有者 B。入口 `code/src/engines/pi/pack.ts`，通道 `rpc`，公共契约 1.0.0。

## RPC

使用 `pi --mode rpc` 的锁定版本，通过公共 ProcessHost 与 LF JSONL 解码器连接。启动命令由可信配置解析为实际 executable/args，不能拼接用户命令。UTF-8 字节分片、一次多行、最大帧、损坏 JSON、EOF 和退出都有测试。

Prompt 成功应答仅说明接受；完成根据实际版本完整运行生命周期判断，覆盖 retry、compaction、排队与 settled。不要只认文本、toolcall 空或第一条 agent_end。旧版本缺少相关事件时以其契约和实测给出可验证实现，不虚构事件。

## 会话和配置

Session 使用独立持久目录。每轮接收新的 IntegrationContext；模型/资产/工具需要绑定到原生能力，无法安全修改时返回明确错误。RPC 取消请求不是停止证据，终止通过公共 Host 完成。

## 原生扩展

通过 Pi Custom Tool/Extension 将 ToolBinding 暴露给模型，保持参数 schema、组织授权、超时与副作用语义。内部 CLI 的认证和业务代码属于 C，不复制到 Pi Pack。外部执行结果不明时不可重发。

## 验收

运行公共契约、RPC 分帧与生命周期测试、模型配置变化测试、工具与交互测试、版本锁和 Windows 原生验证。至少一项 Pi 原生扩展具备配置、执行和观测证据。
