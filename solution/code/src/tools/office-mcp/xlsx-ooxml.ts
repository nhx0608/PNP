import type { SheetCell } from "./xlsx.ts";
import { OfficeToolError } from "./errors.ts";
import {
  openPackage, readOptionalPartText, readPartText, relationshipsOf, relationshipsPartOf, resolveRelationshipTarget,
} from "./package-file.ts";
import { attribute, childrenOf, findChild, flattenText, parseXmlLocalNames, tagName, type XmlNode } from "./xml.ts";

/**
 * A .xlsx reader that goes straight at the OOXML package, used when `exceljs` refuses a workbook.
 *
 * WHY this exists: `exceljs` matches element names literally — it looks for `sheet`, never for
 * `x:sheet` — so a workbook whose parts carry a namespace PREFIX leaves its workbook model empty and
 * the reader then dereferences `undefined.sheets`. Both spellings are valid OOXML: a prefix is only
 * an alias for the namespace URI, so `<x:sheet>` bound to the spreadsheetml namespace and a plain
 * `<sheet>` under that namespace as the default are the same element. Prefixed parts are exactly
 * what several non-Microsoft writers emit (the repository's own evaluation fixture
 * `generate_excel_1.xlsx` is one), so a workbook a judge hands over can be perfectly well-formed and
 * still be unreadable through `exceljs` alone.
 *
 * This reader resolves every element by LOCAL name (see `parseXmlLocalNames`), which makes it blind
 * to the prefix question altogether, and reuses the package helpers that `docx.ts` and `pptx.ts`
 * already read OOXML with rather than introducing a third way to open a zip of XML.
 */

const WORKBOOK_PART = "xl/workbook.xml";
const SHARED_STRINGS_PART = "xl/sharedStrings.xml";
const STYLES_PART = "xl/styles.xml";
const WORKSHEET_RELATIONSHIP_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";

export type OoxmlSheet = {
  name: string;
  rowCount: number;
  columnCount: number;
  /** Dense `rowCount` x `columnCount` grid; cells the sheet does not carry are `null`. */
  rows: SheetCell[][];
};

/**
 * `numFmtId` per `cellXfs` entry plus the custom format codes, which together decide whether a
 * numeric cell is a date. A workbook without `xl/styles.xml` reads as "no style is a date format",
 * which keeps serial numbers as numbers instead of inventing dates.
 */
type NumberFormats = {
  readonly styleFormatIds: readonly number[];
  readonly customCodes: ReadonlyMap<number, string>;
};

const EMPTY_NUMBER_FORMATS: NumberFormats = { styleFormatIds: [], customCodes: new Map() };

/**
 * The built-in date and time formats of ECMA-376: 14-22 and 45-47 are the Latin ones, 27-36 and
 * 50-58 the reserved East Asian ones (`yyyy"年"m"月"d"日"` and friends). `exceljs` only recognises
 * the first group, so this reader is deliberately wider: a Chinese workbook that dates a column with
 * format 31 would otherwise come back as five-digit serial numbers, which is the failure this whole
 * file exists to prevent. The fallback path is the only one affected, so nothing that reads today
 * changes shape.
 */
function isBuiltinDateFormatId(id: number): boolean {
  if (id >= 14 && id <= 22) return true;
  if (id >= 27 && id <= 36) return true;
  if (id >= 45 && id <= 47) return true;
  return id >= 50 && id <= 58;
}

/**
 * Whether a custom format code formats a date. Same shape as the `exceljs` test: drop everything
 * that is not a format token — `[...]` conditions and locale ids, `"..."` literals, and characters
 * escaped with `\`, `_` or `*` — then look for a date/time token. It is a heuristic, and it errs
 * towards "not a date" because reading a number as a number is recoverable and inventing a date is
 * not.
 */
function looksLikeDateFormat(code: string): boolean {
  const tokens = code
    .replace(/\[[^\]]*]/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/[\\_*]./g, "");
  return /[ymdhMsb]/.test(tokens);
}

/**
 * Excel stores a date as a day count. This is the conversion `exceljs` performs (`excelToDate`),
 * including its choice not to correct the 1900 leap-year bug, so the same workbook yields the same
 * instant no matter which of the two readers opened it. `xlsx.ts` renders a date as an ISO string,
 * so that is what this returns.
 */
