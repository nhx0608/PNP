# 本地验证方案：按赛题要求在 Windows 上测 PNP 网关

给执行验证的 Agent/同事：本文是完整的操作与判分依据，按顺序做，把第 7 节的报告填好交回。遇到失败按第 7 节记录证据，不要自行绕过。

仓库提供的是**公开、脱敏、合成的本地夹具**，用于复跑能力与安全边界，不是组委会原始材料，也不能代替正式数据集。公开任务文件中的收件人统一写作 `TEST_RECIPIENT`；真实内网账号只能放进 Git 忽略的私有覆盖文件。

## 1. 目标

1. 证明网关按《Agent 网关接口规范》v1.1 工作：会话、`prompt_async`、SSE 事件、消息轨迹与 8.4 完成规则、中止、反问/授权接口、错误格式、`AGENT_ENGINE` 切换。
2. 证明两个引擎（`opencode`、`pi`）都能完成赛题样例里那类办公任务，产物落在指定绝对路径。
3. 找出失败并留证据：哪一步、什么现象、日志在哪。

## 2. 环境准备（约 10 分钟）

前提：Windows 10/11 x64；能访问智谱开放平台（测试模型用 `glm-4-flash`，需要一个 API Key）；Office 已安装（部分任务要开 Outlook）。不需要 Python、Git Bash、管理员权限。

在 `solution\code`（源码仓库里是 `engineering\code`）下打开 PowerShell（资源管理器地址栏输入 `powershell` 回车）。注意 PowerShell 执行当前目录的程序要带 `.\`：

```powershell
Set-Location <solution>\code

# 1. 写入模型配置（交互式，四个问题；回车取默认值）
.\pnp.cmd config
#   PNP_MODEL_ENDPOINT [https://open.bigmodel.cn/api/paas/v4] → 回车
#   PNP_MODEL_ID       [glm-4-flash]                          → 回车
#   PNP_MODEL_API_KEY  → 粘贴智谱 API Key
#   PNP_MODEL_HEADERS  → 回车（留空）

# 2. 不用模型的自检（用内置模拟模型跑通全部接口机制）
.\pnp.cmd selfcheck --engine opencode
.\pnp.cmd selfcheck --engine pi

# 3. 用真实模型的自检（写文件、同会话第二轮、中止）
.\pnp.cmd livecheck --engine opencode
.\pnp.cmd livecheck --engine pi
```

配置会写入 `engineering\code\runtime\local.env`（交付包中对应 `code\runtime\local.env`），该路径已被 Git 忽略。API Key 不要写进任务 JSON、报告、截图、命令脚本或提交记录，也不要在聊天中发送。若要更换 Key，重新执行 `pnp.cmd config` 即可。

四条命令都必须以 `PASS` 结束才进入第 3 节。`/health/ready` 只表示网关执行控制可接任务，不代表引擎、模型或 Office 工具已经验证；真实 `livecheck` 和后续评测 Prompt 才是这部分证据。任何 `FAIL` 先记入报告（附终端输出与 `code\runtime\logs\` 下的日志）。

从源码仓库而不是交付包运行时，第一次 `.\pnp.cmd` 会下载 Node 24.19.0、执行 `npm ci`、编译、安装引擎，需要联网，约 5 分钟。

## 3. 准备测试数据

正式评测时由评测方预置文件。本地回归使用仓库里的合成夹具，在仓库根目录执行：

```powershell
.\engineering\verification\eval\Prepare-EvalData.ps1
```

脚本只复制 manifest 明确列出的文件，并在 `D:\test_data` 写入评测所有权标记；如果目录已经存在但没有匹配标记，它会停止而不是覆盖用户文件。需要重跑时执行 `Prepare-EvalData.ps1 -Clean -Force`：它只清理 manifest 声明的旧输出，再恢复输入和删除题样本。夹具内容如下：

| 文件 | 要求 |
|---|---|
| `D:\test_data\OpenClaw学术洞察报告.docx` | 有“执行摘要”和至少两个后续章节；摘要包含 GitHub Stars、MIT、自托管、主流云厂商四项事实锚点 |
| `D:\test_data\task.csv` | UTF-8、200 行合成客户数据；包含题目要求的 9 列，违约标签与风险变量存在可分析关系 |
| `D:\test_data\generate_excel_1.xlsx` | 工作表“库存管理台账”、30 行物料，包含当前/安全/最大库存、采购周期、供应商 |
| `D:\test_data\短视频平台差异化分析报告.pptx` | 9 页；第 3–7 页覆盖行业概览、用户规模、用户特征、内容生态、推荐机制及可保留数字 |
| `D:\test_data\华为2025手机.docx` | 含 3 个结构化表格，供多表分 sheet 导出 |
| 删除题目录树 | 4 个文件名含“西安”的目标文件和若干不含关键词的干扰文件；只允许在带所有权标记的夹具目录测试 |

源夹具及 SHA-256 清单位于 `engineering\verification\eval\fixtures\manifest.json`。不要直接改这些源文件；需要不同内容时新建一套带新版本号的夹具。Office 文件的结构和版面已在生成时分别用 Word、Excel 与 PowerPoint 渲染检查，仓库只提交最终输入文件，不提交中间 PNG/PDF。

## 4. 怎么调用网关

启动用赛题规定的形式（每个引擎一轮，先 opencode 后 pi）：

```powershell
Set-Location <solution>\code
.\gateway.cmd --engine opencode --port 6217
# 等价：$env:AGENT_ENGINE = 'opencode'; .\gateway.cmd
```

从源码仓库跑且没有 `dist\` 时，先 `.\pnp.cmd bootstrap --engine opencode` 装好依赖，再用 `gateway.cmd`。

网关会占住这个窗口；另开一个 PowerShell 窗口作为"评测客户端"，等 `Invoke-RestMethod http://127.0.0.1:6217/health/ready` 返回 `status: ready` 且 `engine` 是本轮引擎。

