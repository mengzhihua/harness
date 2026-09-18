import path from "node:path";

/** Remember `cd dir` so the next bash without cwd starts there. Never escapes the workspace. */
export function nextShellCwd(command: string, currentRel: string, exitCode: number): string {
  if (exitCode !== 0) return currentRel;
  const m = command.match(/^\s*cd\s+([^\s;&|]+)/);
  if (!m) return currentRel;
  const dest = m[1]!.replace(/^['"]|['"]$/g, "");
  if (!dest || dest === "-") return currentRel;
  const joined = path.posix.normalize(path.posix.join(currentRel || ".", dest.replaceAll("\\", "/")));
  if (joined.startsWith("..") || path.posix.isAbsolute(joined)) return currentRel;
  return joined === "." ? "" : joined;
}

export function resolveShellCwd(root: string, requested?: string, lastRel = ""): { abs: string; rel: string } {
  const relIn = requested ?? (lastRel || undefined);
  const abs = relIn ? path.resolve(root, relIn) : root;
  const rel = path.relative(root, abs);
  return { abs, rel: rel === "" ? "" : rel.replaceAll("\\", "/") };
}
