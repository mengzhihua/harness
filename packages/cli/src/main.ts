import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { PassThrough } from "node:stream";
import { HarnessClient } from "@harness/sdk";
import { AppServer } from "@harness/server";
import type { InitializeParams } from "@harness/protocol";
import { runTui } from "@harness/tui";

type ModeName = "ask" | "plan" | "agent";

function connect(): HarnessClient {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  new AppServer(toServer, toClient);
  return new HarnessClient(toClient, toServer);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const defaultCmd = process.stdout.isTTY && process.stdin.isTTY ? "tui" : "repl";
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : defaultCmd;
  const rest =
    cmd === "repl" && argv[0] && !argv[0].startsWith("-")
      ? argv.slice(1)
      : argv[0] === "repl"
        ? argv.slice(1)
        : cmd === argv[0]
          ? argv.slice(1)
          : argv;

  if (cmd === "help" || cmd === "--help" || cmd === "-h") return printHelp();
  if (cmd === "serve") {
    new AppServer(process.stdin, process.stdout);
    return;
  }
  if (cmd === "exec") return cmdExec(parseFlags(rest));
  if (cmd === "tui") return cmdTui(parseFlags(rest));
  if (cmd === "eval") return cmdEval(parseFlags(rest));
  if (cmd === "fusion") return cmdFusion(parseFlags(rest));
  if (cmd === "knowledge") return cmdKnowledge(rest);
  if (cmd === "plugin") return cmdPlugin(rest);
  if (cmd === "pr") return cmdPr(parseFlags(rest));
  if (cmd === "ci") return cmdCi(parseFlags(rest));
  if (cmd === "traj") return cmdTraj(rest);
  if (cmd === "apply") return cmdApply(parseFlags(rest));
  if (cmd === "undo") return cmdUndo(parseFlags(rest));
  if (cmd === "threads") return cmdThreads(parseFlags(rest));
  if (cmd === "resume") return cmdRepl(parseFlags(rest), true);
  if (cmd === "repl") return cmdRepl(parseFlags(rest), false);
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`harness — coding agent runtime

Usage:
  harness                         TUI (REPL if not a TTY)
  harness tui                     self-drawn TUI (stream + approval + input)
  harness repl                    line-oriented REPL
  harness serve                   JSON-RPC App Server on stdio
  harness exec --prompt TEXT      one-shot turn (client → App Server)
  harness resume [thread]         continue a thread in the REPL
  harness threads [--query TEXT]
  harness traj show [thread]
  harness traj list | export | replay | diff | fork
  harness apply | undo [thread]
  harness plugin add <path-or-git>
  harness plugin list | enable ID | disable ID | command ID
  harness pr [--title TEXT] [--body TEXT] [--base BRANCH]
  harness ci
  harness fusion --prompt TEXT
  harness knowledge list | add --title TEXT --body TEXT
  harness traj baseline save|list|check NAME
  harness eval --task FILE

Flags:
  --cwd DIR  --home DIR  --profile NAME  --model NAME  --mode ask|plan|agent
  --exec local|docker|remote  --docker-image NAME  --network  --unattended  --detach
  --in-place  --apply  --yolo  --source SRC  --thread ID  -o FILE  --dry  --live  --at ID  --query TEXT
`);
}

async function withClient(flags: Flags, fn: (c: HarnessClient) => Promise<void>, thread?: "start" | "resume"): Promise<void> {
  const client = connect();
  await client.initialize(initParams(flags));
  wireApprovals(client, flags);
  if (thread === "start") await client.threadStart();
  if (thread === "resume") {
    const id = flags.thread ?? flags._[0];
    if (id) await client.threadResume(id);
    else {
      const { threads } = await client.threadList();
      if (!threads[0]) throw new Error("no thread to resume");
      await client.threadResume(threads[0].threadId);
    }
  }
  await fn(client);
}

function wireApprovals(client: HarnessClient, flags: Flags): void {
  client.onEvent((method, params) => {
    if (method !== "approval/request") return;
    const p = params as { id: string };
    const decision = flags.yolo ? "allow_session" : "deny";
    void client.approvalRespond(p.id, decision);
  });
}

