import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import ExcelJS from "exceljs";
import { PptxGen } from "../../../src/tools/office-mcp/pptx-lib.ts";

const SERVER_ENTRY = fileURLToPath(new URL("../../../src/tools/office-mcp/main.ts", import.meta.url));

export type ToolResult = {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
};

/**
 * Starts the real server the gateway will start — a separate `node` process speaking MCP over stdio
 * — and talks to it with the SDK's own client. Testing the tools through the transport is the point:
 * a tool that works when called in-process but whose schema the SDK rejects, or whose result cannot
 * be serialised, is broken for every caller that matters.
 */
export async function startOfficeClient(): Promise<{ client: Client; stop: () => Promise<void> }> {
  // Node 22.18+/23.6+ strip TypeScript by default; older runtimes need the flag. `process.features
  // .typescript` reports what this runtime does, so the same test works on both.
  const flags = process.features.typescript === false ? ["--experimental-strip-types"] : [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...flags, "--no-warnings", SERVER_ENTRY],
    stderr: "ignore",
  });
  const client = new Client({ name: "office-mcp-tests", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    stop: async (): Promise<void> => {
      await client.close();
    },
  };
}

export async function makeWorkspace(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `pnp-office-${prefix}-`));
}

export function structured<T>(result: ToolResult): T {
  assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
  assert.ok(result.structuredContent !== undefined && result.structuredContent !== null,
    `expected structuredContent, got: ${resultText(result)}`);
  return result.structuredContent as T;
}

export function resultText(result: ToolResult): string {
  if (!Array.isArray(result.content)) return JSON.stringify(result);
  return result.content
    .map((block) => (typeof block === "object" && block !== null && "text" in block ? String((block as { text: unknown }).text) : ""))
    .join("\n");
}

export function expectError(result: ToolResult, fragment: string): string {
  assert.equal(result.isError, true, `expected an error result, got: ${resultText(result)}`);
  const text = resultText(result);
  assert.ok(text.includes(fragment), `expected error to mention ${JSON.stringify(fragment)}, got: ${text}`);
  return text;
}

export const DOCX_PARAGRAPH_ONE = "第一段：本季度收入同比增长 12%。First paragraph.";
export const DOCX_PARAGRAPH_TWO = "第二段：西安分公司完成整改。Second paragraph.";
export const DOCX_HEADING = "执行摘要 Executive Summary";

/** A .docx with a heading, two body paragraphs (the first one bold) and a 2x2 table. */
export async function writeFixtureDocx(file: string): Promise<void> {
  const document = new Document({
    sections: [{
      children: [
        new Paragraph({ text: DOCX_HEADING, heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun({ text: DOCX_PARAGRAPH_ONE, bold: true })] }),
        new Paragraph({ children: [new TextRun({ text: DOCX_PARAGRAPH_TWO })] }),
        new Table({
          rows: [
            new TableRow({ children: [cell("物料"), cell("数量")] }),
            new TableRow({ children: [cell("螺栓"), cell("120")] }),
          ],
        }),
      ],
    }],
  });
  await writeFile(file, await Packer.toBuffer(document));
}

function cell(text: string): TableCell {
  return new TableCell({ children: [new Paragraph(text)] });
}

function spanCell(text: string, span: { columnSpan?: number; rowSpan?: number }): TableCell {
  return new TableCell({
    children: [new Paragraph(text)],
    ...(span.columnSpan === undefined ? {} : { columnSpan: span.columnSpan }),
    ...(span.rowSpan === undefined ? {} : { rowSpan: span.rowSpan }),
  });
}

/** What the extraction must produce once `w:gridSpan` and `w:vMerge` are honoured. */
export const DOCX_MERGED_TABLE_ROWS = [
  ["库存汇总", "", "备注"],
  ["仓库", "物料", "数量"],
  ["西安", "螺栓", "120"],
  ["", "垫片", "45"],
];

/**
 * A .docx whose table has both merge kinds: a header cell spanning two grid columns (so the cell
 * after it starts at column 2, not column 1) and a warehouse cell merged down two rows (so the row
 * below carries no cell of its own at column 0). Reading the cells positionally shifts every value
 * of the header row one column left, which is what corrupts a table export.
 */
export async function writeMergedTableDocx(file: string): Promise<void> {
  const document = new Document({
    sections: [{
      children: [
        new Paragraph({ text: "库存表 Inventory", heading: HeadingLevel.HEADING_1 }),
        new Table({
          rows: [
            new TableRow({ children: [spanCell("库存汇总", { columnSpan: 2 }), cell("备注")] }),
            new TableRow({ children: [cell("仓库"), cell("物料"), cell("数量")] }),
            new TableRow({ children: [spanCell("西安", { rowSpan: 2 }), cell("螺栓"), cell("120")] }),
            new TableRow({ children: [cell("垫片"), cell("45")] }),
          ],
        }),
      ],
    }],
  });
  await writeFile(file, await Packer.toBuffer(document));
}

