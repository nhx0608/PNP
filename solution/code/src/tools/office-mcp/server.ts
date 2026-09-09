import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { dataAggregate, type AggregateFilter, type AggregateSpec } from "./aggregate.ts";
import { csvRead } from "./csv.ts";
import { docxExtract, docxReplaceParagraphs } from "./docx.ts";
import { docxCreate, type DocxBlock } from "./docx-create.ts";
import { fsDelete, fsFind } from "./files.ts";
import {
  DOCX_EXTRACT_GUIDANCE, PPTX_EXTRACT_GUIDANCE, TABLE_READ_GUIDANCE, XLSX_READ_GUIDANCE,
} from "./guidance.ts";
import { prepareOutputPath, requireExistingFile } from "./paths.ts";
import { pptxDeleteSlides, pptxExtract, pptxReorderSlides, pptxReplaceText } from "./pptx.ts";
import { MAX_SLIDES, pptxCreate } from "./pptx-create.ts";
import { annotationsFor, failureResult, successResult, type SideEffect, type ToolPayload } from "./results.ts";
import { appOpen, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, webFetch } from "./system.ts";
import { docVerify } from "./verify.ts";
import { xlsxRead, xlsxWrite } from "./xlsx.ts";

export const SERVER_NAME = "office";
export const SERVER_VERSION = "0.1.0";

export type ToolInfo = { name: string; title: string; sideEffect: SideEffect; description: string };

const ABSOLUTE_PATH_NOTE = "必须是绝对路径 / must be an absolute path";
const OVERWRITE_NOTE = "目标文件已存在时是否覆盖，默认 false / replace an existing output file, default false";

const overwriteField = z.boolean().optional().describe(OVERWRITE_NOTE);

function guard<Schema extends z.ZodObject>(
  name: string, schema: Schema, run: (args: z.infer<Schema>) => Promise<ToolPayload>,
): (args: unknown) => Promise<CallToolResult> {
  return async (args: unknown): Promise<CallToolResult> => {
    try {
      return successResult(await run(schema.parse(args)));
    } catch (error) {
      return failureResult(name, error);
    }
  };
}

function register<Schema extends z.ZodObject>(
  server: McpServer,
  catalog: ToolInfo[],
  spec: { name: string; title: string; sideEffect: SideEffect; description: string; inputSchema: Schema },
  run: (args: z.infer<Schema>) => Promise<ToolPayload>,
): void {
  catalog.push({ name: spec.name, title: spec.title, sideEffect: spec.sideEffect, description: spec.description });
  // Widened on purpose: the SDK derives the handler signature from the schema type, and a handler
  // typed against a still-generic schema cannot be checked here. `guard` re-parses the arguments
  // with the same schema, so the concrete argument type is recovered inside the tool body.
  const inputSchema: z.ZodObject = spec.inputSchema;
  server.registerTool(spec.name, {
    title: spec.title,
    description: spec.description,
    inputSchema,
    annotations: annotationsFor(spec.sideEffect, spec.title),
    // The gateway's policy layer classifies a call by its effect, not by its name.
    _meta: { sideEffect: spec.sideEffect },
  }, guard(spec.name, spec.inputSchema, run));
}

