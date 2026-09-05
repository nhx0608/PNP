# T21 会话模型、并发/隔离与沙箱运行时

调研日期：2026-09-04

## 摘要

八个引擎的 session 模型分为两派：CLI/SDK 型（Claude Code、Codex、pi、Gemini CLI）把 session 当作本地 JSONL 文件 + 一次性进程，resume = 重新起进程读文件，**没有跨进程锁**（Claude Code 官方明说双端 resume 会交织写入），并发控制必须由网关做；服务型（opencode server、OpenClaw gateway、Hermes gateway、OpenHands agent-server）由常驻进程拥有全部 session 状态并内建队列——OpenClaw 的 `session:<key>` lane + `messages.queue.mode`(`steer|followup|collect|interrupt`) + `agents.defaults.maxConcurrent` 是最完整的参考实现。分叉能力差异大：pi 是单文件树（`id/parentId`，`/tree` 树内切换、branch summary），Claude Code/Codex/opencode 是"复制 transcript 到新 id"，Hermes/OpenClaw 无 fork，ACP `session/fork` 仍是草案。压缩仅 opencode/pi/OpenClaw/Hermes 可程序化触发。业务 key 语法（`agent:<id>:<channel>:group:<gid>`）在 OpenClaw 与 Hermes 已成熟，但群内是否按人隔离语义相反。沙箱分两层：srt/Codex 的 OS 进程沙箱（毫秒级、无快照）与 E2B/Daytona/Modal/Docker 的 microVM/容器（秒级、可 pause/snapshot；E2B pause 4s/GiB、resume 1s、无 TTL）。建议网关 SessionRegistry 做 BusinessKey → EngineBinding → RuntimeBinding 三级映射，状态机 NEW/ACTIVE/WARM/ARCHIVED，并把 resume 所需启动参数（Claude Code 不恢复 `--mcp-config/--settings/--add-dir/permission mode`）完整存入 binding 每次重放。

## 关键事实（表格）

