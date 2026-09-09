"""Absolute-path discipline / 绝对路径纪律。

The same rule as `src/tools/office-mcp/paths.ts`, restated in Python rather than re-derived: the
gateway starts this server from a directory that has nothing to do with the task, so a relative
path would resolve against a working directory the grader never looks at. Evaluation tasks hand the
model absolute Windows paths that routinely contain Chinese characters
(`D:\\评测\\库存\\西安分公司.pdf`), so a path is accepted when it is absolute for the running
platform, or when it is a Windows drive/UNC path — the second case keeps the error message useful
when a Windows path reaches a POSIX host.

This server never writes, so there is no output-path or overwrite handling here. What it does share
with the Node tools is the containment rule: the path the caller gave is the path that is opened,
normalised but never re-based, never joined onto anything, and never expanded from `~`, `%VAR%` or a
`file:` URL. A caller that means a different file must say so.
"""

from __future__ import annotations

import os
import re

from errors import PdfToolError

_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:[\\/]")
_WINDOWS_UNC = re.compile(r"^\\\\[^\\]")
# %VAR%, $VAR, ${VAR} and a leading ~ are refused rather than expanded: expanding them here would
# make the path this server opens differ from the path the caller can see in the transcript.
_EXPANDABLE = re.compile(r"%[^%]+%|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*")


def is_absolute_path(value):
    return os.path.isabs(value) or bool(_WINDOWS_DRIVE.match(value)) or bool(_WINDOWS_UNC.match(value))


def require_absolute_path(field, value):
    if not isinstance(value, str):
        raise PdfToolError("INVALID_ARGUMENT", "%s 必须是字符串 / must be a string" % field)
    if value.strip() == "":
        raise PdfToolError("INVALID_ARGUMENT", "%s 不能为空 / must not be empty" % field)
    if value.startswith("~"):
        raise PdfToolError(
            "PATH_NOT_ABSOLUTE",
            "%s 不接受 ~ 开头的路径，请给出完整绝对路径 / a ~-relative path is not expanded here; "
            "pass the full absolute path, got %r" % (field, value))
    if _EXPANDABLE.search(value) is not None:
        raise PdfToolError(
            "PATH_NOT_ABSOLUTE",
            "%s 不展开环境变量，请给出已展开的绝对路径 / environment variables are not expanded here; "
            "pass the already-expanded absolute path, got %r" % (field, value))
    if not is_absolute_path(value):
        raise PdfToolError(
            "PATH_NOT_ABSOLUTE",
            "%s 必须是绝对路径 / must be an absolute path, got %r" % (field, value))
    if "\x00" in value:
        raise PdfToolError("INVALID_ARGUMENT", "%s 含有 NUL 字符 / contains a NUL byte" % field)
    return os.path.normpath(value)


def require_existing_file(field, value):
    absolute = require_absolute_path(field, value)
    if not os.path.exists(absolute):
        raise PdfToolError(
            "PATH_NOT_FOUND", "%s 指向的文件不存在 / file does not exist: %s" % (field, absolute))
    if not os.path.isfile(absolute):
        raise PdfToolError("NOT_A_FILE", "%s 不是文件 / is not a file: %s" % (field, absolute))
    return absolute


# A PDF is identified by its header, not by its extension: a task that hands over `report.bin` is
# still readable, and a `.pdf` that is really a Word file must be refused with the reason rather
# than with a parser stack trace.
def require_pdf_file(field, value):
    absolute = require_existing_file(field, value)
    try:
        with open(absolute, "rb") as handle:
            head = handle.read(1024)
    except OSError as error:
        raise PdfToolError("PATH_NOT_FOUND", "%s 无法读取 / could not be read: %s (%s)" % (field, absolute, error))
    if head[:5] != b"%PDF-":
        # Some producers put junk in front of the header; the specification tolerates it and so do
        # readers, so look a little further before refusing.
        if b"%PDF-" not in head:
            raise PdfToolError(
                "UNSUPPORTED_FORMAT",
                "%s 不是 PDF 文件（缺少 %%PDF- 文件头）/ is not a PDF file (no %%PDF- header): %s" % (field, absolute))
    return absolute
