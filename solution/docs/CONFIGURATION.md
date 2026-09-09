# PNP 配置参考

> 本文是 `config/settings.json` 与 `/config` 接口的完整参考。所有陈述均以源码为准，
> 解析器在 `src/config/settings.ts`，接口在 `src/config/routes.ts` 与 `src/config/service.ts`；
> 路径以 `code/` 为根（交付包内为 `solution/code/`）。启动与调用见同目录
> [`USAGE.md`](USAGE.md)，分层与投影见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。
>
> 文中 `openai-chat` 与 `anthropic-messages` 是模型协议标识符，按原样书写。

---

## 1. 文件在哪里、两层模型是什么

设置文件是 **`config/settings.json`**，一个文件同时服务所有引擎。`PNP_SETTINGS` 可指向别处
（相对路径按 `code/` 解析，绝对路径原样使用）。文件里**只有名字，没有值**：模型地址、密钥、
请求头、证书路径一律以环境变量名引用，值放在 `runtime/local.env` 或进程环境（第 5 节）。

顶层只有三个键，`version` 必须是 `1`：

```text
config/settings.json
+----------------------------------------------------------------+
| "version": 1                                                   |
| "common": { model, permissions, instructions, mcp,             |
|             skills, assets, packs, native }     基线：所有引擎  |
| "cores": {                                                     |
|   "opencode": { 同样八个键，均可省略 },       只对该引擎的加法覆盖 |
|   "pi":       { ... },                                         |
|   "hermes":   { ... }                                          |
| }                                                              |
+----------------------------------------------------------------+
                 |  gateway.cmd --engine pi   选定引擎
                 v
   effective(pi) = merge(common, cores.pi)   逐键合并，规则见下表
```

`common` 与每个 `cores.<engineId>` 只接受**同样的八个键**：`model`、`permissions`、
`instructions`、`mcp`、`skills`、`assets`、`packs`、`native`。多一个键（哪怕只是拼错）
整个文件拒绝加载：`common.permisions is an unknown field.`。`common.model` 与
`common.permissions` 必须存在，其余六个键与 `cores` 下的全部键都可省略。

| 引擎 id | 说明 |
|---|---|
| `opencode` | 可启动 |
| `pi` | 可启动 |
| `hermes` | 声明的扩展点，`cores.hermes` 可写；启动以 `ENGINE_UNAVAILABLE` 拒绝 |

每次加载都会解析**全部** `cores.*` 段，与本次选定哪个引擎无关：`cores.pi` 里的错误同样会
让 `--engine opencode` 启动失败。

**合并规则**（`cores.<id>` 对 `common` 的作用）：

| 键 | 规则 |
|---|---|
| `model.models[]` | 按 `providerID`+`modelID` 合并：同键条目整体替换，新键追加 |
| `model.default` | 引擎值覆盖；可只写 `providerID`（该 provider 恰有一个模型时） |
| `permissions.default` | 引擎值覆盖 |
| `permissions.operations` | 按操作名合并，引擎条目优先 |
| `instructions[]` | **整体替换**；`[]` 表示该引擎不注入任何指令 |
| `mcp.servers.<id>` | 按服务器 id **字段级部分覆盖**，`env` / `headerEnvironment` 再按键合并 |
| `skills.<id>`、`assets.<kind>.<id>`、`packs.<id>` | 按 id 字段级部分覆盖；`parameters` 对象浅合并 |
| `native` | 浅合并，引擎键覆盖同名键 |

"部分覆盖"意味着 `cores.<id>` 里的条目**不是独立声明**：它只补充或改写 `common` 中同 id 的
条目。对一个 `common` 从未声明的服务器写 `{ "enabled": false }`，合并结果缺 `transport`，
报 `effective.mcp.servers.<name>.transport must be a non-empty string.`。要只在一个引擎
上关闭一个服务器，写法见第 4.4 节。

---

## 2. 八个可配置域

| 域 | 作用 | 常见写法 | 本交付的投影 |
|---|---|---|---|
| `model` | 模型目录与默认模型 | 一个条目，每个字段都是变量名 | 生效 |
| `permissions` | 操作级授权策略 | `{"default":"allow","operations":{"shell":"ask"}}` | 生效 |
| `instructions` | 注入引擎的指令文件 | `["instructions/competition.md"]` | 生效 |
| `mcp` | MCP 工具服务器 | `servers.<id>`，`stdio` 或 `streamable-http` | 生效 |
| `skills` | 技能目录（`SKILL.md`） | `"<id>": {"path": "skills/<id>"}` | 解析并校验；不投影，可选条目记为跳过 |
| `assets` | 任意类别的资产 | `"<kind>": {"<id>": {"path": "..."}}` | 同上 |
| `packs` | 能力包选择 | `"<id>": {"enabled": true}` | 同上 |
| `native` | 引擎私有选项 | 任意 JSON 对象 | 非空时拒绝启动 |

最后一列是 `src/config/capability-readiness.ts` 的记录方式：语法被接受与能力被投影分开报告，
细节见第 4.5–4.8 节与第 7 节的 `capabilities` 字段。

---

## 3. 一份完整示例

下面这份文件对 `opencode`、`pi`、`hermes` 三个引擎都能通过解析（`loadPnpSettings`），
把它放在 `config/` 目录即可使用。它覆盖了后文每一节要讲的写法。

