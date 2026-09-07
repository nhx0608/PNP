# PNP settings

`settings.json` is the single runtime settings file for model and permission configuration across Agent Cores.
PNP resolves `common` first and then applies `cores.<engineId>` overrides. Engine Packs consume the resulting
settings and translate them into native configuration; callers do not maintain a separate business-side settings
file for OpenCode, Pi, Hermes, or future Cores.

## Location

Default:

```text
engineering/code/config/settings.json
```

Use a private file outside the repository when deployment-specific settings should not be committed:

```powershell
$env:PNP_SETTINGS='D:\pnp-private\settings.json'
```

`PNP_SETTINGS` must be an absolute path. Real credentials never belong in this JSON; model headers reference
environment variable names and are resolved only at runtime.

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
      }
    },
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

## Compatibility

`PNP_MODEL_SETTINGS` is retained as a deprecated model-only override for existing deployments. New deployments
should use `PNP_SETTINGS`.

An explicitly supplied legacy `PNP_CONFIGURED_PROFILE` may still contain inline `models` and `policy`; when no
explicit `PNP_SETTINGS` is supplied those legacy fields are honored. If `PNP_SETTINGS` is supplied explicitly, it
is authoritative for model and permission settings and the configured profile contributes tools only.

`PNP_CONFIGURED_POLICY_OVERRIDES` remains a final deployment-side operation override and is applied after the
resolved settings policy.
