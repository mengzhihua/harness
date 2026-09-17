# Coding Agent 运行时：完整技术方案

**版本**：v1.0（重新设计，替换此前 v0.x 增量稿）  
**状态**：设计完备，实现未开始。  
**对标**：DeepSeek Harness、OpenAI Codex / ChatGPT Agents、Devin、Claude Code、Cursor Cloud、OpenHands / SWE-agent（附录）。

设计完备的意思：子系统、接口、数据、不变量、失败模式一次写清。落地仍分期，但分期是 **写代码的顺序**，不是「到时候再想插件/轨迹」。

---

## 1. 问题、目标和边界

### 1.1 要解决什么

聊天框只能建议改代码。要让模型在仓库里 **闭环干活**，必须有一层确定性系统：

- 把「想」变成读、改、跑
- 把危险动作拦住或问人
- 把项目专有能力接进来（而不是 fork 一份产品）
- 把全过程留下，能看、能回放、能评测

这一层就是 **Agent 运行时**。本仓库做的就是它。

### 1.2 产品目标

做一个模型无关的软件工程 Agent 运行时，默认本地好用，协议可接到 CI / IDE / 云。

日常路径（验收用这条，不用架构清单）：

```text
cd <repo> && harness
> 把失败的登录测试修了，不要动别的模块

1. 几秒内开始搜代码
2. 改动在独立 worktree，用户未提交内容不动
3. 能看见命令、diff、计划
4. 中途可打断、转向、/undo
5. 结束有真实测试/lint 输出
6. /apply 合回；项目插件生效且写进轨迹
7. harness traj show 能回放模型当时看见的内容
```

### 1.3 非目标

| 不做 | 原因 |
| --- | --- |
| IDE 分叉 | 运行时通过协议被 IDE 使用，不自造编辑器 |
| 绑定一家模型 | 议价和可用性 |
| 把 loop 做成插件 | 否则无法稳定 replay |
| 插件商店（v1） | 本地 / 仓库 / git 安装先跑通 |
| 通用个人助理 | 只做软件工程 |
| 第一天自建机房 | 执行运行时先本机 + Docker，云是同一接口的第三实现 |

### 1.4 有运行时的定义

同时满足才算「有」：

1. 存在可启动进程（TUI 或 `exec`）
2. 模型 tool call 真实作用在 Agent worktree
3. 写出带 `plugin_lock` 的轨迹，`traj show` / dry replay 可用
4. 无插件时内置工具就能改代码；有插件时不改源码即可加载

现在：0/4。仓库无实现代码。

---

## 2. 术语

| 词 | 定义 |
| --- | --- |
| **模型** | LLM。只负责采样。不直接碰磁盘。 |
| **Agent 运行时** | harness 主进程。下文单说「运行时」即指它。 |
| **执行运行时** | FS / Shell / 沙箱的后端实现（local / docker / vm）。 |
| **Thread** | 一次持久任务会话。 |
| **Turn** | 一次用户输入触发的工作（可含多步推理与工具）。 |
| **Step** | 一次模型请求 + 它产生的工具调用。 |
| **Item** | 流式原子，UI 只渲染它。 |
| **AgentWorkspace** | 本线程独占目录（默认 git worktree）。 |
| **UserWorkspace** | 用户当前仓库，可能有脏文件。 |
| **插件** | 带 manifest 的扩展包。 |
| **plugin_lock** | 本线程实际加载的插件 id@version+哈希。 |
| **轨迹** | header + 事件流 + artifacts + 结局。事实源。 |
| **Checkpoint** | 工作区快照 + 轨迹投影点，供 undo。 |
| **Done Report** | 改了什么、跑了什么、能否 apply。 |
| **Profile** | 预置能力集。`minimal` 评模型，`standard` 给人用。 |

---

## 3. 总体架构

运行时是一台「软件工程师操作系统」。模型是 CPU。执行运行时是外设。插件是应用。轨迹是黑匣子。