function registerDocxTools(server: McpServer, catalog: ToolInfo[]): void {
  register(server, catalog, {
    name: "docx_extract",
    title: "读取 Word 文档 / Read a Word document",
    sideEffect: "read",
    description: "按文档顺序提取 .docx 的段落、表格与标题。段落索引从 0 开始，可直接用于 docx_replace_paragraphs。"
      + "表格按真实列网格返回：合并单元格（w:gridSpan 横向合并、w:vMerge 纵向合并）不会让后面的单元格串列，"
      + "rows 中被合并覆盖的位置是空串，cells 里给出每个单元格的 column/columnSpan/rowSpan。"
      + " Extracts paragraphs, tables and headings from a .docx in document order; paragraph indexes are"
      + " zero-based and are exactly the indexes docx_replace_paragraphs accepts. Table rows are laid out"
      + " on the real column grid, so a merged header cell no longer shifts the rest of its row: a"
      + " position covered by a horizontal or vertical merge comes back as \"\", and `cells` reports each"
      + " cell's column, columnSpan and rowSpan.",
    inputSchema: z.object({ path: z.string().describe(`.docx 文件路径 / path to the .docx file; ${ABSOLUTE_PATH_NOTE}`) }),
  }, async (args) => {
    const file = await requireExistingFile("path", args.path);
    const extraction = await docxExtract(file);
    return {
      // The guidance line rides on the summary, not inside `data`: the summary is the first thing in
      // the text block (see results.ts) and `data` is the document itself, which stays byte-identical.
      summary: `docx_extract: ${extraction.paragraphCount} 段落 / paragraphs, ${extraction.tableCount} 表格 / tables (${file})`
        + `\n${DOCX_EXTRACT_GUIDANCE}`,
      data: extraction,
    };
  });

  register(server, catalog, {
    name: "docx_replace_paragraphs",
    title: "改写 Word 段落 / Rewrite Word paragraphs",
    sideEffect: "write",
    description: "按段落索引（docx_extract 的 index）或文本匹配改写正文段落，保留段落属性与首个 run 的字体格式，"
      + "写入 outputPath（不修改原文件，除非 outputPath 等于 path 且 overwrite=true）。match 命中多个段落时报错。"
      + " Replaces paragraph text by index or by an exact/substring match while keeping the paragraph"
      + " properties and the first run's formatting; writes a new file and never touches the input unless"
      + " outputPath equals path with overwrite:true. An ambiguous match is an error, not a guess.",
    inputSchema: z.object({
      path: z.string().describe(`源 .docx / source .docx; ${ABSOLUTE_PATH_NOTE}`),
      outputPath: z.string().describe(`输出 .docx / output .docx; ${ABSOLUTE_PATH_NOTE}`),
      replacements: z.array(z.object({
        index: z.number().int().min(0).optional().describe("段落索引（从 0 开始）/ zero-based paragraph index"),
        match: z.string().optional().describe("段落全文或唯一子串 / the paragraph text or a unique substring of it"),
        text: z.string().describe("新的段落文本，\\n 转为换行 / new paragraph text; \\n becomes a line break"),
      })).min(1).describe("每条必须提供 index 或 match / each entry needs either index or match"),
      overwrite: overwriteField,
    }),
  }, async (args) => {
    const file = await requireExistingFile("path", args.path);
    const output = await prepareOutputPath("outputPath", args.outputPath, args.overwrite === true);
    const result = await docxReplaceParagraphs(file, output, args.replacements);
    return {
      summary: `docx_replace_paragraphs: 已替换 ${result.replaced.length} 段 / replaced ${result.replaced.length} paragraph(s)`
        + ` → ${output}`,
      data: result,
    };
  });

  register(server, catalog, {
    name: "docx_create",
    title: "新建 Word 文档 / Create a Word document",
    sideEffect: "write",
    description: "用结构化内容生成 .docx：blocks 支持 heading（level 1-6）、paragraph、bullets（items）、table（rows，首行为表头）。"
      + " Creates a .docx from structured blocks: heading (level 1-6), paragraph, bullets (items) and"
      + " table (rows, first row treated as the header).",
    inputSchema: z.object({
      outputPath: z.string().describe(`输出 .docx / output .docx; ${ABSOLUTE_PATH_NOTE}`),
      title: z.string().optional().describe("文档标题，作为首段标题写入 / document title, written as the first heading"),
      blocks: z.array(z.object({
        type: z.enum(["heading", "paragraph", "bullets", "table"]).describe("块类型 / block type"),
        level: z.number().int().min(1).max(6).optional().describe("标题层级 / heading level"),
        text: z.string().optional().describe("heading/paragraph 的文本 / text for heading and paragraph"),
        items: z.array(z.string()).optional().describe("bullets 的条目 / bullet items"),
        rows: z.array(z.array(z.string())).optional().describe("table 的行 / table rows"),
      })).describe("按顺序写入的内容块 / content blocks in order"),
      overwrite: overwriteField,
    }),
  }, async (args) => {
    const output = await prepareOutputPath("outputPath", args.outputPath, args.overwrite === true);
    const blocks: DocxBlock[] = args.blocks.map((block) => ({
      type: block.type,
      ...(block.level === undefined ? {} : { level: block.level }),
      ...(block.text === undefined ? {} : { text: block.text }),
      ...(block.items === undefined ? {} : { items: block.items }),
      ...(block.rows === undefined ? {} : { rows: block.rows }),
    }));
    const result = await docxCreate(output, blocks, args.title);
    return { summary: `docx_create: ${result.blockCount} 个内容块 / blocks → ${output}`, data: result };
  });
}

