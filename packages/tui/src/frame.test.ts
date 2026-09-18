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

test("TUI live-diff notification updates the diff line", () => {
  let state = emptyTuiState({ threadId: "th_1" });
  state = applyEvent(state, "diff/updated", { files: ["src/auth.js"], summary: " src/auth.js | 2 +-" });
  const frame = renderFrame(state);
  assert.match(frame, /src\/auth\.js/);
});
