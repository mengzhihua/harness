import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatUserConfig, loadUserConfig, patchUserConfig, rememberAllow, saveUserConfig, setUserConfig } from "./user-config.ts";

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

test("patchUserConfig and setUserConfig write yolo and reject unknown keys", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-cfg-"));
  const patched = patchUserConfig({ model: "mock" }, "yolo", "on");
  assert.equal(patched.yolo, true);
  assert.equal(patchUserConfig(patched, "yolo", "off").yolo, false);
  assert.throws(() => patchUserConfig({}, "unknown", "x"), /unknown config key/);
  const saved = await setUserConfig(home, "mode", "plan");
  assert.equal(saved.mode, "plan");
  assert.equal((await loadUserConfig(home)).mode, "plan");
});
