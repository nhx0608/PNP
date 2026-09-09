<#
.SYNOPSIS
  用赛题格式的 JSON 驱动 PNP 网关执行评测任务，并保存可复核证据。

.DESCRIPTION
  默认只运行无外部副作用的用例。桌面启动、联网、递归删除和外部消息必须分别显式开启。
  脚本把“协议正常结束”和“业务机械检查通过”分开记录；PASS(机械) 仍不替代人工内容复核。

  运行前先在另一个窗口启动网关，例如：
      .\gateway.cmd --engine opencode --port 6217

.EXAMPLE
  .\run-eval-tasks.ps1 -Engine opencode
.EXAMPLE
  .\run-eval-tasks.ps1 -Engine opencode -Only office_139 -IncludeNetwork
.EXAMPLE
  .\run-eval-tasks.ps1 -Engine pi -Only office_103 -IncludeDestructive
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('opencode', 'pi')][string]$Engine,
  [string]$Base = 'http://127.0.0.1:6217',
  [string]$TasksFile = "$PSScriptRoot\eval-tasks.json",
  [string]$ExpectationsFile = "$PSScriptRoot\eval-expectations.json",
  [string]$Directory = 'D:\test_data',
  [string]$Evidence = 'D:\pnp-evidence',
  [string[]]$Only = @(),
  [int]$PromptTimeoutSec = 900,
  [switch]$IncludeInteractiveDesktop,
  [switch]$IncludeNetwork,
  [switch]$IncludeDestructive,
  [switch]$IncludeExternalSideEffects
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Write-Line([string]$Text) { Write-Host $Text }

function Has-Property($Object, [string]$Name) {
  return ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name])
}

function Invoke-Json {
  param([string]$Method, [string]$Uri, $Body, [int]$TimeoutSec = 60)
  $arguments = @{ Method = $Method; Uri = $Uri; TimeoutSec = $TimeoutSec; UseBasicParsing = $true }
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Depth 12 -Compress
    $arguments['Body'] = [System.Text.Encoding]::UTF8.GetBytes($json)
    $arguments['ContentType'] = 'application/json; charset=utf-8'
  }
  try {
    $response = Invoke-WebRequest @arguments
    $content = if ($response.Content) { [string]$response.Content } else { '' }
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
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

function Get-ZipEntryText([string]$Path, [string]$EntryName) {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $entry = $archive.GetEntry($EntryName)
    if ($null -eq $entry) { throw "压缩包中缺少 $EntryName" }
    $stream = $entry.Open()
    try {
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true)
      try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
  } finally { $archive.Dispose() }
}

function Get-OpenXmlVisibleText([string]$Path) {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $entries = @()
    $extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    if ($extension -eq '.docx') {
      $entries = @($archive.Entries | Where-Object { $_.FullName -eq 'word/document.xml' })
    } elseif ($extension -eq '.pptx') {
      $entries = @($archive.Entries | Where-Object { $_.FullName -match '^ppt/slides/slide\d+\.xml$' } |
        Sort-Object { [int]([regex]::Match($_.FullName, 'slide(\d+)\.xml').Groups[1].Value) })
    } else {
      throw "不支持从 $extension 提取 Open XML 文本"
    }

    $text = @()
    foreach ($entry in $entries) {
      $stream = $entry.Open()
      try {
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true)
        try { $xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
      } finally { $stream.Dispose() }
      foreach ($match in [regex]::Matches($xml, '<(?:w|a):t(?:\s[^>]*)?>(.*?)</(?:w|a):t>', 'Singleline')) {
        $text += [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value)
      }
    }
    return ($text -join "`n")
  } finally { $archive.Dispose() }
}

function Get-PptxSlideCount([string]$Path) {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try { return @($archive.Entries | Where-Object { $_.FullName -match '^ppt/slides/slide\d+\.xml$' }).Count }
  finally { $archive.Dispose() }
}

function Get-DocxTableCount([string]$Path) {
  $xml = Get-ZipEntryText -Path $Path -EntryName 'word/document.xml'
  return [regex]::Matches($xml, '<w:tbl(?:\s|>)').Count
}