function serialToIsoDate(serial: number, date1904: boolean): SheetCell {
  const milliseconds = Math.round((serial - 25569 + (date1904 ? 1462 : 0)) * 24 * 3600 * 1000);
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? serial : date.toISOString();
}

/** `A1` -> 1, `AB7` -> 28. Returns null when the reference carries no column letters. */
function columnOfReference(reference: string | undefined): number | null {
  if (reference === undefined) return null;
  let column = 0;
  for (const character of reference) {
    const code = character.charCodeAt(0);
    if (code >= 65 && code <= 90) column = column * 26 + (code - 64);
    else if (code >= 97 && code <= 122) column = column * 26 + (code - 96);
    else break;
  }
  return column > 0 ? column : null;
}

function positiveInteger(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Style indexes are 0-based, so `s="0"` is a real answer and must not read as "absent". */
function nonNegativeInteger(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The text of a shared string (`si`) or an inline string (`is`). `rPh` holds the phonetic guide a
 * Japanese workbook attaches to a cell; it is an annotation, not part of the value, so it is skipped
 * — otherwise the reading would be concatenated onto the word itself.
 */
function stringPartText(nodes: XmlNode[]): string {
  let text = "";
  for (const node of nodes) {
    const name = tagName(node);
    if (name === null || name === "rPh" || name === "phoneticPr") continue;
    if (name === "t") text += flattenText(childrenOf(node));
    else text += stringPartText(childrenOf(node));
  }
  return text;
}

function readSharedStrings(sharedStringsXml: string | null): string[] {
  if (sharedStringsXml === null) return [];
  const root = parseXmlLocalNames(sharedStringsXml).find((node) => tagName(node) === "sst");
  if (root === undefined) return [];
  return childrenOf(root)
    .filter((node) => tagName(node) === "si")
    .map((node) => stringPartText(childrenOf(node)));
}

function readNumberFormats(stylesXml: string | null): NumberFormats {
  if (stylesXml === null) return EMPTY_NUMBER_FORMATS;
  const root = parseXmlLocalNames(stylesXml).find((node) => tagName(node) === "styleSheet");
  if (root === undefined) return EMPTY_NUMBER_FORMATS;
  const children = childrenOf(root);
  const customCodes = new Map<number, string>();
  const numFmts = findChild(children, "numFmts");
  if (numFmts !== undefined) {
    for (const node of childrenOf(numFmts)) {
      if (tagName(node) !== "numFmt") continue;
      const id = Number.parseInt(attribute(node, "numFmtId") ?? "", 10);
      const code = attribute(node, "formatCode");
      if (Number.isFinite(id) && code !== undefined) customCodes.set(id, code);
    }
  }
  const styleFormatIds: number[] = [];
  const cellXfs = findChild(children, "cellXfs");
  if (cellXfs !== undefined) {
    for (const node of childrenOf(cellXfs)) {
      if (tagName(node) !== "xf") continue;
      const id = Number.parseInt(attribute(node, "numFmtId") ?? "0", 10);
      styleFormatIds.push(Number.isFinite(id) ? id : 0);
    }
  }
  return { styleFormatIds, customCodes };
}

function isDateStyle(styleIndex: number | null, formats: NumberFormats): boolean {
  if (styleIndex === null) return false;
  const id = formats.styleFormatIds[styleIndex];
  if (id === undefined) return false;
  if (isBuiltinDateFormatId(id)) return true;
  const code = formats.customCodes.get(id);
  return code !== undefined && looksLikeDateFormat(code);
}

type CellContext = {
  readonly sharedStrings: readonly string[];
  readonly formats: NumberFormats;
  readonly date1904: boolean;
};

function typedCellValue(cell: XmlNode, children: XmlNode[], context: CellContext): SheetCell {
  const type = attribute(cell, "t") ?? "n";
  const valueNode = findChild(children, "v");
  const raw = valueNode === undefined ? null : flattenText(childrenOf(valueNode));
  switch (type) {
    case "s": {
      // A shared string cell holds an index into xl/sharedStrings.xml, never the text itself.
      if (raw === null) return null;
      const index = Number.parseInt(raw, 10);
      if (!Number.isFinite(index) || index < 0) return null;
      return context.sharedStrings[index] ?? null;
    }
    case "inlineStr": {
      const inline = findChild(children, "is");
      return inline === undefined ? null : stringPartText(childrenOf(inline));
    }
    case "b":
      return raw === null ? null : raw !== "0" && raw.toLowerCase() !== "false";
    case "e":
      // "#DIV/0!" and friends: the marker a reader sees in the cell, which is also what the exceljs
      // path reports for an error cell.
      return raw;
    case "str":
      // Officially the cached STRING result of a formula, but it is also what several non-Microsoft
      // writers emit for a plain literal string (the repository fixture does exactly this). Either
      // way `<v>` holds the text a reader sees.
      return raw;
    case "d":
      // ISO 8601 in the file already, which is the shape xlsx.ts renders dates in.
      return raw;
    default: {
      if (raw === null || raw.trim().length === 0) return null;
      const number = Number(raw);
      if (!Number.isFinite(number)) return raw;
      const styleIndex = nonNegativeInteger(attribute(cell, "s"));
      return isDateStyle(styleIndex, context.formats) ? serialToIsoDate(number, context.date1904) : number;
    }
  }
}

function cellValue(cell: XmlNode, context: CellContext): SheetCell {
  const children = childrenOf(cell);
  const value = typedCellValue(cell, children, context);
  if (value !== null) return value;
  // A formula cell normally carries its last computed result in `<v>`, and that cached value is what
  // was resolved above — it is the honest answer, because it is the number or text the workbook
  // actually shows. Only when the writer stored no cached value at all is there nothing to report;
  // then fall back to the formula text behind a leading "=", which is precisely what the exceljs
  // path returns in the same situation, so neither reader ever passes a formula off as data.
  const formula = findChild(children, "f");
  if (formula === undefined) return null;
  const text = flattenText(childrenOf(formula)).trim();
  return text.length === 0 ? null : `=${text}`;
}

type ParsedRow = { number: number; cells: Map<number, SheetCell> };

function parseSheetData(sheetData: XmlNode, context: CellContext): ParsedRow[] {
  const rows: ParsedRow[] = [];
  let previousRowNumber = 0;
  for (const rowNode of childrenOf(sheetData)) {
    if (tagName(rowNode) !== "row") continue;
    const rowNumber = positiveInteger(attribute(rowNode, "r")) ?? previousRowNumber + 1;
    previousRowNumber = rowNumber;
    const cells = new Map<number, SheetCell>();
    let previousColumn = 0;
    for (const cellNode of childrenOf(rowNode)) {
      if (tagName(cellNode) !== "c") continue;
      const column = columnOfReference(attribute(cellNode, "r")) ?? previousColumn + 1;
      previousColumn = column;
      cells.set(column, cellValue(cellNode, context));
    }
    rows.push({ number: rowNumber, cells });
  }
  return rows;
}

/**
 * The used range, defined the way the exceljs path defines it: `rowCount` is the last row the sheet
 * declares (a declared-but-empty row still counts, as it does there) and `columnCount` is the widest
 * row's last cell. Deriving it from the cells rather than from `<dimension>` is deliberate — several
 * writers leave `<dimension>` stale or omit it.
 */
function materialize(name: string, parsedRows: readonly ParsedRow[]): OoxmlSheet {
  let rowCount = 0;
  let columnCount = 0;
  for (const row of parsedRows) {
    rowCount = Math.max(rowCount, row.number);
    for (const column of row.cells.keys()) columnCount = Math.max(columnCount, column);
  }
  const rows: SheetCell[][] = [];
  for (let index = 0; index < rowCount; index += 1) rows.push(new Array<SheetCell>(columnCount).fill(null));
  for (const row of parsedRows) {
    const target = rows[row.number - 1];
    if (target === undefined) continue;
    for (const [column, value] of row.cells) {
      if (column >= 1 && column <= columnCount) target[column - 1] = value;
    }
  }
  return { name, rowCount, columnCount, rows };
}

type SheetEntry = { name: string; relationshipId: string | undefined };

function workbookSheetEntries(tree: XmlNode[], file: string): SheetEntry[] {
  const root = tree.find((node) => tagName(node) === "workbook");
  if (root === undefined) {
    throw new OfficeToolError("UNSUPPORTED_FORMAT",
      `${WORKBOOK_PART} 缺少 workbook 根元素 / missing a workbook root element: ${file}`);
  }
  const sheets = findChild(childrenOf(root), "sheets");
  if (sheets === undefined) {
    throw new OfficeToolError("UNSUPPORTED_FORMAT",
      `${WORKBOOK_PART} 缺少 sheets 元素 / missing the sheets element: ${file}`);
  }
  return childrenOf(sheets)
    .filter((node) => tagName(node) === "sheet")
    .map((node, index) => ({
      name: attribute(node, "name") ?? `Sheet${index + 1}`,
      // `r:id` after the prefix is stripped; `sheet` carries no other `id` attribute, so there is
      // nothing for it to collide with.
      relationshipId: attribute(node, "id"),
    }));
}

function workbookIsDate1904(tree: XmlNode[]): boolean {
  const root = tree.find((node) => tagName(node) === "workbook");
  if (root === undefined) return false;
  const properties = findChild(childrenOf(root), "workbookPr");
  if (properties === undefined) return false;
  const flag = attribute(properties, "date1904") ?? attribute(properties, "dateCompatibility");
  return flag === "1" || flag === "true";
}

/**
 * Reads every worksheet of a workbook straight out of its OOXML package, in workbook order.
 *
 * Throws `OfficeToolError` with a message naming the part that defeated it — a caller that cannot
 * read a file has to hear why, and an empty workbook returned in silence is the failure mode that
 * makes an agent invent the contents of a spreadsheet it never opened.
 */
export async function xlsxReadDirect(file: string): Promise<OoxmlSheet[]> {
  const pkg = await openPackage(file);
  const workbookTree = parseXmlLocalNames(await readPartText(pkg, WORKBOOK_PART));
  const entries = workbookSheetEntries(workbookTree, file);
  const relationshipsXml = await readOptionalPartText(pkg, relationshipsPartOf(WORKBOOK_PART));
  const relationships = relationshipsXml === null ? [] : relationshipsOf(parseXmlLocalNames(relationshipsXml));
  const targetsById = new Map(relationships.map((relationship) => [relationship.id, relationship.target]));
  const worksheetTargets = relationships
    .filter((relationship) => relationship.type === WORKSHEET_RELATIONSHIP_TYPE)
    .map((relationship) => relationship.target);
  const context: CellContext = {
    sharedStrings: await readSharedStrings(await readOptionalPartText(pkg, SHARED_STRINGS_PART)),
    formats: readNumberFormats(await readOptionalPartText(pkg, STYLES_PART)),
    date1904: workbookIsDate1904(workbookTree),
  };

  const sheets: OoxmlSheet[] = [];
  for (const [index, entry] of entries.entries()) {
    const relationshipTarget = entry.relationshipId === undefined ? undefined : targetsById.get(entry.relationshipId);
    // A workbook whose sheet elements carry no usable `r:id` still names its worksheet parts in
    // order, so fall back to the n-th worksheet relationship and then to the conventional part name
    // rather than refusing a file whose only fault is a missing attribute.
    const target = relationshipTarget ?? worksheetTargets[index] ?? `/xl/worksheets/sheet${index + 1}.xml`;
    const part = resolveRelationshipTarget(WORKBOOK_PART, target);
    const xml = await readOptionalPartText(pkg, part);
    if (xml === null) {
      throw new OfficeToolError("UNSUPPORTED_FORMAT",
        `工作表 ${JSON.stringify(entry.name)} 的部件缺失 / the worksheet part is missing: ${part} (${file})`);
    }
    const worksheet = parseXmlLocalNames(xml).find((node) => tagName(node) === "worksheet");
    if (worksheet === undefined) {
      throw new OfficeToolError("UNSUPPORTED_FORMAT",
        `${part} 缺少 worksheet 根元素 / missing a worksheet root element: ${file}`);
    }
    const sheetData = findChild(childrenOf(worksheet), "sheetData");
    // A worksheet with no `sheetData` is legal and simply empty; that is a real answer, not a failure.
    sheets.push(materialize(entry.name, sheetData === undefined ? [] : parseSheetData(sheetData, context)));
  }
  return sheets;
}
