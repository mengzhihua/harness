import type { Context, Loader, ProfilePackage } from "@harness/compose";
import path from "node:path";
import type { HarnessConfig } from "./config.ts";
import { AgentLoop } from "./loop.ts";
import { createLlm } from "./llm.ts";
import { LocalFs, LocalSubprocess } from "./runtime-local.ts";
import { TrajManager, type TrajStore } from "./traj.ts";
import { ToolRouter, registerAci } from "./tools.ts";
import { WorkspaceManager } from "./workspace.ts";

export function registerBuiltinPlugins(loader: Loader): void {
  loader.register("harness.traj", trajPlugin);
  loader.register("harness.workspace", workspacePlugin);
  loader.register("harness.runtime-local", runtimePlugin);
  loader.register("harness.llm", llmPlugin);
  loader.register("harness.agent-loop", loopPlugin);
  loader.register("harness.aci-tools", (ctx, pkg) => aciPlugin(ctx, pkg, "full"));
  loader.register("harness.aci-minimal", (ctx, pkg) => aciPlugin(ctx, pkg, "minimal"));
}

async function trajPlugin(ctx: Context, _pkg: ProfilePackage): Promise<void> {
  const config = ctx.get<HarnessConfig>("config");
  ctx.provide("traj", new TrajManager(config.harnessHome));
}

async function workspacePlugin(ctx: Context, _pkg: ProfilePackage): Promise<void> {
  ctx.provide("workspace", new WorkspaceManager());
}

async function runtimePlugin(ctx: Context): Promise<void> {
  const config = ctx.get<HarnessConfig>("config");
  const unbound = path.join(config.harnessHome, "_unbound");
  // Placeholders satisfy host inject(); isolate boot rebinds to the worktree.
  ctx.provide("fs", new LocalFs(unbound));
  ctx.provide("subprocess", new LocalSubprocess(unbound));
}

async function llmPlugin(ctx: Context): Promise<void> {
  const config = ctx.get<HarnessConfig>("config");
  ctx.provide(
    "llm",
    createLlm({
      model: config.model,
      apiKey: config.openaiApiKey,
      baseUrl: config.openaiBaseUrl,
    }),
  );
}

async function loopPlugin(ctx: Context): Promise<void> {
  ctx.provide("agents", new AgentLoop());
}

async function aciPlugin(ctx: Context, _pkg: ProfilePackage, kind: "full" | "minimal"): Promise<void> {
  const router = new ToolRouter(ctx);
  registerAci(router, kind);
  ctx.provide("tools", router);
  await ctx.get<TrajStore>("traj").append("plugin", "plugin/load", {
    id: kind === "full" ? "harness.aci-tools" : "harness.aci-minimal",
    tools: router.schemas().map((s) => s.function.name),
  });
}
