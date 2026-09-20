import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { HarnessClient } from "@harness/sdk";
import { AppServer } from "@harness/server";
import { applyEvent, emptyTuiState, renderFrame } from "@harness/tui";
import { assemble, boot, currentTodos, formatTodos, type ToolRouter } from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p33-"));
  const userRoot = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  await cp(fixture, userRoot, { recursive: true });
  await git(userRoot, ["init"]);
  await git(userRoot, ["config", "user.email", "eval@harness.local"]);
  await git(userRoot, ["config", "user.name", "Eval"]);
  await git(userRoot, ["add", "-A"]);
  await git(userRoot, ["commit", "-m", "fixture"]);
  await writeFile(path.join(userRoot, "USER_WIP.md"), "do not touch me\n");
  return { userRoot, home, tmp };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}

function connect() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  new AppServer(toServer, toClient);
  return new HarnessClient(toClient, toServer);
}

test("protocol version is 0.33 for P33", () => {
  assert.equal(PROTOCOL_VERSION, "0.33.0");
});

test("todo_write is visible in the prompt, TUI, and resume", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", yolo: true });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const wrote = await tools.execute({
      id: "t1",
      type: "function",
      function: {
        name: "todo_write",
        arguments: JSON.stringify({
          todos: [
            { id: "1", content: "fix login", status: "in_progress" },
            { id: "2", content: "run tests", status: "pending" },
          ],
        }),
      },
    });
    assert.equal(wrote.ok, true);
    assert.match(wrote.content, /\[\*\] 1 fix login/);
    assert.equal(currentTodos(session.thread).length, 2);
    const msgs = await assemble(session.thread, "continue");
    assert.match(msgs[0]?.content ?? "", /## todos/);
    assert.match(msgs[0]?.content ?? "", /fix login/);
    const events = await session.traj.events();
    assert.ok(events.some((e) => e.type === "todo/updated"));
    const threadId = session.threadId;
    await session.close();
    const resumed = await boot({ userRoot, harnessHome: home, model: "mock", threadId, yolo: true });
    try {
      assert.equal(formatTodos(currentTodos(resumed.thread)), `- [*] 1 fix login\n- [ ] 2 run tests`);
    } finally {
      await resumed.close();
    }
  } catch (err) {
    await session.close().catch(() => undefined);
    throw err;
  }
});

test("remember writes project knowledge and recall loads the body", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", yolo: true });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const saved = await tools.execute({
      id: "r1",
      type: "function",
      function: {
        name: "remember",
        arguments: JSON.stringify({
          title: "test command",
          body: "The fixture runs `node --test`.\nSECRET_BODY_STAYS_OUT_OF_CATALOG",
        }),
      },
    });
    assert.equal(saved.ok, true);
    assert.equal(existsSync(path.join(userRoot, ".harness", "knowledge", "test-command.md")), true);
    const body = await tools.execute({
      id: "r2",
      type: "function",
      function: { name: "recall", arguments: JSON.stringify({ id: "test command" }) },
    });
    assert.equal(body.ok, true);
    assert.match(body.content, /SECRET_BODY_STAYS_OUT_OF_CATALOG/);
    const msgs = await assemble(session.thread, "look around");
    assert.match(msgs[0]?.content ?? "", /## knowledge/);
    assert.doesNotMatch(msgs[0]?.content ?? "", /SECRET_BODY_STAYS_OUT_OF_CATALOG/);
  } finally {
    await session.close();
  }
});

test("workspace_status reports agent worktree files after an edit", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", yolo: true });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    await tools.execute({
      id: "e1",
      type: "function",
      function: {
        name: "str_replace",
        arguments: JSON.stringify({ path: "src/auth.js", old_string: "passw0rd", new_string: "password" }),
      },
    });
    const st = await tools.execute({
      id: "s1",
      type: "function",
      function: { name: "workspace_status", arguments: "{}" },
    });
    assert.equal(st.ok, true);
    assert.match(st.content, /kind: worktree/);
    assert.match(st.content, /src\/auth\.js/);
    assert.match(st.content, /harness\//);
  } finally {
    await session.close();
  }
});

test("ask mode can remember and list todos but cannot edit files", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", mode: "ask" });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const todo = await tools.execute({
      id: "a1",
      type: "function",
      function: { name: "todo_write", arguments: JSON.stringify({ todos: [{ id: "1", content: "explain auth", status: "pending" }] }) },
    });
    assert.equal(todo.ok, true);
    const mem = await tools.execute({
      id: "a2",
      type: "function",
      function: { name: "remember", arguments: JSON.stringify({ title: "ask note", body: "login uses password" }) },
    });
    assert.equal(mem.ok, true);
    const edit = await tools.execute({
      id: "a3",
      type: "function",
      function: {
        name: "str_replace",
        arguments: JSON.stringify({ path: "src/auth.js", old_string: "passw0rd", new_string: "password" }),
      },
    });
    assert.equal(edit.ok, false);
    assert.match(edit.content, /ask mode is read-only/);
  } finally {
    await session.close();
  }
});

test("TUI paints todos and thread/todos RPC returns the list", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock", yolo: true });
  await client.threadStart();
  const empty = await client.threadTodos();
  assert.deepEqual(empty.todos, []);
  const painted = applyEvent(emptyTuiState({ threadId: "th_1" }), "todo/updated", {
    todos: [{ id: "1", content: "ship p33", status: "in_progress" }],
  });
  assert.match(renderFrame(painted), /todo \[\*\] ship p33/);
  await client.shutdown();
});
