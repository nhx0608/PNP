import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { DocxExtraction, DocxReplacementResult } from "../../../src/tools/office-mcp/docx.ts";
import type { DocxCreateResult } from "../../../src/tools/office-mcp/docx-create.ts";
import { removeTree } from "../../kit/fs.ts";
import {
  DOCX_HEADING, DOCX_MERGED_TABLE_ROWS, DOCX_PARAGRAPH_ONE, DOCX_PARAGRAPH_TWO, expectError, makeWorkspace,
  startOfficeClient, structured, writeFixtureDocx, writeMergedTableDocx, type ToolResult,
} from "./harness.ts";

let session: Awaited<ReturnType<typeof startOfficeClient>> | null = null;
async function connect(): Promise<Client> {
  session ??= await startOfficeClient();
  return session.client;
}
after(async () => {
  if (session !== null) await session.stop();
});

async function documentXml(file: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(file));
  const entry = zip.file("word/document.xml");
  assert.ok(entry !== null, "output package has no word/document.xml");
  return entry.async("string");
}

test("docx_extract reports paragraphs, tables and headings in document order", async () => {
  const workspace = await makeWorkspace("docx-extract");
  try {
    const source = path.join(workspace, "西安报告.docx");
    await writeFixtureDocx(source);
    const client = await connect();
    const extraction = structured<DocxExtraction>(await client.callTool({ name: "docx_extract", arguments: { path: source } }));
    assert.equal(extraction.paragraphCount, 3);
    assert.deepEqual(extraction.paragraphs.map((paragraph) => paragraph.text),
      [DOCX_HEADING, DOCX_PARAGRAPH_ONE, DOCX_PARAGRAPH_TWO]);
    assert.deepEqual(extraction.paragraphs.map((paragraph) => paragraph.index), [0, 1, 2]);
    assert.equal(extraction.headings.length, 1);
    assert.equal(extraction.headings[0]?.level, 1);
    assert.equal(extraction.headings[0]?.paragraphIndex, 0);
    assert.equal(extraction.tableCount, 1);
    assert.deepEqual(extraction.tables[0]?.rows, [["物料", "数量"], ["螺栓", "120"]]);
    assert.equal(extraction.tables[0]?.bodyIndex, 3);
    assert.equal(extraction.tables[0]?.hasMergedCells, false, "a table without merges must not be reported as merged");
    assert.deepEqual(extraction.tables[0]?.cells[1], [
      { row: 1, column: 0, columnSpan: 1, rowSpan: 1, text: "螺栓" },
      { row: 1, column: 1, columnSpan: 1, rowSpan: 1, text: "120" },
    ]);
  } finally {
    await removeTree(workspace);
  }
});

test("docx_extract keeps a merged table on its real column grid instead of shifting the row", async () => {
  const workspace = await makeWorkspace("docx-merged");
  try {
    const source = path.join(workspace, "库存表.docx");
    await writeMergedTableDocx(source);
    const client = await connect();
    const extraction = structured<DocxExtraction>(await client.callTool({ name: "docx_extract", arguments: { path: source } }));
    const table = extraction.tables[0];
    assert.ok(table !== undefined);
    assert.deepEqual(table.rows, DOCX_MERGED_TABLE_ROWS,
      "the gridSpan header must occupy two columns so 备注 stays in the third, and the vMerge continuation must not repeat 西安");
    assert.equal(table.columnCount, 3);
    assert.equal(table.hasMergedCells, true);
    assert.ok(table.rows.every((row) => row.length === table.columnCount),
      "every row must be as wide as the grid, or a sheet export lands values under the wrong header");

    assert.deepEqual(table.cells[0], [
      { row: 0, column: 0, columnSpan: 2, rowSpan: 1, text: "库存汇总" },
      { row: 0, column: 2, columnSpan: 1, rowSpan: 1, text: "备注" },
    ]);
    assert.deepEqual(table.cells[2]?.[0], { row: 2, column: 0, columnSpan: 1, rowSpan: 2, text: "西安" },
      "a vertical merge is reported as a rowSpan on the cell that started it");
    assert.deepEqual(table.cells[3]?.map((cell) => cell.column), [1, 2],
      "the continued column contributes no cell of its own to the row below");
  } finally {
    await removeTree(workspace);
  }
});