| # | 事实 | 来源 | 置信度 | 交叉验证 |
|---|------|------|--------|----------|
| 1 | Claude Code：`claude --resume <session-id|name>`、`claude --continue`、`--fork-session`（与 `--continue`/`--resume` 组合产生新 session id，原 session 不变），交互内 `/branch <name>`；`claude -p --resume <id> --output-format json` 可脚本化追问 | https://code.claude.com/docs/en/sessions | 高 | 是（官方 docs + Boris Cherny threads 帖 + 社区文章一致） |
| 2 | Claude Code transcript 存于 `~/.claude/projects/<project>/<session-id>.jsonl`，可用 `CLAUDE_CONFIG_DIR` + `CLAUDE_CODE_PROJECT_DIR_NAME`（v2.1.234+）为每个租户/会话指定独立存储目录；`--no-session-persistence` 抑制写入 | 同上 | 高 | 否 |
| 3 | Claude Code 同一 session 在两个终端同时 resume（不 fork）会把消息交织写入同一 transcript（无锁） | 同上（"If you resume the same session in two terminals without forking, messages from both interleave"） | 高 | 否 |
| 4 | Codex SDK：`startThread()` / `resumeThread(threadId)` / `thread.run()`；`sandboxMode` 取值 `read_only | workspace_write | full_access`；**每个 thread 一次只处理一个 turn，必须 await 上一个 run** | https://learn.chatgpt.com/docs/codex-sdk | 高 | 是（CLI 侧 `codex resume <id>` / `codex exec --resume-session-id` 由 codex.danielvaughan.com 与 inventivehq 佐证） |
| 5 | opencode：SDK 提供 `session.create({})`、`session.list()`、`session.get()`、`session.chat()`、`session.abort()`、`session.fork()`、`session.compact`、`session.share`；`Session.create()` 支持 `parentID` + `permission` 参数（子 agent 用 parentID 挂到父会话） | https://deepwiki.com/anomalyco/opencode/3.1-session-management ；https://github.com/anomalyco/opencode/issues/12916 | 中高 | 是（DeepWiki + issue #12916 相互印证） |
| 6 | pi：会话是单文件 JSONL 树，每条 entry 有 `id`/`parentId`，含 message、model change、thinking-level change、label、compaction、branch summary、extension 条目；`/tree` 在文件内切换分支，`/fork`、`/clone`、`pi --fork <path|id>`、`pi --session <path|id>`、`pi --no-session` | https://pi.dev/docs/latest/sessions | 高 | 是（npm 页面与 hochej.github.io session format 页一致） |
| 7 | OpenClaw：session key 形如 `agent:<agentId>:main`、`agent:<agentId>:<channel>:group:<id>`、`cron:<job.id>`、`hook:<uuid>`；`session.dmScope` = `main|per-peer|per-channel-peer|per-account-channel-peer`，`session.groupScope` = `per-group|main` | https://docs.openclaw.ai/reference/session-management-compaction ；https://docs.openclaw.ai/concepts/session | 高 | 是（两页官方文档相互印证） |
| 8 | OpenClaw 队列：session lane `session:<key>` 保证"同一 session 同时只有一个 run"；全局 lane `main` 受 `agents.defaults.maxConcurrent` 限制；后台 lane `cron`/`cron-nested`/`nested`/`subagent`；`messages.queue.mode` = `steer|followup|collect|interrupt`，`messages.queue.cap`/`drop`(`summarize|old|new`) | https://docs.openclaw.ai/concepts/queue | 高 | 是（reference 页亦提"两级 lanes/queues"） |
| 9 | OpenClaw 会话存储已迁到 SQLite：`~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`（session rows + append-only 树状 transcript events + compaction checkpoints）；`session.reset.mode` = `none|daily|idle` | 同 #7 | 高 | 是 |
| 10 | Hermes：`~/.hermes/state.db`（SQLite, WAL, FTS5）；key 形如 `agent:main:<platform>:dm:<chat_id>`、`agent:main:<platform>:group:<chat_id>:<user_id>`；`session_reset.mode: none|idle|daily|both`；`/compress` 压缩后生成 "name #2" 续篇会话 | https://hermes-agent.nousresearch.com/docs/user-guide/sessions | 高 | 是（messaging 文档与 FAQ 佐证"每 chat/每 topic 独立 session"） |
| 11 | ACP：`session/new`、`session/load`（agent 通过 `session/update` 回放历史）、`session/fork` 为 RFD 草案（2025-11-17~12-10），请求含 `sessionId`+`cwd`+`mcpServers`，能力声明 `session: { fork: {} }` | https://agentclientprotocol.com/rfds/session-fork | 高 | 是（typescript-sdk `ForkSessionRequest` 类型页存在） |
| 12 | Anthropic sandbox-runtime (srt)：macOS `sandbox-exec` Seatbelt、Linux `bubblewrap` + 去除 netns + seccomp 阻断 unix socket、Windows alpha 用 `srt-sandbox` 账户 + WFP；网络经宿主 HTTP/SOCKS5 代理按 `allowedDomains/deniedDomains` 过滤；配置 `~/.srt-settings.json`；API `SandboxManager.initialize()`/`wrapWithSandbox()` | https://raw.githubusercontent.com/anthropic-experimental/sandbox-runtime/main/README.md | 高 | 是（npm 包页与博客文章一致） |
| 13 | E2B：`sandbox.pause()` 保存文件系统+内存+运行进程；暂停约 4s/GiB RAM，恢复约 1s；暂停态无限期保留、无 TTL；默认 timeout 5 分钟，`onTimeout: "kill"|"pause"`；连续运行上限 Pro 24h / Hobby 1h | https://docs.e2b.dev/sandbox/persistence | 高 | 是（morphllm/beam 第三方文章同样引用 4s/GiB、1s 恢复） |
| 14 | Modal：Sandbox memory snapshot（内存+文件系统）7 天过期、仅能在同一实例类型恢复；filesystem snapshot 默认 30 天 TTL；由外部触发 `_experimental_snapshot()` | https://modal.com/docs/guide/sandbox-snapshots（搜索摘要） | 中 | 否 |
| 15 | Daytona：容器沙箱冷快照（仅文件系统）、VM 沙箱热快照（文件系统+内存）；warm pool 需 snapshot/region/CPU/mem/disk/用户完全匹配且不含自定义 env/volumes/secrets 才命中；archive 把文件系统移到对象存储 | https://www.daytona.io/docs/en/snapshots/ 、troubleshooting（搜索摘要） | 中 | 否 |
| 16 | OpenHands：`DockerSandboxService` 每 conversation 一个 agent-server 容器，生命周期 `STARTING → RUNNING → PAUSED → ERROR → MISSING`；容器启动 30–60s | https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox（搜索摘要） | 中 | 否 |

