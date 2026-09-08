import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { csvRead } from "./csv.ts";
import { docxExtract, docxReplaceParagraphs } from "./docx.ts";
import { docxCreate, type DocxBlock } from "./docx-create.ts";
import { fsDelete, fsFind } from "./files.ts";
import { prepareOutputPath, requireExistingFile } from "./paths.ts";
import { pptxDeleteSlides, pptxExtract, pptxReorderSlides, pptxReplaceText } from "./pptx.ts";
import { MAX_SLIDES, pptxCreate } from "./pptx-create.ts";
import { annotationsFor, failureResult, successResult, type SideEffect, type ToolPayload } from "./results.ts";
import { appOpen, DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, webFetch } from "./system.ts";
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
      + " Extracts paragraphs, tables and headings from a .docx in document order; paragraph indexes are"
      + " zero-based and are exactly the indexes docx_replace_paragraphs accepts.",
    inputSchema: z.object({ path: z.string().describe(`.docx 文件路径 / path to the .docx file; ${ABSOLUTE_PATH_NOTE}`) }),
  }, async (args) => {
    const file = await requireExistingFile("path", args.path);
    const extraction = await docxExtract(file);
    return {
      summary: `docx_extract: ${extraction.paragraphCount} 段落 / paragraphs, ${extraction.tableCount} 表格 / tables (${file})`,
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
        + `（全部工作表 / all sheets: ${result.sheets.join(", ")}）`,
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
      + " Extracts every slide in presentation order (as stored in p:sldIdLst, not by file name) with its"
      + " title, shape texts and speaker notes; slide indexes are 1-based and shapeIds feed pptx_replace_text.",
    inputSchema: z.object({ path: z.string().describe(`.pptx 文件路径 / path to the deck; ${ABSOLUTE_PATH_NOTE}`) }),
  }, async (args) => {
    const file = await requireExistingFile("path", args.path);
    const result = await pptxExtract(file);
    return { summary: `pptx_extract: ${result.slideCount} 页 / slides (${file})`, data: result };
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
        + `（数值列 / numeric: ${result.numericColumns.map((column) => column.column).join(", ") || "无 / none"}）`,
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

