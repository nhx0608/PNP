#requires -Version 5.1
<#
.SYNOPSIS
  Safely prepares the public synthetic PNP evaluation fixtures.

.DESCRIPTION
  This script manages only files explicitly listed in fixtures/manifest.json. It never recursively
  clears a directory and never adopts an existing non-empty directory without a matching owner
  sentinel.

  -Clean removes only manifest.outputs and then restores/verifies all inputs.
  -Force may restore changed manifest inputs only in a directory with a matching sentinel. It never
  bypasses ownership validation.

.EXAMPLE
  .\Prepare-EvalData.ps1
.EXAMPLE
  .\Prepare-EvalData.ps1 -Clean -Force
.EXAMPLE
  .\Prepare-EvalData.ps1 -TestDataRoot D:\temp\pnp-test-data `
    -BackupRoot D:\temp\pnp-test-data-backup -Clean -Force
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
  [Parameter()][string]$TestDataRoot,
  [Parameter()][string]$BackupRoot,
  [Parameter()][switch]$Clean,
  [Parameter()][switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$manifestPath = Join-Path $PSScriptRoot 'fixtures\manifest.json'
$fixturesRoot = Join-Path $PSScriptRoot 'fixtures'
$ordinalIgnoreCase = [System.StringComparison]::OrdinalIgnoreCase
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  $stream = $null
  $algorithm = $null
  try {
    $stream = [System.IO.File]::OpenRead($LiteralPath)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    if ($null -ne $algorithm) { $algorithm.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

function Get-NormalizedAbsolutePath {
  param([Parameter(Mandatory = $true)][string]$PathValue)

  $full = [System.IO.Path]::GetFullPath($PathValue)
  return $full.TrimEnd([char[]]@('\', '/'))
}

function Assert-SafeRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Label
  )

  $volumeRoot = Get-NormalizedAbsolutePath ([System.IO.Path]::GetPathRoot($Root))
  if ([string]::Equals($Root, $volumeRoot, $ordinalIgnoreCase)) {
    throw "$Label cannot be a volume root: $Root"
  }
}

function Test-PathInsideRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $prefix = $Root + [System.IO.Path]::DirectorySeparatorChar
  return $Candidate.StartsWith($prefix, $ordinalIgnoreCase)
}

function Resolve-ManagedPath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($RelativePath)) { throw "$Label cannot be empty." }
  if ([System.IO.Path]::IsPathRooted($RelativePath)) { throw "$Label must be relative: $RelativePath" }
  $segments = @($RelativePath -split '[\\/]+' | Where-Object { $_ -ne '' })
  if ($segments.Count -eq 0 -or $segments -contains '.' -or $segments -contains '..') {
    throw "$Label contains a forbidden path segment: $RelativePath"
  }

  $nativeRelative = $RelativePath.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
  $target = [System.IO.Path]::GetFullPath((Join-Path $Root $nativeRelative))
  if (-not (Test-PathInsideRoot -Candidate $target -Root $Root)) {
    throw "$Label escapes its managed root: $RelativePath"
  }
  return $target
}

function Assert-NoReparsePoint {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if (Test-Path -LiteralPath $Root) {
    $rootItem = Get-Item -LiteralPath $Root -Force
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label root cannot be a link or junction: $Root"
    }
  }

  $relative = $Target.Substring(($Root + [System.IO.Path]::DirectorySeparatorChar).Length)
  $cursor = $Root
  foreach ($segment in @($relative -split '[\\/]+')) {
    $cursor = Join-Path $cursor $segment
    if (-not (Test-Path -LiteralPath $cursor)) { continue }
    $item = Get-Item -LiteralPath $cursor -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label path contains a link or junction: $cursor"
    }
  }
}

function Get-RootState {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Role,
    [Parameter(Mandatory = $true)][string]$SentinelFileName,
    [Parameter(Mandatory = $true)][string]$SentinelSchema,
    [Parameter(Mandatory = $true)][string]$SentinelOwner,
    [Parameter(Mandatory = $true)][string]$FixtureSetId
  )

  if (Test-Path -LiteralPath $Root -PathType Leaf) {
    throw "Evaluation root is occupied by a file: $Root"
  }
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    return [pscustomobject]@{ Mode = 'new'; SentinelPath = (Join-Path $Root $SentinelFileName) }
  }

  Assert-NoReparsePoint -Root $Root -Target (Join-Path $Root $SentinelFileName) -Label "$Role sentinel"
  $sentinelPath = Join-Path $Root $SentinelFileName
  if (Test-Path -LiteralPath $sentinelPath -PathType Leaf) {
    try {
      $ownerRecord = Get-Content -LiteralPath $sentinelPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $schemaMatches = [string]::Equals([string]$ownerRecord.schema, $SentinelSchema, [System.StringComparison]::Ordinal)
      $ownerMatches = [string]::Equals([string]$ownerRecord.owner, $SentinelOwner, [System.StringComparison]::Ordinal)
      $setMatches = [string]::Equals([string]$ownerRecord.fixtureSetId, $FixtureSetId, [System.StringComparison]::Ordinal)
      $roleMatches = [string]::Equals([string]$ownerRecord.rootRole, $Role, [System.StringComparison]::Ordinal)
      $rootMatches = [string]::Equals((Get-NormalizedAbsolutePath ([string]$ownerRecord.canonicalRoot)), $Root, $ordinalIgnoreCase)
    } catch {
      throw "Cannot read or validate owner sentinel $sentinelPath. $($_.Exception.Message)"
    }
    if (-not ($schemaMatches -and $ownerMatches -and $setMatches -and $roleMatches -and $rootMatches)) {
      throw "Owner sentinel does not match this fixture set; refusing to manage: $sentinelPath"
    }
    return [pscustomobject]@{ Mode = 'owned'; SentinelPath = $sentinelPath }
  }

  $firstEntry = Get-ChildItem -LiteralPath $Root -Force | Select-Object -First 1
  if ($null -eq $firstEntry) {
    return [pscustomobject]@{ Mode = 'empty'; SentinelPath = $sentinelPath }
  }

  throw "Directory is non-empty and has no matching owner sentinel; -Force cannot adopt it: $Root"
}

function Initialize-OwnedRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Role,
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)]$Manifest,
    [Parameter(Mandatory = $true)][string]$ManifestHash
  )

  if ($State.Mode -eq 'owned') { return }

  if ($State.Mode -eq 'new' -and $PSCmdlet.ShouldProcess($Root, 'Create managed evaluation root')) {
    New-Item -ItemType Directory -Path $Root | Out-Null
  }
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }

  $ownerRecord = [ordered]@{
    schema = [string]$Manifest.sentinel.schema
    owner = [string]$Manifest.sentinel.owner
    fixtureSetId = [string]$Manifest.fixtureSetId
    fixtureSetVersion = [string]$Manifest.fixtureSetVersion
    rootRole = $Role
    canonicalRoot = $Root
    manifestSha256 = $ManifestHash
    policy = 'manifest-files-only'
  }
  $json = ($ownerRecord | ConvertTo-Json -Depth 4) + "`n"
  if ($PSCmdlet.ShouldProcess($State.SentinelPath, 'Write owner sentinel')) {
    [System.IO.File]::WriteAllText($State.SentinelPath, $json, $utf8NoBom)
  }
}

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Fixture manifest is missing: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([int]$manifest.schemaVersion -ne 1) { throw "Unsupported manifest schemaVersion: $($manifest.schemaVersion)" }
if ([string]::IsNullOrWhiteSpace([string]$manifest.fixtureSetId)) { throw 'manifest.fixtureSetId cannot be empty.' }
if ([string]::IsNullOrWhiteSpace([string]$manifest.fixtureSetVersion)) { throw 'manifest.fixtureSetVersion cannot be empty.' }
if ([string]::IsNullOrWhiteSpace([string]$manifest.sentinel.schema)) { throw 'manifest.sentinel.schema cannot be empty.' }
if (-not [string]::Equals([string]$manifest.sentinel.fileName, '.pnp-evaluation-fixture.json', [System.StringComparison]::Ordinal)) {
  throw 'manifest.sentinel.fileName must be .pnp-evaluation-fixture.json.'
}
if (-not [string]::Equals([string]$manifest.sentinel.owner, 'PNP_EVALUATION_FIXTURE', [System.StringComparison]::Ordinal)) {
  throw 'manifest.sentinel.owner must be PNP_EVALUATION_FIXTURE.'
}