## 架构与工作原理

本专题横切八个引擎与十来种运行时，核心抽象可以统一成四层：

```
业务 key (群/用户/工单)                      ← 网关掌握
   └─► 引擎 session id / thread id / session key   ← 引擎掌握
         └─► transcript 持久化 (JSONL / SQLite)     ← 引擎掌握，位置可注入
               └─► 运行时实例 (进程 / 容器 / microVM) ← 网关或引擎掌握
```

各引擎在"谁拥有 session 状态"上分为两派：

1. **CLI/SDK 型（Claude Code、Codex、pi、Gemini CLI）**：session 是本地文件（JSONL）+ 一个进程；没有常驻服务，"resume" 就是启动新进程并读回文件。并发控制、锁、队列都需要网关自己做。Claude Code 明确说明同一 session 双端 resume 会交织写入。
2. **服务型（opencode server、OpenClaw gateway、Hermes gateway、OpenHands agent-server）**：一个常驻进程拥有全部 session 状态，对外暴露 HTTP/WS/JSON-RPC；session 之间的排队、隔离、并发上限由引擎内部的 lane/queue 实现（OpenClaw 最完备）。

ACP 则是把第 1 派包装成第 2 派的协议：client 起 agent 子进程，用 `session/new`/`session/load`/`session/prompt` 驱动，`session/update` 流式回传。

沙箱层与 session 层是正交的：Codex 的 `sandboxMode`、Anthropic srt 是"进程级 OS 沙箱"（无容器，毫秒级），E2B/Daytona/Modal/OpenHands 是"容器/microVM 级"（秒级启动，支持快照恢复）。网关需要决定 session ↔ 沙箱的映射粒度：每 session 一沙箱（隔离最好、成本最高）、每租户一沙箱（多 session 共享 workspace）、或共享主机 + srt 进程沙箱。

## 可编程接入面

按"网关如何创建/续接/分叉一个 session"整理（均为一手来源，除标注外）：

| 引擎 | 创建 | 续接 | 分叉 | 结构化输出/事件 |
|------|------|------|------|-----------------|
| Claude Code | `claude -p "<prompt>" --output-format json`（返回 `session_id`）；可 `--session-id <uuid>` 预设（社区资料，未在本次一手页面确认，标为推测） | `claude -p --resume <id> --output-format json`；`--continue` 取当前目录最近会话 | `--resume <id> --fork-session`（新进程，权限授权不继承）；交互内 `/branch` | `stream-json`；hooks 收到 `transcript_path`、`SessionEnd` hook 可归档 |
| Claude Agent SDK | `query({ options: { resume, forkSession } })`（docs 页仅提及 SDK 存在，字段名为已知常识，标中置信度） | 同左 | 同左 | 逐消息回调 |
| Codex | `codex exec "<prompt>" --json` / SDK `startThread()` | `codex resume <id>`、`codex exec --resume-session-id <id>` / `resumeThread(threadId)` | CLI 侧有 fork（第三方博客提及，未一手确认） | `--json` 事件流：`thread.started`、`turn.*`、`item.*`（SDK 页面未列全，中置信度）；会话存 `~/.codex/sessions/*.jsonl`，`~/.codex/session_index.jsonl` 存 `/rename` 映射 |
| opencode | HTTP server + 自动生成 SDK：`session.create({ parentID?, permission? })` | `session.chat()`（同 id 继续） | `session.fork()`（复制到某条消息） | `session.abort()`、`session.timeline`、`session.compact`、事件 SSE（DeepWiki） |
| pi | `pi --session <path|id>`、`pi --no-session`（无痕） | `pi -c` / `pi -r` | `pi --fork <path|id>`；`/tree`、`/fork`、`/clone` | JSONL 树文件本身就是事件流；SDK 可 `SessionManager` 打开（推测） |
| Gemini CLI | `gemini -p`、`--resume`（本次未抓取一手页面，推测） | 同左 | 未知 | headless JSON 输出（推测） |
| Hermes | gateway 自动按 chat/user/topic 建 session；CLI `hermes chat` | `hermes --resume <id|name>`、`hermes -c` | 无显式 fork；`/compress` 生成 `#2` 续篇 | SQLite `state.db` + FTS5；`hermes sessions list/delete` |
| OpenClaw | gateway 收到入站消息即按 `sessionKey` 解析；hook `hook:<uuid>`；`/new`、`/reset` | 同 key 自动续接 | 无显式 fork（transcript 是树结构，有 compaction checkpoints） | gateway 是 session 列表/token 计数的唯一真源；SQLite |
| ACP | `session/new { cwd, mcpServers }` → `sessionId` | `session/load { sessionId, cwd, mcpServers }`（agent 用 `session/update` 回放全部历史） | `session/fork`（RFD 草案，同 load 的参数） | `session/update` 通知；`initialize` 协商 `loadSession`、`session.fork` 能力 |

