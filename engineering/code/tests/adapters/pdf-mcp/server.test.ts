import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  PYTHON_SKIP_REASON, expectError, makeWorkspace, startPdfClient, structured, writeFixture,
  type Session, type ToolResult,
} from "./harness.ts";

/**
 * The Python PDF MCP server, exercised across the real stdio boundary with the MCP SDK's client.
 *
 * Every test here skips — never fails — when the host has no usable interpreter, and the skip
 * message names what was missing. That is the whole point of the server being optional: a machine
 * without Python must keep a green suite and working Node office tools.
 */

const skip = PYTHON_SKIP_REASON;

let session: Session | null = null;
async function connect(): Promise<Client> {
  session ??= await startPdfClient();
  return session.client;
}
after(async () => {
  if (session !== null) await session.stop();
});

let workspace: string | null = null;
let reportPdf: string | null = null;
async function report(): Promise<string> {
  if (reportPdf === null) {
    // A Chinese directory component, because that is what the evaluation tasks hand the model.
    workspace ??= path.join(await makeWorkspace("adapter"), "评测-库存");
    await mkdir(workspace, { recursive: true });
    reportPdf = writeFixture("report", path.join(workspace, "西安分公司报告.pdf"));
  }
  return reportPdf;
}

const EXPECTED_TOOLS = ["pdf_extract", "pdf_extract_tables", "pdf_info", "server_info"];

type ServerInfo = {
  name: string;
  version: string;
  implementation: string;
  pythonVersion: string;
  pythonFloor: string;
  dependencies: { name: string; version: string; vendored: boolean; pure_python: boolean }[];
  tools: { name: string; title: string; sideEffect: string; description: string }[];
};

test("a Python MCP server is reachable over the same stdio boundary the Node servers use", { skip }, async () => {
  const client = await connect();
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort());
  for (const tool of listed.tools) {
    assert.ok((tool.description ?? "").length > 0, `${tool.name} has no description`);
    assert.match(tool.description ?? "", /[一-鿿]/, `${tool.name} has no Chinese description`);
    assert.match(tool.description ?? "", /[A-Za-z]{4,}/, `${tool.name} has no English description`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} has no object input schema`);
    assert.ok(tool.annotations?.title !== undefined, `${tool.name} has no annotations`);
    // The whole server is declared sideEffect:read in config/settings.json; every tool must agree.
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} is not marked read-only`);
  }
});

test("server_info reports the interpreter and proves the vendored dependency is the one in use", { skip }, async () => {
  const client = await connect();
  const info = structured<ServerInfo>(await client.callTool({ name: "server_info", arguments: {} }));
  assert.equal(info.name, "pdf");
  assert.equal(info.implementation, "python");
  assert.match(info.version, /^\d+\.\d+\.\d+$/);
  assert.match(info.pythonVersion, /^3\.\d+\.\d+$/);
  assert.equal(info.pythonFloor, "3.9");
  const pypdf = info.dependencies.find((entry) => entry.name === "pypdf");
  assert.ok(pypdf !== undefined, "pypdf must be reported as a dependency");
  assert.equal(pypdf.vendored, true, "the delivery's own copy must win over anything installed");
  assert.equal(pypdf.pure_python, true);
  assert.deepEqual(info.tools.map((tool) => tool.name).sort(), [...EXPECTED_TOOLS].sort());
  assert.ok(info.tools.every((tool) => tool.sideEffect === "read"));
});

type PdfInfo = {
  pageCount: number;
  pdfVersion: string;
  encrypted: boolean;
  hasTextLayer: boolean;
  textLayerCertain: boolean;
  metadata: Record<string, string>;
  pageSizes: { page: number; widthMm: number; orientation: string }[];
  pageKinds: Record<string, number>;
};

