import { stat } from "node:fs/promises";
import ExcelJS from "exceljs";
import type { CellValue } from "exceljs";
import { OfficeToolError } from "./errors.ts";

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
export function sanitizeSheetName(name: string, fallback: string): string {
  let cleaned = name.replace(/[\\/?*[\]:]/g, " ").replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^'+|'+$/g, "").trim();
  if (cleaned.length === 0) cleaned = fallback;
  if (cleaned.length > 31) cleaned = cleaned.slice(0, 31).trim();
  return cleaned;
}

export function uniqueSheetNames(names: readonly string[]): string[] {
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

export async function xlsxRead(file: string, sheet?: string, maxRows?: number): Promise<XlsxReadResult> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(file);
  } catch (error) {
    throw new OfficeToolError("UNSUPPORTED_FORMAT",
      `无法读取工作簿 / cannot read workbook: ${file} (${error instanceof Error ? error.message : String(error)})`);
  }
  const names = workbook.worksheets.map((worksheet) => worksheet.name);
  if (names.length === 0) throw new OfficeToolError("UNSUPPORTED_FORMAT", `工作簿没有工作表 / workbook has no sheets: ${file}`);
  let worksheet = workbook.worksheets[0];
  if (sheet !== undefined && sheet.length > 0) {
    const byName = workbook.worksheets.find((candidate) => candidate.name === sheet);
    const byIndex = /^\d+$/.test(sheet) ? workbook.worksheets[Number(sheet) - 1] : undefined;
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
  const rows: SheetCell[][] = [];
  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const cells: SheetCell[] = [];
    for (let columnNumber = 1; columnNumber <= columnCount; columnNumber += 1) {
      cells.push(cellValue(row.getCell(columnNumber).value));
    }
    rows.push(cells);
  }
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
