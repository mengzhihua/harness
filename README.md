# Harness

自研 Coding Agent Harness。目标不是再做一个能跑 tool call 的聊天框，而是做出 **开发者愿意每天拿来改自己代码** 的运行时。

同一套 Core 驱动 TUI、`exec`、未来的 IDE / Cloud。模型可换，手感不能换。

> 当前阶段：技术方案。实现尚未开始。

## 好用，就是产品

一个 harness 好不好用，不看架构图全不全，看这五件事是否成立：

1. 打开仓库就能干活，不用先写三页配置
2. 不弄脏我正在改的代码
3. 随时能打断、转向、回退
4. 改完能证明（测试 / lint / 复现），不是口头「修好了」
5. 同样的活，比裸聊模型更快、更稳、更好审

细节见 [技术方案](docs/tech-proposal.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [技术方案](docs/tech-proposal.md) | 好用规格、对标、架构取舍、分期 |
| [架构草图](docs/architecture.md) | 分层、协议、工作区、核心循环 |

## 非目标（v1）

- 不做 Cursor 式 IDE 分叉
- 不绑定单一模型供应商
- 不从「Everything is a plugin」起步
- 不把评测基线（Minimal 两件套）当成日常产品
