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
  assert.match(frame, /allow_session/);
  assert.match(frame, /> /);
});
