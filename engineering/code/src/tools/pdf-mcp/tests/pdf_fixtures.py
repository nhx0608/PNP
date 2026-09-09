"""Hand-written PDF files for the tests / 测试用的手写 PDF。

The judge's machine has no PDF *writer* — reportlab, fpdf and friends are all absent, and the
delivery is offline, so a fixture cannot be produced by installing one. Every fixture here is
therefore assembled byte by byte from the PDF 1.7 object model: a catalogue, a page tree, one
content stream per page and a cross-reference table with real byte offsets. That keeps the tests
honest in a way a checked-in binary fixture cannot be — the test states exactly what is on each
page, so "no text on page 3" is a property of the fixture rather than of a file nobody can read.

Only ASCII text is drawn, because a Chinese glyph needs an embedded CID font and embedding one by
hand would make the fixture bigger than the code under test. Non-ASCII coverage is provided where
it actually matters for this server: UTF-16BE document metadata and Chinese directory names in the
paths the tools are handed.
"""

from __future__ import annotations

import zlib

HELVETICA = "Helvetica"
COURIER = "Courier"

# A4 in PostScript points, the size an evaluation task's document actually uses.
A4 = (595.276, 841.89)
LETTER = (612.0, 792.0)


def _escape(text):
    """PDF literal-string escaping for the three bytes that terminate or continue a string."""
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def text_line(x, y, text, font="F1", size=11):
    """One `Tj` show-text operation at an absolute position on the page."""
    return "BT /%s %s Tf %s %s Td (%s) Tj ET" % (font, size, x, y, _escape(text))


def text_grid(rows, x=60, top=760, size=10, font="F2", leading=16, column_width=110):
    """A whitespace-aligned table drawn as one `Tj` per row.

    Each cell is padded to `column_width` points using a fixed-width font, which is how a real
    generator lays out a borderless table: there are no ruling lines in the content stream at all,
    only text placed on a grid. That is the hardest honest case for the table extractor, and the
    reason `pdf_extract_tables` reports a confidence instead of a promise.
    """
    operations = []
    for index, row in enumerate(rows):
        pieces = []
        for column, cell in enumerate(row):
            pieces.append((column * column_width, cell))
        for offset, cell in pieces:
            operations.append(text_line(x + offset, top - index * leading, cell, font=font, size=size))
    return operations


class _Builder(object):
    """Collects numbered indirect objects and serialises them with a valid xref table."""

    def __init__(self):
        self._objects = []  # index i holds the body of object (i + 1)

    def add(self, body):
        self._objects.append(body)
        return len(self._objects)

    def reserve(self):
        self._objects.append(None)
        return len(self._objects)

    def put(self, number, body):
        self._objects[number - 1] = body

    def build(self, root, info=None, encrypt=None, identifier=None):
        out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for index, body in enumerate(self._objects):
            if body is None:
                raise AssertionError("object %d was reserved and never filled" % (index + 1))
            offsets.append(len(out))
            out += ("%d 0 obj\n" % (index + 1)).encode("ascii")
            out += body if isinstance(body, bytes) else body.encode("latin-1")
            out += b"\nendobj\n"
        start = len(out)
        out += ("xref\n0 %d\n" % (len(self._objects) + 1)).encode("ascii")
        out += b"0000000000 65535 f \n"
        for offset in offsets:
            out += ("%010d 00000 n \n" % offset).encode("ascii")
        trailer = "trailer\n<< /Size %d /Root %d 0 R" % (len(self._objects) + 1, root)
        if info is not None:
            trailer += " /Info %d 0 R" % info
        if encrypt is not None:
            trailer += " /Encrypt %d 0 R" % encrypt
        if identifier is not None:
            trailer += " /ID [%s %s]" % (identifier, identifier)
        trailer += " >>\nstartxref\n%d\n%%%%EOF\n" % start
        out += trailer.encode("latin-1")
        return bytes(out)


def _utf16be_string(value):
    """A PDF text string that can carry Chinese: UTF-16BE with the mandatory byte-order mark."""
    encoded = b"\xfe\xff" + value.encode("utf-16-be")
    return "<" + "".join("%02X" % byte for byte in encoded) + ">"


def _stream(data, compress):
    if compress:
        body = zlib.compress(data)
        return b"<< /Length " + str(len(body)).encode("ascii") + b" /Filter /FlateDecode >>\nstream\n" + body + b"\nendstream"
    return b"<< /Length " + str(len(data)).encode("ascii") + b" >>\nstream\n" + data + b"\nendstream"


