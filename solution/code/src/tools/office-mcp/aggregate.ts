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

/**
 * An aggregation exactly as it arrived, before `normalizeAggregateRequest` has had a look at it.
 * `op` is a plain string and `value`/`values` are accepted here even though an aggregation has no
 * use for them, because that is the shape of the call this tool actually receives when it is
 * misused — see the normaliser for what happens next. Nothing downstream sees this type.
 */
export type RawAggregateSpec = {
  op: string;
  column?: string | null;
  as?: string | null;
  value?: FilterValue | null;
  values?: FilterValue[] | null;
};

export type AggregateSort = { by: string; direction?: "asc" | "desc" };

export type AggregateRequest = {
  path: string;
  sheet?: string;
  delimiter?: string;
  filters?: AggregateFilter[];
  filterMode?: "and" | "or";
  groupBy?: string[];
  aggregations?: readonly RawAggregateSpec[];
  sort?: AggregateSort[];
  limit?: number | null;
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

/** A column whose values would work as a `groupBy` key, with the values it actually holds. */
export type GroupingCandidate = { column: string; distinctCount: number; samples: string[] };

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
  /**
   * Why this answer may not be the one the caller meant, and which parameter changes it. `warnings`
   * says "the argument you passed does nothing"; a hint says "the numbers are right but they are
   * not the numbers you were asking for". Evaluation case office_014 is the reason it exists: a
   * model asked for per-`defaulted` statistics, left `groupBy` out, got one whole-table row, and
   * — with nothing in the reply naming `groupBy` — repeated the identical call until the run ended.
   * Empty when there is nothing to say, so a well-formed call stays quiet.
   */
  hints: string[];
  /** Present only when a hint above offers grouping keys, so a caller can act without asking again. */
  groupingCandidates?: GroupingCandidate[];
  returnedRows: number;
  truncated: boolean;
  rows: AggregateRow[];
  skipped: AggregateSkip[];
  warnings: string[];
};

/** Above this the answer stops being an answer and becomes a second copy of the file. */
const DEFAULT_ROW_LIMIT = 1000;
const SAMPLE_LIMIT = 5;

/**
 * What makes a column a plausible `groupBy` key. A candidate needs at least two distinct values —
 * one value regroups the table into the single row the caller already has — at most 20, so the
 * reply stays a summary instead of a second copy of the file, and no more than one distinct value
 * per two rows, so a near-unique id column can never look like a category. Against office_014's
 * fixture `defaulted` (2 values over 200 rows) passes and `customer_id` (200 over 200) fails both
 * the cap and the ratio. The same three numbers decide when an existing `groupBy` is reported as a
 * listing rather than a summary, so the tool cannot recommend a shape it would then complain about.
 */
const MIN_GROUP_KEYS = 2;
const MAX_GROUP_KEYS = 20;
const MIN_ROWS_PER_GROUP = 2;
/** Enough keys to choose between; a 50-column file must not answer with 50 suggestions. */
const CANDIDATE_LIMIT = 6;

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

/** The seven things this tool can compute. Anything else in `op` is a caller mistake, not a feature. */
const AGGREGATE_OPERATIONS = new Set<string>(["count", "sum", "mean", "min", "max", "median", "distinct"]);
/** The twelve comparisons `filters[].op` accepts, kept here so the normaliser can recognise one in the wrong field. */
const FILTER_OPERATORS = new Set<string>([
  "eq", "ne", "gt", "gte", "lt", "lte", "contains", "notContains", "in", "notIn", "empty", "notEmpty",
]);
/**
 * Names for the same seven operations that a model reaches for first. Accepting them costs nothing
 * and removes a whole class of round trip: "avg" is not an ambiguous request, it is `mean` spelled
 * the way most tools spell it.
 */
