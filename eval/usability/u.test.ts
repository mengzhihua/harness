import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { boot, exportTraj, Policy } from "@harness/core";
import { renderFrame, emptyTuiState } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-u-"));
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

test("U1–U12 dogfood checklist", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    // U1 zero-config mock
    assert.equal(session.config.model, "mock");
    // U2 worktree, dirty user file preserved
    assert.equal(session.workspace.kind, "worktree");
    assert.equal(await readFile(path.join(userRoot, "USER_WIP.md"), "utf8"), "do not touch me\n");
    // U5 workspace write allowed; secrets denied
    const p = new Policy({ mode: "agent", yolo: false });
    assert.equal(p.decide({ name: "str_replace", args: { path: "a.js" }, deny: false }).verdict, "allow");
    assert.equal(p.decide({ name: "bash", args: { command: "cat /etc/shadow" }, deny: false }).verdict, "deny");
    // U8 readonly tools exist for parallel
    const names = session.thread.get<{ schemas: () => Array<{ function: { name: string } }> }>("tools").schemas().map((s) => s.function.name);
    assert.ok(names.includes("grep") && names.includes("glob") && names.includes("read_file"));
    // U11 project plugins without forking harness
    const ids = session.plugins().map((pl) => pl.id);
    assert.ok(ids.includes("login.verify"));
    assert.ok(ids.includes("login.no-fmt"));
    // U12 exportable traj
    const out = path.join(home, "u12.traj");
    const exported = await exportTraj(session.traj.dir, out);
    assert.equal(exported, out);
    const st = await readFile(out);
    assert.ok(st.byteLength > 0);
    // U7 TUI can show a live diff line
    assert.match(renderFrame(emptyTuiState({ diff: "src/auth.js" })), /src\/auth\.js/);
  } finally {
    await session.close();
  }
});
