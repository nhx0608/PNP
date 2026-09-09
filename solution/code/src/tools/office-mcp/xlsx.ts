import { stat } from "node:fs/promises";
import ExcelJS from "exceljs";
import type { CellValue, Worksheet } from "exceljs";
import { OfficeToolError } from "./errors.ts";
import { xlsxReadDirect, type OoxmlSheet } from "./xlsx-ooxml.ts";

export type SheetCell = string | number | boolean | null;

export type XlsxReadResult = {
  path: string;
  sheets: string[];
  sheet: string;
  rowCount: number;
  columnCount: number;
  returnedRows: number;
  truncated: boolean;
  rows: SheetCell[][];
};

/**
 * Flattens one cell to a JSON value. A spreadsheet cell can be a formula record, rich text, a
 * hyperlink or an error marker; a model that receives `{"result":42}` for a number cannot compare
 * it with the next one, so each shape is reduced to the value a reader would see.
 */
function cellValue(value: CellValue): SheetCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return typeof value.text === "string" ? value.text : String(value.text);
    if ("result" in value) return value.result === undefined ? null : cellValue(value.result as CellValue);
    if ("formula" in value) return `=${value.formula}`;
    if ("error" in value) return String(value.error);
  }
  return String(value);
}

/** Excel forbids `: \ / ? * [ ]`, caps names at 31 characters and rejects blank names. */
function sanitizeSheetName(name: string, fallback: string): string {
  let cleaned = name.replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^'+|'+$/g, "").trim();
  if (cleaned.length === 0) cleaned = fallback;
  if (cleaned.length > 31) cleaned = cleaned.slice(0, 31).trim();
  return cleaned;
}

function uniqueSheetNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  return names.map((name, index) => {
    const base = sanitizeSheetName(name, `Sheet${index + 1}`);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate.toLowerCase())) {
      const tail = `(${suffix})`;
      candidate = `${base.slice(0, Math.max(0, 31 - tail.length))}${tail}`;
      suffix += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function sheetRows(worksheet: Worksheet, rowLimit: number, columnCount: number): SheetCell[][] {
  const rows: SheetCell[][] = [];
  for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const cells: SheetCell[] = [];
    for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) {
      cells.push(cellValue(row.getCell(columnNumber).value));
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * One worksheet, however it was read. Rows stay behind a call so the exceljs path — the one every
 * workbook this server writes goes through — keeps materialising only the rows `xlsx_read` was asked
 * for instead of the whole workbook.
 */
type LoadedSheet = {
  name: string;
  rowCount: number;
  columnCount: number;
  /** Rows 1..`limit`, each padded to `columnCount`. */
  readRows: (limit: number) => SheetCell[][];
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fromExcelJs(workbook: ExcelJS.Workbook): LoadedSheet[] {
  return workbook.worksheets.map((worksheet) => ({
    name: worksheet.name,
    rowCount: worksheet.rowCount,
    columnCount: worksheet.columnCount,
    readRows: (limit: number): SheetCell[][] => sheetRows(worksheet, limit, worksheet.columnCount),
  }));
}

function fromOoxml(sheets: readonly OoxmlSheet[]): LoadedSheet[] {
  return sheets.map((sheet) => ({
    name: sheet.name,
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
    readRows: (limit: number): SheetCell[][] => sheet.rows.slice(0, Math.max(0, limit)),
  }));
}

/**
 * Opens a workbook with exceljs and, only when that fails, reads the OOXML package directly.
 *
 * exceljs is kept as the primary reader: it is what `xlsx_write` produces, it resolves styles, dates
 * and shared strings the way this file has always reported them, and nothing about that path
 * changes. What it cannot do is read a workbook whose parts use a namespace PREFIX (`<x:sheet>`
 * rather than `<sheet>`) — it compares tag names literally, so its workbook model stays empty and it
 * dies on `undefined.sheets`. That spelling is valid OOXML and is what several non-Microsoft
 * generators emit, including the one that produced this repository's own evaluation fixture, so the
 * file being unreadable is a defect in the reader, not in the file. `xlsxReadDirect` resolves every
 * element by local name and is blind to the distinction.
 *
 * A workbook that parses into zero worksheets counts as a failure too: Excel cannot produce one, so
 * an empty worksheet list always means the reader gave up quietly, and letting that through would
 * hand the caller an empty spreadsheet instead of an error.
 */
async function loadWorkbook(file: string): Promise<LoadedSheet[]> {
  let primaryProblem: string;
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    if (workbook.worksheets.length > 0) return fromExcelJs(workbook);
    primaryProblem = "解析后没有工作表 / parsed without producing any worksheet";
  } catch (error) {
    primaryProblem = messageOf(error);
  }
  try {
    const sheets = await xlsxReadDirect(file);
    if (sheets.length === 0) {
      throw new OfficeToolError("UNSUPPORTED_FORMAT", "包内没有声明任何工作表 / the package declares no worksheet");
    }
    return fromOoxml(sheets);
  } catch (fallbackError) {
    // Both readers are named, with the reason each one gave. A caller that cannot open a file has to
    // be told which reader failed and why; answering with an empty workbook would be far worse.
    throw new OfficeToolError("UNSUPPORTED_FORMAT",
      `无法读取工作簿 / cannot read workbook: ${file}`
      + ` (exceljs: ${primaryProblem}；直接读取 OOXML 包 / direct OOXML reader: ${messageOf(fallbackError)})`);
  }
}

export type XlsxSheetSummary = { name: string; rowCount: number; columnCount: number; rows: SheetCell[][] };

/**
 * Every sheet of a workbook in one parse. `xlsxRead` answers "show me this sheet"; verifying a
 * multi-sheet export has to ask "what is in the whole workbook", and getting there through
 * `xlsxRead` would re-parse the file once per sheet.
 */
export async function xlsxSummarize(file: string): Promise<XlsxSheetSummary[]> {
  const sheets = await loadWorkbook(file);
  return sheets.map((worksheet) => ({
    name: worksheet.name,
    rowCount: worksheet.rowCount,
    columnCount: worksheet.columnCount,
    rows: worksheet.readRows(worksheet.rowCount),
  }));
}

export async function xlsxRead(file: string, sheet?: string, maxRows?: number): Promise<XlsxReadResult> {
  const sheets = await loadWorkbook(file);
  const names = sheets.map((worksheet) => worksheet.name);
  if (names.length === 0) throw new OfficeToolError("UNSUPPORTED_FORMAT", `工作簿没有工作表 / workbook has no sheets: ${file}`);
  let worksheet = sheets[0];
  if (sheet !== undefined && sheet.length > 0) {
    const byName = sheets.find((candidate) => candidate.name === sheet);
    const byIndex = /^\d+$/.test(sheet) ? sheets[Number(sheet) - 1] : undefined;
    const found = byName ?? byIndex;
    if (found === undefined) {
      throw new OfficeToolError("NO_MATCH",
        `工作表 ${JSON.stringify(sheet)} 不存在；可用工作表 / no such sheet, available: ${names.map((name) => JSON.stringify(name)).join(", ")}`);
    }
    worksheet = found;
  }
  if (worksheet === undefined) throw new OfficeToolError("UNSUPPORTED_FORMAT", `工作簿没有可读工作表 / no readable sheet: ${file}`);
  const limit = maxRows === undefined || maxRows <= 0 ? worksheet.rowCount : Math.min(maxRows, worksheet.rowCount);
  const columnCount = worksheet.columnCount;
  const rows = worksheet.readRows(limit);
  return {
    path: file,
    sheets: names,
    sheet: worksheet.name,
    rowCount: worksheet.rowCount,
    columnCount,
    returnedRows: rows.length,
    truncated: limit < worksheet.rowCount,
    rows,
  };
}

export type SheetInput = { name?: string; rows: SheetCell[][] };

export type XlsxWriteResult = {
  outputPath: string;
  sheets: { name: string; requestedName?: string; rowCount: number; columnCount: number }[];
  bytes: number;
};

/**
 * Writes one sheet per input table — the shape "export every table of a document into one workbook"
 * needs. The first row is treated as a header (bold, frozen) because that is what the callers of
 * this tool produce; the data itself is written exactly as given.
 */
export async function xlsxWrite(outputPath: string, sheets: readonly SheetInput[]): Promise<XlsxWriteResult> {
  if (sheets.length === 0) throw new OfficeToolError("INVALID_ARGUMENT", "sheets 不能为空 / must contain at least one sheet");
  const workbook = new ExcelJS.Workbook();
  const names = uniqueSheetNames(sheets.map((sheet, index) => sheet.name ?? `Sheet${index + 1}`));
  const summary: XlsxWriteResult["sheets"] = [];
  sheets.forEach((sheet, index) => {
    const name = names[index] as string;
    const worksheet = workbook.addWorksheet(name);
    const rows = sheet.rows;
    for (const row of rows) worksheet.addRow(row);
    const columnCount = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
    if (rows.length > 0) {
      worksheet.getRow(1).font = { bold: true };
      worksheet.views = [{ state: "frozen", ySplit: 1 }];
      for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) {
        const widest = rows.reduce((width, row) => {
          const cell = row[columnNumber - 1];
          const length = cell === null || cell === undefined ? 0 : String(cell).length;
          return Math.max(width, length);
        }, 8);
        worksheet.getColumn(columnNumber).width = Math.min(60, widest + 2);
      }
    }
    const requested = sheet.name;
    summary.push(requested !== undefined && requested !== name
      ? { name, requestedName: requested, rowCount: rows.length, columnCount }
      : { name, rowCount: rows.length, columnCount });
  });
  await workbook.xlsx.writeFile(outputPath);
  const info = await stat(outputPath);
  return { outputPath, sheets: summary, bytes: info.size };
}
