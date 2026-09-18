const vscode = require("vscode");

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

function workbenchHtml(worktree) {
  const wt = String(worktree).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html><html><body style="font:13px sans-serif;background:#1e1e1e;color:#ddd">
  <h1 class="fork">harness-ide</h1>
  <p>worktree ${wt}</p>
  <p>Apply / Undo / Steer from the Harness IDE fork. Follow-ups queue while a turn runs.</p>
  </body></html>`;
}

module.exports = { activate, deactivate, workbenchHtml };