## 会话模型

### 1) 语义对比

- **Claude Code**：session 绑定项目目录；id 为 uuid，另有可读 name（`-n`、`/rename`）与 AI 生成标题，三者都能作 resume handle（默认显示名不能）。resume 会恢复历史、模型、`--agent`、permission mode、goal、scheduled tasks，但**不恢复** `--mcp-config`、`--settings`、`--add-dir` 等启动参数——网关每次 resume 必须重新传。v2.1.223 起可跨项目目录 resume。fork 语义是"复制 transcript 到新 id"，不是树内分支（pi 才是）。
- **Codex**：thread 是一等公民；`resumeThread` 后继续 `run()`；线程内 turn 严格串行（SDK 明说）。
- **opencode**：session 有 `parentID`，子 agent（Task 工具）创建带 parentID 的子 session；`fork()` 复制到指定消息；`revert` 支持撤销。
- **pi**：单文件树，`/tree` 在树内切 leaf；分支摘要（branch summary）是一等 entry，可把废弃分支压成摘要注入当前分支——这是别的引擎都没有的能力。
- **Hermes**：以聊天平台 (platform, chat_id, user_id/thread_id) 为 key，天然"群内每人独立上下文"（group key 含 `user_id`）；这对"群助手"是重要区别：OpenClaw 默认 `per-group` 是整个群共享一个 session。
- **OpenClaw**：key 由 agentId + channel + scope 组成，scope 策略可配置到 DM/group/thread 三类，并可按 channel 覆盖；重置策略 `none|daily|idle` 分别决定"是否换 sessionId"。gateway reset (`/new`) 只记边界不换 id。
- **ACP**：`session/load` 需要 agent 声明 `loadSession` 能力；不支持时网关必须自己重放上下文。

### 2) 并发控制

| 引擎 | 每 session 串行 | 跨 session 并行 | 进程模型 |
|------|----------------|----------------|----------|
| Claude Code | **无锁**，网关须自建互斥；`/branch` 后后台 subagent/bash 继续运行并归属新分支 | 多进程天然并行；worktrees 文档建议每分支独立 session | 每 session 一进程（`-p` 一次一 turn，进程退出） |
| Codex | SDK 强制一 thread 一 turn | 多 thread 并行 | 每 run 一进程或 SDK 内嵌 |
| opencode | server 内部 `SessionStatus`/abort；细节未一手确认 | server 共享进程多 session | 单服务进程 |
| pi | 文件级，无锁（推测） | 多进程 | 每 session 一进程 |
| OpenClaw | `session:<key>` lane 保证唯一 run；入站排队策略 `steer/followup/collect/interrupt` + `cap/drop` | `agents.defaults.maxConcurrent`；后台 lane `cron/subagent` 不占主 lane | 单 gateway 进程，多 agent；非 main session 可跑在 docker sandbox（reference 页提及，参数名未一手确认） |
| Hermes | 每 chat 串行（推测，文档未明说） | 多 profile 多 gateway 并行，profile 间 memory/session/skills 完全隔离 | 每 profile 一 gateway 进程 |
| OpenHands | 每 conversation 一容器 | 容器级并行 | 控制面 + 每 conversation agent-server |

### 3) 压缩/compaction 可控性

