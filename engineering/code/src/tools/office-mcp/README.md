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
| `docx_extract` | read | `path` | `paragraphs[{index,bodyIndex,style?,headingLevel?,text}]`、`tables[{index,bodyIndex,rowCount,columnCount,rows[][],cells[][{row,column,columnSpan,rowSpan,text}],hasMergedCells}]`、`headings[{paragraphIndex,level,text,style?}]` |
| `docx_replace_paragraphs` | write | `path`, `outputPath`, `replacements[{index?,match?,text}]`, `overwrite?` | `replaced[{index,previousText,text}]`、`paragraphCount`、`bytes` |
| `docx_create` | write | `outputPath`, `title?`, `blocks[{type,level?,text?,items?,rows?}]`, `overwrite?` | `blockCount`、`paragraphCount`、`tableCount`、`bytes` |
| `xlsx_read` | read | `path`, `sheet?`, `maxRows?` | `sheets[]`、`sheet`、`rows[][]`、`rowCount`、`columnCount`、`truncated` |
| `xlsx_write` | write | `outputPath`, `sheets[{name?,rows[][]}]`, `overwrite?` | `sheets[{name,requestedName?,rowCount,columnCount}]`、`bytes` |
| `pptx_extract` | read | `path` | `slideCount`、`tableCount`、`chartCount`、`slides[{index,part,title?,notes?,texts[{shapeId,name?,placeholder?,text}],tables?[{shapeId,name?,rowCount,columnCount,rows[][]}],charts?[{shapeId,name?,part,chartTypes[],title?,series[{name?,categories[],values[]}]}]}]` |
| `pptx_replace_text` | write | `path`, `outputPath`, `edits[{slide,shapeId?,match?,text}]`, `overwrite?` | `edits[{slide,shapeId,previousText,text}]`、`bytes` |
| `pptx_reorder_slides` | write | `path`, `outputPath`, `order[]`, `overwrite?` | `order[]`、`slideCount`、`bytes` |
| `pptx_delete_slides` | write | `path`, `outputPath`, `slides[]`, `overwrite?` | `deleted[{slide,part}]`、`remainingSlides`、`bytes` |
| `pptx_create` | write | `outputPath`, `slides[{title,bullets?,notes?}]`, `theme?`, `overwrite?` | `slideCount`、`bytes` |
| `csv_read` | read | `path`, `delimiter?`, `maxRows?` | `headers[]`、`rows[][]`、`rowCount`、`numericColumns[{column,count,min,max,mean,sum}]`、`textColumns[{column,distinctCount,sample[]}]` |
| `data_aggregate` | read | `path`（`.csv`/`.xlsx`）, `sheet?`, `delimiter?`, `filters[{column,op,value?,values?}]?`, `filterMode?`, `groupBy[]?`, `aggregations[{op,column?,as?}]?`, `sort[{by,direction?}]?`, `limit?` | `rows[{<分组列>,<统计列>}]`、`columns[{column,index,type,numericCount,textCount,emptyCount}]`、`rowCount`、`filteredRowCount`、`groupCount`、`hints[]`、`groupingCandidates[{column,distinctCount,samples[]}]?`、`skipped[{column,nonNumericCount,emptyCount,samples[]}]`、`warnings[]` |
| `fs_find` | read | `root`, `nameContains?`, `extensions?`, `recursive?`, `maxResults?` | `files[{path,name,size,modifiedAt}]`、`directories[{path,name}]`、`truncated` |
| `fs_delete` | external | `paths?` 或 `root`+`nameContains`/`extensions`, `recursive?`, `dryRun?` | `matched[]`、`deleted[]`、`failed[{path,reason}]`、`skippedDirectories[]` |
| `doc_verify` | read | `path`, `minBytes?`, `mustContain[]?`, `mustNotContain[]?`, `minTables?`, `minSlides?`, `maxSlides?`, `minSheets?`, `sheetNames[]?`, `minCjkChars?`, `maxCjkChars?` | `ok`、`kind`、`kindMatchesExtension`、`formatValid`、`formatProblem?`、`bytes`、`textLength`、`cjkChars`、`paragraphCount?`、`tableCount?`、`slideCount?`、`sheetCount?`、`sheetNames?`、`checked[]`、`skipped[]`、`failures[{check,expected,actual}]` |
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
- **数值解析**：`data_aggregate` 只把这些形状当成数字：数字本身、普通小数、千分位（`1,250.5`）、
  货币符号前缀（`¥800`）、百分号后缀（`12%` 读作 `12`，与 `csv_read` 一致）。`N/A`、`未统计`、`120 件`
  这类单元格既不参与统计也不会被当成 0，而是计入 `skipped`（含样例）；某一组完全没有数值时该统计项返回
  `null` 而不是 `0`，因为 `0` 与真实的零无法区分。
- **表格网格**：`docx_extract` 按真实列网格返回表格。`w:gridSpan`（横向合并）与 `w:vMerge`（纵向合并）
  都被展开成列位置：`rows` 中被合并覆盖的位置是空串（不重复文本），`cells` 里给出每个单元格的
  `column`/`columnSpan`/`rowSpan`。这样"每个表格导出成一个 sheet"不会整行错位。
