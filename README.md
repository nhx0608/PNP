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

- [Architecture review](./docs/architecture-review.md) — review of the v2 design proposal against the
  research corpus: 5 blocking gaps, 1 conclusion to correct, 3 simplifications, with a prioritised change list
- [Engineering review and plan](./docs/engineering-review.md) — first-principles review of the `engineering/`
  delivery (spec, detailed design, code) against the task statement, gateway protocol and evaluation cases:
  13 round-fatal / 18 case-level / 11 quality findings, re-balanced A/B/C ownership, milestones, shared change
  requests, and per-task model allocation

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

Candidate Harnesses currently under evaluation include OpenCode, Pi, Hermes, Goose and DeepSeek Harness. Final selections depend on Windows compatibility, internal-model compatibility, task quality and automated deployment stability.

## Repository status

The repository contains the preserved competition and architecture inputs plus the canonical engineering baseline. Real OpenCode, Hermes, Pi, and internal-network integrations remain assigned implementation work and are not represented as completed by the common framework.
