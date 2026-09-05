# G06 评测机制（Rollout + LLM-as-Judge）、轨迹记录与鲁棒性工程

## 摘要

主流 Agent 评测框架（OSWorld、WindowsAgentArena、tau-bench、AgentBench）的核心范式是 **execution-based checker（规则化终态检查）为主、LLM-as-Judge 为辅（多用于事后错误归因而非主评分）**：OSWorld 用 getters+metrics 两层架构对 VM 内文件/浏览器/终端终态做确定性比对（如 compare_docx_files/compare_docx_tables/compare_font_names 等），369 个任务下人类成功率 72.36% vs 当时最优 agent 12.24%；tau-bench 主评分是数据库状态 diff，LLM 只做失败后 fault assignment/type 分类。办公任务（docx/xlsx/pptx）验收应覆盖文件存在性、内容/表格/图片一致性、格式细节（字体/行距/页码/高亮色，用 CIEDE2000 色差容忍渲染误差）三个维度，常见失败模式集中在格式破坏、未保存、路径错误、编码问题与数据幻觉，harness 层应通过系统提示检查清单、产物自检（重新打开生成文件核对）与有限重试来提高通过率。鲁棒性工程重点确认了一个关键、且极易被忽视的 Windows 平台坑：**TerminateProcess 不会级联终止子进程**，必须用 Job Object（JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE）或 `taskkill /T /F` 管理整棵进程树，否则长跑评测会在用例间残留 winword.exe/excel.exe 等僵尸进程导致连锁失败 [已交叉验证]；SSE 断连重连应利用协议原生的 `retry`/`id`+`Last-Event-ID` 机制并在网关侧做短窗口事件缓冲补发。本地回归评测建议用赛题给定 6 类任务各取 1-2 条构成 10 条 smoke-test 子集，跑多引擎生成"引擎×用例"记分卡。评测方沙箱可能无网络/无管理员权限/脚本化安装，要求引擎与依赖支持离线安装、用户态运行、自定义内部模型端点。本报告对赛题实际评测器源码未获取到一手资料，相关结论标注为推测，供后续核实。

## 关键事实（表格）

