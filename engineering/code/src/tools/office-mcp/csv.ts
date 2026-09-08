import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { OfficeToolError } from "./errors.ts";

export type ColumnStatistics = {
  column: string;
  index: number;
  count: number;
  min: number;
  max: number;
  mean: number;
  sum: number;
};

export type CsvReadResult = {
  path: string;
  delimiter: string;
  headers: string[];
  rowCount: number;
  returnedRows: number;
  truncated: boolean;
  rows: string[][];
  numericColumns: ColumnStatistics[];
  textColumns: { column: string; index: number; distinctCount: number; sample: string[] }[];
};

const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"];

/** Picks the delimiter that splits the first non-empty line into the most fields. */
function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0) ?? "";
  let best = ",";
  let bestCount = 0;
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const count = line.split(delimiter).length;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

function asNumber(value: string): number | null {
  const trimmed = value.trim().replace(/,/g, "").replace(/%$/, "");
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toFixed(6));
}

/**
 * Reads a CSV and reports what a model needs before it can write an analysis: the headers, the
 * rows, and per-column basics. Statistics are computed over every data row, not just the rows
 * returned under `maxRows`, so a truncated preview still reports totals for the whole file.
 */
export async function csvRead(file: string, delimiter?: string, maxRows?: number): Promise<CsvReadResult> {
  const text = await readFile(file, "utf8");
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const separator = delimiter !== undefined && delimiter.length > 0 ? delimiter : detectDelimiter(withoutBom);
  let records: string[][];
  try {
    records = parse(withoutBom, {
      delimiter: separator,
      bom: false,
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      trim: false,
    }) as string[][];
  } catch (error) {
    throw new OfficeToolError("UNSUPPORTED_FORMAT",
      `无法解析 CSV / cannot parse CSV: ${file} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (records.length === 0) {
    return {
      path: file, delimiter: separator, headers: [], rowCount: 0, returnedRows: 0, truncated: false,
      rows: [], numericColumns: [], textColumns: [],
    };
  }
  const headers = (records[0] ?? []).map((header, index) => header.trim().length > 0 ? header.trim() : `column${index + 1}`);
  const dataRows = records.slice(1);
  const limit = maxRows === undefined || maxRows <= 0 ? dataRows.length : Math.min(maxRows, dataRows.length);
  const numericColumns: ColumnStatistics[] = [];
  const textColumns: CsvReadResult["textColumns"] = [];
  const width = dataRows.reduce((widest, row) => Math.max(widest, row.length), headers.length);
  for (let index = 0; index < width; index += 1) {
    const values = dataRows.map((row) => row[index] ?? "").filter((value) => value.trim().length > 0);
    const numbers = values.map((value) => asNumber(value)).filter((value): value is number => value !== null);
    const column = headers[index] ?? `column${index + 1}`;
    if (values.length > 0 && numbers.length >= Math.ceil(values.length * 0.6)) {
      const sum = numbers.reduce((total, value) => total + value, 0);
      numericColumns.push({
        column, index, count: numbers.length,
        min: round(Math.min(...numbers)), max: round(Math.max(...numbers)),
        mean: round(sum / numbers.length), sum: round(sum),
      });
    } else {
      const distinct = new Set(values);
      textColumns.push({ column, index, distinctCount: distinct.size, sample: [...distinct].slice(0, 5) });
    }
  }
  return {
    path: file,
    delimiter: separator,
    headers,
    rowCount: dataRows.length,
    returnedRows: limit,
    truncated: limit < dataRows.length,
    rows: dataRows.slice(0, limit),
    numericColumns,
    textColumns,
  };
}
