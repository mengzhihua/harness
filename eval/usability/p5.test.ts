import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { HarnessClient } from "@harness/sdk";
import { createEmbeddedPair } from "@harness/server";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { WorkerHub, boot, type ProcFn, type ToolRouter } from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p5-"));
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

function clientFor(pair: { toServer: import("node:stream").PassThrough; toClient: import("node:stream").PassThrough }) {
  return new HarnessClient(pair.toClient, pair.toServer);
}

async function waitUntilSettled(client: HarnessClient, threadId: string, timeoutMs = 60_000) {
  const start = Date.now();
  for (;;) {
    const status = await client.turnStatus(threadId);
    if (!status.running) return status;
    if (Date.now() - start > timeoutMs) throw new Error("turn did not settle");
    await new Promise((r) => setTimeout(r, 40));
  }
}

test("protocol version is 0.5 for P5", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("detached turn keeps the same traj id after the client reconnects", async () => {
  const { userRoot, home } = await loginRepo();
  const hub = new WorkerHub();
  const a = createEmbeddedPair(hub);
  const clientA = clientFor(a);
  await clientA.initialize({ cwd: userRoot, harnessHome: home, model: "mock", unattended: true });
  const started = await clientA.threadStart("fix login");
  const t0 = Date.now();
  const accepted = (await clientA.turnStart("把失败的登录测试修了", { detach: true })) as {
    running?: boolean;
    threadId?: string;
  };
  assert.equal(accepted.running, true);
  assert.equal(accepted.threadId, started.threadId);
  assert.ok(Date.now() - t0 < 500, "detach must return before the turn finishes");
  await clientA.shutdown();
  assert.equal(hub.get(started.threadId) !== undefined, true);

  const b = createEmbeddedPair(hub);
  const clientB = clientFor(b);
  await clientB.initialize({ cwd: userRoot, harnessHome: home, model: "mock", unattended: true });
  const resumed = await clientB.threadResume(started.threadId);
  assert.equal(resumed.threadId, started.threadId);
  const settled = await waitUntilSettled(clientB, started.threadId);
  assert.equal(settled.running, false);
  const rewind: Array<{ type?: string }> = [];
  clientB.onEvent((method, params) => {
    if (method === "item/rewind") rewind.push(params as { type?: string });
  });
  const sub = await clientB.threadSubscribe(0);
  assert.ok(sub.count > 0);
  assert.equal(sub.running, false);
  assert.ok(rewind.some((e) => e.type === "done_report") || sub.count >= 3);
  const shown = await clientB.trajShow();
  const header = shown.header as { threadId: string; workerId?: string; machineId?: string };
  assert.equal(header.threadId, started.threadId);
  assert.equal(header.workerId, hub.workerId);
  assert.ok(header.machineId);
  await clientB.shutdown();
  await hub.closeAll();
});

test("unattended records an audit event instead of blocking ask-once network", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", unattended: true });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "n1",
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "curl https://example.invalid" }) },
    });
    assert.equal(result.ok, true);
    const events = await session.traj.events();
    assert.ok(events.some((e) => e.type === "audit" && (e.payload as { name?: string }).name === "bash"));
  } finally {
    await session.close();
  }
});

test("workspace/pr and workspace/ci hang artifacts on the same traj", async () => {
  const { userRoot, home } = await loginRepo();
  const proc: ProcFn = async (_file, args) => {
    if (args[0] === "pr") {
      return { stdout: "https://github.com/org/repo/pull/12\n", stderr: "", exitCode: 0 };
    }
    if (args[1] === "list") {
      return {
        stdout: JSON.stringify([
          { databaseId: 99, url: "https://github.com/org/repo/actions/runs/99", conclusion: "success", status: "completed" },
        ]),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "CI ok\n", stderr: "", exitCode: 0 };
  };
  const pair = createEmbeddedPair(undefined, proc);
  const client = clientFor(pair);
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  await client.turnStart("把失败的登录测试修了");
  const pr = await client.openPr({ title: "fix login" });
  assert.equal(pr.ok, true);
  assert.equal(pr.url, "https://github.com/org/repo/pull/12");
  const ci = await client.attachCi();
  assert.equal(ci.ok, true);
  assert.match(ci.artifact ?? "", /ci-99\.log/);
  const shown = await client.trajShow();
  const types = (shown.events as Array<{ type: string }>).map((e) => e.type);
  assert.ok(types.includes("pr/opened"));
  assert.ok(types.includes("ci/log"));
  await client.shutdown();
});

test("initialize returns worker identity (session ≠ machine)", async () => {
  const { userRoot, home } = await loginRepo();
  const pair = createEmbeddedPair();
  const client = clientFor(pair);
  const init = (await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" })) as {
    protocolVersion: string;
    worker: { workerId: string; machineId: string };
  };
  assert.equal(init.protocolVersion, PROTOCOL_VERSION);
  assert.ok(init.worker.workerId.startsWith("wk_"));
  assert.ok(init.worker.machineId);
  const info = await client.workerInfo();
  assert.equal(info.workerId, init.worker.workerId);
  await client.shutdown();
});
