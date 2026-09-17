# Harness

自研 Coding Agent 运行时：模型在真实仓库里改代码、跑检查、用插件扩展、用轨迹回放。

> **P3 协议切片可启动。** 决策以 [docs/decisions.md](docs/decisions.md) 为准。组合内核对齐 Cordis；Spring 只作理念对照。

## 试用

```bash
pnpm install
pnpm test
pnpm harness exec --model mock --cwd eval/fixtures/login \
  --prompt "把失败的登录测试修了，不要动别的模块"
pnpm harness traj show --source tool
pnpm harness traj replay --dry
pnpm harness threads
pnpm harness serve   # JSON-RPC stdio App Server；exec/REPL 是它的 client
```

默认在 git worktree 里改文件，不碰你当前工作区的脏文件。修对了再 `harness apply`。不对就 `harness undo`。

项目插件放在 `.harness/plugins/*/plugin.json`（skill / hook）。REPL：`/ask` `/plan` `/agent` `/steer` `/plugins` `/undo` `/apply`。

无 API key 时用 `--model mock`（内置脚本模型，能修 login fixture）。接真模型：

```bash
export OPENAI_API_KEY=...
# 可选 OPENAI_BASE_URL=https://api.openai.com/v1
pnpm harness exec --model gpt-4o-mini --prompt "..."
```

进仓库根目录直接 `pnpm harness` 进入 REPL（`/ask` `/plan` `/agent` `/steer` `/plugins` `/traj` `/apply` `/undo` `/quit`）。

## 文档

| 文档 | 用途 |
| --- | --- |
| [已确认决策](docs/decisions.md) | 立项拍板，改这里等于改方案 |
| [技术方案](docs/tech-proposal.md) | 规格全文 |
| [架构草图](docs/architecture.md) | 接口与目录 |
| [Spring 对照笔记](docs/di-and-composition.md) | 学习注入理念，**不引入、不约束实现** |

## 一句话

默认 `harness` 进仓库就能干活：worktree 隔离、可打断、有测试证据、插件能加、轨迹能回放。
