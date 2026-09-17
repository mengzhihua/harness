# 自研 Coding Agent Harness 技术方案

**状态**：草案 v0.1，供讨论与立项，不是实现规格冻结。
**对标对象**：DeepSeek Harness、OpenAI Codex / ChatGPT Agents、Devin、Claude Code、Cursor Cloud Agents、OpenHands / SWE-agent。
**结论先行**：先做 **模型无关的软件工程 Agent 运行时**，不要先做 IDE，也不要先做「全自主工程师」产品。

---

## 0. 为什么现在自研

2026 年各家产品表面能力已经收敛：都能读改代码、跑命令、开 PR、接 MCP、做 subagent。真正拉开差距的不是聊天窗口，而是 harness：

- 模型怎么看见环境
- 工具怎么设计、怎么截断、怎么审批
- 上下文怎么缓存和压缩
- 长任务怎么在机器宕掉后还活着
- 同样的 loop 如何同时服务 CLI、IDE、Cloud、CI

OpenAI 把这层直接叫做 **Codex harness**，并开源核心 loop，再用 App Server 喂给 CLI / VS Code / Web / ChatGPT。DeepSeek 把这层做成 **Everything is a plugin** 的开源运行时。Cognition 用 **Devin Fusion** 证明：harness 决定「同样模型下的单价和完成质量」。Cursor 则写明：**环境才是产品**，harness 要学会逐渐把确定性逻辑交还给模型。

所以自研的目标不是再做一个 Copilot 插件，而是掌握这一层运行时。模型可以换，供应商可以换，内部研发流程（评审、合规、私有代码、评测集）不能建立在别人的黑盒 loop 上。

### 0.1 一句话定义

> Harness = 把 LLM 变成能在真实仓库里闭环工作的软件工程师，所需的全部确定性系统：loop、工具、上下文、沙箱、协议、评测。

模型是灵魂。Harness 是身体、感官、手脚和职业规范。

### 0.2 成功标准（12 个月内可验证）

1. **同一套 Core** 驱动 `exec`（无头）、TUI、以及至少一个 IDE/Web 客户端。
2. **换模型不换 harness**：至少跑通 DeepSeek、OpenAI、Anthropic 三家，tool calling 行为一致。
3. **评测可复现**：内置 Minimal 模式（仅 bash + 编辑器），在固定任务集上能对比「裸模型 vs 完整 harness」。
4. **真实闭环**：在内部仓库上能独立完成「读需求 → 改代码 → 跑测试 → 提交 PR」；失败时留下可回放轨迹。
5. **安全默认**：工作区外写入与出网默认拒绝；危险动作可审批、可审计。

---

## 1. 对标：各家 harness 到底赢在哪

下面只谈 **运行时设计**，不谈模型排行榜。引用以各家公开博客、文档、开源仓库为准。

### 1.1 OpenAI Codex / ChatGPT：一份 harness，所有表面

Codex 不是 CLI 产品名那么简单。CLI、IDE 插件、macOS App、Codex Cloud、ChatGPT 里的编码 Agent，共用同一套 **Codex core**：

| 设计点 | 做法 | 可抄 |
| --- | --- | --- |
| 核心循环 | 组 prompt → Responses API 流式推理 → 执行 tool → 把结果 **追加** 到原 prompt 再请求，直到 assistant message | 循环本身极简，复杂度在周边 |
| 会话模型 | Thread / Turn / Item；Item 有 started / delta / completed | 所有 UI 只渲染这套事件 |
| 多表面 | App Server：JSON-RPC over stdio；Web 把同一进程塞进容器，浏览器走 HTTP+SSE | **协议与 loop 分离** |
| 缓存 | 新 prompt 必须是旧 prompt 的精确前缀，让采样从二次变成近似线性 | 前缀稳定性是性能第一原则 |
| 压缩 | 自动 compaction，保留加密的 `encrypted_content` 以保住模型隐状态 | 我们没有这套专有能力时，用结构化摘要代替 |
| 沙箱 | macOS Seatbelt，Linux Landlock + seccomp；MCP 工具自行负责安全 | 内核级隔离，策略与 loop 解耦 |
| 指令 | 模型自带 instructions + `AGENTS.md` 分层 + skills 元数据 | 项目规范用开放文件，不绑产品 |
| 产品化 | Agents API：OpenAI 托管 harness，调用方只选环境和工具 | 「harness 当平台卖」 |