function Get-XlsxSheetCount([string]$Path) {
  $xml = Get-ZipEntryText -Path $Path -EntryName 'xl/workbook.xml'
  return [regex]::Matches($xml, '<(?:\w+:)?sheet(?:\s|>)').Count
}

function Get-ToolTrace($Messages) {
  $byId = @{}
  $sequence = 0
  foreach ($message in @($Messages)) {
    if (Has-Property $message 'parts') {
      foreach ($part in @($message.parts)) {
        if (-not (Has-Property $part 'type') -or [string]$part.type -ne 'tool') { continue }
        $sequence += 1
        $callId = if (Has-Property $part 'callID') { [string]$part.callID } else { "anonymous-$sequence" }
        if (-not $byId.ContainsKey($callId)) {
          $byId[$callId] = [ordered]@{ call_id = $callId; name = ''; status = 'unknown'; input = $null; sequence = $sequence; error = '' }
        }
        $call = $byId[$callId]
        if (Has-Property $part 'tool') { $call.name = [string]$part.tool }
        # 必须先 @(...) 再取 Count：PSObject.Properties 是集合本身没有 Count 成员，
        # 而本脚本开了 Set-StrictMode -Version 2.0，于是每一个带 input 的工具 part 都会在这里抛
        # 「在此对象上找不到属性 Count」。整个 Get-ToolTrace 随之中断，tool_calls 恒为空数组，
        # requiredSuccessfulTools 因此从来没有真正生效过——六道产物明明正确的题被判 PARTIAL，
        # 根因就是这一行，而不是引擎或轨迹。
        if ((Has-Property $part 'input') -and $null -ne $part.input -and @($part.input.PSObject.Properties).Count -gt 0) { $call.input = $part.input }
        if ((Has-Property $part 'state') -and (Has-Property $part.state 'status')) { $call.status = [string]$part.state.status }
        elseif (Has-Property $part 'nativeStatus') { $call.status = [string]$part.nativeStatus }
        if ((Has-Property $part 'output') -and (Has-Property $part.output 'error')) {
          $call.status = 'failed'
          $call.error = [string]$part.output.error
        }
      }
    }
    if ((Has-Property $message 'role') -and [string]$message.role -eq 'tool' -and (Has-Property $message 'tool_call_id')) {
      $callId = [string]$message.tool_call_id
      if ($byId.ContainsKey($callId) -and (Has-Property $message 'content')) {
        try {
          $toolBody = ([string]$message.content) | ConvertFrom-Json
          if (Has-Property $toolBody 'error') {
            $byId[$callId].status = 'failed'
            $byId[$callId].error = [string]$toolBody.error
          }
        } catch { }
      }
    }
  }
  return @($byId.Values | Sort-Object sequence | ForEach-Object { [pscustomobject]$_ })
}

function Test-RiskAllowed([string]$Risk) {
  switch ($Risk) {
    'safe' { return $true }
    'interactive-desktop' { return [bool]$IncludeInteractiveDesktop }
    'network' { return [bool]$IncludeNetwork }
    'destructive-fixture-only' { return [bool]$IncludeDestructive }
    'external-side-effect' { return [bool]$IncludeExternalSideEffects }
    default { return $false }
  }
}

# /health/ready 只证明共享执行控制可接任务；下面的真实 prompt 才验证引擎、模型与工具链。
$ready = Invoke-Json -Method 'GET' -Uri "$Base/health/ready" -Body $null -TimeoutSec 15
if ($ready.Status -ne 200) {
  throw "网关未就绪（$Base/health/ready 返回 $($ready.Status)）。先在另一个窗口执行 .\gateway.cmd --engine $Engine --port 6217"
}
$runningEngine = [string]$ready.Body.engine
if ($runningEngine -ne $Engine) {
  throw "网关跑的是 '$runningEngine'，本次请求的是 '$Engine'。停掉网关后按目标引擎重启。"
}

