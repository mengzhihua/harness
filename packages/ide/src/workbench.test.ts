import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listWorkbenchFiles, renderWorkbench, WORKBENCH_FORK, WORKBENCH_HOST_JS } from "./index.ts";

test("workbench is a Harness IDE fork, not a VS Code source tree", () => {
  const view = renderWorkbench({ threadId: "th_1", worktree: "/tmp/wt" });
  assert.equal(view.fork, WORKBENCH_FORK);
  assert.equal(view.workbench, true);
  assert.ok(view.commands.includes("apply"));
  assert.match(view.html, /harness-ide/);
  assert.match(view.html, /th_1/);
  assert.equal(view.html.includes("vscode source"), false);
});

test("workbench file tree lists worktree files and skips .git", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "harness-wb-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, ".git"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
  writeFileSync(path.join(root, "src", "auth.js"), "export {}\n");
  writeFileSync(path.join(root, "README.md"), "hi\n");
  writeFileSync(path.join(root, ".git", "HEAD"), "ref\n");
  writeFileSync(path.join(root, "node_modules", "x", "index.js"), "1\n");
  const files = listWorkbenchFiles(root);
  assert.ok(files.includes("src/auth.js"));
  assert.ok(files.includes("README.md"));
  assert.equal(files.some((f) => f.includes(".git") || f.includes("node_modules")), false);
  const view = renderWorkbench({ worktree: root, files });
  assert.deepEqual(view.files, files);
  assert.match(view.html, /src\/auth\.js/);
  assert.match(view.html, /data-path="src\/auth\.js"/);
  assert.match(view.contents["src/auth.js"] ?? "", /export \{\}/);
  assert.match(view.html, /const FILES =/);
  assert.match(view.html, /data-cmd="apply"/);
  assert.match(view.html, /ide\/command apply/);
  assert.match(view.html, /dispatchIde/);
  assert.match(view.html, /window\.harness/);
  assert.match(view.html, /acquireVsCodeApi/);
  assert.match(WORKBENCH_HOST_JS, /type: "ide\/command"/);
});
