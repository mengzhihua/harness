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
import { assemble, boot } from "@harness/core";
import { applyEvent, emptyTuiState, renderFrame } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p17-"));
  const userRoot = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  await cp(fixture, userRoot, { recursive: true });
  await git(userRoot, ["init"]);
  await git(userRoot, ["config", "user.email", "eval@harness.local"]);
  await git(userRoot, ["config", "user.name", "Eval"]);
  await git(userRoot, ["add", "-A"]);
  await git(userRoot, ["commit", "-m", "fixture"]);
  await writeFile(path.join(userRoot, "USER_WIP.md"), "do not touch me\n");
  await mkdir(home, { recursive: true });
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

test("protocol version is 0.17 for P17", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("turn notifies item/started current-tool with path/command", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  const tools: Array<{ name?: string; label?: string; path?: string }> = [];
  client.onEvent((method, params) => {
    if (method !== "item/started") return;
    const p = params as { type?: string; name?: string; label?: string; path?: string };
    if (p.type === "tool") tools.push(p);
  });
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  await client.turnStart("把失败的登录测试修了");
  assert.ok(tools.some((t) => t.name === "str_replace" || /str_replace|bash/.test(t.label ?? "")));
  await client.shutdown();
});

test("config/get after threadStart reflects live language from initialize", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock", language: "zh" });
  assert.equal((await client.configGet()).language, undefined);
  await client.threadStart();
  const live = await client.configGet();
  assert.equal(live.language, "zh");
  assert.equal(live.model, "mock");
  await client.shutdown();
});

test("language zh is assembled into the system prompt and lives in config.yml", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", language: "zh" });
  try {
    assert.equal(session.config.language, "zh");
    const messages = await assemble(session.thread, "修登录");
    assert.match(messages[0]!.content, /简体中文/);
  } finally {
    await session.close();
  }
});

test("plugin catalog search and install", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  const { plugins } = await client.pluginSearch("test-runner");
  assert.equal(plugins[0]?.id, "harness.test-runner");
  const added = await client.pluginInstall("harness.test-runner");
  assert.equal(added.id, "harness.test-runner");
  await client.shutdown();
});

test("fusion records lead and sidekick models as two sessions", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart("fusion dual");
  const fusion = await client.fusionRun("把失败的登录测试修了", { leadModel: "mock", sidekickModel: "mock" });
  assert.equal(fusion.leadModel, "mock");
  assert.equal(fusion.sidekickModel, "mock");
  assert.notEqual(fusion.leadId, fusion.sidekickId);
  await client.shutdown();
});

test("ide/status is a bridge and ide/open honors HARNESS_IDE", async () => {
  const prev = process.env.HARNESS_IDE;
  process.env.HARNESS_IDE = "/bin/true";
  try {
    const { userRoot, home } = await loginRepo();
    const client = connect();
    await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
    await client.threadStart();
    const info = await client.ideStatus();
    assert.equal(info.bridge, "harness-ide");
    const opened = await client.ideOpen("src/auth.js");
    assert.equal(opened.ok, true);
    await client.shutdown();
  } finally {
    if (prev === undefined) delete process.env.HARNESS_IDE;
    else process.env.HARNESS_IDE = prev;
  }
});

test("TUI current-tool line is wired for P17", () => {
  const state = applyEvent(emptyTuiState(), "item/started", {
    type: "tool",
    name: "bash",
    command: "node --test",
    label: "bash node --test",
  });
  assert.match(renderFrame(state), /tool bash node --test/);
});
