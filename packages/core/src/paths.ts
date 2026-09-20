import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function hereFile(explicit?: string): string {
  if (explicit) return explicit;
  const meta = import.meta?.url;
  if (typeof meta === "string" && meta.length > 0) {
    try {
      return fileURLToPath(meta);
    } catch {
      /* not a file URL */
    }
  }
  try {
    // Present in the CJS release bundle and Node SEA executables.
    return __filename;
  } catch {
    /* ESM */
  }
  const argv1 = process.argv[1];
  if (argv1) return path.resolve(argv1);
  return process.execPath || process.cwd();
}

function startCandidates(from?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value?: string) => {
    if (!value) return;
    const resolved = path.resolve(value);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  };
  add(from ? hereFile(from) : hereFile());
  add(process.execPath);
  return out;
}

function walkProfiles(start: string): string | undefined {
  let dir = path.dirname(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, "profiles", "standard.yml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Root that contains `profiles/` and `catalog/`.
 * Works from packages/core/src in dev, the bundled release dist/,
 * and Node SEA native executables (Windows/macOS/Linux).
 */
export function packageRoot(from?: string): string {
  if (process.env.HARNESS_ROOT) return path.resolve(process.env.HARNESS_ROOT);
  const starts = startCandidates(from);
  for (const start of starts) {
    const found = walkProfiles(start);
    if (found) return found;
  }
  throw new Error(
    `harness profiles not found from ${starts[0]}; set HARNESS_ROOT or unpack the platform bundle next to the executable`,
  );
}
