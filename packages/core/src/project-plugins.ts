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

const execFile = promisify(execFileCb);

export interface ProjectPlugin {
  id: string;
  kind: "skill" | "hook" | "tool" | "command" | "mcp";
  description?: string;
  body?: string;
  deny?: { bash?: string };
  command?: string;
  args?: string[];
  dir?: string;
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
      if (json.kind === "skill" && !json.body) {
        const skill = path.join(dir, name, "SKILL.md");
        if (existsSync(skill)) json.body = await readFile(skill, "utf8");
      }
      out.push(json);
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function mountProjectPlugins(ctx: Context, plugins: ProjectPlugin[]): Promise<void> {
  const traj = ctx.get<TrajStore>("traj");
  const lock = ctx.own<PluginLock>("plugin_lock") ?? { packages: [] };
  for (const plugin of plugins) {
    lock.packages.push({
      id: plugin.id,
      version: "0.1.0",
      plane: "isolate",
      hash: createHash("sha256").update(plugin.id).digest("hex").slice(0, 16),
    });
    await traj.append("plugin", "plugin/load", { id: plugin.id, kind: plugin.kind });

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
      const router = ctx.get<ToolRouter>("tools");
      for (const tool of mcp.tools) {
        router.register(
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
  }
  ctx.provide("plugin_lock", lock);
  ctx.provide("projectPlugins", plugins);

  const skills = plugins.filter((p) => p.kind === "skill");
  if (skills.length) {
    const catalog = skills.map((s) => `- ${s.id}: ${s.description ?? ""}\n${s.body ?? ""}`.trim()).join("\n");
    ctx.provide("skillCatalog", catalog);
  }
}

export function listPlugins(ctx: Context): Array<{ id: string; plane: string; version: string }> {
  return ctx.pluginLock().packages.map((p) => ({ id: p.id, plane: p.plane, version: p.version }));
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

export function registerPluginTools(_router: ToolRouter, _plugins: ProjectPlugin[]): void {
  // Custom tool kind is MCP in P3; path plugins install via addPlugin.
}
