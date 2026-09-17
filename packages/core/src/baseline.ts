import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { TrajStore, type TrajEvent, type TrajHeader } from "./traj.ts";
import { threadDir } from "./config.ts";
import { diffTrajectories } from "./fork.ts";

export interface Baseline {
  name: string;
  savedAt: string;
  threadId: string;
  plugin_lock: TrajHeader["plugin_lock"];
  tools: string[];
  changed_files: string[];
  apply_ready?: boolean;
}

export function baselineDir(harnessHome: string): string {
  return path.join(harnessHome.replace(/\/$/, ""), "baselines");
}

export async function saveBaseline(opts: {
  harnessHome: string;
  threadId: string;
  name: string;
}): Promise<Baseline> {
  const store = new TrajStore(threadDir(opts.harnessHome, opts.threadId));
  if (!store.header && existsSync(store.headerPath)) {
    store.header = JSON.parse(await readFile(store.headerPath, "utf8")) as TrajHeader;
  }
  const events = await store.events();
  const diff = diffTrajectories(events, events);
  const done = [...events].reverse().find((e: TrajEvent) => e.type === "done_report");
  const baseline: Baseline = {
    name: slug(opts.name),
    savedAt: new Date().toISOString(),
    threadId: opts.threadId,
    plugin_lock: store.header?.plugin_lock ?? { packages: [] },
    tools: diff.toolsA,
    changed_files: diff.filesA,
    apply_ready: (done?.payload as { apply_ready?: boolean } | undefined)?.apply_ready,
  };
  const dir = baselineDir(opts.harnessHome);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${baseline.name}.json`), JSON.stringify(baseline, null, 2));
  return baseline;
}

export async function listBaselines(harnessHome: string): Promise<Baseline[]> {
  const dir = baselineDir(harnessHome);
  if (!existsSync(dir)) return [];
  const names = await readdir(dir);
  const out: Baseline[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    out.push(JSON.parse(await readFile(path.join(dir, name), "utf8")) as Baseline);
  }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export async function checkBaseline(opts: {
  harnessHome: string;
  threadId: string;
  name: string;
}): Promise<{
  equal: boolean;
  name: string;
  saved: string[];
  current: string[];
}> {
  const saved = (await listBaselines(opts.harnessHome)).find((b) => b.name === slug(opts.name));
  if (!saved) throw new Error(`unknown baseline ${opts.name}`);
  const store = new TrajStore(threadDir(opts.harnessHome, opts.threadId));
  const current = diffTrajectories(await store.events(), await store.events()).toolsA;
  return {
    equal: JSON.stringify(saved.tools) === JSON.stringify(current),
    name: saved.name,
    saved: saved.tools,
    current,
  };
}

function slug(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").replace(/^_|_$/g, "") || "baseline";
}
