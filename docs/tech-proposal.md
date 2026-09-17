# 自研 Coding Agent Harness 技术方案

**状态**：草案 v0.2。相对 v0.1：产品北极星从「把运行时做完整」改成「把日常手感做对」。
**对标对象**：DeepSeek Harness、OpenAI Codex / ChatGPT Agents、Devin、Claude Code、Cursor Cloud Agents、OpenHands / SWE-agent。
**结论先行**：做一个 **模型无关、开箱能改代码、随时可转向** 的软件工程 Agent。架构为手感服务，不为对标清单服务。

---

## 0. 什么叫好用

各家 2026 年都能读文件、跑命令、开 PR。开发者真正留下的产品，赢在 **第一次改对、中途能管住、收工可审、明天还想再用**。

好用不是 UI 圆角，是下面这条日常路径毫无摩擦：

```text
cd 我的仓库
harness
> 把失败的登录测试修了，不要动别的模块

# 期望：
# 1. 几秒内开始搜代码，而不是先问我「请提供更多上下文」
# 2. 改动落在独立 worktree，我编辑器里未提交的东西还在
# 3. 我看到它在跑哪条测试、改了哪些文件
# 4. 我说「别改那个文件，用已有 helper」——它立刻停，按新约束继续
# 5. 结束时给出小 diff + 测试输出，而不是一篇作文
# 6. 不对就 /undo，对就 /apply 合回当前分支
```

做不到这条路径，后面的 Fusion、插件、Cloud VM 都是库存。

### 0.1 一句话定义

> Harness = 让模型在真实仓库里 **安全地动手、被人管得住、自己能验收** 的那一层。  
> 模型负责判断；harness 负责手感、边界、记忆和证据。

### 0.2 好用验收（比架构清单优先）

v1 是否合格，用这张表，不用「模块是否齐全」：

| # | 验收 | 反例（看起来像产品，其实不好用） |
| --- | --- | --- |
| U1 | 有 API key 即可在仓库根目录开工，零配置能改代码 | 先写 YAML、先配 MCP、先选 12 个插件 |
| U2 | Agent 默认进 git worktree，不覆盖用户脏工作区 | 直接改当前 tree，把我的半成品冲掉 |
| U3 | Esc / 再输入能在 **当前 step** 打断并转向 | 只能等它把整轮幻觉跑完，或只能 Ctrl-C 死掉会话 |
| U4 | `/undo` 回到本线程上一个检查点，文件与对话一致 | 只能 `git checkout`，对话还以为文件改过 |
| U5 | 工作区内普通写入默认过；出网、密钥、破坏性命令、工作区外才问；同类本会话记住 | 每写一行问一次，或干脆全部 YOLO |
| U6 | 代码有改动则结束前必须留下检查证据（测试/lint/复现命令的真实输出） | 「应该没问题了」然后测试是红的 |
| U7 | live diff 可审：只动相关文件，不做全文件格式化 | 200 文件 whitespace PR |
| U8 | 首步工具调用要快；只读工具可并行；大日志落盘不进 prompt | 先读整个仓库再思考；CI log 把上下文撑爆 |
| U9 | 会话可 resume；昨天的线程今天能接着改 | 关终端就失忆 |
| U10 | 卡住时说人话：缺依赖、缺权限、测不起来，并给出下一步 | 假装完成，或死循环重试同一条命令 |

评测集仍然要，但它回答「聪明不聪明」。这张表回答「烦不烦、敢不敢用」。

### 0.3 成功标准（产品，不是框架）

三个月内 dogfood 成立的标志：

1. 团队内部至少一条真实业务线，**周活**用它修 bug / 写小功能，而不是只跑 demo。
2. 同一模型，走我们的 harness 比「聊天 + 自己粘贴」在黄金任务上：**更少步数、更少越权、更高验收通过**。
3. 新同学对着 README 十分钟内完成一次「修失败测试 → 看 diff → undo → apply」。

---

## 1. 日常产品规格

架构可以后补，下面这些如果 P2 还没有，这个 harness 就不好用。

### 1.1 三种模式，默认 Agent

| 模式 | 能做什么 | 什么时候用 |
| --- | --- | --- |
| **Ask** | 只读。解释、搜、给建议，不改文件 | 「这代码在干什么」 |
| **Plan** | 只读 + 产出可勾选计划，用户确认后再动手 | 跨模块、不确定、有风险 |
| **Agent** | 在 worktree 里改、跑、验证；危险动作才审批 | **默认**。日常修测试、小功能 |

