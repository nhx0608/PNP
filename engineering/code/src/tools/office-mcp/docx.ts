import { OfficeToolError } from "./errors.ts";
import { openPackage, readPartTree, savePackage, writePartTree } from "./package-file.ts";
import {
  attribute, childrenOf, cloneNode, element, findChild, findDescendant, flattenText, setChildren, tagName, textNode,
  type XmlNode,
} from "./xml.ts";

const DOCUMENT_PART = "word/document.xml";

export type DocxParagraph = {
  index: number;
  bodyIndex: number;
  style?: string;
  headingLevel?: number;
  text: string;
};

export type DocxTable = {
  index: number;
  bodyIndex: number;
  rowCount: number;
  columnCount: number;
  rows: string[][];
};

export type DocxExtraction = {
  path: string;
  paragraphCount: number;
  tableCount: number;
  paragraphs: DocxParagraph[];
  tables: DocxTable[];
  headings: { paragraphIndex: number; level: number; text: string; style?: string }[];
};

type Block = { kind: "paragraph" | "table"; node: XmlNode };

/**
 * Body blocks in document order. `w:sdt` (a content control — Word wraps cover pages, tables of
 * contents and form fields in one) is transparent here: its `w:sdtContent` children are treated as
 * body children so a paragraph inside a content control still gets an index the replace tool can
 * address, instead of disappearing from the extraction.
 */
function collectBlocks(nodes: XmlNode[], out: Block[]): void {
  for (const node of nodes) {
    const name = tagName(node);
    if (name === "w:p") out.push({ kind: "paragraph", node });
    else if (name === "w:tbl") out.push({ kind: "table", node });
    else if (name === "w:sdt") {
      const content = findChild(childrenOf(node), "w:sdtContent");
      if (content !== undefined) collectBlocks(childrenOf(content), out);
    }
  }
}

function bodyBlocks(tree: XmlNode[]): Block[] {
  const document = tree.find((node) => tagName(node) === "w:document");
  if (document === undefined) {
    throw new OfficeToolError("UNSUPPORTED_FORMAT", `word/document.xml 缺少 w:document 根元素 / missing w:document root`);
  }
  const body = findChild(childrenOf(document), "w:body");
  if (body === undefined) {
    throw new OfficeToolError("UNSUPPORTED_FORMAT", `word/document.xml 缺少 w:body / missing w:body`);
  }
  const blocks: Block[] = [];
  collectBlocks(childrenOf(body), blocks);
  return blocks;
}

/**
 * Visible text of a paragraph. `w:delText` (text deleted under tracked changes) is skipped because
 * it is not part of the document as read; `w:br`/`w:cr` become newlines and `w:tab` a tab so the
 * text the model matches on looks like what a reader sees.
 */
function collectRunText(nodes: XmlNode[]): string {
  let out = "";
  for (const node of nodes) {
    const name = tagName(node);
    if (name === null) continue;
    if (name === "w:t") out += flattenText(childrenOf(node));
    else if (name === "w:tab") out += "\t";
    else if (name === "w:br" || name === "w:cr") out += "\n";
    else if (name === "w:delText" || name === "w:pPr" || name === "w:rPr") continue;
    else out += collectRunText(childrenOf(node));
  }
  return out;
}

export function paragraphText(paragraph: XmlNode): string {
  return collectRunText(childrenOf(paragraph));
}

function paragraphProperties(paragraph: XmlNode): XmlNode | undefined {
  return findChild(childrenOf(paragraph), "w:pPr");
}

function paragraphStyle(paragraph: XmlNode): string | undefined {
  const properties = paragraphProperties(paragraph);
  if (properties === undefined) return undefined;
  const style = findChild(childrenOf(properties), "w:pStyle");
  return style === undefined ? undefined : attribute(style, "w:val");
}

