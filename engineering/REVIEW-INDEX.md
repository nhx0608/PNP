# 全部交付文件审核索引

[离线逐文件审阅页](REVIEW-ALL.html) 是初始交付时生成的历史快照，不会随实现自动重建，不能用于判断当前代码状态。当前审核必须以下方索引指向的真实文件、`FILE-MANIFEST.json` 和 `verification/results.json` 为准。

审核顺序：需求与范围 → 架构/技术栈 → 公共契约 → 内网边界 → A/B/C工作包 → 编程规范与Prompt → 公共代码与测试 → 实际验证覆盖。

A负责ACP/OpenCode/Hermes，B负责Pi RPC/原生扩展，C负责内网模型/工具/授权和内网验证。公共框架是同一代码基线，A/B不是串行关系。

生成的校验入口：[FILE-MANIFEST.json](FILE-MANIFEST.json)、[SHA256SUMS.txt](SHA256SUMS.txt)、[VERIFY.mjs](VERIFY.mjs)。在目录中运行 `node VERIFY.mjs` 验证全部文件摘要；两者都由 `code/scripts/refresh-manifest.mjs` 生成，不手写，且 `npm run foundation:check` 已把 `node VERIFY.mjs` 接入自动门禁——清单与树不一致时门禁直接失败，不再是事后才发现的静默漂移。审核资料不是生产运行依赖。

当前在 Windows x64 / Node 24.19.0 下完成公共基线：单元及适配器测试274项通过、1项跳过，契约测试4项全部通过；真实 OpenCode 1.18.29 契约1.1端到端检查14/14通过。Pi与授权内网验收仍未完成，详见 [coverage.md](verification/coverage.md) 和 [results.json](verification/results.json)。

下表由 `node scripts/refresh-manifest.mjs`（在 `code/` 目录下运行）与 `FILE-MANIFEST.json` 同步生成，不要手工编辑标记之间的内容。

