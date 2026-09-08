<#
.SYNOPSIS
  按赛题给定的用例 JSON 驱动 PNP 网关跑一遍评测任务，逐条留证据并做机械判定。

.DESCRIPTION
  输入就是赛题格式的用例文件（docs\eval-tasks.json，字段 task_id/title/description/query/
  category/secondary_category/difficulty/difficulty_label）。每条用例走一遍规范定义的调用序列：
  POST /session -> GET /event(SSE) -> POST prompt_async -> GET message -> DELETE /session，
  然后核对规范 8.4 的完成规则和 docs\eval-expectations.json 里的产物。

  本脚本只做“机械可判”的部分（状态码、完成规则、事件序列、产物文件是否生成、输入文件是否被改动）。
  内容质量（改写是否更正式、分析是否站得住）仍由人或裁判模型按 docs\local-verification-plan.md
  第 5 节判定，脚本会把每条的 manual 提示原样写进报告，方便逐条填。

  运行前先启动网关（另一个窗口）：
      .\gateway.cmd --engine opencode --port 6217

.EXAMPLE
  .\run-eval-tasks.ps1 -Engine opencode
.EXAMPLE
  .\run-eval-tasks.ps1 -Engine pi -Only office_014,office_103 -Evidence D:\pnp-evidence
#>
[CmdletBinding()]
param(
  # 只用于给证据目录和报告命名；网关实际用的引擎由启动时的 --engine/AGENT_ENGINE 决定，
  # 脚本会从 /health/ready 读回真实引擎并在不一致时拒绝运行。
  [Parameter(Mandatory = $true)][ValidateSet('opencode', 'pi')][string]$Engine,
  [string]$Base = 'http://127.0.0.1:6217',
  [string]$TasksFile = "$PSScriptRoot\eval-tasks.json",
  [string]$ExpectationsFile = "$PSScriptRoot\eval-expectations.json",
  [string]$Directory = 'D:\test_data',
  [string]$Evidence = 'D:\pnp-evidence',
  [string[]]$Only = @(),
  [int]$PromptTimeoutSec = 900
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$runRoot = Join-Path $Evidence "$Engine-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null

function Write-Line([string]$Text) { Write-Host $Text }

function Invoke-Json {
  param([string]$Method, [string]$Uri, $Body, [int]$TimeoutSec = 60)
  $arguments = @{ Method = $Method; Uri = $Uri; TimeoutSec = $TimeoutSec; UseBasicParsing = $true }
  if ($null -ne $Body) {
    # UTF-8 字节而不是字符串：任务文本和文件名都是中文，交给 PowerShell 自己编码会变成乱码。
    $json = $Body | ConvertTo-Json -Depth 8 -Compress
    $arguments['Body'] = [System.Text.Encoding]::UTF8.GetBytes($json)
    $arguments['ContentType'] = 'application/json; charset=utf-8'
  }
  try {
    $response = Invoke-WebRequest @arguments
    $content = ''
    if ($response.Content) { $content = [string]$response.Content }
    $parsed = $null
    if ($content.Trim().Length -gt 0) { $parsed = $content | ConvertFrom-Json }
    return [pscustomobject]@{ Status = [int]$response.StatusCode; Body = $parsed; Raw = $content; Error = $null }
  } catch {
    $status = 0
    $raw = ''
    $exception = $_.Exception
    if ($exception.PSObject.Properties['Response'] -and $exception.Response) {
      $status = [int]$exception.Response.StatusCode
      try {
        $reader = New-Object System.IO.StreamReader($exception.Response.GetResponseStream())
        $raw = $reader.ReadToEnd()
        $reader.Close()
      } catch { $raw = '' }
    }
    $parsed = $null
    if ($raw.Trim().Length -gt 0) { try { $parsed = $raw | ConvertFrom-Json } catch { $parsed = $null } }
    return [pscustomobject]@{ Status = $status; Body = $parsed; Raw = $raw; Error = $exception.Message }
  }
}

function Get-Sha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

# --- 就绪与引擎确认 -------------------------------------------------------------
$ready = Invoke-Json -Method 'GET' -Uri "$Base/health/ready" -Body $null -TimeoutSec 15
if ($ready.Status -ne 200) {
  throw "网关未就绪（$Base/health/ready 返回 $($ready.Status)）。先在另一个窗口执行 .\gateway.cmd --engine $Engine --port 6217"
}
$runningEngine = [string]$ready.Body.engine
if ($runningEngine -ne $Engine) {
  throw "网关跑的是 '$runningEngine'，但本次要测 '$Engine'。停掉网关后用 --engine $Engine 重启。"
}
Write-Line "[eval] 网关就绪，引擎 = $runningEngine，证据目录 = $runRoot"

# --- 读入赛题用例 ---------------------------------------------------------------
$tasks = (Get-Content -LiteralPath $TasksFile -Raw -Encoding UTF8 | ConvertFrom-Json).tasks
$expectations = Get-Content -LiteralPath $ExpectationsFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Only.Count -gt 0) { $tasks = @($tasks | Where-Object { $Only -contains $_.task_id }) }
if ($tasks.Count -eq 0) { throw "没有要跑的用例（检查 -Only 里的 task_id）。" }
Write-Line "[eval] 用例 $($tasks.Count) 条，工作目录 $Directory"