| 引擎 | 触发 | 外部可触发 | 钩子 |
|------|------|-----------|------|
| Claude Code | 自动（接近上限）+ 手动 `/compact [instructions]`；resume 时若空闲 >1h 且 >100k tokens 弹"Resume from summary"对话框（Pro/Max） | `claude -p --resume <id> "/compact ..."`（推测可行） | `PreCompact` hook（docs 其他页，已知常识） |
| Codex | 自动（未一手确认阈值） | `/compact` | 无 |
| opencode | `session.compact` API | 是（API） | 插件事件（推测） |
| pi | 自动 + `/compact [prompt]`；compaction 是树 entry，可回溯 | 是（SDK） | extension 可拦截（推测） |
| OpenClaw | 三种：provider 上下文溢出错误后压缩重试；用量投影达 window − reserve；session 内阈值（safeguard 模式下禁用）；压缩前先用 `NO_REPLY` 静默写 workspace 记忆 | `/compact` | pre-compaction memory flush |
| Hermes | `sessions.max_resume_messages`（默认 20000）+ `/compress`；压缩产生新 session `name #2`，resume by name 自动取最新谱系 | 是 | 无 |

结论：只有 opencode、pi、OpenClaw 提供了"外部程序化触发压缩"的可靠接口；Claude Code/Codex 需通过 prompt 注入斜杠命令，属于弱契约。网关的 `compact()` 公共能力应标注"best-effort"。

### 4) 工作区模型与密钥注入

- **Claude Code**：session 与 cwd 强绑定；`CLAUDE_CONFIG_DIR=/srv/tenant-a CLAUDE_CODE_PROJECT_DIR_NAME=work claude` 是官方给出的"宿主嵌入 Claude Code、每 session 一个 config dir"模式，transcript 与 auto memory 都落在 `/srv/tenant-a/projects/work/`。这就是网关做租户隔离的钥匙：config dir 隔离 = 会话、记忆、settings 三者一起隔离。密钥经环境变量（`ANTHROPIC_API_KEY` 等）注入进程，注意 `--fork-session` 起的新进程不继承"allow for this session"授权。
- **Codex**：`workingDirectory` + `skipGitRepoCheck`（非 git 目录需显式跳过）+ `sandboxMode`；`workspace_write` 只允许写 workspace 与配置的 writable roots。
- **opencode**：server 进程绑定一个项目目录（DeepWiki 未详述 worktree）；多项目需多 server 实例或 `directory` 参数（推测）。
- **pi**：sessions 按 cwd 分目录存储，`--session-dir` 可改（npm 页面提及，中置信度）。
- **OpenClaw**：每 agent 一个 workspace 目录（`~/.openclaw/agents/<agentId>/`），memory 文件在 workspace 内；非 main session 可配置进 docker 沙箱。
- **Hermes**：每 profile 一套 memory/session/skills 目录；多 bot token 各绑一个 profile。
- **沙箱托管平台**：E2B/Daytona/Modal 都用 env/secrets 参数在 create 时注入；Daytona 明确"带自定义 env/volumes/secrets 的 create 不会命中 warm pool"——密钥注入与冷启动延迟存在直接权衡，建议密钥走运行时挂载/代理而非 create 参数。

### 5) 沙箱运行时对比

| 运行时 | 隔离技术 | 启动延迟 | 快照/恢复 | 成本/多租户要点 |
|--------|---------|---------|-----------|----------------|
| Anthropic srt | bubblewrap / Seatbelt / WFP，进程级，无容器 | 毫秒级（进程包裹） | 无（只是包裹进程） | 免费、本地；网络仅域名级过滤；unix socket 放行可触达 docker；nested（在 docker 内）需 `enableWeakerNestedSandbox` |
| Codex sandbox | 与 srt 同类（Linux landlock/seccomp、macOS seatbelt；本次未一手抓取） | 毫秒级 | 无 | 三档 `read_only/workspace_write/full_access` |
| Docker（OpenHands 模式） | 容器 | 30–60s/conversation（OpenHands 文档口径） | 停止/暂停容器；无内存快照 | 自建；每 conversation 一容器，端口分配、webhook 回控制面 |
| E2B | Firecracker microVM | 300–800ms（第三方口径） | pause 4s/GiB，resume ≈1s；FS+内存+进程全保留；暂停无限期保留（存储持续计费） | 按秒计费 vCPU/GiB；默认 5 分钟超时，`onTimeout: "pause"` 可做"空闲即暂停"的 session 冷存 |
| Daytona | 容器 或 VM 沙箱 | 声称 <90ms（warm pool 命中时） | 容器冷快照(FS)、VM 热快照(FS+内存)；stop/archive（archive 迁对象存储，恢复慢） | warm pool 匹配条件苛刻；archive 适合长期休眠 session |
| Modal Sandboxes | gVisor 容器（Modal 一贯口径；另有 VM Sandboxes 页面） | 秒级 | memory snapshot 7 天过期且需同实例类型；FS snapshot 30 天 TTL；由外部触发 | 适合"执行完即快照+销毁"的批处理式 session |
| Cloudflare Sandbox / Vercel Sandbox | 容器（Cloudflare Containers / Firecracker） | 未一手核实 | 未一手核实 | 本次未抓取，列为未解决问题 |

