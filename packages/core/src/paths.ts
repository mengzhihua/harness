import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function hereFile(explicit?: string): string {
  if (explicit) return explicit;
  const meta = import.meta?.url;
  if (typeof meta === "string" && meta.length > 0) return fileURLToPath(meta);
  try {
    // Present in the CJS release bundle (dist/harness.cjs).
    return __filename;
  } catch {
    /* ESM */
  }
  const argv1 = process.argv[1];
  if (argv1) return path.resolve(argv1);
  return process.cwd();
}

/**
 * Root that contains `profiles/` and `catalog/`.
 * Works from packages/core/src in dev and from the bundled release dist/.
 */
export function packageRoot(from?: string): string {
  if (process.env.HARNESS_ROOT) return path.resolve(process.env.HARNESS_ROOT);
  const start = hereFile(from);
  let dir = path.dirname(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, "profiles", "standard.yml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`harness profiles not found from ${start}; set HARNESS_ROOT or reinstall @harness/cli`);
}
