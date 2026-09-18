import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { boot } from "./boot.ts";
import type { Llm } from "./llm.ts";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../../../eval/fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-followup-"));
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

test("follow-up queued during a no-tool reply continues the same turn", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  const inbox: string[] = [];
  const notes: Array<{ method: string; params: unknown }> = [];
  const llm: Llm = {
    async chat(req) {
      const last = req.messages.at(-1);
      if (last?.role === "user" && String(last.content).includes("[steer]")) {
        return { role: "assistant", content: "queued follow-up received" };
      }
      inbox.push("don't touch USER_WIP.md");
      return { role: "assistant", content: "looking around, almost done" };
    },
  };
  session.thread.provide("llm", llm);
  try {
    const turn = await session.runTurn({
      prompt: "look around",
      inbox,
      onNotify: (method, params) => notes.push({ method, params }),
    });
    assert.match(turn.done.message, /queued follow-up received/);
    const events = await session.traj.events();
    assert.ok(events.some((e) => e.type === "steer"));
    assert.equal(inbox.length, 0);
    const updated = notes.filter((n) => n.method === "inbox/updated");
    assert.ok(updated.length >= 1);
    const last = updated.at(-1)?.params as { queued: string[]; consumed?: string };
    assert.deepEqual(last.queued, []);
    assert.equal(last.consumed, "don't touch USER_WIP.md");
  } finally {
    await session.close();
  }
});

test("preloaded inbox is consumed after the first tool and notifies remaining queue", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  const notes: Array<{ queued?: string[]; consumed?: string }> = [];
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
  const inbox = ["stop after this tool", "then summarize"];
  try {
    const turn = await session.runTurn({
      prompt: "look around",
      inbox,
      onNotify: (method, params) => {
        if (method === "inbox/updated") notes.push(params as { queued?: string[]; consumed?: string });
      },
    });
    assert.match(turn.done.message, /stopped as steered/);
    assert.equal(inbox.length, 0);
    assert.equal(notes[0]?.consumed, "stop after this tool");
    assert.deepEqual(notes[0]?.queued, ["then summarize"]);
    assert.equal(notes[1]?.consumed, "then summarize");
    assert.deepEqual(notes[1]?.queued, []);
  } finally {
    await session.close();
  }
});
