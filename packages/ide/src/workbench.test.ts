import assert from "node:assert/strict";
import { test } from "node:test";
import { renderWorkbench, WORKBENCH_FORK } from "./index.ts";

test("workbench is a Harness IDE fork, not a VS Code source tree", () => {
  const view = renderWorkbench({ threadId: "th_1", worktree: "/tmp/wt" });
  assert.equal(view.fork, WORKBENCH_FORK);
  assert.equal(view.workbench, true);
  assert.ok(view.commands.includes("apply"));
  assert.match(view.html, /harness-ide/);
  assert.match(view.html, /th_1/);
  assert.equal(view.html.includes("vscode source"), false);
});