```json
{
  "version": 1,
  "common": {
    "model": {
      "default": { "providerID": "competition" },
      "models": [
        {
          "selection": { "providerID": "competition", "modelID": "default" },
          "modelIDEnvironment": "PNP_MODEL_ID",
          "endpointEnvironment": "PNP_MODEL_ENDPOINT",
          "protocol": "openai-chat",
          "apiKeyEnvironment": "PNP_MODEL_API_KEY",
          "headersEnvironment": "PNP_MODEL_HEADERS",
          "caFileEnvironment": "PNP_MODEL_CA_FILE"
        }
      ]
    },
    "permissions": {
      "default": "allow",
      "operations": { "shell": "ask", "external": "ask" }
    },
    "instructions": ["instructions/competition.md"],
    "mcp": {
      "servers": {
        "office": {
          "transport": "stdio",
          "command": "${PNP_NODE}",
          "args": ["${PNP_CODE_ROOT}/dist/tools/office-mcp/main.js"],
          "sideEffect": "write",
          "enabled": true
        },
        "desktop": {
          "transport": "stdio",
          "command": "${PNP_NODE}",
          "args": ["${PNP_CODE_ROOT}/dist/tools/desktop-mcp/main.js"],
          "sideEffect": "external",
          "timeoutMs": 15000,
          "enabled": true
        },
        "mail": {
          "transport": "stdio",
          "command": "C:/Python312/python.exe",
          "args": ["D:/intranet-tools/mail-mcp/main.py"],
          "env": { "MAIL_TOKEN": "PNP_MAIL_TOKEN" },
          "sideEffect": "external",
          "timeoutMs": 30000,
          "enabled": true
        },
        "knowledge": {
          "transport": "streamable-http",
          "url": "https://mcp.intranet.example/mcp",
          "headerEnvironment": { "Authorization": "PNP_MCP_KB_TOKEN" },
          "sideEffect": "read",
          "enabled": true
        }
      }
    },
    "skills": {
      "office-report": { "path": "skills/office-report", "enabled": true, "required": false }
    },
    "assets": {
      "hook": {
        "audit": {
          "path": "assets/hooks/audit.js",
          "layout": "file",
          "enabled": true,
          "required": false,
          "engines": ["pi"]
        }
      }
    }
  },
  "cores": {
    "opencode": {
      "permissions": { "operations": { "shell": "allow" } },
      "native": { "share": "disabled" }
    },
    "pi": {
      "mcp": { "servers": { "desktop": { "enabled": false } } }
    },
    "hermes": {}
  }
}
```

| 块 | 写了什么 | 启动时（`opencode`） | 启动时（`pi`） |
|---|---|---|---|
| `common.model` | 一个模型，六个字段全是变量名 | 生效 | 生效 |
| `common.permissions` | 默认放行，`shell` 与 `external` 要问 | `cores.opencode` 把 `shell` 改回放行；`external` 按名合并后仍要问 | 生效 |
| `common.instructions` | 一个指令文件，相对设置目录 | 生效 | 生效 |
| `mcp.servers.office` / `desktop` | 随包的 Node 服务器 | 两个都启用 | `desktop` 被 `cores.pi` 关闭 |
| `mcp.servers.mail` | 本机 Python 写的 stdio 服务器，凭据经 `env` 引用 | 生效，`PNP_MAIL_TOKEN` 必须已设 | 同左 |
| `mcp.servers.knowledge` | 远程 streamable-http 服务器，头经变量引用 | 生效，`PNP_MCP_KB_TOKEN` 必须已设 | 同左 |
| `common.skills.office-report` | 可选技能目录 | 解析；记为 `projection-unavailable`，跳过 | 同左 |
| `common.assets.hook.audit` | 只面向 `pi` 的可选文件资产 | 记为 `not-targeted`，跳过 | 记为 `projection-unavailable`，跳过 |
| `cores.opencode.native` | 引擎私有选项 | **拒绝启动**：`NATIVE_OPTIONS_UNSUPPORTED` | 不涉及 |

也就是说，删掉 `cores.opencode.native` 这一行后，这份文件在两个可启动引擎上都能起来；
保留它是为了展示形状与第 4.8 节的行为。`skills/office-report` 与 `assets/hooks/audit.js`
不存在时不报错（都是 `required: false`），`/config` 会给出 `ASSET_MISSING` 警告。

---

## 4. 逐域详解

### 4.1 `model`

```json
"model": { "default": { "providerID": "...", "modelID": "..." }, "models": [ ... ] }
```

`models[]` 每个条目：

| 字段 | 必需 | 含义 |
|---|---|---|
| `selection` | 是 | `{providerID, modelID}`，文件内的身份；同一层内不得重复 |
| `protocol` | 是 | `openai-chat` 或 `anthropic-messages`，其他值拒绝 |
| `endpoint` / `endpointEnvironment` | 二选一 | 字面 URL，或持有 URL 的变量名；两个都写或都不写均拒绝 |
| `modelIDEnvironment` | 否 | 持有端点认识的模型名的变量；加载时替换 `selection.modelID` |
| `headerEnvironment` | 否 | 请求头名 → 变量名；每个变量都**必需** |
| `headersEnvironment` | 否 | 一个持有 JSON 对象的变量，附加请求头（如 `appid`） |
| `apiKeyEnvironment` | 否 | 裸凭据变量；发 `Authorization: Bearer <值>`，变量未设则不发 |
| `caFileEnvironment` | 否 | 持有 PEM 路径的变量；相对路径按 `code/` 解析；启动时检查存在 |

`default` 决定调用方没有指定、或指定了未配置的模型时用哪一个：写全 `{providerID, modelID}`
必须能在合并后的目录里找到；只写 `providerID` 时该 provider 必须恰有一个模型，否则报
`Effective default model for <engine> names a provider with N models; name modelID.`。
`PNP_MODEL_STRICT=1` 让未配置的选择返回 403 而不是落到默认模型。

