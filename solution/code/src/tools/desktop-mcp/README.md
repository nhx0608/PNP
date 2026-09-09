# Windows Desktop MCP

Minimal Windows-native stdio MCP server for OpenCode and Pi. Entry point after build:

```text
node dist/tools/desktop-mcp/main.js
```

It exposes `desktop_list_apps` (read) and `desktop_open_app` (external). The launch allowlist is fixed to `notepad`, `outlook-classic`, and `outlook-new`. It does not run user-provided commands or arguments, automate UI, send email/messages, read application data, or close processes. It uses Windows Shell activation. The tool reports only `activation_requested`; UI readiness and sign-in require independent observation.

The native Job-host smoke observed a new Notepad process surviving MCP shutdown on this Windows machine. This observation does not establish every Outlook installation's process lifetime. The opt-in smoke retains user applications and is not part of `npm test`:

```powershell
node scripts/e2e/desktop-smoke.mjs --open-notepad
```

Cancellation and timeout stop only the server's PowerShell helper, with a bounded wait for exit. Once submitted, application activation cannot be assumed revoked or safely retried. The helper uses explicit UTF-8 output, stdout carries only MCP JSON, and no credential is accepted as a tool parameter. The implementation follows [Microsoft's Shell.ShellExecute API](https://learn.microsoft.com/en-us/windows/win32/shell/shell-shellexecute).

Suggested MCP configuration (engine adapters project this common stdio definition):

```json
{
  "transport": "stdio",
  "command": "${PNP_NODE}",
  "args": ["${PNP_CODE_ROOT}/dist/tools/desktop-mcp/main.js"],
  "env": {},
  "enabled": true,
  "sideEffect": "external",
  "timeoutMs": 15000
}
```