切换必须是一个按键或一行命令（`/ask` `/plan` `/agent`），不要重启会话。云端 / CI 默认 Agent，且更少提问（提问的代价是小时级）。

Plan 不是聊天里的 Markdown。它是结构化对象：步骤、成功标准、依赖。用户可以删掉某步再开跑。这是 Devin 和所有好用 Plan Mode 的共同点。

### 1.2 工作区：先隔离，再合回

这是「敢用」的前提，比沙箱论文更影响手感。

```text
用户工作区（可能有未提交改动）     Agent worktree（本线程独占）
        │                                    │
        │  /apply 或开 PR                     │ checkpoint（每轮可回退）
        └───────────── merge / rebase ────────┘
```

规则：

- Agent 模式默认 `git worktree`（仓库不是 git 时退化为副本目录，并明确告诉用户）。
- 用户本地的 staged/unstaged 一概不动。
- 每轮 Turn 结束做一次 **checkpoint**（worktree 内 commit 或 stash 快照），`/undo` 回滚文件 + 裁剪会话到该点。
- `/apply` 把 Agent 分支合回用户当前分支；冲突时停下来给人，不要自动乱解。
- 用户说「就在当前目录改」才进入 in-place；TUI 用颜色警告。

Cursor 本地 agent 靠 worktree 才能并行；Devin 靠一次性 VM 才敢放手。我们本地没有 VM 时，worktree 就是那层勇气。

### 1.3 转向：inbox，不是重启

好用的核心交互是 **Steer**，不是「再开一个会话」。

| 用户动作 | harness 行为 |
| --- | --- |
| Esc / `/stop` | 立刻取消 in-flight 推理；正在跑的命令发 SIGINT/超时杀；本轮以 interrupted 收尾 |
| 打一行新话（不按 Esc） | 进入 inbox，当前 tool 跑完后 **立刻** 作为下一步输入，不必等模型把计划写完 |
| `/undo` | 恢复上一个 checkpoint，丢弃其后的文件与模型历史 |
| `/fork` | 从当前点开平行线程，原线程不动 |
| `/resume` | 列出最近线程，接着干 |
| `@path` / 粘贴 diff / 粘贴报错 | 当作用户附件，原样进 log，不要再让模型「请把文件发给我」 |

Follow-up 必须是一等公民。Cloud 场景还要支持：人已经离开，任务继续；人回来看到的是可 rewind 的事件流，不是错乱的半截字。

### 1.4 审批：少问、问得值、问一次

审批是好用与安全的交点。问多了没人用，不问就不敢用。

| 默认 | 例子 |
| --- | --- |
| **自动允许** | 工作区内读；工作区内普通编辑；跑 `*test*` / linter / 构建（可配置白名单） |
| **问一次并记住（本线程）** | 出网、装包、`git push`、改 CI 配置 |
| **每次都问** | `rm -rf`、读 `.env` / 密钥文件、写工作区外、改 git history（rebase -i, force push） |
| **直接拒绝** | 读推理 API key、扫 `/etc/shadow` 一类路径 |

TUI 审批要看得懂：命令原文、工作目录、为什么被拦、本次 / 本线程 / 永久。不要弹一串 JSON。

云端把「问一次」改成「按策略自动」或「事后审计」，避免任务在无人时睡着。

### 1.5 收工契约：没有证据就不算做完

Agent 模式在 `turn/end` 前必须产出一个结构化 **Done Report**（给 UI 和评测，不只给模型自己看）：

```text
changed_files: [...]
checks: [{cmd, exit_code, summary_path}]
residual_risks: [...]
apply_ready: true|false
```

约束：

- 有文件改动且 `checks` 为空 → TUI 标黄，提供一键「按 AGENTS.md 里的测试命令跑」。
- harness **不硬编码** `mvn test` / `npm test`。测试命令来自 `AGENTS.md`、项目探测（lockfile）或用户本句指定。
- 模型说「已修复」但检查失败 → 不准结束，继续修，直到通过、或模型明确声明阻塞原因。
- 大输出只进 `summary_path`，prompt 里留尾部 + 退出码。

