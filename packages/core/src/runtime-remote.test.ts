import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PathDeniedError } from "./runtime-local.ts";
import { remoteExecRequest, RemoteSubprocess } from "./runtime-remote.ts";

test("remoteExecRequest freezes worker/exec with network off", () => {
  const req = remoteExecRequest({ workerId: "wk_1", command: "node --test" });
  assert.equal(req.method, "worker/exec");
  assert.deepEqual(req.params, {
    workerId: "wk_1",
    command: "node --test",
    cwd: ".",
    network: false,
    root: "/workspace",
  });
});

test("remoteExecRequest denies path escape", () => {
  assert.throws(() => remoteExecRequest({ workerId: "wk_1", command: "x", cwd: "../secret" }), PathDeniedError);
});

test("RemoteSubprocess fails closed without HARNESS_WORKER_URL", async () => {
  const prev = process.env.HARNESS_WORKER_URL;
  delete process.env.HARNESS_WORKER_URL;
  try {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-remote-"));
    const sub = new RemoteSubprocess(root, "wk_test");
    const result = await sub.exec("true");
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /HARNESS_WORKER_URL/);
  } finally {
    if (prev !== undefined) process.env.HARNESS_WORKER_URL = prev;
  }
});
