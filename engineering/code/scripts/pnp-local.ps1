[CmdletBinding()]
param(
  [ValidateSet("start", "bootstrap", "help")]
  [string]$Mode = "start",
  [string]$Engine = "",
  [int]$Port = 6217,
  [string]$BindHost = "localhost"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$CodeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RuntimeRoot = Join-Path $CodeRoot "runtime"
$BootstrapRoot = Join-Path $RuntimeRoot "bootstrap"
$PinnedNodeVersion = "24.19.0"
$PinnedNodeArchive = "node-v24.19.0-win-x64.zip"
$PinnedNodeSha256 = "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73"
$PinnedNodeUrl = "https://nodejs.org/dist/v24.19.0/$PinnedNodeArchive"

function Write-Step([string]$Message) {
  Write-Host "[pnp] $Message"
}

function Fail([string]$Message) {
  throw "[pnp] $Message"
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments, [string]$Label) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "$Label failed with exit code $LASTEXITCODE."
  }
}

function Read-LocalEnvironment([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }

  $loaded = New-Object System.Collections.Generic.List[string]
  foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $line = $rawLine.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith("#")) {
      continue
    }

    $separator = $line.IndexOf("=")
    if ($separator -le 0) {
      Fail "Invalid local environment line in '$Path': expected NAME=VALUE."
    }

    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim()
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      Fail "Invalid environment variable name '$name' in '$Path'."
    }

    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    [Environment]::SetEnvironmentVariable($name, $value, "Process")
    $loaded.Add($name)
  }

  if ($loaded.Count -gt 0) {
    Write-Step "Loaded local environment variable names from ${Path}: $($loaded -join ', '). Values are not printed."
  }
}

function Resolve-LocalPath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $Value
  }
  if ([System.IO.Path]::IsPathRooted($Value)) {
    return [System.IO.Path]::GetFullPath($Value)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $CodeRoot $Value))
}

function Test-NodeVersion([string]$NodeExe) {
  if ([string]::IsNullOrWhiteSpace($NodeExe) -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
    return $null
  }

  try {
    $version = (& $NodeExe -p "process.versions.node" 2>$null | Select-Object -First 1).Trim()
  } catch {
    return $null
  }
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^(\d+)\.(\d+)\.(\d+)') {
    return $null
  }

  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  if ($major -ne 24 -or $minor -lt 19) {
    return $null
  }

  return $version
}

function Resolve-SystemNode {
  if (-not [string]::IsNullOrWhiteSpace($env:PNP_NODE_HOME)) {
    $candidate = Join-Path (Resolve-LocalPath $env:PNP_NODE_HOME) "node.exe"
    $version = Test-NodeVersion $candidate
    if ($null -eq $version) {
      Fail "PNP_NODE_HOME does not contain a compatible Node.js 24.19+ runtime: $candidate"
    }
    return @{ Exe = $candidate; Version = $version; Source = "PNP_NODE_HOME" }
  }

  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    $version = Test-NodeVersion $command.Source
    if ($null -ne $version) {
      return @{ Exe = $command.Source; Version = $version; Source = "PATH" }
    }
  }

  return $null
}

