import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultPermissions,
  inferPluginNeed,
  inferPluginOrigin,
  isSecretEnvKey,
  missingPermission,
  normalizePermissions,
  pluginEnv,
} from "./permissions.ts";

test("plugin permissions default to workspace-only and no network", () => {
  assert.deepEqual(defaultPermissions("skill"), {
    network: false,
    secrets: false,
    subprocess: false,
    fs: "workspace",
  });
  assert.equal(defaultPermissions("mcp").subprocess, true);
  const declared = normalizePermissions("mcp", { network: true });
  assert.equal(declared.network, true);
  assert.equal(declared.subprocess, true);
  assert.equal(missingPermission(declared, "network"), undefined);
  assert.equal(missingPermission(defaultPermissions("skill"), "network"), "network");
  assert.equal(missingPermission(defaultPermissions("skill"), "subprocess"), "subprocess");
});

test("pluginEnv drops secret keys unless permissions.secrets is true", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/tmp",
    OPENAI_API_KEY: "sk-test-not-for-plugins",
    GITHUB_TOKEN: "ghp_secret",
    HARNESS_TEST_SECRET_TOKEN: "leak-me",
  };
  const locked = pluginEnv({ network: false, secrets: false, subprocess: true, fs: "workspace" }, source);
  assert.equal(locked.PATH, "/usr/bin");
  assert.equal(locked.HOME, "/tmp");
  assert.equal(locked.OPENAI_API_KEY, undefined);
  assert.equal(locked.GITHUB_TOKEN, undefined);
  assert.equal(locked.HARNESS_TEST_SECRET_TOKEN, undefined);
  const open = pluginEnv({ network: false, secrets: true, subprocess: true, fs: "workspace" }, source);
  assert.equal(open.OPENAI_API_KEY, "sk-test-not-for-plugins");
  assert.equal(isSecretEnvKey("OPENAI_API_KEY"), true);
  assert.equal(isSecretEnvKey("PATH"), false);
});

test("inferPluginOrigin prefers declared catalog origin over harness.* heuristic", () => {
  assert.equal(inferPluginOrigin("harness.agent-loop"), "official");
  assert.equal(inferPluginOrigin("login.verify"), "project");
  assert.equal(inferPluginOrigin("harness.remote-sample", "remote"), "remote");
  assert.equal(inferPluginOrigin("login.verify", "local"), "local");
});

test("inferPluginNeed maps secrets, network, and host-fs escapes", () => {
  assert.equal(inferPluginNeed("peek", { api_key: "sk-test-xxx" }), "secrets");
  assert.equal(inferPluginNeed("web_fetch", { url: "https://ex" }), "network");
  assert.equal(inferPluginNeed("peek", { path: "/etc/passwd" }), "host-fs");
  assert.equal(inferPluginNeed("peek", { path: "../secret" }), "host-fs");
  assert.equal(inferPluginNeed("peek", { path: "src/auth.js" }), undefined);
});
