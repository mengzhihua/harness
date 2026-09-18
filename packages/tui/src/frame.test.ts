import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvent, emptyTuiState, renderFrame } from "./frame.ts";

test("TUI frame shows stream, approval card, and input", () => {
  let state = emptyTuiState({ mode: "agent", model: "mock", threadId: "th_1", plugins: 3 });
  state = applyEvent(state, "item/delta", { text: "step 1" });
  state = applyEvent(state, "approval/request", { id: "ap_1", name: "bash", reason: "network / install / push" });
  const frame = renderFrame(state);
  assert.match(frame, /harness/);
  assert.match(frame, /th_1/);
  assert.match(frame, /step 1/);
  assert.match(frame, /APPROVAL ap_1/);
  assert.match(frame, /this thread/);
  assert.match(frame, /this turn/);
  assert.match(frame, /> /);
});

test("TUI approval card shows command and cwd", () => {
  const state = applyEvent(
    emptyTuiState({ threadId: "th_1" }),
    "approval/request",
    { id: "ap_2", name: "bash", reason: "network / install / push", command: "curl https://ex", cwd: "/tmp/wt" },
  );
  const frame = renderFrame(state);
  assert.match(frame, /curl https:\/\/ex/);
  assert.match(frame, /cwd \/tmp\/wt/);
  assert.match(frame, /why: network/);
});

test("done_report with files and no checks is needs-check", () => {
  const state = applyEvent(emptyTuiState(), "done_report", { changed_files: ["src/auth.js"], apply_ready: false, checks: [] });
  assert.equal(state.status, "needs-check");
});

test("TUI reflects same-thread mode change", () => {
  let state = emptyTuiState({ mode: "agent", threadId: "th_1" });
  state = applyEvent(state, "plugin/event", { type: "mode/change", mode: "ask" });
  assert.equal(state.mode, "ask");
});

test("TUI status shows tok/cache and approval offers always", () => {
  let state = emptyTuiState({ threadId: "th_1" });
  state = applyEvent(state, "llm/usage", { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 3 });
  state = applyEvent(state, "approval/request", {
    id: "ap_3",
    name: "bash",
    reason: "network / install / push",
    command: "curl https://ex",
  });
  const frame = renderFrame(state);
  assert.match(frame, /tok=15 cache=3/);
  assert.match(frame, /\[a\] always/);
  assert.equal(state.tokens, 15);
  assert.equal(state.cacheHit, 3);
});

test("TUI live-diff notification updates the diff line", () => {
  let state = emptyTuiState({ threadId: "th_1" });
  state = applyEvent(state, "diff/updated", { files: ["src/auth.js"], summary: " src/auth.js | 2 +-" });
  const frame = renderFrame(state);
  assert.match(frame, /src\/auth\.js/);
});

test("TUI current-tool line shows command/path and grep hits", () => {
  let state = emptyTuiState({ threadId: "th_1" });
  state = applyEvent(state, "item/started", { type: "tool", name: "grep", pattern: "passw0rd", label: "grep passw0rd" });
  assert.match(renderFrame(state), /tool grep passw0rd/);
  state = applyEvent(state, "item/completed", { type: "tool", name: "grep", hits: 4, label: "grep passw0rd 4 hits" });
  assert.match(renderFrame(state), /tool grep passw0rd 4 hits/);
  state = applyEvent(state, "done_report", { changed_files: [], apply_ready: false, checks: [] });
  assert.equal(state.tool, undefined);
});

test("TUI chrome switches to Chinese when language is zh", () => {
  const state = applyEvent(
    emptyTuiState({ threadId: "th_1", language: "zh" }),
    "approval/request",
    { id: "ap_9", name: "bash", reason: "net", command: "curl x" },
  );
  const frame = renderFrame(state);
  assert.match(frame, /审批 ap_9/);
  assert.match(frame, /原因: net/);
  assert.match(frame, /本次/);
  assert.match(frame, / · zh · /);
});

test("TUI appends streamed deltas onto a live line", () => {
  let state = emptyTuiState({ threadId: "th_1" });
  state = applyEvent(state, "item/delta", { text: "Hel", append: true });
  state = applyEvent(state, "item/delta", { text: "lo", append: true });
  assert.equal(state.stream, "Hello");
  assert.match(renderFrame(state), /Hello/);
});

test("TUI follow-up queue stays under the input and shrinks when consumed", () => {
  let state = emptyTuiState({ threadId: "th_1", language: "zh", status: "running" });
  state = applyEvent(state, "inbox/updated", { queued: ["先别动 USER_WIP.md"] });
  const frame = renderFrame(state);
  assert.match(frame, /队列 \(1\)/);
  assert.match(frame, /> /);
  assert.match(frame, /queued=1/);
  state = applyEvent(state, "inbox/updated", { queued: [] });
  assert.equal(renderFrame(state).includes("queued="), false);
});
