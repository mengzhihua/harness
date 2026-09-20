import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { HarnessClient } from "@harness/sdk";
import { AppServer } from "@harness/server";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { parseIdeSlash, scoreTrajectory } from "@harness/core";
import { applyEvent, emptyTuiState, renderFrame } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));
const vscodeExt = fileURLToPath(new URL("../../extensions/vscode/extension.cjs", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p24-"));
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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

function connect() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  new AppServer(toServer, toClient);
  return new HarnessClient(toClient, toServer);
}

test("protocol version is 0.24 for P24", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("parseIdeSlash maps TUI /ide lines and rejects unknown", () => {
  assert.deepEqual(parseIdeSlash("/ide apply"), { cmd: "apply" });
  assert.deepEqual(parseIdeSlash("/ide steer keep USER_WIP"), { cmd: "steer", text: "keep USER_WIP" });
  assert.deepEqual(parseIdeSlash("/ide open src/auth.js"), { cmd: "open", path: "src/auth.js" });
  assert.throws(() => parseIdeSlash("/ide"), /usage: \/ide/);
  assert.throws(() => parseIdeSlash("/ide explode"), /unknown ide command/);
});

test("ide/command apply merges the worktree without clobbering a dirty user file", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  const started = await client.threadStart();
  await client.turnStart("把失败的登录测试修了");
  const applied = await client.ideCommand("apply");
  assert.equal(applied.ok, true, applied.message);
  assert.equal(await readFile(path.join(userRoot, "USER_WIP.md"), "utf8"), "do not touch me\n");
  assert.match(await readFile(path.join(userRoot, "src/auth.js"), "utf8"), /password === "password"/);
  const listed = await client.itemsList();
  const items = listed.items as Array<{ type?: string; payload?: { cmd?: string } }>;
  assert.ok(items.some((i) => i.type === "ide/command" && i.payload?.cmd === "apply"));
  const shown = await client.trajShow();
  const score = scoreTrajectory({
    events: shown.events as Parameters<typeof scoreTrajectory>[0]["events"],
    task: "ide-host",
    threadId: started.threadId,
  });
  assert.ok(score.ide_commands >= 1);
  const bench = await client.ideWorkbench();
  assert.match(bench.html, /dispatchIde/);
  assert.match(bench.html, /window\.harness/);
  assert.match(bench.html, /data-rpc="ide\/command apply"/);
  await client.shutdown();
});

test("VS Code host sends harness ide apply instead of harness apply", async () => {
  const src = await readFile(vscodeExt, "utf8");
  assert.match(src, /harness ide \$\{cmd\}/);
  assert.match(src, /harness ide apply/);
  assert.doesNotMatch(src, /sendText\("harness apply"\)/);
  assert.match(src, /function harnessIdeCli/);
});

test("TUI paints rewind-style ide/command items", () => {
  const state = applyEvent(emptyTuiState({ threadId: "th_1" }), "plugin/event", {
    type: "ide/command",
    cmd: "apply",
    message: "merged harness/th_1",
  });
  assert.match(renderFrame(state), /apply merged harness\/th_1/);
});