def build_pdf(pages, metadata=None, size=A4, compress=True):
    """Assemble a PDF from a list of page descriptions.

    A page is a dict with any of:
      operations  list of content-stream operations (see `text_line` / `text_grid`)
      image       True to place a 4x4 greyscale image XObject and no text at all — the
                  "scanned page" case a text extractor must report rather than call empty
      rotate      /Rotate value in degrees
      size        (width, height) override for this page only
      blank       True for a page with no content stream at all
    """
    builder = _Builder()
    catalog = builder.reserve()
    pages_object = builder.reserve()
    helvetica = builder.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    courier = builder.add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>")

    page_numbers = []
    for page in pages:
        width, height = page.get("size", size)
        resources = "/Font << /F1 %d 0 R /F2 %d 0 R >>" % (helvetica, courier)
        contents = ""
        if page.get("image"):
            # 4x4 8-bit greyscale, uncompressed: an image with no text layer whatsoever.
            samples = bytes(bytearray(range(0, 256, 16)))
            image = builder.add(
                b"<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray"
                b" /BitsPerComponent 8 /Length " + str(len(samples)).encode("ascii") + b" >>\nstream\n"
                + samples + b"\nendstream")
            resources += " /XObject << /Im0 %d 0 R >>" % image
            operations = ["q 400 0 0 500 90 200 cm /Im0 Do Q"]
        else:
            operations = list(page.get("operations", []))
        if not page.get("blank"):
            data = "\n".join(operations).encode("latin-1")
            contents = " /Contents %d 0 R" % builder.add(_stream(data, compress))
        number = builder.add(
            "<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %s %s] /Resources << %s >>%s%s >>"
            % (pages_object, width, height, resources, contents,
               "" if page.get("rotate") is None else " /Rotate %d" % page["rotate"]))
        page_numbers.append(number)

    builder.put(pages_object, "<< /Type /Pages /Kids [%s] /Count %d >>"
                % (" ".join("%d 0 R" % number for number in page_numbers), len(page_numbers)))
    builder.put(catalog, "<< /Type /Catalog /Pages %d 0 R >>" % pages_object)

    info = None
    if metadata:
        entries = " ".join("/%s %s" % (key, _utf16be_string(value)) for key, value in sorted(metadata.items()))
        info = builder.add("<< %s >>" % entries)
    return builder.build(catalog, info=info)


def write(path, data):
    with open(path, "wb") as handle:
        handle.write(data)
    return path


# -- named fixtures, shared with the Node adapter test ---------------------------------------------
# `tests/adapters/pdf-mcp/` needs the same documents, and a second hand-written PDF writer in
# TypeScript would be a second thing to keep correct. The Node harness shells out to
# `python pdf_fixtures.py <name> <output>` instead, so both suites assert against byte-identical
# documents whose contents are defined here once.

_TABLE_ROWS = [
    ["Item", "Qty", "Unit", "Total"],
    ["Bolt M8", "120", "0.35", "42.00"],
    ["Washer", "1450", "0.02", "29.00"],
    ["Nut M8", "980", "0.11", "107.80"],
]


def named(name):
    """The fixture called `name`, as PDF bytes."""
    if name == "report":
        # Four pages: text, a whitespace-aligned table, a scanned image page, a blank page.
        return build_pdf(
            [
                {"operations": [text_line(72, 780, "Quarterly Inventory Report"),
                                text_line(72, 750, "Prepared for the Xian branch office.")]},
                {"operations": text_grid(_TABLE_ROWS)},
                {"image": True},
                {"blank": True},
            ],
            metadata={"Title": "库存报告 Inventory", "Author": "PNP",
                      "Producer": "pnp-pdf-mcp-tests"})
    if name == "scan":
        return build_pdf([{"image": True}, {"image": True}])
    if name == "prose":
        return build_pdf([{"operations": [
            text_line(72, 780, "This paragraph is ordinary prose with single spaces."),
            text_line(72, 760, "It must not be mistaken for a two column table."),
            text_line(72, 740, "Neither must this third line of running text."),
        ]}])
    raise SystemExit("unknown fixture %r; known: report, scan, prose" % (name,))


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 3:
        raise SystemExit("usage: python pdf_fixtures.py <report|scan|prose> <output.pdf>")
    write(sys.argv[2], named(sys.argv[1]))
    sys.stdout.write(sys.argv[2] + "\n")
