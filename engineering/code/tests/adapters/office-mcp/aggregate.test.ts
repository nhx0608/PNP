import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AggregateResult } from "../../../src/tools/office-mcp/aggregate.ts";
import { removeTree } from "../../kit/fs.ts";
import {
  expectError, makeWorkspace, startOfficeClient, structured, writeAggregateCsv, writeFixtureXlsx, XLSX_SHEET_ONE,
  type ToolResult,
} from "./harness.ts";

let session: Awaited<ReturnType<typeof startOfficeClient>> | null = null;
async function connect(): Promise<Client> {
  session ??= await startOfficeClient();
  return session.client;
}
after(async () => {
  if (session !== null) await session.stop();
});

function rowFor(result: AggregateResult, column: string, value: string): Record<string, unknown> {
  const found = result.rows.find((row) => row[column] === value);
  assert.ok(found !== undefined, `no group ${JSON.stringify(value)} in ${JSON.stringify(result.rows)}`);
  return found;
}

test("data_aggregate groups a CSV and reports the column types it inferred", async () => {
  const workspace = await makeWorkspace("aggregate-csv");
  try {
    const source = path.join(workspace, "库存台账.csv");
    await writeAggregateCsv(source);
    const client = await connect();
    const result = structured<AggregateResult>(await client.callTool({
      name: "data_aggregate",
      arguments: {
        path: source,
        groupBy: ["仓库"],
        aggregations: [
          { op: "count" },
          { op: "sum", column: "当前库存" },
          { op: "mean", column: "单价", as: "均价" },
        ],
        sort: [{ by: "sum_当前库存", direction: "desc" }],
      },
    }));
    assert.equal(result.source, "csv");
    assert.equal(result.rowCount, 6);
    assert.equal(result.filteredRowCount, 6);
    assert.equal(result.groupCount, 3);
    assert.deepEqual(result.aggregations.map((entry) => entry.name), ["count", "sum_当前库存", "均价"]);
    assert.deepEqual(rowFor(result, "仓库", "西安"), { 仓库: "西安", count: 3, "sum_当前库存": 165, 均价: 1.433333 });
    assert.deepEqual(rowFor(result, "仓库", "北京"), { 仓库: "北京", count: 2, "sum_当前库存": 10, 均价: 14 });
    assert.deepEqual(result.rows.map((row) => row["仓库"]), ["西安", "北京", "上海"], "sort must order by the named output column");

    const warehouse = result.columns.find((column) => column.column === "仓库");
    assert.equal(warehouse?.type, "text");
    const price = result.columns.find((column) => column.column === "单价");
    assert.equal(price?.type, "number");
    const stock = result.columns.find((column) => column.column === "当前库存");
    assert.deepEqual(
      { type: stock?.type, numericCount: stock?.numericCount, textCount: stock?.textCount, emptyCount: stock?.emptyCount },
      { type: "mixed", numericCount: 3, textCount: 2, emptyCount: 1 },
      "a column that mixes numbers with 未统计 and a blank must be reported as mixed, not as a number",
    );
  } finally {
    await removeTree(workspace);
  }
});

test("data_aggregate reports dirty cells as skipped and never sums them as zero", async () => {
  const workspace = await makeWorkspace("aggregate-skip");
  try {
    const source = path.join(workspace, "库存台账.csv");
    await writeAggregateCsv(source);
    const client = await connect();
    const result = structured<AggregateResult>(await client.callTool({
      name: "data_aggregate",
      arguments: { path: source, groupBy: ["仓库"], aggregations: [{ op: "sum", column: "当前库存" }] },
    }));
    assert.equal(rowFor(result, "仓库", "上海")["sum_当前库存"], null,
      "a group whose only quantity is 未统计 must report null, not a 0 that reads as a real total");
    const skipped = result.skipped.find((entry) => entry.column === "当前库存");
    assert.ok(skipped !== undefined, "the skipped cells must be reported, not silently dropped");
    assert.equal(skipped.nonNumericCount, 2);
    assert.equal(skipped.emptyCount, 1);
    assert.deepEqual(skipped.samples, ["未统计"], "the sample tells the caller what the unreadable cells looked like");
  } finally {
    await removeTree(workspace);
  }
});

test("data_aggregate parses thousands separators, currency signs and percent signs explicitly", async () => {
  const workspace = await makeWorkspace("aggregate-formats");
  try {
    const source = path.join(workspace, "库存台账.csv");
    await writeAggregateCsv(source);
    const client = await connect();
    const result = structured<AggregateResult>(await client.callTool({
      name: "data_aggregate",
      arguments: {
        path: source,
        aggregations: [
          { op: "sum", column: "金额" },
          { op: "mean", column: "占比" },
          { op: "median", column: "单价" },
          { op: "min", column: "单价" },
          { op: "max", column: "单价" },
          { op: "distinct", column: "仓库" },
          { op: "count", column: "当前库存", as: "有库存数的行" },
        ],
      },
    }));
    assert.equal(result.groupCount, 1, "no groupBy means one group over the whole table");
    const row = result.rows[0];
    assert.ok(row !== undefined);
    assert.equal(row["sum_金额"], 2320, "\"1,200\" and \"¥800\" are numbers; \"N/A\" is not");
    assert.equal(row["mean_占比"], 10.4, "a trailing percent sign keeps the number as written");
    assert.equal(row["median_单价"], 2.5);
    assert.equal(row["min_单价"], 0.8);
    assert.equal(row["max_单价"], 25);
    assert.equal(row["distinct_仓库"], 3);
    assert.equal(row["有库存数的行"], 5, "count over a column counts non-empty cells, not rows");
    assert.deepEqual(result.skipped.map((entry) => entry.column), ["金额", "占比"],
      "only the columns that actually lost cells are reported; 单价 is clean");
  } finally {
    await removeTree(workspace);
  }
});