test("pdf_info answers page count, sizes, metadata and the text layer over stdio", { skip }, async () => {
  const client = await connect();
  const info = structured<PdfInfo>(await client.callTool({ name: "pdf_info", arguments: { path: await report() } }));
  assert.equal(info.pageCount, 4);
  assert.equal(info.pdfVersion, "1.7");
  assert.equal(info.encrypted, false);
  assert.equal(info.hasTextLayer, true);
  assert.equal(info.textLayerCertain, true);
  assert.equal(info.metadata.title, "库存报告 Inventory");
  assert.equal(info.pageSizes[0]?.orientation, "portrait");
  assert.equal(Math.round(info.pageSizes[0]?.widthMm ?? 0), 210);
  assert.deepEqual(info.pageKinds, { "text": 2, "image-only": 1, "no-content": 1 });
});

type Extraction = {
  pageCount: number;
  pages: { page: number; kind: string; hasText: boolean; text?: string; imageCount: number }[];
  pagesWithoutText: number[];
  imageOnlyPages: number[];
  notes: string[];
};

test("pdf_extract returns text per page and names a scanned page instead of implying it is blank", { skip }, async () => {
  const client = await connect();
  const result = structured<Extraction>(
    await client.callTool({ name: "pdf_extract", arguments: { path: await report() } }));
  assert.equal(result.pageCount, 4);
  assert.match(result.pages[0]?.text ?? "", /Quarterly Inventory Report/);
  assert.equal(result.pages[2]?.kind, "image-only");
  assert.equal(result.pages[2]?.hasText, false);
  assert.ok((result.pages[2]?.imageCount ?? 0) >= 1);
  assert.equal(result.pages[3]?.kind, "no-content");
  assert.deepEqual(result.pagesWithoutText, [3, 4]);
  assert.deepEqual(result.imageOnlyPages, [3]);
  assert.ok(result.notes.some((note) => note.includes("OCR")), `notes should mention OCR: ${result.notes.join(" | ")}`);
});

test("pdf_extract honours a page range and refuses one past the end", { skip }, async () => {
  const client = await connect();
  const file = await report();
  const ranged = structured<Extraction>(
    await client.callTool({ name: "pdf_extract", arguments: { path: file, firstPage: 2, lastPage: 3 } }));
  assert.deepEqual(ranged.pages.map((page) => page.page), [2, 3]);
  expectError(await client.callTool({ name: "pdf_extract", arguments: { path: file, firstPage: 9 } }) as ToolResult,
    "INDEX_OUT_OF_RANGE");
});

type TableExtraction = {
  tableCount: number;
  tablesByConfidence: Record<string, number>;
  tables: { page: number; columns: number; rows: string[][]; confidence: string; signals: string[] }[];
  caveat: string;
  method: string;
};

test("pdf_extract_tables recovers a whitespace-aligned table and states its confidence", { skip }, async () => {
  const client = await connect();
  const result = structured<TableExtraction>(
    await client.callTool({ name: "pdf_extract_tables", arguments: { path: await report() } }));
  assert.equal(result.tableCount, 1);
  const table = result.tables[0];
  assert.equal(table?.page, 2);
  assert.equal(table?.columns, 4);
  assert.deepEqual(table?.rows[0], ["Item", "Qty", "Unit", "Total"]);
  assert.deepEqual(table?.rows[1], ["Bolt M8", "120", "0.35", "42.00"]);
  assert.equal(table?.confidence, "high");
  assert.match(result.method, /layout/);
  assert.match(result.caveat, /ruling lines/i);
});

test("pdf_extract_tables does not invent a table out of prose", { skip }, async () => {
  const client = await connect();
  const prose = writeFixture("prose", path.join(path.dirname(await report()), "正文.pdf"));
  const result = structured<TableExtraction>(
    await client.callTool({ name: "pdf_extract_tables", arguments: { path: prose } }));
  assert.equal(result.tableCount, 0);
});

test("a relative path, an unknown tool and a malformed argument are refused, not guessed at", { skip }, async () => {
  const client = await connect();
  expectError(await client.callTool({ name: "pdf_extract", arguments: { path: "report.pdf" } }) as ToolResult,
    "PATH_NOT_ABSOLUTE");
  expectError(await client.callTool({ name: "pdf_delete_everything", arguments: {} }) as ToolResult,
    "pdf_delete_everything");
  expectError(await client.callTool({ name: "pdf_info", arguments: { path: 42 } }) as ToolResult, "path");
});