function registerXlsxTools(server: McpServer, catalog: ToolInfo[]): void {
  register(server, catalog, {
    name: "xlsx_read",
    title: "读取 Excel 工作表 / Read an Excel sheet",
    sideEffect: "read",
    description: "读取 .xlsx：返回全部工作表名与所选工作表的行（首行通常是表头）。sheet 可用工作表名或 1 开始的序号，"
      + "缺省读第一个工作表；公式取计算结果，日期转 ISO 字符串。"
      + " Reads a workbook: every sheet name plus the rows of the selected sheet (by name or 1-based"
      + " index, first sheet by default). Formula cells report their result and dates come back as ISO strings.",
    inputSchema: z.object({
      path: z.string().describe(`.xlsx 文件路径 / path to the workbook; ${ABSOLUTE_PATH_NOTE}`),
      sheet: z.string().optional().describe("工作表名或序号，例如 \"库存管理台账\" 或 \"2\" / sheet name or 1-based index"),
      maxRows: z.number().int().min(1).optional().describe("最多返回的行数 / maximum rows to return"),
    }),
  }, async (args) => {
    const file = await requireExistingFile("path", args.path);
    const result = await xlsxRead(file, args.sheet, args.maxRows);
    return {
      summary: `xlsx_read: 工作表 / sheet ${JSON.stringify(result.sheet)}，${result.returnedRows}/${result.rowCount} 行 / rows`
        + `（全部工作表 / all sheets: ${result.sheets.join(", ")}）`
        + `\n${XLSX_READ_GUIDANCE}`,
      data: result,
    };
  });

  register(server, catalog, {
    name: "xlsx_write",
    title: "写入 Excel 工作簿 / Write an Excel workbook",
    sideEffect: "write",
    description: "生成 .xlsx，每个 sheets 元素写成一个工作表（例如把文档里的每个表格导出成一个 sheet）。"
      + "工作表名会按 Excel 规则清洗并去重，首行加粗并冻结。"
      + " Writes a workbook with one worksheet per input table; sheet names are sanitised to Excel's"
      + " rules and de-duplicated, and the first row is bolded and frozen as a header.",
    inputSchema: z.object({
      outputPath: z.string().describe(`输出 .xlsx / output workbook; ${ABSOLUTE_PATH_NOTE}`),
      sheets: z.array(z.object({
        name: z.string().optional().describe("工作表名 / worksheet name"),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe("行数据 / rows"),
      })).min(1).describe("工作表列表 / worksheets to write"),
      overwrite: overwriteField,
    }),
  }, async (args) => {
    const output = await prepareOutputPath("outputPath", args.outputPath, args.overwrite === true);
    const result = await xlsxWrite(output, args.sheets);
    return {
      summary: `xlsx_write: ${result.sheets.length} 个工作表 / worksheets (${result.sheets.map((sheet) => sheet.name).join(", ")}) → ${output}`,
      data: result,
    };
  });
}

