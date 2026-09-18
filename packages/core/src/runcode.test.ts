import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalFs, LocalSubprocess } from "./runtime-local.ts";
import { runSandboxedCode } from "./runcode.ts";

test("run_code executes javascript in the worktree sandbox", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-runcode-"));
  const out = await runSandboxedCode({
    language: "javascript",
    code: "console.log(40 + 2)",
    fs: new LocalFs(root),
    subprocess: new LocalSubprocess(root, { network: false }),
  });
  assert.match(out, /exit 0/);
  assert.match(out, /42/);
  assert.match(out, /language: javascript/);
});

test("run_code rejects unknown languages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-runcode-bad-"));
  await assert.rejects(
    () =>
      runSandboxedCode({
        language: "ruby",
        code: "p 1",
        fs: new LocalFs(root),
        subprocess: new LocalSubprocess(root, { network: false }),
      }),
    /unsupported run_code language/,
  );
});
