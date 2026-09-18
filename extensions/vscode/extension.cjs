const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");

const SKIP = new Set([".git", "node_modules", "dist", "coverage", ".harness"]);

/** Map a workbench button to `harness ide …` so Apply/Undo hit ide/command. */
function harnessIdeCli(cmd, extra) {
  extra = extra || {};
  if (cmd === "steer") {
    const text = String(extra.text ?? "").trim();
    return text ? `harness ide steer ${text}` : "harness ide steer";
  }
  if (cmd === "open" && extra.path) return `harness ide open ${extra.path}`;
  return `harness ide ${cmd}`;
}

/** Harness IDE fork hosted inside VS Code / Cursor. Owns the workbench; does not vendor editor source. */
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("harness.workbench", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      const panel = vscode.window.createWebviewPanel("harnessIde", "Harness IDE", vscode.ViewColumn.One, {
        enableScripts: true,
      });
      panel.webview.html = workbenchHtml(folder);
      panel.webview.onDidReceiveMessage(async (msg) => {
        if ((msg?.type === "open" || msg?.cmd === "open") && (msg.path || msg.cmd === "open") && folder) {
          const rel = msg.path;
          if (rel) {
            const uri = vscode.Uri.file(path.join(folder, rel));
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
          }
        }
        if (msg?.type === "cmd" || msg?.type === "ide/command") {
          const cmd = msg.cmd;
          if (cmd === "open" && msg.path) return;
          if (cmd === "apply" || cmd === "undo" || cmd === "tui" || cmd === "steer") {
            const term = vscode.window.createTerminal({ name: "harness", cwd: folder });
            term.sendText(harnessIdeCli(cmd, msg));
            term.show();
          }
        }
      });
    }),
    vscode.commands.registerCommand("harness.tui", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const term = vscode.window.createTerminal({ name: "harness", cwd: folder });
      term.sendText("harness ide tui");
      term.show();
    }),
    vscode.commands.registerCommand("harness.open", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("Harness: no active file");
        return;
      }
      const file = editor.document.uri.fsPath;
      const line = editor.selection.active.line + 1;
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const term = vscode.window.createTerminal({ name: "harness", cwd: folder });
      term.sendText(`harness ide ${file}:${line}`);
      term.show();
    }),
    vscode.commands.registerCommand("harness.apply", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const term = vscode.window.createTerminal({ name: "harness", cwd: folder });
      term.sendText("harness ide apply");
      term.show();
    }),
    vscode.commands.registerCommand("harness.undo", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const term = vscode.window.createTerminal({ name: "harness", cwd: folder });
      term.sendText("harness ide undo");
      term.show();
    }),
  );
}

function deactivate() {}

function listFiles(root, max = 48) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const walk = (abs, rel) => {
    if (out.length >= max) return;
    let names;
    try {
      names = fs.readdirSync(abs);
    } catch {
      return;
    }
    names.sort();
    for (const name of names) {
      if (out.length >= max) return;
      if (SKIP.has(name)) continue;
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = fs.statSync(childAbs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) out.push(childRel);
    }
  };
  walk(root, "");
  return out;
}

function workbenchHtml(worktree) {
  const files = listFiles(worktree);
  const wt = String(worktree).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const tree = files.length
    ? files
        .map((f) => {
          const safe = f.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
          return `<div class="file" data-path="${safe}">${safe}</div>`;
        })
        .join("")
    : "(empty worktree)";
  return `<!doctype html><html><body style="font:13px sans-serif;background:#1e1e1e;color:#ddd">
  <h1 class="fork">harness-ide</h1>
  <p>worktree ${wt}</p>
  <aside id="tree">${tree}</aside>
  <p>
    <button data-cmd="apply" data-rpc="ide/command apply">Apply</button>
    <button data-cmd="undo" data-rpc="ide/command undo">Undo</button>
    <button data-cmd="steer" data-rpc="ide/command steer">Steer</button>
    <button data-cmd="tui" data-rpc="ide/command tui">TUI</button>
  </p>
  <input id="steer" placeholder="steer follow-up" />
  <p>Click a file to open it in the Harness IDE host editor.</p>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById("tree").addEventListener("click", (e) => {
      const el = e.target.closest(".file");
      if (!el) return;
      vscode.postMessage({ type: "open", path: el.getAttribute("data-path") });
    });
    document.querySelectorAll("[data-cmd]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cmd = btn.getAttribute("data-cmd");
        const extra = { type: "cmd", cmd: cmd };
        if (cmd === "steer") extra.text = document.getElementById("steer")?.value || "";
        vscode.postMessage(extra);
      });
    });
  </script>
  </body></html>`;
}

module.exports = { activate, deactivate, workbenchHtml, harnessIdeCli };
