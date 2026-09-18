import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalSubprocess } from "./runtime-local.ts";
import { nextShellCwd, resolveShellCwd } from "./cwd.ts";

test("cd persists for the next bash without cwd", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-cwd-"));
  await mkdir(path.join(root, "pkg"));
  await writeFile(path.join(root, "pkg", "marker.txt"), "ok\n");
  const sub = new LocalSubprocess(root, { network: false });
  const cd = await sub.exec("cd pkg");
  assert.equal(cd.exitCode, 0, cd.stderr);
  const listed = await sub.exec("ls");
  assert.equal(listed.exitCode, 0, listed.stderr);
  assert.match(listed.stdout, /marker\.txt/);
  assert.equal(nextShellCwd("cd pkg", "", 0), "pkg");
  assert.equal(resolveShellCwd(root, undefined, "pkg").rel, "pkg");
});
