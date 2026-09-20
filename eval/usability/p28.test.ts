import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { listenAppHttp } from "@harness/server";
import { buildNative } from "../../scripts/build-native.mjs";
import { buildSpringBoot } from "../../scripts/build-spring-boot.mjs";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p28-"));
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

test("protocol version is 0.28 for P28", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("serve --http health and runtime/doctor", async () => {
  const http = await listenAppHttp({ host: "127.0.0.1", port: 0 });
  try {
    const health = await fetch(new URL("/health", http.url));
    const body = (await health.json()) as { ok: boolean; protocol: string };
    assert.equal(body.ok, true);
    assert.equal(body.protocol, PROTOCOL_VERSION);
    const rpc = await fetch(new URL("/rpc", http.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "runtime/doctor", params: {} }),
    });
    const result = (await rpc.json()) as { result?: { ok: boolean } };
    assert.equal(result.result?.ok, true);
  } finally {
    await http.close();
  }
});

test("linux native pack runs without node on PATH", async () => {
  const { userRoot, home, tmp } = await loginRepo();
  const built = await buildNative({ ids: ["linux-x64"], outDir: path.join(tmp, "native") });
  const linux = built.artifacts.find((a) => a.id === "linux-x64");
  assert.ok(linux, "linux-x64 artifact");
  assert.ok(linux.archive.endsWith(`harness-linux-x64-${PROTOCOL_VERSION}.tar.gz`));
  const bin = linux.bin;
  const isolated = { ...process.env, PATH: "/usr/bin:/bin", OPENAI_API_KEY: "" };
  const version = await execFile(bin, ["--version"], { encoding: "utf8", env: isolated });
  assert.equal(version.stdout.trim(), `harness ${PROTOCOL_VERSION}`);
  const doctor = await execFile(bin, ["doctor", "--json", "--cwd", userRoot, "--home", home], {
    encoding: "utf8",
    env: isolated,
  });
  const report = JSON.parse(doctor.stdout) as { ok: boolean; root?: string };
  assert.equal(report.ok, true);
  assert.equal(report.root, linux.dir);
  const nodeDir = path.dirname(process.execPath);
  await execFile(
    bin,
    ["exec", "--model", "mock", "--cwd", userRoot, "--home", home, "--prompt", "把失败的登录测试修了"],
    { encoding: "utf8", env: { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ""}` }, timeout: 60_000 },
  );
  assert.equal(await readFile(path.join(userRoot, "USER_WIP.md"), "utf8"), "do not touch me\n");
});

test("windows zip is a PE exe next to profiles", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p28-win-"));
  const built = await buildNative({ ids: ["win-x64"], outDir: path.join(tmp, "native") });
  const win = built.artifacts.find((a) => a.id === "win-x64");
  assert.ok(win);
  assert.match(win.archive, /\.zip$/);
  const exe = readFileSync(win.bin);
  assert.equal(exe[0], 0x4d);
  assert.equal(exe[1], 0x5a);
  assert.equal(existsSync(path.join(win.dir, "profiles", "standard.yml")), true);
});

test("spring boot jar serves /health and /rpc", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p28-jar-"));
  const built = await buildSpringBoot({ outDir: tmp });
  assert.ok(built.jar.endsWith(`harness-server-${PROTOCOL_VERSION}.jar`));
  const port = await freePort();
  const child = spawn("java", ["-jar", built.jar, `--server.port=${port}`, "--server.address=127.0.0.1"], {
    encoding: "utf8",
  });
  const url = `http://127.0.0.1:${port}/`;
  try {
    await waitHttp(new URL("health", url).href, 40_000);
    const health = await fetch(new URL("health", url));
    const body = (await health.json()) as { ok: boolean; status: string };
    assert.equal(body.status, "UP");
    const rpc = await fetch(new URL("rpc", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "runtime/doctor", params: {} }),
    });
    const result = (await rpc.json()) as { result?: { ok: boolean; protocol: string } };
    assert.equal(result.result?.ok, true);
    assert.equal(result.result?.protocol, PROTOCOL_VERSION);
  } finally {
    child.kill("SIGTERM");
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitHttp(url: string, ms: number): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = String(res.status);
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`server did not start: ${last}`);
}
