# G11 自托管推理引擎工具调用兼容性调研

## 摘要

赛题硬约束"主模型限定内部部署模型"，意味着我们网关背后大概率不是 OpenAI/Anthropic 官方 API，而是 vLLM / SGLang / TGI / Xinference 等自托管 OpenAI 兼容推理服务。本调研证实：这类服务在 **streaming + parallel tool_calls** 场景下存在一系列已知、且截至 2026-09 仍在持续暴露的缺陷——从"多个 tool_calls 挤在一个 SSE delta 里导致断言崩溃"（vLLM #39584），到"reasoning_content 与 tool_calls 交接时丢失标记、tool 调用泄漏进 content 字段"（vLLM #50512、#27641），再到"pipeline-parallel + chunked-prefill 场景下 tool 调用 XML/JSON 被截断产生乱码"（vLLM #46262）。这些问题**不是协议字段映射层面能解决的**，而是推理引擎内部"tool parser 状态机 + 流式增量拼接 + 批处理调度"三者耦合出的深层缺陷，直接后果是 Office 自动化任务里的工具调用参数（文件路径、单元格范围、幻灯片编号等）被截断或错位，进而让 Agent Loop 卡死或产生错误操作（例如递归删除文件用例中路径参数损坏是高风险场景）。

进一步确认：这类问题不是 vLLM 独有，而是"OpenAI 兼容协议 + 自定义 tool parser + 流式增量"这一整条技术路径的通病——SGLang 有独立的 16 种 `--tool-call-parser`，各自绑定特定模型家族，出现同类"多 tool call 边界识别失败"问题（SGLang GLM issue #22922）；国内网关聚合层 one-api/new-api 主要关注"非标准字段污染"而非专门修补 tool_calls 流式拼接；下游 Agent CLI 生态（claude-code-router、opencode-openai-compatible npm 包）已经在**客户端侧**做防御性重写/补丁，说明业界共识是"不能信任自托管推理引擎的原始流式 tool_calls 输出，必须在客户端/网关层做二次校验与缓冲"。

对我们架构的核心启示：**我们自建的"模型代理层"(Model Adapter / LLM Gateway) 必须把 tool_calls 参数增量做整体缓冲（按 index 分桶累积，仅在参数 JSON 闭合后才转发/落盘），并对 reasoning_content 与 tool_calls 的交界做显式状态机识别，同时提供 JSON Schema 校验 + 有限重试兜底**——这应作为网关的"公共能力"而非留给各 Harness 各自实现，因为几乎所有下游 Harness（opencode 基于 ai-sdk、claude-code-router、pi 等）都已经在各自生态里遇到并修补过完全同类的问题，说明这是协议栈的结构性风险点，值得我们在网关的模型代理层统一收敛。

## 关键事实

