import { TrajStore, loadHeader, type TrajSource } from "./traj.ts";
import { threadDir, newThreadId } from "./config.ts";
import { WorkspaceManager } from "./workspace.ts";

export async function forkThread(opts: {
  harnessHome: string;
  sourceId: string;
  at?: string;
  userRoot?: string;
}): Promise<{ threadId: string; agentRoot: string; parentThreadId: string }> {
  const header = await loadHeader(opts.harnessHome, opts.sourceId);
  const source = new TrajStore(threadDir(opts.harnessHome, opts.sourceId));
  const events = await source.events();
  let cut = events.length;
  if (opts.at) {
    const idx = events.findIndex(
      (e) => e.type === "checkpoint/created" && (e.payload as { id?: string }).id === opts.at,
    );
    if (idx < 0) throw new Error(`unknown checkpoint ${opts.at}`);
    cut = idx + 1;
  } else {
    const last = [...events].reverse().find((e) => e.type === "checkpoint/created");
    if (last) {
      cut = events.indexOf(last) + 1;
      opts.at = (last.payload as { id: string }).id;
    }
  }
  const prefix = events.slice(0, cut);
  const threadId = newThreadId();
  const ws = await new WorkspaceManager().beginThread({
    threadId,
    userRoot: opts.userRoot ?? header.userRoot,
    harnessHome: opts.harnessHome,
    inPlace: false,
  });
  if (opts.at && ws.kind === "worktree") {
    await ws.restore(opts.at);
  }
  const dest = new TrajStore(threadDir(opts.harnessHome, threadId));
  await dest.init({
    ...header,
    threadId,
    agentRoot: ws.agentRoot,
    parentThreadId: opts.sourceId,
    startedAt: new Date().toISOString(),
    title: `${header.title ?? opts.sourceId} (fork)`,
  });
  for (const e of prefix) {
    await dest.append(e.source as TrajSource, e.type, e.payload);
  }
  await dest.append("system", "fork", { parent: opts.sourceId, at: opts.at ?? null });
  return { threadId, agentRoot: ws.agentRoot, parentThreadId: opts.sourceId };
}

export function diffTrajectories(
  a: TrajEvent[],
  b: TrajEvent[],
): {
  toolsA: string[];
  toolsB: string[];
  filesA: string[];
  filesB: string[];
  toolSequenceEqual: boolean;
} {
  const toolsA = toolSeq(a);
  const toolsB = toolSeq(b);
  return {
    toolsA,
    toolsB,
    filesA: filesOf(a),
    filesB: filesOf(b),
    toolSequenceEqual: JSON.stringify(toolsA) === JSON.stringify(toolsB),
  };
}

function toolSeq(events: TrajEvent[]): string[] {
  const names: string[] = [];
  for (const e of events) {
    if (e.type !== "step") continue;
    const calls = (e.payload as { tool_calls?: Array<{ name: string }> }).tool_calls ?? [];
    for (const c of calls) names.push(c.name);
  }
  return names;
}

function filesOf(events: TrajEvent[]): string[] {
  const last = [...events].reverse().find((e) => e.type === "done_report");
  if (!last) return [];
  return ((last.payload as { changed_files?: string[] }).changed_files ?? []).slice().sort();
}
