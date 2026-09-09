# PDF MCP server (Python)

A read-only MCP server for PDF handling, written in **Python** and spawned by the gateway over
stdio exactly like the two Node servers next to it.

That is the point of it. The gateway's tool layer is an MCP protocol boundary, not a Node plugin
API: `config/settings.json` names a `command` and its `args`, and the gateway spawns them. Because
that command is arbitrary, a tool server can be written in any language and **both engines**
(OpenCode over ACP, Pi over its RPC mode) get it with **no change to the gateway, the drivers, or
either engine pack**. Three settings entries, three servers, two languages, one code path:

```jsonc
"office":  { "command": "${PNP_NODE}", "args": ["${PNP_CODE_ROOT}/dist/tools/office-mcp/main.js"],  "sideEffect": "write"    },
"desktop": { "command": "${PNP_NODE}", "args": ["${PNP_CODE_ROOT}/dist/tools/desktop-mcp/main.js"], "sideEffect": "external" },
"pdf":     { "command": "${PNP_NODE}", "args": ["${PNP_CODE_ROOT}/dist/tools/pdf-mcp/launch.js"],   "sideEffect": "read"     }
```

`tests/adapters/pdf-mcp/server.test.ts` is the executable form of that claim: it drives the Python
process with the MCP SDK's *own* client across the real stdio boundary.

## Layout, and why it is here

```
src/tools/pdf-mcp/
  launch.ts          Node launcher: resolves an interpreter, then gets out of the way   -> dist/tools/pdf-mcp/launch.js
  python.ts          interpreter resolution (explicit -> bundled -> PATH), version floor
  main.py            the server's entry point; `python main.py` is all it needs
  mcp_stdio.py       MCP over stdio, implemented against the spec (no SDK, no dependency)
  server.py          the tool catalogue: bilingual descriptions, argument validation, result shapes
  pdf_read.py        pypdf-backed reading: pages, text, page classification, metadata, geometry
  tables.py          whitespace-column table detection with a measured confidence
  paths.py           absolute-path discipline, mirroring office-mcp/paths.ts
  errors.py          actionable error codes, mirroring office-mcp/errors.ts
  _vendor/           pypdf 6.13.3, unpacked from its pure-Python wheel (see _vendor/README.md)
  tests/             the standalone unittest suite and the hand-written PDF fixtures
  run-tests.py       the runner for those tests
```

It lives under `src/`, not at the code root, for three concrete reasons:

* `scripts/package-release.mjs` copies an **allow-list** of top-level directories —
  `src`, `native`, `config`, `scripts`, `assets`. A `tools/` directory at the code root would simply
  not be in `solution.zip`.
* `tsconfig.json` has `"include": ["src/**/*.ts"]`, so the TypeScript build never sees a `.py` file.
  `scripts/check-boundaries.mjs` likewise walks `src/` filtering for `.ts`. Python under `src/` is
  invisible to both.
* The other two MCP servers are `src/tools/office-mcp/` and `src/tools/desktop-mcp/`. A judge
  looking for the third one should find it in the same place.

## The Python floor: 3.9

**Required: CPython 3.9 or newer.** Verified three ways rather than asserted:

1. The vendored wheel declares `Requires-Python: >=3.9` and is tagged `py3-none-any`
   (`Root-Is-Purelib: true`) — checked from the files in `_vendor/` by
   `PythonFloorTest.test_the_vendored_wheel_is_pure_python_and_declares_the_same_floor`.
2. Every `.py` file shipped here — this package **and** the 55 vendored ones — is parsed with
   `ast.parse(..., feature_version=(3, 9))`, which makes CPython's parser refuse any syntax newer
   than 3.9. That is
   `PythonFloorTest.test_every_shipped_python_file_parses_at_the_declared_floor`, and it fails on the
   first `match` statement or parenthesised `with` that ever creeps in.
3. `main.py` refuses to run on an older interpreter, in a file deliberately written without
   f-strings so that it *parses* on an old interpreter and can therefore print that message; and
   `python.ts` probes each candidate interpreter's real `sys.version_info` before spawning it.

The measured floor is a *syntax and metadata* floor. It has been executed end to end on CPython
3.13.7 (win32) only, because that is the interpreter this machine has — `server_info` reports the
`pythonVersion` any given run actually used, so the evidence is never a guess.

## What is vendored, and why that shape

`_vendor/pypdf` — pypdf 6.13.3, 60 files, **1,491,250 bytes (1.42 MiB)** unpacked from a 347,288-byte
`py3-none-any` wheel, BSD-3-Clause, **no runtime dependencies**. Full provenance, hashes and the
reproduction command are in [`_vendor/README.md`](_vendor/README.md).

