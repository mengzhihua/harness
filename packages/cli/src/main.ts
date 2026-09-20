import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { PassThrough } from "node:stream";
import { HarnessClient } from "@harness/sdk";
import { AppServer } from "@harness/server";
import { PROTOCOL_VERSION, type InitializeParams } from "@harness/protocol";
import { runTui } from "@harness/tui";
import { formatScorecard, listEvalTasks, scorecardFailed, summarizeScorecard, parseIdeSlash, listenWorkbench, type TaskScore } from "@harness/core";

type ModeName = "ask" | "plan" | "agent";

function connect(): HarnessClient {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  new AppServer(toServer, toClient);
  return new HarnessClient(toClient, toServer);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "-V" || argv[0] === "version") {
    console.log(`harness ${PROTOCOL_VERSION}`);
    return;
  }
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    printHelp();
    return;
  }
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
  if (cmd === "ide") return cmdIde(parseFlags(rest));
  if (cmd === "workbench") return cmdWorkbench(parseFlags(rest));
  if (cmd === "pr") return cmdPr(parseFlags(rest));
  if (cmd === "ci") return cmdCi(parseFlags(rest));
  if (cmd === "traj") return cmdTraj(rest);
  if (cmd === "apply") return cmdApply(parseFlags(rest));
  if (cmd === "undo") return cmdUndo(parseFlags(rest));
  if (cmd === "check") return cmdCheck(parseFlags(rest));
  if (cmd === "config") return cmdConfig(rest);
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
  harness --version               print harness <protocol>
  harness tui                     self-drawn TUI (stream + approval + input)
  harness repl                    line-oriented REPL
  harness serve                   JSON-RPC App Server on stdio
  harness exec --prompt TEXT      one-shot turn (client → App Server)
  harness resume [thread]         continue a thread in the REPL
  harness threads [--query TEXT]
  harness traj show [thread]
  harness traj list | export | replay | diff | fork
  harness apply | undo | check [thread]
  harness config [get [KEY]] | set KEY VALUE
  harness plugin add <path-or-git>
  harness plugin list | enable ID | disable ID | command ID
  harness plugin search [QUERY] | install ID
  harness ide [FILE[:LINE] | apply | undo | steer TEXT | open PATH | save PATH [CONTENT] | tui]
  harness workbench [-o FILE | --serve [--port N]]
  harness pr [--title TEXT] [--body TEXT] [--base BRANCH]
  harness ci
  harness fusion --prompt TEXT [--lead-model NAME] [--sidekick-model NAME]
  harness knowledge list | add --title TEXT --body TEXT
  harness traj baseline save|list|check NAME
  harness eval --task FILE | --dir DIR

Flags:
  --cwd DIR  --home DIR  --profile NAME  --model NAME  --mode ask|plan|agent
  --exec local|docker|remote  --docker-image NAME  --network  --unattended  --detach
  --in-place  --apply  --yolo  --source SRC  --thread ID  -o FILE  --dry  --live  --at ID  --query TEXT
  --task FILE  --dir DIR  --language LANG  --lead-model NAME  --sidekick-model NAME
  --store URL  --serve  --port N
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

async function cmdCheck(flags: Flags): Promise<void> {
  await withClient(flags, async (client) => {
    const checked = await client.runCheck();
    console.log(`${checked.cmd}  exit ${checked.exit_code}`);
    console.log(checked.summary.slice(0, 2000));
    if (checked.exit_code !== 0) process.exitCode = 1;
  }, "resume");
}