ChatGPT 侧的编码能力，本质上是 **同一 harness 的托管形态**：会话持久、沙箱执行、技能/MCP、子任务委派、断线续跑。Agents API 把这套能力从 ChatGPT 里剥出来给开发者。自研时要学的不是 ChatGPT 的气泡，而是「loop 托管 + 环境可选」。

**不要抄**：把 CLI 写死成唯一入口；不要把 UI 事件做成模型 SSE 的透传。

### 1.2 DeepSeek Harness：可组合，而且认真做评测基线

DeepSeek Harness（dsh）把几乎所有能力做成 Cordis 插件：模型、工具、skills、session、sandbox、storage、loop、调度、UI。运行时按 **profile + bundle + patch** 组装，不改源码也能换能力。

四个预置模式特别值得学：

| 模式 | 模型看见什么 | 用途 |
| --- | --- | --- |
| Minimal | 持久 bash + `str_replace_editor` | 评模型，而不是评「堆了多少工具」 |
| Standard | 完整编码工具 + skills + plan + subagent | 日常产品 |
| Code Mode | Standard 的工具，改成生成一段 TypeScript，一次跑完多步 | 降低 round-trip |
| Creator | Standard + 运行时自省，现场拼新 preset | 给 harness 开发者用 |

另外几条原则可以直接当设计约束：

- **模型可见 ≡ 已落盘**。session 是 append-only 事件流；resume / fork / replay 都读同一条日志。
- **Host plane vs Agent plane**。沙箱、审批、持久化、模型路由属于宿主；某个 session 的工具目录属于 agent preset，必须 `isolate`，否则两个会话抢单例。
- **Turn / Step 事件可拦截**。`pre-step`、`tools/pre-execute` 做成 waterfall，策略和观测挂在缝上，而不是写进 loop 的 if/else。

**不要抄**：第一天就上「Everything is a plugin」。dsh 的插件树是演进结果；过早抽象会让 loop、权限、日志三个不变量被拆散。我们先把这三件事做硬，再把可替换点收成 plugin。

### 1.3 Devin：长程任务 + 多模型 harness

Devin 卖的是「自主软件工程师」，公开架构里真正硬的是这几件：

1. **环境是一台 VM**，不是编辑器缓冲区。Workspace 暴露 shell、IDE、浏览器三件套。能测、能点 UI、能查文档，闭环才成立。
2. **计划是结构化状态**，不是聊天里的一段 Markdown。Planner 产出带成功标准的步骤；Executor 只看当前步骤和最新观测；失败则重规划。计划可做成 DAG，可并行的不要串行。
3. **Knowledge 是跨会话记忆**，而且偏策展：README、规则、用户明确写入的约定。不是把上次的 200k 轨迹塞回去。
4. **Fusion**：前沿模型当 Lead（计划、歧义、终审），便宜模型当 Sidekick（探索、实现、跑测）。两边 **各自维护可缓存的 context**，只交换 brief / result / feedback，不交换完整 transcript。Cognition 强调 2026 年该看的是 **price per task**，不是 price per token。
5. **沙箱一次性，知识才持久**。每次 run 新 VM，防止「上一次改坏了全局环境」。

**可抄**：计划对象化、Lead/Sidekick、知识库与轨迹分离、浏览器作为一等工具。
**不要抄**：第一期就做完整云端 IDE + 计费 ACU + 企业知识网络。那是产品公司，不是 harness 的 MVP。

### 1.4 Claude Code：loop 极简，外围才是产品

公开源码分析（2026）把 Claude Code 概括成：**一个 while 循环调模型、跑工具；绝大多数代码在 loop 周围**。

外围系统比 loop 更值得对标：

