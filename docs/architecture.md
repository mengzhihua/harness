# 架构草图

本文是 [技术方案](./tech-proposal.md) 的实现级附录。组合内核对齐 Cordis。Spring 只是学习对照，见 [笔记](./di-and-composition.md)。已确认决策见 [decisions.md](./decisions.md)。

## 1. 分层

```mermaid
flowchart TB
  subgraph surfaces [表面]
    TUI[TUI]
    EXEC[exec]
    SDK[SDK]
  end
  subgraph kernel [组合内核 对齐 Cordis]
    CTX[Context 树]
    LOADER[Loader]
    HOST[Host plane]
    ISO[Agent isolate]
  end
  subgraph hostsvc [Host 服务]
    LLM[ctx.llm]
    LOOP["ctx.agents\n@harness/agent-loop"]
    TRAJ[ctx.traj]
    POL[ctx.policy]
    WS[ctx.workspace]
  end
  subgraph agentsvc [Isolate 服务]
    TOOLS[ctx.tools]
    SHELL[ctx.shell]
    MCP[MCP]
  end
  subgraph execrt [执行 Provider]
    FS[ctx.fs]
    SUB[ctx.subprocess]
  end
  TUI --> CTX
  EXEC --> CTX
  SDK --> CTX
  CTX --> LOADER
  LOADER --> HOST
  LOADER --> ISO
  HOST --> LLM
  HOST --> LOOP
  HOST --> TRAJ
  HOST --> POL
  HOST --> WS
  ISO --> TOOLS
  ISO --> SHELL
  ISO --> MCP
  SHELL --> FS
  SHELL --> SUB
  TOOLS --> FS
```

硬边界：协议 / Context；User≠Agent 工作区；**fs+subprocess 一起换**；轨迹是事实源；官方 loop 契约冻结且进 lock。

## 1.1 组合内核（对齐 Cordis）

| Cordis | 我们 |
| --- | --- |
| Context | 同；isolate 用子树，卸子不影响 Host |
| provide / inject | 同；缺依赖不开工 |
| ctx.effect | 同；必须可逆 |
| Loader + yml | `profiles/*.yml` |
| isolate | 每 Thread 一份 shell/MCP/tool |
| agent-loop 插件 | `@harness/agent-loop`，进 lock |
| waterfall | 审批、hook、轨迹挂在 `tools/*` `agent/*` |

启动：

```text
host = new Context()
Loader.mount(host, 'profiles/standard.yml')
await Loader.await(host)

threadCtx = isolate(host, threadId)
Loader.mount(threadCtx, projectPlugins)
# thread 结束：只卸 threadCtx
```

官方服务名：`llm` `tools` `shell` `fs` `subprocess` `sessions` `traj` `agents` `policy` `workspace` `systemPrompt`。

## 2. 核心对象

```text
UserWorkspace    用户当前目录（可能脏）
AgentWorkspace   本线程独占的 git worktree 或副本
Thread           持久会话（mode: ask|plan|agent）
Turn             一次用户输入触发的工作（可被 steer 插入）
Step             一次模型请求 + 并行/串行工具
Item             user / assistant / tool / approval / diff / checkpoint / done_report / plugin
Checkpoint       Turn 结束时 AgentWorkspace + 轨迹投影的快照
DoneReport       改了什么、跑了什么、能不能 apply
Plugin           isolate 组或 Host bundle（manifest + 可逆 effect）
Composition      profile YAML：有序 bundle + patch
AgentLoop        `@harness/agent-loop`，实现 ctx.agents
Trajectory       一次 run 的事实源：header（含 plugin_lock）+ events + artifacts + outcome
```

Item 生命周期：

```text
started → delta* → completed
          ↘ failed / interrupted
```

客户端只渲染 Item。Steer 不是新协议物种，它是 `turn/interrupt` + 一条新的 user item。

## 3. Agent Loop（含转向与收工）

```text
turn/start
  claim inbox
  assemble prompt                # 前缀稳定
  loop step:
    if cancelled: interrupt
    llm/stream (abortable)
    只读工具并行 → 写工具按文件串行
    policy → plugin hooks → approval memory → execute on AgentWorkspace → truncate to disk
    每步结果 append 到 Trajectory（source=tool|plugin|policy）
    if inbox has steer: next step 吃新约束
    if context pressure: compact
  if agent 且有改动且无 checks: 注入 verify nudge，再开 step
  emit done_report
  checkpoint
turn/end
```

实现约束：

