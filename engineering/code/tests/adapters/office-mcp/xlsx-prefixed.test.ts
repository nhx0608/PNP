import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { AggregateResult } from "../../../src/tools/office-mcp/aggregate.ts";
import type { DocVerifyResult } from "../../../src/tools/office-mcp/verify.ts";
import { xlsxRead, type XlsxReadResult } from "../../../src/tools/office-mcp/xlsx.ts";
import { xlsxReadDirect } from "../../../src/tools/office-mcp/xlsx-ooxml.ts";
import { removeTree } from "../../kit/fs.ts";
import { expectError, makeWorkspace, startOfficeClient, structured, type ToolResult } from "./harness.ts";

/**
 * The repository's own evaluation input for case office_018, used exactly as it sits in the tree.
 * It is a structurally complete OOXML package whose parts spell their elements with a namespace
 * prefix (`<x:sheet>` rather than `<sheet>`) — the shape non-Microsoft generators such as WPS Office
 * emit, and the shape `exceljs` cannot read because it matches tag names literally. Reading it here
 * rather than copying it in is the point: the regression is the real file, hash included.
 */
const PREFIXED_FIXTURE = fileURLToPath(
  new URL("../../../../verification/eval/fixtures/inputs/generate_excel_1.xlsx", import.meta.url));

const FIXTURE_SHEET = "库存管理台账";
const FIXTURE_HEADERS = ["物料编码", "物料名称", "当前库存", "安全库存", "最大库存", "采购周期(天)", "供应商"];

let session: Awaited<ReturnType<typeof startOfficeClient>> | null = null;
async function connect(): Promise<Client> {
  session ??= await startOfficeClient();
  return session.client;
}
after(async () => {
  if (session !== null) await session.stop();
});

const SPREADSHEETML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/**
 * Rewrites a part so every element carries the `x:` prefix bound to the spreadsheetml namespace.
 * The document is unchanged — a prefix is only an alias for the namespace URI — which is exactly why
 * a reader is wrong to reject it. Elements that already carry a prefix (`mc:`, `x14ac:`) are left
 * alone, and attributes are untouched.
 */
function withNamespacePrefix(xml: string): string {
  return xml
    .replace(`xmlns="${SPREADSHEETML}"`, `xmlns:x="${SPREADSHEETML}"`)
    .replace(/<(\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, (_match, slash: string, name: string) => `<${slash}x:${name}`);
}

/** The same workbook, written twice: once as exceljs writes it, once with prefixed element names. */
async function writeWorkbookPair(unprefixed: string, prefixed: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("入库明细");
  sheet.addRow(["物料", "数量", "合格", "入库日期", "金额"]);
  sheet.addRow(["螺栓", 120, true, new Date(Date.UTC(2026, 2, 9)), { formula: "B2*2", result: 240 }]);
  sheet.addRow(["垫片", 45, false, null, { formula: "B3*2" }]);
  await workbook.xlsx.writeFile(unprefixed);

  const zip = await JSZip.loadAsync(await readFile(unprefixed));
  for (const part of ["xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/sharedStrings.xml"]) {
    const entry = zip.file(part);
    assert.ok(entry !== null, `the fixture writer must produce ${part}`);
    zip.file(part, withNamespacePrefix(await entry.async("string")));
  }
  await writeFile(prefixed, await zip.generateAsync({ type: "nodebuffer" }));
}

test("xlsx_read opens the prefixed-OOXML workbook the office_018 evaluation fixture really is", async () => {
  const client = await connect();
  const result = structured<XlsxReadResult>(await client.callTool({
    name: "xlsx_read", arguments: { path: PREFIXED_FIXTURE },
  }));
  assert.deepEqual(result.sheets, [FIXTURE_SHEET]);
  assert.equal(result.sheet, FIXTURE_SHEET);
  assert.equal(result.rowCount, 31, "a header row plus 30 material rows");
  assert.equal(result.columnCount, 7);
  assert.equal(result.returnedRows, 31);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.rows[0], FIXTURE_HEADERS);
  assert.deepEqual(result.rows[1], ["MAT-001", "组件 A1", 72, 43, 125, 7, "华东供应"],
    "the quantities must come back as numbers, not as the strings the file spells them with");
  assert.deepEqual(result.rows[30], ["MAT-030", "组件 D2", 17, 35, 105, 3, "远航配件"]);
  for (const row of result.rows.slice(1)) {
    assert.equal(typeof row[2], "number", `stock must be numeric in ${JSON.stringify(row)}`);
  }

  const limited = structured<XlsxReadResult>(await client.callTool({
    name: "xlsx_read", arguments: { path: PREFIXED_FIXTURE, sheet: FIXTURE_SHEET, maxRows: 3 },
  }));
  assert.equal(limited.returnedRows, 3);
  assert.equal(limited.truncated, true);
  assert.deepEqual(limited.rows[0], FIXTURE_HEADERS);
});

