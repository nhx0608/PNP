/**
 * Routing guidance that rides on a read tool's own result.
 *
 * Why it is here and not only in the tool descriptions: a description is read once, when the tool
 * list is offered; the next call is decided from the result the model just received. Evaluation case
 * office_011 is the proof. Asked to rewrite two paragraphs of a .docx and save the result as a new
 * .docx, a run against OpenCode + GLM-4-Flash read the file correctly with docx_extract — whose
 * description does say the indexes feed docx_replace_paragraphs — and then never called
 * docx_replace_paragraphs once. It tried the engine's native `edit` three times, fell through to the
 * native `write`, and produced one paragraph of plain text under a .docx name while reporting
 * success. The extraction result it was looking at said only "9 段落 / paragraphs, 0 表格 / tables";
 * nothing in it named a tool that writes a .docx back.
 *
 * So each line below names the write tool for that document kind and the parameter that answers the
 * question the model could not answer — outputPath, which is how "save as a new file" is expressed —
 * and says plainly where the engine's own write tool is the right one (a .md or .txt conclusion), so
 * the guidance cannot push a model away from a native tool that was already correct. This is the
 * same defect class, and the same fix, as data_aggregate's `hints` (see aggregate.ts).
 *
 * Nothing here is computed from the document: these are constants about the tool catalogue, appended
 * to the summary line, and no tool's returned data changes because of them.
 */

/** Marks the guidance line so it reads as an instruction to the caller, not as part of the report. */
const NEXT = "下一步 / next: ";

export const DOCX_EXTRACT_GUIDANCE = NEXT
  + "改写本文档用 docx_replace_paragraphs（path 传本文件，replacements[].index 用上面的段落索引，"
  + "outputPath 传一个新的 .docx 就是另存为，原文件不动）；从零新建用 docx_create。"
  + "引擎自带的 write/edit 写不出 .docx，只会生成一个扩展名叫 .docx 的纯文本文件。"
  + " / Write back with docx_replace_paragraphs (path = this file, replacements[].index = the paragraph"
  + " indexes above, outputPath = a new .docx, which is how save-as is done and leaves the source"
  + " untouched), or docx_create for a document built from scratch. The engine's own write/edit tools"
  + " cannot produce a .docx; they only produce plain text under a .docx name.";

export const XLSX_READ_GUIDANCE = NEXT
  + "要写出工作簿用 xlsx_write（outputPath 传新的 .xlsx，sheets 是 [{name, rows}]，一个元素一个工作表）；"
  + "只要分组统计结论用 data_aggregate。引擎自带的 write 写不出 .xlsx。"
  + " / Produce a workbook with xlsx_write (outputPath = the new .xlsx, sheets = [{name, rows}], one"
  + " entry per worksheet); use data_aggregate when only grouped statistics are wanted. The engine's"
  + " own write tool cannot produce an .xlsx.";

export const PPTX_EXTRACT_GUIDANCE = NEXT
  + "改文字用 pptx_replace_text（slide 加上面的 shapeId），调整顺序用 pptx_reorder_slides，"
  + "删页用 pptx_delete_slides，从零新建整份用 pptx_create；前三个都要 outputPath，"
  + "传一个新的 .pptx 就是另存为，原文件不动。引擎自带的 write 写不出 .pptx。"
  + " / pptx_replace_text edits a shape's text (a slide index plus a shapeId above),"
  + " pptx_reorder_slides reorders, pptx_delete_slides drops slides, and pptx_create builds a new"
  + " deck; the first three take outputPath, where a new .pptx is the save-as and leaves the source"
  + " untouched. The engine's own write tool cannot produce a .pptx.";

export const TABLE_READ_GUIDANCE = NEXT
  + "结论写成 .md 或 .txt 时，直接用引擎自带的写文件工具即可，这类纯文本文件不需要 office 工具；"
  + "要产出 .xlsx 用 xlsx_write，要产出 .docx 用 docx_create；写完可用 doc_verify 复核。"
  + " / A Markdown or plain-text conclusion is written with the engine's own file-writing tool — that"
  + " is the right tool for a .md or .txt. Only an .xlsx (xlsx_write) or a .docx (docx_create) needs a"
  + " tool from this server; doc_verify checks whatever was written.";

/**
 * How each Office format is really produced, for the verdict on a file that carries the extension
 * without the bytes. office_011's artefact — plain text named .docx — is exactly what doc_verify
 * catches, and a model that has just been told the file is invalid still needs to be told which tool
 * would not have produced it.
 */
const WRITERS = new Map<string, { zh: string; en: string }>([
  [".docx", {
    zh: "docx_create（从零新建）或 docx_replace_paragraphs（改写原文并写入 outputPath）",
    en: "docx_create, or docx_replace_paragraphs writing to outputPath",
  }],
  [".xlsx", {
    zh: "xlsx_write（outputPath 传新工作簿）",
    en: "xlsx_write, with outputPath set to the new workbook",
  }],
  [".pptx", {
    zh: "pptx_create（从零新建）或 pptx_replace_text（改写原稿并写入 outputPath）",
    en: "pptx_create, or pptx_replace_text writing to outputPath",
  }],
]);

/**
 * The remedy clause for a format failure, or "" for an extension this server does not write — an
 * empty string keeps the caller's concatenation unconditional without inventing advice. The two
 * languages are held apart on purpose: a single bilingual fragment interpolated into both halves
 * produces a sentence that reads as neither.
 */
export function writerRemedyFor(extension: string): string {
  const writers = WRITERS.get(extension);
  if (writers === undefined) return "";
  return `；请改用 ${writers.zh}重新生成，通用写文件工具写不出 ${extension}`
    + ` / regenerate it with ${writers.en}; a generic file-writing tool cannot produce ${extension} files`;
}