The delivery is offline, so `pip install` at deploy time does not exist and a dependency that is not
in the package is not available. And only *pure-Python* wheels may be vendored: a `cp313` wheel
breaks on a judge running 3.11, so `lxml`, `Pillow`, `cryptography` and anything that depends on them
are excluded by rule. pypdf is the right choice precisely because it is pure Python and has no
required dependency of its own.

The official Python MCP SDK is deliberately **not** vendored: it pulls in `pydantic-core`, a Rust
extension module with a platform-specific wheel, plus `anyio`, `httpx`, `starlette` and `uvicorn` —
a tree in which at least one piece cannot ship as `py3-none-any`. `mcp_stdio.py` implements
the three methods this server needs (`initialize`, `tools/list`, `tools/call`, plus `ping` and the
notifications) in about 170 dependency-free lines of code, against the same envelope the Node servers emit.

## Tools

All four are read-only; the whole server is declared `"sideEffect": "read"`, and
`server.test.ts` asserts every published tool carries `readOnlyHint: true`. Every path argument must
be **absolute** — `~`, `%VAR%` and `$VAR` are refused rather than expanded, because the path the
server opens must be the path the caller can see in the transcript.

### `pdf_extract(path, firstPage?, lastPage?, maxCharsPerPage?, includeText?) -> read`

Text per page, the page count and the document metadata. `firstPage`/`lastPage` are 1-based and
inclusive; a `lastPage` past the end is clamped, a `firstPage` past the end is `INDEX_OUT_OF_RANGE`.

The part that matters: **a page that yields no text is never returned as an empty string.** Each page
carries a `kind`:

| `kind` | meaning |
| --- | --- |
| `text` | the page has a text layer and it produced characters |
| `image-only` | no text layer, but the page draws an image — a scanned or picture page |
| `graphics-only` | no text and no image, but the content stream draws something (vectors, a chart) |
| `no-content` | the page is genuinely blank |
| `unreadable` | extraction raised; `failure` carries the reason, and the page is not counted as empty |

plus `pagesWithoutText`, `imageOnlyPages`, `unreadablePages` and `notes` that say in both languages
that this server does no OCR. Truncation (`maxCharsPerPage`, default 20000; 300000 characters in
total) is reported per page in `truncatedPages` and in `notes`, never applied silently.

### `pdf_extract_tables(path, firstPage?, lastPage?, minConfidence?) -> read`

Best-effort table extraction, **and it is worth shipping** — see the honesty section below. Returns
each table's `rows`, `columns`, `header`, a `confidence` of `high`/`medium`/`low`, the measured
`completeRowRatio`, `mergedColumnBoundaries`, and `signals` listing every reason a confidence was
downgraded. `caveat` states in both languages what the method cannot do. `minConfidence` filters, and
`droppedBelowMinConfidence` says how many candidates the filter removed.

### `pdf_info(path) -> read`

Page count, PDF version, per-page size in points *and* millimetres with rotation and orientation,
`uniquePageSizes` over the whole document, encryption status and whether an empty password opened it,
the `/Info` metadata, `pageKinds`, and whether there is a text layer at all.

`hasTextLayer` is measured, not guessed: a spread sample of up to 24 pages, then a full read of up to
200 pages when the sample finds nothing. `textLayerCertain` is `false` only when the document was too
long to finish — the one case where "no text layer" would otherwise be an overclaim.

### `server_info() -> read`

Mirrors the Node servers': version, platform, the full tool catalogue with each tool's side effect —
plus `implementation: "python"`, the `pythonVersion`/`pythonExecutable` actually running, the
declared `pythonFloor`, and `dependencies[].vendored`, which is how a reader confirms the delivery is
using its own pypdf and not whatever happened to be installed.

## Is pure-Python table extraction worth shipping? Yes — with a stated confidence

It was measured before it was written. `camelot` (Ghostscript), `tabula` (a JVM) and `pdfplumber`
(`pdfminer.six` → `cryptography`, a compiled wheel) are all out of reach, so the only material is
pypdf's layout-preserving text extraction, which places each glyph at a character position derived
from its coordinates on the page. A column separator is then a run of character positions that is
blank on *every* line of a block — which survives right-aligned numbers and cells containing spaces —
and a pair of adjacent columns that is never occupied on both sides in the same row is one column the
grid split by accident, so it is merged back and the merge is *reported*.

Measured against four real tables in two Word-exported Chinese PDFs
(`runtime/acceptance-fixtures/word-pdf/`), it recovered **4 of 4 exactly**, cell for cell, including
`华为 2025` price and sales tables with Chinese headers; and it produced **zero** tables from the
prose-only report, which is the failure that would have made it worthless.