async function cmdExec(flags: Flags): Promise<void> {
  const prompt = flags.prompt ?? flags._.join(" ");
  if (!prompt) {
    console.error("exec requires --prompt");
    process.exitCode = 1;
    return;
  }
  await withClient(flags, async (client) => {
    client.onEvent((method, params) => {
      if (method === "item/delta") console.log((params as { text?: string }).text ?? "");
    });
    const done = (await client.turnStart(prompt, flags.detach ? { detach: true } : undefined)) as {
      changed_files?: string[];
      checks?: Array<{ cmd: string; exit_code: number }>;
      apply_ready?: boolean;
      residual_risks?: string[];
      running?: boolean;
      threadId?: string;
    };
    if (done.running) {
      console.log(`detached thread=${done.threadId} (same traj id when you reconnect)`);
      return;
    }
    printDone(done as Parameters<typeof printDone>[0]);
    const shown = await client.trajShow();
    const header = shown.header as { threadId?: string; agentRoot?: string };
    const exported = await client.trajExport(
      flags.output ?? path.join(flags.home ?? path.join(process.env.HOME ?? ".", ".harness"), "exports", `${header.threadId ?? "thread"}.traj`),
    );
    console.log(`traj: ${exported.path}`);
    if (flags.apply && done.apply_ready) {
      const applied = await client.apply();
      console.log(applied.ok ? `applied: ${applied.message}` : `apply failed: ${applied.message}`);
    } else if (done.apply_ready) {
      console.log(`worktree: ${header.agentRoot ?? ""}`);
      console.log("not applied (pass --apply or run: harness apply)");
    }
  }, "start");
}

async function cmdTraj(args: string[]): Promise<void> {
  const sub = args[0] ?? "show";
  const flags = parseFlags(args.slice(["show", "list", "export", "replay", "diff", "fork", "baseline"].includes(sub) ? 1 : 0));
  if (sub === "list") {
    await cmdThreads(flags);
    return;
  }
  if (sub === "baseline") {
    await cmdBaseline(flags);
    return;
  }
  await withClient(flags, async (client) => {
    if (sub === "fork") {
      const source = flags.thread ?? flags._[0];
      if (!source) throw new Error("traj fork requires a thread id");
      const forked = await client.threadFork(source, flags.at);
      console.log(JSON.stringify(forked, null, 2));
      return;
    }
    const id = flags.thread ?? flags._[0];
    if (id) await client.threadResume(id);
    else {
      const { threads } = await client.threadList();
      if (!threads[0]) throw new Error("no threads");
      await client.threadResume(threads[0].threadId);
    }
    if (sub === "export") {
      const out = flags.output ?? path.join(process.cwd(), "thread.traj");
      console.log((await client.trajExport(out)).path);
      return;
    }
    if (sub === "replay") {
      const mode = flags.live ? "live" : "dry";
      console.log(JSON.stringify(await client.trajReplay(mode), null, 2).slice(0, 4000));
      return;
    }
    if (sub === "diff") {
      const other = flags._[1] ?? flags._[0];
      if (!other) throw new Error("traj diff requires another thread id");
      console.log(JSON.stringify(await client.trajDiff(other), null, 2));
      return;
    }
    const shown = await client.trajShow(flags.source);
    console.log(JSON.stringify(shown.header, null, 2));
    for (const ev of shown.events as Array<{ ts: string; source: string; type: string; payload: unknown }>) {
      console.log(`${ev.ts}  ${ev.source.padEnd(10)}  ${ev.type}  ${JSON.stringify(ev.payload).slice(0, 120)}`);
    }
  });
}

async function cmdThreads(flags: Flags): Promise<void> {
  await withClient(flags, async (client) => {
    const { threads } = await client.threadList(flags.query);
    if (!threads.length) {
      console.log("(no threads)");
      return;
    }
    for (const t of threads) console.log(`${t.threadId}  ${t.title}  model=${t.model}`);
  });
}

