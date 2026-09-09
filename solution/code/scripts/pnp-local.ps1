[CmdletBinding()]
param(
  [ValidateSet("start", "bootstrap", "selfcheck", "livecheck", "config", "stop", "help")]
  [string]$Mode = "start",
  [string]$Engine = "",
  [int]$Port = 6217,
  [string]$BindHost = "localhost",
  # livecheck only: the absolute working directory the session is created with.
  [string]$Directory = "",
  # config only: the non-interactive answers. An empty one means "ask", or "leave the file's line
  # as it is" for the two optional variables.
  [string]$Endpoint = "",
  [string]$ModelId = "",
  [string]$ApiKey = "",
  [string]$Headers = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$CodeRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RuntimeRoot = Join-Path $CodeRoot "runtime"
$BootstrapRoot = Join-Path $RuntimeRoot "bootstrap"
$StateRoot = Join-Path $BootstrapRoot "state"
$LogRoot = Join-Path $RuntimeRoot "logs"
$PidFile = Join-Path $RuntimeRoot "gateway.pid"
$PinnedNodeVersion = "24.19.0"
$PinnedNodeArchive = "node-v24.19.0-win-x64.zip"
$PinnedNodeSha256 = "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73"
$PinnedNodeUrl = "https://nodejs.org/dist/v24.19.0/$PinnedNodeArchive"
# The offline bundle ships this exact directory, so it is probed before PATH and long before any
# download: a delivered package must reach a running gateway with the network unplugged.
$BundledNodeHome = Join-Path $BootstrapRoot "node-v$PinnedNodeVersion-win-x64"
# A native engine binary is tens of megabytes. opencode-ai's bin/opencode.exe is a ~479-byte shell
# stub until its postinstall replaces it, and the offline bundle installs with --ignore-scripts on
# purpose, so "does this file exist" is not enough to call an executable resolved.
$MinimumNativeExecutableBytes = 1MB

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

<#
  Runs a command and returns ALL of its output plus the exit code.
  Piping a live process into `Select-Object -First 1` closes its standard output as soon as the
  first line arrives, which on a GitHub windows-latest runner turned a correct "1.18.29" into a
  non-zero exit code and failed a version check against the engine's own answer. Everything is
  collected first; only then is it inspected.
#>
function Invoke-Capture([string]$Executable, [string[]]$Arguments) {
  # Windows PowerShell turns a native command's stderr into error records when it is merged with
  # 2>&1, and the script-wide "Stop" preference would then abort on a program that merely printed a
  # warning. The preference is relaxed for the duration of this call only (preference variables are
  # dynamically scoped), so the exit code stays the verdict and the text stays diagnostic.
  $ErrorActionPreference = "Continue"
  $output = @(& $Executable @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  $text = (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
  return @{ ExitCode = $exitCode; Text = $text }
}

function Assert-Npm([string]$NpmCmd, [string]$Purpose) {
  if ([string]::IsNullOrWhiteSpace($NpmCmd)) {
    Fail "$Purpose requires npm, and npm.cmd was found neither next to Node.js nor on PATH. Use the offline bundle (which needs no npm), or install Node.js 24.19+ and set PNP_NODE_HOME to its directory."
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

function Get-OptionalProperty($Object, [string]$Name) {
  if ($null -eq $Object) {
    return $null
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Read-StampValues([string]$Path) {
  $values = @{}
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $values
  }
  foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $line = $rawLine.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith("#")) { continue }
    $separator = $line.IndexOf("=")
    if ($separator -le 0) { continue }
    $values[$line.Substring(0, $separator).Trim()] = $line.Substring($separator + 1).Trim()
  }
  return $values
}

function Get-StampValue($Values, [string]$Name) {
  if ($null -eq $Values -or -not $Values.ContainsKey($Name)) { return "" }
  return [string]$Values[$Name]
}

function Write-Stamp([string]$Path, [string[]]$Lines) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  Set-Content -LiteralPath $Path -Value $Lines -Encoding ASCII
}

function Test-NodeVersion([string]$NodeExe) {
  if ([string]::IsNullOrWhiteSpace($NodeExe) -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
    return $null
  }

  $result = $null
  try {
    $result = Invoke-Capture $NodeExe @("-p", "process.versions.node")
  } catch {
    return $null
  }
  $version = $result.Text
  if ($result.ExitCode -ne 0 -or $version -notmatch '^(\d+)\.(\d+)\.(\d+)') {
    return $null
  }

  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  if ($major -ne 24 -or $minor -lt 19) {
    return $null
  }

  return $version
}

function Resolve-BundledNode {
  $nodeExe = Join-Path $BundledNodeHome "node.exe"
  $version = Test-NodeVersion $nodeExe
  if ($null -eq $version) {
    return $null
  }
  return @{ Exe = $nodeExe; Version = $version; Source = "bundled runtime (runtime\bootstrap)" }
}

function Resolve-PathNode {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return $null
  }
  $version = Test-NodeVersion $command.Source
  if ($null -eq $version) {
    return $null
  }
  return @{ Exe = $command.Source; Version = $version; Source = "PATH" }
}

function Ensure-PinnedNode {
  if (-not [Environment]::Is64BitOperatingSystem) {
    Fail "The competition target is Windows x64; automatic Node bootstrap requires a 64-bit Windows host."
  }

  $nodeExe = Join-Path $BundledNodeHome "node.exe"
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
      Fail "Node.js download failed. Install Node.js 24.19+ yourself and set PNP_NODE_HOME, point PNP_NODE_DOWNLOAD_URL at an internal mirror of $PinnedNodeArchive, or use the offline bundle that ships runtime\bootstrap\node-v$PinnedNodeVersion-win-x64. $($_.Exception.Message)"
    }
  }

  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $PinnedNodeSha256) {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    Fail "Downloaded Node.js archive failed SHA256 verification. Expected $PinnedNodeSha256, got $actualHash. Point PNP_NODE_DOWNLOAD_URL at a mirror of the official $PinnedNodeArchive."
  }

  Write-Step "Expanding pinned Node.js runtime"
  if (Test-Path -LiteralPath $BundledNodeHome) {
    Remove-Item -LiteralPath $BundledNodeHome -Recurse -Force
  }
  Expand-Archive -LiteralPath $archive -DestinationPath $BootstrapRoot -Force

  $version = Test-NodeVersion $nodeExe
  if ($null -eq $version) {
    Fail "Pinned Node.js runtime did not bootstrap correctly at $nodeExe. Delete $BundledNodeHome and retry, or install Node.js 24.19+ yourself and set PNP_NODE_HOME to its directory."
  }
  return @{ Exe = $nodeExe; Version = $version; Source = "downloaded pinned runtime" }
}

