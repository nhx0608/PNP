# Owner: B

Read root AGENTS.md, docs/spec/contracts.md and the assigned work package. Implement this adapter using ProcessHost, ResourceScope, EventSink and per-run IntegrationContext. Do not import Fastify, storage, GatewayCore or node:child_process. Request ACK is not completion; cancel ACK is not quiescence. Never silently switch engine/model or replay a side effect. Use tests/kit/engine-contract.ts and add protocol-specific failure tests. Shared changes require a separate reviewed PR.
