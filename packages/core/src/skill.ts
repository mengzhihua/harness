import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Context } from "@harness/compose";
import type { ProjectPlugin } from "./project-plugins.ts";
import type { TrajStore } from "./traj.ts";

/** Load SKILL.md for one catalog id. Startup never dumps bodies into the prompt. */
export async function readSkill(ctx: Context, id: string): Promise<string> {
  if (!id) throw new Error("read_skill requires id");
  const plugins = ctx.has("projectPlugins") ? ctx.get<ProjectPlugin[]>("projectPlugins") : [];
  const plugin = plugins.find((p) => p.kind === "skill" && p.id === id);
  if (!plugin) throw new Error(`unknown skill ${id}`);
  const traj = ctx.get<TrajStore>("traj");
  if ((traj.header?.disabledPlugins ?? []).includes(id)) {
    throw new Error(`skill ${id} is disabled`);
  }
  let body = plugin.body?.trim() ?? "";
  if (!body && plugin.dir) {
    const file = path.join(plugin.dir, "SKILL.md");
    if (existsSync(file)) body = (await readFile(file, "utf8")).trim();
  }
  if (!body) throw new Error(`skill ${id} has no SKILL.md`);
  const clipped = body.slice(0, 24_000);
  await traj.append("plugin", "skill/read", { id, bytes: clipped.length });
  return clipped;
}
