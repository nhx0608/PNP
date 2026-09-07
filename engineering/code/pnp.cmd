@echo off
setlocal

set "MODE=%~1"
set "ENGINE=%~2"
set "PORT=%~3"

if "%MODE%"=="" set "MODE=start"

if /I not "%MODE%"=="start" if /I not "%MODE%"=="bootstrap" if /I not "%MODE%"=="help" (
  set "ENGINE=%MODE%"
  set "MODE=start"
)

if "%ENGINE%"=="" if defined AGENT_ENGINE set "ENGINE=%AGENT_ENGINE%"
if "%ENGINE%"=="" set "ENGINE=opencode"
if "%PORT%"=="" set "PORT=6217"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pnp-local.ps1" -Mode "%MODE%" -Engine "%ENGINE%" -Port "%PORT%"
exit /b %ERRORLEVEL%
