import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  boot,
  listThreads,
  loadHeader,
  TrajStore,
  threadDir,
  exportTraj,
  dryReplay,
  type Booted,
  type DoneReport,
} from "@harness/core";

type ModeName = "ask" | "plan" | "agent";

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

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === "exec") {
    await cmdExec(parseFlags(rest));
    return;
  }
  if (cmd === "traj") {
    await cmdTraj(rest);
    return;
  }
  if (cmd === "apply") {
    await cmdApply(parseFlags(rest));
    return;
  }
  if (cmd === "undo") {
    await cmdUndo(parseFlags(rest));
    return;
  }
  if (cmd === "resume") {
    await cmdRepl(parseFlags(rest), true);
    return;
  }
  if (cmd === "repl") {
    await cmdRepl(parseFlags(rest), false);
    return;
  }
  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`harness — coding agent runtime

Usage:
  harness                         interactive REPL
  harness exec --prompt TEXT      one-shot turn (default worktree)
  harness resume [thread]         continue a thread in the REPL
  harness traj show [thread]      print trajectory jsonl
  harness traj list
  harness traj export [thread] -o file.traj
  harness traj replay --dry [thread]
  harness apply [thread]          merge agent branch back to user tree
  harness undo [thread]           restore last turn-begin checkpoint

Flags:
  --cwd DIR         user workspace (default: .)
  --home DIR        HARNESS_HOME (default: ~/.harness)
  --profile NAME    standard | minimal | path to yml
  --model NAME      mock (default) or any OpenAI-compatible model
  --mode MODE       ask | plan | agent (default agent)
  --in-place        write in the user tree (off by default)
  --apply           merge after a successful exec
  --yolo            auto-allow ask-once commands (network/install/push)
  --source SRC      traj show filter: user|assistant|tool|plugin|policy|checkpoint|system
  --thread ID       resume a thread
`);
}

async function cmdExec(flags: Flags): Promise<void> {
  const prompt = flags.prompt ?? flags._.join(" ");
  if (!prompt) {
    console.error("exec requires --prompt");
    process.exitCode = 1;
    return;
  }
  const session = await openSession(flags);
  try {
    const result = await session.runTurn({
      prompt,
      onEvent: (line) => console.log(line),
    });
    printDone(result.done, session);
    if (flags.apply && result.done.apply_ready) {
      const applied = await session.apply();
      console.log(applied.ok ? `applied: ${applied.message}` : `apply failed: ${applied.message}`);
    } else if (result.done.apply_ready) {
      console.log(`worktree: ${session.workspace.agentRoot}`);
      console.log(`traj:     ${session.traj.dir}`);
      console.log("not applied (pass --apply or run: harness apply)");
    }
  } finally {
    await session.close();
  }
}

async function cmdTraj(args: string[]): Promise<void> {
  const sub = args[0] ?? "show";
  const flags = parseFlags(args.slice(["show", "list", "export", "replay"].includes(sub) ? 1 : 0));
  const home = homeOf(flags);
  if (sub === "list") {
    const ids = await listThreads(home);
    if (!ids.length) {
      console.log("(no threads)");
      return;
    }
    for (const id of ids) {
      const header = await loadHeader(home, id);
      console.log(`${id}  model=${header.model}  ${header.userRoot}`);
    }
    return;
  }
  const id = flags._[0] ?? (await listThreads(home))[0];
  if (!id) {
    console.error("no threads");
    process.exitCode = 1;
    return;
  }
  const store = new TrajStore(threadDir(home, id));
  if (sub === "export") {
    const out = flags.output ?? path.join(process.cwd(), `${id}.traj`);
    console.log(await exportTraj(store.dir, out));
    return;
  }
  if (sub === "replay") {
    if (!flags.dry) {
      console.error("P2 supports --dry replay only");
      process.exitCode = 1;
      return;
    }
    const header = await loadHeader(home, id);
    store.header = header;
    const replayed = await dryReplay(store);
    console.log(JSON.stringify({ threadId: id, plugin_lock: header.plugin_lock, messages: replayed.messages.length }, null, 2));
    for (const m of replayed.messages) {
      console.log(`${m.role.padEnd(10)} ${m.content.slice(0, 120).replaceAll("\n", " ")}`);
    }
    return;
  }
  if (sub !== "show") {
    console.error(`unknown traj command: ${sub}`);
    process.exitCode = 1;
    return;
  }
  const header = await loadHeader(home, id);
  console.log(JSON.stringify(header, null, 2));
  for (const ev of await store.events()) {
    if (flags.source && ev.source !== flags.source) continue;
    const src = ev.source.padEnd(10);
    const summary = summarize(ev.payload);
    console.log(`${ev.ts}  ${src}  ${ev.type}  ${summary}`);
  }
}