$allTasks = @((Get-Content -LiteralPath $TasksFile -Raw -Encoding UTF8 | ConvertFrom-Json).tasks)
$expectations = Get-Content -LiteralPath $ExpectationsFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Only.Count -gt 0) { $allTasks = @($allTasks | Where-Object { $Only -contains $_.task_id }) }
if ($allTasks.Count -eq 0) { throw '没有匹配的用例（检查 -Only 里的 task_id）。' }

$tasks = @()
$skipped = @()
foreach ($task in $allTasks) {
  $id = [string]$task.task_id
  $expectation = if ($expectations.PSObject.Properties[$id]) { $expectations.$id } else { $null }
  $risk = 'unknown'
  if ($null -ne $expectation -and (Has-Property $expectation 'execution') -and (Has-Property $expectation.execution 'risk')) {
    $risk = [string]$expectation.execution.risk
  }
  if (Test-RiskAllowed $risk) {
    if ($risk -eq 'external-side-effect' -and [string]$task.query -match 'TEST_RECIPIENT') {
      throw "$id 仍使用公开占位符 TEST_RECIPIENT。请在忽略目录中创建私有 tasks JSON，并通过 -TasksFile 传入真实测试收件人。"
    }
    $tasks += $task
  } else {
    $skipped += [pscustomobject]@{ task_id = $id; risk = $risk; reason = "未提供风险类型 '$risk' 对应的显式开关" }
  }
}
if ($tasks.Count -eq 0) {
  $reasons = @($skipped | ForEach-Object { "$($_.task_id)[$($_.risk)]" }) -join ', '
  throw "所选用例均因安全策略跳过：$reasons"
}

if (@($tasks | Where-Object { [string]$_.task_id -eq 'office_103' }).Count -gt 0) {
  $sentinelPath = Join-Path $Directory '.pnp-evaluation-fixture.json'
  if (-not (Test-Path -LiteralPath $sentinelPath -PathType Leaf)) {
    throw "拒绝运行删除题：$Directory 缺少 .pnp-evaluation-fixture.json。请先运行 engineering\verification\eval\Prepare-EvalData.ps1。"
  }
  $sentinel = Get-Content -LiteralPath $sentinelPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not (Has-Property $sentinel 'owner') -or [string]$sentinel.owner -ne 'PNP_EVALUATION_FIXTURE') {
    throw "拒绝运行删除题：$sentinelPath 不是 PNP 评测包的所有权标记。"
  }
}

$runRoot = Join-Path $Evidence "$Engine-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
Write-Line "[eval] 网关就绪，引擎 = $runningEngine，证据目录 = $runRoot"
Write-Line "[eval] 将运行 $($tasks.Count) / $($allTasks.Count) 条；跳过 $($skipped.Count) 条；工作目录 $Directory"
foreach ($skip in $skipped) { Write-Line "[skip] $($skip.task_id) ($($skip.risk))：$($skip.reason)" }

$results = @()

