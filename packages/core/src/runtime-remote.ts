import { PathDeniedError, type ExecResult, type Subprocess, type SubprocessExecOpts } from "./runtime-local.ts";
import path from "node:path";

export interface RemoteExecParams {
  workerId: string;
  command: string;
  cwd: string;
  network: boolean;
  root: "/workspace";
}

/** Frozen JSON-RPC payload a cloud VM worker must accept. */
export function remoteExecRequest(opts: {
  workerId: string;
  command: string;
  cwd?: string;
  network?: boolean;
}): { method: "worker/exec"; params: RemoteExecParams } {
  const cwd = opts.cwd && opts.cwd !== "." ? opts.cwd.replaceAll("\\", "/") : ".";
  if (cwd.startsWith("..") || path.isAbsolute(cwd)) {
    throw new PathDeniedError(`cwd escapes AgentWorkspace: ${opts.cwd}`);
  }
  return {
    method: "worker/exec",
    params: {
      workerId: opts.workerId,
      command: opts.command,
      cwd,
      network: opts.network ?? false,
      root: "/workspace",
    },
  };
}

/**
 * Subprocess that posts worker/exec to HARNESS_WORKER_URL.
 * Without a URL the call fails closed — same shape as missing docker.
 */
export class RemoteSubprocess implements Subprocess {
  private n = 0;

  constructor(
    readonly root: string,
    readonly workerId: string,
    readonly workerUrl?: string,
    readonly network = false,
  ) {}

  async exec(command: string, opts?: SubprocessExecOpts): Promise<ExecResult> {
    const id = `exec_${++this.n}`;
    const cwd = opts?.cwd ?? ".";
    if (opts?.signal?.aborted) {
      return {
        id,
        command,
        cwd: path.resolve(this.root, cwd),
        exitCode: 1,
        stdout: "",
        stderr: "interrupted",
        truncated: false,
      };
    }
    const rel = path.relative(this.root, path.resolve(this.root, cwd));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new PathDeniedError(`cwd escapes AgentWorkspace: ${opts?.cwd}`);
    }
    const req = remoteExecRequest({
      workerId: this.workerId,
      command,
      cwd,
      network: opts?.network ?? this.network,
    });
    const url = this.workerUrl ?? process.env.HARNESS_WORKER_URL;
    if (!url) {
      return {
        id,
        command,
        cwd: path.resolve(this.root, cwd),
        exitCode: 1,
        stdout: "",
        stderr: "remote worker unavailable: set HARNESS_WORKER_URL",
        truncated: false,
      };
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: opts?.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: req.method, params: req.params }),
      });
      const json = (await res.json()) as { result?: ExecResult; error?: { message: string } };
      if (json.error) {
        return { id, command, cwd: path.resolve(this.root, cwd), exitCode: 1, stdout: "", stderr: json.error.message, truncated: false };
      }
      if (json.result) return { ...json.result, id, command };
      return { id, command, cwd: path.resolve(this.root, cwd), exitCode: 1, stdout: "", stderr: `http ${res.status}`, truncated: false };
    } catch (err) {
      return {
        id,
        command,
        cwd: path.resolve(this.root, cwd),
        exitCode: 1,
        stdout: "",
        stderr: `remote worker unavailable: ${err instanceof Error ? err.message : String(err)}`,
        truncated: false,
      };
    }
  }
}