<#
  Node lookup order, offline-first:
    1. PNP_NODE_HOME              - the operator's explicit answer, and an error when it is wrong.
    2. runtime\bootstrap\node-*   - what the offline bundle ships; no network, no PATH, no surprise.
    3. node.exe on PATH           - only when it is 24.19 or newer within major 24.
    4. download the pinned ZIP    - last resort, SHA-256 verified, mirrorable.
#>
function Resolve-Node {
  if (-not [string]::IsNullOrWhiteSpace($env:PNP_NODE_HOME)) {
    $candidate = Join-Path (Resolve-LocalPath $env:PNP_NODE_HOME) "node.exe"
    $version = Test-NodeVersion $candidate
    if ($null -eq $version) {
      Fail "PNP_NODE_HOME does not contain a compatible Node.js 24.19+ runtime: $candidate. Set PNP_NODE_HOME to a directory that contains node.exe, or clear it to use the bundled runtime."
    }
    return @{ Exe = $candidate; Version = $version; Source = "PNP_NODE_HOME" }
  }

  $bundled = Resolve-BundledNode
  if ($null -ne $bundled) {
    return $bundled
  }

  $onPath = Resolve-PathNode
  if ($null -ne $onPath) {
    return $onPath
  }

  return Ensure-PinnedNode
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
  Fail "npm.cmd was not found next to Node.js or on PATH. Use the offline bundle (which needs no npm), or install Node.js 24.19+ and set PNP_NODE_HOME."
}

<#
  Dependencies are reused whenever node_modules exists and the stamp still describes this
  package-lock.json under this Node major version. The offline bundle ships both node_modules and
  the stamp, so `npm ci` - and with it the network - is skipped entirely.
