# G02 内部部署模型接入：各引擎对自定义 OpenAI/Anthropic 兼容端点的支持

## 摘要
候选引擎在"接自定义/内部部署模型端点"上分两类：一类硬编码单一 wire 协议（Claude Code 仅认 Anthropic Messages；Codex 2026-02 起仅认 Responses API），只能靠环境变量换 base URL，协议不匹配时必须外挂 LiteLLM/claude-code-router 等协议转换代理；另一类在配置层把"wire 协议"做成可选字段（opencode 的 `@ai-sdk/openai-compatible` vs `@ai-sdk/anthropic`、pi 的 `api: openai-completions|anthropic-messages|openai-responses|...`、Codex/dsh/Kimi CLI 的 provider 声明），可以直接对接内部网关的原生协议而无需转换，是接入内部模型摩擦最小的引擎。Goose、Qwen Code 遵循"OpenAI SDK 环境变量惯例"（`OPENAI_BASE_URL`/`OPENAI_API_KEY`），零配置文件改动即可切换。Gemini CLI 用 `GOOGLE_GEMINI_BASE_URL` 整体重定向但协议仍是 Gemini 原生，且沙箱模式下该变量不透传（已知 bug）。协议转换代理层（LiteLLM/claude-code-router/CLIProxyAPI）已知坑集中在：流式 tool_calls 参数拼接损坏（reasoning→tool_calls 混合流）、`cache_control` prompt-cache 语义丢失、`thinking`/`reasoning` 字段无法一一映射、Anthropic 工具 schema 严格性校验。架构建议：网关统一部署一个模型代理（推荐 LiteLLM Proxy 或自研轻量转换网关），对外同时暴露 OpenAI chat/completions 与 Anthropic Messages 两种协议，各引擎按"配置模板注入"方式接入，新引擎接入只需新增模板、判断是否需要协议转换。

## 关键事实


