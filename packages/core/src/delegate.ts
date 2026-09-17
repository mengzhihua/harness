import type { Context } from "@harness/compose";
import type { HarnessConfig } from "./config.ts";
import type { TrajStore } from "./traj.ts";
import type { Workspace } from "./workspace.ts";

export interface DelegateResult {
  childId: string;
  summary: string;
  apply_ready: boolean;
  changed_files: string[];
}

/** Spawn a nested thread on the same AgentWorkspace. Parent traj records a summary only. */
export async function runDelegate(ctx: Context, task: string, title?: string): Promise<DelegateResult> {
  const config = ctx.get<HarnessConfig>("config");
  if ((config.delegateDepth ?? 0) >= 1) {
    throw new Error("nested delegate is not allowed");
  }
  const parentTraj = ctx.get<TrajStore>("traj");
  const workspace = ctx.get<Workspace>("workspace");
  const { boot } = await import("./boot.ts");
  const child = await boot({
    userRoot: workspace.agentRoot,
    harnessHome: config.harnessHome,
    model: config.model,
    mode: "agent",
    profile: config.profile,
    inPlace: true,
    maxSteps: Math.min(6, config.maxSteps),
    yolo: config.yolo,
    delegateDepth: 1,
    exec: config.exec,
    dockerImage: config.dockerImage,
    network: config.network,
  });
  try {
    await child.traj.updateHeader({
      parentThreadId: parentTraj.header?.threadId,
      title: (title ?? task).slice(0, 80),
    });
    const turn = await child.runTurn({ prompt: task });
    const result: DelegateResult = {
      childId: child.threadId,
      summary: turn.done.message.slice(0, 800),
      apply_ready: turn.done.apply_ready,
      changed_files: turn.done.changed_files,
    };
    await parentTraj.updateHeader({
      childThreadIds: [...(parentTraj.header?.childThreadIds ?? []), result.childId],
    });
    await parentTraj.append("tool", "delegate", result);
    return result;
  } finally {
    await child.close();
  }
}