/** Heading level from the paragraph style (`Heading2`, `标题 2`) or from an explicit `w:outlineLvl`. */
function headingLevel(paragraph: XmlNode, style: string | undefined): number | undefined {
  if (style !== undefined) {
    const match = /^(?:heading|标题)\s*([1-9])$/i.exec(style.trim());
    if (match?.[1] !== undefined) return Number(match[1]);
    if (/^title$/i.test(style.trim())) return 1;
  }
  const properties = paragraphProperties(paragraph);
  if (properties !== undefined) {
    const outline = findChild(childrenOf(properties), "w:outlineLvl");
    const value = outline === undefined ? undefined : attribute(outline, "w:val");
    if (value !== undefined && /^\d+$/.test(value)) {
      const level = Number(value) + 1;
      if (level >= 1 && level <= 9) return level;
    }
  }
  return undefined;
}

function tableRows(table: XmlNode): string[][] {
  const rows: string[][] = [];
  for (const row of childrenOf(table)) {
    if (tagName(row) !== "w:tr") continue;
    const cells: string[] = [];
    for (const cell of childrenOf(row)) {
      if (tagName(cell) !== "w:tc") continue;
      const paragraphs = childrenOf(cell).filter((node) => tagName(node) === "w:p");
      cells.push(paragraphs.map((node) => paragraphText(node)).join("\n"));
    }
    rows.push(cells);
  }
  return rows;
}

export async function docxExtract(file: string): Promise<DocxExtraction> {
  const pkg = await openPackage(file);
  const tree = await readPartTree(pkg, DOCUMENT_PART);
  const blocks = bodyBlocks(tree);
  const paragraphs: DocxParagraph[] = [];
  const tables: DocxTable[] = [];
  const headings: DocxExtraction["headings"] = [];
  blocks.forEach((block, bodyIndex) => {
    if (block.kind === "paragraph") {
      const style = paragraphStyle(block.node);
      const level = headingLevel(block.node, style);
      const text = paragraphText(block.node);
      const index = paragraphs.length;
      const entry: DocxParagraph = { index, bodyIndex, text };
      if (style !== undefined) entry.style = style;
      if (level !== undefined) entry.headingLevel = level;
      paragraphs.push(entry);
      if (level !== undefined && text.trim().length > 0) {
        headings.push(style === undefined
          ? { paragraphIndex: index, level, text }
          : { paragraphIndex: index, level, text, style });
      }
    } else {
      const rows = tableRows(block.node);
      tables.push({
        index: tables.length,
        bodyIndex,
        rowCount: rows.length,
        columnCount: rows.reduce((widest, row) => Math.max(widest, row.length), 0),
        rows,
      });
    }
  });
  return { path: file, paragraphCount: paragraphs.length, tableCount: tables.length, paragraphs, tables, headings };
}

export type ParagraphReplacement = { index?: number; match?: string; text: string };

export type DocxReplacementResult = {
  path: string;
  outputPath: string;
  replaced: { index: number; previousText: string; text: string }[];
  paragraphCount: number;
  bytes: number;
};

/**
 * Picks the paragraph a single replacement refers to. `match` is resolved against the whole
 * paragraph text first and only then as a substring, so an exact caption that also appears inside a
 * longer sentence still addresses itself; anything that stays ambiguous is an error naming the
 * candidate indexes rather than a guess that edits the wrong paragraph.
 */