foreach ($task in $tasks) {
  $id = [string]$task.task_id
  Write-Line ''
  Write-Line "=== $id  $($task.title)  (难度 $($task.difficulty)/$($task.difficulty_label)) ==="
  $expectation = if ($expectations.PSObject.Properties[$id]) { $expectations.$id } else { $null }

  $beforeInputs = @{}
  $beforeOutputs = @{}
  $beforeDeleteMatches = @()
  if ($null -ne $expectation -and (Has-Property $expectation 'unchanged')) {
    foreach ($file in @($expectation.unchanged)) { $beforeInputs[[string]$file] = Get-Sha256 ([string]$file) }
  }
  if ($null -ne $expectation -and (Has-Property $expectation 'outputs')) {
    foreach ($file in @($expectation.outputs)) { $beforeOutputs[[string]$file] = Get-Sha256 ([string]$file) }
  }
  if ($null -ne $expectation -and (Has-Property $expectation 'absentGlob')) {
    $root = [string]$expectation.absentGlob.root
    $needle = [string]$expectation.absentGlob.nameContains
    if (Test-Path -LiteralPath $root) {
      $beforeDeleteMatches = @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*$needle*" } | ForEach-Object { $_.FullName })
    }
  }

  $result = [ordered]@{
    task_id = $id; title = $task.title; engine = $Engine
    session_id = $null; prompt_status = $null; duration_s = $null
    protocol_pass = $false; task_mechanical_pass = $false; completion_rule = $null
    outputs_fresh = @(); outputs_missing = @(); outputs_unchanged = @()
    inputs_missing_before = @(); inputs_modified = @(); contains_missing = @()
    delete_matches_before = @($beforeDeleteMatches); leftovers = @()
    required_tools_missing = @(); tool_failures = @(); effect_checks_failed = @()
    structure_failures = @(); final_text_failures = @(); event_failures = @()
    final_text_notes = @()
    events = @(); tool_calls = @(); tools = @(); final_text = ''; manual = ''
    verdict = 'FAIL'; note = ''
  }
  if ($null -ne $expectation -and (Has-Property $expectation 'manual')) { $result.manual = [string]$expectation.manual }
  foreach ($file in $beforeInputs.Keys) {
    if ($null -eq $beforeInputs[$file]) { $result.inputs_missing_before += $file }
  }
  if ($null -ne $expectation -and (Has-Property $expectation 'absentGlob') -and (Has-Property $expectation.absentGlob 'minimumBefore')) {
    $minimum = [int]$expectation.absentGlob.minimumBefore
    if ($beforeDeleteMatches.Count -lt $minimum) {
      $result.effect_checks_failed += "删除前只找到 $($beforeDeleteMatches.Count) 个匹配文件，少于要求的 $minimum 个"
    }
  }

  $eventsFile = Join-Path $runRoot "$id.events.txt"
  $sse = $null
  $messagesBody = @()
  try {
    $session = Invoke-Json -Method 'POST' -Uri "$Base/session" -Body @{ title = $id; directory = $Directory }
    if ($session.Status -ne 200) { throw "POST /session 返回 $($session.Status)：$($session.Raw)" }
    $sessionId = [string]$session.Body.id
    $result.session_id = $sessionId

    $sse = Start-Process -FilePath 'curl.exe' -ArgumentList @('-sN', "$Base/event") `
      -RedirectStandardOutput $eventsFile -NoNewWindow -PassThru
    Start-Sleep -Milliseconds 500

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

    $messages = Invoke-Json -Method 'GET' -Uri "$Base/session/$sessionId/message" -Body $null -TimeoutSec 60
    if ($messages.Status -eq 200) {
      $messagesBody = @($messages.Body)
      $messagesBody | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $runRoot "$id.messages.json") -Encoding UTF8
      $assistants = @($messagesBody | Where-Object { (Has-Property $_ 'role') -and [string]$_.role -eq 'assistant' })
      $last = if ($assistants.Count -gt 0) { $assistants[-1] } else { $null }
      $finish = if ($null -ne $last -and (Has-Property $last 'info') -and (Has-Property $last.info 'finish')) { [string]$last.info.finish } else { '' }
      $hasStepFinish = ($null -ne $last -and (Has-Property $last 'parts') -and @($last.parts | Where-Object { (Has-Property $_ 'type') -and $_.type -eq 'step-finish' }).Count -gt 0)
      $result.completion_rule = "role=$(if ($null -ne $last) { 'assistant' } else { 'missing' }); finish=$finish; step-finish=$hasStepFinish"
      if ($null -ne $last -and (Has-Property $last 'content')) { $result.final_text = [string]$last.content }
      if ([string]$result.final_text -eq '' -and $null -ne $last -and (Has-Property $last 'parts')) {
        $result.final_text = @($last.parts | Where-Object { $_.type -eq 'text' } | ForEach-Object {
          if (Has-Property $_ 'text') { [string]$_.text } elseif (Has-Property $_ 'content') { [string]$_.content }
        }) -join "`n"
      }
      $result.tool_calls = @(Get-ToolTrace $messagesBody)
      $result.tools = @($result.tool_calls | ForEach-Object { $_.name } | Where-Object { $_ -ne '' } | Select-Object -Unique)
    } else {
      $result.note = "GET message 返回 $($messages.Status)：$($messages.Raw)"
    }

    Start-Sleep -Milliseconds 250
    $null = Invoke-Json -Method 'DELETE' -Uri "$Base/session/$sessionId" -Body $null -TimeoutSec 60
  } catch {
    $result.note = $_.Exception.Message
    Write-Line "    异常：$($result.note)"
  } finally {
    if ($null -ne $sse) { try { Stop-Process -Id $sse.Id -Force -ErrorAction SilentlyContinue } catch { } }
  }

  if (Test-Path -LiteralPath $eventsFile) {
    $eventObjects = @()
    foreach ($line in (Get-Content -LiteralPath $eventsFile -Encoding UTF8 -ErrorAction SilentlyContinue)) {
      if ($line -match '^data:\s*(\{.*\})\s*$') {
        try {
          $event = $matches[1] | ConvertFrom-Json
          $belongs = $true
          if ((Has-Property $event 'properties') -and (Has-Property $event.properties 'sessionID')) {
            $belongs = ([string]$event.properties.sessionID -eq [string]$result.session_id)
          }
          if ($belongs) { $eventObjects += $event }
        } catch { }
      }
    }
    $result.events = @($eventObjects | ForEach-Object { [string]$_.type })
  }

  if ($null -ne $expectation) {
    if (Has-Property $expectation 'outputs') {
      foreach ($rawFile in @($expectation.outputs)) {
        $file = [string]$rawFile
        $afterHash = Get-Sha256 $file
        if ($null -eq $afterHash) { $result.outputs_missing += $file }
        elseif ($null -ne $beforeOutputs[$file] -and $beforeOutputs[$file] -eq $afterHash) { $result.outputs_unchanged += $file }
        else { $result.outputs_fresh += $file }
      }
    }
    if (Has-Property $expectation 'unchanged') {
      foreach ($rawFile in @($expectation.unchanged)) {
        $file = [string]$rawFile
        if ($null -ne $beforeInputs[$file] -and $beforeInputs[$file] -ne (Get-Sha256 $file)) { $result.inputs_modified += $file }
      }
    }
    if (Has-Property $expectation 'contains') {
      foreach ($property in $expectation.contains.PSObject.Properties) {
        $file = [string]$property.Name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        $text = Get-Content -LiteralPath $file -Raw -Encoding UTF8
        foreach ($needle in @($property.Value)) {
          if ($text -notlike "*$needle*") { $result.contains_missing += "$file :: $needle" }
        }
      }
    }
    if (Has-Property $expectation 'cjkLength') {
      foreach ($property in $expectation.cjkLength.PSObject.Properties) {
        $file = [string]$property.Name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        $text = Get-Content -LiteralPath $file -Raw -Encoding UTF8
        $count = [regex]::Matches($text, '[\u3400-\u9FFF]').Count
        if ($count -lt [int]$property.Value.min -or $count -gt [int]$property.Value.max) {
          $result.structure_failures += "$file :: 汉字数 $count，不在 $($property.Value.min)-$($property.Value.max)"
        }
      }
    }
    if (Has-Property $expectation 'absentGlob') {
      $root = [string]$expectation.absentGlob.root
      $needle = [string]$expectation.absentGlob.nameContains
      if (Test-Path -LiteralPath $root) {
        $result.leftovers = @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -like "*$needle*" } | ForEach-Object { $_.FullName })
      }
    }
    if (Has-Property $expectation 'requiredSuccessfulTools') {
      $successfulNames = @($result.tool_calls | Where-Object { $_.status -eq 'completed' } | ForEach-Object { [string]$_.name })
      foreach ($group in @($expectation.requiredSuccessfulTools)) {
        $names = @($group | ForEach-Object { [string]$_ })
        if (@($names | Where-Object { $successfulNames -contains $_ }).Count -eq 0) {
          $result.required_tools_missing += ($names -join ' | ')
        }
      }
    }
    foreach ($call in @($result.tool_calls)) {
      if ([string]$call.status -eq 'completed') { continue }
      $recovered = @($result.tool_calls | Where-Object {
        $_.name -eq $call.name -and $_.sequence -gt $call.sequence -and $_.status -eq 'completed'
      }).Count -gt 0
      if (-not $recovered) { $result.tool_failures += "$($call.name)[$($call.call_id)]=$($call.status) $($call.error)".Trim() }
    }
    if (Has-Property $expectation 'requiredNonDryRunTool') {
      $toolName = [string]$expectation.requiredNonDryRunTool
      $effectCall = @($result.tool_calls | Where-Object {
        $_.name -eq $toolName -and $_.status -eq 'completed' -and $null -ne $_.input -and
        (Has-Property $_.input 'dryRun') -and $_.input.dryRun -eq $false
      })
      if ($effectCall.Count -eq 0) { $result.effect_checks_failed += "$toolName 没有成功的 dryRun=false 调用" }
    }
    if (Has-Property $expectation 'docxRequiredText') {
      foreach ($property in $expectation.docxRequiredText.PSObject.Properties) {
        $file = [string]$property.Name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        try {
          $text = Get-OpenXmlVisibleText $file
          foreach ($needle in @($property.Value)) {
            if ($text -notlike "*$needle*") { $result.structure_failures += "$file :: 缺少文本 $needle" }
          }
        } catch { $result.structure_failures += "$file :: DOCX 无法解析：$($_.Exception.Message)" }
      }
    }
    if (Has-Property $expectation 'pptxRequiredText') {
      foreach ($property in $expectation.pptxRequiredText.PSObject.Properties) {
        $file = [string]$property.Name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        try {
          $text = Get-OpenXmlVisibleText $file
          foreach ($needle in @($property.Value)) {
            if ($text -notlike "*$needle*") { $result.structure_failures += "$file :: 缺少文本 $needle" }
          }
        } catch { $result.structure_failures += "$file :: PPTX 无法解析：$($_.Exception.Message)" }
      }
    }
    if (Has-Property $expectation 'pptxMaxSlides') {
      foreach ($property in $expectation.pptxMaxSlides.PSObject.Properties) {
        $file = [string]$property.Name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
        try {
          $count = Get-PptxSlideCount $file
          if ($count -gt [int]$property.Value) { $result.structure_failures += "$file :: $count 页，超过上限 $($property.Value)" }
        } catch { $result.structure_failures += "$file :: PPTX 无法解析：$($_.Exception.Message)" }
      }
    }
    if (Has-Property $expectation 'pptxMinSlidesFrom') {
      foreach ($property in $expectation.pptxMinSlidesFrom.PSObject.Properties) {
        $file = [string]$property.Name
        $source = [string]$property.Value
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or -not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        try {
          $actual = Get-PptxSlideCount $file
          $expectedMinimum = Get-PptxSlideCount $source
          if ($actual -lt $expectedMinimum) { $result.structure_failures += "$file :: $actual 页，少于源文件 $expectedMinimum 页" }
        } catch { $result.structure_failures += "$file :: PPTX 页数无法解析：$($_.Exception.Message)" }
      }
    }
    if (Has-Property $expectation 'xlsxSheetCountFromDocx') {
      foreach ($property in $expectation.xlsxSheetCountFromDocx.PSObject.Properties) {
        $file = [string]$property.Name
        $source = [string]$property.Value
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or -not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
        try {
          $actual = Get-XlsxSheetCount $file
          $expectedCount = Get-DocxTableCount $source
          if ($actual -ne $expectedCount) { $result.structure_failures += "$file :: $actual 个 sheet，不等于源 DOCX 的 $expectedCount 个表格" }
        } catch { $result.structure_failures += "$file :: 结构无法解析：$($_.Exception.Message)" }
      }
    }
    if (Has-Property $expectation 'forbiddenEvents') {
      foreach ($eventType in @($expectation.forbiddenEvents)) {
        if ($result.events -contains [string]$eventType) { $result.event_failures += "出现禁止事件 $eventType" }
      }
    }
    # "无人值守"要判的是没有人被卡住等着回答，而不是没有出现过 question.asked。
    # 网关在默认 PNP_QUESTION_POLICY=auto 下的正确行为，就是先发布 question.asked（让轨迹里
    # 留下这个问题），随即自己作答并发布 question.resolved。把事件本身列为禁止项，等于把网关
    # 设计好的自动应答判成失败。真正的失败是问了却没有被解决，那才会真的阻塞自动评测。
    if ((Has-Property $expectation 'noBlockingQuestion') -and [bool]$expectation.noBlockingQuestion) {
      $asked = @($result.events | Where-Object { $_ -eq 'question.asked' }).Count
      $resolved = @($result.events | Where-Object { $_ -eq 'question.resolved' }).Count
      if ($asked -gt $resolved) {
        $result.event_failures += "有 $asked 次反问但只有 $resolved 次被解决：本轮不是无人值守"
      }
    }
    if ((Has-Property $expectation 'finalMustMentionOutputs') -and [bool]$expectation.finalMustMentionOutputs -and (Has-Property $expectation 'outputs')) {
      foreach ($file in @($expectation.outputs)) {
        $leaf = Split-Path -Leaf ([string]$file)
        if ([string]$result.final_text -notlike "*$leaf*") { $result.final_text_failures += "最终回复未提及产物 $leaf" }
      }
    }
    # 只匹配"智能体自述没做成"的说法，不匹配任务内容里的同形词。
    # 旧的宽匹配（无法|不能|失败|error 任意出现即判失败）会误杀本题就在讨论失败的报告：
    # office_014/015 是违约风险分析，正确结论里几乎必然出现"失败""不能"；office_018 的补货建议
    # 同理。产物是否真的生成，已经由 outputs_missing / outputs_unchanged 用哈希独立判定，
    # 这条规则只负责补上"文件在、但模型自己说没做完"这一种情况。
    if ((Has-Property $expectation 'outputs') -and [string]$result.final_text -match '(?i)我无法|无法完成|无法生成|无法保存|无法创建|无法访问|未能完成|未能生成|不能完成|没有完成|执行失败|生成失败|保存失败|创建失败|写入失败|请提供|请确认|请补充|unable to|cannot complete|could not|failed to') {
      $result.final_text_failures += '最终回复自述未完成'
    }
    # 宽匹配降级为提示：不参与判定，但留给人工复核时扫一眼。
    if ((Has-Property $expectation 'outputs') -and [string]$result.final_text -match '(?i)失败|不存在|error') {
      $result.final_text_notes += '最终回复出现失败类字样（可能只是任务内容，需人工确认）'
    }
  }

  $result.protocol_pass = ($result.prompt_status -eq 204) -and
    ($result.completion_rule -like '*finish=stop*') -and ($result.completion_rule -like '*step-finish=True*')
  $mechanicalViolationCount = $result.outputs_missing.Count + $result.outputs_unchanged.Count +
    $result.inputs_missing_before.Count + $result.inputs_modified.Count + $result.contains_missing.Count +
    $result.leftovers.Count + $result.required_tools_missing.Count + $result.tool_failures.Count +
    $result.effect_checks_failed.Count + $result.structure_failures.Count + $result.final_text_failures.Count +
    $result.event_failures.Count
  $result.task_mechanical_pass = ($mechanicalViolationCount -eq 0)
  if ($result.protocol_pass -and $result.task_mechanical_pass) { $result.verdict = 'PASS(机械)' }
  elseif ($result.protocol_pass) { $result.verdict = 'PARTIAL' }
  else { $result.verdict = 'FAIL' }

  Write-Line "    协议完成 = $($result.protocol_pass)，任务机械检查 = $($result.task_mechanical_pass)，判定 = $($result.verdict)"
  if ($result.outputs_missing.Count -gt 0) { Write-Line "    缺产物：$($result.outputs_missing -join ', ')" }
  if ($result.outputs_unchanged.Count -gt 0) { Write-Line "    旧产物未变化：$($result.outputs_unchanged -join ', ')" }
  if ($result.inputs_missing_before.Count -gt 0) { Write-Line "    运行前缺输入：$($result.inputs_missing_before -join ', ')" }
  if ($result.required_tools_missing.Count -gt 0) { Write-Line "    缺成功工具：$($result.required_tools_missing -join ', ')" }
  if ($result.tool_failures.Count -gt 0) { Write-Line "    未恢复工具失败：$($result.tool_failures -join '；')" }
  if ($result.structure_failures.Count -gt 0) { Write-Line "    结构检查失败：$($result.structure_failures -join '；')" }

  $results += [pscustomobject]$result
}

