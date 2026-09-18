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

function isTrue(value: string): boolean {
  return /^(true|yes|on|1)$/i.test(value);
}

function isFalse(value: string): boolean {
  return /^(false|no|off|0)$/i.test(value);
}

/** Patch one key. Unknown keys throw. Boolean keys accept true/false/on/off. */
export function patchUserConfig(cfg: UserConfig, key: string, value: string): UserConfig {
  const next: UserConfig = { ...cfg, allow: cfg.allow?.slice() };
  if (key === "model") next.model = value;
  else if (key === "mode") {
    if (!isMode(value)) throw new Error("mode must be ask | plan | agent");
    next.mode = value;
  } else if (key === "profile") next.profile = value;
  else if (key === "network") {
    if (!isTrue(value) && !isFalse(value)) throw new Error("network must be true or false");
    next.network = isTrue(value);
  } else if (key === "yolo") {
    if (!isTrue(value) && !isFalse(value)) throw new Error("yolo must be true or false");
    next.yolo = isTrue(value);
  } else if (key === "allow") {
    next.allow = value.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    throw new Error(`unknown config key ${key} (model|mode|profile|network|yolo|allow)`);
  }
  return next;
}

export async function setUserConfig(harnessHome: string, key: string, value: string): Promise<UserConfig> {
  const cfg = patchUserConfig(await loadUserConfig(harnessHome), key, value);
  await saveUserConfig(harnessHome, cfg);
  return cfg;
}

/** Persist an approval signature so later threads skip the ask. */
export async function rememberAllow(harnessHome: string, signature: string): Promise<void> {
  const cfg = await loadUserConfig(harnessHome);
  const allow = new Set(cfg.allow ?? []);
  allow.add(signature);
  cfg.allow = [...allow];
  await saveUserConfig(harnessHome, cfg);
}
