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
import { listenWorkbench, parseIdeSlash } from "@harness/core";
import { applyEvent, emptyTuiState, renderFrame } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p25-"));
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

test("protocol version is 0.25 for P25", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("parseIdeSlash accepts save and still rejects unknown", () => {
  assert.deepEqual(parseIdeSlash("/ide save src/auth.js"), { cmd: "save", path: "src/auth.js" });
  assert.throws(() => parseIdeSlash("/ide save"), /save requires path/);
});

test("ide/command save writes the worktree and refuses path escape", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  const started = await client.threadStart();
  const saved = await client.ideCommand("save", {
    path: "src/auth.js",
    content: "export function login() { return true; }\n",
  });
  assert.equal(saved.ok, true, saved.message);
  assert.match(await readFile(path.join(started.agentRoot, "src/auth.js"), "utf8"), /return true/);
  assert.equal(await readFile(path.join(userRoot, "USER_WIP.md"), "utf8"), "do not touch me\n");
  const escaped = await client.ideCommand("save", { path: "../secret", content: "nope\n" });
  assert.equal(escaped.ok, false);
  assert.match(escaped.message, /escapes|denied|AgentWorkspace/i);
  await assert.rejects(client.ideCommand("save", { path: "src/auth.js" }), /save requires content/);
  const listed = await client.itemsList();
  const items = listed.items as Array<{ type?: string; payload?: { cmd?: string } }>;
  assert.ok(items.some((i) => i.type === "ide/command" && i.payload?.cmd === "save"));
  await client.shutdown();
});

test("workbench HTTP host injects window.harness and saves via RPC", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  const started = await client.threadStart();
  const bench = await client.ideWorkbench();
  assert.match(bench.html, /data-cmd="save"/);
  const host = await listenWorkbench({
    html: bench.html,
    onCommand: (p) => client.ideCommand(p.cmd, { text: p.text, path: p.path, content: p.content }),
  });
  try {
    const page = await fetch(host.url);
    assert.match(await page.text(), /window\.harness = window\.harness/);
    const posted = await fetch(new URL("/rpc/ide/command", host.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "save", path: "README.md", content: "# from host\n" }),
    });
    const result = (await posted.json()) as { ok: boolean; message: string };
    assert.equal(result.ok, true, result.message);
    assert.equal(await readFile(path.join(started.agentRoot, "README.md"), "utf8"), "# from host\n");
  } finally {
    await host.close();
    await client.shutdown();
  }
});

test("TUI paints ide/command from item/rewind", () => {
  const state = applyEvent(emptyTuiState({ threadId: "th_1" }), "item/rewind", {
    type: "ide/command",
    payload: { cmd: "save", message: "saved src/auth.js" },
  });
  assert.match(renderFrame(state), /save saved src\/auth\.js/);
});
