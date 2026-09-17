# Harness

自研 Coding Agent Harness。目标不是再做一个能跑 tool call 的聊天框，而是做出 **开发者愿意每天拿来改自己代码** 的运行时。

同一套 Core 驱动 TUI、`exec`、未来的 IDE / Cloud。模型可换，手感不能换。

> 当前阶段：技术方案。实现尚未开始。运行时内核按 **Cordis 组合模型** 设计（Context / Service / Event / Isolate），不 vendor DeepSeek 源码。

## 好用，就是产品

一个 harness 好不好用，不看架构图全不全，看这些事是否成立：

1. 打开仓库就能干活，不用先写三页配置
2. 不弄脏我正在改的代码
3. 随时能打断、转向、回退
4. 改完能证明（测试 / lint / 复现），不是口头「修好了」
5. 同样的活，比裸聊模型更快、更稳、更好审
6. 项目能力用插件加，不改 harness 源码
7. 每次跑都留下可回放、可对比、可评测的轨迹

细节见 [技术方案](docs/tech-proposal.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [技术方案](docs/tech-proposal.md) | 好用规格、**Cordis 组合内核**、插件、轨迹、分期 |
| [架构草图](docs/architecture.md) | Context/Loader、协议、工作区、轨迹 |

## 非目标（v1）

- 不做 Cursor 式 IDE 分叉
- 不绑定单一模型供应商
- 不把 **loop 契约** 交给第三方插件乱改（官方 `@harness/agent-loop` 是唯一默认驱动，版本锁进轨迹）
- 不直接依赖 DeepSeek Harness 源码；组合内核 **语义对齐 Cordis**，自己实现
- 不把评测基线（Minimal 两件套）当成日常产品
- 第一期不做插件市场 / 商店，但本地与仓库内插件必须能用
