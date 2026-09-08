# Developer convenience entry point. It is deliberately NOT the documented way to start the
# gateway: on a machine whose execution policy is Restricted or AllSigned, PowerShell refuses a
# .ps1 before a single line of it runs, so a self-relaunch under -ExecutionPolicy Bypass written
# here could never execute. The two documented entry points are policy-proof instead:
# `pnp.cmd` (which invokes PowerShell itself with -ExecutionPolicy Bypass) and `gateway.cmd`.
# If you want this file anyway on such a host, start it explicitly:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\gateway.ps1 --engine opencode
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
& node "$PSScriptRoot\dist\main.js" @args
exit $LASTEXITCODE
