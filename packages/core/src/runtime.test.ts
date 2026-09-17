import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalFs, PathDeniedError } from "./runtime-local.ts";
import { TrajStore } from "./traj.ts";

test("fs denies path escape from AgentWorkspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-fs-"));
  const fs = new LocalFs(root);
  assert.throws(() => fs.resolve("../secret"), PathDeniedError);
  assert.throws(() => fs.resolve(os.homedir()), PathDeniedError);
});

test("traj is append-only jsonl", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-traj-"));
  const traj = new TrajStore(dir);
  await traj.init({
    threadId: "th_test",
    mode: "agent",
    model: "mock",
    userRoot: "/tmp/user",
    agentRoot: "/tmp/agent",
    plugin_lock: { packages: [] },
    startedAt: new Date().toISOString(),
  });
  await traj.append("user", "turn/start", { prompt: "hi" });
  await traj.append("tool", "tool_result", { name: "bash" });
  const events = await traj.events();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.source, "user");
  assert.equal(events[1]?.source, "tool");
});
