@chcp 65001>nul
@echo off
rem UTF-8 console first: task prompts and produced file names are Chinese, and the OEM code page
rem turns them into mojibake in this process's own log.
setlocal EnableExtensions

rem This file is what the specification's literal start command (`gateway --engine <id> --port
rem 6217`) resolves to on a delivered package, so it has to work on the machine INSTRUCTION.md
rem describes: Windows PowerShell 5.1, no Node.js installed, nothing on PATH, and the engines only
rem where the offline bundle put them. It used to be a bare `node dist\main.js`, which failed with
rem "'node' is not recognized" on exactly that machine.
rem
rem Resolution order mirrors Resolve-Node in scripts\pnp-local.ps1 minus the download and install
rem steps: this entry point prepares nothing, it only finds what the package already ships. An
rem explicitly exported variable always wins, so an operator override is never second-guessed.

set "PNP_BOOTSTRAP=%~dp0runtime\bootstrap"

rem ---- Node runtime -----------------------------------------------------------------------
set "PNP_NODE_EXE="
if defined PNP_NODE_HOME (
  if exist "%PNP_NODE_HOME%\node.exe" set "PNP_NODE_EXE=%PNP_NODE_HOME%\node.exe"
  if not defined PNP_NODE_EXE (
    echo [pnp] PNP_NODE_HOME does not contain node.exe: %PNP_NODE_HOME% 1>&2
    echo [pnp] Point it at a directory that contains node.exe, or clear it to use the bundled runtime. 1>&2
    exit /b 2
  )
)
if not defined PNP_NODE_EXE (
  rem Globbed, not pinned: the bundled version is recorded in toolchain.json and must not be
  rem duplicated here, where a bump would silently stop matching.
  for /d %%D in ("%PNP_BOOTSTRAP%\node-v*-win-x64") do (
    if not defined PNP_NODE_EXE if exist "%%~fD\node.exe" set "PNP_NODE_EXE=%%~fD\node.exe"
  )
)
if not defined PNP_NODE_EXE (
  for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "PNP_NODE_EXE=%%~$PATH:N"
)
if not defined PNP_NODE_EXE (
  echo [pnp] No Node.js runtime found. 1>&2
  echo [pnp] Expected the bundled runtime under "%PNP_BOOTSTRAP%\node-v^<version^>-win-x64\". 1>&2
  echo [pnp] Run "pnp.cmd bootstrap --engine ^<engineId^>" once to prepare it, or set PNP_NODE_HOME 1>&2
  echo [pnp] to a directory that contains node.exe ^(Node.js 24.19 or newer^). 1>&2
  exit /b 2
)

rem ---- Engines the offline bundle ships ---------------------------------------------------
rem Each Engine Pack reads only its own variables, so naming both here is safe whichever engine
rem --engine or AGENT_ENGINE selects. Without this the launcher was the only route that could
rem find a bundled engine, and `gateway.cmd` - the documented one - failed with
rem ENGINE_EXECUTABLE_NOT_FOUND on a package that carried the engine all along.
if not defined PNP_OPENCODE_EXE_PATH (
  for /d %%V in ("%PNP_BOOTSTRAP%\engines\opencode\*") do (
    if not defined PNP_OPENCODE_EXE_PATH if exist "%%~fV\node_modules\opencode-ai\bin\opencode.exe" set "PNP_OPENCODE_EXE_PATH=%%~fV\node_modules\opencode-ai\bin\opencode.exe"
    if not defined PNP_OPENCODE_EXE_PATH if exist "%%~fV\node_modules\opencode-windows-x64\bin\opencode.exe" set "PNP_OPENCODE_EXE_PATH=%%~fV\node_modules\opencode-windows-x64\bin\opencode.exe"
    if not defined PNP_OPENCODE_EXE_PATH if exist "%%~fV\node_modules\opencode-windows-x64-baseline\bin\opencode.exe" set "PNP_OPENCODE_EXE_PATH=%%~fV\node_modules\opencode-windows-x64-baseline\bin\opencode.exe"
  )
)
if not defined PNP_PI_ENTRY (
  for /d %%V in ("%PNP_BOOTSTRAP%\engines\pi\*") do (
    if not defined PNP_PI_ENTRY if exist "%%~fV\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js" set "PNP_PI_ENTRY=%%~fV\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"
  )
)
rem pi is a Node entry script, not an executable: it needs an interpreter, and the one this
rem gateway itself runs on is the one the package guarantees exists.
if defined PNP_PI_ENTRY if not defined PNP_PI_NODE set "PNP_PI_NODE=%PNP_NODE_EXE%"

rem ---- Compiled gateway -------------------------------------------------------------------
if not exist "%~dp0dist\main.js" (
  echo [pnp] Missing "%~dp0dist\main.js" ^(the compiled gateway^). 1>&2
  echo [pnp] A delivered package ships it. From a source checkout, run 1>&2
  echo [pnp] "pnp.cmd bootstrap --engine ^<engineId^>" once to install dependencies and build. 1>&2
  exit /b 2
)

"%PNP_NODE_EXE%" "%~dp0dist\main.js" %*
exit /b %ERRORLEVEL%
