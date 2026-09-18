import assert from "node:assert/strict";
import { test } from "node:test";
import { envHash, redactSecrets } from "./redact.ts";

test("redactSecrets strips token-like values and named secret keys", () => {
  const out = redactSecrets({
    prompt: "call with sk-abcdefghijklmnopqrstuvwxyz",
    api_key: "supersecretvalue",
    password: "passw0rd",
    nested: { authorization: "Bearer ghp_abcdefghijklmnopqrstuvwxyz" },
  });
  assert.equal(out.password, "passw0rd");
  assert.equal(out.api_key, "[redacted]");
  assert.doesNotMatch(out.prompt, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(out.prompt, /\[redacted\]/);
  assert.equal(out.nested.authorization, "[redacted]");
});

test("envHash is a stable 16-char hex slice", () => {
  assert.match(envHash(), /^[a-f0-9]{16}$/);
  assert.equal(envHash(), envHash());
});
