const vscode = require("vscode");
const fs = require("node:fs");
const path = require("node:path");

const SKIP = new Set([".git", "node_modules", "dist", "coverage", ".harness"]);

/** Harness IDE fork hosted inside VS Code / Cursor. Owns the workbench; does not vendor editor source. */
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("harness.workbench", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
      const panel = vscode.window.createWebviewPanel("harnessIde", "Harness IDE", vscode.ViewColumn.One, {
        enableScripts: true,
      });
      panel.webview.html = workbenchHtml(folder);
    }),
    vscode.commands.registerCommand("harness.tui", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const term = vscode.window.createTerminal({ name: "harness", cwd: folder });
      term.sendText("harness tui");
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
      term.sendText("harness apply");
      term.show();
    }),
    vscode.commands.registerCommand("harness.undo", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const term = vscode.window.createTerminal({ name: "harness", cwd: folder });
      term.sendText("harness undo");
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
    ? files.map((f) => `<div class="file">${f.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`).join("")
    : "(empty worktree)";
  return `<!doctype html><html><body style="font:13px sans-serif;background:#1e1e1e;color:#ddd">
  <h1 class="fork">harness-ide</h1>
  <p>worktree ${wt}</p>
  <aside id="tree">${tree}</aside>
  <p>Apply / Undo / Steer from the Harness IDE fork. Click a file in the tree after opening via harness workbench.</p>
  </body></html>`;
}

module.exports = { activate, deactivate, workbenchHtml };