| 子系统 | 要点 |
| --- | --- |
| 权限 | 多模式 + 分类器；危险动作可拦 |
| 压缩 | 多层 compaction，而不是「超了就摘要一次」 |
| Skills | 渐进披露：启动只加载 name/description，正文按需 |
| Hooks | `PreToolUse` / `PostToolUse` / `Stop` / `SessionStart`… 确定性回调 |
| Subagent | 独立 context，只把终局摘要交回父 Agent |
| 存储 | 只追加的 session |

这套东西回答了一个问题：模型变聪明以后，harness 还做什么？答案是 **权限、压缩、扩展、隔离噪音**，而不是再写一套更重的工作流引擎。

### 1.5 Cursor Cloud Agents：环境、耐久、以及「学会让开」

Cursor 把 Cloud Agent 从「把本地 loop 搬到服务器」进化成一层操作系统。公开教训里有四条对我们直接有用：

1. **开发环境就是产品。** 云上质量崩掉，常常不是模型变笨，而是依赖、密钥、网络、测试命令没对齐本地。要有 snapshot / restore / fork，以及给 Agent 和人类看同一份环境的通道。
2. **长任务需要耐久执行。** 自研 work-stealing 只有一个 9；迁到 Temporal 之后过两个 9。Loop 必须能活过推理中断、Pod 替换、休眠唤醒。
3. **Loop、机器、会话三分离。** 子 Agent 可以比父 Agent 活得更久，也可以跑在不同类型的机器上。会话流还要能 rewind：step 失败重试时，客户端不能把半截流式输出和重试结果叠在一起。
4. **随着模型变强，把确定性逻辑从 harness 里拿掉。** 以前 harness 强制 commit/push、自己去拉 CI 日志；现在改成给 Agent `gh` 和大文件落盘搜索。Harness 留下的是模型还干不好的脚手架（例如 computer use 子 Agent）。

云端 prompt 也和本地不同：更鼓励自主，因为停下来等人审批的代价是小时级。

### 1.6 OpenHands / SWE-agent：先把「手」设计对

SWE-agent 提出 **ACI（Agent-Computer Interface）**：不是把 Linux 原样交给模型，而是给一套为模型手感调过的动作。

被验证过的细节：

- 搜索结果要短（命中文件列表，而不是每处上下文）
- 文件查看器按窗口（约 100 行），不要 `cat` 整文件
- 编辑失败要拒绝并回显邻域；可以接 linter
- 空输出要说「成功但无输出」，不要空白
- 旧 observation 折叠，只留最近几步细节

OpenHands 把这套做成模型无关的 Software Agent SDK：Agent / Conversation / Tool / Workspace，Docker 运行时，评测并行。它是目前开源世界里最接近「生产 + 评测」一体的参照实现。

**可抄**：工具反馈的形状比工具数量更重要；评测从第一天就进仓库。

### 1.7 能力矩阵

| 维度 | Codex / ChatGPT | DeepSeek Harness | Devin | Claude Code | Cursor Cloud | OpenHands | **我们 v1 目标** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 核心 loop | Thread/Turn/Item | Session/Turn/Step + 插件 | Plan/Exec + Fusion | while + tools | Temporal 上的 turn | Event/Conversation | Thread/Turn/Item，无插件内核 |
| 多表面 | App Server | profile: web/sdk/headless | Web + Desktop + CLI | CLI + Desktop | IDE + Cloud + 远程 | CLI + Cloud + SDK | Protocol 先行：exec + TUI + SDK |
| 工具面 | shell/plan/MCP | 可组合；Minimal 两件套 | shell+IDE+browser | 读写搜 + bash + Agent | 编辑器工具 + VM + computer use | ACI + browser | 精简 ACI；MCP 可插 |
| 上下文 | 前缀缓存 + 官方 compaction | 日志投影；模式可关压缩 | 计划对象 + Knowledge | 多层压缩 + Skills | 会话存储与流式 rewind | observation 折叠 | 前缀稳定 + 结构化压缩 + Skills |
| 沙箱 | 内核级 | provider 可换 | 一次性 VM | 应用层 hooks | 独立 VM + 网络策略 | Docker | 本地 kernel / 评测 Docker / 云 VM 接口 |
| 多 Agent | spawn/wait | Agent Teams（实验） | Lead + Sidekick | Subagent | 父子可跨机器 | 并行委托 | `delegate` 子 Agent；Fusion 放 v2 |
| 扩展 | MCP, AGENTS.md, skills | Cordis plugin | Knowledge, skills | Skills/Hooks/MCP | rules/skills/hooks | skills/MCP | AGENTS.md + SKILL.md + hooks + MCP |
| 评测 | 内部 + 开源仓库 | Minimal 就是为评测存在 | FrontierCode | 内部 | 内部 + artifact | SWE-bench 一等公民 | Minimal + 内部黄金集 + 公开榜可选 |
| 开源 | Apache harness | 源码预览 | 闭源 | 部分 | 闭源 | MIT | 默认内部开源，接口按可公开设计 |

