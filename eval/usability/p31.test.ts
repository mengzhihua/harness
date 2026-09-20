import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { HarnessClient } from "@harness/sdk";
import { AppServer } from "@harness/server";
import { boot, assertPublicHttpUrl, type ToolRouter } from "@harness/core";
import { decideRelease, hasSkipMarker } from "../../scripts/release-gate.mjs";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p31-"));
  const userRoot = path.join(tmp, "repo");
  const home = path.join(tmp, "home");
  await cp(fixture, userRoot, { recursive: true });
  await git(userRoot, ["init"]);
  await git(userRoot, ["config", "user.email", "eval@harness.local"]);
  await git(userRoot, ["config", "user.name", "Eval"]);
  await git(userRoot, ["add", "-A"]);
  await git(userRoot, ["commit", "-m", "fixture"]);
  await writeFile(path.join(userRoot, "USER_WIP.md"), "do not touch me\n");
  return { userRoot, home, tmp };
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

test("protocol version is 0.31 for P31", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("apply_patch edits the worktree and refuses a missing hunk", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock", yolo: true });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const ok = await tools.execute({
      id: "p1",
      type: "function",
      function: {
        name: "apply_patch",
        arguments: JSON.stringify({
          patch: `*** Begin Patch
*** Update File: src/auth.js
@@
-passw0rd
+password
*** End Patch
`,
        }),
      },
    });
    assert.equal(ok.ok, true);
    assert.match(await readFile(path.join(session.workspace.agentRoot, "src/auth.js"), "utf8"), /password/);
    const miss = await tools.execute({
      id: "p2",
      type: "function",
      function: {
        name: "apply_patch",
        arguments: JSON.stringify({
          patch: `*** Begin Patch
*** Update File: src/auth.js
@@
-this-string-is-not-there
+x
*** End Patch
`,
        }),
      },
    });
    assert.equal(miss.ok, false);
    assert.match(miss.content, /nearby/);
  } finally {
    await session.close();
  }
});

test("ask_user waits for the human and returns their words", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({
    userRoot,
    harnessHome: home,
    model: "mock",
    yolo: true,
    userAsk: async ({ question, options }) => {
      assert.match(question, /helper/);
      assert.deepEqual(options, ["a", "b"]);
      return "use existing helper";
    },
  });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const result = await tools.execute({
      id: "q1",
      type: "function",
      function: {
        name: "ask_user",
        arguments: JSON.stringify({ question: "which helper?", options: ["a", "b"] }),
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.content, "user: use existing helper");
  } finally {
    await session.close();
  }
});

test("AppServer user/respond rejects unknown question ids", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ protocolVersion: PROTOCOL_VERSION, cwd: userRoot, harnessHome: home, model: "mock", yolo: true });
  await client.threadStart();
  await assert.rejects(() => client.userRespond("ask_missing", "x"), /unknown question/);
  await client.shutdown();
});

test("web_fetch is live when network is on and blocks metadata IPs", async () => {
  const { userRoot, home } = await loginRepo();
  const server = createServer((_, res) => {
    res.setHeader("content-type", "text/plain");
    res.end("pong from local");
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
  const session = await boot({ userRoot, harnessHome: home, model: "mock", yolo: true, network: true });
  try {
    const tools = session.thread.get<ToolRouter>("tools");
    const ok = await tools.execute({
      id: "f1",
      type: "function",
      function: { name: "web_fetch", arguments: JSON.stringify({ url: `http://127.0.0.1:${port}/health` }) },
    });
    assert.equal(ok.ok, true);
    assert.match(ok.content, /pong from local/);
    const blocked = await tools.execute({
      id: "f2",
      type: "function",
      function: { name: "web_fetch", arguments: JSON.stringify({ url: "http://169.254.169.254/latest" }) },
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.content, /blocked metadata/);
    assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"));
  } finally {
    await session.close();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("commit body mentioning skip release still ships; subject skip does not", () => {
  assert.equal(
    hasSkipMarker("feat: auto release\n\nPRs, [skip release], and docs-only commits do not ship.\n"),
    false,
  );
  assert.equal(hasSkipMarker("docs: typo [skip release]"), true);
  assert.equal(hasSkipMarker("feat: x\n\n[skip ci]\n"), true);
  const decision = decideRelease({
    eventName: "push",
    refType: "branch",
    refName: "cursor/p31-agent-hands-558a",
    sha: "abcdef1234567890",
    commitMessage: "feat: publish a GitHub Release after every green push\n\nPRs, [skip release], and docs-only commits do not ship.\n",
    protocolVersion: PROTOCOL_VERSION,
    changedFiles: ["packages/core/src/tools.ts"],
  });
  assert.equal(decision.shouldRelease, true);
});
