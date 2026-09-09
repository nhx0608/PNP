import { csvRead } from "./csv.ts";
import { OfficeToolError } from "./errors.ts";
import { xlsxRead, type SheetCell } from "./xlsx.ts";

/**
 * Group-by and statistics over a .csv or .xlsx, computed here instead of in the model's head. An
 * evaluation task — which materials are below safety stock, which segment defaults most — is scored
 * on the numbers, and a small model that adds 200 rows by hand gets them wrong. Every number this
 * returns is derived from the file by code, and every cell that could not be read as a number is
 * reported as skipped instead of counted as 0: a mean over silently zeroed cells is exactly the
 * confident wrong answer a judge penalises.
 */
export type AggregateCell = SheetCell;

export type AggregateOperation = "count" | "sum" | "mean" | "min" | "max" | "median" | "distinct";

export type FilterOperator =
  | "eq" | "ne" | "gt" | "gte" | "lt" | "lte"
  | "contains" | "notContains" | "in" | "notIn" | "empty" | "notEmpty";

export type FilterValue = string | number | boolean;

export type AggregateFilter = { column: string; op: FilterOperator; value?: FilterValue; values?: FilterValue[] };

export type AggregateSpec = { op: AggregateOperation; column?: string; as?: string };

export type AggregateSort = { by: string; direction?: "asc" | "desc" };

export type AggregateRequest = {
  path: string;
  sheet?: string;
  delimiter?: string;
  filters?: AggregateFilter[];
  filterMode?: "and" | "or";
  groupBy?: string[];
  aggregations?: AggregateSpec[];
  sort?: AggregateSort[];
  limit?: number;
};

export type ColumnKind = "number" | "text" | "boolean" | "empty" | "mixed";

export type AggregateColumn = {
  column: string;
  index: number;
  type: ColumnKind;
  numericCount: number;
  textCount: number;
  emptyCount: number;
};

/** Why a numeric aggregation ignored cells, so a dirty column is visible instead of quietly averaged. */
export type AggregateSkip = { column: string; nonNumericCount: number; emptyCount: number; samples: string[] };

export type AggregateRow = Record<string, AggregateCell>;

export type AggregateResult = {
  path: string;
  source: "csv" | "xlsx";
  sheet?: string;
  sheets?: string[];
  delimiter?: string;
  headers: string[];
  columns: AggregateColumn[];
  rowCount: number;
  filteredRowCount: number;
  groupBy: string[];
  aggregations: { name: string; op: AggregateOperation; column?: string }[];
  groupCount: number;
  returnedRows: number;
  truncated: boolean;
  rows: AggregateRow[];
  skipped: AggregateSkip[];
  warnings: string[];
};

/** Above this the answer stops being an answer and becomes a second copy of the file. */
const DEFAULT_ROW_LIMIT = 1000;
const SAMPLE_LIMIT = 5;

const PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const GROUPED_NUMBER = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const CURRENCY_PREFIX = /^[¥￥$€£]\s*/;

export type NumericParse = { ok: true; value: number } | { ok: false; reason: "empty" | "not-a-number" };

/**
 * The one place a cell becomes a number. Accepted: a real number, a plain decimal, a thousands-
 * grouped decimal ("1,250.5"), a leading currency sign, and a trailing percent sign (the number is
 * kept as written, so "12%" is 12 — the same reading csv_read reports). Everything else — "约 120",
 * "N/A", "120 件", a boolean — is not a number, and is reported rather than coerced.
 */
export function parseNumericCell(cell: AggregateCell): NumericParse {
  if (cell === null) return { ok: false, reason: "empty" };
  if (typeof cell === "number") {
    return Number.isFinite(cell) ? { ok: true, value: cell } : { ok: false, reason: "not-a-number" };
  }
  if (typeof cell === "boolean") return { ok: false, reason: "not-a-number" };
  const trimmed = cell.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  let text = trimmed.replace(CURRENCY_PREFIX, "");
  if (text.endsWith("%")) text = text.slice(0, -1).trim();
  if (GROUPED_NUMBER.test(text)) text = text.replace(/,/g, "");
  if (!PLAIN_NUMBER.test(text)) return { ok: false, reason: "not-a-number" };
  const parsed = Number(text);
  return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false, reason: "not-a-number" };
}

function cellText(cell: AggregateCell): string {
  return cell === null ? "" : String(cell);
}

function round(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toFixed(6));
}

type Table = {
  source: "csv" | "xlsx";
  headers: string[];
  rows: AggregateCell[][];
  sheet?: string;
  sheets?: string[];
  delimiter?: string;
};

function isBlankRow(row: readonly AggregateCell[]): boolean {
  return row.every((cell) => cellText(cell).trim().length === 0);
}

