import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const WORKBENCH_FORK = "harness-ide";

export const workbenchCommands = ["apply", "undo", "steer", "open", "tui"] as const;

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".harness"]);

export interface WorkbenchView {
  fork: typeof WORKBENCH_FORK;
  workbench: true;
  commands: string[];
  files: string[];
  contents: Record<string, string>;
  html: string;
}

/** Walk the agent worktree for the IDE file tree. Skips VCS and install dirs. */
export function listWorkbenchFiles(root?: string, max = 48): string[] {
  if (!root || !existsSync(root)) return [];
  const out: string[] = [];
  walk(root, "", out, max);
  return out;
}

function walk(abs: string, rel: string, out: string[], max: number): void {
  if (out.length >= max) return;
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return;
  }
  names.sort();
  for (const name of names) {
    if (out.length >= max) return;
    if (SKIP_DIRS.has(name)) continue;
    const childAbs = path.join(abs, name);
    const childRel = rel ? `${rel}/${name}` : name;
    let st;
    try {
      st = statSync(childAbs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(childAbs, childRel, out, max);
    } else if (st.isFile()) {
      out.push(childRel);
    }
  }
}

/** Read listed worktree files for the workbench editor (cap size, skip binary). */
export function loadWorkbenchContents(root: string, files: string[], maxBytes = 12_000): Record<string, string> {
  const out: Record<string, string> = {};
  if (!root) return out;
  for (const rel of files) {
    try {
      const abs = path.join(root, rel);
      const st = statSync(abs);
      if (!st.isFile()) continue;
      if (st.size > maxBytes) {
        out[rel] = `(too large: ${st.size} bytes)`;
        continue;
      }
      const raw = readFileSync(abs);
      if (raw.includes(0)) {
        out[rel] = "(binary)";
        continue;
      }
      out[rel] = raw.toString("utf8");
    } catch {
      out[rel] = "(unreadable)";
    }
  }
  return out;
}

/** Self-owned IDE workbench (product fork). Does not vendor VS Code / Cursor source. */
export function renderWorkbench(opts?: {
  threadId?: string;
  worktree?: string;
  title?: string;
  files?: string[];
  contents?: Record<string, string>;
}): WorkbenchView {
  const title = opts?.title ?? "Harness IDE";
  const thread = opts?.threadId ?? "";
  const worktree = opts?.worktree ?? "";
  const files = opts?.files ?? listWorkbenchFiles(worktree);
  const contents = opts?.contents ?? (worktree ? loadWorkbenchContents(worktree, files) : {});
  const tree =
    files.length > 0
      ? files.map((f) => `<div class="file" data-path="${escapeHtml(f)}">${escapeHtml(f)}</div>`).join("\n      ")
      : "(empty worktree)";
  const payload = JSON.stringify(contents).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font: 13px/1.4 ui-sans-serif, system-ui; background: #1e1e1e; color: #ddd; }
    header { padding: 8px 12px; background: #111; border-bottom: 1px solid #333; display: flex; gap: 12px; }
    main { display: grid; grid-template-columns: 220px 1fr 280px; height: calc(100vh - 40px); }
    aside, section { padding: 8px; overflow: auto; border-right: 1px solid #333; }
    textarea { width: 100%; height: 70%; background: #252526; color: #ddd; border: 1px solid #333; }
    button { margin-right: 6px; }
    .fork { color: #9cdcfe; }
    .file { font-family: ui-monospace, monospace; padding: 2px 0; cursor: pointer; }
    .file:hover { color: #9cdcfe; }
  </style>
</head>
<body>
  <header>
    <strong class="fork">${WORKBENCH_FORK}</strong>
    <span>thread ${escapeHtml(thread) || "(none)"}</span>
    <span>${escapeHtml(worktree)}</span>
  </header>
  <main>
    <aside id="tree">
      ${tree}
    </aside>
    <section>
      <textarea id="editor" placeholder="open a file from the agent worktree"></textarea>
      <p>
        <button data-cmd="apply">Apply</button>
        <button data-cmd="undo">Undo</button>
        <button data-cmd="steer">Steer</button>
        <button data-cmd="tui">TUI</button>
      </p>
    </section>
    <aside id="agent">follow-ups stay queued while a turn runs</aside>
  </main>
  <script>
    const FILES = ${payload};
    document.getElementById("tree").addEventListener("click", (e) => {
      const el = e.target.closest(".file");
      if (!el) return;
      const p = el.getAttribute("data-path");
      const editor = document.getElementById("editor");
      if (p && editor) editor.value = FILES[p] ?? "";
    });
  </script>
</body>
</html>`;
  return { fork: WORKBENCH_FORK, workbench: true, commands: [...workbenchCommands], files, contents, html };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
