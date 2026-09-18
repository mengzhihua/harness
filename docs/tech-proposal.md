# 自研 Coding Agent Harness 技术方案

**状态**：P24 工作台宿主桥切片可启动。决策冻结见 [已确认决策](./decisions.md)。Spring 落地为 `@harness/spring`，见 [对照笔记](./di-and-composition.md)，**不 vendor Java Spring**。
**对标对象**：DeepSeek Harness、OpenAI Codex / ChatGPT Agents、Devin、Claude Code、Cursor Cloud Agents、OpenHands / SWE-agent。
**结论先行**：做一个 **模型无关、开箱能改代码、可插拔扩展、全程可回放** 的软件工程 Agent。架构为手感服务；插件和轨迹是手感的一部分，不是后期装饰。

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
# 7. 这个仓的发版/工单能力来自 .harness/plugins，不是改源码
# 8. 跑完能 /traj 打开轨迹：模型看见了什么、哪个插件动过手，能 replay
```

做不到 1–6，Cloud 和 Fusion 是库存。做不到 7–8，团队没法把 harness 嵌进自己的工程，也没法科学地改它。

### 0.1 一句话定义

> Harness = 让模型在真实仓库里 **安全地动手、被人管得住、自己能验收、能被扩展、能被回放** 的那一层。  
> 模型负责判断；harness 负责手感、边界、插件缝、轨迹和证据。

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
| U11 | 不改 harness 源码，能用一份插件清单加上工具 / skill / hook / MCP | 每个内部系统都 fork 一版 harness |
| U12 | 每次 run 产出可导出轨迹：能看、能 replay、能 diff、能当评测输入 | 只有聊天记录；出了问题只能「感觉模型变笨了」 |

评测集仍然要，但它回答「聪明不聪明」。这张表回答「烦不烦、敢不敢用、能不能嵌入、能不能复盘」。

### 0.3 成功标准（产品，不是框架）

三个月内 dogfood 成立的标志：

1. 团队内部至少一条真实业务线，**周活**用它修 bug / 写小功能，而不是只跑 demo。
2. 同一模型，走我们的 harness 比「聊天 + 自己粘贴」在黄金任务上：**更少步数、更少越权、更高验收通过**。
3. 新同学对着 README 十分钟内完成一次「修失败测试 → 看 diff → undo → apply」。
4. 同一条黄金任务能导出轨迹、换模型 replay、对比两条轨迹的工具序列和 diff。
5. 一个内部插件（例如「按仓库规范跑单测」）能装进项目目录即生效，且出现在轨迹里。

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
- 状态：模式、模型、worktree 路径、token / cache hit、是否已验证、**当前插件数**
- `/plugins` 与轨迹面板（按 source 过滤）；exec 结束必须打印 `.traj` 路径

`harness exec` 是同一协议的无头客户端，给 CI 和评测，不是给人的主入口。v0.1 把 exec 当第一客户端，对评测正确，对好用是错的。

### 1.9 组合内核：对齐 Cordis

插件怎么拼进运行时，走 **Cordis 模型**：Context、Service、inject、可逆注册、Loader YAML、Host / isolate。自己实现，不 vendor dsh。

Spring 注入理念落地为 `@harness/spring`（Bean、ApplicationContext、循环依赖检测），仍不 vendor Java Spring JAR，也不替换 Cordis 内核。笔记：[对照](./di-and-composition.md)。已拍板条目见 [确认决策](./decisions.md)。

| 收自 Cordis | 不抄 |
| --- | --- |
| Context + Service + inject | 不 vendor dsh |
| 可逆注册 | 不把业务拆成 30 个微包才开工 |
| waterfall | 不让第三方换 loop 契约 |
| Definition / Provider / Consumer | — |
| Profile = YAML 组合 | — |
| Host vs isolate | — |
| 官方 loop 是驱动插件，进 plugin_lock | 半棵树禁止开工 |

#### 内核对象

```text
Context     插件树和服务仓库。Thread 用 isolate 子树。
Service     ctx.llm / ctx.tools / ctx.shell / ctx.fs / ctx.agents / ctx.traj
inject      必选依赖，齐了才 apply；缺了启动失败
effect      注册必须可逆
Loader      读 YAML 展开；失败则拒绝开工
```

换执行运行时 = 换 `ctx.fs` + `ctx.subprocess` 的 Provider。

#### 两张平面

```text
Host      进程级：llm、traj、policy、workspace、官方 agent-loop
Isolate   每 Thread 一份：tool、skill、会话 hook、MCP、persistent shell
```

Isolate 里的服务两个 Thread 不得共享。Host 不要去碰某个 Thread 的 shell。

#### Profile 是组合，不是 if

`minimal` / `standard` / `eval` 各是一份 composition，不是代码里的 mode 分支。

```yaml
# profiles/standard.yml  （示意，对齐 Cordis include + patch）
bundles:
  - harness-host-base          # traj, policy, workspace, llm
  - harness-agent-loop         # 官方驱动，实现 ctx.agents
  - harness-aci-tools          # read/grep/edit/bash
  - harness-skills
