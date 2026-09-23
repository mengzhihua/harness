# Harness

自研 Coding Agent 运行时。模型在真实仓库里改代码、跑检查、用插件扩展、用轨迹回放。模型可换（OpenAI compatible）；默认在 git worktree 里改，不碰你当前工作区的脏文件。

当前协议 **0.35.0**。成品在 **[GitHub Releases / Latest](https://github.com/mengzhihua/harness/releases/latest)**。决策以 [docs/decisions.md](docs/decisions.md) 为准。组合内核对齐 Cordis；服务端是 `@harness/spring` 与 `java -jar harness-server-*.jar`（不 vendor Spring / VS Code 源码）。

## 安装

每次绿灯推送先跑 `pnpm test`，通过才打包并挂到 Release。Pull Request 只跑测试。`[skip release]`、`[skip ci]` 和纯文档提交不发版。

| 平台 | Latest 资产 | 需要 |
| --- | --- | --- |
| Windows x64 | `harness-win-x64-*.zip`（内含 `harness.exe`） | 解压即用 |
| macOS Apple Silicon (M1+) | `harness-macos-arm64-*.zip` | 解压即用 |
| macOS Intel | `harness-macos-x64-*.zip` | 解压即用 |
| macOS 通用 (ARM+Intel) | `harness-macos-universal-*.zip` | 解压即用 |
| Linux x64 | `harness-linux-x64-*.tar.gz` | 解压即用 |
| Linux ARM64 | `harness-linux-arm64-*.tar.gz` | 解压即用 |
| 服务端 | `harness-server-*.jar` | JDK 21+ |
| npm | `harness-cli-*.tgz` | Node.js 22+ |

Apple Silicon 必出 `harness-macos-arm64-*.zip`；缺这个文件时打包失败。`harness-darwin-*-*.tar.gz` 仍留给脚本。

Linux：

```bash
tar -xzf harness-linux-x64-*.tar.gz
./harness-linux-x64-*/harness --version
./harness-linux-x64-*/harness doctor
cd <repo> && ../harness-linux-x64-*/harness
```

macOS Apple Silicon（M1 / M2 / M3 / M4）：Finder 解压 zip，或：

```bash
unzip harness-macos-arm64-*.zip
./harness-macos-arm64-*/harness --version
./harness-macos-arm64-*/harness doctor
```

Windows：解压 zip，在 cmd 里运行 `harness.exe`。

npm（需要本机 Node.js 22+）：

```bash
npm i -g ./harness-cli-*.tgz
harness --version
harness doctor
```

服务端（Spring Boot JAR，JDK 21+）：

```bash
java -jar harness-server-*.jar
curl http://127.0.0.1:8080/health
curl -s -X POST http://127.0.0.1:8080/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"runtime/doctor","params":{}}'
```

原生包也可以当服务：`./harness serve --http --port 8080 --bind 0.0.0.0`。流水线在 `.github/workflows/release.yml`。从源码重新打包：`pnpm pack:all`（产物在 `dist/native/` 与 `dist/release/`）。

## 第一次跑

无 API key 时用内置 `--model mock`（能修 login fixture）：

```bash
cd <repo>
harness doctor
harness exec --model mock --prompt "把失败的登录测试修了，不要动别的模块"
harness traj show --source tool
```

TTY 下直接 `harness` 进 TUI；不是 TTY 则进 REPL。接真模型：

```bash
export OPENAI_API_KEY=...
# 可选 OPENAI_BASE_URL=https://api.openai.com/v1
harness exec --model gpt-4o-mini --prompt "..."
```

修对了再 `harness apply`。不对就 `harness undo`。`/apply` 遇到 merge 冲突会 abort，不留半合并。

## 日常

默认 `--exec local`，agent 网络关闭。`--network` 或 `HARNESS_NET` 才允许 `web_fetch` / `web_search`。`--exec docker` 把命令丢进 `docker run --rm --network none`。`--exec remote` 打到 `HARNESS_WORKER_URL`。`--unattended` 把「问一次」改成事后审计。

TUI 直播推理和 bash 输出，状态栏有当前工具、`tok=`、`cache=`、`queued=`、`en|zh`。审批：`y` 本次 / `s` 本线程 / `a` 永久（写入 `~/.harness/config.yml` 的 `allow:`）/ `n` 拒绝。运行中再打一行进 inbox，当前工具结束后接着做，不是新 session。`/stop` 打断推理并停掉还在跑的命令和后台任务。

| 斜杠命令 | 作用 |
| --- | --- |
| `/help` | 列出这些命令 |
| `/ask` `/plan` `/agent` | 同线程换模式 |
| `/plan skip ID` | 跳过计划里的一步 |
| `/todos` `/jobs` | 待办、后台任务 |
| `/steer TEXT` `/queue` | 插一句 follow-up；看队列 |
| `/stop` `/check` `/doctor` | 打断；跑检查；安装健康 |
| `/config` `/yolo` `/lang` | 读写 `config.yml` |
| `/open` `/ide` | 打开文件或工作台命令 |
| `/resume` `/fork` `/threads` | 继续、分叉、列出线程 |
| `/fusion` `/plugins` `/traj` | Fusion、插件、轨迹 |
| `/undo` `/apply` `/quit` | 撤销、合并回用户树、退出 |

`~/.harness/config.yml` 可设 `language`、`lead_model` / `sidekick_model`。`harness config` 与 TUI `/config` 写同一份文件。

Ask 模式只读。Plan 模式可以检查和列目录，不能改文件。Agent 模式才写代码、跑命令。

## 模型能用的工具

| 工具 | 做什么 |
| --- | --- |
| `read_file` `list_dir` `grep` `glob` | 读文件、列一层目录、搜内容、按 glob 找文件 |
| `apply_patch` `str_replace` `write_file` | 改代码。多 hunk 优先 `apply_patch` |
| `move_file` `delete_file` | 工作区内改名、删除。不覆盖已有路径，不走出 worktree |
| `bash` `wait` | 跑命令。长任务设 `background: true`，再用 `wait` 收输出 |
| `todo_write` | 线程待办，画在 TUI 上 |
| `remember` `recall` | 跨线程笔记，写在用户树 `.harness/knowledge` |
| `workspace_status` | 看 worktree / 用户树是否脏 |
| `ask_user` | 停下来等人的原话 |
| `web_fetch` `web_search` | 开网后的 HTTP。拦住云 metadata 地址 |
| `run_code` | 在 AgentWorkspace 里跑一小段 JS / Python |
| `read_skill` | 按需加载 skill 正文。启动时只放目录 |
| `delegate` `fusion` | 子任务，或 Lead / Sidekick 两段 session |

列目录、改名、删文件走上面的工具，不必 `ls` / `mv` / `rm`。`apply` 和 `undo` 是用户命令，模型不能自己调用。

## 插件、工作台、轨迹

项目插件放在 `.harness/plugins/*/plugin.json`（skill / hook / mcp / command / adapter）。`harness plugin add <path-or-git>` 拷进该目录。本地 catalog 加上 `HARNESS_STORE_URL` 远程商店，不计费。`permissions` 声明网络、密钥、子进程、文件系统；`/plugins` 能看见。MCP 默认拿不到宿主密钥。绝对路径和 `..` 要 `fs: host`。

`harness workbench --serve` 和 `extensions/vscode` 是自研工作台：侧栏是 worktree 文件树，`--serve` 只绑本机并用 SSE 直播。没有外部编辑器时，`/open` 和 `harness ide FILE` 用 `ide/file` 预览。

轨迹默认脱敏，header 带 `env_hash`。`harness traj show`、`traj replay --dry` 能回放。没有 `AGENTS.md` 时 Done Report 会建议怎么写，但不会擅自改。缺命令、没权限或网络被拦时，`residual_risks` 说明卡在哪里。

## 从源码

需要 Node.js 22+、pnpm 10。

```bash
pnpm install
pnpm test
pnpm harness doctor
pnpm harness exec --model mock --cwd eval/fixtures/login \
  --prompt "把失败的登录测试修了，不要动别的模块"
pnpm harness tui
pnpm harness eval --dir eval/tasks
pnpm harness workbench --serve
```

常用命令：`threads`、`traj show|replay|diff|fork`、`plugin search|install|list`、`knowledge add`、`fusion --prompt`、`pr`、`ci`、`ide apply|undo|save`、`serve`（stdio JSON-RPC；`--http` 为 HTTP）。`exec` / REPL / TUI 都是 App Server 的客户端。

## 文档

| 文档 | 用途 |
| --- | --- |
| [已确认决策](docs/decisions.md) | 立项拍板，改这里等于改方案 |
| [技术方案](docs/tech-proposal.md) | 规格全文 |
| [架构草图](docs/architecture.md) | 接口与目录 |
| [Spring 对照笔记](docs/di-and-composition.md) | `@harness/spring` 的理念来源，不 vendor Java Spring |

默认 `harness` 进仓库就能干活：worktree 隔离、可打断、有测试证据、插件能加、轨迹能回放。
