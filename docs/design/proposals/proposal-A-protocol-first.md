# 方案 A：协议与契约优先（Protocol-first）的多引擎 Agent 网关架构

> 角度：协议/规范设计者（LSP / MCP / ACP 式契约思维）
> 日期：2026-09-04
> 目标读者：本团队 3 人 + 赛题评委 + **一个从未见过本系统、但要为第 5 个引擎写适配器的外部工程师**

---

## 0. 一句话定位

**PNP 不是"一个支持多引擎的网关程序"，而是"一组可独立实现的契约（HAP / CAPS / UAES / USR / UPP）+ 一个参考实现"；网关核心只依赖契约，引擎只需实现契约的一个 profile，任何人拿着这五份规范就能在不读我们一行业务代码的前提下，把第 N 个 Harness 接进来。**

判断本方案成败的唯一验收标准（也是本文每一节的写作纪律）：

> 把 §4 的五份规范打印出来交给一个外部工程师，他能否在不问我们任何问题的情况下，为一个我们没接过的引擎（例如 Cline、Kilo Code）写出一个通过一致性测试的适配器？

---

## 1. 设计原则（每条给出来源与理由）

| # | 原则 | 来源 / 理由 |
|---|---|---|
| P1 | **契约先于实现：五份规范（HAP/CAPS/UAES/USR/UPP）是仓库中的一等公民，有独立版本号、JSON Schema 与一致性测试** | LSP/MCP/ACP 的成功都来自"规范可被第三方独立实现"。T12 证明 ACP 靠一份 schema 让 ≈40 个 harness 与数十个客户端互通；T06 的 Open Harness / UHP 则反证：文档与实现不同步（官网称 8 引擎、容器日志只有 5 个）会让"通用 API"退化成"某一家的 API"。 |
| P2 | **不发明轮子：南向线缆协议直接采用 ACP v1（JSON-RPC 2.0，`protocolVersion: 1`），HAP 只做 profile + 扩展** | T12：ACP 已被 Gemini CLI / Copilot / Goose / opencode / Kimi / Qwen / Hermes / OpenClaw 原生实现，Claude（`claude-agent-acp`）、Codex（`codex-acp`）、pi（`svkozak/pi-acp`）、dsh（`--profile acp`）有现成适配器。自定义线缆协议 = 放弃这批免费适配器，并把"外部人能否写适配器"的门槛从"读一份公开标准"抬高到"读我们的私有文档"。 |
| P3 | **公共能力做归一化、少数派能力只做"带类型的透传"** | T06 教训：Open Harness 的 memory 抄 Letta、subagents 抄 Deep Agents，结果每个 domain 只有一家全绿（覆盖率 24–59%）。UHP 反而因为**不定义** memory / subagent 而保持稳定。归一化的准入线：≥2/3 候选引擎原生具备（对应 CAPS 的 `core` tier）。 |
| P4 | **声明与认证分离：`claimed` 不等于 `supported`，必须跑通一致性测试（CTS）才升级** | T23：K8s Conformance + Sonobuoy、Khronos CTS、WPT 的共同范式。MCP/ACP/A2A 都只做协议层协商、不保证语义正确。这也正是赛题"Rollout + LLM-as-Judge"的同构物——**赛题评测本身就是一套轻量 CTS**。 |
| P5 | **polyfill 是显式的第三态，不是隐藏的实现细节** | T23 + 能力清单：`turn.queue_mode`、`team.room_broadcast`、`schedule.cron`、`memory.*` 在多数引擎上都得由网关托管。若把 polyfill 藏起来，上层无法知道"同名能力体验天差地别"；显式 `status: polyfilled` + `cost_profile` 才能支撑 v2 的 LLM 元编排选型。 |
| P6 | **单一策略源 + 策略编译器：网关持有唯一 PolicyDocument，编译成各引擎原生配置** | T22：Claude Code 首个命中生效、opencode **最后**命中生效、Gemini CLI 数值优先级——三种相反语义。若逐引擎手写规则，deny 会被静默覆盖。统一为 deny 优先（Cedar forbid 同构），由编译器分别生成。 |
| P7 | **网关内部事件 schema 用稳定私有前缀 `agw.*`，`gen_ai.*` 只作导出映射层** | T14：OTel GenAI semconv 至今整体 Development，历史上已把 `gen_ai.system` 改名 `gen_ai.provider.name`、把逐消息事件改成聚合 messages。内部锚定 `agw.*`，一次上游改名只改一张映射表。 |
| P8 | **会话可移植性走"共享工作区 + 任务书"，不做转录重放** | T30：thinking/reasoning 带厂商签名不可跨供应商复用；tool_call id 空间不兼容；Claude Code 官方声明 JSONL "格式随版本变化，勿直接解析"；opencode 自己的 export/import 都有已知 bug（#21941）。而赛题 10 个用例全是**文件系统可观察**的办公任务，任务状态天然可外部化到磁盘。 |
| P9 | **MVP 与愿景共用同一套抽象，靠 tier 与 profile 隔离，不靠两套代码** | 赛题 70% 客观分来自引擎在 Windows 上的实际完成度。愿景能力（memory / dynamic workflow / room / 自进化）全部落在 CAPS 的 `extension` / `experimental` tier 与 HAP 的 `_meta` 扩展位上：**MVP 不实现它们时，协议里只是几个不出现的可选字段，零成本**；v2 实现时不需要改动任何 core 契约。 |
| P10 | **一切"引擎特有能力"必须有命名空间与版本，禁止裸名字段** | T23 + 能力清单第 3 节：`mode` 一词在三个不同层面被复用（权限档位 / plan-act 行为模式 / 推理强度）；`session` 在 opencode 还指存储层三层文件树；`skill` 在 pi 含工具、在 Claude 可被 `disable-model-invocation` 变成纯命令。裸名字段是跨引擎误判的头号来源。 |
| P11 | **每个契约都配一台"状态机"，而不是一堆字段说明** | 赛题最容易失分的地方是 `prompt_async` 的完成判定、abort 的真传播、`idle/busy` 一致性。状态机让"什么时候可以返回 204"变成可测试的断言，而非口头约定。 |
| P12 | **面向评测的降级默认值写进规范，而不是写进代码分支** | G06：评测沙箱可能无网络、无管理员权限；Gemini/Claude 在非交互下 `ask` 会静默变 `deny`，表现为"任务莫名失败"。规范层直接规定 `UPP.unattended.default_effect = allow` 且 `question` 自动应答，才不会在赛场上靠 if-else 打补丁。 |