---

## 2. 从对标抽出的设计原则

1. **Loop 保持笨，周边保持硬。** 再聪明的编排也只是「推理 ↔ 工具」循环。差异化在工具形状、上下文、权限、耐久。
2. **模型可见的必须可回放。** 系统提示、注入、截断、审批结果全部进 append-only log。
3. **前缀稳定性高于「把 prompt 写得漂亮」。** 为了 cache，指令分段顺序要冻结。
4. **工具少而稳，反馈短而准。** 先 bash + 编辑器打基线，再加 grep/read/plan。每一个新工具都要有评测证明它涨分。
5. **执行面可替换，schema 不可乱变。** Local / Docker / VM 是 provider；模型看见的工具名保持稳定。
6. **协议先行于 UI。** 没有 App Server，就没有第二个表面，只会复制粘贴 loop。
7. **环境是正确性的一部分。** 跑不出测试的 Agent 看起来像模型不行。
8. **先信任边界，后信任模型。** 沙箱和审批是默认；随着评测变好再扩大 auto。
9. **随着模型变强做减法。** 能变成工具的，不要写成 harness 硬编码工作流。
10. **评测是功能，不是上线前的脚本。** Minimal 模式永久保留。

---

## 3. 产品形态：我们做运行时，不做又一个 IDE

### 3.1 定位

```text
┌─────────────────────────────────────────────────────────┐
│  内部场景：修 bug、写功能、CR、跑 CI 失败修复、迁移     │
│  外部形态（可选）：CLI 产品 / 企业私有 Agent 平台       │
└─────────────────────────────────────────────────────────┘
                         ▲
                         │ JSON-RPC
┌─────────────────────────────────────────────────────────┐
│  Harness Core  ← 本仓库的全部意义                       │
└─────────────────────────────────────────────────────────┘
                         ▲
          OpenAI / Anthropic / DeepSeek / 自建模型
```

v1 交付物是：

- `harness exec`：CI 和无头任务
- `harness` TUI：本地交互
- App Server + TS SDK：给未来 IDE / Web 用
- `eval/`：可复现对比

v1 **明确不做**：VS Code fork、自研浏览器 IDE、自动按小时计费、通用个人助理、非编码 Agent 平台。

### 3.2 用户任务分层（决定 loop 策略）

| 层 | 例子 | 策略 |
| --- | --- | --- |
| L1 单步 | 解释函数、改一行 | 无计划，少工具 |
| L2 闭环 | 修测试、加小功能 | Standard 工具 + 跑测 |
| L3 长程 | 跨模块重构、迁移 | `update_plan` + 子 Agent + 中途 compact |
| L4 异步云 | 开 PR、修 CI、过夜任务 | 高自主 prompt + 耐久执行 + artifact |

v1 打穿 L1–L2，做出 L3 的骨架（计划、压缩、delegate）。L4 只定义接口和 Docker/VM provider，不自建机房。

---

## 4. 目标架构

详见 [架构草图](./architecture.md)。这里只冻结决策。

### 4.1 六层

| 层 | 职责 | 对标 |
| --- | --- | --- |
| Surfaces | TUI / exec / 未来 IDE | Codex 多客户端 |
| Protocol | JSON-RPC App Server | Codex App Server、dsh sdk profile |
| Core Loop | Thread/Turn/Step、inbox、中断 | 各家共核 |
| Context | 组装、cache、compact、skills | Codex 前缀 + Claude Skills |
| Tools / Policy | ACI、hooks、审批、MCP | SWE-agent + Claude hooks |
| Runtime | FS/Shell/Sandbox/Browser | Cursor env + Devin VM |