1. **vLLM #39584**（2026-04-11 提出，已关闭）：Responses API 流式场景下，当模型在同一个 delta 里生成多个并行 tool_calls 时，`vllm/entrypoints/openai/responses/serving.py:1761` 的断言 `assert len(pm.tool_calls) == 1` 直接触发 `AssertionError` 导致连接崩溃；命中版本 `0.19.1.dev0+g2a69949bd`，用 `qwen3_xml` parser 复现；投机解码（speculative decoding）会放大问题（草稿模型更易一次性吐出多个 tool call）。来源：https://github.com/vllm-project/vllm/issues/39584 【已确认】
2. **vLLM #42696**（2026-05-15，已关闭）：Gemma4 tool parser 在 OpenCode 场景下流式崩坏，两种失败模式——(a) 只有首个 delta chunk 被强制要求带 `id/type/function.name`，但下游 `@ai-sdk` 的 openai-compatible provider 会校验*每个* chunk，缺字段即报 `AI_InvalidResponseDataError`（生产环境约 64% agent 受影响，修复一半后仍有约 42%）；(b) 高并发（c=500-1000）下单个 delta 内含多个完整 tool call 边界时状态机不推进 index，导致参数片段"跨 tool 错位"，`args_invalid_json` 报错率使成功率跌到 21%-35%。来源：https://github.com/vllm-project/vllm/issues/42696 【已确认】
3. **vLLM #50512**（2026-07-31 提出，PR #50528 修复关闭）：Inkling 模型多轮流式场景下，若新一轮 assistant turn 以 `<|content_invoke_tool_json|>` 开头，reasoning→tool 交接丢失"content-kind marker"，导致整段 tool call 原始文本泄漏进 `content` 字段，`tool_calls` 数组为空；非流式单次解析（`_single_pass_parse`）不受影响，说明**问题根源是流式增量状态机与一次性全量解析逻辑不一致**。来源：https://github.com/vllm-project/vllm/issues/50512 【已确认】
4. **vLLM #27641**（2025-10-28 提出，标记 "closed as not planned"，关联 PR #35449）：gpt-oss-120b/20b 在 tools 定义大、system prompt 长时，非流式请求 tool_calls 正常，但流式请求经常把本应属于 `tool_calls` 的 JSON 输出到 `reasoning_content` 字段里，`tool_calls` 保持 `None`；vLLM 维护者未给出主动修复，官方建议 workaround 是**对涉及大量工具定义的调用改用非流式（`stream=False`）**。来源：https://github.com/vllm-project/vllm/issues/27641 【已确认】
5. **vLLM #46262**：Pipeline-Parallel（PP2）+ chunked-prefill 场景下 GLM-5.2-FP8（DSA）tool calling 产生乱码，根因是 `condense()` 复制 token 时用 `num_tokens_no_spec` 计数，请求在 unscheduled→re-added 过程中残余计数错误导致部分 token 丢失；由于 tool call 场景 prompt 天然更长（含完整 `<tools>` schema），比普通对话更容易触发该边界丢 token 问题；相关修复 PR #41133 承认"长 prompt + 较小 max-num-batched-tokens 时仍有概率复现"。来源：GitHub issue 搜索结果，2026-09 数据 【已确认（间接来自搜索摘要，未逐行核对原文，建议正式引用前二次核实 issue 号）】
6. **SGLang** 官方文档列出 16 种独立于 vLLM 的 `--tool-call-parser`（`deepseekv3`/`deepseekv31`/`deepseekv32`/`glm`/`gpt-oss`/`kimi_k2`/`llama3`/`llama4`/`mistral`/`pythonic`/`qwen`/`qwen3_coder`/`qwen`/`step3`/`apertus2509` 等），每种都**硬绑定特定模型家族**；自定义 parser 需要在 `sglang/srt/function_call_parser.py` 里新增 `BaseFormatDetector` 子类并注册进 `MultiFormatParser`——与 vLLM 的插件化 Tool Parser Plugin 机制思路一致，但代码库/接口互不兼容。GPT-OSS parser 明确会把"analysis channel"内容过滤掉，只保留 normal text，可能导致 content 为空。来源：https://docs.sglang.io/advanced_features/tool_parser.html 【已确认】
7. **claude-code-router #1397**（开放中，2026）：内置 `reasoning` transformer 在流式场景下会**重复发送**并**错误递增 index**，导致 Qwen3 系列（含 Coder 变体）、Devstral 2 等"reasoning→tool_calls"模型的工具调用参数 JSON 损坏，官方复现结果为"不用 transformer 时 10/10 有效，用了之后 0/10 全部损坏"；用户自行打补丁（约 240 行）后恢复 10/10。这直接证明**下游 Agent CLI 的流式转译层本身也是一个高风险故障点**，不能假定"上游 vLLM 修好了就万事大吉"。来源：https://github.com/musistudio/claude-code-router/issues/1397 【已确认】
8. **opencode-openai-compatible**（npm，1.0.9，2026-01 发布）：明确以"tool call compatibility fixes"为卖点独立发布的 AI SDK provider 包，说明 opencode 生态已经认识到官方/默认 openai-compatible provider 在对接自建推理服务时 tool_calls 兼容性不足，需要社区包做二次适配。来源：https://libraries.io/npm/opencode-openai-compatible 【已确认存在，但未能读取该包 changelog 逐条修复内容，属于间接证据】
9. **guided decoding / 结构化输出**：vLLM 支持 `outlines`、`lm-format-enforcer`、`xgrammar` 三种 guided decoding backend 来约束 tool_calls 参数 JSON 的 schema 合法性；XGrammar / XGrammar-2 论文声称"只要产生了 tool call，其参数 100% 满足 schema 合法性（100% schema-valid tool-call arguments）"，即**语法层面的 JSON 有效性可以被引擎强制保证**，但这不解决上述"流式拼接错位/泄漏进 content"的问题——因为那些问题发生在 tool-call-parser 对 token 流做正则/状态机分段的阶段，guided decoding 只保证"最终生成的完整参数字符串是合法 JSON"，不保证"流式过程中每个 delta 都能被正确归属到正确的 tool call index"。来源：https://blog.vllm.ai/2025/01/14/struct-decode-intro.html；XGrammar-2 论文 arxiv 2601.04426 【已确认（引擎层结构化输出能力）+ 推测（guided decoding 与流式拼接是两个正交问题，这一推断基于对问题机制的分析，非直接来源明示】
10. **Goose（block/goose）discussion #5914**（截至 2026-01-12 未解决）：用户报告 Goose 1.15.0 接自建 vLLM + Qwen3 endpoint 时，模型能"认识"工具但从不实际发起 tool call（只给出解释性文字），而同一 endpoint+模型换用 `mcphost` 客户端可以正常调用；维护者仅回复"model related"未给出根因，说明**同一自托管后端，不同 Harness 客户端的 system prompt / tool 声明格式封装方式差异，会直接决定 tool calling 触发率**，这是纯客户端侧、与 vLLM 引擎 bug 无关的另一类兼容性风险。来源：https://github.com/block/goose/discussions/5914 【已确认】

