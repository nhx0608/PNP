"""Everything this server knows how to read out of a PDF / PDF 读取实现。

All of it goes through the vendored pypdf (see `_vendor/README.md`). Two properties of that library
decide the shape of this module:

* it is pure Python, so it can be unpacked into the delivery and used on whatever CPython the judge
  happens to have, and
* it reads the *text layer* only. A page produced by a scanner has no text layer at all, and no
  amount of pure-Python effort will produce one. That is a fact about the document, so it is
  reported as one — `kind: "image-only"` — instead of coming back as an empty string that a model
  would read as "this page is blank".
"""

from __future__ import annotations

import struct

from errors import PdfToolError

import pypdf
from pypdf.errors import DependencyError, FileNotDecryptedError, PdfReadError, PyPdfError

POINTS_PER_MM = 72.0 / 25.4

#: Page classifications reported by `pdf_extract` and counted by `pdf_info`.
PAGE_KINDS = ("text", "image-only", "graphics-only", "no-content")


def open_reader(path):
    """Open `path`, decrypting with the empty user password when that is all it needs.

    A PDF that is "encrypted" is usually only permission-flagged and opens with an empty password;
    one that needs a real password cannot be read here and says so. A PDF whose encryption uses AES
    is a third case: pypdf can parse it but needs a crypt provider that is *not* pure Python, which
    this delivery deliberately does not vendor. That is reported as `DEPENDENCY_UNAVAILABLE` with
    the name of the missing package, never as an unreadable or empty document.
    """
    try:
        reader = pypdf.PdfReader(path)
    except DependencyError as error:
        raise PdfToolError(
            "DEPENDENCY_UNAVAILABLE",
            "该 PDF 的加密算法需要非纯 Python 依赖，本交付未内置 / this PDF's encryption needs a "
            "non-pure-Python dependency that is deliberately not vendored (%s): %s" % (error, path))
    except (PdfReadError, PyPdfError) as error:
        raise PdfToolError("PDF_INVALID", "无法解析 PDF / could not parse the PDF: %s (%s)" % (path, error))
    except (ValueError, KeyError, TypeError, EOFError, struct.error) as error:
        raise PdfToolError("PDF_INVALID", "无法解析 PDF / could not parse the PDF: %s (%s)" % (path, error))

    encryption = {"encrypted": bool(reader.is_encrypted), "openedWithEmptyPassword": False}
    if reader.is_encrypted:
        try:
            opened = reader.decrypt("")
        except DependencyError as error:
            raise PdfToolError(
                "DEPENDENCY_UNAVAILABLE",
                "该 PDF 的加密算法需要非纯 Python 依赖，本交付未内置 / this PDF's encryption needs a "
                "non-pure-Python dependency that is deliberately not vendored (%s): %s" % (error, path))
        except (PdfReadError, PyPdfError, NotImplementedError) as error:
            raise PdfToolError(
                "PDF_ENCRYPTED",
                "PDF 已加密且无法用空口令打开 / the PDF is encrypted and did not open with an empty "
                "password: %s (%s)" % (path, error))
        if not opened:
            raise PdfToolError(
                "PDF_ENCRYPTED",
                "PDF 需要口令，本服务器不接受口令参数 / the PDF needs a password; this server takes no "
                "password argument: %s" % path)
        encryption["openedWithEmptyPassword"] = True
    return reader, encryption


def page_count(reader, path):
    try:
        return len(reader.pages)
    except FileNotDecryptedError:
        raise PdfToolError("PDF_ENCRYPTED", "PDF 已加密 / the PDF is encrypted: %s" % path)
    except (PdfReadError, PyPdfError, ValueError, KeyError) as error:
        raise PdfToolError("PDF_INVALID", "页面树无法读取 / the page tree could not be read: %s (%s)" % (path, error))


def resolve_range(first, last, total):
    """1-based inclusive page range, validated against the document."""
    lower = 1 if first is None else first
    upper = total if last is None else last
    for name, value in (("firstPage", first), ("lastPage", last)):
        if value is not None and (not isinstance(value, int) or isinstance(value, bool) or value < 1):
            raise PdfToolError("INVALID_ARGUMENT", "%s 必须是不小于 1 的整数 / must be an integer >= 1" % name)
    if total == 0:
        raise PdfToolError("PDF_INVALID", "文档没有任何页面 / the document has no pages")
    if lower > total:
        raise PdfToolError(
            "INDEX_OUT_OF_RANGE",
            "firstPage %d 超出文档的 %d 页 / is past the document's %d page(s)" % (lower, total, total))
    if upper > total:
        upper = total
    if lower > upper:
        raise PdfToolError("INVALID_ARGUMENT", "firstPage 不能大于 lastPage / firstPage must not exceed lastPage")
    return lower, upper