1. 旧 prompt 是新 prompt 的精确前缀，直到 compaction。
2. 模型看见的每一段都能从 Trajectory 重建。运行时可以断言这一点。
3. 大输出落盘为 artifact，轨迹里留指针；prompt 只留退出码 + 尾部 + 路径。
4. **Steer 在 step 边界生效，取消推理立即生效。** 不要等整个 Turn。
5. Loop 只读写 AgentWorkspace。`/apply` 是 Workspace 层操作，不是模型工具。
6. Compaction 保留：计划、最近 N 步、最新 Done Report / 检查摘要。丢掉这些，undo 和收工都会瞎。
7. 第三方只许挂 `agent/*` 与 `tools/*` waterfall，不许换 `@harness/agent-loop` 契约。
8. 启动时冻结整棵激活树为 plugin_lock（含 loop 版本）。热加载写 `plugin/change`，否则 replay 无效。
9. Loader 未完全激活不得进入 Turn。

## 4. 工具面

v1 模型可见工具。`apply` / `undo` / `fork` 是 **用户命令**，不要做成模型可随便调用的 tool（模型一慌就会 apply）。

| 工具 | 并行 | 要点 |
| --- | --- | --- |
| `read_file` | 只读并行 | 带行号，默认 ~200 行 |
| `grep` | 只读并行 | file:line + 短 snippet，封顶 |
| `glob` | 只读并行 | 限制深度和命中 |
| `str_replace` / `write_file` | 同文件串行 | 失败回邻域；禁止无匹配整文件覆盖 |
| `bash` | 默认串行 | 持久 cwd/env；可杀；空输出有说明 |
| `update_plan` | — | JSON；TUI 可编辑后再跑 |
| `web_search` / `web_fetch` | 需审批 | 可关 |
| `delegate` | P4 | 独立 thread，只回摘要 |
| `ask_user` | — | 本地弹；云端慎用 |

后期：browser、`run_code`（减少 round-trip）。MCP 不以「额外白名单配置」存在，而以 `mcp` 插件 kind 接入，权限和轨迹与内置工具相同。

插件提供的 tool 走同一 Router：schema 进 prompt 的 tool schemas 段，调用进轨迹 `source=tool`，hook 改写进 `source=plugin`。同名冲突按加载顺序覆盖，并在 header.plugin_lock 记录赢家。

## 5. 协议

JSON-RPC 2.0。本地 stdio JSONL；云端 WebSocket / HTTP+SSE 桥同一方法。

### 5.1 客户端 → 服务端

| 方法 | 含义 |
| --- | --- |
| `initialize` | cwd、模型、mode、是否 in-place（默认否） |
| `thread/start` | 创建会话，分配 AgentWorkspace |
| `thread/resume` | 恢复 |
| `thread/fork` | 在 checkpoint 分叉 |
| `turn/start` | 用户输入（含 @path 附件）；`detach` 时立即返回，worker 继续跑 |
| `turn/status` | 查同一 traj 是否还在 worker 上跑 |
| `turn/interrupt` | 立即取消推理，并请求杀命令 |
| `turn/steer` | 不打断当前 tool，插入 inbox |
| `thread/subscribe` | 流 rewind：从 `since` seq 重放完整 item，不是半截 token |
| `worker/info` | 当前机器 / worker id（会话 ≠ 机器） |
| `workspace/pr` | `gh pr create`（用户命令） |
| `workspace/ci` | 把 CI 日志挂到轨迹 artifact |
| `approval/respond` | allow / deny / allow_session |
| `workspace/undo` | 回上一个 checkpoint |
| `workspace/apply` | 合回 UserWorkspace |
| `plugin/list` | 当前线程 plugin_lock |
| `plugin/enable` `plugin/disable` | 改锁并写 `plugin/change`（会断 cache） |
| `traj/show` | 按 source / 时间过滤事件 |
| `traj/export` | 打 `.traj` 包 |
| `traj/replay` | `dry` 或 `live` |
| `traj/diff` | 两条轨迹对比 |
| `thread/items/list` | 断线重连（items 是轨迹的 UI 投影） |

### 5.2 服务端 → 客户端

| 通知 | 含义 |
| --- | --- |
| `item/started` `item/delta` `item/completed` | 流式原子 |
| `approval/request` | 反向 RPC，暂停 loop |
| `diff/updated` | AgentWorkspace 相对基线的 diff |
| `plan/updated` | 结构化计划 |
| `done_report` | 收工证据 |
| `checkpoint/created` | 可供 undo 的点 |
| `plugin/event` | load / error / hook_block / change |
| `turn/completed` / `turn/interrupted` | 结束 |
| `item/rewind` `item/rewind_end` | 重连时整条事件流回放 |

## 6. Workspace Provider

```ts
interface WorkspaceProvider {
  userRoot: string
  agentRoot: string
  beginThread(threadId: string): Promise<void>     // git worktree 或 copy
  checkpoint(label: string): Promise<CheckpointId>
  restore(id: CheckpointId): Promise<void>         // undo
  applyToUser(): Promise<ApplyResult>              // merge / 冲突则停
  listDiff(): Promise<DiffStat>
}

interface ExecutionProvider {
  readFile(path: string, range?: LineRange): Promise<FileSlice>
  writeFile(path: string, content: string): Promise<void>
  exec(req: ExecRequest): Promise<ExecResult>
  kill(execId: string): Promise<void>
}
```