```text
┌──────────────────────────────────────────────────────────┐
│  表面：TUI / exec / SDK / 未来 IDE·Cloud                  │
│  只讲 JSON-RPC，不内嵌 loop                               │
└──────────────────────────┬───────────────────────────────┘
                           │ App Server
┌──────────────────────────▼───────────────────────────────┐
│  Agent 运行时                                             │
│  Thread Manager │ Inbox/Steer │ Agent Loop                │
│  Context        │ Tool Router │ Policy                    │
│  Plugin Host    │ Trajectory  │ Checkpoint / Done Report  │
└───────┬───────────────┬──────────────────┬───────────────┘
        │               │                  │
        ▼               ▼                  ▼
  LLM Adapter     执行运行时          Trajectory Store
  (可插件化)      local/docker/vm     jsonl + .traj 包
        │               │
        ▼               ▼
     模型 API      AgentWorkspace ──apply──► UserWorkspace
```

六条硬边界（设计期就冻结，不靠后期重构）：

| 边界 | 左 | 右 | 破了会怎样 |
| --- | --- | --- | --- |
| 协议 / 运行时 | 所有表面 | Core | 每种 UI 各写一套 Agent |
| 模型 / 运行时 | Adapter | Loop | 换模型等于换产品 |
| 执行 / 运行时 | Provider | Tool Router | 上云要重写工具 |
| 用户目录 / Agent 目录 | User | Agent worktree | 弄脏未提交代码 |
| 插件 / Loop | Plugin Host | Loop 内核 | replay 失效、undo 说不清 |
| 轨迹 / UI | Store | 任何表面 | 评测和复盘各说各话 |

---

## 4. Agent 运行时（主进程）

### 4.1 生命周期

```text
启动
  读 config、cwd、profile、mode
  解析插件根 → 校验权限 → 冻结 plugin_lock
  打开或创建 Thread（header 写入 lock、模型、工作区路径）
  拉起执行运行时（默认 local）
  创建 AgentWorkspace（worktree）
  进入事件循环，直到 exit
退出
  中断 in-flight 推理与命令
  flush 轨迹、写 outcome
  可选保留 worktree（resume）或清理
```

进程内可有多个 Thread，但 v1 默认 TUI 一个前台 Thread。`exec` 一个进程一个 Thread。

### 4.2 Agent Loop（内核，不是插件）

```text
turn/start ← 用户输入或 steer
  认领 inbox
  assemble prompt（顺序冻结，见 §7）
  loop step:
    若 cancelled → interrupt，写轨迹
    llm.stream（可 abort）
    只读工具并行；同文件写串行
      hook.pre → policy → 执行运行时 → hook.post → 截断落盘 → 追加轨迹
    inbox 有 steer → 下一步吃新约束
    上下文压力 → compact（唯一允许打断前缀的时刻）
  Agent 模式且有改动且无 checks → 注入 verify nudge，再开 step
  emit Done Report → checkpoint
turn/end
```

不变量：

1. 直到 compact 之前，新 prompt 是旧 prompt 的精确前缀（缓存）。
2. 进入模型的字节 ⊆ 轨迹可重建字节。违反即运行时 bug。
3. Loop 只读写 AgentWorkspace。
4. `/apply` `/undo` 是用户命令，不是模型工具。
5. 插件只能注册到 Router / Hook / Skill / Adapter / Command，不能替换本循环。

### 4.3 模式

| mode | 执行运行时写 | 网络 | 用途 |
| --- | --- | --- | --- |
| `ask` | 否 | 否 | 解释、搜索 |
| `plan` | 否 | 否 | 产出可编辑计划，确认后再 `agent` |
| `agent` | 仅 AgentWorkspace | 默认关 | **默认** 日常编码 |
| `yolo` | 按配置 | 按配置 | CI 或用户显式 |

切换不重启 Thread，但要写 `mode/change` 进轨迹（可能断 cache）。

### 4.4 Profile

| profile | 模型看见的工具 | 给谁 |
| --- | --- | --- |
| `minimal` | 持久 bash + 编辑器 | 测模型，不测我们堆了多少功能 |
| `standard` | 完整 ACI + 插件 + 计划 + 压缩 | **产品默认** |
| `eval` | 与任务文件声明的工具集一致 | 评测仓 |

