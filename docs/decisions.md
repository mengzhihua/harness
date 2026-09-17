# 已确认的方案

把讨论收成一份可开工的决策。未列入本节的细节（TUI 像素、云厂商）不算阻塞。

**状态：P5 云 worker 切片可启动。** 方案以本节为准。

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

现在有可启动的本地运行时：组合内核、worktree、ACI、轨迹、steer/undo、项目插件、App Server / SDK、MCP、traj diff/fork、Docker 执行面、本地 sandbox、delegate、plugin add、WorkerHub 断线续跑、gh PR / CI artifact、unattended 审批。P6 起补 Fusion。

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
| D1 | 产品是运行时，不是 IDE | TUI + exec + 协议；不做编辑器分叉 |
| D2 | 默认好用 | Agent 模式、git worktree、少问、Done Report、steer/undo/apply |
| D3 | 模型可换 | v1 走 OpenAI compatible；单模型；不热路径切模型 |
| D4 | 组合内核对齐 **Cordis** | Context、Service、inject、可逆注册、Loader、isolate。自己实现，不 vendor dsh |
| D5 | 官方 loop 是驱动插件 | `@harness/agent-loop` 契约冻结，版本进 plugin_lock；第三方只挂拦截，不换循环 |
| D6 | Profile 是组合不是 if | `minimal` 评模型；`standard` 给人用 |
| D7 | 插件一等 | tool / skill / hook / mcp / command / adapter；v1 无商店 |
| D8 | 轨迹一等 | 模型可见 ≡ 可回放；export / dry replay 进 v1 |
| D9 | 执行面可换 | 工具不直连 `child_process`；local 先，docker 评测 |
| D10 | **不引入 Spring** | 只学习其注入理念（依赖声明、隔离实例、卸载干净、横切集中）。笔记见附录，不进 API |

## 3. 明确不做（v1）

- IDE 分叉、插件商店、Fusion 双模型、自建机房
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
| P6+ | Fusion，不回头改 D1–D10 |

## 5. 文档

| 文档 | 用途 |
| --- | --- |
| 本文 | **已确认决策**，改这里等于改立项 |
| [技术方案](./tech-proposal.md) | 规格全文 |
| [架构草图](./architecture.md) | 接口与目录 |
| [Spring 对照笔记](./di-and-composition.md) | 学习用，不约束实现 |