function registerPptxTools(server: McpServer, catalog: ToolInfo[]): void {
  register(server, catalog, {
    name: "pptx_extract",
    title: "读取 PowerPoint / Read a PowerPoint deck",
    sideEffect: "read",
    description: "按演示顺序提取每页的形状文本、标题与备注；index 从 1 开始，shapeId 可直接用于 pptx_replace_text。"
      + "同时提取页内表格（tables，按行列返回单元格文本）与图表的缓存数据（charts：系列名、类别与数值），"
      + "所以改版前后可以逐个核对数据点是否保留。"
      + " Extracts every slide in presentation order (as stored in p:sldIdLst, not by file name) with its"
      + " title, shape texts and speaker notes; slide indexes are 1-based and shapeIds feed"
      + " pptx_replace_text. Slide tables come back as rows of cells and charts as their cached series,"
      + " categories and values, so a data point that lives in a table or a chart can be checked before"
      + " and after a restructure instead of being invisible.",
    inputSchema: z.object({ path: z.string().describe(`.pptx 文件路径 / path to the deck; ${ABSOLUTE_PATH_NOTE}`) }),
  }, async (args) => {
    const file = await requireExistingFile("path", args.path);
    const result = await pptxExtract(file);
    return {
      summary: `pptx_extract: ${result.slideCount} 页 / slides, ${result.tableCount} 表格 / tables,`
        + ` ${result.chartCount} 图表 / charts (${file})`
        + `\n${PPTX_EXTRACT_GUIDANCE}`,
      data: result,
    };
  });

  register(server, catalog, {
    name: "pptx_replace_text",
    title: "替换幻灯片文本 / Replace slide text",
    sideEffect: "write",
    description: "按 shapeId 或唯一文本匹配替换某页某个形状的全部文本（多行按 \\n 拆成多段），保留该形状的段落与字体格式。"
      + " Replaces the whole text of one shape per edit, selected by shapeId or by a unique match; lines"
      + " become separate paragraphs and the shape's paragraph and run formatting is preserved.",
    inputSchema: z.object({
      path: z.string().describe(`源 .pptx / source deck; ${ABSOLUTE_PATH_NOTE}`),
      outputPath: z.string().describe(`输出 .pptx / output deck; ${ABSOLUTE_PATH_NOTE}`),
      edits: z.array(z.object({
        slide: z.number().int().min(1).describe("幻灯片序号，从 1 开始 / 1-based slide index"),
        shapeId: z.string().optional().describe("pptx_extract 返回的 shapeId / shapeId from pptx_extract"),
        match: z.string().optional().describe("该页内唯一的文本或子串 / text unique within the slide"),
        text: z.string().describe("新文本 / replacement text"),
      })).min(1),
      overwrite: overwriteField,
    }),
  }, async (args) => {
    const file = await requireExistingFile("path", args.path);
    const output = await prepareOutputPath("outputPath", args.outputPath, args.overwrite === true);
    const result = await pptxReplaceText(file, output, args.edits);
    return { summary: `pptx_replace_text: ${result.edits.length} 处修改 / edits → ${output}`, data: result };
  });

  register(server, catalog, {
    name: "pptx_reorder_slides",
    title: "调整幻灯片顺序 / Reorder slides",
    sideEffect: "write",
    description: "按 order 给出的新顺序重排幻灯片（order 必须是 1..N 的一个全排列），关系与备注保持不变。"
      + " Reorders the deck by rewriting p:sldIdLst; order must list every slide exactly once and all"
      + " relationships, notes and media stay attached to their slides.",
    inputSchema: z.object({
      path: z.string().describe(`源 .pptx / source deck; ${ABSOLUTE_PATH_NOTE}`),
      outputPath: z.string().describe(`输出 .pptx / output deck; ${ABSOLUTE_PATH_NOTE}`),
      order: z.array(z.number().int().min(1)).min(1).describe("新顺序，例如 [1,3,2] / new order, 1-based"),
      overwrite: overwriteField,
    }),
  }, async (args) => {
    const file = await requireExistingFile("path", args.path);
    const output = await prepareOutputPath("outputPath", args.outputPath, args.overwrite === true);
    const result = await pptxReorderSlides(file, output, args.order);
    return { summary: `pptx_reorder_slides: 新顺序 / new order [${result.order.join(", ")}] → ${output}`, data: result };
  });

  register(server, catalog, {
    name: "pptx_delete_slides",
    title: "删除幻灯片 / Delete slides",
    sideEffect: "write",
    description: "删除指定页（1 开始），同时清理演示关系、备注页与内容类型声明；不能删除全部页。"
      + " Deletes the named slides and cleans up their relationships, notes slides and content-type"
      + " overrides so the written deck stays valid. Deleting every slide is refused.",
    inputSchema: z.object({
      path: z.string().describe(`源 .pptx / source deck; ${ABSOLUTE_PATH_NOTE}`),
      outputPath: z.string().describe(`输出 .pptx / output deck; ${ABSOLUTE_PATH_NOTE}`),
      slides: z.array(z.number().int().min(1)).min(1).describe("要删除的页码 / 1-based slide indexes to delete"),
      overwrite: overwriteField,
    }),
  }, async (args) => {
    const file = await requireExistingFile("path", args.path);
    const output = await prepareOutputPath("outputPath", args.outputPath, args.overwrite === true);
    const result = await pptxDeleteSlides(file, output, args.slides);
    return {
      summary: `pptx_delete_slides: 删除 ${result.deleted.length} 页，剩余 ${result.remainingSlides} 页 /`
        + ` deleted ${result.deleted.length}, ${result.remainingSlides} left → ${output}`,
      data: result,
    };
  });

  register(server, catalog, {
    name: "pptx_create",
    title: "新建演示文稿 / Create a PowerPoint deck",
    sideEffect: "write",
    description: `用大纲生成 .pptx：每页一个 title，可选 bullets 与备注 notes，最多 ${MAX_SLIDES} 页。`
      + ` Builds a 16:9 deck from an outline: one title per slide plus optional bullets and speaker notes,`
      + ` at most ${MAX_SLIDES} slides.`,
    inputSchema: z.object({
      outputPath: z.string().describe(`输出 .pptx / output deck; ${ABSOLUTE_PATH_NOTE}`),
      slides: z.array(z.object({
        title: z.string().describe("标题 / slide title"),
        bullets: z.array(z.string()).optional().describe("要点 / bullet lines"),
        notes: z.string().optional().describe("备注 / speaker notes"),
      })).min(1).max(MAX_SLIDES),
      theme: z.object({
        fontFace: z.string().optional().describe("字体名，中文建议 \"微软雅黑\" / font face"),
        titleColor: z.string().optional().describe("标题色，6 位十六进制 / title colour as 6 hex digits"),
        bodyColor: z.string().optional().describe("正文色 / body colour"),
        backgroundColor: z.string().optional().describe("背景色 / background colour"),
      }).optional(),
      overwrite: overwriteField,
    }),
  }, async (args) => {
    const output = await prepareOutputPath("outputPath", args.outputPath, args.overwrite === true);
    const result = await pptxCreate(output, args.slides, args.theme);
    return { summary: `pptx_create: ${result.slideCount} 页 / slides → ${output}`, data: result };
  });
}