这是「好用」对质量的定义：人审 diff 之前，机器已经替人跑过一遍。Cursor 后来把「强制 commit」从 harness 拿掉是对的；但 **强制留下证据** 应该留下。

### 1.6 给模型的手，也是给人看的手

工具少，反馈短，失败可恢复——这既是 ACI，也是 UX。

| 工具 | 人在 TUI 里应看到 | 模型应看到 |
| --- | --- | --- |
| `read_file` | 文件路径 + 行范围 | 带行号的窗口，默认约 200 行 |
| `grep` / `glob` | 命中计数 | 路径 + 短 snippet，封顶 |
| `str_replace` | live diff hunk | 成功 / 失败邻域；禁止静默整文件重写 |
| `bash` | 命令、cwd、流式 stdout、退出码 | 截断后的输出；空输出要有一句成功说明 |
| `update_plan` | 可勾选步骤列表 | 当前 JSON 计划 |
| `ask_user` | 问题 + 选项 | 用户原话 |

并行：只读工具（read/grep/glob）同 step 并行。同一文件的写串行。这能明显缩短「它在干什么」的空白时间。

编辑失败（上下文没匹配）必须返回邻域，让模型再读，而不是再瞎 generate 一整个文件。这是 SWE-agent 验证过、Claude/Codex 日常手感的底。

### 1.7 项目记忆：薄、准、可版本管理

| 来源 | 作用 | 注意 |
| --- | --- | --- |
| `AGENTS.md`（root → cwd 分层） | 怎么构建、测什么、别碰什么 | 开放格式，兼容 Codex/Cursor |
| `SKILL.md` | 某类任务的步骤（发版、加 API） | 启动只加载目录，正文按需 |
| 用户全局 config | 语言、默认模型、权限口味 | 不要塞进每个项目 |
| 线程内 plan + log | 工作记忆 | 不另做向量库当主记忆 |
| 可选 `knowledge/*.md`（v1.5） | 跨会话约定 | 必须是人策展的，禁止自动倾倒上次轨迹 |

Harness 可以 **建议** 更新 `AGENTS.md`（「我发现测试命令是 `pnpm test`」），默认不擅自改。擅自写记忆是最常见的「智能但不好用」。

### 1.8 TUI 最小可用表面

不做 IDE，但日常入口必须是 TUI，而不是「先学会 JSON-RPC」。P2 结束时应有：

- 流式推理摘要 + 当前工具（命令/路径）
- 右侧或底部 live diff
- 计划列表
- 审批卡片
- 输入框始终可点（队列 follow-up）
- 状态：模式、模型、worktree 路径、token / cache hit、是否已验证

`harness exec` 是同一协议的无头客户端，给 CI 和评测，不是给人的主入口。v0.1 把 exec 当第一客户端，对评测正确，对好用是错的。

---

## 2. 对标：别人的好用从哪来

只摘 **手感相关** 的设计，完整能力矩阵见 §2.7。

### 2.1 Codex / ChatGPT：快、稳、一份协议

- Thread / Turn / Item 让所有表面同一套事件，所以 CLI 和 ChatGPT 手感同源。
- 新 prompt 是旧 prompt 的前缀 → 缓存命中 → **体感快**。慢的 harness 一定不好用。
- App Server 把审批做成反向 RPC：模型不能自说自话「已批准」。
- Agents API 证明 ChatGPT 编码好用的核心是托管 loop + 可选环境，不是气泡样式。

对我们：协议先行是为了以后不把 TUI 写死；P2 的人先要摸到 TUI。

### 2.2 DeepSeek Harness：评测诚实，产品要分层

Minimal（bash + 编辑器）是评模型的手术刀，不是日常 UX。Standard / Code Mode 才是产品。Code Mode 用一段程序合并多步工具，减少「一问一答」的呆滞感。

对我们：仓库里永远留 Minimal **profile**；默认用户走 Standard。不要把评测皮肤做成第一印象。

### 2.3 Devin：隔离让人放心，计划让人敢开大任务

VM + 浏览器 + 结构化计划 + Knowledge。Fusion 用 Lead/Sidekick 降 **price per task**，两边不共享整本 transcript，所以又快又便宜。

对我们：本地用 worktree 代替 VM 给人信心；计划对象化进 v1；Fusion 进后期。没有隔离就学 Devin 的「全自主」，用户第一次被覆盖脏工作区就会卸载。

