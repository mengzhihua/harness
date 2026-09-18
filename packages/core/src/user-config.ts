import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Mode } from "./config.ts";

export interface UserConfig {
  model?: string;
  mode?: Mode;
  profile?: string;
  network?: boolean;
  yolo?: boolean;
}

function isMode(value: string): value is Mode {
  return value === "ask" || value === "plan" || value === "agent";
}

/** Tiny YAML (key: value) from $HARNESS_HOME/config.yml. Flags and env still win. */
export async function loadUserConfig(harnessHome: string): Promise<UserConfig> {
  const file = path.join(harnessHome, "config.yml");
  if (!existsSync(file)) return {};
  const out: UserConfig = {};
  const text = await readFile(file, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.+)$/);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!.trim().replace(/^['"]|['"]$/g, "");
    if (key === "model") out.model = value;
    else if (key === "mode" && isMode(value)) out.mode = value;
    else if (key === "profile") out.profile = value;
    else if (key === "network") out.network = value === "true" || value === "yes";
    else if (key === "yolo") out.yolo = value === "true" || value === "yes";
  }
  return out;
}