#>
function Ensure-ProjectDependencies([string]$NodeVersion, [string]$NpmCmd) {
  $lockFile = Join-Path $CodeRoot "package-lock.json"
  if (-not (Test-Path -LiteralPath $lockFile -PathType Leaf)) {
    Fail "package-lock.json is missing at $lockFile; a deterministic install is not possible. Restore it from the delivered package, or use the delivered package, which ships node_modules already installed."
  }

  $lockHash = (Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash.ToLowerInvariant()
  $nodeMajor = ($NodeVersion -split '\.')[0]
  $stampFile = Join-Path $StateRoot "project-dependencies.txt"
  $nodeModules = Join-Path $CodeRoot "node_modules"
  $stamp = Read-StampValues $stampFile

  if ((Test-Path -LiteralPath $nodeModules -PathType Container) -and (Get-StampValue $stamp "lock") -eq $lockHash -and (Get-StampValue $stamp "node-major") -eq $nodeMajor) {
    $scope = Get-StampValue $stamp "scope"
    $scopeLabel = if ([string]::IsNullOrWhiteSpace($scope)) { "unknown" } else { $scope }
    Write-Step "Dependencies already match package-lock.json (scope: $scopeLabel); reusing node_modules."
    return
  }

  Assert-Npm $NpmCmd "Installing project dependencies"
  Write-Step "Installing project dependencies with npm ci"
  Push-Location $CodeRoot
  try {
    Invoke-Checked $NpmCmd @("ci", "--no-audit", "--no-fund") "npm ci"
  } finally {
    Pop-Location
  }
  Write-Stamp $stampFile @("lock=$lockHash", "node-major=$nodeMajor", "scope=full", "source=launcher")
}

<#
  The build is reused whenever dist\main.js exists and the shipped source stamp still matches the
  sources on disk. Timestamps cannot be used for this: an extracted ZIP has arbitrary mtimes, so a
  freshly delivered package would always look "stale". scripts\source-stamp.mjs computes the same
  content fingerprint for the packager and for this launcher.
#>
function Ensure-Build([string]$NodeExe, [string]$NpmCmd) {
  $entry = Join-Path $CodeRoot "dist\main.js"
  $stampFile = Join-Path $StateRoot "build.txt"
  $stampScript = Join-Path $CodeRoot "scripts\source-stamp.mjs"

  $expected = ""
  if (Test-Path -LiteralPath $stampScript -PathType Leaf) {
    $result = Invoke-Capture $NodeExe @($stampScript)
    if ($result.ExitCode -eq 0 -and $result.Text -match '^[a-f0-9]{64}$') {
      $expected = $result.Text
    }
  }

  if ((Test-Path -LiteralPath $entry -PathType Leaf) -and $expected -ne "" -and (Get-StampValue (Read-StampValues $stampFile) "source") -eq $expected) {
    Write-Step "Build output already matches the sources; reusing dist."
    return
  }

  if (-not (Test-Path -LiteralPath (Join-Path $CodeRoot "node_modules\typescript") -PathType Container)) {
    Fail "dist\main.js is missing or out of date and the TypeScript compiler is not installed (node_modules\typescript). The delivered bundle ships a matching dist; if you changed code\src, install the development dependencies first (npm install, honouring npm_config_registry for an internal mirror)."
  }

  Assert-Npm $NpmCmd "Compiling the gateway"
  Write-Step "Building PNP Gateway"
  Push-Location $CodeRoot
  try {
    Invoke-Checked $NpmCmd @("run", "build") "PNP build"
  } finally {
    Pop-Location
  }
  if ($expected -ne "") {
    Write-Stamp $stampFile @("source=$expected", "source-tool=scripts/source-stamp.mjs")
  }
}

function Test-NativeExecutable([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  return (Get-Item -LiteralPath $Path).Length -ge $MinimumNativeExecutableBytes
}

<#
  Finds the real native engine binary inside an install prefix.

  The package's declared `bin` is probed first and every sibling package's `bin\<same file name>`
  after it, because an install made with --ignore-scripts leaves the declared bin behind as a stub:
  opencode-ai's postinstall - the step that copies the platform binary over bin/opencode.exe - does
  not run in the offline bundle, and what stays there is a ~479-byte script that only prints
  "postinstall script was not run". The size check is what tells the two apart, and the sibling
  scan is what finds the real one (opencode-windows-x64\bin\opencode.exe) without depending on a
  lifecycle script having run. Baseline builds sort last: they are the fallback for a CPU without
  AVX2, not the preferred binary.
#>
function Resolve-PackageExecutable([string]$EngineHome, [string]$PackageName, [string]$PreferredCommand) {
  $modulesRoot = Join-Path $EngineHome "node_modules"
  if (-not (Test-Path -LiteralPath $modulesRoot -PathType Container)) {
    return $null
  }

  $packagePath = Join-Path $modulesRoot ($PackageName -replace '/', '\')
  $packageJsonPath = Join-Path $packagePath "package.json"
  $relative = $null
  if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
    $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $bin = Get-OptionalProperty $packageJson "bin"
    if ($null -ne $bin) {
      if ($bin -is [string]) {
        $relative = [string]$bin
      } else {
        [object[]]$properties = @($bin.PSObject.Properties)
        $preferred = $null
        foreach ($property in $properties) {
          if ($property.Name -eq $PreferredCommand) { $preferred = $property; break }
        }
        if ($null -eq $preferred -and $properties.Count -gt 0) { $preferred = $properties[0] }
        if ($null -ne $preferred) { $relative = [string]$preferred.Value }
      }
    }
  }

  $candidates = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($relative)) {
    $candidates.Add([System.IO.Path]::GetFullPath((Join-Path $packagePath $relative)))
  }
  $binName = if ([string]::IsNullOrWhiteSpace($relative)) { "$PreferredCommand.exe" } else { Split-Path -Leaf $relative }
  $siblings = @(Get-ChildItem -LiteralPath $modulesRoot -Directory -ErrorAction SilentlyContinue | Sort-Object @{ Expression = { $_.Name -like "*baseline*" } }, Name)
  foreach ($sibling in $siblings) {
    $candidates.Add((Join-Path (Join-Path $sibling.FullName "bin") $binName))
  }

  foreach ($candidate in $candidates) {
    if (Test-NativeExecutable $candidate) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }
  return $null
}

<#
  Engine lookup order: the operator's explicit PNP_* variables, then the copy under
  runtime\bootstrap\engines\<id>\<version> (which the offline bundle ships), then an npm install
  into that same directory. Only the third step needs a network.

  This function is deliberately self-contained apart from the small shared helpers, because the
  launcher contract test drives it directly with stubs for those helpers.
#>
function Ensure-EngineDependency([string]$SelectedEngine, [string]$NpmCmd, [string]$NodeExe) {
  if ($SelectedEngine -eq "mock") {
    return
  }

  $configPath = Join-Path $CodeRoot "config\engines\$SelectedEngine.json"
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Fail "No Engine config exists for '$SelectedEngine' at $configPath. The supported ids are the file names under code\config\engines."
  }

  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $distribution = Get-OptionalProperty $config "distribution"
  $distributionKind = [string](Get-OptionalProperty $distribution "kind")
  $version = [string](Get-OptionalProperty $config "engineVersion")
  $packageCandidatesValue = Get-OptionalProperty $distribution "packageNameCandidates"
  # Keep the collection typed outside conditional/pipeline assignment: PowerShell unwraps a
  # one-element result into a scalar, and StrictMode then rejects `.Count` on that scalar.
  [object[]]$packageCandidates = @()
  if ($null -ne $packageCandidatesValue) {
    $packageCandidates = @($packageCandidatesValue)
  }

  if ($SelectedEngine -eq "pi") {
    $providedPiExecutable = [Environment]::GetEnvironmentVariable("PNP_PI_EXECUTABLE")
    if (-not [string]::IsNullOrWhiteSpace($providedPiExecutable)) {
      $providedPiExecutable = Resolve-LocalPath $providedPiExecutable
      if (-not (Test-Path -LiteralPath $providedPiExecutable -PathType Leaf)) {
        Fail "PNP_PI_EXECUTABLE points to a missing executable: $providedPiExecutable"
      }
      [Environment]::SetEnvironmentVariable("PNP_PI_EXECUTABLE", $providedPiExecutable, "Process")
      Write-Step "Using the preconfigured Pi executable from PNP_PI_EXECUTABLE."
      return
    }

    $providedPiEntry = [Environment]::GetEnvironmentVariable("PNP_PI_ENTRY")
    if (-not [string]::IsNullOrWhiteSpace($providedPiEntry)) {
      $providedPiEntry = Resolve-LocalPath $providedPiEntry
      if (-not (Test-Path -LiteralPath $providedPiEntry -PathType Leaf)) {
        Fail "PNP_PI_ENTRY points to a missing Node entry file: $providedPiEntry"
      }
      $providedPiNode = [Environment]::GetEnvironmentVariable("PNP_PI_NODE")
      if ([string]::IsNullOrWhiteSpace($providedPiNode)) {
        $providedPiNode = $NodeExe
      } else {
        $providedPiNode = Resolve-LocalPath $providedPiNode
      }
      if (-not (Test-Path -LiteralPath $providedPiNode -PathType Leaf)) {
        Fail "PNP_PI_NODE points to a missing Node executable: $providedPiNode"
      }
      [Environment]::SetEnvironmentVariable("PNP_PI_ENTRY", $providedPiEntry, "Process")
      [Environment]::SetEnvironmentVariable("PNP_PI_NODE", $providedPiNode, "Process")
      Write-Step "Using the preconfigured Pi Node entry from PNP_PI_ENTRY."
      return
    }

    # Pi's launch target is a Node entry script, not a native binary: `npm install -g` only leaves a
    # .cmd shim on Windows and the shared ProcessHost refuses to spawn a shim, so the pair the
    # driver reads is PNP_PI_ENTRY (the script) plus PNP_PI_NODE (the interpreter).
    $entryRelative = [string](Get-OptionalProperty $distribution "entry")
    if ($distributionKind -ne "npm-node-entry" -or $packageCandidates.Count -eq 0 -or [string]::IsNullOrWhiteSpace($version) -or [string]::IsNullOrWhiteSpace($entryRelative)) {
      Fail "Pi has no locked installer metadata in $configPath, so this launcher will not guess or install a latest package. Preinstall Pi and set PNP_PI_EXECUTABLE, or set PNP_PI_ENTRY (and optionally PNP_PI_NODE) to its dist\bundle\cli.js."
    }

    $packageName = [string]$packageCandidates[0]
    $engineHome = Join-Path $BootstrapRoot "engines\pi\$version"
    $entry = [System.IO.Path]::GetFullPath((Join-Path (Join-Path (Join-Path $engineHome "node_modules") ($packageName -replace '/', '\')) ($entryRelative -replace '/', '\')))

    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
      Assert-Npm $NpmCmd "Installing engine 'pi'"
      Write-Step "Installing pi $version into the PNP runtime cache ($packageName@$version)"
      New-Item -ItemType Directory -Force -Path $engineHome | Out-Null
      # --ignore-scripts: the launch target is a plain Node script, so no lifecycle script has to
      # run to make it usable, and skipping them keeps this install identical to the bundled one.
      Invoke-Checked $NpmCmd @("install", "--prefix", $engineHome, "--no-save", "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund", "$packageName@$version") "pi install"
    } else {
      Write-Step "pi $version already exists in the PNP runtime cache."
    }

    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
      Fail "The $packageName package did not provide $entryRelative under $engineHome. Install Pi manually and set PNP_PI_ENTRY to its dist\bundle\cli.js."
    }

    # The whole output is collected before it is judged; see the note on the native check below.
    $piOutput = @(& $NodeExe $entry --version 2>$null)
    $piExit = $LASTEXITCODE
    $piVersion = (($piOutput | ForEach-Object { [string]$_ }) -join "`n").Trim()
    if ($piExit -ne 0 -or $piVersion -notmatch [regex]::Escape($version)) {
      Fail "pi version check failed. Expected $version, got '$piVersion' (exit code $piExit). Delete $engineHome and retry, or set PNP_PI_ENTRY to a verified install."
    }

    [Environment]::SetEnvironmentVariable("PNP_PI_ENTRY", $entry, "Process")
    [Environment]::SetEnvironmentVariable("PNP_PI_NODE", $NodeExe, "Process")
    Write-Step "pi entry ready at $entry (Node: $NodeExe)"
    return
  }

  $executableConfig = Get-OptionalProperty $config "executable"
  $exeConfig = Get-OptionalProperty $executableConfig "exe"
  $environmentVariable = [string](Get-OptionalProperty $exeConfig "environmentVariable")
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

  if ($distributionKind -ne "npm-global-native-binary") {
    $kindLabel = if ([string]::IsNullOrWhiteSpace($distributionKind)) { "not declared" } else { $distributionKind }
    Fail "Engine '$SelectedEngine' has no automatic local installer yet (distribution kind: $kindLabel). Install it manually and set $environmentVariable to its executable."
  }
  if ($packageCandidates.Count -eq 0) {
    Fail "Engine '$SelectedEngine' declares no npm package candidate in $configPath. Install it yourself and set $environmentVariable to its executable."
  }
  $packageName = [string]$packageCandidates[0]
  if ([string]::IsNullOrWhiteSpace($packageName) -or [string]::IsNullOrWhiteSpace($version)) {
    Fail "Engine '$SelectedEngine' is missing package or version metadata in $configPath. Install it yourself and set $environmentVariable to its executable."
  }

  $engineHome = Join-Path $BootstrapRoot "engines\$SelectedEngine\$version"
  $executable = Resolve-PackageExecutable $engineHome $packageName $SelectedEngine

  if ($null -eq $executable) {
    Assert-Npm $NpmCmd "Installing engine '$SelectedEngine'"
    Write-Step "Installing $SelectedEngine $version into the PNP runtime cache ($packageName@$version)"
    New-Item -ItemType Directory -Force -Path $engineHome | Out-Null
    Invoke-Checked $NpmCmd @("install", "--prefix", $engineHome, "--no-save", "--package-lock=false", "--no-audit", "--no-fund", "$packageName@$version") "$SelectedEngine install"
    $executable = Resolve-PackageExecutable $engineHome $packageName $SelectedEngine
  } else {
    Write-Step "$SelectedEngine $version already exists in the PNP runtime cache."
  }

  if ($null -eq $executable) {
    Fail "The $packageName package did not expose a usable executable under $engineHome. Install $SelectedEngine manually and set $environmentVariable to its executable."
  }

  # The whole output is collected before the first line is read. Piping the live process into
  # Select-Object -First 1 stops the pipeline as soon as one line arrives and closes the
  # executable's standard output while it may still be writing; on windows-latest that turned a
  # correct "1.18.29" into a non-zero exit code and failed the check against its own answer.
  $versionOutput = @(& $executable --version 2>$null)
  $versionExit = $LASTEXITCODE
  $reportedVersion = (($versionOutput | ForEach-Object { [string]$_ }) -join "`n").Trim()
  if ($versionExit -ne 0 -or $reportedVersion -notmatch [regex]::Escape($version)) {
    Fail "$SelectedEngine executable version check failed. Expected $version, got '$reportedVersion' (exit code $versionExit). Delete $engineHome and retry, or set $environmentVariable to a verified install."
  }

  [Environment]::SetEnvironmentVariable($environmentVariable, $executable, "Process")
  Write-Step "$SelectedEngine executable ready at $executable"
}

function Stop-Gateway {
  if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
    Write-Step "No PID file at $PidFile; nothing to stop."
    return 0
  }

  $raw = (Get-Content -LiteralPath $PidFile -Raw).Trim()
  if ($raw -notmatch '^\d+$') {
    Fail "PID file $PidFile does not contain a process id. Delete it and stop the gateway from its own console with Ctrl+C."
  }
  $processId = [int]$raw

  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    Remove-Item -LiteralPath $PidFile -Force
    Write-Step "Process $processId is no longer running; removed the stale $PidFile."
    return 0
  }

  # Identity check before termination. Process ids are reused, so the recorded id is confirmed to
  # still be this gateway before anything is killed - and the kill is by that id alone. Terminating
  # by image name is forbidden: it would take out unrelated Node processes and any Office
  # application a task legitimately opened.
  $commandLine = ""
  try {
    $commandLine = [string](Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop).CommandLine
  } catch {
    $commandLine = ""
  }
  $isGateway = $false
  if ($commandLine -ne "") {
    $isGateway = $commandLine -match 'dist[\\/]main\.js'
  } else {
    $imagePath = ""
    try { $imagePath = [string]$process.Path } catch { $imagePath = "" }
    $isGateway = $imagePath -match '(^|[\\/])node\.exe$'
  }
  if (-not $isGateway) {
    Fail "Process $processId is not this gateway (image/command line does not match dist\main.js). Refusing to terminate it. Delete $PidFile if it is stale."
  }

  Write-Step "Stopping gateway process $processId"
  Stop-Process -Id $processId -Force -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline -and $null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 200
  }
  if ($null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
    Fail "Process $processId did not exit within 15 seconds. $PidFile was left in place for a retry."
  }
  Remove-Item -LiteralPath $PidFile -Force
  Write-Step "Gateway stopped; removed $PidFile."
  return 0
}

