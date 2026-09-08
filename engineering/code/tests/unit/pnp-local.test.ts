import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("pnp-local validates StrictMode package candidates and explicit Pi launch configuration", {
  skip: process.platform !== "win32" ? "Windows PowerShell-specific launcher contract" : false,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pnp-local-candidates-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureCodeRoot = path.join(root, "fixture-code");
  const configRoot = path.join(fixtureCodeRoot, "config", "engines");
  await mkdir(configRoot, { recursive: true });
  const config = (candidates: string[], variable: string) => JSON.stringify({
    engineVersion: "24.19.0",
    distribution: { kind: "npm-global-native-binary", packageNameCandidates: candidates },
    executable: { exe: { environmentVariable: variable } },
  });
  await writeFile(path.join(configRoot, "zero.json"), config([], "PNP_TEST_ZERO_PATH"));
  await writeFile(path.join(configRoot, "multiple.json"), config(["first", "second"], "PNP_TEST_MULTIPLE_PATH"));
  // A pi.json with no distribution block: the launcher must refuse to guess an installer for it.
  await writeFile(path.join(configRoot, "pi.json"), JSON.stringify({ id: "pi", engineVersion: null, capabilityEvidence: "unverified" }));
  const fakeExecutable = path.join(root, "fake-engine.cmd");
  await writeFile(fakeExecutable, "@echo off\r\necho %PNP_TEST_REPORTED_VERSION% & exit /b 0\r\n");
  const fakePiEntry = path.join(root, "fake-pi-entry.mjs");
  await writeFile(fakePiEntry, "// The launcher only validates that this configured entry exists.\n");
  const explicitPiNode = path.join(root, "explicit-pi-node.cmd");
  await writeFile(explicitPiNode, `@echo off\r\n"${process.execPath}" %*\r\nexit /b %ERRORLEVEL%\r\n`);

  const codeRoot = fileURLToPath(new URL("../../", import.meta.url));
  const launcher = path.join(codeRoot, "scripts", "pnp-local.ps1");
  const harness = path.join(root, "pnp-local-harness.ps1");
  const sentinelPrefix = `PNP_LOCAL_HARNESS_COMPLETE_${process.pid}_${Date.now()}`;
  const powershell = String.raw`
$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
try {
  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:PNP_TEST_LAUNCHER, [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count -ne 0) { throw ($parseErrors | ForEach-Object Message) -join "; " }
  foreach ($name in @("Get-OptionalProperty", "Ensure-EngineDependency")) {
    $definition = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
    if ($null -eq $definition) { throw "Missing launcher function: $name" }
    Invoke-Expression $definition.Extent.Text
  }
  function Fail([string]$Message) { throw $Message }
  function Write-Step([string]$Message) {}
  function Resolve-LocalPath([string]$Value) { return $Value }
  function Resolve-PackageExecutable([string]$EngineHome, [string]$PackageName, [string]$PreferredCommand) { return $env:PNP_TEST_FAKE_EXE }
  function Invoke-CandidateCase([string]$Root, [string]$Engine, [string]$EnvironmentVariable, [string]$ReportedVersion, [bool]$ExpectEmptyFailure) {
    $script:CodeRoot = $Root
    $script:BootstrapRoot = $env:PNP_TEST_BOOTSTRAP_ROOT
    [Environment]::SetEnvironmentVariable($EnvironmentVariable, $null, "Process")
    [Environment]::SetEnvironmentVariable("PNP_TEST_REPORTED_VERSION", $ReportedVersion, "Process")
    try {
      Ensure-EngineDependency $Engine "unused-npm.cmd" $env:PNP_TEST_NODE
      if ($ExpectEmptyFailure) { throw "zero-candidate case unexpectedly succeeded" }
    } catch {
      if (-not $ExpectEmptyFailure) { throw }
      if ($_.Exception.Message -notmatch "declares no npm package candidate") { throw }
    }
  }

  $script:CodeRoot = $env:PNP_TEST_REAL_CODE_ROOT
  $script:BootstrapRoot = $env:PNP_TEST_BOOTSTRAP_ROOT
  [Environment]::SetEnvironmentVariable("PNP_PI_ENTRY", $null, "Process")
  [Environment]::SetEnvironmentVariable("PNP_PI_EXECUTABLE", $null, "Process")
  [Environment]::SetEnvironmentVariable("PNP_PI_NODE", $null, "Process")

  switch ($env:PNP_TEST_CASE) {
    "success" {
      # The shipped OpenCode config is the important one-element case that previously became a scalar.
      Invoke-CandidateCase $env:PNP_TEST_REAL_CODE_ROOT "opencode" "PNP_OPENCODE_EXE_PATH" "1.18.29" $false
      Invoke-CandidateCase $env:PNP_TEST_FIXTURE_CODE_ROOT "zero" "PNP_TEST_ZERO_PATH" "24.19.0" $true
      Invoke-CandidateCase $env:PNP_TEST_FIXTURE_CODE_ROOT "multiple" "PNP_TEST_MULTIPLE_PATH" "24.19.0" $false

      $script:CodeRoot = $env:PNP_TEST_REAL_CODE_ROOT
      [Environment]::SetEnvironmentVariable("PNP_PI_ENTRY", $env:PNP_TEST_PI_ENTRY, "Process")
      Ensure-EngineDependency "pi" "unused-npm.cmd" $env:PNP_TEST_NODE
      if ($env:PNP_PI_ENTRY -ne $env:PNP_TEST_PI_ENTRY) { throw "Pi entry configuration was not preserved" }
      if ($env:PNP_PI_NODE -ne $env:PNP_TEST_NODE) { throw "Pi entry configuration did not default PNP_PI_NODE" }

      [Environment]::SetEnvironmentVariable("PNP_PI_NODE", $env:PNP_TEST_EXPLICIT_PI_NODE, "Process")
      Ensure-EngineDependency "pi" "unused-npm.cmd" $env:PNP_TEST_NODE
      if ($env:PNP_PI_NODE -ne $env:PNP_TEST_EXPLICIT_PI_NODE) { throw "Explicit PNP_PI_NODE configuration was not preserved" }

      [Environment]::SetEnvironmentVariable("PNP_PI_ENTRY", $null, "Process")
      [Environment]::SetEnvironmentVariable("PNP_PI_NODE", $null, "Process")
      [Environment]::SetEnvironmentVariable("PNP_PI_EXECUTABLE", $env:PNP_TEST_FAKE_EXE, "Process")
      Ensure-EngineDependency "pi" "unused-npm.cmd" $env:PNP_TEST_NODE
      if ($env:PNP_PI_EXECUTABLE -ne $env:PNP_TEST_FAKE_EXE) { throw "Pi executable configuration was not preserved" }
    }
    "missing-configuration" {
      # The shipped pi.json declares an installable distribution; this case covers an engine
      # config without one, so it runs against the fixture code root's bare pi.json.
      $script:CodeRoot = $env:PNP_TEST_FIXTURE_CODE_ROOT
      Ensure-EngineDependency "pi" "unused-npm.cmd" $env:PNP_TEST_NODE
    }
    "invalid-executable" {
      [Environment]::SetEnvironmentVariable("PNP_PI_EXECUTABLE", $env:PNP_TEST_MISSING_EXECUTABLE, "Process")
      Ensure-EngineDependency "pi" "unused-npm.cmd" $env:PNP_TEST_NODE
    }
    "invalid-entry" {
      [Environment]::SetEnvironmentVariable("PNP_PI_ENTRY", $env:PNP_TEST_MISSING_ENTRY, "Process")
      Ensure-EngineDependency "pi" "unused-npm.cmd" $env:PNP_TEST_NODE
    }
    "invalid-node" {
      [Environment]::SetEnvironmentVariable("PNP_PI_ENTRY", $env:PNP_TEST_PI_ENTRY, "Process")
      [Environment]::SetEnvironmentVariable("PNP_PI_NODE", $env:PNP_TEST_MISSING_NODE, "Process")
      Ensure-EngineDependency "pi" "unused-npm.cmd" $env:PNP_TEST_NODE
    }
    default {
      throw "Unknown harness case: $($env:PNP_TEST_CASE)"
    }
  }

  [Console]::Out.WriteLine($env:PNP_TEST_COMPLETION_SENTINEL)
  exit 0
} catch {
  [Console]::Error.WriteLine(($_ | Out-String))
  exit 1
}
`;
  await writeFile(harness, powershell);
  const runHarness = (caseName: string) => {
    const sentinel = `${sentinelPrefix}_${caseName}`;
    const bootstrapRoot = path.join(root, "bootstrap", caseName);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness], {
      encoding: "utf8",
      env: {
        ...process.env,
        PNP_TEST_CASE: caseName,
        PNP_TEST_LAUNCHER: launcher,
        PNP_TEST_REAL_CODE_ROOT: codeRoot,
        PNP_TEST_FIXTURE_CODE_ROOT: fixtureCodeRoot,
        PNP_TEST_BOOTSTRAP_ROOT: bootstrapRoot,
        PNP_TEST_FAKE_EXE: fakeExecutable,
        PNP_TEST_PI_ENTRY: fakePiEntry,
        PNP_TEST_EXPLICIT_PI_NODE: explicitPiNode,
        PNP_TEST_NODE: process.execPath,
        PNP_TEST_MISSING_EXECUTABLE: path.join(root, "missing-pi.exe"),
        PNP_TEST_MISSING_ENTRY: path.join(root, "missing-pi-entry.mjs"),
        PNP_TEST_MISSING_NODE: path.join(root, "missing-node.exe"),
        PNP_TEST_COMPLETION_SENTINEL: sentinel,
        PNP_PI_ENTRY: "",
        PNP_PI_EXECUTABLE: "",
        PNP_PI_NODE: "",
      },
    });
    assert.ifError(result.error);
    const completions = result.stdout.split(/\r?\n/).filter((line) => line.trim() === sentinel);
    return { result, completions, bootstrapRoot };
  };

  const success = runHarness("success");
  assert.equal(success.result.status, 0, `PowerShell launcher harness failed:\n${success.result.stdout}\n${success.result.stderr}`);
  assert.equal(success.completions.length, 1,
    `PowerShell launcher harness did not report exactly one completion sentinel:\n${success.result.stdout}\n${success.result.stderr}`);

  const invalidCases = [
    ["missing-configuration", /no locked installer metadata[\s\S]*Preinstall Pi/],
    ["invalid-executable", /PNP_PI_EXECUTABLE points to a missing executable/],
    ["invalid-entry", /PNP_PI_ENTRY points to a missing Node entry file/],
    ["invalid-node", /PNP_PI_NODE points to a missing Node executable/],
  ] as const;
  for (const [caseName, diagnostic] of invalidCases) {
    const failed = runHarness(caseName);
    const output = `${failed.result.stdout}\n${failed.result.stderr}`;
    assert.notEqual(failed.result.status, 0, `${caseName} unexpectedly succeeded:\n${output}`);
    assert.equal(failed.completions.length, 0, `${caseName} emitted a success sentinel:\n${output}`);
    assert.match(output, diagnostic, `${caseName} did not emit its actionable diagnostic`);
    await assert.rejects(stat(failed.bootstrapRoot), { code: "ENOENT" }, `${caseName} wrote an unintended bootstrap directory`);
  }
});
