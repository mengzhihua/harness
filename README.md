# Harness

自研 Coding Agent 运行时：模型在真实仓库里改代码、跑检查、用插件扩展、用轨迹回放。

> **P6 Fusion 切片可启动。** 决策以 [docs/decisions.md](docs/decisions.md) 为准。组合内核对齐 Cordis；Spring 只作理念对照。

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
pnpm harness plugin add ./path-or-git
pnpm harness exec --exec docker --prompt "..."   # 无 docker 时 bash 失败闭合
pnpm harness exec --unattended --detach --prompt "..."  # worker 继续跑，回来仍是同一 traj id
pnpm harness pr --title "fix login"
pnpm harness ci
pnpm harness fusion --prompt "把失败的登录测试修了"
pnpm harness knowledge add --title "test command" --body "The fixture runs node --test"
pnpm harness traj baseline save login-fix
```

默认在 git worktree 里改文件，不碰你当前工作区的脏文件。修对了再 `harness apply`。不对就 `harness undo`。子 Agent 用 `delegate`：独立 child 轨迹，父轨迹只留摘要。`fusion` 开 Lead（plan）和 Sidekick（agent）两段同模型 session，父轨迹只记 brief/result。没有 `AGENTS.md` 时 Done Report 会建议怎么写，但不会擅自改。browser 工具无 `HARNESS_BROWSER` 时失败闭合。

项目插件放在 `.harness/plugins/*/plugin.json`（skill / hook / mcp）。`harness plugin add <path-or-git>` 拷进该目录。REPL：`/ask` `/plan` `/agent` `/fusion` `/steer` `/plugins` `/undo` `/apply`。

默认 `--exec local`，agent 网络关闭。`--exec docker` 把命令丢进 `docker run --rm --network none -v agentRoot:/workspace`。`--exec remote` 把 `worker/exec` 打到 `HARNESS_WORKER_URL`（未设置则失败闭合）。`--network` 才开网。`--unattended` / `--cloud` 把「问一次」改成事后审计，避免无人时睡着。`harness serve` 是 worker：客户端可断开，任务仍在，重连 `thread/subscribe` 回放完整 item。

无 API key 时用 `--model mock`（内置脚本模型，能修 login fixture）。接真模型：

```bash
export OPENAI_API_KEY=...
# 可选 OPENAI_BASE_URL=https://api.openai.com/v1
pnpm harness exec --model gpt-4o-mini --prompt "..."
```

进仓库根目录直接 `pnpm harness` 进入 REPL（`/ask` `/plan` `/agent` `/fusion` `/steer` `/plugins` `/traj` `/apply` `/undo` `/quit`）。

## 文档

| 文档 | 用途 |
| --- | --- |
| [已确认决策](docs/decisions.md) | 立项拍板，改这里等于改方案 |
| [技术方案](docs/tech-proposal.md) | 规格全文 |
| [架构草图](docs/architecture.md) | 接口与目录 |
| [Spring 对照笔记](docs/di-and-composition.md) | 学习注入理念，**不引入、不约束实现** |

## 一句话

默认 `harness` 进仓库就能干活：worktree 隔离、可打断、有测试证据、插件能加、轨迹能回放。
