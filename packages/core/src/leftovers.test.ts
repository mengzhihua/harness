import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTool, hitCount, parseToolArgs } from "./tools.ts";
import { installCatalogPlugin, searchCatalog } from "./store.ts";
import { openInIde } from "./ide.ts";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("describeTool shows command, path, and grep hit counts", () => {
  assert.equal(describeTool("bash", { command: "node --test" }).label, "bash node --test");
  assert.equal(describeTool("str_replace", { path: "src/auth.js" }).label, "str_replace src/auth.js");
  assert.equal(describeTool("grep", { pattern: "passw0rd" }, { hits: 3 }).label, "grep passw0rd 3 hits");
  assert.equal(hitCount("a.js:1: x\nb.js:2: y"), 2);
  assert.equal(hitCount("(no matches)"), 0);
  assert.equal(parseToolArgs("{not json").command, undefined);
});

test("catalog search and install copies a plugin into the project", async () => {
  const found = await searchCatalog("test-runner");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.id, "harness.test-runner");
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-store-"));
  const added = await installCatalogPlugin({ userRoot: root, id: "harness.test-runner" });
  assert.equal(added.id, "harness.test-runner");
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(added.dir, "plugin.json"), "utf8"));
  assert.equal(manifest.kind, "skill");
});

test("openInIde uses HARNESS_IDE and fails closed without an editor", async () => {
  const prev = process.env.HARNESS_IDE;
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-ide-"));
  const file = path.join(dir, "note.txt");
  await writeFile(file, "hi\n");
  process.env.HARNESS_IDE = "/bin/true";
  try {
    const opened = await openInIde({ path: file });
    assert.equal(opened.ok, true);
    assert.match(opened.command, /true/);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_IDE;
    else process.env.HARNESS_IDE = prev;
  }
  const none = await mkdtemp(path.join(os.tmpdir(), "harness-ide-none-"));
  await mkdir(none, { recursive: true });
  const savedIde = process.env.HARNESS_IDE;
  const savedVisual = process.env.VISUAL;
  const savedEditor = process.env.EDITOR;
  delete process.env.HARNESS_IDE;
  delete process.env.VISUAL;
  delete process.env.EDITOR;
  try {
    const missing = await openInIde({ path: path.join(none, "x.txt") });
    assert.equal(missing.ok, false);
    assert.match(missing.message, /no editor|not found/);
  } finally {
    if (savedIde !== undefined) process.env.HARNESS_IDE = savedIde;
    if (savedVisual !== undefined) process.env.VISUAL = savedVisual;
    if (savedEditor !== undefined) process.env.EDITOR = savedEditor;
  }
});