### 4.2 模型适配

```text
LLM Adapter
  chat(messages, tools, stream) -> Stream<Event>
  countTokens / maxContext
  compactHint?          # 有官方 compaction 就用，没有就走本地摘要
```

路由策略分三期：

| 期 | 策略 |
| --- | --- |
| v1 | 单模型，配置指定 |
| v1.5 | 按任务类型静态路由：轻模型做 grep/探索，强模型做终局编辑（仍共享一段 history，注意 cache miss） |
| v2 | Fusion：Lead / Sidekick **两段独立 session**，只传 brief/result |

不要在 v1 做「每个 step 换模型」。那会把 cache 打穿，表面上省单价，任务总价更高。

### 4.3 计划与记忆

- **Plan**：`update_plan` 把步骤写成 JSON（id、目标、成功标准、状态）。存在 session 投影里，每步开始时再塞回 prompt 的固定位置。
- **Working memory**：就是 session log。不另搞向量库当主记忆。
- **Knowledge（v1.5）**：`AGENTS.md` + 可选 `knowledge/*.md`，按路径检索注入。用户显式写入的约定优先于模型总结。
- **Trajectory store（评测）**：每次 `exec` 导出完整 jsonl，供 diff 两个模型/两个工具面。

### 4.4 安全模型

三层，缺一不可：

1. **OS / 容器边界**：能做的系统调用和能碰的路径
2. **Policy**：工具级规则（禁 `rm -rf /`、禁读 `.env`、出网白名单）
3. **Approval**：模型申请提权时，客户端 RPC 暂停

再加 hooks，让企业把「禁令」写成脚本，而不是 fork harness。

密钥：Agent 环境给最小权限 token；推理 API key 不准进 sandbox。这条与 OpenAI Agents 的 self-hosted executor 相同。

---

## 5. 与「直接用开源 harness」的取舍

可以 fork 的东西很多：`openai/codex`、`deepseek-ai/deepseek-harness`、OpenHands SDK。自研仍然合理，如果下面至少三条成立：

1. 需要 **模型中立** 且能改 loop / compaction / 工具形状（Codex 绑 Responses 生态，Claude 绑自家模型）。
2. 需要 **代码和轨迹不出域**，审批和审计策略是自己的。
3. 需要把 harness 当成内部平台：接自己的仓库规范、构建系统、评测集、IM。
4. 长期要做 Fusion、私有模型、特定语言工程（例如超大 Maven 单体）的深度优化。

建议的务实路径：

- **协议和对象模型自己定义**（Thread/Turn/Item + JSON-RPC）
- **工具语义大量参考** SWE-agent / Claude / Codex 已验证的 ACI
- **实现不从零发明沙箱**：本地用现有 OS 机制，云用 Docker / 现成 microVM
- **评测跑别人的题，也跑自己的题**

不建议把 dsh 或 Codex 整仓 fork 当主线：上游迭代极快，插件框架会变成我们的税。把它们当对照实现，每周 diff 一次关键模块。

---

## 6. 分期路线

不按日历估工期，按 **可演示的能力切片**。每一期结束都必须能跑评测，而不是「架构更完整了」。

### P0 — 规格与黄金任务（先于代码）

- 冻结 Thread/Turn/Item 事件 schema
- 写 20 个内部任务：修测试、改 API、加日志、重构小模块、看报错修 CI
- 准备 3 个 fixture 仓库（小 Python、小 TS、一个真实内部仓的精简切片）
- 定义 Minimal vs Standard 的计分板：resolve rate、步数、token、墙钟、是否越权

**完成标准**：新同学能靠文档实现一个假 loop（固定回复）并把 jsonl 跑进计分板。

### P1 — Minimal 能干活

