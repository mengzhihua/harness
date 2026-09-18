import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLlm } from "./llm.ts";

test("MockLlm onDelta streams a tool preview", async () => {
  const llm = new MockLlm();
  const chunks: string[] = [];
  const reply = await llm.chat({
    model: "mock",
    messages: [{ role: "user", content: "fix the login test" }],
    tools: [],
    onDelta: (c) => chunks.push(c),
  });
  assert.ok(reply.tool_calls?.[0]?.function.name === "bash" || reply.content);
  assert.match(chunks.join(""), /bash|Login tests pass|→/);
});
