import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { DocxExtraction } from "../../../src/tools/office-mcp/docx.ts";
import type { XlsxReadResult, XlsxWriteResult } from "../../../src/tools/office-mcp/xlsx.ts";
import { removeTree } from "../../kit/fs.ts";
import {
  expectError, makeWorkspace, startOfficeClient, structured, writeFixtureDocx, writeFixtureXlsx, XLSX_SHEET_ONE,
  XLSX_SHEET_TWO, type ToolResult,
} from "./harness.ts";

let session: Awaited<ReturnType<typeof startOfficeClient>> | null = null;
async function connect(): Promise<Client> {
  session ??= await startOfficeClient();
  return session.client;
}
after(async () => {
  if (session !== null) await session.stop();
});

test("xlsx_read lists every sheet and reads the one that was asked for, by name or by position", async () => {
  const workspace = await makeWorkspace("xlsx-read");
  try {
    const source = path.join(workspace, "台账.xlsx");
    await writeFixtureXlsx(source);
    const client = await connect();

    const first = structured<XlsxReadResult>(await client.callTool({ name: "xlsx_read", arguments: { path: source } }));
    assert.deepEqual(first.sheets, [XLSX_SHEET_ONE, XLSX_SHEET_TWO]);
    assert.equal(first.sheet, XLSX_SHEET_ONE);
    assert.deepEqual(first.rows, [["物料", "数量", "仓库"], ["螺栓", 120, "西安"], ["垫片", 45, "北京"]]);

    const named = structured<XlsxReadResult>(await client.callTool({
      name: "xlsx_read", arguments: { path: source, sheet: XLSX_SHEET_ONE },
    }));
    assert.equal(named.sheet, XLSX_SHEET_ONE);
    assert.equal(named.rowCount, 3);

    const byIndex = structured<XlsxReadResult>(await client.callTool({
      name: "xlsx_read", arguments: { path: source, sheet: "2" },
    }));
    assert.equal(byIndex.sheet, XLSX_SHEET_TWO);
    assert.deepEqual(byIndex.rows, [["metric", "value"], ["total", 165]]);

    const limited = structured<XlsxReadResult>(await client.callTool({
      name: "xlsx_read", arguments: { path: source, sheet: XLSX_SHEET_ONE, maxRows: 2 },
    }));
    assert.equal(limited.returnedRows, 2);
    assert.equal(limited.truncated, true);

    const missing = expectError(await client.callTool({
      name: "xlsx_read", arguments: { path: source, sheet: "不存在" },
    }) as ToolResult, "NO_MATCH");
    assert.ok(missing.includes(XLSX_SHEET_ONE), "the error must list the sheets that do exist");
  } finally {
    await removeTree(workspace);
  }
});

test("xlsx_write sanitises and de-duplicates sheet names and writes what xlsx_read reads back", async () => {
  const workspace = await makeWorkspace("xlsx-write");
  try {
    const target = path.join(workspace, "导出", "结果.xlsx");
    const client = await connect();
    const written = structured<XlsxWriteResult>(await client.callTool({
      name: "xlsx_write",
      arguments: {
        outputPath: target,
        sheets: [
          { name: "库存/台账[2026]", rows: [["物料", "数量"], ["螺栓", 120]] },
          { name: "库存/台账[2026]", rows: [["物料", "数量"], ["垫片", 45]] },
          { rows: [["a", true, null]] },
        ],
      },
    }));
    assert.equal(written.sheets.length, 3);
    const names = written.sheets.map((sheet) => sheet.name);
    assert.ok(names[0] !== undefined && !/[\\/?*[\]:]/.test(names[0]), `sheet name not sanitised: ${names[0]}`);
    assert.notEqual(names[0], names[1], "duplicate sheet names must be made unique");

    const read = structured<XlsxReadResult>(await client.callTool({
      name: "xlsx_read", arguments: { path: target, sheet: names[1] },
    }));
    assert.deepEqual(read.rows, [["物料", "数量"], ["垫片", 45]]);
  } finally {
    await removeTree(workspace);
  }
});

test("every table of a document exports into one workbook with one sheet per table", async () => {
  const workspace = await makeWorkspace("xlsx-export");
  try {
    const source = path.join(workspace, "报告.docx");
    const target = path.join(workspace, "表格汇总.xlsx");
    await writeFixtureDocx(source);
    const client = await connect();
    const extraction = structured<DocxExtraction>(await client.callTool({ name: "docx_extract", arguments: { path: source } }));
    const written = structured<XlsxWriteResult>(await client.callTool({
      name: "xlsx_write",
      arguments: {
        outputPath: target,
        sheets: extraction.tables.map((table) => ({ name: `表${table.index + 1}`, rows: table.rows })),
      },
    }));
    assert.equal(written.sheets.length, extraction.tables.length);
    const read = structured<XlsxReadResult>(await client.callTool({ name: "xlsx_read", arguments: { path: target } }));
    assert.equal(read.sheet, "表1");
    assert.deepEqual(read.rows, [["物料", "数量"], ["螺栓", "120"]]);
  } finally {
    await removeTree(workspace);
  }
});