### 2.4 Claude Code：转向、权限、Skills 是手感本体

公开结论是 loop 极简，外围才是产品：Esc 打断、权限模式、渐进 Skills、Hooks、Subagent 把噪音隔开。

对我们：Steer / 审批记忆 / Skills 渐进披露是 P2 的主菜，不是 P6 装饰。

### 2.5 Cursor：环境对了才聪明；后来学会让开

云上质量差，经常是环境不像开发机。worktree、检查点、人工 diff 审阅是本地敢用的原因。另一条：模型变强后，把「强制 commit、自己拉 CI 日志」从 harness 拿走，改成给工具。

对我们：环境探测 + `AGENTS.md` 比再写一套工作流引擎重要。Computer use 仍值得当子 Agent 脚手架，因为模型还干不好。

### 2.6 OpenHands / SWE-agent：工具反馈形状决定智商

短搜索、窗口化阅读、编辑失败回显、空输出说明、旧 observation 折叠。没有这些，再大的模型也会在 `cat` 里淹死。

对我们：ACI 细节写进工具实现规范，而不是「先接 20 个 MCP 再调手感」。

### 2.7 能力矩阵（目标改为「好用 v1」）

| 维度 | 别人 | **我们 v1（好用优先）** |
| --- | --- | --- |
| 默认入口 | CLI / IDE / VM | TUI + worktree；exec 同期但不是主入口 |
| 转向 | Claude Esc、Cursor follow-up | step 级 inbox + 立即取消推理 |
| 隔离 | Devin VM、Cursor worktree | 默认 git worktree + checkpoint / undo |
| 证据 | 各家强弱不一 | Done Report 强制；无检查不能静默成功 |
| 工具 | 从两件套到全家桶 | 精简 ACI；只读并行；MCP 白名单 |
| 协议 | Codex App Server、dsh sdk | JSON-RPC，TUI/`exec` 都是 client |
| 评测 | Minimal / SWE-bench | 黄金任务 + **好用验收 U1–U10** 同时报 |
| 多模型 | Fusion / 路由 | v1 单模型；v2 再 Fusion，禁止热路径切模型 |

---

## 3. 设计原则（按对用户的影响排序）

1. **默认路径必须是安全且能干活的。** 零配置 = Agent + worktree + 工作区可写 + 危险才问。
2. **隔离先于聪明。** 弄脏用户 tree 是不可恢复的信任事故。
3. **转向是一等功能。** 不能转向的 Agent 只适合丢到云上自生自灭。
4. **证据先于叙事。** 没有命令输出的「已完成」对 harness 是 bug。
5. **少问、问清楚、记住。** 审批 UX 决定会不会被关权限或者被关软件。
6. **工具少、反馈短、失败可恢复。** 新工具必须同时改善 U 指标和 resolve rate。
7. **前缀稳定 = 体感快。** 为文采打乱组装顺序，等于把好用卖了。
8. **Loop 保持笨。** 手感做在 worktree、inbox、checkpoint、Done Report、ACI，不做在工作流引擎。
9. **模型可见 ≡ 可回放。** 否则 undo/resume/评测都会撒谎。
10. **随着模型变强做减法。** 能变成工具的不要写死；模型还做不好的（隔离、证据、打断）不要交给模型。
11. **评测进主仓，但分两张榜。** Minimal 测模型；Standard + U1–U10 测 harness。

---

## 4. 目标架构（为手感服务）

实现细节见 [架构草图](./architecture.md)。这里只冻结和「好用」有关的决策。

### 4.1 六层，外加一条工作区轴

```text
TUI / exec / 未来 IDE
        │  JSON-RPC（含 steer / undo / apply / approval）
   Thread + Agent Loop + Inbox
        │
   Context（前缀稳定）  Tools + Policy  Checkpoint
        │
   Workspace Provider：user tree  ←apply→  agent worktree
        │
   Local / Docker / VM
```

v0.1 的三条边界仍然成立（协议、执行面、会话）。v0.2 多一条：**用户工作区 ≠ Agent 工作区**。Loop 永远对着 Agent workspace 说话。

### 4.2 模型