function Copy-NewOutput($Reader, [string]$Prefix) {
  if ($null -eq $Reader) { return }
  while ($true) {
    $line = $Reader.ReadLine()
    if ($null -eq $line) { break }
    if ($Prefix -eq "") { Write-Host $line } else { Write-Host "$Prefix$line" }
  }
}

function Open-Follow([string]$Path) {
  for ($attempt = 0; $attempt -lt 25; $attempt++) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      try {
        $stream = New-Object System.IO.FileStream($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
        return New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
      } catch {
        Start-Sleep -Milliseconds 100
      }
    } else {
      Start-Sleep -Milliseconds 100
    }
  }
  return $null
}

<#
  Starts the gateway as a child process whose id is recorded, and mirrors its output to both the
  console and runtime\logs\gateway-<engine>.log.

  Start-Process -PassThru -NoNewWindow is used for the id (that is the whole point of the PID file:
  `pnp.cmd stop` must terminate one known process, never everything called node.exe), but -Wait is
  deliberately NOT passed: with -Wait the call returns only after the gateway has already exited,
  which is far too late to write a PID file or to show a line of output. The wait happens below
  instead, while the two redirect files are tailed to this console. PowerShell cannot redirect both
  streams to one file, so stderr gets its own .err.log next to the main log.
#>
function Start-Gateway([string]$NodeExe, [string]$SelectedEngine, [int]$SelectedPort, [string]$SelectedHost, [string]$LocalEnvFile) {
  $gatewayEntry = Join-Path $CodeRoot "dist\main.js"
  if (-not (Test-Path -LiteralPath $gatewayEntry -PathType Leaf)) {
    Fail "Gateway build output is missing at $gatewayEntry. Run '.\pnp.cmd bootstrap --engine $SelectedEngine' first."
  }

  if (Test-Path -LiteralPath $PidFile -PathType Leaf) {
    $previous = (Get-Content -LiteralPath $PidFile -Raw).Trim()
    if ($previous -match '^\d+$' -and $null -ne (Get-Process -Id ([int]$previous) -ErrorAction SilentlyContinue)) {
      Fail "A gateway process ($previous) is already recorded in $PidFile. Run '.\pnp.cmd stop' first."
    }
    Remove-Item -LiteralPath $PidFile -Force
  }

  New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
  $stdoutLog = Join-Path $LogRoot "gateway-$SelectedEngine.log"
  $stderrLog = Join-Path $LogRoot "gateway-$SelectedEngine.err.log"

  Write-Step "Starting Gateway: engine=$SelectedEngine, port=$SelectedPort, host=$SelectedHost, data=$($env:PNP_DATA_DIR)"
  if (Test-Path -LiteralPath $LocalEnvFile -PathType Leaf) {
    Write-Step "Local env source: $LocalEnvFile"
  }
  Write-Step "Log: $stdoutLog (errors: $stderrLog)"
  Write-Step "Model secrets are not printed. Press Ctrl+C, or run '.\pnp.cmd stop' from another console."

  # Start-Process joins -ArgumentList with spaces and quotes nothing, so an extraction path such as
  # C:\Program Files\pnp would otherwise split dist\main.js into two arguments.
  $arguments = @($gatewayEntry, "--engine", $SelectedEngine, "--port", [string]$SelectedPort, "--host", $SelectedHost) |
    ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }
  $process = Start-Process -FilePath $NodeExe -ArgumentList $arguments -WorkingDirectory $CodeRoot -NoNewWindow -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
  Set-Content -LiteralPath $PidFile -Value ([string]$process.Id) -Encoding ASCII
  Write-Step "Gateway PID $($process.Id) recorded in $PidFile"

  $outReader = $null
  $errReader = $null
  try {
    $outReader = Open-Follow $stdoutLog
    $errReader = Open-Follow $stderrLog
    while (-not $process.HasExited) {
      Copy-NewOutput $outReader ""
      Copy-NewOutput $errReader ""
      Start-Sleep -Milliseconds 200
    }
    $process.WaitForExit()
    Start-Sleep -Milliseconds 200
    Copy-NewOutput $outReader ""
    Copy-NewOutput $errReader ""
  } finally {
    if ($null -ne $outReader) { $outReader.Dispose() }
    if ($null -ne $errReader) { $errReader.Dispose() }
    if (Test-Path -LiteralPath $PidFile -PathType Leaf) {
      $recorded = (Get-Content -LiteralPath $PidFile -Raw).Trim()
      if ($recorded -eq [string]$process.Id) {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
      }
    }
  }

  Write-Step "Gateway exited with code $($process.ExitCode)."
  return $process.ExitCode
}

