import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import JSZip from "jszip";
import { countCjkChars, type DocVerifyResult } from "../../../src/tools/office-mcp/verify.ts";
import { removeTree } from "../../kit/fs.ts";
import {
  DOCX_HEADING, DOCX_PARAGRAPH_ONE, expectError, FAKE_DOCX_TEXT, makeWorkspace, PPTX_TITLES, startOfficeClient,
  structured, writeFakeDocx, writeFixtureDocx, writeFixturePptx, writeFixtureXlsx, XLSX_SHEET_ONE, XLSX_SHEET_TWO,
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

async function verify(args: Record<string, unknown>): Promise<DocVerifyResult> {
  const client = await connect();
  return structured<DocVerifyResult>(await client.callTool({ name: "doc_verify", arguments: args }));
}

function failure(result: DocVerifyResult, check: string): { check: string; expected: string; actual: string } {
  const found = result.failures.find((entry) => entry.check === check);
  assert.ok(found !== undefined, `expected a ${check} failure, got ${JSON.stringify(result.failures)}`);
  return found;
}

function checkNames(result: DocVerifyResult): string[] {
  return result.failures.map((entry) => entry.check);
}

test("doc_verify reports a text file saved under a .docx name as not a valid Office document", async () => {
  const workspace = await makeWorkspace("verify-fake-docx");
  try {
    // The office_011 regression: before this tool existed, nothing between the model and the grader
    // opened this file, so "已成功创建文件" was the last word on it.
    const target = path.join(workspace, "OpenClaw学术洞察报告.docx");
    await writeFakeDocx(target);

    const result = await verify({ path: target, mustContain: ["学术洞察"], minTables: 1 });
    assert.equal(result.ok, false, "a path string saved as a .docx must never verify");
    assert.equal(result.kind, "text", "the detected kind must describe the bytes, not the extension");
    assert.equal(result.extension, ".docx");
    assert.equal(result.kindMatchesExtension, false);
    assert.equal(result.formatValid, false);
    const format = failure(result, "format");
    assert.match(format.actual, /not a valid Office document/);
    assert.match(format.actual, /不是有效的 Office 文档/);
    // The content expectations could not be evaluated at all; reporting them as passed would be the
    // false confidence this tool exists to remove.
    assert.deepEqual([...result.skipped].sort(), ["minTables", "mustContain"]);
    assert.ok(!checkNames(result).includes("mustContain"), "an unparseable file must not answer content checks");
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify fails minBytes on the 44-byte file the failing run produced", async () => {
  const workspace = await makeWorkspace("verify-min-bytes");
  try {
    const target = path.join(workspace, "报告.docx");
    await writeFakeDocx(target);

    const result = await verify({ path: target, minBytes: 5000 });
    assert.equal(result.bytes, 44, `the office_011 artefact is 44 bytes, got ${result.bytes}`);
    assert.equal(result.ok, false);
    const size = failure(result, "minBytes");
    assert.match(size.expected, /5000/);
    assert.match(size.actual, /44/);
    assert.ok(result.checked.includes("minBytes"), "minBytes is answerable without parsing the package");
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify passes a real .docx and reports its tables, and fails a table count it does not have", async () => {
  const workspace = await makeWorkspace("verify-docx");
  try {
    const target = path.join(workspace, "报告.docx");
    await writeFixtureDocx(target);

    const passing = await verify({
      path: target,
      minBytes: 1000,
      mustContain: [DOCX_HEADING, DOCX_PARAGRAPH_ONE, "螺栓", "120"],
      mustNotContain: [FAKE_DOCX_TEXT],
      minTables: 1,
      minCjkChars: 10,
    });
    assert.deepEqual(passing.failures, [], "a genuine document with met expectations must pass");
    assert.equal(passing.ok, true);
    assert.equal(passing.kind, "docx");
    assert.equal(passing.kindMatchesExtension, true);
    assert.equal(passing.formatValid, true);
    assert.equal(passing.tableCount, 1);
    assert.ok((passing.paragraphCount ?? 0) >= 3);
    assert.deepEqual(passing.skipped, []);

    const failing = await verify({
      path: target,
      minTables: 3,
      mustContain: ["从未写入的结论"],
      mustNotContain: [DOCX_HEADING],
      minCjkChars: 500,
    });
    assert.equal(failing.ok, false);
    assert.deepEqual(checkNames(failing).sort(), ["minCjkChars", "minTables", "mustContain", "mustNotContain"]);
    assert.match(failure(failing, "minTables").actual, /1/);
    assert.match(failure(failing, "mustContain").expected, /从未写入的结论/);
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify checks sheet count and sheet names of a real workbook", async () => {
  const workspace = await makeWorkspace("verify-xlsx");
  try {
    const target = path.join(workspace, "台账.xlsx");
    await writeFixtureXlsx(target);

    const passing = await verify({
      path: target,
      minSheets: 2,
      sheetNames: [XLSX_SHEET_ONE, XLSX_SHEET_TWO],
      mustContain: ["螺栓", "165"],
    });
    assert.deepEqual(passing.failures, []);
    assert.equal(passing.kind, "xlsx");
    assert.equal(passing.sheetCount, 2);
    assert.deepEqual(passing.sheetNames, [XLSX_SHEET_ONE, XLSX_SHEET_TWO]);

    const failing = await verify({ path: target, minSheets: 3, sheetNames: ["利润表"] });
    assert.equal(failing.ok, false);
    assert.deepEqual(checkNames(failing).sort(), ["minSheets", "sheetNames"]);
    assert.match(failure(failing, "minSheets").actual, /2/);
    assert.match(failure(failing, "sheetNames").actual, new RegExp(XLSX_SHEET_ONE));
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify checks the slide count of a real deck in both directions", async () => {
  const workspace = await makeWorkspace("verify-pptx");
  try {
    const target = path.join(workspace, "汇报.pptx");
    await writeFixturePptx(target);

    const passing = await verify({
      path: target,
      minSlides: 3,
      maxSlides: 3,
      mustContain: [PPTX_TITLES[0] as string, "备注 1"],
    });
    assert.deepEqual(passing.failures, []);
    assert.equal(passing.kind, "pptx");
    assert.equal(passing.slideCount, 3);

    const tooFew = await verify({ path: target, minSlides: 8 });
    assert.equal(tooFew.ok, false);
    assert.match(failure(tooFew, "minSlides").actual, /3/);

    const tooMany = await verify({ path: target, maxSlides: 2 });
    assert.equal(tooMany.ok, false);
    assert.match(failure(tooMany, "maxSlides").actual, /3/);
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify refuses to answer a slide count for a document that has no slides", async () => {
  const workspace = await makeWorkspace("verify-not-applicable");
  try {
    const target = path.join(workspace, "报告.docx");
    await writeFixtureDocx(target);

    // Asking a .docx for slides means the caller verified something other than what it produced.
    // Answering "ok" there would hand back exactly the false confidence this tool must not give.
    const result = await verify({ path: target, minSlides: 5, minSheets: 2 });
    assert.equal(result.ok, false);
    assert.deepEqual(checkNames(result).sort(), ["minSheets", "minSlides"]);
    assert.match(failure(result, "minSlides").actual, /does not apply to a docx document/);
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify names the real format when a workbook is saved under a .docx name", async () => {
  const workspace = await makeWorkspace("verify-wrong-kind");
  try {
    const target = path.join(workspace, "台账.docx");
    await writeFixtureXlsx(target);

    const result = await verify({ path: target });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "xlsx", "a real .xlsx must be detected as one whatever the file is called");
    assert.equal(result.kindMatchesExtension, false);
    assert.match(failure(result, "format").actual, /not a valid Office document/);
    assert.match(failure(result, "format").actual, /xlsx/);
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify fails a truncated package instead of trusting its zip header", async () => {
  const workspace = await makeWorkspace("verify-truncated");
  try {
    const source = path.join(workspace, "完整.docx");
    await writeFixtureDocx(source);
    // Half a .docx still starts with the zip signature; what it no longer has is the end-of-central-
    // directory record, which is exactly what the evaluation grader reported when it tried to open
    // the failing artefact. Sniffing the first bytes alone would call this a package.
    const whole = await readFile(source);
    const target = path.join(workspace, "截断.docx");
    await writeFile(target, whole.subarray(0, Math.floor(whole.byteLength / 2)));

    const result = await verify({ path: target, mustContain: [DOCX_HEADING] });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "binary");
    assert.match(failure(result, "format").actual, /not a valid Office document/);
    assert.ok(result.formatProblem !== undefined, "the reader's own reason must survive into the result");
    assert.deepEqual(result.skipped, ["mustContain"]);
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify fails a package whose main part will not parse", async () => {
  const workspace = await makeWorkspace("verify-corrupt-part");
  try {
    const source = path.join(workspace, "完整.docx");
    await writeFixtureDocx(source);
    const target = path.join(workspace, "损坏.docx");
    // A zip that still has word/document.xml, so it is detected as a .docx, but whose main part is
    // not a document: the verdict has to come from parsing the part, not from finding its name.
    const zip = await JSZip.loadAsync(await readFile(source));
    zip.file("word/document.xml", "<not-a-document/>");
    await writeFile(target, await zip.generateAsync({ type: "nodebuffer" }));

    const result = await verify({ path: target, mustContain: [DOCX_HEADING] });
    assert.equal(result.ok, false);
    assert.equal(result.kind, "docx", "the package still looks like a .docx; the content is what fails");
    assert.match(failure(result, "format").actual, /not a valid Office document/);
    assert.deepEqual(result.skipped, ["mustContain"]);
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify fails an empty file on non-emptiness and on format", async () => {
  const workspace = await makeWorkspace("verify-empty");
  try {
    const target = path.join(workspace, "空.docx");
    await writeFile(target, "");

    const result = await verify({ path: target });
    assert.equal(result.ok, false);
    assert.equal(result.bytes, 0);
    assert.equal(result.kind, "empty");
    assert.deepEqual(checkNames(result).sort(), ["format", "notEmpty"]);
  } finally {
    await removeTree(workspace);
  }
});

/** The grader's range is U+3400-U+9FFF; the boundary characters prove both ends are inclusive. */
const CJK_LOW_BOUND = String.fromCodePoint(0x3400);
const CJK_HIGH_BOUND = String.fromCodePoint(0x9fff);
const BELOW_RANGE = String.fromCodePoint(0x33ff);
const ABOVE_RANGE = String.fromCodePoint(0xa000);
const HIRAGANA = String.fromCodePoint(0x3041);

const MARKDOWN_BODY = `# 报告${CJK_LOW_BOUND}${CJK_HIGH_BOUND}\n\n`
  + `${"中".repeat(300)}\n\n`
  + `${BELOW_RANGE}${ABOVE_RANGE}${HIRAGANA}，。ABC 123 12%\n`;
/** 报告 (2) + the two boundary characters + 300 repeats; nothing outside the range counts. */
const MARKDOWN_CJK_COUNT = 304;

test("doc_verify counts exactly the grader's CJK range in a Markdown report", async () => {
  const workspace = await makeWorkspace("verify-markdown");
  try {
    const target = path.join(workspace, "违约风险分析.md");
    await writeFile(target, MARKDOWN_BODY, "utf8");

    assert.equal(countCjkChars(MARKDOWN_BODY), MARKDOWN_CJK_COUNT,
      "the counter must ignore kana, full-width punctuation and latin digits");

    const short = await verify({ path: target, minCjkChars: 500, mustContain: ["报告"] });
    assert.equal(short.ok, false, "office_015 wrote 301 characters against a required 500-800");
    assert.equal(short.kind, "text");
    assert.equal(short.cjkChars, MARKDOWN_CJK_COUNT);
    assert.deepEqual(checkNames(short), ["minCjkChars"]);
    assert.match(failure(short, "minCjkChars").actual, new RegExp(String(MARKDOWN_CJK_COUNT)));

    const long = await verify({ path: target, maxCjkChars: 200 });
    assert.equal(long.ok, false);
    assert.match(failure(long, "maxCjkChars").expected, /200/);

    const passing = await verify({
      path: target, minBytes: 100, minCjkChars: 300, maxCjkChars: 800, mustContain: ["报告", "ABC"],
    });
    assert.deepEqual(passing.failures, []);
    assert.equal(passing.ok, true);
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify errors on a missing file and on an extension it cannot parse", async () => {
  const workspace = await makeWorkspace("verify-errors");
  try {
    const client = await connect();
    const missing = path.join(workspace, "从未写出.docx");
    expectError(await client.callTool({ name: "doc_verify", arguments: { path: missing } }) as ToolResult,
      "PATH_NOT_FOUND");

    const relative = await client.callTool({ name: "doc_verify", arguments: { path: "报告.docx" } });
    expectError(relative as ToolResult, "PATH_NOT_ABSOLUTE");

    const pdf = path.join(workspace, "报告.pdf");
    await writeFile(pdf, "%PDF-1.7\n", "utf8");
    const unsupported = expectError(
      await client.callTool({ name: "doc_verify", arguments: { path: pdf } }) as ToolResult, "UNSUPPORTED_FORMAT");
    assert.match(unsupported, /\.docx/, "the error must name the extensions that are supported");

    const legacy = path.join(workspace, "旧版.doc");
    await writeFile(legacy, "old binary", "utf8");
    const legacyError = expectError(
      await client.callTool({ name: "doc_verify", arguments: { path: legacy } }) as ToolResult, "UNSUPPORTED_FORMAT");
    assert.match(legacyError, /\.doc/);
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify passes what this server's own write tools produce", async () => {
  const workspace = await makeWorkspace("verify-roundtrip");
  try {
    const client = await connect();
    // The loop the instructions now ask the model to run: write the artefact, then verify it. A
    // verifier that rejected our own writers would be worse than none — it would teach the model to
    // ignore the verdict.
    const document = path.join(workspace, "洞察报告.docx");
    structured<unknown>(await client.callTool({
      name: "docx_create",
      arguments: {
        outputPath: document,
        blocks: [
          { type: "heading", level: 1, text: "学术洞察报告" },
          { type: "paragraph", text: "本报告基于原始数据重写，未引用任何未经核实的数字。" },
          { type: "table", rows: [["指标", "数值"], ["样本量", "200"]] },
        ],
      },
    }));
    const verifiedDocument = await verify({
      path: document, minBytes: 1000, mustContain: ["学术洞察报告", "样本量"], minTables: 1, minCjkChars: 20,
    });
    assert.deepEqual(verifiedDocument.failures, []);
    assert.equal(verifiedDocument.kind, "docx");

    const workbook = path.join(workspace, "表格导出.xlsx");
    structured<unknown>(await client.callTool({
      name: "xlsx_write",
      arguments: {
        outputPath: workbook,
        sheets: [
          { name: "第一表", rows: [["物料", "数量"], ["螺栓", 120]] },
          { name: "第二表", rows: [["物料", "数量"], ["垫片", 45]] },
        ],
      },
    }));
    const verifiedWorkbook = await verify({
      path: workbook, minSheets: 2, sheetNames: ["第一表", "第二表"], mustContain: ["螺栓", "45"],
    });
    assert.deepEqual(verifiedWorkbook.failures, []);

    const deck = path.join(workspace, "汇报.pptx");
    structured<unknown>(await client.callTool({
      name: "pptx_create",
      arguments: {
        outputPath: deck,
        slides: [
          { title: "第一页", bullets: ["要点一", "要点二"] },
          { title: "第二页", bullets: ["要点三"], notes: "备注" },
        ],
      },
    }));
    const verifiedDeck = await verify({ path: deck, minSlides: 2, maxSlides: 2, mustContain: ["第一页", "要点三"] });
    assert.deepEqual(verifiedDeck.failures, []);
  } finally {
    await removeTree(workspace);
  }
});

test("doc_verify summarises the verdict in text so an engine that shows only text can act on it", async () => {
  const workspace = await makeWorkspace("verify-summary");
  try {
    const good = path.join(workspace, "报告.docx");
    await writeFixtureDocx(good);
    const bad = path.join(workspace, "假报告.docx");
    await writeFakeDocx(bad);
    const client = await connect();

    const passing = await client.callTool({ name: "doc_verify", arguments: { path: good, minTables: 1 } });
    const passingText = (passing as ToolResult).content;
    assert.ok(Array.isArray(passingText));
    assert.match(JSON.stringify(passingText), /PASS/);

    const failing = await client.callTool({ name: "doc_verify", arguments: { path: bad, minBytes: 5000 } });
    assert.equal((failing as ToolResult).isError, undefined,
      "a failed verification is a normal result the model must be able to read");
    const failingText = JSON.stringify((failing as ToolResult).content);
    assert.match(failingText, /FAIL/);
    assert.match(failingText, /format/);
    assert.match(failingText, /minBytes/);
  } finally {
    await removeTree(workspace);
  }
});