function headerNames(cells: readonly AggregateCell[]): string[] {
  return cells.map((cell, index) => {
    const text = cellText(cell).trim();
    return text.length > 0 ? text : `column${index + 1}`;
  });
}

async function loadTable(request: AggregateRequest, warnings: string[]): Promise<Table> {
  const lower = request.path.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt")) {
    if (request.sheet !== undefined) {
      warnings.push("sheet 对 CSV 无意义，已忽略 / sheet does not apply to a CSV and was ignored");
    }
    const csv = await csvRead(request.path, request.delimiter);
    return { source: "csv", headers: csv.headers, rows: csv.rows, delimiter: csv.delimiter };
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) {
    if (request.delimiter !== undefined) {
      warnings.push("delimiter 对工作簿无意义，已忽略 / delimiter does not apply to a workbook and was ignored");
    }
    const workbook = await xlsxRead(request.path, request.sheet);
    const [header, ...rest] = workbook.rows;
    if (header === undefined) {
      return { source: "xlsx", headers: [], rows: [], sheet: workbook.sheet, sheets: workbook.sheets };
    }
    return {
      source: "xlsx",
      headers: headerNames(header),
      rows: rest.filter((row) => !isBlankRow(row)),
      sheet: workbook.sheet,
      sheets: workbook.sheets,
    };
  }
  throw new OfficeToolError("UNSUPPORTED_FORMAT",
    `data_aggregate 只支持 .csv 与 .xlsx / only .csv and .xlsx are supported, got ${JSON.stringify(request.path)}`);
}

/** Resolves a column name to its index: the exact header first, then a trimmed case-insensitive match. */
function columnIndex(headers: readonly string[], name: string, label: string): number {
  const exact = headers.indexOf(name);
  if (exact >= 0) return exact;
  const wanted = name.trim().toLowerCase();
  const relaxed = headers.findIndex((header) => header.trim().toLowerCase() === wanted);
  if (relaxed >= 0) return relaxed;
  throw new OfficeToolError("NO_MATCH",
    `${label} 的列 ${JSON.stringify(name)} 不存在；可用列 / no such column, available: `
    + headers.map((header) => JSON.stringify(header)).join(", "));
}

function describeColumns(headers: readonly string[], rows: readonly AggregateCell[][]): AggregateColumn[] {
  return headers.map((column, index) => {
    let numericCount = 0;
    let textCount = 0;
    let emptyCount = 0;
    let booleanCount = 0;
    for (const row of rows) {
      const cell = row[index] ?? null;
      if (typeof cell === "boolean") booleanCount += 1;
      const parsed = parseNumericCell(cell);
      if (parsed.ok) numericCount += 1;
      else if (parsed.reason === "empty") emptyCount += 1;
      else textCount += 1;
    }
    let type: ColumnKind = "mixed";
    if (numericCount === 0 && textCount === 0) type = "empty";
    else if (numericCount === 0 && booleanCount === textCount) type = "boolean";
    else if (textCount === 0) type = "number";
    else if (numericCount === 0) type = "text";
    return { column, index, type, numericCount, textCount, emptyCount };
  });
}

/**
 * Ordering for `gt`/`gte`/`lt`/`lte`: numeric when both sides are numbers, textual when neither is,
 * and `null` — not comparable — when they disagree. Comparing 未统计 against 50 as text would put it
 * confidently on one side of the threshold; a cell that is not a number simply has no place in a
 * numeric comparison.
 */
function compareValues(cell: AggregateCell, bound: FilterValue): number | null {
  const cellNumber = parseNumericCell(cell);
  const boundNumber = parseNumericCell(typeof bound === "boolean" ? String(bound) : bound);
  if (cellNumber.ok !== boundNumber.ok) return null;
  if (cellNumber.ok && boundNumber.ok) return cellNumber.value - boundNumber.value;
  const left = cellText(cell).trim();
  const right = String(bound).trim();
  return left === right ? 0 : (left < right ? -1 : 1);
}

function equalValues(cell: AggregateCell, value: FilterValue): boolean {
  const cellNumber = parseNumericCell(cell);
  const valueNumber = parseNumericCell(typeof value === "boolean" ? String(value) : value);
  if (cellNumber.ok && valueNumber.ok) return cellNumber.value === valueNumber.value;
  return cellText(cell).trim() === String(value).trim();
}

function requireValue(filter: AggregateFilter, label: string): FilterValue {
  if (filter.value === undefined) {
    throw new OfficeToolError("INVALID_ARGUMENT", `${label}.op=${filter.op} 需要 value / needs a value`);
  }
  return filter.value;
}