## 详细分析

### 1. streaming + parallel tool_calls：四类根因归纳

综合上述 issue，vLLM（以及同架构的 SGLang）在流式 tool_calls 场景下的缺陷可以归纳为四类根因，这四类根因分别对应赛题给出的线索 issue：

- **(A) 协议假设过窄**：#39584 的代码硬编码"每个 delta 最多一个 tool_call"，但 OpenAI Responses/Chat Completions 规范并未做此限制，一旦模型（尤其是投机解码、或倾向"一口气"输出多个并行调用的模型）真的在单个 delta 里塞进 ≥2 个 tool_calls，服务端直接断言崩溃而非优雅降级。这是"实现遗漏"，而非"协议本身有歧义"。
- **(B) 状态机边界识别失败**：#42696、#50512、SGLang #22922 都属于此类——tool-call-parser 本质是一个"从 token 流里用正则/标签识别 tool call 起止边界"的状态机，continuous batching 产生的"大块 delta"（一个 delta 里包含多个完整 tool call 起止标记）会让状态机的"逐块处理"假设失效，造成 index 不推进、参数片段跨 tool 泄漏、或起始标记被吞掉导致整段内容误判为 plain content。**这是目前最普遍、最难根治的一类问题**，因为每个模型家族的 tool 调用格式（XML/JSON/pythonic）不同，每种格式都要维护一套独立状态机。
- **(C) reasoning 与 tool_calls 交接丢失**：#27641（gpt-oss）、#50512（Inkling）都指向同一现象——当模型输出顺序是"先 reasoning_content 后 tool_calls"（国产深度思考模型、gpt-oss 的 harmony 格式等普遍如此）时，流式路径下"reasoning 结束→tool 开始"这个转折点的探测容易出错，要么把 tool JSON 误判为还在 reasoning_content 里，要么把 tool 调用泄漏进 content。非流式（一次性拿到全量文本再做正则匹配）几乎不受影响，这也是 #27641 里 vLLM 官方给出的 workaround（改用 `stream=False`）的技术依据。
- **(D) 批处理调度导致的 token 丢失**：#46262 揭示了一个更底层的问题——不是 tool parser 逻辑错，而是**PP（pipeline parallel）+ chunked prefill 组合场景下，engine 内部 token 计数（`num_tokens_no_spec`）在请求被踢出批次再重新排入时出现残余误差，物理层面丢了 token**，恰好因为 tool call 场景 prompt 更长（含完整工具 schema）更容易撞上这个边界条件。这类问题**任何 tool parser 修复都无法解决**，只能等 vLLM 调度器本身修复，或者规避这类并行策略组合。

### 2. reasoning_content 与 tool_calls 混合输出的分离现状

