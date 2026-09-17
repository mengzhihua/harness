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
import { boot, assemble, threadDir, type ToolRouter } from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p6-"));
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

test("protocol version is 0.6 for P6", () => {
  assert.match(PROTOCOL_VERSION, /^0\.[6-9]\.\d+$/);
});

test("fusion lead and sidekick do not share transcripts; parent only stores brief/result", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  const started = await client.threadStart("fusion login");
  const fusion = await client.fusionRun("把失败的登录测试修了");
  assert.ok(fusion.leadId);
  assert.ok(fusion.sidekickId);
  assert.notEqual(fusion.leadId, fusion.sidekickId);
  assert.match(fusion.brief, /BRIEF:/);
  assert.match(fusion.brief, /src\/auth\.js/);
  const shown = await client.trajShow();
  assert.equal((shown.header as { threadId: string }).threadId, started.threadId);
  const types = (shown.events as Array<{ type: string }>).map((e) => e.type);
  assert.ok(types.includes("fusion"));
  const parentTools = (shown.events as Array<{ type: string; payload: { name?: string } }>)
    .filter((e) => e.type === "tool_result")
    .map((e) => e.payload.name);
  assert.equal(parentTools.includes("bash"), false);
  assert.equal(parentTools.includes("grep"), false);
  const leadJsonl = await readFile(path.join(threadDir(home, fusion.leadId), "session.jsonl"), "utf8");
  const sideJsonl = await readFile(path.join(threadDir(home, fusion.sidekickId), "session.jsonl"), "utf8");
  assert.match(leadJsonl, /Fusion Lead/);
  assert.doesNotMatch(sideJsonl, /Fusion Lead/);
  assert.match(sideJsonl, /BRIEF:/);
  assert.match(sideJsonl, /"name":"bash"/);
  const leadHeader = JSON.parse(await readFile(path.join(threadDir(home, fusion.leadId), "header.json"), "utf8")) as {
    fusionRole: string;
    parentThreadId: string;
  };
  assert.equal(leadHeader.fusionRole, "lead");
  assert.equal(leadHeader.parentThreadId, started.threadId);
  assert.match(
    await readFile(path.join((shown.header as { agentRoot: string }).agentRoot, "src/auth.js"), "utf8"),
    /password === "password"/,
  );
  await client.shutdown();
});

test("nested fusion is rejected", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", fusionDepth: 1 });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "f1",
      type: "function",
      function: { name: "fusion", arguments: JSON.stringify({ task: "nope" }) },
    });
    assert.equal(result.ok, false);
    assert.match(result.content, /nested fusion/);
  } finally {
    await session.close();
  }
});

test("knowledge notes appear in the assembled prompt without dumping bodies", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  const added = await client.knowledgeAdd(
    "test command",
    "The fixture runs `node --test`.\n\nFULL_NOTE_BODY_DUMP must stay out of the catalog.",
  );
  assert.equal(added.id, "test-command");
  assert.equal(existsSync(path.join(userRoot, ".harness", "knowledge", "test-command.md")), true);
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const msgs = await assemble(session.thread, "look around");
    assert.match(msgs[0]?.content ?? "", /## knowledge/);
    assert.match(msgs[0]?.content ?? "", /test command/);
    assert.match(msgs[0]?.content ?? "", /node --test/);
    assert.doesNotMatch(msgs[0]?.content ?? "", /FULL_NOTE_BODY_DUMP/);
  } finally {
    await session.close();
    await client.shutdown();
  }
});

test("browser tool fails closed without HARNESS_BROWSER", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "b1",
      type: "function",
      function: { name: "browser", arguments: JSON.stringify({ action: "snapshot" }) },
    });
    assert.equal(result.ok, false);
    assert.match(result.content, /HARNESS_BROWSER/);
  } finally {
    await session.close();
  }
});

test("traj baseline save and check compare tool sequences", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  await client.turnStart("把失败的登录测试修了");
  const saved = (await client.trajBaseline("save", "login-fix")) as { name: string; tools: string[] };
  assert.equal(saved.name, "login-fix");
  assert.ok(saved.tools.includes("bash"));
  const check = (await client.trajBaseline("check", "login-fix")) as { equal: boolean };
  assert.equal(check.equal, true);
  const listed = (await client.trajBaseline("list")) as { baselines: Array<{ name: string }> };
  assert.ok(listed.baselines.some((b) => b.name === "login-fix"));
  await client.shutdown();
});
