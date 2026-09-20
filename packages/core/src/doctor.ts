import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { packageRoot } from "./paths.ts";
import { listCatalog } from "./store.ts";
import { formatUserConfig, loadUserConfig } from "./user-config.ts";

const execFile = promisify(execFileCb);

export type DoctorLevel = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  ok: boolean;
  level: DoctorLevel;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  protocol: string;
  root?: string;
  checks: DoctorCheck[];
}

function check(id: string, level: DoctorLevel, message: string): DoctorCheck {
  return { id, ok: level !== "fail", level, message };
}

async function probe(cmd: string, args: string[], cwd?: string): Promise<{ ok: boolean; text: string }> {
  try {
    const { stdout, stderr } = await execFile(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: 4000,
    });
    return { ok: true, text: `${stdout}${stderr}`.trim() };
  } catch (err) {
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
}

/** Host-side install health. Never prints secret values. */
export async function runDoctor(opts?: { cwd?: string; home?: string }): Promise<DoctorReport> {
  const cwd = path.resolve(opts?.cwd ?? process.cwd());
  const home = path.resolve(opts?.home ?? path.join(process.env.HOME ?? ".", ".harness"));
  const checks: DoctorCheck[] = [];

  checks.push(check("protocol", "ok", PROTOCOL_VERSION));

  let root: string | undefined;
  try {
    root = packageRoot();
    checks.push(check("package_root", "ok", root));
  } catch (err) {
    checks.push(check("package_root", "fail", err instanceof Error ? err.message : String(err)));
  }

  if (root) {
    const profile = path.join(root, "profiles", "standard.yml");
    checks.push(
      existsSync(profile)
        ? check("profiles", "ok", "standard.yml")
        : check("profiles", "fail", `missing ${profile}`),
    );
    try {
      const plugins = await listCatalog(path.join(root, "catalog"));
      checks.push(
        plugins.length > 0
          ? check("catalog", "ok", `${plugins.length} plugins`)
          : check("catalog", "warn", "0 plugins"),
      );
    } catch (err) {
      checks.push(check("catalog", "fail", err instanceof Error ? err.message : String(err)));
    }
  } else {
    checks.push(check("profiles", "fail", "no package root"));
    checks.push(check("catalog", "fail", "no package root"));
  }

  const major = Number(process.versions.node.split(".")[0]);
  const nodeLabel = `v${process.versions.node}`;
  if (major >= 22) checks.push(check("node", "ok", nodeLabel));
  else if (major >= 20) checks.push(check("node", "warn", `${nodeLabel} (want 22+)`));
  else checks.push(check("node", "fail", `${nodeLabel} (need 22+)`));

  const gitVer = await probe("git", ["--version"]);
  if (gitVer.ok) checks.push(check("git", "ok", gitVer.text.split("\n")[0] || "git"));
  else checks.push(check("git", "fail", "git not found (worktree needs git)"));

  const inside = await probe("git", ["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside.ok && inside.text.split("\n")[0]?.trim() === "true") {
    checks.push(check("cwd_git", "ok", cwd));
  } else {
    checks.push(check("cwd_git", "warn", `${cwd} is not a git repository`));
  }

  const cfg = await loadUserConfig(home);
  const cfgFile = path.join(home, "config.yml");
  if (!existsSync(cfgFile)) {
    checks.push(check("config", "ok", "missing"));
  } else {
    const summary = formatUserConfig(cfg).trim().replace(/\s+/g, " ") || "empty";
    checks.push(check("config", "ok", summary.slice(0, 80)));
  }

  const keySet = Boolean(process.env.OPENAI_API_KEY);
  if (keySet) checks.push(check("api_key", "ok", "OPENAI_API_KEY set"));
  else checks.push(check("api_key", "warn", "OPENAI_API_KEY unset (mock still works)"));

  checks.push(check("network", "ok", cfg.network === true ? "enabled in config.yml" : "default off"));

  return {
    ok: checks.every((c) => c.level !== "fail"),
    protocol: PROTOCOL_VERSION,
    root,
    checks,
  };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [`harness ${report.protocol} doctor`];
  for (const c of report.checks) {
    lines.push(`${c.level.padEnd(4)}  ${c.id.padEnd(12)}  ${c.message}`);
  }
  return lines.join("\n");
}
