import type { Context } from "@harness/compose";
import type { HarnessConfig, Mode } from "./config.ts";
import type { TrajStore } from "./traj.ts";
import { Policy } from "./policy.ts";

export async function setThreadMode(ctx: Context, mode: Mode): Promise<{ mode: Mode; threadId: string }> {
  if (mode !== "ask" && mode !== "plan" && mode !== "agent") {
    throw new Error("mode must be ask | plan | agent");
  }
  const config = ctx.get<HarnessConfig>("config");
  config.mode = mode;
  try {
    ctx.get<Policy>("policy").setMode(mode);
  } catch {
    /* policy not on this ctx */
  }
  const traj = ctx.get<TrajStore>("traj");
  await traj.updateHeader({ mode });
  await traj.append("system", "mode/change", { mode });
  return { mode, threadId: ctx.name };
}

export type PlanStep = { id: string; title: string; status: "pending" | "done" | "skipped" };

export function normalizePlan(steps: unknown): PlanStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((raw, i) => {
    const rec = raw as Partial<PlanStep> & { title?: unknown; id?: unknown; status?: unknown };
    const status = rec.status === "done" || rec.status === "skipped" ? rec.status : "pending";
    return { id: String(rec.id ?? i + 1), title: String(rec.title ?? ""), status };
  });
}

export async function setPlan(
  ctx: Context,
  steps: PlanStep[],
  source: "user" | "model" = "user",
): Promise<{ steps: PlanStep[] }> {
  const normalized = normalizePlan(steps);
  ctx.provide("plan", normalized);
  await ctx.get<TrajStore>("traj").append("assistant", "plan/updated", { steps: normalized, source });
  return { steps: normalized };
}

export function formatPlan(steps: PlanStep[] | undefined): string {
  if (!steps?.length) return "";
  return steps.map((s) => `- [${s.status === "done" ? "x" : s.status === "skipped" ? "-" : " "}] ${s.id} ${s.title}`).join("\n");
}
