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
import { listEvalTasks, scoreTrajectory, summarizeScorecard } from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));
const tasksDir = fileURLToPath(new URL("../tasks", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p16-"));
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

test("protocol version is 0.16 for P16", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("eval/score after a mock turn reports apply_ready, plugins, and no unrelated files", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart("fix-login");
  const done = (await client.turnStart("把失败的登录测试修了，不要动别的模块")) as {
    apply_ready: boolean;
    changed_files: string[];
  };
  assert.equal(done.apply_ready, true);
  const score = await client.evalScore({ task: "fix-login" });
  assert.equal(score.task, "fix-login");
  assert.equal(score.apply_ready, true);
  assert.equal(score.claimed_done_but_check_fail, 0);
  assert.equal(score.plugin_errors, 0);
  assert.equal(score.integrity_mismatch, 0);
  assert.deepEqual(score.unrelated_files, []);
  assert.ok(score.changed_files.includes("src/auth.js"));
  assert.ok(score.project_plugins.includes("login.verify"));
  assert.equal(
    score.project_plugins.some((id) => id.startsWith("harness.") || id.startsWith("@harness/")),
    false,
  );
  assert.ok(score.plugin_lock.some((id) => id.startsWith("login.verify@")));
  assert.equal(score.dry_replay_ok, true);
  assert.ok(score.first_tool_ms == null || score.first_tool_ms >= 0);
  await client.shutdown();
});

test("eval suite lists golden markdown tasks and scores two threads", async () => {
  const listed = await listEvalTasks(tasksDir);
  assert.ok(listed.length >= 20, `expected golden tasks, got ${listed.length}`);
  assert.ok(listed.some((t) => t.name === "fix-login"));

  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock", profile: "eval" });
  const scores = [];
  for (const name of ["fix-login", "dirty-tree"]) {
    await client.threadStart(name);
    await client.turnStart("把失败的登录测试修了，不要动别的模块");
    scores.push(await client.evalScore({ task: name }));
  }
  const card = summarizeScorecard(scores);
  assert.equal(card.totals.tasks, 2);
  assert.equal(card.totals.apply_ready, 2);
  assert.equal(card.totals.claimed_done_but_check_fail, 0);
  assert.equal(card.totals.unrelated_files, 0);
  assert.equal(card.totals.plugin_errors, 0);
  assert.equal(card.totals.project_plugins_seen, 2);
  await client.shutdown();
});

test("scoreTrajectory stays the source of eval/score numbers", () => {
  const score = scoreTrajectory({
    events: [
      { ts: "t0", source: "user", type: "turn/start", payload: { prompt: "x" } },
      {
        ts: "t1",
        source: "system",
        type: "done_report",
        payload: { changed_files: ["USER_WIP.md"], checks: [], apply_ready: false },
      },
    ],
  });
  assert.deepEqual(score.unrelated_files, ["USER_WIP.md"]);
});