请求头按固定顺序组装：先 `headerEnvironment` 的每一项，再 `headersEnvironment` 里的 JSON
对象，最后 `apiKeyEnvironment`——仅当前两者没有设置过 `Authorization`（不区分大小写）时
才加 `Bearer`。

传输规则对字面 `endpoint` 与变量里的值一视同仁：`https` 任意；`http` 只允许 `localhost`、
`127.0.0.1`、`[::1]`，除非 `PNP_ALLOW_HTTP_ENDPOINTS=1`；URL 里带用户名密码一律拒绝。

随包文件只声明一个模型，就是第 3 节里的那一段，所以部署只设四个变量、不改文件（见
`USAGE.md` 第 2 节）。

### 4.2 `permissions`

```json
"permissions": { "default": "allow", "operations": { "shell": "ask", "external": "ask" } }
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `default` | `allow` / `deny` / `ask` | 未列出的操作一律按此；`common` 必填，`cores.<id>` 可选 |
| `operations.<操作名>` | 同上 | 按操作名逐条裁决；`deny` 不能被用户回复推翻 |

`PNP_CONFIGURED_POLICY_OVERRIDES`（JSON，如 `{"write":"ask"}`）在加载时最后覆盖
`operations`，用于不改文件就把某个操作改为询问；`/permission` 的 `always` 回复只在该会话内
记住，不会写回引擎。

**操作名从哪里来**，两个引擎不同，这也是 MCP 服务器上 `sideEffect` 字段的用途：

```text
settings.json  mcp.servers.<id>.sideEffect   read | write | external
        |  缺省 external（最强）
        v
ToolBinding.sideEffect  ---- 每轮随 IntegrationContext.tools 交给驱动
        |
        +--> Pi 桥（pnp-bridge.ts）：桥接工具的操作名 = sideEffect
        |      read -> 不询问；write / external -> 问网关 authorize()
        |      内建工具：bash/powershell->shell  write/edit->write
        |                read/grep/find/ls->read  其他保留原名
        |
        +--> OpenCode（ACP）：操作名 = 驱动锁定的工具名 -> name -> kind
               -> title；sideEffect 不参与，原生 permission 块见下
        v