---

## 2. 总体架构

### 2.1 分层平面图

```mermaid
flowchart TB
  subgraph BIZ["业务平面（易变，v2 扩展区）"]
    IM["IM/群助手适配器<br/>飞书/钉钉/企微/Slack"]
    EVAL["评测客户端<br/>Rollout Runner"]
    ORCH["Meta-Orchestrator<br/>LLM 选引擎/选能力（v2）"]
  end

  subgraph NORTH["北向契约层（稳定：赛题规范锁定）"]
    HTTP["通用 Agent 网关规范 :6217<br/>POST /session · prompt_async · /message<br/>/abort · GET /event SSE"]
    MYA["MyAgent 规范 :3008（可选薄映射）"]
  end

  subgraph CORE["网关内核（稳定：只依赖契约，不认识任何引擎）"]
    SESS["SessionRegistry<br/>route_key → GatewaySession"]
    RUN["RunController<br/>Turn 状态机 / 阻塞语义 / abort 传播"]
    POL["PolicyEngine (UPP)<br/>单一策略源 + 决策记账"]
    EVT["EventHub (UAES)<br/>归一化 · 序号 · 扇出 SSE/OTel"]
    USRS["SessionRecorder (USR)<br/>统一轨迹 + 任务书"]
    CAPR["CapabilityRegistry (CAPS)<br/>manifest · 探针 · CTS 结果"]
  end

  subgraph SOUTH["南向契约层：HAP = ACP v1 + PNP profile"]
    HAP["JSON-RPC 2.0 over stdio/ws<br/>initialize · session/* · session/update<br/>request_permission · _pnp/*"]
  end

  subgraph ADP["适配器平面（易变，每引擎一个，可由外部人独立实现）"]
    A1["opencode 适配器<br/>HTTP+SSE 桥"]
    A2["Claude Code 适配器<br/>stream-json 子进程桥"]
    A3["pi 适配器<br/>--mode rpc 桥"]
    A4["ACP 直通适配器<br/>Goose/Qwen/Kimi/dsh 零代码"]
    A5["Hermes / Codex / … "]
  end

  subgraph RES["共享资源平面（引擎无关）"]
    ASSET["AssetCompiler<br/>SKILL.md/AGENTS.md/MCP → 各引擎投影"]
    MODEL["ModelProxy<br/>内部模型端点 + 协议转换"]
    WS["WorkspaceManager<br/>每 session 独立 cwd + Job Object"]
    MEM["MemoryService（v2 polyfill）"]
  end

  IM --> HTTP
  EVAL --> HTTP
  ORCH --> HTTP
  HTTP --> SESS
  MYA --> SESS
  SESS --> RUN --> HAP
  POL <--> RUN
  EVT <-- HAP
  USRS <-- EVT
  CAPR <--> HAP
  HAP --> A1 & A2 & A3 & A4 & A5
  A1 & A2 & A3 & A4 & A5 --> RES
```

