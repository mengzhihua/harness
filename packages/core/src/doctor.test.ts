import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatDoctor, runDoctor } from "./doctor.ts";

test("runDoctor finds profiles and never leaks API keys", async () => {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-leaked-secret-xyz";
  try {
    const report = await runDoctor({ cwd: process.cwd() });
    assert.equal(report.ok, true);
    assert.match(report.protocol, /^0\.\d+\.\d+$/);
    assert.ok(report.checks.some((c) => c.id === "package_root" && c.level === "ok"));
    assert.ok(report.checks.some((c) => c.id === "profiles" && c.level === "ok"));
    assert.ok(report.checks.some((c) => c.id === "catalog" && c.level === "ok"));
    const key = report.checks.find((c) => c.id === "api_key");
    assert.equal(key?.level, "ok");
    assert.equal(key?.message, "OPENAI_API_KEY set");
    const dumped = `${formatDoctor(report)}\n${JSON.stringify(report)}`;
    assert.doesNotMatch(dumped, /sk-leaked-secret-xyz/);
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prev;
  }
});

test("runDoctor warns when cwd is not a git repo", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-doctor-"));
  mkdirSync(path.join(dir, "empty"), { recursive: true });
  const report = await runDoctor({ cwd: path.join(dir, "empty"), home: path.join(dir, "home") });
  const cwdGit = report.checks.find((c) => c.id === "cwd_git");
  assert.equal(cwdGit?.level, "warn");
  assert.match(cwdGit?.message ?? "", /not a git repository/);
  assert.equal(report.ok, true);
});

test("runDoctor fails profiles when HARNESS_ROOT is empty", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "harness-doctor-root-"));
  writeFileSync(path.join(dir, "readme.txt"), "no profiles\n");
  const prev = process.env.HARNESS_ROOT;
  process.env.HARNESS_ROOT = dir;
  try {
    const report = await runDoctor({ cwd: dir, home: path.join(dir, "home") });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((c) => c.id === "profiles")?.level, "fail");
  } finally {
    if (prev === undefined) delete process.env.HARNESS_ROOT;
    else process.env.HARNESS_ROOT = prev;
  }
});