function resolveTarget(texts: string[], replacement: ParagraphReplacement, position: number): number {
  const label = `replacements[${position}]`;
  if (replacement.index !== undefined) {
    if (!Number.isInteger(replacement.index) || replacement.index < 0 || replacement.index >= texts.length) {
      throw new OfficeToolError("INDEX_OUT_OF_RANGE",
        `${label}.index=${replacement.index} 超出段落范围 0..${texts.length - 1} / paragraph index out of range`);
    }
    return replacement.index;
  }
  const match = replacement.match;
  if (match === undefined || match.length === 0) {
    throw new OfficeToolError("INVALID_ARGUMENT", `${label} 必须提供 index 或 match / needs either index or match`);
  }
  const exact: number[] = [];
  const partial: number[] = [];
  texts.forEach((text, index) => {
    if (text === match) exact.push(index);
    else if (text.includes(match)) partial.push(index);
  });
  const candidates = exact.length > 0 ? exact : partial;
  if (candidates.length === 0) {
    throw new OfficeToolError("NO_MATCH", `${label}.match 未匹配任何段落 / matched no paragraph: ${JSON.stringify(match)}`);
  }
  if (candidates.length > 1) {
    throw new OfficeToolError("AMBIGUOUS_MATCH",
      `${label}.match 匹配到 ${candidates.length} 个段落（索引 ${candidates.join(", ")}），请改用 index 或更精确的 match /` +
      ` ambiguous match, use index or a more specific match: ${JSON.stringify(match)}`);
  }
  return candidates[0] as number;
}

/**
 * Rewrites the paragraph's text while keeping its identity: `w:pPr` (style, numbering, alignment,
 * spacing) is reused as-is and the first run's `w:rPr` (font, size, bold, colour) is carried onto
 * the single run that now holds the text. Everything else in the paragraph — extra runs with other
 * formatting, comment anchors, fields — is replaced, which is exactly what "rewrite this paragraph"
 * means and is recorded as a limitation in the README. Bookmarks are kept so a cross-reference or a
 * table of contents entry pointing at this paragraph still resolves.
 */
function applyReplacement(paragraph: XmlNode, text: string): void {
  const children = childrenOf(paragraph);
  const properties = children.find((node) => tagName(node) === "w:pPr");
  const firstRun = findDescendant(children, "w:r");
  const runProperties = firstRun === undefined ? undefined : findChild(childrenOf(firstRun), "w:rPr");
  const runChildren: XmlNode[] = [];
  if (runProperties !== undefined) runChildren.push(cloneNode(runProperties));
  const lines = text.split(/\r?\n/);
  lines.forEach((line, position) => {
    if (position > 0) runChildren.push(element("w:br", []));
    runChildren.push(element("w:t", line.length > 0 ? [textNode(line)] : [], { "@_xml:space": "preserve" }));
  });
  const next: XmlNode[] = [];
  if (properties !== undefined) next.push(properties);
  for (const child of children) if (tagName(child) === "w:bookmarkStart") next.push(child);
  next.push(element("w:r", runChildren));
  for (const child of children) if (tagName(child) === "w:bookmarkEnd") next.push(child);
  setChildren(paragraph, next);
}

export async function docxReplaceParagraphs(
  file: string, outputPath: string, replacements: readonly ParagraphReplacement[],
): Promise<DocxReplacementResult> {
  if (replacements.length === 0) {
    throw new OfficeToolError("INVALID_ARGUMENT", "replacements 不能为空 / must contain at least one replacement");
  }
  const pkg = await openPackage(file);
  const tree = await readPartTree(pkg, DOCUMENT_PART);
  const paragraphs = bodyBlocks(tree).filter((block) => block.kind === "paragraph").map((block) => block.node);
  const texts = paragraphs.map((node) => paragraphText(node));
  const targets = replacements.map((replacement, position) => resolveTarget(texts, replacement, position));
  const seen = new Set<number>();
  targets.forEach((index, position) => {
    if (seen.has(index)) {
      throw new OfficeToolError("INVALID_ARGUMENT",
        `replacements[${position}] 与前一条指向同一段落（索引 ${index}）/ two replacements address the same paragraph`);
    }
    seen.add(index);
  });
  const replaced = targets.map((index, position) => {
    const paragraph = paragraphs[index] as XmlNode;
    const text = (replacements[position] as ParagraphReplacement).text;
    applyReplacement(paragraph, text);
    return { index, previousText: texts[index] as string, text };
  });
  writePartTree(pkg, DOCUMENT_PART, tree);
  const bytes = await savePackage(pkg, outputPath);
  return { path: file, outputPath, replaced, paragraphCount: paragraphs.length, bytes };
}