What it cannot do is stated in `caveat` on every response and downgraded in `confidence`:
scanned pages (no text layer to align), cells that wrap onto several lines (each visual line becomes
a row), tables defined only by ruling lines with no horizontal gap, and merged cells (a spanned cell
lands in one of the columns it spans). A `low` confidence means the result is a hint, not data.

## Degradation when Python is absent

**This server is optional and must never take anything else down.** The Node office and desktop
servers do not depend on it, and nothing in the gateway does.

`launch.ts` resolves an interpreter with the house pattern from `scripts/pnp-local.ps1`'s
`Resolve-Node` — explicit variable, then bundled, then PATH:

1. **`PNP_PYTHON`** — an absolute path to a python executable, or to a directory containing one.
   If it is set and unusable the search **stops there** and says so, naming the variable; it does not
   quietly substitute a different interpreter. (`Resolve-Node` treats `PNP_NODE_HOME` the same way.)
2. **Bundled** — `runtime/bootstrap/python/` or `runtime/bootstrap/python-*/`, the slot next to the
   pinned `node-v24.19.0-win-x64`. Nothing ships there today.
3. **PATH** — `py -3` first on Windows (the official launcher, which skips the App Execution Alias
   stub), then `python`, then `python3`.

Each candidate is *run* (`-c "import sys; ..."`) before it is accepted, because a `python` on PATH may
be the Windows Store stub, and a `python3` may be a 3.8 that would fail on the first tool call rather
than at startup.

When nothing resolves, the launcher **does not exit**. It serves MCP itself and publishes exactly one
tool, `server_info`, reporting:

```json
{ "name": "pdf", "available": false, "reason": "...", "detail": "...checked candidates...",
  "requiredPython": "3.9+", "remedyVariable": "PNP_PYTHON", "tools": [] }
```

So an unavailable optional server is a **reported fact**: never a startup failure (the engine's MCP
client sees a healthy server and completes `initialize`), and never a silent hole (no PDF tool is
published that could not be honoured, and the reason plus the variable to set are one call away, and
also on stderr). `tests/adapters/pdf-mcp/launcher.test.ts` proves this on a machine that *does* have
Python, by pointing `PNP_PYTHON` at nothing.

### Why a Node file starts a Python server

`launch.ts` is a bridge, not a proxy: it `spawn`s Python with `stdio: "inherit"`, so the Python
process inherits the gateway's own pipes and owns the JSON-RPC stream end to end. Not one frame is
parsed, copied or re-serialised in Node.

It exists because of two rules in code this package does not own:

1. `expandPlaceholders` in `src/config/settings.ts` knows exactly two placeholders,
   `${PNP_CODE_ROOT}` and `${PNP_NODE}`. An unknown one raises `SETTINGS_INVALID` and fails the
   **whole** settings load — which would take the Node tool servers down with it. So `${PNP_PYTHON}`
   cannot be written in `config/settings.json` today.
2. `mcpToolBindings` in `src/integration/index.ts` requires `command` to be an absolute path, never a
   PATH lookup — and no absolute path to Python is knowable when the settings file is written.

Both are correct rules. The one-line change that retires this file is in "Launcher change required"
below; after it, the settings entry becomes `"command": "${PNP_PYTHON}"`,
`"args": ["${PNP_CODE_ROOT}/src/tools/pdf-mcp/main.py"]` and `launch.ts` / `python.ts` can be deleted.
Until then the settings entry that ships is the one that works.

## Verifying the server standalone

No gateway, no engine, no build. From `engineering/code`:

```powershell
# 1. the tests: 36 of them, standard-library unittest, fixtures written by the tests themselves
python src\tools\pdf-mcp\run-tests.py

# 2. the server itself, as the gateway starts it
python src\tools\pdf-mcp\main.py
# then paste one line and press Enter:
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

`tools/list` answers with the four tools on one line of stdout. `Ctrl+Z` then Enter (or closing
stdin) exits 0.

To check the launcher and the interpreter resolution as `config/settings.json` declares them, after
`npm run build`:

```powershell
node dist\tools\pdf-mcp\launch.js
# stderr says which interpreter it chose, e.g.
#   pdf MCP server starting python 3.13.7 from PATH (py)
#   pdf MCP server 0.1.0 ready on stdio (python 3.13.7, win32)
```

And the Node adapter suite, which does all of the above through the MCP SDK's client:

```powershell
node --experimental-strip-types --test tests\adapters\pdf-mcp\*.test.ts
```

Those tests **skip** rather than fail when no interpreter is found, and the skip message names what
was missing — CI on a machine without Python stays green.

## Launcher change required (not made here)

`scripts/pnp-local.ps1` is another session's territory and has not been touched. Nothing here needs
it in order to work — PATH resolution finds the judge's `py -3` unaided — but two changes would make
the deployment story better, and one of them is what retires `launch.ts`:

**1. `scripts/pnp-local.ps1` — a `Resolve-Python` next to `Resolve-Node`.** Same three-step shape,
but *optional*: it must return `$null` instead of calling `Fail` when nothing is found, because a
machine without Python still has to start.

```powershell
function Test-PythonVersion([string]$Exe) {
  if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return $null }
  $probe = & $Exe -c "import sys; sys.stdout.write('%d.%d.%d' % sys.version_info[:3])" 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($probe)) { return $null }
  $parts = $probe.Trim() -split '\.'
  if ([int]$parts[0] -lt 3 -or ([int]$parts[0] -eq 3 -and [int]$parts[1] -lt 9)) { return $null }
  return $probe.Trim()
}

