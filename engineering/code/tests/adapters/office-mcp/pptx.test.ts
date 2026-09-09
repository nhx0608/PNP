import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  PptxDeleteResult, PptxExtraction, PptxReorderResult, PptxReplaceResult,
} from "../../../src/tools/office-mcp/pptx.ts";
import type { PptxCreateResult } from "../../../src/tools/office-mcp/pptx-create.ts";
import { removeTree } from "../../kit/fs.ts";
import {
  expectError, makeWorkspace, PPTX_CHART_LABELS, PPTX_CHART_SERIES, PPTX_CHART_VALUES, PPTX_TABLE_ROWS, PPTX_TITLES,
  startOfficeClient, structured, writeFixturePptx, writeFixturePptxWithData, type ToolResult,
} from "./harness.ts";

let session: Awaited<ReturnType<typeof startOfficeClient>> | null = null;
async function connect(): Promise<Client> {
  session ??= await startOfficeClient();
  return session.client;
}
after(async () => {
  if (session !== null) await session.stop();
});

async function partXml(file: string, part: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(file));
  const entry = zip.file(part);
  assert.ok(entry !== null, `output package has no ${part}`);
  return entry.async("string");
}

test("pptx_extract reports slides in presentation order with their shapes and notes", async () => {
  const workspace = await makeWorkspace("pptx-extract");
  try {
    const source = path.join(workspace, "西安汇报.pptx");
    await writeFixturePptx(source);
    const client = await connect();
    const extraction = structured<PptxExtraction>(await client.callTool({ name: "pptx_extract", arguments: { path: source } }));
    assert.equal(extraction.slideCount, 3);
    assert.deepEqual(extraction.slides.map((slide) => slide.index), [1, 2, 3]);
    assert.deepEqual(extraction.slides.map((slide) => slide.title), PPTX_TITLES);
    assert.deepEqual(extraction.slides.map((slide) => slide.notes), ["备注 1", "备注 2", "备注 3"]);
    assert.equal(extraction.slides[0]?.texts.length, 3);
    assert.equal(extraction.slides[0]?.texts[1]?.text, "要点 1A\n要点 1B");
    assert.ok((extraction.slides[0]?.texts[0]?.shapeId ?? "").length > 0, "every shape needs an addressable id");
    assert.equal(extraction.tableCount, 0);
    assert.equal(extraction.chartCount, 0);
  } finally {
    await removeTree(workspace);
  }
});