Code Mode（模型写一段程序合并多步工具）列入 v1.1，接口预留 `run_code`，v1 不实现。

---

## 5. 执行运行时

工具不直接 `child_process`。一律走 Provider，这样本机、评测容器、云 VM 对 Loop 同构。

```ts
interface ExecutionProvider {
  id: "local" | "docker" | "vm"
  start(ctx: ThreadContext): Promise<void>
  stop(): Promise<void>
  readFile(path: string, range?: LineRange): Promise<FileSlice>
  writeFile(path: string, content: string): Promise<void>
  exec(req: ExecRequest): Promise<ExecResult>   // 持久 shell
  kill(execId: string): Promise<void>
  listDiff(since?: CheckpointId): Promise<DiffStat>
}

interface WorkspaceProvider {
  beginThread(threadId: string): Promise<{ agentRoot: string }>
  checkpoint(label: string): Promise<CheckpointId>
  restore(id: CheckpointId): Promise<void>
  applyToUser(): Promise<ApplyResult>           // 冲突则停，不自动乱解
}
```

| 实现 | 何时用 | v1 |
| --- | --- | --- |
| `local` | 日常 TUI | 必做。git worktree + 路径约束；Linux 后续加 Landlock |
| `docker` | 评测、不可信任务 | 必做。镜像由项目或 fixture 声明 |
| `vm` | 长任务 / 云 | 接口先留，实现放落地后期 |

路径相对 AgentWorkspace。`../` 逃逸 → policy deny，写轨迹 `source=policy`。

执行运行时 **看不到** 推理 API key。需要的第三方 token 由运行时按权限注入，并出现在轨迹 header 的「已注入密钥名」（无值）。

---

## 6. 工作区、转向、收工、审批

### 6.1 工作区

默认 Agent 模式创建 git worktree。非 git 仓库则复制目录，并在 TUI 明示。

- 用户 staged/unstaged 一律不动
- 每 Turn 结束 checkpoint
- `/undo`：restore + 轨迹追加 `rewind`（不改写历史）
- `/apply`：合回 UserWorkspace；冲突交给人
- in-place 仅 opt-in，TUI 警告

### 6.2 转向

| 动作 | 行为 |
| --- | --- |
| Esc / `turn/interrupt` | 立即取消推理，SIGINT 正在跑的命令 |
| 再输入 / `turn/steer` | 当前 tool 结束后下一步采用新约束 |
| `/fork` | 从 checkpoint 或指定事件开平行 Thread |
| `/resume` | 打开最近 Thread，执行运行时按 header 重建 |

### 6.3 收工

Agent 模式结束前必须有 Done Report：

```text
changed_files[], checks[{cmd, exit_code, artifact}], residual_risks[], apply_ready
```

有改动且 checks 为空 → 不能静默成功，注入 verify nudge。测试命令来自 `AGENTS.md` / 插件 / 用户本句，运行时不硬编码 `npm test`。检查失败则继续修，或由模型声明阻塞原因后 `apply_ready=false` 结束。

### 6.4 审批

| 默认 | 例子 |
| --- | --- |
| 自动允许 | AgentWorkspace 内读、普通编辑、白名单测试/lint |
| 问一次并记住（本 Thread） | 出网、装包、`git push`、插件申请的额外权限 |
| 每次都问 | 破坏性删除、读密钥文件、写工作区外、改 git history |
| 拒绝 | 读推理 key、明显系统路径 |

云 / `exec --yes` 把「问一次」改成策略自动 + 事后审计，避免无人时睡着。

---

## 7. 上下文

组装顺序冻结（单测锁死）。后者更具体。

```text
1. 模型基座 instructions（随模型版本绑定）
2. tool schemas（内置 ∪ 插件，按 lock）
3. 沙箱 / 权限说明
4. 用户全局 developer instructions
5. AGENTS.md（repo root → cwd）
6. skill catalog（仅 name + description）
7. environment_context（agent/user cwd、mode、dirty 提示、plugin_lock 摘要）
8. 从轨迹投影的 history
9. 本轮用户输入 / steer
10. verify nudge（仅缺证据时由运行时插入）
```