### 2.2 每层职责与"稳定 vs 演进"归属

| 层 | 职责 | 稳定性 | 演进纪律 |
|---|---|---|---|
| 北向契约层 | 把赛题规范（6217/3008）当作**外部给定的契约**，做协议翻译与阻塞语义合成 | **冻结**（赛题锁定） | 只增不改；MyAgent 规范作为 30 行薄映射，共用同一内核 |
| 网关内核 | Session/Run/Policy/Event/Record/Capability 六个子系统。**内核代码里不允许出现任何引擎名字符串**（用 CI lint 强制） | **稳定** | 修改需同步修改契约 major 版本 |
| 南向契约层 HAP | ACP v1 线缆 + PNP profile；核心方法集冻结，扩展走 `_meta` / `_pnp/*` | **稳定**（core），**开放**（extension） | 新能力先进 `experimental`，两个引擎实现后升 `standard` |
| 适配器平面 | 每引擎一个进程/模块，把引擎私有接入面翻译成 HAP | **易变** | 引擎升级只改适配器 + manifest，不动内核 |
| 共享资源平面 | 资产编译、模型代理、工作区隔离、记忆 | **半稳定** | 对适配器暴露的也是契约（AssetBundle / ModelProfile） |
| 业务平面 | IM 桥、评测客户端、v2 元编排 | **易变** | 只经北向 HTTP，不得直连适配器 |

**关键结构决策**：内核 ↔ 适配器之间用的是**进程外 JSON-RPC**，而非语言内接口。代价是一次序列化开销（毫秒级，相对 LLM 调用可忽略），收益是：(1) 适配器可以用任何语言写；(2) 适配器崩溃不拖垮网关；(3) 外部人写适配器时只需对着 wire 协议，不需要编译我们的代码；(4) 原生 ACP 引擎连适配器都不用写，直接是 HAP 端点。

---

## 3. 核心抽象与数据模型

所有类型定义放在 `packages/contracts/`，用 TypeScript 写、用 `ts-json-schema-generator` 导出 JSON Schema，作为跨语言（Python/Go 适配器）的权威来源。命名遵循 P10：域前缀 + 版本。

### 3.1 标识体系（三层，解决 T30/能力清单第 3 节的 session 语义混乱）

```ts
/** 业务侧稳定键：群/话题/用户。永不变，网关自己生成与持有。 */
type RouteKey = string;   // "acme:feishu:group:oc_5ce6…:thread:omt_d4b…" | "eval:office_011"

/** 网关会话：北向 /session/{id} 暴露的就是它。 */
type SessionId = string;  // "ses_01J8Z…"（ULID，可排序）

/** 引擎侧会话句柄：易变、可重建、可为空（引擎无显式 session 时由适配器合成）。 */
type EngineSessionRef = { engineId: EngineId; nativeId: string | null; pid?: number };

/** 一次 prompt→最终回复 的完整执行。北向 prompt_async 的阻塞单位。 */
type RunId = string;      // "run_01J8Z…"

/** Run 内部的一次 LLM step（对应 opencode step-finish / ACP 无对应 / Claude 的一次 API 调用）。 */
type StepId = string;
```

> 纪律：文档与代码中 **`session` 一律指 `GatewaySession`**；引擎侧一律写 `engine_session_ref`。禁止出现裸 `thread` / `conversation`。`Run` 与赛题的"一轮"一一对应；`Turn` 一词禁止使用（pi 的 `turn_start/turn_end` 与 Codex 的 `turn` 语义不同），需要时写 `engine_turn`。

### 3.2 Engine / Adapter