- Agent loop + jsonl session
- 工具：持久 `bash`、`str_replace`/`write_file`
- `harness exec` 无头跑完一个「修失败测试」
- 一个 LLM adapter（先 OpenAI compatible，便于接 DeepSeek / vLLM）
- 本地 cwd 执行，尚可无沙箱，但必须有 workspace 路径约束

**完成标准**：Minimal 在 fixture 上稳定可复现；换模型只改配置。

### P2 — Standard 编码 Agent

- 补 `read_file` / `grep` / `glob` / `update_plan`
- `AGENTS.md` 组装、observation 截断、空输出提示
- 基础 compaction（超阈摘要旧 observation，保留计划与最近 N 步）
- TUI：流式输出、diff、中断
- 审批：写工作区外、跑网络，默认问一次

**完成标准**：Standard 在同一黄金集上显著高于 Minimal（步数下降或 resolve 上升）。否则工具加错了。

### P3 — 协议与多表面

- App Server JSON-RPC
- TS SDK；`exec` 和 TUI 都改成 client
- resume / fork
- MCP 客户端（只读或显式白名单）

**完成标准**：用 SDK 写一个 50 行的「修测试」脚本，不 import core。

### P4 — Runtime 升级

- Docker provider，评测隔离
- Linux Landlock/seccomp 或最小 seccomp profile
- Skills（`SKILL.md` 渐进披露）
- Hooks（至少 PreToolUse / PostToolUse / Stop）
- `delegate` 子 Agent（同步，独立 thread，回传摘要）

**完成标准**：同一任务在 Local 与 Docker 轨迹结构一致；hooks 能拦住一条禁令。

### P5 — 云与长程

- CloudVM / RemoteWorker 接口
- 会话与机器分离；休眠/恢复
- Git 工具：branch、commit、PR；CI 日志落盘
- Artifact：测试输出、截图（若有 browser）
- 耐久：先用简单的 step checkpoint + 重试；规模上来再引 Temporal 一类系统

**完成标准**：断开客户端后任务继续；重连能 rewind 到正确 item。

### P6 — Fusion 与平台化

- Lead / Sidekick 双 session
- Knowledge 库
- Browser / computer use 作为独立 subagent
- Creator 式 preset（到这时再做插件化）
- 企业：审计、SSO、网络策略、密钥注入

---

## 7. 评测设计

没有评测的 harness 只能靠感觉调 prompt，最后变成不可维护的 system prompt 博物馆。

### 7.1 三层题库

| 层 | 来源 | 作用 |
| --- | --- | --- |
| 内部黄金集 | 真实工单脱敏 | 优化对象，回归门禁 |
| Fixture | 仓库内造的小项目 | 快速 CI |
| 公开榜 | SWE-bench Verified、Terminal-Bench、自选 | 对外沟通，防自我欺骗 |

### 7.2 必报指标

- Resolve / Fail / Loop（步数打满）
- 平均步数、平均 tool 失败次数
- 输入/输出 token、cache hit rate
- 墙钟时间
- 越权次数（读了工作区外、打了未授权网）
- 人工抽检：diff 质量、是否乱改无关文件

对比实验固定三组：`model × {minimal, standard}`、`standard × {model A, model B}`、`standard × {有无 AGENTS.md}`。

### 7.3 轨迹是一等资产

每次 run 保存：配置哈希、模型版本、完整 jsonl、最终 diff、测试日志。调工具或 prompt 必须能回答：「黄金集上哪几题坏了」。

---

## 8. 技术选型（建议，可在 P0 拍板）

| 问题 | 建议 | 备选 | 理由 |
| --- | --- | --- | --- |
| 主语言 | TypeScript | Rust core | P1–P4 要改协议和工具形状，TS 更快；Rust 留给 sandbox executor |
| 包管理 | pnpm workspace | — | 与多数 TS monorepo 一致 |
| LLM 协议 | Chat Completions tools + 适配器 | 只上 Responses | 要接 DeepSeek / 国产 / 自建；Responses 特性用 adapter 包一层 |
| 会话存储 | JSONL 文件 | SQLite | 人类可读、易 diff、易 fork；量上来再加索引 |
| TUI | 自绘精简 或 Ink | 全功能 IDE | P2 够用 |
| 沙箱 | Docker（评测）+ 路径策略（本地） | 一上来 microVM | 先可跑，P4 再加固 |
| 前端协议 | JSON-RPC JSONL | 自研 frame | 已有 Codex / dsh / MCP 同构，减少发明 |
| 耐久编排 | P5 再定 | Temporal | Cursor 的教训，但 P1 引入是过度设计 |

