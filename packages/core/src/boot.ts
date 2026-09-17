import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Context, Loader } from "@harness/compose";
import type { HarnessConfig, Mode } from "./config.ts";
import { newThreadId } from "./config.ts";
import { registerBuiltinPlugins } from "./plugins.ts";
import { LocalFs, LocalSubprocess } from "./runtime-local.ts";
import type { TrajManager, TrajStore } from "./traj.ts";
import type { Workspace, WorkspaceManager } from "./workspace.ts";
import type { AgentLoop, TurnInput, TurnResult } from "./loop.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");

export interface BootOptions {
  userRoot: string;
  harnessHome?: string;
  profile?: string;
  model?: string;
  mode?: Mode;
  inPlace?: boolean;
  threadId?: string;
  maxSteps?: number;
}

export interface Booted {
  host: Context;
  thread: Context;
  loader: Loader;
  config: HarnessConfig;
  threadId: string;
  traj: TrajStore;
  workspace: Workspace;
  runTurn: (input: TurnInput) => Promise<TurnResult>;
  close: () => Promise<void>;
}

export async function boot(opts: BootOptions): Promise<Booted> {
  const profileName = opts.profile ?? "standard";
  const config: HarnessConfig = {
    userRoot: path.resolve(opts.userRoot),
    harnessHome: path.resolve(opts.harnessHome ?? process.env.HARNESS_HOME ?? path.join(os.homedir(), ".harness")),
    profile: profileName,
    profilePath: resolveProfile(profileName),
    model: opts.model ?? process.env.HARNESS_MODEL ?? "mock",
    mode: opts.mode ?? "agent",
    inPlace: opts.inPlace ?? false,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    openaiApiKey: process.env.OPENAI_API_KEY,
    maxSteps: opts.maxSteps ?? 12,
  };

  const host = new Context("host");
  host.provide("config", config);
  const loader = new Loader();
  registerBuiltinPlugins(loader);
  await loader.mount(host, config.profilePath, "host");
  await loader.await(host);

  const threadId = opts.threadId ?? newThreadId();
  const thread = host.isolate(threadId);
  thread.provide("config", config);
  thread.provide("threadId", threadId);

  const workspace = await host.get<WorkspaceManager>("workspace").beginThread({
    threadId,
    userRoot: config.userRoot,
    harnessHome: config.harnessHome,
    inPlace: config.inPlace,
  });
  thread.provide("workspace", workspace);
  thread.provide("fs", new LocalFs(workspace.agentRoot));
  thread.provide("subprocess", new LocalSubprocess(workspace.agentRoot));

  const traj = host.get<TrajManager>("traj").open(threadId);
  await traj.init({
    threadId,
    mode: config.mode,
    model: config.model,
    userRoot: config.userRoot,
    agentRoot: workspace.agentRoot,
    plugin_lock: { packages: [] },
    startedAt: new Date().toISOString(),
  });
  thread.provide("traj", traj);

  await loader.mount(thread, config.profilePath, "isolate");
  const lock = loader.lock(thread);
  traj.header = { ...traj.header!, plugin_lock: lock };
  await traj.init(traj.header);
  await traj.append("plugin", "plugin_lock", lock);

  const agents = host.get<AgentLoop>("agents");
  return {
    host,
    thread,
    loader,
    config,
    threadId,
    traj,
    workspace,
    runTurn: (input) => agents.runTurn(thread, input),
    close: () => host.close(),
  };
}

export function resolveProfile(name: string): string {
  if (name.endsWith(".yml") || name.endsWith(".yaml")) return path.resolve(name);
  return path.join(repoRoot, "profiles", `${name}.yml`);
}