function requireValues(filter: AggregateFilter, label: string): FilterValue[] {
  if (filter.values === undefined || filter.values.length === 0) {
    throw new OfficeToolError("INVALID_ARGUMENT",
      `${label}.op=${filter.op} 需要非空的 values / needs a non-empty values list`);
  }
  return filter.values;
}

function matchesFilter(cell: AggregateCell, filter: AggregateFilter, label: string): boolean {
  const text = cellText(cell).trim();
  if (filter.op === "empty") return text.length === 0;
  if (filter.op === "notEmpty") return text.length > 0;
  if (filter.op === "eq") return equalValues(cell, requireValue(filter, label));
  if (filter.op === "ne") return !equalValues(cell, requireValue(filter, label));
  if (filter.op === "contains") return text.includes(String(requireValue(filter, label)));
  if (filter.op === "notContains") return !text.includes(String(requireValue(filter, label)));
  if (filter.op === "in") return requireValues(filter, label).some((value) => equalValues(cell, value));
  if (filter.op === "notIn") return !requireValues(filter, label).some((value) => equalValues(cell, value));
  // An empty cell is outside every ordered comparison; it is not "less than" the threshold.
  if (text.length === 0) return false;
  const order = compareValues(cell, requireValue(filter, label));
  if (order === null) return false;
  if (filter.op === "gt") return order > 0;
  if (filter.op === "gte") return order >= 0;
  if (filter.op === "lt") return order < 0;
  return order <= 0;
}

function defaultName(spec: AggregateSpec): string {
  return spec.column === undefined ? spec.op : `${spec.op}_${spec.column}`;
}

type ResolvedSpec = { name: string; op: AggregateOperation; column?: string; index?: number };

function resolveAggregations(
  headers: readonly string[], specs: readonly AggregateSpec[], groupBy: readonly string[],
): ResolvedSpec[] {
  if (specs.length === 0) {
    throw new OfficeToolError("INVALID_ARGUMENT", "aggregations 不能为空 / must contain at least one aggregation");
  }
  const used = new Set<string>(groupBy);
  return specs.map((spec, position) => {
    const label = `aggregations[${position}]`;
    if (spec.column === undefined && spec.op !== "count") {
      throw new OfficeToolError("INVALID_ARGUMENT", `${label}.op=${spec.op} 需要 column / needs a column`);
    }
    const name = spec.as !== undefined && spec.as.length > 0 ? spec.as : defaultName(spec);
    if (used.has(name)) {
      throw new OfficeToolError("INVALID_ARGUMENT",
        `${label} 的输出列名 ${JSON.stringify(name)} 与已有列重复，请用 as 指定 / duplicate output column, set "as"`);
    }
    used.add(name);
    if (spec.column === undefined) return { name, op: spec.op };
    return { name, op: spec.op, column: spec.column, index: columnIndex(headers, spec.column, label) };
  });
}

type SkipTally = { nonNumericCount: number; emptyCount: number; samples: Set<string> };