- **产出校验**：`doc_verify` 按文件内容而不是扩展名判断格式——`.docx`/`.xlsx`/`.pptx` 会真的打开 OOXML 包
  并解析主部件，所以"把路径字符串写进 `.docx`"这类 44 字节假文件会被判为"不是有效的 Office 文档"，
  而不是因为扩展名对就通过。期望不满足不是错误：返回 `ok:false` 与 `failures[{check,expected,actual}]`，
  调用方据此修复重写；只有参数本身不可用（缺路径、相对路径、不支持的扩展名、文件不存在）才返回
  `isError`。文件解析失败时，需要读内容的期望不会被"默认通过"，而是列进 `skipped`；对文档类型不适用的
  期望（对 `.docx` 问 `minSlides`）计为失败，因为那说明校验的根本不是刚写出的那个产物。
  `minCjkChars`/`maxCjkChars` 只统计 U+3400-U+9FFF，与评测口径一致。
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
- **pptx 读取范围**：`texts` 只包含 `p:sp`（含组合内的形状）；表格与图表另外报在 `tables` 与 `charts` 里，
  但都只能读不能改（`pptx_replace_text` 仍只处理 `p:sp`）。图表读的是图表部件里的缓存值
  （`c:strCache`/`c:numCache`），即 PowerPoint 当前显示的数据；外部链接的工作簿不会被打开，图表部件缺失时
  该图表仍会被报出来（`series` 为空），不会被当作"没有图表"。SmartArt（`ppt/diagrams/`）与图片仍不可读。
  备注可读、在重排与删页时会跟随幻灯片，但没有备注编辑工具。
- **xlsx**：`xlsx_write` 总是新建工作簿，不做原位编辑，因此图表、透视表、宏、条件格式不会被保留；
  `xlsx_read` 只返回值，不返回格式、合并单元格几何或批注。公式单元格返回缓存结果（即工作簿当前显示的数字或
  文本）；写入方没有存缓存结果时才退回 `=公式` 字符串，不会把公式当成数据。
  工作表名按 Excel 规则清洗并去重，实际使用的名字在 `sheets[].name` 里回报。
- **xlsx 读取路径**：主读取器是 `exceljs`；它按字面比较标签名（只认 `sheet`，不认 `x:sheet`），因此带命名空间
  前缀的工作簿（`<x:workbook>`，WPS 等非微软生成器的常见写法，同样是合法 OOXML）会解析失败。这类文件改由
  直接读取 OOXML 包的回退读取器处理（`xlsx-ooxml.ts`，按 local name 解析，支持共享字符串、内联字符串、
  布尔、错误值，并按数字格式把日期序列号还原成 ISO 字符串）。两个读取器都失败时报 `UNSUPPORTED_FORMAT`，
  错误信息同时给出两个读取器各自的原因，绝不返回空工作簿。
- **csv**：按 UTF-8（可带 BOM）读取，不做 GBK 等编码探测。
- **data_aggregate**：只读 `.csv`/`.tsv`/`.txt` 与 `.xlsx`/`.xlsm`，首行必须是表头；过滤条件只比较"列与常量"，
  不比较两列（"低于安全库存"这类判断请分组取出两列的值后自行比较）。默认最多返回 1000 组，超出时
  `truncated:true`。`gt/gte/lt/lte` 在两侧都能解析成数字时按数值比较，否则退化为字符串比较；空单元格不参与
  任何大小比较。
- **hints（结果为什么可能不是你要的）**：`hints[]` 不改变任何计算结果，只说明"数字是对的，但回答的不是你问的
  问题"，并指出改哪个参数。会触发的情况：没传 `groupBy`（返回的那 1 行是整表汇总，不是分类结果，并给出
  `groupingCandidates`）、`filters` 一行都没匹配上（并列出被过滤列真实存在的取值）、`groupBy` 的组数接近行数
  （是原表重排而不是汇总）、没传 `aggregations`（只做了一次 count）、某个统计项在每一组都是 `null`（该列没有
  可解析的数字，不等于 0）、结果被 `limit` 截断、表里根本没有数据行。空数组表示无话可说。
  `groupingCandidates` 的判据：不同取值数 ≥ 2（只有一个值等于没分组）、≤ 20（再多就不是摘要而是另一份原表）、
  且 ≤ 行数的一半（保证每组平均至少 2 行），按取值数从少到多排序、最多 6 列——所以 200 行里两个取值的
  `defaulted` 会被推荐，200 个取值的 `customer_id` 不会。这条判据同时决定"组数太多"的提醒何时出现，
  工具不会推荐一个自己随后又要抱怨的分组方式。这些提示既在 `structuredContent` 里，也在同一段文本的 JSON 中。
- **doc_verify**：只支持 `.docx`/`.xlsx`/`.pptx` 与 `.md`/`.markdown`/`.txt`/`.csv`，`.doc`/`.xls`/`.ppt`
  等旧版二进制格式与 `.pdf` 直接报 `UNSUPPORTED_FORMAT`（宁可拒答也不给一个没验证过的"通过"）。
  可读文本的范围与各自的读取工具一致：docx 只覆盖正文（页眉页脚、脚注、文本框不算在 `mustContain` 与
  中文字数里），pptx 覆盖形状文本、表格、备注与图表缓存值，xlsx 覆盖全部工作表的单元格值。
  "是不是文本文件"用首 4 KB 内有无 NUL 字节判断——足够识别"把路径或 Markdown 存成 `.docx`"，
  但不是通用的编码探测。它能证明"文件存在、格式真、结构与字数达标"，不能证明"内容正确"：
  数字是不是编的仍要靠 `csv_read`/`data_aggregate` 先算。
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
