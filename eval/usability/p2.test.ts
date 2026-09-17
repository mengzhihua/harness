import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { boot, dryReplay, modelVisibleSubsetOfTraj, projectMessages } from "@harness/core";
import type { ChatMessage, Llm, ToolRouter } from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo(): Promise<{ userRoot: string; home: string }> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p2-"));
  const userRoot = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  await cp(fixture, userRoot, { recursive: true });
  await git(userRoot, ["init"]);
  await git(userRoot, ["config", "user.email", "eval@harness.local"]);
  await git(userRoot, ["config", "user.name", "Eval"]);
  await git(userRoot, ["add", "-A"]);
  await git(userRoot, ["commit", "-m", "fixture"]);
  await writeFile(path.join(userRoot, "USER_WIP.md"), "do not touch me\n");
  return { userRoot, home };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}

test("undo restores the worktree and crops trajectory projection", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    await session.runTurn({ prompt: "把失败的登录测试修了" });
    assert.match(await readFile(path.join(session.workspace.agentRoot, "src/auth.js"), "utf8"), /password === "password"/);
    await session.undo();
    assert.match(await readFile(path.join(session.workspace.agentRoot, "src/auth.js"), "utf8"), /passw0rd/);
    const msgs = projectMessages(await session.traj.events());
    assert.equal(msgs.filter((m) => m.role === "assistant").length, 0);
  } finally {
    await session.close();
  }
});

test("steer is consumed at the next step boundary", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  const llm: Llm = {
    async chat(req) {
      const last = req.messages.at(-1);
      if (last?.role === "user" && String(last.content).includes("[steer]")) {
        return { role: "assistant", content: "stopped as steered" };
      }
      return {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_glob",
            type: "function",
            function: { name: "glob", arguments: JSON.stringify({ pattern: "**/*.js" }) },
          },
        ],
      };
    },
  };
  session.thread.provide("llm", llm);
  const inbox = ["stop after this tool, do not continue"];
  try {
    const turn = await session.runTurn({ prompt: "look around", inbox });
    assert.match(turn.done.message, /stopped as steered/);
    const events = await session.traj.events();
    assert.ok(events.some((e) => e.type === "steer"));
    assert.equal(inbox.length, 0);
  } finally {
    await session.close();
  }
});

test("ask mode cannot mutate the worktree", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", mode: "ask" });
  try {
    await session.runTurn({ prompt: "把失败的登录测试修了" });
    assert.match(await readFile(path.join(session.workspace.agentRoot, "src/auth.js"), "utf8"), /passw0rd/);
  } finally {
    await session.close();
  }
});

test("project hook blocks formatter commands and skill is locked", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const ids = session.plugins().map((p) => p.id);
    assert.ok(ids.includes("login.verify"));
    assert.ok(ids.includes("login.no-fmt"));
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "t1",
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "prettier --write src/auth.js" }) },
    });
    assert.equal(result.ok, false);
    assert.match(result.content, /denied|blocked/i);
    const events = await session.traj.events();
    assert.ok(events.some((e) => e.source === "plugin" && e.type === "hook_block"));
  } finally {
    await session.close();
  }
});

test("dry replay rebuilds the conversation from the trajectory", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const turn = await session.runTurn({ prompt: "把失败的登录测试修了" });
    const replayed = await dryReplay(session.traj);
    assert.ok(replayed.messages.some((m) => m.role === "user"));
    assert.ok(replayed.messages.some((m) => m.role === "tool"));
    assert.ok(turn.done.apply_ready);
    const events = await session.traj.events();
    const conv: ChatMessage[] = replayed.messages;
    assert.equal(modelVisibleSubsetOfTraj(conv, events), true);
  } finally {
    await session.close();
  }
});