include:
  - ~/.harness/composition.patch.yml
  - .harness/composition.yml   # 项目插件
```

```yaml
# profiles/minimal.yml
bundles:
  - harness-host-base
  - harness-agent-loop
  - harness-aci-minimal        # 仅 bash + str_replace
```

启动：`new Context()` → provide 路径 → Loader 展开 YAML → await 全部激活 → 失败则拒绝开工。禁止半棵树跑 Agent。

#### 官方 loop 是驱动插件

`@harness/agent-loop` 实现 `ctx.agents`：Turn/Step、inbox、steer、Done Report、前缀稳定、模型可见⊆轨迹可重建。

- v1 **只加载这一份驱动**。第三方可以挂 waterfall（`agent/pre-step`、`tools/pre-execute`），不能换循环语义。
- 驱动的 id@version 写入 plugin_lock。dry replay 对不齐 = 驱动或组装变了。
- 这样既融合了 Cordis「loop 也是插件」，又保住轨迹稳定性：换驱动等于换 lock，live replay 必须失败。

事件缝（waterfall 必须 `next()`）：

```text
agent/pre-step → agent/request → llm/stream
tools/pre-execute → tools/execute → tools/post-execute
agent/turn-stopping（serial，无 next）
```

这些就是 Claude Hook / 审批 / 审计的挂载点，不再另做一套平行 hook 总线。

#### 一份外部插件长什么样

仍可以是目录 + manifest（给业务用，不必手写 composition 树）：

```text
.harness/plugins/acme-test/
  plugin.json          # 会被 Loader 编成一条 isolate 组
  SKILL.md
  tools/run-unit.ts
  hooks/block-prod.ts  # 实际注册到 tools/pre-execute waterfall
```

规则不变：声明权限、失败可见、模型可见输出进轨迹、零配置时 standard 组合已含 ACI、本地 catalog + `HARNESS_STORE_URL` 远程商店（无计费）。

TUI `/plugins` 列出 **整棵已激活树**（host + 本 Thread isolate），含官方 loop 版本。

### 1.10 轨迹：模型看见的，必须能拿回来

轨迹不是「日志文件」。它是 harness 的源代码级事实：评测、undo、resume、插件审计、对比两个模型，全部读它。DeepSeek 的原则直接采用：**模型可见 ≡ 已落盘。**

#### 一条轨迹包含什么

```text
Trajectory
  header
    harness_version, model, mode
    plugin_lock          # 每个插件 id@version + 内容哈希
    userRoot, agentRoot, git_head, dirty 提示
    env_hash             # os / shell / 关键环境，不进密钥
  events[]               # append-only，见 Item
  artifacts/             # 截断的命令输出、测试日志、diff 包
  outcome                # Done Report；interrupted / failed 也要有