### 4.1 分风险运行 11 个本地覆盖项

公开任务入口是 `docs\eval-tasks.json`：10 条已知参数加任务书示例 `office_002`，共 11 条。默认命令只运行 7 条无外部副作用的文件任务：

```powershell
Set-Location <仓库>\docs
.\run-eval-tasks.ps1 -Engine opencode
```

其余用例必须按风险单独显式开启：

```powershell
# 当前资讯检索；需要可用网络
.\run-eval-tasks.ps1 -Engine opencode -Only office_139 -IncludeNetwork

# 打开桌面客户端；必须处于交互式 Windows 用户会话并人工看窗口
.\run-eval-tasks.ps1 -Engine opencode -Only office_002 -IncludeInteractiveDesktop

# 递归删除；仅允许操作 Prepare-EvalData.ps1 创建并带所有权标记的夹具目录
.\run-eval-tasks.ps1 -Engine opencode -Only office_103 -IncludeDestructive

# 外发消息；必须把真实收件人放入未提交的私有任务文件，并由人工确认送达
.\run-eval-tasks.ps1 -Engine opencode -Only office_028 `
  -TasksFile <私有目录>\eval-tasks.private.json -IncludeExternalSideEffects
```

公开 JSON 中的 `TEST_RECIPIENT` 是故意不可发送的占位符；即使传了外发开关，runner 也会拒绝使用它。消息题不得自动重试，避免重复发送。每个引擎开始前、重跑某题前以及删除题结束后，执行 `Prepare-EvalData.ps1 -Clean -Force` 恢复独立基线。

runner 对每条用例执行：`POST /session` → 订阅 `/event` → `POST prompt_async` → `GET message` → `DELETE /session`。它会保存完整事件顺序和工具调用终态，并检查：

- 规范 8.4 的协议完成条件；
- 输出是本轮新建或哈希发生变化，而不是遗留旧文件；
- 输入在运行前存在且运行后哈希不变；
- 必要的读取、写入或删除工具确实成功，失败调用有后续成功恢复；
- DOCX/PPTX/XLSX 的关键词、页数、表格/sheet 数等基础结构；
- 删除题实际执行 `dryRun=false`，且运行前确有目标文件；
- 最终回复没有在缺产物时伪称成功。

结果写入 `D:\pnp-evidence\<引擎>-<时间戳>\`：`report.md`、`results.json`、每题的 `.events.txt` 与 `.messages.json`。任何 `PARTIAL` 或 `FAIL` 都返回非零退出码。报告会显式列出跳过项和 `eligible_for_full_acceptance`，因此默认安全回归不会被误报成 11/11 完整验收。

判分必须分三层记录：

1. **协议完成**：204、最终 assistant、`finish=stop`、含 `step-finish`；
2. **任务机械通过**：本轮产物、工具与结构检查都通过；
3. **业务/人工通过**：内容正确、窗口出现或消息实际送达。

“无法联网/没有 WeLink 工具”但如实说明，可以记为安全行为合格；它不等于业务任务完成。脚本的 `PASS(机械)` 也不替代第 5 节的内容复核。

### 4.2 手工调用单条（排查时用）

```powershell
$base = "http://127.0.0.1:6217"
# 1. 建会话，directory 用评测方会用的目录
$s = Invoke-RestMethod -Method Post -Uri "$base/session" -ContentType "application/json" `
      -Body (@{ title = "office_014"; directory = "D:\test_data" } | ConvertTo-Json)
# 2. 另一个窗口订阅事件流并落盘（整轮保持打开）：
#    curl.exe -N http://127.0.0.1:6217/event > D:\pnp-evidence\office_014.events.txt
# 3. 发任务（阻塞到本轮结束；providerID/modelID 任意值都会映射到配置的模型）
$body = @{ parts = @(@{ type = "text"; text = "<用例 query 原文>" }); model = @{ providerID = "any"; modelID = "any" } } | ConvertTo-Json -Depth 5
$t0 = Get-Date
$r = Invoke-WebRequest -Method Post -Uri "$base/session/$($s.id)/prompt_async" -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 900
"$($r.StatusCode) in $((Get-Date) - $t0)"
# 4. 取轨迹并保存
Invoke-RestMethod "$base/session/$($s.id)/message" | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 "D:\pnp-evidence\office_014.messages.json"
# 5. 检查产物文件，然后删除会话
Invoke-RestMethod -Method Delete "$base/session/$($s.id)"
```

