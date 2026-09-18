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
        const decision = key === "y" ? "allow" : key === "s" ? "allow_session" : "deny";
        await opts.client.approvalRespond(state.approval.id, decision);
        state = { ...state, approval: undefined, status: "running" };
        paint();
        continue;
      }
      if (line.startsWith("/steer ")) {
        await opts.client.turnSteer(line.slice(7));
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
