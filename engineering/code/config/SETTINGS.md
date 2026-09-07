# PNP settings

`settings.json` is the single runtime settings file for model, permission, and MCP configuration across Agent Cores.
PNP resolves `common` first and then applies `cores.<engineId>` overrides. Engine/Integration adapters consume the
effective settings and translate supported capabilities into native configuration; callers do not maintain a
separate business-side settings file for OpenCode, Pi, Hermes, or future Cores.

## Location

Default:

```text
engineering/code/config/settings.json
```

Use a private file outside the repository when deployment-specific settings should not be committed:

```powershell
$env:PNP_SETTINGS='D:\pnp-private\settings.json'
```

`PNP_SETTINGS` must be an absolute path. Real credentials never belong in this JSON. Model headers and MCP
credentials reference environment variable names and are resolved by the adapter that consumes them.

## Shape

```json
{
  "version": 1,
  "common": {
    "model": {
      "default": {
        "providerID": "his",
        "modelID": "GLM-V5.1-DX"
      },
      "models": [
        {
          "selection": {
            "providerID": "his",
            "modelID": "GLM-V5.1-DX"
          },
          "endpointEnvironment": "PNP_HIS_MODEL_ENDPOINT",
          "protocol": "openai-chat",
          "headerEnvironment": {
            "Authorization": "PNP_HIS_AUTHORIZATION"
          }
        }
      ]
    },
    "permissions": {
      "default": "allow",
      "operations": {
        "read": "allow"
      }
    },
    "mcp": {
      "servers": {
        "welink": {
          "transport": "stdio",
          "command": "welink-mcp",
          "args": [],
          "env": {},
          "enabled": true,
          "timeoutMs": 10000
        }
      }
    }
  },
  "cores": {
    "opencode": {
      "model": {
        "default": {
          "providerID": "his",
          "modelID": "GLM-V5.1-DX"
        }
      },
      "permissions": {
        "operations": {
          "edit": "ask",
          "write": "ask",
          "bash": "ask"
        }
      },
      "mcp": {
        "servers": {
          "welink": {
            "timeoutMs": 15000
          }
        }
      }
    },
    "pi": {},
    "hermes": {}
  }
}
```