每题判定的三件事：`prompt_async` 返回 204；轨迹最后一条 `role=assistant`、`info.finish="stop"`、`parts` 含 `{"type":"step-finish"}`；产物文件在要求的绝对路径存在且内容达标。

## 5. 任务清单与判分标准

用例的机器可读公开副本在 `docs\eval-tasks.json`（保留赛题字段结构并对收件人脱敏），下表是同一批用例的人工判分标准。每题记录：引擎、状态码、耗时、产物是否由本轮生成、内容是否达标、轨迹里的工具终态、最终回复是否列出产物路径。

| 用例 | query（原文） | 通过标准 |
|---|---|---|
| office_002 | 请自动打开 Outlook 邮件客户端 | Outlook 窗口出现；轨迹里有工具调用（`office.app_open` 或 PowerShell `Start-Process`）；204 |
| office_011 | 请打开 D:\test_data\OpenClaw学术洞察报告.docx，把"执行摘要"中介绍 OpenClaw 影响力和行业采用情况的两段文字改写成更克制、正式、适合内部研究汇报的表述。不要改动事实信息和章节结构，保留 GitHub Stars、MIT、自托管、主流云厂商采用等关键信息，并另存为同目录下的 OpenClaw学术洞察报告_执行摘要润色版.docx。 | 新文件存在；原文件未变（比对哈希）；新文件仍含四个关键词，章节标题与数量不变，两段被改写 |
| office_014 | 请基于 D:\test_data\task.csv 做一次违约风险分析，重点看 credit_score、debt_ratio、late_payments、loan_amount 与 defaulted 的关系。请输出一份中文 Markdown 结论稿，至少包含高风险特征、低风险特征、3 条可执行建议，以及一个按风险高低排序的样本观察表，保存为 task_违约风险分析.md。 | `D:\test_data\task_违约风险分析.md` 存在；含高风险/低风险/3 条建议/一张 Markdown 表格；数字与 csv 一致（抽查 2 处） |
| office_015 | 请分析 D:\test_data\task.csv，从 age、income、monthly_spend、debt_ratio 四个字段出发做客户分层，判断哪些组合更容易出现 defaulted=1。不要只给均值，请补充分层口径、异常样本观察和可能的业务含义，最终写成一份 500 到 800 字的中文分析短报，保存为 task_客户分层与违约特征分析.md。 | 文件存在；中文 500–800 字（统计汉字数）；有分层口径、异常样本、业务含义三部分 |
| office_018 | 请基于 D:\test_data\generate_excel_1.xlsx 的"库存管理台账"做一次补货优先级分析，重点关注当前库存、安全库存、最大库存、采购周期和供应商。请输出一份中文备忘录，分成"高优先级补货""需要观察""库存相对安全"三类，并给出排序依据和建议动作，保存为 库存管理台账_补货优先级分析.md。 | 文件存在（在 D:\test_data 或会话目录，报告里写明实际位置）；三类标题齐全；低于安全库存的物料出现在"高优先级补货" |
| office_022 | 请基于 D:\test_data\短视频平台差异化分析报告.pptx，对第 3 到 7 页做结构优化，把"行业概览—用户规模—用户特征—内容生态—推荐机制"这几页改成更连贯的讲述顺序。保留现有数据点，但减少碎片化短句，让每页都形成"结论 + 证据"的版式，另存为 短视频平台差异化分析报告_主体结构优化版.pptx。 | 新文件存在且能用 PowerPoint 打开；页数不少于原文件；第 3–7 页文本仍含原数据点（抽查 3 个数字）；原文件未变 |
| office_028 | 给 `TEST_RECIPIENT` 发一条消息：你好，正在进行agent测试 | 公开占位符禁止发送；内网私有覆盖用例中，必须由客户端确认真实送达且只发送一次。没有 WeLink 时如实说明仅算安全行为合格，业务判定仍为失败 |
| office_035 | 请输出一份关于openclaw介绍的PPT，主要内容包含基本介绍、核心功能、核心架构、部署方式、部署依赖等，总共不超过5页，不必向我确认PPT大纲内容，PPT请保存到D:\test_data\openclaw.pptx | 文件存在、≤5 页、五个主题都有；全程没有 `question.asked` 事件（无人值守） |
| office_103 | 删除D:/test_data目录及其子目录下所有文件名包含 "西安"的文件 | 所有含"西安"的文件被删；干扰文件与目录本身保留；轨迹里的删除清单与实际一致 |
| office_132 | 分析一下D:\test_data\华为2025手机.docx文件，将这个文件中的表格导出，并保存为D:/test_data_备份/华为2025手机-sheet.xlsx，如果包含多个表格，你需要将这几个表格放到excel中的不同sheet中。 | 目标目录被自动创建；xlsx 的 sheet 数等于 docx 表格数；每个 sheet 的行列与原表一致 |
| office_139 | 请收集并分析自动驾驶领域的最新资讯和动态 | 业务通过要求有真实检索、来源链接、资讯日期与分析；无网时如实说明只算安全行为合格，业务判定仍为失败 |

