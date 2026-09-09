import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { docxExtract } from "./docx.ts";
import { OfficeToolError } from "./errors.ts";
import { openPackage } from "./package-file.ts";
import { pptxExtract } from "./pptx.ts";
import { xlsxSummarize } from "./xlsx.ts";

/**
 * Why this exists: a model that cannot read a binary Office format declares success on a file it
 * never looked at. Three observed runs, one shape — an engine's native `read` answers
 * "Cannot read binary file", the model falls back to the native `write`, and the reply says 已完成:
 *
 *  - a .docx whose entire 44-byte content was the literal path string (not even a zip);
 *  - an .xlsx that was never created at all;
 *  - a Markdown analysis of a CSV that was never read, so every number in it was invented.
 *
 * None of that is visible in the protocol: the request is a clean 204 with finish=stop. Only reading
 * the artefact back catches it. So this tool re-opens the file the way a grader does — by parsing the
 * package, not by trusting the extension — and answers with a verdict the model can act on rather
 * than an exception, because "your file is broken, fix it" is information, not a tool failure.
 */

/** What the bytes actually are, decided by content. Reported next to the extension so a mismatch shows. */
export type DocKind = "docx" | "xlsx" | "pptx" | "zip" | "text" | "binary" | "empty";

/** One unmet expectation: which check, what it demanded, and what the file really holds. */
export type VerifyFailure = { check: string; expected: string; actual: string };

export type VerifyExpectations = {
  minBytes?: number;
  mustContain?: readonly string[];
  mustNotContain?: readonly string[];
  minTables?: number;
  minSlides?: number;
  maxSlides?: number;
  minSheets?: number;
  sheetNames?: readonly string[];
  minCjkChars?: number;
  maxCjkChars?: number;
};

export type DocVerifyResult = {
  path: string;
  ok: boolean;
  bytes: number;
  extension: string;
  kind: DocKind;
  kindMatchesExtension: boolean;
  formatValid: boolean;
  /** Why the format check failed, when it did; absent on a document that parsed. */
  formatProblem?: string;
  textLength: number;
  cjkChars: number;
  paragraphCount?: number;
  tableCount?: number;
  slideCount?: number;
  sheetCount?: number;
  sheetNames?: string[];
  /** Checks that were actually evaluated, and expectations that could not be (the file never parsed). */
  checked: string[];
  skipped: string[];
  failures: VerifyFailure[];
};

const OFFICE_EXTENSIONS = new Map<string, "docx" | "xlsx" | "pptx">([
  [".docx", "docx"],
  [".xlsx", "xlsx"],
  [".pptx", "pptx"],
]);

/** Plain-text artefacts: an analysis written as Markdown is checked for length and wording, nothing more. */
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".csv"]);

/** The pre-2007 binary formats are not zips and nothing here can open them; saying so beats a wrong verdict. */
const LEGACY_EXTENSIONS = new Set([".doc", ".xls", ".ppt"]);

/**
 * The character range the evaluation grader counts, verbatim: U+3400-U+9FFF, CJK Extension A plus
 * the unified ideographs. Anything wider (punctuation, kana, full-width latin) would report a number
 * the grader disagrees with, which is worse than not counting at all — office_015 produced 301
 * characters against a required 500-800 and the model had no way to notice before it finished. The
 * bounds are written as code points so both ends stay auditable against the grader's expression.
 */
const CJK_FIRST_CODE_POINT = 0x3400;
const CJK_LAST_CODE_POINT = 0x9fff;

export function countCjkChars(text: string): number {
  let count = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code !== undefined && code >= CJK_FIRST_CODE_POINT && code <= CJK_LAST_CODE_POINT) count += 1;
  }
  return count;
}

/**
 * Matching normalises only horizontal whitespace — `[^\S\n]` is every whitespace character except a
 * line break, so spaces, tabs, NBSP and the ideographic space collapse to one space on both sides of
 * the comparison and a phrase split by a soft layout difference still matches. Line breaks survive,
 * so a needle can never be satisfied by text that spans two unrelated paragraphs.
 */
