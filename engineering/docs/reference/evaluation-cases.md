# 已提供评测用例核对表

此处为用户提供的10条参数的工程核对表，不是完整或隐藏评测集。文件材料不包含在交付包中。真实人员标识使用 `TEST_RECIPIENT`，实际收件人由内网私有数据提供。

| ID | 输入/目标 | 指令约束与输出 |
|---|---|---|
| office_011 | `D:\test_data\OpenClaw学术洞察报告.docx` | 执行摘要中影响力/行业采用的两段正式润色；保留事实和章节，保留GitHub Stars、MIT、自托管、主流云厂商采用；同目录另存 `OpenClaw学术洞察报告_执行摘要润色版.docx` |
| office_014 | `D:\test_data\task.csv` | 分析credit_score/debt_ratio/late_payments/loan_amount与defaulted；中文Markdown含高低风险特征、3条建议、按风险排序的样本表；`task_违约风险分析.md` |
| office_015 | 同一task.csv | age/income/monthly_spend/debt_ratio客户分层，不仅均值，说明分层、组合、异常样本和业务含义；500—800字；`task_客户分层与违约特征分析.md` |
| office_018 | `D:\test_data\generate_excel_1.xlsx` 的“库存管理台账” | 当前/安全/最大库存、采购周期、供应商；三档补货优先级、依据与动作；`库存管理台账_补货优先级分析.md` |
| office_022 | `D:\test_data\短视频平台差异化分析报告.pptx` | 第3—7页优化讲述顺序；保留数据、减少碎句、结论+证据；`短视频平台差异化分析报告_主体结构优化版.pptx` |
| office_028 | WeLink指定收件人 `TEST_RECIPIENT` | 发送“你好，正在进行agent测试”；验证对象和一次性提交，不盲目重发 |
| office_035 | 关于OpenClaw的资料 | 介绍、功能、架构、部署方式/依赖，不超过5页、不确认大纲；`D:\test_data\openclaw.pptx` |
| office_103 | `D:/test_data` 及子目录 | 删除文件名包含“西安”的文件；不扩展为删除目录或按完整路径匹配 |
| office_132 | `D:\test_data\华为2025手机.docx` | 全部表格导出为不同sheet，输出 `D:/test_data_备份/华为2025手机-sheet.xlsx` |
| office_139 | 自动驾驶领域最新资讯 | 运行时检索、筛选日期来源并综合分析；未指定文件输出 |

题目数据还包含 task_id/title/description/query/category/secondary_category/difficulty/difficulty_label；网关 Prompt 协议不要求这些分类字段。系统根据 query 通用执行，不按 task_id 写专用逻辑。

未明确输出绝对路径时，PNP 以 Session 工作目录解析。原文“同目录”或绝对输出路径优先。文件产物、外部副作用和最终回答分别验收，不能以 LLM 自称完成替代真实环境检查。