vLLM 官方博客确认存在专门的示例 "OpenAI Chat Completion Tool Calls With Reasoning"，说明"reasoning + tool_calls 共存"是官方认可且需要专门文档说明的场景，而非边缘情况——这也印证了它是个已知的高复杂度组合。DeepSeek 官方 API 层面的约定是：`reasoning_content` 与 `content`/`tool_calls` 分离表达，思考过程只出现在 `reasoning_content`，最终答案/工具调用只出现在 `content`/`tool_calls`；但多篇 vLLM issue（如搜索命中的 #12683、#13125、#19222）显示，vLLM 对 DeepSeek-R1 系列模型的 reasoning parser 与官方 DeepSeek API 行为并不总是完全一致（例如"含 `reasoning_content` 时 `content` 字段是否应为 `null`"这类细节实现差异），流式路径下问题更突出。**结论：不能假设自托管推理引擎与模型厂商官方 API 的 reasoning/tool_calls 分离行为完全等价，必须以我们网关自己的解析器为准，不能直接透传自托管引擎的原始字段语义。**

### 3. tool parser 与模型家族的强绑定关系

vLLM 与 SGLang 都采用"tool-call-parser 名称 ↔ 特定模型家族/输出格式"的硬绑定设计：

- vLLM `--tool-call-parser` 官方支持列表（据 vLLM 最新文档 TOC 提炼）：`hermes`（NousResearch Hermes 格式，被 Qwen、多个开源模型复用）、`mistral`、`llama3_json`、`granite`、`internlm`、`jamba`、`xlam`、`deepseek_v3`/`deepseek_v31`、`openai`（gpt-oss）、`kimi_k2`、`hunyuan_a13b`、`cohere_command3`、`longcat`、`glm45`/`glm47`、`functiongemma`、`qwen3_xml`、`olmo3`、`gigachat3`、`apertus`、`pythonic`。来源：https://docs.vllm.ai/en/latest/features/tool_calling/（页面 TOC 提取）【已确认存在该清单，但受限于页面为客户端渲染的 mkdocs 站点、curl 抓取未取到正文细节，清单来自 TOC 标题，建议正式引用前用浏览器人工复核一次】
- SGLang 的 16 种 parser 命名体系与 vLLM 完全不同（`glm` vs vLLM 的 `glm45`/`glm47`，`qwen` vs vLLM 的 `hermes`/`qwen3_xml` 混用），两个引擎之间**没有统一的 parser 命名标准**，接入新引擎时不能假设"vLLM 用什么 parser 名，SGLang 就用同名 parser"。
- **⚠️ 重要命名混淆风险（对我们团队的直接警示）**：vLLM 的 `hermes` tool-call-parser 指的是"NousResearch Hermes 系列模型使用的 tool-call XML/JSON 格式"，与本次比赛候选 Harness 名单里的 **"Hermes"引擎（Agent 网关规范里的候选 harness 之一）完全是两个不同的概念**——前者是"模型输出格式解析器"，后者是"Agent 编排引擎"。团队内部沟通、文档撰写、代码命名时必须显式区分，否则容易产生"给 Hermes 引擎配 hermes tool parser"这类似是而非但实际无关的错误假设。
- **若内部主模型是自研/微调模型**：由于没有任何官方 parser 天然匹配，只有两条路——(a) 在微调阶段严格复用某个已支持家族的 tool-call 输出格式（如强制模型输出 Hermes/xLAM 风格的 `<tool_call>{json}</tool_call>` 标签），从而直接复用 `hermes` parser；(b) 编写自定义 tool parser 插件——vLLM 提供官方"How to Write a Tool Parser Plugin"指南，SGLang 需要在 `function_call_parser.py` 里新增 `BaseFormatDetector` 子类。**两条路都要求推理框架团队与模型微调团队提前对齐输出格式规范**，这是一个跨团队协作项，不是网关能单独解决的。

### 4. 严格 JSON Schema 覆盖率与自研模型微调短板

搜索到的公开资料（JSONSchemaBench、BFCL-v4、τ-Bench、ToolMind 等 2025-2026 论文）显示：

