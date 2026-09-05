# 全部交付文件审核索引

[离线逐文件审阅页](REVIEW-ALL.html) 将源代码、文档、测试、配置和证据嵌入一个可搜索文件，无需外部网络。以下每个路径也可以单独打开。

审核顺序：需求与范围 → 架构/技术栈 → 公共契约 → 内网边界 → A/B/C工作包 → 编程规范与Prompt → 公共代码与测试 → 实际验证覆盖。

A负责ACP/OpenCode/Hermes，B负责Pi RPC/原生扩展，C负责内网模型/工具/授权和内网验证。公共框架是同一代码基线，A/B不是串行关系。

生成的校验入口：[FILE-MANIFEST.json](FILE-MANIFEST.json)、[SHA256SUMS.txt](SHA256SUMS.txt)、[VERIFY.mjs](VERIFY.mjs)。在目录中运行 `node VERIFY.mjs` 验证全部文件摘要。审核资料不是生产运行依赖。

实际验证为Linux/Node22下的36项公共测试；完整HTTP构建、Windows、Node24与内网验证范围见 [coverage.md](verification/coverage.md)。未提供虚构依赖锁或真实引擎成功记录。

| # | 文件 | 所有者 | 用途 |
|---:|---|---|---|
| 1 | [.gitattributes](.gitattributes) | 共同 | 入口与配置 |
| 2 | [.github/workflows/ci.yml](.github/workflows/ci.yml) | 共同 | 入口与配置 |
| 3 | [.gitignore](.gitignore) | 共同 | 入口与配置 |
| 4 | [AGENTS.md](AGENTS.md) | 共同 | 入口与配置 |
| 5 | [CLAUDE.md](CLAUDE.md) | 共同 | 入口与配置 |
| 6 | [INSTRUCTION.md](INSTRUCTION.md) | 共同 | 入口与配置 |
| 7 | [README.md](README.md) | 共同 | 入口与配置 |
| 8 | [VERIFY.mjs](VERIFY.mjs) | 共同 | 入口与配置 |
| 9 | [code/.env.example](code/.env.example) | 共同 | 入口与配置 |
| 10 | [code/.gitignore](code/.gitignore) | 共同 | 入口与配置 |
| 11 | [code/README.md](code/README.md) | 共同 | 入口与配置 |
| 12 | [code/config/engines/hermes.json](code/config/engines/hermes.json) | A | 入口与配置 |
| 13 | [code/config/engines/opencode.json](code/config/engines/opencode.json) | A | 入口与配置 |
| 14 | [code/config/engines/pi.json](code/config/engines/pi.json) | B | 入口与配置 |
| 15 | [code/config/internal.example.json](code/config/internal.example.json) | C | 入口与配置 |
| 16 | [code/config/release-profile.json](code/config/release-profile.json) | 共同 | 入口与配置 |
| 17 | [code/engines.lock.example.json](code/engines.lock.example.json) | 共同 | 入口与配置 |
| 18 | [code/native/windows/JobHost.cs](code/native/windows/JobHost.cs) | 共同 | Windows宿主源码 |
| 19 | [code/native/windows/job-host.ps1](code/native/windows/job-host.ps1) | 共同 | Windows宿主源码 |
| 20 | [code/package.json](code/package.json) | 共同 | 入口与配置 |
| 21 | [code/scripts/check-boundaries.mjs](code/scripts/check-boundaries.mjs) | 共同 | 执行脚本 |
| 22 | [code/scripts/doctor.mjs](code/scripts/doctor.mjs) | 共同 | 执行脚本 |
| 23 | [code/scripts/export-diagnostics.mjs](code/scripts/export-diagnostics.mjs) | 共同 | 执行脚本 |
| 24 | [code/scripts/foundation-check.mjs](code/scripts/foundation-check.mjs) | 共同 | 执行脚本 |
| 25 | [code/scripts/freeze-dependencies.mjs](code/scripts/freeze-dependencies.mjs) | 共同 | 执行脚本 |
| 26 | [code/scripts/install.ps1](code/scripts/install.ps1) | 共同 | 执行脚本 |
| 27 | [code/scripts/lib.mjs](code/scripts/lib.mjs) | 共同 | 执行脚本 |
| 28 | [code/scripts/recover.mjs](code/scripts/recover.mjs) | 共同 | 执行脚本 |
| 29 | [code/scripts/release-check.mjs](code/scripts/release-check.mjs) | 共同 | 执行脚本 |
| 30 | [code/scripts/start.ps1](code/scripts/start.ps1) | 共同 | 执行脚本 |
| 31 | [code/scripts/test.mjs](code/scripts/test.mjs) | 共同 | 执行脚本 |
| 32 | [code/src/assets/resolver.ts](code/src/assets/resolver.ts) | 共同 | 实现源码 |
| 33 | [code/src/contracts/AGENTS.md](code/src/contracts/AGENTS.md) | 共同 | 实现源码 |
| 34 | [code/src/contracts/host.ts](code/src/contracts/host.ts) | 共同 | 实现源码 |
| 35 | [code/src/contracts/index.ts](code/src/contracts/index.ts) | 共同 | 实现源码 |
| 36 | [code/src/core/AGENTS.md](code/src/core/AGENTS.md) | 共同 | 实现源码 |
| 37 | [code/src/core/errors.ts](code/src/core/errors.ts) | 共同 | 实现源码 |
| 38 | [code/src/core/gateway-core.ts](code/src/core/gateway-core.ts) | 共同 | 实现源码 |
| 39 | [code/src/core/interactions.ts](code/src/core/interactions.ts) | 共同 | 实现源码 |
| 40 | [code/src/core/journal.ts](code/src/core/journal.ts) | 共同 | 实现源码 |
| 41 | [code/src/drivers/acp/AGENTS.md](code/src/drivers/acp/AGENTS.md) | A | 实现源码 |
| 42 | [code/src/drivers/pi-rpc/AGENTS.md](code/src/drivers/pi-rpc/AGENTS.md) | B | 实现源码 |
| 43 | [code/src/engines/hermes/AGENTS.md](code/src/engines/hermes/AGENTS.md) | A | 实现源码 |
| 44 | [code/src/engines/hermes/pack.ts](code/src/engines/hermes/pack.ts) | A | 实现源码 |
| 45 | [code/src/engines/mock/pack.ts](code/src/engines/mock/pack.ts) | 共同 | 实现源码 |
| 46 | [code/src/engines/opencode/AGENTS.md](code/src/engines/opencode/AGENTS.md) | A | 实现源码 |
| 47 | [code/src/engines/opencode/pack.ts](code/src/engines/opencode/pack.ts) | A | 实现源码 |
| 48 | [code/src/engines/pi/AGENTS.md](code/src/engines/pi/AGENTS.md) | B | 实现源码 |
| 49 | [code/src/engines/pi/pack.ts](code/src/engines/pi/pack.ts) | B | 实现源码 |
| 50 | [code/src/gateway/AGENTS.md](code/src/gateway/AGENTS.md) | 共同 | 实现源码 |
| 51 | [code/src/gateway/app.ts](code/src/gateway/app.ts) | 共同 | 实现源码 |
| 52 | [code/src/gateway/schemas.ts](code/src/gateway/schemas.ts) | 共同 | 实现源码 |
| 53 | [code/src/integration/configured/provider.ts](code/src/integration/configured/provider.ts) | 共同 | 实现源码 |
| 54 | [code/src/integration/internal/AGENTS.md](code/src/integration/internal/AGENTS.md) | C | 实现源码 |
| 55 | [code/src/integration/internal/provider.ts](code/src/integration/internal/provider.ts) | C | 实现源码 |
| 56 | [code/src/integration/mock/provider.ts](code/src/integration/mock/provider.ts) | 共同 | 实现源码 |
| 57 | [code/src/main.ts](code/src/main.ts) | 共同 | 实现源码 |
| 58 | [code/src/registry/index.ts](code/src/registry/index.ts) | 共同 | 实现源码 |
| 59 | [code/src/runtime/AGENTS.md](code/src/runtime/AGENTS.md) | 共同 | 实现源码 |
| 60 | [code/src/runtime/deadline.ts](code/src/runtime/deadline.ts) | 共同 | 实现源码 |
| 61 | [code/src/runtime/instance-lock.ts](code/src/runtime/instance-lock.ts) | 共同 | 实现源码 |
| 62 | [code/src/runtime/jsonl.ts](code/src/runtime/jsonl.ts) | 共同 | 实现源码 |
| 63 | [code/src/runtime/process-host.ts](code/src/runtime/process-host.ts) | 共同 | 实现源码 |
| 64 | [code/src/runtime/resource-scope.ts](code/src/runtime/resource-scope.ts) | 共同 | 实现源码 |
| 65 | [code/src/runtime/windows-host.ts](code/src/runtime/windows-host.ts) | 共同 | 实现源码 |
| 66 | [code/src/security/redaction.ts](code/src/security/redaction.ts) | 共同 | 实现源码 |
| 67 | [code/src/security/workspace.ts](code/src/security/workspace.ts) | 共同 | 实现源码 |
| 68 | [code/src/storage/AGENTS.md](code/src/storage/AGENTS.md) | 共同 | 实现源码 |
| 69 | [code/src/storage/protocol.ts](code/src/storage/protocol.ts) | 共同 | 实现源码 |
| 70 | [code/src/storage/store.ts](code/src/storage/store.ts) | 共同 | 实现源码 |
| 71 | [code/src/storage/worker.ts](code/src/storage/worker.ts) | 共同 | 实现源码 |
| 72 | [code/tests/contract/gateway.test.ts](code/tests/contract/gateway.test.ts) | 共同 | 测试代码 |
| 73 | [code/tests/contract/sse.test.ts](code/tests/contract/sse.test.ts) | 共同 | 测试代码 |
| 74 | [code/tests/kit/engine-contract.ts](code/tests/kit/engine-contract.ts) | 共同 | 测试代码 |
| 75 | [code/tests/unit/config-assets.test.ts](code/tests/unit/config-assets.test.ts) | 共同 | 测试代码 |
| 76 | [code/tests/unit/contracts.test.ts](code/tests/unit/contracts.test.ts) | 共同 | 测试代码 |
| 77 | [code/tests/unit/core.test.ts](code/tests/unit/core.test.ts) | 共同 | 测试代码 |
| 78 | [code/tests/unit/runtime.test.ts](code/tests/unit/runtime.test.ts) | 共同 | 测试代码 |
| 79 | [code/toolchain.json](code/toolchain.json) | 共同 | 入口与配置 |
| 80 | [code/tsconfig.json](code/tsconfig.json) | 共同 | 入口与配置 |
| 81 | [docs/engines/hermes.md](docs/engines/hermes.md) | A | 入口与配置 |
| 82 | [docs/engines/opencode.md](docs/engines/opencode.md) | A | 入口与配置 |
| 83 | [docs/engines/pi.md](docs/engines/pi.md) | B | 入口与配置 |
| 84 | [docs/internal/README.md](docs/internal/README.md) | C | 入口与配置 |
| 85 | [docs/reference/README.md](docs/reference/README.md) | 共同 | 资料核对 |
| 86 | [docs/reference/evaluation-cases.md](docs/reference/evaluation-cases.md) | 共同 | 资料核对 |
| 87 | [docs/reference/gateway-spec.md](docs/reference/gateway-spec.md) | 共同 | 资料核对 |
| 88 | [docs/spec/architecture.md](docs/spec/architecture.md) | 共同 | 架构与契约 |
| 89 | [docs/spec/contracts.md](docs/spec/contracts.md) | 共同 | 架构与契约 |
| 90 | [docs/spec/dfx-and-testing.md](docs/spec/dfx-and-testing.md) | 共同 | 架构与契约 |
| 91 | [docs/spec/internal-integration.md](docs/spec/internal-integration.md) | 共同 | 架构与契约 |
| 92 | [docs/spec/requirements.md](docs/spec/requirements.md) | 共同 | 架构与契约 |
| 93 | [docs/spec/sources.md](docs/spec/sources.md) | 共同 | 架构与契约 |
| 94 | [docs/spec/technology.md](docs/spec/technology.md) | 共同 | 架构与契约 |
| 95 | [docs/team/change-request.md](docs/team/change-request.md) | 共同 | 分工与协作 |
| 96 | [docs/team/collaboration.md](docs/team/collaboration.md) | 共同 | 分工与协作 |
| 97 | [docs/team/handoff-template.md](docs/team/handoff-template.md) | 共同 | 分工与协作 |
| 98 | [docs/team/ownership.json](docs/team/ownership.json) | 共同 | 分工与协作 |
| 99 | [docs/team/repository-import.md](docs/team/repository-import.md) | 共同 | 分工与协作 |
| 100 | [docs/team/work-packages.md](docs/team/work-packages.md) | 共同 | 分工与协作 |
| 101 | [prompts/00-baseline-check.md](prompts/00-baseline-check.md) | 共同 | Prompt |
| 102 | [prompts/01-A-acp.md](prompts/01-A-acp.md) | 共同 | Prompt |
| 103 | [prompts/02-B-pi.md](prompts/02-B-pi.md) | 共同 | Prompt |
| 104 | [prompts/03-C-internal.md](prompts/03-C-internal.md) | 共同 | Prompt |
| 105 | [prompts/04-integration.md](prompts/04-integration.md) | 共同 | Prompt |
| 106 | [prompts/05-internal-acceptance.md](prompts/05-internal-acceptance.md) | 共同 | Prompt |
| 107 | [prompts/06-review.md](prompts/06-review.md) | 共同 | Prompt |
| 108 | [prompts/07-resume.md](prompts/07-resume.md) | 共同 | Prompt |
| 109 | [prompts/08-handoff.md](prompts/08-handoff.md) | 共同 | Prompt |
| 110 | [prompts/README.md](prompts/README.md) | 共同 | Prompt |
| 111 | [verification/coverage.md](verification/coverage.md) | 共同 | 验证证据 |
| 112 | [verification/internal/evidence.example.json](verification/internal/evidence.example.json) | C | 验证证据 |
| 113 | [verification/logs/boundaries.txt](verification/logs/boundaries.txt) | 共同 | 验证证据 |
| 114 | [verification/logs/core-typecheck.txt](verification/logs/core-typecheck.txt) | 共同 | 验证证据 |
| 115 | [verification/logs/npm-resolution.txt](verification/logs/npm-resolution.txt) | 共同 | 验证证据 |
| 116 | [verification/logs/release-gate.json](verification/logs/release-gate.json) | 共同 | 验证证据 |
| 117 | [verification/logs/unit.tap](verification/logs/unit.tap) | 共同 | 验证证据 |
| 118 | [verification/results.json](verification/results.json) | 共同 | 验证证据 |