test("data_aggregate filters rows before grouping", async () => {
  const workspace = await makeWorkspace("aggregate-filter");
  try {
    const source = path.join(workspace, "库存台账.csv");
    await writeAggregateCsv(source);
    const client = await connect();
    const below = structured<AggregateResult>(await client.callTool({
      name: "data_aggregate",
      arguments: {
        path: source,
        filters: [{ column: "当前库存", op: "lt", value: 50 }],
        aggregations: [{ op: "count" }],
      },
    }));
    assert.equal(below.filteredRowCount, 2, "45 and 10 are below 50; an empty or unreadable cell is not");
    assert.equal(below.rows[0]?.["count"], 2);

    const atLeastZero = structured<AggregateResult>(await client.callTool({
      name: "data_aggregate",
      arguments: {
        path: source,
        filters: [{ column: "当前库存", op: "gte", value: 0 }],
        aggregations: [{ op: "count" }],
      },
    }));
    assert.equal(atLeastZero.filteredRowCount, 3,
      "a cell that is not a number has no place in a numeric comparison and must be excluded, not compared as text");

    const named = structured<AggregateResult>(await client.callTool({
      name: "data_aggregate",
      arguments: {
        path: source,
        filters: [{ column: "仓库", op: "in", values: ["西安", "上海"] }],
        groupBy: ["仓库"],
        aggregations: [{ op: "count" }],
        sort: [{ by: "count", direction: "desc" }],
      },
    }));
    assert.deepEqual(named.rows, [{ 仓库: "西安", count: 3 }, { 仓库: "上海", count: 1 }]);
    assert.equal(named.filteredRowCount, 4);

    const either = structured<AggregateResult>(await client.callTool({
      name: "data_aggregate",
      arguments: {
        path: source,
        filterMode: "or",
        filters: [
          { column: "仓库", op: "eq", value: "上海" },
          { column: "物料", op: "contains", value: "螺" },
        ],
        aggregations: [{ op: "count" }],
      },
    }));
    assert.equal(either.filteredRowCount, 2);
  } finally {
    await removeTree(workspace);
  }
});

test("data_aggregate reads a named worksheet of an .xlsx", async () => {
  const workspace = await makeWorkspace("aggregate-xlsx");
  try {
    const source = path.join(workspace, "台账.xlsx");
    await writeFixtureXlsx(source);
    const client = await connect();
    const result = structured<AggregateResult>(await client.callTool({
      name: "data_aggregate",
      arguments: {
        path: source,
        sheet: XLSX_SHEET_ONE,
        groupBy: ["仓库"],
        aggregations: [{ op: "sum", column: "数量" }],
        sort: [{ by: "sum_数量", direction: "desc" }],
      },
    }));
    assert.equal(result.source, "xlsx");
    assert.equal(result.sheet, XLSX_SHEET_ONE);
    assert.deepEqual(result.rows, [{ 仓库: "西安", "sum_数量": 120 }, { 仓库: "北京", "sum_数量": 45 }]);
    assert.equal(result.rowCount, 2, "the header row is not a data row");
    assert.deepEqual(result.skipped, [], "a clean numeric column has nothing to report");
  } finally {
    await removeTree(workspace);
  }
});

test("data_aggregate refuses an unknown column, an unusable sort key and an unsupported file", async () => {
  const workspace = await makeWorkspace("aggregate-errors");
  try {
    const source = path.join(workspace, "库存台账.csv");
    await writeAggregateCsv(source);
    const client = await connect();
    expectError(await client.callTool({
      name: "data_aggregate", arguments: { path: source, groupBy: ["不存在的列"] },
    }) as ToolResult, "NO_MATCH");
    expectError(await client.callTool({
      name: "data_aggregate", arguments: { path: source, aggregations: [{ op: "sum" }] },
    }) as ToolResult, "INVALID_ARGUMENT");
    expectError(await client.callTool({
      name: "data_aggregate",
      arguments: { path: source, aggregations: [{ op: "sum", column: "单价" }], sort: [{ by: "mean_单价" }] },
    }) as ToolResult, "NO_MATCH");
    expectError(await client.callTool({
      name: "data_aggregate",
      arguments: {
        path: source,
        aggregations: [{ op: "sum", column: "单价" }, { op: "sum", column: "单价" }],
      },
    }) as ToolResult, "INVALID_ARGUMENT");
    expectError(await client.callTool({
      name: "data_aggregate", arguments: { path: "库存台账.csv" },
    }) as ToolResult, "PATH_NOT_ABSOLUTE");
    expectError(await client.callTool({
      name: "data_aggregate", arguments: { path: path.join(workspace, "缺失.csv") },
    }) as ToolResult, "PATH_NOT_FOUND");

    const document = path.join(workspace, "报告.docx");
    await writeAggregateCsv(document);
    expectError(await client.callTool({
      name: "data_aggregate", arguments: { path: document },
    }) as ToolResult, "UNSUPPORTED_FORMAT");
  } finally {
    await removeTree(workspace);
  }
});
