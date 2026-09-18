import assert from "node:assert/strict";
import { test } from "node:test";
import { humanizeStuck } from "./stuck.ts";
import { parseMentions } from "./attach.ts";

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
