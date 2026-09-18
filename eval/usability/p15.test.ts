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
import { boot, loadUserConfig, type ToolRouter } from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p15-"));
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

test("protocol version is 0.15 for P15", () => {
  assert.equal(PROTOCOL_VERSION, "0.15.0");
});

test("config/get and config/set persist yolo into config.yml", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  assert.deepEqual(await client.configGet(), {});
  const cfg = await client.configSet("yolo", "on");
  assert.equal(cfg.yolo, true);
  assert.equal((await client.configGet()).yolo, true);
  assert.equal((await loadUserConfig(home)).yolo, true);
  await client.shutdown();
});

test("config/set yolo is picked up by the next boot without flags", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.configSet("yolo", "true");
  await client.shutdown();

  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    assert.equal(session.config.yolo, true);
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "c1",
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "curl https://example.com" }) },
    });
    assert.equal(result.ok, true, result.content);
  } finally {
    await session.close();
  }
});