v1 单模型、配置指定。Adapter 走 Chat Completions tools，便于 DeepSeek / 自建 / OpenAI。不要每个 step 换模型（打穿 cache，任务更贵、手感更顿）。Fusion 留 v2：Lead / Sidekick **两段 session**，只传 brief/result。

### 4.3 安全：三层 + 工作区隔离

1. Worktree / 副本（用户资产）
2. OS / 容器边界（系统资产）
3. Policy + 审批 + hooks（意图资产）

推理 API key 不准进 sandbox。Agent 若需要 GitHub，给最小权限 token。

---

## 5. 分期：每一期都要能用，不是更能画

每一期的完成标准都是 **人能用的切片**，附带评测，而不是「模块合并完成」。

### P0 — 写死手感契约

- 冻结事件：Thread / Turn / Item，外加 `checkpoint` / `done_report` / `steer`
- 写好用验收脚本（U1–U10）和 20 个黄金任务
- 指定默认测试命令如何从仓库发现
- 三个 fixture（含「用户 tree 有脏文件」这一条）

**完成**：用假 loop 也能演示 worktree + undo 的文件行为。

### P1 — 第一次修对测试

- loop + jsonl + 一个 OpenAI compatible adapter
- `bash` + `str_replace` + `read_file`（没有 read，日常已经不好用）
- **默认 worktree** + 路径约束
- `harness` TUI 雏形：流式命令、diff、输入框
- `harness exec` 同期，给评测

**完成**：在 fixture 上「修失败测试」从 TUI 走通；用户原目录脏文件仍在。Minimal profile 可关 TUI、只留两件套跑基线。

### P2 — 日常好用（dogfood 门）

- grep / glob / update_plan；只读并行
- Ask / Plan / Agent 切换
- Esc 打断、inbox 转向、checkpoint、`/undo` `/apply` `/resume`
- 审批记忆（§1.4）
- `AGENTS.md` 组装、observation 截断、Done Report
- 基础 compaction（保留计划、最近 N 步、检查证据）

**完成**：团队能在真实小仓库 dogfood；U1–U10 有自动化或人工清单；Standard 黄金集优于 Minimal。

### P3 — 同一手感出现在第二扇门

- App Server；TUI 与 exec 均改 client
- fork；MCP 白名单
- 会话列表、标题、搜索

**完成**：用 SDK 写脚本不 import core；IDE 试点只接协议，不重写 loop。

### P4 — 更稳、更会、更少吵

- Docker provider（评测与脏任务）
- 本地 kernel sandbox
- Skills 渐进披露、Hooks
- `delegate` 探索型子 Agent（独立 context，避免 grep 污染主线程）
- 建议更新 `AGENTS.md`（仍默认不自动写）

**完成**：hooks 能拦住一条禁令；大仓探索不明显拖慢主对话。

### P5 — 人走了还能干完

- 云 VM / RemoteWorker；会话与机器分离
- 断线续跑、流 rewind
- `gh` 开 PR；CI 日志落盘
- 云端减少提问、提高自主

**完成**：关笔记本任务仍在；回来能看完整 diff 与 Done Report。

### P6 — 更便宜的好用

- Fusion（price per task）
- Knowledge
- Browser 子 Agent（前端才需要）
- 插件化（这时才有资格）

---

## 6. 评测：两张榜

| 榜 | 证明什么 | 怎么跑 |
| --- | --- | --- |
| 模型榜 | 模型本身 | Minimal profile，bash + 编辑器 |
| Harness 榜 | 我们好不好用 | Standard + worktree + Done Report；报 resolve **和** U 指标 |

Harness 榜额外指标：

- 打断后是否按新约束完成（steer 任务）
- undo 后用户 tree 与 agent tree 是否符合预期
- 审批次数（越少越好，越权次数必须为零）
- 无关文件改动数
- 首个 tool 调用延迟、cache hit rate
- 「声称完成但检查失败」次数（应为零）

对比实验：`有无 worktree`、`有无 Done Report`、`有无 AGENTS.md`、`只读是否并行`。这些才是 harness 自己的贡献，不要和换模型混在一张表里。

---

## 7. 技术选型

