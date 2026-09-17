import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { attachCiLogs, createPullRequest, type ProcFn } from "./github.ts";
import { TrajStore } from "./traj.ts";

test("createPullRequest records the URL from gh stdout", async () => {
  const proc: ProcFn = async (file, args) => {
    assert.equal(file, "gh");
    assert.equal(args[0], "pr");
    assert.equal(args[1], "create");
    return { stdout: "https://github.com/org/repo/pull/9\n", stderr: "", exitCode: 0 };
  };
  const out = await createPullRequest({ cwd: "/tmp", title: "fix login", body: "done", proc });
  assert.equal(out.ok, true);
  assert.equal(out.url, "https://github.com/org/repo/pull/9");
  assert.equal(out.number, 9);
});

test("createPullRequest fails closed when gh is missing", async () => {
  const proc: ProcFn = async () => ({ stdout: "", stderr: "gh unavailable: spawn gh ENOENT", exitCode: 1 });
  const out = await createPullRequest({ cwd: "/tmp", title: "x", body: "y", proc });
  assert.equal(out.ok, false);
  assert.match(out.message, /gh unavailable|ENOENT/);
});

test("attachCiLogs writes an artifact and ci/log traj event", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-ci-"));
  const traj = new TrajStore(dir);
  await traj.init({
    threadId: "th_ci",
    mode: "agent",
    model: "mock",
    userRoot: "/tmp/user",
    agentRoot: "/tmp/agent",
    plugin_lock: { packages: [] },
    startedAt: new Date().toISOString(),
  });
  const proc: ProcFn = async (_file, args) => {
    if (args[0] === "run" && args[1] === "list") {
      return {
        stdout: JSON.stringify([{ databaseId: 42, url: "https://github.com/org/repo/actions/runs/42", conclusion: "success", status: "completed" }]),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "job1\tpassed\n", stderr: "", exitCode: 0 };
  };
  const out = await attachCiLogs({ cwd: "/tmp", traj, proc });
  assert.equal(out.ok, true);
  assert.match(out.artifact ?? "", /ci-42\.log/);
  const events = await traj.events();
  assert.equal(events.some((e) => e.type === "ci/log"), true);
});
