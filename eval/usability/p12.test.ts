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
import { boot, detectCheckCommand, loadUserConfig, Policy } from "@harness/core";
import { applyEvent, emptyTuiState, renderFrame } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p12-"));
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

test("protocol version is 0.12 for P12", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("user config.yml supplies model and mode when flags are omitted", async () => {
  const { userRoot, home } = await loginRepo();
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "config.yml"), "model: mock\nmode: plan\nyolo: false\n");
  const loaded = await loadUserConfig(home);
  assert.equal(loaded.model, "mock");
  assert.equal(loaded.mode, "plan");
  const session = await boot({ userRoot, harnessHome: home });
  try {
    assert.equal(session.config.model, "mock");
    assert.equal(session.config.mode, "plan");
  } finally {
    await session.close();
  }
  const flagged = await boot({ userRoot, harnessHome: home, model: "mock", mode: "agent" });
  try {
    assert.equal(flagged.config.mode, "agent");
  } finally {
    await flagged.close();
  }
});

test("detectCheckCommand prefers AGENTS.md then package.json", async () => {
  const { userRoot } = await loginRepo();
  assert.equal(await detectCheckCommand(userRoot), "node --test");
  await writeFile(path.join(userRoot, "AGENTS.md"), "Run `pnpm test` in this repo.\n");
  assert.equal(await detectCheckCommand(userRoot), "pnpm test");
});

test("workspace/check runs the detected test command", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock", yolo: true });
  await client.threadStart();
  const checked = await client.runCheck();
  assert.equal(checked.cmd, "node --test");
  assert.equal(typeof checked.exit_code, "number");
  const shown = await client.trajShow();
  assert.ok((shown.events as Array<{ type: string }>).some((e) => e.type === "workspace/check"));
  await client.shutdown();
});

test("SDK resume returns the same thread id", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  const started = await client.threadStart("resume me");
  const listed = await client.threadList("resume");
  assert.ok(listed.threads.some((t) => t.threadId === started.threadId));
  const resumed = await client.threadResume(started.threadId);
  assert.equal(resumed.threadId, started.threadId);
  await client.shutdown();
});

test("approval card lists command, cwd, and this-turn / this-thread keys", () => {
  const state = applyEvent(emptyTuiState({ threadId: "th_1", agentRoot: "/tmp/wt" }), "approval/request", {
    id: "ap_9",
    name: "bash",
    reason: "network / install / push",
    command: "curl https://example",
    cwd: "/tmp/wt",
  });
  const frame = renderFrame(state);
  assert.match(frame, /curl https:\/\/example/);
  assert.match(frame, /cwd \/tmp\/wt/);
  assert.match(frame, /this turn/);
  assert.match(frame, /this thread/);
  assert.match(frame, /\[n\] deny/);
});

test("read_skill is a default-allow read in ask mode", () => {
  const p = new Policy({ mode: "ask", yolo: false });
  assert.equal(p.decide({ name: "read_skill", args: { id: "login.verify" }, deny: false }).verdict, "allow");
});
