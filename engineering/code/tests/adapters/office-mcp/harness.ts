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
    slide.addNotes(`备注 ${index + 1}`);
  });
  await deck.writeFile({ fileName: file });
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
