# PNP

PNP is an experimental multi-Harness Agent Gateway project for the **multi-agent-engine replaceable architecture** competition.

The project goal is to build a self-developed, engine-independent Agent Gateway that can connect multiple downloadable industry Agent Harnesses behind one stable northbound protocol.

## Competition docs

- [Competition baseline](./docs/competition-baseline.md)
- [Gateway API baseline](./docs/gateway-api-baseline.md)
- [Known evaluation cases](./docs/evaluation-cases.md)

## Research

33 deep-dive reports on candidate engines, interop protocols, and the Windows delivery constraints —
see [docs/research/](./docs/research/README.md) for the index, or jump to:

- [Engine comparison matrix](./docs/research/engine-matrix.md) — engines x 18 dimensions, selection advice, verification checklist
- [Capability inventory](./docs/research/capability-inventory.md) — 12 capability domains, capability x engine support matrix, unified terminology
- [Architecture constraints](./docs/research/architecture-constraints.md) — 14 non-negotiable design decisions with evidence
- [Digest](./docs/research/DIGEST.md) — every report's summary, key facts and design implications

## Architecture

The current specification lives in [engineering/docs/spec/](./engineering/docs/spec/) and the current evidence in
[engineering/verification/](./engineering/verification/). The documents below are **dated reviews of earlier
commits**; they drove later work and are preserved as design inputs, but they do not describe the current tree.

- [Architecture review](./docs/architecture-review.md) — 2026-09-05 review of the v2 design proposal against the research corpus
- [Engineering reviews](./docs/engineering-review.md) ([round 2](./docs/engineering-review-2.md),
  [round 3](./docs/engineering-review-3.md), [readiness audit](./docs/competition-readiness.md)) — reviews of
  commits `63b0a80`, `3337990`, `795b98b` and `adfee9d`; each records the findings that later commits addressed

## Engineering delivery

The canonical final engineering package is under [engineering/](./engineering/README.md). Its primary entry points are:

- [Agent development rules](./engineering/AGENTS.md)
- [Deployment and evaluation instructions](./engineering/INSTRUCTION.md)
- [Final specifications](./engineering/docs/spec/)
- [Team ownership and collaboration](./engineering/docs/team/)
- [Role prompts](./engineering/prompts/)
- [Common framework source](./engineering/code/)
- [Verification scope and evidence](./engineering/verification/)

## Current direction

- Self-developed Agent Gateway / Engine Fabric
- Multiple real Harness integrations
- Engine selection by startup configuration
- Stable Session / Run / Event abstraction independent from a specific engine
- Preserve engine-native capabilities instead of reducing every Harness to the lowest common denominator
- Focus on low-cost onboarding of the 3rd/4th engine

## Engines in this delivery

| Engine | Channel | Pinned in `engineering/code/engines.lock.json` | Status |
|---|---|---|---|
| OpenCode | ACP (stdio JSON-RPC) | `opencode-windows-x64@1.18.29`, tarball SHA-256 | Implemented. Windows-native real-binary smoke through the real gateway against a mock model service: 20/21 passed, 0 failed, 1 skipped by design; includes Office MCP and Desktop MCP round trips, permission once/reject, abort, cross-session queue |
| Pi | Pi RPC (JSONL) | `@earendil-works/pi-coding-agent@0.85.1`, tarball SHA-256 | Implemented. Same smoke: 20/21 passed, 0 failed, 1 skipped by design |
| Hermes | ACP | not pinned | **Not implemented.** `HermesPack` ships `implementationProvided: false` and refuses with `ENGINE_UNAVAILABLE`; it exists only as the extension-point example for a third ACP engine and is outside the release matrix |

`gateway.cmd` and `gateway.ps1` both start with no Node.js on PATH (bundled runtime) and reach `/health/ready` reporting the selected engine; verified for `opencode` and `pi` separately.

## Repository status

The repository contains the preserved competition and architecture inputs (`docs/`) plus the canonical engineering baseline (`engineering/`).

Measured on Windows x64 / Node 24.19.0 on 2026-09-09: `npm run typecheck` clean; unit + adapter tests 469 (467 passed, 0 failed, 2 skipped); HTTP/SSE contract tests 9/9; module-boundary, strip-only and PowerShell-encoding checks pass.

Not done, and not claimed:

- The intranet `internal` IntegrationProvider is an unimplemented stub (`INTEGRATION_UNAVAILABLE`). The shipped path is the `configured` provider driven by `config/settings.json` plus the `PNP_MODEL_*` environment variables.
- The employee-assistant CLI MCP server, the organisation policy service and the capability-pack manifest mechanism described in the spec are not delivered. Tool and instruction injection is delivered through `settings.json` (Office MCP, Desktop MCP, `instructions/competition.md`).
- Per-engine intranet acceptance has not been run, so `npm run release:check` still exits non-zero for that reason alone.

Details: [engineering/verification/results.json](./engineering/verification/results.json) and [engineering/verification/coverage.md](./engineering/verification/coverage.md).
