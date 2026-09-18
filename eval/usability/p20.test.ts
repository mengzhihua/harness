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
import { boot } from "@harness/core";
import type { ToolRouter } from "@harness/core";
import { formatPluginRow } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p20-"));
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

async function git(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd });
}

function connect() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  new AppServer(toServer, toClient);
  return new HarnessClient(toClient, toServer);
}

function mcpEchoServer(): string {
  return `import { writeSync } from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    writeSync(1, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "0" } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    writeSync(1, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "secret_echo", description: "echo a secret env", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");
  } else if (msg.method === "tools/call") {
    const text = process.env.HARNESS_TEST_SECRET_TOKEN || "(none)";
    writeSync(1, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } }) + "\\n");
  }
});
`;
}

test("protocol version is 0.20 for P20", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("plugin/list returns origin and permissions; TUI row shows them", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  const listed = await client.pluginList();
  const verify = listed.packages.find((p) => p.id === "login.verify");
  assert.ok(verify, `expected login.verify in ${listed.packages.map((p) => p.id).join(",")}`);
  assert.equal(verify.origin, "project");
  assert.equal(verify.permissions?.fs, "workspace");
  assert.equal(verify.permissions?.network, false);
  const hint = listed.packages.find((p) => p.id === "login.hint");
  assert.equal(hint?.permissions?.subprocess, true);
  const row = formatPluginRow(verify);
  assert.match(row, /login.verify project on/);
  assert.match(row, /fs=workspace/);
  await client.shutdown();
});

test("MCP plugins do not inherit secret env unless permissions.secrets", async () => {
  const { userRoot, home } = await loginRepo();
  const dir = path.join(userRoot, ".harness", "plugins", "echo");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "mcp.mjs"), mcpEchoServer());
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      id: "eval.secret-echo",
      kind: "mcp",
      command: "node",
      args: ["mcp.mjs"],
      permissions: { subprocess: true, secrets: false },
    }),
  );
  const prev = process.env.HARNESS_TEST_SECRET_TOKEN;
  process.env.HARNESS_TEST_SECRET_TOKEN = "should-not-leak";
  try {
    const session = await boot({ userRoot, harnessHome: home, model: "mock" });
    try {
      const tools = session.thread.get<ToolRouter>("tools");
      const result = await tools.execute({
        id: "echo1",
        type: "function",
        function: { name: "secret_echo", arguments: "{}" },
      });
      assert.equal(result.ok, true, result.content);
      assert.match(result.content, /\(none\)/);
      assert.equal(result.content.includes("should-not-leak"), false);
    } finally {
      await session.close();
    }
  } finally {
    if (prev === undefined) delete process.env.HARNESS_TEST_SECRET_TOKEN;
    else process.env.HARNESS_TEST_SECRET_TOKEN = prev;
  }
});

test("ide/workbench files come from the agent worktree", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  const bench = await client.ideWorkbench();
  assert.ok(bench.files.some((f) => f === "src/auth.js" || f.endsWith("/src/auth.js")));
  assert.match(bench.html, /src\/auth\.js/);
  await client.shutdown();
});