if ([string]::IsNullOrWhiteSpace($TestDataRoot)) { $TestDataRoot = [string]$manifest.defaultRoots.testData }
if ([string]::IsNullOrWhiteSpace($BackupRoot)) { $BackupRoot = [string]$manifest.defaultRoots.backup }
$testRoot = Get-NormalizedAbsolutePath $TestDataRoot
$backupResolvedRoot = Get-NormalizedAbsolutePath $BackupRoot
Assert-SafeRoot -Root $testRoot -Label 'TestDataRoot'
Assert-SafeRoot -Root $backupResolvedRoot -Label 'BackupRoot'
if ([string]::Equals($testRoot, $backupResolvedRoot, $ordinalIgnoreCase) -or
    (Test-PathInsideRoot -Candidate $testRoot -Root $backupResolvedRoot) -or
    (Test-PathInsideRoot -Candidate $backupResolvedRoot -Root $testRoot)) {
  throw "TestDataRoot and BackupRoot must be distinct, non-nested directories: $testRoot / $backupResolvedRoot"
}

$roots = @{ testData = $testRoot; backup = $backupResolvedRoot }
$manifestHash = Get-Sha256 $manifestPath
$sentinelName = [string]$manifest.sentinel.fileName
$sentinelSchema = [string]$manifest.sentinel.schema
$sentinelOwner = [string]$manifest.sentinel.owner
$fixtureSetId = [string]$manifest.fixtureSetId
$normalizedFixturesRoot = Get-NormalizedAbsolutePath $fixturesRoot