/**
 * Exactly what evaluation case office_011 produced. The model could not read the source .docx, fell
 * back to the engine's native `write`, passed the destination path as the file content, and reported
 * 已成功创建文件. The result is 44 bytes of text under a .docx name — not a zip, so not a document any
 * grader can open. Every check that only looks at the extension, the size or the exit status passes
 * it; only parsing the package catches it.
 */
export const FAKE_DOCX_TEXT = "D:\\test_data\\OpenClaw学术洞察报告.docx";

export async function writeFakeDocx(file: string): Promise<void> {
  await writeFile(file, FAKE_DOCX_TEXT, "utf8");
}

export const XLSX_SHEET_ONE = "库存管理台账";
export const XLSX_SHEET_TWO = "Summary";

export async function writeFixtureXlsx(file: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet(XLSX_SHEET_ONE);
  first.addRow(["物料", "数量", "仓库"]);
  first.addRow(["螺栓", 120, "西安"]);
  first.addRow(["垫片", 45, "北京"]);
  const second = workbook.addWorksheet(XLSX_SHEET_TWO);
  second.addRow(["metric", "value"]);
  second.addRow(["total", 165]);
  await workbook.xlsx.writeFile(file);
}

export const PPTX_TITLES = ["第一页 概述", "第二页 证据", "第三页 结论"];

export async function writeFixturePptx(file: string): Promise<void> {
  const deck = new PptxGen();
  PPTX_TITLES.forEach((title, index) => {
    const slide = deck.addSlide();
    slide.addText(title, { x: 0.5, y: 0.4, w: 8.5, h: 1, fontSize: 28, bold: true });
    slide.addText([`要点 ${index + 1}A`, `要点 ${index + 1}B`].join("\n"), { x: 0.6, y: 1.7, w: 8.4, h: 3 });
    // A second shape whose text shares a prefix with the title: an ambiguous match has to be an
    // error, and a fixture where every shape is unique could never show that.
    slide.addText(`第 ${index + 1} 页 页脚`, { x: 0.6, y: 4.8, w: 8.4, h: 0.4, fontSize: 12 });
    slide.addNotes(`备注 ${index + 1}`);
  });
  await deck.writeFile({ fileName: file });
}

export const PPTX_TABLE_ROWS = [
  ["平台", "月活"],
  ["A 平台", "6.8"],
  ["B 平台", "4.2"],
];
export const PPTX_CHART_SERIES = "月活用户";
export const PPTX_CHART_LABELS = ["2023", "2024"];
export const PPTX_CHART_VALUES = [8.2, 9.6];

/**
 * A deck whose numbers live where `p:sp` shapes cannot see them: one slide holds a table inside a
 * `p:graphicFrame`, the next holds a chart whose values only exist in its cached chart part.
 */
export async function writeFixturePptxWithData(file: string): Promise<void> {
  const deck = new PptxGen();
  const first = deck.addSlide();
  first.addText("行业概览", { x: 0.5, y: 0.3, w: 8.5, h: 0.8, fontSize: 24, bold: true });
  first.addTable(PPTX_TABLE_ROWS.map((row) => row.map((text) => ({ text }))), { x: 0.5, y: 1.4, w: 8 });
  const second = deck.addSlide();
  second.addText("用户规模", { x: 0.5, y: 0.3, w: 8.5, h: 0.8, fontSize: 24, bold: true });
  second.addChart(deck.ChartType.bar,
    [{ name: PPTX_CHART_SERIES, labels: [...PPTX_CHART_LABELS], values: [...PPTX_CHART_VALUES] }],
    { x: 0.5, y: 1.4, w: 6, h: 3 });
  await deck.writeFile({ fileName: file });
}

/**
 * A stock ledger with the three shapes that break naive arithmetic: an empty cell, a cell that says
 * 未统计 instead of a number, and a whole warehouse whose only quantity is unreadable. The numeric
 * formats a spreadsheet export really produces — a thousands separator, a currency sign, a percent
 * sign — are here too, so the parser is tested against them rather than against clean integers.
 */
export const AGGREGATE_CSV_TEXT = [
  "物料,仓库,当前库存,安全库存,单价,金额,占比",
  "螺栓,西安,120,80,1.5,\"1,200\",12%",
  "垫片,西安,45,60,0.8,¥800,8%",
  "轴承,北京,10,25,25,250,25%",
  "法兰,北京,未统计,30,3,N/A,—",
  "密封圈,西安,,15,2,30,3%",
  "角铁,上海,未统计,10,4,40,4%",
  "",
].join("\n");

export async function writeAggregateCsv(file: string): Promise<void> {
  await writeFile(file, AGGREGATE_CSV_TEXT, "utf8");
}

export const CSV_TEXT = [
  "物料名称,库存数量,单价",
  "螺栓,120,1.5",
  "垫片,45,0.8",
  "轴承,10,25",
  "",
].join("\n");

export async function writeFixtureCsv(file: string): Promise<void> {
  await writeFile(file, `﻿${CSV_TEXT}`, "utf8");
}
