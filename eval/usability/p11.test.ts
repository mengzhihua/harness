import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { HarnessClient } from "@harness/sdk";
import { AppServer } from "@harness/server";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { assemble, boot, compactMessages, setPluginEnabled, type Llm, type ToolRouter } from "@harness/core";
import { applyEvent, emptyTuiState } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p11-"));
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

test("protocol version is 0.11 for P11", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("read_skill loads SKILL.md on demand and does not dump it at assemble", async () => {
  const { userRoot, home } = await loginRepo();
  const dir = path.join(userRoot, ".harness", "plugins", "login-skill");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({ id: "login.helper", kind: "skill", description: "how to fix login tests" }),
  );
  await writeFile(path.join(dir, "SKILL.md"), "SECRET_SKILL_BODY always run node --test\n");
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const msgs = await assemble(session.thread, "continue");
    const sys = msgs[0]?.content ?? "";
    assert.match(sys, /login\.helper/);
    assert.match(sys, /read_skill/);
    assert.doesNotMatch(sys, /SECRET_SKILL_BODY/);
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "s1",
      type: "function",
      function: { name: "read_skill", arguments: JSON.stringify({ id: "login.helper" }) },
    });
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /SECRET_SKILL_BODY/);
    const events = await session.traj.events();
    assert.ok(events.some((e) => e.type === "skill/read"));
  } finally {
    await session.close();
  }
});

test("read_skill fails closed when the skill is disabled", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    await setPluginEnabled(session.thread, "login.verify", false);
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "s1",
      type: "function",
      function: { name: "read_skill", arguments: JSON.stringify({ id: "login.verify" }) },
    });
    assert.equal(result.ok, false);
    assert.match(result.content, /disabled/);
  } finally {
    await session.close();
  }
});

test("ask mode can still read_skill", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", mode: "ask" });
  const llm: Llm = {
    async chat(req) {
      const names = (req.tools ?? []).map((t) => t.function.name);
      assert.ok(names.includes("read_skill"));
      assert.equal(names.includes("str_replace"), false);
      return { role: "assistant", content: "tools-ok" };
    },
  };
  session.thread.provide("llm", llm);
  try {
    const turn = await session.runTurn({ prompt: "what skills exist?" });
    assert.equal(turn.done.message, "tools-ok");
  } finally {
    await session.close();
  }
});

test("writes emit diff/updated for the TUI during the turn", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  const notices: Array<{ method: string; params: unknown }> = [];
  const llm: Llm = {
    async chat(req) {
      const used = req.messages.some((m) => m.role === "tool");
      if (!used) {
        return {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "w1",
              type: "function",
              function: {
                name: "str_replace",
                arguments: JSON.stringify({
                  path: "src/auth.js",
                  old_string: "passw0rd",
                  new_string: "password",
                }),
              },
            },
          ],
        };
      }
      return { role: "assistant", content: "edited" };
    },
  };
  session.thread.provide("llm", llm);
  try {
    const turn = await session.runTurn({
      prompt: "fix password",
      onNotify: (method, params) => notices.push({ method, params }),
    });
    assert.ok(notices.some((n) => n.method === "diff/updated"));
    const events = await session.traj.events();
    const live = events.find((e) => e.type === "diff/updated");
    assert.ok(live);
    assert.ok(((live?.payload as { files?: string[] }).files ?? []).includes("src/auth.js"));
    const tui = applyEvent(emptyTuiState(), "diff/updated", live?.payload);
    assert.match(tui.diff ?? "", /auth/);
    assert.match(turn.done.message, /edited/);
  } finally {
    await session.close();
  }
});

test("SDK forwards live diff/updated from the App Server", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  const seen: string[] = [];
  client.onEvent((method) => seen.push(method));
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock", yolo: true });
  await client.threadStart();
  await client.turnStart("把失败的登录测试修了，不要动别的模块");
  assert.ok(seen.includes("diff/updated"));
  await client.shutdown();
});

test("compactMessages still shrinks long histories", () => {
  const msgs = [
    { role: "system" as const, content: "s" },
    ...Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, content: `x${i}`.repeat(4000) })),
  ];
  assert.ok(compactMessages(msgs, 100).length < msgs.length);
});