function registerDataTools(server: McpServer, catalog: ToolInfo[]): void {
  register(server, catalog, {
    name: "csv_read",
    title: "读取 CSV / Read a CSV file",
    sideEffect: "read",
    description: "读取 CSV（UTF-8，自动跳过 BOM，未给 delimiter 时自动判断 , ; Tab |），返回表头、数据行、总行数，"
      + "并对数值列给出 count/min/max/mean/sum，对文本列给出取值数与样例，便于直接写分析结论。"
      + " Reads a CSV and returns headers, rows, the total row count, per-numeric-column statistics"
      + " (count, min, max, mean, sum) and a sample of each text column, so an analysis can be written"
      + " without a second pass over the file.",
    inputSchema: z.object({
      path: z.string().describe(`.csv 文件路径 / path to the CSV; ${ABSOLUTE_PATH_NOTE}`),
      delimiter: z.string().optional().describe("分隔符，缺省自动判断 / delimiter, auto-detected when omitted"),
      maxRows: z.number().int().min(1).optional().describe("最多返回的数据行数（统计仍覆盖全部行）/ maximum data rows to return; statistics still cover every row"),
    }),
  }, async (args) => {
    const file = await requireExistingFile("path", args.path);
    const result = await csvRead(file, args.delimiter, args.maxRows);
    return {
      summary: `csv_read: ${result.rowCount} 行 / rows, ${result.headers.length} 列 / columns`
        + `（数值列 / numeric: ${result.numericColumns.map((column) => column.column).join(", ") || "无 / none"}）`
        + `\n${TABLE_READ_GUIDANCE}`,
      data: result,
    };
  });

  register(server, catalog, {
    name: "data_aggregate",
    title: "分组统计 / Aggregate table data",
    sideEffect: "read",
    description: "对 .csv 或 .xlsx 直接算出结论需要的数字：先按 filters 过滤（filterMode=and/or），再按 groupBy 分组"
      + "（groupBy 为空表示整表一组），对每组执行 aggregations：count（不给 column 时是行数，给了是该列非空数）、"
      + "sum、mean、min、max、median、distinct，可用 as 指定输出列名，并支持 sort（按输出列名）与 limit。"
      + "数值解析是显式的：只接受数字、千分位、货币符号前缀与百分号后缀（\"12%\" 读作 12），"
      + "\"N/A\"、\"约 120\" 这类单元格不会被当成 0，而是计入 skipped，整组没有数值时该项返回 null 而不是 0。"
      + "返回 rows（每组一行）、columns（推断出的列类型与计数）、skipped 与 warnings。"
      + " Computes the numbers an analysis needs from a .csv or .xlsx instead of leaving the arithmetic"
      + " to the model: filter rows, group by zero or more columns (no groupBy means one group over the"
      + " whole table) and apply count (row count, or non-empty cells when a column is named), sum,"
      + " mean, min, max, median and distinct, with optional per-aggregation output names, sorting by an"
      + " output column and a row limit. Numeric parsing is explicit — plain numbers, thousands"
      + " separators, a currency prefix and a trailing percent sign (\"12%\" reads as 12) — and a cell"
      + " that is not a number is never coerced to 0: it is counted in `skipped` with samples, and an"
      + " aggregation whose group held no number at all returns null rather than a fake zero.",
    inputSchema: z.object({
      path: z.string().describe(`.csv 或 .xlsx 文件路径 / path to the .csv or .xlsx; ${ABSOLUTE_PATH_NOTE}`),
      sheet: z.string().optional().describe("工作表名或 1 开始的序号，仅对 .xlsx 有效 / sheet name or 1-based index, .xlsx only"),
      delimiter: z.string().optional().describe("CSV 分隔符，缺省自动判断 / CSV delimiter, auto-detected when omitted"),
      filters: z.array(z.object({
        column: z.string().describe("列名（表头）/ column header"),
        op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "notContains", "in", "notIn", "empty", "notEmpty"])
          .describe("比较方式；两侧都是数字时按数值比较 / comparison; numeric when both sides parse as numbers"),
        value: z.union([z.string(), z.number(), z.boolean()]).optional().describe("比较值 / value to compare against"),
        values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional().describe("in/notIn 的取值集合 / values for in and notIn"),
      })).optional().describe("行过滤条件 / row filters"),
      filterMode: z.enum(["and", "or"]).optional().describe("多个过滤条件的组合方式，默认 and / how filters combine, default and"),
      groupBy: z.array(z.string()).optional().describe("分组列，可为空 / grouping columns; empty means one group"),
      aggregations: z.array(z.object({
        op: z.enum(["count", "sum", "mean", "min", "max", "median", "distinct"]).describe("统计方式 / aggregation"),
        column: z.string().optional().describe("被统计的列；count 以外必须提供 / column to aggregate; required except for count"),
        as: z.string().optional().describe("输出列名，缺省为 <op>_<column> / output column name, defaults to <op>_<column>"),
      })).optional().describe("统计项，缺省为一次 count / aggregations, defaults to a single count"),
      sort: z.array(z.object({
        by: z.string().describe("输出列名（分组列或统计列）/ an output column name"),
        direction: z.enum(["asc", "desc"]).optional().describe("默认 asc / defaults to asc"),
      })).optional().describe("结果排序 / result ordering"),
      limit: z.number().int().min(1).optional().describe("最多返回的分组行数 / maximum result rows"),
    }),
  }, async (args) => {
    const file = await requireExistingFile("path", args.path);
    const filters: AggregateFilter[] | undefined = args.filters?.map((filter) => ({
      column: filter.column,
      op: filter.op,
      ...(filter.value === undefined ? {} : { value: filter.value }),
      ...(filter.values === undefined ? {} : { values: filter.values }),
    }));
    const aggregations: AggregateSpec[] | undefined = args.aggregations?.map((aggregation) => ({
      op: aggregation.op,
      ...(aggregation.column === undefined ? {} : { column: aggregation.column }),
      ...(aggregation.as === undefined ? {} : { as: aggregation.as }),
    }));
    const result = await dataAggregate({
      path: file,
      ...(args.sheet === undefined ? {} : { sheet: args.sheet }),
      ...(args.delimiter === undefined ? {} : { delimiter: args.delimiter }),
      ...(filters === undefined ? {} : { filters }),
      ...(args.filterMode === undefined ? {} : { filterMode: args.filterMode }),
      ...(args.groupBy === undefined ? {} : { groupBy: args.groupBy }),
      ...(aggregations === undefined ? {} : { aggregations }),
      ...(args.sort === undefined ? {} : { sort: args.sort }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });
    const dirty = result.skipped.reduce((total, entry) => total + entry.nonNumericCount, 0);
    return {
      // The hints ride on the summary line, not only inside `data`. A model that reads the first
      // line and stops is exactly the one that needs them: a real run answered office_014's
      // ungrouped call three times with byte-identical arguments, because "1 组 / 1 groups" never
      // said that no groupBy had been asked for. Empty for a well-formed call, so nothing is added
      // to the common case.
      summary: `data_aggregate: ${result.filteredRowCount}/${result.rowCount} 行 / rows → ${result.groupCount} 组 / groups`
        + `（统计 / aggregations: ${result.aggregations.map((entry) => entry.name).join(", ")}）`
        + (dirty > 0 ? `，${dirty} 个非数值单元格被跳过 / non-numeric cells skipped` : "")
        + result.hints.map((hint) => `\n${hint}`).join("")
        // After the hints: a hint says the numbers are not the ones that were asked for, which has
        // to be settled before there is anything worth writing out.
        + `\n${TABLE_READ_GUIDANCE}`,
      data: result,
    };
  });

  register(server, catalog, {
    name: "fs_find",
    title: "查找文件 / Find files",
    sideEffect: "read",
    description: "在目录树中按文件名片段和扩展名查找文件，返回绝对路径、大小与修改时间；默认递归。"
      + " Finds files under a directory tree by name fragment and extension and returns absolute paths,"
      + " sizes and modification times; recursive by default and case-insensitive on the name fragment.",
    inputSchema: z.object({
      root: z.string().describe(`搜索起点目录 / directory to search; ${ABSOLUTE_PATH_NOTE}`),
      nameContains: z.string().optional().describe("文件名包含的片段，例如 \"西安\" / name fragment"),
      extensions: z.array(z.string()).optional().describe("扩展名过滤，例如 [\".docx\", \"xlsx\"] / extension filter"),
      recursive: z.boolean().optional().describe("是否递归子目录，默认 true / recurse into subdirectories, default true"),
      maxResults: z.number().int().min(1).optional().describe("最多返回的文件数 / maximum files to return"),
    }),
  }, async (args) => {
    const result = await fsFind({
      root: args.root,
      ...(args.nameContains === undefined ? {} : { nameContains: args.nameContains }),
      ...(args.extensions === undefined ? {} : { extensions: args.extensions }),
      ...(args.recursive === undefined ? {} : { recursive: args.recursive }),
      ...(args.maxResults === undefined ? {} : { maxResults: args.maxResults }),
    });
    return {
      summary: `fs_find: ${result.files.length} 个文件 / files under ${result.root}${result.truncated ? "（已截断 / truncated）" : ""}`,
      data: result,
    };
  });

  register(server, catalog, {
    name: "fs_delete",
    title: "删除文件 / Delete files",
    sideEffect: "external",
    description: "只删除文件，从不删除目录：可直接给 paths，或给 root + nameContains/extensions 批量删除（例如删除名字含 \"西安\" 的文件）。"
      + "拒绝驱动器根目录与 Windows 系统目录；dryRun=true 只列出将要删除的文件。"
      + " Deletes files and only files — directories are reported as skipped, never removed. Either name"
      + " the paths or select them with root plus nameContains/extensions. Drive roots and Windows system"
      + " directories are refused, and dryRun:true lists what would be deleted without touching anything.",
    inputSchema: z.object({
      paths: z.array(z.string()).optional().describe(`要删除的文件绝对路径 / absolute file paths to delete`),
      root: z.string().optional().describe(`按条件删除时的起点目录 / directory to select files under; ${ABSOLUTE_PATH_NOTE}`),
      nameContains: z.string().optional().describe("文件名包含的片段 / name fragment"),
      extensions: z.array(z.string()).optional().describe("扩展名过滤 / extension filter"),
      recursive: z.boolean().optional().describe("是否递归，默认 true / recurse, default true"),
      dryRun: z.boolean().optional().describe("只列出不删除，默认 false / list without deleting, default false"),
    }),
  }, async (args) => {
    const result = await fsDelete({
      ...(args.paths === undefined ? {} : { paths: args.paths }),
      ...(args.root === undefined ? {} : { root: args.root }),
      ...(args.nameContains === undefined ? {} : { nameContains: args.nameContains }),
      ...(args.extensions === undefined ? {} : { extensions: args.extensions }),
      ...(args.recursive === undefined ? {} : { recursive: args.recursive }),
      ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
    });
    return {
      summary: result.dryRun
        ? `fs_delete(dryRun): 命中 ${result.matched.length} 个文件 / ${result.matched.length} file(s) would be deleted`
        : `fs_delete: 已删除 ${result.deleted.length} 个文件，失败 ${result.failed.length} /`
          + ` deleted ${result.deleted.length}, failed ${result.failed.length}`,
      data: result,
    };
  });
}

