const vscode = require("vscode");

/** VS Code / Cursor client for the Harness App Server. Spawns `harness` — does not fork the editor. */
function activate(context) {
  context.subscriptions.push(
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
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