async function cmdConfig(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const op = flags._[0] ?? "get";
  await withClient(flags, async (client) => {
    if (op === "set") {
      const key = flags._[1];
      const value = flags._.slice(2).join(" ");
      if (!key || !value) {
        console.error("usage: harness config set KEY VALUE");
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(await client.configSet(key, value), null, 2));
      return;
    }
    const cfg = await client.configGet();
    const key = op === "get" ? flags._[1] : op !== "get" ? op : undefined;
    if (key && key !== "get") {
      const rec = cfg as Record<string, unknown>;
      console.log(rec[key] === undefined ? "" : String(rec[key]));
      return;
    }
    console.log(JSON.stringify(cfg, null, 2));
  });
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
  if (sub === "search") {
    await withClient(flags, async (client) => {
      const q = flags._[0] ?? flags.query;
      console.log(JSON.stringify((await client.pluginSearch(q, flags.store)).plugins, null, 2));
    });
    return;
  }
  if (sub === "install") {
    const id = flags._[0];
    if (!id) {
      console.error("plugin install requires an id from the catalog");
      process.exitCode = 1;
      return;
    }
    await withClient(flags, async (client) => {
      const added = await client.pluginInstall(id, flags.store);
      console.log(`installed ${added.id} -> ${added.dir}`);
    });
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
  await runTui({ client, mode: flags.mode, model: flags.model, language: flags.language });
  await client.shutdown();
}

async function cmdEval(flags: Flags): Promise<void> {
  const raw = flags.dir ?? flags.suite ?? flags.task ?? flags._[0] ?? flags.prompt;
  if (!raw) {
    console.error("eval requires --task FILE or --dir DIR");
    process.exitCode = 1;
    return;
  }
  const { stat } = await import("node:fs/promises");
  const abs = path.resolve(raw);
  const st = await stat(abs).catch(() => undefined);
  if (!st) {
    console.error(`eval path not found: ${abs}`);
    process.exitCode = 1;
    return;
  }
  flags.profile = flags.profile ?? "eval";
  if (st.isDirectory()) return cmdEvalSuite(flags, abs);
  return cmdEvalTask(flags, abs);
}

async function cmdEvalTask(flags: Flags, taskPath: string): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const body = await readFile(taskPath, "utf8");
  const prompt = body.trim() || "complete the eval task";
  const name = path.basename(taskPath, path.extname(taskPath));
  await withClient(flags, async (client) => {
    const done = (await client.turnStart(prompt)) as Parameters<typeof printDone>[0];
    printDone(done);
    const shown = await client.trajShow();
    const header = shown.header as { threadId?: string };
    const threadId = header.threadId ?? "task";
    const exported = await client.trajExport(
      flags.output ?? path.join(evalHome(flags), `${name}-${threadId}.traj`),
    );
    console.log(`traj: ${exported.path}`);
    const score = await client.evalScore({ task: name, traj: exported.path });
    const card = summarizeScorecard([{ ...score, task: name, traj: exported.path }]);
    console.log(formatScorecard(card));
    if (scorecardFailed(card)) process.exitCode = 1;
  }, "start");
}

async function cmdEvalSuite(flags: Flags, dir: string): Promise<void> {
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const tasks = await listEvalTasks(dir);
  if (!tasks.length) {
    console.error(`eval --dir ${dir}: no *.md tasks`);
    process.exitCode = 1;
    return;
  }
  const home = evalHome(flags);
  const scores: TaskScore[] = [];
  await withClient(flags, async (client) => {
    for (const task of tasks) {
      const prompt = (await readFile(task.path, "utf8")).trim() || "complete the eval task";
      console.log(`\n== ${task.name}`);
      const started = await client.threadStart(task.name);
      const done = (await client.turnStart(prompt)) as Parameters<typeof printDone>[0];
      printDone(done);
      const exported = await client.trajExport(path.join(home, `${task.name}-${started.threadId}.traj`));
      console.log(`traj: ${exported.path}`);
      const score = await client.evalScore({ task: task.name, traj: exported.path });
      scores.push({ ...score, task: task.name, threadId: started.threadId, traj: exported.path });
    }
  });
  const card = summarizeScorecard(scores);
  const out = flags.output && flags.output.endsWith(".json") ? flags.output : path.join(home, "scorecard.json");
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(card, null, 2));
  console.log("");
  console.log(formatScorecard(card));
  console.log(`scorecard: ${out}`);
  if (scorecardFailed(card)) process.exitCode = 1;
}

function evalHome(flags: Flags): string {
  return path.join(flags.home ?? path.join(process.env.HOME ?? ".", ".harness"), "eval");
}

