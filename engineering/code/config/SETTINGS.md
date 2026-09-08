# PNP settings

`settings.json` is the single runtime settings file for model, instruction, permission and MCP
configuration across Agent Cores. PNP resolves `common` first and then applies `cores.<engineId>`
overrides. Engine/Integration adapters consume the effective settings and translate supported
capabilities into native configuration; callers do not maintain a separate business-side settings
file for OpenCode, Pi, Hermes, or future Cores.

Nothing secret belongs in this file. Every endpoint, credential, header and certificate is named by
the **environment variable that holds it**, and the value is read from the process environment when
it is needed.

## Location

Default:

```text
engineering/code/config/settings.json
```

`PNP_SETTINGS` selects a different file. An absolute path is used as given; a relative one is
resolved against the package root (`engineering/code/`), so a deployment can name a file inside the
delivery without knowing where it was unpacked:

```powershell
$env:PNP_SETTINGS='config/settings.json'          # inside the delivery
$env:PNP_SETTINGS='D:\pnp-private\settings.json'  # outside it
```

`PNP_CONFIGURED_PROFILE`, `PNP_LOCAL_ENV_FILE` and `PNP_MODEL_CA_FILE` follow the same rule.

## What a deployment actually sets

The shipped `settings.json` declares one model whose every part is a variable name, so a normal
deployment configures a run without editing any file in the delivery:

| Variable | Required | Meaning |
|---|---|---|
| `PNP_MODEL_ENDPOINT` | yes | The model service endpoint. |
| `PNP_MODEL_ID` | yes | The model name that endpoint expects. It replaces the identifier declared in `settings.json`. |
| `PNP_MODEL_API_KEY` | no | Sent as `Authorization: Bearer <value>`. |
| `PNP_MODEL_HEADERS` | no | A JSON object of additional request headers, for example `{"appid":"..."}`. |
| `PNP_MODEL_CA_FILE` | no | PEM bundle for a private certificate authority. |

Two more switches exist for networks that need them, and neither is a default:

| Variable | Meaning |
|---|---|
| `PNP_ALLOW_HTTP_ENDPOINTS=1` | Allow plain `http` for model endpoints and remote MCP servers outside loopback. |
| `PNP_MODEL_TLS_INSECURE=1` | Ask the engine process not to verify the endpoint's certificate. Last resort; prefer `PNP_MODEL_CA_FILE`. |

Put them in `engineering/code/runtime/local.env` (copy `config/local.env.example`). The gateway loads
that file itself at startup, whichever entry point started it, and prints only the variable NAMES it
applied. A variable already present in the environment wins over the file.

Any `providerID`/`modelID` a caller sends in `prompt_async` resolves to this model: the settings, not
the request, are the endpoint allow-list, and the substitution is published as `model.resolved`.

## Shape

```json
{
  "version": 1,
  "common": {
    "model": {
      "default": { "providerID": "competition" },
      "models": [
        {
          "selection": { "providerID": "competition", "modelID": "default" },
          "modelIDEnvironment": "PNP_MODEL_ID",
          "endpointEnvironment": "PNP_MODEL_ENDPOINT",
          "protocol": "openai-chat",
          "apiKeyEnvironment": "PNP_MODEL_API_KEY",
          "headersEnvironment": "PNP_MODEL_HEADERS",
          "caFileEnvironment": "PNP_MODEL_CA_FILE"
        }
      ]
    },
    "permissions": {
      "default": "allow",
      "operations": {}
    },
    "instructions": ["instructions/competition.md"],
    "mcp": {
      "servers": {
        "office": {
          "transport": "stdio",
          "command": "${PNP_NODE}",
          "args": ["${PNP_CODE_ROOT}/dist/tools/office-mcp/main.js"],
          "sideEffect": "write",
          "enabled": true
        }
      }
    }
  },
  "cores": {
    "opencode": {},
    "pi": {},
    "hermes": {}
  }
}
```

## Inheritance

