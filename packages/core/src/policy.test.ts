import assert from "node:assert/strict";
import { test } from "node:test";
import { Policy } from "./policy.ts";
import { applyRewinds, projectMessages } from "./history.ts";
import type { TrajEvent } from "./traj.ts";

test("policy allows workspace writes and denies secrets", () => {
  const p = new Policy({ mode: "agent", yolo: false });
  assert.equal(p.decide({ name: "read_file", args: { path: "a.js" }, deny: false }).verdict, "allow");
  assert.equal(p.decide({ name: "str_replace", args: { path: "a.js" }, deny: false }).verdict, "allow");
  assert.equal(p.decide({ name: "bash", args: { command: "node --test" }, deny: false }).verdict, "allow");
  assert.equal(p.decide({ name: "delegate", args: { task: "fix tests" }, deny: false }).verdict, "allow");
  assert.equal(p.decide({ name: "fusion", args: { task: "fix tests" }, deny: false }).verdict, "allow");
  assert.equal(p.decide({ name: "browser", args: { action: "snapshot" }, deny: false }).verdict, "allow");
  assert.equal(p.decide({ name: "browser", args: { action: "navigate", url: "https://ex" }, deny: false }).verdict, "ask");
  assert.equal(p.decide({ name: "bash", args: { command: "curl https://ex" }, deny: false }).verdict, "ask");
  assert.equal(p.decide({ name: "bash", args: { command: "cat /etc/shadow" }, deny: false }).verdict, "deny");
});

test("unattended auto-allows ask-once with audit, still blocks always-ask", async () => {
  const p = new Policy({ mode: "agent", yolo: false, unattended: true });
  const net = await p.gate({ name: "bash", args: { command: "curl https://ex" }, deny: false });
  assert.equal(net.deny, false);
  assert.equal(net.audit, true);
  assert.equal(p.memory.get("bash:net"), "allow");
  const rm = await p.gate({ name: "bash", args: { command: "cat .env" }, deny: false });
  assert.equal(rm.deny, true);
});

test("ask mode cannot write", () => {
  const p = new Policy({ mode: "ask", yolo: false });
  assert.equal(p.decide({ name: "str_replace", args: { path: "a.js" }, deny: false }).verdict, "deny");
  assert.equal(p.decide({ name: "bash", args: { command: "node --test" }, deny: false }).verdict, "deny");
  assert.equal(p.decide({ name: "delegate", args: { task: "x" }, deny: false }).verdict, "deny");
  assert.equal(p.decide({ name: "fusion", args: { task: "x" }, deny: false }).verdict, "deny");
  assert.equal(p.decide({ name: "browser", args: { action: "snapshot" }, deny: false }).verdict, "deny");
});

test("plan mode cannot fusion or browse", () => {
  const p = new Policy({ mode: "plan", yolo: false });
  assert.equal(p.decide({ name: "fusion", args: { task: "x" }, deny: false }).verdict, "deny");
  assert.equal(p.decide({ name: "browser", args: { action: "snapshot" }, deny: false }).verdict, "deny");
  assert.equal(p.decide({ name: "grep", args: { pattern: "login" }, deny: false }).verdict, "allow");
});

test("unattended auto-allows browser navigate with audit", async () => {
  const p = new Policy({ mode: "agent", yolo: false, unattended: true });
  const nav = await p.gate({ name: "browser", args: { action: "navigate", url: "https://ex" }, deny: false });
  assert.equal(nav.deny, false);
  assert.equal(nav.audit, true);
  assert.equal(p.memory.get("browser:navigate"), "allow");
});

test("yolo remembers ask-once network", async () => {
  const p = new Policy({ mode: "agent", yolo: true });
  const req = { name: "bash", args: { command: "curl https://ex" }, deny: false };
  const out = await p.gate(req);
  assert.equal(out.deny, false);
  assert.equal(p.memory.get("bash:net"), "allow");
});

test("rewind crops later turns out of the projection", () => {
  const events: TrajEvent[] = [
    { ts: "1", source: "user", type: "turn/start", payload: { prompt: "first" } },
    { ts: "2", source: "checkpoint", type: "checkpoint/created", payload: { id: "cp1", label: "turn-begin" } },
    { ts: "3", source: "user", type: "turn/start", payload: { prompt: "second" } },
    { ts: "4", source: "checkpoint", type: "checkpoint/created", payload: { id: "cp2", label: "turn-begin" } },
    { ts: "5", source: "assistant", type: "step", payload: { content: "bad" } },
    { ts: "6", source: "checkpoint", type: "rewind", payload: { id: "cp2" } },
  ];
  const visible = applyRewinds(events);
  assert.equal(visible.at(-1)?.type, "checkpoint/created");
  const msgs = projectMessages(events);
  assert.deepEqual(
    msgs.map((m) => m.content),
    ["first", "second"],
  );
});