Skills 渐进披露：目录常驻，正文仅在调用或 `/skill` 时读入并写轨迹。  
Compact 保留：计划、最近 N 步、最新检查摘要。Compact 事件本身进轨迹。

---

## 8. 内置工具（ACI）

v1 内置这些。多一个必须双榜证明涨分。

| 工具 | 并行 | 要点 |
| --- | --- | --- |
| `read_file` | 只读并行 | 带行号，默认约 200 行 |
| `grep` | 只读并行 | 路径 + 短 snippet，封顶 |
| `glob` | 只读并行 | 限深度和命中数 |
| `str_replace` / `write_file` | 同文件串行 | 失败回邻域；禁止无匹配整文件覆盖 |
| `bash` | 默认串行 | 持久 cwd/env；可杀；空输出有说明 |
| `update_plan` | — | JSON 计划，TUI 可改后再跑 |
| `web_search` / `web_fetch` | 需审批 | 可关 |
| `delegate` | — | 子 Thread，独立轨迹，只回摘要 |
| `ask_user` | — | 本地弹；exec 默认禁用 |

`apply` / `undo` / `fork` / `plugin/*` / `traj/*` 是用户或协议方法，禁止暴露成模型工具。

---

## 9. 插件系统（设计完备）

没有插件，每个内部系统都要 fork 运行时。把 loop 做成插件，轨迹无法 replay。

### 9.1 Kind

| kind | 平面 | 作用 |
| --- | --- | --- |
| `adapter` | Host（进程单例） | 模型供应商 |
| `hook`（全局） | Host | 审计、强制策略 |
| `tool` | Agent（按 Thread isolate） | 模型可调用 |
| `skill` | Agent | 按需说明书 |
| `hook`（会话） | Agent | 本任务拦截 |
| `mcp` | Agent | 子进程 MCP，schema 并入 Router |
| `command` | 表面 | `/ship` 等，不经模型 |

### 9.2 Manifest

```json
{
  "id": "acme.test",
  "version": "1.2.0",
  "kinds": ["tool", "skill", "hook"],
  "permissions": ["workspace-write", "shell:test"],
  "tools": [{ "name": "run_unit", "entry": "./tools/run-unit.js" }],
  "hooks": [{ "event": "preToolUse", "entry": "./hooks/block-prod.js" }],
  "skills": ["./SKILL.md"]
}
```

加载顺序：bundled → `~/.harness/plugins` → `<repo>/.harness/plugins` → CLI override。同名后者覆盖，赢家写入 plugin_lock。

### 9.3 权限与失败

- 未声明权限的动作直接拒绝
- load 失败：TUI 报错 + 轨迹 `plugin/error`；默认不带残缺工具集继续（可配置降级）
- 热加载必须写 `plugin/change` 并视为 cache miss
- v1 安装：`harness plugin add <path|git>`，无商店

Hook 事件（v1 齐全）：`onSessionStart` `preToolUse` `postToolUse` `onStop` `onCompact`。可改写、阻止；改写前后都进轨迹。

---

## 10. 轨迹系统（设计完备）

轨迹是运行时的事实源。UI、评测、undo、插件审计都读它。

### 10.1 包结构

```text
header.json          模型、mode、profile、plugin_lock、工作区、git_head、env_hash
session.jsonl        只追加事件
artifacts/           大输出、测试日志、diff 包
outcome.json         Done Report 或 interrupted/failed
plugins.lock.json    与 header 一致，便于单独校验

导出：*.traj = 上述文件的归档
```

### 10.2 事件 source

`system` `user` `steer` `assistant` `reasoning` `tool` `plugin` `policy` `compact` `checkpoint` `done_report` `mode` `error`

每条含 `ts`、`turn_id`、`step_id`、`id`。Item 是给 UI 的投影，不是另一套存储。

### 10.3 操作（v1 接口齐全）

| 操作 | 语义 |
| --- | --- |
| 实时记录 | 默认永远开 |
| show | 按 source 过滤 |
| export / import | `.traj` |
| replay --dry | 不跑工具，重建当时 prompt；应对齐（除时间戳） |
| replay --live | 要求 **同一 plugin_lock + 同一 git revision**，否则失败 |
| fork --at | 从任意事件新 Thread |
| diff | 工具序列、文件、token、越权、Done Report |

