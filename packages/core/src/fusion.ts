import type { Context } from "@harness/compose";
import type { HarnessConfig } from "./config.ts";
import type { TrajStore } from "./traj.ts";
import type { Workspace } from "./workspace.ts";

export interface FusionResult {
  leadId: string;
  sidekickId: string;
  brief: string;
  summary: string;
  apply_ready: boolean;
  changed_files: string[];
  leadModel?: string;
  sidekickModel?: string;
}

/**
 * Lead and Sidekick are two sessions. They do not share transcripts.
 * The parent trajectory records only brief + result.
 */
export async function runFusion(
  ctx: Context,
  task: string,
  opts?: { leadModel?: string; sidekickModel?: string },
): Promise<FusionResult> {
  const config = ctx.get<HarnessConfig>("config");
  if ((config.fusionDepth ?? 0) >= 1) {
    throw new Error("nested fusion is not allowed");
  }
  const parentTraj = ctx.get<TrajStore>("traj");
  const workspace = ctx.get<Workspace>("workspace");
  const { boot } = await import("./boot.ts");
  const leadModel = opts?.leadModel ?? config.leadModel ?? config.model;
  const sidekickModel = opts?.sidekickModel ?? config.sidekickModel ?? config.model;
  const shared = {
    userRoot: workspace.agentRoot,
    harnessHome: config.harnessHome,
    profile: config.profile,
    inPlace: true as const,
    yolo: config.yolo,
    exec: config.exec,
    dockerImage: config.dockerImage,
    network: config.network,
    unattended: config.unattended,
    language: config.language,
    fusionDepth: 1,
    delegateDepth: 1,
  };

  const lead = await boot({
    ...shared,
    model: leadModel,
    mode: "plan",
    maxSteps: Math.min(4, config.maxSteps),
    fusionRole: "lead",
  });
  let brief = "";
  try {
    await lead.traj.updateHeader({
      parentThreadId: parentTraj.header?.threadId,
      title: `lead: ${task}`.slice(0, 80),
      fusionRole: "lead",
    });
    const leadTurn = await lead.runTurn({
      prompt: `Fusion Lead: inspect if needed, then output a BRIEF for the Sidekick.\n\nTask:\n${task}`,
    });
    brief = extractBrief(leadTurn.done.message) || `BRIEF:\ngoal: ${task}\ntest: node --test`;
  } finally {
    await lead.close();
  }

  const sidekick = await boot({
    ...shared,
    model: sidekickModel,
    mode: "agent",
    maxSteps: Math.min(8, config.maxSteps),
    fusionRole: "sidekick",
  });
  try {
    await sidekick.traj.updateHeader({
      parentThreadId: parentTraj.header?.threadId,
      title: `sidekick: ${task}`.slice(0, 80),
      fusionRole: "sidekick",
    });
    const sideTurn = await sidekick.runTurn({ prompt: brief });
    const result: FusionResult = {
      leadId: lead.threadId,
      sidekickId: sidekick.threadId,
      brief: brief.slice(0, 2000),
      summary: sideTurn.done.message.slice(0, 800),
      apply_ready: sideTurn.done.apply_ready,
      changed_files: sideTurn.done.changed_files,
      leadModel,
      sidekickModel,
    };
    await parentTraj.updateHeader({
      childThreadIds: [...(parentTraj.header?.childThreadIds ?? []), result.leadId, result.sidekickId],
    });
    await parentTraj.append("system", "fusion", result);
    return result;
  } finally {
    await sidekick.close();
  }
}

export function extractBrief(message: string): string {
  const idx = message.search(/BRIEF\s*:/i);
  if (idx >= 0) return message.slice(idx).trim();
  return message.trim();
}