`welink-mcp` above is only an example command name. PNP does not implement the WeLink CLI -> MCP wrapper in this
settings layer. The owner of that adapter supplies the actual MCP server command or endpoint; PNP only provides the
common configuration contract and Core override semantics.

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
    "default": {
      "providerID": "his",
      "modelID": "Qwen-V3.6-27B-DX"
    }
  }
}
```

A Core can also replace one common model definition for itself by listing the same `providerID/modelID` under
`cores.<id>.model.models`. This is useful when one Core needs a different protocol-compatible endpoint or header
projection while the logical model identity stays the same.

For MCP, the server name is the merge key. A Core can override only the fields it needs:

```json
"opencode": {
  "mcp": {
    "servers": {
      "welink": {
        "enabled": false
      }
    }
  }
}
```

A Core may also add an MCP server that is not present in `common`, but a new server must contain a complete valid
server definition.

## Permissions

Effects are:

- `allow` - execute without a user approval.
- `ask` - require the PNP permission loop.
- `deny` - reject the operation; a user reply cannot override it.

`common.permissions.default` applies to every operation not listed explicitly. Operation names are the names
reported by the Engine/Driver. Put an override under `cores.<id>.permissions.operations` when Cores use different
names for the same action.

For OpenCode, PNP projects effective permission settings into the private `opencode.json` before launch. Operations
that PNP must decide as `ask` or `deny` are projected as native `ask` so OpenCode emits an ACP permission request;
the gateway remains the authority and then applies the effective PNP policy. The old
`PNP_OPENCODE_NATIVE_PERMISSIONS=ask` switch remains only as a compatibility/diagnostic force-ask option.

## Models

The effective default model must exist in the effective model list. Model definitions support:

- `protocol`: `openai-chat` or `anthropic-messages`.
- exactly one of `endpoint` or `endpointEnvironment`.
- `headerEnvironment`: request header name -> environment variable name.
- HTTPS for remote endpoints; HTTP only for loopback development endpoints.

The shipped settings include these HIS model IDs:

```text
his/GLM-V5.1-DX
his/Qwen-V3.6-27B-DX
```

Runtime values stay outside the file:

```powershell
$env:PNP_HIS_MODEL_ENDPOINT='https://<approved-channel-domain>/v1'
$env:PNP_HIS_AUTHORIZATION='Bearer <API-KEY>'
$env:PNP_MODEL_STRICT='1'
```

## MCP

`common.mcp.servers` defines MCP servers available by default to every Core. `cores.<id>.mcp.servers` contains
Core-specific additions or partial overrides. PNP uses protocol-neutral names rather than copying one Core's native
settings format.

Every enabled server becomes one tool binding on each run's IntegrationContext, which is what an Engine Pack or
driver projects. A server with `"enabled": false` is simply absent from that list.

### stdio

A local MCP server uses the standard MCP stdio process model:

```json
"welink": {
  "transport": "stdio",
  "command": "D:\\pnp-mcp\\welink-mcp.exe",
  "args": ["serve"],
  "env": {
    "WELINK_HOME": "PNP_WELINK_HOME"
  },
  "enabled": true,
  "sideEffect": "external",
  "timeoutMs": 10000
}
```

Fields:

- `transport`: `stdio`.
- `command`: MCP server executable supplied by the adapter owner. It must be an **absolute path**: PNP never
  searches PATH, so what runs is what this file names. A relative command fails the load with
  `INTEGRATION_CONFIG_INVALID` (400).
- `args`: optional argument array; defaults to `[]`.
- `env`: child-process environment variable name -> PNP process environment variable name. Values are references,
  not secrets. The names are resolved to values once, while the gateway loads its integration, so a variable this
  file names but the environment does not set fails the load with `INTEGRATION_CONFIG_INVALID` (503) instead of
  producing a tool that silently does nothing during a run. No value is ever written back into this file, logged,
  or included in an error message.
- `enabled`: optional, defaults to `true`.
- `sideEffect`: optional `read`, `write` or `external`; defaults to `external`. It is what the permission policy
  judges the server's calls by, so the default is the strongest of the three — a server that does not say what it
  does must not slip past a policy that asks about `external`.
- `timeoutMs`: optional positive integer.

There is no `cwd`: ACP's stdio MCP server has no working-directory field, so a value here could only have been
discarded without saying so.

For the employee-assistant integration, C is responsible for producing the MCP server executable/command. Once C
provides it, deployment only fills this MCP entry; there is no WeLink-specific configuration in PNP Core code.

### Streamable HTTP

A remote MCP server uses MCP Streamable HTTP:

```json
"knowledge": {
  "transport": "streamable-http",
  "urlEnvironment": "PNP_KNOWLEDGE_MCP_URL",
  "headerEnvironment": {
    "Authorization": "PNP_KNOWLEDGE_MCP_AUTHORIZATION"
  },
  "enabled": true,
  "sideEffect": "read",
  "timeoutMs": 10000
}
```

Use exactly one of `url` or `urlEnvironment`. Literal remote URLs require HTTPS; loopback development endpoints may
use HTTP, and a URL that arrives through a variable faces the same rule at the moment it resolves, because this file
cannot know what the variable will hold. A rejected address is reported by setting name, never by value.
`headerEnvironment` maps HTTP header names to environment variable names so credentials stay out of the settings
file; like `env` above, the names resolve to values at load and a missing variable fails with
`INTEGRATION_CONFIG_INVALID` (503). `enabled`, `sideEffect` and `timeoutMs` mean exactly what they mean for stdio.

MCP configuration in this file is the public, cross-Core contract. How an Engine Pack projects an effective MCP
server into OpenCode, Pi, Hermes, or another native Core configuration is adapter work and does not change this
schema. A native channel that cannot carry a transport drops that server and reports it rather than reaching it by
some other route: an ACP engine, for instance, receives a `streamable-http` server only when its `initialize`
declared `mcpCapabilities.http`.

## Compatibility

`PNP_MODEL_SETTINGS` is retained as a deprecated model-only override for existing deployments. New deployments
should use `PNP_SETTINGS`.

An explicitly supplied legacy `PNP_CONFIGURED_PROFILE` may still contain inline `models`, `policy` and `tools`;
when no explicit `PNP_SETTINGS` is supplied, all three are honored and that profile is the whole source. Every
other deployment — the shipped default path included — takes its models, its policy and its MCP servers from this
settings file, and the profile's `tools` are not read.

`PNP_CONFIGURED_POLICY_OVERRIDES` remains a final deployment-side operation override and is applied after the
resolved settings policy.