function Resolve-Python {
  # 1. explicit
  if (-not [string]::IsNullOrWhiteSpace($env:PNP_PYTHON)) {
    $candidate = Resolve-LocalPath $env:PNP_PYTHON
    if (Test-Path -LiteralPath $candidate -PathType Container) { $candidate = Join-Path $candidate "python.exe" }
    $version = Test-PythonVersion $candidate
    if ($null -eq $version) {
      Fail "PNP_PYTHON does not point at a usable Python 3.9+ interpreter: $candidate. Set PNP_PYTHON to a python executable (or the directory containing one), or clear it to search PATH. The PDF tools are optional; the office and desktop tools work without them."
    }
    return @{ Exe = $candidate; Version = $version; Source = "PNP_PYTHON" }
  }
  # 2. bundled
  $bundled = Join-Path $CodeRoot "runtime\bootstrap\python\python.exe"
  $version = Test-PythonVersion $bundled
  if ($null -ne $version) { return @{ Exe = $bundled; Version = $version; Source = "bundled" } }
  # 3. PATH - the official `py` launcher first, then python/python3
  $py = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($null -ne $py) {
    $probe = & $py.Source -3 -c "import sys; sys.stdout.write(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($probe)) {
      $version = Test-PythonVersion $probe.Trim()
      if ($null -ne $version) { return @{ Exe = $probe.Trim(); Version = $version; Source = "PATH (py -3)" } }
    }
  }
  foreach ($name in @("python.exe", "python3.exe")) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -ne $command) {
      $version = Test-PythonVersion $command.Source
      if ($null -ne $version) { return @{ Exe = $command.Source; Version = $version; Source = "PATH" } }
    }
  }
  return $null   # optional: report it, do not Fail
}
```

Call it next to `Resolve-Node` and export the result so the gateway process inherits it, and report
the outcome the way the Node version is reported:

```powershell
$python = Resolve-Python
if ($null -eq $python) {
  Write-Step "Python 3.9+ was not found; the PDF tools will report themselves unavailable. Set PNP_PYTHON to enable them. The office and desktop tools are unaffected."
} else {
  $env:PNP_PYTHON = [string]$python.Exe
  Write-Step "Using Python $($python.Version) from $($python.Source) for the PDF tools."
}
```

**2. `src/config/settings.ts` — one line in `expandPlaceholders`, which retires `launch.ts`.**

```ts
if (name === "PNP_PYTHON") {
  const value = process.env.PNP_PYTHON;
  if (value === undefined || value.trim() === "") {
    throw new PnpError("SETTINGS_INVALID", `${label} uses \${PNP_PYTHON} but PNP_PYTHON is not set.`, 400);
  }
  return value;
}
```

With both in place the settings entry becomes the direct one, and the architecture claim needs no
footnote at all:

```jsonc
"pdf": {
  "transport": "stdio",
  "command": "${PNP_PYTHON}",
  "args": ["${PNP_CODE_ROOT}/src/tools/pdf-mcp/main.py"],
  "sideEffect": "read",
  "timeoutMs": 60000,
  "enabled": true
}
```

Note the interaction with the "optional" rule: `expandPlaceholders` runs for **every** declared
server whether or not it is `enabled`, so with `${PNP_PYTHON}` in the file a machine with no Python
would fail the whole settings load unless the launcher always sets the variable *or* the placeholder
resolves to something harmless. That is exactly the coupling `launch.ts` avoids today, and it is why
step 1 and step 2 have to land together.

**3. `scripts/package-release.mjs` — add `__pycache__` to `EXCLUDE_NAMES`.** CPython writes bytecode
caches next to the source it imports, including inside `_vendor/`. They are ignored by
`src/tools/pdf-mcp/.gitignore`, so they cannot be committed, but a release built on a machine that
has run the server would carry ~1.7 MiB of another interpreter's cache into `solution.zip`. Harmless
(CPython ignores a mismatched magic number) but pure dead weight.
