"""MCP over stdio, implemented directly against the specification / 直接实现的 MCP stdio 协议。

The official Python MCP SDK is not vendored, on purpose. It pulls in `pydantic`, `pydantic-core`
(a Rust extension module, so a platform-specific wheel), `anyio`, `httpx`, `httpx-sse`,
`sse-starlette`, `starlette` and `uvicorn` — roughly 20 MB of dependencies, at least one of which
cannot be shipped as a pure-Python wheel and would therefore break on any judge whose CPython minor
version differs from the one the wheel was built for. What this server actually needs of the
protocol is three request methods and one response envelope, and the two Node servers next door show
exactly what the client sends and expects. Implementing that directly is ~150 lines with no
dependencies at all, and it is the reason `_vendor/` contains one pure-Python package instead of a
platform-locked tree.

Framing, per the MCP stdio transport: one JSON-RPC message per line on stdout, UTF-8, no embedded
newlines. stdout carries JSON-RPC frames and nothing else — one stray `print()` desynchronises the
client and takes the whole tool set down — so `sys.stdout` is redirected to stderr for the lifetime
of the process and the real handle is kept private to this module.
"""

from __future__ import annotations

import io
import json
import sys

JSONRPC_VERSION = "2.0"

#: Revisions this server will negotiate. The client's version is echoed when it appears here;
#: otherwise the server answers with `PREFERRED_PROTOCOL_VERSION` and the client decides.
SUPPORTED_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07")
PREFERRED_PROTOCOL_VERSION = "2025-06-18"

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603


def annotations_for(side_effect, title):
    """The same hint set the Node servers publish for a tool with this side effect."""
    if side_effect == "read":
        return {"title": title, "readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}
    if side_effect == "write":
        return {"title": title, "readOnlyHint": False, "destructiveHint": False,
                "idempotentHint": False, "openWorldHint": False}
    return {"title": title, "readOnlyHint": False, "destructiveHint": True,
            "idempotentHint": False, "openWorldHint": True}


class Tool(object):
    """One registered tool: what `tools/list` publishes and what `tools/call` dispatches to."""

    def __init__(self, name, title, side_effect, description, input_schema, run):
        self.name = name
        self.title = title
        self.side_effect = side_effect
        self.description = description
        self.input_schema = input_schema
        self.run = run

    def descriptor(self):
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "inputSchema": self.input_schema,
            "annotations": annotations_for(self.side_effect, self.title),
            # The gateway's policy layer classifies a call by its effect, not by its name.
            "_meta": {"sideEffect": self.side_effect},
        }


def success_result(summary, data):
    """Both halves of the answer in one result, exactly as `office-mcp/results.ts` sends them.

    `structuredContent` serves a client that reads MCP structured output; the same JSON is appended
    to the text block for the engines that only surface text to the model. Sending the summary alone
    would make the model guess at the data it just asked for.
    """
    return {
        "content": [{"type": "text", "text": "%s\n%s" % (summary, json.dumps(data, ensure_ascii=False))}],
        "structuredContent": data,
    }


def failure_result(tool, code, message):
    return {
        "content": [{"type": "text", "text": "%s 失败 / failed [%s]: %s" % (tool, code, message)}],
        "isError": True,
    }


class StdioServer(object):
    def __init__(self, name, version, instructions, tools):
        self.name = name
        self.version = version
        self.instructions = instructions
        self.tools = {}
        self.order = []
        for tool in tools:
            self.tools[tool.name] = tool
            self.order.append(tool.name)
        self._out = None

    # -- framing ---------------------------------------------------------------------------------

    def _open_streams(self):
        """UTF-8 in both directions with `\\n` line endings, on every platform.

        Windows would otherwise translate `\\n` to `\\r\\n` on stdout and decode stdin with the
        console code page, which corrupts every Chinese path and description the moment the server
        leaves an English-locale machine.
        """
        stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace", newline="\n")
        self._out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="strict",
                                     newline="\n", write_through=True)
        # Anything that reaches for `print()` from here on — a library warning, a stray debug line —
        # lands on stderr instead of corrupting the JSON-RPC stream.
        sys.stdout = sys.stderr
        return stdin

    def _send(self, message):
        self._out.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")))
        self._out.write("\n")
        self._out.flush()

    def _respond(self, request_id, result):
        self._send({"jsonrpc": JSONRPC_VERSION, "id": request_id, "result": result})

    def _fail(self, request_id, code, message):
        self._send({"jsonrpc": JSONRPC_VERSION, "id": request_id, "error": {"code": code, "message": message}})

    # -- methods ---------------------------------------------------------------------------------

    def _initialize(self, params):
        requested = params.get("protocolVersion") if isinstance(params, dict) else None
        version = requested if requested in SUPPORTED_PROTOCOL_VERSIONS else PREFERRED_PROTOCOL_VERSION
        return {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": self.name, "title": self.name, "version": self.version},
            "instructions": self.instructions,
        }

    def _list_tools(self):
        return {"tools": [self.tools[name].descriptor() for name in self.order]}

    def _call_tool(self, params):
        if not isinstance(params, dict):
            return failure_result("tools/call", "INVALID_ARGUMENT", "params 必须是对象 / params must be an object")
        name = params.get("name")
        if not isinstance(name, str) or name not in self.tools:
            # An unknown tool is answered as a tool error rather than a transport error, which is
            # what the Node servers do: the model reads the name it got wrong and can correct it.
            return failure_result(
                "tools/call", "INVALID_ARGUMENT",
                "未知工具 / unknown tool %r；可用工具 / available: %s" % (name, ", ".join(self.order)))
        arguments = params.get("arguments")
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            return failure_result(name, "INVALID_ARGUMENT", "arguments 必须是对象 / arguments must be an object")
        return self.tools[name].run(arguments)

    # -- loop ------------------------------------------------------------------------------------

    def _dispatch(self, message):
        method = message.get("method")
        request_id = message.get("id")
        is_request = request_id is not None
        if method == "initialize":
            self._respond(request_id, self._initialize(message.get("params") or {}))
            return
        if method in ("notifications/initialized", "notifications/cancelled", "notifications/progress"):
            return
        if method == "ping":
            if is_request:
                self._respond(request_id, {})
            return
        if method == "tools/list":
            self._respond(request_id, self._list_tools())
            return
        if method == "tools/call":
            self._respond(request_id, self._call_tool(message.get("params") or {}))
            return
        if not is_request:
            return  # an unknown notification is ignored, as the specification requires
        self._fail(request_id, METHOD_NOT_FOUND, "Method not found: %s" % method)

    def serve_forever(self):
        stdin = self._open_streams()
        while True:
            line = stdin.readline()
            if line == "":
                return 0  # the client closed the pipe
            line = line.strip()
            if line == "":
                continue
            try:
                message = json.loads(line)
            except ValueError as error:
                self._fail(None, PARSE_ERROR, "Parse error: %s" % error)
                continue
            if not isinstance(message, dict) or message.get("jsonrpc") != JSONRPC_VERSION:
                self._fail(message.get("id") if isinstance(message, dict) else None,
                           INVALID_REQUEST, "Invalid Request")
                continue
            try:
                self._dispatch(message)
            except Exception as error:  # a handler bug must not kill the session
                request_id = message.get("id")
                if request_id is not None:
                    self._fail(request_id, INTERNAL_ERROR, "%s: %s" % (error.__class__.__name__, error))
                else:
                    sys.stderr.write("pdf MCP server notification handler failed: %r\n" % (error,))