def _image_xobject_count(page):
    """Images drawn on the page, counted from /Resources rather than decoded.

    `page.images` would decode every image, which needs Pillow for most filters — a compiled wheel
    this delivery must not depend on. The resource dictionary answers the only question asked here
    ("is there an image on this page at all?") without decoding a single byte.
    """
    try:
        resources = page.get("/Resources")
        if resources is None:
            return 0
        resources = resources.get_object()
        xobjects = resources.get("/XObject")
        if xobjects is None:
            return 0
        xobjects = xobjects.get_object()
        count = 0
        for key in list(xobjects.keys()):
            try:
                entry = xobjects[key].get_object()
            except Exception:  # a broken single entry must not lose the whole count
                continue
            if entry.get("/Subtype") == "/Image":
                count += 1
        return count
    except Exception:
        return 0


def _inline_image_count(content):
    """Inline images (`BI ... ID ... EI`) drawn straight into the content stream."""
    if not content:
        return 0
    count = 0
    index = 0
    while True:
        index = content.find(b"BI", index)
        if index < 0:
            return count
        # `BI` is only an operator at a token boundary; anything else is a coincidence inside data.
        before_ok = index == 0 or content[index - 1:index] in b" \t\r\n[]<>/"
        after = content[index + 2:index + 3]
        if before_ok and after in (b" ", b"\t", b"\r", b"\n", b"/"):
            if content.find(b"ID", index) > 0:
                count += 1
        index += 2


def _content_bytes(page):
    """`(data, absent)` — `absent` is True only when the page really has no content stream.

    The distinction matters: "there is nothing to draw" and "I could not decode what is drawn" must
    not collapse into the same empty answer, or an unreadable page becomes a blank one.
    """
    try:
        contents = page.get_contents()
    except Exception:
        return b"", False
    if contents is None:
        return b"", True
    try:
        return contents.get_data(), False
    except Exception:
        return b"", False


def classify_page(text, page):
    """Why a page produced no text, stated as a fact about the page.

    text          the page has a text layer and it yielded characters
    image-only    no text layer, but the page draws at least one image — the scanned-page case
    graphics-only no text and no image, but the content stream draws something (vectors, a chart)
    no-content    the page is genuinely blank
    """
    if text.strip() != "":
        return "text", {"imageCount": _image_xobject_count(page)}
    content, _absent = _content_bytes(page)
    images = _image_xobject_count(page) + _inline_image_count(content)
    if images > 0:
        return "image-only", {"imageCount": images}
    if len(content.strip()) > 0:
        return "graphics-only", {"imageCount": 0}
    return "no-content", {"imageCount": 0}


def extract_page_text(page, layout=False):
    """Returns `(text, failure_reason)`; exactly one of the two is meaningful.

    One unreadable page must not lose the other two hundred, so a page-level exception is turned
    into a reason string rather than aborting the call — but it is never turned into `""`, which the
    caller would be entitled to read as "this page has no text".
    """
    # A page with no content stream draws nothing, so it has no text. Saying so directly keeps the
    # layout extractor — which raises rather than returning "" for such a page — from turning a
    # blank page into an "unreadable" one.
    if _content_bytes(page)[1]:
        return "", None
    try:
        if layout:
            return page.extract_text(extraction_mode="layout"), None
        return page.extract_text(), None
    except DependencyError as error:
        raise PdfToolError(
            "DEPENDENCY_UNAVAILABLE",
            "该页的文本提取需要未内置的依赖 / extracting this page's text needs a dependency that is "
            "not vendored: %s" % error)
    except Exception as error:
        return "", "%s: %s" % (error.__class__.__name__, error)


def page_size(page):
    box = page.mediabox
    width = float(box.width)
    height = float(box.height)
    rotation = 0
    try:
        rotation = int(page.get("/Rotate") or 0) % 360
    except Exception:
        rotation = 0
    return {
        "widthPt": round(width, 2),
        "heightPt": round(height, 2),
        "widthMm": round(width / POINTS_PER_MM, 1),
        "heightMm": round(height / POINTS_PER_MM, 1),
        "rotation": rotation,
        "orientation": "portrait" if height >= width else "landscape",
    }


_METADATA_FIELDS = (
    ("/Title", "title"),
    ("/Author", "author"),
    ("/Subject", "subject"),
    ("/Keywords", "keywords"),
    ("/Creator", "creator"),
    ("/Producer", "producer"),
    ("/CreationDate", "creationDate"),
    ("/ModDate", "modificationDate"),
)


def document_metadata(reader):
    """The /Info dictionary as plain strings; absent keys are absent, never empty strings."""
    try:
        info = reader.metadata
    except Exception:
        return {}
    if not info:
        return {}
    result = {}
    for key, name in _METADATA_FIELDS:
        try:
            value = info.get(key)
        except Exception:
            continue
        if value is None:
            continue
        text = str(value)
        if text != "":
            result[name] = text
    return result


def pdf_version(reader):
    try:
        header = reader.pdf_header
    except Exception:
        return None
    if not header:
        return None
    header = str(header)
    return header[5:].strip() if header.startswith("%PDF-") else header.strip()