| 事实 | 来源 | 置信度 | 交叉验证 |
|---|---|---|---|
| Claude Code 通过 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`（settings.json 的 `env` 块或 shell 环境变量）指向自定义端点，但端点必须原生说 Anthropic Messages 协议；Anthropic 官方明确"不支持通过任何网关把 Claude Code 路由到非 Claude 模型" | code.claude.com/docs/en/llm-gateway | 高 | 已交叉验证（docs.claude.com 重定向到同一页 + requesty.ai 独立描述一致） |
| Codex 的 `[model_providers.<id>]` 支持 `name/base_url/env_key/wire_api/query_params/http_headers/env_http_headers`；自定义 provider 不能占用保留 id `openai/ollama/lmstudio` | learn.chatgpt.com/docs/config-file/config-advanced | 高 | 已交叉验证（与 morphllm.com、codex.danielvaughan.com 独立描述一致） |
| Codex 的 `wire_api` 字段截至 2026-09 官方文档明确列出 `"responses"` 为主要取值；三方来源提到 2026年2月起 Chat Completions 支持已被移除，仅保留 responses | learn.chatgpt.com + 三方 blog | 中（三方来源未能被官方页直接复核细节） | 部分交叉验证 |
| pi 的 `pi.registerProvider(id, config)` 支持 `api` 字段取值 `openai-completions/anthropic-messages/openai-responses/mistral-conversations/google-generative-ai/bedrock-converse-stream`，模型定义可覆盖 provider 级 `api` | pi.dev/docs/latest/custom-provider | 高 | 已交叉验证（aliou.me 博客与 GitHub docs/custom-provider.md 描述一致） |
| pi 也支持免代码的 `~/.pi/agent/models.json`，优先级高于代码注册的 provider（override 语义） | pi.dev/docs/latest/custom-provider | 高 | 单来源 |
| opencode 用 `opencode.json` 的 `provider.<id>.npm`（如 `@ai-sdk/openai-compatible`/`@ai-sdk/anthropic`）+ `options.baseURL`/`options.apiKey` + `models` 映射自定义 provider；baseURL 不应包含 `/chat/completions` | deepwiki.com/sst/opencode + haimaker.ai/ourtoken.ai | 中 | 部分交叉验证（deepwiki 摘要与多篇第三方教程一致，未直接读官方 opencode.ai 文档源码） |
| Goose 用环境变量 `GOOSE_PROVIDER=openai` + `OPENAI_HOST=<base url>` + `OPENAI_API_KEY` + `GOOSE_MODEL` 配置任意 OpenAI 兼容端点，也可用 `goose configure` 交互式设置 Custom provider | hpc-ai.com docs / goose-docs.ai | 中 | 单来源为主，交互配置流程被多篇第三方文章重复描述 |
| dsh（DeepSeek Harness）把模型适配器做成插件，在 `$DSH_HOME/settings.yaml` 里注册任意 OpenAI 兼容端点：provider id、base URL、protocol、credential env、models 列表；UI 里也可 Settings→Models→Add custom provider | apidog.com/ofox.ai 等三方 | 低（未找到 DeepSeek 官方一手文档，均为第三方转述/教程站） | 未交叉验证到官方源 |
| Qwen Code CLI 遵循 OpenAI SDK 惯例：`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL` 环境变量或 `.qwen/.env`；也支持 `settings.json` 里的 `modelProviders` 数组配置多个 provider，每项可带 `baseUrl` | qwenlm.github.io/qwen-code-docs | 高 | 已交叉验证（DataCamp 教程与官方文档一致；配置优先级 CLI > env(QWEN_*/OPENAI_*) > .qwen/settings.json > 全局 settings > 内置默认） |
| Kimi CLI（moonshotai/kimi-cli）用 TOML `[providers.<id>]`（`type="kimi"`、`base_url`、`api_key`）配置自定义端点；区分 `KIMI_CODE_BASE_URL`（OAuth 面向 kimi.com）与 `KIMI_BASE_URL`（直接 API Key 面向 moonshot.ai）两套变量，二者不可混用凭证 | moonshotai.github.io/kimi-cli docs | 高 | 单来源（官方文档），字段名与结构在多语言镜像页一致 |
| Hermes Agent 的"Custom endpoint"选项要求 base URL 以 `/v1` 结尾（Hermes 自动补 `/chat/completions`），`api_mode` 字段默认 `chat_completions`；支持配置"backup providers 链"和独立的 auxiliary model 路由 | hermes-agent.nousresearch.com | 中 | 单来源为主（官方文档站），第三方教程站描述一致但未逐字核对 |
| Gemini CLI 通过 `GOOGLE_GEMINI_BASE_URL`（来自 `@google/genai` SDK）把请求整体重定向到任意端点，或 `~/.gemini/settings.json` 的 `baseUrl`/`apiKey`；沙箱模式下该变量不会传入容器（已知问题，需 `--sandbox=false`） | GitHub PR #2899 + dev.to 教程 | 中 | 部分交叉验证（PR 描述与教程站一致，但未见到 Google 官方文档明确列出 OpenAI chat/completions 直通模式，2026-06 起 Gemini CLI 个人 OAuth 已被弃用，进一步依赖自定义端点/Vertex） |
| LiteLLM Proxy 作为统一网关，接收 OpenAI 兼容请求并转发到 Anthropic/Bedrock/Vertex 等后端，可通过 `router_settings.model_group_alias` 做模型别名映射；Qwen Code CLI 等客户端只需把 `OPENAI_BASE_URL` 指向 LiteLLM Proxy 即可 | docs.litellm.ai/docs/tutorials/litellm_qwen_code_cli | 中 | 单来源 |
| claude-code-router / CLIProxyAPI 类协议转换层存在已知坑：(1) 流式响应中 reasoning→tool_calls 的模型（如 Qwen3 思考模式）会导致 tool-call 参数 JSON 在增量拼接中被破坏；(2) OpenAI 兼容后端把 `function.name` 只在首个 delta 给出、后续留空，转换器可能生成多余的空 `content_block_start`，破坏 Claude Code 的工具调用解析；(3) Claude 的 `cache_control` prompt caching 断点在转换到 OpenAI 兼容后端时容易丢失或无法保持 1 小时 TTL；(4) Anthropic 工具 schema 里若省略 `{"type":"object"}` 等字段，部分 OpenAI 兼容后端会直接拒绝 | GitHub musistudio/claude-code-router#1397, router-for-me/CLIProxyAPI#3165 & #3398 | 高（一手 issue） | 已交叉验证（两个独立仓库的 issue 描述同类问题） |

## 架构与工作原理

各引擎接入自定义模型端点的方式可归纳为三种"层次"：

1. **环境变量重定向层**（最浅）：引擎在启动时读取形如 `<VENDOR>_BASE_URL` / `<VENDOR>_API_KEY` 的环境变量，把内置的默认厂商端点整体替换为自定义 URL，但**协议形态不变**——引擎依然按它原生认的那套 wire protocol 组包、解包。典型代表：Claude Code（`ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN`，协议永远是 Anthropic Messages）、Gemini CLI（`GOOGLE_GEMINI_BASE_URL`，协议是 Gemini generateContent，尽管也存在部分 OpenAI 兼容层）、Qwen Code（`OPENAI_BASE_URL`+`OPENAI_API_KEY`，协议固定 OpenAI chat/completions）。这一层最简单，但**引擎认死一种协议**，如果内部模型网关不支持该协议，就必须在网关侧做转换（见下）。

2. **多 provider 注册层**（中等）：引擎内置一个 provider 抽象，允许在配置文件里声明"provider id → wire 协议类型 + base URL + 认证方式 + 模型列表"的多条记录，一个引擎进程内可以同时挂多个 provider，运行时按模型名路由。典型代表：opencode（`opencode.json` 的 `provider.<id>.npm` 选择 `@ai-sdk/openai-compatible` 还是 `@ai-sdk/anthropic` 这两种 Vercel AI SDK adapter，外加 `options.baseURL`）、pi（`pi.registerProvider(id,{api: "openai-completions"|"anthropic-messages"|"openai-responses"|...})` 或等价的 `~/.pi/agent/models.json`）、dsh（`$DSH_HOME/settings.yaml` 声明 protocol+base URL+models）、Codex（`[model_providers.<id>]` + `wire_api`）、Kimi CLI（`[providers.<id>]` TOML）。这一层的价值在于**协议是可选的一等字段**，只要引擎的 provider 抽象里包含"这个 provider 说 OpenAI chat/completions 还是 Anthropic Messages"这一开关，网关就不需要额外转换，直接把内部模型网关地址喂给引擎、并把 wire 协议设为内部网关实际提供的协议即可。

3. **网关/代理转换层**（最重）：当引擎的协议是硬编码死的（如 Claude Code 只认 Anthropic Messages），而内部模型网关只输出 OpenAI chat/completions（多数内部部署模型的现状）时，必须在两者之间插入一个协议翻译代理——LiteLLM Proxy、claude-code-router (CCR)、new-api/one-api、CLIProxyAPI 等。这类代理把 Anthropic Messages ↔ OpenAI chat/completions ↔ OpenAI Responses ↔ Gemini 等格式互相翻译，同时承担 tool_calls 参数拼接、`cache_control`/prompt cache 映射、`thinking`/`reasoning` 字段映射、SSE 流式事件重映射等工作，是已知最容易出 bug 的环节（见"权限与安全"及"启示"章节的坑清单）。

## 可编程接入面

- **CLI 启动参数/环境变量**：几乎所有引擎都支持"进程启动前用环境变量指定 base URL + key"，这是最容易被网关统一注入的接入面（Docker/K8s env、Windows 环境变量、`.env` 文件均可）。
- **配置文件字段**：opencode.json / config.toml (Codex) / settings.yaml (dsh) / models.json (pi) / settings.json (Kimi CLI, Qwen Code, Gemini CLI, Claude Code) —— 网关可以在启动引擎前用模板生成/覆写这些文件，实现"每引擎一套内部模型注入模板"。
- **SDK 级注册（代码扩展）**：pi 的 `pi.registerProvider()` 是目前发现的唯一"运行时用 JS 代码注册 provider"的机制，允许附带自定义鉴权流程（如企业 SSO/OAuth）、自定义 headers、甚至非标准流式解析逻辑，灵活度最高但需要写 pi 扩展代码。

## 会话模型
不适用——本专题聚焦模型端点协议接入，不涉及各引擎的 session/对话状态管理（该内容属于其他专题 G0x 覆盖范围）。

## 权限与安全
自定义端点接入本身几乎不带权限模型，安全面主要在两点：(1) API key 的存放位置——多数引擎推荐 `$ENV_VAR` 间接引用而非明文写入配置文件（pi 的 `apiKey: "$MY_LLM_API_KEY"`、opencode 的 `"apiKey": "$CUSTOM_OPENAI_KEY"`、Codex 的 `env_key = "PORTKEY_API_KEY"`），便于网关通过环境变量分发密钥而不落盘；(2) Claude Code 官方明确指出"网关凭证在使用时会顶替 claude.ai 订阅登录"，即只设置 `ANTHROPIC_BASE_URL` 而不设置凭证变量时流量仍会走已保存的订阅登录（可能产生非预期计费/越权），这是网关集成时必须显式覆盖两个变量的安全坑。

## 扩展机制与资产
不适用于本专题（扩展/插件资产格式属于其他专题）；仅指出 pi 的 provider 注册本身就是一种"扩展"（extension）形式，可以和其自定义工具一起打包分发，这是本专题范围内唯一与扩展机制交叉的点。

## 记忆
不适用。

## 多 Agent 与协作
不适用。

## 可观测性
不适用于协议转换本身，但注意：经协议转换代理（LiteLLM/CCR/CLIProxyAPI）中转的请求，原始 provider 返回的 usage/cost/thinking 元数据可能在转换中丢失或被重新计算，网关若要做统一计费/审计需要在代理层单独埋点，不能假设转换后的响应完整保留了原始 token 用量字段。

## 对我们架构的启示

**公共能力（所有引擎共有，可归一化）**：
- "base URL 覆盖"这一动作本身是所有 10 个引擎的公共能力，网关可以统一定义一个抽象参数 `{engine_model_base_url, engine_model_api_key, engine_model_id}`，在启动引擎前用引擎专属模板把这三元组渲染进对应的 env/config。

**扩展能力（引擎特有，需要单独适配）**：
| 引擎 | 硬编码协议？ | 关键配置面 | 网关注入方式建议 |
|---|---|---|---|
| Claude Code | 是，仅 Anthropic Messages | `ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN`（settings.json `env` 块） | 若内部模型只有 OpenAI 兼容端点，必须前置 LiteLLM/CCR 做 OpenAI→Anthropic 转换，网关只需把 `ANTHROPIC_BASE_URL` 指向转换代理 |
| Codex | 是，2026-02 起仅 Responses API（`wire_api="responses"`） | `config.toml [model_providers.<id>]` | 网关模板生成 TOML，或用 `--config` 覆盖；内部模型若只出 chat/completions，需代理转换为 Responses API 形态（比 Anthropic 转换更少见，坑更多） |
| opencode | 否，provider 级可选 `@ai-sdk/openai-compatible` 或 `@ai-sdk/anthropic` | `opencode.json provider.<id>` | 直接指向内部网关真实协议，无需转换，是接入内部模型最友好的引擎之一 |
| pi | 否，`api` 字段任选 openai-completions/anthropic-messages/openai-responses/... | `models.json` 或 `registerProvider` | 同 opencode，天然灵活；models.json 可由网关按需生成、无需重启（据文档需重启进程生效，需与网关"每轮新 session"策略配合） |
| Hermes | 否（内部转成 chat_completions） | Custom endpoint（base URL + key），`api_mode` | 直接对接 OpenAI 兼容内部网关最简单 |
| Goose | 否，`GOOSE_PROVIDER=openai` 通用 | `OPENAI_HOST`/`OPENAI_API_KEY`/`GOOSE_MODEL` 环境变量 | 环境变量注入即可，零配置文件改动 |
| dsh | 否，插件化协议声明 | `$DSH_HOME/settings.yaml` | 网关模板化 YAML；官方一手资料稀缺，需在评测环境实测确认字段名 |
| Gemini CLI | 部分——`GOOGLE_GEMINI_BASE_URL` 走原生 Gemini 协议；沙箱模式下该变量不透传（已知 bug，需 `--sandbox=false`） | `~/.gemini/settings.json` 的 `baseUrl`/`apiKey`，或环境变量 | 若内部模型非 Gemini 协议，需代理转换为 generateContent 形态；Windows 原生运行时注意沙箱开关 |
| Kimi CLI | 否，TOML provider 声明，`type="kimi"` 走其自有协议但可配 OpenAI 兼容 base_url | `[providers.<id>]` in config TOML | 区分 `KIMI_BASE_URL`（直连）与 `KIMI_CODE_BASE_URL`（OAuth），网关应统一走前者 |
| Qwen Code | 否，OpenAI SDK 惯例 | `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL` 或 `settings.json.modelProviders` | 环境变量注入即可，是接入内部 OpenAI 兼容模型最直接的引擎之一 |

**风险与坑（协议转换代理相关，务必在架构中预留缓解措施）**：
1. **Tool calling 流式拼接损坏**：reasoning→tool_calls 混合流（Qwen3 类思考模型）在协议转换时容易导致 JSON 参数被截断/损坏——若内部模型走这种输出模式，评测中"Word 润色""CSV 分析"等需要连续工具调用的任务会失败。建议网关自建的转换层对 tool_calls 增量做完整缓冲后再转发，不做逐 token 直通。
2. **cache_control/prompt caching 语义丢失**：Anthropic 的 `cache_control` 断点在转发到 OpenAI 兼容后端时无对应字段，若强行丢弃会导致成本上升但不影响正确性；若内部网关本身不支持 prompt cache，可直接忽略该字段，无需报错。
3. **thinking/reasoning 字段映射不一致**：Anthropic 的 `thinking` block、OpenAI 的 `reasoning_effort`/`reasoning_content`、Responses API 的 `reasoning` item 三者字段名和结构都不同，转换代理需要显式做空值兜底（内部模型很可能不支持 reasoning，需要转换层直接丢弃该字段而不是报 400）。
4. **Anthropic 工具 schema 严格性**：部分 OpenAI 兼容后端要求 JSON Schema 显式带 `{"type":"object"}`，Anthropic 格式若省略会被拒绝，网关的转换层需要做 schema 补全。
5. **Claude Code 官方立场**：其文档明确"不支持把 Claude Code 路由到非 Claude 模型"，这意味着若参赛方案选择接入 Claude Code 作为候选引擎之一，且内部模型不是 Claude 系列，那么 Claude Code 天然不适合本赛题（除非自建一个"伪装成 Anthropic Messages 协议的内部模型代理"，风险自负，且 Anthropic 不提供支持）。这是选择候选引擎时的一个重要判据。
6. **推荐方案**：网关层统一自建/复用一个**模型代理（推荐 LiteLLM Proxy 或自研的轻量转换网关）**，对外暴露 OpenAI chat/completions + Anthropic Messages 两种协议（内部网关是什么协议，代理就以什么为"真源"，再向两个方向转换），所有引擎统一从这个代理拉取模型服务；每种引擎的"注入方式"用**引擎专属配置模板**（.env / *.json / *.toml / *.yaml）在拉起引擎进程前渲染写入，这样上层网关代码本身不需要理解任何引擎特定协议细节，只需要维护一份"代理地址 + 各引擎模板"的映射表，新引擎接入时只需新增一份模板 + 确认它的 wire 协议是否需要代理转换。

## 未解决问题
- Codex `wire_api="chat"` 是否在 2026-09 仍可用（多个第三方来源说法不一，未能从 openai 官方 config-advanced 页面得到明确的"是否移除"结论，仅确认默认/首选值是 `"responses"`）；需要在真实 Codex CLI（评测使用的具体版本）上实测 `wire_api = "chat"` 是否报错。
- dsh（DeepSeek Harness）没有找到官方一手文档（github.com/deepseek-ai 相关仓库或官方博客），所有信息来自第三方教程/聚合站点，字段名 (`settings.yaml`) 可信度中等，需要在拿到真实 dsh 源码/官方文档后复核。
- Gemini CLI 是否有官方文档化的"直接说 OpenAI chat/completions 协议"的开关（而不是通过 `GOOGLE_GEMINI_BASE_URL` 整体重定向、协议仍是 Gemini 原生），未找到官方确证；2026-06 Google 已弃用消费者 OAuth，进一步应以 Vertex/API Key + 自定义 base URL 路径为准，需要实测。
- Hermes Agent 的 auxiliary model 路由与 backup provider 链的确切配置字段（YAML/JSON schema）未逐字核对官方 config 参考页，只读取了功能性描述。

## 来源列表
- https://code.claude.com/docs/en/llm-gateway （官方，Claude Code LLM Gateway 说明，2026-09 抓取）
- https://learn.chatgpt.com/docs/config-file/config-advanced （官方，Codex config.toml model_providers/wire_api）
- https://pi.dev/docs/latest/custom-provider （官方，pi.registerProvider 与 models.json）
- https://deepwiki.com/sst/opencode/3.3-provider-and-model-configuration （DeepWiki 源码摘要，opencode provider 配置）
- https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/ （官方，Qwen Code model providers）
- https://moonshotai.github.io/kimi-cli/en/configuration/providers.html （官方，Kimi CLI providers）
- https://hermes-agent.nousresearch.com/docs/user-guide/configuration （官方，Hermes Agent 配置）
- https://github.com/musistudio/claude-code-router/issues/1397 （一手 issue，流式 tool-call 损坏）
- https://github.com/router-for-me/CLIProxyAPI/issues/3165 （一手 issue，OpenAI→Claude 转换兼容性）
- https://github.com/router-for-me/CLIProxyAPI/issues/3398 （一手 issue，cache_control 1h TTL 保留问题）
- https://docs.litellm.ai/docs/tutorials/litellm_qwen_code_cli （官方教程，LiteLLM Proxy 用法）
- https://github.com/google-gemini/gemini-cli/pull/2899 （一手 PR，GOOGLE_GEMINI_BASE_URL 支持）
- https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/providers.md （Goose 官方文档源码）
- 第三方转述（中等置信度，未逐字核实官方源）：haimaker.ai、ofox.ai、apidog.com、hpc-ai.com、dev.to 等相关文章（见正文各处标注）
