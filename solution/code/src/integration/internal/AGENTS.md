# Owner: C

Read root AGENTS.md and docs/spec/internal-integration.md. Supply IntegrationProvider, model authentication, ToolBinding and authorization. Do not implement an Agent loop or import an EnginePack. Do not invent private API schemas. Use explicit approved fixtures; redact secrets before every log/export. Enforce policy at the actual service/tool boundary and do not retry uncertain side effects.