async function cmdApply(flags: Flags): Promise<void> {
  const session = await resume(flags);
  try {
    const result = await session.apply();
    console.log(result.ok ? `applied: ${result.message}` : `apply failed: ${result.message}`);
  } finally {
    await session.close();
  }
}

async function cmdUndo(flags: Flags): Promise<void> {
  const session = await resume(flags);
  try {
    const id = await session.undo();
    console.log(`restored ${id}`);
  } finally {
    await session.close();
  }
}

async function cmdRepl(flags: Flags, resumeThread: boolean): Promise<void> {
  const session = resumeThread ? await resume(flags) : await openSession(flags);
  let mode: ModeName = session.config.mode;
  const inbox: string[] = [];
  console.log(`harness  thread=${session.threadId}  model=${session.config.model}  mode=${mode}`);
  console.log(`user     ${session.workspace.userRoot}`);
  console.log(`agent    ${session.workspace.agentRoot} (${session.workspace.kind})`);
  console.log("type a task, or /ask /plan /agent /traj /plugins /steer /undo /apply /quit");
  const rl = readline.createInterface({ input, output });
  const ask = async (q: string) => (await rl.question(q)).trim();
  try {
    for (;;) {
      const line = await ask("harness> ");
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      if (line === "/help") {
        printHelp();
        continue;
      }
      if (line === "/ask" || line === "/plan" || line === "/agent") {
        mode = line.slice(1) as ModeName;
        session.config.mode = mode;
        console.log(`mode=${mode}`);
        continue;
      }
      if (line === "/plugins") {
        for (const p of session.plugins()) console.log(`${p.plane.padEnd(8)} ${p.id}@${p.version}`);
        continue;
      }
      if (line.startsWith("/steer ")) {
        inbox.push(line.slice(7));
        console.log(`queued steer (${inbox.length})`);
        continue;
      }
      if (line === "/traj") {
        for (const ev of await session.traj.events()) {
          console.log(`${ev.ts}  ${ev.source}  ${ev.type}`);
        }
        continue;
      }
      if (line === "/apply") {
        const result = await session.apply();
        console.log(result.message);
        continue;
      }
      if (line === "/undo") {
        try {
          console.log(`restored ${await session.undo()}`);
        } catch (err) {
          console.log(err instanceof Error ? err.message : err);
        }
        continue;
      }
      session.config.mode = mode;
      const result = await session.runTurn({
        prompt: line,
        inbox,
        onEvent: (l) => console.log(l),
      });
      printDone(result.done, session);
    }
  } finally {
    rl.close();
    await session.close();
  }
}

function printDone(done: DoneReport, session: Booted): void {
  console.log("");
  console.log("Done Report");
  console.log(`  changed_files: ${done.changed_files.join(", ") || "(none)"}`);
  for (const check of done.checks) {
    console.log(`  check: ${check.cmd} exit=${check.exit_code}`);
  }
  console.log(`  apply_ready: ${done.apply_ready}`);
  if (done.residual_risks.length) console.log(`  risks: ${done.residual_risks.join("; ")}`);
  console.log(`  traj: ${session.traj.dir}`);
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
  source?: string;
  output?: string;
  thread?: string;
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
    else if (a === "--in-place") flags.inPlace = true;
    else if (a === "--apply") flags.apply = true;
    else if (a === "--yolo") flags.yolo = true;
    else if (a === "--dry") flags.dry = true;
    else if (a.startsWith("--")) console.error(`unknown flag ${a}`);
    else flags._.push(a);
  }
  return flags;
}

function homeOf(flags: Flags): string {
  return path.resolve(flags.home ?? process.env.HARNESS_HOME ?? path.join(process.env.HOME ?? ".", ".harness"));
}

async function openSession(flags: Flags): Promise<Booted> {
  return boot({
    userRoot: flags.cwd ?? process.cwd(),
    harnessHome: flags.home ?? process.env.HARNESS_HOME,
    profile: flags.profile,
    model: flags.model,
    mode: flags.mode,
    inPlace: flags.inPlace,
    threadId: flags.thread,
    yolo: flags.yolo,
  });
}

async function resume(flags: Flags): Promise<Booted> {
  const home = homeOf(flags);
  const threadId = flags.thread ?? flags._[0] ?? (await listThreads(home))[0];
  if (!threadId) throw new Error("no thread to resume");
  const header = await loadHeader(home, threadId);
  return boot({
    userRoot: flags.cwd ?? header.userRoot,
    harnessHome: home,
    profile: flags.profile,
    model: flags.model ?? header.model,
    mode: flags.mode ?? (header.mode as ModeName),
    inPlace: flags.inPlace,
    threadId,
    yolo: flags.yolo,
  });
}

function summarize(payload: unknown): string {
  const text = JSON.stringify(payload);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
