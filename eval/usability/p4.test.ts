import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { HarnessClient } from "@harness/sdk";
import { AppServer } from "@harness/server";
import { PROTOCOL_VERSION } from "@harness/protocol";
import {
  boot,
  looksLikeGit,
  threadDir,
  type Llm,
  type ToolRouter,
} from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p4-"));
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

function connect() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  new AppServer(toServer, toClient);
  return new HarnessClient(toClient, toServer);
}

test("protocol version is 0.4 for P4", () => {
  assert.equal(PROTOCOL_VERSION, "0.4.0");
});

test("looksLikeGit detects remotes vs local paths", () => {
  assert.equal(looksLikeGit("https://example.com/org/plug.git"), true);
  assert.equal(looksLikeGit("git@github.com:org/plug.git"), true);
  assert.equal(looksLikeGit("/tmp/my-plugin"), false);
});

test("Done Report suggests AGENTS.md without writing it", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const turn = await session.runTurn({ prompt: "把失败的登录测试修了" });
    assert.equal(existsSync(path.join(session.workspace.agentRoot, "AGENTS.md")), false);
    assert.match(turn.done.agents_md_suggestion ?? "", /AGENTS\.md/);
    assert.match(turn.done.agents_md_suggestion ?? "", /node --test/);
  } finally {
    await session.close();
  }
});

test("plugin/add copies a local plugin into .harness/plugins", async () => {
  const { userRoot, home } = await loginRepo();
  const src = await mkdtemp(path.join(os.tmpdir(), "harness-plug-"));
  await writeFile(
    path.join(src, "plugin.json"),
    JSON.stringify({ id: "eval.note", kind: "skill", description: "a note" }),
  );
  await writeFile(path.join(src, "SKILL.md"), "Remember to keep diffs small.\n");
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  const added = await client.pluginAdd(src);
  assert.equal(added.id, "eval.note");
  const dest = path.join(userRoot, ".harness", "plugins", "eval.note", "plugin.json");
  assert.equal(existsSync(dest), true);
  const json = JSON.parse(await readFile(dest, "utf8")) as { id: string };
  assert.equal(json.id, "eval.note");
  await client.shutdown();
});

test("delegate child traj is linked; parent only sees a summary", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  let delegated = false;
  const llm: Llm = {
    async chat() {
      if (!delegated) {
        delegated = true;
        return {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_del",
              type: "function",
              function: {
                name: "delegate",
                arguments: JSON.stringify({ task: "把失败的登录测试修了", title: "fix login" }),
              },
            },
          ],
        };
      }
      return { role: "assistant", content: "Child finished the login fix." };
    },
  };
  session.thread.provide("llm", llm);
  try {
    const turn = await session.runTurn({ prompt: "split the login fix to a child agent" });
    assert.match(turn.done.message, /Child finished/);
    const parentEvents = await session.traj.events();
    const del = parentEvents.find((e) => e.type === "delegate");
    assert.ok(del, "parent traj missing delegate summary");
    const payload = del!.payload as { childId: string; summary: string };
    assert.ok(payload.childId);
    const parentToolNames = parentEvents
      .filter((e) => e.type === "tool_result")
      .map((e) => (e.payload as { name?: string }).name);
    assert.deepEqual(parentToolNames, ["delegate"]);
    assert.ok(!parentToolNames.includes("bash"));
    const childDir = threadDir(home, payload.childId);
    const childJsonl = await readFile(path.join(childDir, "session.jsonl"), "utf8");
    assert.match(childJsonl, /"name":"bash"/);
    const childHeader = JSON.parse(await readFile(path.join(childDir, "header.json"), "utf8")) as {
      parentThreadId: string;
    };
    assert.equal(childHeader.parentThreadId, session.threadId);
    assert.ok(session.traj.header?.childThreadIds?.includes(payload.childId));
    assert.match(
      await readFile(path.join(session.workspace.agentRoot, "src/auth.js"), "utf8"),
      /password === "password"/,
    );
  } finally {
    await session.close();
  }
});

test("nested delegate is rejected", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", delegateDepth: 1 });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "d1",
      type: "function",
      function: { name: "delegate", arguments: JSON.stringify({ task: "nope" }) },
    });
    assert.equal(result.ok, false);
    assert.match(result.content, /nested delegate/);
  } finally {
    await session.close();
  }
});

test("assemble prompt includes sandbox instructions", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const { assemble } = await import("@harness/core");
    const msgs = await assemble(session.thread, "look around");
    assert.match(msgs[0]?.content ?? "", /sandbox \/ permissions/);
    assert.match(msgs[0]?.content ?? "", /network: off/);
  } finally {
    await session.close();
  }
});
