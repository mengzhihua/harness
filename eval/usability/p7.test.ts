import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { HarnessClient } from "@harness/sdk";
import { AppServer } from "@harness/server";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { assemble, boot, compactMessages, modelVisibleSubsetOfTraj, type Llm, type ToolRouter } from "@harness/core";
import { renderFrame, emptyTuiState } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p7-"));
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

test("protocol version is 0.7 for P7", () => {
  assert.equal(PROTOCOL_VERSION, "0.7.0");
});

test("TUI first viewport is stream + status + input", () => {
  const frame = renderFrame(emptyTuiState({ threadId: "th_p7", plugins: 2, items: ["step 1"] }));
  assert.match(frame, /harness/);
  assert.match(frame, /th_p7/);
  assert.match(frame, /step 1/);
  assert.match(frame, /> /);
});

test("approval reverse RPC can allow_session an ask-once command", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({
    userRoot,
    harnessHome: home,
    model: "mock",
    approver: async () => "allow_session",
  });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "c1",
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: "curl https://example.com" }) },
    });
    assert.equal(result.ok, true, result.content);
    assert.match(result.content, /exit /);
  } finally {
    await session.close();
  }
});

test("AppServer approval/respond round-trips through the SDK", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  await assert.rejects(client.approvalRespond("ap_missing", "allow"), /unknown approval/);
  await client.shutdown();
});

test("plugin disable writes plugin/change and drops the package from the live list", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  const before = await client.pluginList();
  assert.ok(before.packages.some((p) => p.id === "login.verify" && p.enabled !== false));
  const disabled = await client.pluginDisable("login.verify");
  assert.equal(disabled.enabled, false);
  const shown = await client.trajShow();
  assert.ok((shown.events as Array<{ type: string }>).some((e) => e.type === "plugin/change"));
  const after = await client.pluginList();
  const row = after.packages.find((p) => p.id === "login.verify");
  assert.equal(row?.enabled, false);
  await client.shutdown();
});

test("command plugin runs on the AgentWorkspace", async () => {
  const { userRoot, home } = await loginRepo();
  const src = await mkdtemp(path.join(os.tmpdir(), "harness-cmd-"));
  await writeFile(
    path.join(src, "plugin.json"),
    JSON.stringify({ id: "login.testcmd", kind: "command", command: "node", args: ["--version"] }),
  );
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.pluginAdd(src);
  await client.threadStart();
  const result = await client.pluginCommand("login.testcmd");
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /v?\d+/);
  await client.shutdown();
});

test("verify nudge fires when files changed with no checks", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  let sawNudge = false;
  const llm: Llm = {
    async chat(req) {
      const last = req.messages.at(-1);
      const blob = req.messages.map((m) => `${m.role}:${m.content}`).join("\n");
      if (last?.role === "user" && String(last.content).includes("[verify]")) {
        sawNudge = true;
        return {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "b1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "node --test" }) } },
          ],
        };
      }
      if (blob.includes("updated src/auth.js") || blob.includes("1 replacement")) {
        return { role: "assistant", content: "edited without checks" };
      }
      return {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "e1",
            type: "function",
            function: {
              name: "str_replace",
              arguments: JSON.stringify({ path: "src/auth.js", old_string: "passw0rd", new_string: "password" }),
            },
          },
        ],
      };
    },
  };
  session.thread.provide("llm", llm);
  try {
    const turn = await session.runTurn({ prompt: "edit auth" });
    assert.equal(sawNudge, true);
    assert.ok((await session.traj.events()).some((e) => e.type === "verify_nudge"));
    assert.ok(turn.done.checks.length > 0);
  } finally {
    await session.close();
  }
});

test("live assemble stays a subset of the trajectory", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  const llm: Llm = {
    async chat() {
      return { role: "assistant", content: "hello" };
    },
  };
  session.thread.provide("llm", llm);
  try {
    await session.runTurn({ prompt: "say hello" });
    await session.traj.append("user", "turn/start", { prompt: "follow up" });
    const msgs = await assemble(session.thread, "follow up");
    assert.equal(modelVisibleSubsetOfTraj(msgs, await session.traj.events()), true);
    assert.ok(compactMessages(msgs).length >= 1);
  } finally {
    await session.close();
  }
});

test("web_search fails closed without HARNESS_NET", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({
    userRoot,
    harnessHome: home,
    model: "mock",
    yolo: true,
  });
  const prev = process.env.HARNESS_NET;
  delete process.env.HARNESS_NET;
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "w1",
      type: "function",
      function: { name: "web_search", arguments: JSON.stringify({ query: "harness" }) },
    });
    assert.equal(result.ok, false);
    assert.match(result.content, /HARNESS_NET/);
  } finally {
    if (prev !== undefined) process.env.HARNESS_NET = prev;
    await session.close();
  }
});