```

每条 event 带 `source`，Trajectory View 按来源过滤，而不是一条聊天长卷：

| source | 例子 |
| --- | --- |
| `system` | 组装后的系统段（可哈希，正文可按策略折叠） |
| `user` / `steer` | 人的话 |
| `assistant` / `reasoning` | 模型输出 |
| `tool` | 调用与结果 |
| `plugin` | load / hook 改写 / 报错 |
| `policy` | 审批、拒绝 |
| `compact` | 压缩点，之后 history 从这里投影 |
| `checkpoint` / `done_report` | 工作区快照与收工证据 |

#### 人要能做的事

| 命令 | 行为 |
| --- | --- |
| `/traj` 或 `harness traj show` | 按 source 浏览；点开一条 tool 看完整 artifact |
| `harness traj export` | 打成 `.traj` 包（header + jsonl + artifacts + plugin_lock），可进 git-lfs 或评测仓 |
| `harness traj replay --dry` | **不跑工具**，按 log 重建当时 prompt。用来查「模型到底看见了什么」 |
| `harness traj replay --live` | 同一 plugin_lock + 同一仓库 revision 上重跑工具。用来评测 |
| `harness traj fork --at <event>` | 从任意事件开新线程（比 checkpoint fork 更细） |
| `harness traj diff a b` | 对比工具序列、改动文件、token、是否越权、Done Report |

dry replay 是调试神器，必须 P2 就有。live replay 要求 plugin_lock 能还原，还原不了要明确失败，不许悄悄用当前插件集重跑（分数会撒谎）。

#### 和会话、checkpoint 的关系

- Thread 进行中：jsonl 就是活轨迹，边跑边写。
- undo：工作区回滚 + 投影 rewind；jsonl 仍追加一条 `rewind`，审计链不断。
- 评测：黄金任务的期望可以是「最终 diff」也可以是「轨迹约束」（例如不得调用 `bash rm`、必须出现 `run_unit`）。
- 训练/蒸馏（后期）：轨迹是数据，不是现在的产品目标，但 schema 不要设计成以后导不出来。

TUI 最小：当前线程可打开轨迹面板；`exec` 结束打印轨迹路径。没有路径的成功，评测视为无效 run。

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

对我们：组合内核按 Cordis 做（Context / Service / isolate / 组合即 profile）。Minimal 与 Standard 是两份 YAML，不是 if/else。官方 loop 作为驱动插件进 lock。轨迹按 source 查看。不 vendor dsh 源码。

### 2.3 Devin：隔离让人放心，计划让人敢开大任务

VM + 浏览器 + 结构化计划 + Knowledge。Fusion 用 Lead/Sidekick 降 **price per task**，两边不共享整本 transcript，所以又快又便宜。

对我们：本地用 worktree 代替 VM 给人信心；计划对象化进 v1；Fusion 进后期。没有隔离就学 Devin 的「全自主」，用户第一次被覆盖脏工作区就会卸载。

### 2.4 Claude Code：转向、权限、Skills 是手感本体

公开结论是 loop 极简，外围才是产品：Esc 打断、权限模式、渐进 Skills、Hooks、Subagent 把噪音隔开。

对我们：Steer / 审批记忆 / Skills 是 P2 主菜。Skills 和 Hooks **挂在 Cordis 事件缝上**（`tools/pre-execute` waterfall），不另做一套总线。

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
| 插件 | dsh Cordis；Claude skills/hooks/MCP；Codex MCP | **融合 Cordis**：Context/Service/Event/isolate；profile=composition；官方 loop 驱动进 plugin_lock；本地 + 远程商店 |
| 轨迹 | dsh append-only + source 视图；各家 session log | 一等 Trajectory：export / dry·live replay / diff / fork；plugin_lock 写入 header |
| 评测 | Minimal / SWE-bench | 黄金任务 + U1–U12；评测读轨迹，不另造一套 log |
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
8. **Loop 保持笨，但是官方驱动插件。** 手感做在 worktree、inbox、checkpoint、ACI、组合缝、轨迹。循环语义由 `@harness/agent-loop` 实现并锁进 plugin_lock。
9. **模型可见 ≡ 可回放。** 插件输出、hook 改写、截断、审批全部进轨迹，否则 undo/resume/评测都会撒谎。
10. **扩展只走组合内核。** 新能力写成插件；禁止为业务 fork harness。第三方可挂 waterfall，不可换 loop 契约。
11. **随着模型变强做减法。** 能变成 tool/skill 的不要写死；模型还做不好的（隔离、证据、打断、轨迹完整性）不要交给模型。
12. **评测进主仓，但分两张榜，且都消费轨迹。** Minimal 测模型；Standard + U1–U12 测 harness。

---

## 4. 目标架构（为手感服务）

实现细节见 [架构草图](./architecture.md)。立项决策见 [已确认决策](./decisions.md)。

### 4.1 六层，外加一条工作区轴

```text
TUI / exec / 未来 IDE
        │  JSON-RPC
   App Server
        │
   Context 树（Cordis 对齐的组合内核）
        │
   Host: llm / traj / policy / workspace / agent-loop
   Agent isolate: tools / skills / mcp / shell
        │
   执行运行时 Provider（ctx.fs + ctx.subprocess）
        │
   AgentWorkspace ──apply──► UserWorkspace
