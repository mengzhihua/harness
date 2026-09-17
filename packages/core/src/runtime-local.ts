import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

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

export class LocalSubprocess {
  private n = 0;

  constructor(readonly root: string) {}

  async exec(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
    const cwd = opts?.cwd ? path.resolve(this.root, opts.cwd) : this.root;
    const rel = path.relative(this.root, cwd);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new PathDeniedError(`cwd escapes AgentWorkspace: ${opts?.cwd}`);
    }
    const id = `exec_${++this.n}`;
    return runShell(id, command, cwd, opts?.timeoutMs ?? 30_000);
  }
}

function runShell(id: string, command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        id,
        command,
        cwd,
        exitCode: code ?? 1,
        stdout,
        stderr,
        truncated: false,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
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