function Ensure-PinnedNode {
  if (-not [Environment]::Is64BitOperatingSystem) {
    Fail "The competition target is Windows x64; automatic Node bootstrap requires a 64-bit Windows host."
  }

  $nodeHome = Join-Path $BootstrapRoot "node-v$PinnedNodeVersion-win-x64"
  $nodeExe = Join-Path $nodeHome "node.exe"
  $existingVersion = Test-NodeVersion $nodeExe
  if ($null -ne $existingVersion) {
    return @{ Exe = $nodeExe; Version = $existingVersion; Source = "PNP runtime cache" }
  }

  New-Item -ItemType Directory -Force -Path $BootstrapRoot | Out-Null
  $downloads = Join-Path $BootstrapRoot "downloads"
  New-Item -ItemType Directory -Force -Path $downloads | Out-Null
  $archive = Join-Path $downloads $PinnedNodeArchive
  $downloadUrl = if ([string]::IsNullOrWhiteSpace($env:PNP_NODE_DOWNLOAD_URL)) { $PinnedNodeUrl } else { $env:PNP_NODE_DOWNLOAD_URL }

  $needDownload = $true
  if (Test-Path -LiteralPath $archive -PathType Leaf) {
    $existingHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $needDownload = $existingHash -ne $PinnedNodeSha256
    if ($needDownload) {
      Remove-Item -LiteralPath $archive -Force
    }
  }

  if ($needDownload) {
    Write-Step "Downloading pinned Node.js $PinnedNodeVersion from $downloadUrl"
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -Uri $downloadUrl -OutFile $archive -UseBasicParsing
    } catch {
      Fail "Node.js download failed. Install Node.js 24.19+ yourself, set PNP_NODE_HOME, or point PNP_NODE_DOWNLOAD_URL at an internal mirror. $($_.Exception.Message)"
    }
  }

  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $PinnedNodeSha256) {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    Fail "Downloaded Node.js archive failed SHA256 verification. Expected $PinnedNodeSha256, got $actualHash."
  }

  Write-Step "Expanding pinned Node.js runtime"
  if (Test-Path -LiteralPath $nodeHome) {
    Remove-Item -LiteralPath $nodeHome -Recurse -Force
  }
  Expand-Archive -LiteralPath $archive -DestinationPath $BootstrapRoot -Force

  $version = Test-NodeVersion $nodeExe
  if ($null -eq $version) {
    Fail "Pinned Node.js runtime did not bootstrap correctly at $nodeExe"
  }
  return @{ Exe = $nodeExe; Version = $version; Source = "downloaded pinned runtime" }
}

function Resolve-Npm([string]$NodeExe) {
  $nodeHome = Split-Path -Parent $NodeExe
  $sibling = Join-Path $nodeHome "npm.cmd"
  if (Test-Path -LiteralPath $sibling -PathType Leaf) {
    return $sibling
  }

  $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    return $command.Source
  }
  Fail "npm.cmd was not found next to Node.js or on PATH."
}

function Ensure-ProjectDependencies([string]$NodeVersion, [string]$NpmCmd) {
  $lockFile = Join-Path $CodeRoot "package-lock.json"
  if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf)) {
    Fail "package-lock.json is missing; deterministic bootstrap is not possible."
  }

  $lockHash = (Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash.ToLowerInvariant()
  $stampDirectory = Join-Path $BootstrapRoot "state"
  $stampFile = Join-Path $stampDirectory "project-dependencies.txt"
  $expectedStamp = "$NodeVersion`n$lockHash"
  $nodeModules = Join-Path $CodeRoot "node_modules"
  $currentStamp = if (Test-Path -LiteralPath $stampFile -PathType Leaf) { (Get-Content -LiteralPath $stampFile -Raw).TrimEnd() } else { "" }

  if (-not (Test-Path -LiteralPath $nodeModules -PathType Container) -or $currentStamp -ne $expectedStamp) {
    Write-Step "Installing project dependencies with npm ci"
    Push-Location $CodeRoot
    try {
      Invoke-Checked $NpmCmd @("ci", "--no-audit", "--no-fund") "npm ci"
    } finally {
      Pop-Location
    }
    New-Item -ItemType Directory -Force -Path $stampDirectory | Out-Null
    Set-Content -LiteralPath $stampFile -Value $expectedStamp -Encoding ASCII
  } else {
    Write-Step "Project dependencies already match package-lock.json; reusing node_modules."
  }
}

function Resolve-PackageExecutable([string]$EngineHome, [string]$PackageName, [string]$PreferredCommand) {
  $packagePath = Join-Path (Join-Path $EngineHome "node_modules") ($PackageName -replace '/', '\\')
  $packageJsonPath = Join-Path $packagePath "package.json"
  if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
    return $null
  }

  $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -eq $packageJson.bin) {
    return $null
  }

  $relative = $null
  if ($packageJson.bin -is [string]) {
    $relative = [string]$packageJson.bin
  } else {
    $properties = @($packageJson.bin.PSObject.Properties)
    $preferred = $properties | Where-Object { $_.Name -eq $PreferredCommand } | Select-Object -First 1
    if ($null -eq $preferred) {
      $preferred = $properties | Select-Object -First 1
    }
    if ($null -ne $preferred) {
      $relative = [string]$preferred.Value
    }
  }

  if ([string]::IsNullOrWhiteSpace($relative)) {
    return $null
  }
  return [System.IO.Path]::GetFullPath((Join-Path $packagePath $relative))
}

