import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { buildRelease } from "../../scripts/build-release.mjs";

const execFile = promisify(execFileCb);
const fixture = fileURLToPath(new URL("../fixtures/login", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

async function loginRepo() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "harness-p26-"));
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

test("protocol version is 0.26 for P26", () => {
  assert.match(PROTOCOL_VERSION, /^0\.\d+\.\d+$/);
});

test("dev CLI prints harness --version", async () => {
  const { stdout } = await execFile(
    process.execPath,
    [path.join(repoRoot, "packages/cli/bin/harness.mjs"), "--version"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(stdout.trim(), `harness ${PROTOCOL_VERSION}`);
});

test("release tarball installs and runs a mock turn", async () => {
  const { userRoot, home, tmp } = await loginRepo();
  const built = await buildRelease(path.join(tmp, "release"));
  assert.equal(built.version, PROTOCOL_VERSION);
  assert.match(built.tarball, /harness-cli-0\.\d+\.\d+\.tgz$/);
  const prefix = path.join(tmp, "npm");
  await mkdir(prefix, { recursive: true });
  await execFile("npm", ["install", "--prefix", prefix, built.tarball], { encoding: "utf8" });
  const bin = path.join(prefix, "node_modules", ".bin", "harness");
  const version = await execFile(bin, ["--version"], { encoding: "utf8" });
  assert.equal(version.stdout.trim(), `harness ${PROTOCOL_VERSION}`);
  const help = await execFile(bin, ["--help"], { encoding: "utf8" });
  assert.match(help.stdout, /harness exec/);
  assert.doesNotMatch(help.stdout, /unknown flag/);
  await execFile(
    bin,
    [
      "exec",
      "--model",
      "mock",
      "--cwd",
      userRoot,
      "--home",
      home,
      "--prompt",
      "把失败的登录测试修了",
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(await readFile(path.join(userRoot, "USER_WIP.md"), "utf8"), "do not touch me\n");
  const listed = await execFile(bin, ["plugin", "search", "test-runner"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.match(listed.stdout, /harness\.test-runner/);
});