test("data_aggregate computes real grouped numbers over the prefixed-OOXML fixture", async () => {
  const client = await connect();
  const result = structured<AggregateResult>(await client.callTool({
    name: "data_aggregate",
    arguments: {
      path: PREFIXED_FIXTURE,
      groupBy: ["供应商"],
      aggregations: [{ op: "count" }, { op: "sum", column: "当前库存" }],
      sort: [{ by: "sum_当前库存", direction: "desc" }],
    },
  }));
  assert.equal(result.source, "xlsx");
  assert.equal(result.sheet, FIXTURE_SHEET);
  assert.deepEqual(result.headers, FIXTURE_HEADERS);
  assert.equal(result.rowCount, 30, "the header row is not a data row");
  assert.ok(result.groupCount > 1, `expected several suppliers, got ${result.groupCount}`);
  assert.deepEqual(result.skipped, [], "every stock cell is a number, so nothing may be skipped");

  const totals = result.rows.map((row) => row["sum_当前库存"]);
  for (const total of totals) assert.equal(typeof total, "number", `a group total must be a number, got ${String(total)}`);
  const counts = result.rows.map((row) => Number(row["count"]));
  assert.equal(counts.reduce((sum, value) => sum + value, 0), 30, "every row must land in exactly one group");
  // The sum of the group sums is the sum of the column, so an off-by-one or a mis-typed cell shows up.
  const direct = await xlsxRead(PREFIXED_FIXTURE);
  const expectedTotal = direct.rows.slice(1).reduce((sum, row) => sum + Number(row[2]), 0);
  assert.equal(totals.reduce((sum, value) => sum + Number(value), 0), expectedTotal);
});

test("doc_verify checks minSheets and sheetNames against the prefixed-OOXML fixture", async () => {
  const client = await connect();
  const result = structured<DocVerifyResult>(await client.callTool({
    name: "doc_verify",
    arguments: {
      path: PREFIXED_FIXTURE,
      minSheets: 1,
      sheetNames: [FIXTURE_SHEET],
      mustContain: ["MAT-001", "华东供应"],
    },
  }));
  assert.equal(result.kind, "xlsx");
  assert.equal(result.formatValid, true);
  assert.equal(result.sheetCount, 1);
  assert.deepEqual(result.sheetNames, [FIXTURE_SHEET]);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  for (const check of ["minSheets", "sheetNames", "mustContain"]) {
    assert.ok(result.checked.includes(check), `${check} must have been evaluated, got ${JSON.stringify(result.checked)}`);
  }
  assert.deepEqual(result.skipped, []);
});

