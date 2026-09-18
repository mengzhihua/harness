import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPermissions, missingPermission, normalizePermissions } from "./permissions.ts";

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
