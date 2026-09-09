import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AggregateResult } from "../../../src/tools/office-mcp/aggregate.ts";
import type { CsvReadResult } from "../../../src/tools/office-mcp/csv.ts";
import { docxExtract, type DocxExtraction } from "../../../src/tools/office-mcp/docx.ts";
import type { PptxExtraction } from "../../../src/tools/office-mcp/pptx.ts";
import type { DocVerifyResult } from "../../../src/tools/office-mcp/verify.ts";
import type { XlsxReadResult } from "../../../src/tools/office-mcp/xlsx.ts";
import { removeTree } from "../../kit/fs.ts";
import {
  DOCX_HEADING, DOCX_PARAGRAPH_ONE, DOCX_PARAGRAPH_TWO, XLSX_SHEET_ONE, makeWorkspace, resultText,
  startOfficeClient, structured, writeAggregateCsv, writeFakeDocx, writeFixtureCsv, writeFixtureDocx,
  writeFixturePptx, writeFixtureXlsx, type ToolResult,
} from "./harness.ts";

/**
 * Evaluation case office_011, verbatim: rewrite two paragraphs of a .docx and save the result as a
 * new .docx. Against OpenCode + GLM-4-Flash the model read the file correctly with docx_extract and
 * then never called docx_replace_paragraphs once — it tried the engine's native `edit` three times,
 * fell through to the native `write`, and declared success over one paragraph of plain text named
 * .docx. The extraction result it was reading named no write tool, so these tests assert on what a
 * read tool's own reply says, which is where the next call is decided.
 */

let session: Awaited<ReturnType<typeof startOfficeClient>> | null = null;
async function connect(): Promise<Client> {
  session ??= await startOfficeClient();
  return session.client;
}
after(async () => {
  if (session !== null) await session.stop();
});

/** What the model actually sees: the summary line and the JSON travel in one text block. */
function replyText(result: ToolResult): string {
  return resultText(result);
}

function assertMentions(text: string, needles: readonly string[], context: string): void {
  for (const needle of needles) {
    assert.ok(text.includes(needle), `${context} should name ${JSON.stringify(needle)}; reply was: ${text}`);
  }
}

/** The guidance is advice about the tool catalogue, so it must never end up inside the computed data. */
function assertGuidanceStaysOutOfData(result: ToolResult, tool: string): void {
  const data = JSON.stringify(result.structuredContent);
  assert.ok(!data.includes("下一步 / next: "), `${tool} must keep the guidance out of structuredContent: ${data}`);
}

test("docx_extract's own reply names docx_replace_paragraphs and outputPath — the write-back office_011 never found", async () => {
  const workspace = await makeWorkspace("guidance-docx");
  try {
    const source = path.join(workspace, "西安报告.docx");
    await writeFixtureDocx(source);
    const client = await connect();
    const result = await client.callTool({ name: "docx_extract", arguments: { path: source } }) as ToolResult;
    const text = replyText(result);
    // The two facts the failing run could not recover: which tool writes a .docx, and how "save as a
    // new file" is expressed once it has been found.
    assertMentions(text, ["docx_replace_paragraphs", "outputPath", "docx_create"], "docx_extract's reply");
    // The guidance has to reach a reader of either language, like every other message in this server.
    assert.match(text, /下一步 \/ next: /);
    assert.match(text, /save-as/);
  } finally {
    await removeTree(workspace);
  }
});

test("docx_extract's guidance is additive: the extraction data is exactly what docxExtract computes", async () => {
  const workspace = await makeWorkspace("guidance-docx-data");
  try {
    const source = path.join(workspace, "西安报告.docx");
    await writeFixtureDocx(source);
    const client = await connect();
    const result = await client.callTool({ name: "docx_extract", arguments: { path: source } }) as ToolResult;
    const extraction = structured<DocxExtraction>(result);
    // Round-tripped through JSON on both sides so an absent optional field is compared as absent,
    // which is what the transport does to it anyway.
    const computed: unknown = JSON.parse(JSON.stringify(await docxExtract(source)));
    assert.deepEqual(extraction as unknown, computed);
    assert.equal(extraction.paragraphCount, 3);
    assert.deepEqual(extraction.paragraphs.map((paragraph) => paragraph.text),
      [DOCX_HEADING, DOCX_PARAGRAPH_ONE, DOCX_PARAGRAPH_TWO]);
    assertGuidanceStaysOutOfData(result, "docx_extract");
  } finally {
    await removeTree(workspace);
  }
});

test("xlsx_read's reply names xlsx_write and the outputPath that writes a new workbook", async () => {
  const workspace = await makeWorkspace("guidance-xlsx");
  try {
    const source = path.join(workspace, "台账.xlsx");
    await writeFixtureXlsx(source);
    const client = await connect();
    const result = await client.callTool({ name: "xlsx_read", arguments: { path: source } }) as ToolResult;
    const text = replyText(result);
    assertMentions(text, ["xlsx_write", "outputPath"], "xlsx_read's reply");
    const read = structured<XlsxReadResult>(result);
    assert.equal(read.sheet, XLSX_SHEET_ONE);
    assert.deepEqual(read.rows[0], ["物料", "数量", "仓库"]);
    assertGuidanceStaysOutOfData(result, "xlsx_read");
  } finally {
    await removeTree(workspace);
  }
});

