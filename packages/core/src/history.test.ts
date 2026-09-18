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

test("compactMessages keeps check/verify evidence from the middle", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: "start".repeat(2000) },
    { role: "assistant", content: "mid".repeat(2000) },
    { role: "user", content: "[check] Last command failed (exit 2). Keep fixing." },
    { role: "tool", name: "bash", content: "exit 2\ncwd: /tmp\n--- stdout ---\nFAIL\n--- stderr ---\n" },
    ...Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, content: `noise${i}`.repeat(2000) })),
  ];
  const out = compactMessages(msgs, 100);
  assert.ok(out.some((m) => m.content.includes("[check]")));
  assert.ok(out.some((m) => m.name === "bash" || /exit 2/.test(m.content)));
  assert.ok(out.some((m) => m.content.includes("kept plan, recent steps, latest checks")));
});

test("projectMessages surfaces the latest done_report", () => {
  const events: TrajEvent[] = [
    { ts: "1", source: "user", type: "turn/start", payload: { prompt: "hi" } },
    {
      ts: "2",
      source: "system",
      type: "done_report",
      payload: { changed_files: ["src/auth.js"], apply_ready: true, checks: [{ cmd: "node --test", exit_code: 0 }] },
    },
  ];
  const msgs = projectMessages(events);
  assert.match(msgs.at(-1)?.content ?? "", /\[done\].*src\/auth\.js.*node --test exit 0/);
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