多租户维度：srt 与 Codex sandbox 依赖宿主 OS 用户/命名空间，适合"可信单租户 + 防误操作"；microVM 类（E2B、Daytona VM、Firecracker）才提供硬多租户边界。

## 权限与安全

- Claude Code 的 permission mode 是 session 状态的一部分，但**恢复规则复杂**：终端 resume 恢复原 mode（`bypassPermissions`、`plan` 例外）；`claude -p --resume` 按新 `-p` 运行的默认 mode，只有满足四条件（传 `--permission-prompt-tool`、不传 `--permission-mode`、不传 `--fork-session`、非 channels 启动）才恢复 plan mode。网关应**每次显式传 `--permission-mode`**，不要依赖恢复。
- Codex：`sandboxMode` + approval policy 组成权限；SDK 侧无逐工具审批回调（本次未确认）。
- opencode：`session.create({ permission })` 可按 session 下发权限规则——这是最贴近"网关按业务下发权限"的接口形态。
- OpenClaw：会话隔离 + 非 main 会话沙箱化 + per-channel 队列策略，是"群助手权限限制"最完整的参考实现。
- srt 的 `denyRead/allowRead/allowWrite/denyWrite/allowedDomains/deniedDomains/allowUnixSockets/allowLocalBinding` 可作为网关统一的"沙箱策略 IR"，再翻译成 Codex sandboxMode、docker 挂载、E2B 网络策略。

## 扩展机制与资产

本专题只涉及与 session 相关的部分：pi 的 extension entry 可把自定义状态写进 session 树（随分支/回退一起管理）；OpenClaw transcript 含 compaction checkpoints；Claude Code hooks（`SessionStart/SessionEnd/PreCompact`）与 `transcript_path` 是网关归档、审计的接口。其他资产格式见 T-其他专题，此处不展开。

## 记忆

与 session 直接相关的记忆行为：Claude Code auto memory 随 `CLAUDE_CONFIG_DIR`/project dir 隔离（`projects/<name>/memory/`）；OpenClaw 压缩前 `NO_REPLY` 静默 flush 到 workspace 记忆文件；Hermes 每 profile 独立 memory store。其余不适用（由记忆专题覆盖）。

## 多 Agent 与协作

- opencode 子 agent = 带 `parentID` 的子 session，可通过 API 列出/中止，父子关系可观测。
- OpenClaw subagent 走独立 `subagent` lane，`subagents.maxConcurrent`（reference 页提及，键名中置信度）限流，不阻塞主会话 lane。
- Claude Code 后台 subagent 在 `/branch` 后归属新分支，`--fork-session` 新进程则不带走它们。
- ACP `session/fork` RFD 的动机之一正是"在不污染原会话的前提下起并行任务（如生成摘要）"。

## 可观测性

- Claude Code：`stream-json` 事件流、hooks 输入含 `session_id`/`transcript_path`、`SessionEnd` 归档；transcript 格式内部不稳定，官方明确"不要直接解析 JSONL"。
- Codex：`--json` 事件 + `~/.codex/sessions/*.jsonl`。
- opencode：server SSE 事件 + `session.timeline`。
- OpenClaw：gateway 是 token 计数/会话列表真源；SQLite 可直接查询；`session.maintenance` (`pruneAfter`、`archiveDashboardAfter`、`maxEntries`、`preserveRecent`) 定义了归档/清理策略。
- Hermes：`state.db` FTS5 全文检索；`sessions.auto_prune` 默认 90 天。
- 沙箱平台：OpenHands 容器状态机 `STARTING/RUNNING/PAUSED/ERROR/MISSING` 经 webhook 回报；E2B 状态 `Running → Paused → Running → Killed`。

## 对我们架构的启示

### 1) SessionRegistry 设计

网关维护三级映射，每级独立持久化（建议 SQLite/Postgres，一行一 binding）：