function Ensure-EngineDependency([string]$SelectedEngine, [string]$NpmCmd) {
  if ($SelectedEngine -eq "mock") {
    return
  }

  $configPath = Join-Path $CodeRoot "config\engines\$SelectedEngine.json"
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Fail "No Engine config exists for '$SelectedEngine'."
  }

  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $environmentVariable = [string]$config.executable.exe.environmentVariable
  $providedExecutable = if ([string]::IsNullOrWhiteSpace($environmentVariable)) { $null } else { [Environment]::GetEnvironmentVariable($environmentVariable) }
  if (-not [string]::IsNullOrWhiteSpace($providedExecutable)) {
    $providedExecutable = Resolve-LocalPath $providedExecutable
    if (-not (Test-Path -LiteralPath $providedExecutable -PathType Leaf)) {
      Fail "$environmentVariable points to a missing executable: $providedExecutable"
    }
    Write-Step "Using preconfigured $SelectedEngine executable from $environmentVariable."
    [Environment]::SetEnvironmentVariable($environmentVariable, $providedExecutable, "Process")
    return
  }

  if ([string]$config.distribution.kind -ne "npm-global-native-binary") {
    Fail "Engine '$SelectedEngine' has no automatic local installer yet (distribution kind: $($config.distribution.kind)). Set its executable environment variable or use gateway.cmd after the judge/operator installs the required dependency."
  }

  $packageCandidates = @($config.distribution.packageNameCandidates)
  if ($packageCandidates.Count -eq 0) {
    Fail "Engine '$SelectedEngine' declares no npm package candidate for bootstrap."
  }
  $packageName = [string]$packageCandidates[0]
  $version = [string]$config.engineVersion
  if ([string]::IsNullOrWhiteSpace($packageName) -or [string]::IsNullOrWhiteSpace($version)) {
    Fail "Engine '$SelectedEngine' is missing package or version bootstrap metadata."
  }

  $engineHome = Join-Path $BootstrapRoot "engines\$SelectedEngine\$version"
  $executable = Resolve-PackageExecutable $engineHome $packageName $SelectedEngine
  $needInstall = $null -eq $executable -or -not (Test-Path -LiteralPath $executable -PathType Leaf)

  if ($needInstall) {
    Write-Step "Installing $SelectedEngine $version into the PNP runtime cache ($packageName@$version)"
    New-Item -ItemType Directory -Force -Path $engineHome | Out-Null
    Invoke-Checked $NpmCmd @("install", "--prefix", $engineHome, "--no-save", "--package-lock=false", "--no-audit", "--no-fund", "$packageName@$version") "$SelectedEngine install"
    $executable = Resolve-PackageExecutable $engineHome $packageName $SelectedEngine
  } else {
    Write-Step "$SelectedEngine $version already exists in the PNP runtime cache."
  }

  if ($null -eq $executable -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    Fail "The $packageName package did not expose a usable executable after installation."
  }

  $reportedVersion = (& $executable --version 2>$null | Select-Object -First 1).Trim()
  if ($LASTEXITCODE -ne 0 -or $reportedVersion -notmatch [regex]::Escape($version)) {
    Fail "$SelectedEngine executable version check failed. Expected $version, got '$reportedVersion'."
  }

  [Environment]::SetEnvironmentVariable($environmentVariable, $executable, "Process")
  Write-Step "$SelectedEngine executable ready at $executable"
}

