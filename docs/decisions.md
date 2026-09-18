# 已确认的方案

把讨论收成一份可开工的决策。未列入本节的细节（TUI 像素、云厂商）不算阻塞。

**状态：P18 follow-up 队列切片可启动。** 方案以本节为准。

---

## 1. 我们在做什么

做一个 **Coding Agent 运行时**：让模型在真实仓库里动手改代码、跑检查、用插件扩展、用轨迹回放。

```text
模型            脑子（DeepSeek / GPT / Claude / 自建，可换）
Agent 运行时    本仓库要做的主进程
执行运行时      工具跑在哪：先本机，再 Docker，云 VM 同一接口后补
插件            项目能力（测、工单、MCP），不 fork 源码
轨迹            黑匣子：能看、能 replay、能评测
```

现在有可启动的本地运行时：组合内核、worktree、ACI、轨迹、steer/undo、项目插件、App Server / SDK、MCP、traj diff/fork、Docker 执行面、本地 sandbox、delegate、plugin add、WorkerHub 断线续跑、gh PR / CI artifact、unattended 审批、Fusion Lead/Sidekick（两段 session，可各指定模型）、Knowledge 目录、browser 合同失败闭合、轨迹 baseline 库、TUI 第一视口（含当前工具行与 follow-up 队列）、approval reverse RPC、prompt 前缀/轨迹完整性、plugin enable/disable 与 command kind、同线程 `/ask|/plan|/agent`、`@path` 与粘贴附件、可编辑结构化计划、`plan/skip`、adapter 插件替换 `ctx.llm`、`profiles/eval.yml` 与 `harness eval --task` / `--dir`、Harness 榜 scorecard、`/stop` 打断并杀掉 in-flight 命令、同 step 只读并行、失败检查 nudge、大输出落盘、分层 AGENTS.md、skill 目录不倾正文且 `read_skill` 按需、轨迹脱敏与 `env_hash`、apply 冲突 abort、compaction 保留计划/检查、写入后 live diff、可读审批卡片、`/resume`、`/check`、全局 `config.yml`（含 `language`）、bash 记住 cwd、`[a] always` 写入 `allow:`、TUI `tok=` / `cache=`、LLM 与 bash 流式 `item/delta`、`harness config` / `/yolo` / `/lang`、本地 plugin catalog、IDE 桥。远程插件市场与编辑器分叉仍不做。

日常验收路径：

```text
cd <repo> && harness
> 把失败的登录测试修了，不要动别的模块
# worktree 隔离 → 可打断转向 → 有测试输出 → /undo 或 /apply → traj show
```

---

## 2. 已拍板

| # | 决策 | 说明 |
| --- | --- | --- |
| D1 | 产品是运行时，不是 IDE | TUI + exec + 协议；IDE 只做桥（`ide/open`、`extensions/vscode`），**不分叉编辑器** |
| D2 | 默认好用 | Agent 模式、git worktree、少问、Done Report、steer/undo/apply |
| D3 | 模型可换 | v1 走 OpenAI compatible；热路径单模型；Fusion Lead/Sidekick 两段 session 可各指定模型 |
| D4 | 组合内核对齐 **Cordis** | Context、Service、inject、可逆注册、Loader、isolate。自己实现，不 vendor dsh |
| D5 | 官方 loop 是驱动插件 | `@harness/agent-loop` 契约冻结，版本进 plugin_lock；第三方只挂拦截，不换循环 |
| D6 | Profile 是组合不是 if | `minimal` 评模型；`standard` 给人用 |
| D7 | 插件一等 | tool / skill / hook / mcp / command / adapter；本地 catalog 商店；无远程计费市场 |
| D8 | 轨迹一等 | 模型可见 ≡ 可回放；export / dry replay 进 v1 |
| D9 | 执行面可换 | 工具不直连 `child_process`；local 先，docker 评测 |
| D10 | **不引入 Spring** | 只学习其注入理念（依赖声明、隔离实例、卸载干净、横切集中）。笔记见附录，不进 API |

## 3. 明确不做（v1）

- 编辑器分叉、远程插件市场、热路径切模型、自建机房
- 把 loop 契约交给第三方
- 引入 Spring / 引入 DeepSeek Harness 源码
- 把 Minimal 两件套当成日常产品
- 默认 in-place 改用户脏工作区

## 4. 实现顺序（设计已齐，代码按此切）

| 切片 | 交出 |
| --- | --- |
| P0 | schema、假进程、脏树 fixture、composition YAML |
| P1 | 第一个真运行时：TUI 修通测试 + worktree + 写轨迹 |
| P2 | dogfood：steer/undo、审批记忆、项目插件、dry replay |
| P3 | App Server / SDK、MCP、traj diff |
| P4 | Docker 执行面、delegate 子轨迹 |
| P5 | 云 VM / RemoteWorker、断线续跑、gh PR |
| P6 | Fusion Lead/Sidekick、Knowledge、browser 合同、traj baseline；不回头改 D1–D10 |
| P7 | TUI 第一视口、approval reverse RPC、prompt 完整性、plugin enable/command、U1–U12 清单 |
| P8 | 同线程 mode 切换、`@path` 附件、`plan/set`、adapter kind、eval profile、U10 卡住说人话 |
| P9 | `/stop` 打断并杀命令、TUI undo/apply/plugins/traj、同 step 只读并行、失败检查 nudge、bash artifact |
| P10 | 分层 AGENTS.md、skill catalog-on-demand、粘贴 diff/报错附件、轨迹脱敏与 `env_hash`、apply 冲突 abort、`plan/skip` |
| P11 | `read_skill` 按需加载正文、compaction 保留计划/检查/Done Report、写入后 `diff/updated` live diff |
| P12 | 可读审批（命令/cwd/本次·本线程）、TUI `/resume` `/check`、`~/.harness/config.yml`、bash 持久 cwd |
| P13 | `[a] always` 写入 `config.yml` `allow:`、跨线程记住；TUI `tok=` / `cache=`；轨迹 `llm/usage` |
| P14 | LLM token 与 bash stdout 流式 `item/delta`（append）；TUI 直播行；轨迹仍记完整 step |
| P15 | `config/get` `config/set`；`harness config`；TUI `/config` `/yolo` 写 `config.yml` |
| P16 | `harness eval --dir` 跑黄金任务；`eval/score` 从轨迹打出 §6 Harness 榜；协议 0.16.0 |
| P17 | TUI 当前工具行；`language`；本地 plugin catalog；Fusion 双模型 session；IDE 桥（不分叉） |
| P18 | TUI follow-up 队列；`inbox/updated`；无 tool 时 inbox 续跑本轮；REPL 输入不阻塞 |

## 5. 文档

| 文档 | 用途 |
| --- | --- |
| 本文 | **已确认决策**，改这里等于改立项 |
| [技术方案](./tech-proposal.md) | 规格全文 |
| [架构草图](./architecture.md) | 接口与目录 |
| [Spring 对照笔记](./di-and-composition.md) | 学习用，不约束实现 |
