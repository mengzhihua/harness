import readline from "node:readline/promises";
import type { HarnessClient } from "@harness/sdk";
import { applyEvent, emptyTuiState, renderFrame, type TuiState } from "./frame.ts";

export async function runTui(opts: {
  client: HarnessClient;
  mode?: string;
  model?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const started = await opts.client.threadStart();
  const plugins = await opts.client.pluginList();
  let state: TuiState = emptyTuiState({
    mode: opts.mode ?? "agent",
    model: opts.model ?? "mock",
    threadId: started.threadId,
    agentRoot: started.agentRoot,
    plugins: plugins.packages.length,
    status: "ready",
  });
  const paint = () => {
    output.write(`\x1b[2J\x1b[H${renderFrame(state)}\n`);
  };
  opts.client.onEvent((method, params) => {
    state = applyEvent(state, method, params);
    paint();
  });
  paint();
  const rl = readline.createInterface({ input: input as NodeJS.ReadableStream, output: output as NodeJS.WritableStream });
  try {
    for (;;) {
      const line = (await rl.question("")).trim();
      if (!line) continue;
      if (line === "/quit" || line === "/exit") break;
      if (state.approval) {
        const key = line[0]?.toLowerCase();
        const decision =
          key === "y" ? "allow" : key === "s" ? "allow_session" : key === "a" ? "allow_always" : "deny";
        await opts.client.approvalRespond(state.approval.id, decision);
        state = { ...state, approval: undefined, status: "running" };
        paint();
        continue;
      }
      if (line.startsWith("/steer ")) {
        await opts.client.turnSteer(line.slice(7));
        continue;
      }
      if (line === "/stop" || line === "/interrupt") {
        await opts.client.turnInterrupt();
        state = { ...state, status: "interrupted", items: [...state.items, "interrupted"] };
        paint();
        continue;
      }
      const planSkip = line.match(/^\/plan skip(?:\s+(\S+))?$/);
      if (planSkip) {
        const id = planSkip[1];
        if (!id) {
          state = { ...state, items: [...state.items, "usage: /plan skip ID"] };
          paint();
          continue;
        }
        const skipped = await opts.client.planSkip(id);
        state = {
          ...state,
          plan: JSON.stringify(skipped.steps),
          items: [...state.items, `skipped ${id}`],
        };
        paint();
        continue;
      }
      if (line === "/ask" || line === "/plan" || line === "/agent") {
        const changed = await opts.client.threadMode(line.slice(1) as "ask" | "plan" | "agent");
        state = { ...state, mode: changed.mode, items: [...state.items, `mode ${changed.mode}`] };
        paint();
        continue;
      }
      if (line === "/fork") {
        const forked = await opts.client.threadFork();
        state = { ...state, items: [...state.items, `forked ${forked.threadId}`] };
        paint();
        continue;
      }
      if (line === "/undo") {
        const undone = await opts.client.undo();
        state = { ...state, items: [...state.items, `undo ${undone.id}`], status: "ready" };
        paint();
        continue;
      }
      if (line === "/apply") {
        const applied = await opts.client.apply();
        state = { ...state, items: [...state.items, applied.message] };
        paint();
        continue;
      }
      if (line === "/threads" || line.startsWith("/threads ")) {
        const query = line.slice("/threads".length).trim() || undefined;
        const { threads } = await opts.client.threadList(query);
        const rows = threads.length
          ? threads.map((t) => `${t.threadId} ${t.title}`)
          : ["(no threads)"];
        state = { ...state, items: [...state.items, ...rows] };
        paint();
        continue;
      }
      if (line === "/resume" || line.startsWith("/resume ")) {
        const id = line.slice("/resume".length).trim();
        if (!id) {
          const { threads } = await opts.client.threadList();
          const rows = threads.length
            ? threads.slice(0, 8).map((t) => `${t.threadId} ${t.title}`)
            : ["(no threads)"];
          state = { ...state, items: [...state.items, "resume: /resume THREAD_ID", ...rows] };
          paint();
          continue;
        }
        const resumed = await opts.client.threadResume(id);
        state = {
          ...state,
          threadId: resumed.threadId,
          agentRoot: resumed.agentRoot ?? state.agentRoot,
          items: [...state.items, `resumed ${resumed.threadId}`],
          status: "ready",
        };
        paint();
        continue;
      }
      if (line === "/check") {
        const checked = await opts.client.runCheck();
        state = {
          ...state,
          items: [...state.items, `check ${checked.cmd} exit ${checked.exit_code}`],
          status: checked.exit_code === 0 ? "ready" : "needs-check",
        };
        paint();
        continue;
      }
      if (line === "/config" || line.startsWith("/config ")) {
        const rest = line.slice("/config".length).trim();
        const set = rest.match(/^set\s+(\S+)\s+(.+)$/);
        if (set) {
          const cfg = await opts.client.configSet(set[1]!, set[2]!);
          state = { ...state, items: [...state.items, `config ${JSON.stringify(cfg)}`] };
        } else {
          const cfg = await opts.client.configGet();
          state = { ...state, items: [...state.items, `config ${JSON.stringify(cfg)}`] };
        }
        paint();
        continue;
      }
      if (line === "/yolo" || line === "/yolo on") {
        const cfg = await opts.client.configSet("yolo", "true");
        state = { ...state, items: [...state.items, `yolo ${cfg.yolo}`] };
        paint();
        continue;
      }
      if (line === "/yolo off") {
        const cfg = await opts.client.configSet("yolo", "false");
        state = { ...state, items: [...state.items, `yolo ${cfg.yolo}`] };
        paint();
        continue;
      }
      if (line === "/plugins") {
        const list = await opts.client.pluginList();
        state = { ...state, plugins: list.packages.length, items: [...state.items, `plugins ${list.packages.length}`] };
        paint();
        continue;
      }
      if (line === "/traj" || line.startsWith("/traj ")) {
        const source = line.slice("/traj".length).trim() || undefined;
        const shown = await opts.client.trajShow(source);
        const last = (shown.events as Array<{ type: string }>).at(-1);
        state = {
          ...state,
          items: [...state.items, `traj ${source ?? "all"} ${shown.events.length} last=${last?.type ?? "empty"}`],
        };
        paint();
        continue;
      }
      if (line.startsWith("/")) {
        state = { ...state, items: [...state.items, line], input: "" };
        paint();
        continue;
      }
      if (state.status === "running") {
        await opts.client.turnSteer(line);
        continue;
      }
      state = { ...state, input: line, status: "running" };
      paint();
      void opts.client.turnStart(line).then(
        () => {
          state = { ...state, input: "", status: state.approval ? "approval" : "ready" };
          paint();
        },
        (err) => {
          state = { ...state, status: "error", items: [...state.items, String(err)] };
          paint();
        },
      );
    }
  } finally {
    rl.close();
  }
}
