# Office MCP 服务器 / Office MCP server

一个 stdio 传输的 MCP 服务器，给两个引擎（OpenCode、Pi）提供 Word / Excel / PowerPoint / CSV /
文件 / 系统能力，使评测任务在 Windows 上无需 Python、Git Bash 或 COM 即可完成文档改写与生成。

A stdio MCP server that gives both engines the Word, Excel, PowerPoint, CSV, filesystem and system
tools an evaluation task needs, so document work on Windows needs neither Python nor Git Bash.

入口 / entry point: `node dist/tools/office-mcp/main.js` （源码 `src/tools/office-mcp/main.ts`）。
stdout 只承载 JSON-RPC，日志一律走 stderr。

## 网关接线 / How the gateway wires it

`config/settings.json`：

```json
{
  "common": {
    "mcp": {
      "servers": {
        "office": {
          "transport": "stdio",
          "command": "${PNP_NODE}",
          "args": ["${PNP_CODE_ROOT}/dist/tools/office-mcp/main.js"],
          "env": {},
          "enabled": true,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`${PNP_NODE}`（包内 Node 可执行文件）与 `${PNP_CODE_ROOT}`（`engineering/code` 的绝对路径）由设置
加载时展开（WP1），因此交付包换一个解压目录也不需要改配置。OpenCode 通过原生 MCP 配置拿到它，Pi 通过
扩展里的 MCP 客户端桥拿到同一份工具清单。

## 工具 / Tools

`sideEffect` 同时写进工具的 `_meta.sideEffect` 与 MCP annotations（`readOnlyHint` / `destructiveHint`），
供网关的权限策略分类使用。

| 工具 | sideEffect | 输入 / input | 输出 / output |
|---|---|---|---|
| `docx_extract` | read | `path` | `paragraphs[{index,bodyIndex,style?,headingLevel?,text}]`、`tables[{index,bodyIndex,rowCount,columnCount,rows[][]}]`、`headings[{paragraphIndex,level,text,style?}]` |
| `docx_replace_paragraphs` | write | `path`, `outputPath`, `replacements[{index?,match?,text}]`, `overwrite?` | `replaced[{index,previousText,text}]`、`paragraphCount`、`bytes` |
| `docx_create` | write | `outputPath`, `title?`, `blocks[{type,level?,text?,items?,rows?}]`, `overwrite?` | `blockCount`、`paragraphCount`、`tableCount`、`bytes` |
| `xlsx_read` | read | `path`, `sheet?`, `maxRows?` | `sheets[]`、`sheet`、`rows[][]`、`rowCount`、`columnCount`、`truncated` |
| `xlsx_write` | write | `outputPath`, `sheets[{name?,rows[][]}]`, `overwrite?` | `sheets[{name,requestedName?,rowCount,columnCount}]`、`bytes` |
| `pptx_extract` | read | `path` | `slides[{index,part,title?,notes?,texts[{shapeId,name?,placeholder?,text}]}]` |
| `pptx_replace_text` | write | `path`, `outputPath`, `edits[{slide,shapeId?,match?,text}]`, `overwrite?` | `edits[{slide,shapeId,previousText,text}]`、`bytes` |
| `pptx_reorder_slides` | write | `path`, `outputPath`, `order[]`, `overwrite?` | `order[]`、`slideCount`、`bytes` |
| `pptx_delete_slides` | write | `path`, `outputPath`, `slides[]`, `overwrite?` | `deleted[{slide,part}]`、`remainingSlides`、`bytes` |
| `pptx_create` | write | `outputPath`, `slides[{title,bullets?,notes?}]`, `theme?`, `overwrite?` | `slideCount`、`bytes` |
| `csv_read` | read | `path`, `delimiter?`, `maxRows?` | `headers[]`、`rows[][]`、`rowCount`、`numericColumns[{column,count,min,max,mean,sum}]`、`textColumns[{column,distinctCount,sample[]}]` |
| `fs_find` | read | `root`, `nameContains?`, `extensions?`, `recursive?`, `maxResults?` | `files[{path,name,size,modifiedAt}]`、`directories[{path,name}]`、`truncated` |
| `fs_delete` | external | `paths?` 或 `root`+`nameContains`/`extensions`, `recursive?`, `dryRun?` | `matched[]`、`deleted[]`、`failed[{path,reason}]`、`skippedDirectories[]` |
| `app_open` | external | `name` | `name`、`command`、`argv[]`、`exitCode` |
| `web_fetch` | external | `url`, `maxBytes?`, `timeoutMs?` | `status`、`contentType`、`title?`、`text`、`bytes`、`truncated` |
| `server_info` | read | — | `name`、`version`、`platform`、`nodeVersion`、`tools[{name,title,sideEffect,description}]` |

每个工具都返回 `structuredContent`（结构化结果）与一段文本（摘要 + 同一份 JSON），失败时返回
`isError:true` 和 `<工具名> 失败 / failed [CODE]: 说明`。

## 约定 / Conventions

- **绝对路径**：所有路径必须是绝对路径（Windows 盘符、UNC 或 POSIX 绝对路径），相对路径直接报
  `PATH_NOT_ABSOLUTE`；服务器的工作目录与任务无关，解析相对路径只会把产物写到裁判找不到的地方。
- **不覆盖**：写入类工具在 `outputPath` 已存在时报 `OUTPUT_EXISTS`，需要覆盖时显式传 `overwrite:true`；
  这也是"原文件不会被第二次调用毁掉"的保证。`outputPath` 的父目录会自动创建。
- **索引**：docx 段落索引从 0 开始（`docx_extract` 的 `index` 就是 `docx_replace_paragraphs` 接受的
  `index`）；pptx 幻灯片序号从 1 开始，且按 `p:sldIdLst` 的演示顺序而不是文件名顺序。
- **匹配**：`match` 先按整段/整形状全文匹配，再退化为子串匹配；命中多个时报 `AMBIGUOUS_MATCH` 并列出
  候选索引，绝不猜测。
- **错误码**：`PATH_NOT_ABSOLUTE`、`PATH_NOT_FOUND`、`NOT_A_FILE`、`OUTPUT_EXISTS`、`INVALID_ARGUMENT`、
  `NO_MATCH`、`AMBIGUOUS_MATCH`、`INDEX_OUT_OF_RANGE`、`UNSUPPORTED_FORMAT`、`PROTECTED_LOCATION`、
  `PLATFORM_UNSUPPORTED`、`REQUEST_FAILED`、`UNEXPECTED`。

## 已知限制 / Known limitations

改写类工具在保真与"能改"之间取了明确的一侧，下面这些结构不会被保留或不被支持：

- **docx 段落改写**：整段的多个 run 会合并成一个 run，只保留段落属性 `w:pPr` 与第一个 run 的 `w:rPr`。
  段内的局部格式（一句话里加粗的一个词）、超链接、域、批注锚点、脚注引用会丢失；书签（`w:bookmarkStart/End`）
  会保留。修订标记的删除文本（`w:delText`）在读取时被忽略。
- **docx 读取范围**：只覆盖 `word/document.xml`。页眉、页脚、脚注、尾注、文本框与 SmartArt 不在
  `paragraphs`/`tables` 里，也不能被 `docx_replace_paragraphs` 定位。表格单元格里的段落只在
  `tables[].rows` 里可读，不参与段落索引。
- **docx 生成**：`docx_create` 使用库的默认样式，不继承任何模板，不支持图片、页眉页脚、目录与页码。
- **pptx 文本改写**：保留第一段的 `a:pPr` 与第一个 run 的 `a:rPr` 并克隆到每一行；形状内原有的分段
  格式差异、`a:fld`（页码等域）、超链接会丢失。文本自动缩放不会重新计算，把短标题换成长标题可能在
  PowerPoint 里溢出占位符。
- **pptx 读取范围**：只遍历 `p:sp`（含组合内的形状）。表格（`p:graphicFrame`）、图表、SmartArt、图片
  不在 `texts` 里，也不能改写。备注可读、在重排与删页时会跟随幻灯片，但没有备注编辑工具。
- **xlsx**：`xlsx_write` 总是新建工作簿，不做原位编辑，因此图表、透视表、宏、条件格式不会被保留；
  `xlsx_read` 只返回值，不返回格式、合并单元格几何或批注。公式单元格返回缓存结果，没有缓存结果时为 `null`。
  工作表名按 Excel 规则清洗并去重，实际使用的名字在 `sheets[].name` 里回报。
- **csv**：按 UTF-8（可带 BOM）读取，不做 GBK 等编码探测。
- **web_fetch**：不执行 JavaScript，HTML 转文本是启发式的。Node 的全局 `fetch` 默认不读代理环境变量；
  需要代理时在 Node 24 上设 `NODE_USE_ENV_PROXY=1`。
- **app_open**：仅 Windows，走 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
  `-NoProfile -NonInteractive`，只接受应用名（不含路径分隔符与 shell 元字符），不接受任意命令行。
- **fs_delete**：只删文件，永不删目录；拒绝驱动器根、`C:\Windows`、`C:\Program Files`、`C:\ProgramData`、
  用户目录根以及 POSIX 系统目录；按 `root` 删除时必须给 `nameContains` 或 `extensions`。

## 开发 / Development

```bash
npm run typecheck
npm test                 # 含 tests/adapters/office-mcp（真实 stdio MCP 客户端往返）
npm run build            # 产出 dist/tools/office-mcp/main.js
```

测试夹具（docx / xlsx / pptx / csv）在测试运行时用同一批依赖现场生成，不落库任何二进制样例。