<#
  One offline end-to-end proof: the smoke harness starts its own mock model service and its own
  gateway process, runs a real prompt round trip through the north-bound HTTP API and tears
  everything down again. No network and no model credentials are involved.
#>
function Invoke-SelfCheck([string]$NodeExe, [string]$SelectedEngine, [int]$SelectedPort) {
  $smoke = Join-Path $CodeRoot "scripts\e2e\ci-smoke.mjs"
  if (-not (Test-Path -LiteralPath $smoke -PathType Leaf)) {
    Fail "The self-check harness is missing at $smoke."
  }
  Write-Step "Running the offline self-check for engine '$SelectedEngine' on port $SelectedPort."
  # Out-Host, not the pipeline: the harness prints a lot, and its output must reach the console
  # rather than become this function's return value (which is the exit code).
  & $NodeExe $smoke --engine $SelectedEngine --gateway-port ([string]$SelectedPort) | Out-Host
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) {
    Write-Host "[pnp] SELFCHECK PASS (engine=$SelectedEngine)"
  } else {
    Write-Host "[pnp] SELFCHECK FAIL (engine=$SelectedEngine, exit code $exitCode)"
  }
  return $exitCode
}

<#
  One live end-to-end proof: the same north-bound HTTP surface as the self-check, but against the
  REAL model service this machine configures. The harness starts no model stand-in; it launches the
  gateway through the shipped launcher and inherits this process's environment, so PNP_MODEL_* and
  runtime\local.env are the only model configuration involved.
