# PNP 公开合成评测夹具

本目录提供一套可公开、可重复准备的办公评测输入，用于运行仓库中的已知评测用例。它们是为本地回归专门制作的**合成材料**，不是组委会原始文件，也不代表真实公司、客户、员工或业务数据。

## 包含内容

`fixtures/manifest.json` 是唯一的文件管理白名单和哈希清单。当前夹具包括：

| 输入 | 结构 | 覆盖用例 |
|---|---|---|
| `OpenClaw学术洞察报告.docx` | 含“执行摘要”和约束要求的关键词 | `office_011` |
| `task.csv` | 200 行合成客户记录，违约标签与风险字段有关联 | `office_014`、`office_015` |
| `generate_excel_1.xlsx` | “库存管理台账”，含低于安全库存的物料 | `office_018` |
| `短视频平台差异化分析报告.pptx` | 9 页，第 3–7 页为指定主题并含数字证据 | `office_022` |
| `华为2025手机.docx` | 3 张结构化表格 | `office_132` |

删除题另有 4 个文件名包含“西安”的目标文件，分布在根目录、一级和二级子目录；还有 4 个必须保留的干扰文件。其中 `西安/保留_成都.txt` 专门验证实现只匹配**文件名**，不会因为父目录名命中而误删文件。

Office 文件已经做过打开与视觉检查。每个仓库源文件的 SHA-256 都固定在 manifest 中，准备脚本会在复制前后校验。

## 安全模型

默认评测位置是 `D:\test_data` 和 `D:\test_data_备份`。准备脚本遵守以下边界：

1. 一个新目录，或一个确实为空的目录，可以初始化为评测目录。
2. 已有且非空的目录必须在根下包含 `.pnp-evaluation-fixture.json`，其中至少要有 `owner: "PNP_EVALUATION_FIXTURE"`，并且夹具 ID、根角色和规范化绝对路径都要匹配。
3. 缺少、损坏或不匹配的 sentinel 会立即终止。`-Force` 也不能绕过所有权校验。
4. 脚本只复制 `manifest.inputs`，只清理 `manifest.outputs`。未知文件和目录永远不处理。
5. 脚本不递归清空任何目录，也不删除目录。链接和 junction 不能出现在受管文件路径中。
6. `-Force` 只用于把**已有匹配 sentinel** 的受管输入恢复到 manifest 哈希；它不表示接管任意目录。
7. `-Clean` 只删除 manifest 明列的预期输出，然后补齐并校验所有输入。这也是在两道题或两个引擎之间恢复夹具的推荐方式。

若机器上的 `D:\test_data` 已存有个人或业务文件，不要移动、改名或删除它来迁就脚本；请改用专用测试机，或先用自定义临时根验证夹具。由于已知用例的 query 写死了 `D:\test_data`，自定义根只适合测试本准备脚本，不能等价替代最终端到端评测。

## 准备与恢复

在仓库根目录的 PowerShell 中运行：

```powershell
# 先看将发生什么
.\engineering\verification\eval\Prepare-EvalData.ps1 -WhatIf

# 首次准备；若默认目录非空且不受本夹具管理，会安全失败
.\engineering\verification\eval\Prepare-EvalData.ps1

# 每题或每个引擎开始前：清掉已知输出，并恢复被删除/改动的合成输入
.\engineering\verification\eval\Prepare-EvalData.ps1 -Clean -Force
```

用临时目录检查准备逻辑：

```powershell
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("pnp-eval-" + [guid]::NewGuid().ToString("N"))
.\engineering\verification\eval\Prepare-EvalData.ps1 `
  -TestDataRoot (Join-Path $scratch "test_data") `
  -BackupRoot (Join-Path $scratch "test_data_backup") `
  -Clean -Force
```

脚本不会自动删除 `$scratch`；确认路径后由测试者自行清理。

## 运行评测

1. 在 `engineering/code` 下运行 `./pnp.cmd config`，把模型 endpoint、模型 ID 和 API Key 写入本地配置。不要把 Key 放入命令记录、报告或 Git。
2. 分别对 `opencode` 和 `pi` 运行 `selfcheck` 与真实模型 `livecheck`。
3. 启动本轮引擎的网关，再按 [`docs/local-verification-plan.md`](../../../docs/local-verification-plan.md) 调用 [`docs/run-eval-tasks.ps1`](../../../docs/run-eval-tasks.ps1)。
4. 每道会产生文件或删除副作用的题开始前运行 `Prepare-EvalData.ps1 -Clean -Force`，避免旧产物造成假阳性。
5. 把 HTTP/完成规则、真实产物、内容质量和安全行为分别判定；模型自称完成不能替代产物检查。

`office_103` 只能针对本脚本拥有的夹具根运行。manifest 的 `deleteCase.minimumBefore` 要求运行前至少有 4 个目标文件。`office_002` 会操作交互式桌面；`office_028` 会产生不可撤销的外部消息副作用，它不需要也不包含在本夹具中。公开用例应使用 `TEST_RECIPIENT`，真实收件人只能从不入库的私有配置提供，且必须显式授权、禁止盲目重试。

## 交付包边界

本目录刻意放在 `engineering/verification/eval/`，不在交付代码目录中。`engineering/code/scripts/package-release.mjs` 使用允许列表，仅复制交付所需的 `engineering/code` 内容和 `engineering/INSTRUCTION.md`，因此这些测试材料不会进入默认 `solution.zip`。

不要把本目录移动到 `engineering/code/assets`、`engineering/code/scripts` 或 `engineering/code/tests`：前两者始终随包复制，后者在 `--include-tests` 时会被复制。生成过程中的页面预览、PDF、日志和运行证据也不应提交；它们应保留在仓库外的证据目录。