test("docx_replace_paragraphs rewrites by index and by match, keeps formatting, leaves the input alone", async () => {
  const workspace = await makeWorkspace("docx-replace");
  try {
    const source = path.join(workspace, "执行摘要.docx");
    const target = path.join(workspace, "输出", "执行摘要-改.docx");
    await writeFixtureDocx(source);
    const client = await connect();
    const replacement = structured<DocxReplacementResult>(await client.callTool({
      name: "docx_replace_paragraphs",
      arguments: {
        path: source,
        outputPath: target,
        replacements: [
          { index: 1, text: "改写后的第一段。Rewritten first paragraph." },
          { match: DOCX_PARAGRAPH_TWO, text: "改写后的第二段。\nSecond line." },
        ],
      },
    }));
    assert.deepEqual(replacement.replaced.map((entry) => entry.index), [1, 2]);
    assert.equal(replacement.replaced[0]?.previousText, DOCX_PARAGRAPH_ONE);

    const after = structured<DocxExtraction>(await client.callTool({ name: "docx_extract", arguments: { path: target } }));
    assert.deepEqual(after.paragraphs.map((paragraph) => paragraph.text), [
      DOCX_HEADING,
      "改写后的第一段。Rewritten first paragraph.",
      "改写后的第二段。\nSecond line.",
    ]);
    assert.equal(after.tableCount, 1, "the table must survive a paragraph edit");
    assert.equal(after.headings[0]?.text, DOCX_HEADING);

    const xml = await documentXml(target);
    assert.match(xml, /<w:pStyle w:val="Heading1"\/>/, "the heading style must be preserved");
    assert.match(xml, /<w:rPr><w:b\/>/, "the bold run properties of the replaced paragraph must be preserved");
    assert.match(xml, /<w:br\/>/, "a newline in the replacement must become a real line break");
    assert.ok(!xml.includes(DOCX_PARAGRAPH_ONE), "the old text must be gone from the output");

    const original = structured<DocxExtraction>(await client.callTool({ name: "docx_extract", arguments: { path: source } }));
    assert.deepEqual(original.paragraphs.map((paragraph) => paragraph.text),
      [DOCX_HEADING, DOCX_PARAGRAPH_ONE, DOCX_PARAGRAPH_TWO], "the input file must not be modified");
  } finally {
    await removeTree(workspace);
  }
});

test("docx_replace_paragraphs refuses a relative path, a missing file, an ambiguous match and an existing output", async () => {
  const workspace = await makeWorkspace("docx-errors");
  try {
    const source = path.join(workspace, "报告.docx");
    await writeFixtureDocx(source);
    const client = await connect();
    const target = path.join(workspace, "out.docx");
    const replacements = [{ index: 1, text: "x" }];

    expectError(await client.callTool({
      name: "docx_replace_paragraphs", arguments: { path: "报告.docx", outputPath: target, replacements },
    }) as ToolResult, "PATH_NOT_ABSOLUTE");

    expectError(await client.callTool({
      name: "docx_extract", arguments: { path: path.join(workspace, "缺失.docx") },
    }) as ToolResult, "PATH_NOT_FOUND");

    expectError(await client.callTool({
      name: "docx_replace_paragraphs",
      arguments: { path: source, outputPath: target, replacements: [{ match: "第", text: "x" }] },
    }) as ToolResult, "AMBIGUOUS_MATCH");

    expectError(await client.callTool({
      name: "docx_replace_paragraphs",
      arguments: { path: source, outputPath: target, replacements: [{ index: 9, text: "x" }] },
    }) as ToolResult, "INDEX_OUT_OF_RANGE");

    structured<DocxReplacementResult>(await client.callTool({
      name: "docx_replace_paragraphs", arguments: { path: source, outputPath: target, replacements },
    }));
    expectError(await client.callTool({
      name: "docx_replace_paragraphs", arguments: { path: source, outputPath: target, replacements },
    }) as ToolResult, "OUTPUT_EXISTS");
    structured<DocxReplacementResult>(await client.callTool({
      name: "docx_replace_paragraphs", arguments: { path: source, outputPath: target, replacements, overwrite: true },
    }));
  } finally {
    await removeTree(workspace);
  }
});

test("docx_create writes a document the extractor reads back", async () => {
  const workspace = await makeWorkspace("docx-create");
  try {
    const target = path.join(workspace, "新建", "报告.docx");
    const client = await connect();
    const created = structured<DocxCreateResult>(await client.callTool({
      name: "docx_create",
      arguments: {
        outputPath: target,
        title: "库存分析报告",
        blocks: [
          { type: "heading", level: 1, text: "结论 Conclusion" },
          { type: "paragraph", text: "库存周转率提升。" },
          { type: "bullets", items: ["西安仓补货", "北京仓维持"] },
          { type: "table", rows: [["物料", "数量"], ["螺栓", "120"]] },
        ],
      },
    }));
    assert.equal(created.blockCount, 4);
    const extraction = structured<DocxExtraction>(await client.callTool({ name: "docx_extract", arguments: { path: target } }));
    assert.equal(extraction.tableCount, 1);
    assert.deepEqual(extraction.tables[0]?.rows, [["物料", "数量"], ["螺栓", "120"]]);
    const texts = extraction.paragraphs.map((paragraph) => paragraph.text);
    assert.deepEqual(texts, ["库存分析报告", "结论 Conclusion", "库存周转率提升。", "西安仓补货", "北京仓维持"]);
    assert.ok(extraction.headings.some((heading) => heading.text === "结论 Conclusion"));
  } finally {
    await removeTree(workspace);
  }
});