| 事实 | 来源 | 置信度 | 是否交叉验证 |
|---|---|---|---|
| OSWorld 采用"execution-based evaluation"，即执行后对真实 VM 内文件/浏览器/终端状态做规则化检查，而非单纯依赖 LLM 打分；论文摘要明确称为 execution-based evaluation | OSWorld README (raw.githubusercontent.com/xlang-ai/OSWorld) + arXiv:2404.07972 摘要 | 高 | 是（README 与论文摘要互证）|
| OSWorld 基准含 369 个真实桌面/网页任务，覆盖 OS 文件 I/O 与跨应用工作流；论文报告人类成功率 72.36%，当时最好 agent 仅 12.24% | arXiv:2404.07972 摘要 | 高 | 否（仅一手来源，未二次核对，但为论文摘要原文引用）|
| OSWorld 评测架构分两层：getters（从浏览器/文件系统/终端等取状态）与 metrics（比较取到的状态与期望结果的校验逻辑），任务由 JSON 定义 instruction/config(初始化)/evaluator(校验)/postconfig 等字段 | deepwiki.com/xlang-ai/OSWorld 摘要 | 中 | 否（deepwiki 为二手摘要工具，未能直接核对原始 JSON schema，个别字段名可能有出入）|
| OSWorld 针对 docx 类办公任务的 metrics 函数示例：compare_docx_files（内容比对，支持忽略空格/大小写/乱序/模糊匹配）、compare_docx_tables、compare_docx_images（字节级比对）、compare_line_spacing、compare_font_names、contains_page_break、has_page_numbers_in_footers、check_tabstops、evaluate_colored_words_in_tables（用 CIEDE2000 色差阈值 3.5 判断颜色）、compare_image_text（EasyOCR）等 | raw.githubusercontent.com/xlang-ai/OSWorld/main/desktop_env/evaluators/metrics/docs.py | 高 | 否（源码文件直接读取，函数名与逻辑描述一致性高）|
| WindowsAgentArena（WAA）任务用 JSON 配置（如 evaluation_examples_windows/test_all.json），含 diff_lvl（normal/hard）、json_name 等字段；本地跑通过 Docker+QEMU 起一个约 30GB 的 Windows 11 VM 快照，VM 内跑一个 Python server 接收/执行 agent 指令；云端可用 Azure Standard_D8_v3 做 40 路并行，约 35 分钟跑完 | github.com/microsoft/WindowsAgentArena README | 高 | 否 |
| τ-bench（tau-bench）用 Pass^k（Pass^1..Pass^4）衡量多次独立试跑下的稳定成功率，并提供一个"auto error identification"工具，用 LLM 做失败后的 fault assignment（判断责任方：user/agent/environment）与 fault type 分类——即 LLM 用于事后错误归因，而非充当主评分器；README 提示原版任务集已不再更新，建议关注 τ²-bench | raw.githubusercontent.com/sierra-research/tau-bench README | 中 | 否 |
| AgentBench 覆盖 8 类环境（OS/DB/KG/DCG/LTP + 移植的 ALFWorld/WebShop/Mind2Web），以环境内状态/结果做评测而非 LLM-judge，Dev/Test 集分别约需 4k/13k 次多轮交互 | raw.githubusercontent.com/THUDM/AgentBench README | 中 | 否 |
| Windows 上 TerminateProcess 只终止目标进程本身，**不会**终止其创建的子进程；若要保证父子进程一起退出必须显式管理，官方推荐用 Job Object（JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE，配合 AssignProcessToJobObject）把整棵进程树纳管，句柄关闭时整树被杀 | learn.microsoft.com/windows/win32/procthread/terminating-a-process 与 .../job-objects [已交叉验证] | 高 | 是（两篇官方文档互证同一结论）|
| Job Object 自 Windows 8 / Server 2012 起支持嵌套（nested jobs），此前版本一个进程只能属于一个 job 且不可嵌套；子进程默认随父进程一起加入同一 job，除非显式设置 BREAKAWAY 标志 | learn.microsoft.com/windows/win32/procthread/job-objects | 高 | 否 |
| SSE（EventSource）协议原生支持断线自动重连：服务端可在事件流中下发 `retry: <ms>` 字段控制重连等待时间，并用 `id:` 字段配合客户端自动回传的 `Last-Event-ID` 请求头实现"断点续传"式的事件恢复 | developer.mozilla.org MDN Server-sent events 指南 | 高 | 否（MDN 为规范权威文档，行业公认）|

## 架构与工作原理

主流 Agent 评测框架（OSWorld、WindowsAgentArena、tau-bench、AgentBench）的通用架构可以抽象为三层：

1. **Rollout 执行层**：在一个隔离环境（VM/容器/沙箱）中，按照任务 config 做初始化（安装/打开指定文件、设置桌面状态、注入初始数据），然后把 instruction 交给被测 agent，由 agent 自主多轮操作（点击、输入、调用工具、执行 shell），过程中把每一步动作、观测（截图/DOM/终端输出）、以及最终产物状态记录下来，形成一条 **trajectory**。
2. **评测/打分层（Evaluator）**：分两种范式，且往往组合使用：
   - **规则化/执行式检查（execution-based checker）**：OSWorld 与 AgentBench 的主评测均属此类——评测器不看"过程"，只看**任务结束后的环境终态**（文件内容、数据库记录、桌面截图 OCR 结果等），用确定性代码（getters 取状态 + metrics 比较）给出 0/1 或部分分。这类检查器可复现、无 LLM 调用开销、但需要为每个任务单独写校验脚本，覆盖率与工程量成本高。
   - **LLM-as-Judge / 事后归因**：当终态无法用简单规则判定（如"文案是否得体""排版是否美观""资讯检索结果是否准确"），或需要对失败原因做归因时引入 LLM 评判。tau-bench 的做法是典型例子：主评分仍是数据库状态 diff（rule-based reward），LLM 只在事后对失败 trajectory 做 fault assignment（user/agent/environment 三方责任判定）与 fault type 分类，用于诊断而非直接决定得分——这提示我们"LLM-as-Judge"更适合做**辅助性、可解释性**评分，而不是完全替代规则检查。
   - 对于本赛题这种"Windows 办公任务 + Rollout + LLM-as-Judge"的组合评测，合理推测（**推测**，题面未给出评测器源码）是：客观分的"规则可判定部分"（文件是否存在、格式是否为 docx/xlsx/pptx、路径是否正确、是否覆盖保存）用脚本检查，"内容质量/语义正确性部分"（润色是否得体、数据分析结论是否合理、PPT 排版是否可用）用 LLM-as-Judge 读取产物 + 轨迹给出评分，两者加权构成客观 70% 中的分项。