- 开源模型在"自定义 schema"（非常见的、微调数据里没见过的参数结构）上的 tool calling 准确率明显低于闭源旗舰模型；ITC（International Tool Calling Dataset）微调可以让 Qwen2.5-7B 的工具选择召回率提升 45%、调用精度提升 47.9%，说明**没有专门做 function-calling 微调的自研模型，默认工具调用能力大概率不足**。
- vLLM/SGLang 的 guided decoding（outlines/xgrammar）可以**语法层面**强制 100% JSON schema 合法（XGrammar-2 论文声称），但这只保证"生成的字符串能被 json.loads 解析且字段类型对"，**不保证参数值语义正确**（例如模型仍可能把文件路径参数填错、把单元格范围填串），也不保证前述"流式拼接不出错"。
- **结论**：即使开启 guided decoding，网关层依然需要做**参数级别的二次校验**（业务 schema 校验，而非仅 JSON 语法校验）+ **失败重试兜底**（例如：校验失败时把错误信息作为一次"assistant tool_result: error"反馈给模型，触发模型自我纠正重试，而非直接判定任务失败）。这一点在 Office 自动化场景尤其关键——递归删除文件这类破坏性操作，参数损坏的代价极高，必须有网关层强校验兜底（例如路径必须在允许的工作目录内、必须做二次确认）。

### 5. 国内网关聚合层（one-api/new-api）与 claude-code-router 的经验

- **one-api / new-api**：搜索结果显示这两个项目关注的主要痛点是"上游返回非标准 OpenAI 字段污染响应体"（如 new-api issue #5834 提到 MiniMax 上游在 `choices[0].delta` 里塞入 `name`/`audio_content`/`input_sensitive`/`service_tier`/`base_resp` 等私有字段，违反 OpenAI Chat Completions 规范），以及"国产大模型流式调用"的历史遗留问题（one-api 老 issue #861）。**未搜索到 one-api/new-api 有专门针对"vLLM 自托管场景下 tool_calls 流式拼接错位"这一具体问题的补丁记录**——这两个项目更多是"多厂商 API 格式转换网关"定位，其代理对象主要是各云厂商官方 API 而非自托管推理引擎内部 bug，因此这类问题超出其覆盖范围，我们不能指望直接复用它们的经验来解决 vLLM/SGLang 引擎内部的 tool parser bug，只能借鉴其"响应体标准化清洗"的工程套路（字段白名单过滤、schema 校验）。
- **claude-code-router**：如前所述，#1397 提供了一个**极具参考价值的正面案例**——它证明了在"网关/转译层"（而非引擎层）做防御性重写是可行且有效的：识别到"reasoning→tool_calls"转折点后，不信任上游的 index 字段，而是自己维护 tool call 的 index 分配与去重逻辑，就能把 0/10 的失败率恢复到 10/10。这与我们计划的"网关模型代理层做整体缓冲"思路完全一致，是可直接复用的设计经验（虽然代码本身因框架不同不能直接照搬，但状态机设计思路可以参考其 PR 描述里"去掉 index++、清理 thinking chunk 构造、把 reasoning_content 删除逻辑挪到条件外"的具体修复点）。
- **CopilotKit** 仓库也存在一个专门的 PR `fix-vllm-toolcall-streaming-compatibility`（#1662），进一步印证"vLLM 流式 tool_calls 输出需要下游框架专门适配"是一个跨生态的共识，而不是孤立个案。

### 6. 各候选引擎 provider 适配层的降级策略调研结果

| 引擎/项目 | 是否有针对性降级/修复 | 具体做法 | 来源确信度 |
|---|---|---|---|
| opencode（基于 ai-sdk openai-compatible provider） | 有，且有独立 npm 包 `opencode-openai-compatible` 专门做"tool call compatibility fixes" | 具体修复点未逐条核实（无法读取包源码 diff），但包描述与 vLLM #42696 报告的"opencode 场景 tool parser 崩坏"互相印证，可以合理推断该包针对的正是此类问题 | 中：包存在性已确认，具体代码修复内容未直接核实 |
| goose（block/goose） | 未搜到明确的、已合并的"自托管场景 tool_calls 修复" | discussion #5914 显示遇到"能看到工具但不触发调用"的问题，维护者未给出根因，讨论悬而未决 | 高：讨论内容已确认，但"goose 是否已修复"是否定结论 |
| claude-code-router | 有，issue 中提出具体修复方案且用户已验证补丁有效 | 移除错误的 index++、修正 thinking chunk 构造、reasoning_content 删除逻辑调整 | 高：issue 描述与复现数据已确认，但截至调研时 issue 仍标记 Open（未合并进主线） |
| pi / hermes（比赛候选引擎名） | 未搜索到公开的、针对自托管推理引擎流式 tool_calls 问题的专门讨论或 issue | 无法确认这两个引擎是否已有降级策略 | 低：未找到一手资料，视为**未知/需在后续用真实自建 vLLM 环境实测确认** |
| dsh（DeepSeek Harness，若为候选） | 未搜索到公开资料 | 同上 | 低：未找到一手资料 |

