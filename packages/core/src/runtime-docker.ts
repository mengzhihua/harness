import { spawn } from "node:child_process";
import path from "node:path";
import { PathDeniedError, type ExecResult, type Subprocess, type SubprocessExecOpts } from "./runtime-local.ts";

export interface DockerRunOpts {
  image: string;
  hostRoot: string;
  command: string;
  cwd?: string;
  network?: boolean;
}

/** Frozen `docker run` argv. Bind-mounts the AgentWorkspace; fs stays LocalFs. */
export function dockerArgs(opts: DockerRunOpts): string[] {
  const workdir = containerWorkdir(opts.hostRoot, opts.cwd);
  return [
    "run",
    "--rm",
    "--network",
    opts.network ? "bridge" : "none",
    "-v",
    `${opts.hostRoot}:/workspace`,
    "-w",
    workdir,
    opts.image,
    "sh",
    "-lc",
    opts.command,
  ];
}

export function containerWorkdir(hostRoot: string, cwd?: string): string {
  if (!cwd) return "/workspace";
  const abs = path.resolve(hostRoot, cwd);
  const rel = path.relative(hostRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathDeniedError(`cwd escapes AgentWorkspace: ${cwd}`);
  }
  const posix = rel.replaceAll("\\", "/");
  return posix && posix !== "." ? `/workspace/${posix}` : "/workspace";
}

export class DockerSubprocess implements Subprocess {
  private n = 0;

  constructor(
    readonly root: string,
    readonly image: string,
    readonly network = false,
  ) {}

  async exec(command: string, opts?: SubprocessExecOpts): Promise<ExecResult> {
    const hostCwd = opts?.cwd ? path.resolve(this.root, opts.cwd) : this.root;
    const rel = path.relative(this.root, hostCwd);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new PathDeniedError(`cwd escapes AgentWorkspace: ${opts?.cwd}`);
    }
    const id = `exec_${++this.n}`;
    const network = opts?.network ?? this.network;
    const args = dockerArgs({
      image: this.image,
      hostRoot: this.root,
      command,
      cwd: opts?.cwd,
      network,
    });
    return runDocker(id, command, hostCwd, args, opts?.timeoutMs ?? 60_000, opts?.signal);
  }
}

function runDocker(
  id: string,
  command: string,
  cwd: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ id, command, cwd, exitCode: 1, stdout: "", stderr: "interrupted", truncated: false });
      return;
    }
    const child = spawn("docker", args, { env: dockerClientEnv() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (result: ExecResult) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      finish({
        id,
        command,
        cwd,
        exitCode: signal?.aborted ? 1 : (code ?? 1),
        stdout,
        stderr: signal?.aborted ? `${stderr}\ninterrupted`.trim() : stderr,
        truncated: false,
      });
    });
    child.on("error", (err) => {
      finish({
        id,
        command,
        cwd,
        exitCode: 1,
        stdout,
        stderr: `docker unavailable: ${err instanceof Error ? err.message : String(err)}`,
        truncated: false,
      });
    });
  });
}

function dockerClientEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "DOCKER_HOST", "XDG_RUNTIME_DIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
