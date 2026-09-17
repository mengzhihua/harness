import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { containerWorkdir, dockerArgs, DockerSubprocess } from "./runtime-docker.ts";
import { PathDeniedError } from "./runtime-local.ts";

test("dockerArgs bind-mounts the worktree with network off", () => {
  const args = dockerArgs({
    image: "node:22-bookworm",
    hostRoot: "/tmp/agent",
    command: "node --test",
  });
  assert.deepEqual(args.slice(0, 8), [
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    "/tmp/agent:/workspace",
    "-w",
    "/workspace",
  ]);
  assert.equal(args.at(-4), "node:22-bookworm");
  assert.deepEqual(args.slice(-3), ["sh", "-lc", "node --test"]);
  assert.equal(args.includes("OPENAI_API_KEY"), false);
});

test("dockerArgs maps relative cwd under /workspace and can enable bridge", () => {
  const args = dockerArgs({
    image: "node:22-bookworm",
    hostRoot: "/tmp/agent",
    command: "pwd",
    cwd: "src",
    network: true,
  });
  assert.equal(args[args.indexOf("--network") + 1], "bridge");
  assert.equal(args[args.indexOf("-w") + 1], "/workspace/src");
});

test("containerWorkdir denies path escape", () => {
  assert.equal(containerWorkdir("/tmp/agent"), "/workspace");
  assert.equal(containerWorkdir("/tmp/agent", "."), "/workspace");
  assert.throws(() => containerWorkdir("/tmp/agent", "../secret"), PathDeniedError);
});

test("DockerSubprocess fails closed when docker is missing", async (t) => {
  if (process.env.HARNESS_DOCKER_LIVE) {
    t.skip("live docker requested");
    return;
  }
  if (await dockerOnPath()) {
    t.skip("docker binary present; argv contract is the P4 guarantee");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-dock-"));
  const sub = new DockerSubprocess(root, "node:22-bookworm", false);
  const result = await sub.exec("true");
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /docker unavailable|not found|ENOENT|Cannot connect/i);
});

function dockerOnPath(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["version"], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}