3. **结果聚合/展示层**：如 OSWorld 的 `show_result.py`、WAA 的 `show_results.py`，按域/类别汇总 pass rate，输出排行榜格式，通常还保留每条 trajectory 的日志目录供人工复核（manual_examine.py）。

## 可编程接入面

评测框架本身的"可编程接入面"关注的是它如何**驱动/观察**被测 agent，这与我们网关要暴露给评测器的接口正好对偶：

- OSWorld：开发者需实现统一的 agent 接口（在 `run.py` 中 import 自定义 agent 类），本质是一个"给定 observation（截图/accessibility tree），返回下一步 action" 的函数式接口，循环驱动直到 agent 主动声明 done 或超步数上限。这与题面给的"POST /session/{id}/prompt_async 阻塞到本轮完整结束"的语义不同——OSWorld 是逐步细粒度回合制，而题面网关是整轮任务级异步驱动，说明本赛题评测器大概率是在**任务粒度**上调用网关（一次 prompt_async 对应一个完整办公任务，而非逐个鼠标点击），更贴近 tau-bench/AgentBench 式"高层指令 → 完整完成/失败"的评测粒度。
- WAA：VM 内运行一个 Python server 接收/执行 agent 发出的命令（截图、鼠标键盘操作等），agent 与该 server 通信；宿主机侧再用 `test_all.json` 驱动批量任务、用 `show_results.py` 汇总。
- 结果记录格式：OSWorld 明确会保存 **截图序列 + 动作序列 + 视频录像** 到 results 目录，供事后分析和排行榜复核；这是 Rollout 评测的通用套路——"轨迹"不仅是文本 JSON，还应包含可回放的视觉证据（这一点对 Windows 办公任务尤其重要，因为很多失败只有截图才能看出，如"表格样式跑版但文字内容正确"）。

## 会话模型（评测视角：Rollout 与网关 Session 的映射）

评测器眼中的"一个 rollout"应当**严格对应网关的一个 session 生命周期**：POST /session 创建（带 directory，指向该用例的隔离工作目录）→ 若干次 prompt_async（阻塞轮次，允许多轮指令，如"先读取 CSV，再生成分析报告"）→ 用 GET /session/{id}/message 拉取完整轨迹供打分 → DELETE /session 收尾清理。评测器很可能对每个用例单独起一个新 session（保证会话隔离，避免上一用例的上下文污染下一用例的判定），这与题面强调的"不同群 session 隔离"是同一机制在评测场景下的复用。

## 权限与安全（评测视角）

评测环境的沙箱化程度直接决定引擎可用的操作面：

- OSWorld/WAA 均在**独立 VM/容器快照**里跑任务，agent 对宿主机无破坏性影响，允许较激进的操作（如系统级文件删除用例）。
- 本赛题约束是"Windows 10/11 原生运行、可能无管理员权限、脚本化安装、无网络或受限网络"（见下文"沙箱部署方式"节），这比 OSWorld/WAA 的完全托管 VM 更贴近真实企业内网场景，意味着：引擎与网关都不能依赖需要管理员权限的安装动作（如注册 Windows 服务、写系统盘保护目录），需支持"用户态安装 + 便携式运行"。
- 递归删除文件类用例本身就是"高风险操作评测点"，鲁棒性工程上应要求网关/引擎在执行前有可预览、可确认的中间态（配合题面的 /permission 可选接口），并在轨迹中完整记录被删除的文件清单，便于 judge 核验是否误删。

## 扩展机制与资产

不适用：本专题聚焦评测机制本身而非某个具体 Agent 引擎的插件/资产系统，故此章节留空，相关内容见 G01-G05 等引擎专题报告。

## 记忆

不适用：评测框架层面通常不涉及跨 rollout 的持久记忆（每个用例应从干净状态开始，以保证可复现性）；OSWorld/WAA 的 VM 快照机制本质上是"每次评测强制重置记忆/状态"的工程实现，这与我们网关侧"会话上下文隔离"的诉求是一致的设计目标。

## 多 Agent 与协作

