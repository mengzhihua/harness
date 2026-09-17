import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { TrajStore, type TrajEvent, type TrajHeader } from "./traj.ts";
import { applyRewinds, projectMessages } from "./history.ts";
import type { ChatMessage } from "./llm.ts";
import type { ToolRouter } from "./tools.ts";

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

export async function liveReplay(
  store: TrajStore,
  opts: { userRoot: string; harnessHome: string; model?: string },
): Promise<{ ok: boolean; reason?: string; threadId?: string }> {
  const header = (store.header ??
    (existsSync(store.headerPath)
      ? (JSON.parse(await readFile(store.headerPath, "utf8")) as TrajHeader)
      : undefined)) as TrajHeader | undefined;
  if (!header) return { ok: false, reason: "missing header" };
  const { boot } = await import("./boot.ts");
  const session = await boot({
    userRoot: opts.userRoot,
    harnessHome: opts.harnessHome,
    model: opts.model ?? header.model,
  });
  try {
    if (header.gitRevision && header.gitRevision !== "copy" && session.workspace.baseline !== header.gitRevision) {
      return {
        ok: false,
        reason: `revision mismatch: traj=${header.gitRevision} now=${session.workspace.baseline}`,
      };
    }
    const want = (header.plugin_lock.packages ?? []).map((p) => `${p.id}@${p.hash}`).sort();
    const have = (session.traj.header?.plugin_lock.packages ?? []).map((p) => `${p.id}@${p.hash}`).sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      return { ok: false, reason: "plugin_lock mismatch" };
    }
    const tools = session.thread.get<ToolRouter>("tools");
    const events = applyRewinds(await store.events());
    for (const e of events) {
      if (e.type !== "step") continue;
      const calls = (e.payload as { tool_calls?: Array<{ id: string; name: string; arguments: string }> }).tool_calls ?? [];
      for (const c of calls) {
        await tools.execute({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        });
      }
    }
    return { ok: true, threadId: session.threadId };
  } finally {
    await session.close();
  }
}
