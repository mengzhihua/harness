import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { HarnessClient } from "@harness/sdk";
import { AppServer } from "@harness/server";
import { applyEvent, emptyTuiState, renderFrame } from "@harness/tui";
import { boot, clampTimeout, type ToolRouter } from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p34-"));
  const userRoot = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  await cp(fixture, userRoot, { recursive: true });
  await git(userRoot, ["init"]);
  await git(userRoot, ["config", "user.email", "eval@harness.local"]);
  await git(userRoot, ["config", "user.name", "Eval"]);
  await git(userRoot, ["add", "-A"]);
  await git(userRoot, ["commit", "-m", "fixture"]);
  await writeFile(path.join(userRoot, "USER_WIP.md"), "do not touch me\n");
  return { userRoot, home, tmp };
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

test("protocol version is semver for P34", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("clampTimeout floors to 1s and caps at 10 minutes", () => {
  assert.equal(clampTimeout(500, 30_000), 1_000);
  assert.equal(clampTimeout(999_999, 30_000), 600_000);
  assert.equal(clampTimeout("nope", 30_000), 30_000);
});

test("delete_file removes a workspace file and ask mode refuses it", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", yolo: true });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    await tools.execute({
      id: "w",
      type: "function",
      function: { name: "write_file", arguments: JSON.stringify({ path: "tmp-p34.txt", content: "x\n" }) },
    });
    assert.equal(existsSync(path.join(session.workspace.agentRoot, "tmp-p34.txt")), true);
    const del = await tools.execute({
      id: "d",
      type: "function",
      function: { name: "delete_file", arguments: JSON.stringify({ path: "tmp-p34.txt" }) },
    });
    assert.equal(del.ok, true);
    assert.equal(existsSync(path.join(session.workspace.agentRoot, "tmp-p34.txt")), false);
  } finally {
    await session.close();
  }
  const ask = await boot({ userRoot, harnessHome: home, model: "mock", mode: "ask" });
  try {
    const tools = ask.thread.get<ToolRouter>("tools");
    const denied = await tools.execute({
      id: "d2",
      type: "function",
      function: { name: "delete_file", arguments: JSON.stringify({ path: "src/auth.js" }) },
    });
    assert.equal(denied.ok, false);
    assert.match(denied.content, /ask mode is read-only/);
  } finally {
    await ask.close();
  }
});

test("background bash returns immediately and wait collects the output", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", yolo: true });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const started = await tools.execute({
      id: "b",
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify({ command: "sleep 0.2; printf p34-jobs", background: true }),
      },
    });
    assert.equal(started.ok, true);
    assert.match(started.content, /started job_1/);
    assert.match(started.content, /call wait/);
    const waited = await tools.execute({
      id: "w",
      type: "function",
      function: { name: "wait", arguments: JSON.stringify({ job_id: "job_1", timeout_ms: 5000 }) },
    });
    assert.equal(waited.ok, true);
    assert.match(waited.content, /--- stdout ---[\s\S]*p34-jobs/);
    assert.match(waited.content, /exit 0/);
  } finally {
    await session.close();
  }
});

test("wait can poll a still-running job then interrupt kills it", async () => {
  const { userRoot, home } = await loginRepo();
  const ac = new AbortController();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", yolo: true });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const started = await tools.execute({
      id: "b",
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify({ command: "sleep 20", background: true, timeout_ms: 60000 }),
      },
      // start without abort so the job is linked after we pass signal
    });
    assert.match(started.content, /started job_1/);
    const poll = await tools.execute({
      id: "p",
      type: "function",
      function: { name: "wait", arguments: JSON.stringify({ job_id: "job_1", timeout_ms: 200 }) },
    });
    assert.match(poll.content, /still running/);
    const startedWithSignal = await tools.execute(
      {
        id: "b2",
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "sleep 20", background: true }),
        },
      },
      ac.signal,
    );
    assert.match(startedWithSignal.content, /started job_2/);
    ac.abort();
    const killed = await tools.execute({
      id: "w2",
      type: "function",
      function: { name: "wait", arguments: JSON.stringify({ job_id: "job_2", timeout_ms: 5000 }) },
    });
    assert.match(killed.content, /killed|interrupted|exit 1/);
  } finally {
    await session.close();
  }
});

test("TUI paints running jobs and thread/jobs RPC lists them", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock", yolo: true });
  await client.threadStart();
  const listed = await client.threadJobs();
  assert.deepEqual(listed.jobs, []);
  const painted = applyEvent(emptyTuiState({ threadId: "th_1" }), "jobs/updated", {
    jobs: [{ id: "job_1", command: "node --test", status: "running" }],
  });
  assert.match(renderFrame(painted), /jobs job_1 node --test/);
  await client.shutdown();
});
