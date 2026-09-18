import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@harness/protocol";
import { MockLlm, LocalSubprocess } from "@harness/core";
import { applyEvent, emptyTuiState, renderFrame } from "@harness/tui";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("protocol version is 0.14 for P14", () => {
  assert.equal(PROTOCOL_VERSION, "0.14.0");
});

test("TUI appends streamed item/delta into the live line", () => {
  let state = emptyTuiState({ threadId: "th_1" });
  state = applyEvent(state, "item/delta", { text: "Hel", append: true, source: "llm" });
  state = applyEvent(state, "item/delta", { text: "lo", append: true, source: "llm" });
  assert.equal(state.stream, "Hello");
  const frame = renderFrame(state);
  assert.match(frame, /Hello/);
  state = applyEvent(state, "item/delta", { text: "step 1" });
  assert.equal(state.stream, "");
  assert.ok(state.items.includes("step 1"));
});

test("MockLlm streams deltas while still returning a complete message", async () => {
  const llm = new MockLlm();
  const chunks: string[] = [];
  const reply = await llm.chat({
    model: "mock",
    messages: [{ role: "user", content: "fix login" }],
    tools: [],
    onDelta: (c) => chunks.push(c),
  });
  assert.ok(chunks.length > 0);
  assert.ok(reply.tool_calls?.length || reply.content);
});

test("bash onStdout fires with command output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-p14-"));
  const chunks: string[] = [];
  const sub = new LocalSubprocess(root, { network: false });
  const result = await sub.exec("printf 'stream-ok\\n'", { onStdout: (c) => chunks.push(c) });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(chunks.join(""), /stream-ok/);
});