For the selected Core, PNP calculates an effective settings view:

```text
common.model.models
  + cores.<id>.model.models     (same providerID/modelID replaces common definition)

common.model.default
  -> cores.<id>.model.default   (when present)

common.permissions.default
  -> cores.<id>.permissions.default  (when present)

common.permissions.operations
  + cores.<id>.permissions.operations (Core entry wins for the same operation)

common.instructions
  -> cores.<id>.instructions    (the Core list REPLACES the common list, including with [])

common.mcp.servers
  + cores.<id>.mcp.servers      (same server id is partially overridden by the Core)
```

Therefore an empty Core section inherits everything:

```json
"opencode": {}
```

A Core can override only its default model without copying the common model catalog:

```json
"opencode": {
  "model": {
    "default": { "providerID": "competition", "modelID": "default" }
  }
}
```

A Core can also replace one common model definition for itself by listing the same
`providerID/modelID` under `cores.<id>.model.models`. This is useful when one Core needs a different
protocol-compatible endpoint or header projection while the logical model identity stays the same.

For MCP, the server name is the merge key. A Core can override only the fields it needs:

```json
"opencode": {
  "mcp": {
    "servers": {
      "office": { "enabled": false }
    }
  }
}
```

A Core may also add an MCP server that is not present in `common`, but a new server must contain a
complete valid server definition.

## Models

Model definitions support:

- `selection`: `{providerID, modelID}`, the identity this file uses to refer to the model.
- `protocol`: `openai-chat` or `anthropic-messages`.
- exactly one of `endpoint` (a literal URL) or `endpointEnvironment` (the variable holding one).
- `modelIDEnvironment`: the variable holding the model name the endpoint expects. Its value replaces
  `selection.modelID` when the settings load, so the trajectory, `model.resolved` and the request the
  engine sends all carry the same identifier.
- `headerEnvironment`: request header name -> environment variable name. Every variable named here is
  required; a missing one fails.
- `apiKeyEnvironment`: the variable holding a bare credential. When it is set, `Authorization: Bearer
  <value>` is added — unless an `Authorization` header (in any letter case) already came from
  `headerEnvironment` or `headersEnvironment`. When it is unset, no `Authorization` header is sent
  and nothing fails.
- `headersEnvironment`: one variable whose value is a JSON object of `string -> string` headers,
  merged after `headerEnvironment` and before `apiKeyEnvironment`. Unset or empty contributes
  nothing; anything that is not a JSON object of strings fails the start with
  `MODEL_ENVIRONMENT_INVALID`, naming the variable only.
- `caFileEnvironment`: the variable holding a PEM bundle path (relative paths resolve against the
  package root). The file must exist at startup (`MODEL_CA_FILE_MISSING`), and the resolved absolute
  path is published on the model binding for the Engine Pack to project.

`common.model.default` may name only `providerID` when that provider has exactly one entry in the
effective catalog; with none or several, name `modelID` as well. The effective default must exist in
the effective model list, and its variables are checked at startup: a missing one refuses the start
with `MODEL_ENVIRONMENT_MISSING` and the message lists the variable NAMES (never a value). A model
that is not the default fails the same way, but only when a prompt selects it.

Transport rule, applied to whatever a literal or a variable produced: `https` anywhere, `http` on
loopback, and `http` elsewhere only when `PNP_ALLOW_HTTP_ENDPOINTS=1`. Credentials inside the URL are
never accepted. The same rule governs remote MCP servers.

## Instructions

`common.instructions` is a list of files whose text tells every Core how to behave in this
deployment. Paths are relative to the directory holding the settings file; an absolute path is also
accepted. Each file must exist and be readable when the settings load, or the start fails with
`SETTINGS_INVALID` naming the path.

Each file becomes one instruction asset on every run's `IntegrationContext`
(`{kind:"instruction", id:"instruction:<file name without extension>", path, sha256, required:true}`),
in declaration order, and the Engine Pack projects it into the Core's native instruction mechanism.
`cores.<id>.instructions` replaces the common list for that Core, and `[]` means "no instructions".

