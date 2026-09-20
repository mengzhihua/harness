import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { packageRoot } from "./paths.ts";
import { repoRoot } from "./boot.ts";

test("packageRoot finds profiles from the source tree", () => {
  assert.equal(packageRoot(), repoRoot);
  assert.equal(existsSync(path.join(packageRoot(), "profiles", "standard.yml")), true);
});

test("packageRoot walks up from a bundled dist file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-pack-root-"));
  mkdirSync(path.join(dir, "profiles"), { recursive: true });
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  writeFileSync(path.join(dir, "profiles", "standard.yml"), "packages: []\n");
  const bundled = path.join(dir, "dist", "harness.mjs");
  writeFileSync(bundled, "// bundle\n");
  assert.equal(packageRoot(bundled), dir);
});
