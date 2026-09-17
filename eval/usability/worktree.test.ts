import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { boot } from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

test("exec fixes failing login tests without dirtying the user tree", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-u2-"));
  const userRoot = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  await cp(fixture, userRoot, { recursive: true });
  await git(userRoot, ["init"]);
  await git(userRoot, ["config", "user.email", "eval@harness.local"]);
  await git(userRoot, ["config", "user.name", "Eval"]);
  await git(userRoot, ["add", "-A"]);
  await git(userRoot, ["commit", "-m", "fixture"]);
  await writeFile(path.join(userRoot, "USER_WIP.md"), "do not touch me\n");

  const session = await boot({
    userRoot,
    harnessHome: home,
    profile: "standard",
    model: "mock",
  });

  try {
    const turn = await session.runTurn({
      prompt: "把失败的登录测试修了，不要动别的模块",
    });

    const userSrc = await readFile(path.join(userRoot, "src/auth.js"), "utf8");
    const userWip = await readFile(path.join(userRoot, "USER_WIP.md"), "utf8");
    const agentSrc = await readFile(path.join(session.workspace.agentRoot, "src/auth.js"), "utf8");

    assert.match(userSrc, /passw0rd/);
    assert.doesNotMatch(userSrc, /password === "password"/);
    assert.equal(userWip, "do not touch me\n");
    assert.match(agentSrc, /password === "password"/);
    assert.doesNotMatch(agentSrc, /passw0rd/);

    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("NODE_TEST")) delete env[key];
    }
    const testRun = await execFile("node", ["--test"], {
      cwd: session.workspace.agentRoot,
      encoding: "utf8",
      env,
    });
    const testOut = `${testRun.stdout}\n${testRun.stderr}`;
    assert.match(testOut, /pass\s+1/);
    assert.match(testOut, /fail\s+0/);

    assert.ok(turn.done.changed_files.includes("src/auth.js"));
    assert.equal(turn.done.apply_ready, true);

    const lockIds = session.traj.header?.plugin_lock.packages.map((p) => p.id) ?? [];
    assert.ok(lockIds.includes("harness.agent-loop"));
    assert.ok(lockIds.includes("harness.aci-tools"));

    const events = await session.traj.events();
    assert.ok(events.some((e) => e.source === "tool"));
    assert.ok(events.some((e) => e.source === "plugin"));
    assert.ok(events.some((e) => e.type === "done_report"));
    assert.ok(events.some((e) => e.source === "assistant"));
  } finally {
    await session.close();
  }
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}