**方法论提示**：以上"未搜到"不等于"没有该问题"或"该引擎已解决该问题"，只说明公开可检索的一手资料（GitHub issue、npm 包、官方文档）中没有直接证据；对 pi、hermes、dsh 这几个 harness，建议在实际选型阶段用真实的内部自托管 vLLM/SGLang 服务做压力测试（并行 tool_calls、长 system prompt、reasoning 模型三种场景各测一遍），不能只依赖调研结论。

## 对我们架构的启示

1. **网关必须内置"模型代理层的流式 tool_calls 整体缓冲机制"，作为公共能力而非引擎自理**。具体设计：对上游自托管推理服务的 SSE 流，网关按 `tool_call.index` 分桶累积 `arguments` 字符串增量，只有当某个 index 的参数 JSON 通过括号配对/长度校验判定"已闭合"（或收到 `finish_reason=tool_calls`/`stop`）后，才把该 tool_call 作为一个完整事件转发给上层 Harness 或写入 `/session/{id}/message` 轨迹——绝不能逐 token 直通转发未闭合的 tool_calls 参数片段。这直接对应赛题网关规范里 `GET /session/{id}/message` 要求的"完整轨迹"语义：轨迹里的 tool call 记录本身就应该是缓冲后的完整快照，而不是原始流式碎片的拼接产物，这样即使底层引擎有 #42696/#50512 类型的边界识别 bug，网关也能通过"闭合性校验失败则丢弃重试"兜底，不把损坏数据透传给上层。
2. **网关需要一个显式的 reasoning/tool_calls 分离状态机，且不能信任自托管引擎自己给出的字段划分**。鉴于 #27641、#50512 都指向"reasoning→tool 交接"是流式路径的高危区，且国产深度思考模型是我们大概率要用的"内部部署主模型"类型，建议网关模型代理层自己维护一套"reasoning 标签检测 + tool 标签检测"的双状态机（可以复用 vLLM/SGLang 开源的 reasoning parser、tool parser 源码作为参考实现，而不是重新发明），并且在**非流式兜底模式**下做二次校验——即对高风险操作（如递归删除文件类工具调用），网关可以选择性地对该次请求强制 `stream=false` 重新请求一次，用完整响应校验流式结果是否一致，不一致则以非流式结果为准（参考 vLLM 官方对 #27641 给出的"改非流式"workaround，网关把这个 workaround 做成可配置的"高风险工具白名单强制非流式复核"策略）。
3. **tool parser 选择 / 自定义必须作为"新引擎接入 SOP"的显式一步，且要与模型微调团队联动**。由于 vLLM 与 SGLang 的 parser 命名体系互不兼容、且都与模型家族强绑定，我们的《新引擎接入标准流程》文档里必须包含一个专门的 checklist 项："确认该 Harness 底层依赖的推理框架是什么（vLLM/SGLang/TGI/其他）→ 确认我们的内部主模型是否已有匹配的官方 tool-call-parser → 若无匹配，评估是"微调阶段对齐已支持格式"还是"网关层自定义 parser"两条路线的成本"。同时要在团队文档里明确警示"hermes parser 名"与"Hermes 引擎名"是两个不相关概念，避免命名混淆导致的错误配置。
4. **guided decoding（xgrammar 等）应作为网关推荐给自托管推理服务的启动参数，但不能替代网关层的业务参数校验**。建议在 `INSTRUCTION.md` 里给出的自托管推理服务启动参数模板中，显式建议开启 `--enable-auto-tool-choice --tool-call-parser <匹配值> --guided-decoding-backend xgrammar`（若 vLLM 版本支持），这能从引擎层面消除"JSON 语法不合法"这一类最基础的错误；但网关的模型代理层依然要做**业务语义校验**（参数值是否在允许范围、路径是否合法等）+ **有限次数的"报错回灌重试"**，因为 guided decoding 解决不了语义错误，更解决不了本报告列出的流式拼接类 bug。
5. **鲁棒性评分项应该体现"面对底层推理引擎抽风时网关如何优雅降级"**，这是赛题"鲁棒性 5%"分值的一个具体可演示点：可以设计一个"网关自愈"机制——当检测到某次工具调用的 JSON 参数校验持续失败（比如 2 次重试后依然拼不出合法 JSON），网关自动把该次请求降级为非流式重放一次；如果非流式也失败，则把错误明确反馈给上层 Harness 而不是让整个 session 卡死（对应赛题 `POST /session/{id}/abort` 必须能传播到底层 run 的要求——一个健壮的网关应该能主动检测"底层引擎卡在半个 tool_call 里不吐 finish_reason"这种异常并主动触发 abort/超时熔断，而不是无限等待）。

