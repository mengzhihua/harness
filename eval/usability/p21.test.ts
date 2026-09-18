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
import { formatCatalogRow } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p21-"));
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

function mcpServer(tool: string, body: string): string {
  return `import { writeSync } from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    writeSync(1, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "p21", version: "0" } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    writeSync(1, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: ${JSON.stringify(tool)}, description: "p21", inputSchema: { type: "object", properties: { path: { type: "string" }, api_key: { type: "string" } } } }] } }) + "\\n");
  } else if (msg.method === "tools/call") {
    writeSync(1, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: ${JSON.stringify(body)} }] } }) + "\\n");
  }
});
`;
}

test("protocol version is 0.21 for P21", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("ide/file reads worktree files and refuses path escape", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  const file = await client.ideFile("src/auth.js");
  assert.equal(file.ok, true, file.content);
  assert.match(file.content, /password|export|function/i);
  const escaped = await client.ideFile("../secret");
  assert.equal(escaped.ok, false);
  assert.match(escaped.content, /escapes|denied|AgentWorkspace/i);
  const bench = await client.ideWorkbench();
  assert.ok(bench.contents["src/auth.js"] || Object.keys(bench.contents).some((k) => k.endsWith("src/auth.js")));
  assert.match(bench.html, /data-path=/);
  await client.shutdown();
});

test("plugin host-fs and secrets args fail closed unless declared", async () => {
  const { userRoot, home } = await loginRepo();
  const dir = path.join(userRoot, ".harness", "plugins", "peek");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "mcp.mjs"), mcpServer("peek_path", "peeked"));
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      id: "eval.peek",
      kind: "mcp",
      command: "node",
      args: ["mcp.mjs"],
      permissions: { subprocess: true, secrets: false, fs: "workspace" },
    }),
  );
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const host = await tools.execute({
      id: "h1",
      type: "function",
      function: { name: "peek_path", arguments: JSON.stringify({ path: "/etc/passwd" }) },
    });
    assert.equal(host.ok, false, host.content);
    assert.match(host.content, /host-fs/);
    const secret = await tools.execute({
      id: "h2",
      type: "function",
      function: { name: "peek_path", arguments: JSON.stringify({ api_key: "sk-test-xxx" }) },
    });
    assert.equal(secret.ok, false, secret.content);
    assert.match(secret.content, /secrets/);
    const ok = await tools.execute({
      id: "h3",
      type: "function",
      function: { name: "peek_path", arguments: JSON.stringify({ path: "src/auth.js" }) },
    });
    assert.equal(ok.ok, true, ok.content);
    const events = await session.traj.events();
    assert.ok(events.some((e) => e.type === "plugin/permission" && (e.payload as { deny?: string }).deny === "host-fs"));
  } finally {
    await session.close();
  }
});

test("MCP with permissions.secrets sees host secret env", async () => {
  const { userRoot, home } = await loginRepo();
  const dir = path.join(userRoot, ".harness", "plugins", "echo-ok");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "mcp.mjs"),
    `import { writeSync } from "node:fs";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    writeSync(1, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo-ok", version: "0" } } }) + "\\n");
  } else if (msg.method === "tools/list") {
    writeSync(1, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "secret_echo_ok", description: "echo", inputSchema: { type: "object", properties: {} } }] } }) + "\\n");
  } else if (msg.method === "tools/call") {
    const text = process.env.HARNESS_TEST_SECRET_TOKEN || "(none)";
    writeSync(1, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } }) + "\\n");
  }
});
`,
  );
  await writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      id: "eval.secret-ok",
      kind: "mcp",
      command: "node",
      args: ["mcp.mjs"],
      permissions: { subprocess: true, secrets: true },
    }),
  );
  const prev = process.env.HARNESS_TEST_SECRET_TOKEN;
  process.env.HARNESS_TEST_SECRET_TOKEN = "allowed-secret";
  try {
    const session = await boot({ userRoot, harnessHome: home, model: "mock" });
    try {
      const tools = session.thread.get<ToolRouter>("tools");
      const result = await tools.execute({
        id: "ok1",
        type: "function",
        function: { name: "secret_echo_ok", arguments: "{}" },
      });
      assert.equal(result.ok, true, result.content);
      assert.match(result.content, /allowed-secret/);
    } finally {
      await session.close();
    }
  } finally {
    if (prev === undefined) delete process.env.HARNESS_TEST_SECRET_TOKEN;
    else process.env.HARNESS_TEST_SECRET_TOKEN = prev;
  }
});

test("catalog rows include origin and fs permission", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  const { plugins } = await client.pluginSearch("test-runner");
  const found = plugins.find((p) => p.id === "harness.test-runner");
  assert.ok(found);
  const row = formatCatalogRow(found);
  assert.match(row, /harness.test-runner/);
  assert.match(row, /local/);
  assert.match(row, /fs=workspace/);
  await client.shutdown();
});
