import type { ExecResult, Subprocess, SubprocessExecOpts } from "./runtime-local.ts";

export interface JobSnapshot {
  id: string;
  command: string;
  cwd?: string;
  status: "running" | "exited" | "killed";
  exitCode?: number;
  stdout: string;
  stderr: string;
}

interface Job {
  id: string;
  command: string;
  cwd?: string;
  status: "running" | "exited" | "killed";
  started: number;
  stdout: string;
  stderr: string;
  result?: ExecResult;
  promise: Promise<ExecResult>;
  controller: AbortController;
}

const MAX_TIMEOUT_MS = 600_000;

export function clampTimeout(ms: unknown, fallback: number): number {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(n)));
}

export class JobHub {
  private n = 0;
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly subprocess: Subprocess) {}

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map(snapshot);
  }

  running(): JobSnapshot[] {
    return this.list().filter((j) => j.status === "running");
  }

  start(opts: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void;
    network?: boolean;
  }): JobSnapshot {
    const id = `job_${++this.n}`;
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const job: Job = {
      id,
      command: opts.command,
      cwd: opts.cwd,
      status: "running",
      started: Date.now(),
      stdout: "",
      stderr: "",
      controller,
      promise: Promise.resolve({
        id,
        command: opts.command,
        cwd: opts.cwd ?? "",
        exitCode: 1,
        stdout: "",
        stderr: "",
        truncated: false,
      }),
    };
    const execOpts: SubprocessExecOpts = {
      cwd: opts.cwd,
      timeoutMs: clampTimeout(opts.timeoutMs, 600_000),
      signal: controller.signal,
      network: opts.network,
      onStdout: (chunk) => {
        job.stdout += chunk;
        opts.onStdout?.(chunk);
      },
    };
    job.promise = this.subprocess
      .exec(opts.command, execOpts)
      .then((result) => {
        job.result = result;
        job.stdout = result.stdout || job.stdout;
        job.stderr = result.stderr;
        job.status = controller.signal.aborted ? "killed" : "exited";
        return result;
      })
      .catch((err) => {
        const result: ExecResult = {
          id,
          command: opts.command,
          cwd: opts.cwd ?? "",
          exitCode: 1,
          stdout: job.stdout,
          stderr: err instanceof Error ? err.message : String(err),
          truncated: false,
        };
        job.result = result;
        job.status = controller.signal.aborted ? "killed" : "exited";
        return result;
      });
    this.jobs.set(id, job);
    return snapshot(job);
  }

  async wait(jobId: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<JobSnapshot> {
    const job = jobId ? this.jobs.get(jobId) : this.latest();
    if (!job) throw new Error(jobId ? `unknown job ${jobId}` : "no background jobs");
    if (job.status !== "running") return snapshot(job);
    const timeout = new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        resolve(null);
      }, { once: true });
    });
    const raced = await Promise.race([job.promise.then(() => job), timeout]);
    if (!raced) return snapshot(job);
    return snapshot(job);
  }

  abortAll(): string[] {
    const ids: string[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.controller.abort();
      ids.push(job.id);
    }
    return ids;
  }

  private latest(): Job | undefined {
    return [...this.jobs.values()].at(-1);
  }
}

function snapshot(job: Job): JobSnapshot {
  return {
    id: job.id,
    command: job.command,
    cwd: job.cwd,
    status: job.status,
    exitCode: job.result?.exitCode,
    stdout: (job.result?.stdout || job.stdout).slice(-8_000),
    stderr: (job.result?.stderr || job.stderr).slice(-2_000),
  };
}

export function formatJob(job: JobSnapshot): string {
  const head = `${job.id} ${job.status}${job.exitCode != null ? ` exit ${job.exitCode}` : ""}`;
  const cmd = `command: ${job.command}`;
  if (job.status === "running") {
    const tail = job.stdout.trim() ? `\n--- stdout ---\n${job.stdout.slice(-1500)}` : "";
    return `${head}\n${cmd}${tail}\n(still running; call wait again)`;
  }
  return `${head}\n${cmd}\n--- stdout ---\n${job.stdout || "(no output)"}\n--- stderr ---\n${job.stderr}`;
}
