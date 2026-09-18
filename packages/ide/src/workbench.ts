export const WORKBENCH_FORK = "harness-ide";

export const workbenchCommands = ["apply", "undo", "steer", "open", "tui"] as const;

export interface WorkbenchView {
  fork: typeof WORKBENCH_FORK;
  workbench: true;
  commands: string[];
  html: string;
}

/** Self-owned IDE workbench (product fork). Does not vendor VS Code / Cursor source. */
export function renderWorkbench(opts?: { threadId?: string; worktree?: string; title?: string }): WorkbenchView {
  const title = opts?.title ?? "Harness IDE";
  const thread = opts?.threadId ?? "";
  const worktree = opts?.worktree ?? "";
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
  </style>
</head>
<body>
  <header>
    <strong class="fork">${WORKBENCH_FORK}</strong>
    <span>thread ${escapeHtml(thread) || "(none)"}</span>
    <span>${escapeHtml(worktree)}</span>
  </header>
  <main>
    <aside id="tree">files</aside>
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
</body>
</html>`;
  return { fork: WORKBENCH_FORK, workbench: true, commands: [...workbenchCommands], html };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