function Show-Help {
  @"
PNP local bootstrap launcher

Usage:
  .\pnp.cmd start --engine <id> [--port 6217] [--host localhost]
  .\pnp.cmd bootstrap --engine <id>
  .\pnp.cmd help

Examples:
  .\pnp.cmd start --engine opencode --port 6217
  .\pnp.cmd bootstrap --engine opencode

The competition engine switch is the required --engine startup argument. The launcher does not
choose a default engine. The lower-level gateway still understands AGENT_ENGINE for compatibility,
but pnp.cmd always forwards the explicit engine as --engine.

Local configuration:
  - runtime\local.env is loaded automatically when present.
  - PNP_LOCAL_ENV_FILE can point at another env file.
  - Relative PNP_SETTINGS paths in that env file are resolved from engineering\code.
  - npm_config_registry is honored, so an internal npm mirror can be used without changing PNP.
  - PNP_NODE_DOWNLOAD_URL can point at an internal mirror of the pinned Node.js ZIP.

The launcher never writes model API keys into the repository. Model credentials still come from
process environment variables referenced by settings.json.
"@ | Write-Host
}

if ($Mode -eq "help") {
  Show-Help
  exit 0
}

if ($Port -lt 1 -or $Port -gt 65535) {
  Fail "Port must be between 1 and 65535."
}
if ([string]::IsNullOrWhiteSpace($Engine)) {
  Fail "Missing required startup argument: --engine <engineId>."
}
if (@("127.0.0.1", "localhost", "::1") -notcontains $BindHost) {
  Fail "Host must be a loopback address: localhost, 127.0.0.1, or ::1."
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
$localEnvFile = if ([string]::IsNullOrWhiteSpace($env:PNP_LOCAL_ENV_FILE)) { Join-Path $RuntimeRoot "local.env" } else { Resolve-LocalPath $env:PNP_LOCAL_ENV_FILE }
Read-LocalEnvironment $localEnvFile

if (-not [string]::IsNullOrWhiteSpace($env:AGENT_ENGINE) -and $env:AGENT_ENGINE -ne $Engine) {
  Fail "--engine and AGENT_ENGINE disagree. Clear AGENT_ENGINE or make it match the startup parameter."
}
if (-not [string]::IsNullOrWhiteSpace($env:PNP_SETTINGS)) {
  $env:PNP_SETTINGS = Resolve-LocalPath $env:PNP_SETTINGS
}
if ([string]::IsNullOrWhiteSpace($env:PNP_DATA_DIR)) {
  $env:PNP_DATA_DIR = Join-Path $RuntimeRoot "data\$Engine"
} else {
  $env:PNP_DATA_DIR = Resolve-LocalPath $env:PNP_DATA_DIR
}
New-Item -ItemType Directory -Force -Path $env:PNP_DATA_DIR | Out-Null

if ($Engine -eq "mock") {
  $env:PNP_MODE = "development"
  $env:PNP_INTEGRATION = "mock"
}

$node = Resolve-SystemNode
if ($null -eq $node) {
  $node = Ensure-PinnedNode
}
$nodeExe = [string]$node.Exe
$nodeVersion = [string]$node.Version
$nodeHome = Split-Path -Parent $nodeExe
$env:PATH = "$nodeHome;$env:PATH"
$npmCmd = Resolve-Npm $nodeExe
Write-Step "Using Node.js $nodeVersion from $($node.Source)."

Ensure-ProjectDependencies $nodeVersion $npmCmd
Write-Step "Building PNP Gateway"
Push-Location $CodeRoot
try {
  Invoke-Checked $npmCmd @("run", "build") "PNP build"
} finally {
  Pop-Location
}

Ensure-EngineDependency $Engine $npmCmd

if ($Mode -eq "bootstrap") {
  Write-Step "Bootstrap complete for engine '$Engine'."
  exit 0
}

$gatewayEntry = Join-Path $CodeRoot "dist\main.js"
if (-not (Test-Path -LiteralPath $gatewayEntry -PathType Leaf)) {
  Fail "Gateway build output is missing at $gatewayEntry"
}

Write-Step "Starting Gateway: engine=$Engine, port=$Port, host=$BindHost, data=$($env:PNP_DATA_DIR)"
if (Test-Path -LiteralPath $localEnvFile -PathType Leaf) {
  Write-Step "Local env source: $localEnvFile"
}
Write-Step "Model secrets are not printed. Press Ctrl+C to stop."

& $nodeExe $gatewayEntry --engine $Engine --port $Port --host $BindHost
exit $LASTEXITCODE
