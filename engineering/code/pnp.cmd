@chcp 65001>nul
@echo off
setlocal EnableExtensions

rem UTF-8 first: the assessor's prompts, task files and produced artefacts are Chinese, and a
rem console left on the OEM code page turns every one of those paths into mojibake in the log.

set "MODE=start"
set "ENGINE="
set "PORT=6217"
set "BINDHOST=localhost"

if /I "%~1"=="start" (
  set "MODE=start"
  shift
) else if /I "%~1"=="bootstrap" (
  set "MODE=bootstrap"
  shift
) else if /I "%~1"=="selfcheck" (
  set "MODE=selfcheck"
  shift
) else if /I "%~1"=="stop" (
  set "MODE=stop"
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
if /I "%~1"=="--host" (
  if "%~2"=="" (
    echo [pnp] --host requires a value. 1>&2
    exit /b 2
  )
  set "BINDHOST=%~2"
  shift
  shift
  goto parse
)
if /I "%~1"=="--help" goto help

echo [pnp] Unknown argument: %~1 1>&2
exit /b 2

:resolved
rem `stop` acts on the PID file this launcher wrote; it needs no engine selection.
if /I "%MODE%"=="stop" goto run

rem The task book requires the engine to be selectable through AGENT_ENGINE, so --engine is
rem optional whenever that variable is set. Supplying both is only accepted when they agree:
rem a silent winner between two different answers is how a whole evaluation round ends up
rem measuring the wrong engine.
if not "%ENGINE%"=="" goto engine_given
if defined AGENT_ENGINE goto engine_from_environment
echo [pnp] No engine selected. Set AGENT_ENGINE or pass --engine ^<engineId^>. 1>&2
echo [pnp] Example: set AGENT_ENGINE=opencode ^&^& pnp.cmd start 1>&2
echo [pnp] Example: pnp.cmd start --engine opencode --port 6217 1>&2
exit /b 2

:engine_from_environment
set "ENGINE=%AGENT_ENGINE%"
goto run

:engine_given
if not defined AGENT_ENGINE goto run
if /I "%AGENT_ENGINE%"=="%ENGINE%" goto run
echo [pnp] --engine and AGENT_ENGINE disagree ^(--engine=%ENGINE%, AGENT_ENGINE=%AGENT_ENGINE%^). 1>&2
echo [pnp] Clear AGENT_ENGINE or make it match. 1>&2
exit /b 2

:run
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pnp-local.ps1" -Mode "%MODE%" -Engine "%ENGINE%" -Port "%PORT%" -BindHost "%BINDHOST%"
exit /b %ERRORLEVEL%

:help
echo PNP launcher (dependency preparation + gateway lifecycle)
echo.
echo Usage:
echo   pnp.cmd start      [--engine ^<id^>] [--port 6217] [--host localhost]
echo   pnp.cmd bootstrap  [--engine ^<id^>]
echo   pnp.cmd selfcheck  [--engine ^<id^>]
echo   pnp.cmd stop
echo   pnp.cmd help
echo.
echo Engine selection:
echo   set AGENT_ENGINE=opencode ^&^& pnp.cmd start
echo   pnp.cmd start --engine opencode --port 6217
echo   Both are accepted; giving both different values fails instead of picking one.
echo.
echo Modes:
echo   bootstrap  prepare Node, dependencies, build output and the engine, then stop.
echo   start      bootstrap, then run the gateway; the PID is written to runtime\gateway.pid
echo              and the output to runtime\logs\gateway-^<engine^>.log.
echo   selfcheck  bootstrap, then run the offline end-to-end check (mock model service +
echo              gateway + one real prompt) and print PASS or FAIL.
echo   stop       terminate exactly the process recorded in runtime\gateway.pid.
exit /b 0
