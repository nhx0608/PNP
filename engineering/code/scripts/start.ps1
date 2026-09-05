param([string]$Engine)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if ($Engine) {
  if ($env:AGENT_ENGINE -and $env:AGENT_ENGINE -ne $Engine) { throw 'Engine argument conflicts with AGENT_ENGINE.' }
  $env:AGENT_ENGINE = $Engine
}
if (-not $env:AGENT_ENGINE) { throw 'AGENT_ENGINE is required.' }
& node dist/main.js
exit $LASTEXITCODE