| 问题 | 建议 | 理由 |
| --- | --- | --- |
| 主语言 | TypeScript | 手感迭代（协议、TUI、工具反馈）远快于先写 Rust |
| 包管理 | pnpm workspace | — |
| LLM | Chat Completions tools + adapter | 中立；Responses 特性后挂 |
| 会话 | JSONL | 可回放、可 fork、人能读 |
| 日常入口 | TUI（Ink 或精简自绘） | 不好用的 CLI 没人 dogfood |
| 隔离 | git worktree 第一，Docker 评测/脏任务 | 比第一天 microVM 更能上日常 |
| 协议 | JSON-RPC JSONL | 与 Codex / MCP 同构 |
| 耐久 | P5 再定 | P1 上 Temporal 是过度设计 |

---

## 8. 风险（好用视角）

| 风险 | 表现 | 缓解 |
| --- | --- | --- |
| 架构完整、没人用 | 只有 exec 和论文指标 | P1 就必须 TUI + worktree |
| 审批疲劳 | 用户关安全或关软件 | 分级 + 记忆；用审批次数当回归指标 |
| 弄脏工作区 | 一次事故永久卸载 | 默认 worktree；脏树 fixture 进 CI |
| 假完成 | 作文式成功 | Done Report；检查失败禁止 turn 成功结束 |
| 工具膨胀 | 又慢又蠢 | 新工具双榜 A/B |
| 过早插件化 / Fusion | 没人讲清 undo 发生了什么 | P6 之前扩展点只有 adapter 与 hooks |
| 把 Minimal 当产品 | 新用户觉得「还得自己 cat」 | 默认 Standard；Minimal 藏在 `--profile` |
| cache 被破坏 | 又贵又卡 | 组装顺序单测冻结 |

---

## 9. 建议拍板的问题

1. **主战场**：先内部 dogfood CLI，还是一开始就要 IDE 插件？（建议：CLI/TUI 打穿 U1–U10 再接 IDE。）
2. **默认模型**：P1 用哪家 OpenAI compatible 端点。
3. **黄金任务**来自哪条业务线；其中至少 3 条必须是「用户 tree 不干净」。
4. **代码是否不出域**。
5. **in-place 是否允许做默认**（建议否，仅 opt-in）。

不回答也可以开工 P0。但不要平行开工插件市场、Cloud、Fusion——那会做出一个完整而不好用的东西。

---

## 10. 附录：带转向与收工的循环

```ts
async function runTurn(thread: Thread, input: UserInput): Promise<Turn> {
  thread.inbox.push(input)
  const turn = thread.beginTurn()
  while (true) {
    if (thread.cancelled) return turn.interrupt()

    const claimed = thread.claimInbox()
    if (!claimed && !turn.toolsOutstanding()) {
      if (thread.mode === "agent" && turn.changedFiles() && !turn.hasEvidence()) {
        thread.inbox.push(thread.verifyNudge()) // 确定性提醒：去跑检查
        continue
      }
      turn.emitDoneReport()
      thread.checkpoint()
      return turn.close()
    }

    const prompt = assemble(thread)
    const stream = await llm.chat(prompt, thread.toolSchemas())
    const item = await consume(stream, { abort: thread.abort })

    if (item.functionCalls.length === 0) {
      turn.emitAssistant(item)
      continue
    }

    const { reads, writes } = partition(item.functionCalls)
    await Promise.all(reads.map((c) => runTool(thread, turn, c)))
    for (const c of writes) await runTool(thread, turn, c)
    if (needCompact(thread)) compact(thread)
  }
}

async function runTool(thread: Thread, turn: Turn, call: ToolCall) {
  const decision = await policy.check(call, thread.approvalMemory)
  if (decision === "ask") await client.approval(call)
  if (decision === "deny") return thread.appendToolResult(call.id, deniedMessage(call))
  const raw = await tools.execute(call, thread.agentWorkspace)
  thread.appendToolResult(call.id, truncateToDisk(raw))
}
```

---

## 11. 参考

- OpenAI, *Unrolling the Codex agent loop*；*Unlocking the Codex harness*；*Introducing the Agents API*
- DeepSeek Harness / Cordis 文档（Minimal vs Standard vs Code Mode）
- Cognition, *Devin Fusion*
- Cursor, *What we’ve learned building cloud agents*
- Claude Code Agent SDK；*Dive into Claude Code*
- SWE-agent ACI；OpenHands Software Agent SDK

对标会过时。好用不过时：**隔离、能转向、有证据、默认少问、diff 可审、明天还能 resume。**
