import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@harness/protocol";
import {
  decideRelease,
  formatReleaseNotes,
  isDocsOnlyPath,
  releaseTag,
  shortSha,
} from "../../scripts/release-gate.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

test("protocol version is 0.29 for P30", () => {
  assert.equal(PROTOCOL_VERSION, "0.29.0");
});

test("green push after tests publishes a unique release tag", () => {
  const decision = decideRelease({
    eventName: "push",
    refType: "branch",
    refName: "cursor/p30-auto-release-558a",
    sha: "abcdef1234567890",
    commitMessage: "feat: auto release green commits",
    protocolVersion: PROTOCOL_VERSION,
    changedFiles: ["scripts/release-gate.mjs", "packages/protocol/src/types.ts"],
    existingReleaseTags: ["v0.28.0"],
    actor: "cursor[bot]",
  });
  assert.equal(decision.shouldRelease, true);
  assert.equal(decision.reason, "green_push");
  assert.equal(decision.tag, `v${PROTOCOL_VERSION}-abcdef1`);
  assert.equal(decision.title, `v${PROTOCOL_VERSION} (abcdef1)`);
  assert.equal(decision.makeLatest, true);
});

test("pull requests only test and never release", () => {
  const decision = decideRelease({
    eventName: "pull_request",
    refType: "branch",
    refName: "cursor/p30-auto-release-558a",
    sha: "abcdef1234567890",
    commitMessage: "feat: auto release",
    protocolVersion: PROTOCOL_VERSION,
    changedFiles: ["packages/cli/src/main.ts"],
  });
  assert.equal(decision.shouldRelease, false);
  assert.equal(decision.reason, "pull_request");
});

test("skip release markers and docs-only commits do not ship", () => {
  const skipped = decideRelease({
    eventName: "push",
    refType: "branch",
    refName: "main",
    sha: "1111111deadbeef",
    commitMessage: "docs: typo [skip release]",
    protocolVersion: PROTOCOL_VERSION,
    changedFiles: ["packages/cli/src/main.ts"],
  });
  assert.equal(skipped.shouldRelease, false);
  assert.equal(skipped.reason, "skip_marker");

  const docs = decideRelease({
    eventName: "push",
    refType: "branch",
    refName: "main",
    sha: "2222222deadbeef",
    commitMessage: "docs: readme",
    protocolVersion: PROTOCOL_VERSION,
    changedFiles: ["README.md", "docs/architecture.md"],
  });
  assert.equal(docs.shouldRelease, false);
  assert.equal(docs.reason, "docs_only");
  assert.equal(isDocsOnlyPath("README.md"), true);
  assert.equal(isDocsOnlyPath(".github/workflows/release.yml"), false);
});

test("already published tags and dependabot commits are skipped", () => {
  const tag = releaseTag({
    protocolVersion: PROTOCOL_VERSION,
    sha: "abcdef1234567890",
    refType: "branch",
    refName: "main",
  });
  const again = decideRelease({
    eventName: "push",
    refType: "branch",
    refName: "main",
    sha: "abcdef1234567890",
    commitMessage: "feat: again",
    protocolVersion: PROTOCOL_VERSION,
    changedFiles: ["packages/cli/src/main.ts"],
    existingReleaseTags: [tag],
  });
  assert.equal(again.shouldRelease, false);
  assert.equal(again.reason, "already_released");

  const bot = decideRelease({
    eventName: "push",
    refType: "branch",
    refName: "main",
    sha: "abcdef1234567890",
    commitMessage: "chore(deps): bump",
    protocolVersion: PROTOCOL_VERSION,
    changedFiles: ["pnpm-lock.yaml"],
    actor: "dependabot[bot]",
  });
  assert.equal(bot.shouldRelease, false);
  assert.equal(bot.reason, "bot");
  assert.equal(shortSha("abcdef1234567890"), "abcdef1");
});

test("release workflow tests first and does not pin a second pnpm version", async () => {
  const yml = await readFile(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");
  assert.match(yml, /pull_request:/);
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /run: pnpm test/);
  assert.match(yml, /needs: test/);
  assert.match(yml, /needs: \[test, gate\]/);
  assert.match(yml, /should_release == 'true'/);
  assert.match(yml, /pnpm pack:all/);
  assert.match(yml, /softprops\/action-gh-release@v2/);
  assert.match(yml, /make_latest: true/);
  assert.doesNotMatch(yml, /version:\s*10\b/);
  assert.match(yml, /scripts\/release-gate\.mjs/);
  assert.match(yml, /github-actions\[bot\]/);
  const notes = formatReleaseNotes({
    protocolVersion: PROTOCOL_VERSION,
    tag: `v${PROTOCOL_VERSION}-abcdef1`,
    sha: "abcdef1234567890",
    branch: "cursor/p30-auto-release-558a",
    reason: "green_push",
  });
  assert.match(notes, /releases\/latest/);
  assert.match(notes, /\[skip release\]/);
});

test("workflow_dispatch can ship even when the last commit is docs-only", () => {
  const decision = decideRelease({
    eventName: "workflow_dispatch",
    refType: "branch",
    refName: "cursor/p30-auto-release-558a",
    sha: "abcdef1234567890",
    commitMessage: "docs: readme [skip release]",
    protocolVersion: PROTOCOL_VERSION,
    changedFiles: ["README.md"],
  });
  assert.equal(decision.shouldRelease, true);
  assert.equal(decision.reason, "manual");
});