function registerVerifyTools(server: McpServer, catalog: ToolInfo[]): void {
  register(server, catalog, {
    name: "doc_verify",
    title: "校验产出文件 / Verify a produced document",
    sideEffect: "read",
    description: "在声称完成之前校验刚写出的文件：按真实内容而不是扩展名判断格式（.docx/.xlsx/.pptx 会实际打开 OOXML 包），"
      + "并逐项检查可选期望：minBytes、mustContain/mustNotContain（文档可见文本）、minTables（.docx/.pptx）、"
      + "minSlides/maxSlides（.pptx）、minSheets/sheetNames（.xlsx）、minCjkChars/maxCjkChars（按评测口径统计"
      + " U+3400-U+9FFF 的中文字符）。.md/.txt/.csv 只做存在性、minBytes、mustContain 与中文字数检查。"
      + "不满足期望不是错误：返回 ok=false 与 failures[{check,expected,actual}]，请据此修复后重新生成，"
      + "ok=false 时不要宣称任务完成。"
      + " Verifies a file you just produced, before you claim it is done. The format is decided by"
      + " parsing the bytes, not by the extension: a text file saved under a .docx name is reported as"
      + " not a valid Office document instead of passing. Optional expectations are checked one by one —"
      + " minBytes, mustContain/mustNotContain against the document's visible text, minTables (.docx and"
      + " .pptx), minSlides/maxSlides (.pptx), minSheets/sheetNames (.xlsx) and minCjkChars/maxCjkChars"
      + " counting the U+3400-U+9FFF range the evaluation grader itself uses; .md, .txt and .csv get"
      + " existence, minBytes, mustContain and the CJK count. An unmet expectation is not an error: the"
      + " result carries ok=false and failures[{check,expected,actual}] so you can fix the file and try"
      + " again. Do not report completion while ok is false.",
    inputSchema: z.object({
      path: z.string().describe(`要校验的文件 / the file to verify; ${ABSOLUTE_PATH_NOTE}`),
      minBytes: z.number().int().min(1).optional()
        .describe("最小文件字节数 / minimum file size in bytes"),
      mustContain: z.array(z.string()).optional()
        .describe("文档可见文本必须包含的字符串 / strings that must appear in the document's visible text"),
      mustNotContain: z.array(z.string()).optional()
        .describe("文档可见文本不得包含的字符串 / strings that must not appear"),
      minTables: z.number().int().min(0).optional().describe("最少表格数（.docx/.pptx）/ minimum tables (.docx, .pptx)"),
      minSlides: z.number().int().min(0).optional().describe("最少幻灯片页数（.pptx）/ minimum slides (.pptx)"),
      maxSlides: z.number().int().min(0).optional().describe("最多幻灯片页数（.pptx）/ maximum slides (.pptx)"),
      minSheets: z.number().int().min(0).optional().describe("最少工作表数（.xlsx）/ minimum sheets (.xlsx)"),
      sheetNames: z.array(z.string()).optional().describe("必须存在的工作表名（.xlsx）/ sheet names that must exist (.xlsx)"),
      minCjkChars: z.number().int().min(0).optional()
        .describe("最少中文字符数（U+3400-U+9FFF）/ minimum CJK characters in the U+3400-U+9FFF range"),
      maxCjkChars: z.number().int().min(0).optional()
        .describe("最多中文字符数（U+3400-U+9FFF）/ maximum CJK characters in the U+3400-U+9FFF range"),
    }),
  }, async (args) => {
    const file = await requireExistingFile("path", args.path);
    const result = await docVerify(file, {
      ...(args.minBytes === undefined ? {} : { minBytes: args.minBytes }),
      ...(args.mustContain === undefined ? {} : { mustContain: args.mustContain }),
      ...(args.mustNotContain === undefined ? {} : { mustNotContain: args.mustNotContain }),
      ...(args.minTables === undefined ? {} : { minTables: args.minTables }),
      ...(args.minSlides === undefined ? {} : { minSlides: args.minSlides }),
      ...(args.maxSlides === undefined ? {} : { maxSlides: args.maxSlides }),
      ...(args.minSheets === undefined ? {} : { minSheets: args.minSheets }),
      ...(args.sheetNames === undefined ? {} : { sheetNames: args.sheetNames }),
      ...(args.minCjkChars === undefined ? {} : { minCjkChars: args.minCjkChars }),
      ...(args.maxCjkChars === undefined ? {} : { maxCjkChars: args.maxCjkChars }),
    });
    const shape = `${result.kind}，${result.bytes} 字节 / bytes，${result.cjkChars} 中文字符 / CJK chars`;
    return {
      // A failed verification is reported as a successful call with ok:false: the model has to read
      // the failures and fix the file, and an error result would invite it to retry the tool instead.
      summary: result.ok
        ? `doc_verify: 通过 / PASS（${shape}）${file}`
        : `doc_verify: 未通过 / FAIL，${result.failures.length} 项不符 / ${result.failures.length} check(s) failed`
          + `（${result.failures.map((failure) => failure.check).join(", ")}；${shape}）${file}`,
      data: result,
    };
  });
}

