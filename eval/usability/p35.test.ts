import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { SLASH_HELP } from "@harness/tui";
import { boot, type ToolRouter } from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p35-"));
  const userRoot = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  await cp(fixture, userRoot, { recursive: true });
  await git(userRoot, ["init"]);
  await git(userRoot, ["config", "user.email", "eval@harness.local"]);
  await git(userRoot, ["config", "user.name", "Eval"]);
  await git(userRoot, ["add", "-A"]);
  await git(userRoot, ["commit", "-m", "fixture"]);
  return { userRoot, home };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}

test("protocol version is 0.35 for P35", () => {
  assert.equal(PROTOCOL_VERSION, "0.35.0");
});

test("slash help lists jobs and todos", () => {
  assert.match(SLASH_HELP, /\/help/);
  assert.match(SLASH_HELP, /\/jobs/);
  assert.match(SLASH_HELP, /\/todos/);
});

test("list_dir shows src and refuses to escape the workspace", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", yolo: true });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const listed = await tools.execute({
      id: "ls",
      type: "function",
      function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) },
    });
    assert.equal(listed.ok, true);
    assert.match(listed.content, /dir   src/);
    assert.match(listed.content, /file  package\.json/);
    const escaped = await tools.execute({
      id: "bad",
      type: "function",
      function: { name: "list_dir", arguments: JSON.stringify({ path: "../" }) },
    });
    assert.equal(escaped.ok, false);
    assert.match(escaped.content, /escapes AgentWorkspace/);
  } finally {
    await session.close();
  }
});

test("move_file renames inside the workspace and ask mode refuses it", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", yolo: true });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const root = session.workspace.agentRoot;
    await writeFile(path.join(root, "keep.txt"), "stay\n");
    await writeFile(path.join(root, "old.txt"), "moved\n");
    const clash = await tools.execute({
      id: "clash",
      type: "function",
      function: { name: "move_file", arguments: JSON.stringify({ from: "old.txt", to: "keep.txt" }) },
    });
    assert.equal(clash.ok, false);
    assert.match(clash.content, /destination exists/);
    assert.equal(await readFile(path.join(root, "old.txt"), "utf8"), "moved\n");
    const moved = await tools.execute({
      id: "mv",
      type: "function",
      function: { name: "move_file", arguments: JSON.stringify({ from: "old.txt", to: "nested/new.txt" }) },
    });
    assert.equal(moved.ok, true);
    assert.match(moved.content, /moved old\.txt -> nested\/new\.txt/);
    assert.equal(existsSync(path.join(root, "old.txt")), false);
    assert.equal(await readFile(path.join(root, "nested/new.txt"), "utf8"), "moved\n");
    const escaped = await tools.execute({
      id: "out",
      type: "function",
      function: { name: "move_file", arguments: JSON.stringify({ from: "keep.txt", to: "../nope.txt" }) },
    });
    assert.equal(escaped.ok, false);
    assert.match(escaped.content, /escapes AgentWorkspace/);
  } finally {
    await session.close();
  }

  const ask = await boot({ userRoot, harnessHome: home, model: "mock", mode: "ask" });
  try {
    const tools = ask.thread.get<ToolRouter>("tools");
    const listed = await tools.execute({
      id: "ls2",
      type: "function",
      function: { name: "list_dir", arguments: "{}" },
    });
    assert.equal(listed.ok, true);
    assert.match(listed.content, /dir   src/);
    const denied = await tools.execute({
      id: "mv2",
      type: "function",
      function: { name: "move_file", arguments: JSON.stringify({ from: "src/auth.js", to: "src/auth2.js" }) },
    });
    assert.equal(denied.ok, false);
    assert.match(denied.content, /ask mode is read-only/);
    assert.equal(existsSync(path.join(ask.workspace.agentRoot, "src/auth.js")), true);
  } finally {
    await ask.close();
  }
});
