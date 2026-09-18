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
import { boot, loadUserConfig, type ToolRouter } from "@harness/core";
import { applyEvent, emptyTuiState, renderFrame } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p13-"));
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

function connect() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  new AppServer(toServer, toClient);
  return new HarnessClient(toClient, toServer);
}

test("protocol version is 0.13 for P13", () => {
  assert.equal(PROTOCOL_VERSION, "0.13.0");
});

test("config.yml allow list seeds policy so a new thread does not re-ask", async () => {
  const { userRoot, home } = await loginRepo();
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "config.yml"), "model: mock\nallow: bash:net\n");
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "c1",
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "curl https://example.com" }) },
    });
    assert.equal(result.ok, true, result.content);
  } finally {
    await session.close();
  }
});

test("allow_always writes the signature into config.yml", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({
    userRoot,
    harnessHome: home,
    model: "mock",
    approver: async () => "allow_always",
  });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "c1",
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "curl https://example.com" }) },
    });
    assert.equal(result.ok, true, result.content);
    const loaded = await loadUserConfig(home);
    assert.ok(loaded.allow?.includes("bash:net"), String(loaded.allow));
    const shown = await session.traj.events();
    assert.ok(shown.some((e) => e.type === "allow_always"));
  } finally {
    await session.close();
  }
});

test("turn emits llm/usage with token counts", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  const usage: Array<{ prompt_tokens?: number }> = [];
  client.onEvent((method, params) => {
    if (method === "llm/usage") usage.push(params as { prompt_tokens?: number });
  });
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock", yolo: true });
  await client.threadStart();
  await client.turnStart("把失败的登录测试修了");
  assert.ok(usage.length > 0, "expected llm/usage notifications");
  assert.ok((usage[0]?.prompt_tokens ?? 0) > 0);
  const shown = await client.trajShow();
  assert.ok((shown.events as Array<{ type: string }>).some((e) => e.type === "llm/usage"));
  await client.shutdown();
});

test("approval card includes always; status shows tok/cache", () => {
  const state = applyEvent(emptyTuiState({ threadId: "th_1" }), "llm/usage", {
    prompt_tokens: 8,
    completion_tokens: 2,
    cached_tokens: 1,
  });
  const withAsk = applyEvent(state, "approval/request", {
    id: "ap_a",
    name: "bash",
    reason: "network / install / push",
    command: "curl https://example",
    cwd: "/tmp/wt",
  });
  const frame = renderFrame(withAsk);
  assert.match(frame, /\[a\] always/);
  assert.match(frame, /tok=10 cache=1/);
});