```ts
type EngineId = string;   // "opencode" | "claude-code" | "pi" | "hermes" | "dsh" | ...

interface EngineDescriptor {
  id: EngineId;
  displayName: string;
  /** 适配器的启动方式；对原生 ACP 引擎直接就是引擎自身命令。 */
  launch: {
    kind: "stdio" | "ws";
    command: string; args: string[];
    env: Record<string, string>;      // 支持 ${VAR} 间接引用，禁止内联密钥
    cwd?: string;
    /** ACP Registry 条目 id（若来自 cdn.agentclientprotocol.com/registry），可省。 */
    acpRegistryId?: string;
  };
  /** 进程编排策略：由适配器 manifest 的 concurrency 能力位决定，网关据此建池。 */
  processModel: "one-process-per-session" | "shared-process-multi-session";
  install?: { probe: string; script: string; pinnedVersion: string }; // 首启安装，版本钉死
}

/** 适配器只需实现 HAP 的 wire 协议；这个接口是"参考实现"侧的形状，不是契约的一部分。 */
interface EngineAdapter {
  initialize(p: HapInitializeParams): Promise<HapInitializeResult>;   // 返回 CapabilityManifest
  sessionNew(p: SessionNewParams): Promise<{ sessionId: string; modes?; configOptions? }>;
  sessionPrompt(p: SessionPromptParams): Promise<{ stopReason: StopReason }>;  // 长阻塞
  sessionCancel(p: { sessionId: string }): Promise<void>;
  sessionClose(p: { sessionId: string }): Promise<void>;
  // 反向：适配器 → 网关
  onSessionUpdate(cb: (u: HapSessionUpdate) => void): void;
  onPermissionRequest(cb: (r: PermissionRequest) => Promise<PermissionDecision>): void;
}
```

### 3.3 Capability（CAPS 的运行时投影）

```ts
type CapabilityTier = "core" | "standard" | "extension" | "experimental";
type CapabilityStatus = "claimed" | "supported" | "polyfilled" | "degraded" | "unsupported";

/** ID 文法： authority ":" domain "." name ["." detail] "@" major
 *  authority: "agw"（网关归一化能力） | 引擎 vendor 反向域名（"opencode.ai" / "anthropic.com" / "pi.dev"）
 *  domain ∈ session|turn|permission|sandbox|tool|asset|context|memory|team|workflow|schedule|evolution|observability|model|protocol|route  */
type CapabilityId = string;   // "agw:session.create@1" | "anthropic.com:workflow.dynamic_script@1"

interface Capability {
  id: CapabilityId;
  tier: CapabilityTier;
  status: CapabilityStatus;
  /** 该能力被调用时可接受的参数，JSON Schema Draft 2020-12。上层节点配置表单由它生成。 */
  paramsSchema?: JSONSchema;
  dependsOn?: CapabilityId[];
  conflictsWith?: CapabilityId[];
  /** polyfill 时，指向网关侧的实现者，便于审计与成本归因。 */
  implementedBy?: "engine" | "adapter" | "gateway";
  conformance?: { testRef: string; lastRun: string; passed: boolean; version: string };
  costProfile?: { latencyP50Ms?: number; tokenOverhead?: "none"|"low"|"medium"|"high"; monetary?: "free"|"metered" };
  /** 引擎原生参数的逃生舱：网关不解释，原样透传。 */
  engineOptionsSchema?: JSONSchema;
  notes?: string;
}
```

### 3.4 Session / Run / Step

```ts
type SessionState = "idle" | "busy" | "awaiting_interaction" | "error" | "closed";
type RunState = "queued" | "running" | "awaiting_interaction" | "aborting" | "done" | "failed" | "aborted";
type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "error";

interface GatewaySession {
  id: SessionId;
  routeKey: RouteKey;
  title: string;
  workspace: WorkspaceContext;
  engine: { id: EngineId; version: string; ref: EngineSessionRef };
  state: SessionState;
  /** 北向 GET /session/status 只暴露 idle|busy；映射见 §4.1.5 */
  createdAt: string; updatedAt: string;
  policyProfileId: string;
  assetBundleId: string;
  modelProfileId: string;
  capabilitySnapshot: CapabilityId[];   // 创建时冻结，供 USR 迁移检查用
  metadata: Record<string, unknown>;
}

interface WorkspaceContext {
  directory: string;          // 赛题 POST /session 的 directory，绝对路径
  additionalDirectories: string[];
  isolation: "shared" | "per-session-dir" | "per-session-user" | "container";
  jobObjectHandle?: string;   // Windows：进程树杀除锚点（G06）
}

interface Run {
  id: RunId; sessionId: SessionId;
  state: RunState;
  input: ContentBlock[];
  startedAt: string; endedAt?: string;
  stopReason?: StopReason;
  steps: StepId[];
  usage: Usage; cost?: Cost;
  error?: GatewayError;
  abortRequestedAt?: string;
  /** 阻塞语义的判定水位：见 §4.1.5 状态机 */
  finalizedBy?: "engine_stop_reason" | "idle_event" | "watchdog_timeout";
}
```

### 3.5 Event（UAES 信封，详见 §4.3）