<!-- FILE-TABLE:START -->
| # | 文件 | 所有者 | 用途 |
|---:|---|---|---|
| 1 | [.gitattributes](.gitattributes) | 共同 | 入口与配置 |
| 2 | [.github/workflows/ci.yml](.github/workflows/ci.yml) | 共同 | 入口与配置 |
| 3 | [.gitignore](.gitignore) | 共同 | 入口与配置 |
| 4 | [AGENTS.md](AGENTS.md) | 共同 | 入口与配置 |
| 5 | [CLAUDE.md](CLAUDE.md) | 共同 | 入口与配置 |
| 6 | [code/.env.example](code/.env.example) | 共同 | 入口与配置 |
| 7 | [code/.gitignore](code/.gitignore) | 共同 | 入口与配置 |
| 8 | [code/assets/packs/README.md](code/assets/packs/README.md) | 共同 | 能力包 |
| 9 | [code/config/configured.example.json](code/config/configured.example.json) | 共同 | 入口与配置 |
| 10 | [code/config/engines/hermes.json](code/config/engines/hermes.json) | A | 入口与配置 |
| 11 | [code/config/engines/opencode.json](code/config/engines/opencode.json) | A | 入口与配置 |
| 12 | [code/config/engines/pi.json](code/config/engines/pi.json) | B | 入口与配置 |
| 13 | [code/config/internal.example.json](code/config/internal.example.json) | C | 入口与配置 |
| 14 | [code/config/release-profile.json](code/config/release-profile.json) | 共同 | 入口与配置 |
| 15 | [code/engines.lock.example.json](code/engines.lock.example.json) | 共同 | 入口与配置 |
| 16 | [code/engines.lock.json](code/engines.lock.json) | 共同 | 入口与配置 |
| 17 | [code/native/windows/job-host.ps1](code/native/windows/job-host.ps1) | 共同 | Windows宿主源码 |
| 18 | [code/native/windows/JobHost.cs](code/native/windows/JobHost.cs) | 共同 | Windows宿主源码 |
| 19 | [code/package-lock.json](code/package-lock.json) | 共同 | 入口与配置 |
| 20 | [code/package.json](code/package.json) | 共同 | 入口与配置 |
| 21 | [code/README.md](code/README.md) | 共同 | 入口与配置 |
| 22 | [code/scripts/check-boundaries.mjs](code/scripts/check-boundaries.mjs) | 共同 | 执行脚本 |
| 23 | [code/scripts/doctor.mjs](code/scripts/doctor.mjs) | 共同 | 执行脚本 |
| 24 | [code/scripts/e2e/ci-smoke.mjs](code/scripts/e2e/ci-smoke.mjs) | 共同 | 执行脚本 |
| 25 | [code/scripts/e2e/mock-model-server.mjs](code/scripts/e2e/mock-model-server.mjs) | 共同 | 执行脚本 |
| 26 | [code/scripts/e2e/run-e2e.mjs](code/scripts/e2e/run-e2e.mjs) | 共同 | 执行脚本 |
| 27 | [code/scripts/export-diagnostics.mjs](code/scripts/export-diagnostics.mjs) | 共同 | 执行脚本 |
| 28 | [code/scripts/foundation-check.mjs](code/scripts/foundation-check.mjs) | 共同 | 执行脚本 |
| 29 | [code/scripts/freeze-dependencies.mjs](code/scripts/freeze-dependencies.mjs) | 共同 | 执行脚本 |
| 30 | [code/scripts/install.ps1](code/scripts/install.ps1) | 共同 | 执行脚本 |
| 31 | [code/scripts/lib.mjs](code/scripts/lib.mjs) | 共同 | 执行脚本 |
| 32 | [code/scripts/package-release.mjs](code/scripts/package-release.mjs) | 共同 | 执行脚本 |
| 33 | [code/scripts/recover.mjs](code/scripts/recover.mjs) | 共同 | 执行脚本 |
| 34 | [code/scripts/refresh-manifest.mjs](code/scripts/refresh-manifest.mjs) | 共同 | 执行脚本 |
| 35 | [code/scripts/release-check.mjs](code/scripts/release-check.mjs) | 共同 | 执行脚本 |
| 36 | [code/scripts/start.ps1](code/scripts/start.ps1) | 共同 | 执行脚本 |
| 37 | [code/scripts/strip-only-check.mjs](code/scripts/strip-only-check.mjs) | 共同 | 执行脚本 |
| 38 | [code/scripts/test.mjs](code/scripts/test.mjs) | 共同 | 执行脚本 |
| 39 | [code/src/assets/resolver.ts](code/src/assets/resolver.ts) | 共同 | 实现源码 |
| 40 | [code/src/contracts/AGENTS.md](code/src/contracts/AGENTS.md) | 共同 | 实现源码 |
| 41 | [code/src/contracts/host.ts](code/src/contracts/host.ts) | 共同 | 实现源码 |
| 42 | [code/src/contracts/index.ts](code/src/contracts/index.ts) | 共同 | 实现源码 |
| 43 | [code/src/core/AGENTS.md](code/src/core/AGENTS.md) | 共同 | 实现源码 |
| 44 | [code/src/core/errors.ts](code/src/core/errors.ts) | 共同 | 实现源码 |
| 45 | [code/src/core/gateway-core.ts](code/src/core/gateway-core.ts) | 共同 | 实现源码 |
| 46 | [code/src/core/interactions.ts](code/src/core/interactions.ts) | 共同 | 实现源码 |
| 47 | [code/src/core/journal.ts](code/src/core/journal.ts) | 共同 | 实现源码 |
| 48 | [code/src/drivers/acp/AGENTS.md](code/src/drivers/acp/AGENTS.md) | A | 实现源码 |
| 49 | [code/src/drivers/acp/capabilities.ts](code/src/drivers/acp/capabilities.ts) | A | 实现源码 |
| 50 | [code/src/drivers/acp/channel.ts](code/src/drivers/acp/channel.ts) | A | 实现源码 |
| 51 | [code/src/drivers/acp/json.ts](code/src/drivers/acp/json.ts) | A | 实现源码 |
| 52 | [code/src/drivers/acp/transport.ts](code/src/drivers/acp/transport.ts) | A | 实现源码 |
| 53 | [code/src/drivers/acp/updates.ts](code/src/drivers/acp/updates.ts) | A | 实现源码 |
| 54 | [code/src/drivers/pi-rpc/AGENTS.md](code/src/drivers/pi-rpc/AGENTS.md) | B | 实现源码 |
| 55 | [code/src/engines/hermes/AGENTS.md](code/src/engines/hermes/AGENTS.md) | A | 实现源码 |
| 56 | [code/src/engines/hermes/pack.ts](code/src/engines/hermes/pack.ts) | A | 实现源码 |
| 57 | [code/src/engines/mock/pack.ts](code/src/engines/mock/pack.ts) | 共同 | 实现源码 |
| 58 | [code/src/engines/opencode/AGENTS.md](code/src/engines/opencode/AGENTS.md) | A | 实现源码 |
| 59 | [code/src/engines/opencode/assets.ts](code/src/engines/opencode/assets.ts) | A | 实现源码 |
| 60 | [code/src/engines/opencode/config.ts](code/src/engines/opencode/config.ts) | A | 实现源码 |
| 61 | [code/src/engines/opencode/executable.ts](code/src/engines/opencode/executable.ts) | A | 实现源码 |
| 62 | [code/src/engines/opencode/native-config.ts](code/src/engines/opencode/native-config.ts) | A | 实现源码 |
| 63 | [code/src/engines/opencode/pack.ts](code/src/engines/opencode/pack.ts) | A | 实现源码 |
| 64 | [code/src/engines/pi/AGENTS.md](code/src/engines/pi/AGENTS.md) | B | 实现源码 |
| 65 | [code/src/engines/pi/pack.ts](code/src/engines/pi/pack.ts) | B | 实现源码 |
| 66 | [code/src/gateway/AGENTS.md](code/src/gateway/AGENTS.md) | 共同 | 实现源码 |
| 67 | [code/src/gateway/app.ts](code/src/gateway/app.ts) | 共同 | 实现源码 |
| 68 | [code/src/gateway/schemas.ts](code/src/gateway/schemas.ts) | 共同 | 实现源码 |
| 69 | [code/src/integration/configured/provider.ts](code/src/integration/configured/provider.ts) | 共同 | 实现源码 |
| 70 | [code/src/integration/index.ts](code/src/integration/index.ts) | 共同 | 实现源码 |
| 71 | [code/src/integration/internal/AGENTS.md](code/src/integration/internal/AGENTS.md) | C | 实现源码 |
| 72 | [code/src/integration/internal/provider.ts](code/src/integration/internal/provider.ts) | C | 实现源码 |
| 73 | [code/src/integration/mock/provider.ts](code/src/integration/mock/provider.ts) | 共同 | 实现源码 |
| 74 | [code/src/main.ts](code/src/main.ts) | 共同 | 实现源码 |
| 75 | [code/src/registry/index.ts](code/src/registry/index.ts) | 共同 | 实现源码 |
| 76 | [code/src/runtime/AGENTS.md](code/src/runtime/AGENTS.md) | 共同 | 实现源码 |
| 77 | [code/src/runtime/deadline.ts](code/src/runtime/deadline.ts) | 共同 | 实现源码 |
| 78 | [code/src/runtime/instance-lock.ts](code/src/runtime/instance-lock.ts) | 共同 | 实现源码 |
| 79 | [code/src/runtime/jsonl.ts](code/src/runtime/jsonl.ts) | 共同 | 实现源码 |
| 80 | [code/src/runtime/process-host.ts](code/src/runtime/process-host.ts) | 共同 | 实现源码 |
| 81 | [code/src/runtime/recovery.ts](code/src/runtime/recovery.ts) | 共同 | 实现源码 |
| 82 | [code/src/runtime/resource-scope.ts](code/src/runtime/resource-scope.ts) | 共同 | 实现源码 |
| 83 | [code/src/runtime/windows-host.ts](code/src/runtime/windows-host.ts) | 共同 | 实现源码 |
| 84 | [code/src/security/redaction.ts](code/src/security/redaction.ts) | 共同 | 实现源码 |
| 85 | [code/src/security/workspace.ts](code/src/security/workspace.ts) | 共同 | 实现源码 |
| 86 | [code/src/storage/AGENTS.md](code/src/storage/AGENTS.md) | 共同 | 实现源码 |
| 87 | [code/src/storage/protocol.ts](code/src/storage/protocol.ts) | 共同 | 实现源码 |
| 88 | [code/src/storage/store.ts](code/src/storage/store.ts) | 共同 | 实现源码 |
| 89 | [code/src/storage/worker.ts](code/src/storage/worker.ts) | 共同 | 实现源码 |
| 90 | [code/tests/adapters/acp/cancel.test.ts](code/tests/adapters/acp/cancel.test.ts) | A | 测试代码 |
| 91 | [code/tests/adapters/acp/handshake.test.ts](code/tests/adapters/acp/handshake.test.ts) | A | 测试代码 |
| 92 | [code/tests/adapters/acp/harness.ts](code/tests/adapters/acp/harness.ts) | A | 测试代码 |
| 93 | [code/tests/adapters/acp/json.test.ts](code/tests/adapters/acp/json.test.ts) | A | 测试代码 |
| 94 | [code/tests/adapters/acp/lifecycle.test.ts](code/tests/adapters/acp/lifecycle.test.ts) | A | 测试代码 |
| 95 | [code/tests/adapters/acp/permission.test.ts](code/tests/adapters/acp/permission.test.ts) | A | 测试代码 |
| 96 | [code/tests/adapters/acp/projection.test.ts](code/tests/adapters/acp/projection.test.ts) | A | 测试代码 |
| 97 | [code/tests/adapters/acp/script.ts](code/tests/adapters/acp/script.ts) | A | 测试代码 |
| 98 | [code/tests/adapters/acp/updates.test.ts](code/tests/adapters/acp/updates.test.ts) | A | 测试代码 |
| 99 | [code/tests/adapters/opencode/assets.test.ts](code/tests/adapters/opencode/assets.test.ts) | 共同 | 测试代码 |
| 100 | [code/tests/adapters/opencode/config.test.ts](code/tests/adapters/opencode/config.test.ts) | 共同 | 测试代码 |
| 101 | [code/tests/adapters/opencode/executable.test.ts](code/tests/adapters/opencode/executable.test.ts) | 共同 | 测试代码 |
| 102 | [code/tests/adapters/opencode/native-config.test.ts](code/tests/adapters/opencode/native-config.test.ts) | 共同 | 测试代码 |
| 103 | [code/tests/adapters/opencode/pack.test.ts](code/tests/adapters/opencode/pack.test.ts) | 共同 | 测试代码 |
| 104 | [code/tests/contract/gateway.test.ts](code/tests/contract/gateway.test.ts) | 共同 | 测试代码 |
| 105 | [code/tests/contract/sse.test.ts](code/tests/contract/sse.test.ts) | 共同 | 测试代码 |
| 106 | [code/tests/kit/engine-contract.ts](code/tests/kit/engine-contract.ts) | 共同 | 测试代码 |
| 107 | [code/tests/kit/fake-host.ts](code/tests/kit/fake-host.ts) | 共同 | 测试代码 |
| 108 | [code/tests/unit/config-assets.test.ts](code/tests/unit/config-assets.test.ts) | 共同 | 测试代码 |
| 109 | [code/tests/unit/contracts.test.ts](code/tests/unit/contracts.test.ts) | 共同 | 测试代码 |
| 110 | [code/tests/unit/core.test.ts](code/tests/unit/core.test.ts) | 共同 | 测试代码 |
| 111 | [code/tests/unit/process-host.test.ts](code/tests/unit/process-host.test.ts) | 共同 | 测试代码 |
| 112 | [code/tests/unit/runtime.test.ts](code/tests/unit/runtime.test.ts) | 共同 | 测试代码 |
| 113 | [code/toolchain.json](code/toolchain.json) | 共同 | 入口与配置 |
| 114 | [code/tsconfig.json](code/tsconfig.json) | 共同 | 入口与配置 |
| 115 | [docs/engines/hermes.md](docs/engines/hermes.md) | A | 入口与配置 |
| 116 | [docs/engines/opencode.md](docs/engines/opencode.md) | A | 入口与配置 |
| 117 | [docs/engines/pi.md](docs/engines/pi.md) | B | 入口与配置 |
| 118 | [docs/internal/README.md](docs/internal/README.md) | C | 入口与配置 |
| 119 | [docs/reference/evaluation-cases.md](docs/reference/evaluation-cases.md) | 共同 | 资料核对 |
| 120 | [docs/reference/gateway-spec.md](docs/reference/gateway-spec.md) | 共同 | 资料核对 |
| 121 | [docs/reference/README.md](docs/reference/README.md) | 共同 | 资料核对 |
| 122 | [docs/spec/architecture.md](docs/spec/architecture.md) | 共同 | 架构与契约 |
| 123 | [docs/spec/contracts.md](docs/spec/contracts.md) | 共同 | 架构与契约 |
| 124 | [docs/spec/dfx-and-testing.md](docs/spec/dfx-and-testing.md) | 共同 | 架构与契约 |
| 125 | [docs/spec/internal-integration.md](docs/spec/internal-integration.md) | 共同 | 架构与契约 |
| 126 | [docs/spec/requirements.md](docs/spec/requirements.md) | 共同 | 架构与契约 |
| 127 | [docs/spec/sources.md](docs/spec/sources.md) | 共同 | 架构与契约 |
| 128 | [docs/spec/technology.md](docs/spec/technology.md) | 共同 | 架构与契约 |
| 129 | [docs/team/change-request.md](docs/team/change-request.md) | 共同 | 分工与协作 |
| 130 | [docs/team/collaboration.md](docs/team/collaboration.md) | 共同 | 分工与协作 |
| 131 | [docs/team/handoff-current.md](docs/team/handoff-current.md) | 共同 | 分工与协作 |
| 132 | [docs/team/handoff-template.md](docs/team/handoff-template.md) | 共同 | 分工与协作 |
| 133 | [docs/team/ownership.json](docs/team/ownership.json) | 共同 | 分工与协作 |
| 134 | [docs/team/repository-import.md](docs/team/repository-import.md) | 共同 | 分工与协作 |
| 135 | [docs/team/work-packages.md](docs/team/work-packages.md) | 共同 | 分工与协作 |
| 136 | [INSTRUCTION.md](INSTRUCTION.md) | 共同 | 入口与配置 |
| 137 | [prompts/00-baseline-check.md](prompts/00-baseline-check.md) | 共同 | Prompt |
| 138 | [prompts/01-A-acp.md](prompts/01-A-acp.md) | 共同 | Prompt |
| 139 | [prompts/02-B-pi.md](prompts/02-B-pi.md) | 共同 | Prompt |
| 140 | [prompts/03-C-internal.md](prompts/03-C-internal.md) | 共同 | Prompt |
| 141 | [prompts/04-integration.md](prompts/04-integration.md) | 共同 | Prompt |
| 142 | [prompts/05-internal-acceptance.md](prompts/05-internal-acceptance.md) | 共同 | Prompt |
| 143 | [prompts/06-review.md](prompts/06-review.md) | 共同 | Prompt |
| 144 | [prompts/07-resume.md](prompts/07-resume.md) | 共同 | Prompt |
| 145 | [prompts/08-handoff.md](prompts/08-handoff.md) | 共同 | Prompt |
| 146 | [prompts/README.md](prompts/README.md) | 共同 | Prompt |
| 147 | [README.md](README.md) | 共同 | 入口与配置 |
| 148 | [verification/coverage.md](verification/coverage.md) | 共同 | 验证证据 |
| 149 | [verification/internal/evidence.example.json](verification/internal/evidence.example.json) | C | 验证证据 |
| 150 | [verification/logs/boundaries.txt](verification/logs/boundaries.txt) | 共同 | 验证证据 |
| 151 | [verification/logs/core-typecheck.txt](verification/logs/core-typecheck.txt) | 共同 | 验证证据 |
| 152 | [verification/logs/npm-resolution.txt](verification/logs/npm-resolution.txt) | 共同 | 验证证据 |
| 153 | [verification/logs/release-gate.json](verification/logs/release-gate.json) | 共同 | 验证证据 |
| 154 | [verification/logs/unit.tap](verification/logs/unit.tap) | 共同 | 验证证据 |
| 155 | [verification/results.json](verification/results.json) | 共同 | 验证证据 |
| 156 | [VERIFY.mjs](VERIFY.mjs) | 共同 | 入口与配置 |
<!-- FILE-TABLE:END -->
