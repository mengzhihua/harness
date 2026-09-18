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
import { boot, type Llm } from "@harness/core";
import { applyEvent, emptyTuiState } from "@harness/tui";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p9-"));
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

test("protocol version is 0.9 for P9", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("turn/interrupt aborts in-flight inference and writes interrupted Done Report", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({
    userRoot,
    harnessHome: home,
    model: "mock",
  });
  const llm: Llm = {
    async chat(_req, signal) {
      await new Promise<void>((_resolve, reject) => {
        const err = Object.assign(new Error("aborted"), { name: "AbortError" });
        if (signal?.aborted) {
          reject(err);
          return;
        }
        signal?.addEventListener("abort", () => reject(err), { once: true });
      });
      return { role: "assistant", content: "should not finish" };
    },
  };
  session.thread.provide("llm", llm);
  const ac = new AbortController();
  try {
    const pending = session.runTurn({ prompt: "hang", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 40));
    ac.abort();
    const turn = await pending;
    assert.equal(turn.done.interrupted, true);
    assert.equal(turn.done.apply_ready, false);
    assert.match(turn.done.message, /interrupted/);
    const events = await session.traj.events();
    assert.ok(events.some((e) => e.type === "turn/interrupted"));
  } finally {
    await session.close();
  }
});

test("SDK turnInterrupt stops a running App Server turn", async () => {
  const { userRoot, home } = await loginRepo();
  const dir = path.join(userRoot, ".harness", "plugins", "hang");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify({ id: "eval.hang", kind: "adapter", entry: "adapter.mjs" }));
  await writeFile(
    path.join(dir, "adapter.mjs"),
    "export function createLlm() { return { async chat(_req, signal) { await new Promise((_res, rej) => { const err = Object.assign(new Error('aborted'), { name: 'AbortError' }); if (signal?.aborted) { rej(err); return; } signal?.addEventListener('abort', () => rej(err), { once: true }); }); } }; }\n",
  );
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock", yolo: true });
  await client.threadStart();
  const started = Date.now();
  const pending = client.turnStart("hang please");
  await new Promise((r) => setTimeout(r, 80));
  await client.turnInterrupt();
  const done = (await pending) as { interrupted?: boolean; message?: string };
  assert.ok(Date.now() - started < 8_000);
  assert.equal(done.interrupted, true);
  assert.match(String(done.message), /interrupted/);
  await client.shutdown();
});

test("readonly tools in a mixed step run in parallel", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  const lines: string[] = [];
  const llm: Llm = {
    async chat(req) {
      const used = req.messages.some((m) => m.role === "tool");
      if (!used) {
        return {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "g1", type: "function", function: { name: "grep", arguments: JSON.stringify({ pattern: "passw0rd" }) } },
            { id: "r1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/auth.js" }) } },
            {
              id: "w1",
              type: "function",
              function: {
                name: "str_replace",
                arguments: JSON.stringify({ path: "src/auth.js", old_string: "passw0rd", new_string: "password" }),
              },
            },
          ],
        };
      }
      return { role: "assistant", content: "edited" };
    },
  };
  session.thread.provide("llm", llm);
  try {
    const turn = await session.runTurn({ prompt: "fix", onEvent: (line) => lines.push(line) });
    assert.ok(lines.some((l) => /parallel grep,read_file/.test(l)));
    assert.match(turn.done.message, /edited/);
  } finally {
    await session.close();
  }
});

test("failed checks nudge instead of ending the turn (then honor a blocker)", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  const llm: Llm = {
    async chat(req) {
      const last = req.messages.at(-1);
      if (String(last?.content ?? "").includes("[check]")) {
        return { role: "assistant", content: "blocked: cannot make the command pass" };
      }
      const used = req.messages.some((m) => m.role === "tool");
      if (!used) {
        return {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "b1",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "node -e \"process.exit(2)\"" }) },
            },
          ],
        };
      }
      return { role: "assistant", content: "all good" };
    },
  };
  session.thread.provide("llm", llm);
  try {
    const turn = await session.runTurn({ prompt: "run checks" });
    const events = await session.traj.events();
    assert.ok(events.some((e) => e.type === "check_nudge"));
    assert.match(turn.done.message, /blocked/);
    assert.equal(turn.done.apply_ready, false);
    assert.ok(turn.done.residual_risks.some((r) => /still failing/i.test(r)));
  } finally {
    await session.close();
  }
});

test("large bash output is an artifact pointer in the check", async () => {
  const { userRoot, home } = await loginRepo();
  const session = await boot({ userRoot, harnessHome: home, model: "mock" });
  const llm: Llm = {
    async chat(req) {
      const used = req.messages.some((m) => m.role === "tool");
      if (!used) {
        return {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "b1",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: "node -e \"console.log('x'.repeat(9000))\"" }),
              },
            },
          ],
        };
      }
      return { role: "assistant", content: "logged" };
    },
  };
  session.thread.provide("llm", llm);
  try {
    const turn = await session.runTurn({ prompt: "print a lot" });
    const check = turn.done.checks[0];
    assert.ok(check?.summary_path);
    assert.match(check.summary, /full log:/);
    const events = await session.traj.events();
    const tool = events.find((e) => e.type === "tool_result");
    assert.match(String((tool?.payload as { content?: string }).content), /full log:/);
  } finally {
    await session.close();
  }
});

test("TUI /stop maps to interrupted status", () => {
  const state = applyEvent(emptyTuiState({ status: "running" }), "turn/interrupted", { message: "interrupted" });
  assert.equal(state.status, "interrupted");
});