function registerSystemTools(server: McpServer, catalog: ToolInfo[]): void {
  register(server, catalog, {
    name: "app_open",
    title: "打开应用 / Open an application",
    sideEffect: "external",
    description: "在 Windows 上用 PowerShell 的 Start-Process 打开应用（如 outlook、winword、excel）；"
      + "name 只能是应用名，不能包含路径分隔符或 shell 元字符。非 Windows 平台返回错误。"
      + " Launches an installed application through Windows PowerShell's Start-Process (for example"
      + " outlook). The name must be a bare application name; anything with a path separator or a shell"
      + " metacharacter is refused. Windows only.",
    inputSchema: z.object({
      name: z.string().describe("应用名，例如 outlook / application name, e.g. outlook"),
    }),
  }, async (args) => {
    const result = await appOpen(args.name);
    return { summary: `app_open: 已启动 / launched ${result.name}（${result.command}）`, data: result };
  });

  register(server, catalog, {
    name: "web_fetch",
    title: "抓取网页 / Fetch a web page",
    sideEffect: "external",
    description: "GET 一个 http/https 地址，HTML 转为纯文本（保留 <title>），按 maxBytes 截断。"
      + " Fetches an http or https URL and returns the page as plain text with its title; the body is"
      + " capped at maxBytes and the request at timeoutMs.",
    inputSchema: z.object({
      url: z.string().describe("http/https 地址 / http or https URL"),
      maxBytes: z.number().int().min(1024).optional().describe(`最多读取的字节数，默认 ${DEFAULT_MAX_BYTES} / byte cap`),
      timeoutMs: z.number().int().min(1000).optional().describe(`超时毫秒，默认 ${DEFAULT_TIMEOUT_MS} / request timeout`),
    }),
  }, async (args) => {
    const result = await webFetch(args.url, args.maxBytes, args.timeoutMs);
    return {
      summary: `web_fetch: HTTP ${result.status}，${result.bytes} 字节 / bytes${result.truncated ? "（已截断 / truncated）" : ""}`
        + ` ${result.title === undefined ? "" : `— ${result.title}`}`,
      data: result,
    };
  });
}

export function createOfficeServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
    instructions: "Office 文档工具：路径一律使用绝对路径，写入类工具默认不覆盖已存在的文件（需要覆盖时传 overwrite:true）。"
      + " Office document tools. All paths are absolute; write tools refuse to replace an existing file"
      + " unless overwrite:true is passed.",
  });
  const catalog: ToolInfo[] = [];
  registerDocxTools(server, catalog);
  registerXlsxTools(server, catalog);
  registerPptxTools(server, catalog);
  registerDataTools(server, catalog);
  registerVerifyTools(server, catalog);
  registerSystemTools(server, catalog);
  register(server, catalog, {
    name: "server_info",
    title: "服务器信息 / Server information",
    sideEffect: "read",
    description: "返回本服务器的版本、运行平台与全部工具清单（含读写副作用标记）。"
      + " Reports this server's version, host platform and the full tool list with each tool's side effect.",
    inputSchema: z.object({}),
  }, async () => ({
    summary: `server_info: ${SERVER_NAME} ${SERVER_VERSION}，${catalog.length} 个工具 / tools，platform ${process.platform}`,
    data: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      platform: process.platform,
      nodeVersion: process.versions.node,
      tools: catalog,
    },
  }));
  return server;
}

