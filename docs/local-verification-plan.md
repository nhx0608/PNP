# 本地验证方案：按赛题要求在 Windows 上测 PNP 网关

给执行验证的 Agent/同事：本文是完整的操作与判分依据，按顺序做，把第 7 节的报告填好交回。全程不需要改代码；遇到失败按第 7 节记录证据，不要自行绕过。

## 1. 目标

1. 证明网关按《Agent 网关接口规范》v1.1 工作：会话、`prompt_async`、SSE 事件、消息轨迹与 8.4 完成规则、中止、反问/授权接口、错误格式、`AGENT_ENGINE` 切换。
2. 证明两个引擎（`opencode`、`pi`）都能完成赛题样例里那类办公任务，产物落在指定绝对路径。
3. 找出失败并留证据：哪一步、什么现象、日志在哪。

## 2. 环境准备（约 10 分钟）

前提：Windows 10/11 x64；能访问智谱开放平台（测试模型用智谱免费档 `glm-4-flash`，需要一个 API Key）；Office 已安装（部分任务要开 Outlook）。不需要 Python、Git Bash、管理员权限。

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

四条命令都必须以 `PASS` 结束才进入第 3 节。任何 `FAIL` 先记入报告（附终端输出与 `code\runtime\logs\` 下的日志）。

从源码仓库而不是交付包运行时，第一次 `.\pnp.cmd` 会下载 Node 24.19.0、执行 `npm ci`、编译、安装引擎，需要联网，约 5 分钟。

## 3. 准备测试数据

评测方会把文件预置在 `D:\test_data`。本地按下面清单自己生成（可以用 Node 脚本配合 `code\node_modules` 里已有的 `docx`、`exceljs`、`pptxgenjs` 库，也可以用 Office 手工做；内容不必逼真，但字段与结构必须齐）：

| 文件 | 要求 |
|---|---|
| `D:\test_data\OpenClaw学术洞察报告.docx` | 有标题"执行摘要"的章节，其下至少两段介绍 OpenClaw 影响力与行业采用情况的文字，段落里出现 "GitHub Stars"、"MIT"、"自托管"、"主流云厂商" 四个词；后面再放两个其他章节 |
| `D:\test_data\task.csv` | UTF-8，表头 `customer_id,age,income,monthly_spend,credit_score,debt_ratio,late_payments,loan_amount,defaulted`，200 行左右随机数据，`defaulted` 为 0/1，让低 credit_score、高 debt_ratio、多 late_payments 的行更多为 1 |
| `D:\test_data\generate_excel_1.xlsx` | 工作表名 `库存管理台账`，列 `物料编码,物料名称,当前库存,安全库存,最大库存,采购周期(天),供应商`，30 行左右，其中若干行当前库存低于安全库存 |
| `D:\test_data\短视频平台差异化分析报告.pptx` | 至少 9 页；第 3–7 页标题依次为 行业概览、用户规模、用户特征、内容生态、推荐机制，每页有 3–5 条含数字的短句 |
| `D:\test_data\华为2025手机.docx` | 正文里有 2–3 个表格（例如机型参数表、价格表），每表 4 列 5 行以上 |
| `D:\test_data\西安\...`、`D:\test_data\报告_西安分公司.txt`、`D:\test_data\子目录\西安2025.docx` 等 | 至少 4 个文件名含"西安"的文件分布在两级子目录，另放 3 个不含"西安"的干扰文件 |

准备好后**先复制一份**到 `D:\test_data_原始备份\`，每轮引擎测试前把 `D:\test_data` 恢复成原始状态。

## 4. 怎么调用网关

启动（每个引擎一轮，先 opencode 后 pi）：

```powershell
Set-Location <solution>\code
$env:AGENT_ENGINE = 'opencode'
.\pnp.cmd start
```

网关会占住这个窗口；另开一个 PowerShell 窗口作为"评测客户端"，等 `Invoke-RestMethod http://127.0.0.1:6217/health/ready` 返回 `status: ready`。

