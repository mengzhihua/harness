import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { sandboxEnv } from "./sandbox.ts";
import { nextShellCwd, resolveShellCwd } from "./cwd.ts";

export class PathDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathDeniedError";
  }
}

export interface FileSlice {
  path: string;
  startLine: number;
  content: string;
}

export interface ExecResult {
  id: string;
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  artifact?: string;
}

export interface SubprocessExecOpts {
  cwd?: string;
  timeoutMs?: number;
  network?: boolean;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
}

export interface Subprocess {
  readonly root: string;
  exec(command: string, opts?: SubprocessExecOpts): Promise<ExecResult>;
}

export class LocalFs {
  constructor(readonly root: string) {}

  resolve(input: string): string {
    const abs = path.resolve(this.root, input);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new PathDeniedError(`path escapes AgentWorkspace: ${input}`);
    }
    return abs;
  }

  async readFile(rel: string, range?: { start: number; end?: number }): Promise<FileSlice> {
    const abs = this.resolve(rel);
    const raw = await readFile(abs, "utf8");
    const lines = raw.split("\n");
    const start = Math.max(1, range?.start ?? 1);
    const end = Math.min(lines.length, range?.end ?? start + 199);
    const numbered = lines.slice(start - 1, end).map((line, i) => `${start + i}|${line}`);
    return { path: rel, startLine: start, content: numbered.join("\n") };
  }

  async readRaw(rel: string): Promise<string> {
    return readFile(this.resolve(rel), "utf8");
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const abs = this.resolve(rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }

  async glob(pattern: string, maxHits = 80): Promise<string[]> {
    const matchers = expandBraces(pattern).map(globToRegExp);
    const hits: string[] = [];
    await walk(this.root, this.root, (rel) => {
      const norm = rel.replaceAll("\\", "/");
      if (matchers.some((rx) => rx.test(norm))) hits.push(norm);
      return hits.length < maxHits;
    });
    return hits;
  }

  async grep(pattern: string, globPat = "**/*", maxHits = 40): Promise<string[]> {
    const files = await this.glob(globPat, 400);
    const rx = new RegExp(pattern);
    const out: string[] = [];
    for (const rel of files) {
      let text: string;
      try {
        text = await this.readRaw(rel);
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!rx.test(lines[i]!)) continue;
        const snippet = lines[i]!.slice(0, 160);
        out.push(`${rel}:${i + 1}: ${snippet}`);
        if (out.length >= maxHits) return out;
      }
    }
    return out;
  }
}

export class LocalSubprocess implements Subprocess {
  private n = 0;
  private unshare: boolean | undefined;
  lastCwd = "";

  constructor(
    readonly root: string,
    readonly sandbox: { network: boolean } = { network: false },
  ) {}

  async exec(command: string, opts?: SubprocessExecOpts): Promise<ExecResult> {
    const resolved = resolveShellCwd(this.root, opts?.cwd, this.lastCwd);
    if (resolved.rel.startsWith("..") || path.isAbsolute(resolved.rel)) {
      throw new PathDeniedError(`cwd escapes AgentWorkspace: ${opts?.cwd ?? this.lastCwd}`);
    }
    const cwd = resolved.abs;
    const id = `exec_${++this.n}`;
    const network = opts?.network ?? this.sandbox.network;
    const wrapped = await this.wrap(command, network);
    const result = await runShell(id, wrapped, cwd, opts?.timeoutMs ?? 30_000, network, opts?.signal, opts?.onStdout);
    result.command = command;
    this.lastCwd = nextShellCwd(command, resolved.rel, result.exitCode);
    return result;
  }

  private async wrap(command: string, network: boolean): Promise<string> {
    if (network) return command;
    if (this.unshare === undefined) this.unshare = await probeUnshare();
    if (!this.unshare) return command;
    return `unshare -n -- sh -lc ${JSON.stringify(command)}`;
  }
}

function runShell(
  id: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  network: boolean,
  signal?: AbortSignal,
  onStdout?: (chunk: string) => void,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        id,
        command,
        cwd,
        exitCode: 1,
        stdout: "",
        stderr: "interrupted",
        truncated: false,
      });
      return;
    }
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: sandboxEnv(network),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      killTree(child);
    }, timeoutMs);
    const onAbort = () => {
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (result: ExecResult) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    child.stdout?.on("data", (d) => {
      const chunk = String(d);
      stdout += chunk;
      onStdout?.(chunk);
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
        stderr: stderr + String(err),
        truncated: false,
      });
    });
  });
}

function killTree(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      /* not a process-group leader */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already exited */
  }
}

const SKIP = new Set(["node_modules", ".git", ".harness", "dist"]);

async function walk(root: string, dir: string, visit: (rel: string) => boolean): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const ent of entries) {
    if (SKIP.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    const rel = path.relative(root, abs).replaceAll("\\", "/");
    if (ent.isDirectory()) {
      const st = await stat(abs).catch(() => null);
      if (!st) continue;
      if (!(await walk(root, abs, visit))) return false;
    } else if (ent.isFile()) {
      if (!visit(rel)) return false;
    }
  }
  return true;
}

function probeUnshare(): Promise<boolean> {
  if (process.platform !== "linux") return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn("unshare", ["-n", "true"], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function expandBraces(pattern: string): string[] {
  const m = /\{([^}]+)\}/.exec(pattern);
  if (!m || m.index === undefined) return [pattern];
  const out: string[] = [];
  for (const part of m[1]!.split(",")) {
    out.push(...expandBraces(pattern.slice(0, m.index) + part + pattern.slice(m.index + m[0].length)));
  }
  return out;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let re = "^";
  for (let i = 0; i < normalized.length; ) {
    if (normalized.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
    } else if (normalized.startsWith("**", i) && i + 2 === normalized.length) {
      re += ".*";
      i += 2;
    } else if (normalized[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else if (normalized[i] === "?") {
      re += "[^/]";
      i += 1;
    } else if ("\\^$+()[]{}|.".includes(normalized[i]!)) {
      re += `\\${normalized[i]!}`;
      i += 1;
    } else {
      re += normalized[i]!;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}