test("pptx_extract reports the data points held in a slide table and in a chart's cached values", async () => {
  const workspace = await makeWorkspace("pptx-data");
  try {
    const source = path.join(workspace, "差异化分析.pptx");
    await writeFixturePptxWithData(source);
    const client = await connect();
    const extraction = structured<PptxExtraction>(await client.callTool({ name: "pptx_extract", arguments: { path: source } }));
    assert.equal(extraction.slideCount, 2);
    assert.equal(extraction.tableCount, 1);
    assert.equal(extraction.chartCount, 1);

    const table = extraction.slides[0]?.tables?.[0];
    assert.ok(table !== undefined, "a table inside a graphicFrame must not be invisible to the extractor");
    assert.deepEqual(table.rows, PPTX_TABLE_ROWS, "cells come back as rows, not flattened into one string");
    assert.equal(table.rowCount, 3);
    assert.equal(table.columnCount, 2);
    assert.ok(table.shapeId.length > 0);

    const chart = extraction.slides[1]?.charts?.[0];
    assert.ok(chart !== undefined, "a chart's numbers must be readable, or a restructure cannot preserve them");
    assert.match(chart.part, /^ppt\/charts\//);
    assert.ok(chart.chartTypes.includes("barChart"), `expected a bar chart, got ${chart.chartTypes.join(", ")}`);
    assert.equal(chart.series.length, 1);
    assert.equal(chart.series[0]?.name, PPTX_CHART_SERIES);
    assert.deepEqual(chart.series[0]?.categories, PPTX_CHART_LABELS);
    assert.deepEqual(chart.series[0]?.values, PPTX_CHART_VALUES,
      "cached numbers must come back as numbers so they can be compared before and after an edit");

    assert.ok((extraction.slides[0]?.texts.length ?? 0) > 0, "the existing shape texts must still be reported");
    assert.equal(extraction.slides[0]?.charts, undefined, "a slide without charts carries no chart list");
  } finally {
    await removeTree(workspace);
  }
});

test("pptx_replace_text rewrites a shape by id and by match while keeping its run formatting", async () => {
  const workspace = await makeWorkspace("pptx-replace");
  try {
    const source = path.join(workspace, "汇报.pptx");
    const target = path.join(workspace, "输出", "汇报-改.pptx");
    await writeFixturePptx(source);
    const client = await connect();
    const before = structured<PptxExtraction>(await client.callTool({ name: "pptx_extract", arguments: { path: source } }));
    const titleShape = before.slides[0]?.texts[0];
    assert.ok(titleShape !== undefined);

    const replaced = structured<PptxReplaceResult>(await client.callTool({
      name: "pptx_replace_text",
      arguments: {
        path: source,
        outputPath: target,
        edits: [
          { slide: 1, shapeId: titleShape.shapeId, text: "结论：整改已完成" },
          { slide: 2, match: "要点 2A", text: "证据一\n证据二" },
        ],
      },
    }));
    assert.equal(replaced.edits.length, 2);
    assert.equal(replaced.edits[0]?.previousText, PPTX_TITLES[0]);

    const after = structured<PptxExtraction>(await client.callTool({ name: "pptx_extract", arguments: { path: target } }));
    assert.equal(after.slides[0]?.title, "结论：整改已完成");
    assert.equal(after.slides[1]?.texts[1]?.text, "证据一\n证据二");
    assert.equal(after.slides[0]?.notes, "备注 1", "notes must survive a text edit");
    assert.equal(after.slideCount, 3);

    const slidePart = after.slides[0]?.part;
    assert.ok(slidePart !== undefined);
    const xml = await partXml(target, slidePart);
    assert.match(xml, /sz="2800"/, "the title run size must be preserved");
    assert.match(xml, /b="1"/, "the bold run property must be preserved");

    const original = structured<PptxExtraction>(await client.callTool({ name: "pptx_extract", arguments: { path: source } }));
    assert.equal(original.slides[0]?.title, PPTX_TITLES[0], "the input deck must not be modified");
  } finally {
    await removeTree(workspace);
  }
});

test("pptx_reorder_slides changes the order and pptx_delete_slides drops a slide", async () => {
  const workspace = await makeWorkspace("pptx-order");
  try {
    const source = path.join(workspace, "汇报.pptx");
    const reordered = path.join(workspace, "重排.pptx");
    const trimmed = path.join(workspace, "删页.pptx");
    await writeFixturePptx(source);
    const client = await connect();

    const order = structured<PptxReorderResult>(await client.callTool({
      name: "pptx_reorder_slides", arguments: { path: source, outputPath: reordered, order: [3, 1, 2] },
    }));
    assert.deepEqual(order.order, [3, 1, 2]);
    const afterOrder = structured<PptxExtraction>(await client.callTool({ name: "pptx_extract", arguments: { path: reordered } }));
    assert.deepEqual(afterOrder.slides.map((slide) => slide.title), [PPTX_TITLES[2], PPTX_TITLES[0], PPTX_TITLES[1]]);
    assert.deepEqual(afterOrder.slides.map((slide) => slide.notes), ["备注 3", "备注 1", "备注 2"]);

    const deleted = structured<PptxDeleteResult>(await client.callTool({
      name: "pptx_delete_slides", arguments: { path: source, outputPath: trimmed, slides: [2] },
    }));
    assert.equal(deleted.remainingSlides, 2);
    const afterDelete = structured<PptxExtraction>(await client.callTool({ name: "pptx_extract", arguments: { path: trimmed } }));
    assert.deepEqual(afterDelete.slides.map((slide) => slide.title), [PPTX_TITLES[0], PPTX_TITLES[2]]);
    assert.deepEqual(afterDelete.slides.map((slide) => slide.notes), ["备注 1", "备注 3"]);
  } finally {
    await removeTree(workspace);
  }
});

test("pptx tools refuse an incomplete order, an out-of-range slide and an ambiguous match", async () => {
  const workspace = await makeWorkspace("pptx-errors");
  try {
    const source = path.join(workspace, "汇报.pptx");
    await writeFixturePptx(source);
    const client = await connect();
    const target = path.join(workspace, "out.pptx");

    expectError(await client.callTool({
      name: "pptx_reorder_slides", arguments: { path: source, outputPath: target, order: [2, 1] },
    }) as ToolResult, "INVALID_ARGUMENT");

    expectError(await client.callTool({
      name: "pptx_replace_text", arguments: { path: source, outputPath: target, edits: [{ slide: 9, text: "x" }] },
    }) as ToolResult, "INDEX_OUT_OF_RANGE");

    expectError(await client.callTool({
      name: "pptx_replace_text",
      arguments: { path: source, outputPath: target, edits: [{ slide: 1, match: "第", text: "x" }] },
    }) as ToolResult, "AMBIGUOUS_MATCH");

    expectError(await client.callTool({
      name: "pptx_delete_slides", arguments: { path: source, outputPath: target, slides: [1, 2, 3] },
    }) as ToolResult, "INVALID_ARGUMENT");
  } finally {
    await removeTree(workspace);
  }
});

test("pptx_create builds a deck from an outline that pptx_extract reads back", async () => {
  const workspace = await makeWorkspace("pptx-create");
  try {
    const target = path.join(workspace, "生成", "五页.pptx");
    const client = await connect();
    const slides = Array.from({ length: 5 }, (_unused, index) => ({
      title: `第 ${index + 1} 页标题`,
      bullets: [`要点 ${index + 1}-1`, `要点 ${index + 1}-2`],
      notes: `讲稿 ${index + 1}`,
    }));
    const created = structured<PptxCreateResult>(await client.callTool({
      name: "pptx_create",
      arguments: {
        outputPath: target,
        slides,
        theme: { titleColor: "#1F4E79", bodyColor: "333333", backgroundColor: "FFFFFF", fontFace: "微软雅黑" },
      },
    }));
    assert.equal(created.slideCount, 5);
    const extraction = structured<PptxExtraction>(await client.callTool({ name: "pptx_extract", arguments: { path: target } }));
    assert.equal(extraction.slideCount, 5);
    assert.deepEqual(extraction.slides.map((slide) => slide.title), slides.map((slide) => slide.title));
    assert.equal(extraction.slides[0]?.notes, "讲稿 1");
    assert.ok(extraction.slides[4]?.texts.some((shape) => shape.text.includes("要点 5-2")));

    expectError(await client.callTool({
      name: "pptx_create", arguments: { outputPath: path.join(workspace, "坏色.pptx"), slides, theme: { titleColor: "红色" } },
    }) as ToolResult, "INVALID_ARGUMENT");
  } finally {
    await removeTree(workspace);
  }
});