function numericValues(rows: readonly AggregateCell[][], index: number, tally: SkipTally): number[] {
  const values: number[] = [];
  for (const row of rows) {
    const cell = row[index] ?? null;
    const parsed = parseNumericCell(cell);
    if (parsed.ok) {
      values.push(parsed.value);
      continue;
    }
    if (parsed.reason === "empty") {
      tally.emptyCount += 1;
      continue;
    }
    tally.nonNumericCount += 1;
    if (tally.samples.size < SAMPLE_LIMIT) tally.samples.add(cellText(cell).trim());
  }
  return values;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/**
 * One aggregation over one group. `null` — not 0 — is the answer when no cell of the group carried a
 * number: a sum reported as 0 for a column of "N/A" reads as a real total and cannot be told apart
 * from a genuine zero.
 */
function computeAggregation(
  spec: ResolvedSpec, rows: readonly AggregateCell[][], tallies: Map<string, SkipTally>,
): AggregateCell {
  const index = spec.index;
  if (index === undefined) return rows.length;
  if (spec.op === "count") {
    return rows.filter((row) => cellText(row[index] ?? null).trim().length > 0).length;
  }
  if (spec.op === "distinct") {
    const seen = new Set<string>();
    for (const row of rows) {
      const text = cellText(row[index] ?? null).trim();
      if (text.length > 0) seen.add(text);
    }
    return seen.size;
  }
  const column = spec.column ?? String(index);
  let tally = tallies.get(column);
  if (tally === undefined) {
    tally = { nonNumericCount: 0, emptyCount: 0, samples: new Set<string>() };
    tallies.set(column, tally);
  }
  const values = numericValues(rows, index, tally);
  if (values.length === 0) return null;
  if (spec.op === "sum") return round(values.reduce((total, value) => total + value, 0));
  if (spec.op === "mean") return round(values.reduce((total, value) => total + value, 0) / values.length);
  if (spec.op === "min") return round(Math.min(...values));
  if (spec.op === "max") return round(Math.max(...values));
  return round(median(values));
}

function compareRows(left: AggregateRow, right: AggregateRow, sort: readonly AggregateSort[]): number {
  for (const entry of sort) {
    const direction = entry.direction === "desc" ? -1 : 1;
    const leftValue = left[entry.by] ?? null;
    const rightValue = right[entry.by] ?? null;
    if (leftValue === null && rightValue === null) continue;
    // A group with no numeric value sorts last in both directions: it is missing, not extreme.
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    if (typeof leftValue === "number" && typeof rightValue === "number") {
      if (leftValue !== rightValue) return (leftValue - rightValue) * direction;
      continue;
    }
    const order = String(leftValue).localeCompare(String(rightValue));
    if (order !== 0) return order * direction;
  }
  return 0;
}

export async function dataAggregate(request: AggregateRequest): Promise<AggregateResult> {
  const warnings: string[] = [];
  const table = await loadTable(request, warnings);
  const headers = table.headers;
  const groupBy = request.groupBy ?? [];
  const groupIndexes = groupBy.map((column, position) => columnIndex(headers, column, `groupBy[${position}]`));
  const specs = resolveAggregations(headers, request.aggregations ?? [{ op: "count" }], groupBy);
  const filters = (request.filters ?? []).map((filter, position) => ({
    filter,
    label: `filters[${position}]`,
    index: columnIndex(headers, filter.column, `filters[${position}]`),
  }));
  const mode = request.filterMode ?? "and";
  const kept = filters.length === 0 ? table.rows : table.rows.filter((row) => {
    const outcomes = filters.map((entry) => matchesFilter(row[entry.index] ?? null, entry.filter, entry.label));
    return mode === "or" ? outcomes.some((value) => value) : outcomes.every((value) => value);
  });

  const groups = new Map<string, { key: AggregateCell[]; rows: AggregateCell[][] }>();
  if (groupBy.length === 0) {
    groups.set("", { key: [], rows: [...kept] });
  } else {
    for (const row of kept) {
      const key = groupIndexes.map((index) => row[index] ?? null);
      const identity = JSON.stringify(key.map((cell) => cellText(cell).trim()));
      const existing = groups.get(identity);
      if (existing === undefined) groups.set(identity, { key, rows: [row] });
      else existing.rows.push(row);
    }
  }

  const tallies = new Map<string, SkipTally>();
  const rows: AggregateRow[] = [];
  for (const group of groups.values()) {
    const output: AggregateRow = {};
    groupBy.forEach((column, position) => {
      output[column] = cellText(group.key[position] ?? null).trim();
    });
    for (const spec of specs) output[spec.name] = computeAggregation(spec, group.rows, tallies);
    rows.push(output);
  }

  const sort = request.sort ?? [];
  for (const entry of sort) {
    if (!groupBy.includes(entry.by) && !specs.some((spec) => spec.name === entry.by)) {
      throw new OfficeToolError("NO_MATCH",
        `sort.by ${JSON.stringify(entry.by)} 不是输出列；可用 / not an output column, available: `
        + [...groupBy, ...specs.map((spec) => spec.name)].map((name) => JSON.stringify(name)).join(", "));
    }
  }
  if (sort.length > 0) rows.sort((left, right) => compareRows(left, right, sort));
  const limit = request.limit === undefined || request.limit <= 0
    ? Math.min(rows.length, DEFAULT_ROW_LIMIT)
    : Math.min(request.limit, rows.length);

  const skipped: AggregateSkip[] = [];
  for (const [column, tally] of tallies) {
    if (tally.nonNumericCount === 0 && tally.emptyCount === 0) continue;
    skipped.push({
      column,
      nonNumericCount: tally.nonNumericCount,
      emptyCount: tally.emptyCount,
      samples: [...tally.samples],
    });
  }

  const result: AggregateResult = {
    path: request.path,
    source: table.source,
    headers,
    columns: describeColumns(headers, table.rows),
    rowCount: table.rows.length,
    filteredRowCount: kept.length,
    groupBy: [...groupBy],
    aggregations: specs.map((spec) => (spec.column === undefined
      ? { name: spec.name, op: spec.op }
      : { name: spec.name, op: spec.op, column: spec.column })),
    groupCount: rows.length,
    returnedRows: limit,
    truncated: limit < rows.length,
    rows: rows.slice(0, limit),
    skipped,
    warnings,
  };
  if (table.sheet !== undefined) result.sheet = table.sheet;
  if (table.sheets !== undefined) result.sheets = table.sheets;
  if (table.delimiter !== undefined) result.delimiter = table.delimiter;
  return result;
}