The shipped `config/instructions/competition.md` states the delivery's own operating rules
(unattended, never ask the user, use given absolute paths, save outputs where requested, prefer the
`office` tools on Windows PowerShell, verify before claiming success). Edit that file, or point the
setting at your own, to change how both Cores behave.

## Permissions

Effects are:

- `allow` - execute without a user approval.
- `ask` - require the PNP permission loop.
- `deny` - reject the operation; a user reply cannot override it.

`common.permissions.default` applies to every operation not listed explicitly. Operation names are
the names reported by the Engine/Driver. Put an override under `cores.<id>.permissions.operations`
when Cores use different names for the same action.

For OpenCode, PNP projects effective permission settings into the private `opencode.json` before
launch. Operations that PNP must decide as `ask` or `deny` are projected as native `ask` so OpenCode
emits an ACP permission request; the gateway remains the authority and then applies the effective PNP
policy.

`POST /permission/{id}/reply` with `always` is answered exactly like `once` for that request, and the
gateway additionally remembers the operation **for that session**: later requests for the same
operation in the same session resolve as `allow` with `source: "remembered"`. It never becomes a
native allow-always inside an engine, never outlives the session, and never overrides a `deny`.

`PNP_QUESTION_POLICY` decides what happens when an engine asks the user a question. The default,
`auto`, records the question, publishes `question.asked`, answers it immediately with the first
offered option (an empty answer when none was offered) and publishes `question.resolved` with
`source: "auto"`. `PNP_QUESTION_POLICY=ask` restores the interactive behaviour, where the run waits
for `POST /question/{id}/reply`.

## MCP

`common.mcp.servers` defines MCP servers available by default to every Core. `cores.<id>.mcp.servers`
contains Core-specific additions or partial overrides. PNP uses protocol-neutral names rather than
copying one Core's native settings format.

This document defines only **how a compliant MCP Server is configured**. The normative wire/behavior
contract that C must implement is [`PNP-MCP/1`](../../docs/spec/mcp-integration-profile.md): standard
MCP, required Tools surface, version compatibility, tool naming/schema, error semantics,
cancellation, permissions, idempotency and acceptance cases. A valid settings entry does not by
itself prove that the Server conforms to PNP-MCP/1.

Every enabled server becomes one tool binding on each run's IntegrationContext, which is what an
Engine Pack or driver projects. A server with `"enabled": false` is simply absent from that list.

### Placeholders

Two placeholders may appear in `command`, `args[]` and `url`, and they are expanded when the settings
load:

- `${PNP_CODE_ROOT}` - the absolute package root (`engineering/code/`), so a shipped settings file can
  point at a tool inside the delivery without knowing where it was unpacked.
- `${PNP_NODE}` - the absolute path of the Node executable running the gateway.

Any other `${...}` token fails the load with `SETTINGS_INVALID`. In particular there is no
`${ENV:NAME}`: a credential is passed by variable NAME through `env` or `headerEnvironment`, never
expanded into a command line where a process listing would show it.

### stdio

A local MCP server uses the standard MCP stdio process model:

```json
"office": {
  "transport": "stdio",
  "command": "${PNP_NODE}",
  "args": ["${PNP_CODE_ROOT}/dist/tools/office-mcp/main.js"],
  "env": {},
  "enabled": true,
  "sideEffect": "write",
  "timeoutMs": 60000
}
```

Fields:

- `transport`: `stdio`.
- `command`: the MCP server executable. After placeholder expansion it must be an **absolute path**:
  PNP never searches PATH, so what runs is what this file names. A relative command fails the load
  with `INTEGRATION_CONFIG_INVALID` (400). The file itself is not required to exist when the settings
  load, so a build output may be named here.