```ts
interface AgwEvent<T = unknown> {
  schema: "agw.event/1";
  name: AgwEventName;              // "agw.run.start" | "agw.step.tool.end" | ...
  seq: number;                     // 会话内单调递增，网关打（引擎不可信，T14 坑 #8）
  time: string;                    // RFC3339，毫秒
  ids: { sessionId: SessionId; runId?: RunId; stepId?: StepId; routeKey: RouteKey;
         engineSessionId?: string; parentRunId?: RunId };
  trace: { traceId: string; spanId: string; parentSpanId?: string };
  engine: { id: EngineId; version: string };
  redaction: "L0" | "L1" | "L2" | "L3";
  payload: T;
  /** 引擎原始事件，仅在 redaction >= L1 时保留，用于事后归因与新能力发现 */
  raw?: { name: string; body: unknown };
}
```

### 3.6 Policy / Asset / Model

```ts
type Effect = "allow" | "ask" | "review" | "deny";

interface PolicyDocument {           // UPP，唯一策略源，见 §4.5
  id: string; version: string;
  subject: { tenant?: string; routeKeyGlob?: string; role?: string[] };
  defaults: { effect: Effect; unattended: { effect: Effect; onTimeout: Effect; timeoutMs: number } };
  rules: PolicyRule[];
  sandbox: { fs: "read_only"|"workspace_write"|"full_access"; network: "deny"|"allowlist"|"allow";
             allowedDomains?: string[] };
  budget: { maxWallTimeMs?: number; maxToolCalls?: number; maxCostUsd?: number; maxRuns?: number };
}
interface PolicyRule {
  id: string; effect: Effect;
  match: { toolClass?: ToolClass[]; toolName?: string[]; argGlob?: Record<string,string>;
           pathGlob?: string[]; commandPrefix?: string[]; mcpServer?: string[];
           sideEffect?: ("fs_write"|"fs_delete"|"exec"|"network"|"external_message")[] };
  reason: string;                     // 机读 PascalCase + 人读说明，K8s conditions 风格
}

interface AssetBundle {              // 见 §5.6 资产编译
  id: string;
  rules: { agentsMd: string };                     // 规范源 = AGENTS.md
  skills: { name: string; path: string; frontmatter: Record<string,unknown> }[];  // SKILL.md
  mcpServers: McpServerDecl[];                     // 唯一协议级可移植资产
  commands?: { name: string; body: string }[];
  enginePlugins?: { engineId: EngineId; path: string; note: string }[];  // 仅登记，不跨引擎编译
}
interface McpServerDecl {
  name: string; enabled: boolean;
  transport: { type: "stdio"; command: string; args: string[]; env: Record<string,string> }
           | { type: "http"; url: string; headers: Record<string,string> };
}

interface ModelProfile {
  id: string;
  wire: "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini";
  baseUrl: string; apiKeyEnv: string; modelId: string;
  /** 引擎硬编码协议时，网关 ModelProxy 负责转换；此处记录是否需要转换与已知损耗 */
  viaProxy: boolean; knownLossy?: ("cache_control"|"reasoning"|"tool_call_streaming")[];
  fallbacks?: { modelId: string; wire: string }[];
}
```

### 3.7 Workflow / Node（v2 抽象，MVP 不实现但契约先占位）

```ts
interface WorkflowNode {
  id: string;
  /** 引擎选择：显式 id、或按能力约束求解（由 CapabilityRegistry 解算） */
  engine: { mode: "pinned"; id: EngineId }
        | { mode: "requires"; capabilities: CapabilityId[]; prefer?: "cheapest"|"fastest"|"most_capable" };
  /** 节点级能力配置：key 必须是 CapabilityId，value 必须通过其 paramsSchema 校验 */
  capabilityConfig: Record<CapabilityId, unknown>;
  policyProfileId?: string;          // 节点级权限收紧（只能比会话级更严）
  assetBundleId?: string;
  budget?: Run["usage"] & { maxWallTimeMs?: number };
  input: { template: string; from?: string[] };
  outputSchema?: JSONSchema;          // 对应 agw:turn.structured_output@1
}
interface WorkflowPlan {
  id: string; nodes: WorkflowNode[]; edges: { from: string; to: string; when?: string }[];
  /** v2：由 Meta-Orchestrator（LLM）生成或修改，须通过 schema 校验 + 策略校验才能执行 */
  authoredBy: "human" | "llm"; approvedBy?: string;
}
```

> **MVP/愿景共用同一抽象的关键点**：MVP 的一次评测请求就是一个只有一个节点的 `WorkflowPlan`（`engine.mode="pinned"`、`capabilityConfig` 只填 `agw:session.directory_isolation@1` 与 `agw:turn.budget@1`）。v2 的多节点编排、LLM 元编排、agent team 全都只是"节点更多、能力配置更丰富"，**不新增任何内核概念**。

