import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatUserConfig, loadUserConfig, rememberAllow, saveUserConfig } from "./user-config.ts";

test("loadUserConfig parses allow signatures from a comma list", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-cfg-"));
  await saveUserConfig(home, { model: "mock", mode: "plan", allow: ["bash:net", "web:net"] });
  const loaded = await loadUserConfig(home);
  assert.equal(loaded.model, "mock");
  assert.equal(loaded.mode, "plan");
  assert.deepEqual(loaded.allow, ["bash:net", "web:net"]);
});

test("rememberAllow appends a signature and keeps other keys", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-cfg-"));
  await mkdir(home, { recursive: true });
  await saveUserConfig(home, { model: "mock", yolo: false });
  await rememberAllow(home, "bash:net");
  await rememberAllow(home, "bash:net");
  const loaded = await loadUserConfig(home);
  assert.equal(loaded.model, "mock");
  assert.equal(loaded.yolo, false);
  assert.deepEqual(loaded.allow, ["bash:net"]);
  assert.match(formatUserConfig(loaded), /allow: bash:net/);
});