#>
function Invoke-LiveCheck([string]$NodeExe, [string]$SelectedEngine, [int]$SelectedPort, [string]$SelectedDirectory) {
  $live = Join-Path $CodeRoot "scripts\e2e\live-check.mjs"
  if (-not (Test-Path -LiteralPath $live -PathType Leaf)) {
    Fail "The live-check harness is missing at $live."
  }
  $arguments = @($live, "--engine", $SelectedEngine, "--port", [string]$SelectedPort)
  if (-not [string]::IsNullOrWhiteSpace($SelectedDirectory)) {
    if (-not [System.IO.Path]::IsPathRooted($SelectedDirectory)) {
      Fail "--directory must be an absolute path; the gateway rejects a relative working directory."
    }
    $arguments += @("--directory", $SelectedDirectory)
  }
  Write-Step "Running the live check for engine '$SelectedEngine' on port $SelectedPort against the configured model service."
  Write-Step "The endpoint and credentials come from this environment and runtime\local.env; only variable names are printed."
  # Out-Host, not the pipeline: the harness prints a lot, and its output must reach the console
  # rather than become this function's return value (which is the exit code).
  & $NodeExe @arguments | Out-Host
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) {
    Write-Host "[pnp] LIVECHECK PASS (engine=$SelectedEngine)"
  } else {
    Write-Host "[pnp] LIVECHECK FAIL (engine=$SelectedEngine, exit code $exitCode)"
  }
  return $exitCode
}

# The variables `pnp.cmd config` owns. Every other line of the file belongs to the operator and is
# copied through untouched. PNP_ALLOW_HTTP_ENDPOINTS is managed too: the competition's main model is
# an internal deployment, and an intranet endpoint is routinely plain http. Printing the variable as
# advice was not enough - the advice was a session-only `$env:` assignment, so an assessor who
# configured the endpoint in one window and started the gateway in another still met
# INSECURE_MODEL_ENDPOINT. Deciding it here writes the decision next to the endpoint that motivated
# it, and clears it again when the endpoint goes back to https.
$ManagedModelVariables = @("PNP_MODEL_ENDPOINT", "PNP_MODEL_ID", "PNP_MODEL_API_KEY", "PNP_MODEL_HEADERS",
  "PNP_ALLOW_HTTP_ENDPOINTS")

<#
  The active NAME=VALUE assignments of an env file, as a hashtable. A commented line is not an
  assignment and is ignored here exactly as the gateway ignores it. Nothing is printed: these
  values only become the defaults the operator can accept with Enter.
#>
function Get-LocalEnvironmentValues([string]$Path) {
  $values = @{}
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $values
  }
  foreach ($rawLine in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $line = $rawLine.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith("#")) {
      continue
    }
    $separator = $line.IndexOf("=")
    if ($separator -le 0) {
      continue
    }
    $name = $line.Substring(0, $separator).Trim()
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      continue
    }
    if (-not $values.ContainsKey($name)) {
      $values[$name] = $line.Substring($separator + 1).Trim()
    }
  }
  return $values
}

<#
  Writes the managed variables into the env file and leaves every other line where it was:
  comments, spacing and any other variable the operator put there survive. A managed variable whose
  new value is empty has its assignment removed, which is how "no key at all" is expressed. The
  return value carries NAMES only; no value is returned, printed or logged.
#>
function Set-LocalEnvironmentValues([string]$Path, [hashtable]$Values) {
  $parent = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  $existed = Test-Path -LiteralPath $Path -PathType Leaf
  [string[]]$existing = @()
  if ($existed) {
    $existing = @(Get-Content -LiteralPath $Path -Encoding UTF8)
  }

  $output = New-Object System.Collections.Generic.List[string]
  $written = New-Object System.Collections.Generic.List[string]
  $removed = New-Object System.Collections.Generic.List[string]
  $seen = New-Object System.Collections.Generic.List[string]

  if (-not $existed) {
    $output.Add("# Written by 'pnp.cmd config'. runtime\ is git-ignored.") | Out-Null
    $output.Add("# The gateway loads this file at startup and prints only the names it applied, never a value.") | Out-Null
    $output.Add("") | Out-Null
  }

  foreach ($rawLine in $existing) {
    $line = $rawLine.Trim()
    $name = ""
    if ($line.Length -gt 0 -and -not $line.StartsWith("#")) {
      $separator = $line.IndexOf("=")
      if ($separator -gt 0) {
        $name = $line.Substring(0, $separator).Trim()
      }
    }
    if ($name -ne "" -and $Values.ContainsKey($name)) {
      if ($seen.Contains($name)) {
        # A second assignment of a managed name would shadow the one just written.
        continue
      }
      $seen.Add($name) | Out-Null
      $value = [string]$Values[$name]
      if ($value -eq "") {
        $removed.Add($name) | Out-Null
        continue
      }
      $output.Add("$name=$value") | Out-Null
      $written.Add($name) | Out-Null
      continue
    }
    $output.Add($rawLine) | Out-Null
  }

  foreach ($name in $ManagedModelVariables) {
    if (-not $Values.ContainsKey($name)) { continue }
    if ($seen.Contains($name)) { continue }
    $value = [string]$Values[$name]
    if ($value -eq "") { continue }
    $output.Add("$name=$value") | Out-Null
    $written.Add($name) | Out-Null
  }

  Set-Content -LiteralPath $Path -Value $output.ToArray() -Encoding UTF8
  return @{ Written = $written.ToArray(); Removed = $removed.ToArray() }
}

