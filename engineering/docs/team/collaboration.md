# 协作、编程与合并规范

## 1. 唯一执行依据

执行顺序：`AGENTS.md` → `docs/spec/` → 自己的工作包 → `code/src/contracts/` → 相应测试。公开协议文档用于核验具体通道；发生冲突提交变更单，不静默改公共行为。

`docs/spec/` 是设计规范，`verification/` 是验证事实，二者分开维护。没有目标环境证据不得写“已完成内网/Windows验收”。

## 2. 分支与共同基线

三人分支从同一个共同基线 SHA 创建，例如 `feature/acp-engines`、`feature/pi-engine`、`feature/internal-integration`。分支名称示例不是固定个人身份配置。

每个交接记录必须包含共同基线 SHA、契约版本和 package-lock 哈希。不得把本地未提交修改、IDE 全局配置、已有登录态或开发者全局 Harness 配置作为依赖。

## 3. 目录与修改范围

按 [工作包](work-packages.md) 修改自己的目录。公共目录修改必须独立提交并说明所有调用方影响。禁止顺手格式化、调整无关 import、重命名公共对象或批量重写文件。

根 `package.json`、锁文件、tsconfig、入口注册、公共契约与存储版本由共同审查管理。需要新依赖时提交用途、官方来源、确切版本、Windows 安装风险和替代方案。

## 4. 编码约束

TypeScript strict；不使用 `any`、`@ts-ignore`、空 catch 吞错或未观察的 Promise。协议输入以 unknown 接收，验证后转换。仅资源清理和错误收尾可明确捕获并转为不确定性证据。

采用 ESM、显式 type import、双引号、分号和两空格缩进。使用可由 Node strip-only 执行的语法，不使用 TS enum 或 constructor parameter property。相对 import 统一 `.ts`，tsc 构建时转换为 `.js`。

禁止在 Adapter 中直接 spawn/exec、访问 SQLite、控制 HTTP 或自行发布最终 idle。禁止修改 `process.cwd()` 或使用全局单例原生 Session。所有子进程经过 ProcessHost，所有可等待事件经过 EventSink。

错误必须带稳定 code、公开安全 message 和可追溯 run/session 标识。控制台不得直接打印请求体、完整模型配置、环境变量、Cookie、密钥或原始内部日志。

## 5. 接口变更

公共契约变更必须说明：需要解决的实际问题、现有契约不足、调用方、字段/行为差异、向后兼容性、测试与迁移。仅字段能编译不是兼容性的充分条件。

双方不能分别创建 `EngineAdapterV2`、自己的 Session 类型或隐藏默认参数。确有破坏性变更时更新契约版本和所有调用方，在独立公共变更中合入。

## 6. 测试与完成定义

PR 必须具备类型检查、边界检查、自有模块单测、共同引擎契约和故障测试。外网测试与内网测试分开报告；缺环境属于未验证，不是通过。

正式 EnginePack 的 `implementationProvided=true` 只表示已有实现代码，不表示 Windows 或内网认证通过。正式支持矩阵来自匹配版本与 SHA 的验收证据。

## 7. 合并规则

合并顺序不决定开发先后。每个分支持续保持可构建，公共变更先以独立提交共享；引擎工作包通过测试即可合入。组合入口已预留 OpenCode/Hermes/Pi，不要求 A/B 同时修改 main。

合并冲突不能通过覆盖另一个分支的文件解决。先按目录所有权处理实现文件，再核对契约与测试。每次合并都执行共同测试，不以单个 Agent 的自然语言声明代替输出。

## 8. 交接产物

按 [交接模板](handoff-template.md) 提供：实现范围、文件清单、版本、运行配置、测试命令与结果、实际限制、公共契约变更、内网所需条件。真实凭据和内部材料不随交接提交。

所有 Agent 只在得到明确指令时提交或推送远端；默认输出修改、测试证据及需要审核的差异。
