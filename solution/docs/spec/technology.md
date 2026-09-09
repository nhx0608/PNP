# 技术栈与依赖规则

## 1. 唯一技术选择

| 范围 | 选择 | 原因与边界 |
|---|---|---|
| 目标系统 | Windows 10/11 x64 | 赛题环境；桌面任务使用交互用户会话 |
| 主运行时 | Node.js 24.19.0 | 固定基线，不使用浮动 latest；`toolchain.json` 是机器可读声明 |
| 语言/模块 | TypeScript strict / ESM | 公共契约与引擎适配使用同一类型系统 |
| Web | Fastify 5.11.0 | 请求校验、JSON 返回、生命周期、Pino 日志 |
| JSON Schema | TypeBox 0.34.41 | 请求 Schema 与 TS 类型同源 |
| 存储 | Node `node:sqlite`，单 Worker | 本地文件、单写入者；同步 SQLite API 不阻塞 HTTP 事件循环 |
| 南向 | ACP TypeScript SDK 1.4.0；Pi RPC | ACP 选定 v1 语义；Pi 使用锁定引擎版本对应的 RPC 语义 |
| 进程 | Node child_process；Windows Job Object | 统一所有权、stdio 和清理；不在引擎包中直接 spawn |
| Windows helper | Windows PowerShell 5.1 + 系统 .NET Framework | C# P/Invoke 源码由 Add-Type 加载；不依赖额外数据库、Rust 或 C++ 工具链 |
| 测试 | Node 内置 test/assert；Fastify.inject | 避免第二套测试框架依赖；真实 SSE 使用实际 HTTP 连接测试 |
| 构建 | tsc 5.8.3 | 不打包 Harness，不引入前端构建器 |
| 包管理 | npm + package-lock.json | A/B/C 使用同一依赖解析结果 |
| 运维 | PowerShell + Node 脚本 | 安装、自检、恢复、测试和归档 |

准确版本以 `code/package.json`、`code/toolchain.json` 和经依赖准入生成的 `package-lock.json` 为准。实际版本不得由单个开发分支自行升级。ACP 协议版本与 npm SDK 版本是两个字段，不能混用。

## 2. node:sqlite 约束

Node 24.19.0 文档将 `node:sqlite` 标为 Release Candidate；`DatabaseSync` 是同步 API。[官方文档](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html)

PNP 把它固定在存储 Worker，使用 prepared statements、WAL、FULL 同步及有界调用队列。Worker 故障、写入超时或磁盘错误均阻断新任务，不从内存伪造已持久化状态。SQLite 驱动不做自动降级切换，不同时维护 `sqlite3/better-sqlite3/node:sqlite` 三条路径。

## 3. 依赖准入

`npm run dependencies:freeze` 在可访问批准 npm 源的环境解析依赖、生成真实锁文件、执行安装与完整检查。生成的锁文件与公共基线一起提交，A/B/C 分支只执行 `npm ci`。缺失锁文件的仓库不能通过 `foundation:check`。

依赖准入不是 A 的引擎工作包。仓库审核者在建立共同基线时执行它；A 和 B 从同一个已通过准入的提交开工。没有网络或目标 Windows 的环境不能把未运行的准入测试标记为通过。

## 4. 引擎与内网依赖

OpenCode/Hermes/Pi 各自安装包、运行时、许可证、确切版本和来源由其工作包声明。Hermes 需要的 Python 环境属于 Hermes 包，不升级成所有引擎的共同前提。

内部模型、员工助手 CLI、证书、代理及授权配置由 C 声明。API key、Token、Cookie、私有证书、真实内网地址与测试账号不得提交到公开仓库。提交文件只记录变量名、接口形态和非敏感版本信息。

## 5. 不引入的基础设施

不引入数据库服务、Redis、消息队列、注册中心、配置中心、Docker、Kubernetes、外部可观测集群或多模型代理平台。只有实际内网协议无法直连时，C 才提供解决已确认问题的最小兼容模块；它仍遵守 IntegrationProvider 契约。