不适用：所调研的四个评测框架（OSWorld、WindowsAgentArena、tau-bench、AgentBench）均以单 agent 驱动单环境为主评测单位；tau-bench 中的"user simulator"（ReAct 风格模拟用户）不是被测多 agent 协作，而是评测器一侧用于生成动态对话的辅助角色，不属于我们架构中"agent team/多 agent 编排"这一扩展能力范畴。

## 可观测性（轨迹记录格式与要求）

- **轨迹应为结构化、可回放、可差异对比的日志**：OSWorld 的做法是 截图序列 + 动作序列 + 视频，按 domain/task_id 分目录存放，配合 `manual_examine.py` 支持人工复核；这提示我们网关侧的 `GET /session/{id}/message` 至少要能重建"user 指令 → assistant 思考/工具调用 → tool result → step-finish(finish=stop)"这样完整的、按时间顺序排列的事件流（与题面给的字段术语一致），并且**工具调用与结果要能关联到具体产物文件路径**，以便 judge 直接定位到 docx/xlsx/pptx 文件做二次校验。
- **SSE 事件应可断线重连**：MDN 规范明确 EventSource 原生支持 `retry` 字段控制重连间隔、`id`/`Last-Event-ID` 支持断点续传；网关的 `GET /event` 实现应当下发递增的事件 id 并在客户端携带 `Last-Event-ID` 重连时支持"从断点补发"，否则评测器在长任务网络抖动后会丢失关键的 `session.idle`/`message.part.updated` 事件，导致误判超时失败。heartbeat（心跳）事件（题面已列出 `heartbeat`）是判断连接存活与和"引擎挂起 vs 网络断开"区分的关键信号，鲁棒性设计上应设置心跳超时阈值（如 30s 无心跳判定连接死亡并触发客户端重连）。
- **完成判定信号要清晰、唯一**：题面协议用 `finish=stop` 表示最终完成，`session.idle`/`session.error` 表示会话级状态；轨迹记录与 judge 消费的应是同一份"finish 事件"，避免网关和评测器对"任务是否结束"有不同理解（例如 assistant 输出了文字但工具调用还在排队执行，不能提前判定 finish）。


## 对我们架构的启示

### 1. 办公任务（docx/xlsx/pptx）自动化验收方式与常见失败模式

