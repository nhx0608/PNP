# 内网接入交付规范

责任人 C。唯一接口是 `IntegrationProvider` 与其 `ResolvedModel`、`ToolBinding`、`AssetBinding`、授权结果。完整规范见 [internal-integration.md](../spec/internal-integration.md)。

公共仓库只保留配置字段、环境变量名称、协议描述、脱敏夹具、调用示例和不含用户内容的测试摘要。内部资源详情通过私有文件分发。

## 必交付物

- 模型协议、鉴权、CA/网络、工具调用往返报告。
- 员工助手 CLI 的命令封装、输入输出 schema、错误和副作用分类。
- 组织授权规则与执行入口，拒绝/过期/取消测试。
- A/B 可独立使用的 Fake/脱敏夹具，不依赖真实内部地址。
- 安装自检、最终内网联合验收及同一 gitCommit 的证据。

## 验收 JSON

字段使用 `gitCommit`、`engineId`、`channelId`、`engineVersion`、`nodeVersion`、`platform`、`checks`。`checks` 中每项包括 id、status、evidence。模板见 `verification/internal/evidence.example.json`。只有真实执行的成功项写 passed。
