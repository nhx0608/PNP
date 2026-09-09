# Shared-module ownership

Read the repository AGENTS.md and docs/spec/contracts.md. This directory is shared infrastructure, not an A/B feature workspace. Changes require a separate contract/framework PR and tests for both adapter families. No engine-specific imports, model credentials, task-ID logic, or side-effect replay. Preserve public behavior and persistent-data compatibility.