```

硬边界：协议 / 组合内核；User≠Agent 工作区；执行 Provider 可换；**轨迹是事实源**；**loop 契约冻结在官方驱动 + lock**。

### 4.2 模型

v1 单模型、配置指定。Adapter 本身是一种插件 kind，但默认内置 OpenAI compatible。不要每个 step 换模型（打穿 cache，任务更贵、手感更顿）。Fusion 留 v2：Lead / Sidekick **两段 session**，只传 brief/result；两段各自写轨迹，父轨迹只记 brief/result。

### 4.3 安全：三层 + 工作区隔离 + 插件权限

1. Worktree / 副本（用户资产）
2. OS / 容器边界（系统资产）
3. Policy + 审批 + **插件声明的 permissions** + hooks（意图资产）

推理 API key 不准进 sandbox，也不准进插件进程，除非 permissions 显式申请并经审批。Agent 若需要 GitHub，给最小权限 token。轨迹默认脱敏：header 只留 env_hash，artifact 扫密钥模式。

---

## 5. 分期：每一期都要能用，不是更能画

每一期的完成标准都是 **人能用的切片**，附带评测，而不是「模块合并完成」。

### P0 — 写死手感契约

- 冻结事件：Thread / Turn / Item，外加 `checkpoint` / `done_report` / `steer` / 组合事件 / 轨迹 header（含 **整棵激活树的 plugin_lock**）
- 冻结 composition YAML：`standard.yml` / `minimal.yml` 的 bundle 列表
- 冻结官方 `@harness/agent-loop` 契约（Turn/Step、前缀稳定、模型可见⊆轨迹）
- 写好用验收脚本（U1–U12）和 20 个黄金任务
- 三个 fixture（脏树 + 项目测试插件）
- 冻结 `.traj` 导出格式

**完成**：假 Context 能展开 standard 组合、建 worktree、写出可 `traj show` 的 jsonl。半棵树必须启动失败。

### P1 — 第一次修对测试

- **组合内核 + Loader**：`new Context()` 展开 `standard.yml`，官方 `@harness/agent-loop` 进 lock
- 轨迹 jsonl（边跑边写）+ OpenAI compatible adapter（`ctx.llm` Provider）
- `bash` + `str_replace` + `read_file`（ACI 作为 bundle，不是写死在 loop 里）
- **默认 worktree** + 路径约束（`ctx.fs` / `ctx.workspace`）
- TUI 雏形；`exec` 打印轨迹路径
- 项目 `.harness/plugins` 编进 Agent isolate 组（先 skill）

**完成**：TUI 修通失败测试；脏文件仍在；`traj show` 能看到 source 与官方 loop 版本。

### P2 — 日常好用（dogfood 门）

- grep / glob / update_plan；只读并行
- Ask / Plan / Agent 切换
- Esc 打断、inbox 转向、checkpoint、`/undo` `/apply` `/resume`
- 审批记忆（§1.4）
- `AGENTS.md`、Done Report、基础 compaction
- **插件 = isolate 组**：tool / skill / `tools/pre-execute` waterfall；`/plugins` 列出整棵树
- **轨迹：export、dry replay、按 source 过滤**

**完成**：团队 dogfood；U1–U12 可勾；内部插件不改源码即可跑仓库单测；dry replay 对齐 prompt（含 loop 版本）。

### P3 — 同一手感出现在第二扇门

- App Server；TUI 与 exec 均改 client
- fork（含 `traj fork --at`）；MCP 作为插件 kind
- 会话列表、标题、搜索
- `traj diff`；live replay 的最小版（同 revision + plugin_lock）

**完成**：SDK 不 import core；评测消费 `.traj` 而不是临时 stdout。

### P4 — 更稳、更会、更少吵

- Docker provider
- 本地 kernel sandbox
- `delegate` 子 Agent（子轨迹挂到父轨迹）
- 建议更新 `AGENTS.md`
- `harness plugin add <path-or-git>`

**完成**：hooks 能拦住禁令并写进轨迹；子 Agent 噪音不污染父轨迹正文。

### P5 — 人走了还能干完

- 云 VM / RemoteWorker；会话与机器分离
- 断线续跑、流 rewind（仍是同一条轨迹）
- `gh` 开 PR；CI 日志作为 artifact 挂在轨迹上
- 云端减少提问

**完成**：关笔记本任务仍在；回来打开的是同一 traj id。

### P6 — 更便宜的好用

- Fusion：Lead / Sidekick **两段同模型 session**（不是热路径切模型），只传 brief/result
- Knowledge：`.harness/knowledge/*.md`，prompt 只进目录
- Browser 子 Agent 合同；无运行时失败闭合
- 轨迹 baseline 库（工具序列对照，供蒸馏/回归）
- 远程计费市场仍不做（D7：可远程 catalog，无支付）

**完成**：父 jsonl 看不到 Lead/Sidekick 的工具噪音；catalog 不倾倒笔记全文；browser 默认不可用。

### P7 — dogfood 表面

- 自绘 TUI 第一视口（流 + 当前工具 + 输入 + 审批卡片）；`harness repl` 仍在
- `approval/respond` 反向 RPC；非 yolo 的 ask 暂停 loop
- 运行时断言：模型可见 ⊆ 轨迹；step 前缀稳定直到 compact 事件
- `plugin/enable` `plugin/disable` 写 `plugin/change`；`command` kind
- `web_search` / `web_fetch` / `ask_user`；无 `HARNESS_NET` 失败闭合
- U1–U12 清单与 3 个黄金任务 markdown

**完成**：TTY 下 `harness` 能看见审批并回答；exec 打印 `.traj`；disable 插件会断 lock。

### P8 — 同一条会话里的日常产品

- `/ask` `/plan` `/agent` 改当前 thread 的 mode 与 Policy，不开新会话；resume 读 header.mode
- `@path` 作为用户附件：最多 4 个文件 × 24KB，展开进 turn/start，轨迹记 `attachment`
- `plan/set`：用户可 skip 步骤；assemble 进 `## plan`；`update_plan` 同源
- `adapter` kind：插件 `createLlm()` 替换 isolate `ctx.llm`；缺入口失败闭合
- `profiles/eval.yml`（aci-minimal）+ `harness eval --task FILE`
- U10：缺命令 / 权限 / 网络被拦写进 `residual_risks` 人话
- 协议 0.8.0：`thread/mode` `plan/set`

**完成**：mode 切换后 thread id 不变且 ask 不能写；`@src/auth.js` 出现在 user turn；eval profile 没有 fusion/delegate。

### P9 — 打断得了、证据落得下

- `/stop`：`turn/interrupt` 取消 in-flight `llm.chat`，并把 AbortSignal 传到 subprocess（SIGKILL）
- TUI 补 `/stop` `/undo` `/apply` `/plugins` `/traj`；REPL 同名
- 同 step：read/grep/glob 并行，写仍串行；结果按原 tool_call 顺序回灌
- 检查失败且不是 U10 卡住：注入一次 `check_nudge`，禁止作文式收工
- bash 大输出落盘 `artifacts/`，Done Report `checks[].summary_path`
- 协议 0.9.0

**完成**：`/stop` 后 Done Report `interrupted`；混合 step 日志出现 `parallel grep,read_file`；超长 stdout 只在 prompt 里留指针。

### P10 — 日常产品收口

- `AGENTS.md`：git root → cwd 分层，映射到 agent worktree；越近越靠后
- skill catalog：assemble 只进 `id` + `description`，不倾 `SKILL.md` 正文
- 粘贴 `diff`/`patch` 与 stack trace：轨迹 `paste:diff` / `paste:error`；prompt 不再展开一份
- 轨迹 `append` / artifact 脱敏（`sk-` / `ghp_` / `AKIA` / PEM / `api_key|secret|token`）；header `env_hash`
- `/apply` 冲突：`git merge --abort`，报告冲突文件，用户树不留半合并
- `/plan skip ID`（协议 `plan/skip`）；精确 `/plan` 仍只切 mode
- 协议 0.10.0

**完成**：cwd 子目录能看见根 + 近处 AGENTS.md；skill 正文不进 system；粘贴 diff 有 attachment 无 `## attachments` 重复；冲突 apply 后无 unmerged paths。

### P11 — 按需技能、压得住上下文、看得见 diff

- `read_skill`：启动只加载 skill 目录；正文按 id 读取 `SKILL.md`（≤24KB），轨迹 `skill/read`；disable 失败闭合；ask/plan 可调用
- Compaction 保留计划、最近步骤、`[check]`/`[verify]`/bash 证据；投影带上最新 `[done]`
- 写入后发出 `diff/updated`（files + summary）给 TUI，不等 Done Report
- 协议 0.11.0

**完成**：assemble 仍无 SKILL.md 正文；`read_skill` 能拿到正文；compaction 后 `[check]` 还在；str_replace 当步就有 `diff/updated`。

### P12 — 审批看得懂、会话接得上

- 审批卡片：命令原文、cwd、why；`[y] this turn` `[s] this thread` `[n] deny`（不再只显示 JSON 工具名）
- TUI / REPL：`/resume` `/threads` `/traj SOURCE` `/check`；缺 checks 的 diff 标 `needs-check`
- `workspace/check`：从 AGENTS.md 或 package.json 探测测试命令，经 subprocess 跑，轨迹 `workspace/check`
- `$HARNESS_HOME/config.yml`：默认 model / mode / network / yolo；CLI 旗标优先
- bash `cd` 记住 cwd（不逃出 worktree）
- 协议 0.12.0

**完成**：config.yml 能改默认 mode；`cd pkg` 后 `ls` 看到 pkg 内文件；审批帧含 command+cwd；`/check` 写出 workspace/check 事件。

### P13 — 永久记住、看得到 token

- `[a] always`：`approval/respond` 增加 `allow_always`；签名写入 `$HARNESS_HOME/config.yml` 的 `allow:`，启动时灌进 Policy memory；轨迹 `allow_always`
- TUI 状态：`tok=`（prompt+completion 累计）与 `cache=`（本步 cached_tokens）
- 每步 LLM 发出 `llm/usage` 通知并写轨迹（prompt_tokens / completion_tokens / cached_tokens）
- 协议 0.13.0

**完成**：`allow: bash:net` 的新线程不再问 curl；`[a]` 之后 config.yml 有签名；TUI 帧含 `tok=` 与 `[a] always`。

### P14 — 看得见它在想、看得见它在跑

- `llm.chat` 走 SSE（JSON 回退）；`onDelta` 发 `item/delta` `{ append: true, source: llm }`。Mock 切 24 字或 `→ tool` 预览。
- `bash` / Docker `onStdout` 同样 `append` + `source: bash`。Remote 仍缓冲。
- TUI 用 `state.stream` 直播末两行；离散 `item/delta` 与 `done_report` 清掉。
- 轨迹仍只写完整 `step` / tool_result，不写每个 token。
- 协议 0.14.0

**完成**：MockLlm 带 onDelta 有 chunk；`printf` 的 onStdout 能拼出输出；TUI 帧在 append 时出现直播行。

### P15 — 全局配置不用手改 YAML

- 协议 `config/get` `config/set`：读写 `$HARNESS_HOME/config.yml`（model / mode / profile / network / yolo / allow）
- `yolo` 与 `mode` 立刻作用到当前 thread 的 Policy；其余键下次 boot 生效
- CLI：`harness config` / `get [KEY]` / `set KEY VALUE`
- TUI / REPL：`/config` `/config set KEY VALUE` `/yolo` `/yolo off`
- 协议 0.15.0

**完成**：config/set yolo 后 config.yml 有 `yolo: true`；下次 boot 的 curl 不再问。

### P16 — Harness 榜能从轨迹打出来

- `scoreTrajectory(header, events)`：§6 指标（apply_ready、checks、审批 deny/always/audit、无关文件 `USER_WIP.md`、首个 tool 延迟、`llm/usage` cache hit、声称完成但检查失败、plugin/error、integrity/mismatch、plugin_lock / 项目插件 tool）
- 协议 `eval/score`：给当前 thread 打分；有 `turn/start` 时再跑 dry replay 确认能投影出 user 消息
- `harness eval --task FILE` 打完也打印一张 scorecard；`--dir DIR`（`--suite` 同义）顺序跑目录里全部 `*.md`，轨迹进 `~/.harness/eval/`，写出 `scorecard.json`
- 门禁：`claimed_done_but_check_fail`、`plugin_errors`、无关文件、`integrity_mismatch` 必须为零
- 协议 0.16.0

**完成**：eval/score 在 mock 修 login 后 apply_ready 且 plugin_lock 含项目插件；`--dir` 能列出 eval/tasks 的黄金 markdown。

### P17 — 当前工具、语言、目录商店、双模型 Fusion、IDE 桥

- TUI 当前工具行：loop 在每步 `item/started` / `item/completed` 带 command / path / grep 命中计数；收工清掉
- `config.yml` `language: zh|en`；assemble 约束回复语言；TUI 审批铬字中英切换；`/lang`
- 本地 catalog：`catalog/plugins.json` + `plugin/search` `plugin/install`（不是远程市场）
- Fusion Lead/Sidekick 可 `lead_model` / `sidekick_model`（仍是两段 session，不是热路径切模型）
- IDE 桥：`ide/open` `ide/status`、`harness ide`、`extensions/vscode`；**不分叉编辑器**（D1）
- 协议 0.17.0

**完成**：TUI 帧出现 `tool grep … N hits`；language=zh 的 system prompt 含「简体中文」；catalog 能 install `harness.test-runner`；fusion 结果带两个 model 字段；`HARNESS_IDE=/bin/true` 时 ide/open 成功。`config/get` 在有 thread 时叠加活会话（所以 `--language zh` 能进 TUI）。`HARNESS_IDE=none` 关闭编辑器探测。

### P18 — 输入框始终可点（队列 follow-up）

- 运行中再打一行话进入 inbox，不新开 session；TUI 输入行一直在，下面画出 `queued (N)`
- 协议 `inbox/updated`；`turn/steer` 回 `{ queued, items }`；`turn/inbox` / `turn/inbox/clear`
- 模型若已收工（无 tool）但 inbox 还有字，同一 turn 继续吃 steer，不把 follow-up 丢掉
- REPL 不再卡住等 Done Report：运行中的输入走队列；`/queue` `/queue clear`
- 协议 0.18.0

**完成**：steer 通知带剩余队列；无 tool 回复期间推进 inbox 的 follow-up 会写成 `steer` 事件并继续本轮；TUI 帧有 `queued=` 且 `>` 仍在。

### P19 — 远程商店、IDE 工作台、Spring、插件权限、run_code

- 远程商店：`HARNESS_STORE_URL`（http(s) 或本地 JSON）并入 `plugin/search`；`origin=remote|local`；仍无计费
- IDE 分叉：自研 `@harness/ide` 工作台 + `ide/workbench` + VS Code 扩展宿主；**不 vendor VS Code 源码**
- `@harness/spring`：ApplicationContext / Bean / autowire / 循环依赖检测；isolate boot 挂 `ctx.spring`
- 插件 `permissions`：network / secrets / subprocess / fs；缺声明失败闭合，轨迹写 `plugin/permission`
- `run_code`：JS/Python 片段在 AgentWorkspace 沙箱执行（断网）；ask/plan 不可用
- 协议 0.19.0

**完成**：STORE_URL 的远程 catalog 能 search/install；command 插件 `subprocess: false` 记 permission 并拒绝执行；`run_code` 打出 stdout；`ide/status.fork=harness-ide`；Spring circular inject 在 refresh 失败。

### P20 — 权限展示、MCP 密钥隔离、scorecard、workbench 文件树

- `plugin/list` 带 `origin` 与 `permissions`；TUI `/plugins` 逐行打印，不只报个数
- MCP spawn 走 `pluginEnv`：`permissions.secrets=false` 时剥掉 API key / token
- 商店 install 把 catalog `origin` 写进 `plugin.json`
- scorecard 计 `plugin_permission`；`run_code` 算内置工具
- IDE workbench `files[]` 来自 agent worktree（跳过 `.git` / `node_modules`）
- 协议 0.20.0

**完成**：login.verify 的 list 行是 `project` + `fs=workspace`；MCP 子进程看不到 `HARNESS_TEST_SECRET_TOKEN`；workbench HTML 含 `src/auth.js`；scorecard 把 `run_code` 排除在 plugin_tools 外。

### P21 — 工作台打开文件、host-fs、密钥放行

- 工作台树节点带 `data-path`，HTML 内嵌 `contents`，点击填进编辑器
- `ide/file` 用 LocalFs 读 worktree，`..` / 绝对路径失败闭合
- 插件 tool 参数：绝对路径/`..` → `host-fs`；api_key/token → `secrets`；拒绝原因写进 tool result
- MCP `permissions.secrets=true` 时子进程能看到宿主 token
- TUI `/store` 行带 origin 与 `fs=`
- 协议 0.21.0

**完成**：`ide/file src/auth.js` 读出正文；`peek_path /etc/passwd` 记 `plugin/permission` host-fs；secrets 放行的 MCP 能回显 token。

### P22 — 无编辑器打开、工作台命令、失败 tool 进 TUI

- 修好 CLI `harness ide`（先前误并进 workbench）
- 无编辑器时 `/open` 与 `harness ide FILE` 回退 `ide/file` 预览；`ide/open` 本身仍失败闭合
- 工作台 Apply/Undo/Steer/TUI 按钮写到 agent 栏；Steer 输入框
- 失败 tool 的 `error` 随 `item/completed` 进 TUI
- VS Code 宿主点击树节点打开文件
- 协议 0.22.0

**完成**：`HARNESS_IDE=none` 时 ide/open 失败但 ide/file 读出 src/auth.js；工作台 HTML 含 `data-cmd="apply"` 和 `harness apply`；TUI 帧出现 host-fs 拒绝原因。

### P23 — 工作台按钮真正执行

- 协议 `ide/command`：`apply` / `undo` / `steer` / `open` / `tui` 作用在当前线程
- 未知命令失败闭合；steer 必须带 text；open 必须带 path
- 轨迹写 `ide/command`；通知 `plugin/event` type=ide/command，TUI 画出
- CLI `harness ide apply|undo|steer|open|tui`
- 工作台 HINTS 指向 `ide/command …`
- 协议 0.23.0

**完成**：steer 进 inbox；open 读出 src/auth.js；未知 explode 抛 unknown ide command。

### P24 — 工作台宿主桥与 TUI `/ide`

- 工作台 JS 通过 `window.harness.command` / `acquireVsCodeApi().postMessage` / `parent.postMessage` 发 `ide/command`
- 无宿主时仍在 agent 栏画 `ide/command …` 提示
- TUI / REPL `/ide apply|undo|steer|open|tui`
- VS Code 宿主终端跑 `harness ide apply`（不再是 `harness apply`）
- `thread/items/list` 投影包含 `ide/command`；scorecard 计 `ide_commands`
- 脏用户树 `USER_WIP.md` 在 `ide/command apply` 后仍在
- 协议 0.24.0

**完成**：apply 合回 agent 修复且不覆盖 USER_WIP.md；items 列表出现 ide/command apply；`/ide explode` 失败闭合。

---

## 6. 评测：两张榜

| 榜 | 证明什么 | 怎么跑 |
| --- | --- | --- |
| 模型榜 | 模型本身 | Minimal profile，bash + 编辑器 |
| Harness 榜 | 我们好不好用 | Standard + worktree + Done Report + 插件锁；报 resolve **和** U 指标 |

两张榜都产出 `.traj`。没有轨迹的分数不入库。

Harness 榜额外指标：

- 打断后是否按新约束完成（steer 任务）
- undo 后用户 tree 与 agent tree 是否符合预期
- 审批次数（越少越好，越权次数必须为零）
- 无关文件改动数
- 首个 tool 调用延迟、cache hit rate
- 「声称完成但检查失败」次数（应为零）
- 插件 load 失败却继续跑的次数（应为零）
- 插件 permission 拒绝次数（`plugin/permission`，失败闭合计数，不单独当 suite 红灯）
- dry replay 能否逐字节对齐当时 prompt（除时间戳）
- 装入项目测试插件后，轨迹里是否出现对应 tool/skill

对比实验：`有无 worktree`、`有无 Done Report`、`有无 AGENTS.md`、`有无项目插件`、`只读是否并行`。换模型必须 **同一 plugin_lock + 同一轨迹约束** 才叫对照。

---

## 7. 技术选型

| 问题 | 建议 | 理由 |
| --- | --- | --- |
| 主语言 | TypeScript | 手感迭代（协议、TUI、工具反馈）远快于先写 Rust |
| 包管理 | pnpm workspace | — |
| LLM | Chat Completions tools + adapter | 中立；Responses 特性后挂 |
| 会话 / 轨迹 | JSONL + `.traj` 包 | 可回放、可 fork、人能读、评测可入库 |
| 日常入口 | TUI（Ink 或精简自绘） | 不好用的 CLI 没人 dogfood |
| 隔离 | git worktree 第一，Docker 评测/脏任务 | 比第一天 microVM 更能上日常 |
| 组合内核 | 自研、对齐 Cordis | `@harness/spring` 适配层；不 vendor dsh / Java Spring |
| 插件 | composition YAML + 目录 manifest | MCP 子进程；业务插件编成 isolate 组 |
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
| 工具 / 插件膨胀 | 又慢又蠢 | 新内置工具与新官方插件都要双榜 A/B；权限默认最小 |
| 第三方换掉 loop 契约 | undo / replay 说不清 | 只允许官方 `@harness/agent-loop`；版本进 lock；waterfall 可挂不可换驱动 |
| 半加载树开工 | 缺工具还以为自己全知 | Loader await 失败即拒绝启动 |
| 轨迹不完整 | replay 对不齐，评测撒谎 | 运行时断言：进模型的字节 ⊂ 轨迹可重建字节 |
| 把 Minimal 当产品 | 新用户觉得「还得自己 cat」 | 默认 Standard；Minimal 藏在 `--profile` |
| cache 被破坏 | 又贵又卡 | 组装顺序单测冻结 |
| 插件静默失败 | Agent 少工具还以为自己全知 | load error 进 TUI + 轨迹，默认中止或降级提示 |

---

## 9. 建议拍板的问题

1. **主战场**：先内部 dogfood CLI，还是一开始就要 IDE 插件？（建议：CLI/TUI 打穿 U1–U12 再接 IDE。）
2. **默认模型**：P1 用哪家 OpenAI compatible 端点。
3. **黄金任务**来自哪条业务线；其中至少 3 条必须是「用户 tree 不干净」。
4. **代码是否不出域**。
5. **in-place 是否允许做默认**（建议否，仅 opt-in）。
6. **第一批要写的内部插件是哪一个**（建议：仓库单测 / 工单系统二选一，用来把 U11 跑通）。

不回答也可以开工 P0。但不要平行开工插件商店、Cloud、Fusion。本地插件和轨迹格式必须进 P1/P2，否则 dogfood 时每个业务线都会来要 fork。

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
  const hooked = await plugins.hooks.preToolUse(call) // 可改写或拒绝，结果进轨迹
  if (hooked.block) {
    return thread.traj.append({ source: "plugin", type: "hook_block", call, reason: hooked.reason })
  }
  const decision = await policy.check(hooked.call, thread.approvalMemory)
  if (decision === "ask") await client.approval(hooked.call)
  if (decision === "deny") return thread.traj.append({ source: "policy", type: "denied", call: hooked.call })
  const raw = await tools.execute(hooked.call, thread.agentWorkspace)
  const afterHook = await plugins.hooks.postToolUse(hooked.call, raw)
  thread.traj.append({ source: "tool", call: hooked.call, result: truncateToDisk(afterHook) })
}

// 进模型的每一段都必须能从 thread.traj 重建；插件 lock 写在 header。
```

---

## 11. 参考

- OpenAI, *Unrolling the Codex agent loop*；*Unlocking the Codex harness*；*Introducing the Agents API*
- DeepSeek Harness / Cordis
- Spring IoC → `@harness/spring`，见 `docs/di-and-composition.md`
- Cognition, *Devin Fusion*
- Cursor, *What we’ve learned building cloud agents*
- Claude Code Agent SDK；*Dive into Claude Code*
- SWE-agent ACI；OpenHands Software Agent SDK

对标会过时。好用不过时：**隔离、能转向、有证据、默认可扩展、每次都能回放。**
