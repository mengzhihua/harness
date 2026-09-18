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
import { applyEvent, emptyTuiState, previewLines, renderFrame } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p22-"));
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

test("protocol version is 0.22 for P22", () => {
  assert.equal(PROTOCOL_VERSION, "0.22.0");
});

test("ide/file is the workbench fallback when no editor is configured", async () => {
  const prev = process.env.HARNESS_IDE;
  process.env.HARNESS_IDE = "none";
  try {
    const { userRoot, home } = await loginRepo();
    const client = connect();
    await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
    await client.threadStart();
    const opened = await client.ideOpen("src/auth.js");
    assert.equal(opened.ok, false);
    const read = await client.ideFile("src/auth.js");
    assert.equal(read.ok, true, read.content);
    assert.match(read.content, /password|export|function/i);
    const lines = previewLines(read.content, 3);
    assert.ok(lines.length >= 1);
    await client.shutdown();
  } finally {
    if (prev === undefined) delete process.env.HARNESS_IDE;
    else process.env.HARNESS_IDE = prev;
  }
});

test("workbench HTML wires apply/undo/steer commands", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  const bench = await client.ideWorkbench();
  assert.match(bench.html, /data-cmd="apply"/);
  assert.match(bench.html, /harness apply/);
  assert.match(bench.html, /id="steer"/);
  await client.shutdown();
});

test("TUI paints a failed tool's permission error", () => {
  const state = applyEvent(emptyTuiState({ threadId: "th_1" }), "item/completed", {
    type: "tool",
    name: "peek_path",
    ok: false,
    error: "denied by policy/plugin: plugin eval.peek lacks permissions.host-fs",
  });
  assert.match(renderFrame(state), /host-fs/);
});
