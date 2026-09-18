import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  formatScorecard,
  listEvalTasks,
  scoreTrajectory,
  scorecardFailed,
  summarizeScorecard,
} from "./scorecard.ts";
import type { TrajEvent, TrajHeader } from "./traj.ts";

function ev(type: string, payload: unknown, extra?: Partial<TrajEvent>): TrajEvent {
  return {
    ts: extra?.ts ?? "2026-01-01T00:00:00.000Z",
    source: extra?.source ?? "system",
    type,
    payload,
  };
}

const header: TrajHeader = {
  threadId: "th_1",
  mode: "agent",
  model: "mock",
  userRoot: "/tmp/repo",
  agentRoot: "/tmp/agent",
  plugin_lock: {
    packages: [
      { id: "@harness/agent-loop", version: "1", plane: "host", hash: "a" },
      { id: "login.verify", version: "0", plane: "isolate", hash: "b" },
    ],
  },
  startedAt: "2026-01-01T00:00:00.000Z",
};

test("scoreTrajectory reads Done Report, latency, usage, plugins, and unrelated files", () => {
  const events: TrajEvent[] = [
    ev("plugin_lock", header.plugin_lock, { source: "plugin" }),
    ev("turn/start", { prompt: "fix login" }, { source: "user", ts: "2026-01-01T00:00:00.000Z" }),
    ev(
      "step",
      { content: "", tool_calls: [{ id: "c1", name: "str_replace", arguments: "{}" }] },
      { source: "assistant", ts: "2026-01-01T00:00:00.040Z" },
    ),
    ev("tool_result", { name: "str_replace", callId: "c1" }, { source: "tool" }),
    ev("tool_result", { name: "password_hint", callId: "c2" }, { source: "tool" }),
    ev("tool_result", { name: "run_code", callId: "c3" }, { source: "tool" }),
    ev("plugin/permission", { id: "eval.no-shell", deny: "subprocess" }, { source: "plugin" }),
    ev("llm/usage", { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 25 }, { source: "assistant" }),
    ev("steer", { text: "keep USER_WIP" }, { source: "user" }),
    ev("deny", { name: "bash", reason: "net" }, { source: "policy" }),
    ev(
      "done_report",
      {
        changed_files: ["src/auth.js", "USER_WIP.md"],
        checks: [{ cmd: "node --test", exit_code: 0 }],
        residual_risks: [],
        apply_ready: true,
        interrupted: false,
      },
    ),
  ];
  const score = scoreTrajectory({ header, events, task: "fix-login" });
  assert.equal(score.apply_ready, true);
  assert.equal(score.claimed_done_but_check_fail, 0);
  assert.deepEqual(score.unrelated_files, ["USER_WIP.md"]);
  assert.equal(score.first_tool_ms, 40);
  assert.equal(score.cache_hit_rate, 0.25);
  assert.equal(score.approvals.deny, 1);
  assert.equal(score.steered, true);
  assert.ok(score.project_plugins.includes("login.verify"));
  assert.equal(score.project_plugins.some((id) => id.startsWith("harness.") || id.startsWith("@harness/")), false);
  assert.ok(score.plugin_tools.includes("password_hint"));
  assert.equal(score.plugin_tools.includes("str_replace"), false);
  assert.equal(score.plugin_tools.includes("run_code"), false);
  assert.equal(score.plugin_permission, 1);
  assert.equal(score.dry_replay_ok, true);
});

test("claimed-done-but-check-fail is 1 when apply_ready hides a failing check", () => {
  const events: TrajEvent[] = [
    ev("turn/start", { prompt: "fix" }, { source: "user" }),
    ev("done_report", {
      changed_files: ["src/auth.js"],
      checks: [{ cmd: "node --test", exit_code: 1 }],
      apply_ready: true,
    }),
  ];
  const score = scoreTrajectory({ events });
  assert.equal(score.claimed_done_but_check_fail, 1);
  assert.equal(score.dry_replay_ok, true);
});

test("plugin/error and integrity/mismatch fail the suite gate", () => {
  const events: TrajEvent[] = [
    ev("plugin/error", { id: "broken", error: "missing entry" }, { source: "plugin" }),
    ev("integrity/mismatch", { step: 0 }),
    ev("done_report", { changed_files: [], checks: [], apply_ready: false }),
  ];
  const score = scoreTrajectory({ events, task: "broken" });
  assert.equal(score.plugin_errors, 1);
  assert.equal(score.integrity_mismatch, 1);
  assert.equal(score.dry_replay_ok, false);
  const card = summarizeScorecard([score], "2026-01-01T00:00:00.000Z");
  assert.equal(scorecardFailed(card), true);
  assert.match(formatScorecard(card), /plugin_errors 1/);
  assert.match(formatScorecard(card), /plugin_permission 0/);
});

test("listEvalTasks returns sorted markdown names", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-eval-tasks-"));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "b-two.md"), "# two\n");
  await writeFile(path.join(dir, "a-one.md"), "# one\n");
  await writeFile(path.join(dir, "skip.txt"), "nope\n");
  const tasks = await listEvalTasks(dir);
  assert.deepEqual(
    tasks.map((t) => t.name),
    ["a-one", "b-two"],
  );
});