function normalizeForMatch(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ");
}

const ZIP_SIGNATURES: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
];

const SNIFF_BYTES = 4096;

async function readHead(file: string, length: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function hasZipSignature(head: Buffer): boolean {
  return ZIP_SIGNATURES.some((signature) => signature.every((byte, index) => head[index] === byte));
}

/**
 * A NUL byte in the first block is the one cheap signal that separates a text artefact from a binary
 * one. It is deliberately generous: the case that matters is a path string or a Markdown report
 * saved under a .docx name, and that has no NUL anywhere.
 */
function looksLikeText(head: Buffer): boolean {
  return !head.includes(0);
}

const OOXML_MARKERS: readonly { kind: "docx" | "xlsx" | "pptx"; part: string }[] = [
  { kind: "docx", part: "word/document.xml" },
  { kind: "xlsx", part: "xl/workbook.xml" },
  { kind: "pptx", part: "ppt/presentation.xml" },
];

type Detection = { kind: DocKind; problem?: string };

/**
 * Decides what the file is from its bytes and its package parts — never from its name. A zip whose
 * `word/document.xml` is missing is not a .docx no matter what the extension says, and that is
 * exactly the confusion this tool exists to end.
 */
async function detectKind(file: string, bytes: number): Promise<Detection> {
  if (bytes === 0) return { kind: "empty" };
  const head = await readHead(file, SNIFF_BYTES);
  if (!hasZipSignature(head)) {
    return looksLikeText(head)
      ? { kind: "text" }
      : { kind: "binary", problem: "不是 zip/OOXML 包 / not a zip (OOXML) package" };
  }
  let pkg;
  try {
    pkg = await openPackage(file);
  } catch (error) {
    // The bytes start like a zip but the archive will not open — truncated or corrupt. Reporting the
    // reader's own message keeps the verdict specific instead of "something is wrong".
    return { kind: "binary", problem: error instanceof Error ? error.message : String(error) };
  }
  const marker = OOXML_MARKERS.find((candidate) => pkg.zip.file(candidate.part) !== null);
  if (marker === undefined) {
    return { kind: "zip", problem: "是 zip，但没有 Word/Excel/PowerPoint 主部件 / a zip without a Word, Excel or PowerPoint main part" };
  }
  return { kind: marker.kind };
}

type Content = {
  text: string;
  paragraphCount?: number;
  tableCount?: number;
  slideCount?: number;
  sheetCount?: number;
  sheetNames?: string[];
};

async function docxContent(file: string): Promise<Content> {
  const extraction = await docxExtract(file);
  const blocks: { bodyIndex: number; text: string }[] = [];
  for (const paragraph of extraction.paragraphs) blocks.push({ bodyIndex: paragraph.bodyIndex, text: paragraph.text });
  for (const table of extraction.tables) {
    blocks.push({ bodyIndex: table.bodyIndex, text: table.rows.map((row) => row.join("\t")).join("\n") });
  }
  blocks.sort((left, right) => left.bodyIndex - right.bodyIndex);
  return {
    text: blocks.map((block) => block.text).join("\n"),
    paragraphCount: extraction.paragraphCount,
    tableCount: extraction.tableCount,
  };
}

async function pptxContent(file: string): Promise<Content> {
  const extraction = await pptxExtract(file);
  const lines: string[] = [];
  for (const slide of extraction.slides) {
    for (const shape of slide.texts) lines.push(shape.text);
    for (const table of slide.tables ?? []) for (const row of table.rows) lines.push(row.join("\t"));
    for (const chart of slide.charts ?? []) {
      if (chart.title !== undefined) lines.push(chart.title);
      for (const series of chart.series) {
        if (series.name !== undefined) lines.push(series.name);
        lines.push(series.categories.join("\t"));
        lines.push(series.values.map((value) => String(value)).join("\t"));
      }
    }
    if (slide.notes !== undefined) lines.push(slide.notes);
  }
  return { text: lines.join("\n"), slideCount: extraction.slideCount, tableCount: extraction.tableCount };
}

async function xlsxContent(file: string): Promise<Content> {
  const sheets = await xlsxSummarize(file);
  const lines: string[] = [];
  for (const sheet of sheets) {
    lines.push(sheet.name);
    for (const row of sheet.rows) lines.push(row.map((cell) => (cell === null ? "" : String(cell))).join("\t"));
  }
  return {
    text: lines.join("\n"),
    sheetCount: sheets.length,
    sheetNames: sheets.map((sheet) => sheet.name),
  };
}

const BYTE_ORDER_MARK = 0xfeff;

async function textContent(file: string): Promise<Content> {
  const raw = await readFile(file, "utf8");
  // A UTF-8 BOM survives the decode as U+FEFF and would otherwise sit in front of the first heading,
  // where it defeats a `mustContain` on that heading.
  return { text: raw.charCodeAt(0) === BYTE_ORDER_MARK ? raw.slice(1) : raw };
}

function expectedKindFor(extension: string): DocKind {
  const office = OFFICE_EXTENSIONS.get(extension);
  return office === undefined ? "text" : office;
}

/** Rejects an argument this tool cannot answer for, rather than reporting a pass it did not verify. */
function requireSupportedExtension(file: string): string {
  const extension = path.extname(file).toLowerCase();
  if (OFFICE_EXTENSIONS.has(extension) || TEXT_EXTENSIONS.has(extension)) return extension;
  if (LEGACY_EXTENSIONS.has(extension)) {
    throw new OfficeToolError("UNSUPPORTED_FORMAT",
      `不支持旧版二进制格式 ${extension}，请改用 .docx/.xlsx/.pptx /`
      + ` the pre-2007 binary format ${extension} cannot be verified; use .docx, .xlsx or .pptx: ${file}`);
  }
  throw new OfficeToolError("UNSUPPORTED_FORMAT",
    `doc_verify 不支持的扩展名 ${extension === "" ? "（无扩展名 / none）" : extension}；支持 /`
    + ` supported extensions are .docx, .xlsx, .pptx, .md, .markdown, .txt, .csv: ${file}`);
}

/**
 * The expectations that need the document's content. When the file will not parse they are reported
 * as skipped rather than quietly dropped: "I could not check this" and "this passed" must never look
 * the same to a caller deciding whether it is finished.
 */
function requestedContentChecks(expectations: VerifyExpectations): string[] {
  const requested: string[] = [];
  if (expectations.mustContain !== undefined && expectations.mustContain.length > 0) requested.push("mustContain");
  if (expectations.mustNotContain !== undefined && expectations.mustNotContain.length > 0) requested.push("mustNotContain");
  if (expectations.minTables !== undefined) requested.push("minTables");
  if (expectations.minSlides !== undefined) requested.push("minSlides");
  if (expectations.maxSlides !== undefined) requested.push("maxSlides");
  if (expectations.minSheets !== undefined) requested.push("minSheets");
  if (expectations.sheetNames !== undefined && expectations.sheetNames.length > 0) requested.push("sheetNames");
  if (expectations.minCjkChars !== undefined) requested.push("minCjkChars");
  if (expectations.maxCjkChars !== undefined) requested.push("maxCjkChars");
  return requested;
}

/**
 * An expectation that does not apply to what the file turned out to be (minSlides on a .docx,
 * minSheets on a report) is a failure, never a silent pass: it means the caller verified something
 * other than the artefact it produced, which is the whole failure mode this tool guards against.
 */
function notApplicable(check: string, expected: string, kind: DocKind): VerifyFailure {
  return {
    check,
    expected,
    actual: `该检查不适用于 ${kind} 文档 / this check does not apply to a ${kind} document`,
  };
}

export async function docVerify(file: string, expectations: VerifyExpectations): Promise<DocVerifyResult> {
  const extension = requireSupportedExtension(file);
  const info = await stat(file);
  const bytes = info.size;
  const detection = await detectKind(file, bytes);
  const expectedKind = expectedKindFor(extension);
  const kindMatchesExtension = detection.kind === expectedKind;
  const failures: VerifyFailure[] = [];
  const checked: string[] = ["exists", "notEmpty", "format"];
  const skipped: string[] = [];

  if (bytes === 0) {
    failures.push({ check: "notEmpty", expected: "非空文件 / a non-empty file", actual: "0 字节 / 0 bytes" });
  }
  if (expectations.minBytes !== undefined) {
    checked.push("minBytes");
    if (bytes < expectations.minBytes) {
      failures.push({
        check: "minBytes",
        expected: `至少 ${expectations.minBytes} 字节 / at least ${expectations.minBytes} bytes`,
        actual: `${bytes} 字节 / bytes`,
      });
    }
  }

  const formatValid = kindMatchesExtension;
  if (!formatValid) {
    const problem = detection.problem ?? `实际内容是 ${detection.kind} / the content is a ${detection.kind}`;
    failures.push({
      check: "format",
      expected: expectedKind === "text"
        ? `${extension} 文本文件 / a ${extension} text file`
        : `可解析的 ${extension} OOXML 包 / a readable ${extension} OOXML package`,
      actual: OFFICE_EXTENSIONS.has(extension)
        ? `不是有效的 Office 文档 / not a valid Office document: ${problem}（检测到 / detected: ${detection.kind}）`
        : `${problem}（检测到 / detected: ${detection.kind}）`,
    });
  }

  let content: Content = { text: "" };
  let readProblem: string | null = null;
  if (formatValid) {
    try {
      if (detection.kind === "docx") content = await docxContent(file);
      else if (detection.kind === "pptx") content = await pptxContent(file);
      else if (detection.kind === "xlsx") content = await xlsxContent(file);
      else content = await textContent(file);
    } catch (error) {
      // The package opened but its parts do not read: still a verdict, not a tool failure — the
      // caller has to know the artefact is unusable, and an exception here would hide that as
      // "the tool broke" instead of "the file is broken".
      readProblem = error instanceof Error ? error.message : String(error);
    }
  }
  if (readProblem !== null) {
    failures.push({
      check: "format",
      expected: `可解析的 ${extension} 内容 / readable ${extension} content`,
      actual: `不是有效的 Office 文档 / not a valid Office document: ${readProblem}`,
    });
  }

  const readable = formatValid && readProblem === null;
  const normalizedText = normalizeForMatch(content.text);
  const cjkChars = countCjkChars(content.text);

  if (!readable) {
    for (const name of requestedContentChecks(expectations)) skipped.push(name);
  } else {
    for (const needle of expectations.mustContain ?? []) {
      if (!checked.includes("mustContain")) checked.push("mustContain");
      if (!normalizedText.includes(normalizeForMatch(needle))) {
        failures.push({
          check: "mustContain",
          expected: `文档文本包含 / the text contains ${JSON.stringify(needle)}`,
          actual: `未找到 / not found（文本长度 / text length ${content.text.length}）`,
        });
      }
    }
    for (const needle of expectations.mustNotContain ?? []) {
      if (!checked.includes("mustNotContain")) checked.push("mustNotContain");
      if (normalizedText.includes(normalizeForMatch(needle))) {
        failures.push({
          check: "mustNotContain",
          expected: `文档文本不包含 / the text does not contain ${JSON.stringify(needle)}`,
          actual: "仍然存在 / still present",
        });
      }
    }
    if (expectations.minTables !== undefined) {
      checked.push("minTables");
      const expected = `至少 ${expectations.minTables} 个表格 / at least ${expectations.minTables} table(s)`;
      if (content.tableCount === undefined) failures.push(notApplicable("minTables", expected, detection.kind));
      else if (content.tableCount < expectations.minTables) {
        failures.push({ check: "minTables", expected, actual: `${content.tableCount} 个 / table(s)` });
      }
    }
    if (expectations.minSlides !== undefined) {
      checked.push("minSlides");
      const expected = `至少 ${expectations.minSlides} 页幻灯片 / at least ${expectations.minSlides} slide(s)`;
      if (content.slideCount === undefined) failures.push(notApplicable("minSlides", expected, detection.kind));
      else if (content.slideCount < expectations.minSlides) {
        failures.push({ check: "minSlides", expected, actual: `${content.slideCount} 页 / slide(s)` });
      }
    }
    if (expectations.maxSlides !== undefined) {
      checked.push("maxSlides");
      const expected = `最多 ${expectations.maxSlides} 页幻灯片 / at most ${expectations.maxSlides} slide(s)`;
      if (content.slideCount === undefined) failures.push(notApplicable("maxSlides", expected, detection.kind));
      else if (content.slideCount > expectations.maxSlides) {
        failures.push({ check: "maxSlides", expected, actual: `${content.slideCount} 页 / slide(s)` });
      }
    }
    if (expectations.minSheets !== undefined) {
      checked.push("minSheets");
      const expected = `至少 ${expectations.minSheets} 个工作表 / at least ${expectations.minSheets} sheet(s)`;
      if (content.sheetCount === undefined) failures.push(notApplicable("minSheets", expected, detection.kind));
      else if (content.sheetCount < expectations.minSheets) {
        failures.push({ check: "minSheets", expected, actual: `${content.sheetCount} 个 / sheet(s)` });
      }
    }
    const wantedSheets = expectations.sheetNames ?? [];
    if (wantedSheets.length > 0) {
      checked.push("sheetNames");
      const present = content.sheetNames;
      if (present === undefined) {
        failures.push(notApplicable("sheetNames",
          `包含工作表 / contains sheets ${JSON.stringify(wantedSheets)}`, detection.kind));
      } else {
        for (const name of wantedSheets) {
          if (!present.includes(name)) {
            failures.push({
              check: "sheetNames",
              expected: `存在工作表 / a sheet named ${JSON.stringify(name)}`,
              actual: `实际工作表 / sheets are ${JSON.stringify(present)}`,
            });
          }
        }
      }
    }
    if (expectations.minCjkChars !== undefined) {
      checked.push("minCjkChars");
      if (cjkChars < expectations.minCjkChars) {
        failures.push({
          check: "minCjkChars",
          expected: `至少 ${expectations.minCjkChars} 个中文字符 / at least ${expectations.minCjkChars} CJK characters`,
          actual: `${cjkChars} 个 / characters`,
        });
      }
    }
    if (expectations.maxCjkChars !== undefined) {
      checked.push("maxCjkChars");
      if (cjkChars > expectations.maxCjkChars) {
        failures.push({
          check: "maxCjkChars",
          expected: `最多 ${expectations.maxCjkChars} 个中文字符 / at most ${expectations.maxCjkChars} CJK characters`,
          actual: `${cjkChars} 个 / characters`,
        });
      }
    }
  }

  const result: DocVerifyResult = {
    path: file,
    ok: failures.length === 0,
    bytes,
    extension,
    kind: detection.kind,
    kindMatchesExtension,
    formatValid: readable,
    textLength: content.text.length,
    cjkChars,
    checked,
    skipped,
    failures,
  };
  const problem = readProblem ?? detection.problem;
  if (!readable && problem !== undefined) result.formatProblem = problem;
  if (content.paragraphCount !== undefined) result.paragraphCount = content.paragraphCount;
  if (content.tableCount !== undefined) result.tableCount = content.tableCount;
  if (content.slideCount !== undefined) result.slideCount = content.slideCount;
  if (content.sheetCount !== undefined) result.sheetCount = content.sheetCount;
  if (content.sheetNames !== undefined) result.sheetNames = content.sheetNames;
  return result;
}
