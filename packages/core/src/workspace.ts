import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { cp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { threadDir, worktreeDir } from "./config.ts";

const execFile = promisify(execFileCb);

export interface DiffStat {
  files: string[];
  summary: string;
  baseline: string;
}

export interface ApplyResult {
  ok: boolean;
  message: string;
}

export interface Workspace {
  userRoot: string;
  agentRoot: string;
  kind: "worktree" | "copy" | "in-place";
  baseline: string;
  checkpoint(label: string): Promise<string>;
  restore(id: string): Promise<void>;
  applyToUser(): Promise<ApplyResult>;
  listDiff(): Promise<DiffStat>;
  userDirty(): Promise<string>;
}

export class WorkspaceManager {
  async beginThread(opts: {
    threadId: string;
    userRoot: string;
    harnessHome: string;
    inPlace: boolean;
  }): Promise<Workspace> {
    const userRoot = path.resolve(opts.userRoot);
    if (opts.inPlace) {
      const baseline = (await isGitRepo(userRoot)) ? await git(userRoot, ["rev-parse", "HEAD"]) : "copy";
      return new GitWorkspace(userRoot, userRoot, "in-place", baseline.trim(), "");
    }

    const agentRoot = worktreeDir(opts.harnessHome, opts.threadId);
    const metaPath = path.join(threadDir(opts.harnessHome, opts.threadId), "workspace.json");
    if (existsSync(agentRoot) && existsSync(metaPath)) {
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as {
        kind: Workspace["kind"];
        baseline: string;
        branch: string;
        userRoot: string;
        agentRoot: string;
      };
      return new GitWorkspace(meta.userRoot, meta.agentRoot, meta.kind, meta.baseline, meta.branch);
    }
    await mkdir(path.dirname(agentRoot), { recursive: true });

    if (await isGitRepo(userRoot)) {
      const branch = `harness/${opts.threadId}`;
      await git(userRoot, ["worktree", "add", "-b", branch, agentRoot, "HEAD"]);
      await git(agentRoot, ["config", "user.email", "harness@local"]);
      await git(agentRoot, ["config", "user.name", "Harness"]);
      const baseline = (await git(agentRoot, ["rev-parse", "HEAD"])).trim();
      const ws = new GitWorkspace(userRoot, agentRoot, "worktree", baseline, branch);
      await persistMeta(metaPath, ws);
      return ws;
    }

    await mkdir(agentRoot, { recursive: true });
    await cp(userRoot, agentRoot, {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(userRoot, src);
        return !rel.split(path.sep).some((p) => p === "node_modules" || p === ".git" || p === ".harness");
      },
    });
    const ws = new GitWorkspace(userRoot, agentRoot, "copy", "copy", "");
    await persistMeta(metaPath, ws);
    return ws;
  }
}

async function persistMeta(metaPath: string, ws: GitWorkspace): Promise<void> {
  await mkdir(path.dirname(metaPath), { recursive: true });
  await writeFile(
    metaPath,
    JSON.stringify(
      {
        kind: ws.kind,
        baseline: ws.baseline,
        branch: ws.branch,
        userRoot: ws.userRoot,
        agentRoot: ws.agentRoot,
      },
      null,
      2,
    ),
  );
}

class GitWorkspace implements Workspace {
  constructor(
    readonly userRoot: string,
    readonly agentRoot: string,
    readonly kind: Workspace["kind"],
    readonly baseline: string,
    readonly branch: string,
  ) {}

  async checkpoint(label: string): Promise<string> {
    if (this.kind === "copy" || !(await isGitRepo(this.agentRoot))) {
      return `copy:${label}`;
    }
    await git(this.agentRoot, ["add", "-A"]);
    await git(this.agentRoot, ["commit", "--allow-empty", "-m", `checkpoint: ${label}`]);
    return (await git(this.agentRoot, ["rev-parse", "HEAD"])).trim();
  }

  async restore(id: string): Promise<void> {
    if (this.kind === "copy" || id.startsWith("copy:")) {
      throw new Error("undo is only available on git worktrees in P1");
    }
    await git(this.agentRoot, ["reset", "--hard", id]);
  }

  async applyToUser(): Promise<ApplyResult> {
    if (this.kind === "in-place") {
      return { ok: true, message: "in-place: already on the user tree" };
    }
    if (this.kind === "copy" || !this.branch) {
      return { ok: false, message: "non-git workspace: copy files from the agent root yourself" };
    }
    try {
      const out = await git(this.userRoot, ["merge", "--no-edit", this.branch]);
      return { ok: true, message: out.trim() || `merged ${this.branch}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async listDiff(): Promise<DiffStat> {
    if (!(await isGitRepo(this.agentRoot)) || this.baseline === "copy") {
      return { files: [], summary: "(non-git copy; see agent root)", baseline: this.baseline };
    }
    const names = await git(this.agentRoot, ["diff", "--name-only", this.baseline]);
    const summary = await git(this.agentRoot, ["diff", "--stat", this.baseline]);
    const files = names
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return { files, summary: summary.trim(), baseline: this.baseline };
  }

  async userDirty(): Promise<string> {
    if (!(await isGitRepo(this.userRoot))) return "";
    return (await git(this.userRoot, ["status", "--porcelain"])).trim();
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  if (!existsSync(path.join(cwd, ".git"))) {
    try {
      await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8" });
  return stdout;
}