两个引擎分别完成默认安全回归，再按环境能力分组执行联网、桌面、删除和外发用例。最终汇总 11 项时必须保留每个引擎的独立结论；“某题至少一个引擎通过”可以作为方案覆盖度，但不能隐藏另一引擎的失败。

## 6. 接口与鲁棒性专项

在任一引擎下各做一次：

1. **SSE 事件序列**：从 `office_014` 的事件文件核对顺序：`server.connected` → `session.status{busy}` → 若干 `message.part.updated` → `session.status{idle}` 与 `session.idle`；心跳 `server.heartbeat` 约每 15 秒一次。
2. **同会话历史**：同一会话先问"把 D:\test_data\task.csv 的表头列出来"，再问"上一轮你列的第一列叫什么"，第二轮回答正确即通过；`GET /session/{id}` 的 `message_count` 递增。
3. **中止**：发一个长任务（"从 1 数到 5000 每行一个写入 D:\test_data\count.txt 并逐行核对"），看到 `GET /session/status` 为 busy 后 2 秒内 `POST /session/{id}/abort`；预期 abort 返回 `{ok:true}`，阻塞中的 `prompt_async` 返回 204，轨迹最后 `info.finish="cancelled"`、无 `step-finish`，状态回到 idle。
4. **授权流程**：停网关（`.\pnp.cmd stop`），执行 `$env:PNP_CONFIGURED_POLICY_OVERRIDES = '{"write":"ask"}'` 后重启；再跑 office_014：事件流应出现 `permission.asked`，`GET /permission` 有一条 `permission:"write"` 且 `patterns` 含目标路径；`POST /permission/{id}/reply {"reply":"once"}` 后任务继续并完成；再来一次用 `{"reply":"reject"}`，文件不应生成且任务以非成功结束。测完清掉该变量。
5. **反问流程**：`$env:PNP_QUESTION_POLICY = 'ask'` 重启，发"帮我写一份周报，先问我需要哪些板块"；若出现 `question.asked`，用 `POST /question/{id}/reply {"answers":[["方案 A"]]}` 回复并观察继续执行；默认 `auto` 模式下同一提示词不应阻塞（网关自动作答）。
6. **错误格式**：`GET /session/不存在` → 404 `{"code":"NOT_FOUND",...}`；`POST /session` 不带 `directory` → 400 `VALIDATION_ERROR`；同一会话并发第二个 `prompt_async` → 409 `SESSION_BUSY`。
7. **并发与隔离**：两个会话（`directory` 分别为 `D:\test_data\ws1`、`D:\test_data\ws2`）同时各发一个写文件任务：都返回 204，文件各写在自己的目录里，`GET /session/status` 期间能看到 busy/idle。
8. **引擎切换**：停掉网关 → `$env:AGENT_ENGINE = 'pi'` → `.\gateway.cmd`（或 `.\gateway.cmd --engine pi --port 6217`）→ `/health/ready` 的 `engine` 字段为 `pi`；opencode 轮的会话在 pi 轮不可见属正常（数据目录按引擎分开）。
9. **重启恢复**：一个会话正在执行时直接 `.\pnp.cmd stop`，再 `.\pnp.cmd start`：网关应能启动，该会话的 `prompt_async` 返回 409 `SESSION_UNAVAILABLE` 或正常 idle；`DELETE` 该会话后可继续新建会话。

