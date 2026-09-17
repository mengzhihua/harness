import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { HarnessClient } from "@harness/sdk";
import { AppServer } from "@harness/server";
import { PROTOCOL_VERSION } from "@harness/protocol";
import type { ToolRouter } from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p3-"));
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

test("sdk package does not depend on core", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../../packages/sdk/package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.equal(pkg.dependencies?.["@harness/core"], undefined);
  assert.ok(pkg.dependencies?.["@harness/protocol"]);
});

test("client talks JSON-RPC to App Server and fixes login tests", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  const init = await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  assert.equal((init as { protocolVersion: string }).protocolVersion, PROTOCOL_VERSION);
  await client.threadStart("fix login");
  const done = (await client.turnStart("把失败的登录测试修了")) as { apply_ready: boolean; changed_files: string[] };
  assert.equal(done.apply_ready, true);
  assert.ok(done.changed_files.includes("src/auth.js"));
  const listed = await client.threadList("login");
  assert.ok(listed.threads.some((t) => t.title.includes("fix login") || t.title.includes("把失败")));
  const plugins = await client.pluginList();
  assert.ok(plugins.packages.some((p) => p.id === "login.hint"));
  await client.shutdown();
});

test("MCP plugin registers password_hint", async () => {
  const { userRoot, home } = await loginRepo();
  const { boot } = await import("@harness/core");
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "h1",
      type: "function",
      function: { name: "password_hint", arguments: "{}" },
    });
    assert.equal(result.ok, true);
    assert.match(result.content, /password/);
  } finally {
    await session.close();
  }
});

test("traj diff and fork", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  const a = await client.threadStart();
  await client.turnStart("把失败的登录测试修了");
  const forked = await client.threadFork(a.threadId);
  assert.equal(forked.parentThreadId, a.threadId);
  const diff = await client.trajDiff(forked.threadId);
  assert.equal(typeof (diff as { toolSequenceEqual: boolean }).toolSequenceEqual, "boolean");
  await client.shutdown();
});

test("live replay rejects a plugin_lock mismatch", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  await client.turnStart("把失败的登录测试修了");
  const shown = await client.trajShow();
  const header = shown.header as { plugin_lock: { packages: Array<{ id: string; hash: string }> } };
  header.plugin_lock.packages = [{ id: "not-the-lock", hash: "deadbeef", plane: "host", version: "0" } as never];
  const { liveReplay, TrajStore, threadDir } = await import("@harness/core");
  const store = new TrajStore(threadDir(home, (shown.header as { threadId: string }).threadId));
  store.header = shown.header as never;
  const result = await liveReplay(store, { userRoot, harnessHome: home, model: "mock" });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /plugin_lock/);
  await client.shutdown();
});
