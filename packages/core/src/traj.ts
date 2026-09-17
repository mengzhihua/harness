import { mkdir, readFile, appendFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PluginLock } from "@harness/compose";
import { threadDir } from "./config.ts";

export type TrajSource =
  | "user"
  | "assistant"
  | "tool"
  | "plugin"
  | "policy"
  | "checkpoint"
  | "system";

export interface TrajHeader {
  threadId: string;
  mode: string;
  model: string;
  userRoot: string;
  agentRoot: string;
  plugin_lock: PluginLock;
  startedAt: string;
}

export interface TrajEvent {
  ts: string;
  source: TrajSource;
  type: string;
  payload: unknown;
}

export class TrajStore {
  readonly dir: string;
  readonly jsonl: string;
  readonly headerPath: string;
  readonly artifactsDir: string;
  header?: TrajHeader;

  constructor(dir: string) {
    this.dir = dir;
    this.jsonl = path.join(dir, "session.jsonl");
    this.headerPath = path.join(dir, "header.json");
    this.artifactsDir = path.join(dir, "artifacts");
  }

  async init(header: TrajHeader): Promise<void> {
    this.header = header;
    await mkdir(this.artifactsDir, { recursive: true });
    await mkdir(path.join(this.dir, "checkpoints"), { recursive: true });
    await writeFile(this.headerPath, JSON.stringify(header, null, 2));
    await writeFile(path.join(this.dir, "plugins.lock.json"), JSON.stringify(header.plugin_lock, null, 2));
    if (!existsSync(this.jsonl)) await writeFile(this.jsonl, "");
  }

  async append(source: TrajSource, type: string, payload: unknown): Promise<TrajEvent> {
    const event: TrajEvent = { ts: new Date().toISOString(), source, type, payload };
    await appendFile(this.jsonl, `${JSON.stringify(event)}\n`);
    return event;
  }

  async events(): Promise<TrajEvent[]> {
    if (!existsSync(this.jsonl)) return [];
    const text = await readFile(this.jsonl, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TrajEvent);
  }

  async writeArtifact(name: string, content: string): Promise<string> {
    await mkdir(this.artifactsDir, { recursive: true });
    const file = path.join(this.artifactsDir, name);
    await writeFile(file, content);
    return file;
  }
}

export class TrajManager {
  constructor(private readonly harnessHome: string) {}

  open(threadId: string): TrajStore {
    return new TrajStore(threadDir(this.harnessHome, threadId));
  }
}

export async function listThreads(harnessHome: string): Promise<string[]> {
  const root = path.join(harnessHome, "threads");
  if (!existsSync(root)) return [];
  const names = await readdir(root);
  const dated: { id: string; mtime: number }[] = [];
  for (const id of names) {
    const header = path.join(root, id, "header.json");
    if (!existsSync(header)) continue;
    const st = await import("node:fs/promises").then((fs) => fs.stat(header));
    dated.push({ id, mtime: st.mtimeMs });
  }
  return dated.sort((a, b) => b.mtime - a.mtime).map((d) => d.id);
}

export async function loadHeader(harnessHome: string, threadId: string): Promise<TrajHeader> {
  const file = path.join(threadDir(harnessHome, threadId), "header.json");
  return JSON.parse(await readFile(file, "utf8")) as TrajHeader;
}