test("pptx_extract's reply names every deck-writing tool and the outputPath that saves as a new deck", async () => {
  const workspace = await makeWorkspace("guidance-pptx");
  try {
    const source = path.join(workspace, "汇报.pptx");
    await writeFixturePptx(source);
    const client = await connect();
    const result = await client.callTool({ name: "pptx_extract", arguments: { path: source } }) as ToolResult;
    const text = replyText(result);
    assertMentions(text,
      ["pptx_replace_text", "pptx_reorder_slides", "pptx_delete_slides", "pptx_create", "outputPath"],
      "pptx_extract's reply");
    const extraction = structured<PptxExtraction>(result);
    assert.equal(extraction.slideCount, 3);
    assertGuidanceStaysOutOfData(result, "pptx_extract");
  } finally {
    await removeTree(workspace);
  }
});

test("csv_read's reply says a Markdown conclusion is written with the engine's own file tool", async () => {
  const workspace = await makeWorkspace("guidance-csv");
  try {
    const source = path.join(workspace, "库存.csv");
    await writeFixtureCsv(source);
    const client = await connect();
    const result = await client.callTool({ name: "csv_read", arguments: { path: source } }) as ToolResult;
    const text = replyText(result);
    // Pushing the model off its native write tool for a .md would trade one wrong turn for another:
    // the native tool is the correct one for plain text, and only the Office formats are not.
    assertMentions(text, [".md", "xlsx_write", "docx_create", "doc_verify"], "csv_read's reply");
    assert.match(text, /engine's own file-writing tool/);
    const read = structured<CsvReadResult>(result);
    assert.equal(read.rowCount, 3);
    assert.deepEqual(read.headers, ["物料名称", "库存数量", "单价"]);
    assertGuidanceStaysOutOfData(result, "csv_read");
  } finally {
    await removeTree(workspace);
  }
});

test("data_aggregate keeps its own hints and its data while adding the write guidance", async () => {
  const workspace = await makeWorkspace("guidance-aggregate");
  try {
    const source = path.join(workspace, "库存台账.csv");
    await writeAggregateCsv(source);
    const client = await connect();
    // No groupBy: the office_014 shape, so the existing hint has to survive alongside the new line.
    const result = await client.callTool({
      name: "data_aggregate",
      arguments: { path: source, aggregations: [{ op: "sum", column: "当前库存" }] },
    }) as ToolResult;
    const text = replyText(result);
    assert.match(text, /groupBy/, "the existing ungrouped hint must survive");
    assertMentions(text, [".md", "xlsx_write", "docx_create"], "data_aggregate's reply");
    const aggregate = structured<AggregateResult>(result);
    assert.equal(aggregate.groupCount, 1);
    assert.equal(aggregate.rowCount, 6);
    assert.ok(aggregate.hints.length > 0, "data_aggregate's own hints stay in the data");
    assertGuidanceStaysOutOfData(result, "data_aggregate");
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify's verdict on text saved under a .docx name names the tools that write a real document", async () => {
  const workspace = await makeWorkspace("guidance-verify");
  try {
    // Byte for byte the artefact office_011 produced: a path string written by the native `write`.
    const artefact = path.join(workspace, "润色版.docx");
    await writeFakeDocx(artefact);
    const client = await connect();
    const result = await client.callTool({ name: "doc_verify", arguments: { path: artefact } }) as ToolResult;
    const verdict = structured<DocVerifyResult>(result);
    assert.equal(verdict.ok, false);
    const format = verdict.failures.find((failure) => failure.check === "format");
    assert.ok(format !== undefined, `expected a format failure, got ${JSON.stringify(verdict.failures)}`);
    // The verdict already said "not a valid Office document"; what it never said is what would have
    // produced one, which is the only thing that changes the next call.
    assertMentions(format.actual, ["docx_create", "docx_replace_paragraphs", "outputPath"],
      "doc_verify's format failure");
    assert.match(format.actual, /not a valid Office document/);
    assert.match(format.actual, /a generic file-writing tool cannot produce \.docx files/);
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify names the workbook writer for an .xlsx that is not a package", async () => {
  const workspace = await makeWorkspace("guidance-verify-xlsx");
  try {
    const artefact = path.join(workspace, "汇总.xlsx");
    await writeFakeDocx(artefact);
    const client = await connect();
    const verdict = structured<DocVerifyResult>(
      await client.callTool({ name: "doc_verify", arguments: { path: artefact } }) as ToolResult);
    const format = verdict.failures.find((failure) => failure.check === "format");
    assert.ok(format !== undefined, `expected a format failure, got ${JSON.stringify(verdict.failures)}`);
    assertMentions(format.actual, ["xlsx_write", "outputPath"], "doc_verify's format failure");
  } finally {
    await removeTree(workspace);
  }
});

test("a Markdown report keeps a verdict free of Office-tool advice that would not apply to it", async () => {
  const workspace = await makeWorkspace("guidance-verify-md");
  try {
    const artefact = path.join(workspace, "分析.md");
    await writeFixtureCsv(artefact);
    const client = await connect();
    const verdict = structured<DocVerifyResult>(await client.callTool({
      name: "doc_verify",
      arguments: { path: artefact, mustContain: ["不存在的结论"] },
    }) as ToolResult);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.failures.some((failure) => failure.check === "format"), false,
      "a text file under a .md name is a valid artefact and must not be told to use an Office writer");
    assert.equal(JSON.stringify(verdict).includes("docx_create"), false);
  } finally {
    await removeTree(workspace);
  }
});