- `args`: optional argument array; defaults to `[]`.
- `env`: child-process environment variable name -> PNP process environment variable name. Values are
  references, not secrets. The names are resolved to values once, while the gateway loads its
  integration, so a variable this file names but the environment does not set fails the load with
  `INTEGRATION_CONFIG_INVALID` (503) instead of producing a tool that silently does nothing during a
  run. No value is ever written back into this file, logged, or included in an error message.
- `enabled`: optional, defaults to `true`.
- `sideEffect`: optional `read`, `write` or `external`; defaults to `external`. It is what the
  permission policy judges the server's calls by, so the default is the strongest of the three — a
  server that does not say what it does must not slip past a policy that asks about `external`.
- `timeoutMs`: optional positive integer.

There is no `cwd`: ACP's stdio MCP server has no working-directory field, so a value here could only
have been discarded without saying so.

An MCP server that lives outside the delivery is named by its own absolute path:

```json
"welink": {
  "transport": "stdio",
  "command": "D:\\pnp-mcp\\welink-mcp.exe",
  "args": ["serve"],
  "env": { "WELINK_HOME": "PNP_WELINK_HOME" },
  "enabled": true,
  "sideEffect": "external",
  "timeoutMs": 10000
}
```

### Streamable HTTP

A remote MCP server uses MCP Streamable HTTP. This is how an intranet service is added, with its
credentials kept in the environment:

```json
"knowledge": {
  "transport": "streamable-http",
  "urlEnvironment": "PNP_KNOWLEDGE_MCP_URL",
  "headerEnvironment": {
    "Authorization": "PNP_KNOWLEDGE_MCP_AUTHORIZATION",
    "appid": "PNP_KNOWLEDGE_MCP_APPID"
  },
  "enabled": true,
  "sideEffect": "read",
  "timeoutMs": 10000
}
```

with, in `runtime/local.env`:

```text
PNP_KNOWLEDGE_MCP_URL=<https://knowledge.intranet/mcp>
PNP_KNOWLEDGE_MCP_AUTHORIZATION=Bearer <token>
PNP_KNOWLEDGE_MCP_APPID=<appid>
```

Use exactly one of `url` or `urlEnvironment`. The transport rule above applies to both, at the moment
the address resolves, because this file cannot know what a variable will hold; an intranet server
that only speaks plain HTTP needs `PNP_ALLOW_HTTP_ENDPOINTS=1`. A rejected address is reported by
setting name, never by value. `headerEnvironment` maps HTTP header names to environment variable
names so credentials stay out of the settings file; like `env` above, the names resolve to values at
load and a missing variable fails with `INTEGRATION_CONFIG_INVALID` (503). `enabled`, `sideEffect`
and `timeoutMs` mean exactly what they mean for stdio.

MCP configuration in this file is the public, cross-Core contract. How an Engine Pack projects an
effective MCP server into OpenCode, Pi, Hermes, or another native Core configuration is adapter work
and does not change this schema. A native channel that cannot carry a transport drops that server and
reports it rather than reaching it by some other route: an ACP engine, for instance, receives a
`streamable-http` server only when its `initialize` declared `mcpCapabilities.http`.

## Compatibility

`PNP_MODEL_SETTINGS` is retained as a deprecated model-only override for existing deployments. New
deployments should use `PNP_SETTINGS`.

An explicitly supplied legacy `PNP_CONFIGURED_PROFILE` may still contain inline `models`, `policy`
and `tools`; when no explicit `PNP_SETTINGS` is supplied, all three are honored and that profile is
the whole source (it carries no instructions). Every other deployment — the shipped default path
included — takes its models, its policy, its instructions and its MCP servers from this settings
file, and the profile's `tools` are not read.

`PNP_CONFIGURED_POLICY_OVERRIDES` remains a final deployment-side operation override and is applied
after the resolved settings policy.

`PNP_MODEL_STRICT=1` makes a request that names an unconfigured model fail with 403 instead of
running on the effective default. Leave it unset unless the caller's model identifiers are known to
match this file.