## 未解决问题

1. 本次调研未能对 **pi、hermes、dsh** 这三个比赛候选引擎在"自托管 vLLM/SGLang + 并行 tool_calls + 流式"组合场景下的实际表现找到任何公开一手资料（GitHub issue、官方文档、社区讨论均未命中）。这是本报告最大的信息缺口，强烈建议在方案定稿前，用团队实际可访问的内部自托管推理服务，对这几个候选引擎各跑一遍"5 个并行 tool_calls + 长 system prompt + reasoning 模型"的最小复现用例，用真实数据代替本报告基于同类项目（opencode/goose/claude-code-router）的**类比推断**。
2. vLLM 官方 `features/tool_calling` 文档页面在本次调研中因客户端渲染（mkdocs-material instant loading）导致 curl/WebFetch 只抓到导航目录（TOC），未能获取到正文里关于"Streaming Support"章节的具体技术细节（例如流式 tool_calls 的确切 SSE 事件格式、是否官方声明支持 parallel tool_calls 流式），建议后续用带 JS 渲染能力的浏览器工具人工复核该页面正文。
3. vLLM #46262（PP2 chunked-prefill tool call 乱码）的细节来自搜索引擎摘要而非直接 WebFetch 原始 issue 页面，issue 号与描述细节建议在正式引用前二次核实（WebFetch 该 URL 时遭遇速率限制未能完成直接抓取）。
4. 未找到任何官方基准测试量化"自托管 vLLM/SGLang 相对官方闭源 API，在并行 tool_calls 场景下的失败率差异"这一直接对比数据，本报告的严重性判断主要基于"issue 数量与描述的具体性"这一间接证据，缺少量化基准支撑，建议若时间允许在团队自己的目标模型上跑一次小规模 BFCL-v4 或自建用例的失败率统计。
5. SGLang 是否存在与 vLLM #39584 同类的"parallel tool_calls streaming 断言崩溃"问题，本次调研未找到对应 issue（可能是命名体系不同导致检索未命中，也可能 SGLang 架构规避了该问题），需要后续专门检索 `sgl-project/sglang` 仓库确认。
6. TGI（text-generation-inference）与 Xinference 的 tool_calling 相关 GitHub issue 检索覆盖不足（仅确认二者"支持 OpenAI 兼容 tool calling API"这一表层事实），未找到与 vLLM 同等深度的已知 bug 清单，不确定是这两个项目问题更少，还是社区使用规模较小导致 issue 曝光率低，建议视团队是否考虑 TGI/Xinference 作为推理后端来决定是否值得追加调研。

## 来源列表

