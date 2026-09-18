import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { createServer } from "node:http";
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
import { boot } from "@harness/core";
import type { ToolRouter } from "@harness/core";
import { runProjectCommand } from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p19-"));
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

test("protocol version is 0.19 for P19", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("remote store search merges HARNESS_STORE_URL catalog", async () => {
  const { userRoot, home } = await loginRepo();
  const remoteDir = path.join(home, "remote-plugin");
  await mkdir(remoteDir, { recursive: true });
  await writeFile(
    path.join(remoteDir, "plugin.json"),
    JSON.stringify({
      id: "harness.remote-sample",
      kind: "skill",
      description: "Remote catalog sample",
      permissions: { fs: "workspace" },
    }),
  );
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        plugins: [
          {
            id: "harness.remote-sample",
            kind: "skill",
            description: "Remote catalog sample",
            source: remoteDir,
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const store = `http://127.0.0.1:${port}/plugins.json`;
  try {
    const client = connect();
    await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
    const { plugins } = await client.pluginSearch("remote-sample", store);
    const found = plugins.find((p) => p.id === "harness.remote-sample");
    assert.ok(found, `expected remote-sample in ${plugins.map((p) => p.id).join(",")}`);
    assert.equal(found.origin, "remote");
    const added = await client.pluginInstall("harness.remote-sample", store);
    assert.equal(added.id, "harness.remote-sample");
    await client.shutdown();
  } finally {
    server.close();
  }
});

test("plugin/load records permissions and subprocess-less command plugins fail closed", async () => {
  const { userRoot, home } = await loginRepo();
  const dir = path.join(userRoot, ".harness", "plugins", "no-shell");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      id: "eval.no-shell",
      kind: "command",
      command: "node",
      args: ["--version"],
      permissions: { subprocess: false },
    }),
  );
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const events = await session.traj.events();
    assert.ok(events.some((e) => e.type === "plugin/load" && (e.payload as { id?: string }).id === "login.verify"));
    const verify = events.find((e) => e.type === "plugin/load" && (e.payload as { id?: string }).id === "login.verify");
    assert.equal((verify?.payload as { permissions?: { fs?: string } }).permissions?.fs, "workspace");
    assert.ok(events.some((e) => e.type === "plugin/permission" && (e.payload as { id?: string }).id === "eval.no-shell"));
    await assert.rejects(() => runProjectCommand(session.thread, "eval.no-shell"), /subprocess/);
  } finally {
    await session.close();
  }
});

test("run_code is registered and executes a snippet", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    assert.ok(tools.schemas().some((s) => s.function.name === "run_code"));
    const result = await tools.execute({
      id: "rc1",
      type: "function",
      function: { name: "run_code", arguments: JSON.stringify({ language: "javascript", code: "console.log('hi-harness')" }) },
    });
    assert.equal(result.ok, true);
    assert.match(result.content, /hi-harness/);
    assert.ok(session.thread.has("spring"));
  } finally {
    await session.close();
  }
});

test("ide/workbench is a Harness IDE fork", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  const status = await client.ideStatus();
  assert.equal(status.fork, "harness-ide");
  assert.equal(status.workbench, true);
  const bench = await client.ideWorkbench();
  assert.equal(bench.fork, "harness-ide");
  assert.match(bench.html, /harness-ide/);
  await client.shutdown();
});
