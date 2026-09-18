import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** Load AGENTS.md from git root toward cwd (worktree-mapped). Nearer files come last. */
export async function loadAgentsMd(opts: { agentRoot: string; userRoot: string }): Promise<string> {
  const gitRoot = findGitRoot(opts.userRoot) ?? path.resolve(opts.userRoot);
  const rel = path.relative(gitRoot, path.resolve(opts.userRoot));
  const dirs = [opts.agentRoot];
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    let acc = opts.agentRoot;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      acc = path.join(acc, part);
      dirs.push(acc);
    }
  }
  const chunks: string[] = [];
  for (const dir of dirs) {
    const file = path.join(dir, "AGENTS.md");
    if (!existsSync(file)) continue;
    const body = (await readFile(file, "utf8")).trim();
    if (!body) continue;
    const label = path.relative(opts.agentRoot, file) || "AGENTS.md";
    chunks.push(`### ${label}\n${body}`);
  }
  return chunks.join("\n\n");
}

export function findGitRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (let i = 0; i < 16; i++) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