const OPERATION_ALIASES = new Map<string, AggregateOperation>([
  ["avg", "mean"], ["average", "mean"],
  ["total", "sum"],
  ["cnt", "count"], ["size", "count"], ["rows", "count"], ["rowcount", "count"], ["row_count", "count"],
  ["nunique", "distinct"], ["unique", "distinct"], ["uniquecount", "distinct"],
  ["countdistinct", "distinct"], ["count_distinct", "distinct"], ["distinctcount", "distinct"],
]);

function canonicalOperation(op: string): AggregateOperation | undefined {
  const lower = op.trim().toLowerCase();
  if (AGGREGATE_OPERATIONS.has(lower)) return lower as AggregateOperation;
  return OPERATION_ALIASES.get(lower);
}

/** A filter operator, spelled the way `filters[].op` wants it, or undefined when `op` is not one. */
function canonicalFilterOperator(op: string): FilterOperator | undefined {
  const lower = op.trim().toLowerCase();
  for (const candidate of FILTER_OPERATORS) {
    if (candidate.toLowerCase() === lower) return candidate as FilterOperator;
  }
  return undefined;
}

export type NormalizedAggregateRequest = {
  aggregations: AggregateSpec[];
  filters: AggregateFilter[];
  filterMode: "and" | "or";
};

/**
 * Reads the call the caller meant when the one they sent cannot be read literally.
 *
 * Evaluation case office_014 is why this exists. A model wanted "how many rows have credit_score
 * above 700" and wrote it as `aggregations:[{op:"gt", column:"credit_score", value:700}]` — a
 * filter in the field that names a statistic. The schema rejected it, the rejection said only
 * which strings `op` accepts, and the model sent the identical call four more times before giving
 * up and writing the report without any numbers in it. The information needed to answer was
 * present in the very first call; only the shape was wrong.
 *
 * So exactly one reading is repaired, the one that has no second interpretation: a single
 * aggregation whose `op` is a comparison and which carries the value to compare against. That is
 * "count the rows matching this condition", it becomes a filter plus a count, and the repair is
 * stated in `warnings` and in the tool summary — the caller is told what was run, never left to
 * assume its own call was executed as written. Two such aggregations in one call are not repaired:
 * whether they meant one filtered count or two separate ones is a guess, and a guessed number
 * presented as an answer is the failure this whole module is built to avoid.
 *
 * Everything else is rejected with the corrected call written out in the message, because a
 * rejection a model cannot act on costs the same as a wrong answer.
 */
export function normalizeAggregateRequest(request: AggregateRequest, warnings: string[]): NormalizedAggregateRequest {
  const filters: AggregateFilter[] = [...(request.filters ?? [])];
  const filterMode = request.filterMode ?? "and";
  const raw = request.aggregations ?? [{ op: "count" }];
  const misplaced = raw.filter((spec) => canonicalOperation(spec.op) === undefined
    && canonicalFilterOperator(spec.op) !== undefined);

  if (misplaced.length === 1 && raw.length === 1) {
    const spec = misplaced[0]!;
    const operator = canonicalFilterOperator(spec.op)!;
    const needsValue = operator !== "empty" && operator !== "notEmpty";
    const hasValue = spec.value !== undefined && spec.value !== null;
    const hasValues = Array.isArray(spec.values) && spec.values.length > 0;
    if (typeof spec.column === "string" && spec.column.length > 0 && (!needsValue || hasValue || hasValues)) {
      const repaired: AggregateFilter = {
        column: spec.column, op: operator,
        ...(hasValue ? { value: spec.value as FilterValue } : {}),
        ...(hasValues ? { values: spec.values as FilterValue[] } : {}),
      };
      filters.push(repaired);
      const name = typeof spec.as === "string" && spec.as.length > 0 ? spec.as : `count_${spec.column}`;
      warnings.push(
        `aggregations[0].op=${JSON.stringify(spec.op)} 是过滤条件，不是统计方式；已按“先筛选再计数”执行：`
        + `filters 追加 ${JSON.stringify(repaired)}，统计项改为 {"op":"count","as":${JSON.stringify(name)}}。`
        + `下次请直接写在 filters 里 / a comparison was passed where an aggregation was expected; it was`
        + ` moved into filters and the aggregation became a count. Pass comparisons in filters.`,
      );
      return { aggregations: [{ op: "count", as: name }], filters, filterMode };
    }
  }

  const aggregations: AggregateSpec[] = raw.map((spec, position) => {
    const canonical = canonicalOperation(spec.op);
    if (canonical === undefined) {
      const label = `aggregations[${position}]`;
      const filterOperator = canonicalFilterOperator(spec.op);
      const example = filterOperator === undefined ? "" :
        `。它是过滤条件：应写成 filters:[{"column":${JSON.stringify(spec.column ?? "列名")},`
        + `"op":${JSON.stringify(filterOperator)},"value":${JSON.stringify(spec.value ?? 0)}}]`
        + `，同时 aggregations 传 [{"op":"count"}] / it is a filter: move it into filters and count`;
      throw new OfficeToolError("INVALID_ARGUMENT",
        `${label}.op=${JSON.stringify(spec.op)} 不是统计方式，只能是 `
        + `count / sum / mean / min / max / median / distinct${example}`);
    }
    return {
      op: canonical,
      ...(typeof spec.column === "string" && spec.column.length > 0 ? { column: spec.column } : {}),
      ...(typeof spec.as === "string" && spec.as.length > 0 ? { as: spec.as } : {}),
    };
  });
  return { aggregations, filters, filterMode };
}