undo 不删除 jsonl，只追加 rewind。审计链不断。

子 Agent 写自己的轨迹，父轨迹只记 `delegate` 的 brief/result 和子 traj id。

---

## 11. 协议（App Server）

所有表面都是 client。本地 stdio JSONL；远端 WebSocket / HTTP+SSE 桥同一方法。

客户端 → 运行时：`initialize` `thread/start|resume|fork|list` `turn/start|interrupt|steer` `approval/respond` `workspace/undo|apply` `plugin/list|enable|disable` `traj/show|export|replay|diff` `shutdown`

运行时 → 客户端：`item/*` `approval/request`（反向 RPC，暂停 loop）`diff/updated` `plan/updated` `done_report` `checkpoint/created` `plugin/event` `turn/completed|interrupted`

字段级 schema 见 [架构说明](./architecture.md)。

---

## 12. 表面

| 表面 | 角色 |
| --- | --- |
| **TUI** | 人的默认入口。流式工具、live diff、计划、审批、输入始终可点、插件列表、轨迹面板 |
| **exec** | CI / 评测。同一协议。结束必须打印轨迹路径，否则分数无效 |
| **SDK** | 进程内或子进程连 App Server，禁止业务 import core |
| IDE / Cloud | v1 协议预留；实现不阻塞运行时完备 |

---

## 13. 模型适配

```ts
interface LLMAdapter {
  id: string
  chat(req: ChatRequest, abort: AbortSignal): AsyncIterable<LLMEvent>
  countTokens(parts: PromptPart[]): number
  contextWindow(): number
}
```

v1 内置 OpenAI compatible（Chat Completions + tools），覆盖 DeepSeek / 自建 / 多数网关。Anthropic Messages、OpenAI Responses 用 adapter 插件补。

v1 单模型。禁止每个 step 换模型（打穿 cache）。Fusion（Lead/Sidekick 双轨迹）接口：父轨迹只记 brief/result；实现放后期。

---

## 14. 配置

```text
~/.harness/config.toml          默认模型、权限口味、插件根
<repo>/AGENTS.md                构建、测试、禁区
<repo>/.harness/plugins/        项目插件
<repo>/.harness/env.toml        可选：docker 镜像、测试命令探测
$HARNESS_HOME/threads/<id>/     轨迹与 worktree 元数据
```

零配置：有 API key 即可 `standard` + local + worktree 开工。配置只做加法。

---

## 15. 安全模型（四层，缺一不可）

1. **工作区隔离**：默认不碰 UserWorkspace
2. **执行边界**：路径策略；docker 评测；local 后续 kernel sandbox
3. **策略 + 审批 + 插件 permissions**
4. **轨迹脱敏**：header 只留密钥名与 env_hash；artifact 扫常见密钥模式

推理 key 永不进入执行运行时或插件子进程，除非 permissions 显式申请并通过审批。

---

## 16. 失败模式

| 失败 | 运行时行为 |
| --- | --- |
| 模型流中断 | 重试当前 step（次数有限）；轨迹记 attempt；UI rewind 半截 delta |
| 工具超时 | kill + 超时结果进轨迹，不卡死 Turn |
| 插件 load 失败 | 见 §9.3 |
| worktree 创建失败 | 拒绝开工，不要 silently in-place |
| apply 冲突 | 停，列出冲突文件 |
| live replay 锁不一致 | 硬失败 |
| 轨迹无法重建 prompt | 内部断言失败，当 bug 报 |

---

## 17. 评测

两张榜，**都产出 `.traj`**。无轨迹分数不入库。

| 榜 | 测什么 | 怎么跑 |
| --- | --- | --- |
| 模型榜 | 模型 | `minimal`，固定 fixture |
| 运行时榜 | 我们 | `standard` + worktree + 插件锁 + Done Report + U 指标 |

运行时榜必报：resolve、步数、token、cache hit、墙钟、越权=0、假完成=0、审批次数、无关文件数、steer 成功率、undo 正确性、dry replay 对齐、插件错误仍继续的次数=0。

