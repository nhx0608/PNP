# Shared model settings

`model-settings.json` is the common model configuration for every real Agent Core connected through PNP. Engine-specific adapters consume the resolved model; they do not own a separate business-side model list.

## Default location and override

Default:

```text
engineering/code/config/model-settings.json
```

To use a file outside the repository, set an absolute path:

```powershell
$env:PNP_MODEL_SETTINGS='D:\pnp-private\model-settings.json'
```

`PNP_MODEL_SETTINGS` overrides only the model list. `PNP_CONFIGURED_PROFILE` can still supply tools and policy, and existing profiles with inline `models` remain compatible.

## Format

```json
{
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
}
```

Rules:

- `default` must exactly match one item in `models`.
- `providerID + modelID` must be unique.
- `protocol` currently supports `openai-chat` and `anthropic-messages`.
- Each model must use exactly one of `endpoint` or `endpointEnvironment`.
- Remote endpoints must use HTTPS; HTTP is allowed only for loopback development endpoints.
- Credentials must be referenced through `headerEnvironment`. Never commit API keys or tokens.

## HIS OpenAI-compatible models

The shipped file includes these selectable IDs:

```text
his/GLM-V5.1-DX
his/Qwen-V3.6-27B-DX
```

Set the runtime values in the authorized environment:

```powershell
$env:PNP_HIS_MODEL_ENDPOINT='https://<approved-channel-domain>/v1'
$env:PNP_HIS_AUTHORIZATION='Bearer <API-KEY>'
$env:PNP_MODEL_STRICT='1'
```

To make GLM the default, change only the `default` object in `model-settings.json` to:

```json
{
  "providerID": "his",
  "modelID": "GLM-V5.1-DX"
}
```

To make Qwen the default, use `Qwen-V3.6-27B-DX` instead.

A request may always choose explicitly:

```json
{
  "parts": [{ "type": "text", "text": "hello" }],
  "model": {
    "providerID": "his",
    "modelID": "GLM-V5.1-DX"
  }
}
```

The same settings are resolved before Engine selection-specific adaptation, so OpenCode, Pi, Hermes, or future Engine Packs use the same logical model configuration when their adapters support the selected protocol.