async function cmdWorkbench(flags: Flags): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  if (flags.serve) {
    await withClient(
      flags,
      async (client) => {
        const view = await client.ideWorkbench();
        const host = await listenWorkbench({
          html: view.html,
          port: flags.port,
          onCommand: (p) => client.ideCommand(p.cmd, { text: p.text, path: p.path, content: p.content }),
        });
        console.log(`${view.fork} workbench ${host.url}`);
        await new Promise<void>((resolve) => {
          const stop = () => {
            void host.close().finally(() => resolve());
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
      },
      "start",
    );
    return;
  }
  await withClient(flags, async (client) => {
    const view = await client.ideWorkbench();
    const out =
      flags.output ??
      path.join(flags.home ?? path.join(process.env.HOME ?? ".", ".harness"), "ide.html");
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, view.html);
    console.log(`${view.fork} workbench ${out}`);
  }, "start");
}

async function cmdIde(flags: Flags): Promise<void> {
  const spec = flags._[0];
  const commands = new Set(["apply", "undo", "steer", "open", "tui", "save"]);
  if (spec && commands.has(spec)) {
    const thread = spec === "tui" ? undefined : "resume";
    await withClient(
      flags,
      async (client) => {
        if (spec === "tui") {
          const result = await client.ideCommand("tui");
          console.log(result.message);
          return;
        }
        const result = await client.ideCommand(spec, {
          text: spec === "steer" ? flags._.slice(1).join(" ") || flags.prompt : undefined,
          path: spec === "open" || spec === "save" ? flags._[1] : undefined,
          content: spec === "save" ? flags._.slice(2).join("\n") || undefined : undefined,
        });
        console.log(result.message);
        if (result.content && spec === "open") console.log(result.content);
        if (!result.ok) process.exitCode = 1;
      },
      thread,
    );
    return;
  }
  await withClient(flags, async (client) => {
    if (!spec) {
      const info = await client.ideStatus();
      console.log(JSON.stringify(info, null, 2));
      if (info.worktree) {
        const opened = await client.ideOpen(info.worktree);
        console.log(opened.ok ? opened.message : `ide: ${opened.message}`);
        if (!opened.ok) process.exitCode = 1;
      }
      return;
    }
    const [file, line] = spec.split(":");
    const target = file || spec;
    const opened = await client.ideOpen(target, line ? Number(line) : undefined);
    if (opened.ok) {
      console.log(opened.message);
      return;
    }
    const read = await client.ideFile(target);
    if (read.ok) {
      console.log(`workbench ${read.path}`);
      console.log(read.content);
      return;
    }
    console.log(`ide: ${opened.message}`);
    console.log(read.content);
    process.exitCode = 1;
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
    const result = await client.fusionRun(task, { leadModel: flags.leadModel, sidekickModel: flags.sidekickModel });
    console.log(`lead ${result.leadId} model=${result.leadModel ?? ""}`);
    console.log(`sidekick ${result.sidekickId} model=${result.sidekickModel ?? ""}`);
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
  console.log("type a task, or /ask /plan /agent /plan skip ID /stop /check /config /yolo /lang /open /ide /store /install /resume /fusion /traj /plugins /steer /queue /undo /apply /threads /quit");
  const rl = readline.createInterface({ input, output });
  let running = false;
  let inFlight: Promise<unknown> | undefined;
  client.onEvent((method, params) => {
    if (method === "item/delta") console.log((params as { text?: string }).text ?? "");
    if (method === "inbox/updated") {
      const q = (params as { queued?: string[] }).queued ?? [];
      console.log(q.length ? `queued ${q.length}: ${q[q.length - 1]}` : "queued 0");
    }
    if (method === "done_report" || method === "turn/completed" || method === "turn/interrupted") {
      running = false;
    }
  });
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
        const queued = await client.turnSteer(line.slice(7));
        console.log(`queued ${queued.queued}`);
        continue;
      }
      if (line === "/queue") {
        const listed = await client.turnInbox();
        if (!listed.queued.length) console.log("queued 0");
        else listed.queued.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
        continue;
      }
      if (line === "/queue clear") {
        await client.turnInboxClear();
        console.log("queued 0");
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
      if (line === "/traj" || line.startsWith("/traj ")) {
        const source = line.slice("/traj".length).trim() || undefined;
        const shown = await client.trajShow(source);
        for (const ev of shown.events as Array<{ ts: string; source: string; type: string }>) {
          console.log(`${ev.ts}  ${ev.source}  ${ev.type}`);
        }
        continue;
      }
      if (line === "/threads" || line.startsWith("/threads ")) {
        const query = line.slice("/threads".length).trim() || undefined;
        const { threads } = await client.threadList(query);
        for (const t of threads) console.log(`${t.threadId}  ${t.title}`);
        continue;
      }
      if (line === "/resume" || line.startsWith("/resume ")) {
        const id = line.slice("/resume".length).trim();
        if (!id) {
          const { threads } = await client.threadList();
          for (const t of threads) console.log(`${t.threadId}  ${t.title}`);
          console.log("usage: /resume THREAD_ID");
          continue;
        }
        const resumed = await client.threadResume(id);
        console.log(`resumed ${resumed.threadId}`);
        continue;
      }
      if (line === "/check") {
        const checked = await client.runCheck();
        console.log(`${checked.cmd}  exit ${checked.exit_code}`);
        console.log(checked.summary.slice(0, 800));
        continue;
      }
      if (line === "/config" || line.startsWith("/config ")) {
        const rest = line.slice("/config".length).trim();
        const set = rest.match(/^set\s+(\S+)\s+(.+)$/);
        if (set) console.log(JSON.stringify(await client.configSet(set[1]!, set[2]!), null, 2));
        else console.log(JSON.stringify(await client.configGet(), null, 2));
        continue;
      }
      if (line === "/yolo" || line === "/yolo on") {
        console.log(JSON.stringify(await client.configSet("yolo", "true"), null, 2));
        continue;
      }
      if (line === "/yolo off") {
        console.log(JSON.stringify(await client.configSet("yolo", "false"), null, 2));
        continue;
      }
      if (line === "/lang" || line.startsWith("/lang ")) {
        const value = line.slice("/lang".length).trim();
        if (!value) console.log((await client.configGet()).language ?? "en");
        else console.log(JSON.stringify(await client.configSet("language", value), null, 2));
        continue;
      }
      if (line.startsWith("/open ")) {
        const spec = line.slice(6).trim();
        const [file, lineNo] = spec.split(":");
        const target = file || spec;
        const opened = await client.ideOpen(target, lineNo ? Number(lineNo) : undefined);
        if (opened.ok) console.log(opened.message);
        else {
          const read = await client.ideFile(target);
          console.log(read.ok ? `workbench ${read.path}\n${read.content}` : read.content);
        }
        continue;
      }
      if (line === "/ide" || line.startsWith("/ide ")) {
        try {
          const parsed = parseIdeSlash(line);
          const result = await client.ideCommand(parsed.cmd, { text: parsed.text, path: parsed.path });
          console.log(result.message);
          if (parsed.cmd === "open" && result.content) console.log(result.content);
        } catch (err) {
          console.log(err instanceof Error ? err.message : String(err));
        }
        continue;
      }
      if (line === "/store" || line.startsWith("/store ")) {
        const q = line.slice("/store".length).trim() || undefined;
        console.log(JSON.stringify((await client.pluginSearch(q)).plugins, null, 2));
        continue;
      }
      if (line.startsWith("/install ")) {
        const added = await client.pluginInstall(line.slice("/install".length).trim());
        console.log(`installed ${added.id} -> ${added.dir}`);
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
      if (running) {
        const queued = await client.turnSteer(line);
        console.log(`queued ${queued.queued}`);
        continue;
      }
      running = true;
      inFlight = client.turnStart(line).then(
        (done) => {
          running = false;
          printDone(done as Parameters<typeof printDone>[0]);
        },
        (err) => {
          running = false;
          console.error(err instanceof Error ? err.message : err);
        },
      );
    }
  } finally {
    if (inFlight) await inFlight.catch(() => undefined);
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
  dir?: string;
  suite?: string;
  language?: string;
  leadModel?: string;
  sidekickModel?: string;
  store?: string;
  serve?: boolean;
  port?: number;
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
    else if (a === "--dir" || a === "--suite") flags.dir = next();
    else if (a === "--language" || a === "--lang") flags.language = next();
    else if (a === "--lead-model") flags.leadModel = next();
    else if (a === "--sidekick-model") flags.sidekickModel = next();
    else if (a === "--store") flags.store = next();
    else if (a === "--serve") flags.serve = true;
    else if (a === "--port") flags.port = Number(next());
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
    language: flags.language,
    leadModel: flags.leadModel,
    sidekickModel: flags.sidekickModel,
  };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
});
