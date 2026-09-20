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
import { formatDoctor, listenWorkbench, runDoctor } from "@harness/core";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const harnessBin = path.join(repoRoot, "packages/cli/bin/harness.mjs");

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p27-"));
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
  return { userRoot, home, tmp };
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

async function collectSse(url: string, afterOpen: () => void, until: (buf: string) => boolean, ms = 4000): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: "text/event-stream" } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    if (!res.body) throw new Error("no sse body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let opened = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (!opened && buf.includes(":")) {
        opened = true;
        afterOpen();
      }
      if (until(buf)) {
        await reader.cancel().catch(() => undefined);
        return buf;
      }
    }
    throw new Error(`sse closed before match: ${buf}`);
  } finally {
    clearTimeout(timer);
  }
}

test("protocol version is 0.27 for P27", () => {
  assert.equal(PROTOCOL_VERSION, "0.27.0");
});

test("harness doctor reports a healthy source install", async () => {
  const { userRoot, home } = await loginRepo();
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { stdout } = await execFile(process.execPath, [harnessBin, "doctor", "--cwd", userRoot, "--home", home], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, OPENAI_API_KEY: "" },
    });
    assert.match(stdout, /harness 0\.27\.0 doctor/);
    assert.match(stdout, /ok\s+protocol/);
    assert.match(stdout, /ok\s+package_root/);
    assert.match(stdout, /ok\s+profiles/);
    assert.match(stdout, /ok\s+catalog/);
    assert.match(stdout, /ok\s+cwd_git/);
    assert.match(stdout, /warn\s+api_key/);
    assert.doesNotMatch(stdout, /sk-/);
    const json = await execFile(
      process.execPath,
      [harnessBin, "doctor", "--json", "--cwd", userRoot, "--home", home],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "" } },
    );
    const report = JSON.parse(json.stdout) as {
      ok: boolean;
      protocol: string;
      checks: Array<{ id: string; level: string; message: string }>;
    };
    assert.equal(report.ok, true);
    assert.equal(report.protocol, PROTOCOL_VERSION);
    assert.equal(report.checks.find((c) => c.id === "api_key")?.level, "warn");
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test("runtime/doctor RPC matches runDoctor and hides API keys", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-rpc-secret";
  try {
    await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
    const report = await client.runtimeDoctor();
    assert.equal(report.ok, true);
    assert.equal(report.protocol, PROTOCOL_VERSION);
    assert.equal(report.checks.find((c) => c.id === "api_key")?.message, "OPENAI_API_KEY set");
    assert.doesNotMatch(JSON.stringify(report), /sk-rpc-secret/);
    assert.doesNotMatch(formatDoctor(report), /sk-rpc-secret/);
    const direct = await runDoctor({ cwd: userRoot, home });
    assert.equal(direct.ok, report.ok);
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
    await client.shutdown();
  }
});

test("workbench host SSE paints live events and doctor HTTP", async () => {
  const { userRoot, home } = await loginRepo();
  const client = connect();
  await client.initialize({ cwd: userRoot, harnessHome: home, model: "mock" });
  await client.threadStart();
  const bench = await client.ideWorkbench();
  assert.match(bench.html, /data-cmd="save"/);
  const host = await listenWorkbench({
    html: bench.html,
    onDoctor: () => client.runtimeDoctor(),
    onCommand: (p) => client.ideCommand(p.cmd, { text: p.text, path: p.path, content: p.content }),
  });
  try {
    const page = await fetch(host.url);
    const html = await page.text();
    assert.match(html, /window\.harness = window\.harness/);
    assert.match(html, /EventSource\("\/events"\)/);
    const stream = await collectSse(
      new URL("/events", host.url).href,
      () => host.push({ method: "item/delta", params: { text: "workbench live" } }),
      (buf) => buf.includes("event: item/delta") && buf.includes("workbench live"),
    );
    assert.match(stream, /workbench live/);
    const doctor = await fetch(new URL("/rpc/runtime/doctor", host.url));
    const body = (await doctor.json()) as { ok: boolean; protocol: string };
    assert.equal(doctor.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.protocol, PROTOCOL_VERSION);
    const posted = await fetch(new URL("/rpc/ide/command", host.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "save", path: "README.md", content: "# from live host\n" }),
    });
    const result = (await posted.json()) as { ok: boolean; message: string };
    assert.equal(result.ok, true, result.message);
  } finally {
    await host.close();
    await client.shutdown();
  }
});
