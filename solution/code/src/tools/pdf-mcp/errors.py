"""Tool failures the caller can act on / 调用方可据以修正的失败。

Mirrors `src/tools/office-mcp/errors.ts`: the model sees `<CODE>: <message>` and the code names the
one thing to change. Anything that escapes a handler is reported with its own message under
`UNEXPECTED`, never as a silent empty result — a tool that answers "no text" where it meant "I could
not read the file" is the failure mode that makes an agent invent content.
"""

from __future__ import annotations

# Kept in the same order as the Node server's union so the two lists can be diffed by eye.
ERROR_CODES = (
    "PATH_NOT_ABSOLUTE",
    "PATH_NOT_FOUND",
    "NOT_A_FILE",
    "INVALID_ARGUMENT",
    "INDEX_OUT_OF_RANGE",
    "UNSUPPORTED_FORMAT",
    # PDF-specific, with no Node counterpart.
    "PDF_INVALID",
    "PDF_ENCRYPTED",
    "DEPENDENCY_UNAVAILABLE",
    "UNEXPECTED",
)


class PdfToolError(Exception):
    """A failure with an actionable code. `message` is bilingual, like every other surface here."""

    def __init__(self, code, message):
        Exception.__init__(self, message)
        if code not in ERROR_CODES:
            raise AssertionError("unknown error code %r" % (code,))
        self.code = code
        self.message = message


def describe_error(error):
    """(code, message) for anything that reached a handler boundary.

    An OSError keeps its errno name visible instead of being flattened into `UNEXPECTED`, for the
    same reason the Node server keeps Node's `error.code`: "ENOENT" tells the caller what to fix and
    "UNEXPECTED" does not.
    """
    if isinstance(error, PdfToolError):
        return error.code, error.message
    if isinstance(error, OSError):
        name = getattr(error, "strerror", None) or str(error)
        code = getattr(error, "errno", None)
        import errno as _errno
        label = _errno.errorcode.get(code, "OSError") if code is not None else "OSError"
        return "UNEXPECTED", "%s: %s" % (label, name)
    return "UNEXPECTED", str(error) or error.__class__.__name__