async function cmdApply(flags: Flags): Promise<void> {
  await withClient(flags, async (client) => {
    const result = await client.apply();
    console.log(result.ok ? `applied: ${result.message}` : `apply failed: ${result.message}`);
  }, "resume");
}

async function cmdUndo(flags: Flags): Promise<void> {
  await withClient(flags, async (client) => {
    const { id } = await client.undo();
    console.log(`restored ${id}`);
  }, "resume");
}

async function cmdPlugin(args: string[]): Promise<void> {
  const sub = args[0];
  const flags = parseFlags(args.slice(1));
  if (sub === "list") {
    await withClient(flags, async (client) => {
      console.log(JSON.stringify((await client.pluginList()).packages, null, 2));
    }, "start");
    return;
  }
  if (sub === "add") {
    const source = flags._[0];
    if (!source) {
      console.error("plugin add requires a path or git URL");
      process.exitCode = 1;
      return;
    }
    await withClient(flags, async (client) => {
      const added = await client.pluginAdd(source);
      console.log(`added ${added.id} -> ${added.dir}`);
    });
    return;
  }
  if (sub === "enable" || sub === "disable") {
    const id = flags._[0];
    if (!id) {
      console.error(`plugin ${sub} requires an id`);
      process.exitCode = 1;
      return;
    }
    await withClient(flags, async (client) => {
      const result = sub === "enable" ? await client.pluginEnable(id) : await client.pluginDisable(id);
      console.log(`${result.id} enabled=${result.enabled}`);
    }, "start");
    return;
  }
  if (sub === "command") {
    const id = flags._[0];
    if (!id) {
      console.error("plugin command requires an id");
      process.exitCode = 1;
      return;
    }
    await withClient(flags, async (client) => {
      const result = await client.pluginCommand(id);
      console.log(result.output);
      if (!result.ok) process.exitCode = 1;
    }, "start");
    return;
  }
  printHelp();
  process.exitCode = 1;
}

async function cmdPr(flags: Flags): Promise<void> {
  await withClient(flags, async (client) => {
    const result = await client.openPr({ title: flags.title, body: flags.body, base: flags.base });
    console.log(result.ok ? `pr: ${result.url ?? result.message}` : `pr failed: ${result.message}`);
  }, "resume");
}

async function cmdCi(flags: Flags): Promise<void> {
  await withClient(flags, async (client) => {
    const result = await client.attachCi();
    console.log(result.ok ? `ci: ${result.artifact ?? result.message}` : `ci failed: ${result.message}`);
  }, "resume");
}

async function cmdTui(flags: Flags): Promise<void> {
  const client = connect();
  await client.initialize(initParams(flags));
  await runTui({ client, mode: flags.mode, model: flags.model });
  await client.shutdown();
}

async function cmdEval(flags: Flags): Promise<void> {
  const task = flags.task ?? flags._[0] ?? flags.prompt;
  if (!task) {
    console.error("eval requires --task FILE or a path argument");
    process.exitCode = 1;
    return;
  }
  const { readFile } = await import("node:fs/promises");
  const body = await readFile(path.resolve(task), "utf8");
  const prompt = body.trim() || "complete the eval task";
  flags.profile = flags.profile ?? "eval";
  await withClient(flags, async (client) => {
    const done = (await client.turnStart(prompt)) as Parameters<typeof printDone>[0];
    printDone(done);
    const shown = await client.trajShow();
    const header = shown.header as { threadId?: string };
    const exported = await client.trajExport(
      flags.output ?? path.join(flags.home ?? path.join(process.env.HOME ?? ".", ".harness"), "eval", `${header.threadId ?? "task"}.traj`),
    );
    console.log(`traj: ${exported.path}`);
  }, "start");
}

