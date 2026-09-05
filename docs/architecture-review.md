# PnP Agent Fabric 方案评审（针对 v2 稿）

> 评审日期：2026-09-05
> 评审依据：33 份一手调研（[`research/`](./research/README.md)）、赛题原文任务书与调测指南、
> [`competition-baseline.md`](./competition-baseline.md)、[`gateway-api-baseline.md`](./gateway-api-baseline.md)、
> [`evaluation-cases.md`](./evaluation-cases.md)，以及五份从不同角度独立撰写的架构方案与三份交叉评审。
> 评审对象：《PnP Agent Fabric 多 Agent 引擎可替换架构完整设计方案》（88 节版本，下称 v2 稿）。

---

## 0. 总体结论

**v2 稿可以作为开发依据，骨架不需要推翻。** 相比上一版，它在几个关键处已经修正到位：
只做两个 Driver 而不是四个、进程树用 `taskkill /T /F` 清理、明确"不自动重放 Prompt"、
`MAX_CONCURRENT_RUNS=1`、`engines.lock.json` 钉死版本、FakeEngineDriver、
以及一份写得很清楚的 P0/P1/P2 优先级与"明确不做"清单。这些判断都对。

但按调研证据逐条核对后，有 **5 处阻断级缺失**（不补会直接掉分或让评测归零）、
**3 处复杂度超预算**、**1 处结论需要纠正**。下面按严重程度排列，每条都给出证据出处与具体改法。

评审用的两把尺子：
- **赛题尺子**：客观分 70% 来自引擎在 Windows 上完成办公任务的效果，架构分 20%，创新与鲁棒各 5%。
- **复杂度尺子**：一个抽象只有在 MVP 内就存在至少两个真实实现时才成立，否则它是负债。

---

## 1. 阻断级问题（不补会直接失分，建议全部纳入 P0）

### 1.1 `prompt_async` 的阻塞语义没有写实现，只画在时序图里

**问题**：§76 的时序图画了最后返回 HTTP 204，§77 列了固定的完成顺序，但全文没有说明
**这个 204 究竟由什么信号触发**。如果实现时顺手把引擎的 prompt 调用结果直接返回，就会踩坑。

**证据**：G04 逐项核对 opencode 源码，其原生 `prompt_async` **立即返回 204**，
真正阻塞的是同步 `POST /session/{id}/message`。赛题要求这个端点阻塞到本轮完整结束。
一旦透传，评测器会在毫秒级收到 204 后立刻去拉 `/message`，此时本轮可能尚未开始，
误判"已完成" —— **十个用例全部归零**。这是全赛题最大的单点失败风险。

**建议改法**（补一节"阻塞语义实现"）：
- HTTP 处理器调用 `driver.prompt()` 后不等它的返回值，而是等待内部 Run 终态信号；
- 终态必须**双重确认**：引擎侧 prompt 调用返回 **且** 事件流出现终态事件。
  只认其中一个都不安全 —— G07 记录了 opencode 存在 abort 后 `finish` 字段不置位、
  fd 泄漏导致工具态永不收敛的已确认 bug；
- **总超时兜底**（建议 `PROMPT_TIMEOUT_MS` 默认 10 分钟）：超时后走取消流程，
  Run 置 `failed` 且 `stopReason=timeout`，但**仍然返回 HTTP 响应**，绝不能一直挂着；
- `finish` 枚举按 opencode 实际的 **6 个值**定义：
  `stop | tool-calls | length | error | content-filter | unknown`。v2 稿 §17 只提了 `stop`。

### 1.2 取消只有两层，缺"软停"且未处理引擎不响应的常见情况

**问题**：§44 写了协议取消 → 超时 → `taskkill /T /F`，方向正确，但把
`EngineDriver.cancel()` 当成了大概率生效的操作。

**证据**：G07 逐一核实五个引擎，**没有一个在所有路径上做到真取消**：
Goose 的 `goosed` REST 历史上**没有任何取消端点**（ACP 是迁移目标而非已完工能力）；
dsh 在 Windows 上 ConPTY 没有进程组，SIGINT 转发这条路径曾整体失效；
opencode 存在 abort 后残留悬空 `tool_use`（没有配对 `tool_result`）的确认 bug。

**建议改法**（把三层写进 `EngineDriver.cancel()` 的契约，而不是当作可选优化）：
1. **协议级**：`session/cancel`（ACP）或 `abort`（RPC），等待 `CANCEL_GRACE_MS`（建议 5 秒）；
2. **软停**：Run 置 `cancelling`，停止向 SSE 转发该 Run 的事件，**释放 HTTP 等待者**
   （这一层 v2 稿没有，缺了它会出现"引擎不理睬取消，HTTP 一直挂着"）；
