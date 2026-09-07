@echo off
setlocal

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pnp-local.ps1" %*
exit /b %ERRORLEVEL%