每个任务的标准流程（PowerShell）：

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

每题记录：引擎、状态码、耗时、产物是否存在、内容是否达标、轨迹里调用了哪些工具、最终回复是否列出了产物路径。用例 query 原文如下（不要改写）。

| 用例 | query（原文） | 通过标准 |
|---|---|---|
| office_002 | 请自动打开 Outlook 邮件客户端 | Outlook 窗口出现；轨迹里有工具调用（`office.app_open` 或 PowerShell `Start-Process`）；204 |
| office_011 | 请打开 D:\test_data\OpenClaw学术洞察报告.docx，把"执行摘要"中介绍 OpenClaw 影响力和行业采用情况的两段文字改写成更克制、正式、适合内部研究汇报的表述。不要改动事实信息和章节结构，保留 GitHub Stars、MIT、自托管、主流云厂商采用等关键信息，并另存为同目录下的 OpenClaw学术洞察报告_执行摘要润色版.docx。 | 新文件存在；原文件未变（比对哈希）；新文件仍含四个关键词，章节标题与数量不变，两段被改写 |
| office_014 | 请基于 D:\test_data\task.csv 做一次违约风险分析，重点看 credit_score、debt_ratio、late_payments、loan_amount 与 defaulted 的关系。请输出一份中文 Markdown 结论稿，至少包含高风险特征、低风险特征、3 条可执行建议，以及一个按风险高低排序的样本观察表，保存为 task_违约风险分析.md。 | `D:\test_data\task_违约风险分析.md` 存在；含高风险/低风险/3 条建议/一张 Markdown 表格；数字与 csv 一致（抽查 2 处） |
| office_015 | 请分析 D:\test_data\task.csv，从 age、income、monthly_spend、debt_ratio 四个字段出发做客户分层，判断哪些组合更容易出现 defaulted=1。不要只给均值，请补充分层口径、异常样本观察和可能的业务含义，最终写成一份 500 到 800 字的中文分析短报，保存为 task_客户分层与违约特征分析.md。 | 文件存在；中文 500–800 字（统计汉字数）；有分层口径、异常样本、业务含义三部分 |
| office_018 | 请基于 D:\test_data\generate_excel_1.xlsx 的"库存管理台账"做一次补货优先级分析，重点关注当前库存、安全库存、最大库存、采购周期和供应商。请输出一份中文备忘录，分成"高优先级补货""需要观察""库存相对安全"三类，并给出排序依据和建议动作，保存为 库存管理台账_补货优先级分析.md。 | 文件存在（在 D:\test_data 或会话目录，报告里写明实际位置）；三类标题齐全；低于安全库存的物料出现在"高优先级补货" |
| office_022 | 请基于 D:\test_data\短视频平台差异化分析报告.pptx，对第 3 到 7 页做结构优化，把"行业概览—用户规模—用户特征—内容生态—推荐机制"这几页改成更连贯的讲述顺序。保留现有数据点，但减少碎片化短句，让每页都形成"结论 + 证据"的版式，另存为 短视频平台差异化分析报告_主体结构优化版.pptx。 | 新文件存在且能用 PowerPoint 打开；页数不少于原文件；第 3–7 页文本仍含原数据点（抽查 3 个数字）；原文件未变 |
| office_028 | 给y00942037发一条消息：你好，正在进行agent测试 | 本地没有 WeLink 工具：预期最终回复明确说明没有可用的消息发送工具、没有伪造"已发送"；204 且 finish=stop 即通过（记录为"能力缺失但行为诚实"） |
| office_035 | 请输出一份关于openclaw介绍的PPT，主要内容包含基本介绍、核心功能、核心架构、部署方式、部署依赖等，总共不超过5页，不必向我确认PPT大纲内容，PPT请保存到D:\test_data\openclaw.pptx | 文件存在、≤5 页、五个主题都有；全程没有 `question.asked` 事件（无人值守） |
| office_103 | 删除D:/test_data目录及其子目录下所有文件名包含 "西安"的文件 | 所有含"西安"的文件被删；干扰文件与目录本身保留；轨迹里的删除清单与实际一致 |
| office_132 | 分析一下D:\test_data\华为2025手机.docx文件，将这个文件中的表格导出，并保存为D:/test_data_备份/华为2025手机-sheet.xlsx，如果包含多个表格，你需要将这几个表格放到excel中的不同sheet中。 | 目标目录被自动创建；xlsx 的 sheet 数等于 docx 表格数；每个 sheet 的行列与原表一致 |
| office_139 | 请收集并分析自动驾驶领域的最新资讯和动态 | 有网时：回复含来源链接与分析；无网时：最终回复如实说明无法联网，不编造新闻。两种都算通过，记录属于哪种 |