function resolveAggregations(
  headers: readonly string[], specs: readonly AggregateSpec[], groupBy: readonly string[],
): ResolvedSpec[] {
  if (specs.length === 0) {
    // An empty list is a legitimate-looking argument with no legitimate reading, so it fails — but
    // the message has to carry the fix, or the caller only learns that its call was rejected.
    throw new OfficeToolError("INVALID_ARGUMENT",
      "aggregations 不能是空数组：要统计行数请传 [{\"op\":\"count\"}]，省略该参数也会默认做一次 count"
      + " / aggregations must not be an empty array; pass [{\"op\":\"count\"}] or omit the parameter"
      + " to default to a single row count");
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

/**
 * The distinct non-empty values of a column, or `null` once there are more than `limit` of them.
 * Stopping at the limit keeps this bounded in memory over an id column of a large file, and the
 * exact count above the limit is not something any caller acts on: too many is too many.
 */
function distinctValues(rows: readonly AggregateCell[][], index: number, limit: number): string[] | null {
  const seen = new Set<string>();
  for (const row of rows) {
    const text = cellText(row[index] ?? null).trim();
    if (text.length === 0) continue;
    seen.add(text);
    if (seen.size > limit) return null;
  }
  return [...seen];
}

function findGroupingCandidates(
  headers: readonly string[], rows: readonly AggregateCell[][], exclude: ReadonlySet<string>,
): GroupingCandidate[] {
  const limit = Math.min(MAX_GROUP_KEYS, Math.floor(rows.length / MIN_ROWS_PER_GROUP));
  if (limit < MIN_GROUP_KEYS) return [];
  const found: GroupingCandidate[] = [];
  headers.forEach((column, index) => {
    if (exclude.has(column)) return;
    const values = distinctValues(rows, index, limit);
    if (values === null || values.length < MIN_GROUP_KEYS) return;
    found.push({ column, distinctCount: values.length, samples: values.slice(0, SAMPLE_LIMIT) });
  });
  // Fewest groups first: the shortest table is the one a model can read back and act on.
  return found.sort((left, right) => left.distinctCount - right.distinctCount).slice(0, CANDIDATE_LIMIT);
}

function describeCandidates(candidates: readonly GroupingCandidate[]): string {
  if (candidates.length === 0) {
    return "没有列的取值数量适合做分组键 / no column has a small enough set of distinct values to group by";
  }
  return "候选分组列 / grouping candidates: " + candidates
    .map((entry) => `${JSON.stringify(entry.column)}（${entry.distinctCount} 个不同值 / distinct: ${entry.samples.join(", ")}）`)
    .join("; ");
}

type DiagnosisInput = {
  headers: readonly string[];
  columns: readonly AggregateColumn[];
  tableRows: readonly AggregateCell[][];
  keptRows: readonly AggregateCell[][];
  filterColumns: readonly { column: string; index: number; op: FilterOperator }[];
  groupBy: readonly string[];
  specs: readonly ResolvedSpec[];
  aggregationsGiven: boolean;
  rows: readonly AggregateRow[];
  returnedRows: number;
};

/**
 * Everything the numbers alone do not say. Each case here is an input that is legal, is computed
 * correctly, and reads as a finished answer while actually answering a different question than the
 * caller asked; a model that cannot tell the difference retries the identical call instead of
 * fixing the argument. Nothing here changes what was computed.
 */
function diagnose(input: DiagnosisInput): { hints: string[]; candidates: GroupingCandidate[] } {
  const hints: string[] = [];
  let candidates: GroupingCandidate[] = [];
  const kept = input.keptRows.length;

  // An empty input has exactly one thing worth saying, and saying anything else on top of it is
  // wrong: "mean is null because the column holds no number" is false when the column is fine and
  // the row set is empty. So these two cases answer alone.
  if (input.tableRows.length === 0) {
    return {
      hints: ["文件里没有数据行（只有表头或整表为空），所有统计都是对 0 行算出来的。"
        + " / The file has no data rows (header only, or empty), so every number below counts nothing."],
      candidates,
    };
  }
  if (kept === 0) {
    // Zeros and nulls over an empty set look exactly like a real "nothing is at risk" finding.
    const present = input.filterColumns.map((entry) => {
      const values = distinctValues(input.tableRows, entry.index, MAX_GROUP_KEYS);
      const shown = values === null
        ? "取值过多，未列出 / too many values to list"
        : values.slice(0, SAMPLE_LIMIT).join(", ");
      return `${JSON.stringify(entry.column)} ${entry.op}（${shown}）`;
    }).join("; ");
    return {
      hints: [`filters 只匹配到 0/${input.tableRows.length} 行，下面的统计是在空集合上算出来的，`
        + `不是"没有符合条件的行"这一结论；请先核对过滤值的拼写、大小写与类型。`
        + ` / The filters matched 0 of ${input.tableRows.length} rows, so every number below is computed over an`
        + ` empty set and is not a finding; check the spelling, case and type of the filter values first.`
        + ` 被过滤列的实际取值 / values actually present: ${present}`],
      candidates,
    };
  }

  if (input.groupBy.length === 0) {
    candidates = findGroupingCandidates(input.headers, input.keptRows, new Set());
    const first = candidates[0];
    const example = first === undefined ? "" : ` groupBy: [${JSON.stringify(first.column)}]`;
    hints.push(`本次没有传 groupBy：返回的这 1 行是全部 ${kept} 行（过滤后）的整表汇总，`
      + `不是按类别拆开的结果；要让每个类别各占一行，请传 groupBy`
      + (example === "" ? "。" : `，例如${example}。`)
      + ` / No groupBy was requested, so the single row aggregates all ${kept} filtered rows;`
      + ` pass groupBy to get one row per category`
      + (example === "" ? "." : `, e.g.${example}.`)
      + ` ${describeCandidates(candidates)}`);
  } else if (input.rows.length > MAX_GROUP_KEYS && input.rows.length * MIN_ROWS_PER_GROUP > kept) {
    candidates = findGroupingCandidates(input.headers, input.keptRows, new Set(input.groupBy));
    hints.push(`groupBy ${input.groupBy.map((column) => JSON.stringify(column)).join(", ")} 把 ${kept} 行拆成了`
      + ` ${input.rows.length} 组，几乎每行一组：这是原表的另一种排列，不是汇总；`
      + `按取值较少的列分组才能得到可读的结论。`
      + ` / Grouping by these columns turned ${kept} rows into ${input.rows.length} groups, roughly one row each:`
      + ` that is a re-listing of the file, not a summary. Group by a column with fewer distinct values.`
      + ` ${describeCandidates(candidates)}`);
  }

  if (!input.aggregationsGiven) {
    const numeric = input.columns.find((column) => column.type === "number");
    const example = numeric === undefined
      ? ""
      : ` aggregations: [{"op":"mean","column":${JSON.stringify(numeric.column)}}]`;
    hints.push("没有传 aggregations，本次只统计了行数 count；求和、均值等必须显式传 aggregations"
      + (example === "" ? "。" : `，例如${example}。`)
      + " / No aggregations were given, so only a row count was computed; pass aggregations for sums or means"
      + (example === "" ? "." : `, e.g.${example}.`));
  }

  for (const spec of input.specs) {
    if (spec.column === undefined || spec.op === "count" || spec.op === "distinct") continue;
    if (input.rows.length === 0 || input.rows.some((row) => row[spec.name] !== null)) continue;
    // null everywhere is correct and unreadable: it means "no number here", not "the value is 0".
    hints.push(`${spec.name} 在每一组都是 null，因为 ${JSON.stringify(spec.column)} 里没有任何可解析的数字`
      + `（原因见 skipped），这不等于 0。`
      + ` / ${spec.name} is null in every group because ${JSON.stringify(spec.column)} holds no parsable number`
      + ` (see skipped); that is not a zero.`);
  }

  if (input.returnedRows < input.rows.length) {
    hints.push(`结果被截断：共 ${input.rows.length} 组，只返回了前 ${input.returnedRows} 组，`
      + `对返回行求和不等于全表的合计；请提高 limit 或先用 filters 缩小范围。`
      + ` / Truncated: ${input.rows.length} groups exist and only the first ${input.returnedRows} are returned,`
      + ` so totals over the returned rows are not totals over the file; raise limit or narrow the filters.`);
  }

  return { hints, candidates };
}

export async function dataAggregate(request: AggregateRequest): Promise<AggregateResult> {
  const warnings: string[] = [];
  const table = await loadTable(request, warnings);
  const headers = table.headers;
  const groupBy = request.groupBy ?? [];
  const groupIndexes = groupBy.map((column, position) => columnIndex(headers, column, `groupBy[${position}]`));
  const normalized = normalizeAggregateRequest(request, warnings);
  const specs = resolveAggregations(headers, normalized.aggregations, groupBy);
  const filters = normalized.filters.map((filter, position) => ({
    filter,
    label: `filters[${position}]`,
    index: columnIndex(headers, filter.column, `filters[${position}]`),
  }));
  const mode = normalized.filterMode;
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
  const limit = request.limit === undefined || request.limit === null || request.limit <= 0
    ? Math.min(rows.length, DEFAULT_ROW_LIMIT)
    : Math.min(request.limit, rows.length);

  const columns = describeColumns(headers, table.rows);
  const diagnosis = diagnose({
    headers,
    columns,
    tableRows: table.rows,
    keptRows: kept,
    filterColumns: filters.map((entry) => ({ column: entry.filter.column, index: entry.index, op: entry.filter.op })),
    groupBy,
    specs,
    aggregationsGiven: request.aggregations !== undefined,
    rows,
    returnedRows: limit,
  });

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
    columns,
    rowCount: table.rows.length,
    filteredRowCount: kept.length,
    groupBy: [...groupBy],
    aggregations: specs.map((spec) => (spec.column === undefined
      ? { name: spec.name, op: spec.op }
      : { name: spec.name, op: spec.op, column: spec.column })),
    groupCount: rows.length,
    // Before `rows`, so an engine that shows the model a truncated JSON blob still shows the hint.
    hints: diagnosis.hints,
    ...(diagnosis.candidates.length === 0 ? {} : { groupingCandidates: diagnosis.candidates }),
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