参考 OSWorld 的 metrics 库（`compare_docx_files`/`compare_docx_tables`/`compare_docx_images`/`compare_font_names`/`contains_page_break`/`check_highlighted_words` 等），可归纳出办公类用例的**规则化验收维度**，可直接用于我们自建的本地回归 benchmark：
  - 文件层面：`check_file_exists`（路径/文件名是否正确、扩展名是否匹配）、是否覆盖保存到预期目录而非另存为临时文件。
  - 内容层面：文本内容比对（可忽略空格/大小写/顺序，支持模糊匹配容忍同义改写）、表格结构与单元格值比对、图片是否插入且字节一致、OCR 识别截图中的文字（EasyOCR）用于验证"看起来对不对"。
  - 格式层面：字体、行距、页码、首行居中、制表位、着重/删除线、高亮颜色（用 CIEDE2000 色差判定，容忍渲染误差）——这提示我们的引擎层系统提示词应显式要求"用编程库（如 python-docx/openpyxl/python-pptx）而非手工拼 XML"来保证格式一致性，减少"格式破坏"这一常见失败模式。

  **常见失败模式**（综合 OSWorld 评测维度设计动机 + 通用工程经验，标注为**推测/经验总结**，非单一来源直接陈述）：
  1. 格式破坏：另存为错误格式（如把 .docx 存成 .txt）、样式丢失、表格边框/合并单元格错乱。
  2. 文件未保存/未落盘：agent 在内存里"生成"了内容但没有调用保存工具，或保存到了错误的工作目录（尤其在多 session 并发、`directory` 参数配置错误时）。
  3. 路径错误：相对路径 vs 绝对路径混淆、Windows 路径分隔符 `\` 被转义成 `/` 导致工具调用失败、路径含中文/空格未做转义。
  4. 编码问题：CSV/Excel 读写涉及 GBK/UTF-8 混用，中文办公场景下尤其突出，需要引擎在处理国产 Office 文件时做编码探测与容错。
  5. 幻觉数据：数据分析类任务中 agent 编造不存在于源数据的数字/结论，而不是真正调用工具读取 CSV/Excel 计算——这是 LLM-as-Judge 最应重点核查的一类失败，需要 judge 拿到"轨迹中的工具调用与真实产物"做交叉核对，而不仅看最终文字描述。

  **提高通过率的 harness 层措施**：
  - 系统提示中显式给出"office 任务检查清单"（保存路径确认、格式验证、内容 diff self-check）。
  - 产物自检（self-verification）：让引擎在声明完成前，用只读工具重新打开生成的文件、核对关键字段，是文本判定之外增加的一层"execution-based self-check"，可显著降低"看似完成实则文件损坏"的比例。
  - 失败重试：网关层可对"工具调用报错/文件未生成"类失败做有限次数（如 1-2 次）自动重试或提示引擎自纠正，但要避免无限重试导致超时（评测器通常对单用例有总时长上限）。

### 2. 鲁棒性工程清单（可直接落地到网关实现）

- **超时/重试/幂等**：`prompt_async` 是阻塞语义，网关需要设置合理的整体超时（超过阈值主动返回错误并保留部分轨迹，而非无限挂起）；对幂等性，同一 session 内重复 POST prompt 应有防抖或排队机制（题面 `GET /session/status` 的 idle/busy 状态即用于此目的——客户端应先查 busy 再决定是否排队/拒绝）。
- **引擎进程崩溃恢复**：网关应对底层引擎子进程做健康探测（如定期检查进程存活 + stdout/stderr 是否异常退出），崩溃后能在同一 session 语义下重启引擎进程并从已持久化的对话历史恢复上下文（若引擎自身不支持断点续跑，至少要能把"未完成"状态如实反映在 `session.error` 事件中，而不是让评测器无限等待）。
- **僵尸进程清理与 Windows 进程树终止**：**[已交叉验证]** Win32 官方文档明确指出 `TerminateProcess` 只杀死目标进程本身、**不会**杀死其创建的子进程；要保证"杀网关时引擎及其派生的所有子进程（如被引擎调用的 Word/Excel COM 进程、shell 子命令）一起退出"，必须使用 **Job Object**（`CreateJobObject` + `AssignProcessToJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），或在 Node/Python 场景下用等价的 `taskkill /PID <pid> /T /F`（`/T` 表示杀整棵进程树）。这是 Windows 平台鲁棒性工程里最容易被忽视但后果最严重的一点——不做进程树管理，长跑评测很容易在多用例之间残留僵尸的 winword.exe/excel.exe 进程，进而在下一个用例里造成"文件被占用无法保存"这类连锁失败。
- **SSE 断连重连**：依据 SSE 规范，服务端应下发 `retry:` 与递增的 `id:`，客户端（评测器）按标准 EventSource 行为自动重连并带上 `Last-Event-ID`；网关应保留一个短窗口的事件缓冲（如最近 N 条或最近 T 秒），以便重连后补发遗漏事件，避免评测器因为一次网络抖动就误判"引擎失联"。
- **并发用例隔离**：题面 `POST /session {title, directory}` 天然支持"用 directory 隔离不同用例的工作目录"；网关需保证不同 session 对应不同的引擎子进程/工作目录/临时文件区，并在 Windows 上注意"同名文件跨 session 加锁冲突"（如两个用例都恰好生成 `output.docx` 到共享临时目录时要防止互相覆盖）。
- **日志与轨迹持久化**：每个 session 的完整消息轨迹、工具调用参数与结果、进程 stdout/stderr、耗时统计都应落盘（而非只保留在内存），以便评测器 `GET /session/{id}/message` 随时能拉取完整历史，也便于我们自己做"引擎记分卡"式的本地回归分析。
- **启动自检（preflight check）**：网关/引擎启动时应主动探测：(a) 模型端点连通性（对内部部署的 OpenAI/Anthropic 兼容端点发一个最小 ping 请求）、(b) 引擎版本号打印与期望版本核对、(c) 关键工具可用性（如 python-docx/openpyxl/python-pptx 是否已安装、Windows 上 Office 是否已安装或改用无 Office 依赖的库）。启动自检失败应快速返回明确错误而非在第一个用例执行时才暴露，这直接影响评测方"鲁棒性 5%"这一项打分。

### 3. 本地回归评测框架（"引擎记分卡"）设计建议

