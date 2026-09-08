import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CsvReadResult } from "../../../src/tools/office-mcp/csv.ts";
import type { DeleteResult, FindResult } from "../../../src/tools/office-mcp/files.ts";
import { removeTree } from "../../kit/fs.ts";
import { expectError, makeWorkspace, startOfficeClient, structured, writeFixtureCsv, type ToolResult } from "./harness.ts";

let session: Awaited<ReturnType<typeof startOfficeClient>> | null = null;
async function connect(): Promise<Client> {
  session ??= await startOfficeClient();
  return session.client;
}
after(async () => {
  if (session !== null) await session.stop();
});

test("csv_read returns headers, rows and per-column statistics", async () => {
  const workspace = await makeWorkspace("csv");
  try {
    const source = path.join(workspace, "库存.csv");
    await writeFixtureCsv(source);
    const client = await connect();
    const result = structured<CsvReadResult>(await client.callTool({ name: "csv_read", arguments: { path: source } }));
    assert.deepEqual(result.headers, ["物料名称", "库存数量", "单价"], "the UTF-8 BOM must not leak into the first header");
    assert.equal(result.delimiter, ",");
    assert.equal(result.rowCount, 3);
    assert.deepEqual(result.rows[0], ["螺栓", "120", "1.5"]);
    const quantity = result.numericColumns.find((column) => column.column === "库存数量");
    assert.ok(quantity !== undefined, "库存数量 must be recognised as a numeric column");
    assert.deepEqual(
      { count: quantity.count, min: quantity.min, max: quantity.max, sum: quantity.sum, mean: quantity.mean },
      { count: 3, min: 10, max: 120, sum: 175, mean: 58.333333 },
    );
    const price = result.numericColumns.find((column) => column.column === "单价");
    assert.equal(price?.sum, 27.3);
    const name = result.textColumns.find((column) => column.column === "物料名称");
    assert.equal(name?.distinctCount, 3);

    const limited = structured<CsvReadResult>(await client.callTool({
      name: "csv_read", arguments: { path: source, maxRows: 1 },
    }));
    assert.equal(limited.returnedRows, 1);
    assert.equal(limited.truncated, true);
    assert.equal(limited.rowCount, 3, "statistics and totals still cover every row");
    assert.equal(limited.numericColumns.find((column) => column.column === "库存数量")?.count, 3);
  } finally {
    await removeTree(workspace);
  }
});

async function makeTree(root: string): Promise<void> {
  await mkdir(path.join(root, "子目录"), { recursive: true });
  await mkdir(path.join(root, "西安归档"), { recursive: true });
  await writeFile(path.join(root, "西安分公司报表.docx"), "a", "utf8");
  await writeFile(path.join(root, "北京分公司报表.docx"), "b", "utf8");
  await writeFile(path.join(root, "子目录", "西安库存.xlsx"), "c", "utf8");
  await writeFile(path.join(root, "子目录", "其他.txt"), "d", "utf8");
  await writeFile(path.join(root, "西安归档", "报表.docx"), "e", "utf8");
}

test("fs_find matches by name fragment across the tree and reports matching directories separately", async () => {
  const workspace = await makeWorkspace("fs-find");
  try {
    await makeTree(workspace);
    const client = await connect();
    const found = structured<FindResult>(await client.callTool({
      name: "fs_find", arguments: { root: workspace, nameContains: "西安" },
    }));
    assert.deepEqual(found.files.map((file) => path.basename(file.path)).sort(),
      ["西安分公司报表.docx", "西安库存.xlsx"]);
    assert.deepEqual(found.directories.map((directory) => directory.name), ["西安归档"]);
    assert.ok(found.files.every((file) => path.isAbsolute(file.path)), "paths must come back absolute");

    const shallow = structured<FindResult>(await client.callTool({
      name: "fs_find", arguments: { root: workspace, nameContains: "西安", recursive: false },
    }));
    assert.deepEqual(shallow.files.map((file) => path.basename(file.path)), ["西安分公司报表.docx"]);

    const byExtension = structured<FindResult>(await client.callTool({
      name: "fs_find", arguments: { root: workspace, extensions: ["docx"] },
    }));
    assert.equal(byExtension.files.length, 3);
  } finally {
    await removeTree(workspace);
  }
});

test("fs_delete previews first, then deletes only the matching files and never a directory", async () => {
  const workspace = await makeWorkspace("fs-delete");
  try {
    await makeTree(workspace);
    const client = await connect();
    const preview = structured<DeleteResult>(await client.callTool({
      name: "fs_delete", arguments: { root: workspace, nameContains: "西安", dryRun: true },
    }));
    assert.equal(preview.dryRun, true);
    assert.equal(preview.matched.length, 2);
    assert.equal(preview.deleted.length, 0);
    assert.ok(existsSync(path.join(workspace, "西安分公司报表.docx")), "a dry run must not delete anything");

    const deleted = structured<DeleteResult>(await client.callTool({
      name: "fs_delete", arguments: { root: workspace, nameContains: "西安" },
    }));
    assert.deepEqual(deleted.deleted.map((file) => path.basename(file)).sort(), ["西安分公司报表.docx", "西安库存.xlsx"]);
    assert.equal(deleted.failed.length, 0);
    assert.deepEqual(deleted.skippedDirectories.map((directory) => path.basename(directory)), ["西安归档"]);
    assert.ok(!existsSync(path.join(workspace, "西安分公司报表.docx")));
    assert.ok(existsSync(path.join(workspace, "北京分公司报表.docx")), "files that do not match must be left alone");
    assert.ok(existsSync(path.join(workspace, "西安归档", "报表.docx")), "a matching directory must survive with its contents");

    const missing = structured<DeleteResult>(await client.callTool({
      name: "fs_delete", arguments: { paths: [path.join(workspace, "不存在.docx")] },
    }));
    assert.equal(missing.deleted.length, 0);
    assert.equal(missing.failed.length, 1);
  } finally {
    await removeTree(workspace);
  }
});

test("fs_delete refuses a drive root, a relative path and an unfiltered tree", async () => {
  const workspace = await makeWorkspace("fs-guard");
  try {
    await makeTree(workspace);
    const client = await connect();
    expectError(await client.callTool({
      name: "fs_delete", arguments: { root: path.parse(tmpdir()).root, nameContains: "西安", dryRun: true },
    }) as ToolResult, "PROTECTED_LOCATION");
    expectError(await client.callTool({
      name: "fs_delete", arguments: { paths: ["西安分公司报表.docx"] },
    }) as ToolResult, "PATH_NOT_ABSOLUTE");
    expectError(await client.callTool({
      name: "fs_delete", arguments: { root: workspace },
    }) as ToolResult, "INVALID_ARGUMENT");
    assert.ok(existsSync(path.join(workspace, "西安分公司报表.docx")), "a refused delete must not have deleted anything");
  } finally {
    await removeTree(workspace);
  }
});
