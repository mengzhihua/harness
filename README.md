# Harness

自研 Coding Agent 运行时：模型在真实仓库里改代码、跑检查、用插件扩展、用轨迹回放。

> **P35 列目录 / 改名 / `/help`。** 决策以 [docs/decisions.md](docs/decisions.md) 为准。组合内核对齐 Cordis；Spring 落地为 `@harness/spring` 与 `java -jar harness-server-*.jar`（不 vendor Spring 源码）。

## 安装（直接用）

成品始终从 **[GitHub Releases / Latest](https://github.com/mengzhihua/harness/releases/latest)** 下载。每次推送会先跑 `pnpm test`，通过才打包 Windows / macOS / Linux 原生包、Spring Boot JAR 和 npm tarball 并挂到 Release。PR 只跑测试；提交说明写 `[skip release]` 不发版。

| 平台 | Latest 资产 |
| --- | --- |
| Windows x64 | `harness-win-x64-*.zip`（内含 `harness.exe`） |
| macOS Apple Silicon (M1+) | `harness-macos-arm64-*.zip` |
| macOS Intel | `harness-macos-x64-*.zip` |
| macOS 通用 | `harness-macos-universal-*.zip` |
| Linux x64 | `harness-linux-x64-*.tar.gz` |
| Linux ARM64 | `harness-linux-arm64-*.tar.gz` |
| 服务端 JDK 21+ | `harness-server-*.jar` |
| npm | `harness-cli-*.tgz` |

从源码重新打包：`pnpm pack:all`（产物在 `dist/native/` 与 `dist/release/`）。

Linux:

```bash
tar -xzf harness-linux-x64-*.tar.gz
./harness-linux-x64-*/harness --version
./harness-linux-x64-*/harness doctor
cd <repo> && ../harness-linux-x64-*/harness exec --model mock --prompt "把失败的登录测试修了"
```

macOS Apple Silicon（M1 / M2 / M3 / M4）：在 Finder 里解压 zip，或：

```bash
unzip harness-macos-arm64-*.zip
./harness-macos-arm64-*/harness --version
./harness-macos-arm64-*/harness doctor
```

Windows：解压 zip 后双击或在 cmd 里运行 `harness.exe`。

服务端（Spring Boot JAR，JDK 21+）：

```bash
java -jar harness-server-*.jar
curl http://127.0.0.1:8080/health
curl -s -X POST http://127.0.0.1:8080/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"runtime/doctor","params":{}}'
```

原生包同样可以当服务：`./harness serve --http --port 8080 --bind 0.0.0.0`。

流水线在 `.github/workflows/release.yml`：测试不过不发版。

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
pnpm harness tui
pnpm harness plugin disable login.verify
pnpm harness eval --task eval/tasks/mode-switch.md
pnpm harness eval --dir eval/tasks
pnpm harness plugin search test-runner
pnpm harness plugin install harness.test-runner
pnpm harness ide src/auth.js:1
pnpm harness ide apply
pnpm harness doctor
pnpm harness doctor --json
pnpm harness workbench --serve
```

默认 `harness` 在 TTY 下进 TUI（流式推理和 bash 输出 + **当前工具** + **follow-up 队列** + 输入始终可点；审批卡片 `y` 本次 / `s` 本线程 / `a` 永久 / `n` 拒绝；状态栏 `tok=` `cache=` `en|zh` `queued=`），非 TTY 仍是 REPL。`harness doctor` 检查 release/源码安装是否能跑（不打印密钥）。`~/.harness/config.yml` 可设 `language`、`lead_model` / `sidekick_model`。插件目录：本地 catalog + `HARNESS_STORE_URL` 远程商店（无计费）。Fusion 两段 session 可各用一个模型。`harness workbench --serve` / `extensions/vscode` 是 **Harness IDE 工作台**（自研分叉式产品面，不 vendor VS Code 源码；侧栏是 worktree 文件树，点开进编辑器；`--serve` 用 loopback SSE 直播 `item/delta`）。没有外部编辑器时 `/open` 和 `harness ide FILE` 走 `ide/file` 预览。工作台按钮、TUI `/ide` 和 `harness ide apply|undo|steer|save` 走 `ide/command`（`--serve` 注入 `window.harness`；VS Code `postMessage`）。插件 `permissions` 声明网络/密钥/子进程/文件系统，`plugin/list` 和 `/plugins` 能看见；MCP 默认拿不到宿主密钥，声明 `secrets` 才放行。绝对路径 / `..` 要 `fs: host`。`run_code` 跑沙箱片段。`@harness/spring` 是 Bean 容器适配层。

默认在 git worktree 里改文件，不碰你当前工作区的脏文件。修对了再 `harness apply`。不对就 `harness undo`。子 Agent 用 `delegate`：独立 child 轨迹，父轨迹只留摘要。`fusion` 开 Lead（plan）和 Sidekick（agent）两段同模型 session，父轨迹只记 brief/result。没有 `AGENTS.md` 时 Done Report 会建议怎么写，但不会擅自改。browser 工具无 `HARNESS_BROWSER` 时失败闭合。缺命令 / 没权限 / 网络被拦时，Done Report 的 `residual_risks` 说人话（U10）。

项目插件放在 `.harness/plugins/*/plugin.json`（skill / hook / mcp / command / adapter）。skill 启动只进目录（id + description），`SKILL.md` 正文按需。`adapter` 导出 `createLlm()`，挂到 isolate 的 `ctx.llm`。`harness plugin add <path-or-git>` 拷进该目录。REPL / TUI：`/help` `/ask` `/plan` `/agent` `/plan skip` `/stop` `/check` `/resume` `/fork` `/fusion` `/steer` `/queue` `/todos` `/jobs` `/plugins` `/traj` `/undo` `/apply` `/ide`。运行中再打一行是 follow-up（inbox），不是新 session。列目录用 `list_dir`，改名用 `move_file`，删文件用 `delete_file`，不必再走 `ls` / `mv` / `rm`。`/apply` 遇到 merge 冲突会 abort，不留半合并。轨迹默认脱敏，header 带 `env_hash`。bash 的 `cd` 会记住 cwd。

默认 `--exec local`，agent 网络关闭。`--exec docker` 把命令丢进 `docker run --rm --network none -v agentRoot:/workspace`。`--exec remote` 把 `worker/exec` 打到 `HARNESS_WORKER_URL`（未设置则失败闭合）。`--network` 才开网。`--unattended` / `--cloud` 把「问一次」改成事后审计，避免无人时睡着。`harness serve` 是 worker：客户端可断开，任务仍在，重连 `thread/subscribe` 回放完整 item。`harness eval --task FILE` 默认 `profiles/eval.yml`（minimal ACI），把轨迹写到 `~/.harness/eval/`。`harness eval --dir eval/tasks` 跑完全部黄金任务 markdown，从每条轨迹打出 Harness 榜 scorecard（apply_ready、审批、无关文件、首个 tool 延迟、cache hit、声称完成但检查失败、插件错误、plugin_permission、dry replay、plugin_lock）。

无 API key 时用 `--model mock`（内置脚本模型，能修 login fixture）。接真模型：

```bash
export OPENAI_API_KEY=...
# 可选 OPENAI_BASE_URL=https://api.openai.com/v1
pnpm harness exec --model gpt-4o-mini --prompt "..."
```

进仓库根目录直接 `pnpm harness` 进入 TUI（非 TTY 则 REPL：`/help` `/ask` `/plan` `/agent` `/plan skip` `/todos` `/jobs` `/stop` `/check` `/doctor` `/resume` `/fork` `/fusion` `/steer` `/queue` `/plugins` `/traj` `/apply` `/undo` `/ide` `/quit`）。

## 文档

| 文档 | 用途 |
| --- | --- |
| [已确认决策](docs/decisions.md) | 立项拍板，改这里等于改方案 |
| [技术方案](docs/tech-proposal.md) | 规格全文 |
| [架构草图](docs/architecture.md) | 接口与目录 |
| [Spring 对照笔记](docs/di-and-composition.md) | `@harness/spring` 的理念来源，不 vendor Java Spring |

## 一句话

默认 `harness` 进仓库就能干活：worktree 隔离、可打断、有测试证据、插件能加、轨迹能回放。