async function cmdFusion(flags: Flags): Promise<void> {
  const task = flags.prompt ?? flags._.join(" ");
  if (!task) {
    console.error("fusion requires --prompt");
    process.exitCode = 1;
    return;
  }
  await withClient(flags, async (client) => {
    const result = await client.fusionRun(task);
    console.log(`lead ${result.leadId}`);
    console.log(`sidekick ${result.sidekickId}`);
    console.log(result.brief);
    console.log(result.summary);
  }, "start");
}

async function cmdKnowledge(args: string[]): Promise<void> {
  const sub = args[0];
  const flags = parseFlags(args.slice(1));
  if (sub === "list") {
    await withClient(flags, async (client) => {
      console.log(JSON.stringify((await client.knowledgeList()).notes, null, 2));
    });
    return;
  }
  if (sub === "add") {
    const title = flags.title ?? "note";
    const body = flags.body ?? flags._.join(" ");
    await withClient(flags, async (client) => {
      const note = await client.knowledgeAdd(title, body);
      console.log(`added ${note.id}`);
    });
    return;
  }
  printHelp();
  process.exitCode = 1;
}

async function cmdBaseline(flags: Flags): Promise<void> {
  const op = (flags._[0] ?? "list") as "save" | "list" | "check";
  const name = flags._[1];
  if (op === "list") {
    await withClient(flags, async (client) => {
      console.log(JSON.stringify(await client.trajBaseline("list"), null, 2));
    });
    return;
  }
  await withClient(flags, async (client) => {
    console.log(JSON.stringify(await client.trajBaseline(op, name), null, 2));
  }, "resume");
}

async function cmdRepl(flags: Flags, resumeThread: boolean): Promise<void> {
  const client = connect();
  await client.initialize(initParams(flags));
  wireApprovals(client, flags);
  if (resumeThread) {
    const id = flags.thread ?? flags._[0];
    if (id) await client.threadResume(id);
    else {
      const { threads } = await client.threadList();
      if (!threads[0]) throw new Error("no thread");
      await client.threadResume(threads[0].threadId);
    }
  } else {
    await client.threadStart();
  }
  client.onEvent((method, params) => {
    if (method === "item/delta") console.log((params as { text?: string }).text ?? "");
  });
  console.log("type a task, or /ask /plan /agent /plan skip ID /stop /fusion /traj /plugins /steer /undo /apply /threads /quit");
  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const line = (await rl.question("harness> ")).trim();
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      if (line === "/help") {
        printHelp();
        continue;
      }
      const planSkip = line.match(/^\/plan skip(?:\s+(\S+))?$/);
      if (planSkip) {
        const id = planSkip[1];
        if (!id) {
          console.log("usage: /plan skip ID");
          continue;
        }
        const skipped = await client.planSkip(id);
        for (const step of skipped.steps as Array<{ id: string; title: string; status: string }>) {
          const mark = step.status === "done" ? "x" : step.status === "skipped" ? "-" : " ";
          console.log(`- [${mark}] ${step.id} ${step.title}`);
        }
        continue;
      }
      if (line === "/ask" || line === "/plan" || line === "/agent") {
        const mode = line.slice(1) as ModeName;
        flags.mode = mode;
        const changed = await client.threadMode(mode);
        console.log(`mode ${changed.mode} (same thread ${changed.threadId})`);
        continue;
      }
      if (line === "/stop" || line === "/interrupt") {
        await client.turnInterrupt();
        console.log("interrupted");
        continue;
      }
      if (line === "/plugins") {
        console.log(JSON.stringify((await client.pluginList()).packages, null, 2));
        continue;
      }
      if (line.startsWith("/steer ")) {
        await client.turnSteer(line.slice(7));
        continue;
      }
      if (line.startsWith("/fusion ")) {
        const result = await client.fusionRun(line.slice(8));
        console.log(`lead ${result.leadId}`);
        console.log(`sidekick ${result.sidekickId}`);
        console.log(result.brief);
        console.log(result.summary);
        continue;
      }
      if (line === "/traj") {
        const shown = await client.trajShow();
        for (const ev of shown.events as Array<{ ts: string; source: string; type: string }>) {
          console.log(`${ev.ts}  ${ev.source}  ${ev.type}`);
        }
        continue;
      }
      if (line === "/threads") {
        const { threads } = await client.threadList();
        for (const t of threads) console.log(`${t.threadId}  ${t.title}`);
        continue;
      }
      if (line === "/fork") {
        const forked = await client.threadFork();
        console.log(`forked ${forked.threadId} from ${forked.parentThreadId}`);
        continue;
      }
      if (line === "/apply") {
        const result = await client.apply();
        console.log(result.message);
        continue;
      }
      if (line === "/undo") {
        console.log(`restored ${(await client.undo()).id}`);
        continue;
      }
      const done = await client.turnStart(line);
      printDone(done as Parameters<typeof printDone>[0]);
    }
  } finally {
    rl.close();
  }
}

