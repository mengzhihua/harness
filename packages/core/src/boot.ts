import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Context, Loader } from "@harness/compose";
import type { ExecProvider, HarnessConfig, Mode } from "./config.ts";
import { newThreadId, threadDir } from "./config.ts";
import type { PlanStep } from "./mode.ts";
import { registerBuiltinPlugins } from "./plugins.ts";
import { LocalFs, LocalSubprocess } from "./runtime-local.ts";
import { DockerSubprocess } from "./runtime-docker.ts";
import { RemoteSubprocess } from "./runtime-remote.ts";
import type { TrajManager, TrajStore } from "./traj.ts";
import type { Workspace, WorkspaceManager } from "./workspace.ts";
import type { AgentLoop, TurnInput, TurnResult } from "./loop.ts";
import { Policy, type GateRequest } from "./policy.ts";
import { loadProjectPlugins, mountProjectPlugins, listPlugins } from "./project-plugins.ts";
import { applyRewinds } from "./history.ts";

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
  yolo?: boolean;
  exec?: ExecProvider;
  dockerImage?: string;
  network?: boolean;
  delegateDepth?: number;
  fusionDepth?: number;
  fusionRole?: "lead" | "sidekick";
  unattended?: boolean;
  workerId?: string;
  machineId?: string;
  approver?: (req: GateRequest, reason: string) => Promise<"allow" | "deny" | "allow_session">;
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
  undo: () => Promise<string>;
  apply: () => Promise<{ ok: boolean; message: string }>;
  plugins: () => Array<{ id: string; plane: string; version: string }>;
  close: () => Promise<void>;
}

function isMode(value: unknown): value is Mode {
  return value === "ask" || value === "plan" || value === "agent";
}

export async function boot(opts: BootOptions): Promise<Booted> {
  const profileName = opts.profile ?? "standard";
  const exec: ExecProvider =
    opts.exec ?? (profileName === "docker" ? "docker" : profileName === "remote" ? "remote" : "local");
  const harnessHome = path.resolve(opts.harnessHome ?? process.env.HARNESS_HOME ?? path.join(os.homedir(), ".harness"));
  let mode: Mode = opts.mode ?? "agent";
  let disabledPlugins: string[] | undefined;
  if (opts.threadId) {
    const headerPath = path.join(threadDir(harnessHome, opts.threadId), "header.json");
    if (existsSync(headerPath)) {
      try {
        const prev = JSON.parse(await readFile(headerPath, "utf8")) as { mode?: string; disabledPlugins?: string[] };
        if (isMode(prev.mode)) mode = prev.mode;
        disabledPlugins = prev.disabledPlugins;
      } catch {
        /* new or unreadable header */
      }
    }
  }
  const config: HarnessConfig = {
    userRoot: path.resolve(opts.userRoot),
    harnessHome,
    profile: profileName,
    profilePath: resolveProfile(profileName),
    model: opts.model ?? process.env.HARNESS_MODEL ?? "mock",
    mode,
    inPlace: opts.inPlace ?? false,
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    openaiApiKey: process.env.OPENAI_API_KEY,
    yolo: opts.yolo ?? false,
    maxSteps: opts.maxSteps ?? 12,
    exec,
    dockerImage: opts.dockerImage ?? process.env.HARNESS_DOCKER_IMAGE ?? "node:22-bookworm",
    network: opts.network ?? false,
    delegateDepth: opts.delegateDepth ?? 0,
    fusionDepth: opts.fusionDepth ?? 0,
    fusionRole: opts.fusionRole,
    unattended: opts.unattended ?? false,
    workerId: opts.workerId,
    machineId: opts.machineId,
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
  // Docker bind-mounts agentRoot at /workspace; LocalFs stays, only subprocess swaps.
  // Remote posts worker/exec to a VM; session (client) ≠ machine (this hub / URL).
  thread.provide("subprocess", bindSubprocess(workspace.agentRoot, config));

  const traj = host.get<TrajManager>("traj").open(threadId);
  await traj.init({
    threadId,
    mode: config.mode,
    model: config.model,
    userRoot: config.userRoot,
    agentRoot: workspace.agentRoot,
    plugin_lock: { packages: [] },
    startedAt: new Date().toISOString(),
    gitRevision: workspace.baseline === "copy" ? undefined : workspace.baseline,
    exec: config.exec,
    network: config.network,
    unattended: config.unattended,
    workerId: config.workerId,
    machineId: config.machineId,
    fusionRole: config.fusionRole,
    disabledPlugins,
  });
  thread.provide("traj", traj);

  const policy = new Policy({
    mode: config.mode,
    yolo: config.yolo,
    unattended: config.unattended,
    approver: opts.approver,
  });
  thread.provide("policy", policy);
  thread.onWaterfall<GateRequest>("tools/pre-execute", async (req) => {
    const out = await policy.gate(req);
    if (out.deny) {
      await traj.append("policy", "deny", { name: req.name, reason: out.reason });
    } else if (out.audit) {
      await traj.append("policy", "audit", { name: req.name, reason: out.reason });
    }
    return out;
  });

  await loader.mount(thread, config.profilePath, "isolate");
  const project = await loadProjectPlugins(config.userRoot);
  await mountProjectPlugins(thread, project);

  const lock = loader.lock(thread);
  traj.header = { ...traj.header!, plugin_lock: lock };
  await traj.init(traj.header);
  const existing = await traj.events();
  if (!existing.some((e) => e.type === "plugin_lock")) {
    await traj.append("plugin", "plugin_lock", lock);
  }
  const lastPlan = [...existing].reverse().find((e) => e.type === "plan/updated");
  const steps = (lastPlan?.payload as { steps?: PlanStep[] } | undefined)?.steps;
  if (Array.isArray(steps) && steps.length) thread.provide("plan", steps);

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
    undo: () => undoLastTurn(workspace, traj),
    apply: () => workspace.applyToUser(),
    plugins: () => listPlugins(thread),
    close: () => host.close(),
  };
}

export async function undoLastTurn(workspace: Workspace, traj: TrajStore): Promise<string> {
  const events = await traj.events();
  const visible = applyRewinds(events);
  const begins = visible.filter(
    (e) => e.type === "checkpoint/created" && (e.payload as { label?: string }).label === "turn-begin",
  );
  const lastRewind = [...events].reverse().find((e) => e.type === "rewind");
  const lastRewindId = lastRewind ? (lastRewind.payload as { id?: string }).id : undefined;
  if (lastRewindId && (begins.at(-1)?.payload as { id?: string } | undefined)?.id === lastRewindId) {
    begins.pop();
  }
  const target = begins.at(-1) as { payload: { id: string } } | undefined;
  if (!target) throw new Error("nothing to undo");
  await workspace.restore(target.payload.id);
  await traj.append("checkpoint", "rewind", { id: target.payload.id });
  return target.payload.id;
}

export function resolveProfile(name: string): string {
  if (name.endsWith(".yml") || name.endsWith(".yaml")) return path.resolve(name);
  return path.join(repoRoot, "profiles", `${name}.yml`);
}

function bindSubprocess(agentRoot: string, config: HarnessConfig) {
  if (config.exec === "docker") {
    return new DockerSubprocess(agentRoot, config.dockerImage, config.network);
  }
  if (config.exec === "remote") {
    return new RemoteSubprocess(agentRoot, config.workerId ?? "wk_local", process.env.HARNESS_WORKER_URL, config.network);
  }
  return new LocalSubprocess(agentRoot, { network: config.network });
}