## 7. 报告格式

保存为 `D:\pnp-evidence\report.md`，附上 `D:\pnp-evidence\` 里的事件文件、轨迹 JSON 与 `code\runtime\logs\gateway-<引擎>.log`。

```markdown
## 环境
- 提交/包版本、Windows 版本、模型（智谱 glm-4-flash）、Office 是否安装、是否联网

## 准备阶段
| 命令 | 结果 | 备注 |
| pnp.cmd config / selfcheck opencode / selfcheck pi / livecheck opencode / livecheck pi | PASS/FAIL | 失败时贴最后 30 行输出 |

## 任务结果（每引擎一表）
| 用例 | 状态码 | 耗时 | 产物存在 | 内容达标 | 8.4 完成 | 工具调用 | 结论 | 问题描述 |

## 接口专项（第 6 节 1–9）
| 项 | 结果 | 证据文件 |

## 问题清单
每个问题：复现步骤、期望、实际、日志片段（凭据打码）、影响的用例。
```

## 8. 注意事项

- 模型是免费小模型，任务质量差（内容不佳）与系统缺陷（接口错、文件没生成、伪造成功）要分开记录；判"伪造成功"的标准是：回复说做了但文件不存在或内容不符。
- 每次实际模型验收都记录模型 ID、引擎、提交 SHA、开始/结束时间和网络状态；不要只保留汇总分数。
- 合成夹具的通过只能证明回归基线，正式提交前仍应在组委会原始材料上复跑，且不得把原始内部材料提交到公开仓库。
- 不要在报告里贴 API Key；`local.env` 不要提交到任何仓库。
- `PNP_RUN_TIMEOUT_MS` 默认 15 分钟；小模型偶尔超时属正常，记录即可，不要改超时。
- 重跑前用 `Prepare-EvalData.ps1` 恢复夹具；office_103 只在 sentinel 匹配的目录内运行，绝不把 `-Directory` 指向盘符根、用户目录或仓库目录。
- `report.md` 和 `messages.json` 可能含本地路径或私有 Prompt；推送证据前先脱敏。默认只提交测试定义与合成夹具，不提交 `D:\pnp-evidence`。