- vLLM Issue #39584（AssertionError: Multiple tool calls in one delta / Responses API streaming crash）：https://github.com/vllm-project/vllm/issues/39584
- vLLM Issue #42696（Gemma4 tool parser broken in streaming mode for OpenCode）：https://github.com/vllm-project/vllm/issues/42696
- vLLM Issue #50512（Inkling tool call leaks as content in multi-turn streaming）：https://github.com/vllm-project/vllm/issues/50512
- vLLM Issue #27641（Streaming tool call randomly failed when using gpt-oss-120b/20b）：https://github.com/vllm-project/vllm/issues/27641
- vLLM Issue #46262（PP2 tool calling produces garbled output while PP1 works correctly, GLM-5.2-FP8 DSA, chunked-prefill）：https://github.com/vllm-project/vllm/issues/46262（间接来源，搜索摘要，建议二次核实）
- vLLM Issue #9451（Feature: Consider parallel_tool_calls parameter at the API level）：https://github.com/vllm-project/vllm/issues/9451
- vLLM Issue #21544（Hermes tool call parser fails with "Error trying to handle streaming tool call"）：https://github.com/vllm-project/vllm/issues/21544
- vLLM Issue #43267（Feature: Support streaming output for tool_calls arguments）：https://github.com/vllm-project/vllm/issues/43267
- vLLM Issue #10589（Streaming output error of tool calling has still not been resolved）：https://github.com/vllm-project/vllm/issues/10589
- vLLM Issue #12683 / #13125 / #19222（DeepSeek R1 reasoning_content 流式解析相关问题，来自搜索摘要）：https://github.com/vllm-project/vllm/issues/12683 ，https://github.com/vllm-project/vllm/issues/13125 ，https://github.com/vllm-project/vllm/issues/19222
- vLLM 官方文档：Tool Calling：https://docs.vllm.ai/en/latest/features/tool_calling/
- vLLM 官方博客：Structured Decoding in vLLM: a gentle introduction（2025-01-14）：https://blog.vllm.ai/2025/01/14/struct-decode-intro.html
- XGrammar-2 论文（arXiv 2601.04426）：https://arxiv.org/pdf/2601.04426
- SGLang 官方文档：Tool Parser：https://docs.sglang.io/advanced_features/tool_parser.html
- SGLang Issue #22922（Tool-call-parser fails to format function calls for GLM5.1 in cursor）：https://github.com/sgl-project/sglang/issues/22922
- claude-code-router Issue #1397（Streaming reasoning transformer corrupts tool-call argument deltas for reasoning→tool_calls models）：https://github.com/musistudio/claude-code-router/issues/1397
- opencode Issue #44852（Failed parallel tool call leaves dangling tool_call_id, causing 400 errors）：https://github.com/anomalyco/opencode/issues/44852
- opencode Issue #5674（Custom OpenAI-compatible provider options not being passed to API calls）：https://github.com/anomalyco/opencode/issues/5674
- opencode-openai-compatible npm 包信息：https://libraries.io/npm/opencode-openai-compatible
- goose（block/goose）Discussion #5914（Goose unable to tool call with a custom vLLM endpoint）：https://github.com/block/goose/discussions/5914
- goose Issue #3857（Add vllm and NIM providers or provide the ability to create a custom provider）：https://github.com/block/goose/issues/3857
- new-api Issue #5834（非流式+流式响应含非 OpenAI 字段，违反 OpenAI Chat Completions 规范）：https://github.com/QuantumNous/new-api/issues/5834
- one-api Issue #861（关于国产大模型的流式调用的问题）：https://github.com/songquanpeng/one-api/issues/861
- CopilotKit PR #1662（fix-vllm-toolcall-streaming-compatibility）：https://github.com/CopilotKit/CopilotKit/pull/1662
- Xinference 官方文档：Tools（模型能力）：https://inference.readthedocs.io/en/stable/models/model_abilities/tools.html
- Hugging Face TGI 官方文档首页：https://huggingface.co/docs/text-generation-inference/index
- Red Hat Developer：Structured outputs in vLLM: Guiding AI responses（2025-06-03）：https://developers.redhat.com/articles/2025/06/03/structured-outputs-vllm-guiding-ai-responses

（说明：本报告中标注"已确认"的事实均基于对上述 URL 的直接 WebFetch 抓取或 WebSearch 返回的搜索引擎摘要交叉验证；标注"推测/间接"的内容已在正文中明确标出，正式写入比赛方案前建议对高影响力结论做二次人工核实，尤其是 #46262 与 vLLM 官方文档正文细节两处。)
