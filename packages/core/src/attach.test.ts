import assert from "node:assert/strict";
import { test } from "node:test";
import { humanizeStuck } from "./stuck.ts";
import { parseMentions, parsePastes } from "./attach.ts";

test("parseMentions picks file paths not bare words", () => {
  assert.deepEqual(parseMentions("look at @src/auth.js and @README.md please"), ["src/auth.js", "README.md"]);
  assert.deepEqual(parseMentions("email me @admin later"), []);
});

test("parsePastes captures fenced diffs without treating them as extra files", () => {
  const prompt = "please apply\n```diff\ndiff --git a/src/auth.js b/src/auth.js\n--- a/src/auth.js\n+++ b/src/auth.js\n@@ -1 +1 @@\n-a\n+b\n```\n";
  const pastes = parsePastes(prompt);
  assert.equal(pastes.length, 1);
  assert.equal(pastes[0]?.kind, "diff");
  assert.match(pastes[0]?.content ?? "", /diff --git/);
});

test("parsePastes captures unfenced diffs and stack traces", () => {
  const diff = parsePastes("diff --git a/x b/x\n--- a/x\n+++ b/x\n+ok\n");
  assert.equal(diff[0]?.kind, "diff");
  const err = parsePastes("TypeError: x is not a function\n    at foo (bar.js:1:1)\nFAIL login");
  assert.ok(err.some((p) => p.kind === "error"));
  assert.match(err.find((p) => p.kind === "error")?.content ?? "", /TypeError/);
});

test("humanizeStuck explains missing commands", () => {
  assert.match(
    humanizeStuck({ cmd: "foo --test", exit_code: 127, summary: "foo: not found" }) ?? "",
    /command missing/,
  );
  assert.match(
    humanizeStuck({ cmd: "cat secret", exit_code: 126, summary: "Permission denied" }) ?? "",
    /permission denied/,
  );
  assert.match(
    humanizeStuck({ cmd: "curl https://example", exit_code: 1, summary: "connect: ECONNREFUSED" }) ?? "",
    /network blocked/,
  );
});


test("parseMentions picks file paths not bare words", () => {
  assert.deepEqual(parseMentions("look at @src/auth.js and @README.md please"), ["src/auth.js", "README.md"]);
  assert.deepEqual(parseMentions("email me @admin later"), []);
});

test("humanizeStuck explains missing commands", () => {
  assert.match(
    humanizeStuck({ cmd: "foo --test", exit_code: 127, summary: "foo: not found" }) ?? "",
    /command missing/,
  );
  assert.match(
    humanizeStuck({ cmd: "cat secret", exit_code: 126, summary: "Permission denied" }) ?? "",
    /permission denied/,
  );
  assert.match(
    humanizeStuck({ cmd: "curl https://example", exit_code: 1, summary: "connect: ECONNREFUSED" }) ?? "",
    /network blocked/,
  );
});