function printDone(done: {
  changed_files: string[];
  checks: Array<{ cmd: string; exit_code: number }>;
  apply_ready: boolean;
  residual_risks?: string[];
  agents_md_suggestion?: string;
}): void {
  console.log("");
  console.log("Done Report");
  console.log(`  changed_files: ${done.changed_files.join(", ") || "(none)"}`);
  for (const check of done.checks) console.log(`  check: ${check.cmd} exit=${check.exit_code}`);
  console.log(`  apply_ready: ${done.apply_ready}`);
  if (done.residual_risks?.length) console.log(`  risks: ${done.residual_risks.join("; ")}`);
  if (done.agents_md_suggestion) console.log(`  AGENTS.md: ${done.agents_md_suggestion}`);
}

interface Flags {
  prompt?: string;
  cwd?: string;
  home?: string;
  profile?: string;
  model?: string;
  mode?: ModeName;
  inPlace?: boolean;
  apply?: boolean;
  yolo?: boolean;
  dry?: boolean;
  live?: boolean;
  source?: string;
  output?: string;
  thread?: string;
  at?: string;
  query?: string;
  exec?: "local" | "docker" | "remote";
  dockerImage?: string;
  network?: boolean;
  unattended?: boolean;
  detach?: boolean;
  title?: string;
  body?: string;
  base?: string;
  task?: string;
  _: string[];
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? "";
    if (a === "--prompt" || a === "-p") flags.prompt = next();
    else if (a === "--cwd") flags.cwd = next();
    else if (a === "--home") flags.home = next();
    else if (a === "--profile") flags.profile = next();
    else if (a === "--model") flags.model = next();
    else if (a === "--mode") flags.mode = next() as ModeName;
    else if (a === "--thread") flags.thread = next();
    else if (a === "--source") flags.source = next();
    else if (a === "-o" || a === "--output") flags.output = next();
    else if (a === "--at") flags.at = next();
    else if (a === "--query") flags.query = next();
    else if (a === "--exec") flags.exec = next() as "local" | "docker" | "remote";
    else if (a === "--docker-image") flags.dockerImage = next();
    else if (a === "--network") flags.network = true;
    else if (a === "--unattended" || a === "--cloud") flags.unattended = true;
    else if (a === "--detach") flags.detach = true;
    else if (a === "--title") flags.title = next();
    else if (a === "--body") flags.body = next();
    else if (a === "--base") flags.base = next();
    else if (a === "--task") flags.task = next();
    else if (a === "--in-place") flags.inPlace = true;
    else if (a === "--apply") flags.apply = true;
    else if (a === "--yolo") flags.yolo = true;
    else if (a === "--dry") flags.dry = true;
    else if (a === "--live") flags.live = true;
    else if (a.startsWith("--")) console.error(`unknown flag ${a}`);
    else flags._.push(a);
  }
  return flags;
}

function initParams(flags: Flags): InitializeParams {
  return {
    cwd: path.resolve(flags.cwd ?? process.cwd()),
    harnessHome: flags.home,
    profile: flags.profile,
    model: flags.model,
    mode: flags.mode,
    inPlace: flags.inPlace,
    yolo: flags.yolo,
    exec: flags.exec,
    dockerImage: flags.dockerImage,
    network: flags.network,
    unattended: flags.unattended,
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
