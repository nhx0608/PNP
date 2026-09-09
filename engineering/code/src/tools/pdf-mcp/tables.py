"""Best-effort table detection from the text layer / 基于文本层的表格识别（尽力而为）。

## Why this exists at all, and what it will not do

The usual PDF table extractors are out of reach for this delivery. `camelot` needs Ghostscript,
`tabula` needs a JVM, `pdfplumber` needs `pdfminer.six`, which needs `cryptography` — a compiled
wheel. Constraint: pure-Python wheels only, vendored, offline. So the only material available is
pypdf's layout-preserving text extraction, which places each glyph at a character position derived
from its real coordinates on the page.

That is enough for one specific and common kind of table: **whitespace-aligned**, produced by a
document generator (Word, LaTeX, a report writer) rather than by a scanner. It is *not* enough for:

* a scanned table — there is no text layer, so there is nothing to align;
* a table whose cells wrap onto several lines — each visual row becomes several detected rows;
* a table distinguished only by ruling lines while its columns overlap horizontally;
* merged cells — a spanned cell lands in one of the columns it spans, not in all of them.

Rather than hide that, every detected table carries a `confidence` computed from what was actually
measured, and the reasons behind a downgrade are listed in `signals`. A caller that needs certainty
is told plainly, in `caveat`, that this reads the text layer and not the page's ruling lines.

## The method

1. Take the page's layout-mode text. Every line is a row of a fixed-width character grid.
2. A line is "tabular" when it holds at least two runs of text separated by a gap of
   `MIN_GAP` or more spaces. Prose has single spaces between words and is therefore one run.
3. Consecutive tabular lines form a block (blank lines between rows are tolerated, because a
   generator's row spacing produces them; a run of prose ends the block).
4. Inside a block, a column separator is a run of character positions that is blank on *every*
   line of the block. That is what survives right-aligned numbers and cells containing spaces.
5. A pair of adjacent columns that is never occupied on both sides in the same row is one column
   that the grid split by accident — a centred header over left-aligned data does this — so it is
   merged back and the merge is reported.
"""

from __future__ import annotations

import re

#: Spaces that must separate two runs before they count as different cells. One space is a word
#: break inside a cell; two is the narrowest gap a layout engine leaves between columns.
MIN_GAP = 2
#: A block needs at least this many rows before it is a table rather than two coincidental lines.
MIN_ROWS = 2
#: Blank lines tolerated inside one table before the block is considered finished.
MAX_BLANK_RUN = 3
#: Beyond this a "table" is almost certainly a mis-read page of prose or a code listing.
MAX_COLUMNS = 30

_SEGMENT = re.compile(r"\S(?:.*?\S)?(?=\s{%d,}|$)" % MIN_GAP)


def segments(line):
    """Maximal runs of text, treating a gap of fewer than MIN_GAP spaces as part of one cell."""
    return [(match.start(), match.end(), match.group()) for match in _SEGMENT.finditer(line)]


def _blocks(lines):
    found = []
    current = []
    blank_run = 0
    for index, line in enumerate(lines):
        if line.strip() == "":
            if current:
                blank_run += 1
                if blank_run > MAX_BLANK_RUN:
                    found.append(current)
                    current = []
                    blank_run = 0
            continue
        if len(segments(line)) >= 2:
            current.append((index, line))
            blank_run = 0
            continue
        if current:
            found.append(current)
        current = []
        blank_run = 0
    if current:
        found.append(current)
    return [block for block in found if len(block) >= MIN_ROWS]


def _separators(block):
    width = max(len(line) for _, line in block)
    blank = [True] * width
    for _, line in block:
        for index, character in enumerate(line):
            if character != " ":
                blank[index] = False
    runs = []
    index = 0
    while index < width:
        if not blank[index]:
            index += 1
            continue
        start = index
        while index < width and blank[index]:
            index += 1
        # A leading or trailing blank run is a margin, not a separator between two columns.
        if index - start >= MIN_GAP and start > 0 and index < width:
            runs.append((start, index))
    return runs, width


def _split(line, separators, width):
    padded = line.ljust(width)
    bounds = [0] + [(start + end) // 2 for start, end in separators] + [width]
    return [padded[bounds[i]:bounds[i + 1]].strip() for i in range(len(bounds) - 1)]


def _merge_split_columns(rows):
    """Fold adjacent columns that are never both occupied in the same row.

    A centred header over left-aligned numbers produces exactly this: the header occupies one strip
    of the grid, the data another, and the blank-everywhere test finds a separator between them that
    corresponds to no real column boundary. Two columns that never coexist in any row are one.
    """
    merged = 0
    column = 0
    while rows and column < len(rows[0]) - 1:
        if all(not (row[column] and row[column + 1]) for row in rows):
            for row in rows:
                row[column] = (row[column] + " " + row[column + 1]).strip()
                del row[column + 1]
            merged += 1
        else:
            column += 1
    return merged


def _confidence(rows, columns, merged):
    """Confidence with the measurements that produced it, so a caller can disagree with it."""
    signals = []
    complete = sum(1 for row in rows if sum(1 for cell in row if cell) == columns)
    ratio = complete / float(len(rows))
    if ratio < 1.0:
        signals.append("%d/%d 行未填满全部 %d 列 / row(s) do not fill all %d columns"
                       % (len(rows) - complete, len(rows), columns, columns))
    if merged > 0:
        signals.append("%d 处列边界被合并（表头与数据未对齐）/ column boundary/-ies were merged because a "
                       "header and its data did not share a grid" % merged)
    if len(rows) < 3:
        signals.append("只有 %d 行，样本过小 / only %d row(s); too small a sample to be sure" % (len(rows), len(rows)))
    if ratio == 1.0 and len(rows) >= 3:
        level = "high"
    elif ratio >= 0.75:
        level = "medium"
    else:
        level = "low"
    return level, ratio, signals


CAVEAT = (
    "本工具从文本层的空白对齐推断表格，不读取表格框线，也无法处理扫描件、跨行单元格与合并单元格；"
    "confidence 由实际测得的行列一致性得出，low 表示结果很可能不可用。"
    " Tables are inferred from whitespace alignment in the text layer. Ruling lines are not read, and"
    " scanned pages, cells that wrap onto several lines and merged cells are out of reach. The"
    " confidence is computed from the measured row/column consistency; \"low\" means the result is"
    " probably not usable."
)


def detect_tables(layout_text, page_number):
    """Every table candidate on one page's layout text."""
    tables = []
    for block in _blocks(layout_text.split("\n")):
        separators, width = _separators(block)
        if not separators or len(separators) + 1 > MAX_COLUMNS:
            continue
        rows = [_split(line, separators, width) for _, line in block]
        merged = _merge_split_columns(rows)
        columns = len(rows[0])
        if columns < 2:
            continue
        # A block in which every row collapsed to one occupied cell is prose that happened to be
        # laid out with wide gaps, not a table.
        if all(sum(1 for cell in row if cell) < 2 for row in rows):
            continue
        level, ratio, signals = _confidence(rows, columns, merged)
        tables.append({
            "page": page_number,
            "firstLine": block[0][0],
            "columns": columns,
            "rowCount": len(rows),
            "rows": rows,
            "header": rows[0],
            "confidence": level,
            "completeRowRatio": round(ratio, 3),
            "mergedColumnBoundaries": merged,
            "signals": signals,
        })
    return tables
