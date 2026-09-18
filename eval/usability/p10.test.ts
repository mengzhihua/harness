import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { HarnessClient } from "@harness/sdk";
import { AppServer } from "@harness/server";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { assemble, boot, setPlan, skipPlanStep, type Llm } from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p10-"));
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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd, encoding: "utf8" });
  return stdout;
}

function connect() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  new AppServer(toServer, toClient);
  return new HarnessClient(toClient, toServer);
}

test("protocol version is 0.10 for P10", () => {
  assert.equal(PROTOCOL_VERSION, "0.10.0");
});

test("layered AGENTS.md walks root toward cwd (nearer last)", async () => {
  const { userRoot, home } = await loginRepo();
  await writeFile(path.join(userRoot, "AGENTS.md"), "ROOT_AGENTS_MARK: use node --test\n");
  await mkdir(path.join(userRoot, "pkg"), { recursive: true });
  await writeFile(path.join(userRoot, "pkg", "AGENTS.md"), "PKG_AGENTS_MARK: stay in pkg\n");
  await git(userRoot, ["add", "-A"]);
  await git(userRoot, ["commit", "-m", "agents"]);
  const session = await boot({ userRoot: path.join(userRoot, "pkg"), harnessHome: home, model: "mock" });
  try {
    const msgs = await assemble(session.thread, "continue");
    const sys = msgs[0]?.content ?? "";
    assert.match(sys, /ROOT_AGENTS_MARK/);
    assert.match(sys, /PKG_AGENTS_MARK/);
    assert.ok(sys.indexOf("ROOT_AGENTS_MARK") < sys.indexOf("PKG_AGENTS_MARK"));
  } finally {
    await session.close();
  }
});

test("skill catalog lists id and description, not SKILL.md body", async () => {
  const { userRoot, home } = await loginRepo();
  const dir = path.join(userRoot, ".harness", "plugins", "login-skill");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({ id: "login.helper", kind: "skill", description: "how to fix login tests" }),
  );
  await writeFile(path.join(dir, "SKILL.md"), "SECRET_SKILL_BODY never dump this into the prompt\n");
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const msgs = await assemble(session.thread, "continue");
    const sys = msgs[0]?.content ?? "";
    assert.match(sys, /login\.helper/);
    assert.match(sys, /how to fix login tests/);
    assert.doesNotMatch(sys, /SECRET_SKILL_BODY/);
  } finally {
    await session.close();
  }
});

test("pasted diffs are attachment events and are not duplicated under ## attachments", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  const llm: Llm = {
    async chat(req) {
      const last = req.messages.filter((m) => m.role === "user").at(-1);
      return { role: "assistant", content: last?.content ?? "" };
    },
  };
  session.thread.provide("llm", llm);
  try {
    const prompt =
      "apply this\n```diff\ndiff --git a/src/auth.js b/src/auth.js\n--- a/src/auth.js\n+++ b/src/auth.js\n@@ -1 +1 @@\n-a\n+b\n```\n";
    const turn = await session.runTurn({ prompt });
    assert.doesNotMatch(turn.done.message, /## attachments/);
    assert.match(turn.done.message, /diff --git/);
    const events = await session.traj.events();
    const att = events.find((e) => e.type === "attachment");
    assert.ok(att);
    assert.deepEqual((att?.payload as { paths?: string[] }).paths, ["paste:diff"]);
  } finally {
    await session.close();
  }
});

test("traj redacts secrets and records env_hash", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    assert.match(session.traj.header?.env_hash ?? "", /^[a-f0-9]{16}$/);
    await session.traj.append("user", "turn/start", {
      prompt: "use sk-abcdefghijklmnopqrstuvwxyz",
      api_key: "supersecretvalue",
      password: "passw0rd",
    });
    const blob = JSON.stringify(await session.traj.events());
    assert.doesNotMatch(blob, /sk-abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(blob, /supersecretvalue/);
    assert.match(blob, /\[redacted\]/);
    assert.match(blob, /passw0rd/);
    const artifact = await session.traj.writeArtifact("leak.txt", "token sk-abcdefghijklmnopqrstuvwxyz\n");
    const body = await readFile(artifact, "utf8");
    assert.doesNotMatch(body, /sk-abcdefghijklmnopqrstuvwxyz/);
    assert.match(body, /\[redacted\]/);
  } finally {
    await session.close();
  }
});

test("apply aborts a conflicted merge and leaves the user tree unmerged-clean", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    await writeFile(path.join(userRoot, "src/auth.js"), "export const userSide = 1;\n");
    await git(userRoot, ["add", "src/auth.js"]);
    await git(userRoot, ["commit", "-m", "user edit"]);
    await writeFile(path.join(session.workspace.agentRoot, "src/auth.js"), "export const agentSide = 2;\n");
    await session.workspace.checkpoint("agent edit");
    const applied = await session.apply();
    assert.equal(applied.ok, false);
    assert.match(applied.message, /merge conflict/);
    const unmerged = (await git(userRoot, ["diff", "--name-only", "--diff-filter=U"])).trim();
    assert.equal(unmerged, "");
    const status = await git(userRoot, ["status"]);
    assert.doesNotMatch(status, /You have unmerged paths|All conflicts fixed but you are still merging/i);
    const userSrc = await readFile(path.join(userRoot, "src/auth.js"), "utf8");
    assert.match(userSrc, /userSide = 1/);
  } finally {
    await session.close();
  }
});

test("plan/skip marks a step skipped for assemble and the SDK", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  await client.planSet([
    { id: "1", title: "inspect", status: "pending" },
    { id: "2", title: "edit auth", status: "pending" },
  ]);
  const skipped = await client.planSkip("2");
  assert.equal((skipped.steps as Array<{ id: string; status: string }>).find((s) => s.id === "2")?.status, "skipped");
  const session = await boot({ userRoot, harnessHome: path.join(home, "p"), model: "mock" });
  try {
    await setPlan(session.thread, [
      { id: "1", title: "inspect", status: "pending" },
      { id: "2", title: "edit auth", status: "pending" },
    ]);
    await skipPlanStep(session.thread, "2");
    const msgs = await assemble(session.thread, "continue");
    assert.match(msgs[0]?.content ?? "", /\[-\] 2 edit auth/);
  } finally {
    await session.close();
    await client.shutdown();
  }
});