- 用赛题给出的 6 类办公任务（Word 润色/表格导出、CSV/Excel 分析、PPT 编辑/生成、递归删除文件、IM 发消息、实时资讯检索）各取 1-2 条，共约 10 条构成本地 smoke-test 子集，每条用例固定：instruction、初始 `directory` 快照、规则化 checker（参照 OSWorld metrics 风格，用 python-docx/openpyxl/python-pptx 做产物比对）+ 可选 LLM-judge rubric。
- 框架对每个候选引擎（通过 `gateway --engine <name> --port 6217` 分别启动）跑一遍全部用例，记录：pass/fail、耗时、工具调用次数、是否触发重试、失败类型标签（格式破坏/未保存/路径错误/编码问题/幻觉数据/超时/进程崩溃），汇总成一张"引擎 × 用例"的记分卡矩阵，作为架构设计里"每个用例取所有引擎最高分"评分逻辑的本地复现工具，也是我们判断"新引擎接入是否达标"的验收标准。
- 记分卡应包含"能力协商"结果快照（该引擎本轮声明支持哪些扩展能力、用了哪些配置参数），便于横向比较引擎差异是能力问题还是 harness 层适配问题。

### 4. 评测方沙箱部署方式对方案的影响

题面明确：评测环境为 Windows 10/11，可能**无网络或受限网络、无管理员权限、脚本化安装**。这对方案的直接影响：
  - 引擎与依赖（Node/Python 运行时、python-docx 等库）必须支持**离线/内网镜像安装**或**打包成免安装的便携版**，不能依赖运行时从公网拉取（如 npm install / pip install 在受限网络下会失败）；建议在交付物中预置 vendor 好的依赖包或使用单文件可执行打包（如 PyInstaller/pkg 或 Node 的 `pkg`/`nexe`）。
  - 无管理员权限意味着不能注册 Windows 服务、不能写入 `C:\Program Files` 或系统目录，网关与引擎都应以普通用户权限、用户目录（如 `%LOCALAPPDATA%`）下运行和写日志。
  - 脚本化安装要求提供幂等的一键安装/启动脚本（PowerShell/批处理），且脚本本身要做好前置检查（磁盘空间、端口 6217 是否被占用、Office/依赖库是否已存在）并在失败时给出清晰诊断信息——这与"启动自检"是同一工程诉求的两个阶段（安装时 vs 运行时）。
  - 主模型限定为内部部署模型，意味着评测网络大概率只放通到该内部端点，因此引擎选型必须优先支持"自定义 base_url + API Key"这种 OpenAI/Anthropic 兼容配置方式，而不能依赖仅支持官方云端点的引擎变体。

## 未解决问题

1. 本赛题实际使用的评测器代码/rubric 未公开获取到一手来源，本报告对"客观 70% 如何在规则检查与 LLM-judge 之间分配权重"只能基于同类框架的通用做法做合理推测，需以赛题方后续公布的评测脚本为准。
2. OSWorld 的 task JSON 完整 schema（`evaluator`/`postconfig`/`result` 字段的精确结构）未能直接抓取到原始文件内容（deepwiki 摘要为二手信息，且原始 raw.githubusercontent 路径抓取时返回 404，可能是文件路径已变化），建议后续如有需要应通过 `gh api` 或 DeepWiki 源码浏览做二次确认。
3. WindowsAgentArena 与 tau-bench/AgentBench 的最新版本号、发布日期、是否仍活跃维护（尤其 tau-bench README 已提示"任务集不再更新，建议关注 τ²-bench"）未做进一步版本核实，若要在设计文档中引用具体版本号需再核对一次。
4. 题面网关协议中 `/question`、`/permission` 两个可选接口与评测器 LLM-as-Judge 之间的交互方式（例如递归删除文件类用例是否会触发 permission.asked 事件、judge 是否会检查 agent 是否正确请求了权限确认）未见一手说明，属于需要与赛题方进一步确认的空白点。

## 来源列表

- https://raw.githubusercontent.com/xlang-ai/OSWorld/main/README.md
- https://github.com/microsoft/WindowsAgentArena
- https://raw.githubusercontent.com/xlang-ai/OSWorld/main/desktop_env/evaluators/metrics/docs.py
- https://deepwiki.com/xlang-ai/OSWorld
- https://raw.githubusercontent.com/sierra-research/tau-bench/main/README.md
- https://raw.githubusercontent.com/THUDM/AgentBench/main/README.md
- https://arxiv.org/abs/2404.07972 （OSWorld 论文摘要）
- https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process
- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events
