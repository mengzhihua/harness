import { spawn } from "node:child_process";
import type { TrajStore } from "./traj.ts";

export interface ProcResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ProcFn = (file: string, args: string[], cwd: string) => Promise<ProcResult>;

export async function runProc(file: string, args: string[], cwd: string): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.on("error", (err) => {
      resolve({
        stdout,
        stderr: `gh unavailable: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
      });
    });
  });
}

export async function createPullRequest(opts: {
  cwd: string;
  title: string;
  body: string;
  base?: string;
  proc?: ProcFn;
}): Promise<{ ok: boolean; url?: string; number?: number; message: string }> {
  const proc = opts.proc ?? runProc;
  const args = ["pr", "create", "--title", opts.title, "--body", opts.body];
  if (opts.base) args.push("--base", opts.base);
  const result = await proc("gh", args, opts.cwd);
  if (result.exitCode !== 0) {
    return { ok: false, message: (result.stderr || result.stdout || "gh pr create failed").slice(0, 800) };
  }
  const url =
    result.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^https?:\/\//.test(l)) ?? result.stdout.trim();
  const num = /\/pull\/(\d+)/.exec(url);
  return { ok: true, url, number: num ? Number(num[1]) : undefined, message: url };
}

export async function attachCiLogs(opts: {
  cwd: string;
  traj: TrajStore;
  proc?: ProcFn;
}): Promise<{ ok: boolean; artifact?: string; url?: string; message: string }> {
  const proc = opts.proc ?? runProc;
  const listed = await proc("gh", ["run", "list", "--limit", "1", "--json", "databaseId,url,conclusion,status,headBranch"], opts.cwd);
  if (listed.exitCode !== 0) {
    return { ok: false, message: (listed.stderr || listed.stdout || "gh run list failed").slice(0, 800) };
  }
  let runs: Array<{ databaseId?: number; url?: string; conclusion?: string; status?: string; headBranch?: string }> = [];
  try {
    runs = JSON.parse(listed.stdout || "[]") as typeof runs;
  } catch {
    return { ok: false, message: `unparseable gh run list: ${listed.stdout.slice(0, 200)}` };
  }
  const run = runs[0];
  if (!run?.databaseId) {
    return { ok: false, message: "no CI runs yet" };
  }
  const logs = await proc("gh", ["run", "view", String(run.databaseId), "--log"], opts.cwd);
  const body = logs.exitCode === 0 ? logs.stdout : `${logs.stderr}\n${logs.stdout}`;
  const artifact = await opts.traj.writeArtifact(`ci-${run.databaseId}.log`, body || "(empty log)");
  await opts.traj.append("system", "ci/log", {
    runId: run.databaseId,
    url: run.url,
    conclusion: run.conclusion,
    status: run.status,
    artifact,
  });
  return {
    ok: logs.exitCode === 0,
    artifact,
    url: run.url,
    message: run.url ?? artifact,
  };
}