<#
  Asks for one value, showing the current one (or the suggested one) in brackets. Enter keeps that
  default; a single "-" clears the variable. A secret is read through -AsSecureString so it never
  appears on the console, in the command line or in the shell history, and it is turned back into
  plain text only to be written into the file.
#>
function Read-ConfiguredValue([string]$Label, [string]$Default, [bool]$Secret, [bool]$HasCurrent) {
  if ($Secret) {
    $hint = if ($HasCurrent) { "keep the current value" } else { "none" }
    $secure = Read-Host -Prompt "$Label [$hint]" -AsSecureString
    $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $entered = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
      [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
  } else {
    $hint = if ($Default -ne "") { $Default } else { "none" }
    $entered = Read-Host -Prompt "$Label [$hint]"
  }
  if ($null -eq $entered) {
    $entered = ""
  }
  $entered = $entered.Trim()
  if ($entered -eq "") {
    return $Default
  }
  if ($entered -eq "-") {
    return ""
  }
  return $entered
}

<#
  `pnp.cmd config`: writes the model variables into the local env file, interactively or straight
  from the command line. It runs no engine, needs no build and never contacts the model service;
  the proof that the values actually work is `pnp.cmd livecheck`.
#>
function Invoke-Configure([string]$Path) {
  # The team's own free test tier is the suggested answer; any OpenAI-compatible service is accepted.
  $suggestedEndpoint = "https://open.bigmodel.cn/api/paas/v4"
  $suggestedModelId = "glm-4-flash"
  $current = Get-LocalEnvironmentValues $Path
  $values = @{}

  $nonInteractive = (-not [string]::IsNullOrWhiteSpace($Endpoint)) -or (-not [string]::IsNullOrWhiteSpace($ModelId))
  if ($nonInteractive) {
    if ([string]::IsNullOrWhiteSpace($Endpoint) -or [string]::IsNullOrWhiteSpace($ModelId)) {
      Fail "--endpoint and --model go together. Give both, or give neither and answer the prompts."
    }
    $values["PNP_MODEL_ENDPOINT"] = $Endpoint.Trim()
    $values["PNP_MODEL_ID"] = $ModelId.Trim()
    # An option that was not given leaves the file's line alone: only what was named is rewritten.
    if (-not [string]::IsNullOrWhiteSpace($ApiKey)) {
      $values["PNP_MODEL_API_KEY"] = $ApiKey.Trim()
    }
    if (-not [string]::IsNullOrWhiteSpace($Headers)) {
      $values["PNP_MODEL_HEADERS"] = $Headers.Trim()
    }
  } else {
    Write-Step "Writing the model configuration into $Path."
    Write-Step "Press Enter to accept the value in brackets; type a single '-' to clear a variable."
    $endpointDefault = if ($current.ContainsKey("PNP_MODEL_ENDPOINT")) { [string]$current["PNP_MODEL_ENDPOINT"] } else { $suggestedEndpoint }
    $modelDefault = if ($current.ContainsKey("PNP_MODEL_ID")) { [string]$current["PNP_MODEL_ID"] } else { $suggestedModelId }
    $keyDefault = if ($current.ContainsKey("PNP_MODEL_API_KEY")) { [string]$current["PNP_MODEL_API_KEY"] } else { "" }
    $headersDefault = if ($current.ContainsKey("PNP_MODEL_HEADERS")) { [string]$current["PNP_MODEL_HEADERS"] } else { "" }
    $values["PNP_MODEL_ENDPOINT"] = Read-ConfiguredValue "PNP_MODEL_ENDPOINT (OpenAI-compatible base URL)" $endpointDefault $false ($endpointDefault -ne "")
    $values["PNP_MODEL_ID"] = Read-ConfiguredValue "PNP_MODEL_ID (the name that endpoint knows)" $modelDefault $false ($modelDefault -ne "")
    $values["PNP_MODEL_API_KEY"] = Read-ConfiguredValue "PNP_MODEL_API_KEY (optional, not echoed)" $keyDefault $true ($keyDefault -ne "")
    $values["PNP_MODEL_HEADERS"] = Read-ConfiguredValue "PNP_MODEL_HEADERS (optional JSON object)" $headersDefault $false ($headersDefault -ne "")
  }

  $endpointValue = [string]$values["PNP_MODEL_ENDPOINT"]
  $modelValue = [string]$values["PNP_MODEL_ID"]
  if ([string]::IsNullOrWhiteSpace($endpointValue) -or [string]::IsNullOrWhiteSpace($modelValue)) {
    Fail "PNP_MODEL_ENDPOINT and PNP_MODEL_ID are both required; nothing was written."
  }
  if ($endpointValue -notmatch '^https?://') {
    Fail "PNP_MODEL_ENDPOINT must be an http:// or https:// base URL; nothing was written."
  }
  if ($values.ContainsKey("PNP_MODEL_HEADERS")) {
    $headersValue = [string]$values["PNP_MODEL_HEADERS"]
    if ($headersValue -ne "") {
      try {
        $null = ConvertFrom-Json $headersValue
      } catch {
        Fail "PNP_MODEL_HEADERS must be a JSON object such as {""appid"":""12345""}; nothing was written."
      }
    }
  }

  # A plain-http endpoint outside loopback is the intranet case, and it needs the deployment switch
  # to start at all. Set it beside the endpoint rather than telling the operator to remember a
  # separate command; clear it when the endpoint no longer needs it, so the relaxation never
  # outlives the reason for it.
  $needsHttpSwitch = $endpointValue -match '^http://' -and $endpointValue -notmatch '^http://(127\.0\.0\.1|localhost|\[::1\])(:|/|$)'
  $values["PNP_ALLOW_HTTP_ENDPOINTS"] = if ($needsHttpSwitch) { "1" } else { "" }

  $result = Set-LocalEnvironmentValues $Path $values
  Write-Step "Wrote $Path"
  if ($result.Written.Count -gt 0) {
    Write-Step "Variables written (names only; values are never printed): $($result.Written -join ', ')"
  }
  if ($result.Removed.Count -gt 0) {
    Write-Step "Variables cleared: $($result.Removed -join ', ')"
  }
  if ($needsHttpSwitch) {
    Write-Step "That endpoint is plain http outside loopback, so PNP_ALLOW_HTTP_ENDPOINTS=1 was written alongside it."
  }
  Write-Step "Next: 'pnp.cmd livecheck --engine opencode' verifies the whole chain against this service."
  return 0
}

function Show-Help {
  @"
PNP launcher (dependency preparation + gateway lifecycle)

Usage:
  .\pnp.cmd start      [--engine <id>] [--port 6217] [--host localhost]
  .\pnp.cmd bootstrap  [--engine <id>]
  .\pnp.cmd selfcheck  [--engine <id>] [--port 6217]
  .\pnp.cmd livecheck  [--engine <id>] [--port 6217] [--directory <absolute path>]
  .\pnp.cmd config     [--endpoint <url> --model <id> [--api-key <key>] [--headers <json>]]
  .\pnp.cmd stop
  .\pnp.cmd help

Engine selection:
  set AGENT_ENGINE=opencode  &&  .\pnp.cmd start
  .\pnp.cmd start --engine opencode --port 6217
  Both forms are accepted. Passing --engine while AGENT_ENGINE names a different engine fails
  instead of silently choosing one.

Modes:
  bootstrap  prepare Node, dependencies, build output and the engine, then stop.
  start      bootstrap, then run the gateway. The process id goes to runtime\gateway.pid and the
             output to runtime\logs\gateway-<engine>.log (errors: gateway-<engine>.err.log).
  selfcheck  bootstrap, then run the offline end-to-end check (mock model service + gateway + one
             real prompt) and print PASS or FAIL. No model configuration is needed.
  livecheck  bootstrap, then run the same shape of check against the REAL model service configured
             in this environment or in runtime\local.env, and print PASS or FAIL. It refuses to
             start when PNP_MODEL_ENDPOINT or PNP_MODEL_ID is missing.
  config     write PNP_MODEL_ENDPOINT / PNP_MODEL_ID / PNP_MODEL_API_KEY / PNP_MODEL_HEADERS into
             runtime\local.env. Interactive unless --endpoint and --model are given; the key is
             read without echo and no value is ever printed. Other lines of the file are kept.
  stop       terminate exactly the process recorded in runtime\gateway.pid, then delete the file.

Offline order (no network is used when each step is already satisfied):
  Node          PNP_NODE_HOME -> runtime\bootstrap\node-v$PinnedNodeVersion-win-x64 -> PATH (24.19+) -> download
  Dependencies  node_modules + runtime\bootstrap\state\project-dependencies.txt -> npm ci
  Build         dist\main.js + runtime\bootstrap\state\build.txt -> npm run build
  Engine        PNP_* variables -> runtime\bootstrap\engines\<id>\<version> -> npm install

Local configuration:
  - runtime\local.env is loaded automatically when present (names are printed, values never).
  - PNP_LOCAL_ENV_FILE can point at another env file.
  - Relative PNP_SETTINGS paths in that env file are resolved from engineering\code.
  - npm_config_registry is honored, so an internal npm mirror can be used without changing PNP.
  - PNP_NODE_DOWNLOAD_URL can point at an internal mirror of the pinned Node.js ZIP.

The launcher never writes model credentials into the repository. They stay in process environment
variables referenced by config\settings.json.
"@ | Write-Host
}

if ($Mode -eq "help") {
  Show-Help
  exit 0
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
$localEnvFile = if ([string]::IsNullOrWhiteSpace($env:PNP_LOCAL_ENV_FILE)) { Join-Path $RuntimeRoot "local.env" } else { Resolve-LocalPath $env:PNP_LOCAL_ENV_FILE }

if ($Mode -eq "stop") {
  exit (Stop-Gateway)
}

# `config` only writes the env file: no engine, no Node, no build and no call to the model service.
if ($Mode -eq "config") {
  exit (Invoke-Configure $localEnvFile)
}

if ($Port -lt 1 -or $Port -gt 65535) {
  Fail "Port must be between 1 and 65535."
}
if ([string]::IsNullOrWhiteSpace($Engine)) {
  Fail "No engine selected. Set AGENT_ENGINE, or pass --engine <engineId>."
}
if (@("127.0.0.1", "localhost", "::1") -notcontains $BindHost) {
  Fail "Host must be a loopback address: localhost, 127.0.0.1, or ::1."
}

Read-LocalEnvironment $localEnvFile

if (-not [string]::IsNullOrWhiteSpace($env:AGENT_ENGINE) -and $env:AGENT_ENGINE -ne $Engine) {
  Fail "--engine and AGENT_ENGINE disagree (--engine=$Engine, AGENT_ENGINE=$($env:AGENT_ENGINE)). Clear AGENT_ENGINE or make it match the startup parameter."
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

$node = Resolve-Node
$nodeExe = [string]$node.Exe
$nodeVersion = [string]$node.Version
$nodeHome = Split-Path -Parent $nodeExe
$env:PATH = "$nodeHome;$env:PATH"
Write-Step "Using Node.js $nodeVersion from $($node.Source)."

$npmCmd = ""
try {
  $npmCmd = Resolve-Npm $nodeExe
} catch {
  # npm is only needed when something still has to be installed or compiled. A complete offline
  # bundle needs none of that, so a missing npm must not block the start; it is reported by the
  # first step that actually requires it.
  $npmCmd = ""
}

Ensure-ProjectDependencies $nodeVersion $npmCmd
Ensure-Build $nodeExe $npmCmd
Ensure-EngineDependency $Engine $npmCmd $nodeExe

if ($Mode -eq "bootstrap") {
  Write-Step "Bootstrap complete for engine '$Engine'."
  exit 0
}

if ($Mode -eq "selfcheck") {
  exit (Invoke-SelfCheck $nodeExe $Engine $Port)
}

if ($Mode -eq "livecheck") {
  exit (Invoke-LiveCheck $nodeExe $Engine $Port $Directory)
}

exit (Start-Gateway $nodeExe $Engine $Port $BindHost $localEnvFile)