```
BusinessKey  = <tenant>:<channel>:<scope>:<id>[:<user>]      # 借鉴 OpenClaw/Hermes key 语法
   ├─ EngineBinding { engine, engineSessionRef, cwd, configDir, permissionProfile, model, createdAt, lastTurnAt }
   │      engineSessionRef 形态：claude:{uuid} | codex:{threadId} | opencode:{id,parentID} | pi:{path,leafId} | openclaw:{sessionKey} | acp:{sessionId}
   └─ RuntimeBinding { kind: process|docker|e2b|daytona|modal|srt, instanceId, state, snapshotRef?, lastPausedAt }
```

要点：
- BusinessKey 的 scope 策略要做成配置（`dmScope`/`groupScope` 直接抄 OpenClaw 枚举），并允许"群内按人隔离"（Hermes 语义）作为可选项——群助手赛题里"同群连续 + 群间隔离"对应 `per-group`，但企业场景常需 `group+user`。
- EngineBinding 要保存**resume 时必须重传的启动参数**（Claude Code 不恢复 `--mcp-config/--settings/--add-dir`；`--permission-mode` 恢复规则复杂），网关每次 resume 从 binding 里完整重放，而不是信任引擎恢复。
- RuntimeBinding 与 EngineBinding 解耦：同一引擎 session 可在不同运行时实例上恢复（E2B resume、Daytona archive 恢复、或落回本机 srt）。

### 2) 生命周期状态机

```
NEW ─create─► ACTIVE ─turn─► ACTIVE
ACTIVE ─idle(T1)─► WARM      (进程退出/沙箱 pause；E2B pause ≈4s/GiB，resume ≈1s)
WARM   ─idle(T2)─► ARCHIVED  (transcript 归档 + 沙箱 archive/kill；Daytona archive、Modal FS snapshot 30d)
ARCHIVED ─message─► ACTIVE   (重新 create 运行时 + engine resume；需重放启动参数与密钥)
ANY    ─reset(/new, daily, idle)─► NEW(新 engineSessionRef，旧 binding 标 superseded)   # OpenClaw/Hermes 语义
ACTIVE ─fork─► ACTIVE'       (Claude --fork-session / opencode fork / pi --fork / ACP session/fork)
```

- 每个 BusinessKey 一条 **session lane**（照搬 OpenClaw：串行 run；入站策略 `steer|followup|collect|interrupt` 作为公共能力参数）；全局 `maxConcurrent` 与后台 lane（subagent/cron）分离。
- 因 Claude Code/pi 无文件锁，lane 是**唯一**防止 transcript 交织的手段；网关必须保证同一 engineSessionRef 不会被两个进程同时 resume。
- 过期策略参数化：`idleMinutes`、`dailyResetHour`、`pruneAfter`、`preserveRecent`（OpenClaw/Hermes 已有成熟枚举可直接映射）。

### 3) 公共能力 vs 扩展能力映射

| 能力 | 公共（可归一化） | 引擎扩展 | 接入参数 |
|------|-----------------|---------|---------|
| `session.create/resume` | 全部引擎 | — | cwd、configDir、model、permissionProfile、env/secrets |
| `session.fork` | Claude Code、Codex(CLI)、opencode、pi、ACP(RFD) | Hermes/OpenClaw 无（需网关"复制 transcript"降级） | fromMessageId（仅 opencode/pi 支持点位） |
| `session.tree`（树内分支/回退/branch summary） | — | **pi 独有**；Claude Code checkpointing 仅 rewind | leafId |
| `session.compact` | opencode、pi、OpenClaw、Hermes（可程序触发） | Claude Code/Codex 仅斜杠命令（best-effort） | instructions、reserveTokens |
| `session.lane.mode` | 网关实现即可归一 | OpenClaw 原生 | steer/followup/collect/interrupt、cap、drop |
| `session.reset.policy` | 网关实现 | OpenClaw/Hermes 原生 | none/idle/daily/both |
| `session.child`（子 session 树） | opencode(parentID)、OpenClaw(subagent lane) | Claude Code subagent 不是独立 session | parentRef |
| `sandbox.policy` | 用 srt 的 allow/deny 键做 IR | Codex 三档、docker 挂载、E2B/Daytona 网络策略 | fs.allowWrite[]、net.allowedDomains[] |
| `runtime.snapshot/restore` | — | E2B(内存)、Daytona(VM 热/容器冷)、Modal(内存 7d) | ttl、instanceType 约束 |

### 4) 风险与坑