$states = @{}
foreach ($role in @('testData', 'backup')) {
  $states[$role] = Get-RootState -Root $roots[$role] -Role $role -SentinelFileName $sentinelName `
    -SentinelSchema $sentinelSchema -SentinelOwner $sentinelOwner -FixtureSetId $fixtureSetId
}

$destinationKeys = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
$inputPlans = @()
foreach ($inputEntry in @($manifest.inputs)) {
  $role = [string]$inputEntry.root
  if (-not $roots.ContainsKey($role)) { throw "Unknown input root role: $role" }
  $source = Resolve-ManagedPath -Root $normalizedFixturesRoot -RelativePath ([string]$inputEntry.source) -Label 'input.source'
  $destination = Resolve-ManagedPath -Root $roots[$role] -RelativePath ([string]$inputEntry.path) -Label 'input.path'
  Assert-NoReparsePoint -Root $normalizedFixturesRoot -Target $source -Label 'Fixture source'
  Assert-NoReparsePoint -Root $roots[$role] -Target $destination -Label 'Fixture destination'
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Fixture source does not exist: $source" }
  $expectedHash = ([string]$inputEntry.sha256).ToLowerInvariant()
  $sourceHash = Get-Sha256 $source
  if ($sourceHash -ne $expectedHash) { throw "Fixture source hash mismatch: $source" }
  if (-not $destinationKeys.Add($destination)) { throw "Duplicate manifest destination: $destination" }
  if ([string]::Equals([System.IO.Path]::GetFileName($destination), $sentinelName, $ordinalIgnoreCase)) {
    throw "An input cannot overwrite the owner sentinel: $destination"
  }
  if (Test-Path -LiteralPath $destination -PathType Container) { throw "Input destination is a directory: $destination" }
  if (Test-Path -LiteralPath $destination -PathType Leaf) {
    $currentHash = Get-Sha256 $destination
    if ($currentHash -ne $expectedHash -and -not $Force) {
      throw "Managed input was changed; use -Force to restore it: $destination"
    }
  }
  $inputPlans += [pscustomobject]@{
    Source = $source
    Destination = $destination
    ExpectedHash = $expectedHash
  }
}

$outputPlans = @()
foreach ($outputEntry in @($manifest.outputs)) {
  $role = [string]$outputEntry.root
  if (-not $roots.ContainsKey($role)) { throw "Unknown output root role: $role" }
  $destination = Resolve-ManagedPath -Root $roots[$role] -RelativePath ([string]$outputEntry.path) -Label 'output.path'
  Assert-NoReparsePoint -Root $roots[$role] -Target $destination -Label 'Evaluation output'
  if ($destinationKeys.Contains($destination)) { throw "A path cannot be both input and output: $destination" }
  if (-not $destinationKeys.Add($destination)) { throw "Duplicate manifest destination: $destination" }
  if ([string]::Equals([System.IO.Path]::GetFileName($destination), $sentinelName, $ordinalIgnoreCase)) {
    throw "An output cannot overwrite the owner sentinel: $destination"
  }
  if (Test-Path -LiteralPath $destination -PathType Container) {
    throw "Output destination is a directory and will not be removed: $destination"
  }
  $outputPlans += [pscustomobject]@{ Destination = $destination }
}

foreach ($role in @('testData', 'backup')) {
  Initialize-OwnedRoot -Root $roots[$role] -Role $role -State $states[$role] -Manifest $manifest -ManifestHash $manifestHash
}

if ($Clean) {
  foreach ($plan in $outputPlans) {
    if (-not (Test-Path -LiteralPath $plan.Destination -PathType Leaf)) { continue }
    if ($PSCmdlet.ShouldProcess($plan.Destination, 'Remove manifest-listed evaluation output')) {
      Remove-Item -LiteralPath $plan.Destination -Force
    }
  }
}

foreach ($plan in $inputPlans) {
  $needsCopy = -not (Test-Path -LiteralPath $plan.Destination -PathType Leaf)
  if (-not $needsCopy) { $needsCopy = (Get-Sha256 $plan.Destination) -ne $plan.ExpectedHash }
  if (-not $needsCopy) { continue }

  $parent = Split-Path -Parent $plan.Destination
  if (-not (Test-Path -LiteralPath $parent -PathType Container) -and $PSCmdlet.ShouldProcess($parent, 'Create fixture parent directory')) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  if ($PSCmdlet.ShouldProcess($plan.Destination, 'Copy manifest-listed synthetic input')) {
    Copy-Item -LiteralPath $plan.Source -Destination $plan.Destination -Force
  }
}

if ($WhatIfPreference) {
  Write-Host '[fixtures] WhatIf complete; no files were written, overwritten, or removed.'
  exit 0
}

foreach ($plan in $inputPlans) {
  if (-not (Test-Path -LiteralPath $plan.Destination -PathType Leaf)) {
    throw "Input is still missing after preparation: $($plan.Destination)"
  }
  if ((Get-Sha256 $plan.Destination) -ne $plan.ExpectedHash) {
    throw "Input hash mismatch after preparation: $($plan.Destination)"
  }
}
if ($Clean) {
  foreach ($plan in $outputPlans) {
    if (Test-Path -LiteralPath $plan.Destination) {
      throw "Output still exists after cleanup: $($plan.Destination)"
    }
  }
}

Write-Host "[fixtures] READY: $($inputPlans.Count) inputs verified."
Write-Host "[fixtures] testData = $testRoot"
Write-Host "[fixtures] backup   = $backupResolvedRoot"
if ($Clean) {
  Write-Host "[fixtures] Checked $($outputPlans.Count) manifest-listed output paths; no directory was recursively cleared."
}