路径策略：工具参数里的路径相对 AgentWorkspace。试图用 `../` 逃到 UserWorkspace 或家目录 → policy deny。

Docker 执行面：bind-mount AgentWorkspace 到容器 `/workspace`。**LocalFs 留在宿主机路径，只换 subprocess**（`--network none` 默认）。本地 sandbox 默认断网：`HTTP(S)_PROXY=127.0.0.1:1`，有权限时再套 `unshare -n`。推理 API key 不进 agent 子进程环境。Remote worker 发 `worker/exec` JSON-RPC；会话在客户端，机器在 `WorkerHub` / `harness serve`。

权限档位：

| 档位 | 写 | 网 | 谁用 |
| --- | --- | --- | --- |
| `read-only` | 否 | 否 | Ask / Plan |
| `workspace-write` | 仅 AgentWorkspace | 默认关 | **Agent 默认** |
| `full-access` | 是 | 是 | 显式 `/yolo` 或 CI 配置 |

## 7. Context 组装顺序

顺序冻结。后出现的更具体。

```text
1. model base instructions          # 含：验证契约、小 diff、不要动无关文件
2. tool schemas
3. sandbox / permission instructions
4. developer instructions
5. project docs                     # AGENTS.md root → cwd
6. skill catalog                    # 内置 + 插件 skill 的 name + description
7. environment_context              # agent cwd, user cwd, git dirty 提示, mode, plugin_lock 摘要
8. session history                  # 从轨迹投影，禁止旁路注入
9. user turn input / steer
10. verify nudge                    # 仅当收工缺证据，确定性插入
```

`environment_context` 必须告诉模型：你在 worktree 里，用户原目录可能有未提交改动，**不要去碰**。

## 8. 仓库目录

按手感迭代边界拆，不要按插件拆：

```text
harness/
  packages/
    compose/           # Context, Service, inject, effect, Loader（Cordis 语义）
    agent-loop/        # 官方 ctx.agents 驱动
    traj/
    tools/             # ACI Consumer；依赖 ctx.shell / ctx.fs Definition
    protocol/
    workspace/
    runtime-local/     # fs + subprocess Provider
    runtime-docker/
    adapters/
    tui/
    cli/
    sdk/
  profiles/
    standard.yml
    minimal.yml
    eval.yml
  bundled-plugins/
  eval/
  docs/
```

语言：Core / TUI / Protocol 用 TypeScript；Eval 可用 Python；Sandbox executor 需要时再 Rust。

## 9. 轨迹存储

活线程与导出包是同一套事实，只是打包边界不同。

```text
$HARNESS_HOME/threads/<thread_id>/
  header.json              # mode, model, userRoot, agentRoot, plugin_lock
  session.jsonl            # 轨迹事件
  checkpoints/
  artifacts/
  plugins.lock.json        # id@version + 内容哈希，与 header 一致

导出：
  something.traj           # tar/zip：header + jsonl + artifacts + plugins.lock
```

规则：

- 只追加 jsonl；rewind 追加 `source=checkpoint` 的 rewind 事件，不改写历史
- checkpoint 记录：jsonl 偏移 + worktree 快照 id
- undo = restore 快照 + 投影 rewind
- fork / `traj fork --at` = 新 thread + 前缀拷贝 + 新 worktree + 新轨迹 id（header 记 parent）
- dry replay 只读 jsonl 重建 prompt，禁止执行 provider
- live replay 必须校验 plugin_lock 与 git revision，对不上则失败
- 插件 load/error/hook 全部落 `source=plugin`

## 10. 组合加载

```ts
interface Context {
  isolate(threadId: string): Context
  provide<T>(name: string, value: T): void
  inject: string[]
  plugin(entry: PluginEntry, config?: unknown): Promise<void>
  effect(register: () => () => void): void
  waterfall<T>(event: string, payload: T): Promise<T>
  close(): Promise<void>
}

interface Loader {
  mount(ctx: Context, profilePath: string, patches?: string[]): Promise<void>
  await(ctx: Context): Promise<void>
  lock(ctx: Context): PluginLock
}
```

业务插件目录用 `plugin.json`，Loader 编进该 Thread 的 isolate。  
`preToolUse` 挂在 `tools/pre-execute`。缺 inject 或组合失败 → 拒绝开工。

## 11. 评测入口

```bash
# 模型榜
harness exec --profile minimal --model <id> --task-file eval/tasks/fix-failing-tests.md

# harness 榜（含脏工作区）
harness exec --profile standard --dirty-user-tree --model <id> --task-file eval/tasks/fix-failing-tests.md

# 手感 + 插件 + 轨迹
harness exec --eval-usability eval/usability/
harness traj replay --dry eval/trajectories/fix-login.traj
harness traj diff run-a.traj run-b.traj
```

任何「我们更好用」必须同时报：模型榜、harness 榜、U 指标，并附轨迹。缺轨迹的发布说明视为不合格。