两个引擎各跑一遍全部 11 题。同一题两引擎至少一个通过即达标（评测按题取最高分）。

## 6. 接口与鲁棒性专项

在任一引擎下各做一次：

1. **SSE 事件序列**：从 `office_014` 的事件文件核对顺序：`server.connected` → `session.status{busy}` → 若干 `message.part.updated` → `session.status{idle}` 与 `session.idle`；心跳 `server.heartbeat` 约每 15 秒一次。
2. **同会话历史**：同一会话先问"把 D:\test_data\task.csv 的表头列出来"，再问"上一轮你列的第一列叫什么"，第二轮回答正确即通过；`GET /session/{id}` 的 `message_count` 递增。
3. **中止**：发一个长任务（"从 1 数到 5000 每行一个写入 D:\test_data\count.txt 并逐行核对"），看到 `GET /session/status` 为 busy 后 2 秒内 `POST /session/{id}/abort`；预期 abort 返回 `{ok:true}`，阻塞中的 `prompt_async` 返回 204，轨迹最后 `info.finish="cancelled"`、无 `step-finish`，状态回到 idle。
4. **授权流程**：停网关（`.\pnp.cmd stop`），执行 `$env:PNP_CONFIGURED_POLICY_OVERRIDES = '{"write":"ask"}'` 后重启；再跑 office_014：事件流应出现 `permission.asked`，`GET /permission` 有一条 `permission:"write"` 且 `patterns` 含目标路径；`POST /permission/{id}/reply {"reply":"once"}` 后任务继续并完成；再来一次用 `{"reply":"reject"}`，文件不应生成且任务以非成功结束。测完清掉该变量。
5. **反问流程**：`$env:PNP_QUESTION_POLICY = 'ask'` 重启，发"帮我写一份周报，先问我需要哪些板块"；若出现 `question.asked`，用 `POST /question/{id}/reply {"answers":[["方案 A"]]}` 回复并观察继续执行；默认 `auto` 模式下同一提示词不应阻塞（网关自动作答）。
6. **错误格式**：`GET /session/不存在` → 404 `{"code":"NOT_FOUND",...}`；`POST /session` 不带 `directory` → 400 `VALIDATION_ERROR`；同一会话并发第二个 `prompt_async` → 409 `SESSION_BUSY`。
7. **并发与隔离**：两个会话（`directory` 分别为 `D:\test_data\ws1`、`D:\test_data\ws2`）同时各发一个写文件任务：都返回 204，文件各写在自己的目录里，`GET /session/status` 期间能看到 busy/idle。
8. **引擎切换**：`.\pnp.cmd stop` → `$env:AGENT_ENGINE = 'pi'` → `.\pnp.cmd start` → `/health/ready` 的 `engine` 字段为 `pi`；opencode 轮的会话在 pi 轮不可见属正常（数据目录按引擎分开）。
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
- 不要在报告里贴 API Key；`local.env` 不要提交到任何仓库。
- `PNP_RUN_TIMEOUT_MS` 默认 15 分钟；小模型偶尔超时属正常，记录即可，不要改超时。
- 每题跑完恢复 `D:\test_data`，尤其是 office_103（删除）之后。