$machineOutput = [ordered]@{
  generated_at = (Get-Date).ToString('o')
  engine = $Engine
  selected = @($results | ForEach-Object { $_.task_id })
  skipped = $skipped
  eligible_for_full_acceptance = ($skipped.Count -eq 0)
  results = $results
}
$machineOutput | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath (Join-Path $runRoot 'results.json') -Encoding UTF8

$report = @()
$report += "# PNP 评测任务运行报告（引擎 $Engine）"
$report += ''
$report += "- 时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$report += "- 工作目录：$Directory"
$report += "- 证据目录：$runRoot"
$report += "- 覆盖：运行 $($results.Count) / 请求 $($allTasks.Count)，跳过 $($skipped.Count)"
$report += "- 可作为完整验收：$(if ($skipped.Count -eq 0) { '是（仍须人工复核）' } else { '否' })"
$report += "- 机械通过：$(@($results | Where-Object { $_.verdict -eq 'PASS(机械)' }).Count) / $($results.Count)"
$report += ''
if ($skipped.Count -gt 0) {
  $report += '## 因安全策略跳过'
  $report += ''
  $report += '| 用例 | 风险 | 原因 |'
  $report += '|---|---|---|'
  foreach ($row in $skipped) { $report += "| $($row.task_id) | $($row.risk) | $($row.reason) |" }
  $report += ''
}
$report += '## 逐题结果'
$report += ''
$report += '| 用例 | 状态码 | 耗时(s) | 协议完成 | 任务机械检查 | 产物 | 判定 | 内容判定（人工填） |'
$report += '|---|---:|---:|---|---|---|---|---|'
foreach ($row in $results) {
  $outputs = if (($row.outputs_fresh.Count + $row.outputs_missing.Count + $row.outputs_unchanged.Count) -eq 0) { '—' } else {
    "新/变 $($row.outputs_fresh.Count)，缺 $($row.outputs_missing.Count)，旧 $($row.outputs_unchanged.Count)"
  }
  $report += "| $($row.task_id) | $($row.prompt_status) | $($row.duration_s) | $($row.protocol_pass) | $($row.task_mechanical_pass) | $outputs | $($row.verdict) |  |"
}
$report += ''
$report += '## 人工复核与轨迹摘要'
$report += ''
foreach ($row in $results) {
  $report += "### $($row.task_id)"
  $report += ''
  $report += "- 人工标准：$(if ([string]$row.manual -ne '') { $row.manual } else { '无补充项' })"
  $report += "- 最终回复：$($row.final_text)"
  $report += "- 工具：$(if ($row.tools.Count -gt 0) { $row.tools -join ', ' } else { '（无）' })"
  if ($row.required_tools_missing.Count -gt 0) { $report += "- 缺成功工具：$($row.required_tools_missing -join ', ')" }
  if ($row.tool_failures.Count -gt 0) { $report += "- 未恢复工具失败：$($row.tool_failures -join '；')" }
  if ($row.structure_failures.Count -gt 0) { $report += "- 结构失败：$($row.structure_failures -join '；')" }
  if ($row.final_text_failures.Count -gt 0) { $report += "- 最终回复失败信号：$($row.final_text_failures -join '；')" }
  if ($row.final_text_notes.Count -gt 0) { $report += "- 提示（不影响判定）：$($row.final_text_notes -join '；')" }
  $report += ''
}
$reportPath = Join-Path $runRoot 'report.md'
$report -join "`r`n" | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Line ''
Write-Line "[eval] 完成：机械通过 $(@($results | Where-Object { $_.verdict -eq 'PASS(机械)' }).Count) / $($results.Count)"
Write-Line "[eval] 报告 $reportPath"
Write-Line "[eval] 证据（事件流、轨迹、results.json）$runRoot"
if (@($results | Where-Object { $_.verdict -ne 'PASS(机械)' }).Count -gt 0) { exit 1 }
exit 0