3. **进程树强杀**：Windows 优先 Job Object（`CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），
   降级 `taskkill /PID <pid> /T /F`。杀完**扫描并记录残留的 Office 进程**。

> 补充风险：评测沙箱是否允许创建 Job Object 未经核实，所以 `taskkill /T /F` 必须实现为降级路径，
> 不能只当备选。这一点建议写进第一周的实测清单。

### 1.3 能力注入被放在 P1，但它是 70% 客观分的主杠杆

**问题**：§35–37 的 Asset Federation 只写到"发现 / 描述 / 配置 / 注入"这一层抽象，
没有落到具体内容，且整体归在 P1。

**证据**：G03 与用例分析共同指向一个结论 —— 十个评测用例考的
Office 文件处理、Windows GUI 操作、网页检索能力，**没有一个引擎原生具备**，
全部要靠网关注入。接第三个引擎带来的边际收益，远低于把注入能力做扎实。

**建议改法**：把能力注入提为 **P0**，并落到实处：
- **MVP 只做两个 Capability Pack**：
  - `office`：SKILL.md（docx/xlsx/pptx/csv 的处理方法论与产物自检清单）+
    预装 Python 环境（python-docx、openpyxl、python-pptx、pandas）；
  - `windows`：GUI 自动化 MCP（UI Automation）+ 文件操作规范 + 危险命令清单。
- **注入方式退化成一个函数**，不要 `CapabilityProvider` 接口 —— SKILL.md 与 AGENTS.md
  已是跨引擎事实标准（T24），大多数情况就是复制或软链，加上生成一份 MCP 配置：
  ```ts
  function projectAssets(assetsDir: string, pack: EnginePack, workspace: string): void
  ```
- 通过 AGENTS.md 注入**产物自检清单**（文件已保存、路径正确、格式未破坏、数据可与源文件对账），
  直接对抗 G06 记录的高频失败模式：未保存、路径错、幻觉数据。

### 1.4 缺少 EngineChannel 维度，能力挂在引擎上而不是通道上

**问题**：§31 的 manifest 把 `capabilities` 直接挂在引擎下。这无法表达一个关键事实：
**同一个引擎的不同接入面，能力差异极大**。

**证据**：
- `hermes acp` 是进程内会话且工具面被裁剪（排除消息投递与 cron），而 `:8642` HTTP 才是完整接入面；
- dsh 的 SDK 通道**没有 cancel、审批不可达**，只有 ACP 通道有；
- opencode 插件里的 `client.session.abort()` 静默 no-op，而裸 HTTP `/abort` 正常；
- Claude Code 的 Agent Teams 在无头/SDK 通道下直接不可用。

三位独立评审一致认为这是**零代码增量、最高性价比**的一处改动。

**建议改法**：能力挂在 channel 下，manifest 多一层数组即可：
```json
{
  "id": "hermes",
  "defaultChannel": "acp",
  "channels": [
    { "id": "acp", "driver": "acp", "launch": { "command": "hermes", "args": ["acp"] },
      "capabilities": { "cancel": true, "sessionResume": true, "toolSurface": "reduced" } },
    { "id": "http", "driver": "http", "baseUrl": "http://127.0.0.1:8642",
      "capabilities": { "cancel": true, "toolSurface": "full" }, "status": "v2" }
  ]
}
```
**收益**：能力降级的粒度从"整个引擎下线"细化到"切到同引擎的另一个通道"；
并且可以诚实地把某能力在某通道上标成 `unsupported`，让上层永远不会选中它。

### 1.5 Windows Session 0 隔离完全没有提及

**问题**：全文没有涉及网关进程以什么会话身份运行。

**证据**：G03。Windows 自 Vista 起强制 Session 0 隔离，
**以服务、计划任务或任何非交互方式启动的进程，完全无法操作桌面 UI**。
已知用例 `office_028`（WeLink 发消息）与任务书正文示例 `office_002`（打开 Outlook 客户端）
都会因此静默失败 —— 不是报错，是拿不到分。

而且这不是一个孤例：`office_002` 的二级分类是"软件交互"，
说明隐藏用例里很可能还有多条桌面客户端操作任务。

**建议改法**：
- 网关**必须以交互式桌面会话身份启动**，写进 `INSTRUCTION.md` 的显著位置；
- `scripts/doctor.ps1` 增加检查：`(Get-Process -Id $PID).SessionId -eq 0` 则告警；
- `/health/ready` 的返回体里带 `desktopSession: true|false`。

---

## 2. 需要纠正的结论

### 2.1 §39"Gateway 不做代理模型请求" —— 方向对，结论不完整

**v2 稿的判断**：不做模型代理，避免额外网络跳转。**这个方向是对的**，也符合轻量化。

**但缺了一个前提**：赛题限定内部部署模型，这类服务大概率是
vLLM / SGLang / TGI 等自托管 OpenAI 兼容推理。G11 证实它们在
**流式 + 并行工具调用**场景下有持续暴露的缺陷：多个 tool_calls 挤在一个 delta 里触发断言崩溃、
`reasoning_content` 与 `tool_calls` 交接丢标记、pipeline-parallel 下 JSON 被截断
（vLLM #39584、#50512、#27641、#46262；SGLang 有同类问题）。

后果是工具调用的参数被截断或错位 —— 文件路径、单元格范围、幻灯片编号。
在 `office_103`（递归删除）这种用例上，参数损坏是危险的。

**建议改法**（既保持轻量又有兜底）：
- **默认直连**，保留 v2 稿的判断，不加这一跳；
- **Engine Doctor 增加一项"工具调用往返探针"**：发一个强制多参数工具调用的探测 prompt，
  校验返回的参数 JSON 完整性。探针失败时明确提示启用 `MODEL_PROXY=1`；
- `[v2]` 的 ModelProxy 只做一件事：按 `index` 分桶缓冲工具调用增量，
  仅在参数 JSON 闭合后才转发。接口预留，v1 不写代码。
- **鉴权必须支持 appid**：赛题原文写明"提供测试环境的 appid"，
  不能假定标准 `Authorization: Bearer`。v2 稿 §38 的 `auth.type` 已含 `app-id`，这点保留即可。

### 2.2 引擎选型不宜预设，应作为第一周的实验

**v2 稿**：§54 直接定为 OpenCode + Hermes + Pi。

**调研不支持这个预设**：

| 引擎 | 有利 | 风险 |
| --- | --- | --- |
| **Pi** | npm 安装、Windows 原生文档完整、`--mode rpc` 协议文档化（LF-delimited JSONL）、models.json 可配任意 wire 协议、有 PowerShell 工具 | 无独立 HTTP server 模式 |
| **OpenCode** | 协议形态与赛题规范最贴近、provider 原生支持 openai-compatible、SKILL.md 生态成熟 | **官方 strongly recommend WSL**，与 Windows 原生硬约束正面冲突（v2 稿 §55 自己也承认了） |
| **Hermes** | 有 Windows 原生自举安装器（自带 Python/Node/PortableGit）、`/v1/capabilities` 可做能力协商 | Windows 支持标注 **early beta**；自身即"网关+多渠道"，存在双网关叠层 |
| **Goose** | Apache-2.0、AAIF 治理、Computer Controller 直接覆盖桌面自动化 | `goosed` REST 历史上无取消端点；架构重构活跃期 |

**建议改法**：把 §54 改写成一条可执行的实验 ——
**第一周并行验证 Pi 与 OpenCode**，用 Conformance Kit 的 C01–C08 跑原生 Windows 冒烟，
以实测结果决定主力，Hermes 作为第三个引擎在第三周接入。
不预设结论，反而更能体现架构的引擎中立性。

---

## 3. 建议简化（复杂度超预算）

复杂度预算参考：MVP 核心 ≤5000 行 TypeScript、Canonical Core 模块 ≤6、Engine 侧 ≤3、
错误码 ≤8、Capability Pack 2 个、外部服务依赖 0。

### 3.1 Engine Fabric 九个组件 → 三个

§23 列了 Engine Registry、Engine Pack、Driver Registry、Capability Negotiation、
Engine Host、Engine Supervisor、Session Mapping、Model Adapter、Native Extension 九项。
这些组件对应的真实逻辑加起来不到 600 行，拆成九个模块只增加导航成本与接口摩擦。

| 合并为 | 职责 |
| --- | --- |
| `engine/registry.ts` | 扫描 engine-packs、按 `AGENT_ENGINE` 选引擎与通道、静态 manifest + 运行时探测合成有效能力 |
| `engine/host.ts` | 进程生命周期：spawn、health、异常退出、重启退避、进程树清理 |
| `engine/drivers/{acp,rpc}/` | 两个 Driver 实现 |

`Session Mapping` 其实就是 `sessions` 表的两个字段（`engine_id`、`native_session_id`），不需要独立组件；
`Model Adapter` 与 `Native Extension` 是 Engine Pack 目录下的文件，不是 Fabric 的组件。

### 3.2 SQLite 保留但要极简

赛题明确"可以不实现持久化存储，会话数据可以保存在内存中"。
v2 稿把 SQLite 列为 P0，理由是崩溃恢复 —— 这个理由在鲁棒性 5% 和演示价值上站得住，**建议保留**，
但要控制实现成本：

- **不要 migrations 框架**：一个 `schema.sql` + 启动时 `CREATE TABLE IF NOT EXISTS` 即可，
  `schema_migrations` 表保留但 v1 只有版本 1；
- **不要 Repository 的多态抽象**：每张表一个模块，导出几个函数，内部是 prepared statement；
- **驱动建议 `better-sqlite3`**：同步 API 让事务代码简单得多，这个场景没有并发写压力
  （Agent 的耗时在 LLM 和工具上，不在 SQLite）。若 Windows 编译安装失败，
  降级到 Node 24 内置的 `node:sqlite`。v2 稿选 `sqlite3` 异步驱动会让 §16 的事务代码复杂不少。
- 预计代码量：建表 + 四张表读写约 300 行。

### 3.3 错误码 14 → 8

保留 `VALIDATION_ERROR`、`NOT_FOUND`、`SESSION_BUSY`、`ENGINE_UNAVAILABLE`、
`ENGINE_PROTOCOL_ERROR`、`EXECUTION_TIMEOUT`、`EXECUTION_CANCELLED`、`INTERNAL_ERROR`。

合并：`ENGINE_NOT_FOUND` / `ENGINE_START_FAILED` → `ENGINE_UNAVAILABLE`（细节进 `detail`）；
`ENGINE_SESSION_ERROR` → `ENGINE_PROTOCOL_ERROR`；
`MODEL_CONFIGURATION_ERROR` / `MODEL_REQUEST_ERROR` → 启动期归 `ENGINE_UNAVAILABLE`、运行期归 `ENGINE_PROTOCOL_ERROR`；
`CAPABILITY_UNSUPPORTED` → `VALIDATION_ERROR`（带 `detail.capability`）。

错误码本身不贵，但每个都需要触发路径、测试和文档；八个足够覆盖赛题要求的错误模型。

---

## 4. 值得补充的两条

### 4.1 危险操作的记录与幂等

两条高危用例：`office_103` 递归删除（作用域错误不可逆）、`office_028` 外部消息（重试会重复发送）。

- 权限策略默认 `allow`（保证自动评测不挂死，v2 稿 §43 已如此），
  但所有 permission 请求应**全量落 `interactions` 表并进入 Run 事件流**；
- 对匹配危险模式的命令（`Remove-Item -Recurse`、`rm -rf`、`del /s`）额外打 `risk: high` 标记；
- **有外部副作用的操作不自动重试** —— 与 v2 稿 §45"不自动重放 Prompt"同源，建议在文档里并列写明。

### 4.2 `/question` 与 `/permission` 是必做而非可选

v2 稿 §42 写"赛题允许 Question/Permission 简化实现"，这个表述需要收紧。

**赛题原文**（任务书"重要提示"）：
"执行过程需要人工交互的，**需要实现接口供裁判模型自动提交交互**，否则将导致作品无法完成自动评测。"

可以简化的是**默认策略**（默认允许、默认不询问），**接口本身必须真实可用** ——
裁判模型要靠这两条链路把交互提交回来。v2 稿 §42–43 的实际设计（保留完整 API + 默认自动策略）
是符合要求的，只是文字表述容易让实现者误以为可以砍掉端点，建议改一句话。

---

## 5. 逐节抽查结论

| 节 | 结论 |
| --- | --- |
| §2 赛题要求对照 | 准确。建议补一行"以交互式桌面会话运行"，见 1.5 |
| §3–5 P0/P1/P2 | 结构好。建议把"能力注入"从 P1 提到 P0（见 1.3），SQLite 从 P0 降为"P0 但极简"（见 3.2） |
| §6 总体架构图 | 清晰。Engine Fabric 内部组件建议按 3.1 合并 |
| §7–9 技术栈 | 认同。Node + TypeScript + Fastify 的理由充分；SQLite 驱动建议换 `better-sqlite3`（见 3.2） |
| §12–16 Session/Run/事务 | 状态机与事务边界设计正确，`interrupted` 态是亮点 |
| §17 Message Store | 需补 `finish` 的 6 个值（见 1.1） |
| §18–20 事件架构 | Canonical + Raw 双写是正确判断。建议补一句"网关自打 `sequence`"，多数引擎不提供序号 |
| §21–22 SSE 与背压 | 有界队列 + 慢客户端断开 + "Message Store 是最终事实源"的定位都对 |
| §24–27 Driver | 只做两个 Driver 的决定正确。Pi 走 RPC 而非嵌入 SDK 的理由（进程隔离）成立 |
| §28–32 Engine Host / Pack | 声明式接入是核心亮点。manifest 需加 channel 维度（见 1.4） |
| §33–34 能力协商 | 静态 manifest + 运行时探测的两段式正确。建议再加一态：未跑通 CTS 的只能标 `claimed` |
| §35–37 Asset Federation | 最需要加强的一节，见 1.3 |
| §38–40 Model | 见 2.1。`dynamicModelSwitch` 的处理（不支持就报错而非隐式重启）是对的 |
| §41 Workspace | 正确。建议补长路径（>260 字符）与中文路径的处理说明 |
| §42–43 Interaction | 见 4.2 |
| §44 Cancellation | 见 1.2，缺"软停"层 |
| §45 不自动重放 | **全文最重要的安全判断之一**，完全认同 |
| §46–49 恢复与 Supervisor | 设计合理。`sessionRecovery` 三态（native/recreate/unsupported）与"不做伪恢复"的态度正确 |
| §50–51 Health / Doctor | Doctor 是部署可靠性的关键。建议增加两项检查：Session 0 检测、工具调用往返探针 |
| §52–53 Conformance Kit | C01–C20 覆盖面好。建议把 G07 的四条核验补进去：abort 后用 `tasklist` 核实子进程真没了、abort 后检查残留 `tool_use` 是否有配对 `tool_result`、流式中发第二个 prompt 确认返回 409、确认无残留 Office 进程 |
| §54–58 Harness 选择 | 见 2.2，建议改为第一周实验 |
| §59–63 可观测 | 本地轻量方案的取舍正确，不引入外部栈是对的 |
| §64–72 DFX | 系统性强。`MAX_CONCURRENT_RUNS=1` 的理由（多 Agent 抢同一桌面）很实际 |
| §73–80 各流程 | 完成顺序（§77）严格对齐赛题判定，是全文最有价值的段落之一。需补 §76 的 204 触发信号（见 1.1） |
| §81 Error Model | 见 3.3 |
| §82 项目结构 | 合理，可直接使用 |
| §84–88 V2 与亮点 | 定位准确。建议把"双跑取优 / 跨引擎 fallback"从任何位置移除 —— 赛题一轮只启动一个引擎，这两条既不成立也容易被读成投机 |

---

## 6. 修改清单（按优先级）

| # | 改动 | 优先级 | 预计工作量 |
| --- | --- | --- | --- |
| 1 | 补"`prompt_async` 阻塞语义实现"一节：双重确认 + 总超时兜底 + `finish` 6 值 | 阻断 | 文档 1 节，代码约 80 行 |
| 2 | 取消补"软停"层，三层写进 `cancel()` 契约 | 阻断 | 文档半节，代码约 60 行 |
| 3 | 能力注入提为 P0，落到 office / windows 两个 Pack + `projectAssets` 函数 | 阻断 | 文档 1 节，代码约 150 行 + 资产内容 |
| 4 | manifest 增加 EngineChannel 维度 | 阻断 | 文档半节，代码约 30 行 |
| 5 | 补 Windows Session 0 检查与 INSTRUCTION.md 说明 | 阻断 | 文档半节，脚本约 20 行 |
| 6 | Doctor 增加工具调用往返探针，`[v2]` 预留 ModelProxy | 重要 | 文档半节，代码约 60 行 |
| 7 | §54 引擎选型改为第一周实验 | 重要 | 仅文档 |
| 8 | Engine Fabric 九组件合并为三个 | 重要 | 仅文档结构，减少代码 |
| 9 | SQLite 极简化，驱动换 `better-sqlite3` | 建议 | 减少代码 |
| 10 | 错误码 14 → 8 | 建议 | 减少代码 |
| 11 | 危险操作全量记录 + 不自动重试 | 建议 | 代码约 40 行 |
| 12 | §42 关于 Question/Permission 的表述收紧 | 建议 | 仅文档一句话 |
| 13 | 移除"双跑取优 / 跨引擎 fallback" | 建议 | 仅文档 |
| 14 | Conformance Kit 补 G07 的四条核验 | 建议 | 用例约 4 个 |

前五条建议在开始编码前补进方案；6–8 在第一周内确定；9–14 可以边写边改。

---

## 7. 一句话评价

**骨架对了，边界也划得清楚，问题集中在"引擎不按文档行事"这一类现实风险上。**
v2 稿的多数设计是在假定引擎会正确响应取消、正确给出终态、正确解析工具调用的前提下写的；
而调研的一手证据显示这三条恰恰都不可靠。把这五处阻断级的兜底补上，
再按复杂度预算收一收组件数量，这份方案就可以直接开工。
