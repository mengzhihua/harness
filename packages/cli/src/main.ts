import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { PassThrough } from "node:stream";
import { HarnessClient } from "@harness/sdk";
import { AppServer } from "@harness/server";
import type { InitializeParams } from "@harness/protocol";

type ModeName = "ask" | "plan" | "agent";

function connect(): HarnessClient {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  new AppServer(toServer, toClient);
  return new HarnessClient(toClient, toServer);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "repl";
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
  harness                         interactive REPL
  harness serve                   JSON-RPC App Server on stdio
  harness exec --prompt TEXT      one-shot turn (client → App Server)
  harness resume [thread]         continue a thread in the REPL
  harness threads [--query TEXT]
  harness traj show [thread]
  harness traj list | export | replay | diff | fork
  harness apply | undo [thread]

Flags:
  --cwd DIR  --home DIR  --profile NAME  --model NAME  --mode ask|plan|agent
  --in-place  --apply  --yolo  --source SRC  --thread ID  -o FILE  --dry  --live  --at ID  --query TEXT
`);
}

async function withClient(flags: Flags, fn: (c: HarnessClient) => Promise<void>, thread?: "start" | "resume"): Promise<void> {
  const client = connect();
  await client.initialize(initParams(flags));
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
    const done = (await client.turnStart(prompt)) as {
      changed_files: string[];
      checks: Array<{ cmd: string; exit_code: number }>;
      apply_ready: boolean;
      residual_risks: string[];
    };
    printDone(done);
    const shown = await client.trajShow();
    const header = shown.header as { threadId?: string; agentRoot?: string };
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
  const flags = parseFlags(args.slice(["show", "list", "export", "replay", "diff", "fork"].includes(sub) ? 1 : 0));
  if (sub === "list") {
    await cmdThreads(flags);
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

async function cmdRepl(flags: Flags, resumeThread: boolean): Promise<void> {
  const client = connect();
  await client.initialize(initParams(flags));
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
  console.log("type a task, or /ask /plan /agent /traj /plugins /steer /undo /apply /threads /quit");
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
      if (line === "/ask" || line === "/plan" || line === "/agent") {
        flags.mode = line.slice(1) as ModeName;
        console.log(`mode change takes effect on a new thread; current turn uses ${line.slice(1)}`);
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
}): void {
  console.log("");
  console.log("Done Report");
  console.log(`  changed_files: ${done.changed_files.join(", ") || "(none)"}`);
  for (const check of done.checks) console.log(`  check: ${check.cmd} exit=${check.exit_code}`);
  console.log(`  apply_ready: ${done.apply_ready}`);
  if (done.residual_risks?.length) console.log(`  risks: ${done.residual_risks.join("; ")}`);
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
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