test("the direct OOXML reader returns exactly what exceljs returns for a workbook exceljs wrote", async () => {
  const workspace = await makeWorkspace("xlsx-readers-agree");
  try {
    const unprefixed = path.join(workspace, "入库.xlsx");
    const prefixed = path.join(workspace, "入库-prefixed.xlsx");
    await writeWorkbookPair(unprefixed, prefixed);

    // The primary path: exceljs reads its own output, which is what every caller gets today.
    const primary = await xlsxRead(unprefixed);
    assert.deepEqual(primary.rows, [
      ["物料", "数量", "合格", "入库日期", "金额"],
      ["螺栓", 120, true, "2026-03-09T00:00:00.000Z", 240],
      ["垫片", 45, false, null, "=B3*2"],
    ], "the exceljs path must keep reporting exactly what it reports today");

    const [direct, ...rest] = await xlsxReadDirect(unprefixed);
    assert.deepEqual(rest, [], "the workbook has one sheet");
    assert.ok(direct !== undefined);
    // Shared strings, numbers, booleans, a date behind a number format, a formula's cached result and
    // a formula with no cached value: the fallback has to agree with exceljs on every one of them.
    assert.deepEqual(
      { name: direct.name, rowCount: direct.rowCount, columnCount: direct.columnCount, rows: direct.rows },
      { name: primary.sheet, rowCount: primary.rowCount, columnCount: primary.columnCount, rows: primary.rows },
    );
  } finally {
    await removeTree(workspace);
  }
});

test("a prefixed workbook reads identically to the unprefixed workbook it was made from", async () => {
  const workspace = await makeWorkspace("xlsx-prefixed-pair");
  try {
    const unprefixed = path.join(workspace, "入库.xlsx");
    const prefixed = path.join(workspace, "入库-prefixed.xlsx");
    await writeWorkbookPair(unprefixed, prefixed);
    const client = await connect();

    const plain = structured<XlsxReadResult>(await client.callTool({ name: "xlsx_read", arguments: { path: unprefixed } }));
    const aliased = structured<XlsxReadResult>(await client.callTool({ name: "xlsx_read", arguments: { path: prefixed } }));
    assert.deepEqual(
      { sheets: aliased.sheets, sheet: aliased.sheet, rowCount: aliased.rowCount, columnCount: aliased.columnCount, rows: aliased.rows },
      { sheets: plain.sheets, sheet: plain.sheet, rowCount: plain.rowCount, columnCount: plain.columnCount, rows: plain.rows },
      "a namespace prefix is an alias, so the two files are the same workbook and must read the same",
    );

    const verified = structured<DocVerifyResult>(await client.callTool({
      name: "doc_verify", arguments: { path: prefixed, minSheets: 1, sheetNames: ["入库明细"], mustContain: ["螺栓"] },
    }));
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.sheetNames, ["入库明细"]);
  } finally {
    await removeTree(workspace);
  }
});

test("a workbook neither reader can open fails loudly and names both readers", async () => {
  const workspace = await makeWorkspace("xlsx-corrupt");
  try {
    const truncated = path.join(workspace, "损坏.xlsx");
    // A real .xlsx header followed by nothing: it starts like a zip, so neither reader can dismiss it
    // on its first bytes, and both have to admit they cannot open it.
    await writeFile(truncated, Buffer.concat([Buffer.from("PK", "latin1"), Buffer.alloc(64)]));
    const client = await connect();
    const message = expectError(
      await client.callTool({ name: "xlsx_read", arguments: { path: truncated } }) as ToolResult, "UNSUPPORTED_FORMAT");
    assert.ok(message.includes("exceljs"), `the error must name the primary reader, got: ${message}`);
    assert.ok(message.includes("OOXML"), `the error must name the fallback reader, got: ${message}`);
    assert.ok(message.includes(truncated), `the error must name the file, got: ${message}`);

    // A well-formed zip that is not a workbook: the fallback must say which part it wanted, not
    // return an empty spreadsheet.
    const notAWorkbook = path.join(workspace, "不是工作簿.xlsx");
    const zip = new JSZip();
    zip.file("hello.txt", "这不是工作簿");
    await writeFile(notAWorkbook, await zip.generateAsync({ type: "nodebuffer" }));
    const second = expectError(
      await client.callTool({ name: "xlsx_read", arguments: { path: notAWorkbook } }) as ToolResult, "UNSUPPORTED_FORMAT");
    assert.ok(second.includes("xl/workbook.xml"), `the error must name the missing part, got: ${second}`);
  } finally {
    await removeTree(workspace);
  }
});
