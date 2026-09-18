import assert from "node:assert/strict";
import { test } from "node:test";
import { compactMessages, messagesArePrefix, modelVisibleSubsetOfTraj, projectMessages } from "./history.ts";
import type { ChatMessage } from "./llm.ts";
import type { TrajEvent } from "./traj.ts";

test("messagesArePrefix holds when only appending", () => {
  const a: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ];
  const b: ChatMessage[] = [...a, { role: "assistant", content: "ok" }];
  assert.equal(messagesArePrefix(a, b), true);
  assert.equal(messagesArePrefix(b, a), false);
});

test("compactMessages inserts a placeholder and drops the middle", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "s" },
    ...Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, content: `x${i}`.repeat(5000) })),
  ];
  const out = compactMessages(msgs, 100);
  assert.ok(out.length < msgs.length);
  assert.ok(out.some((m) => m.content.includes("compacted earlier steps")));
});

test("modelVisibleSubsetOfTraj matches projected conversation", () => {
  const events: TrajEvent[] = [
    { ts: "1", source: "user", type: "turn/start", payload: { prompt: "hi" } },
    { ts: "2", source: "assistant", type: "step", payload: { content: "ok" } },
  ];
  const msgs: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" },
  ];
  assert.equal(modelVisibleSubsetOfTraj(msgs, events), true);
  assert.equal(projectMessages(events).map((m) => m.role).join(), "user,assistant");
});
