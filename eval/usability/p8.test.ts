import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
  assemble,
  boot,
  setThreadMode,
  setPlan,
  type Llm,
  type ToolRouter,
} from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p8-"));
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

test("protocol version is 0.8 for P8", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("mode switch keeps the same thread and ask cannot write", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const id = session.threadId;
    const changed = await setThreadMode(session.thread, "ask");
    assert.equal(changed.threadId, id);
    assert.equal(changed.mode, "ask");
    assert.equal(session.config.mode, "ask");
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "w1",
      type: "function",
      function: {
        name: "str_replace",
        arguments: JSON.stringify({ path: "src/auth.js", old_string: "a", new_string: "b" }),
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.content, /denied/);
    const events = await session.traj.events();
    assert.ok(events.some((e) => e.type === "mode/change"));
  } finally {
    await session.close();
  }
});

test("@path attachments are copied into the user turn", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  const llm: Llm = {
    async chat(req) {
      const last = req.messages.filter((m) => m.role === "user").at(-1);
      return { role: "assistant", content: last?.content ?? "" };
    },
  };
  session.thread.provide("llm", llm);
  try {
    const turn = await session.runTurn({ prompt: "explain @src/auth.js" });
    assert.match(turn.done.message, /## attachments/);
    assert.match(turn.done.message, /passw0rd/);
    const events = await session.traj.events();
    assert.ok(events.some((e) => e.type === "attachment"));
  } finally {
    await session.close();
  }
});

test("resuming a thread keeps switched mode and user plan", async () => {
  const { userRoot, home } = await loginRepo();
  const first = await boot({ userRoot, harnessHome: home, model: "mock" });
  const threadId = first.threadId;
  try {
    await setThreadMode(first.thread, "ask");
    await setPlan(first.thread, [{ id: "1", title: "inspect", status: "skipped" }]);
  } finally {
    await first.close();
  }
  const resumed = await boot({ userRoot, harnessHome: home, model: "mock", threadId, mode: "agent" });
  try {
    assert.equal(resumed.threadId, threadId);
    assert.equal(resumed.config.mode, "ask");
    const msgs = await assemble(resumed.thread, "continue");
    assert.match(msgs[0]?.content ?? "", /## plan/);
    assert.match(msgs[0]?.content ?? "", /\[-\] 1 inspect/);
    const tools = resumed.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "w2",
      type: "function",
      function: {
        name: "write_file",
        arguments: JSON.stringify({ path: "nope.js", content: "x" }),
      },
    });
    assert.equal(result.ok, false);
  } finally {
    await resumed.close();
  }
});

test("user can edit the structured plan then see it in assemble", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  const plan = await client.planSet([
    { id: "1", title: "inspect", status: "done" },
    { id: "2", title: "edit auth", status: "skipped" },
  ]);
  assert.equal(plan.steps.length, 2);
  const session = await boot({ userRoot, harnessHome: path.join(home, "p"), model: "mock" });
  try {
    await setPlan(session.thread, [
      { id: "1", title: "inspect", status: "done" },
      { id: "2", title: "edit auth", status: "skipped" },
    ]);
    const msgs = await assemble(session.thread, "continue");
    assert.match(msgs[0]?.content ?? "", /## plan/);
    assert.match(msgs[0]?.content ?? "", /edit auth/);
    assert.match(msgs[0]?.content ?? "", /\[-\]/);
  } finally {
    await session.close();
    await client.shutdown();
  }
});

test("adapter plugin replaces ctx.llm", async () => {
  const { userRoot, home } = await loginRepo();
  const dir = path.join(userRoot, ".harness", "plugins", "echo");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({ id: "eval.echo", kind: "adapter", entry: "adapter.mjs" }),
  );
  await writeFile(
    path.join(dir, "adapter.mjs"),
    "export function createLlm() { return { async chat() { return { role: 'assistant', content: 'adapter-ok' }; } }; }\n",
  );
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const turn = await session.runTurn({ prompt: "hi" });
    assert.equal(turn.done.message, "adapter-ok");
  } finally {
    await session.close();
  }
});

test("eval profile uses minimal ACI (no fusion tool)", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", profile: "eval" });
  try {
    const names = session.thread.get<ToolRouter>("tools").schemas().map((s) => s.function.name);
    assert.ok(names.includes("bash"));
    assert.equal(names.includes("fusion"), false);
    assert.equal(names.includes("delegate"), false);
  } finally {
    await session.close();
  }
});

test("missing check command is explained in residual_risks (U10)", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  const llm: Llm = {
    async chat(req) {
      const used = req.messages.some((m) => m.role === "tool");
      if (!used) {
        return {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "b1",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "not-a-harness-bin --test" }) },
            },
          ],
        };
      }
      return { role: "assistant", content: "done" };
    },
  };
  session.thread.provide("llm", llm);
  try {
    const turn = await session.runTurn({ prompt: "run tests" });
    assert.ok(turn.done.residual_risks.some((r) => /command missing|still failing/i.test(r)));
    assert.equal(turn.done.apply_ready, false);
  } finally {
    await session.close();
  }
});
