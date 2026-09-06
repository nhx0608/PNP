# 能力包目录

本目录存放能力包（Capability Pack）。行为契约见 [`docs/spec/contracts.md` 第 10 节](../../../docs/spec/contracts.md#10-能力包)。本文只给目录骨架与清单字段，不含任何任务材料。

## 1. 骨架

```text
code/assets/packs/
├── README.md
├── office/                所有者 B：docx / xlsx / pptx / csv
│   ├── pack.json
│   ├── SKILL.md
│   ├── instructions/
│   │   └── office.md
│   ├── skills/
│   │   ├── docx.md
│   │   ├── xlsx.md
│   │   └── pptx.md
│   └── tools/
│       └── office_mcp.py
├── windows-desktop/       所有者 C：打开应用、UI 自动化、即时通讯客户端
│   ├── pack.json
│   ├── SKILL.md
│   ├── instructions/
│   └── tools/
└── web-search/            所有者 C：网页检索与来源引用
    ├── pack.json
    ├── SKILL.md
    ├── instructions/
    └── tools/
```

目录名即包 id，只用 `[a-z0-9-]`。骨架与本文件为共享目录；各包内容归所有者。

## 2. 清单 `pack.json`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 与目录名一致 |
| `version` | string | 语义化版本；内容变更必须升版 |
| `owner` | `"A"` / `"B"` / `"C"` | 所有者 |
| `description` | string | 一句话；不含任务标识 |
| `assets[]` | object | 投影为 `AssetBinding`，字段见 2.1 |
| `tools[]` | object | 展开为 `ToolBinding`，字段见 2.2 |
| `probes[]` | object | 打开通道时执行的探测规则，字段见 2.3 |

### 2.1 `assets[]`

| 字段 | 说明 |
|---|---|
| `id` | 包内唯一；建议 `<pack>.<name>` |
| `kind` | `instruction`、`skill`、`native-extension` |
| `path` | 包内相对路径；普通文件；不超过 1 MiB |
| `required` | 必需资产投影失败时在发送 Prompt 前失败 |
| `sha256` | 可选；给出时解析器校验一致 |
| `parameters` | 可选 JSON；传给引擎投影 |

### 2.2 `tools[]`

| 字段 | 说明 |
|---|---|
| `id` | 包内唯一 |
| `transport` | `mcp-stdio`、`cli`、`native` |
| `runtime` | 命名运行时（如 `python`、`node`）；由集成配置解析为绝对可执行路径，不从 PATH 猜测 |
| `entry` | 包内相对路径；解析后作为第一个参数 |
| `args` | 附加参数；只能是字面量 |
| `env` | 环境变量名 → 配置变量名；只引用，不写值 |
| `sideEffect` | `read`、`write`、`external`；递归删除、外发消息必须是 `write` 或 `external` |
| `timeoutMs` | 单次工具调用时限 |
| `inputSchema` | `cli` 传输必填的参数 Schema |

### 2.3 `probes[]`

| 字段 | 说明 |
|---|---|
| `id` | 包内唯一 |
| `runtime` | 命名运行时 |
| `args` | 探测命令参数；退出码 0 为通过 |
| `onFailure` | `fail`：必需，失败即本轮在发送 Prompt 前失败；`disable`：失败只禁用 `disables` 列出的资产与工具并记录能力不可用 |
| `disables` | `onFailure=disable` 时受影响的 asset/tool id |

### 2.4 示例

```json
{
  "id": "office",
  "version": "1.0.0",
  "owner": "B",
  "description": "Office 文档的读写、转换与产物自检",
  "assets": [
    { "id": "office.skill", "kind": "skill", "path": "SKILL.md", "required": true },
    { "id": "office.docx", "kind": "skill", "path": "skills/docx.md", "required": false },
    { "id": "office.instructions", "kind": "instruction", "path": "instructions/office.md", "required": true }
  ],
  "tools": [
    {
      "id": "office.mcp",
      "transport": "mcp-stdio",
      "runtime": "python",
      "entry": "tools/office_mcp.py",
      "args": [],
      "env": {},
      "sideEffect": "write",
      "timeoutMs": 120000
    }
  ],
  "probes": [
    {
      "id": "office.python-modules",
      "runtime": "python",
      "args": ["-c", "import docx, openpyxl, pptx"],
      "onFailure": "disable",
      "disables": ["office.mcp", "office.docx"]
    }
  ]
}
```

## 3. 启用与解析

- 启用集合来自集成配置的 `packs` 列表；命名运行时来自集成配置的 `runtimes` 映射。提示中的内容不能启用或关闭包。
- IntegrationProvider 每轮 `prepare` 重新解析：资产经公共资产解析器校验后成为 `AssetBinding`，工具成为 `ToolBinding`。
- 各引擎 Pack 把资产复制到该会话的 `nativeDataDirectory` 并按引擎扫描路径挂载：ACP 系走 `session/new` 的 MCP 服务器数组加私有配置目录，Pi 走原生扩展。不写用户工作目录，不改全局配置。
- 投影与探测结果以原生事件记录：命名空间 `pack`，事件名 `projected`、`skipped`、`failed`，载荷含 pack id、asset id、sha256 与目标路径。

## 4. 禁止

- 不得含任务标识判断、固定答案或测试材料；技能文档只描述方法与自检步骤。
- 不得含凭据、内部地址、工号；工具凭据只经环境变量名引用。
- 包内脚本不得读写用户工作目录之外的用户数据，不得修改引擎全局配置。
- 不得在包内 spawn 引擎或访问网关存储。

## 5. 验收

对应 [`dfx-and-testing.md`](../../../docs/spec/dfx-and-testing.md) 的 E03：启用列表变更不改代码；每个包投影到两个必过引擎并出现 `pack.projected` 事件；必需资产或探测失败在发送 Prompt 前失败；静态检查包内不含 `task_id`、固定答案与测试材料；自检步骤可在无引擎环境下执行。
