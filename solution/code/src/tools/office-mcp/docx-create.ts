import {
  Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";
import { writeFile } from "node:fs/promises";
import { OfficeToolError } from "./errors.ts";

export type DocxBlock = {
  type: "heading" | "paragraph" | "bullets" | "table";
  level?: number;
  text?: string;
  items?: string[];
  rows?: string[][];
};

export type DocxCreateResult = {
  outputPath: string;
  blockCount: number;
  paragraphCount: number;
  tableCount: number;
  bytes: number;
};

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
] as const;

/** A paragraph carrying the caller's line breaks as real `w:br` runs rather than literal "\n". */
type Heading = (typeof HeadingLevel)[keyof typeof HeadingLevel];

function textParagraph(text: string, options: { heading?: Heading; bullet?: boolean }): Paragraph {
  const lines = text.split(/\r?\n/);
  const runs = lines.map((line, index) => new TextRun(index === 0 ? { text: line } : { text: line, break: 1 }));
  return new Paragraph({
    children: runs,
    ...(options.heading === undefined ? {} : { heading: options.heading }),
    ...(options.bullet === true ? { bullet: { level: 0 } } : {}),
  });
}

function tableFrom(rows: string[][]): Table {
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((row, rowIndex) => new TableRow({
      children: Array.from({ length: width }, (_unused, columnIndex) => new TableCell({
        children: [new Paragraph({
          children: [new TextRun({ text: row[columnIndex] ?? "", bold: rowIndex === 0 })],
        })],
      })),
    })),
  });
}

function blockChildren(block: DocxBlock, position: number): (Paragraph | Table)[] {
  const label = `blocks[${position}]`;
  if (block.type === "heading") {
    if (block.text === undefined) throw new OfficeToolError("INVALID_ARGUMENT", `${label} 缺少 text / heading needs text`);
    const level = block.level ?? 1;
    if (!Number.isInteger(level) || level < 1 || level > HEADING_LEVELS.length) {
      throw new OfficeToolError("INVALID_ARGUMENT", `${label}.level 必须是 1..${HEADING_LEVELS.length} / heading level out of range`);
    }
    return [textParagraph(block.text, { heading: HEADING_LEVELS[level - 1] })];
  }
  if (block.type === "paragraph") {
    if (block.text === undefined) throw new OfficeToolError("INVALID_ARGUMENT", `${label} 缺少 text / paragraph needs text`);
    return [textParagraph(block.text, {})];
  }
  if (block.type === "bullets") {
    const items = block.items ?? [];
    if (items.length === 0) throw new OfficeToolError("INVALID_ARGUMENT", `${label} 缺少 items / bullets needs items`);
    return items.map((item) => textParagraph(item, { bullet: true }));
  }
  const rows = block.rows ?? [];
  if (rows.length === 0) throw new OfficeToolError("INVALID_ARGUMENT", `${label} 缺少 rows / table needs rows`);
  return [tableFrom(rows)];
}

export async function docxCreate(
  outputPath: string, blocks: readonly DocxBlock[], title?: string,
): Promise<DocxCreateResult> {
  if (blocks.length === 0 && title === undefined) {
    throw new OfficeToolError("INVALID_ARGUMENT", "blocks 不能为空 / must contain at least one block");
  }
  const children: (Paragraph | Table)[] = [];
  if (title !== undefined && title.length > 0) children.push(textParagraph(title, { heading: HeadingLevel.TITLE }));
  blocks.forEach((block, position) => children.push(...blockChildren(block, position)));
  const document = new Document({
    ...(title === undefined ? {} : { title }),
    sections: [{ children }],
  });
  const bytes = await Packer.toBuffer(document);
  await writeFile(outputPath, bytes);
  return {
    outputPath,
    blockCount: blocks.length,
    paragraphCount: children.filter((child) => child instanceof Paragraph).length,
    tableCount: children.filter((child) => child instanceof Table).length,
    bytes: bytes.byteLength,
  };
}
