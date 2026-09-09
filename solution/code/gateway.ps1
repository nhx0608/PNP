# Developer convenience entry point. It is deliberately NOT the documented way to start the
# gateway: on a machine whose execution policy is Restricted or AllSigned, PowerShell refuses a
# .ps1 before a single line of it runs, so a self-relaunch under -ExecutionPolicy Bypass written
# here could never execute. The two documented entry points are policy-proof instead:
# `pnp.cmd` (which invokes PowerShell itself with -ExecutionPolicy Bypass) and `gateway.cmd`.
# If you want this file anyway on such a host, start it explicitly:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\gateway.ps1 --engine opencode
#
# Runtime resolution is kept identical to gateway.cmd on purpose: `.\gateway` in PowerShell
# resolves to THIS file rather than the .cmd, so a difference between the two would show up as
# "the same command works from cmd and fails from PowerShell".
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$bootstrap = Join-Path $PSScriptRoot 'runtime\bootstrap'

function Find-First([string[]]$Candidates) {
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }
  return $null
}

# ---- Node runtime ------------------------------------------------------------------------
# Order mirrors Resolve-Node in scripts\pnp-local.ps1 minus the download step: this entry point
# prepares nothing, it only finds what the package already ships. An exported variable wins.
$nodeExe = $null
if (-not [string]::IsNullOrWhiteSpace($env:PNP_NODE_HOME)) {
  $nodeExe = Find-First @((Join-Path $env:PNP_NODE_HOME 'node.exe'))
  if ($null -eq $nodeExe) {
    Write-Error "PNP_NODE_HOME does not contain node.exe: $env:PNP_NODE_HOME. Point it at a directory that contains node.exe, or clear it to use the bundled runtime."
    exit 2
  }
}
if ($null -eq $nodeExe) {
  # Globbed, not pinned: the bundled version lives in toolchain.json and must not be duplicated
  # here, where a bump would silently stop matching.
  $nodeExe = Find-First @(Get-ChildItem -Path $bootstrap -Directory -Filter 'node-v*-win-x64' -ErrorAction SilentlyContinue |
    Sort-Object Name | ForEach-Object { Join-Path $_.FullName 'node.exe' })
}
if ($null -eq $nodeExe) {
  $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -ne $onPath) { $nodeExe = $onPath.Source }
}
if ($null -eq $nodeExe) {
  Write-Error "No Node.js runtime found. Expected the bundled runtime under $bootstrap\node-v<version>-win-x64\. Run `"pnp.cmd bootstrap --engine <engineId>`" once to prepare it, or set PNP_NODE_HOME to a directory containing node.exe (Node.js 24.19 or newer)."
  exit 2
}

# ---- Engines the offline bundle ships ----------------------------------------------------
# Each Engine Pack reads only its own variables, so naming both is safe whichever engine
# --engine or AGENT_ENGINE selects.
if ([string]::IsNullOrWhiteSpace($env:PNP_OPENCODE_EXE_PATH)) {
  $opencode = Find-First @(Get-ChildItem -Path (Join-Path $bootstrap 'engines\opencode') -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name | ForEach-Object {
      $root = $_.FullName
      @('opencode-ai', 'opencode-windows-x64', 'opencode-windows-x64-baseline') |
        ForEach-Object { Join-Path $root "node_modules\$_\bin\opencode.exe" }
    })
  if ($null -ne $opencode) { $env:PNP_OPENCODE_EXE_PATH = $opencode }
}
if ([string]::IsNullOrWhiteSpace($env:PNP_PI_ENTRY)) {
  $pi = Find-First @(Get-ChildItem -Path (Join-Path $bootstrap 'engines\pi') -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name | ForEach-Object {
      Join-Path $_.FullName 'node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js'
    })
  if ($null -ne $pi) { $env:PNP_PI_ENTRY = $pi }
}
# pi is a Node entry script, not an executable: it needs an interpreter, and the one this gateway
# itself runs on is the one the package guarantees exists.
if ((-not [string]::IsNullOrWhiteSpace($env:PNP_PI_ENTRY)) -and [string]::IsNullOrWhiteSpace($env:PNP_PI_NODE)) {
  $env:PNP_PI_NODE = $nodeExe
}

# ---- Compiled gateway --------------------------------------------------------------------
$entry = Join-Path $PSScriptRoot 'dist\main.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
  Write-Error "Missing $entry (the compiled gateway). A delivered package ships it. From a source checkout, run `"pnp.cmd bootstrap --engine <engineId>`" once to install dependencies and build."
  exit 2
}

& $nodeExe $entry @args
exit $LASTEXITCODE