---

## 9. 风险

| 风险 | 表现 | 缓解 |
| --- | --- | --- |
| 做成「提示词 + 聊天框」 | 无法无头跑、无法评测 | exec + jsonl 作为第一客户端 |
| 工具膨胀 | 模型乱选工具，token 涨、分不涨 | 新工具必须带 A/B |
| 过早插件化 | 没人能讲清 turn 生命周期 | P6 之前只留 hooks / adapter 两个扩展点 |
| 绑定单一模型 | 议价权和稳定性归供应商 | 三家适配器进 CI |
| 忽略环境 | 「模型不行」的误诊 | fixture 必须能在 Docker 内复现测试 |
| 安全事件 | Agent 读密钥、扫内网 | 默认无网、密钥不进 sandbox、hooks 审计 |
| Cache 被写 prompt 的人破坏 | 成本翻倍 | 组装顺序单测冻结；禁止在 history 中间插入系统段 |
| 对标变成抄产品 | 人力散到 IDE、计费、市场功能 | 本文非目标清单每季度重读 |

---

## 10. 建议立即拍板的问题

1. **主战场**：内部提效平台，还是要做可分发的开源/商业 CLI？
2. **默认模型**：P1 先接哪一家（建议 OpenAI compatible，方便同时打 DeepSeek 与自建）。
3. **第一批黄金任务**来自哪几条真实业务线。
4. **代码是否需要不出域**（决定自托管推理还是 API）。
5. **P1 是否必须 Docker**（若目标仓库构建很重，建议 P1 就 Docker，避免「本机能跑、评测机跑不了」）。

这五个问题不回答，也可以开工 P0 schema 和 fixture；但不要平行开工 TUI、云端、插件市场。

---

## 11. 附录：核心循环伪代码

```ts
async function runTurn(thread: Thread, input: UserInput): Promise<Turn> {
  thread.inbox.push(input)
  const turn = thread.beginTurn()
  while (true) {
    const claimed = thread.claimInbox()
    if (!claimed && !turn.toolsOutstanding()) {
      turn.close()
      return turn
    }
    const prompt = assemble(thread)          // 顺序冻结，见 architecture.md
    const stream = await llm.chat(prompt, thread.toolSchemas())
    const item = await consume(stream)       // 写入 jsonl：reasoning / text / calls
    if (item.functionCalls.length === 0) {
      turn.emitAssistant(item)
      if (thread.inboxEmpty()) {
        turn.close()
        return turn
      }
      continue
    }
    for (const call of item.functionCalls) {
      const decision = await policy.check(call)
      if (decision === "ask") await client.approval(call)
      const raw = await tools.execute(call, thread.runtime)
      const obs = truncate(raw)              // 大输出落盘
      thread.appendToolResult(call.id, obs)  // 只追加，保持前缀
    }
    if (needCompact(thread)) compact(thread) // 只在这里允许打断前缀
  }
}
```

---

## 12. 参考（公开材料）

- OpenAI, *Unrolling the Codex agent loop*；*Unlocking the Codex harness*；*Codex as a platform*；*Introducing the Agents API*
- OpenAI Codex 开源仓库与 App Server 协议
- DeepSeek, *Harness developer preview*；DeepSeek Harness Architecture / Cordis primer
- Cognition, *Devin Fusion*；*Introducing Fusion in Devin Desktop & CLI*
- Cursor, *What we’ve learned building cloud agents*
- Anthropic Claude Code Agent SDK；公开架构分析 *Dive into Claude Code*
- SWE-agent: *Agent-Computer Interfaces Enable Automated Software Engineering*
- OpenHands Software Agent SDK

对标会过时，原则不过时：**笨 loop、硬日志、稳前缀、少工具、可替换执行面、评测进主仓。**
