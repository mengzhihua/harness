import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { TrajStore, type TrajEvent } from "./traj.ts";
import { applyRewinds, projectMessages } from "./history.ts";
import type { ChatMessage } from "./llm.ts";

const execFile = promisify(execFileCb);

export async function exportTraj(threadDir: string, outFile: string): Promise<string> {
  const abs = path.resolve(outFile);
  await mkdir(path.dirname(abs), { recursive: true });
  const parent = path.dirname(threadDir);
  const base = path.basename(threadDir);
  await execFile("tar", ["-czf", abs, "-C", parent, base]);
  return abs;
}

export async function dryReplay(store: TrajStore): Promise<{
  header: unknown;
  messages: ChatMessage[];
  events: TrajEvent[];
}> {
  const events = applyRewinds(await store.events());
  return {
    header: store.header ?? (existsSync(store.headerPath) ? JSON.parse(await (await import("node:fs/promises")).readFile(store.headerPath, "utf8")) : undefined),
    messages: projectMessages(events),
    events,
  };
}