对照只能在 **同一 plugin_lock** 下换模型或换某一开关（worktree / Done Report / 项目插件）。

好用验收 U1–U12 作为运行时榜的固定用例，不是单独的主观感受。

---

## 18. 工程落地

### 18.1 技术选型

| 项 | 选择 |
| --- | --- |
| 语言 | TypeScript（运行时、TUI、协议）；评测脚本可用 Python |
| 包 | pnpm workspace |
| LLM 默认 | OpenAI compatible tools |
| 轨迹 | JSONL + `.traj` 归档 |
| 本地隔离 | git worktree；评测 Docker |
| 协议 | JSON-RPC JSONL |
| 插件 | 目录 + manifest，进程内加载 JS；MCP 子进程 |

### 18.2 仓库

见 [架构说明 §目录](./architecture.md)。核心包：`core` `protocol` `plugins` `workspace` `runtime-local` `runtime-docker` `adapters` `tui` `cli` `sdk`。

### 18.3 实现顺序（设计已完备，代码按此切）

| 切片 | 交出什么 | 才算这期完成 |
| --- | --- | --- |
| **P0 契约** | schema、假 loop、脏树 fixture、轨迹/插件 fixture | 假进程能 worktree + 写出可 show 的 jsonl |
| **P1 第一个运行时** | 真 loop + local 执行 + TUI 雏形 + 内置读写跑 + 边写轨迹 | 修通失败测试；脏树仍在；`traj show` |
| **P2 能日常用** | 完整 ACI、模式、steer/undo/apply、审批记忆、Done Report、skill/tool/hook 插件、dry replay | dogfood；U1–U12 可跑 |
| **P3 能被接走** | App Server、SDK、MCP kind、traj diff、live replay、fork --at | 评测只吃 `.traj`；业务不 import core |
| **P4 更硬** | Docker 执行运行时、kernel sandbox、delegate 子轨迹、`plugin add` | 评测隔离；子 Agent 不污染父轨迹 |
| **P5 人离开仍能跑** | vm provider、断线续跑、同一 traj id 重连 | 关客户端任务仍在 |
| **P6 更便宜** | Fusion、Knowledge、browser 子 Agent、可选登记处 | price per task，不破坏前序不变量 |

P1 结束，我们才「有运行时」。P2 结束，才「有好用的运行时」。

---

## 19. 风险

| 风险 | 缓解 |
| --- | --- |
| 做成聊天框 | P1 就必须真实改 worktree + 写轨迹 |
| 审批疲劳 | 分级 + 记忆；审批次数进榜 |
| 弄脏用户树 | 默认 worktree；失败则拒绝开工 |
| 假完成 | 无 checks 不得成功结束 |
| 插件把内核咬碎 | kind 白名单；loop 不开放 |
| 轨迹不完整 | 运行时断言：模型可见 ⊆ 可重建 |
| 过早上云 / 商店 | P5/P6 之前禁止把人力拆走 |

开工前建议拍板：默认模型端点、第一条内部插件（建议仓库单测）、黄金任务来源、代码是否不出域、是否禁止 in-place 做默认（建议禁止）。

---

## 20. 附录：对标（设计从这里收，不从这里摊）

| 来源 | 收进本设计的 |
| --- | --- |
| Codex / ChatGPT | Thread/Turn/Item；App Server；前缀缓存；Agents = 托管运行时 + 可选执行环境 |
| DeepSeek Harness | Minimal/Standard 分层；Host vs Agent plane；模型可见≡落盘；按 source 看轨迹。不收「loop 也是插件」 |
| Devin | 结构化计划；隔离才敢动手（我们用 worktree）；Fusion 后期双轨迹 |
| Claude Code | steer、分级权限、Skills 渐进、Hooks、Subagent 隔噪音 |
| Cursor Cloud | 环境即正确性；loop / 机器 / 会话分离；模型变强后 harness 做减法 |
| SWE-agent / OpenHands | 短搜索、窗口读、编辑失败回邻域、空输出说明 |

完整能力对照不再展开：我们的完备性以本文 §4–§17 的接口是否齐全为准，不以「别人有的功能我们列表里有」为准。