permissions.operations.<操作名>  -> allow | ask | deny（缺省 default）
```

| 引擎 | 操作名 | 说明 |
|---|---|---|
| Pi | `shell`、`write`、`read`、以及每个桥接 MCP 服务器的 `sideEffect` | `read` 类不经策略；所以 `operations.read: "ask"` 在 Pi 下无效 |
| OpenCode | 引擎自己的权限名：`edit`、`bash`、`read`、`webfetch`、`websearch`、`task`、`external_directory` … | 网关把 `operations` 投影进 OpenCode 私有配置的 `permission` 块；`ask` / `deny` 都写成原生 `ask`，裁决仍由网关按本策略给出 |

为了让同一份 `operations` 在两个引擎下意思一致，OpenCode 投影时做别名映射：
`write`、`patch`、`file.write` → `edit`；`file.read` → `read`；`shell`、`shell.execute` → `bash`；
`web.fetch` → `webfetch`；`web.search` → `websearch`；`subagent` → `task`。当 `default` 是 `allow`
且没有条目提到 `external_directory` 时，会显式写出 `external_directory: allow`——这是
OpenCode 自己默认询问的键，无人值守的任务必须放行它。

### 4.3 `instructions`

```json
"instructions": ["instructions/competition.md", "D:/team/extra-rules.md"]
```

- 数组元素是路径：相对路径按**设置文件所在目录**解析，绝对路径原样使用；按声明顺序注入。
- 启动时逐个检查可读；缺一个即拒绝：`Instruction file is missing or unreadable: <绝对路径>`。
- `cores.<id>.instructions` **整体替换** `common` 的列表，`[]` 表示该引擎不注入指令。
- 到达引擎的方式：OpenCode 写入私有配置的 `instructions[]`，Pi 以 `--append-system-prompt`
  注入；文件文本每轮重新读取（生效时机见第 6 节）。
- `/config/files/instruction/*` 只能读写 `config/instructions/` 目录内的 `.md` 普通文件：相对路径、
  不得是链接、不得逃出该目录，上限 1 MiB；`/config/files` 的列表只列出该目录直接下的文件。

随包文件注入 `config/instructions/competition.md`。

### 4.4 `mcp`

```json
"mcp": { "servers": { "<id>": { ... } } }
```

`servers.<id>` 允许的键就这十一个，多一个拒绝：`transport`、`command`、`args`、`env`、`url`、
`urlEnvironment`、`headerEnvironment`、`enabled`、`sideEffect`、`timeoutMs`（id 本身来自键名，
不得为空）。

| 字段 | 适用 | 说明 |
|---|---|---|
| `transport` | 都 | `stdio` 或 `streamable-http` |
| `enabled` | 都 | 缺省 `true`；`false` 的服务器仍留在有效设置里（`enabled: false`），但不会成为工具绑定，引擎看不到它 |
| `sideEffect` | 都 | `read` / `write` / `external`，缺省 `external`；用途见第 4.2 节 |
| `timeoutMs` | 都 | 正整数，可选 |
| `command` | stdio | 可执行文件。设置解析只要求非空；**启动时**要求展开后是绝对路径，否则 `INTEGRATION_CONFIG_INVALID`：`Tool command must be absolute.`（从不搜索 PATH） |
| `args` | stdio | 字符串数组，可选 |
| `env` | stdio | 子进程变量名 → 网关环境变量名；启动时按名取值，缺一个即 503 `Required tool environment variable is absent: <变量名>` |
| `url` / `urlEnvironment` | streamable-http | 二选一：字面 URL，或持有 URL 的变量名；两者都遵守第 4.1 节的传输规则 |
| `headerEnvironment` | streamable-http | 请求头名 → 变量名；头名不得重复（不区分大小写） |

stdio 服务器写了 `url` / `urlEnvironment` / `headerEnvironment`，或 http 服务器写了 `command` /
`args` / `env`，都拒绝。

**占位符**只有两个，在 `command`、`args[]`、`url` 中展开；其他任何 `${...}` 让整个文件拒绝加载
（`... uses an unsupported placeholder ${NAME}.`）：

| 占位符 | 展开为 |
|---|---|
| `${PNP_CODE_ROOT}` | 包根目录 `code/` 的绝对路径 |
| `${PNP_NODE}` | 运行网关的 Node 可执行文件 |

没有 `${ENV:NAME}` 之类的写法：凭据只经 `env` / `headerEnvironment` 按名引用，不会展开进命令行。

**随包的三个服务器**（`config/settings.json` 原文）：

```json
"office":  { "transport": "stdio", "command": "${PNP_NODE}",
             "args": ["${PNP_CODE_ROOT}/dist/tools/office-mcp/main.js"],
             "sideEffect": "write", "enabled": true },
"desktop": { "transport": "stdio", "command": "${PNP_NODE}",
             "args": ["${PNP_CODE_ROOT}/dist/tools/desktop-mcp/main.js"],
             "sideEffect": "external", "timeoutMs": 15000, "enabled": true },
"pdf":     { "transport": "stdio", "command": "${PNP_NODE}",
             "args": ["${PNP_CODE_ROOT}/dist/tools/pdf-mcp/launch.js"],
             "sideEffect": "read", "timeoutMs": 60000, "enabled": true }
```

| 服务器 | 实现 | `sideEffect` |
|---|---|---|
| `office` | Node，docx / xlsx / pptx / csv 读写与文件工具 | `write` |
| `desktop` | Node，列举与打开固定允许的 Windows 应用 | `external` |
| `pdf` | Python（`main.py`），由 Node 启动器 `launch.js` 找解释器后 spawn；解释器顺序 `PNP_PYTHON` → 包内 → PATH，找不到时服务器仍启动、只发布 `server_info` 报告不可用 | `read` |

`pdf` 用 Node 启动器而不是直接写 `python`，正是上面两条规则的结果：`${PNP_PYTHON}` 不是
合法占位符，而写文件时又不可能知道 Python 的绝对路径。

**添加一个本机 stdio 服务器**（任何语言，只要按 MCP stdio 协议工作）：命令写绝对路径，
凭据写变量名——第 3 节的 `mail` 条目就是一个 Python 服务器的完整写法。

**添加一个远程 streamable-http 服务器**：

```json
"knowledge": {
  "transport": "streamable-http",
  "urlEnvironment": "PNP_KB_URL",
  "headerEnvironment": { "Authorization": "PNP_MCP_KB_TOKEN", "appid": "PNP_KB_APPID" },
  "sideEffect": "read"
}
```

`runtime/local.env` 里对应写 `PNP_KB_URL=https://...`、`PNP_MCP_KB_TOKEN=Bearer <token>`、
`PNP_KB_APPID=<appid>`。ACP 引擎只在 `initialize` 声明了 `mcpCapabilities.http` 时才收到
http 服务器，否则该绑定被丢弃并附原因上报；Pi 桥两种传输都支持。

**只对一个引擎关闭一个服务器**——`cores.<id>` 条目是部分覆盖，所以只写要改的字段：

```json
"cores": { "pi": { "mcp": { "servers": { "desktop": { "enabled": false } } } } }
```

同理可以只改 `timeoutMs`、只加一个 `env` 键。反过来，在 `cores.<id>` 里声明一个 `common`
没有的服务器要写全（至少 `transport` 加对应传输的必填字段），否则报第 1 节末尾那条错误。

### 4.5 `skills`

```json
"skills": { "office-report": { "path": "skills/office-report", "required": false } }
```

`skills.<id>` 与 `assets.<kind>.<id>` 用同一种条目（`AssetEntry`），允许的键：`path`、`layout`、
`entry`、`required`、`enabled`、`engines`、`parameters`、`permitted`。

| 字段 | 说明 |
|---|---|
| `path` | 相对设置目录或绝对；必须落在批准的资产根内（下表），否则 403 `ASSET_OUTSIDE_ROOT` |
| `layout` | `directory`（技能缺省）或 `file` |
| `entry` | 目录布局内的入口文件，缺省 `SKILL.md`；必须是目录内的相对路径；`file` 布局不得写 |
| `required` | 缺省 `false`。`true`：路径缺失即拒绝加载；`false`：只记 `ASSET_MISSING` 警告并跳过 |
| `enabled` | 缺省 `true`；`false` 的条目不出现在有效设置里（路径仍要在根内） |
| `engines` | 引擎 id 数组；不含当前引擎的条目按 `not-targeted` 跳过，即使 `required` |
| `parameters` | 任意 JSON，跨层浅合并 |
| `permitted` | 布尔，可选 |

| 资产根 | 位置 |
|---|---|
| `delivery` | `code/assets/packs/` |
| `config` | 设置文件所在目录 |
| `extra:<n>` | `PNP_PACK_ROOTS` 中第 n 个以 `;` 分隔的**绝对**路径 |

技能专有的检查：id 须匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`；入口文件不超过 1 MiB，且必须带
含 `name` 与 `description` 的 frontmatter，否则
`... is missing Agent Skills frontmatter (name, description).`；`name` 与 id 不一致只给
`SKILL_NAME_MISMATCH` 警告；目录树不超过 512 项，不得含指向目录外的链接。

**本交付的行为**：技能条目被解析、合并、校验路径，但没有投影器把它送进引擎。
`capability-readiness` 把每个启用且面向当前引擎的技能记为 `projection-unavailable`：
`required: false` 的写进启动日志 `configuration.capabilities.skipped`，`required: true` 的
让启动以 502 `ENGINE_ASSET_KIND_UNSUPPORTED` 拒绝，消息列出域名与 id。

### 4.6 `assets`

```json
"assets": { "hook": { "audit": { "path": "assets/hooks/audit.js", "layout": "file" } } }
```

`assets.<kind>.<id>`，`<kind>` 是任意非空字符串——这是配置模型的开放点，解析器不枚举类别。
两个例外：`assets.instruction` 与 `assets.skill` 被拒绝并提示改用 `instructions` / `skills`
（`common.assets.skill is an alias; use skills instead.`）。条目字段与第 4.5 节相同，
`layout` 缺省为 `file`。投影状态与技能相同：解析校验、`projection-unavailable`、
必需即拒绝启动。

### 4.7 `packs`

```json
"packs": {
  "office-pack": {
    "enabled": true, "required": false, "root": "config",
    "permitNativeExtensions": false,
    "contributions": { "skill": { "docx": { "enabled": true } } }
  }
}
```

| 字段 | 说明 |
|---|---|
| id（键名） | 须匹配 `^[a-z0-9-]+$` |
| `enabled` | 只有显式 `false` 才把包从有效设置里去掉；省略视为启用 |
| `required` | 缺省 `false` |
| `root` | 资产根**名字**（`delivery` / `config` / `extra:<n>`），不是路径；不认识的名字拒绝 |
| `permitNativeExtensions` | 布尔，缺省 `false` |
| `contributions.<kind>.<id>` | `{enabled, required, parameters}`，跨层按 id 合并 |

**本交付的行为**：`capability-readiness` 把每个启用的包记为 `pack-loader-unavailable`；
`required: true` 时启动以 502 `PACK_LOADER_UNAVAILABLE` 拒绝，否则记入跳过报告。

### 4.8 `native`

```json
"cores": { "opencode": { "native": { "share": "disabled" } } }
```

任意 JSON 对象（值必须是有限的 JSON：不能有函数、循环引用、非普通对象），`common` 与
`cores.<id>` 浅合并。**本交付的行为**：合并后非空时，`/config` 报告 `nativeOptionsPending:
true`，启动以 400 `NATIVE_OPTIONS_UNSUPPORTED` 拒绝——没有引擎连接了这个域的校验与投影，
静默忽略引擎选项不是可接受的替代。

---

## 5. 凭据规则

```text
code/runtime/local.env  或进程环境                     (值)
   |  启动时 src/config/local-env.ts 读入；已存在的变量优先；只打印名字
   v
config/settings.json                                    (名字)
   |  解析器要求名字形如 ^[A-Za-z_][A-Za-z0-9_]*$，否则 SETTINGS_INVALID
   |  启动时 src/integration/index.ts 按名字取值；缺一个即拒绝启动
   v
引擎子进程环境 / 请求头                                  (值)
   本文件、日志、/config 应答、错误消息里永远只有名字
```

**为什么文件里只有变量名。** 每个可能装凭据的槽位——`apiKeyEnvironment`、`headersEnvironment`、
`caFileEnvironment`、`endpointEnvironment`、`modelIDEnvironment`、`urlEnvironment`、
`headerEnvironment` 的值、`env` 的值——解析器都要求是变量名的形状。把密钥直接粘进去会在加载时
被指名拒绝：`common.model.models[0].apiKeyEnvironment must name an environment variable, not
hold its value.`。因此这个文件可以提交、可以整份给审阅者看。

**值放在哪里。** 三种方式，前者优先：

| 方式 | 说明 |
|---|---|
| 启动窗口的环境变量 | `$env:PNP_MODEL_API_KEY = '...'`，对本次启动有效 |
| `code/runtime/local.env` | `NAME=VALUE` 每行一条，`#` 注释；`runtime/` 不入包、不入库；`PNP_LOCAL_ENV_FILE` 可改位置 |
| `.\pnp.cmd config` | 交互或 `--endpoint/--model/--api-key/--headers` 写入上一行的文件，密钥不回显；只写模型的四个变量（外加需要时的 `PNP_ALLOW_HTTP_ENDPOINTS`），不碰 `settings.json` |

无论用 `gateway.cmd`、`pnp.cmd start` 还是 `npm start` 启动，`local.env` 都在读取任何设置之前
装入进程环境；已经存在的变量不会被文件覆盖；控制台只打印装入的**名字**。

**内网三种情况**：

| 情况 | 变量 | 说明 |
|---|---|---|
| 需要 `appid` 一类请求头 | `PNP_MODEL_HEADERS={"appid":"12345"}` | 必须是 JSON 对象且值为字符串，否则 503 `MODEL_ENVIRONMENT_INVALID` |
| 自签或私有 CA | `PNP_MODEL_CA_FILE=D:\certs\internal-ca.pem` | PEM 文件；相对路径按 `code/` 解析；文件不存在则 503 `MODEL_CA_FILE_MISSING` |
| 端点是 `http://` 且不在回环 | `PNP_ALLOW_HTTP_ENDPOINTS=1` | 同时放开模型端点与 MCP `url`；`pnp.cmd config` 遇到这类地址自动写入 |

来不及配证书时可临时 `PNP_MODEL_TLS_INSECURE=1`，仅限内网。

**MCP 服务器的凭据**同一套规则：stdio 用 `env`（子进程变量名 → 网关变量名），http 用
`headerEnvironment`（头名 → 变量名）与 `urlEnvironment`。启动时按名取值，缺失的以变量名报错，
值不进日志、不进错误消息、不写回任何文件。

**HTTP 边界**：`/config` 家族双向扫描文档，键名形如凭据（`token`、`secret`、`apiKey`、
`password` …）且值是字符串的字段，以及 `endpoint` / `url` 里带用户名密码或形如凭据的查询参数，
一律 400 `CONFIG_HTTP_UNSAFE_FIELD`：`Configuration field settings.cores.opencode.native.apiKey
cannot cross the HTTP boundary.`。`runtime/local.env` 不经任何路由；指令文件若与它是同一个文件
（链接），以 403 `CONFIG_PATH_FORBIDDEN` 拒绝。

---

## 6. 改完怎么生效

模型目录、策略、MCP 服务器、指令**列表**与四个能力域都在进程启动时读取一次
（`loadIntegration` 只在 `main.ts` 跑一次），之后冻结。`src/config/effects.ts` 给出的表：

| 改了什么 | 生效方式 | 对已打开的会话 |
|---|---|---|
| `model`、`permissions`、`instructions`（列表）、`mcp`、`skills`、`assets`、`packs`、`native` | **重启网关** | 不受影响，重启前沿用旧值 |
| 已列出的指令文件的**文本** | **新会话**即用新文本，不需重启 | 引擎相关：OpenCode（ACP）会话在下一轮以 409 `ENGINE_BINDINGS_CHANGED` 停下，需开新会话；Pi 会话保持启动时注入的文本 |

没有任何一种改动会热修改运行中的会话，也不会重写引擎已生成的原生配置。重启就是在网关窗口
`Ctrl+C` 后再次 `gateway.cmd`（或 `.\pnp.cmd stop` / `start`）。

**`pnp.cmd config` 与直接编辑文件的关系**：`pnp.cmd config` 只写 `runtime/local.env` 里的
模型变量，从不改 `settings.json`；`settings.json` 用编辑器改，或经 `PUT /config` 改，改的是
同一个文件。三者改完都要重启。`GET /config` 的 `running.inSync` 告诉你文件现在的 SHA-256 是否
还等于进程启动时装入的那份——手工编辑后它变成 `false`，直到重启。

经 `PUT /config` 写入的流程：

```text
PUT /config {settings, baseSha256, label?}
   |-- HTTP 边界扫描            形如凭据的值 -> 400 CONFIG_HTTP_UNSAFE_FIELD
   |-- 对全部引擎校验          任一错误 -> 400 SETTINGS_INVALID + problems[]
   |-- 文件 sha256 != baseSha256 -> 409 CONFIG_CONFLICT {current}
   |-- 备份 runtime/config-history/settings-<时间戳>[-label].json
   |-- 写临时文件 + fsync，再 rename 覆盖 settings.json
   v
{sha256, backup, effect:"restart", changed:[...], running:{inSync:false}}
```

`PNP_CONFIG_READONLY=1` 让两条写路由返回 403 `CONFIG_READONLY`，读路由照常。

---

## 7. `/config` HTTP 接口

与业务接口同一地址 `http://127.0.0.1:6217`，请求体与应答均为 JSON。只在设置文件存在时挂载
（用旧式 profile 启动、没有 `settings.json` 的部署没有这组路由）。所有应答**从不含变量值**。

| 方法 | 路径 | 输入 | 应答 |
|---|---|---|---|
| `GET` | `/config?engine=<id>` | `engine` 可选，缺省为启动引擎；未注册的 id → 404 `CONFIG_UNKNOWN_ENGINE` | `{file, running, effective, provenance[], capabilities, effect, effects[], warnings[]}` |
| `GET` | `/config/raw` | — | `{settings, sha256, modifiedAt}`，响应头 `ETag: "<sha256>"` |
| `POST` | `/config/validate` | `{settings, engines?: [id...]}` | `{ok, problems[], effective{<id>}, provenance{<id>}, capabilities{<id>}}`；多引擎时 `problems[].path` 前缀 `engines.<id>.` |
| `GET` | `/config/environment` | — | `{variables: [{variable, set, kind, paths[]}], howToSet}`；`kind` 为 `model` / `mcp` / `asset` / `runtime` |
| `GET` | `/config/files?kind=instruction` | `kind` 只接受 `instruction` | `{kind, root, files: [{path, bytes, sha256}]}` |
| `GET` | `/config/files/instruction/<name>.md` | — | `{path, text, sha256, effect, residents, note}` |
| `PUT` | `/config` | `{settings, baseSha256, label?}`；`label` 匹配 `^[A-Za-z0-9._-]{1,48}$` | `{sha256, backup, effect, changed[], running}`；409 `{code:"CONFIG_CONFLICT", message, current}`；400 `{code:"SETTINGS_INVALID", message, problems[]}` |
| `PUT` | `/config/files/instruction/<name>.md` | `{text, ifMatch}`；`ifMatch` 为当前 sha256 或 `*` | `{path, sha256, effect, residents, note}`；409 同上 |

`GET /config` 应答里几个字段的含义：

| 字段 | 含义 |
|---|---|
| `file` | `{path, sha256, modifiedAt, readonly}`，磁盘上的文件 |
| `running` | `{engine, sha256, loadedAt, inSync}`，进程启动时装入的那份及是否仍一致 |
| `effective` | 该引擎合并后的设置，形状即第 1–4 节描述的有效值（路径已成绝对，占位符已展开） |
| `provenance[]` | 每个有效值的来源：`layer` 为 `common` / `core` / `default`（schema 默认）/ `environment`（变量，附 `variable` 与 `set`） |
| `capabilities` | `{engineId, applicable, skipped[], required[], nativeOptionsPending}`：这份配置里被接受但当前交付不会投影给该引擎的部分。`skipped[]` / `required[]` 的每项是 `{kind, id, reason}`，`reason` 取 `not-targeted`（`engines` 未包含该引擎）、`projection-unavailable`（该资产类别没有投影器）、`pack-loader-unavailable`；`applicable: false` 表示按这份文件该引擎将拒绝启动（有 `required` 项或 `native` 非空） |
| `effect` / `effects[]` | 第 6 节的表：`effect` 恒为 `restart`（整体结论），`effects[]` 逐段给出 `{section, effect, residents, note}` |
| `warnings[]` | 校验时的非致命问题，如可选资产缺失 `ASSET_MISSING`、技能名不一致 `SKILL_NAME_MISMATCH` |

**例一：读取有效配置与来源**

```powershell
Invoke-RestMethod 'http://127.0.0.1:6217/config?engine=opencode' | ConvertTo-Json -Depth 6
```

应答节选（随包文件、四个模型变量未设的机器）：

```json
{
  "file": { "path": "D:\\pnp\\solution\\code\\config\\settings.json",
            "sha256": "75589eae…1646e", "modifiedAt": "2026-09-09T12:34:24.376Z",
            "readonly": false },
  "running": { "engine": "opencode", "sha256": "75589eae…1646e",
               "loadedAt": "2026-09-09T13:00:02.118Z", "inSync": true },
  "effective": {
    "model": { "default": { "providerID": "competition", "modelID": "default" },
               "models": [ { "selection": { "providerID": "competition", "modelID": "default" },
                             "protocol": "openai-chat", "headerEnvironment": {},
                             "endpointEnvironment": "PNP_MODEL_ENDPOINT", "…": "…" } ] },
    "permissions": { "default": "allow", "operations": {} },
    "instructions": [ "D:\\pnp\\solution\\code\\config\\instructions\\competition.md" ],
    "mcp": { "servers": [ { "id": "office", "transport": "stdio",
                            "command": "D:\\pnp\\solution\\code\\runtime\\bootstrap\\node-v24.19.0-win-x64\\node.exe",
                            "args": [ "D:\\pnp\\solution\\code/dist/tools/office-mcp/main.js" ],
                            "env": {}, "enabled": true, "sideEffect": "write" }, "…" ] },
    "skills": [], "assets": {}, "packs": [], "native": {},
    "assetRoots": [ { "name": "delivery", "path": "D:\\pnp\\solution\\code\\assets\\packs" },
                    { "name": "config",   "path": "D:\\pnp\\solution\\code\\config" } ]
  },
  "provenance": [
    { "path": "permissions.default", "layer": "common", "source": "common.permissions.default" },
    { "path": "mcp.servers.0.sideEffect", "layer": "common",
      "source": "common.mcp.servers.office.sideEffect" },
    { "path": "common.model.models.0.endpointEnvironment", "layer": "environment",
      "source": "PNP_MODEL_ENDPOINT", "variable": "PNP_MODEL_ENDPOINT", "set": false }
  ],
  "capabilities": { "engineId": "opencode", "applicable": true,
                    "skipped": [], "required": [], "nativeOptionsPending": false },
  "effect": "restart",
  "effects": [ { "section": "model", "effect": "restart", "residents": "unaffected", "note": "…" },
               { "section": "instruction-file", "effect": "new-sessions",
                 "residents": "engine-dependent", "note": "…" } ],
  "warnings": []
}
```

**例二：保存前校验一份候选文件**。把第 3 节的示例存为 `candidate.json`，改错两处试试：
`operations.shell` 写成 `"prompt"`，并在 `cores.pi` 下对 `common` 没有的 `foo` 写
`{"enabled": false}`。

```powershell
$settings = Get-Content .\candidate.json -Raw
$body = '{"settings":' + $settings + ',"engines":["opencode","pi"]}'
Invoke-RestMethod -Method Post http://127.0.0.1:6217/config/validate `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) | ConvertTo-Json -Depth 6
```

应答：

```json
{
  "ok": false,
  "problems": [
    { "severity": "error", "path": "engines.opencode.common.permissions.operations.shell",
      "code": "SETTINGS_INVALID",
      "message": "common.permissions.operations.shell must be allow, deny, or ask." },
    { "severity": "error", "path": "engines.opencode.cores.pi.mcp",
      "code": "SETTINGS_INVALID",
      "message": "effective.mcp.servers.foo.transport must be a non-empty string." },
    { "severity": "error", "path": "engines.pi.common.permissions.operations.shell",
      "code": "SETTINGS_INVALID",
      "message": "common.permissions.operations.shell must be allow, deny, or ask." },
    { "severity": "error", "path": "engines.pi.cores.pi.mcp",
      "code": "SETTINGS_INVALID",
      "message": "effective.mcp.servers.foo.transport must be a non-empty string." }
  ],
  "effective": {}, "provenance": {}, "capabilities": {}
}
```

改回去再发一次，`ok` 为 `true`，`problems` 只剩两个可选资产缺失的 `warning`，`capabilities.opencode`
给出 `nativeOptionsPending: true`、`applicable: false`，`capabilities.pi` 给出两条
`projection-unavailable` 的 `skipped`——与第 3 节表格一致。校验路由不写盘；`PUT /config`
在写入前会对**全部**注册引擎做同样的校验。

---

## 8. 校验与排错

三种时机会拒绝一份设置，错误码不同：

| 时机 | 错误码 | 含义 |
|---|---|---|
| 解析（启动、`GET /config`、`/config/validate`） | `SETTINGS_INVALID`（400） | 形状、取值、路径、合并结果不合法；消息以字段路径开头 |
| 解析 | `ASSET_OUTSIDE_ROOT`（403） | `path` / `entry` 逃出批准的资产根 |
| 启动（`loadIntegration`） | `INTEGRATION_CONFIG_INVALID`、`MODEL_ENVIRONMENT_MISSING`、`MODEL_AUTH_MISSING`、`MODEL_CA_FILE_MISSING`、`INSECURE_MODEL_ENDPOINT`、`ENGINE_ASSET_KIND_UNSUPPORTED`、`PACK_LOADER_UNAVAILABLE`、`NATIVE_OPTIONS_UNSUPPORTED` | 文件合法，但变量缺失、命令不是绝对路径、传输不合规，或配置了当前交付不投影的必需能力 |

启动阶段的错误直接打印在网关窗口，进程以非零退出码结束，消息里只有变量名。改文件前先用
`POST /config/validate` 试，或直接启动看第一条错误。

**`SETTINGS_INVALID` 常见消息与改法**（消息原文）：

| 消息 | 原因 | 改法 |
|---|---|---|
| `settings.version must be 1.` | `version` 不是 `1` | 写 `"version": 1` |
| `common.permisions is an unknown field.` / `cores.pi.hooks is an unknown field.` | 八个键以外的键 | 改成八个键之一，或删除 |
| `common.model.models[0].protocol is unsupported.` | 协议名不对 | 写 `openai-chat` 或 `anthropic-messages` |
| `common.model.models[0] needs exactly one of endpoint and endpointEnvironment.` | 两个都写或都没写 | 留一个 |
| `common.model.models[0].apiKeyEnvironment must name an environment variable, not hold its value.` | 把值写进了名字槽 | 改成变量名，值放 `local.env` |
| `common.model.models[0].endpoint is not an approved transport.` | `http://` 非回环，或 URL 带凭据 | 改 `https`，或设 `PNP_ALLOW_HTTP_ENDPOINTS=1`；去掉 URL 里的用户名密码 |
| `Effective default model for pi names a provider with 0 models; name modelID.` | `default` 只写 provider 但该 provider 没有或有多个模型 | 补 `modelID`，或让该 provider 恰有一个条目 |
| `common.permissions.operations.shell must be allow, deny, or ask.` | 效果值拼错 | 三选一 |
| `Instruction file is missing or unreadable: <路径>` | 指令文件不存在 | 修正路径（相对设置目录）或创建文件 |
| `effective.mcp.servers.foo.transport must be a non-empty string.` | 在 `cores.<id>` 下覆盖了 `common` 没有的服务器 | 在 `common` 声明它，或在 `cores.<id>` 写全 |
| `effective.mcp.servers.office.transport must be stdio or streamable-http.` | 传输名不对 | 二选一 |
| `effective.mcp.servers.office.command uses an unsupported placeholder ${PNP_PYTHON}.` | 未知占位符 | 只用 `${PNP_NODE}` / `${PNP_CODE_ROOT}`，或写绝对路径 |
| `effective.mcp.servers.office stdio server cannot define HTTP fields.` | stdio 条目写了 `url` 等 | 删掉，或改 `transport` |
| `effective.mcp.servers.office.sideEffect must be read, write, or external.` | 副作用值不对 | 三选一 |
| `effective.mcp.servers.mail.env.MAIL_TOKEN must name an environment variable, not hold its value.` | `env` 的值写成了凭据 | 改成变量名 |
| `common.assets.skill is an alias; use skills instead.` | 用了别名域 | 改写到 `skills` / `instructions` |
| `common.skills.Office has an invalid skill id.` | id 含大写或非法字符 | 小写字母数字与 `._-` |
| `common.skills.office-report.path is missing or unreadable.` | `required: true` 且路径缺失 | 补目录，或改 `required: false` |
| `common.skills.office-report.entry is missing Agent Skills frontmatter (name, description).` | `SKILL.md` 没有 frontmatter | 文件顶部加 `---\nname: …\ndescription: …\n---` |
| `common.packs.Bad_Id has an invalid pack id.` | 包 id 含大写或下划线 | 只用 `[a-z0-9-]` |
| `common.skills.outside.path is outside the approved asset roots.`（`ASSET_OUTSIDE_ROOT`） | 路径不在任何资产根内 | 放进设置目录或 `assets/packs/`，或用 `PNP_PACK_ROOTS` 加根 |

**启动阶段常见消息**：

| 消息 | 改法 |
|---|---|
| `Tool command must be absolute.` | stdio 服务器的 `command` 写绝对路径（或 `${PNP_NODE}`） |
| `Required tool environment variable is absent: PNP_MAIL_TOKEN.` | 在 `local.env` 设该变量 |
| `The configured model settings name environment variables that are not set: PNP_MODEL_ENDPOINT, PNP_MODEL_ID.` | `.\pnp.cmd config` |
| `Engine "opencode" has no connected settings projector for required domain(s): "skill" ("office-report").` | 该条目改 `required: false`，或从该引擎的 `engines` 中去掉 |
| `Required pack(s) "office-pack" need the manifest loader and engine projectors.` | 包改 `required: false` 或 `enabled: false` |
| `Engine "opencode" has no connected native-options validator/projector in this configuration path.` | 删除该引擎有效的 `native` 内容 |

**接口层错误**：`CONFIG_CONFLICT`（409，附 `current` 摘要，重新 `GET /config/raw` 后再提交）、
`CONFIG_READONLY`（403，`PNP_CONFIG_READONLY=1`）、`CONFIG_HTTP_UNSAFE_FIELD`（400，见第 5 节）、
`CONFIG_PATH_FORBIDDEN`（403，指令路径不是 `config/instructions/` 直接下的 `.md`）、
`CONFIG_FILE_TOO_LARGE`（413，指令文件超过 1 MiB）。
