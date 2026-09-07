@echo off
setlocal EnableExtensions

set "MODE=start"
set "ENGINE="
set "PORT=6217"

if /I "%~1"=="start" (
  set "MODE=start"
  shift
) else if /I "%~1"=="bootstrap" (
  set "MODE=bootstrap"
  shift
) else if /I "%~1"=="help" (
  goto help
)

:parse
if "%~1"=="" goto resolved
if /I "%~1"=="--engine" (
  if "%~2"=="" (
    echo [pnp] --engine requires a value. 1>&2
    exit /b 2
  )
  set "ENGINE=%~2"
  shift
  shift
  goto parse
)
if /I "%~1"=="--port" (
  if "%~2"=="" (
    echo [pnp] --port requires a value. 1>&2
    exit /b 2
  )
  set "PORT=%~2"
  shift
  shift
  goto parse
)
if /I "%~1"=="--help" goto help

echo [pnp] Unknown argument: %~1 1>&2
exit /b 2

:resolved
if "%ENGINE%"=="" if defined AGENT_ENGINE set "ENGINE=%AGENT_ENGINE%"
if "%ENGINE%"=="" (
  echo [pnp] Specify the Agent Core at startup: --engine opencode ^(or set AGENT_ENGINE for compatibility^). 1>&2
  exit /b 2
)
if defined AGENT_ENGINE if /I not "%AGENT_ENGINE%"=="%ENGINE%" (
  echo [pnp] --engine and AGENT_ENGINE disagree. 1>&2
  exit /b 2
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pnp-local.ps1" -Mode "%MODE%" -Engine "%ENGINE%" -Port "%PORT%"
exit /b %ERRORLEVEL%

:help
echo PNP local bootstrap launcher
echo.
echo Usage:
echo   pnp.cmd start --engine ^<id^> [--port 6217]
echo   pnp.cmd bootstrap --engine ^<id^>
echo   pnp.cmd help
echo.
echo Examples:
echo   pnp.cmd start --engine opencode --port 6217
echo   pnp.cmd bootstrap --engine opencode
echo.
echo Engine selection is a startup argument. AGENT_ENGINE is retained only as a compatibility fallback.
exit /b 0
