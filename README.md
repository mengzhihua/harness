# Harness

自研 Coding Agent Harness。目标是做出一套 **模型无关、可评测、可本地可云端** 的软件工程 Agent 运行时：同一套 Core Loop 驱动 CLI、IDE、Cloud、CI。

> 当前阶段：技术方案。实现尚未开始。

## 文档

| 文档 | 内容 |
| --- | --- |
| [技术方案](docs/tech-proposal.md) | 对标 DeepSeek / Codex / ChatGPT / Devin / Claude Code / Cursor / OpenHands，给出能力矩阵、架构、分期路线 |
| [架构草图](docs/architecture.md) | 分层、协议、目录、核心循环的实现级草图 |

## 我们要做什么

Harness 不是模型，也不是聊天 UI。它是把 LLM 变成能干活的软件工程师所需的那一层：

1. **Agent Loop**：Turn / Step / Tool 循环、中断、恢复
2. **ACI**：面向模型的工具面（读、搜、改、跑、浏览器、MCP）
3. **Context**：前缀稳定缓存、压缩、Skills 渐进披露、会话日志
4. **Runtime**：沙箱、审批、工作区、环境快照
5. **Protocol**：一份 JSON-RPC，多种客户端
6. **Eval**：Minimal 模式 + 内部黄金任务 + SWE-bench / Terminal-Bench

## 非目标（v1）

- 不做 Cursor 式 IDE 分叉
- 不绑定单一模型供应商
- 不在第一期做完整的 Devin 式「全自主软件工程师」产品
- 不从「Everything is a plugin」起步（插件系统是后期，不是地基）
