import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalFs, LocalSubprocess, PathDeniedError } from "./runtime-local.ts";
import { TrajStore } from "./traj.ts";
import { NETWORK_SINK } from "./sandbox.ts";

test("fs denies path escape from AgentWorkspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-fs-"));
  const fs = new LocalFs(root);
  assert.throws(() => fs.resolve("../secret"), PathDeniedError);
  assert.throws(() => fs.resolve(os.homedir()), PathDeniedError);
});

test("local sandbox strips secrets and sinks network by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-sbx-"));
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-should-not-leak";
  try {
    const sub = new LocalSubprocess(root, { network: false });
    const net = await sub.exec("node -e \"console.log(process.env.HTTP_PROXY||'')\"");
    assert.equal(net.exitCode, 0, net.stderr);
    assert.equal(net.stdout.trim(), NETWORK_SINK);
    const secret = await sub.exec("node -e \"console.log(process.env.OPENAI_API_KEY||'unset')\"");
    assert.equal(secret.exitCode, 0, secret.stderr);
    assert.equal(secret.stdout.trim(), "unset");
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test("exec streams stdout chunks before the process exits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-stream-"));
  const chunks: string[] = [];
  const sub = new LocalSubprocess(root, { network: false });
  const result = await sub.exec("printf 'hello\\nworld\\n'", { onStdout: (c) => chunks.push(c) });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(chunks.join(""), /hello/);
  assert.match(result.stdout, /hello/);
});

test("subprocess abort kills the in-flight command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-abort-"));
  const sub = new LocalSubprocess(root, { network: false });
  const ac = new AbortController();
  const started = Date.now();
  const pending = sub.exec("sleep 20", { timeoutMs: 30_000, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 80));
  ac.abort();
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /interrupted/);
  assert.ok(Date.now() - started < 3_000, `abort waited ${Date.now() - started}ms`);
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
