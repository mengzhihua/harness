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
import { applyEvent, emptyTuiState, renderFrame } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p18-"));
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

test("protocol version is 0.18 for P18", () => {
  assert.equal(PROTOCOL_VERSION, "0.18.0");
});

test("turn/steer queues follow-ups, notifies inbox/updated, and clear empties the inbox", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  const updates: Array<{ queued?: string[] }> = [];
  client.onEvent((method, params) => {
    if (method === "inbox/updated") updates.push(params as { queued?: string[] });
  });
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  const first = await client.turnSteer("don't touch USER_WIP.md");
  assert.equal(first.queued, 1);
  assert.deepEqual(first.items, ["don't touch USER_WIP.md"]);
  const second = await client.turnSteer("then run the tests");
  assert.equal(second.queued, 2);
  assert.deepEqual((await client.turnInbox()).queued, ["don't touch USER_WIP.md", "then run the tests"]);
  assert.ok(updates.some((u) => u.queued?.length === 2));
  const cleared = await client.turnInboxClear();
  assert.deepEqual(cleared.queued, []);
  assert.deepEqual((await client.turnInbox()).queued, []);
  await client.shutdown();
});

test("TUI frame keeps the input line and paints queued follow-ups", () => {
  let state = emptyTuiState({ threadId: "th_1", status: "running" });
  state = applyEvent(state, "inbox/updated", {
    queued: ["don't touch USER_WIP.md", "then run the tests"],
  });
  const frame = renderFrame(state);
  assert.match(frame, /> /);
  assert.match(frame, /queued \(2\)/);
  assert.match(frame, /queued=2/);
  assert.match(frame, /don't touch USER_WIP/);
  assert.match(frame, /then run the tests/);
  state = applyEvent(state, "inbox/updated", { queued: ["then run the tests"], consumed: "don't touch USER_WIP.md" });
  assert.deepEqual(state.pending, ["then run the tests"]);
  assert.match(renderFrame(state), /queued \(1\)/);
});
