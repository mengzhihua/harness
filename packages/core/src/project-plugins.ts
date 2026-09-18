import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import type { Context } from "@harness/compose";
import type { PluginLock } from "@harness/compose";
import type { GateRequest } from "./policy.ts";
import type { TrajStore } from "./traj.ts";
import type { ToolRouter } from "./tools.ts";
import { McpClient } from "./mcp.ts";
import { missingPermission, normalizePermissions, type PluginNeed, type PluginPermissions } from "./permissions.ts";

const execFile = promisify(execFileCb);

export interface ProjectPlugin {
  id: string;
  kind: "skill" | "hook" | "tool" | "command" | "mcp" | "adapter";
  description?: string;
  body?: string;
  deny?: { bash?: string };
  command?: string;
  args?: string[];
  dir?: string;
  entry?: string;
  permissions?: PluginPermissions;
}

export async function loadProjectPlugins(userRoot: string): Promise<ProjectPlugin[]> {
  const dir = path.join(userRoot, ".harness", "plugins");
  if (!existsSync(dir)) return [];
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: ProjectPlugin[] = [];
  for (const name of names) {
    const manifest = path.join(dir, name, "plugin.json");
    if (!existsSync(manifest)) continue;
    try {
      const json = JSON.parse(await readFile(manifest, "utf8")) as ProjectPlugin;
      json.id ??= name;
      json.dir = path.join(dir, name);
      json.permissions = normalizePermissions(json.kind, json.permissions);
      out.push(json);
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function mountProjectPlugins(ctx: Context, plugins: ProjectPlugin[]): Promise<void> {
  const traj = ctx.get<TrajStore>("traj");
  const disabled = new Set(traj.header?.disabledPlugins ?? []);
  const lock = ctx.own<PluginLock>("plugin_lock") ?? { packages: [] };
  const router = ctx.has("tools") ? ctx.get<ToolRouter>("tools") : undefined;
  const pluginTools = new Map<string, ProjectPlugin>();
  for (const plugin of plugins) {
    const enabled = !disabled.has(plugin.id);
    const perms = plugin.permissions ?? normalizePermissions(plugin.kind, plugin.permissions);
    plugin.permissions = perms;
    lock.packages.push({
      id: plugin.id,
      version: "0.1.0",
      plane: "isolate",
      hash: createHash("sha256").update(plugin.id).digest("hex").slice(0, 16),
      enabled,
    });
    await traj.append("plugin", "plugin/load", { id: plugin.id, kind: plugin.kind, enabled, permissions: perms });
    if (!enabled) continue;

    if ((plugin.kind === "mcp" || plugin.kind === "command" || plugin.kind === "tool") && missingPermission(perms, "subprocess")) {
      await traj.append("plugin", "plugin/permission", { id: plugin.id, deny: "subprocess" });
      await traj.append("plugin", "plugin/error", { id: plugin.id, error: `${plugin.kind} requires permissions.subprocess` });
      continue;
    }

    if (plugin.kind === "hook" && plugin.deny?.bash) {
      const rx = new RegExp(plugin.deny.bash);
      ctx.onWaterfall<GateRequest>("tools/pre-execute", async (req) => {
        if (req.deny) return req;
        if (req.name !== "bash") return req;
        const cmd = String(req.args.command ?? "");
        if (rx.test(cmd)) {
          await traj.append("plugin", "hook_block", { id: plugin.id, command: cmd });
          return { ...req, deny: true, reason: `blocked by plugin ${plugin.id}` };
        }
        return req;
      });
    }
    if (plugin.kind === "mcp" && plugin.command) {
      const mcp = await McpClient.start({
        command: plugin.command,
        args: plugin.args,
        cwd: plugin.dir,
      });
      ctx.effect(() => () => mcp.close());
      const tools = ctx.get<ToolRouter>("tools");
      for (const tool of mcp.tools) {
        pluginTools.set(tool.name, plugin);
        tools.register(
          {
            type: "function",
            function: {
              name: tool.name,
              description: tool.description ?? `MCP ${plugin.id}`,
              parameters: tool.inputSchema ?? { type: "object", properties: {} },
            },
          },
          async (args) => {
            const text = await mcp.call(tool.name, args);
            await traj.append("plugin", "mcp/call", { id: plugin.id, tool: tool.name });
            return text;
          },
        );
      }
    }
    if (plugin.kind === "tool" && router && plugin.command) {
      const name = plugin.id.replace(/[^\w]+/g, "_");
      pluginTools.set(name, plugin);
      router.register(
        {
          type: "function",
          function: {
            name,
            description: plugin.description ?? `plugin command ${plugin.id}`,
            parameters: { type: "object", properties: {} },
          },
        },
        async () => runProjectCommand(ctx, plugin.id).then((r) => r.output),
      );
    }
    if (plugin.kind === "adapter") {
      await mountAdapter(ctx, plugin, traj);
    }
  }
  ctx.provide("plugin_lock", lock);
  ctx.provide("projectPlugins", plugins);
  ctx.provide("pluginTools", pluginTools);
  ctx.onWaterfall<GateRequest>("tools/pre-execute", async (req) => {
    if (req.deny) return req;
    const owner = pluginTools.get(req.name);
    if (!owner?.permissions) return req;
    const need = inferPluginNeed(req);
    if (!need) return req;
    const denied = missingPermission(owner.permissions, need);
    if (!denied) return req;
    await traj.append("plugin", "plugin/permission", { id: owner.id, deny: denied, tool: req.name });
    return { ...req, deny: true, reason: `plugin ${owner.id} lacks permissions.${denied}` };
  });

  const skills = plugins.filter((p) => p.kind === "skill" && !disabled.has(p.id));
  if (skills.length) {
    const catalog = [
      ...skills.map((s) => `- ${s.id}: ${s.description ?? ""}`),
      "Call read_skill with a skill id to load SKILL.md.",
    ].join("\n");
    ctx.provide("skillCatalog", catalog);
  }
}

export function listPlugins(ctx: Context): Array<{ id: string; plane: string; version: string; enabled: boolean }> {
  return ctx.pluginLock().packages.map((p) => ({
    id: p.id,
    plane: p.plane,
    version: p.version,
    enabled: p.enabled !== false,
  }));
}

export async function setPluginEnabled(ctx: Context, id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> {
  const traj = ctx.get<TrajStore>("traj");
  const lock = ctx.pluginLock();
  const found = lock.packages.find((p) => p.id === id);
  if (!found) throw new Error(`unknown plugin ${id}`);
  found.enabled = enabled;
  const disabled = new Set(traj.header?.disabledPlugins ?? []);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  await traj.updateHeader({ plugin_lock: ctx.pluginLock(), disabledPlugins: [...disabled] });
  await traj.append("plugin", "plugin/change", { id, enabled });
  return { id, enabled };
}

export async function runProjectCommand(
  ctx: Context,
  id: string,
): Promise<{ ok: boolean; output: string }> {
  const plugins = ctx.has("projectPlugins") ? ctx.get<ProjectPlugin[]>("projectPlugins") : [];
  const plugin = plugins.find((p) => p.id === id);
  if (!plugin) throw new Error(`unknown plugin ${id}`);
  if (plugin.kind !== "command" && plugin.kind !== "tool") {
    throw new Error(`${id} is not a command plugin`);
  }
  if (!plugin.command) throw new Error(`${id} has no command`);
  const perms = plugin.permissions ?? normalizePermissions(plugin.kind, plugin.permissions);
  if (missingPermission(perms, "subprocess")) {
    throw new Error(`${id} lacks permissions.subprocess`);
  }
  const traj = ctx.get<TrajStore>("traj");
  const { LocalSubprocess } = await import("./runtime-local.ts");
  const workspace = ctx.get<{ agentRoot: string }>("workspace");
  const sub = new LocalSubprocess(workspace.agentRoot, { network: false });
  const cmd = [plugin.command, ...(plugin.args ?? [])].join(" ");
  const result = await sub.exec(cmd);
  const output = `exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`;
  await traj.append("plugin", "command/run", { id, exit: result.exitCode });
  return { ok: result.exitCode === 0, output };
}

export function looksLikeGit(source: string): boolean {
  return /^(git@|ssh:\/\/|git:\/\/|https?:\/\/)/.test(source) || source.endsWith(".git");
}

export async function addPlugin(opts: { userRoot: string; source: string }): Promise<{
  id: string;
  dir: string;
  kind?: string;
}> {
  const destBase = path.join(path.resolve(opts.userRoot), ".harness", "plugins");
  await mkdir(destBase, { recursive: true });

  let srcDir = path.resolve(opts.source);
  let cloned: string | undefined;
  if (looksLikeGit(opts.source)) {
    cloned = await mkdtemp(path.join(os.tmpdir(), "harness-plugin-"));
    await execFile("git", ["clone", "--depth", "1", opts.source, cloned]);
    srcDir = cloned;
  }
  if (!existsSync(srcDir)) throw new Error(`plugin source not found: ${opts.source}`);
  try {
    const manifestPath = path.join(srcDir, "plugin.json");
    if (!existsSync(manifestPath)) throw new Error(`no plugin.json in ${opts.source}`);
    const json = JSON.parse(await readFile(manifestPath, "utf8")) as { id?: string; kind?: string };
    const id = sanitizePluginId(json.id ?? path.basename(srcDir));
    const dest = path.join(destBase, id);
    if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
    await cp(srcDir, dest, {
      recursive: true,
      filter: (p) => path.basename(p) !== ".git",
    });
    return { id, dir: dest, kind: json.kind };
  } finally {
    if (cloned) await rm(cloned, { recursive: true, force: true }).catch(() => undefined);
  }
}

function sanitizePluginId(id: string): string {
  const s = id.replace(/[^\w.@+-]/g, "_");
  if (!s) throw new Error("invalid plugin id");
  return s;
}

function inferPluginNeed(req: GateRequest): PluginNeed | undefined {
  if (req.name === "web_search" || req.name === "web_fetch" || req.name === "browser") return "network";
  if (req.name === "bash") {
    const cmd = String(req.args.command ?? "");
    if (/\b(curl|wget|npm\s+i|pnpm\s+add|pip\s+install)\b/i.test(cmd)) return "network";
  }
  const url = String(req.args.url ?? "");
  if (/^https?:\/\//i.test(url)) return "network";
  return undefined;
}

async function mountAdapter(ctx: Context, plugin: ProjectPlugin, traj: TrajStore): Promise<void> {
  const entry = plugin.entry ?? "adapter.mjs";
  const file = path.join(plugin.dir ?? "", entry);
  if (!plugin.dir || !existsSync(file)) {
    await traj.append("plugin", "plugin/error", { id: plugin.id, error: `adapter entry missing: ${entry}` });
    throw new Error(`adapter ${plugin.id} has no ${entry}`);
  }
  const { pathToFileURL } = await import("node:url");
  const mod = (await import(pathToFileURL(file).href)) as {
    createLlm?: () => { chat: (req: unknown, signal?: AbortSignal) => Promise<unknown> };
  };
  if (typeof mod.createLlm !== "function") {
    await traj.append("plugin", "plugin/error", { id: plugin.id, error: "createLlm export missing" });
    throw new Error(`adapter ${plugin.id} must export createLlm()`);
  }
  ctx.provide("llm", mod.createLlm());
  await traj.append("plugin", "plugin/load", { id: plugin.id, kind: "adapter", entry });
}

export function registerPluginTools(_router: ToolRouter, _plugins: ProjectPlugin[]): void {
  // Custom tool kind is MCP in P3; path plugins install via addPlugin.
}