1. Claude Code transcript JSONL 格式官方声明不稳定——网关只能用 `-p --output-format json`、hooks 与 `transcript_path` 归档，不要解析行格式做业务。
2. Claude Code `--fork-session` 新进程丢失 session 内授权；`-p --resume` 不恢复 permission mode（除 plan 特例）。
3. OpenClaw 已从 `sessions.json` 迁移到 SQLite，老资料（含大量博客）过时；接入时以 `openclaw doctor --session-sqlite import` 为准。
4. E2B paused sandbox 无 TTL、持续占存储；必须在 ARCHIVED 转换里显式 kill。Modal memory snapshot 仅 7 天且绑定实例类型，不能当长期归档。
5. Daytona warm pool 命中条件苛刻，注入 secrets 会退化为冷启动；把密钥改为运行时通过代理/挂载注入。
6. srt 在 docker 内需 `enableWeakerNestedSandbox`，安全性下降；Linux 无内置违规监控。
7. Hermes 群 key 包含 `user_id`，与 OpenClaw `per-group` 语义相反；网关 scope 策略要显式映射，否则"同群连续性"评测会失败。
8. ACP `session/fork` 仍是草案；`session/load` 需 agent 声明 `loadSession`，不支持时网关要自己重放历史（成本高）。

## 未解决问题

- Gemini CLI 的 session/resume 与 checkpoint 语义（`--resume`、`/chat save`）本次未抓取一手页面。
- Codex CLI `--json` 事件的完整枚举、fork 命令形态、compaction 阈值需查 openai/codex 仓库 docs。
- opencode server 的 HTTP 路径（`/session`、`/session/:id/fork`）与 `SessionStatus` 取值需查 OpenAPI spec；opencode 是否支持多目录/worktree。
- OpenClaw `agents.defaults.sandbox.mode`（off/non-main/all）与 docker 参数键名需在 docs.openclaw.ai/gateway/sandboxing 核实。
- Cloudflare Sandbox、Vercel Sandbox 的启动延迟与快照能力未核实；gVisor 在 Modal 的现状（VM Sandboxes 新页面暗示可能已引入 microVM）。
- Claude Agent SDK 的 `resume`/`forkSession` 字段名与 `--session-id` 预设 uuid 行为需在 agent-sdk 文档确认。
- Firecracker 直接自建（非 E2B）的快照恢复延迟数据未收集。

## 来源列表

1. https://code.claude.com/docs/en/sessions
2. https://learn.chatgpt.com/docs/codex-sdk （由 https://developers.openai.com/codex/sdk 重定向）
3. https://deepwiki.com/anomalyco/opencode/3.1-session-management
4. https://github.com/anomalyco/opencode/issues/12916
5. https://pi.dev/docs/latest/sessions
6. https://docs.openclaw.ai/reference/session-management-compaction
7. https://docs.openclaw.ai/concepts/session
8. https://docs.openclaw.ai/concepts/queue
9. https://hermes-agent.nousresearch.com/docs/user-guide/sessions
10. https://hermes-agent.nousresearch.com/docs/user-guide/messaging/ （搜索摘要）
11. https://agentclientprotocol.com/rfds/session-fork
12. https://agentclientprotocol.github.io/typescript-sdk/types/ForkSessionRequest.html （搜索结果，用于交叉验证）
13. https://raw.githubusercontent.com/anthropic-experimental/sandbox-runtime/main/README.md
14. https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime （搜索结果）
15. https://docs.e2b.dev/sandbox/persistence
16. https://www.morphllm.com/e2b-pricing 、https://www.beam.cloud/blog/e2b-pricing-explained （第三方，交叉验证 E2B 数字）
17. https://modal.com/docs/guide/sandbox-snapshots 、https://modal.com/docs/reference/modal.SandboxSnapshot （搜索摘要）
18. https://www.daytona.io/docs/en/snapshots/ 、https://www.daytona.io/docs/en/troubleshooting/ （搜索摘要）
19. https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox 、https://github.com/OpenHands/OpenHands/issues/15630 （搜索摘要）
20. https://codex.danielvaughan.com/2026/04/13/codex-cli-session-persistence-resume-fork-analytics/ 、https://inventivehq.com/knowledge-base/openai/how-to-resume-sessions （第三方，Codex CLI resume 交叉验证）
21. https://www.threads.com/@boris_cherny/post/DWfjrxpFF9X （Claude Code fork 交叉验证）
