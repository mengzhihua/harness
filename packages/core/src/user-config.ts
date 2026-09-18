import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Mode } from "./config.ts";

export interface UserConfig {
  model?: string;
  mode?: Mode;
  profile?: string;
  network?: boolean;
  yolo?: boolean;
  /** Policy signatures remembered across threads (`[a] always`). */
  allow?: string[];
}

function isMode(value: string): value is Mode {
  return value === "ask" || value === "plan" || value === "agent";
}

function configPath(harnessHome: string): string {
  return path.join(harnessHome, "config.yml");
}

/** Tiny YAML (key: value) from $HARNESS_HOME/config.yml. Flags and env still win. */
export async function loadUserConfig(harnessHome: string): Promise<UserConfig> {
  const file = configPath(harnessHome);
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
    else if (key === "allow") {
      const extra = value.split(",").map((s) => s.trim()).filter(Boolean);
      out.allow = [...(out.allow ?? []), ...extra];
    }
  }
  return out;
}

export function formatUserConfig(cfg: UserConfig): string {
  const lines: string[] = [];
  if (cfg.model) lines.push(`model: ${cfg.model}`);
  if (cfg.mode) lines.push(`mode: ${cfg.mode}`);
  if (cfg.profile) lines.push(`profile: ${cfg.profile}`);
  if (cfg.network !== undefined) lines.push(`network: ${cfg.network}`);
  if (cfg.yolo !== undefined) lines.push(`yolo: ${cfg.yolo}`);
  if (cfg.allow?.length) lines.push(`allow: ${cfg.allow.join(", ")}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export async function saveUserConfig(harnessHome: string, cfg: UserConfig): Promise<void> {
  await mkdir(harnessHome, { recursive: true });
  await writeFile(configPath(harnessHome), formatUserConfig(cfg), "utf8");
}

/** Persist an approval signature so later threads skip the ask. */
export async function rememberAllow(harnessHome: string, signature: string): Promise<void> {
  const cfg = await loadUserConfig(harnessHome);
  const allow = new Set(cfg.allow ?? []);
  allow.add(signature);
  cfg.allow = [...allow];
  await saveUserConfig(harnessHome, cfg);
}
