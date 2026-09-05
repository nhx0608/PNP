# PNP 仓库开发约束

## 项目定义

PNP 是 Windows 上的自研多 Harness Gateway。开发依据在 `docs/spec/`；工作分工在 `docs/team/work-packages.md`；公共类型在 `code/src/contracts/`。每个编码 Agent 必须读取本文件及对应工作包，不需要任何外部聊天上下文。

## 实现边界

A 负责 ACP/OpenCode/Hermes，B 负责 Pi RPC/Pi 扩展，C 负责内网模型/工具/授权。公共框架不属于 A 对 B 的串行前置开发。所有分支基于同一个通过准入的公共提交。

Adapter 不直接使用 Fastify、SQLite、GatewayCore 或 child_process；只能通过公共契约、ProcessHost、ResourceScope 和 EventSink。内网模块不执行 Agent Loop。Core 不读取内网凭据或按引擎名称分支。

## 必须保持的语义

1. Session/Run/Message/原生绑定本地持久化，内存仅为运行缓存。
2. 请求接受 ACK 不是执行完成。正常 204 与 idle 只能在真实终态和持久化完成后出现。
3. 取消 ACK 不是停止证据；无法证明停止时保持阻断，不重放 Prompt。
4. EngineSessionChannel 按 Session 隔离；禁止共享可变原生当前会话或 process.chdir。
5. 每轮使用新 IntegrationContext；组织 deny 不允许被用户审批覆盖。
6. 工具结果缺失只能记录明确来源的观察状态，不能伪造成功、tool result 或业务结论。
7. 新进程在创建前登记归属；迟到资源仍需清理；禁止按进程名全量杀进程。
8. 删除只处理本系统拥有的状态与原生历史，不能删除用户目录、文件产物或任意 Office 应用。
9. 环境变量 AGENT_ENGINE 必须有效；与 --engine 冲突时明确失败。
10. 正式引擎不可自动回退 Mock、其他引擎或未授权模型。

## 代码和依赖

TypeScript strict、ESM、两空格、双引号、分号、type import。禁止 any、@ts-ignore、无关格式调整、复制公共类型、未观察的 Promise、空 catch 隐藏业务失败。允许资源收尾明确转为不确定性状态。

使用 Node strip-only 兼容语法；不使用 TS enum 或构造器参数属性。使用 package-lock 与 npm ci。新增或升级依赖、公共类型、SQL版本和组合入口必须提交独立变更并通过双方审查。

## 安全与证据

禁止提交 API key、appid 对应秘密、Token、Cookie、私钥、私有证书、真实工号、内部材料和未脱敏日志。禁止打印整个 process.env 或模型绑定。导出诊断前必须在命令或代码中脱敏。

`implementationProvided` 只描述代码是否存在。正式能力必须有匹配 Engine/Channel/版本/commit 的实际验证证据。Mock、外网测试、静态检查和内网验收分别记录。

## 工作完成输出

列出修改文件、接口影响、运行命令、实际测试结果、尚无环境证据的范围、所需配置。使用 `docs/team/handoff-template.md`。不得宣称未执行的测试通过，不得为了通过测试削弱取消、权限或持久化语义。

默认只修改工作目录并给出可审核结果；没有明确授权不提交或推送远端仓库。
