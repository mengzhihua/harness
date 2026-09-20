import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyPatchOps, parsePatch } from "./patch.ts";
import { LocalFs } from "./runtime-local.ts";

test("parsePatch reads Codex update/add/delete ops", () => {
  const ops = parsePatch(`*** Begin Patch
*** Update File: src/auth.js
@@
 return x
-passw0rd
+password
*** Add File: notes.txt
+hello
*** Delete File: old.md
*** End Patch
`);
  assert.equal(ops.length, 3);
  assert.equal(ops[0]?.kind, "update");
  assert.equal(ops[1]?.kind, "add");
  assert.equal(ops[2]?.kind, "delete");
});

test("applyPatchOps updates a file and returns neighborhood on miss", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-patch-"));
  const fs = new LocalFs(dir);
  await writeFile(path.join(dir, "a.js"), "const x = 1;\nconst y = 2;\n");
  await applyPatchOps(
    fs,
    parsePatch(`*** Begin Patch
*** Update File: a.js
@@
 const x = 1;
-const y = 2;
+const y = 3;
*** End Patch
`),
  );
  assert.equal(await fs.readRaw("a.js"), "const x = 1;\nconst y = 3;\n");
  await assert.rejects(
    () =>
      applyPatchOps(
        fs,
        parsePatch(`*** Begin Patch
*** Update File: a.js
@@
-missing line
+other
*** End Patch
`),
      ),
    /nearby/,
  );
});
