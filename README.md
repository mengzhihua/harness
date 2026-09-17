# Harness

自研 Coding Agent 运行时：模型在真实仓库里改代码、跑检查、用插件扩展、用轨迹回放。

> **方案已确认，实现未开始。** 决策以 [docs/decisions.md](docs/decisions.md) 为准。

## 文档

| 文档 | 用途 |
| --- | --- |
| [已确认决策](docs/decisions.md) | 立项拍板，改这里等于改方案 |
| [技术方案](docs/tech-proposal.md) | 规格全文 |
| [架构草图](docs/architecture.md) | 接口与目录 |
| [Spring 对照笔记](docs/di-and-composition.md) | 学习注入理念，**不引入、不约束实现** |

## 一句话

默认 `harness` 进仓库就能干活：worktree 隔离、可打断、有测试证据、插件能加、轨迹能回放。组合内核对齐 Cordis。Spring 只作理念对照。
