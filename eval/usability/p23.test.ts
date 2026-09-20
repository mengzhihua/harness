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
import { parseIdeCommand } from "@harness/core";
import { applyEvent, emptyTuiState, renderFrame } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p23-"));
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

test("protocol version is 0.23 for P23", () => {
  assert.equal(PROTOCOL_VERSION, "0.23.0");
});

test("parseIdeCommand accepts workbench buttons and rejects unknown", () => {
  assert.equal(parseIdeCommand("apply"), "apply");
  assert.equal(parseIdeCommand("steer"), "steer");
  assert.throws(() => parseIdeCommand("explode"), /unknown ide command/);
});

test("ide/command steers, opens a worktree file, and reports tui", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  const events: Array<{ type?: string; cmd?: string }> = [];
  client.onEvent((method, params) => {
    if (method === "plugin/event") events.push(params as { type?: string; cmd?: string });
  });
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  const steered = await client.ideCommand("steer", { text: "don't touch USER_WIP.md" });
  assert.equal(steered.ok, true);
  assert.equal(steered.queued, 1);
  assert.deepEqual((await client.turnInbox()).queued, ["don't touch USER_WIP.md"]);
  const opened = await client.ideCommand("open", { path: "src/auth.js" });
  assert.equal(opened.ok, true, opened.message);
  assert.match(opened.content ?? "", /password|export|function/i);
  const tui = await client.ideCommand("tui");
  assert.equal(tui.message, "harness tui");
  await assert.rejects(client.ideCommand("explode"), /unknown ide command/);
  assert.ok(events.some((e) => e.type === "ide/command" && e.cmd === "steer"));
  const bench = await client.ideWorkbench();
  assert.match(bench.html, /ide\/command apply/);
  await client.shutdown();
});

test("TUI paints ide/command notifications", () => {
  const state = applyEvent(emptyTuiState({ threadId: "th_1" }), "plugin/event", {
    type: "ide/command",
    cmd: "steer",
    message: "queued 1",
  });
  assert.match(renderFrame(state), /steer queued 1/);
});