$results = @()

foreach ($task in $tasks) {
  $id = [string]$task.task_id
  Write-Line ''
  Write-Line "=== $id  $($task.title)  (难度 $($task.difficulty)/$($task.difficulty_label)) ==="

  $expectation = $null
  if ($expectations.PSObject.Properties[$id]) { $expectation = $expectations.$id }

  # 运行前记录必须保持不变的输入文件的哈希
  $before = @{}
  if ($null -ne $expectation -and $expectation.PSObject.Properties['unchanged']) {
    foreach ($file in $expectation.unchanged) { $before[$file] = Get-Sha256 $file }
  }

  $result = [ordered]@{
    task_id = $id; title = $task.title; engine = $Engine
    session_id = $null; prompt_status = $null; duration_s = $null
    completion_rule = $null; outputs_created = @(); outputs_missing = @()
    inputs_modified = @(); contains_missing = @(); leftovers = @()
    events = @(); tools = @(); final_text = ''; manual = ''
    verdict = 'FAIL'; note = ''
  }
  if ($null -ne $expectation -and $expectation.PSObject.Properties['manual']) { $result.manual = [string]$expectation.manual }

  $eventsFile = Join-Path $runRoot "$id.events.txt"
  $sse = $null
  try {
    # 1. 建会话
    $session = Invoke-Json -Method 'POST' -Uri "$Base/session" -Body @{ title = $id; directory = $Directory }
    if ($session.Status -ne 200) { throw "POST /session 返回 $($session.Status)：$($session.Raw)" }
    $sessionId = [string]$session.Body.id
    $result.session_id = $sessionId

    # 2. 订阅事件流（curl.exe 是 Windows 10+ 自带的；-N 关闭缓冲）
    $sse = Start-Process -FilePath 'curl.exe' -ArgumentList @('-sN', "$Base/event") `
      -RedirectStandardOutput $eventsFile -NoNewWindow -PassThru
    Start-Sleep -Milliseconds 500

    # 3. 发任务：赛题定义的请求体，query 原样，model 任意取值都会映射到网关配置的模型
    $body = @{
      parts = @(@{ type = 'text'; text = [string]$task.query })
      model = @{ providerID = 'evaluator'; modelID = 'default' }
      agent = 'assistant'
    }
    $started = Get-Date
    $prompt = Invoke-Json -Method 'POST' -Uri "$Base/session/$sessionId/prompt_async" -Body $body -TimeoutSec $PromptTimeoutSec
    $result.duration_s = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    $result.prompt_status = $prompt.Status
    Write-Line "    prompt_async -> $($prompt.Status)，耗时 $($result.duration_s)s"

    # 4. 取轨迹
    $messages = Invoke-Json -Method 'GET' -Uri "$Base/session/$sessionId/message" -Body $null -TimeoutSec 60
    if ($messages.Status -eq 200) {
      $messages.Body | ConvertTo-Json -Depth 25 | Set-Content -LiteralPath (Join-Path $runRoot "$id.messages.json") -Encoding UTF8
      $last = @($messages.Body)[-1]
      $finish = ''
      if ($null -ne $last -and $last.PSObject.Properties['info'] -and $null -ne $last.info) { $finish = [string]$last.info.finish }
      $hasStepFinish = $false
      if ($null -ne $last -and $last.PSObject.Properties['parts'] -and $null -ne $last.parts) {
        $hasStepFinish = @($last.parts | Where-Object { $_.type -eq 'step-finish' }).Count -gt 0
      }
      $isAssistant = ($null -ne $last -and [string]$last.role -eq 'assistant')
      $result.completion_rule = "role=$(if ($isAssistant) { 'assistant' } else { [string]$last.role }); finish=$finish; step-finish=$hasStepFinish"
      if ($isAssistant -and $null -ne $last.PSObject.Properties['content']) { $result.final_text = [string]$last.content }
      $result.tools = @($messages.Body | Where-Object { $_.role -eq 'tool' } | ForEach-Object { [string]$_.tool_name } | Select-Object -Unique)
    }

    # 5. 清理会话（产物文件不受影响）
    $null = Invoke-Json -Method 'DELETE' -Uri "$Base/session/$sessionId" -Body $null -TimeoutSec 60
  } catch {
    $result.note = $_.Exception.Message
    Write-Line "    异常：$($result.note)"
  } finally {
    if ($null -ne $sse) { try { Stop-Process -Id $sse.Id -Force -ErrorAction SilentlyContinue } catch { } }
  }

  # --- 机械判定 ---------------------------------------------------------------
  if (Test-Path -LiteralPath $eventsFile) {
    $seen = @()
    foreach ($line in (Get-Content -LiteralPath $eventsFile -Encoding UTF8 -ErrorAction SilentlyContinue)) {
      if ($line -match '^data:\s*(\{.*\})\s*$') {
        try { $seen += [string](($matches[1] | ConvertFrom-Json).type) } catch { }
      }
    }
    $result.events = @($seen | Select-Object -Unique)
  }

  if ($null -ne $expectation) {
    if ($expectation.PSObject.Properties['outputs']) {
      foreach ($file in $expectation.outputs) {
        if (Test-Path -LiteralPath $file -PathType Leaf) { $result.outputs_created += $file } else { $result.outputs_missing += $file }
      }
    }
    if ($expectation.PSObject.Properties['unchanged']) {
      foreach ($file in $expectation.unchanged) {
        if ($before[$file] -ne (Get-Sha256 $file)) { $result.inputs_modified += $file }
      }
    }
    if ($expectation.PSObject.Properties['contains']) {
      foreach ($property in $expectation.contains.PSObject.Properties) {
        $file = $property.Name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        $text = Get-Content -LiteralPath $file -Raw -Encoding UTF8
        foreach ($needle in $property.Value) {
          if ($text -notlike "*$needle*") { $result.contains_missing += "$file :: $needle" }
        }
      }
    }
    if ($expectation.PSObject.Properties['absentGlob']) {
      $root = [string]$expectation.absentGlob.root
      $needle = [string]$expectation.absentGlob.nameContains
      if (Test-Path -LiteralPath $root) {
        $result.leftovers = @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -like "*$needle*" } | ForEach-Object { $_.FullName })
      }
    }
  }

  $completed = ($result.prompt_status -eq 204) -and ($result.completion_rule -like '*finish=stop*') -and ($result.completion_rule -like '*step-finish=True*')
  $clean = ($result.outputs_missing.Count -eq 0) -and ($result.inputs_modified.Count -eq 0) -and
           ($result.contains_missing.Count -eq 0) -and ($result.leftovers.Count -eq 0)
  if ($completed -and $clean) { $result.verdict = 'PASS(机械)' } elseif ($completed) { $result.verdict = 'PARTIAL' } else { $result.verdict = 'FAIL' }
  Write-Line "    判定 $($result.verdict)：$($result.completion_rule)"
  if ($result.outputs_missing.Count -gt 0) { Write-Line "    缺产物：$($result.outputs_missing -join ', ')" }
  if ($result.inputs_modified.Count -gt 0) { Write-Line "    输入被改动：$($result.inputs_modified -join ', ')" }
  if ($result.leftovers.Count -gt 0) { Write-Line "    应删未删：$($result.leftovers -join ', ')" }

  $results += [pscustomobject]$result
}

# --- 汇总 ---------------------------------------------------------------------
$results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runRoot 'results.json') -Encoding UTF8

$report = @()
$report += "# PNP 评测任务运行报告（引擎 $Engine）"
$report += ''
$report += "- 时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$report += "- 工作目录：$Directory"
$report += "- 证据目录：$runRoot"
$report += "- 机械通过：$(@($results | Where-Object { $_.verdict -eq 'PASS(机械)' }).Count) / $($results.Count)"
$report += ''
$report += '## 逐题结果'
$report += ''
$report += '| 用例 | 状态码 | 耗时(s) | 完成规则 | 产物 | 机械判定 | 内容判定（人工填） |'
$report += '|---|---|---|---|---|---|---|'
foreach ($row in $results) {
  $outputs = '—'
  if ($row.outputs_created.Count -gt 0 -or $row.outputs_missing.Count -gt 0) {
    $outputs = "有 $($row.outputs_created.Count) / 缺 $($row.outputs_missing.Count)"
  }
  $report += "| $($row.task_id) | $($row.prompt_status) | $($row.duration_s) | $($row.completion_rule) | $outputs | $($row.verdict) |  |"
}
$report += ''
$report += '## 需要人工确认的点'
$report += ''
foreach ($row in $results) {
  if ([string]$row.manual -ne '') {
    $report += "### $($row.task_id)"
    $report += ''
    $report += [string]$row.manual
    $report += ''
    $report += "最终回复：$($row.final_text)"
    $report += ''
    $report += "调用的工具：$(if ($row.tools.Count -gt 0) { $row.tools -join ', ' } else { '（无）' })"
    $report += ''
  }
}
$reportPath = Join-Path $runRoot 'report.md'
$report -join "`r`n" | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Line ''
Write-Line "[eval] 完成：机械通过 $(@($results | Where-Object { $_.verdict -eq 'PASS(机械)' }).Count) / $($results.Count)"
Write-Line "[eval] 报告 $reportPath"
Write-Line "[eval] 证据（事件流、轨迹、results.json）$runRoot"
if (@($results | Where-Object { $_.verdict -eq 'FAIL' }).Count -gt 0) { exit 1 }
exit 0
